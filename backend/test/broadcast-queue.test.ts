/**
 * `nemar admin notify` through the announcement outbox (epic #1893 phase 2, ADR 0110): the
 * producer half. Real D1 for the audit row; the Queue binding is the recorder from
 * helpers/queue-binding.ts, the external boundary.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { type BroadcastEnv, sendBroadcast } from "../src/services/broadcast";
import { type OutboxEnv, handleOutboxBatch } from "../src/services/email-outbox";
import { recordingBinding } from "./helpers/cloudflare-email";
import { freshDb, realD1 } from "./helpers/d1";
import { recordingBatch, recordingQueue } from "./helpers/queue-binding";

const FROM = "NEMAR Staging <noreply@staging.nemar.test>";

function seedSender(db: Database): number {
  db.prepare(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('broadcastadmin', 'broadcastadmin@nemar.test', 'x', 'approved', 'admin', 1)`,
  ).run();
  const row = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'broadcastadmin'")
    .get();
  if (!row) throw new Error("seed: sender insert failed");
  return row.id;
}

function env(queue: Queue | undefined): { env: BroadcastEnv; sent: unknown[] } {
  const { binding, sent } = recordingBinding();
  return {
    sent,
    env: {
      ENVIRONMENT: "development",
      DEV_EMAIL_ALLOWLIST: "@nemar.test",
      EMAIL_PROVIDER: "cloudflare",
      EMAIL: binding,
      EMAIL_OUTBOX: queue,
    },
  };
}

function run(db: Database, recipients: string[], e: BroadcastEnv) {
  return sendBroadcast(
    realD1(db),
    "",
    FROM,
    {
      sentById: seedSender(db),
      group: "admins",
      subject: "Maintenance window",
      bodyMarkdown: "Hello **all**",
      recipients,
    },
    undefined,
    true,
    e,
  );
}

type Row = {
  status: string;
  queued_count: number;
  delivered_count: number;
  failure_count: number;
  unknown_count: number;
  body_markdown: string;
};
const readRow = (db: Database) =>
  db
    .query<Row, []>(
      "SELECT status, queued_count, delivered_count, failure_count, unknown_count, body_markdown FROM broadcast_emails",
    )
    .get();

describe("sendBroadcast with an outbox bound", () => {
  test("queues the row and enqueues only allowed recipients, without the body", async () => {
    const q = recordingQueue();
    const { env: e, sent } = env(q.queue);
    const db = freshDb();
    const result = await run(db, ["a@nemar.test", "outsider@example.org", "b@nemar.test"], e);

    expect(result).toMatchObject({
      status: "queued",
      recipient_count: 2,
      failure_count: 0,
      failed_recipients: [],
      suppressed_count: 1,
    });
    expect(result.error).toBeUndefined();
    expect(sent.length).toBe(0); // nothing is sent inline
    expect(q.bodies).toEqual([
      { kind: "broadcast", broadcast_id: result.broadcast_id, to: "a@nemar.test" },
      { kind: "broadcast", broadcast_id: result.broadcast_id, to: "b@nemar.test" },
    ]);
    expect(JSON.stringify(q.bodies)).not.toContain("outsider");
    expect(JSON.stringify(q.bodies)).not.toContain("Hello");
    expect(readRow(db)).toMatchObject({ status: "queued", queued_count: 2, delivered_count: 0 });
  });

  test("enqueues in chunks of 100", async () => {
    const q = recordingQueue();
    const { env: e } = env(q.queue);
    const recipients = Array.from({ length: 250 }, (_, i) => `u${i}@nemar.test`);
    const result = await run(freshDb(), recipients, e);
    expect(q.batchSizes).toEqual([100, 100, 50]);
    expect(result.recipient_count).toBe(250);
  });

  test("a sendBatch failure midway counts the unqueued remainder and reports the error", async () => {
    const q = recordingQueue({ failBatchAt: 1 });
    const { env: e } = env(q.queue);
    const db = freshDb();
    const recipients = Array.from({ length: 150 }, (_, i) => `u${i}@nemar.test`);
    const result = await run(db, recipients, e);

    expect(result.error).toBe("queue_enqueue_failed");
    expect(result.recipient_count).toBe(100);
    expect(result.failure_count).toBe(50);
    expect(result.failed_recipients).toEqual([]);
    expect(result.status).toBe("queued"); // the 100 enqueued are still to be delivered
    expect(readRow(db)).toMatchObject({ status: "queued", queued_count: 150, failure_count: 50 });
  });

  test("a sendBatch failure on the first chunk leaves the row done", async () => {
    const q = recordingQueue({ failBatchAt: 0 });
    const { env: e } = env(q.queue);
    const db = freshDb();
    const result = await run(db, ["a@nemar.test", "b@nemar.test"], e);
    expect(result).toMatchObject({ status: "done", recipient_count: 0, failure_count: 2 });
    expect(readRow(db)).toMatchObject({ status: "done", failure_count: 2 });
  });

  test("with every recipient fenced nothing is queued and the row is sent", async () => {
    const q = recordingQueue();
    const { env: e } = env(q.queue);
    const db = freshDb();
    const result = await run(db, ["x@example.org"], e);
    expect(q.bodies).toEqual([]);
    expect(result).toMatchObject({ status: "sent", recipient_count: 0, suppressed_count: 1 });
    expect(readRow(db)?.status).toBe("sent");
  });

  test("without the outbox the sequential path runs and the row is sent", async () => {
    const { env: e, sent } = env(undefined);
    const db = freshDb();
    const result = await run(db, ["a@nemar.test"], e);
    expect(result.status).toBe("sent");
    expect(sent.length).toBe(1);
    expect(readRow(db)).toMatchObject({ status: "sent", queued_count: 0 });
  });

  test("after a partial enqueue every message counts once, even one that was in fact enqueued", async () => {
    const q = recordingQueue({ failBatchAt: 1 });
    const { env: e, sent } = env(q.queue);
    const db = freshDb();
    const recipients = Array.from({ length: 150 }, (_, i) => `u${i}@nemar.test`);
    const result = await run(db, recipients, e);
    expect(result).toMatchObject({
      recipient_count: 100,
      failure_count: 50,
      error: "queue_enqueue_failed",
    });
    const outcomes = db
      .query<{ outcome: string; n: number }, []>(
        "SELECT outcome, COUNT(*) AS n FROM broadcast_outcomes GROUP BY outcome",
      )
      .all();
    expect(outcomes).toEqual([{ outcome: "unqueued", n: 50 }]);

    // The 100 that were enqueued, plus one from the unqueued remainder that the failed sendBatch
    // had in fact enqueued after all: it must not be sent or counted again.
    const delivered = [
      ...q.bodies,
      { kind: "broadcast", broadcast_id: result.broadcast_id, to: "u120@nemar.test" },
    ];
    const { batch, recorded } = recordingBatch(delivered);
    const quiet = console.warn;
    console.warn = () => {};
    try {
      await handleOutboxBatch(batch.messages as never, { ...e, DB: realD1(db) } as OutboxEnv);
    } finally {
      console.warn = quiet;
    }
    expect(sent.length).toBe(100);
    expect(recorded.every((r) => r.acked)).toBe(true);
    expect(readRow(db)).toMatchObject({
      status: "done",
      queued_count: 150,
      delivered_count: 100,
      failure_count: 50,
    });
  });

  test("case-variant duplicates are queued once and the row reaches done", async () => {
    const q = recordingQueue();
    const { env: e } = env(q.queue);
    const db = freshDb();
    const result = await run(db, ["a@nemar.test", "A@Nemar.test ", "b@nemar.test"], e);
    expect(result.recipient_count).toBe(2);
    expect(q.bodies.map((b) => (b as { to: string }).to)).toEqual(["a@nemar.test", "b@nemar.test"]);
    expect(readRow(db)).toMatchObject({ queued_count: 2 });

    const { batch } = recordingBatch(q.bodies);
    await handleOutboxBatch(batch.messages as never, { ...e, DB: realD1(db) } as OutboxEnv);
    expect(readRow(db)).toMatchObject({ status: "done", queued_count: 2, delivered_count: 2 });
  });
});
