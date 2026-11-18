/**
 * Admin route: unpublish (ADR 0125).
 *
 * POST /admin/datasets/:id/unpublish takes a dataset back to the unpublished, private state:
 * private on GitHub, S3 and in the catalog, the publication record reset, every DOI left
 * untouched (EZID is never called), and a later publication request allowed. `dry_run`
 * defaults to true, like withdraw, so a bare `{}` body never mutates.
 *
 * It is the only way to make a published dataset private. `withdraw` is the other,
 * for a broken or removed dataset, and it tombstones the DOIs; the two are not interchangeable.
 *
 * Status codes follow withdraw.ts: a skip and a dry-run plan are 200; a failed visibility
 * stage maps to 404/400/500 with the structured body kept and a top-level `error` added.
 */

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { type UnpublishResult, unpublishDataset } from "../../services/unpublish";
import type { AdminRouter } from "./shared";
import { statusForVisibilityStage } from "./withdraw";

function statusForResult(result: UnpublishResult): 200 | 400 | 404 | 500 {
  if ("skipped" in result) return 200;
  if (result.record_error) return 500;
  if (result.visibility.status === "failed") {
    return statusForVisibilityStage(result.visibility.stage) as 400 | 404 | 500;
  }
  return 200;
}

export function registerUnpublishRoutes(admin: AdminRouter): void {
  const unpublishSchema = z.object({
    reason: z.string().min(1).optional(),
    dry_run: z.boolean().optional(),
  });

  admin.post(
    "/datasets/:id/unpublish",
    zValidator("json", unpublishSchema, (result, c) => {
      if (!result.success) {
        const why = result.error.issues
          .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
          .join("; ");
        return c.json({ error: `Invalid request body: ${why}` }, 400);
      }
    }),
    async (c) => {
      const datasetId = c.req.param("id");
      const body = c.req.valid("json");
      const dryRun = body.dry_run !== false;

      if (!dryRun && !body.reason) {
        return c.json({ error: "reason is required to execute an unpublish" }, 400);
      }

      const result = await unpublishDataset(c.env, datasetId, body.reason ?? "", {
        dryRun,
        actorUserId: c.get("user").id,
      });
      const status = statusForResult(result);
      if (!("skipped" in result) && result.visibility.status === "failed") {
        return c.json({ ...result, error: result.visibility.error }, status);
      }
      if (!("skipped" in result) && result.record_error) {
        return c.json({ ...result, error: result.record_error }, status);
      }
      return c.json(result, status);
    },
  );
}
