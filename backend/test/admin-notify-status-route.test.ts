/**
 * POST /admin/notify through the outbox and GET /admin/notify/:id (epic #1893 phase 2).
 * The real admin router and real D1; the Queue and send_email bindings are the recorders at the
 * external boundary. The consumer is run on what the route enqueued, so the status the GET
 * reports is the one a real delivery would leave.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { type OutboxEnv, handleOutboxBatch } from "../src/services/email-outbox";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { bindingError, recordingBinding } from "./helpers/cloudflare-email";
import { freshDb, realD1 } from "./helpers/d1";
import { recordingBatch, recordingQueue } from "./helpers/queue-binding";

const ADMIN_KEY = "notify-route-admin-key-0123456789abcdef012345";
const USER_KEY = "notify-route-user-key-0123456789abcdef0123456";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

async function seed(username: string, role: "admin" | "member", key: string, email: string) {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access)
     VALUES (?, ?, 'x', 'approved', ?, 1, 1)`,
  ).run(username, email, role);
  const u = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!u) throw new Error("seed failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(key),
    key.slice(0, 8),
  );
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seed("notifyadmin", "admin", ADMIN_KEY, "notifyadmin@nemar.test");
  await seed("notifymember", "member", USER_KEY, "notifymember@nemar.test");
  await seed(
    "fenceduser",
    "admin",
    "fenced-user-key-0123456789abcdef0123456789",
    "fenced@example.org",
  );
});

function env(queue: Queue, failure?: Parameters<typeof recordingBinding>[0]) {
  const { binding, sent } = recordingBinding(failure);
  const e = {
    DB: realD1(db),
    ENVIRONMENT: "development",
    DEV_EMAIL_ALLOWLIST: "@nemar.test",
    EMAIL_PROVIDER: "cloudflare",
    EMAIL: binding,
    EMAIL_OUTBOX: queue,
    FROM_EMAIL: "NEMAR Staging <noreply@staging.nemar.test>",
  } as unknown as Bindings;
  return { e, sent };
}

const get = (id: number | string, key: string, e: Bindings) =>
  app.request(`/admin/notify/${id}`, { headers: { Authorization: `Bearer ${key}` } }, e);

describe("announcements through the outbox", () => {
  test("POST queues, the consumer delivers, GET reports done", async () => {
    const q = recordingQueue();
    const { e, sent } = env(q.queue, (m) =>
      m.to === "notifymember@nemar.test" ? bindingError("E_RECIPIENT_SUPPRESSED") : undefined,
    );
    const post = await app.request(
      "/admin/notify",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ to: "all", subject: "Hello", body: "Body text" }),
      },
      e,
    );
    expect(post.status).toBe(200);
    const result = (await post.json()) as {
      broadcast_id: number;
      status: string;
      recipient_count: number;
      suppressed_count: number;
    };
    expect(result).toMatchObject({ status: "queued", recipient_count: 2, suppressed_count: 1 });
    expect(sent).toEqual([]);

    const before = (await (await get(result.broadcast_id, ADMIN_KEY, e)).json()) as Record<
      string,
      unknown
    >;
    expect(before).toMatchObject({ status: "queued", queued_count: 2, delivered_count: 0 });

    const { batch } = recordingBatch(q.bodies);
    const quiet = console.error;
    console.error = () => {};
    try {
      await handleOutboxBatch(batch.messages as never, e as unknown as OutboxEnv);
    } finally {
      console.error = quiet;
    }

    const after = (await (await get(result.broadcast_id, ADMIN_KEY, e)).json()) as {
      failed_recipients: string[];
    };
    expect(after).toMatchObject({
      id: result.broadcast_id,
      status: "done",
      subject: "Hello",
      recipient_group: "all",
      queued_count: 2,
      delivered_count: 1,
      failure_count: 1,
      unknown_count: 0,
    });
    expect(after.failed_recipients).toEqual(["n***@nemar.test"]);
    expect(JSON.stringify(after)).not.toContain("notifymember@");
  });

  test("an enqueue failure answers 200 with the error and the counted remainder", async () => {
    const q = recordingQueue({ failBatchAt: 0 });
    const { e } = env(q.queue);
    const post = await app.request(
      "/admin/notify",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ to: "all", subject: "Hello", body: "Body text" }),
      },
      e,
    );
    expect(post.status).toBe(200);
    expect(await post.json()).toMatchObject({ error: "queue_enqueue_failed", failure_count: 2 });
  });
});

describe("GET /admin/notify/:id", () => {
  test("404 for an absent id, 400 for a malformed one", async () => {
    const { e } = env(recordingQueue().queue);
    expect((await get(999, ADMIN_KEY, e)).status).toBe(404);
    expect((await get("abc", ADMIN_KEY, e)).status).toBe(400);
  });

  test("a non-admin is refused and no key is 401", async () => {
    const { e } = env(recordingQueue().queue);
    expect((await get(1, USER_KEY, e)).status).toBe(403);
    expect((await app.request("/admin/notify/1", {}, e)).status).toBe(401);
  });

  test("a row from before the outbox reads as sent", async () => {
    db.query(
      `INSERT INTO broadcast_emails (sent_by, recipient_group, subject, body_markdown, recipient_count)
       VALUES (1, 'all', 'Old', 'x', 5)`,
    ).run();
    const { e } = env(recordingQueue().queue);
    const res = await get(1, ADMIN_KEY, e);
    expect(await res.json()).toMatchObject({ status: "sent", queued_count: 0, subject: "Old" });
  });
});
