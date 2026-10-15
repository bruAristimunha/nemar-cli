/**
 * POST /datasets/:id/publish/withdraw: the depositor takes their own publication
 * request back, with no administrator involved.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the
 * real auth middleware, and the real routes through Hono's `app.request()`.
 * Ages are set with SQLite's own `datetime('now', '-N minutes')`, well clear of
 * the 15-minute approval lease edge, so no clock is faked.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { datasetRoutes } from "../src/routes/datasets";
import { MARK_APPROVING_SQL } from "../src/services/publication-orchestrator";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const OWNER_KEY = "withdraw-owner-key-0123456789abcdef0123456789abcdef";
const OTHER_KEY = "withdraw-other-key-0123456789abcdef0123456789abcdef";
const ADMIN_KEY = "withdraw-admin-key-0123456789abcdef0123456789abcdef";
const DATASET = "nm000490";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let env: Bindings;
let ownerId: number;

async function addUser(username: string, role: string, key: string): Promise<number> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('${username}', '${username}@example.org', 'x', 'approved', '${role}', 1)`,
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
  env = { DB: realD1(db), ENVIRONMENT: "test" } as Bindings;
  ownerId = await addUser("wdowner", "member", OWNER_KEY);
  await addUser("wdother", "member", OTHER_KEY);
  await addUser("wdadmin", "admin", ADMIN_KEY);
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, visibility)
     VALUES ('${DATASET}', 'Withdraw me', ${ownerId}, 'nemarDatasets/${DATASET}', 'private')`,
  );
});

function seedRequest(
  status: string,
  extra: {
    dispatchedAt?: string;
    ageMinutes?: number;
    steps?: string[];
    currentStep?: string;
    lastError?: string;
  } = {},
): number {
  db.run(
    `INSERT INTO publication_requests
       (dataset_id, status, requested_by, requested_at, updated_at, approval_dispatched_at,
        steps_completed, current_step, last_error)
     VALUES ('${DATASET}', '${status}', ${ownerId}, datetime('now', '-3 hours'),
             datetime('now', '-${extra.ageMinutes ?? 180} minutes'),
             ${extra.dispatchedAt ? `datetime('now', '${extra.dispatchedAt}')` : "NULL"},
             ?, ?, ?)`,
    [JSON.stringify(extra.steps ?? []), extra.currentStep ?? null, extra.lastError ?? null],
  );
  return db.query<{ id: number }, []>("SELECT MAX(id) AS id FROM publication_requests").get()
    ?.id as number;
}

function row(id: number) {
  return db
    .query<
      {
        status: string;
        withdrawn_at: string | null;
        denied_by: number | null;
        denied_reason: string | null;
      },
      [number]
    >(
      "SELECT status, withdrawn_at, denied_by, denied_reason FROM publication_requests WHERE id = ?",
    )
    .get(id) as {
    status: string;
    withdrawn_at: string | null;
    denied_by: number | null;
    denied_reason: string | null;
  };
}

/**
 * A real D1 whose first `batch()` waits for `before()` first: the route's SELECT
 * has been read, its conditional write is about to run, and `before` lands
 * another writer in that gap. `realD1` runs each statement synchronously, so
 * without this gap a lost race cannot be built. Statements still run on the real
 * engine; nothing is faked.
 */
function racingBatchD1(d1: D1Database, before: () => void | Promise<void>): D1Database {
  let fired = false;
  return {
    prepare: (sql: string) => d1.prepare(sql),
    async batch(stmts: unknown[]) {
      if (!fired) {
        fired = true;
        await before();
      }
      return (d1 as unknown as { batch(s: unknown[]): Promise<unknown> }).batch(stmts);
    },
  } as unknown as D1Database;
}

function withdrawRacing(before: () => void | Promise<void>): Promise<Response> {
  return app.request(
    `/datasets/${DATASET}/publish/withdraw`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${OWNER_KEY}`, "X-CLI-Version": "99.0.0" },
    },
    { ...env, DB: racingBatchD1(env.DB, before) } as Bindings,
  );
}

/** The steps a run records before it changes anything, and the first ones after. */
const VALIDATION_ONLY = ["ci_check", "enrichment_check"];
const PUBLIC_STEPS = ["ci_check", "enrichment_check", "s3_public_read", "repo_public"];

function auditRows() {
  return db
    .query<
      {
        user_id: number | null;
        action: string;
        resource_type: string | null;
        resource_id: string | null;
        details: string | null;
      },
      []
    >(
      "SELECT user_id, action, resource_type, resource_id, details FROM audit_log WHERE action = 'publication_request_withdrawn'",
    )
    .all();
}

function withdraw(key = OWNER_KEY, dataset = DATASET): Promise<Response> {
  return app.request(
    `/datasets/${dataset}/publish/withdraw`,
    { method: "POST", headers: { Authorization: `Bearer ${key}`, "X-CLI-Version": "99.0.0" } },
    env,
  );
}

describe("a request nobody has acted on", () => {
  for (const status of ["requested", "blocked"]) {
    test(`a ${status} request is withdrawn by its owner`, async () => {
      const id = seedRequest(status);
      const res = await withdraw();
      expect(res.status).toBe(200);
      const r = row(id);
      expect(r.status).toBe("denied");
      expect(r.withdrawn_at).not.toBeNull();
      // The requester's own act: no administrator and no reason are recorded.
      expect(r.denied_by).toBeNull();
      expect(r.denied_reason).toBeNull();
    });
  }

  test("a stale dispatch (lease lapsed, nothing followed) does not block a withdrawal", async () => {
    const id = seedRequest("requested", { dispatchedAt: "-16 minutes" });
    expect((await withdraw()).status).toBe(200);
    expect(row(id).withdrawn_at).not.toBeNull();
  });

  test("withdrawing twice is a 404 the second time, not a second write", async () => {
    seedRequest("requested");
    expect((await withdraw()).status).toBe(200);
    expect((await withdraw()).status).toBe(404);
  });

  test("a withdrawn request is not active: an admin cannot approve it", async () => {
    seedRequest("requested");
    await withdraw();
    const res = await app.request(
      `/admin/publish/${DATASET}/approve`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe("a request an administrator has started on", () => {
  test("an approving request is refused with 409 and left alone", async () => {
    const id = seedRequest("approving", { ageMinutes: 1 });
    const res = await withdraw();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("withdraw_too_late");
    expect(row(id)).toMatchObject({ status: "approving", withdrawn_at: null });
  });

  test("a dispatched approval still inside its lease is refused with 409", async () => {
    const id = seedRequest("requested", { dispatchedAt: "-5 minutes" });
    expect((await withdraw()).status).toBe(409);
    expect(row(id)).toMatchObject({ status: "requested", withdrawn_at: null });
  });

  test("an approving request whose lease has lapsed is still refused", async () => {
    // `approving` means a run claimed the request and may be between steps; the
    // lease only says whether something is still driving it. A stalled run is for
    // an administrator to re-run or deny, not for the depositor to close, so the
    // status refuses it whatever the lease says.
    const id = seedRequest("approving", { ageMinutes: 20 });
    const res = await withdraw();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("withdraw_too_late");
    expect(row(id)).toMatchObject({ status: "approving", withdrawn_at: null });
  });

  test("a dispatched run that failed more than the grace ago is stalled and may be withdrawn", async () => {
    // The dispatch is inside the lease, but the run recorded an error and has
    // been quiet for 2 minutes, past FAILED_RUN_GRACE_SECONDS (60): nothing is
    // driving it, so it does not count as in flight.
    const id = seedRequest("requested", {
      dispatchedAt: "-5 minutes",
      lastError: "ci_check failed",
      ageMinutes: 2,
    });
    expect((await withdraw()).status).toBe(200);
    expect(row(id).withdrawn_at).not.toBeNull();
  });

  test("a dispatched run that failed seconds ago is still in flight and is refused", async () => {
    // Inside the grace the CLI's own retry may be about to start, so the failure
    // does not yet release the lease (services/approval-dispatch.ts).
    const id = seedRequest("requested", {
      dispatchedAt: "-5 minutes",
      lastError: "ci_check failed",
    });
    db.run(
      `UPDATE publication_requests SET updated_at = datetime('now', '-10 seconds') WHERE id = ${id}`,
    );
    expect((await withdraw()).status).toBe(409);
    expect(row(id)).toMatchObject({ status: "requested", withdrawn_at: null });
  });

  test("a published request cannot be withdrawn", async () => {
    const id = seedRequest("published");
    expect((await withdraw()).status).toBe(404);
    expect(row(id)).toMatchObject({ status: "published", withdrawn_at: null });
  });
});

describe("a request whose publishing has started, whatever its status", () => {
  // A run that made the data public (s3_public_read, repo_public) and was then
  // walked back to `blocked` (the owner's name was cleared) keeps those steps,
  // and the data is still public. Withdrawing would close the request as
  // withdrawn over a public dataset. Nothing in `status` says so; the steps do.
  for (const status of ["blocked", "requested"]) {
    test(`a ${status} request with public steps recorded is refused with 409`, async () => {
      const id = seedRequest(status, { steps: PUBLIC_STEPS });
      const res = await withdraw();
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; code: string };
      expect(Object.keys(body).sort()).toEqual(["code", "error"]);
      expect(body.code).toBe("withdraw_too_late");
      expect(body.error).toContain("already started");
      expect(row(id)).toMatchObject({ status, withdrawn_at: null });
    });
  }

  test("a run cut off inside its first public step (current_step only) is refused", async () => {
    // A step is recorded as done only after it ran. The bucket-policy write of
    // s3_public_read may have landed unacknowledged, with only validation steps
    // in steps_completed and the step itself in current_step.
    const id = seedRequest("blocked", { steps: VALIDATION_ONLY, currentStep: "s3_public_read" });
    expect((await withdraw()).status).toBe(409);
    expect(row(id)).toMatchObject({ status: "blocked", withdrawn_at: null });
  });

  test("validation-only progress does not block: nothing is public yet", async () => {
    const id = seedRequest("blocked", { steps: VALIDATION_ONLY, currentStep: "enrichment_check" });
    expect((await withdraw()).status).toBe(200);
    expect(row(id).withdrawn_at).not.toBeNull();
  });

  test("steps_completed that is not JSON does not break the write", async () => {
    const id = seedRequest("requested");
    db.run(`UPDATE publication_requests SET steps_completed = 'not json' WHERE id = ${id}`);
    expect((await withdraw()).status).toBe(200);
    expect(row(id).withdrawn_at).not.toBeNull();
  });

  // The guard terms of the write itself, one at a time, with a writer landing
  // between the route's read and its write. updated_at is NOT touched in the
  // first two, because datetime('now') has one-second resolution: a step
  // recorded in the same second as the read leaves updated_at equal, and only the
  // column terms can see it.
  test("public steps recorded after the read (same second) refuse the write", async () => {
    const id = seedRequest("blocked", { ageMinutes: 0 });
    const res = await withdrawRacing(() => {
      db.run("UPDATE publication_requests SET steps_completed = ? WHERE id = ?", [
        JSON.stringify(PUBLIC_STEPS),
        id,
      ]);
    });
    expect(res.status).toBe(409);
    expect(row(id)).toMatchObject({ status: "blocked", withdrawn_at: null });
    expect(auditRows()).toHaveLength(0);
  });

  test("a public step begun after the read (same second) refuses the write", async () => {
    const id = seedRequest("blocked", { ageMinutes: 0 });
    const res = await withdrawRacing(() => {
      db.run("UPDATE publication_requests SET current_step = 's3_public_read' WHERE id = ?", [id]);
    });
    expect(res.status).toBe(409);
    expect(row(id)).toMatchObject({ status: "blocked", withdrawn_at: null });
  });

  test("any other write to the row after the read refuses the write (updated_at guard)", async () => {
    // A touch that changes no column the other terms read: only updated_at moves.
    const id = seedRequest("requested");
    const res = await withdrawRacing(() => {
      db.run("UPDATE publication_requests SET updated_at = datetime('now') WHERE id = ?", [id]);
    });
    expect(res.status).toBe(409);
    expect(row(id)).toMatchObject({ status: "requested", withdrawn_at: null });
    expect(auditRows()).toHaveLength(0);
  });
});

describe("the audit row", () => {
  test("a withdrawal records who, which request and which dataset", async () => {
    const id = seedRequest("requested");
    expect((await withdraw()).status).toBe(200);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: ownerId,
      resource_type: "dataset",
      resource_id: DATASET,
    });
    expect(JSON.parse(rows[0].details as string)).toEqual({ request_id: id });
  });

  test("a refused withdrawal writes none", async () => {
    seedRequest("approving", { ageMinutes: 1 });
    expect((await withdraw()).status).toBe(409);
    expect((await withdraw(OTHER_KEY)).status).toBe(403);
    expect(auditRows()).toHaveLength(0);
  });
});

describe("who may withdraw", () => {
  test("another user is refused", async () => {
    const id = seedRequest("requested");
    expect((await withdraw(OTHER_KEY)).status).toBe(403);
    expect(row(id).withdrawn_at).toBeNull();
  });

  test("an administrator who is not the owner is refused and pointed at deny", async () => {
    const id = seedRequest("requested");
    const res = await withdraw(ADMIN_KEY);
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain("publish deny");
    expect(row(id).withdrawn_at).toBeNull();
  });

  test("an unknown dataset is a 404", async () => {
    expect((await withdraw(OWNER_KEY, "nm000491")).status).toBe(404);
  });

  test("no key is a 401", async () => {
    seedRequest("requested");
    const res = await app.request(`/datasets/${DATASET}/publish/withdraw`, { method: "POST" }, env);
    expect(res.status).toBe(401);
  });

  test("a dataset with no request at all is a 404 with its own code", async () => {
    const res = await withdraw();
    expect(res.status).toBe(404);
    // The CLI keys its hint on `code` and keeps the sentence; its test
    // (test/publish-withdraw-cli.test.ts) stands in for exactly this body.
    expect(await res.json()).toEqual({
      error: "No active publication request found",
      code: "no_active_request",
    });
  });
});

describe("how a withdrawal reads afterwards", () => {
  test("status stays denied for older clients and says withdrawn", async () => {
    seedRequest("requested");
    await withdraw();
    const res = await app.request(
      `/datasets/${DATASET}/publish/status`,
      { headers: { Authorization: `Bearer ${OWNER_KEY}`, "X-CLI-Version": "99.0.0" } },
      env,
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("denied");
    expect(body.withdrawn).toBe(true);
    expect(body.withdrawn_at).toBeTruthy();
    expect(body.denied_reason).toBeNull();
  });

  test("an administrator's denial is not reported as withdrawn", async () => {
    seedRequest("requested");
    const denied = await app.request(
      `/admin/publish/${DATASET}/deny`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "incomplete" }),
      },
      env,
    );
    expect(denied.status).toBe(200);
    const res = await app.request(
      `/datasets/${DATASET}/publish/status`,
      { headers: { Authorization: `Bearer ${OWNER_KEY}`, "X-CLI-Version": "99.0.0" } },
      env,
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.withdrawn).toBe(false);
    expect(body.denied_reason).toBe("incomplete");
  });

  test("the admin list carries withdrawn_at, and a denied-only filter includes it", async () => {
    seedRequest("requested");
    await withdraw();
    const res = await app.request(
      "/admin/publish/requests?status=denied",
      { headers: { Authorization: `Bearer ${ADMIN_KEY}`, "X-CLI-Version": "99.0.0" } },
      env,
    );
    const body = (await res.json()) as {
      requests: Array<{ dataset_id: string; status: string; withdrawn_at: string | null }>;
    };
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]).toMatchObject({ dataset_id: DATASET, status: "denied" });
    expect(body.requests[0].withdrawn_at).toBeTruthy();
  });
});

describe("a withdrawn request stays withdrawn", () => {
  test("the orchestrator's mark-approving write leaves a withdrawn request alone", async () => {
    const id = seedRequest("requested");
    await withdraw();
    const ran = db.query(MARK_APPROVING_SQL).run(ownerId, id);
    expect(ran.changes).toBe(0);
    expect(row(id)).toMatchObject({ status: "denied" });
    expect(row(id).withdrawn_at).not.toBeNull();
  });

  test("the same write still starts an active request", async () => {
    for (const status of ["requested", "blocked", "approving"]) {
      const id = seedRequest(status);
      expect(db.query(MARK_APPROVING_SQL).run(ownerId, id).changes).toBe(1);
      expect(row(id).status).toBe("approving");
    }
  });

  test("a web approval dispatched after the withdrawal finds nothing to approve", async () => {
    seedRequest("requested");
    await withdraw();
    const res = await app.request(
      `/admin/publish/${DATASET}/approve-dispatch`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "X-CLI-Version": "99.0.0" },
      },
      env,
    );
    expect(res.status).toBe(404);
  });

  // This reaches the deny route's first look, which finds no active request (404).
  // The guarded UPDATE, a withdrawal landing after that look, is in
  // publish-withdraw-approve-race.test.ts.
  test("an administrator cannot deny a request that was withdrawn", async () => {
    const id = seedRequest("requested");
    await withdraw();
    const res = await app.request(
      `/admin/publish/${DATASET}/deny`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "too late" }),
      },
      env,
    );
    expect(res.status).toBe(404);
    expect(row(id).denied_reason).toBeNull();
  });

  test("status reports withdrawn only for a denied row, whatever withdrawn_at holds", async () => {
    // No writer today puts withdrawn_at on a live row: `publish request` matches
    // only active statuses and inserts a NEW row after a withdrawal, so the old
    // row stays withdrawn. The column is seeded directly to pin that the report
    // keys on the status as well (ADR 0104, decision 2), so a future writer that
    // revives a row is not read as a withdrawal.
    const id = seedRequest("requested");
    db.run(`UPDATE publication_requests SET withdrawn_at = datetime('now') WHERE id = ${id}`);
    const res = await app.request(
      `/datasets/${DATASET}/publish/status`,
      { headers: { Authorization: `Bearer ${OWNER_KEY}`, "X-CLI-Version": "99.0.0" } },
      env,
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("requested");
    expect(body.withdrawn).toBe(false);
    expect(body.withdrawn_at).toBeNull();
  });
});
