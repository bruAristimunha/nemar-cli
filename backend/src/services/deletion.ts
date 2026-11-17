/**
 * Dataset cascade deletion service
 *
 * Shared logic for deleting a dataset and all its associated resources:
 * GitHub repo, S3 objects, and D1 database records. Used by both the
 * admin DELETE endpoint and the scheduled cleanup cron.
 */

import { SYSTEM_USER_ID } from "../lib/constants.js";
import type { Bindings } from "../types/bindings.js";
import { isDevOwnedDatasetId, isValidDatasetId } from "./datasetId.js";
import { isNonProductionEnv } from "./environment.js";
import { getDatasetsToken } from "./github-auth.js";
import { deleteRepository } from "./github.js";
import { type DeleteResult, deleteDatasetObjects, markDatasetPublic } from "./s3.js";

export interface DeletionSteps {
  github: { success: boolean; error?: string };
  s3: DeleteResult & { skipped?: boolean };
  d1: {
    success: boolean;
    versionsDeleted: number;
    pubRequestsDeleted: number;
    s3PermsDeleted: number;
    error?: string;
  };
  /** #646 Phase 4: Vectorize vector removal (skipped when VECTORIZE unbound). */
  vectorize: { success: boolean; skipped?: boolean; error?: string };
}

export interface DeletionResult {
  datasetId: string;
  deleted: boolean;
  steps: DeletionSteps;
  warnings: string[];
  /**
   * How many `published` derivatives of this dataset the derivative store keeps (portable compute, card V1b;
   * ADR 0123 decision 5). Deleting a dataset expires its `canary` and `catalog` derivatives and NEVER a
   * `published` one: nothing published is deleted by code, so the owner is told what stays.
   */
  published_derivatives_held: number;
}

/**
 * Delete a dataset and all associated resources.
 *
 * Steps:
 * 1. Delete GitHub repository (idempotent, continues on 404)
 * 2. Delete S3 objects (unless skipS3 is set)
 * 3. Delete D1 records (dataset_versions, publication_requests,
 *    dataset_collaborators, datasets) in a single atomic batch
 */
/**
 * Thrown when a non-production worker attempts to cascade-delete a dataset
 * outside the dev id band. Typed so routes can answer 403 (a deliberate refusal
 * the caller can act on) instead of letting it surface as a generic 500.
 */
export class ProdRepoFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProdRepoFenceError";
  }
}

export async function deleteDatasetCascade(
  db: D1Database,
  env: Bindings,
  datasetId: string,
  options: { skipS3?: boolean; bypassGovernance?: boolean } = {},
): Promise<DeletionResult> {
  if (!isValidDatasetId(datasetId)) {
    throw new Error(`Invalid dataset ID: "${datasetId}"`);
  }

  // Prod-repo fence for non-production workers (epic #923).
  //
  // Step 1 below deletes `nemarDatasets/<datasetId>` and that half is NOT
  // environment-scoped: the org name is hardcoded and getDatasetsToken resolves
  // the same org-wide credential everywhere. The S3 and D1 halves ARE scoped
  // (env.S3_BUCKET, env.DB), so on the dev/staging worker only the GitHub
  // deletion can reach production — and dev's D1 is a partial PRODUCTION MIRROR,
  // so a real id like nm000103 resolves to a real row there. Worse, the manual
  // delete endpoints skip their extra confirmations for private/no-DOI datasets,
  // which is exactly how the LIVE nm000103-nm000107 datasets are kept.
  //
  // scheduledCleanup already fences its automated path by ID band; this is the
  // same fence at the single choke point every manual caller shares
  // (admin delete-dataset, admin bulk-delete, draft delete, import rollback,
  // and services/import-recovery.ts's auto-rollback, which is automated rather
  // than manual -- widening this fence widens it there too).
  // Non-production may only cascade ids it OWNS: the dev sandbox partition
  // (xx09NNNN, SANDBOX_ID_FLOOR=90001) plus the reserved fixtures declared
  // dev-owned in datasetId.ts (#1440). The second term exists because a
  // standing fixture at a reserved `nm` id is dev's to delete and rebuild, and
  // without it the documented recovery for a failed fixture build -- delete,
  // then recreate -- was refused on the only worker that could run it.
  // nm099999 is NOT dev-owned and stays refused here: production has it too.
  if (isNonProductionEnv(env) && !isDevOwnedDatasetId(datasetId)) {
    throw new ProdRepoFenceError(
      `Refusing to delete "${datasetId}" from a non-production worker: cascade deletion removes the GitHub repository nemarDatasets/${datasetId}, which is shared with production. Non-production may only delete ids it owns (xx090000-xx099999, plus its declared reserved fixtures).`,
    );
  }

  // Refuse folded legacy catalog rows (#646): they are sentinel-owned with no
  // GitHub repo or S3 objects of their own, and the upstream nemar.org catalog
  // sync re-folds them into `datasets` on its next run, so deleting one here
  // would only drop it until the next sweep re-creates it. The real fix is to
  // remove the dataset from the upstream nemar.org catalog.
  // ownerRow is null when the dataset doesn't exist: optional-chaining lets it
  // fall through to the cascade, which no-ops correctly on a missing row.
  const ownerRow = await db
    .prepare("SELECT owner_user_id FROM datasets WHERE dataset_id = ?")
    .bind(datasetId)
    .first<{ owner_user_id: number }>();
  if (ownerRow?.owner_user_id === SYSTEM_USER_ID) {
    throw new Error(
      `Refusing to delete system catalog dataset "${datasetId}" (owner=nemar-system); it is managed by the nemar.org catalog sync.`,
    );
  }

  const warnings: string[] = [];
  const steps: DeletionSteps = {
    github: { success: false },
    s3: { deleted: 0, failed: [], skipped: false },
    d1: { success: false, versionsDeleted: 0, pubRequestsDeleted: 0, s3PermsDeleted: 0 },
    vectorize: { success: false },
  };

  // Step 1: Delete GitHub repository
  try {
    await deleteRepository(datasetId, await getDatasetsToken(env));
    steps.github.success = true;
  } catch (err) {
    steps.github.error = err instanceof Error ? err.message : String(err);
    warnings.push(`GitHub repo deletion failed: ${steps.github.error}`);
  }

  // Step 2: Delete S3 objects
  if (options.skipS3) {
    steps.s3.skipped = true;
  } else {
    const s3Options = {
      bucket: env.S3_BUCKET,
      region: env.AWS_REGION,
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    };
    try {
      const s3Result = await deleteDatasetObjects(
        s3Options,
        datasetId,
        options.bypassGovernance ?? false,
      );
      steps.s3.deleted = s3Result.deleted;
      steps.s3.failed = s3Result.failed;
      if (s3Result.failed.length > 0) {
        warnings.push(`${s3Result.failed.length} S3 objects failed to delete`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`S3 deletion failed: ${msg}`);
      steps.s3.failed.push({ key: `${datasetId}/*`, error: msg });
    }

    // Drop the dataset's private carve-out from the bucket policy so it does
    // not linger after the prefix is gone. Best-effort: a stale carve-out is
    // harmless (it keeps a now-empty prefix private), so a failure here must
    // not fail the deletion.
    try {
      await markDatasetPublic(s3Options, datasetId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Bucket-policy carve-out cleanup failed: ${msg}`);
    }
  }

  // Step 3: Delete D1 records (batched for atomicity)
  let publishedDerivativesHeld = 0;
  try {
    // The count of kept derivatives is read from the batch by the statement that asked for it, never by a
    // position that the next statement added to the batch would move.
    const heldDerivatives = db
      .prepare(
        "SELECT COUNT(*) AS n FROM compute_derivatives WHERE dataset_id = ? AND retention = 'published'",
      )
      .bind(datasetId);
    const statements = [
      db.prepare("DELETE FROM dataset_versions WHERE dataset_id = ?").bind(datasetId),
      db.prepare("DELETE FROM publication_requests WHERE dataset_id = ?").bind(datasetId),
      db
        .prepare(
          "DELETE FROM dataset_collaborators WHERE dataset_id IN (SELECT id FROM datasets WHERE dataset_id = ?)",
        )
        .bind(datasetId),
      db.prepare("DELETE FROM user_s3_permissions WHERE s3_prefix = ?").bind(datasetId),
      // The record of an upstream re-pull has no foreign key to `datasets` (migration 0105), so it
      // is deleted here, its screens first (migration 0106): their foreign key cascades on D1, but
      // the delete does not rely on the pragma. Placed after the indexed results above so their
      // positions do not move. The automatic path's dispatches (migration 0112) have no foreign
      // key either, and some have no re-pull row at all (a run refused before its create), so they
      // go by dataset, before the re-pull rows. An administrator's acceptance of a merge made
      // without its trailers (migration 0113) goes with its re-pull the way a screen does.
      db
        .prepare(
          "DELETE FROM upstream_repull_screens WHERE repull_id IN (SELECT id FROM upstream_repulls WHERE dataset_id = ?)",
        )
        .bind(datasetId),
      db
        .prepare(
          "DELETE FROM upstream_repull_merge_acceptances WHERE repull_id IN (SELECT id FROM upstream_repulls WHERE dataset_id = ?)",
        )
        .bind(datasetId),
      db.prepare("DELETE FROM upstream_repull_dispatches WHERE dataset_id = ?").bind(datasetId),
      db.prepare("DELETE FROM upstream_repulls WHERE dataset_id = ?").bind(datasetId),
      // NEMAR's own pipeline stamps (migration 0117) have no foreign key and go with the dataset. The
      // JOB rows and the ledger of the runs stay, by design (design section 9): they are the record of
      // what was spent, and carry no dataset-level data.
      db
        .prepare("DELETE FROM compute_pipeline_stamps WHERE dataset_id = ?")
        .bind(datasetId),
      // The derivative store (migration 0143, ADR 0123 decision 5): a deleted dataset's `canary` and
      // `catalog` derivatives are due now (the store's next sync marks them `expired` and deletes their
      // objects, the rows staying), and its `published` ones are KEPT, never touched by code. The count of
      // the kept ones is read in the same batch and reported to the owner. The rows have no foreign key.
      db
        .prepare(
          `UPDATE compute_derivatives SET expires_at = datetime('now')
            WHERE dataset_id = ? AND retention IN ('canary', 'catalog') AND state IN ('copying', 'stored')`,
        )
        .bind(datasetId),
      heldDerivatives,
      db.prepare("DELETE FROM datasets WHERE dataset_id = ?").bind(datasetId),
    ];
    const batchResults = await db.batch(statements);

    steps.d1.versionsDeleted = batchResults[0].meta.changes ?? 0;
    steps.d1.pubRequestsDeleted = batchResults[1].meta.changes ?? 0;
    steps.d1.s3PermsDeleted = batchResults[3].meta.changes ?? 0;
    publishedDerivativesHeld = Number(
      (
        batchResults[statements.indexOf(heldDerivatives)]?.results?.[0] as
          | { n?: number }
          | undefined
      )?.n ?? 0,
    );
    steps.d1.success = true;
  } catch (err) {
    steps.d1.error = err instanceof Error ? err.message : String(err);
    warnings.push(`D1 cleanup failed: ${steps.d1.error}`);
  }

  // Step 4: remove the Vectorize vector (#646 Phase 4) so a deleted dataset
  // can't surface as an orphan that the id-only hydration then drops. Guarded +
  // non-fatal: a Vectorize blip shouldn't block the rest of the cascade.
  if (!env.VECTORIZE) {
    steps.vectorize.skipped = true;
  } else {
    try {
      await env.VECTORIZE.deleteByIds([datasetId]);
      steps.vectorize.success = true;
    } catch (err) {
      steps.vectorize.error = err instanceof Error ? err.message : String(err);
      warnings.push(`Vectorize deletion failed: ${steps.vectorize.error}`);
    }
  }

  return {
    datasetId,
    deleted:
      steps.d1.success && steps.github.success && (options.skipS3 || steps.s3.failed.length === 0),
    steps,
    warnings,
    published_derivatives_held: publishedDerivativesHeld,
  };
}
