/**
 * Admin routes for the dataset pull-request review queue (ADR 0093, following ADR 0092):
 *
 *   GET    /admin/pr-reviews                      every open pull request to `main`, with its review
 *   GET    /admin/pr-reviews/:dataset/:pr         one pull request: stored report, history, author
 *                                                 (`?head=<sha>` asks about that commit, not GitHub's)
 *   GET    /admin/pr-review-authors/:login        a contributor's tally, override and standing
 *   PUT    /admin/pr-review-authors/:login        allow or block a contributor (`{mode, reason?}`)
 *   DELETE /admin/pr-review-authors/:login        remove that decision; the tally decides again
 *   POST   /admin/pr-reviews/:dataset/:pr/start   review a pull request that is already open (or
 *                                                 start again a commit whose review ended without a
 *                                                 verdict); the Worker reads it from GitHub itself
 *
 * Admin-only through the router's `authMiddleware` and `adminMiddleware`. The reads need no switch:
 * `PR_REVIEW_ENABLED` gates the REVIEW, not the view of it, so with the review off the queue lists
 * the same pull requests and those with no stored review show as `not_reviewed`. Nothing here
 * approves or merges a pull request: no Worker code path approves, and the Worker holds nothing that
 * belongs to an individual administrator. An approval is the administrator's own act with their own
 * GitHub identity, taken by the CLI (ADR 0093). `start` is the one route that makes the Worker act:
 * it makes the dispatch, check and comment calls any review makes, and nothing more.
 *
 * The contributor routes live under their own prefix (`pr-review-authors`) rather than under
 * `pr-reviews/authors/...`, because `pr-reviews/:dataset/:pr` has the same shape and a router that
 * runs every matching handler in registration order would let `authors` be read as a dataset id.
 */

import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { z } from "zod";
import type { SetOverrideRequest } from "../../../../shared/contract/pr-review-admin";
import { isValidDatasetId } from "../../services/datasetId";
import {
  QueueError,
  buildQueue,
  clearOverride,
  parseLogin,
  parseVerdictFilter,
  readContributor,
  readPrReviewDetail,
  setOverride,
} from "../../services/pr-review-queue";
import { startPullRequestReview } from "../../services/pr-review-start";
import type { AdminRouter } from "./shared";

const overrideSchema = z
  .object({
    mode: z.enum(["allow", "block"]),
    reason: z.string().max(500).optional(),
  })
  .strict() satisfies z.ZodType<SetOverrideRequest>;

/** A thrown `QueueError` becomes its status and sentence; anything else is a 500 that says no more. */
function fail(c: Context, err: unknown) {
  if (err instanceof QueueError) return c.json({ error: err.message, code: err.code }, err.status);
  console.error("[admin/pr-reviews] unexpected failure:", err);
  return c.json(
    { error: "The pull-request review queue failed unexpectedly.", code: "internal" },
    500,
  );
}

function truthy(v: string | undefined): boolean {
  return v === "1" || v === "true";
}

export function registerPrReviewRoutes(admin: AdminRouter): void {
  admin.get("/pr-reviews", async (c) => {
    try {
      const dataset = c.req.query("dataset") ?? null;
      if (dataset !== null && !isValidDatasetId(dataset)) {
        throw new QueueError(400, "bad_dataset", "That is not a dataset id.");
      }
      const author = c.req.query("author") ?? null;
      if (author !== null) parseLogin(author);
      return c.json(
        await buildQueue(c.env, {
          verdicts: parseVerdictFilter(c.req.query("verdict")),
          dataset,
          author,
          needs_me: truthy(c.req.query("needs_me")),
        }),
      );
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.get("/pr-reviews/:dataset/:pr", async (c) => {
    try {
      const dataset = c.req.param("dataset");
      const pr = Number(c.req.param("pr"));
      if (!isValidDatasetId(dataset)) {
        throw new QueueError(400, "bad_dataset", "That is not a dataset id.");
      }
      if (!Number.isSafeInteger(pr) || pr <= 0) {
        throw new QueueError(400, "bad_pr", "A pull request number is a positive whole number.");
      }
      const head = c.req.query("head") ?? null;
      return c.json(await readPrReviewDetail(c.env, dataset, pr, head));
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.post("/pr-reviews/:dataset/:pr/start", async (c) => {
    try {
      const dataset = c.req.param("dataset");
      const pr = Number(c.req.param("pr"));
      if (!isValidDatasetId(dataset)) {
        throw new QueueError(400, "bad_dataset", "That is not a dataset id.");
      }
      if (!Number.isSafeInteger(pr) || pr <= 0) {
        throw new QueueError(400, "bad_pr", "A pull request number is a positive whole number.");
      }
      return c.json(await startPullRequestReview(c.env, c.get("user").id, dataset, pr));
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.get("/pr-review-authors/:login", async (c) => {
    try {
      return c.json(await readContributor(c.env, c.req.param("login")));
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.put("/pr-review-authors/:login", zValidator("json", overrideSchema), async (c) => {
    try {
      const body = c.req.valid("json");
      return c.json(
        await setOverride(c.env, c.get("user").id, c.req.param("login"), body.mode, body.reason),
      );
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.delete("/pr-review-authors/:login", async (c) => {
    try {
      return c.json(await clearOverride(c.env, c.get("user").id, c.req.param("login")));
    } catch (err) {
      return fail(c, err);
    }
  });
}
