-- Epic #1893 phase 2 (ADR 0110): announcements move onto a queue when the Cloudflare email
-- provider is active, so the audit row outlives the request and accumulates outcomes.
-- ADD COLUMN only on broadcast_emails (no table rebuild). Existing rows read as 'sent',
-- their send having completed inline.
--   status: 'sent' = finished inline; 'queued' = messages still being delivered;
--           'done' = every queued message has an outcome.
--   queued_count: the number of messages the row expects an outcome for (the allowed
--           recipients). recipient_count keeps its inline meaning (delivered) for 'sent'
--           rows and holds the number actually enqueued for queued rows.
--   delivered_count / unknown_count: per-message outcomes written by the queue consumer.
--   failure_count: certain non-deliveries, plus any remainder that could not be enqueued
--           ('unqueued'). failed_recipients keeps its meaning (redacted for queued rows).
ALTER TABLE broadcast_emails ADD COLUMN status TEXT NOT NULL DEFAULT 'sent'
  CHECK (status IN ('sent', 'queued', 'done'));
ALTER TABLE broadcast_emails ADD COLUMN queued_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE broadcast_emails ADD COLUMN delivered_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE broadcast_emails ADD COLUMN unknown_count INTEGER NOT NULL DEFAULT 0;

-- One outcome per (announcement, recipient). Queues deliver at least once, so a redelivered
-- message must not count twice or be sent twice: the consumer inserts here first and bumps a
-- counter only when the insert took. The recipient is a SHA-256 hex of the trimmed, lowercased
-- address, so the table holds no address.
CREATE TABLE IF NOT EXISTS broadcast_outcomes (
  broadcast_id INTEGER NOT NULL,
  recipient_hash TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'failed', 'unknown', 'unqueued')),
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (broadcast_id, recipient_hash)
);
