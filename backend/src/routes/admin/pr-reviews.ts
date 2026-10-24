/**
 * Admin routes for the dataset pull-request review queue (ADR 0093, following ADR 0092):
 *
 *   GET    /admin/pr-reviews                      every open pull request to `main`, with its review,
 *                                                 and the volume of reviews over the last day and week
 *   GET    /admin/pr-reviews/:dataset/:pr         one pull request: stored report, history, author
 *                                                 (`?head=<sha>` asks about that commit, not GitHub's)
 *   GET    /admin/pr-review-authors/:login        a contributor's record, override and standing
 *   PUT    /admin/pr-review-authors/:login        block a contributor, or lift a block (`{mode, reason?}`)
 *   DELETE /admin/pr-review-authors/:login        remove that decision
 *   POST   /admin/pr-reviews/:dataset/:pr/start   review a pull request that is already open (or
 *                                                 start again a commit whose review ended without a
 *                                                 verdict, or with `?redo=1` one that has a result);
 *                                                 the Worker reads it from GitHub itself
 *   POST   /admin/pr-reviews/:dataset/:pr/allow   waive the naming rule for an owner's or an
 *                                                 administrator's pull request at its current commit
 *                                                 (`{reason, head_sha?}`); recorded, and the check
 *                                                 is skipped. The reason is required (400 without
 *                                                 one). With `head_sha` (a hex prefix of 7+
 *                                                 characters) a pull request that has moved on is a
 *                                                 409 `head_moved`, and nothing is recorded or posted
 *
 * Admin-only through the router's `authMiddleware` and `adminMiddleware`. The reads need no switch:
 * `PR_REVIEW_ENABLED` gates the REVIEW, not the view of it, so with the review off the queue lists
 * the same pull requests and those with no stored review show as `not_reviewed` (or `exempt`, for
 * a pull request an owner or administrator opened, ADR 0107). Nothing here approves or merges a
 * pull request: no Worker code path approves, and the Worker holds nothing that belongs to an
 * individual administrator. An approval is the administrator's own act with their own GitHub
 * identity, taken by the CLI (ADR 0093). `start` and `allow` are the routes that make the Worker
 * act: `start` makes the dispatch, check and comment calls any review makes, and `allow` records a
 * waiver of the naming rule and posts the one check an exempt pull request carries (ADR 0107).
 *
 * The contributor routes live under their own prefix (`pr-review-authors`) rather than under
 * `pr-reviews/authors/...`, because `pr-reviews/:dataset/:pr` has the same shape and a router that
 * runs every matching handler in registration order would let `authors` be read as a dataset id.
 */

import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { z } from "zod";
import type {
  SetOverrideRequest,
  WaiveNamingRequest,
} from "../../../../shared/contract/pr-review-admin";
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
import { waiveNamingRule } from "../../services/pr-review-waiver";
import type { AdminRouter } from "./shared";

const overrideSchema = z
  .object({
    mode: z.enum(["allow", "block"]),
    reason: z.string().max(500).optional(),
  })
  .strict() satisfies z.ZodType<SetOverrideRequest>;

/** A commit named by its first seven to forty characters; the service lowercases it. */
const COMMIT_PREFIX = /^[0-9a-fA-F]{7,40}$/;

/**
 * A waiver is recorded with the reason it was given, so the reason is required: the route does not
 * waive on a blank one. (The service also refuses a reason with no plain words left after the
 * sanitizer, which the schema cannot see.)
 */
const waiveSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
    head_sha: z.string().regex(COMMIT_PREFIX).optional(),
  })
  .strict() satisfies z.ZodType<WaiveNamingRequest>;

/** The dataset and pull request number of a `/pr-reviews/:dataset/:pr/...` route, checked. */
function target(c: Context): { dataset: string; pr: number } {
  const dataset = c.req.param("dataset") ?? "";
  const pr = Number(c.req.param("pr"));
  if (!isValidDatasetId(dataset)) {
    throw new QueueError(400, "bad_dataset", "That is not a dataset id.");
  }
  if (!Number.isSafeInteger(pr) || pr <= 0) {
    throw new QueueError(400, "bad_pr", "A pull request number is a positive whole number.");
  }
  return { dataset, pr };
}

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
      const { dataset, pr } = target(c);
      const head = c.req.query("head") ?? null;
      return c.json(await readPrReviewDetail(c.env, dataset, pr, head));
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.post("/pr-reviews/:dataset/:pr/start", async (c) => {
    try {
      const { dataset, pr } = target(c);
      return c.json(
        await startPullRequestReview(c.env, c.get("user").id, dataset, pr, {
          redo: truthy(c.req.query("redo")),
        }),
      );
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.post(
    "/pr-reviews/:dataset/:pr/allow",
    zValidator("json", waiveSchema, (result, c) => {
      // A field a person typed gets a sentence; anything else keeps the validator's own 400.
      if (result.success) return;
      const issue = result.error.issues[0];
      if (issue?.path[0] === "reason") {
        return fail(
          c,
          new QueueError(
            400,
            "bad_reason",
            issue.code === "too_big"
              ? "The reason is too long: 500 characters at most."
              : "A reason is required: say, in plain words, why the naming rule is waived. It is recorded with the waiver.",
          ),
        );
      }
      if (issue?.path[0] === "head_sha") {
        return fail(
          c,
          new QueueError(
            400,
            "bad_head",
            "head_sha is the first 7 to 40 characters of a commit id (hexadecimal).",
          ),
        );
      }
    }),
    async (c) => {
      try {
        const { dataset, pr } = target(c);
        const body = c.req.valid("json");
        return c.json(
          await waiveNamingRule(c.env, c.get("user").id, dataset, pr, {
            reason: body.reason,
            commit: body.head_sha,
          }),
        );
      } catch (err) {
        return fail(c, err);
      }
    },
  );

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
