/**
 * Email Sending delivery events (epic #1893 phase 2, ADR 0110).
 *
 * Cloudflare publishes one event per delivery outcome of a sending domain into the queue
 * this Worker consumes. Only `message.bounced` (hard and soft) and `message.complained` are
 * stored: Cloudflare already suppresses those recipients, and this table is the platform's own
 * record of them. `delivered`, `deferred` and any type not known here are acked and dropped.
 *
 * Queues deliver at least once, so a write is INSERT OR IGNORE on `eventId`. A message is
 * retried only when the D1 write throws; a body that cannot be understood would fail the same
 * way again, so it is acked and logged without an address.
 */

import { redactRecipient } from "./email";
import { clampUtf8Bytes } from "./inbound-mail";

/** Message bodies whose `type` starts with this are Email Sending events. */
export const EMAIL_EVENT_TYPE_PREFIX = "cf.email.sending.";
/** Rows older than this are deleted by the daily cleanup. */
export const EMAIL_EVENT_RETENTION_DAYS = 180;
/** `smtp_response` is free text from a remote server; keep at most this many UTF-8 bytes. */
export const SMTP_RESPONSE_MAX_BYTES = 500;

const STORED_TYPES = {
  "cf.email.sending.message.bounced": "message.bounced",
  "cf.email.sending.message.complained": "message.complained",
} as const;

export function isEmailEventMessage(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { type?: unknown }).type === "string" &&
    (body as { type: string }).type.startsWith(EMAIL_EVENT_TYPE_PREFIX)
  );
}

export interface DeliveryEventRow {
  event_id: string;
  event_type: "message.bounced" | "message.complained";
  sending_domain: string | null;
  recipient: string;
  sender: string | null;
  message_id: string | null;
  bounce_type: string | null;
  smtp_status: string | null;
  smtp_response: string | null;
  occurred_at: string;
}

export type ParsedEvent =
  | { kind: "store"; row: DeliveryEventRow }
  | { kind: "ignore" }
  | { kind: "malformed"; reason: string };

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

/** Read one event body defensively. Never throws. */
export function parseEmailEvent(body: unknown): ParsedEvent {
  const top = obj(body);
  const type = str(top.type);
  if (!type) return { kind: "malformed", reason: "no type" };
  const stored = (STORED_TYPES as Record<string, DeliveryEventRow["event_type"] | undefined>)[type];
  if (!stored) return { kind: "ignore" };

  const payload = obj(top.payload);
  const eventId = str(payload.eventId);
  const recipient = str(payload.recipient);
  const timestamp = str(obj(top.metadata).eventTimestamp);
  if (!eventId) return { kind: "malformed", reason: "no eventId" };
  if (!recipient) return { kind: "malformed", reason: "no recipient" };
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) {
    return { kind: "malformed", reason: "no valid eventTimestamp" };
  }

  const delivery = obj(payload.delivery);
  const detail =
    stored === "message.bounced" ? str(obj(payload.bounce).type) : str(obj(payload.complaint).type);
  const response = str(delivery.smtpResponse);
  return {
    kind: "store",
    row: {
      event_id: eventId,
      event_type: stored,
      sending_domain: str(obj(top.source).domain),
      recipient,
      sender: str(payload.sender),
      message_id: str(payload.messageId),
      bounce_type: detail,
      smtp_status: str(delivery.smtpEnhancedStatusCode) ?? str(delivery.smtpStatusCode),
      smtp_response: response === null ? null : clampUtf8Bytes(response, SMTP_RESPONSE_MAX_BYTES),
      occurred_at: new Date(timestamp).toISOString(),
    },
  };
}

/** Handle a batch of Email Sending events. Retries a message only when its D1 write throws. */
export async function handleEmailEventBatch(
  messages: readonly Message<unknown>[],
  env: { DB: D1Database },
): Promise<void> {
  for (const message of messages) {
    const parsed = parseEmailEvent(message.body);
    if (parsed.kind === "malformed") {
      console.warn(`[email-events] malformed event (${parsed.reason}); acking`);
      message.ack();
      continue;
    }
    if (parsed.kind === "ignore") {
      message.ack();
      continue;
    }
    const r = parsed.row;
    try {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO email_delivery_events
           (event_id, event_type, sending_domain, recipient, sender, message_id,
            bounce_type, smtp_status, smtp_response, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          r.event_id,
          r.event_type,
          r.sending_domain,
          r.recipient,
          r.sender,
          r.message_id,
          r.bounce_type,
          r.smtp_status,
          r.smtp_response,
          r.occurred_at,
        )
        .run();
      message.ack();
    } catch (err) {
      console.error(
        `[email-events] store failed for ${redactRecipient(r.recipient)}; retrying:`,
        err instanceof Error ? err.message : "unknown error",
      );
      message.retry({ delaySeconds: eventRetryDelaySeconds(message.attempts) });
    }
  }
}

/** A D1 write that failed waits 30 s, then longer each attempt, so a short outage cannot spend every retry at once. */
export function eventRetryDelaySeconds(attempts: number): number {
  return Math.min(30 * Math.max(1, attempts), 600);
}

/** Delete events older than the retention window; returns the number deleted. */
export async function pruneEmailDeliveryEvents(
  db: D1Database,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - EMAIL_EVENT_RETENTION_DAYS * 86_400_000).toISOString();
  const res = await db
    .prepare("DELETE FROM email_delivery_events WHERE occurred_at < ?")
    .bind(cutoff)
    .run();
  return res.meta?.changes ?? 0;
}
