/**
 * Announcement outbox consumer (epic #1893 phase 2, ADR 0110).
 *
 * `nemar admin notify` on the Cloudflare provider enqueues one {@link BroadcastOutboxMessage}
 * per recipient (services/broadcast.ts). This module sends each through `sendEmail`, so the
 * dev fence, the [DEV] wrap and the provider selection apply exactly as for any other mail,
 * and records the outcome on the `broadcast_emails` row.
 *
 * Rules that shape everything:
 * - A send whose outcome is unknown is NEVER retried. A timeout or an internal error may have
 *   been accepted by the provider with only the answer lost, and a retry would deliver the
 *   announcement twice. Only a Cloudflare rate or daily limit, which says nothing was
 *   delivered, is retried, later, with a growing delay.
 * - Retries are bounded. On the final delivery attempt a limit refusal is recorded as a
 *   failure (certainly nothing was sent) instead of retried, so the row can reach `done`. A
 *   message that still ends in the dead-letter queue means something else went wrong
 *   (typically the database): look at the DLQ.
 * - Outcomes are idempotent (services/broadcast-outcomes.ts): a redelivered message whose
 *   outcome is already recorded is acked without a second send or count.
 * - Pacing: `max_concurrency = 1` only serialises BATCHES. Within a batch the sends run one at
 *   a time, and after the first limit refusal the rest of the batch is deferred unsent.
 */

import type { BroadcastEnv, BroadcastOutboxMessage } from "./broadcast";
import { buildBroadcastHtml, markdownToEmailHtml } from "./broadcast";
import {
  type BroadcastOutcome,
  hasOutcome,
  recipientHash,
  recordBroadcastOutcome,
} from "./broadcast-outcomes";
import {
  BROADCAST_SEND_TIMEOUT_MS,
  CLOUDFLARE_LIMIT_CODES,
  EmailRejectedError,
  isCertainNonDelivery,
  redactAddressIn,
  redactRecipient,
  resolveEmailConfig,
  sendEmail,
} from "./email";

/** Must match `max_retries` for the outbox consumer in wrangler-sccn.toml (prod and dev). */
export const OUTBOX_MAX_RETRIES = 10;
/**
 * `Message.attempts` starts at 1 on the first delivery, so with `max_retries` retries the last
 * delivery is attempt `max_retries + 1`; a retry requested on it would go to the DLQ.
 */
export const OUTBOX_FINAL_ATTEMPT = OUTBOX_MAX_RETRIES + 1;
/** A limit refusal is retried after `min(BASE * attempts, MAX)` seconds. */
export const OUTBOX_LIMIT_RETRY_BASE_SECONDS = 300;
export const OUTBOX_LIMIT_RETRY_MAX_SECONDS = 3600;
/** Seconds before a message is retried after the audit row could not be read (nothing was sent). */
const ROW_READ_RETRY_DELAY_SECONDS = 60;

export function limitRetryDelaySeconds(attempts: number): number {
  return Math.min(
    OUTBOX_LIMIT_RETRY_BASE_SECONDS * Math.max(attempts, 1),
    OUTBOX_LIMIT_RETRY_MAX_SECONDS,
  );
}

export function isBroadcastOutboxMessage(body: unknown): body is BroadcastOutboxMessage {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    b.kind === "broadcast" &&
    typeof b.broadcast_id === "number" &&
    Number.isInteger(b.broadcast_id) &&
    typeof b.to === "string" &&
    b.to !== ""
  );
}

interface BroadcastRow {
  subject: string;
  body_markdown: string;
}

/** What {@link handleOutboxBatch} needs of the Worker env: the bindings that send and the DB. */
export type OutboxEnv = BroadcastEnv & {
  DB: D1Database;
  RESEND_API_KEY?: string;
  FROM_EMAIL?: string;
  REPLY_TO?: string;
};

/**
 * Process one batch of broadcast messages, one at a time. Every message is acked or retried;
 * this function does not throw for a per-message problem.
 */
export async function handleOutboxBatch(
  messages: ReadonlyArray<Message<BroadcastOutboxMessage>>,
  env: OutboxEnv,
): Promise<void> {
  const { fromEmail, replyTo, isDev } = resolveEmailConfig(env);
  const rows = new Map<number, BroadcastRow | null>();

  /**
   * Record a certain failure for a message that cannot be retried further and ack it. If the
   * outcome cannot be written, the message is retried instead (to the DLQ once exhausted).
   */
  const giveUp = async (message: Message<BroadcastOutboxMessage>, reason: string) => {
    const { broadcast_id: id, to } = message.body;
    try {
      await recordBroadcastOutcome(
        env.DB,
        id,
        to,
        "failed",
        `${redactRecipient(to)} (${reason}, gave up)`,
      );
      message.ack();
    } catch (error) {
      console.error(
        `[email-outbox] could not record give-up for broadcast ${id}:`,
        error instanceof Error ? error.message : String(error),
      );
      message.retry({ delaySeconds: ROW_READ_RETRY_DELAY_SECONDS });
    }
  };

  /** A limit refusal: retry later, or give up on the final attempt. */
  const deferForLimit = async (message: Message<BroadcastOutboxMessage>) => {
    if (message.attempts >= OUTBOX_FINAL_ATTEMPT) await giveUp(message, "limit");
    else message.retry({ delaySeconds: limitRetryDelaySeconds(message.attempts) });
  };

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const { broadcast_id: id, to } = message.body;
    const who = redactRecipient(to);

    let row = rows.get(id);
    if (row === undefined) {
      try {
        row =
          (await env.DB.prepare("SELECT subject, body_markdown FROM broadcast_emails WHERE id = ?")
            .bind(id)
            .first<BroadcastRow>()) ?? null;
      } catch (error) {
        // Nothing was sent, so a retry cannot duplicate.
        console.error(
          `[email-outbox] could not read broadcast ${id} (attempt ${message.attempts}):`,
          error instanceof Error ? error.message : String(error),
        );
        if (message.attempts >= OUTBOX_FINAL_ATTEMPT) await giveUp(message, "row unreadable");
        else message.retry({ delaySeconds: ROW_READ_RETRY_DELAY_SECONDS });
        continue;
      }
      rows.set(id, row);
    }
    if (!row) {
      console.error(`[email-outbox] broadcast ${id} not found; dropping message for ${who}`);
      message.ack();
      continue;
    }

    // A redelivered message whose outcome is already recorded must not be sent again.
    try {
      if (await hasOutcome(env.DB, id, await recipientHash(to))) {
        console.warn(`[email-outbox] broadcast ${id} to ${who} already has an outcome; acking`);
        message.ack();
        continue;
      }
    } catch (error) {
      console.error(
        `[email-outbox] could not check outcome for broadcast ${id}:`,
        error instanceof Error ? error.message : String(error),
      );
      // Not knowing whether it was sent, the safe move is to try later, not to send.
      message.retry({ delaySeconds: ROW_READ_RETRY_DELAY_SECONDS });
      continue;
    }

    const html = buildBroadcastHtml(row.subject, markdownToEmailHtml(row.body_markdown));
    let outcome: BroadcastOutcome;
    try {
      await sendEmail(
        to,
        row.subject,
        html,
        env.RESEND_API_KEY ?? "",
        fromEmail,
        replyTo,
        isDev,
        env,
        BROADCAST_SEND_TIMEOUT_MS,
      );
      outcome = "delivered";
    } catch (error) {
      if (
        error instanceof EmailRejectedError &&
        error.code !== undefined &&
        CLOUDFLARE_LIMIT_CODES.has(error.code)
      ) {
        const delay = limitRetryDelaySeconds(message.attempts);
        console.warn(
          `[email-outbox] ${error.code} for broadcast ${id} (attempt ${message.attempts}); deferring the rest of the batch by ${delay}s`,
        );
        await deferForLimit(message);
        // Pace: nothing else in this batch is sent while the provider is refusing.
        for (const rest of messages.slice(index + 1)) await deferForLimit(rest);
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[email-outbox] broadcast ${id} to ${who}:`, redactAddressIn(reason, to));
      outcome = isCertainNonDelivery(error) ? "failed" : "unknown";
    }

    // The outcome is recorded once. If this write fails the mail may already be out, so the
    // message is acked regardless: a retry would send it again.
    try {
      await recordBroadcastOutcome(env.DB, id, to, outcome, who);
    } catch (error) {
      console.error(
        `[email-outbox] could not record ${outcome} for broadcast ${id}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
    message.ack();
  }
}
