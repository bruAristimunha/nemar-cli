/**
 * Pull-request review callbacks, called by the `run-pr-review` workflow (ADR 0092).
 *
 *   POST /pr-review-claim    the workflow's first real step, before it mints an identity or reads
 *                            anything: take the review. A dispatch that cannot present the token
 *                            gets 401 and buys nothing; a newer delivery, ineligible dataset, or
 *                            unsettled claim is refused with 409 before the workflow reads
 *                            anything or calls a model.
 *   POST /pr-review-result   the report (or the word for why there is none).
 *
 * Both are authed like the identifier-screen callback: a per-review HMAC token in X-Webhook-Token,
 * signed over {dataset_id, review_id, nonce} with PRESCREEN_CALLBACK_SECRET under the `pr-review`
 * domain tag, whose nonce is recovered from the row the token was issued for. The token is spent
 * by the RESULT: the row is found only while it waits for its report (`dispatched`, or
 * `unreported` after the watchdog gave up), and storing a result clears the nonce, so a replayed
 * or late result finds nothing to verify and gets 401. The CLAIM is one-shot by `claimed_at`
 * instead: a replayed claim still finds the row and gets 409 `already_claimed`.
 *
 * Body: `{ review_id, dataset_id, outcome: "reported" | "error", report?, error? }`. Every field
 * is untrusted. `dataset_id` and `review_id` are validated against their exact shapes BEFORE they
 * are used or logged, and `report` reaches nothing except through `parsePrReviewReport` (via
 * `parseCallbackOutcome`). The parser refuses unknown keys and values outside the closed sets,
 * which is stored as `report_invalid`; free text (`summary`, a finding's `note`) is not refused
 * but reduced to plain words by `sanitizeNote`, so what a workflow changed to put there is shown
 * as text and never as markup, a link or a mention.
 */

import { parseCallbackOutcome } from "../../../../shared/pr-review.js";
import { isValidDatasetId } from "../../services/datasetId.js";
import { verifyPrReviewCallbackToken } from "../../services/github/callback-tokens.js";
import { claimPrReview, pendingNonce, storePrReviewResult } from "../../services/pr-review.js";
import type { WebhookContext, WebhookRouter } from "../webhooks/shared.js";
import { readBoundedJsonObject } from "./bounded-json.js";

/** Every refusal says the same bytes, so the answer does not tell a caller which reviews are running. */
const UNAUTHORIZED = { error: "Invalid or expired callback token" } as const;

interface Verified {
  reviewId: number;
  datasetId: string;
  nonce: string;
  body: Record<string, unknown>;
}

/** The shared door: token present, body bounded and shaped, secret set, nonce found, HMAC good. */
async function verify(c: WebhookContext, route: string): Promise<Verified | Response> {
  const token = c.req.header("X-Webhook-Token");
  if (!token) return c.json(UNAUTHORIZED, 401);

  const read = await readBoundedJsonObject(c);
  if (!read.ok) return c.json({ error: read.error }, read.status);
  const b = read.body;
  if (typeof b.dataset_id !== "string" || !isValidDatasetId(b.dataset_id)) {
    return c.json({ error: "dataset_id must be a dataset id" }, 400);
  }
  if (typeof b.review_id !== "number" || !Number.isSafeInteger(b.review_id) || b.review_id < 1) {
    return c.json({ error: "review_id must be a positive integer" }, 400);
  }
  const datasetId = b.dataset_id;
  const reviewId = b.review_id;

  const secret = c.env.PRESCREEN_CALLBACK_SECRET;
  if (!secret) {
    console.error(`[${route}] PRESCREEN_CALLBACK_SECRET is unset; rejecting`);
    return c.json({ error: "Server misconfigured: callback secret unset" }, 500);
  }

  const nonce = await pendingNonce(c.env.DB, reviewId, datasetId);
  if (!nonce) {
    console.warn(`[${route}] no waiting review ${reviewId} (${datasetId})`);
    return c.json(UNAUTHORIZED, 401);
  }
  const ok = await verifyPrReviewCallbackToken(token, { datasetId, reviewId, nonce }, secret);
  if (!ok) {
    console.warn(`[${route}] token mismatch for review ${reviewId} (${datasetId})`);
    return c.json(UNAUTHORIZED, 401);
  }
  return { reviewId, datasetId, nonce, body: b };
}

export function registerPrReviewRoutes(webhooks: WebhookRouter): void {
  webhooks.post("/pr-review-claim", async (c) => {
    const v = await verify(c, "pr-review-claim");
    if (v instanceof Response) return v;
    const claim = await claimPrReview(c.env, v.reviewId, v.datasetId, v.nonce);
    console.log(`[pr-review-claim] review ${v.reviewId} (${v.datasetId}): ${claim}`);
    if (claim === "claimed") return c.json({ ok: true, claimed: true });
    return c.json({ ok: false, claimed: false, reason: claim }, 409);
  });

  webhooks.post("/pr-review-result", async (c) => {
    const v = await verify(c, "pr-review-result");
    if (v instanceof Response) return v;

    const outcome = parseCallbackOutcome(
      { outcome: v.body.outcome, report: v.body.report, error: v.body.error },
      // The parser's reason is a fixed word, so it is safe to log, and without it a contract that
      // drifted between the script (deployed from main) and the Worker looks like a silent
      // "report_invalid" for every review.
      (code) =>
        console.warn(
          `[pr-review-result] review ${v.reviewId} (${v.datasetId}): report refused (${code})`,
        ),
    );
    const stored = await storePrReviewResult(c.env, v.reviewId, v.datasetId, v.nonce, outcome);
    if (!stored.stored) {
      // Verified, but another writer (a duplicate callback) won the one conditional UPDATE
      // between the read and the write. Harmless.
      return c.json({ ok: true, dataset_id: v.datasetId, duplicate: true });
    }
    // Fixed words only: the state, and for an error the closed word for it.
    console.log(
      `[pr-review-result] review ${v.reviewId} (${v.datasetId}): ${stored.state}${
        outcome.kind === "error" ? ` (${outcome.error})` : ""
      }`,
    );
    return c.json({ ok: true, dataset_id: v.datasetId });
  });
}
