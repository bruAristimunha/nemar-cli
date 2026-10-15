/**
 * A withdrawal that lands between an approval's read and its first write.
 *
 * ADR 0104: every writer that ends or starts a publication request is guarded on
 * the request still being active, and checks how many rows it changed. The
 * orchestrator's "mark approving" write and the administrator's deny are the two
 * that could otherwise overwrite a withdrawal. Both are driven here through the
 * real routes (`POST /admin/publish/:id/approve`, `POST /admin/publish/:id/deny`),
 * with the depositor's REAL withdraw route called from a hook that runs just
 * ahead of the guarded statement, so the interleaving is real and only
 * deterministic. `realD1` runs each statement synchronously, so without the hook
 * the two could not overlap.
 *
 * The approval runs as the CLI does for a request nothing has run on
 * (`resume: false`); the race is lost before any step runs, so no external
 * service is touched beyond the identifier-screen gate's one read of `main`,
 * answered by a `Bun.serve()` stand-in as in approval-attribution.test.ts.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the
 * real auth middleware, the real routes.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { datasetRoutes } from "../src/routes/datasets";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, interceptingD1, realD1 } from "./helpers/d1";
import { mainRefAnswer, markDatasetScreensClean } from "./helpers/identifier-screen";

const OWNER_KEY = "race-owner-key-0123456789abcdef0123456789abcdef";
const ADMIN_KEY = "race-admin-key-0123456789abcdef0123456789abcdef";
const DATASET = "nm000491";

let server: Server;
let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let env: Bindings;
let ownerId: number;
let requestId: number;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      return mainRefAnswer(req) ?? new Response(null, { status: 204 });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

async function addUser(username: string, role: string, key: string): Promise<number> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        given_name, family_name)
     VALUES ('${username}', '${username}@example.org', 'x', 'approved', '${role}', 1, 'Test', 'User')`,
  );
  const id = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username)?.id as number;
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    id,
    await hashApiKey(key),
    key.slice(0, 8),
  );
  return id;
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/datasets", datasetRoutes);
  app.route("/admin", adminRoutes);
  env = { DB: realD1(db), ENVIRONMENT: "test", GITHUB_ADMIN_PAT: "test-pat" } as Bindings;
  ownerId = await addUser("raceowner", "member", OWNER_KEY);
  await addUser("raceadmin", "admin", ADMIN_KEY);
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, visibility)
     VALUES ('${DATASET}', 'Race me', ${ownerId}, 'nemarDatasets/${DATASET}', 'private')`,
  );
  db.run(
    `INSERT INTO publication_requests
       (dataset_id, status, requested_by, requested_at, updated_at, steps_completed)
     VALUES ('${DATASET}', 'requested', ${ownerId}, datetime('now', '-3 hours'),
             datetime('now', '-180 minutes'), '[]')`,
  );
  requestId = db.query<{ id: number }, []>("SELECT MAX(id) AS id FROM publication_requests").get()
    ?.id as number;
  markDatasetScreensClean(db, DATASET);
});

/** The depositor's real withdraw route, on the plain (unhooked) database. */
async function withdrawNow(): Promise<void> {
  const res = await app.request(
    `/datasets/${DATASET}/publish/withdraw`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${OWNER_KEY}`, "X-CLI-Version": "99.0.0" },
    },
    env,
  );
  expect(res.status).toBe(200);
}

/** Run `withdrawNow` once, just ahead of the first statement whose SQL contains `marker`. */
function withdrawBefore(marker: string): Bindings {
  let done = false;
  return {
    ...env,
    DB: interceptingD1(realD1(db), async (sql) => {
      if (!done && sql.includes(marker)) {
        done = true;
        await withdrawNow();
      }
    }),
  } as Bindings;
}

function post(path: string, body: unknown, bindings: Bindings): Promise<Response> {
  return app.request(
    path,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ADMIN_KEY}`,
        "Content-Type": "application/json",
        "X-CLI-Version": "99.0.0",
      },
      body: JSON.stringify(body),
    },
    bindings,
  );
}

function row() {
  return db
    .query<
      {
        status: string;
        withdrawn_at: string | null;
        approved_by: number | null;
        denied_by: number | null;
        denied_reason: string | null;
      },
      [number]
    >(
      "SELECT status, withdrawn_at, approved_by, denied_by, denied_reason FROM publication_requests WHERE id = ?",
    )
    .get(requestId) as {
    status: string;
    withdrawn_at: string | null;
    approved_by: number | null;
    denied_by: number | null;
    denied_reason: string | null;
  };
}

describe("an approval that loses to a withdrawal", () => {
  test("answers 409 request_ended and leaves the withdrawal as it was", async () => {
    const res = await post(
      `/admin/publish/${DATASET}/approve`,
      { resume: false },
      withdrawBefore("SET status = 'approving'"),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("request_ended");
    expect(body.error).toContain("withdrawn");
    // The withdrawal stands: not re-opened as approving, nobody recorded as approver.
    expect(row()).toMatchObject({ status: "denied", approved_by: null, denied_by: null });
    expect(row().withdrawn_at).not.toBeNull();
    // And nothing ran after the lost claim: no publication audit row.
    expect(db.query("SELECT 1 FROM audit_log WHERE action = 'dataset_published'").get()).toBeNull();
  });
});

describe("a denial that loses to a withdrawal", () => {
  test("answers 409 and records no denier and no reason", async () => {
    // The first look finds the request active (so this is not the 404 a request
    // withdrawn BEFORE the deny gets); the guarded UPDATE is the one that loses.
    const res = await post(
      `/admin/publish/${DATASET}/deny`,
      { reason: "too late" },
      withdrawBefore("SET status = 'denied', denied_at"),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain(
      "ended before it could be denied",
    );
    expect(row()).toMatchObject({ status: "denied", denied_by: null, denied_reason: null });
    expect(row().withdrawn_at).not.toBeNull();
  });
});
