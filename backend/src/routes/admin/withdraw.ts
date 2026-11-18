/**
 * Admin routes: dataset withdrawal / restore (epic #967 phase 4, #971).
 *
 * Thin HTTP wrappers over services/withdraw.ts: `dry_run` defaults to TRUE on
 * both endpoints (mirror POST /datasets/:id/enforce, fleet.ts) so a bare `{}`
 * body never mutates. There is no per-endpoint prod guard here beyond the
 * ordinary admin-role check -- the safety comes from the default dry-run, the
 * per-dataset precondition checks in the service, and (for the real
 * production run) the CLI's own not-on-the-checked-in-list `--force` guard,
 * which is client-side (scripts/withdrawn-datasets.json is never loaded by
 * the Worker).
 *
 * Status codes (review fix GROUP 2c): a precondition skip or a dry-run plan
 * always returns 200 -- both are informational no-ops by design (so `--all`
 * never needs per-dataset status-code branching for the common "not a
 * withdrawal candidate" case), not failures. An outright visibility-stage
 * failure maps to the status the visibility transition's stage names
 * (404/400/500; fleet.ts PATCH /visibility is refused with 409 and no longer uses them), and a completed transition with one or more failed DOI
 * steps returns 207 Multi-Status (mirrors ci/sync's convention) -- both keep
 * the full structured body (visibility detail + per-DOI status) in the
 * response, and 207 stays in the 2xx-family `response.ok` range so the CLI
 * client still gets it back as a normal result, not a thrown ApiError.
 *
 * On a non-2xx, the CLI's shared `request()` helper (src/lib/api/client.ts)
 * throws an ApiError built from the JSON body's top-level `error`/`message`
 * field -- which this result shape doesn't otherwise have (it uses
 * `visibility.error` nested under the stage detail). `bodyForResult` adds
 * that top-level `error` ONLY on the non-2xx path, so the thrown ApiError's
 * message is the actual visibility failure reason instead of a generic
 * "Request failed", while the full structured body (still readable via
 * `error.details` today, or a future caller that reads the raw response)
 * stays intact.
 */

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { DatasetTransitionResult } from "../../services/withdraw";
import { restoreDataset, withdrawDataset } from "../../services/withdraw";
import type { AdminRouter } from "./shared";

export function statusForVisibilityStage(
  stage: "not_found" | "no_repo" | "invalid_repo" | "github" | "s3" | "db",
): 404 | 400 | 500 {
  switch (stage) {
    case "not_found":
      return 404;
    case "no_repo":
      return 400;
    default:
      return 500;
  }
}

/** Pick the response status for a withdraw/restore result. */
function statusForResult(result: DatasetTransitionResult): 200 | 207 | 400 | 404 | 500 {
  if ("skipped" in result || result.dry_run) return 200;
  if (result.visibility.status === "failed") {
    return statusForVisibilityStage(result.visibility.stage);
  }
  return result.dois.some((d) => d.status === "failed") ? 207 : 200;
}

/** Add a top-level `error` field mirroring the visibility failure -- see the
 *  file header for why. A no-op for every other outcome (skipped/dry-run/ok/
 *  partial-DOI-failure), which are all 2xx and never thrown as an ApiError. */
function bodyForResult(
  result: DatasetTransitionResult,
): DatasetTransitionResult & { error?: string } {
  if (!("skipped" in result) && result.visibility.status === "failed") {
    return { ...result, error: result.visibility.error };
  }
  return result;
}

export function registerWithdrawRoutes(admin: AdminRouter): void {
  const withdrawSchema = z.object({
    reason: z.string().min(1).optional(),
    dry_run: z.boolean().optional(),
  });

  /**
   * POST /admin/datasets/:id/withdraw - Make a dataset private and tombstone
   * its concept + version EZID DOIs. `dry_run` defaults to true.
   */
  admin.post("/datasets/:id/withdraw", zValidator("json", withdrawSchema), async (c) => {
    const datasetId = c.req.param("id");
    const body = c.req.valid("json");
    const dryRun = body.dry_run !== false;
    const adminUser = c.get("user");

    if (!dryRun && !body.reason) {
      return c.json({ error: "reason is required to execute a withdrawal" }, 400);
    }

    const result = await withdrawDataset(c.env, datasetId, body.reason ?? "", {
      dryRun,
      actorUserId: adminUser.id,
    });
    return c.json(bodyForResult(result), statusForResult(result));
  });

  const restoreSchema = z.object({
    dry_run: z.boolean().optional(),
  });

  /**
   * POST /admin/datasets/:id/restore - Reverse a withdrawal: make the dataset
   * public again and restore its concept + version EZID DOIs. `dry_run`
   * defaults to true.
   */
  admin.post("/datasets/:id/restore", zValidator("json", restoreSchema), async (c) => {
    const datasetId = c.req.param("id");
    const body = c.req.valid("json");
    const dryRun = body.dry_run !== false;
    const adminUser = c.get("user");

    const result = await restoreDataset(c.env, datasetId, {
      dryRun,
      actorUserId: adminUser.id,
    });
    return c.json(bodyForResult(result), statusForResult(result));
  });
}
