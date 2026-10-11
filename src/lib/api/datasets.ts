/**
 * NEMAR API client: dataset catalog, manifests, access/collaborators, and
 * enrichment endpoints.
 *
 * Split from lib/api.ts by endpoint group (#908, epic #902); bodies moved
 * verbatim.
 */

import {
  type DatasetFacetsEnvelope,
  datasetFacetsEnvelopeSchema,
  datasetSearchEnvelopeSchema,
} from "../../../shared/contract/index.js";
import type { UploaderPreflight } from "../../../shared/identifier-screen-report.js";
import { request } from "./client.js";

/** ORCID identifier format: XXXX-XXXX-XXXX-XXXX (last char may be X) */
export const ORCID_REGEX = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

export interface UserCiStatusResponse {
  dataset_id: string;
  bids_validation: {
    present: boolean;
    status: string;
    url: string | null;
  };
}

/**
 * Get CI workflow status for a dataset (user-accessible, owner or admin)
 */
export async function getUserCiStatus(datasetId: string): Promise<UserCiStatusResponse> {
  return request<UserCiStatusResponse>(`/datasets/${datasetId}/ci/status`, {}, true);
}

// ============================================================================
// Manifests
// ============================================================================

export interface ManifestFile {
  key: string;
  size: number;
  checksum: string;
}

export interface VersionManifest {
  dataset_id: string;
  version: string;
  doi: string | null;
  concept_doi: string | null;
  created: string;
  files: Record<string, ManifestFile>;
}

export interface ManifestListResponse {
  dataset_id: string;
  versions: string[];
}

/**
 * List available version manifests for a dataset
 */
export async function listManifestVersions(datasetId: string): Promise<ManifestListResponse> {
  return request<ManifestListResponse>(`/datasets/${datasetId}/manifest`, {}, true);
}

/**
 * Get a specific version manifest for a dataset
 */
export async function getManifest(datasetId: string, version: string): Promise<VersionManifest> {
  return request<VersionManifest>(`/datasets/${datasetId}/manifest/${version}`, {}, true);
}

// ============================================================================
// Datasets
// ============================================================================

export interface Dataset {
  id: number;
  dataset_id: string;
  name: string;
  description: string | null;
  owner_username: string;
  /**
   * Lifecycle state of the dataset.
   * - active: Dataset is operational
   * - archived: Dataset is read-only, preserved for historical reference
   * - deleted: Dataset is soft-deleted, invisible to users
   */
  status: "active" | "archived" | "deleted";
  /**
   * Access control state.
   * - private: Only owner and admins can view (default for new datasets)
   * - public: Visible to all users, accessible via public catalog
   */
  visibility: "public" | "private";
  github_repo: string | null;
  concept_doi: string | null;
  created_at: string;
  /**
   * Withdrawal state (migration 0060). A withdrawn dataset had its concept DOI
   * tombstoned at the registrar and its repo made private; its S3 content is
   * gone by design. NULL/absent means not withdrawn.
   *
   * `status` stays "active" for a withdrawn dataset -- withdrawal is a separate
   * axis from the lifecycle column, not a value of it -- so anything reporting
   * on a dataset has to read this field to avoid presenting a tombstoned
   * dataset as live (#1048).
   */
  withdrawn_at?: string | null;
  withdrawn_reason?: string | null;
  /**
   * #1408: 1 while the deposit conceals its depositor.
   *
   * A separate axis from `visibility`: an anonymous deposit is
   * `visibility: "public"` -- listed, browsable, downloadable -- and still
   * unattributed, so a reader that wants to say who deposited something has to
   * check this too.
   */
  anonymous?: number | null;
  /**
   * The last anonymity verdict (#1409), served only to the owner and to an
   * admin; every other reader gets nulls, because "this deposit has findings"
   * is itself a fact about the person being concealed. `anonymity_findings`
   * and `anonymity_unchecked` are JSON arrays as stored.
   */
  anonymity_status?: "verified" | "findings" | "unverifiable" | null;
  anonymity_checked_at?: string | null;
  anonymity_findings?: string | null;
  anonymity_unchecked?: string | null;
  // Catalog-enriched fields (from nemar_catalog JOIN or catalog-only)
  modalities?: string;
  participants?: number;
  tasks?: string;
  authors?: string;
  /** Free-text license string (e.g. "CC0", "CC-BY-4.0"), or "" when unknown.
      Added in #653; older backends omit it. The website derives a permissiveness
      tier from this for filtering/coloring. */
  license?: string;
  file_size?: number;
  file_size_formatted?: string;
  /** 'managed' = in D1 datasets table, 'catalog' = nemar.org only */
  source_type?: "managed" | "catalog";
  /** DOI field from catalog (for catalog-only datasets) */
  doi?: string | null;
  /** Import source (e.g. "openneuro") */
  source?: string | null;
  /** Original ID at the source (e.g. "ds007315") */
  source_id?: string | null;
  /** Latest published version DOI tag (e.g. "1.0.0"), or null when no
      version has been minted yet. Added in v0.8.9; older backends omit it. */
  latest_version?: string | null;
  /** When `latest_version` was released, as SQLite UTC ("YYYY-MM-DD HH:MM:SS"),
      or null when no version exists. Unlike `updated_at` it is not bumped by
      enrichment or other row writes. Older backends omit it. */
  latest_version_at?: string | null;
  /** HED presence of the latest version (#869): 1 = has HED, 0 = checked/none,
      null = not classified yet. Older backends omit it. */
  has_hed?: number | null;
  /** Declared HEDVersion of the latest version (#869), or null. */
  hed_version?: string | null;
  /** Honest total file count (#970: manifest-first, S3-sum fallback for
      pre-manifest datasets). Older backends omit it. */
  total_files?: number | null;
  /** Data completeness of the latest version (#970): 1 = every annex-keyed
      manifest entry verified present at its declared size, whole or as a
      complete chunk set (#1565), 0 = incomplete (the #967 signature), null =
      not audited yet. Older backends omit it. */
  data_complete?: number | null;
  /** Actual bytes present in S3 (#970) -- distinct from file_size when
      data_complete=0. */
  bytes_present?: number | null;
}

export interface DatasetsListResponse {
  datasets: Dataset[];
  count: number;
  total_count: number;
  limit: number;
  offset: number;
  // Set by the backend when the list query degraded to a basic datasets-only
  // result (catalog/FTS table or consolidation column missing). When present,
  // filters were NOT applied and catalog datasets are NOT included (#646).
  fallback?: boolean;
  warning?: string;
  // Epic #1144 phase 3/4 (#1147/#1148): rows hidden by the default
  // unknown-excluded facet policy -- present only when at least one facet
  // filter (shared/facets.ts) is active. See dataset-facets.ts#buildFacetClauses.
  excluded_unknown?: number;
  // Epic #1144 phase 4 (#1148), D5: per-facet breakdown of excluded_unknown,
  // keyed by FacetKey. Does NOT sum to excluded_unknown -- a dataset unknown
  // in two active facets counts once in the total but once in EACH bucket.
  // Always present together with excluded_unknown, never on its own.
  excluded_unknown_by_facet?: Record<string, number>;
}

export interface DatasetListFilters {
  mine?: boolean;
  search?: string;
  modality?: string;
  author?: string;
  task?: string;
  hasDoi?: boolean;
  /** Only datasets with HED annotations (#869). Serialized as has_hed=1. */
  hasHed?: boolean;
  /** Only datasets with a ready Zarr copy (#1062). Serialized as has_zarr=1. */
  hasZarr?: boolean;
  /** Only datasets whose Zarr copy has passed the fidelity verification
   *  sweep (#1068). Serialized as has_zarr_verified=1. */
  hasZarrVerified?: boolean;
  /** Only datasets verified data-complete (#970). Serialized as data_complete=1. */
  dataComplete?: boolean;
  recent?: number;
  /** Comma-separated license tiers (public, attribution, sharealike,
      noncommercial, noderiv, unknown), OR semantics. #653. */
  license?: string;
  sort?: "newest" | "oldest" | "name" | "participants" | "size" | "citations";
  limit?: number;
  offset?: number;
  owner?: string;
  /** Wire-ready facet query params (queryParam -> canonical value), built by
   *  `lib/facet-options.ts#buildFacetParams` from the declared table in
   *  `shared/facets.ts`. Epic #1144 phase 4 (#1148). */
  facets?: Record<string, string>;
  /** Widen every active facet's predicate to also match rows where that
   *  field is unknown (NULL). Serialized as include_unknown=1. */
  includeUnknown?: boolean;
}

export interface DatasetSearchResult {
  id: string;
  name: string;
  modalities: string;
  participants: number;
  doi: string;
  tasks: string;
  authors: string;
  /** HED presence (#869): 1 = has HED, 0 = checked/none, null = not classified. */
  has_hed?: number | null;
  score: number;
  /** FTS5 highlight (#646, epic #1144 phase 6/#1150 D2): `<mark>`-wrapped
   *  matched terms around a README excerpt. Absent on the exact-id tier and
   *  on semantic rows with no FTS match -- render nothing for those, not a
   *  blank line. Untrusted dataset-supplied prose; sanitise before printing
   *  (`src/lib/render/snippet.ts`), same class as Phase 5b's completion
   *  candidate sanitisation. */
  snippet?: string;
}

export interface DatasetSearchResponse {
  results: DatasetSearchResult[];
  count: number;
  // Additive envelope fields (#1145, epic #1144 phase 1): `count` is now the
  // true total for the query + filters, decoupled from page size (and can
  // legitimately exceed `candidate_ceiling` -- see `truncated`). Types only
  // this phase -- the CLI renders nothing new beyond surfacing `warning`
  // (see src/commands/dataset.ts), same as the list endpoint already does.
  returned?: number;
  offset?: number;
  limit?: number;
  candidate_ceiling?: number;
  /** True when `count` exceeds `candidate_ceiling`: more rows match than
   *  this response's candidate window could ever supply (review round 3 S1). */
  truncated?: boolean;
  method: "semantic" | "text" | "text_fallback" | "exact_id" | "unavailable";
  min_score?: number;
  /** Set only when the backend's exact-count query failed and `count` fell
   *  back to a page-derived lower bound (review round 3 I1). */
  warning?: string;
  /** Epic #1144 phase 3/4 (#1147/#1148): identical semantics to
   *  `DatasetsListResponse#excluded_unknown` -- present only when at least
   *  one facet filter is active. */
  excluded_unknown?: number;
  /** Epic #1144 phase 4 (#1148), D5: identical semantics to
   *  `DatasetsListResponse#excluded_unknown_by_facet` -- per-facet breakdown,
   *  does not sum to `excluded_unknown`, always present alongside it. */
  excluded_unknown_by_facet?: Record<string, number>;
}

/**
 * Filters `nemar dataset search` accepts (epic #1144 phase 4, #1148, D6).
 * Phase 3 already made `GET /datasets/search` honour `license`, `author`,
 * `task`, `has_doi`, `recent`, `data_complete` and the full facet table via
 * the same `parseFilterQuery` the list endpoint uses -- this type is what
 * makes those reachable from the CLI. Deliberately no `search`: this
 * endpoint's free text is the `q` argument, not a `search` query param (D6).
 */
export interface DatasetSearchFilters {
  modality?: string;
  /** Only datasets with HED annotations (#869). Serialized as has_hed=1. */
  hasHed?: boolean;
  /** Only datasets with a ready Zarr copy (#1062). Serialized as has_zarr=1. */
  hasZarr?: boolean;
  /** Only datasets whose Zarr copy has passed the fidelity verification
   *  sweep (#1068). Serialized as has_zarr_verified=1. */
  hasZarrVerified?: boolean;
  limit?: number;
  author?: string;
  task?: string;
  /** Comma-separated license tiers, OR semantics. #653. */
  license?: string;
  hasDoi?: boolean;
  /** Only datasets verified data-complete (#970). Serialized as data_complete=1. */
  dataComplete?: boolean;
  recent?: number;
  /** Wire-ready facet query params, built by
   *  `lib/facet-options.ts#buildFacetParams`. */
  facets?: Record<string, string>;
  /** Widen every active facet's predicate to also match unknown (NULL) rows. */
  includeUnknown?: boolean;
}

/**
 * Validate dataset object has correct status and visibility values
 * Throws error if validation fails
 */
export function validateDataset(data: unknown): Dataset {
  const d = data as Dataset;

  // Catalog-only records have null status; default to "active"
  if (!d.status) {
    d.status = "active";
  } else if (!["active", "archived", "deleted"].includes(d.status)) {
    throw new Error(`Invalid dataset status: ${d.status}`);
  }

  // Default to private if visibility not set (older records missing column)
  if (!d.visibility) {
    d.visibility = "private";
  } else if (!["public", "private"].includes(d.visibility)) {
    throw new Error(`Invalid dataset visibility: ${d.visibility}`);
  }

  return d;
}

/**
 * List datasets with optional filters
 */
export async function listDatasets(
  filters: DatasetListFilters = {},
): Promise<DatasetsListResponse> {
  const params = new URLSearchParams();
  if (filters.mine) params.set("mine", "true");
  if (filters.search) params.set("search", filters.search);
  if (filters.modality) params.set("modality", filters.modality);
  if (filters.author) params.set("author", filters.author);
  if (filters.task) params.set("task", filters.task);
  if (filters.license) params.set("license", filters.license);
  if (filters.hasDoi) params.set("has_doi", "true");
  if (filters.hasHed) params.set("has_hed", "1");
  if (filters.hasZarr) params.set("has_zarr", "1");
  if (filters.hasZarrVerified) params.set("has_zarr_verified", "1");
  if (filters.dataComplete) params.set("data_complete", "1");
  if (filters.recent) params.set("recent", String(filters.recent));
  if (filters.sort) params.set("sort", filters.sort);
  if (filters.limit != null) params.set("limit", String(filters.limit));
  if (filters.offset != null) params.set("offset", String(filters.offset));
  if (filters.owner) params.set("owner", filters.owner);
  if (filters.facets) {
    for (const [key, value] of Object.entries(filters.facets)) {
      params.set(key, value);
    }
  }
  if (filters.includeUnknown) params.set("include_unknown", "1");
  const query = params.toString() ? `?${params.toString()}` : "";
  const response = await request<DatasetsListResponse>(
    `/datasets${query}`,
    {},
    filters.mine ? true : "optional",
  );
  response.datasets = response.datasets.map(validateDataset);
  return response;
}

interface ResolveSourceResult {
  found: boolean;
  dataset_id?: string;
  name?: string;
  github_repo?: string | null;
  owner_username?: string;
}

/**
 * Resolve an OpenNeuro source ID (ds######) to its NEMAR counterpart
 */
export async function resolveSourceId(sourceId: string): Promise<ResolveSourceResult> {
  return request<ResolveSourceResult>(`/datasets/resolve/${sourceId}`, {}, "optional");
}

/**
 * Facet vocabulary with counts (epic #1144 phase 5a's `GET /datasets/facets`,
 * consumed by phase 5b's shell completion, #1149). Optional-auth like the
 * other catalog reads above -- the response is identical for every caller.
 *
 * Bounded like update-check.ts's own npm-registry fetch (same 5s budget):
 * one caller is the opportunistic, fire-and-forget refresh after a
 * successful `dataset list`/`dataset search` (src/lib/completion/refresh.ts)
 * -- without a timeout, a hung connection there would hold the CLI process
 * open well after its output has already been rendered.
 */
export async function getFacets(): Promise<DatasetFacetsEnvelope> {
  return request<DatasetFacetsEnvelope>(
    "/datasets/facets",
    { signal: AbortSignal.timeout(5000) },
    "optional",
    datasetFacetsEnvelopeSchema,
  );
}

/**
 * Semantic dataset search
 *
 * Validated against the shared contract (#1145 review I5) -- previously the
 * only endpoints doing this were the ones burned by a real drift bug
 * (getCurrentUser's #895 nested-envelope regression); search had none, so a
 * backend shape drift here would have silently cast to a malformed
 * `DatasetSearchResponse` instead of failing loudly. The schema's field
 * shapes don't line up 1:1 with this legacy interface (nullable columns,
 * etc.), so the validated value is cast rather than returned as-is -- the
 * validation itself, not the cast, is what the drift guard actually buys.
 */
export async function searchDatasets(
  query: string,
  filters: DatasetSearchFilters = {},
): Promise<DatasetSearchResponse> {
  const params = new URLSearchParams({ q: query });
  if (filters.modality) params.set("modality", filters.modality);
  if (filters.limit) params.set("limit", String(filters.limit));
  if (filters.hasHed) params.set("has_hed", "1");
  if (filters.hasZarr) params.set("has_zarr", "1");
  if (filters.hasZarrVerified) params.set("has_zarr_verified", "1");
  if (filters.author) params.set("author", filters.author);
  if (filters.task) params.set("task", filters.task);
  if (filters.license) params.set("license", filters.license);
  if (filters.hasDoi) params.set("has_doi", "true");
  if (filters.dataComplete) params.set("data_complete", "1");
  if (filters.recent) params.set("recent", String(filters.recent));
  if (filters.facets) {
    for (const [key, value] of Object.entries(filters.facets)) {
      params.set(key, value);
    }
  }
  if (filters.includeUnknown) params.set("include_unknown", "1");
  const response = await request(
    `/datasets/search?${params.toString()}`,
    {},
    "optional",
    datasetSearchEnvelopeSchema,
  );
  return response as unknown as DatasetSearchResponse;
}

interface GetDatasetResponse {
  dataset: Dataset;
}

/**
 * Get a single dataset by ID
 */
export async function getDataset(datasetId: string): Promise<Dataset> {
  const response = await request<GetDatasetResponse>(`/datasets/${datasetId}`, {}, "optional");
  return validateDataset(response.dataset);
}

// ============================================================================
// Version History
// ============================================================================

export interface VersionInfo {
  version: string;
  doi: string;
  provider: "ezid" | "zenodo";
  created_at: string;
}

export interface VersionHistoryResponse {
  dataset_id: string;
  current_version: string;
  versions: VersionInfo[];
}

/**
 * Get version history for a dataset (requires auth)
 */
export async function getVersionHistory(datasetId: string): Promise<VersionHistoryResponse> {
  return request<VersionHistoryResponse>(`/datasets/${datasetId}/versions`, {}, true);
}

export interface FileInfo {
  path: string;
  size: number;
  type: "metadata" | "data";
}

export interface CreateDatasetRequest {
  name: string;
  description?: string;
  files?: FileInfo[];
  sandbox?: boolean; // If true, creates sandbox dataset with xx000xxx ID
  /**
   * Name the id instead of being allocated one (ADR 0068, #1432).
   *
   * Refused unless the request is non-production, the caller is an admin, the
   * id is in the reserved fixture band, and that id is declared dev-owned --
   * see `explicitDatasetIdGate`. It exists because `generateDatasetId` is
   * structurally unable to return a reserved id, so the standing fixtures that
   * live there have no other way in through the route that creates everything
   * else.
   *
   * Omitted by every ordinary upload: a dataset id is allocated, never chosen.
   */
  dataset_id?: string;
  // Deposit attestation (#1077): recorded on the dataset row (migration 0067).
  // Optional at the wire level for older CLIs; collected for every new upload.
  attestation?: AttestationWire;
  /**
   * The identifier preflight this upload ran before sending anything (ADR 0087), recorded with
   * the attestation. Counts and fixed words only; the backend parses it with the same contract.
   */
  identifier_preflight?: UploaderPreflight;
}

/** The attestation as the create and record-attestation routes take it. */
export interface AttestationWire {
  deposit_type: "owner" | "redistribution";
  key_status: "destroyed" | "retained";
  deidentified: true;
  no_duplicate?: boolean;
  upstream_source?: string;
}

/**
 * What the backend says about the identifier preflight it was sent. Absent on a backend that
 * predates the preflight, which drops the field without a word: absent is "not recorded".
 */
export interface PreflightRecording {
  identifier_preflight_recorded?: boolean;
  /** The contract's fixed word when the record was refused at the door. */
  identifier_preflight_refused?: string;
}

export interface CreateDatasetResponse extends PreflightRecording {
  message: string;
  resumed: boolean;
  dataset: {
    id: string;
    dataset_id: string;
    name: string;
    description: string | null;
    github_repo: string;
    github_url: string;
    ssh_url: string;
    s3_prefix: string;
  };
  // Presigned URLs for file uploads (keyed by relative file path)
  upload_urls?: Record<string, string>;
  // S3 configuration for constructing public URLs
  s3_config: {
    bucket: string;
    region: string;
    public_url: string;
  };
}

/**
 * Create a new dataset (requires authentication)
 * Returns dataset info including GitHub repo URL and S3 prefix
 */
export async function createDataset(data: CreateDatasetRequest): Promise<CreateDatasetResponse> {
  return request<CreateDatasetResponse>(
    "/datasets",
    {
      method: "POST",
      body: JSON.stringify(data),
    },
    true,
  );
}

export interface RecordAttestationResponse extends PreflightRecording {
  recorded: boolean;
}

/**
 * Record the deposit attestation, and the identifier preflight with it, on a dataset this upload
 * is resuming (ADR 0087). A resume from a local config never calls `createDataset`, so without
 * this the answers given at the prompt, and the preflight of the files now being sent, would not
 * reach the dataset at all. Owner or admin only, and refused once the dataset is public.
 */
export async function recordDepositAttestation(
  datasetId: string,
  body: { attestation: AttestationWire; identifier_preflight?: UploaderPreflight },
): Promise<RecordAttestationResponse> {
  return request<RecordAttestationResponse>(
    `/datasets/${datasetId}/attestation`,
    { method: "PUT", body: JSON.stringify(body) },
    true,
  );
}

export interface FinalizeDatasetResponse {
  message: string;
  warnings?: string[];
  dataset: {
    dataset_id: string;
    status: string;
    github_url: string;
  };
}

/**
 * Finalize a dataset after upload (requires authentication)
 * Applies branch protection and marks dataset as published
 */
export async function finalizeDataset(datasetId: string): Promise<FinalizeDatasetResponse> {
  return request<FinalizeDatasetResponse>(
    `/datasets/${datasetId}/finalize`,
    {
      method: "POST",
    },
    true,
  );
}

// ============================================================================
// Dataset Access
// ============================================================================

export interface RequestAccessResponse {
  /**
   * "none"      - public dataset; nothing granted (already world-readable)
   * "requested" - private dataset; a pending request was queued for the owner
   */
  action: "none" | "requested";
  message: string;
  dataset_id: string;
  github_repo?: string;
}

/**
 * Request collaborator access to a dataset (requires authentication).
 * Publish-gated: public datasets grant nothing; private datasets queue a
 * request for the owner to approve.
 */
export async function requestDatasetAccess(datasetId: string): Promise<RequestAccessResponse> {
  return request<RequestAccessResponse>(
    `/datasets/${datasetId}/request-access`,
    {
      method: "POST",
    },
    true,
  );
}

export interface AccessRequest {
  username: string;
  github_username: string;
  status: "pending" | "approved" | "denied";
  created_at: string;
  decided_at: string | null;
}

export interface ListAccessRequestsResponse {
  dataset_id: string;
  status: string;
  requests: AccessRequest[];
  count: number;
}

/**
 * List access requests for a dataset (owner/admin only). Defaults to pending.
 */
export async function listAccessRequests(
  datasetId: string,
  status?: "pending" | "approved" | "denied",
): Promise<ListAccessRequestsResponse> {
  const qs = status ? `?status=${status}` : "";
  return request<ListAccessRequestsResponse>(
    `/datasets/${datasetId}/access-requests${qs}`,
    {},
    true,
  );
}

export interface DecideAccessRequestResponse {
  message: string;
  dataset_id: string;
  username: string;
}

/**
 * Approve a pending access request (owner/admin only).
 */
export async function approveAccessRequest(
  datasetId: string,
  username: string,
): Promise<DecideAccessRequestResponse> {
  return request<DecideAccessRequestResponse>(
    `/datasets/${datasetId}/access-requests/${username}/approve`,
    { method: "POST" },
    true,
  );
}

/**
 * Deny a pending access request (owner/admin only).
 */
export async function denyAccessRequest(
  datasetId: string,
  username: string,
): Promise<DecideAccessRequestResponse> {
  return request<DecideAccessRequestResponse>(
    `/datasets/${datasetId}/access-requests/${username}/deny`,
    { method: "POST" },
    true,
  );
}

export interface InviteCollaboratorResponse {
  message: string;
  dataset_id: string;
  invitee: string;
}

/**
 * Invite a user as collaborator to a dataset (owner/admin only)
 */
export async function inviteCollaborator(
  datasetId: string,
  username: string,
): Promise<InviteCollaboratorResponse> {
  return request<InviteCollaboratorResponse>(
    `/datasets/${datasetId}/invite`,
    {
      method: "POST",
      body: JSON.stringify({ username }),
    },
    true,
  );
}

export interface Collaborator {
  username: string;
  github_username: string;
  access_type: "requested" | "invited";
  granted_at: string;
  granted_by_username: string | null;
}

export interface ListCollaboratorsResponse {
  dataset_id: string;
  collaborators: Collaborator[];
  count: number;
}

/**
 * List collaborators for a dataset (owner/admin only)
 */
export async function listCollaborators(datasetId: string): Promise<ListCollaboratorsResponse> {
  return request<ListCollaboratorsResponse>(`/datasets/${datasetId}/collaborators`, {}, true);
}

// ============================================================================
// Enrichment
// ============================================================================

import type { NemarMetadata } from "../../../shared/datacite-constants.js";
export type NemarMetadataPayload = NemarMetadata;

export interface SubmitEnrichmentResponse {
  message: string;
  dataset_id: string;
  committed: boolean;
  bidsignore_updated: boolean;
}

/**
 * Submit metadata enrichment for a dataset (admin only)
 * Commits nemar_metadata.json to the dataset repo and caches in D1.
 */
export async function submitEnrichment(
  datasetId: string,
  metadata: NemarMetadataPayload,
): Promise<SubmitEnrichmentResponse> {
  return request<SubmitEnrichmentResponse>(
    `/admin/datasets/${datasetId}/enrichment`,
    {
      method: "POST",
      body: JSON.stringify(metadata),
    },
    true,
  );
}
