-- Epic #1893 phase 2 (ADR 0110): Cloudflare Email Sending publishes bounce and complaint
-- events into a Queue that this Worker consumes (services/email-events.ts). Cloudflare
-- suppresses those recipients itself; this table is the platform's own record of them.
--   event_id: Cloudflare's eventId. Queues deliver at least once, so the consumer inserts
--             with INSERT OR IGNORE and a repeated event stores one row.
--   event_type: 'message.bounced' or 'message.complained'.
--   bounce_type: 'hard' or 'soft' for a bounce, the complaint type (for example 'abuse')
--             for a complaint.
--   occurred_at: the event's own timestamp (ISO 8601, UTC); retention is judged on it.
-- The message subject is deliberately not stored. Rows older than 180 days are deleted by
-- the daily cleanup.
CREATE TABLE IF NOT EXISTS email_delivery_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  sending_domain TEXT,
  recipient TEXT NOT NULL,
  sender TEXT,
  message_id TEXT,
  bounce_type TEXT,
  smtp_status TEXT,
  smtp_response TEXT,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_email_delivery_events_recipient
  ON email_delivery_events (recipient);
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_occurred_at
  ON email_delivery_events (occurred_at);
