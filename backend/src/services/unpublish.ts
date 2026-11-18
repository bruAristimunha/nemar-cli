/**
 * Unpublish: take a dataset back to the unpublished, private state, as its authors ask
 * (ADR 0125).
 *
 * This is NOT `withdraw` (services/withdraw.ts). Withdraw is for a dataset that is broken or
 * removed: it makes the repository private AND tombstones every EZID DOI, so a resolvable DOI
 * never points at data that is gone. Unpublish is for a dataset that is fine and whose authors
 * want it back: it makes the dataset private everywhere and resets the publication state, and it
 * never calls EZID. The concept DOI and every version DOI stay exactly as they were (a DOI
 * cannot be withdrawn once minted, so the registrar is not asked to forget one), and the dataset
 * can be published again through the ordinary request.
 *
 * Why this exists as one operation: the bare visibility flip that preceded it
 * (`PATCH /admin/datasets/:id/visibility`, now refused) changed GitHub, S3 and the catalog row
 * and left the publication record saying "published". nm000289 was left that way on 2026-10-29:
 * private everywhere, with a `published` request, DOIs and versions behind it, so `publish
 * status` reported a finished publication of a dataset nobody could reach.
 *
 * What it does, in order, for a dataset that is public or carries a live publication record:
 *   1. refuses what it must not touch: a live dataset (nm000103-nm000107), an exemplar, a
 *      withdrawn dataset (that is `restore`), a dataset that is private with nothing to reset;
 *   2. applyDatasetVisibility(private): GitHub repository, S3 policy, D1 `visibility`, repo spec
 *      (the branch ruleset comes off so the owner can push again), collaborator reconcile, with
 *      revert-on-failure at each stage. It is idempotent, so a dataset that is ALREADY private
 *      (the nm000289 half state) is repaired by running it again;
 *   3. stamps `publication_requests.unpublished_at` on every request still `published`, so the
 *      owner's `publish status` stops reporting a publication and a new request can be filed;
 *   4. writes the `dataset_unpublished` audit row, with the reason.
 *
 * What it leaves alone, on purpose: `first_published_at` (a public repository's history has
 * been public, so anonymity is still unavailable, ADR 0065), `concept_doi`, `ezid_status`,
 * `dataset_versions` (the DOIs), the tag protection ruleset and the S3 object lock (both guard
 * the published versions, which still exist), collaborators, and access requests.
 *
 * `dry_run` defaults to true. Returns a structured result like `withdrawDataset`.
 */

import { isLiveDataset } from "../constants.js";
import { auditLogStatement } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import { applyDatasetVisibility } from "./visibility.js";
import { toFailedVisibilityStep } from "./withdraw.js";
import type { VisibilityStepResult } from "./withdraw.js";

/** Which of the three states the dataset was in, so the report says what was repaired. */
export type UnpublishCase =
  /** Public, with a live `published` request: the ordinary pull-back. */
  | "published"
  /** Public with no publication record (an import, an anonymous release, a bare flip). */
  | "public-never-published"
  /** Already private, but a `published` request still stands: the nm000289 half state. */
  | "private-with-live-publication-record";

export type UnpublishResult =
  | { dataset_id: string; dry_run: boolean; skipped: string }
  | {
      dataset_id: string;
      dry_run: boolean;
      case: UnpublishCase;
      visibility: VisibilityStepResult;
      /** `published` requests stamped `unpublished_at` (planned count on a dry run). */
      publication_requests_reset: number;
      /** The DOIs left exactly as they were; EZID is never called. */
      dois_untouched: { concept: string | null; versions: number };
      /** Set when the audit-log write failed; the operation itself still succeeded. */
      warning?: string;
    };

export interface UnpublishOptions {
  dryRun?: boolean;
  /** Acting admin user id for the audit-log row. */
  actorUserId?: number | null;
}

interface UnpublishCandidate {
  dataset_id: string;
  visibility: string;
  concept_doi: string | null;
  withdrawn_at: string | null;
  is_exemplar: number | null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Classify a dataset for unpublishing, or say why it is not a candidate. Pure: no D1, no
 * network. Exported so the decision is testable beside the route that drives it.
 */
export function decideUnpublish(input: {
  datasetId: string;
  visibility: string;
  withdrawnAt: string | null;
  isExemplar: boolean;
  liveRequests: number;
}): { case: UnpublishCase } | { skipped: string } {
  if (isLiveDataset(input.datasetId)) {
    return {
      skipped: `${input.datasetId} is a live dataset (AGENTS.md: nm000103-nm000107); it is never unpublished by a tool`,
    };
  }
  if (input.isExemplar) {
    return { skipped: "Dataset is an exemplar; the exemplar fleet is permanent" };
  }
  if (input.withdrawnAt) {
    return {
      skipped:
        "Dataset is withdrawn (its DOIs are tombstoned); reverse that with 'nemar admin repo restore', not unpublish",
    };
  }
  if (input.visibility === "public") {
    return { case: input.liveRequests > 0 ? "published" : "public-never-published" };
  }
  if (input.liveRequests > 0) return { case: "private-with-live-publication-record" };
  return {
    skipped: "Dataset is already private and has no live publication record; nothing to unpublish",
  };
}

export async function unpublishDataset(
  env: Bindings,
  datasetId: string,
  reason: string,
  opts: UnpublishOptions = {},
): Promise<UnpublishResult> {
  const dryRun = opts.dryRun !== false;
  const db = env.DB;

  const dataset = await db
    .prepare(
      `SELECT dataset_id, visibility, concept_doi, withdrawn_at, is_exemplar
       FROM datasets WHERE dataset_id = ?`,
    )
    .bind(datasetId)
    .first<UnpublishCandidate>();
  if (!dataset) return { dataset_id: datasetId, dry_run: dryRun, skipped: "Dataset not found" };

  const live = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM publication_requests
       WHERE dataset_id = ? AND status = 'published' AND unpublished_at IS NULL`,
    )
    .bind(datasetId)
    .first<{ n: number }>();
  const liveRequests = live?.n ?? 0;

  const decision = decideUnpublish({
    datasetId,
    visibility: dataset.visibility,
    withdrawnAt: dataset.withdrawn_at,
    isExemplar: dataset.is_exemplar === 1,
    liveRequests,
  });
  if ("skipped" in decision) {
    return { dataset_id: datasetId, dry_run: dryRun, skipped: decision.skipped };
  }

  const versions = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM dataset_versions WHERE dataset_id = ? AND doi IS NOT NULL AND doi != ''",
    )
    .bind(datasetId)
    .first<{ n: number }>();
  const dois_untouched = { concept: dataset.concept_doi, versions: versions?.n ?? 0 };

  if (dryRun) {
    return {
      dataset_id: datasetId,
      dry_run: true,
      case: decision.case,
      visibility: { status: "planned" },
      publication_requests_reset: liveRequests,
      dois_untouched,
    };
  }

  const flip = await applyDatasetVisibility(env, datasetId, "private");
  if (!flip.ok) {
    // Nothing else was written: the publication record still describes the dataset as it is,
    // and a retry starts from the same state.
    return {
      dataset_id: datasetId,
      dry_run: false,
      case: decision.case,
      visibility: toFailedVisibilityStep(flip),
      publication_requests_reset: 0,
      dois_untouched,
    };
  }

  const reset = await db
    .prepare(
      `UPDATE publication_requests
       SET unpublished_at = datetime('now'), updated_at = datetime('now')
       WHERE dataset_id = ? AND status = 'published' AND unpublished_at IS NULL`,
    )
    .bind(datasetId)
    .run();
  await db
    .prepare("UPDATE datasets SET updated_at = datetime('now') WHERE dataset_id = ?")
    .bind(datasetId)
    .run();

  let warning: string | undefined;
  try {
    await auditLogStatement(db, {
      userId: opts.actorUserId ?? null,
      action: "dataset_unpublished",
      resourceType: "dataset",
      resourceId: datasetId,
      details: JSON.stringify({
        reason,
        case: decision.case,
        publication_requests_reset: reset.meta.changes,
        concept_doi: dataset.concept_doi,
        version_dois: dois_untouched.versions,
        ezid_called: false,
      }),
    }).run();
  } catch (auditError) {
    console.error(`Audit log write failed for dataset_unpublished on ${datasetId}:`, auditError);
    warning = `Audit log write failed: ${errMsg(auditError)}. Operation succeeded but was not logged for compliance.`;
  }

  return {
    dataset_id: datasetId,
    dry_run: false,
    case: decision.case,
    visibility: { status: "ok" },
    publication_requests_reset: reset.meta.changes,
    dois_untouched,
    warning,
  };
}
