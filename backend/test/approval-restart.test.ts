/**
 * A new approval attempt starts clean (ADR 0080).
 *
 * `/approve` is called once per attempt: the first call, every batch of the S3
 * Object Lock loop, and every retry after a failed step. When it starts it
 * clears the request's `last_error`, because a new attempt begins and the
 * previous attempt's error is history (the caller's own output has it). That is
 * what makes a run that is genuinely restarting read as in flight again at once,
 * instead of failed until it fails or finishes.
 *
 * The lease also has to outlast the CLI's own retry wait. A failed run stays in
 * flight for FAILED_RUN_GRACE_SECONDS after it fails, and the CLI waits
 * APPROVE_RETRY_DELAY_MS before it retries, so a second executor launched in
 * that wait would run beside the retry about to start. The last test holds the
 * two numbers together.
 *
 * Driven through the real routes on a real schema. The restart is made to stop
 * early by approving an `xx` (sandbox) dataset, which `/approve` refuses with a
 * 400 only AFTER the request-start UPDATE, so nothing external is touched. That
 * refusal now writes its own sentence as `last_error` (#1582), so the row is read
 * at the one moment that shows what the request-start UPDATE alone did: just
 * before that write.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { APPROVE_RETRY_DELAY_MS } from "../../shared/publication-retry.js";
import { adminRoutes } from "../src/routes/admin";
import { FAILED_RUN_GRACE_SECONDS } from "../src/services/approval-dispatch";
import { PRE_LOOP_FAILURE_SQL } from "../src/services/publication-orchestrator";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, interceptingD1, realD1 } from "./helpers/d1";

const ADMIN_KEY = "restart-admin-key-0123456789abcdef0123456789abcdef";
const SANDBOX_DATASET = "xx012345";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let env: Bindings;
let adminId: number;

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  env = { DB: realD1(db), ENVIRONMENT: "test", GITHUB_ADMIN_PAT: "t" } as Bindings;
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        given_name, family_name)
     VALUES ('restartadmin', 'restartadmin@example.org', 'x', 'approved', 'admin', 1, 'Re', 'Start')`,
  );
  adminId = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='restartadmin'").get()
    ?.id as number;
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    adminId,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, visibility, is_sandbox)
     VALUES (?, 'Sandbox', ?, ?, 'private', 1)`,
    [SANDBOX_DATASET, adminId, `nemarDatasets/${SANDBOX_DATASET}`],
  );
});

/** A run that failed five minutes ago: stalled, with its error still on the row. */
function seedFailedRun(): number {
  db.run(
    `INSERT INTO publication_requests
       (dataset_id, status, requested_by, requested_at, updated_at, steps_completed, last_error, current_step)
     VALUES (?, 'approving', ?, datetime('now', '-3 hours'), datetime('now', '-5 minutes'),
             '[]', 'EZID 503', 'doi_create')`,
    [SANDBOX_DATASET, adminId],
  );
  return db.query<{ id: number }, []>("SELECT MAX(id) AS id FROM publication_requests").get()
    ?.id as number;
}

function approve(bindings: Bindings = env): Promise<Response> {
  return app.request(
    `/admin/publish/${SANDBOX_DATASET}/approve`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ resume: true }),
    },
    bindings,
  );
}

function inFlight(id: number): Promise<boolean> {
  return app
    .request("/admin/publish/requests", { headers: { Authorization: `Bearer ${ADMIN_KEY}` } }, env)
    .then(
      (r) => r.json() as Promise<{ requests: Array<{ id: number; approval_in_flight: boolean }> }>,
    )
    .then((b) => b.requests.find((r) => r.id === id)?.approval_in_flight ?? false);
}

describe("a restarting run", () => {
  test("is stalled before the attempt, and in flight as soon as /approve starts it", async () => {
    const id = seedFailedRun();
    expect(await inFlight(id)).toBe(false);

    // The row as the request-start UPDATE left it: read when the refusal below is about to write
    // its own error, which is the next write of the call.
    let afterStart: { status: string; last_error: string | null } | null = null;
    const watched = {
      ...env,
      DB: interceptingD1(realD1(db), (sql) => {
        if (sql === PRE_LOOP_FAILURE_SQL) {
          afterStart = db
            .query<{ status: string; last_error: string | null }, [number]>(
              "SELECT status, last_error FROM publication_requests WHERE id = ?",
            )
            .get(id);
        }
      }),
    } as Bindings;
    const res = await approve(watched);
    // Refused by the sandbox gate, which runs AFTER the request-start UPDATE.
    expect(res.status).toBe(400);

    // The previous attempt's error is cleared as the new attempt begins...
    expect(afterStart).toEqual({ status: "approving", last_error: null });
    // ...the refusal then says why it stopped, in its own words and not the old run's...
    const row = db
      .query<{ status: string; last_error: string | null }, [number]>(
        "SELECT status, last_error FROM publication_requests WHERE id = ?",
      )
      .get(id);
    expect(row?.status).toBe("approving");
    expect(row?.last_error).toContain("Sandbox datasets");
    expect(row?.last_error).not.toContain("EZID");
    // ...and the heartbeat is fresh, so the row reads as running at once.
    expect(await inFlight(id)).toBe(true);
  });

  test("keeps current_step, which says where the run had got to", async () => {
    const id = seedFailedRun();
    await approve();
    expect(
      db
        .query<{ current_step: string | null }, [number]>(
          "SELECT current_step FROM publication_requests WHERE id = ?",
        )
        .get(id)?.current_step,
    ).toBe("doi_create");
  });
});

describe("the grace window and the CLI's retry wait", () => {
  test("a failed run is held in flight for longer than the CLI waits before retrying", () => {
    // If the CLI's wait is raised without the grace, a second executor could be
    // launched in the gap before the retry; this turns that into a red build.
    // Required margin: three retry waits, enough for the failing call to return
    // and the retry to reach /approve.
    expect(FAILED_RUN_GRACE_SECONDS * 1000).toBeGreaterThanOrEqual(3 * APPROVE_RETRY_DELAY_MS);
  });
});
