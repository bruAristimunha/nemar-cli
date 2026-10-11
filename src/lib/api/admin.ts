/**
 * NEMAR API client: admin endpoints (users, repo/CI, DOI, lifecycle, imports,
 * reindex, fleet, email, broadcast, summary, manifest dispatch).
 *
 * Split from lib/api.ts by endpoint group (#908, epic #902); bodies moved
 * verbatim.
 */

import {
  type AdminUserEditBody,
  type AdminUserEditResponse,
  type AdminUserDetail as AdminUserFullDetail,
  type AdminUserShowResponse,
  adminUserEditResponseSchema,
  adminUserShowResponseSchema,
} from "../../../shared/contract/admin-user.js";
import {
  type AccountKind,
  type AdminUserListItem,
  type AdminUsersListResponse,
  type ApiKeyCreateResponse,
  type ApiKeyListResponse,
  type BackfillUsernameOutcome,
  type BackfillVerifyOutcome,
  type ClearIdentityConflictResponse,
  type DuplicateReport,
  adminUsersListResponseSchema,
  apiKeyCreateResponseSchema,
  apiKeyListResponseSchema,
  clearIdentityConflictResponseSchema,
  duplicateReportSchema,
} from "../../../shared/contract/index.js";
import type {
  NeurobagelRegenerateRequest,
  NeurobagelRunResult,
  NeurobagelStatus,
  NeurobagelVerifyResult,
} from "../../../shared/contract/neurobagel-admin.js";
import type {
  ClearOverrideResponse,
  ContributorStanding,
  PrReviewDetail,
  QueueResponse,
  SetOverrideResponse,
  StartReviewResponse,
} from "../../../shared/contract/pr-review-admin.js";
import type { BackfillNameOutcome } from "../../../shared/contract/publication.js";
import type { NeurobagelWeekly } from "../../../shared/contract/weekly-attention.js";
import { request } from "./client.js";

// ============================================================================
// Admin
// ============================================================================

/**
 * Wire shapes for GET /admin/users live in shared/contract/user.ts and are
 * VALIDATED on the way in (below), not merely asserted with a cast. The
 * hand-written interface these replaced declared `service_access: number` and
 * `username: string`, neither of which the endpoint guarantees — a cast makes
 * both drifts invisible, which is the getCurrentUser bug (#899) in a new place.
 */
export type UserListItem = AdminUserListItem;
export type UsersListResponse = AdminUsersListResponse;

/**
 * The upload tier of a listed account (ADR 0040). Three states, not two:
 * `unknown` is a backend that did not report `service_access` at all (deployed
 * before #1251, or a rolling deploy mid-flight), and must not be shown or
 * filtered as "browse" — telling an uploader they have no upload access sends
 * them to an admin to ask for something they already hold.
 */
export type UploadTier = "upload" | "browse" | "unknown";

export function uploadTierOf(user: Pick<UserListItem, "service_access">): UploadTier {
  if (user.service_access === undefined || user.service_access === null) return "unknown";
  return user.service_access ? "upload" : "browse";
}

/**
 * List users (admin only)
 */
export async function listUsers(
  status?: string,
  role?: string,
  // Open upload requests only (ADR 0042, #1253): asked, not yet granted. This
  // one is server-side because the timestamp it filters on is not something a
  // client can derive from the rest of the row.
  awaitingApproval?: boolean,
  // What the account IS (epic #1272 phase 4, #1284; ADR 0048).
  kind?: AccountKind,
  extra: {
    /** Words to find in ANY text field of an account (ADR 0096). Every word
     *  must match somewhere. Each matching row then carries `matched_in`. */
    search?: string;
    /** Include tombstoned accounts, which the listing hides by default. */
    includeDeleted?: boolean;
  } = {},
): Promise<UsersListResponse> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (role) params.set("role", role);
  if (awaitingApproval) params.set("awaiting_approval", "1");
  if (kind) params.set("kind", kind);
  // `!== undefined`, not truthiness: an empty search must reach the backend and
  // be refused there, never be dropped here and answered with every account.
  if (extra.search !== undefined) params.set("q", extra.search);
  if (extra.includeDeleted) params.set("include_deleted", "true");
  const query = params.toString() ? `?${params.toString()}` : "";
  return request(`/admin/users${query}`, {}, true, adminUsersListResponseSchema);
}

export type { AdminUserFullDetail, AdminUserEditBody, AdminUserEditResponse };

/**
 * One account's full non-secret details, by numeric id (ADR 0096). By id and
 * not username because a web/ORCID account has no username.
 */
export async function getAdminUserById(
  id: number,
  includeDeleted = false,
): Promise<AdminUserShowResponse> {
  return request(
    `/admin/users/by-id/${id}${includeDeleted ? "?include_deleted=true" : ""}`,
    {},
    true,
    adminUserShowResponseSchema,
  );
}

/**
 * Edit an account (ADR 0096). Descriptive fields: any admin. username, email
 * and github_username: owner only, and never one's own account.
 */
export async function editAdminUser(
  id: number,
  fields: AdminUserEditBody,
): Promise<AdminUserEditResponse> {
  return request(
    `/admin/users/by-id/${id}`,
    { method: "PATCH", body: JSON.stringify(fields) },
    true,
    adminUserEditResponseSchema,
  );
}

export interface ApproveResponse {
  message: string;
  /**
   * Present only on the repair path: the account was already `approved` but
   * carried no upload grant, so only the grant was written (ADR 0040).
   */
  note?: string;
  user: {
    id: number;
    // NULL for web/ORCID accounts (they have no username by design).
    username: string | null;
    email: string;
    status: string;
    /** Approval grants upload access; always true on a 200 (ADR 0040). */
    service_access?: boolean;
  };
  email_sent: boolean;
}

/**
 * Approve a pending user (admin only)
 */
export async function approveUser(username: string): Promise<ApproveResponse> {
  return request<ApproveResponse>(
    `/admin/approve/${username}`,
    {
      method: "POST",
    },
    true,
  );
}

/**
 * Approve a user by their numeric id (admin only). Needed for web/ORCID
 * accounts, which have username = NULL and so cannot be addressed by the
 * username-keyed endpoint (#1012).
 */
export async function approveUserById(id: number): Promise<ApproveResponse> {
  return request<ApproveResponse>(
    `/admin/approve/by-id/${id}`,
    {
      method: "POST",
    },
    true,
  );
}

/**
 * Revoke a user's access (admin only)
 */
export async function revokeUser(username: string): Promise<{ message: string }> {
  return request<{ message: string }>(
    `/admin/revoke/${username}`,
    {
      method: "POST",
    },
    true,
  );
}

/**
 * Revoke a user's access by their numeric id (admin only). The mirror of
 * {@link approveUserById}, and needed for the same accounts: a web/ORCID
 * signup has username = NULL, so the username-keyed endpoint can never reach
 * one. Approval grants upload access to those accounts (ADR 0040), so revoke
 * has to be able to take it back from them.
 */
export async function revokeUserById(id: number): Promise<{ message: string }> {
  return request<{ message: string }>(
    `/admin/revoke/by-id/${id}`,
    {
      method: "POST",
    },
    true,
  );
}

export interface ChangeRoleResponse {
  message: string;
  user: { username: string; role: string };
  tokens_revoked?: number;
}

/**
 * Change a user's role (owner only)
 */
export async function changeUserRole(
  username: string,
  role: "owner" | "admin" | "member",
): Promise<ChangeRoleResponse> {
  return request<ChangeRoleResponse>(
    `/admin/users/${username}/role`,
    {
      method: "POST",
      body: JSON.stringify({ role }),
    },
    true,
  );
}

export interface ChangeKindResponse {
  message: string;
  user: { username: string; account_kind: AccountKind };
}

/**
 * Change a user's account kind (owner only; epic #1272 phase 4, #1284; ADR
 * 0048).
 */
export async function setAccountKind(
  username: string,
  kind: AccountKind,
): Promise<ChangeKindResponse> {
  return request<ChangeKindResponse>(
    `/admin/users/${username}/kind`,
    {
      method: "POST",
      body: JSON.stringify({ kind }),
    },
    true,
  );
}

/** The fields `nemar admin doctor kinds` reads off `GET
 *  /admin/users/:username` (epic #1272 phase 4, #1284 review; ADR 0048).
 *  The route selects every NON-SECRET column (`ADMIN_USER_NON_SECRET_SELECT`;
 *  credentials are never returned, ADR 0096) plus two computed columns, so
 *  this is deliberately narrow rather than a full mirror of the row --
 *  everything else is untyped here on purpose (`.passthrough()`-shaped).
 *  `getAdminUserById` is the validated, fully typed read of one account. */
export interface AdminUserDetail {
  username: string | null;
  account_kind?: AccountKind;
}

/** `GET /admin/users/:username` (owner/admin; any kind). Throws `ApiError`
 *  404 for an unknown username, same as every other username-keyed admin
 *  route. */
export async function getAdminUserByUsername(username: string): Promise<{ user: AdminUserDetail }> {
  return request<{ user: AdminUserDetail }>(`/admin/users/${username}`, {}, true);
}

/**
 * Mint a key for a non-person account (owner only; epic #1272 phase 4,
 * #1284; ADR 0048) -- the one path that can mint a key for a `service`/`test`
 * kind, which cannot self-mint (`nemar auth keys create` / the device flow
 * both refuse them).
 */
export async function createKeyFor(username: string, name: string): Promise<ApiKeyCreateResponse> {
  return request<ApiKeyCreateResponse>(
    `/admin/users/${username}/keys`,
    { method: "POST", body: JSON.stringify({ name }) },
    true,
    apiKeyCreateResponseSchema,
  );
}

/** List a target account's live keys (owner only; any kind). */
export async function listKeysFor(username: string): Promise<ApiKeyListResponse> {
  return request<ApiKeyListResponse>(
    `/admin/users/${username}/keys`,
    {},
    true,
    apiKeyListResponseSchema,
  );
}

/** Revoke one of a target account's keys by row id (owner only; any kind). */
export async function revokeKeyFor(username: string, id: number): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/admin/users/${username}/keys/${id}`, { method: "DELETE" }, true);
}

// ============================================================================
// Admin - Repository Management
// ============================================================================

export interface VisibilityResponse {
  message: string;
  dataset_id: string;
  visibility: "public" | "private";
}

/**
 * Change dataset repository visibility (admin only)
 */
export async function changeVisibility(
  datasetId: string,
  visibility: "public" | "private",
): Promise<VisibilityResponse> {
  return request<VisibilityResponse>(
    `/admin/datasets/${datasetId}/visibility`,
    {
      method: "PATCH",
      body: JSON.stringify({ visibility }),
    },
    true,
  );
}

export interface PublishDatasetResponse {
  success: boolean;
  message: string;
  dataset_id: string;
  github_url: string;
  s3_url: string;
}

/**
 * Publish a dataset (make public) - admin only
 * This is a one-way operation that cannot be undone
 */
export async function publishDataset(datasetId: string): Promise<PublishDatasetResponse> {
  return request<PublishDatasetResponse>(
    `/datasets/${datasetId}/publish`,
    { method: "POST" },
    true,
  );
}

// ============================================================================
// Admin - CI Management
// ============================================================================

export interface CiStatusResponse {
  dataset_id: string;
  bids_validation: {
    present: boolean;
    status: string;
    url: string | null;
  };
  version_check: {
    present: boolean;
  };
}

/**
 * Get CI workflow status for a dataset (admin only)
 */
export async function getCiStatus(datasetId: string): Promise<CiStatusResponse> {
  return request<CiStatusResponse>(`/admin/datasets/${datasetId}/ci`, {}, true);
}

export interface AddCiResponse {
  message: string;
  dataset_id: string;
  workflows_deployed: string[];
}

/**
 * Deploy CI workflows to a dataset repository (admin only).
 *
 * Returns immediately after the tree-batched commit; post-deploy
 * parseability validation lives in `validateCi()` (issue #472).
 */
export async function addCi(datasetId: string): Promise<AddCiResponse> {
  return request<AddCiResponse>(`/admin/datasets/${datasetId}/ci`, { method: "POST" }, true);
}

export interface ValidateCiResponse {
  dataset_id: string;
  /** Workflow basenames GitHub Actions could parse. */
  valid: string[];
  /** Deployed workflow basenames not listed by GitHub Actions — either a YAML
   *  parse error or transient indexing lag right after the deploy. */
  missing: string[];
  /** Transport / API errors from the listing call (5xx, network). The
   *  validation is best-effort; an error here doesn't fail the deploy. */
  errors: string[];
}

/**
 * One-shot parseability probe for the latest CI workflow deploy.
 * Callers (the CLI) handle the indexing-lag wait and retry locally so
 * the Worker's wall-clock budget stays out of the loop (issue #472).
 */
export async function validateCi(datasetId: string): Promise<ValidateCiResponse> {
  return request<ValidateCiResponse>(
    `/admin/datasets/${datasetId}/ci/validate`,
    { method: "POST" },
    true,
  );
}

export interface SyncCiResponse {
  dataset_id: string;
  checked: string[];
  changed: string[];
  added: string[];
  errors: string[];
  /** True iff a tree commit was actually made. */
  committed: boolean;
  /** True iff the workflow directory listing failed; treat result as
      "presence unknown" rather than "no workflows deployed." */
  list_failed: boolean;
}

/**
 * Sync deployed CI workflows to current templates (admin only).
 * Only writes files that drift or are missing.
 */
export async function syncCi(datasetId: string): Promise<SyncCiResponse> {
  return request<SyncCiResponse>(`/admin/datasets/${datasetId}/ci/sync`, { method: "POST" }, true);
}

// ============================================================================
// DOI Management (Admin)
// ============================================================================

export interface CreateConceptDoiRequest {
  title?: string;
  description?: string;
  authors?: Array<{ name: string; affiliation?: string }>;
  sandbox?: boolean;
  provider?: "ezid" | "zenodo";
}

interface CreateConceptDoiResponseBase {
  message: string;
  concept_doi: string;
  warning: string;
  metadata_warning?: string;
}

export type CreateConceptDoiResponse = CreateConceptDoiResponseBase &
  (
    | { provider: "ezid"; ezid_identifier: string; doi_url: string }
    | { provider: "zenodo"; zenodo_id: number; zenodo_url: string }
  );

/**
 * Create concept DOI for a dataset (admin only)
 */
export async function createConceptDoi(
  datasetId: string,
  data: CreateConceptDoiRequest,
): Promise<CreateConceptDoiResponse> {
  return request<CreateConceptDoiResponse>(
    `/admin/datasets/${datasetId}/doi/concept`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
    true,
  );
}

export interface PublishVersionDoiRequest {
  version: string;
  release_url: string;
  sandbox?: boolean;
}

export interface PublishVersionDoiResponse {
  message: string;
  version: string;
  version_doi: string;
  concept_doi: string;
  zenodo_url: string;
  warning: string;
}

/**
 * Publish version DOI for a dataset (admin only)
 */
export async function publishVersionDoi(
  datasetId: string,
  data: PublishVersionDoiRequest,
): Promise<PublishVersionDoiResponse> {
  return request<PublishVersionDoiResponse>(
    `/admin/datasets/${datasetId}/doi/publish`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
    true,
  );
}

export interface DoiInfoResponse {
  dataset_id: string;
  name: string;
  concept_doi: string | null;
  latest_version_doi: string | null;
  /** Always "ezid" since #1182 (ADR 0007); kept for older backends. */
  doi_provider: "ezid" | "zenodo";
  zenodo_concept_url: string | null;
  ezid_identifier: string | null;
  ezid_status: "reserved" | "public" | "unavailable" | null;
  doi_url: string | null;
}

/**
 * Get DOI info for a dataset (admin only)
 */
export async function getDoiInfo(datasetId: string): Promise<DoiInfoResponse> {
  return request<DoiInfoResponse>(`/admin/datasets/${datasetId}/doi`, {}, true);
}

export interface UpdateDoiRequest {
  status?: "public" | "unavailable";
  refresh_metadata?: boolean;
}

export interface UpdateDoiResponse {
  message: string;
  ezid_identifier: string;
  status: "reserved" | "public" | "unavailable";
  doi_url: string;
  metadata_refreshed: boolean;
}

/**
 * Update EZID DOI metadata or status (admin only)
 */
export async function updateDoi(
  datasetId: string,
  data: UpdateDoiRequest,
): Promise<UpdateDoiResponse> {
  return request<UpdateDoiResponse>(
    `/admin/datasets/${datasetId}/doi/update`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
    true,
  );
}

// ---------------------------------------------------------------------------
// Withdrawal / restore (epic #967 phase 4, #971)
//
// NOTE (tracked, not fixed here -- #937): these wire types are hand-
// duplicated against backend/src/services/withdraw.ts rather than sourced
// from shared/contract, same as most of this file's other endpoints. The
// @nemar/contract migration is a separate tracked follow-up.
// ---------------------------------------------------------------------------

export interface DoiStepResult {
  doi: string;
  kind: "concept" | "version";
  version?: string;
  action: "unavailable" | "public";
  status: "planned" | "ok" | "failed";
  error?: string;
}

/** Mirrors services/visibility.ts's VisibilityTransitionResult failure branch
 *  (minus the `ok` discriminant) so the CLI can render exactly which surface
 *  (GitHub/S3/D1) desynced instead of a flattened error string. */
export type VisibilityStepResult =
  | { status: "planned" }
  | { status: "ok" }
  | { status: "failed"; stage: "not_found" | "no_repo" | "invalid_repo" | "github"; error: string }
  | { status: "failed"; stage: "s3"; error: string; githubReverted: boolean; revertError?: string }
  | {
      status: "failed";
      stage: "db";
      error: string;
      githubReverted: boolean;
      s3Reverted: boolean;
      revertError?: string;
    };

/** Discriminated on `skipped`: exactly one of the two shapes, mirroring
 *  backend/src/services/withdraw.ts's DatasetTransitionResult. withdraw and
 *  restore share this one name (rather than separate Withdraw/Restore
 *  aliases) since the shapes are otherwise identical. */
export type DatasetTransitionResponse =
  | { dataset_id: string; dry_run: boolean; skipped: string; resumed?: boolean }
  | {
      dataset_id: string;
      dry_run: boolean;
      resumed?: boolean;
      visibility: VisibilityStepResult;
      dois: DoiStepResult[];
      warning?: string;
    };

/**
 * Withdraw a published dataset: make it private and tombstone its concept +
 * version EZID DOIs. `dryRun` defaults to true server-side; pass `false` to
 * execute (requires `reason`).
 */
export async function withdrawDataset(
  datasetId: string,
  opts: { reason?: string; dryRun: boolean },
): Promise<DatasetTransitionResponse> {
  return request<DatasetTransitionResponse>(
    `/admin/datasets/${datasetId}/withdraw`,
    {
      method: "POST",
      body: JSON.stringify({ reason: opts.reason, dry_run: opts.dryRun }),
    },
    true,
  );
}

/**
 * Reverse a withdrawal: make the dataset public again and restore its
 * concept + version EZID DOIs. `dryRun` defaults to true server-side.
 */
export async function restoreDataset(
  datasetId: string,
  opts: { dryRun: boolean },
): Promise<DatasetTransitionResponse> {
  return request<DatasetTransitionResponse>(
    `/admin/datasets/${datasetId}/restore`,
    {
      method: "POST",
      body: JSON.stringify({ dry_run: opts.dryRun }),
    },
    true,
  );
}

// ---------------------------------------------------------------------------
// Dataset deletion
// ---------------------------------------------------------------------------

export interface DeleteDatasetResponse {
  datasetId: string;
  deleted: boolean;
  steps: {
    github: { success: boolean; error?: string };
    s3: { deleted: number; failed: Array<{ key: string; error: string }>; skipped?: boolean };
    d1: { success: boolean; versionsDeleted: number; pubRequestsDeleted: number; error?: string };
  };
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Test dataset reset
// ---------------------------------------------------------------------------

export interface ResetTestDatasetResponse {
  message: string;
  success: boolean;
  github_ssh_url: string;
  steps: { s3_deleted: number; github_recreated: boolean; d1_cleaned: boolean };
}

/**
 * Reset a test dataset to clean state (admin only, nm099999 only)
 */
export async function resetTestDataset(datasetId: string): Promise<ResetTestDatasetResponse> {
  return request<ResetTestDatasetResponse>(
    `/admin/datasets/${datasetId}/reset`,
    { method: "POST" },
    true,
  );
}

export async function deleteDataset(
  datasetId: string,
  force = false,
): Promise<DeleteDatasetResponse> {
  return request<DeleteDatasetResponse>(
    `/admin/datasets/${datasetId}`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force }),
    },
    true,
  );
}

export interface BulkDeleteResponse {
  deleted: number;
  failed: number;
  results: Array<{ dataset_id: string; deleted: boolean; error?: string }>;
}

export async function bulkDeleteDatasets(datasetIds: string[]): Promise<BulkDeleteResponse> {
  return request<BulkDeleteResponse>(
    "/admin/datasets/bulk-delete",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset_ids: datasetIds }),
    },
    true,
  );
}

// ─── Import ─────────────────────────────────────────────────────────────────

export interface ImportDatasetResponse {
  dataset_id: string;
  name: string;
  github_repo: string;
  source: string;
  source_id: string;
}

export async function importDataset(opts: {
  dataset_id: string;
  name: string;
  description?: string;
  source: "openneuro";
  source_id: string;
}): Promise<ImportDatasetResponse> {
  return request<ImportDatasetResponse>(
    "/admin/datasets/import",
    {
      method: "POST",
      body: JSON.stringify(opts),
    },
    true,
  );
}

// ─── Exemplar ───────────────────────────────────────────────────────────────
// Staging exemplar datasets (epic #923, Phase 5). See
// backend/src/routes/admin/exemplar.ts for the endpoint contract; both routes
// 403 in production (staging-only fleet).

export interface CreateExemplarResponse {
  dataset_id: string;
  name: string;
  github_repo: string;
  source: string;
  source_id: string;
}

export async function createExemplar(opts: {
  dataset_id: string;
  source_id: string;
  name?: string;
  description?: string;
  /**
   * Mirrors the route's still-live `anonymous` field (`POST
   * /admin/datasets/exemplar`). It has had no caller since #1433 removed the
   * fleet's anonymous designation, and is kept only so this client stays a
   * faithful description of the endpoint. #1434 retires both together; do not
   * use it to build a fixture, which is what ADR 0068 moved to a reserved
   * `nm` id.
   */
  anonymous?: true;
}): Promise<CreateExemplarResponse> {
  return request<CreateExemplarResponse>(
    "/admin/datasets/exemplar",
    {
      method: "POST",
      body: JSON.stringify(opts),
    },
    true,
  );
}

export interface RemintExemplarDoisResponse {
  dataset_id: string;
  concept_doi: string;
  status: "reserved" | "public" | "unavailable";
  warnings?: string[];
}

export async function remintExemplarDois(datasetId: string): Promise<RemintExemplarDoisResponse> {
  return request<RemintExemplarDoisResponse>(
    `/admin/datasets/${datasetId}/exemplar/remint-dois`,
    { method: "POST" },
    true,
  );
}

// ============================================================================
// Import jobs (issue #754)
// ============================================================================

export interface ImportJobRow {
  dataset_id: string;
  source: string;
  source_id: string;
  stage: string;
  status: string;
  last_error: string | null;
  workflow_run_url: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  // Retry engine + blocklist columns (#969, epic #967 Phase 2; migration 0058).
  recovery_attempts: number;
  first_incomplete_at: string | null;
  next_retry_at: string | null;
  blocklisted: number;
  blocklist_reason: string | null;
  maintainer_notified_at: string | null;
  integrity_checked_at: string | null;
}

export interface ImportStatusResponse {
  imports: ImportJobRow[];
  total: number;
  by_status: Record<string, number>;
  /**
   * Imported datasets that have since been withdrawn. NOT a value of
   * `by_status` -- withdrawal is orthogonal to the import lifecycle, and these
   * rows are counted inside `by_status.complete` because their import did
   * succeed. Optional: older backends omit it (#1048).
   */
  withdrawn?: number;
}

export async function getImportStatus(
  status?: string,
  blocklisted?: boolean,
): Promise<ImportStatusResponse> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (blocklisted !== undefined) params.set("blocklisted", blocklisted ? "1" : "0");
  const q = params.toString();
  return request<ImportStatusResponse>(`/admin/imports${q ? `?${q}` : ""}`, {}, true);
}

export async function rollbackImport(
  datasetId: string,
): Promise<{ ok: boolean; dataset_id: string; rolled_back: boolean; warnings: string[] }> {
  return request(`/admin/imports/${datasetId}/rollback`, { method: "POST" }, true);
}

export async function retryImport(
  datasetId: string,
): Promise<{ ok: boolean; dataset_id: string; status: string }> {
  return request(`/admin/imports/${datasetId}/retry`, { method: "POST" }, true);
}

export interface ImportVerifyResponse {
  dataset_id: string;
  complete: boolean;
  missingKeys: string[];
  zeroByteKeys: string[];
  expectedCount: number;
  presentCount: number;
}

export async function verifyImport(datasetId: string): Promise<ImportVerifyResponse> {
  return request(`/admin/imports/${datasetId}/verify`, { method: "POST" }, true);
}

/**
 * Push `next_retry_at` forward for datasets `recover --execute` just
 * dispatched out-of-band, so the Phase-2 retry cron doesn't re-dispatch the
 * same onboard-openneuro.yml run on its next tick (#981).
 */
export async function dispatchCooldown(datasetIds: string[]): Promise<{ updated: number }> {
  return request(
    "/admin/imports/dispatch-cooldown",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset_ids: datasetIds }),
    },
    true,
  );
}

// ============================================================================
// Reindex (epic #417 phase 3)
// ============================================================================

export interface ReindexOptions {
  skip_enrichment?: boolean;
  skip_sync?: boolean;
  ref?: string;
}

export interface ReindexResponse {
  dataset_id: string;
  enrichment: {
    status: "ok" | "failed" | "skipped";
    ref?: string;
    error?: string;
    /** DOI metadata lookups (#1549). `failed` counts DOIs no registry
     *  answered for (rate limit, server error, timeout): worth a retry.
     *  `skipped` counts DOIs past the per-run lookup cap. */
    doi_resolution?: { resolved: number; unresolved: number; failed: number; skipped: number };
    /** Non-fatal notes on an otherwise successful run: a deliberate DOI-sync
     *  skip (#1255) or DOI lookups that got no registry answer (#1549). */
    warnings?: string[];
  };
  sync: {
    status: "ok" | "failed" | "skipped";
    metadata_columns_written?: boolean;
    metadata_columns_error?: string;
  };
}

export type ReindexFilter = "all" | "missing-metadata" | "stale";

export interface ReindexBulkOptions {
  older_than_days?: number;
  skip_enrichment?: boolean;
  skip_sync?: boolean;
  dry_run?: boolean;
}

export interface ReindexBulkResponse {
  filter: ReindexFilter;
  total: number;
  elapsed_ms: number;
  /** Populated only when dry_run=true. */
  dry_run?: boolean;
  /** Populated only when dry_run=true. */
  datasets?: string[];
  /** Populated only when dry_run is false or absent. */
  results?: ReindexResponse[];
}

export async function reindexDataset(
  datasetId: string,
  options?: ReindexOptions,
): Promise<ReindexResponse> {
  return request<ReindexResponse>(
    `/admin/datasets/${datasetId}/reindex`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options ?? {}),
    },
    true,
  );
}

export async function reindexBulk(
  filter: ReindexFilter,
  options?: ReindexBulkOptions,
): Promise<ReindexBulkResponse> {
  return request<ReindexBulkResponse>(
    "/admin/datasets/reindex/bulk",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filter, ...(options ?? {}) }),
    },
    true,
  );
}

/** One batch of the HED backfill sweep (#869 phase 3, `POST /admin/datasets/hed-sweep`). */
export interface HedSweepBatchResponse {
  processed: number;
  /** Classified has_hed=1 this batch. */
  withHed: number;
  /** Classified has_hed=0 (checked, no HED) this batch. */
  withoutHed: number;
  /** Could not classify (no dataset_description.json / probe error) -> NULL. */
  unknown: number;
  errors: { dataset_id: string; error: string }[];
  /** Datasets still unswept (no `$.hed_checked_at` in sweep_stamps); 0 when done. */
  remaining: number | null;
}

/** Response of `?reset=1`: count of probed rows cleared back to unclassified. */
export interface HedSweepResetResponse {
  reset: number;
}

/** Run one bounded HED sweep batch (default 15, server-clamped to [1,30]). */
export async function hedSweep(options?: { limit?: number }): Promise<HedSweepBatchResponse> {
  const limit = options?.limit ?? 15;
  return request<HedSweepBatchResponse>(
    `/admin/datasets/hed-sweep?limit=${encodeURIComponent(String(limit))}`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}

/** Clear every probed HED row so a corrected detector can re-sweep from scratch. */
export async function hedSweepReset(): Promise<HedSweepResetResponse> {
  return request<HedSweepResetResponse>(
    "/admin/datasets/hed-sweep?reset=1",
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}

/** One batch of the recording-stats backfill sweep (migration 0070, epic
 *  #1144 Phase 2, issue #1146, `POST /admin/datasets/recording-stats-sweep`). */
export interface RecordingStatsSweepBatchResponse {
  processed: number;
  /** Candidates whose zarr index yielded at least one measured recording. */
  measured: number;
  /** Candidates whose zarr index existed but had no measured recordings. */
  unmeasured: number;
  errors: { dataset_id: string; error: string }[];
  /** Datasets still unswept; 0 when done, null if the count query failed. */
  remaining: number | null;
}

/** Response of `?reset=1`: count of stamped rows cleared back to unswept. */
export interface RecordingStatsSweepResetResponse {
  reset: number;
}

/** Run one bounded recording-stats sweep batch (default 50, server-clamped to [1,200]). */
export async function recordingStatsSweep(options?: {
  limit?: number;
}): Promise<RecordingStatsSweepBatchResponse> {
  const limit = options?.limit ?? 50;
  return request<RecordingStatsSweepBatchResponse>(
    `/admin/datasets/recording-stats-sweep?limit=${encodeURIComponent(String(limit))}`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}

/** Clear every stamped recording-stats row so a corrected aggregator can re-sweep from scratch. */
export async function recordingStatsSweepReset(): Promise<RecordingStatsSweepResetResponse> {
  return request<RecordingStatsSweepResetResponse>(
    "/admin/datasets/recording-stats-sweep?reset=1",
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}

/** One batch of the signal-defaults backfill sweep (migrations 0072/0073, epic
 *  #1144 Phase 2b, issue #1153, `POST /admin/datasets/signal-defaults-sweep`). */
export interface SignalDefaultsSweepBatchResponse {
  processed: number;
  /** Candidates whose probe found at least one usable sidecar key and wrote it. */
  populated: number;
  /** Candidates whose probe completed but found nothing to write. */
  noData: number;
  errors: { dataset_id: string; error: string }[];
  /** Datasets still unswept; 0 when done, null if the count query failed. */
  remaining: number | null;
}

/** Response of `?reset=1`: count of stamped rows cleared back to unswept. */
export interface SignalDefaultsSweepResetResponse {
  reset: number;
}

/** Run one bounded signal-defaults sweep batch (default 15, server-clamped to [1,30]). */
export async function signalDefaultsSweep(options?: {
  limit?: number;
}): Promise<SignalDefaultsSweepBatchResponse> {
  const limit = options?.limit ?? 15;
  return request<SignalDefaultsSweepBatchResponse>(
    `/admin/datasets/signal-defaults-sweep?limit=${encodeURIComponent(String(limit))}`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}

/** Clear every stamped signal-defaults row so a corrected probe can re-sweep from scratch. */
export async function signalDefaultsSweepReset(): Promise<SignalDefaultsSweepResetResponse> {
  return request<SignalDefaultsSweepResetResponse>(
    "/admin/datasets/signal-defaults-sweep?reset=1",
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}

/** One batch of the data-integrity sweep (epic #967 Phase 3, #970,
 *  `POST /admin/datasets/data-integrity-sweep`). */
export interface DataIntegritySweepBatchResponse {
  processed: number;
  /** Verified complete (every annex-keyed manifest entry present at declared size,
   *  whole or as a complete chunk set). */
  complete: number;
  /** Verified incomplete this batch -- the #967 signature. */
  incomplete: number;
  /** Could not verify (no manifest / verify error) -> data_complete stays NULL. */
  unknown: number;
  errors: { dataset_id: string; error: string }[];
  /** Datasets still unaudited (or stale past --older-than); 0 when the sweep is done. */
  remaining: number | null;
}

/** Response of `?reset=1`: count of audited rows cleared back to unclassified. */
export interface DataIntegritySweepResetResponse {
  reset: number;
}

/** Run one bounded data-integrity sweep batch (default 15, server-clamped to
 *  [1,30]). `olderThan` widens candidacy to already-checked rows past N days
 *  for periodic re-audit (moving window, never converges to 0 on its own).
 *  `before` widens candidacy to an ANCHORED ISO8601 cutoff instead (#980) --
 *  pass the SAME timestamp on every call in a loop and `remaining` strictly
 *  decreases to 0, unlike `olderThan`. Omit both for the one-shot
 *  never-checked drain. */
export async function dataIntegritySweep(options?: {
  limit?: number;
  olderThan?: number;
  before?: string;
}): Promise<DataIntegritySweepBatchResponse> {
  const limit = options?.limit ?? 15;
  const params = new URLSearchParams({ limit: String(limit) });
  if (options?.olderThan != null) params.set("older-than", String(options.olderThan));
  if (options?.before != null) params.set("before", options.before);
  return request<DataIntegritySweepBatchResponse>(
    `/admin/datasets/data-integrity-sweep?${params.toString()}`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}

/** Clear every audited row so a corrected verifier can re-sweep from scratch. */
export async function dataIntegritySweepReset(): Promise<DataIntegritySweepResetResponse> {
  return request<DataIntegritySweepResetResponse>(
    "/admin/datasets/data-integrity-sweep?reset=1",
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}

// ============================================================================
// Availability report (epic #999 Phase 1, #1000)
// ============================================================================

/** One manifest path whose declared annex key is not present in S3 at its
 *  declared size. Keyed by path (not annex key): git-annex is
 *  content-addressed, so two distinct paths can share one key (repeated
 *  calibration/empty-room/identical-stimulus files are common in BIDS). */
export interface AvailabilityReportMissingEntry {
  path: string;
  key: string;
  declared_size: number;
  reason: "zero_byte" | "absent";
}

export interface AvailabilityReportCompleteness {
  files_present: number;
  files_declared: number;
  bytes_present: number;
  bytes_declared: number;
  /** bytes_present / bytes_declared, or null whenever bytes_declared is not
   *  > 0 (a 0-declared-bytes dataset, with or without a manifest). */
  pct_bytes: number | null;
}

/** `.nemar/availability-report.json` shape (mirrors
 *  backend/src/services/availability-report.ts's AvailabilityReport). */
export interface AvailabilityReport {
  dataset_id: string;
  version: string | null;
  generated_at: string;
  source: { type: string; id: string } | null;
  complete: boolean;
  completeness: AvailabilityReportCompleteness;
  missing: AvailabilityReportMissingEntry[];
  blocklist_reason?: string;
}

/** `POST /admin/datasets/:id/availability-report` response: the bare report
 *  on a dry run, or `{ written: true, report }` once it's committed. */
export type AvailabilityReportResult =
  | AvailabilityReport
  | { written: true; report: AvailabilityReport };

/**
 * Generate a dataset's availability report. Dry-run by default (server-side
 * `?dry_run=1`, returns the report without committing it); pass
 * `{ write: true }` to commit it to `.nemar/availability-report.json` on the
 * repo's `main` branch.
 */
export async function availabilityReport(
  datasetId: string,
  opts?: { write?: boolean },
): Promise<AvailabilityReportResult> {
  const query = opts?.write ? "" : "?dry_run=1";
  return request<AvailabilityReportResult>(
    `/admin/datasets/${datasetId}/availability-report${query}`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}

/** One batch of the availability-report backfill sweep (epic #999 phase 2,
 *  #1001, `POST /admin/datasets/availability-report-sweep`). */
export interface AvailabilityReportSweepBatchResponse {
  processed: number;
  /** Successfully generated + committed this batch. */
  written: number;
  errors: AvailabilityReportSweepError[];
  /** Candidates still unstamped (no `$.availability_report_at` in sweep_stamps),
   *  including rows this batch refused or failed; 0 means nothing is left to try. */
  remaining: number | null;
}

/** One candidate a batch could not complete. */
export interface AvailabilityReportSweepError {
  dataset_id: string;
  error: string;
  /** The status the single-dataset route answers for this failure: 409 = refused
   *  because the repository has no `main`; 400/404 = the dataset's own
   *  configuration; 500 = anything else (S3, GitHub or auth failure, a
   *  repository not visible to NEMAR). */
  status: number;
}

/** Response of `?reset=1`: count of stamped rows cleared back to unswept. */
export interface AvailabilityReportSweepResetResponse {
  reset: number;
}

/** Run one bounded availability-report sweep batch (default 30,
 *  server-clamped to [1,30]). Each candidate does a GitHub commit, so the
 *  server clamp is the real bound -- asking for more just gets 30.
 *  `missingOnly` narrows candidacy to datasets already known incomplete
 *  (data_complete = 0). */
export async function availabilityReportSweep(options?: {
  limit?: number;
  missingOnly?: boolean;
}): Promise<AvailabilityReportSweepBatchResponse> {
  const limit = options?.limit ?? 30;
  const params = new URLSearchParams({ limit: String(limit) });
  if (options?.missingOnly) params.set("missing-only", "1");
  return request<AvailabilityReportSweepBatchResponse>(
    `/admin/datasets/availability-report-sweep?${params.toString()}`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}

/** Clear every stamped row so a corrected report generator can re-sweep from scratch. */
export async function availabilityReportSweepReset(): Promise<AvailabilityReportSweepResetResponse> {
  return request<AvailabilityReportSweepResetResponse>(
    "/admin/datasets/availability-report-sweep?reset=1",
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}

// ============================================================================
// Fleet governance (epic #713)
// ============================================================================

export interface FleetDriftResponse {
  scanned: number;
  limit: number;
  counts: Record<string, number>;
  buckets: Record<string, string[]>;
  repos: Array<{ dataset_id: string; buckets: string[] }>;
}

export async function getFleetDrift(opts?: {
  prefix?: string;
  visibility?: "public" | "private";
  limit?: number;
}): Promise<FleetDriftResponse> {
  const qs = new URLSearchParams();
  if (opts?.prefix) qs.set("prefix", opts.prefix);
  if (opts?.visibility) qs.set("visibility", opts.visibility);
  if (opts?.limit) qs.set("limit", String(opts.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request<FleetDriftResponse>(`/admin/fleet/drift${suffix}`, {}, true);
}

export interface EnforceResponse {
  dataset_id: string;
  dry_run: boolean;
  result: {
    visibility: string;
    defaultBranch: string;
    steps: Record<string, { status: string; detail?: string }>;
  };
}

export async function enforceDataset(datasetId: string, dryRun: boolean): Promise<EnforceResponse> {
  return request<EnforceResponse>(
    `/admin/datasets/${datasetId}/enforce`,
    { method: "POST", body: JSON.stringify({ dry_run: dryRun }) },
    true,
  );
}

export interface EnforceBulkResponse {
  dry_run: boolean;
  count: number;
  results: Array<{
    dataset_id: string;
    steps?: Record<string, { status: string; detail?: string }>;
    error?: string;
  }>;
}

export async function enforceBulk(opts: {
  prefix?: string;
  visibility?: "public" | "private";
  limit?: number;
  dryRun: boolean;
}): Promise<EnforceBulkResponse> {
  return request<EnforceBulkResponse>(
    "/admin/datasets/enforce/bulk",
    {
      method: "POST",
      body: JSON.stringify({
        prefix: opts.prefix,
        visibility: opts.visibility,
        limit: opts.limit,
        dry_run: opts.dryRun,
      }),
    },
    true,
  );
}

export interface RevalidateResponse {
  dataset_id: string;
  head_sha: string | null;
  triggered_by?: "sync" | "dispatch";
  skipped?: string;
}

export async function revalidateDataset(
  datasetId: string,
  force = false,
): Promise<RevalidateResponse> {
  const qs = force ? "?force=true" : "";
  return request<RevalidateResponse>(
    `/admin/datasets/${datasetId}/revalidate${qs}`,
    { method: "POST" },
    true,
  );
}

// ============================================================================
// Email Preferences
// ============================================================================

export interface EmailPreferences {
  user_approval: boolean;
  publication_request: boolean;
  announcements: boolean;
  /** #1409: findings from the anonymity sweep on an anonymous deposit. */
  dataset_anonymity: boolean;
  /** Epic #1610 phase 5 (ADR 0088): the identifier sweep's weekly report. */
  identifier_sweep: boolean;
}

/** Preferences plus whose they are (the backend echoes the resolved username). */
export type EmailPreferencesResult = EmailPreferences & { username?: string };

/** `targetUser` (owner-only) reads another user's preferences; omit for self. */
export async function getEmailPreferences(targetUser?: string): Promise<EmailPreferencesResult> {
  const qs = targetUser ? `?user=${encodeURIComponent(targetUser)}` : "";
  return request<EmailPreferencesResult>(`/admin/email-preferences${qs}`, {}, true);
}

/** `targetUser` (owner-only) updates another user's preferences; omit for self. */
export async function updateEmailPreferences(
  prefs: Partial<EmailPreferences>,
  targetUser?: string,
): Promise<EmailPreferencesResult> {
  const qs = targetUser ? `?user=${encodeURIComponent(targetUser)}` : "";
  return request<EmailPreferencesResult>(
    `/admin/email-preferences${qs}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(prefs),
    },
    true,
  );
}

// ============================================================================
// Broadcast
// ============================================================================

export interface BroadcastResponse {
  broadcast_id: number;
  recipient_count: number;
  failure_count: number;
  failed_recipients: string[];
}

export interface BroadcastDryRunResponse {
  dry_run: true;
  recipient_group: string;
  recipient_count: number;
  recipients: string[];
}

/**
 * Send broadcast email to a user group or a single user (admin only).
 *
 * `to` and `user` are mutually exclusive; provide exactly one.
 */
export async function sendBroadcast(data: {
  to?: string;
  user?: string;
  subject: string;
  body: string;
  dry_run?: boolean;
}): Promise<BroadcastResponse | BroadcastDryRunResponse> {
  return request<BroadcastResponse | BroadcastDryRunResponse>(
    "/admin/notify",
    {
      method: "POST",
      body: JSON.stringify(data),
    },
    true,
  );
}

// ============================================================================
// Summary coverage (epic #618 / phase 2 #620)
// ============================================================================

export type SummarySchemaState =
  | { kind: "ok"; schema_version: string }
  | { kind: "stale"; schema_version: string }
  | { kind: "missing" }
  | { kind: "error"; status: number; message: string };

export interface SummaryVersionCoverage {
  dataset_id: string;
  version: string;
  doi: string;
  concept_doi: string | null;
  state: SummarySchemaState;
}

export interface SummaryCoverageReport {
  generated_at: string;
  target_schema: string;
  totals: {
    versions: number;
    ok: number;
    stale: number;
    missing: number;
    error: number;
  };
  versions: SummaryVersionCoverage[];
}

export async function getSummaryCoverage(): Promise<SummaryCoverageReport> {
  return request<SummaryCoverageReport>("/admin/summary/coverage", {}, true);
}

export interface DispatchManifestResponse {
  dispatched: boolean;
  dataset_id: string;
  version: string;
}

export async function dispatchManifest(
  datasetId: string,
  version: string,
  options?: { skipCanary?: boolean },
): Promise<DispatchManifestResponse> {
  return request<DispatchManifestResponse>(
    "/admin/manifest/dispatch",
    {
      method: "POST",
      body: JSON.stringify({
        dataset_id: datasetId,
        version,
        skip_canary: options?.skipCanary ?? false,
      }),
    },
    true,
  );
}

// ============================================================================
// Doctor (diagnostic checks + remediation, #1130)
// ============================================================================

/** One dataset/version exhibiting a check's problem. */
export interface DoctorFinding {
  dataset_id: string;
  version?: string;
  details?: Record<string, unknown>;
}

/** Response of `POST /admin/doctor/scan` (read-only). */
export interface DoctorScanResponse {
  scanned: string[];
  results: Record<string, { description: string; count: number; findings: DoctorFinding[] }>;
}

/** Per-finding outcome of a fix run. */
export interface DoctorFixResult {
  dataset_id: string;
  version?: string;
  status: "fixed" | "skipped" | "failed";
  message?: string;
  details?: Record<string, unknown>;
}

/** `POST /admin/doctor/fix` with `dry_run: true`: lists findings, writes nothing. */
export interface DoctorFixDryRunResponse {
  check: string;
  dry_run: true;
  would_fix: number;
  findings: DoctorFinding[];
}

/** `POST /admin/doctor/fix` live run: per-finding outcomes and counts. */
export interface DoctorFixLiveResponse {
  check: string;
  total: number;
  fixed: number;
  skipped: number;
  failed: number;
  results: DoctorFixResult[];
}

/** Discriminated on `dry_run` so a caller cannot read live-run counts off a
 *  dry-run response (or vice versa); the overloads on {@link doctorFix} pick
 *  the arm at the call site. */
export type DoctorFixResponse = DoctorFixDryRunResponse | DoctorFixLiveResponse;

/** Run doctor diagnostic checks (read-only). Omit `check` to run them all. */
export async function doctorScan(options?: {
  check?: string;
  datasetId?: string;
}): Promise<DoctorScanResponse> {
  return request<DoctorScanResponse>(
    "/admin/doctor/scan",
    {
      method: "POST",
      body: JSON.stringify({
        ...(options?.check && { check: options.check }),
        ...(options?.datasetId && { dataset_id: options.datasetId }),
      }),
    },
    true,
  );
}

/** Apply a doctor check's remediation. `dryRun` lists findings without writing. */
export async function doctorFix(options: {
  check: string;
  datasetId?: string;
  dryRun: true;
}): Promise<DoctorFixDryRunResponse>;
export async function doctorFix(options: {
  check: string;
  datasetId?: string;
  dryRun?: false;
}): Promise<DoctorFixLiveResponse>;
export async function doctorFix(options: {
  check: string;
  datasetId?: string;
  dryRun?: boolean;
}): Promise<DoctorFixResponse> {
  return request<DoctorFixResponse>(
    "/admin/doctor/fix",
    {
      method: "POST",
      body: JSON.stringify({
        check: options.check,
        ...(options.datasetId && { dataset_id: options.datasetId }),
        ...(options.dryRun && { dry_run: true }),
      }),
    },
    true,
  );
}

// ============================================================================
// Zarr catalog (issue #1062, epic #1181 phase 2)
// ============================================================================

export interface PublishZarrCatalogResponse {
  count: number;
  bytes: number;
}

/**
 * Rebuild and republish the top-level Zarr discovery catalog
 * (`zarr-catalog.json`) to this environment's own S3 bucket. The daily cron
 * does this automatically; this is the on-demand escape hatch for an
 * operator who doesn't want to wait for the next tick.
 */
export async function publishZarrCatalog(): Promise<PublishZarrCatalogResponse> {
  return request<PublishZarrCatalogResponse>(
    "/admin/zarr-catalog/publish",
    { method: "POST" },
    true,
  );
}

// ============================================================================
// Neurobagel artifact store (epic #1586 phase 4, ADR 0084)
// ============================================================================

// The wire shapes live in shared/contract so the Worker that answers and this client that
// prints read one definition; a field the writer adds is a type error here, not a blank.
export type {
  NeurobagelDatasetResult,
  NeurobagelRegenerateRequest,
  NeurobagelRunResult,
  NeurobagelRunSummary,
  NeurobagelStatus,
  NeurobagelVerification,
  NeurobagelVerifyResult,
} from "../../../shared/contract/neurobagel-admin.js";

/**
 * Examine datasets for the Neurobagel artifact store and, only with `execute: true`,
 * write what changed. Dry run by default; the server refuses `execute` unless the
 * writer is enabled.
 */
export async function neurobagelRegenerate(
  body: NeurobagelRegenerateRequest,
): Promise<NeurobagelRunResult> {
  return request<NeurobagelRunResult>(
    "/admin/neurobagel/regenerate",
    { method: "POST", body: JSON.stringify(body) },
    true,
  );
}

export async function getNeurobagelStatus(): Promise<NeurobagelStatus> {
  return request<NeurobagelStatus>("/admin/neurobagel/status", { method: "GET" }, true);
}

/**
 * Run the Neurobagel verification sweep now (epic #1586 phase 6). It reports and never
 * repairs; it works on staging and writes only its own heartbeat.
 */
export async function neurobagelVerify(): Promise<NeurobagelVerifyResult> {
  return request<NeurobagelVerifyResult>(
    "/admin/neurobagel/verify",
    { method: "POST", body: "{}" },
    true,
  );
}

// ============================================================================
// Zarr fidelity verification sweep (issue #1068, epic #1181 phase 8)
// ============================================================================

/** One {path, code} mismatch example, bounded to 20 entries / 4 KB server-side. */
export interface ZarrFidelityMismatchExample {
  path: string;
  code: "channel_count_mismatch" | "duration_mismatch" | "rate_mismatch";
}

/** Per-dataset outcome for every candidate the sweep reached a verdict for. */
export interface ZarrFidelityDatasetResult {
  dataset_id: string;
  verdict: "verified" | "failed" | "unverifiable";
  sampled: number;
  checked: number;
  checked_channels: number;
  checked_duration: number;
  checked_rate: number;
  unchecked: number;
  examples: ZarrFidelityMismatchExample[];
  mismatch_count: number;
  examples_truncated: boolean;
}

/** One batch of the zarr fidelity sweep
 *  (`POST /admin/datasets/zarr-fidelity-sweep`). `ok` is false (with a 502
 *  status) only when every processed candidate errored -- a partial mix of
 *  verdicts and errors, or an empty candidate set, is still `ok: true`
 *  (#1203 review, item 6). */
export interface ZarrFidelitySweepBatchResponse {
  processed: number;
  verified: number;
  failed: number;
  unverifiable: number;
  results: ZarrFidelityDatasetResult[];
  errors: { dataset_id: string; error: string }[];
  /** Candidates still unverified after this run; null if the count query failed. */
  remaining: number | null;
  /** True when the sweep-wide fetch budget ran out before every requested
   *  candidate could be attempted; datasets past this point were never
   *  touched at all (#1203 review, item 3). */
  budget_exhausted: boolean;
  ok: boolean;
}

/** Run one bounded zarr fidelity sweep batch (server default and max: 25). */
export async function zarrFidelitySweep(options?: {
  limit?: number;
}): Promise<ZarrFidelitySweepBatchResponse> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set("limit", String(options.limit));
  const query = params.toString() ? `?${params.toString()}` : "";
  return request<ZarrFidelitySweepBatchResponse>(
    `/admin/datasets/zarr-fidelity-sweep${query}`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}

// ============================================================================
// Import-failure issue triage (#1310, epic #1306)
// ============================================================================

export interface ImportIssueTriageEntry {
  issueNumber: number;
  datasetId: string | null;
  title: string;
  kind: "close" | "relabel" | "keep";
  reason: string;
  labels?: string[];
  /** The action was attempted and did not land. Excluded from the counts. */
  failed?: boolean;
}

/** One batch of the import-failure issue triage
 *  (`POST /admin/imports/issue-triage`). `applied` is false on a dry run, which
 *  is the default: nothing is written to GitHub unless `--apply` is passed. */
export interface ImportIssueTriageResponse {
  applied: boolean;
  /** Open per-dataset issues (rollups excluded). */
  openIssues: number;
  /** Aggregate filing mode across causes. Not per-cause: the filer asks the same
   *  question of ONE cause's rollup, so inside the hysteresis band a cause with
   *  no rollup of its own still files per-dataset. */
  mode: "per-dataset" | "rollup";
  /** Open per-cause rollup issues seen this run. `outcome` is set only on an
   *  applied run that tried to release them. */
  rollups: { number: number; title: string; outcome?: "released" | "failed" }[];
  /** Rollups closed (or, on a dry run, that would be) because the mode released. */
  rollupsReleased: number;
  examined: number;
  /** WRITES tried: non-keep entries plus rollup releases, on an applied run only.
   *  Zero on a dry run, which attempts nothing. Decision failures are not
   *  attempts; they appear in `errors` with `stage: "plan"`. */
  attempted: number;
  closed: number;
  relabelled: number;
  kept: number;
  plan: ImportIssueTriageEntry[];
  errors: {
    issue: number;
    dataset_id: string | null;
    /** `comment` means the state change LANDED and only its comment failed. */
    stage: "plan" | "apply" | "comment";
    error: string;
  }[];
  /** Candidates outside this run's window; the window rotates daily. */
  remaining: number;
  /**
   * Whether the failures and their tracking issues describe the same set (#1352).
   *
   * `null` means the comparison could not be made, NOT that they agree -- see
   * `reconcileError`. Report-only: it files nothing.
   */
  reconcile: {
    rowsWithoutIssue: {
      datasetId: string;
      sourceId: string;
      status: string;
      stage: string;
      cause: string;
      label: string;
      updatedAt: string | null;
    }[];
    issuesWithoutRow: { number: number; datasetId: string; title: string }[];
    /** Unresolved rows the retry engine parked; already reported by the weekly
     *  summary, so not counted as untracked here. */
    parked: number;
    /** Quarantined rows: their own channel (admin email, audit row,
     *  `GET /admin/imports?status=quarantined`), so counted and never listed. */
    quarantined: number;
    /** True when failures exist but NO open import-failure issue was found at all --
     *  suspect a renamed label before suspecting the fleet. */
    issueListEmpty: boolean;
    rowsExamined: number;
    issuesExamined: number;
    reason: string;
  } | null;
  /** Why `reconcile` is null, when it is. */
  reconcileError: string | null;
  ok: boolean;
  /** Present when the run applied changes but its audit row could not be written.
   *  The changes still happened -- this is not a failure of the run. */
  audit_failed?: string;
}

/** Triage the open import-failure issues (server default 15 per run, max 30).
 *  Dry run unless `apply` is set. */
export async function importIssueTriage(options?: {
  limit?: number;
  apply?: boolean;
}): Promise<ImportIssueTriageResponse> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set("limit", String(options.limit));
  if (options?.apply) params.set("apply", "1");
  const query = params.toString() ? `?${params.toString()}` : "";
  return request<ImportIssueTriageResponse>(
    `/admin/imports/issue-triage${query}`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}

// ============================================================================
// Import coverage sweep (#1311, epic #1306 phase 3)
// ============================================================================

/**
 * One run of the import coverage sweep (`POST /admin/imports/coverage-sweep`).
 *
 * `status` is the verdict and the three values are genuinely different answers:
 * `healthy` (checked, fine), `alarm` (checked, not fine), `unknown` (could not
 * check). The third is why the route answers 502 for it -- an unreadable pipeline
 * reported as a healthy one is the failure this sweep exists to detect.
 */
export interface ImportCoverageResponse {
  applied: boolean;
  status: "healthy" | "alarm" | "unknown";
  kind: "backlog" | "silence" | "disabled" | "dispatch-lost" | null;
  reason: string;
  /** Whether `AUTO_IMPORT_ENABLED` is the exact string `"true"`. */
  enabled: boolean;
  lastDispatchAt: string | null;
  dispatchAgeHours: number | null;
  /** The dataset the last dispatch row named. */
  lastDispatchSourceId: string | null;
  /** The last dispatch picked a dataset that never acquired an import row: the
   *  hand-off is failing after the audit row is written. */
  dispatchLost: boolean;
  /** In-scope datasets OpenNeuro reported this run. */
  discovered: number;
  /** Managed mirrors in D1, however many the scan still returns. */
  imported: number;
  /** Of `discovered`: already imported. The first term of the balance. */
  importedInScan: number;
  /** Mirrors the scan no longer returns: drift, not a coverage gap. */
  importedNotInScan: number;
  inFlight: number;
  terminal: number;
  /** `neverAttempted` + `untracked` is the outstanding work that drives the
   *  verdict; `tracked` and `blocklisted` are owned by something else. The counts
   *  balance against `discovered` -- if they do not, the read was degraded. */
  backlog: {
    neverAttempted: string[];
    untracked: string[];
    tracked: string[];
    blocklisted: string[];
  };
  issue: {
    /** null on a dry run that would create the issue. */
    number: number | null;
    action: "created" | "refreshed" | "relabelled" | "closed";
    commentError?: string;
    labelError?: string;
  } | null;
  errors: { stage: "discovery" | "d1" | "report" | "anomaly"; error: string }[];
  ok: boolean;
  audit_failed?: string;
}

/** Run the import coverage sweep. Dry run unless `apply` is set; `apply` is
 *  refused by the backend outside production. */
export async function importCoverageSweep(options?: {
  apply?: boolean;
}): Promise<ImportCoverageResponse> {
  const query = options?.apply ? "?apply=1" : "";
  return request<ImportCoverageResponse>(
    `/admin/imports/coverage-sweep${query}`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}

// ============================================================================
// Weekly import summary (#1312, epic #1306 phase 4)
// ============================================================================

/** One blocklisted dataset in the weekly report. `parkedDays` is null when the
 *  anchor column is NULL -- genuinely unknown, not zero days. */
export interface WeeklyParkedDataset {
  datasetId: string;
  reason: string | null;
  parkedDays: number | null;
}

/**
 * The weekly import summary (`POST /admin/imports/weekly-summary`).
 *
 * **Every count is `number | null`, and `null` means the sweep could not determine
 * it.** Rendering an unknown as 0 is how the original incident stayed invisible, so
 * a consumer must not coalesce these.
 */
export interface WeeklySummaryResponse {
  applied: boolean;
  /** False when the once-per-week gate refused, or on a dry run. `facts` is still
   *  populated so the report can be read. */
  posted: boolean;
  gateReason: string;
  /** NULL when the once-per-week gate refused: nothing was gathered, so this is "we
   *  did not look", which is a different answer from "we looked and could not tell".
   *  Do not render it as a page of unknowns. */
  facts: {
    week: string;
    windowStart: string;
    windowEnd: string;
    importedThisWeek: number | null;
    importedTotal: number | null;
    coverageStatus: "healthy" | "alarm" | "unknown" | null;
    coverageReason: string | null;
    outstanding: number | null;
    discovered: number | null;
    importedNotInScan: number | null;
    autoImportEnabled: boolean | null;
    dispatchPhrase: string | null;
    dispatchLost: boolean | null;
    failuresByCause: Record<string, number> | null;
    openFailureTotal: number | null;
    parked: WeeklyParkedDataset[] | null;
    issuesClosed: number | null;
    issuesRelabelled: number | null;
    /** The daily Neurobagel verification runs of the window; null when none was recorded. */
    neurobagel: NeurobagelWeekly | null;
    /** Findings that need a person, as a count with no kind; null when it could not be counted. */
    neurobagelFindings: number | null;
    errors: { stage: string; error: string }[];
  } | null;
  issue: { number: number | null; action: "created" | "would-create" | "already-filed" } | null;
  closedPrevious: number | null;
  /** The body exactly as it would be, or was, posted -- so a dry run can be
   *  reviewed before it becomes an issue. */
  renderedBody: string | null;
  ok: boolean;
}

/** Produce the weekly import summary. Dry run unless `apply` is set; a dry run also
 *  bypasses the once-per-week gate, since it files nothing. */
export async function importWeeklySummary(options?: {
  apply?: boolean;
}): Promise<WeeklySummaryResponse> {
  const query = options?.apply ? "?apply=1" : "";
  return request<WeeklySummaryResponse>(
    `/admin/imports/weekly-summary${query}`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}

// ============================================================================
// Researcher-name backfill (#1255, epic #1250)
// ============================================================================

export interface BackfillNameResult {
  id: number;
  username: string | null;
  email: string;
  orcid: string;
  outcome: BackfillNameOutcome;
  given_name?: string | null;
  family_name?: string | null;
  error?: string;
}

export interface BackfillNamesResponse {
  apply: boolean;
  scanned: number;
  filled: number;
  would_fill: number;
  no_public_name: number;
  lookup_failed: number;
  /** Rows whose name UPDATE threw. Optional: a backend that predates #1274 had
   *  no such outcome -- one failed write 500ed the whole batch. */
  write_failed?: number;
  /** Candidates still missing a name after this batch; `null` when the count
   *  query itself failed (never confuse that with "nothing left"). */
  remaining: number | null;
  /** Set when a non-fatal part of the batch failed, e.g. the remaining count. */
  warning?: string;
  results: BackfillNameResult[];
}

/** Fill NULL researcher names from the public ORCID record. Dry run unless
 *  `apply` is true. */
export async function backfillUserNames(options?: {
  apply?: boolean;
  limit?: number;
}): Promise<BackfillNamesResponse> {
  return request<BackfillNamesResponse>(
    "/admin/users/backfill-names",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apply: options?.apply ?? false,
        ...(options?.limit != null ? { limit: options.limit } : {}),
      }),
    },
    true,
  );
}

// ============================================================================
// Username backfill (ADR 0042, #1253)
// ============================================================================

export interface BackfillUsernameResult {
  id: number;
  email: string;
  orcid: string | null;
  outcome: BackfillUsernameOutcome;
  username?: string | null;
  given_name?: string | null;
  family_name?: string | null;
  verify?: BackfillVerifyOutcome;
  error?: string;
}

/** One row of the verify-retry pass: an account that already has a username
 *  and still has an unproven inbox. */
export interface BackfillVerifyRetry {
  id: number;
  email: string;
  verify: BackfillVerifyOutcome;
}

export interface BackfillUsernamesResponse {
  apply: boolean;
  scanned: number;
  assigned: number;
  would_assign: number;
  single_name: number;
  no_name: number;
  lookup_failed: number;
  conflict: number;
  /** Rows whose suggested base was saturated up to the suffix limit. Optional
   *  for the same reason the verify counters are: a backend that predates the
   *  split reports those rows inside `conflict`. */
  exhausted?: number;
  /** Rows whose claim write threw. Optional for the same reason: a backend
   *  that predates #1274 had no such outcome -- it 500ed the whole batch. */
  write_failed?: number;
  /** Verify-message outcomes, counted across BOTH passes. Optional so a
   *  backend that predates the retry pass is rendered as unknown, not zero. */
  verify_sent: number;
  verify_failed?: number;
  verify_rate_limited?: number;
  verify_skipped_fence?: number;
  verify_retried?: number;
  verify_retries?: BackfillVerifyRetry[];
  /** Candidates still without a username after this batch; `null` when the
   *  count query itself failed (never confuse that with "nothing left"). */
  remaining: number | null;
  /** Set when a non-fatal part of the batch failed, e.g. the remaining count. */
  warning?: string;
  results: BackfillUsernameResult[];
}

/** Give username-less accounts a username derived from their name. Dry run
 *  unless `apply` is true. */
export async function backfillUsernames(options?: {
  apply?: boolean;
  limit?: number;
}): Promise<BackfillUsernamesResponse> {
  return request<BackfillUsernamesResponse>(
    "/admin/users/backfill-usernames",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apply: options?.apply ?? false,
        ...(options?.limit != null ? { limit: options.limit } : {}),
      }),
    },
    true,
  );
}

// ============================================================================
// Identity uniqueness (#1254, epic #1250; ADR 0043)
// ============================================================================

/**
 * Duplicate-account report: live accounts sharing an ORCID iD, an email
 * address, or a GitHub handle.
 *
 * Validated against the shared contract rather than cast, for the reason
 * stated at the top of this file: the report drives an operator's decision
 * about which of two real accounts survives, so a silent shape drift here is
 * worse than a loud parse failure.
 */
export async function getUserDuplicates(): Promise<DuplicateReport> {
  return request("/admin/users/duplicates", {}, true, duplicateReportSchema);
}

/**
 * Clear a row's `identity_conflict` flag. 409s while the collision is still
 * there, which is the expected answer until someone has actually resolved it.
 */
export async function clearIdentityConflict(id: number): Promise<ClearIdentityConflictResponse> {
  return request(
    `/admin/users/${id}/clear-identity-conflict`,
    { method: "POST" },
    true,
    clearIdentityConflictResponseSchema,
  );
}

// ============================================================================
// Anonymity verification sweep (issue #1409, epic #1406)
// ============================================================================

/** One thing the sweep found. Never carries the matched text (#1409). */
export interface AnonymityFinding {
  /** Stable id, so a caller can branch without parsing prose. */
  check: string;
  /**
   * `invariant` is a NEMAR guarantee that stopped holding; `deposit` is
   * something the depositor left in their own files. Only the first is a bug,
   * and only the second is the depositor's to fix.
   */
  severity: "invariant" | "deposit";
  detail: string;
  file?: string;
}

/** Per-dataset outcome for every candidate the sweep reached a verdict for. */
export interface AnonymityDatasetResult {
  dataset_id: string;
  /** `findings` rather than `failed`: not every finding is NEMAR's bug. */
  status: "verified" | "findings" | "unverifiable";
  findings: AnonymityFinding[];
  /**
   * Check ids this run could not evaluate. NEVER empty: identity inside the
   * recordings themselves is always in here, because a Worker does not pull
   * annexed gigabytes to read an EDF header. A caller that renders "no
   * findings" without this is claiming more than the sweep did.
   */
  unchecked: string[];
  files_scanned: number;
  files_listed: number;
}

/** One batch of the anonymity sweep (`POST /admin/datasets/anonymity-sweep`). */
export interface AnonymitySweepBatchResponse {
  processed: number;
  verified: number;
  with_findings: number;
  unverifiable: number;
  results: AnonymityDatasetResult[];
  errors: { dataset_id: string; error: string }[];
  /** Candidates still owing a pass; null if the count query failed. */
  remaining: number | null;
  budget_exhausted: boolean;
  /** Findings that reached nobody. The mail is the depositor's only copy. */
  mail_failures: { dataset_id: string; recipient: string; error: string }[];
}

/** Run one bounded anonymity sweep batch (server default 10, max 25). */
export async function anonymitySweep(options?: {
  limit?: number;
}): Promise<AnonymitySweepBatchResponse> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set("limit", String(options.limit));
  const query = params.toString() ? `?${params.toString()}` : "";
  return request<AnonymitySweepBatchResponse>(
    `/admin/datasets/anonymity-sweep${query}`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}

/** Re-arm every anonymous deposit for the next pass (verdict AND attempt stamp). */
export async function anonymitySweepReset(): Promise<{ reset: number }> {
  return request<{ reset: number }>(
    "/admin/datasets/anonymity-sweep?reset=1",
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}

// ============================================================================
// Dataset pull-request review queue (ADR 0093, following ADR 0092)
// ============================================================================

export type {
  ClearOverrideResponse,
  ContributorStanding,
  PrReviewDetail,
  QueueEntry,
  QueueResponse,
  QueueVerdict,
  SetOverrideResponse,
  StartReviewResponse,
} from "../../../shared/contract/pr-review-admin.js";

/** Every open pull request to `main` in `nemarDatasets`, with the automated review of its current commit. */
export async function listPrReviews(filters: {
  verdicts?: string[];
  dataset?: string;
  author?: string;
  needsMe?: boolean;
}): Promise<QueueResponse> {
  const params = new URLSearchParams();
  if (filters.verdicts && filters.verdicts.length > 0) {
    params.set("verdict", filters.verdicts.join(","));
  }
  if (filters.dataset) params.set("dataset", filters.dataset);
  if (filters.author) params.set("author", filters.author);
  if (filters.needsMe) params.set("needs_me", "1");
  const query = params.toString() ? `?${params.toString()}` : "";
  return request<QueueResponse>(`/admin/pr-reviews${query}`, { method: "GET" }, true);
}

/**
 * One pull request: its stored review and history, what GitHub says now, and its author's standing.
 * Pass `head` (a full commit id) to ask what the review concluded about THAT commit, which is how
 * `approve` avoids relying on a head the Worker read a moment earlier or later.
 */
export async function getPrReview(
  datasetId: string,
  prNumber: number,
  head?: string,
): Promise<PrReviewDetail> {
  const query = head ? `?head=${encodeURIComponent(head)}` : "";
  return request<PrReviewDetail>(
    `/admin/pr-reviews/${encodeURIComponent(datasetId)}/${prNumber}${query}`,
    { method: "GET" },
    true,
  );
}

/**
 * Review a pull request that is already open, or start again a commit whose review ended without a
 * verdict. The Worker reads the pull request from GitHub itself; only the dataset and the number are
 * sent. The answer is the review gate's own fixed word (`dispatched`, `duplicate`, ...).
 */
export async function startPrReview(
  datasetId: string,
  prNumber: number,
): Promise<StartReviewResponse> {
  return request<StartReviewResponse>(
    `/admin/pr-reviews/${encodeURIComponent(datasetId)}/${prNumber}/start`,
    { method: "POST" },
    true,
  );
}

export async function getPrReviewAuthor(login: string): Promise<ContributorStanding> {
  return request<ContributorStanding>(
    `/admin/pr-review-authors/${encodeURIComponent(login)}`,
    { method: "GET" },
    true,
  );
}

/** Allow or block a contributor; the tally no longer decides the pause until it is cleared (rate limits still apply). */
export async function setPrReviewAuthor(
  login: string,
  mode: "allow" | "block",
  reason?: string,
): Promise<SetOverrideResponse> {
  return request<SetOverrideResponse>(
    `/admin/pr-review-authors/${encodeURIComponent(login)}`,
    { method: "PUT", body: JSON.stringify(reason ? { mode, reason } : { mode }) },
    true,
  );
}

export async function clearPrReviewAuthor(login: string): Promise<ClearOverrideResponse> {
  return request<ClearOverrideResponse>(
    `/admin/pr-review-authors/${encodeURIComponent(login)}`,
    { method: "DELETE" },
    true,
  );
}
