/**
 * Per-recipient outcomes of a queued announcement (epic #1893 phase 2, migration 0100).
 *
 * Queues deliver at least once, so a message can arrive twice. The outcome table is the
 * idempotency record: an outcome is inserted first, and the audit row's counter moves only when
 * that insert took. The two statements run as one D1 batch (one transaction), so a counter can
 * neither be bumped without its outcome row nor miss it.
 */

export type BroadcastOutcome = "delivered" | "failed" | "unknown" | "unqueued";

/** SHA-256 hex of the trimmed, lowercased address: the table holds no address. */
export async function recipientHash(address: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(address.trim().toLowerCase()),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Whether an outcome is already recorded for this recipient of this announcement. */
export async function hasOutcome(
  db: D1Database,
  broadcastId: number,
  hash: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT 1 AS found FROM broadcast_outcomes WHERE broadcast_id = ? AND recipient_hash = ?",
    )
    .bind(broadcastId, hash)
    .first<{ found: number }>();
  return row !== null;
}

// SQLite evaluates every SET expression against the row's OLD values, so the "+ 1" inside the
// done check is deliberate: it counts the outcome this same statement is adding.
const DONE_WHEN_COMPLETE = (outcomeSum: string) =>
  `status = CASE WHEN status = 'queued' AND ${outcomeSum} >= queued_count THEN 'done' ELSE status END`;

const COUNTER_SQL: Record<BroadcastOutcome, string> = {
  delivered: `UPDATE broadcast_emails
   SET delivered_count = delivered_count + 1,
       ${DONE_WHEN_COMPLETE("delivered_count + 1 + failure_count + unknown_count")}
 WHERE id = ? AND changes() > 0`,
  unknown: `UPDATE broadcast_emails
   SET unknown_count = unknown_count + 1,
       ${DONE_WHEN_COMPLETE("delivered_count + failure_count + unknown_count + 1")}
 WHERE id = ? AND changes() > 0`,
  failed: `UPDATE broadcast_emails
   SET failure_count = failure_count + 1,
       failed_recipients = json_insert(COALESCE(failed_recipients, '[]'), '$[#]', ?),
       ${DONE_WHEN_COMPLETE("delivered_count + failure_count + 1 + unknown_count")}
 WHERE id = ? AND changes() > 0`,
  // A remainder that never reached the queue: counted as a failure, no address listed.
  unqueued: `UPDATE broadcast_emails
   SET failure_count = failure_count + 1,
       ${DONE_WHEN_COMPLETE("delivered_count + failure_count + 1 + unknown_count")}
 WHERE id = ? AND changes() > 0`,
};

/**
 * Record one recipient's outcome. Returns true when it was new and the counter moved, false
 * when an outcome for this recipient was already recorded (nothing changes). `redacted` is the
 * address as stored in `failed_recipients`, used for `failed` only. Throws on a D1 failure.
 */
export async function recordBroadcastOutcome(
  db: D1Database,
  broadcastId: number,
  to: string,
  outcome: BroadcastOutcome,
  redacted?: string,
): Promise<boolean> {
  const hash = await recipientHash(to);
  const insert = db
    .prepare(
      "INSERT OR IGNORE INTO broadcast_outcomes (broadcast_id, recipient_hash, outcome) VALUES (?, ?, ?)",
    )
    .bind(broadcastId, hash, outcome);
  const update =
    outcome === "failed"
      ? db.prepare(COUNTER_SQL.failed).bind(redacted ?? "", broadcastId)
      : db.prepare(COUNTER_SQL[outcome]).bind(broadcastId);
  const results = await db.batch([insert, update]);
  return (results[0]?.meta?.changes ?? 0) > 0;
}
