/**
 * Email Sending bounce and complaint events (epic #1893 phase 2, ADR 0110). Real D1 for the
 * table; the batch is a plain object with ack/retry recorders (helpers/queue-binding.ts), the
 * Queue boundary. Payloads follow Cloudflare's documented event shapes.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { dispatchQueueBatch } from "../src/index";
import {
  eventRetryDelaySeconds,
  handleEmailEventBatch,
  pruneEmailDeliveryEvents,
} from "../src/services/email-events";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { recordingBatch } from "./helpers/queue-binding";

type Kind = "bounced" | "complained" | "delivered" | "deferred";

function event(kind: Kind, over: Record<string, unknown> = {}, payloadOver = {}) {
  const payload: Record<string, unknown> = {
    eventId: `evt-${kind}-1`,
    messageId: `msg-${kind}`,
    sender: "noreply@send.example.com",
    recipient: "user@example.net",
    subject: "Secret subject line",
    terminal: kind !== "deferred",
    delivery: {
      status: kind,
      smtpStatusCode: "550",
      smtpEnhancedStatusCode: "5.1.1",
      smtpResponse: "550 5.1.1 User unknown",
    },
    ...payloadOver,
  };
  if (kind === "bounced") {
    payload.bounce = { type: "hard", classification: "permanent_failure", reason: "x" };
  }
  if (kind === "deferred") payload.bounce = { type: "soft", classification: "temporary_failure" };
  if (kind === "complained") {
    payload.delivery = { status: "complained" };
    payload.complaint = { type: "abuse" };
  }
  return {
    type: `cf.email.sending.message.${kind}`,
    source: { type: "email.sending", zoneId: "zone", domain: "send.example.com" },
    payload,
    metadata: { eventTimestamp: "2026-06-01T02:48:57.132Z" },
    ...over,
  };
}

const rows = (db: Database) =>
  db.query<Record<string, string | null>, []>("SELECT * FROM email_delivery_events").all();

function setup() {
  const db = freshDb();
  return { db, env: { DB: realD1(db) } };
}

async function run(db: Database, bodies: unknown[]) {
  const { batch, recorded } = recordingBatch(bodies);
  await handleEmailEventBatch(batch.messages, { DB: realD1(db) });
  return recorded;
}

describe("handleEmailEventBatch", () => {
  test("stores a hard bounce with the right columns and no subject", async () => {
    const { db } = setup();
    const [r] = await run(db, [event("bounced")]);
    expect(r.acked).toBe(true);
    expect(r.retried).toBeNull();
    const [row] = rows(db);
    expect(row).toMatchObject({
      event_id: "evt-bounced-1",
      event_type: "message.bounced",
      sending_domain: "send.example.com",
      recipient: "user@example.net",
      sender: "noreply@send.example.com",
      message_id: "msg-bounced",
      bounce_type: "hard",
      smtp_status: "5.1.1",
      smtp_response: "550 5.1.1 User unknown",
      occurred_at: "2026-06-01T02:48:57.132Z",
    });
    expect(row.received_at).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain("Secret subject");
  });

  test("stores a soft bounce", async () => {
    const { db } = setup();
    const body = event("bounced");
    (body.payload as { bounce: { type: string } }).bounce.type = "soft";
    await run(db, [body]);
    expect(rows(db)[0].bounce_type).toBe("soft");
  });

  test("stores a complaint with its type", async () => {
    const { db } = setup();
    const [r] = await run(db, [event("complained")]);
    expect(r.acked).toBe(true);
    expect(rows(db)[0]).toMatchObject({
      event_type: "message.complained",
      bounce_type: "abuse",
      smtp_status: null,
      smtp_response: null,
    });
  });

  test("acks delivered and deferred without storing them", async () => {
    const { db } = setup();
    const out = await run(db, [event("delivered"), event("deferred")]);
    expect(out.every((r) => r.acked && r.retried === null)).toBe(true);
    expect(rows(db)).toHaveLength(0);
  });

  test("acks an unknown event type and malformed bodies", async () => {
    const { db } = setup();
    const noId = event("bounced");
    delete (noId.payload as Record<string, unknown>).eventId;
    const out = await run(db, [
      event("bounced", { type: "cf.email.sending.message.future" }),
      noId,
      event("bounced", { metadata: { eventTimestamp: "not a date" } }),
      event("bounced", {}, { recipient: "" }),
      { type: "cf.email.sending.message.bounced" },
    ]);
    expect(out.every((r) => r.acked && r.retried === null)).toBe(true);
    expect(rows(db)).toHaveLength(0);
  });

  test("a repeated eventId is stored once", async () => {
    const { db } = setup();
    const out = await run(db, [event("bounced"), event("bounced")]);
    expect(out.every((r) => r.acked)).toBe(true);
    expect(rows(db)).toHaveLength(1);
  });

  test("clamps smtp_response to 500 bytes without splitting a character", async () => {
    const { db } = setup();
    const long = `550 ${"é".repeat(400)}`;
    await run(db, [
      event("bounced", {}, { delivery: { smtpEnhancedStatusCode: "5.1.1", smtpResponse: long } }),
    ]);
    const stored = rows(db)[0].smtp_response as string;
    expect(new TextEncoder().encode(stored).byteLength).toBeLessThanOrEqual(500);
    expect(stored).not.toContain("�");
    expect(long.startsWith(stored)).toBe(true);
  });

  test("retries when the D1 write fails, and redacts the address in the log", async () => {
    const db = freshDb();
    db.exec("DROP TABLE email_delivery_events");
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => logged.push(a.join(" "));
    try {
      const [r] = await run(db, [event("bounced")]);
      expect(r.retried).toEqual({ delaySeconds: eventRetryDelaySeconds(1) });
      expect(r.acked).toBe(false);
    } finally {
      console.error = orig;
    }
    expect(logged.join("\n")).not.toContain("user@example.net");
  });
});

describe("dispatchQueueBatch", () => {
  test("routes events and outbox-unrelated bodies separately", async () => {
    const { db, env } = setup();
    const { batch, recorded } = recordingBatch([
      event("bounced"),
      event("complained", {}, { eventId: "evt-2" }),
      { something: "else" },
    ]);
    await dispatchQueueBatch(batch, env as unknown as Bindings);
    expect(recorded.every((r) => r.acked)).toBe(true);
    expect(rows(db).map((r) => r.event_type)).toEqual(["message.bounced", "message.complained"]);
  });
});

describe("pruneEmailDeliveryEvents", () => {
  test("deletes only rows older than 180 days", async () => {
    const { db, env } = setup();
    const now = new Date("2026-10-23T00:00:00.000Z");
    const insert = db.prepare(
      "INSERT INTO email_delivery_events (event_id, event_type, recipient, occurred_at) VALUES (?, 'message.bounced', 'a@example.net', ?)",
    );
    insert.run("old", "2026-04-20T00:00:00.000Z"); // 186 days
    insert.run("edge", "2026-04-26T00:00:00.000Z"); // 180 days
    insert.run("new", "2026-10-01T00:00:00.000Z");
    expect(await pruneEmailDeliveryEvents(env.DB, now)).toBe(1);
    expect(
      rows(db)
        .map((r) => r.event_id)
        .sort(),
    ).toEqual(["edge", "new"]);
  });
});
