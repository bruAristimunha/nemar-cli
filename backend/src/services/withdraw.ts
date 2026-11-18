/**
 * Dataset withdrawal service (epic #967 phase 4, #971).
 *
 * Withdraws a broken published dataset -- one of the 11 datasets published
 * with 0-byte content whose OpenNeuro source cannot currently be recovered
 * (scripts/withdrawn-datasets.json) -- by flipping its visibility to private
 * (applyDatasetVisibility, services/visibility.ts) and tombstoning every EZID
 * DOI it carries, concept AND every version (`_status=unavailable`), so a
 * resolvable DOI never points at now-private (empty) data. `restoreDataset` is
 * the exact reverse. Both directions are fully reversible: `status`
 * (lifecycle) is untouched, only `visibility` gates catalog/data-plane access.
 *
 * Resumability (review fix, GROUP 1): the visibility flip is the FIRST
 * mutation withdrawDataset performs, and it is the one step that changes the
 * column its OWN precondition used to read. A transient EZID failure right
 * after the flip therefore used to leave a dataset stuck PRIVATE with no
 * recorded withdrawal intent -- indistinguishable from "private for an
 * unrelated reason" and unrecoverable by re-running either command. The fix:
 * `withdrawn_at`/`withdrawn_reason` are stamped (markWithdrawalIntent) right
 * after the visibility flip succeeds, regardless of whether the DOI
 * tombstones that follow succeed, and the precondition is expressed as the
 * pure `decideWithdrawAction` so "never attempted" (fresh), "interrupted,
 * needs finishing" (resume), "private for an unrelated reason" (skip), and
 * "already fully done" (skip) are all distinguishable. Every step re-run on
 * `resume` is independently idempotent (applyDatasetVisibility reads each
 * surface's prior state and skips a stage already at the target; EZID `makeUnavailable`/`makePublic`
 * on an already-tombstoned/public identifier is a harmless no-op), so a
 * resumed run always converges without special-casing.
 *
 * Testability seam (no mocks): the D1 reads/writes below
 * (loadDatasetForTransition / loadVersionDois / markWithdrawalIntent /
 * clearWithdrawalIntent / markConceptEzidStatus / markVersionEzidStatus) and
 * the pure `decideWithdrawAction` are exercised directly in
 * backend/test/withdraw.test.ts against a real in-memory SQLite D1 -- no
 * network. The orchestration functions (withdrawDataset / restoreDataset)
 * call GitHub, S3, and EZID for real once past the precondition checks and
 * the dry-run early-return, so only those two network-free paths
 * (precondition-fail, dry-run) are covered by the pure/CI test tier. The full
 * live round trip additionally needs a real GitHub PAT + AWS S3 credentials
 * (services/visibility.ts's applyDatasetVisibility runs before any EZID
 * call), which the gated test/ezid-sandbox.test.ts does not have by default;
 * see that file's "Withdraw/Restore Orchestration Round Trip" block for
 * exactly what additional env vars make it runnable, and
 * backend/test/visibility.test.ts for applyDatasetVisibility's own
 * network-free branches (not_found/no_repo/invalid_repo).
 */

import { datasetLandingUrl, datasetVersionLandingUrl } from "../../../shared/datacite-constants.js";
import { auditLogStatement } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import { resolveEzidAuth } from "./doi.js";
import { resolveDatasetLandingBase } from "./environment.js";
import { conceptEzidIdentifier, ensureDoiScheme, makePublic, makeUnavailable } from "./ezid.js";
import { applyDatasetVisibility } from "./visibility.js";
import type { VisibilityTransitionResult } from "./visibility.js";

export interface DoiStepResult {
  doi: string;
  kind: "concept" | "version";
  version?: string;
  action: "unavailable" | "public";
  status: "planned" | "ok" | "failed";
  error?: string;
}

/**
 * Mirrors VisibilityTransitionResult's failure branch (services/visibility.ts)
 * minus the `ok` discriminant, so a caller can see exactly which surface
 * desynced (GitHub/S3/D1, plus any revert outcome) instead of a flattened
 * error string (review fix GROUP 2a). Written out literally rather than via
 * `Omit` because `Omit` does not distribute over a union without an extra
 * distributive-conditional helper, and this reads more plainly.
 */
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

/**
 * Discriminated on `skipped`: a precondition failure returns ONLY
 * `dataset_id`/`dry_run`/`skipped` (no network calls, no D1 writes -- see the
 * file header); every other outcome (planned, executed, or a mid-execution
 * failure) carries `visibility` + `dois` together. Review fix GROUP 4a: the
 * previous shape made `visibility`/`dois`/`skipped` independently optional,
 * permitting states like `{skipped, dois}` that printTransitionResult (CLI)
 * already had to defend against at runtime.
 */
export type DatasetTransitionResult =
  | { dataset_id: string; dry_run: boolean; skipped: string; resumed?: boolean }
  | {
      dataset_id: string;
      dry_run: boolean;
      resumed?: boolean;
      visibility: VisibilityStepResult;
      dois: DoiStepResult[];
      /** Set when the audit-log write failed; the operation itself still
       *  succeeded (review fix GROUP 2d, mirrors fleet.ts's visibility route). */
      warning?: string;
    };

interface TransitionOptions {
  dryRun?: boolean;
  /** Acting admin user id for the audit-log row; null for system-initiated calls. */
  actorUserId?: number | null;
}

interface WithdrawCandidate {
  dataset_id: string;
  concept_doi: string | null;
  ezid_status: string | null;
  visibility: string;
  is_sandbox: number | null;
  withdrawn_at: string | null;
}

interface VersionDoiRow {
  version: string;
  doi: string;
  ezid_status: string | null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Strip the `ok` discriminant off a VisibilityTransitionResult failure. */
export function toFailedVisibilityStep(
  failure: Exclude<VisibilityTransitionResult, { ok: true }>,
): Extract<VisibilityStepResult, { status: "failed" }> {
  const { ok: _ok, ...rest } = failure;
  return { status: "failed", ...rest };
}

// ---------------------------------------------------------------------------
// Pure decision logic -- no D1, no network. Exported for direct unit testing.
// ---------------------------------------------------------------------------

export type WithdrawAction = "fresh" | "resume" | "skip-unrelated-private" | "skip-done";

export interface WithdrawDecisionInput {
  visibility: string;
  withdrawnAt: string | null;
  /** datasets.ezid_status: the concept DOI's last recorded status. */
  conceptEzidStatus: string | null;
  /** dataset_versions.ezid_status for every version carrying a DOI. */
  versionEzidStatuses: Array<string | null>;
}

/**
 * Decide what withdrawDataset should do for a dataset that already passed
 * the "has an EZID concept DOI" gate. See the file header for the full
 * rationale; in short:
 *   - fresh: never attempted (visibility public, no withdrawal intent
 *     recorded) -> proceed with a full withdrawal.
 *   - resume: intent was recorded (withdrawn_at set) by a prior attempt that
 *     did not finish tombstoning every DOI -> proceed; every step is
 *     independently idempotent so re-running to completion is always safe.
 *   - skip-unrelated-private: private, but withdrawal intent was never
 *     recorded -- NOT a withdrawal candidate (a private dataset for some
 *     other reason); refuse rather than silently treating it as withdrawn.
 *   - skip-done: intent recorded AND the concept DOI plus every version DOI
 *     are already 'unavailable' -- nothing left to do; skip to avoid
 *     redundant EZID calls.
 */
export function decideWithdrawAction(input: WithdrawDecisionInput): WithdrawAction {
  if (!input.withdrawnAt) {
    return input.visibility === "public" ? "fresh" : "skip-unrelated-private";
  }
  const conceptDone = input.conceptEzidStatus === "unavailable";
  const versionsDone = input.versionEzidStatuses.every((s) => s === "unavailable");
  return conceptDone && versionsDone ? "skip-done" : "resume";
}

// ---------------------------------------------------------------------------
// D1 reads/writes -- pure, no network. Exported for direct unit testing.
// ---------------------------------------------------------------------------

async function loadDatasetForTransition(
  db: D1Database,
  datasetId: string,
): Promise<WithdrawCandidate | null> {
  return db
    .prepare(
      `SELECT dataset_id, concept_doi, ezid_status, visibility, is_sandbox, withdrawn_at
       FROM datasets WHERE dataset_id = ?`,
    )
    .bind(datasetId)
    .first<WithdrawCandidate>();
}

async function loadVersionDois(db: D1Database, datasetId: string): Promise<VersionDoiRow[]> {
  const rows = await db
    .prepare(
      `SELECT version, doi, ezid_status FROM dataset_versions
       WHERE dataset_id = ? AND doi IS NOT NULL AND doi != ''
       ORDER BY version`,
    )
    .bind(datasetId)
    .all<VersionDoiRow>();
  return rows.results ?? [];
}

/**
 * Stamp withdrawal intent. Called right after the visibility flip succeeds,
 * regardless of whether the DOI tombstones that follow succeed, so a
 * transient EZID failure never leaves the dataset stuck private with no
 * recorded intent (see file header). `COALESCE` preserves the original
 * `withdrawn_at` across a resume, so it still reflects when withdrawal was
 * first initiated rather than when it last retried. Pure D1 write; no
 * network.
 */
export async function markWithdrawalIntent(
  db: D1Database,
  datasetId: string,
  reason: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE datasets
       SET withdrawn_at = COALESCE(withdrawn_at, datetime('now')),
           withdrawn_reason = ?,
           updated_at = datetime('now')
       WHERE dataset_id = ?`,
    )
    .bind(reason, datasetId)
    .run();
}

/** Clear a dataset's withdrawal intent (restore). Pure D1 write; no network. */
export async function clearWithdrawalIntent(db: D1Database, datasetId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE datasets
       SET withdrawn_at = NULL, withdrawn_reason = NULL, updated_at = datetime('now')
       WHERE dataset_id = ?`,
    )
    .bind(datasetId)
    .run();
}

/**
 * Set the CONCEPT DOI's `ezid_status` column. Split from the withdrawal-intent
 * columns (withdrawn_at/withdrawn_reason) because it must only be written
 * once the concept DOI's EZID call actually succeeds, while the intent stamp
 * lands earlier and unconditionally (see markWithdrawalIntent). Pure D1
 * write; no network.
 */
export async function markConceptEzidStatus(
  db: D1Database,
  datasetId: string,
  status: "unavailable" | "public",
): Promise<void> {
  await db
    .prepare(
      "UPDATE datasets SET ezid_status = ?, updated_at = datetime('now') WHERE dataset_id = ?",
    )
    .bind(status, datasetId)
    .run();
}

/** Set one version's EZID status. Pure D1 write; no network. */
export async function markVersionEzidStatus(
  db: D1Database,
  datasetId: string,
  version: string,
  status: "unavailable" | "public",
): Promise<void> {
  await db
    .prepare("UPDATE dataset_versions SET ezid_status = ? WHERE dataset_id = ? AND version = ?")
    .bind(status, datasetId, version)
    .run();
}

function buildPlannedDois(
  conceptIdentifier: string,
  versions: VersionDoiRow[],
  action: "unavailable" | "public",
): DoiStepResult[] {
  return [
    { doi: conceptIdentifier, kind: "concept", action, status: "planned" },
    ...versions.map((v) => ({
      doi: v.doi,
      kind: "version" as const,
      version: v.version,
      action,
      status: "planned" as const,
    })),
  ];
}

/** Write the audit-log row; returns a warning string (never throws) when the
 *  write itself fails, mirroring fleet.ts's visibility route so a logging
 *  failure is surfaced to the caller instead of only console.error'd
 *  (review fix GROUP 2d). */
async function logAudit(
  db: D1Database,
  actorUserId: number | null,
  action: "dataset_withdrawn" | "dataset_restored",
  datasetId: string,
  details: Record<string, unknown>,
): Promise<string | undefined> {
  try {
    await auditLogStatement(db, {
      userId: actorUserId,
      action,
      resourceType: "dataset",
      resourceId: datasetId,
      details: JSON.stringify(details),
    }).run();
    return undefined;
  } catch (auditError) {
    const msg = errMsg(auditError);
    console.error(`Audit log write failed for ${action} on ${datasetId}:`, auditError);
    return `Audit log write failed: ${msg}. Operation succeeded but was not logged for compliance.`;
  }
}

// ---------------------------------------------------------------------------
// Orchestration -- GitHub + S3 (via applyDatasetVisibility) + live EZID + D1.
// ---------------------------------------------------------------------------

/**
 * Withdraw a published dataset: flip visibility to private, then tombstone
 * the concept DOI and every version DOI. `dry_run` defaults to true (must
 * pass `{ dryRun: false }` explicitly to execute), matching the fleet
 * enforce/bulk convention so a bare call never mutates.
 *
 * Preconditions that fail return `{ skipped: <reason> }` immediately -- no
 * network calls, no D1 writes -- so a batch run (`--all`) can report a
 * per-dataset reason instead of aborting the whole run. See
 * `decideWithdrawAction` for the fresh/resume/skip decision and the file
 * header for why resumability needed its own fix.
 */
export async function withdrawDataset(
  env: Bindings,
  datasetId: string,
  reason: string,
  opts: TransitionOptions = {},
): Promise<DatasetTransitionResult> {
  const dryRun = opts.dryRun !== false;
  const db = env.DB;

  const dataset = await loadDatasetForTransition(db, datasetId);
  if (!dataset) {
    return { dataset_id: datasetId, dry_run: dryRun, skipped: "Dataset not found" };
  }
  // EZID is the sole provider (ADR 0007), so "has a concept DOI" IS "has an
  // EZID concept DOI"; the identifier is derived, not stored (#1182).
  if (!dataset.concept_doi) {
    return {
      dataset_id: datasetId,
      dry_run: dryRun,
      skipped:
        "Dataset has no EZID concept DOI; withdrawal is only supported for EZID-managed DOIs",
    };
  }
  const conceptIdentifier = conceptEzidIdentifier(dataset.concept_doi);

  const versions = await loadVersionDois(db, datasetId);
  const action = decideWithdrawAction({
    visibility: dataset.visibility,
    withdrawnAt: dataset.withdrawn_at,
    conceptEzidStatus: dataset.ezid_status,
    versionEzidStatuses: versions.map((v) => v.ezid_status),
  });

  if (action === "skip-unrelated-private") {
    return {
      dataset_id: datasetId,
      dry_run: dryRun,
      skipped: `Dataset visibility is already "${dataset.visibility}" but it has never been withdrawn (not a withdrawal candidate)`,
    };
  }
  if (action === "skip-done") {
    return {
      dataset_id: datasetId,
      dry_run: dryRun,
      skipped:
        "Dataset is already fully withdrawn (visibility private, concept + every version DOI unavailable)",
    };
  }

  const resumed = action === "resume";
  const plannedDois = buildPlannedDois(conceptIdentifier, versions, "unavailable");

  if (dryRun) {
    return {
      dataset_id: datasetId,
      dry_run: true,
      resumed,
      visibility: { status: "planned" },
      dois: plannedDois,
    };
  }

  const visibilityResult = await applyDatasetVisibility(env, datasetId, "private");
  if (!visibilityResult.ok) {
    return {
      dataset_id: datasetId,
      dry_run: false,
      resumed,
      visibility: toFailedVisibilityStep(visibilityResult),
      dois: plannedDois.map((d) => ({
        ...d,
        status: "failed" as const,
        error: "not attempted: visibility transition failed",
      })),
    };
  }

  // Stamp intent EARLY -- see file header + markWithdrawalIntent's doc comment.
  await markWithdrawalIntent(db, datasetId, reason);

  const auth = resolveEzidAuth(env, !!dataset.is_sandbox);
  const dois: DoiStepResult[] = [];

  let conceptOk = false;
  try {
    await makeUnavailable(auth, conceptIdentifier, reason);
    conceptOk = true;
    dois.push({
      doi: conceptIdentifier,
      kind: "concept",
      action: "unavailable",
      status: "ok",
    });
  } catch (err) {
    dois.push({
      doi: conceptIdentifier,
      kind: "concept",
      action: "unavailable",
      status: "failed",
      error: errMsg(err),
    });
  }

  for (const v of versions) {
    try {
      // dataset_versions.doi is stored WITHOUT the "doi:" scheme prefix
      // (unlike the derived concept identifier); EZID rejects an unprefixed
      // identifier as "invalid identifier" (bug #984).
      await makeUnavailable(auth, ensureDoiScheme(v.doi), reason);
      await markVersionEzidStatus(db, datasetId, v.version, "unavailable");
      dois.push({
        doi: v.doi,
        kind: "version",
        version: v.version,
        action: "unavailable",
        status: "ok",
      });
    } catch (err) {
      dois.push({
        doi: v.doi,
        kind: "version",
        version: v.version,
        action: "unavailable",
        status: "failed",
        error: errMsg(err),
      });
    }
  }

  // Only stamp the concept DOI's ezid_status once its own EZID call actually
  // succeeded; per-version status was already written above for whichever
  // versions succeeded, independent of the concept outcome, so a partial
  // failure is still recorded accurately. withdrawn_at/withdrawn_reason are
  // already stamped (markWithdrawalIntent, above) regardless of this outcome.
  if (conceptOk) {
    await markConceptEzidStatus(db, datasetId, "unavailable");
  }

  const warning = await logAudit(db, opts.actorUserId ?? null, "dataset_withdrawn", datasetId, {
    reason,
    resumed,
    dois: dois.map((d) => ({ doi: d.doi, status: d.status })),
  });

  return {
    dataset_id: datasetId,
    dry_run: false,
    resumed,
    visibility: { status: "ok" },
    dois,
    ...(warning ? { warning } : {}),
  };
}

/**
 * Restore a withdrawn dataset: the exact reverse of `withdrawDataset` --
 * flip visibility back to public, then makePublic the concept DOI and every
 * version DOI. Requires the dataset to actually be withdrawn
 * (`withdrawn_at` set); restore is not a generic "make public" -- that's
 * publishing (`POST /admin/publish/:id/approve` or `make-public`) + `doi/update --make-public`;
 * `PATCH /admin/datasets/:id/visibility` is refused with 409 (ADR 0125).
 *
 * Unlike withdrawDataset, restore's precondition already keys on
 * `withdrawn_at` (the column the operation itself clears LAST, on success),
 * not on `visibility` (the column the operation mutates FIRST) -- so a
 * partial failure here (visibility flipped to public, then a DOI call
 * throws) leaves `withdrawn_at` still set, and a re-run naturally resumes:
 * the precondition still passes, and every step (visibility flip, EZID
 * `makePublic`) is independently idempotent. No GROUP-1-style fix needed.
 */
export async function restoreDataset(
  env: Bindings,
  datasetId: string,
  opts: TransitionOptions = {},
): Promise<DatasetTransitionResult> {
  const dryRun = opts.dryRun !== false;
  const db = env.DB;

  const dataset = await loadDatasetForTransition(db, datasetId);
  if (!dataset) {
    return { dataset_id: datasetId, dry_run: dryRun, skipped: "Dataset not found" };
  }
  // Same derived-identifier gate as withdrawDataset above (#1182, ADR 0007).
  if (!dataset.concept_doi) {
    return {
      dataset_id: datasetId,
      dry_run: dryRun,
      skipped: "Dataset has no EZID concept DOI; restore is only supported for EZID-managed DOIs",
    };
  }
  const conceptIdentifier = conceptEzidIdentifier(dataset.concept_doi);
  if (!dataset.withdrawn_at) {
    return {
      dataset_id: datasetId,
      dry_run: dryRun,
      skipped: "Dataset was not withdrawn (withdrawn_at is not set)",
    };
  }

  const versions = await loadVersionDois(db, datasetId);
  const plannedDois = buildPlannedDois(conceptIdentifier, versions, "public");

  if (dryRun) {
    return {
      dataset_id: datasetId,
      dry_run: true,
      visibility: { status: "planned" },
      dois: plannedDois,
    };
  }

  const visibilityResult = await applyDatasetVisibility(env, datasetId, "public");
  if (!visibilityResult.ok) {
    return {
      dataset_id: datasetId,
      dry_run: false,
      visibility: toFailedVisibilityStep(visibilityResult),
      dois: plannedDois.map((d) => ({
        ...d,
        status: "failed" as const,
        error: "not attempted: visibility transition failed",
      })),
    };
  }

  const auth = resolveEzidAuth(env, !!dataset.is_sandbox);
  const landingBase = resolveDatasetLandingBase(env);
  const dois: DoiStepResult[] = [];

  let conceptOk = false;
  try {
    await makePublic(auth, conceptIdentifier, datasetLandingUrl(datasetId, landingBase));
    conceptOk = true;
    dois.push({ doi: conceptIdentifier, kind: "concept", action: "public", status: "ok" });
  } catch (err) {
    dois.push({
      doi: conceptIdentifier,
      kind: "concept",
      action: "public",
      status: "failed",
      error: errMsg(err),
    });
  }

  for (const v of versions) {
    try {
      // See the makeUnavailable loop above: dataset_versions.doi has no
      // "doi:" prefix, EZID needs one (bug #984).
      await makePublic(
        auth,
        ensureDoiScheme(v.doi),
        datasetVersionLandingUrl(datasetId, v.version, landingBase),
      );
      await markVersionEzidStatus(db, datasetId, v.version, "public");
      dois.push({
        doi: v.doi,
        kind: "version",
        version: v.version,
        action: "public",
        status: "ok",
      });
    } catch (err) {
      dois.push({
        doi: v.doi,
        kind: "version",
        version: v.version,
        action: "public",
        status: "failed",
        error: errMsg(err),
      });
    }
  }

  if (conceptOk) {
    await clearWithdrawalIntent(db, datasetId);
    await markConceptEzidStatus(db, datasetId, "public");
  }

  const warning = await logAudit(db, opts.actorUserId ?? null, "dataset_restored", datasetId, {
    dois: dois.map((d) => ({ doi: d.doi, status: d.status })),
  });

  return {
    dataset_id: datasetId,
    dry_run: false,
    visibility: { status: "ok" },
    dois,
    ...(warning ? { warning } : {}),
  };
}
