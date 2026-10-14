/**
 * Approval-release callback: POST /approval-release, called by the executor's failure step
 * (#1582, ADR 0103 decision 9).
 *
 * A web click claims the request (`approval_requested_by`, `approval_dispatched_at`) and
 * dispatches an executor. A failure the Worker can see for itself (a step that failed, a gate that
 * refused) is recorded by `/approve` as the request's `last_error`. A failure it cannot see (a
 * secret the workflow lacks, an install that failed, a run that was cancelled) leaves the claim
 * holding its lease for fifteen minutes with nothing running, and a second click is refused for
 * all of it. This route is how the failing workflow gives the claim back.
 *
 * Authenticated by the dispatch token ALONE, in `X-Approval-Dispatch-Token`: an HMAC over the
 * claim's own columns (`signApprovalDispatchToken`), signed with PRESCREEN_CALLBACK_SECRET under
 * the approval-dispatch domain tag. It is not an administrator key and not a cookie, because the
 * failures this must be able to report include the executor having no administrator key. What a
 * leaked token can do is end ONE approval's lease early: it cannot approve, deny or read anything,
 * and it stops verifying the moment the claim is released, replaced or taken over.
 *
 * Body: `{ dataset_id, request_id, reason? }`. Every field is untrusted. `dataset_id` and
 * `request_id` are validated against their exact shapes BEFORE they are used or logged, and
 * `reason` is read only as one of a closed vocabulary (`APPROVAL_RELEASE_REASONS`): the fixed
 * sentence of the word is what is stored, never text the executor wrote, so a failing workflow
 * cannot put words on the page. An unknown or missing reason is `workflow_failed`.
 *
 * Every refusal of the credential says the same bytes with the same status: no header, a token
 * that does not verify, a request that does not exist, one that is closed, one whose claim was
 * released already, and a write that lost a race. An answer that differed would tell a caller
 * which requests have a live claim.
 *
 * The release is ONE conditional write. `updated_at` is left alone on purpose: the failed-run
 * grace reads it as the run's last sign of life, and refreshing it here would hold the run "in
 * flight" for another minute after it was reported dead. A specific `last_error` that a failed
 * step already recorded is kept; the generic sentence only fills an empty one.
 */

import {
  APPROVAL_DISPATCH_TOKEN_HEADER,
  APPROVAL_RELEASE_REASONS,
  APPROVAL_RELEASE_REASON_TEXT,
  type ApprovalReleaseReason,
} from "../../../../shared/contract/publication.js";
import { auditLogStatement } from "../../db/audit-log.js";
import { APPROVAL_CLAIM_CLEAR_SQL } from "../../services/approval-dispatch.js";
import { isValidDatasetId } from "../../services/datasetId.js";
import { verifyApprovalDispatchToken } from "../../services/github.js";
import { errorMessage } from "../../services/repo-metadata.js";
import type { WebhookRouter } from "../webhooks/shared.js";
import { readBoundedJsonObject } from "./bounded-json.js";

/** The largest body a release reads: `dataset_id`, `request_id` and one closed-vocabulary word. */
const MAX_RELEASE_BODY_BYTES = 1024;

/** Every refusal of the credential says these bytes, whatever the reason. */
const UNAUTHORIZED = { error: "Invalid or expired approval token" } as const;

/**
 * The release. Bound to the claim the token was verified against, by its instant AND its clicker
 * (the two columns the token is derived from besides the request), so a claim that was replaced
 * since the read, by a fresh click or a takeover, is never cleared by the older run's report. A
 * request that stopped being one that can run (published, denied, blocked) is left alone.
 * `COALESCE` keeps a specific failure. No `updated_at`: see the file header.
 */
export const APPROVAL_RELEASE_SQL = `UPDATE publication_requests
      SET last_error = COALESCE(last_error, ?), ${APPROVAL_CLAIM_CLEAR_SQL}
    WHERE id = ? AND approval_dispatched_at = ? AND approval_requested_by = ?
      AND status IN ('requested', 'approving')`;

/** The reason of a body as one of the closed words; anything else is a generic failure. */
function releaseReason(value: unknown): ApprovalReleaseReason {
  return typeof value === "string" &&
    (APPROVAL_RELEASE_REASONS as readonly string[]).includes(value)
    ? (value as ApprovalReleaseReason)
    : "workflow_failed";
}

export function registerApprovalReleaseRoutes(webhooks: WebhookRouter): void {
  webhooks.post("/approval-release", async (c) => {
    const token = c.req.header(APPROVAL_DISPATCH_TOKEN_HEADER)?.trim();
    if (!token) {
      return c.json(UNAUTHORIZED, 401);
    }

    // Bounded before parsing: by the declared length, and by the bytes that actually arrived. The
    // body is three scalars, so the bound is 1 KiB, not the 256 KiB a screen report is given.
    const read = await readBoundedJsonObject(c, MAX_RELEASE_BODY_BYTES);
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
    const reason = releaseReason(b.reason);

    const secret = c.env.PRESCREEN_CALLBACK_SECRET;
    if (!secret) {
      console.error("[approval-release] PRESCREEN_CALLBACK_SECRET is unset; rejecting");
      return c.json({ error: "Server misconfigured: callback secret unset" }, 500);
    }

    // The claim, if there is one on a request that can still run. A published, denied or blocked
    // request has no run to release, and a replayed or late report finds nothing to verify.
    const row = await c.env.DB.prepare(
      `SELECT approval_requested_by, approval_dispatched_at FROM publication_requests
        WHERE id = ? AND dataset_id = ?
          AND approval_dispatched_at IS NOT NULL
          AND status IN ('requested', 'approving')
        LIMIT 1`,
    )
      .bind(requestId, datasetId)
      .first<{ approval_requested_by: number | null; approval_dispatched_at: string | null }>();
    if (!row || row.approval_requested_by === null || row.approval_dispatched_at === null) {
      console.warn(`[approval-release] no live claim for request ${requestId} (${datasetId})`);
      return c.json(UNAUTHORIZED, 401);
    }

    const ok = await verifyApprovalDispatchToken(
      token,
      {
        datasetId,
        requestId,
        clickerId: row.approval_requested_by,
        claimedAt: row.approval_dispatched_at,
      },
      secret,
    );
    if (!ok) {
      console.warn(`[approval-release] token mismatch for request ${requestId} (${datasetId})`);
      return c.json(UNAUTHORIZED, 401);
    }

    const released = await c.env.DB.prepare(APPROVAL_RELEASE_SQL)
      .bind(
        APPROVAL_RELEASE_REASON_TEXT[reason],
        requestId,
        row.approval_dispatched_at,
        row.approval_requested_by,
      )
      .run();
    if ((released.meta.changes ?? 0) !== 1) {
      // Verified, but the claim moved between the read and the write (a fresh click, a takeover,
      // a publish or a denial). That claim is not this run's to release, and the answer says no
      // more than any other refusal.
      console.warn(`[approval-release] request ${requestId} (${datasetId}): claim changed`);
      return c.json(UNAUTHORIZED, 401);
    }

    // The release is done; a missing audit row must not report it as failed.
    try {
      await auditLogStatement(c.env.DB, {
        userId: null,
        action: "approval_dispatch_released",
        resourceType: "dataset",
        resourceId: datasetId,
        details: JSON.stringify({ request_id: requestId, reason }),
      }).run();
    } catch (auditError) {
      console.error(
        `[approval-release] audit write failed for request ${requestId} (${datasetId}): ${errorMessage(auditError)}`,
      );
    }

    console.log(
      `[approval-release] request ${requestId} (${datasetId}): released, reason=${reason}`,
    );
    return c.json({ ok: true, released: true });
  });
}
