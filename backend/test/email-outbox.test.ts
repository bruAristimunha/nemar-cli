/**
 * The announcement outbox consumer (epic #1893 phase 2, ADR 0110). Real D1 for the audit row;
 * the send_email binding is the recorder from helpers/cloudflare-email.ts and the batch is a
 * plain object with ack/retry recorders (helpers/queue-binding.ts): both external boundaries.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { dispatchQueueBatch } from "../src/index";
import {
  OUTBOX_FINAL_ATTEMPT,
  OUTBOX_MAX_RETRIES,
  type OutboxEnv,
  handleOutboxBatch,
  limitRetryDelaySeconds,
} from "../src/services/email-outbox";
import type { Bindings } from "../src/types/bindings";
import { type BindingMessage, bindingError, recordingBinding } from "./helpers/cloudflare-email";
import { freshDb, realD1 } from "./helpers/d1";
import { recordingBatch } from "./helpers/queue-binding";

function seedBroadcast(db: Database, queued: number): number {
  db.prepare(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('broadcastadmin', 'broadcastadmin@nemar.test', 'x', 'approved', 'admin', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO broadcast_emails
       (sent_by, recipient_group, subject, body_markdown, recipient_count, status, queued_count)
     VALUES (1, 'admins', 'Maintenance window', 'Hello **all**', ?, 'queued', ?)`,
  ).run(queued, queued);
  return 1;
}

const row = (db: Database) =>
  db
    .query<
      {
        status: string;
        delivered_count: number;
        failure_count: number;
        unknown_count: number;
        failed_recipients: string;
      },
      []
    >(
      "SELECT status, delivered_count, failure_count, unknown_count, failed_recipients FROM broadcast_emails",
    )
    .get();

function setup(failure?: (m: BindingMessage) => unknown, extra: Partial<OutboxEnv> = {}) {
  const db = freshDb();
  const { binding, sent } = recordingBinding(failure);
  const env: OutboxEnv = {
    DB: realD1(db),
    ENVIRONMENT: "development",
    DEV_EMAIL_ALLOWLIST: "@nemar.test",
    EMAIL_PROVIDER: "cloudflare",
    EMAIL: binding,
    FROM_EMAIL: "NEMAR Staging <noreply@staging.nemar.test>",
    ...extra,
  };
  return { db, env, sent };
}

const msg = (to: string, broadcast_id = 1) => ({ kind: "broadcast", broadcast_id, to });
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const e = console.error;
  const w = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.error = e;
    console.warn = w;
  }
};

describe("handleOutboxBatch", () => {
  test("sends the rendered announcement, counts it and reaches done", async () => {
    const { db, env, sent } = setup();
    seedBroadcast(db, 2);
    const { batch, recorded } = recordingBatch([msg("a@nemar.test"), msg("b@nemar.test")]);
    await handleOutboxBatch(batch.messages as never, env);

    expect(sent.map((m) => m.to)).toEqual(["a@nemar.test", "b@nemar.test"]);
    expect(sent[0].subject).toBe("[DEV] Maintenance window");
    expect(sent[0].html).toContain("<strong>all</strong>");
    expect(sent[0].html).toContain("DEV BACKEND - NOT PRODUCTION");
    expect(recorded.every((r) => r.acked && r.retried === null)).toBe(true);
    expect(row(db)).toMatchObject({ status: "done", delivered_count: 2 });
  });

  test("status stays queued until every outcome is in", async () => {
    const { db, env } = setup();
    seedBroadcast(db, 3);
    const { batch } = recordingBatch([msg("a@nemar.test")]);
    await handleOutboxBatch(batch.messages as never, env);
    expect(row(db)).toMatchObject({ status: "queued", delivered_count: 1 });
  });

  test("a fenced recipient is a failure, never sent, and its address is stored redacted", async () => {
    const { db, env, sent } = setup();
    seedBroadcast(db, 1);
    const { batch, recorded } = recordingBatch([msg("outsider@example.org")]);
    await quiet(() => handleOutboxBatch(batch.messages as never, env));

    expect(sent).toEqual([]);
    expect(recorded[0]).toMatchObject({ acked: true, retried: null });
    const r = row(db);
    expect(r).toMatchObject({ status: "done", failure_count: 1 });
    expect(JSON.parse(r?.failed_recipients ?? "[]")).toEqual(["o***@example.org"]);
    expect(r?.failed_recipients).not.toContain("outsider");
  });

  test("a definite refusal is a failure and acked without retry", async () => {
    const { db, env } = setup(() => bindingError("E_RECIPIENT_SUPPRESSED", "suppressed"));
    seedBroadcast(db, 1);
    const { batch, recorded } = recordingBatch([msg("a@nemar.test")]);
    await quiet(() => handleOutboxBatch(batch.messages as never, env));
    expect(recorded[0]).toMatchObject({ acked: true, retried: null });
    expect(row(db)).toMatchObject({ status: "done", failure_count: 1, delivered_count: 0 });
    expect(JSON.parse(row(db)?.failed_recipients ?? "[]")).toEqual(["a***@nemar.test"]);
  });

  test.each(["E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED"])(
    "%s retries in 300 seconds and changes no counter",
    async (code) => {
      const { db, env } = setup(() => bindingError(code, "slow down"));
      seedBroadcast(db, 1);
      const { batch, recorded } = recordingBatch([msg("a@nemar.test")]);
      await quiet(() => handleOutboxBatch(batch.messages as never, env));
      expect(recorded[0]).toMatchObject({ acked: false, retried: { delaySeconds: 300 } });
      expect(row(db)).toMatchObject({
        status: "queued",
        delivered_count: 0,
        failure_count: 0,
        unknown_count: 0,
      });
    },
  );

  test("an internal error is unknown, acked and never retried", async () => {
    const { db, env } = setup(() => bindingError("E_INTERNAL_SERVER_ERROR", "boom"));
    seedBroadcast(db, 1);
    const { batch, recorded } = recordingBatch([msg("a@nemar.test")]);
    await quiet(() => handleOutboxBatch(batch.messages as never, env));
    expect(recorded[0]).toMatchObject({ acked: true, retried: null });
    expect(row(db)).toMatchObject({ status: "done", unknown_count: 1, failure_count: 0 });
  });

  test("a timeout is unknown, acked and never retried", async () => {
    const { db, env } = setup();
    // A binding that never answers: the broadcast timeout bounds it.
    env.EMAIL = { send: () => new Promise(() => {}) };
    seedBroadcast(db, 1);
    const { batch, recorded } = recordingBatch([msg("a@nemar.test")]);
    const realSetTimeout = globalThis.setTimeout;
    // Shorten only the 10 second bound so the test does not wait for it.
    globalThis.setTimeout = ((fn: () => void, ms?: number) =>
      realSetTimeout(fn, ms === 10_000 ? 20 : ms)) as typeof setTimeout;
    try {
      await quiet(() => handleOutboxBatch(batch.messages as never, env));
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(recorded[0]).toMatchObject({ acked: true, retried: null });
    expect(row(db)).toMatchObject({ status: "done", unknown_count: 1 });
  });

  test("an unusable provider setting is a certain failure", async () => {
    const { db, env } = setup(undefined, { EMAIL_PROVIDER: "cloudfare" });
    seedBroadcast(db, 1);
    const { batch, recorded } = recordingBatch([msg("a@nemar.test")]);
    await quiet(() => handleOutboxBatch(batch.messages as never, env));
    expect(recorded[0]).toMatchObject({ acked: true, retried: null });
    expect(row(db)).toMatchObject({ failure_count: 1 });
  });

  test("a mixed batch lands every outcome and the row is done", async () => {
    const { db, env } = setup((m) =>
      m.to === "bad@nemar.test"
        ? bindingError("E_RECIPIENT_NOT_ALLOWED")
        : m.to === "odd@nemar.test"
          ? bindingError(undefined, "mystery")
          : undefined,
    );
    seedBroadcast(db, 3);
    const { batch } = recordingBatch([
      msg("ok@nemar.test"),
      msg("bad@nemar.test"),
      msg("odd@nemar.test"),
    ]);
    await quiet(() => handleOutboxBatch(batch.messages as never, env));
    expect(row(db)).toMatchObject({
      status: "done",
      delivered_count: 1,
      failure_count: 1,
      unknown_count: 1,
    });
  });

  test("a message whose row is missing is acked without sending", async () => {
    const { env, sent } = setup();
    const { batch, recorded } = recordingBatch([msg("a@nemar.test", 99)]);
    await quiet(() => handleOutboxBatch(batch.messages as never, env));
    expect(sent).toEqual([]);
    expect(recorded[0]).toMatchObject({ acked: true, retried: null });
  });
});

describe("dispatchQueueBatch", () => {
  test("routes broadcast messages to the outbox and acks anything else", async () => {
    const { db, env, sent } = setup();
    seedBroadcast(db, 1);
    const { batch, recorded } = recordingBatch([
      msg("a@nemar.test"),
      { type: "something.else" },
      "not an object",
    ]);
    await quiet(() => dispatchQueueBatch(batch, env as unknown as Bindings));
    expect(sent.length).toBe(1);
    expect(recorded.map((r) => [r.acked, r.retried])).toEqual([
      [true, null],
      [true, null],
      [true, null],
    ]);
    expect(row(db)?.status).toBe("done");
  });
});

/**
 * The D1 boundary failing: `prepare` throws for SQL matching `prepare`, and `batch` (the
 * outcome write) rejects when `batch` is set. Everything else is the real database.
 */
function failingDb(real: D1Database, fail: { prepare?: RegExp; batch?: boolean }): D1Database {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (fail.prepare?.test(sql)) throw new Error("d1 unavailable");
          return target.prepare(sql);
        };
      }
      if (prop === "batch" && fail.batch) {
        return async () => {
          throw new Error("d1 unavailable");
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("retry bounds and pacing", () => {
  test("the final attempt tracks max_retries", () => {
    expect(OUTBOX_FINAL_ATTEMPT).toBe(OUTBOX_MAX_RETRIES + 1);
    const toml = require("node:fs").readFileSync(
      require("node:path").join(import.meta.dir, "../wrangler-sccn.toml"),
      "utf-8",
    ) as string;
    // Only the outbox consumers: the delivery-events consumers have their own retry budget.
    type Consumer = { queue: string; max_retries?: number };
    const config = Bun.TOML.parse(toml) as {
      queues?: { consumers?: Consumer[] };
      env?: { dev?: { queues?: { consumers?: Consumer[] } } };
    };
    const retries = [
      ...(config.queues?.consumers ?? []),
      ...(config.env?.dev?.queues?.consumers ?? []),
    ]
      .filter((c) => c.queue.startsWith("nemar-email-outbox"))
      .map((c) => c.max_retries);
    expect(retries).toEqual([OUTBOX_MAX_RETRIES, OUTBOX_MAX_RETRIES]);
  });

  test("a limit refusal retries with a growing, capped delay and changes no counter", async () => {
    expect(limitRetryDelaySeconds(1)).toBe(300);
    expect(limitRetryDelaySeconds(3)).toBe(900);
    expect(limitRetryDelaySeconds(10)).toBe(3000);
    expect(limitRetryDelaySeconds(20)).toBe(3600);
    for (const attempts of [1, 3, 10]) {
      const { db, env } = setup(() => bindingError("E_RATE_LIMIT_EXCEEDED"));
      seedBroadcast(db, 1);
      const { batch, recorded } = recordingBatch([msg("a@nemar.test")], attempts);
      await quiet(() => handleOutboxBatch(batch.messages as never, env));
      expect(recorded[0]).toMatchObject({
        acked: false,
        retried: { delaySeconds: limitRetryDelaySeconds(attempts) },
      });
      expect(row(db)).toMatchObject({ status: "queued", failure_count: 0, delivered_count: 0 });
    }
  });

  test("a limit refusal on the final attempt is recorded as a failure and acked", async () => {
    const { db, env } = setup(() => bindingError("E_DAILY_LIMIT_EXCEEDED"));
    seedBroadcast(db, 1);
    const { batch, recorded } = recordingBatch([msg("a@nemar.test")], OUTBOX_FINAL_ATTEMPT);
    await quiet(() => handleOutboxBatch(batch.messages as never, env));
    expect(recorded[0]).toMatchObject({ acked: true, retried: null });
    const r = row(db);
    expect(r).toMatchObject({ status: "done", failure_count: 1 });
    expect(JSON.parse(r?.failed_recipients ?? "[]")).toEqual(["a***@nemar.test (limit, gave up)"]);
  });

  test("after a limit refusal the rest of the batch is retried unsent", async () => {
    const { db, env, sent } = setup(() => bindingError("E_RATE_LIMIT_EXCEEDED"));
    seedBroadcast(db, 3);
    const { batch, recorded } = recordingBatch([
      msg("a@nemar.test"),
      msg("b@nemar.test"),
      msg("c@nemar.test"),
    ]);
    await quiet(() => handleOutboxBatch(batch.messages as never, env));
    expect(sent.length).toBe(1); // only the first was tried
    for (const r of recorded)
      expect(r).toMatchObject({ acked: false, retried: { delaySeconds: 300 } });
    expect(row(db)).toMatchObject({ status: "queued", delivered_count: 0, failure_count: 0 });
  });

  test("deferred messages on their final attempt give up rather than reach the DLQ", async () => {
    const { db, env } = setup(() => bindingError("E_RATE_LIMIT_EXCEEDED"));
    seedBroadcast(db, 2);
    const { batch, recorded } = recordingBatch(
      [msg("a@nemar.test"), msg("b@nemar.test")],
      OUTBOX_FINAL_ATTEMPT,
    );
    await quiet(() => handleOutboxBatch(batch.messages as never, env));
    expect(recorded.every((r) => r.acked && r.retried === null)).toBe(true);
    expect(row(db)).toMatchObject({ status: "done", failure_count: 2 });
  });

  test("an unreadable row retries, then gives up on the final attempt", async () => {
    const { db, env, sent } = setup();
    seedBroadcast(db, 1);
    const broken = { ...env, DB: failingDb(env.DB, { prepare: /SELECT subject/ }) };

    const first = recordingBatch([msg("a@nemar.test")], 1);
    await quiet(() => handleOutboxBatch(first.batch.messages as never, broken));
    expect(first.recorded[0]).toMatchObject({ acked: false, retried: { delaySeconds: 60 } });
    expect(row(db)?.failure_count).toBe(0);

    const last = recordingBatch([msg("a@nemar.test")], OUTBOX_FINAL_ATTEMPT);
    await quiet(() => handleOutboxBatch(last.batch.messages as never, broken));
    expect(last.recorded[0]).toMatchObject({ acked: true, retried: null });
    expect(row(db)).toMatchObject({ status: "done", failure_count: 1 });
    expect(JSON.parse(row(db)?.failed_recipients ?? "[]")).toEqual([
      "a***@nemar.test (row unreadable, gave up)",
    ]);
    expect(sent).toEqual([]);
  });
});

describe("idempotent outcomes", () => {
  test("a duplicate delivery is acked, not re-sent, and counts once", async () => {
    const { db, env, sent } = setup();
    seedBroadcast(db, 2);
    const first = recordingBatch([msg("a@nemar.test")]);
    await handleOutboxBatch(first.batch.messages as never, env);
    const again = recordingBatch([msg("A@nemar.test ")]); // same recipient, differently written
    await quiet(() => handleOutboxBatch(again.batch.messages as never, env));

    expect(sent.length).toBe(1);
    expect(again.recorded[0]).toMatchObject({ acked: true, retried: null });
    expect(row(db)).toMatchObject({ status: "queued", delivered_count: 1 });
    const stored = db.query("SELECT recipient_hash FROM broadcast_outcomes").all();
    expect(stored.length).toBe(1);
    expect(JSON.stringify(stored)).not.toContain("nemar.test");
  });

  test("a failed outcome write is acked and logged, never retried", async () => {
    const { db, env, sent } = setup();
    seedBroadcast(db, 1);
    const broken = { ...env, DB: failingDb(env.DB, { batch: true }) };
    const lines: string[] = [];
    const real = console.error;
    console.error = (...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    };
    const { batch, recorded } = recordingBatch([msg("a@nemar.test")]);
    try {
      await handleOutboxBatch(batch.messages as never, broken);
    } finally {
      console.error = real;
    }
    expect(sent.length).toBe(1);
    expect(recorded[0]).toMatchObject({ acked: true, retried: null });
    expect(lines.some((l) => l.includes("could not record delivered"))).toBe(true);
    expect(lines.join("\n")).not.toContain("a@nemar.test");
  });
});
