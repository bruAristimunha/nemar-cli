/**
 * Identifier-screen callback: POST /identifier-screen-result, called by the
 * `run-identifier-screen` workflow (epic #1610, phase 4).
 *
 * Authed like the pre-screen callback: a per-request HMAC token in
 * X-Webhook-Token, signed over {dataset_id, request_id, nonce} with
 * PRESCREEN_CALLBACK_SECRET under the identifier-screen domain tag, whose nonce
 * is recovered from the row the token was issued for. One-shot: the row is
 * looked up only while its screen is `pending`, and storing a result clears the
 * nonce, so a replay or a late callback finds nothing to verify and gets 401.
 *
 * Body: `{ dataset_id, request_id, workflow_run_id?, report }`. Every field is
 * untrusted. `dataset_id` and `request_id` are validated against their exact
 * shapes BEFORE they are used or logged, `workflow_run_id` is logged only when
 * it is a run number, and `report` reaches nothing except through
 * `parseScreenReport` (services/identifier-screen.ts). A route that echoed a
 * body field into a log line would be a way for a header's text to reach the
 * Worker's logs, which is the thing this feature exists to keep out.
 */

import { isValidDatasetId } from "../../services/datasetId.js";
import { verifyIdentifierScreenCallbackToken } from "../../services/github.js";
import { notifyAdminsOfScreen, storeScreenResult } from "../../services/identifier-screen.js";
import { startPublicationReviewForScreen } from "../../services/publication-review.js";
import type { WebhookRouter } from "../webhooks/shared.js";
import { readBoundedJsonObject } from "./bounded-json.js";
import { deferAfterAnswer } from "./defer.js";

/**
 * The largest body this route reads (shared with the sweep's callback in
 * `bounded-json.ts`). A real report is a few kilobytes (closed vocabularies and
 * counts); anything near this is not a report.
 */
export { MAX_CALLBACK_BODY_BYTES } from "./bounded-json.js";

/**
 * Every refusal of the token says the same bytes, whether no screen was in
 * flight for the request or the token did not verify, so the answer does not
 * tell a caller which requests have a screen running.
 */
const UNAUTHORIZED = { error: "Invalid or expired callback token" } as const;

export function registerIdentifierScreenRoutes(webhooks: WebhookRouter): void {
  webhooks.post("/identifier-screen-result", async (c) => {
    const token = c.req.header("X-Webhook-Token");
    if (!token) {
      return c.json(UNAUTHORIZED, 401);
    }

    // Bounded before parsing: by the declared length, and by the bytes that
    // actually arrived (a declared length can be absent or wrong).
    const read = await readBoundedJsonObject(c);
    if (!read.ok) return c.json({ error: read.error }, read.status);
    const b = read.body;
    if (typeof b.dataset_id !== "string" || !isValidDatasetId(b.dataset_id)) {
      return c.json({ error: "dataset_id must be a dataset id" }, 400);
    }
    if (
      typeof b.request_id !== "number" ||
      !Number.isSafeInteger(b.request_id) ||
      b.request_id < 1
    ) {
      return c.json({ error: "request_id must be a positive integer" }, 400);
    }
    const datasetId = b.dataset_id;
    const requestId = b.request_id;
    const runId =
      typeof b.workflow_run_id === "string" && /^\d{1,20}$/.test(b.workflow_run_id)
        ? b.workflow_run_id
        : typeof b.workflow_run_id === "number" && Number.isSafeInteger(b.workflow_run_id)
          ? String(b.workflow_run_id)
          : null;

    const secret = c.env.PRESCREEN_CALLBACK_SECRET;
    if (!secret) {
      console.error("[identifier-screen-result] PRESCREEN_CALLBACK_SECRET is unset; rejecting");
      return c.json({ error: "Server misconfigured: callback secret unset" }, 500);
    }

    // The nonce of the in-flight screen. Only a screen still waiting for its
    // report is found: `pending`, or `unreported` (the watchdog gave up on it,
    // but kept its nonce so a late report still lands). A stored result has no
    // nonce, so a replay cannot re-store or re-mail it, and a re-run replaced
    // the nonce, so an earlier run cannot answer for the new one.
    const row = await c.env.DB.prepare(
      `SELECT identifier_screen_nonce FROM publication_requests
        WHERE id = ? AND dataset_id = ?
          AND identifier_screen_status IN ('pending', 'unreported')
        LIMIT 1`,
    )
      .bind(requestId, datasetId)
      .first<{ identifier_screen_nonce: string | null }>();
    if (!row?.identifier_screen_nonce) {
      console.warn(
        `[identifier-screen-result] no pending screen for request ${requestId} (${datasetId})`,
      );
      return c.json(UNAUTHORIZED, 401);
    }

    const ok = await verifyIdentifierScreenCallbackToken(
      token,
      { datasetId, requestId, nonce: row.identifier_screen_nonce },
      secret,
    );
    if (!ok) {
      console.warn(
        `[identifier-screen-result] callback token mismatch for request ${requestId} (${datasetId})`,
      );
      return c.json(UNAUTHORIZED, 401);
    }

    const stored = await storeScreenResult(c.env, {
      requestId,
      datasetId,
      nonce: row.identifier_screen_nonce,
      body: b.report,
    });
    if (!stored.stored) {
      // Verified, but another writer (a duplicate callback, the watchdog) won
      // the one conditional UPDATE between the read and the write. Harmless.
      console.warn(
        `[identifier-screen-result] request ${requestId} (${datasetId}): result already recorded`,
      );
      return c.json({ ok: true, dataset_id: datasetId, duplicate: true });
    }

    console.log(
      `[identifier-screen-result] request ${requestId} (${datasetId}): state=${stored.state}${
        runId ? ` run=${runId}` : ""
      }`,
    );
    // ADR 0102: a stored result whose gate is clear or acknowledge starts the model review of
    // ITS commit (nothing happens when the flag is off, the dataset is the other Worker's, the
    // request no longer waits for its decision, or the gate blocks, waits or reruns). It goes
    // here and not in `storeScreenResult`, whose outcome is pinned and which must not depend on
    // the review; it goes BEFORE the mail, so the review's row exists when the mail is tried, and
    // it never throws, so a fault in the review cannot fail the callback that stores the screen.
    //
    // Both go after the answer: the result is stored, and the review's start (a GitHub App token
    // and a dispatch of up to ten seconds) and the mail (the lease makes the send safe to finish
    // in the background: a send that dies is retried by the watchdog once the lease expires) must
    // not run past the workflow's POST timeout, whose retry would find the token spent. They stay
    // in one task, in that order. A test harness has no execution context, so the task is awaited
    // there instead.
    const afterAnswer = (async () => {
      await startPublicationReviewForScreen(c.env, { requestId, datasetId });
      await notifyAdminsOfScreen(c.env, requestId);
    })();
    if (!deferAfterAnswer(c)(afterAnswer)) await afterAnswer;
    return c.json({
      ok: true,
      dataset_id: datasetId,
      state: stored.state,
      blocked: stored.blocked,
    });
  });
}
