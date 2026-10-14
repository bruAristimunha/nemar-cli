/**
 * The administrator's comment on a publication request (ADR 0102, section 8):
 *
 *   POST /admin/publish/:id/comment   mail the depositor a message the administrator typed, and
 *                                     leave the request open
 *
 * Admin-only through the router's `authMiddleware` and `adminMiddleware`. It decides nothing: the
 * request stays as it is (no status, no review, no approval changes), and nothing of the review
 * travels in the mail, which is a fixed frame around the typed words (`sendPublicationCommentEmail`).
 * It is not behind `PUBLICATION_REVIEW_ENABLED`, which switches the review and not a message an
 * administrator types.
 *
 * It mails a real person, so a session cookie is accepted only from a NEMAR page (the rule of
 * `review/start`), and the send goes through the environment's delivery fence: outside production
 * only a depositor on `DEV_EMAIL_ALLOWLIST` is mailed, and a refusal is a failed send like any
 * other. A failed send is 502 and is never answered as a success, and it is one of two kinds by
 * what the Worker knows. A send that certainly delivered nothing (Resend's 4xx, the fence, a
 * depositor with no address or one that could not be read) is `comment_not_sent`, "nothing was
 * sent", audited `not_sent`. One that may have been accepted (a Resend 5xx, an unreachable host or
 * a lost answer) is `comment_not_confirmed`, whose sentence is deliberately not "nothing was
 * sent", audited `unknown`: an administrator who read that might send it twice.
 *
 * The audit row, `publication_request_commented`, is written whichever way the send went, with the
 * typed words (the denial's reason is stored on its request the same way), so what a depositor was
 * or was not told is on record.
 */

import type { Context } from "hono";
import {
  PUBLICATION_COMMENT_MAX_LENGTH,
  type PublicationCommentErrorBody,
  type PublicationCommentErrorCode,
  type PublicationCommentResponse,
} from "../../../../shared/contract/publication-review-admin";
import { auditLogStatement } from "../../db/audit-log";
import { ACTIVE_REQUEST_TAIL_SQL } from "../../services/approval-dispatch";
import { isValidDatasetId } from "../../services/datasetId";
import {
  isCertainNonDelivery,
  resolveEmailConfig,
  sendPublicationCommentEmail,
} from "../../services/email";
import { errorWords } from "../../services/publication-review-log";
import { isAllowedOrigin } from "../../services/web-session";
import type { Bindings } from "../../types/bindings";
import type { AdminRouter } from "./shared";

/**
 * The fixed sentence of each refusal and fault, by the closed code that carries it. Keyed by the
 * contract's closed list, so a code added there without a sentence does not compile.
 */
export const PUBLICATION_COMMENT_SENTENCES: Record<PublicationCommentErrorCode, string> = {
  bad_dataset: "That is not a dataset id.",
  not_found: "That dataset has no active publication request.",
  origin_not_allowed: "This request did not come from a NEMAR page, so it was not accepted.",
  invalid_body: `The body must be a JSON object with one field, message, of 1 to ${PUBLICATION_COMMENT_MAX_LENGTH} characters.`,
  comment_not_sent: "The message could not be mailed, so nothing was sent to the depositor.",
  comment_not_confirmed:
    "The mail may not have been sent, and it may also have arrived. Check with the depositor before sending it again.",
  internal: "The publication request could not be read, so nothing was sent. Try again.",
};

/** Answer with a fixed sentence and a code from the contract's closed list. */
function refuse(
  c: Context,
  status: 400 | 403 | 404 | 500 | 502,
  code: PublicationCommentErrorCode,
) {
  const body: PublicationCommentErrorBody = { error: PUBLICATION_COMMENT_SENTENCES[code], code };
  return c.json(body, status);
}

/**
 * The typed words of a comment, trimmed, or null when the body is not exactly `{ message }` with a
 * string of 1 to {@link PUBLICATION_COMMENT_MAX_LENGTH} characters once trimmed. Parsed by hand,
 * not by a validator middleware, so the route answers in its own shape and its entry in the
 * router's inventory stays one handler.
 */
function typedMessage(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== "message") return null;
  const { message } = raw as { message: unknown };
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  return trimmed.length >= 1 && trimmed.length <= PUBLICATION_COMMENT_MAX_LENGTH ? trimmed : null;
}

/**
 * What a comment's send came to, by what the Worker knows of the mail: `sent`, `not_sent` (it
 * certainly delivered nothing) or `unknown` (it may have been accepted). The audit row records it.
 */
type CommentOutcome = "sent" | "not_sent" | "unknown";

/**
 * Mail the request's depositor the message. Everything that certainly keeps it from going is
 * `not_sent`: a depositor with no address on record or one that could not be read (nothing was
 * attempted), the environment's fence refusing the recipient, and Resend refusing the message with
 * a 4xx. A send that ended without a definite answer (a 5xx, an unreachable host, a lost answer)
 * is `unknown`, because the mail may have been accepted. The log says which kind by fixed words
 * (`errorWords`), never by the error's own text, which names the recipient.
 */
async function mailDepositor(
  env: Bindings,
  requestedBy: number,
  datasetId: string,
  message: string,
): Promise<CommentOutcome> {
  let to: string | undefined;
  let username: string;
  let config: ReturnType<typeof resolveEmailConfig>;
  try {
    const depositor = await env.DB.prepare("SELECT username, email FROM users WHERE id = ?")
      .bind(requestedBy)
      .first<{ username: string | null; email: string | null }>();
    to = depositor?.email?.trim();
    username = depositor?.username ?? "there";
    config = resolveEmailConfig(env);
  } catch (err) {
    console.error(
      `[admin/publish-comment] ${datasetId}: the depositor could not be read (${errorWords(err)})`,
    );
    return "not_sent";
  }
  if (!to) {
    console.error(`[admin/publish-comment] ${datasetId}: the depositor has no address on record`);
    return "not_sent";
  }
  try {
    await sendPublicationCommentEmail(
      to,
      username,
      datasetId,
      message,
      env.RESEND_API_KEY,
      config.fromEmail,
      config.replyTo,
      config.isDev,
      env,
    );
    return "sent";
  } catch (err) {
    const certain = isCertainNonDelivery(err);
    console.error(
      `[admin/publish-comment] ${datasetId}: the comment was ${certain ? "refused" : "not confirmed"} (${errorWords(err)})`,
    );
    return certain ? "not_sent" : "unknown";
  }
}

/**
 * The audit row of a comment, whatever the outcome. Best effort: an answer that tells the
 * administrator what happened must not become an error because its audit row could not be written,
 * so a failure is logged by ids and fixed words and the answer stands.
 */
async function recordComment(
  db: D1Database,
  userId: number,
  datasetId: string,
  requestId: number,
  outcome: CommentOutcome,
  message: string,
): Promise<void> {
  try {
    await auditLogStatement(db, {
      userId,
      action: "publication_request_commented",
      resourceType: "dataset",
      resourceId: datasetId,
      details: JSON.stringify({ request_id: requestId, outcome, message }),
    }).run();
  } catch (err) {
    console.error(
      `[admin/publish-comment] ${datasetId}: comment ${outcome}, audit row not written (${errorWords(err)})`,
    );
  }
}

export function registerPublishCommentRoutes(admin: AdminRouter): void {
  admin.post("/publish/:id/comment", async (c) => {
    // A session cookie rides along with any cross-site request a browser can be tricked into
    // making, and this route mails a real person, so every path but a bearer key must come from a
    // NEMAR origin (the rule of `review/start` and `approve-dispatch`). A bearer key cannot be
    // forged cross-site and a terminal sends no Origin. Phrased as "not a token" so that an unset
    // `authMethod` fails closed.
    if (c.get("authMethod") !== "token" && !isAllowedOrigin(c.req.header("Origin"))) {
      return refuse(c, 403, "origin_not_allowed");
    }
    const datasetId = c.req.param("id");
    if (!isValidDatasetId(datasetId)) return refuse(c, 400, "bad_dataset");
    const message = typedMessage(await c.req.json().catch(() => undefined));
    if (message === null) return refuse(c, 400, "invalid_body");

    let request: { id: number; requested_by: number } | null;
    try {
      request = await c.env.DB.prepare(`SELECT id, requested_by ${ACTIVE_REQUEST_TAIL_SQL}`)
        .bind(datasetId)
        .first<{ id: number; requested_by: number }>();
    } catch (err) {
      // Ids and fixed words only: the error text can carry SQL.
      console.error(
        `[admin/publish-comment] could not read the request of ${datasetId} (${errorWords(err)})`,
      );
      return refuse(c, 500, "internal");
    }
    if (!request) return refuse(c, 404, "not_found");

    const outcome = await mailDepositor(c.env, request.requested_by, datasetId, message);
    await recordComment(c.env.DB, c.get("user").id, datasetId, request.id, outcome, message);
    if (outcome === "not_sent") return refuse(c, 502, "comment_not_sent");
    if (outcome === "unknown") return refuse(c, 502, "comment_not_confirmed");

    const body: PublicationCommentResponse = {
      dataset_id: datasetId,
      request_id: request.id,
      mailed: true,
    };
    return c.json(body);
  });
}
