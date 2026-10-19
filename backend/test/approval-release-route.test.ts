/**
 * POST /webhooks/approval-release (#1582, ADR 0105 decision 9).
 *
 * A web click claims the request and dispatches an executor. When that executor fails in a way the
 * Worker cannot see (a missing secret, a failed install, a cancelled run), the claim would hold
 * its lease for fifteen minutes with nothing running. The failing workflow reports it here, with
 * the dispatch token it was handed, and the Worker releases the claim, records one FIXED sentence
 * as the request's `last_error`, and leaves `updated_at` alone so the failed-run grace reads from
 * the run's last real sign of life. The token is the only authentication.
 *
 * What is pinned: a valid token releases and records exactly what decision 9 says; every refusal is
 * the SAME 401 bytes with nothing changed, whether the request is unknown, closed, already
 * released or the token is wrong (an answer that differed would tell a caller which requests have
 * a claim); a specific failure already on the row is never overwritten by the generic sentence;
 * the executor's own words never reach the row; the body is bounded before the database is read;
 * and the token and its MAC reach no log, no audit row and no answer.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the real routes
 * (`/webhooks`, `/admin`) through Hono's `app.request()`, and every token minted by the production
 * `signApprovalDispatchToken` from the row's own columns, never a hand-copied digest. GitHub is a
 * `Bun.serve()` stand-in, used only for the click that follows a release.
 *
 * The executor's token on `/approve` after a release (a 409 `dispatch_superseded`) is the
 * approval route's rule, pinned with that route's tests.
 *
 * CI TIER: unit-pure. Hermetic: an in-process Worker over a local database and a local stand-in.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import {
  APPROVAL_DISPATCH_TOKEN_HEADER,
  APPROVAL_RELEASE_REASONS,
  APPROVAL_RELEASE_REASON_TEXT,
} from "../../shared/contract/publication";
import { AUDIT_LOG_INSERT_SQL } from "../src/db/audit-log";
import { adminRoutes } from "../src/routes/admin";
import { APPROVAL_RELEASE_SQL } from "../src/routes/callbacks/approval-release";
import webhooks from "../src/routes/webhooks";
import { signApprovalDispatchToken } from "../src/services/github/callback-tokens";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, interceptingD1, realD1 } from "./helpers/d1";
import { mainRefAnswer } from "./helpers/identifier-screen";
import { seedScreenedRequest, seedUser } from "./helpers/publication-review";

const SECRET = "approval-release-secret-do-not-use-in-prod";
const ADMIN_KEY = "release-admin-key-0123456789abcdef0123456789abcdef";
const DATASET = "nm098770";
const GENERIC = APPROVAL_RELEASE_REASON_TEXT.workflow_failed;

let server: Server;
let dispatches: { client_payload: Record<string, unknown> }[] = [];
let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let adminId: number;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const ref = mainRefAnswer(request);
      if (ref) return ref;
      dispatches.push(await request.json());
      return new Response(null, { status: 204 });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

afterEach(() => {
  dispatches = [];
});

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/webhooks", webhooks);
  app.route("/admin", adminRoutes);
  adminId = await seedUser(db, "releaseadmin", "admin", ADMIN_KEY);
});

function env(over: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    GITHUB_ADMIN_PAT: "ghp_release_test_token",
    PRESCREEN_CALLBACK_SECRET: SECRET,
    ...over,
  } as Bindings;
}

interface RequestRow {
  id: number;
  status: string;
  approval_requested_by: number | null;
  approval_dispatched_at: string | null;
  last_error: string | null;
  updated_at: string;
  [column: string]: unknown;
}

function requestRow(id: number): RequestRow {
  return db
    .query<RequestRow, [number]>("SELECT * FROM publication_requests WHERE id = ?")
    .get(id) as RequestRow;
}

/** The columns a release writes; every other column of the row must come through it unchanged. */
const RELEASE_COLUMNS = ["approval_requested_by", "approval_dispatched_at", "last_error"];

function withoutReleaseColumns(row: RequestRow): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([k]) => !RELEASE_COLUMNS.includes(k)));
}

function releasedAudit(): {
  user_id: number | null;
  resource_type: string;
  resource_id: string;
  details: string;
}[] {
  return db
    .query<
      { user_id: number | null; resource_type: string; resource_id: string; details: string },
      []
    >(
      "SELECT user_id, resource_type, resource_id, details FROM audit_log WHERE action = 'approval_dispatch_released'",
    )
    .all();
}

interface Seeded {
  requestId: number;
  datasetId: string;
  clickerId: number;
  claimedAt: string;
  token: string;
}

interface SeedClaim {
  datasetId?: string;
  /** The request's status. Default `requested`. */
  status?: "requested" | "approving" | "blocked" | "denied" | "published";
  /** SQLite modifier for the claim's instant. Default three minutes ago. */
  dispatchedAgo?: string;
  /** SQLite modifier for `updated_at`; left at the seed's own value when omitted. */
  updatedAgo?: string;
  /** A failure already recorded by a step of the run. */
  lastError?: string;
  /** No claim at all: the request was never dispatched, or it was released already. */
  unclaimed?: boolean;
}

/**
 * A request and, unless told otherwise, the claim a web click leaves on it, with the token the
 * dispatch would have carried: minted by the production signer from the row's real columns.
 */
async function seedClaim(o: SeedClaim = {}): Promise<Seeded> {
  const datasetId = o.datasetId ?? DATASET;
  const { requestId } = seedScreenedRequest(db, {
    datasetId,
    requestStatus: o.status ?? "requested",
  });
  if (!o.unclaimed) {
    db.run(
      `UPDATE publication_requests
          SET approval_requested_by = ?, approval_dispatched_at = datetime('now', ?)
        WHERE id = ?`,
      [adminId, o.dispatchedAgo ?? "-3 minutes", requestId],
    );
  }
  if (o.updatedAgo) {
    db.run("UPDATE publication_requests SET updated_at = datetime('now', ?) WHERE id = ?", [
      o.updatedAgo,
      requestId,
    ]);
  }
  if (o.lastError) {
    db.run("UPDATE publication_requests SET last_error = ? WHERE id = ?", [o.lastError, requestId]);
  }
  const row = requestRow(requestId);
  const claimedAt = row.approval_dispatched_at ?? "2026-01-01 00:00:00";
  const token = await signApprovalDispatchToken(
    { datasetId, requestId, clickerId: adminId, claimedAt },
    SECRET,
  );
  return { requestId, datasetId, clickerId: adminId, claimedAt, token };
}

function release(
  token: string | null,
  body: unknown,
  bindings: Bindings = env(),
  headers: Record<string, string> = {},
): Promise<Response> {
  const h: Record<string, string> = { "Content-Type": "application/json", ...headers };
  if (token !== null) h[APPROVAL_DISPATCH_TOKEN_HEADER] = token;
  return app.request(
    "/webhooks/approval-release",
    {
      method: "POST",
      headers: h,
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    bindings,
  );
}

const bodyOf = (s: Seeded, extra: Record<string, unknown> = {}) => ({
  dataset_id: s.datasetId,
  request_id: s.requestId,
  ...extra,
});

/** The click the website makes, with the admin's API key. */
function click(dataset = DATASET): Promise<Response> {
  return app.request(
    `/admin/publish/${dataset}/approve-dispatch`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "X-CLI-Version": "99.0.0" },
    },
    env(),
  );
}

async function inFlight(id: number): Promise<boolean> {
  const res = await app.request(
    "/admin/publish/requests",
    { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
    env(),
  );
  const body = (await res.json()) as {
    requests: { id: number; approval_in_flight: boolean }[];
  };
  const listed = body.requests.find((r) => r.id === id);
  if (!listed) throw new Error(`request ${id} is not in the list`);
  return listed.approval_in_flight;
}

/** Everything printed while `run` runs, joined, and silenced: for the "never logged" checks. */
async function printedDuring(run: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
  };
  const grab = (...a: unknown[]) => {
    lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  };
  console.log = grab;
  console.warn = grab;
  console.error = grab;
  console.info = grab;
  try {
    await run();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    console.info = original.info;
  }
  return lines.join("\n");
}

describe("a valid token releases the claim", () => {
  for (const status of ["requested", "approving"] as const) {
    test(`on a ${status} request: the fixed sentence is recorded, the claim is cleared, nothing else moves`, async () => {
      const s = await seedClaim({ status, updatedAgo: "-2 minutes" });
      const before = requestRow(s.requestId);
      expect(before.approval_dispatched_at).not.toBeNull();
      expect(before.last_error).toBeNull();

      const res = await release(s.token, bodyOf(s));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, released: true });

      const after = requestRow(s.requestId);
      expect(after.last_error).toBe(GENERIC);
      expect(after.approval_requested_by).toBeNull();
      expect(after.approval_dispatched_at).toBeNull();
      // The grace reads `updated_at`, so the release must not refresh it; and the request is
      // still the request it was.
      expect(after.updated_at).toBe(before.updated_at);
      expect(after.status).toBe(status);
      // Every other column is untouched: the claim's two and `last_error` are the whole write.
      expect(withoutReleaseColumns(after)).toEqual(withoutReleaseColumns(before));
    });
  }

  test("writes one audit row with no user, the request and the reason, and no token", async () => {
    const s = await seedClaim();
    expect((await release(s.token, bodyOf(s, { reason: "secret_missing" }))).status).toBe(200);

    const rows = releasedAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBeNull();
    expect(rows[0].resource_type).toBe("dataset");
    expect(rows[0].resource_id).toBe(s.datasetId);
    expect(JSON.parse(rows[0].details)).toEqual({
      request_id: s.requestId,
      reason: "secret_missing",
    });
    const everyAuditRow = JSON.stringify(db.query("SELECT * FROM audit_log").all());
    expect(everyAuditRow).not.toContain(s.token);
    expect(everyAuditRow).not.toMatch(/[0-9a-f]{64}/i);
  });

  test("a failed audit write is logged with its cause, and the release still answers 200", async () => {
    const s = await seedClaim({ status: "approving", updatedAgo: "-2 minutes" });
    const bindings = env({
      DB: interceptingD1(realD1(db), (sql) => {
        if (sql === AUDIT_LOG_INSERT_SQL) throw new Error("audit store unavailable");
      }),
    });
    let res: Response | undefined;
    const printed = await printedDuring(async () => {
      res = await release(s.token, bodyOf(s), bindings);
    });

    // The release was one conditional write and it landed; a missing audit row does not undo it.
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ ok: true, released: true });
    const after = requestRow(s.requestId);
    expect(after.approval_requested_by).toBeNull();
    expect(after.approval_dispatched_at).toBeNull();
    expect(after.last_error).toBe(GENERIC);
    expect(releasedAudit()).toHaveLength(0);
    // The log names the request and carries the cause, and the token is nowhere in it.
    expect(printed).toContain(`request ${s.requestId} (${s.datasetId})`);
    expect(printed).toContain("audit store unavailable");
    expect(printed).not.toContain(s.token);
  });

  // The route reads the claim's own columns and never the lease: a run reports its own failure
  // late (a cancelled workflow is reported when GitHub says so), and a lapsed claim is exactly
  // one that nothing else will clear (ADR 0105 decision 9).
  for (const status of ["requested", "approving"] as const) {
    test(`a claim 30 minutes old, past the lease, on a request that is ${status} is released all the same`, async () => {
      const s = await seedClaim({
        status,
        dispatchedAgo: "-30 minutes",
        updatedAgo: "-30 minutes",
      });
      const res = await release(s.token, bodyOf(s, { reason: "workflow_cancelled" }));
      expect(res.status).toBe(200);
      const after = requestRow(s.requestId);
      expect(after.approval_requested_by).toBeNull();
      expect(after.approval_dispatched_at).toBeNull();
      expect(after.last_error).toBe(APPROVAL_RELEASE_REASON_TEXT.workflow_cancelled);
      expect(releasedAudit()).toHaveLength(1);
    });
  }

  test("the token is spent by the release: a second call with it is the 401, and writes nothing more", async () => {
    const s = await seedClaim();
    expect((await release(s.token, bodyOf(s))).status).toBe(200);
    const once = requestRow(s.requestId);

    const again = await release(s.token, bodyOf(s));
    expect(again.status).toBe(401);
    expect(releasedAudit()).toHaveLength(1);
    expect(requestRow(s.requestId)).toEqual(once);
  });

  test("a run still reads as in flight before the release, and a stalled one after it, so a new click dispatches", async () => {
    // A run that began and then went quiet two minutes ago: past the failed-run grace, inside the
    // lease. Dispatched three minutes ago.
    const s = await seedClaim({ status: "approving", updatedAgo: "-2 minutes" });
    expect(await inFlight(s.requestId)).toBe(true);
    const refused = await click();
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe("already_in_flight");
    expect(dispatches).toHaveLength(0);

    expect((await release(s.token, bodyOf(s))).status).toBe(200);

    // The row now carries a failure older than the grace and no claim: nothing is running.
    expect(await inFlight(s.requestId)).toBe(false);
    const again = await click();
    expect(again.status).toBe(202);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].client_payload.resume).toBe(true);
    expect(dispatches[0].client_payload.request_id).toBe(s.requestId);
  });
});

describe("a refusal is always the same 401 and changes nothing", () => {
  type Case = {
    name: string;
    /** Builds the call from a seeded, valid claim; the request may be altered first. */
    make: (s: Seeded) => Promise<{ token: string | null; body: unknown }>;
    seed?: SeedClaim;
  };

  const cases: Case[] = [
    {
      name: "no token header",
      make: async (s) => ({ token: null, body: bodyOf(s) }),
    },
    {
      name: "an empty token header",
      make: async (s) => ({ token: "", body: bodyOf(s) }),
    },
    {
      name: "a blank token header",
      make: async (s) => ({ token: "   ", body: bodyOf(s) }),
    },
    {
      name: "a token with its last hex character changed",
      make: async (s) => {
        const last = s.token.at(-1) === "0" ? "1" : "0";
        return { token: s.token.slice(0, -1) + last, body: bodyOf(s) };
      },
    },
    {
      name: "a token with its first hex character changed",
      make: async (s) => {
        const first = s.token[0] === "0" ? "1" : "0";
        return { token: first + s.token.slice(1), body: bodyOf(s) };
      },
    },
    {
      name: "a token that is not hex at all",
      make: async (s) => ({ token: "not-a-token", body: bodyOf(s) }),
    },
    {
      name: "a token minted for another request id",
      make: async (s) => ({
        token: await signApprovalDispatchToken(
          {
            datasetId: s.datasetId,
            requestId: s.requestId + 1,
            clickerId: s.clickerId,
            claimedAt: s.claimedAt,
          },
          SECRET,
        ),
        body: bodyOf(s),
      }),
    },
    {
      name: "a token minted for another dataset",
      make: async (s) => ({
        token: await signApprovalDispatchToken(
          {
            datasetId: "nm098779",
            requestId: s.requestId,
            clickerId: s.clickerId,
            claimedAt: s.claimedAt,
          },
          SECRET,
        ),
        body: bodyOf(s),
      }),
    },
    {
      name: "a token minted for another clicker",
      make: async (s) => ({
        token: await signApprovalDispatchToken(
          {
            datasetId: s.datasetId,
            requestId: s.requestId,
            clickerId: s.clickerId + 1,
            claimedAt: s.claimedAt,
          },
          SECRET,
        ),
        body: bodyOf(s),
      }),
    },
    {
      name: "a token of an earlier claim of the same request",
      make: async (s) => ({
        token: await signApprovalDispatchToken(
          {
            datasetId: s.datasetId,
            requestId: s.requestId,
            clickerId: s.clickerId,
            claimedAt: "2026-01-01 00:00:00",
          },
          SECRET,
        ),
        body: bodyOf(s),
      }),
    },
    {
      name: "a token signed with another secret",
      make: async (s) => ({
        token: await signApprovalDispatchToken(
          {
            datasetId: s.datasetId,
            requestId: s.requestId,
            clickerId: s.clickerId,
            claimedAt: s.claimedAt,
          },
          "another-secret",
        ),
        body: bodyOf(s),
      }),
    },
    {
      name: "a valid token with a body dataset_id that differs from the row",
      make: async (s) => ({
        token: s.token,
        body: { dataset_id: "nm098778", request_id: s.requestId },
      }),
    },
    {
      name: "a valid token with a request id that does not exist",
      make: async (s) => ({
        token: s.token,
        body: { dataset_id: s.datasetId, request_id: s.requestId + 500 },
      }),
    },
    {
      name: "a valid token on a published request",
      seed: { status: "published" },
      make: async (s) => ({ token: s.token, body: bodyOf(s) }),
    },
    {
      name: "a valid token on a denied request",
      seed: { status: "denied" },
      make: async (s) => ({ token: s.token, body: bodyOf(s) }),
    },
    {
      name: "a valid token on a blocked request",
      seed: { status: "blocked" },
      make: async (s) => ({ token: s.token, body: bodyOf(s) }),
    },
    {
      name: "a token of a claim that was already released",
      seed: { unclaimed: true },
      make: async (s) => ({ token: s.token, body: bodyOf(s) }),
    },
  ];

  /** The answer for a request that does not exist at all: the one every refusal must equal. */
  async function unknownRequestAnswer(): Promise<{ status: number; text: string }> {
    const res = await release("0".repeat(64), { dataset_id: "nm098799", request_id: 999999 });
    return { status: res.status, text: await res.text() };
  }

  for (const c of cases) {
    test(`${c.name}: 401, the same bytes as an unknown request, and nothing is written`, async () => {
      const s = await seedClaim(c.seed);
      const before = JSON.stringify(db.query("SELECT * FROM publication_requests").all());
      const auditBefore = JSON.stringify(db.query("SELECT * FROM audit_log").all());
      const { token, body } = await c.make(s);

      const res = await release(token, body);
      const text = await res.text();
      const unknown = await unknownRequestAnswer();

      expect(res.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(text).toBe(unknown.text);
      expect(JSON.stringify(db.query("SELECT * FROM publication_requests").all())).toBe(before);
      expect(JSON.stringify(db.query("SELECT * FROM audit_log").all())).toBe(auditBefore);
      expect(releasedAudit()).toHaveLength(0);
    });
  }

  test("a wrong token on a real claim and a real token on no claim answer with the very same bytes", async () => {
    const live = await seedClaim({ datasetId: "nm098771" });
    const idle = await seedClaim({ datasetId: "nm098772", unclaimed: true });
    const wrong = await release("f".repeat(64), bodyOf(live));
    const none = await release(idle.token, bodyOf(idle));
    expect(wrong.status).toBe(none.status);
    expect(await wrong.text()).toBe(await none.text());
    // The wrong call did not release the live claim.
    expect(requestRow(live.requestId).approval_dispatched_at).not.toBeNull();
  });

  test("losing a race for the claim is the same 401, and clears nothing of the claim that won", async () => {
    const s = await seedClaim();
    // Between the release's read and its write, a fresh click replaces the claim.
    let raced = false;
    const bindings = env({
      DB: interceptingD1(realD1(db), (sql) => {
        if (sql === APPROVAL_RELEASE_SQL && !raced) {
          raced = true;
          db.run(
            "UPDATE publication_requests SET approval_dispatched_at = datetime('now', '-1 minutes') WHERE id = ?",
            [s.requestId],
          );
        }
      }),
    });
    const before = requestRow(s.requestId);
    const res = await release(s.token, bodyOf(s), bindings);
    expect(raced).toBe(true);
    expect(res.status).toBe(401);
    const after = requestRow(s.requestId);
    expect(after.approval_requested_by).toBe(adminId);
    expect(after.approval_dispatched_at).not.toBeNull();
    expect(after.approval_dispatched_at).not.toBe(before.approval_dispatched_at);
    expect(after.last_error).toBeNull();
    expect(releasedAudit()).toHaveLength(0);
  });

  test("a claim re-made at the same instant by another administrator is not released by the first one's token", async () => {
    const s = await seedClaim();
    const otherId = await seedUser(
      db,
      "releaseadmin2",
      "admin",
      "release-admin2-key-0123456789abcdef0123456789",
    );
    let raced = false;
    const bindings = env({
      DB: interceptingD1(realD1(db), (sql) => {
        if (sql === APPROVAL_RELEASE_SQL && !raced) {
          raced = true;
          // Same `approval_dispatched_at`, another clicker: only the clicker column differs.
          db.run("UPDATE publication_requests SET approval_requested_by = ? WHERE id = ?", [
            otherId,
            s.requestId,
          ]);
        }
      }),
    });
    const res = await release(s.token, bodyOf(s), bindings);
    expect(raced).toBe(true);
    expect(res.status).toBe(401);
    const after = requestRow(s.requestId);
    expect(after.approval_requested_by).toBe(otherId);
    expect(after.approval_dispatched_at).toBe(s.claimedAt);
    expect(after.last_error).toBeNull();
    expect(releasedAudit()).toHaveLength(0);
  });

  test("a request that is published between the read and the write is not released either", async () => {
    const s = await seedClaim({ status: "approving", updatedAgo: "-2 minutes" });
    const bindings = env({
      DB: interceptingD1(realD1(db), (sql) => {
        if (sql === APPROVAL_RELEASE_SQL) {
          db.run("UPDATE publication_requests SET status = 'published' WHERE id = ?", [
            s.requestId,
          ]);
        }
      }),
    });
    const res = await release(s.token, bodyOf(s), bindings);
    expect(res.status).toBe(401);
    const after = requestRow(s.requestId);
    expect(after.status).toBe("published");
    expect(after.last_error).toBeNull();
    expect(after.approval_dispatched_at).not.toBeNull();
    expect(releasedAudit()).toHaveLength(0);
  });
});

describe("last_error and the reason", () => {
  test("a specific failure already on the row is kept, and the claim is still released", async () => {
    const s = await seedClaim({
      status: "approving",
      updatedAgo: "-2 minutes",
      lastError: "EZID 503 while publishing the DOI",
    });
    const res = await release(s.token, bodyOf(s, { reason: "workflow_cancelled" }));
    expect(res.status).toBe(200);
    const after = requestRow(s.requestId);
    expect(after.last_error).toBe("EZID 503 while publishing the DOI");
    expect(after.approval_requested_by).toBeNull();
    expect(after.approval_dispatched_at).toBeNull();
    // It is still an audited release, with the reason the executor gave.
    expect(JSON.parse(releasedAudit()[0].details).reason).toBe("workflow_cancelled");
  });

  for (const reason of APPROVAL_RELEASE_REASONS) {
    test(`the reason ${reason} records its own fixed sentence`, async () => {
      const s = await seedClaim();
      expect((await release(s.token, bodyOf(s, { reason }))).status).toBe(200);
      expect(requestRow(s.requestId).last_error).toBe(APPROVAL_RELEASE_REASON_TEXT[reason]);
      expect(JSON.parse(releasedAudit()[0].details).reason).toBe(reason);
    });
  }

  const unknown: [string, unknown][] = [
    ["a word outside the vocabulary", "disk_on_fire"],
    ["a sentence the executor wrote", "Run 4711 died: SMITH-LEAK-SENTINEL token=abc"],
    ["a number", 7],
    ["null", null],
    ["an object", { reason: "secret_missing" }],
    ["an empty string", ""],
  ];
  for (const [name, reason] of unknown) {
    test(`${name} as the reason is stored as workflow_failed, and its text reaches nothing`, async () => {
      const s = await seedClaim();
      expect((await release(s.token, bodyOf(s, { reason }))).status).toBe(200);
      expect(requestRow(s.requestId).last_error).toBe(GENERIC);
      const audit = releasedAudit();
      expect(JSON.parse(audit[0].details)).toEqual({
        request_id: s.requestId,
        reason: "workflow_failed",
      });
      expect(JSON.stringify(db.query("SELECT * FROM publication_requests").all())).not.toContain(
        "SMITH-LEAK-SENTINEL",
      );
      expect(audit[0].details).not.toContain("SMITH-LEAK-SENTINEL");
    });
  }

  test("a missing reason is workflow_failed", async () => {
    const s = await seedClaim();
    expect((await release(s.token, bodyOf(s))).status).toBe(200);
    expect(requestRow(s.requestId).last_error).toBe(GENERIC);
  });
});

describe("the body is bounded and shaped before the database is read", () => {
  /** An environment whose database records every statement it is asked to run. */
  function recording(): { bindings: Bindings; statements: string[] } {
    const statements: string[] = [];
    return {
      statements,
      bindings: env({ DB: interceptingD1(realD1(db), (sql) => void statements.push(sql)) }),
    };
  }

  /** A release body of exactly `bytes` bytes: the real fields, padded with one extra field. */
  function bodyOfSize(s: Seeded, bytes: number): string {
    const bare = JSON.stringify({ ...bodyOf(s), pad: "" });
    const raw = JSON.stringify({ ...bodyOf(s), pad: "x".repeat(bytes - bare.length) });
    expect(new TextEncoder().encode(raw).length).toBe(bytes);
    return raw;
  }

  test("a body over 1 KiB is refused by its real length, and by a declared length that lies low", async () => {
    // The body is three scalars, so the bound is 1 KiB and not the 256 KiB a screen report needs.
    const s = await seedClaim();
    const over = bodyOfSize(s, 1025);
    const a = recording();
    expect((await release(s.token, over, a.bindings)).status).toBe(413);
    const b = recording();
    const lying = await release(s.token, over, b.bindings, { "Content-Length": "100" });
    expect(lying.status).toBe(413);
    expect(a.statements).toEqual([]);
    expect(b.statements).toEqual([]);
    expect(requestRow(s.requestId).approval_dispatched_at).not.toBeNull();
  });

  test("a body of exactly 1 KiB, and an ordinary one, are read", async () => {
    const edge = await seedClaim({ datasetId: "nm098776" });
    expect((await release(edge.token, bodyOfSize(edge, 1024))).status).toBe(200);
    expect(requestRow(edge.requestId).approval_dispatched_at).toBeNull();
    const plain = await seedClaim({ datasetId: "nm098777" });
    expect((await release(plain.token, bodyOf(plain, { reason: "secret_missing" }))).status).toBe(
      200,
    );
    expect(requestRow(plain.requestId).approval_dispatched_at).toBeNull();
  });

  const bad: [string, string][] = [
    ["JSON that does not parse", "{not json"],
    ["an empty body", ""],
    ["an array", "[1,2]"],
    ["a bare string", '"nm098770"'],
  ];
  for (const [name, raw] of bad) {
    test(`${name} is a 400, with no statement run`, async () => {
      const s = await seedClaim();
      const r = recording();
      const res = await release(s.token, raw, r.bindings);
      expect(res.status).toBe(400);
      expect(r.statements).toEqual([]);
      expect(requestRow(s.requestId).approval_dispatched_at).not.toBeNull();
    });
  }

  const shapes: [string, Record<string, unknown>][] = [
    ["no dataset_id", { request_id: 1 }],
    ["a dataset_id that is not a dataset id", { dataset_id: "../etc", request_id: 1 }],
    ["a numeric dataset_id", { dataset_id: 98770, request_id: 1 }],
    ["no request_id", { dataset_id: DATASET }],
    ["a request_id of zero", { dataset_id: DATASET, request_id: 0 }],
    ["a fractional request_id", { dataset_id: DATASET, request_id: 1.5 }],
    ["a string request_id", { dataset_id: DATASET, request_id: "1" }],
    ["a request_id beyond a safe integer", { dataset_id: DATASET, request_id: 2 ** 60 }],
  ];
  for (const [name, body] of shapes) {
    test(`${name} is a 400, with no statement run`, async () => {
      const s = await seedClaim();
      const r = recording();
      const res = await release(s.token, body, r.bindings);
      expect(res.status).toBe(400);
      expect(r.statements).toEqual([]);
    });
  }

  test("a missing token is refused before the body is even read", async () => {
    const r = recording();
    const res = await release(null, "{not json", r.bindings);
    expect(res.status).toBe(401);
    expect(r.statements).toEqual([]);
  });
});

describe("with no callback secret on the Worker", () => {
  for (const [name, secret] of [
    ["unset", undefined],
    ["empty", ""],
  ] as const) {
    test(`a secret that is ${name} is a 500, and nothing changes`, async () => {
      const s = await seedClaim({ status: "approving", updatedAgo: "-2 minutes" });
      const before = JSON.stringify(db.query("SELECT * FROM publication_requests").all());
      const res = await release(
        s.token,
        bodyOf(s),
        env({ PRESCREEN_CALLBACK_SECRET: secret as string | undefined }),
      );
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain(s.token);
      expect(JSON.stringify(db.query("SELECT * FROM publication_requests").all())).toBe(before);
      expect(releasedAudit()).toHaveLength(0);
    });
  }
});

describe("the token never leaves", () => {
  test("it is in no log line, no answer and no stored row, on success and on refusal", async () => {
    const live = await seedClaim({ datasetId: "nm098773" });
    const stale = await seedClaim({ datasetId: "nm098774", status: "published" });
    const other = await seedClaim({ datasetId: "nm098775" });
    // A token one character off a live claim's: presented, refused, and not echoed anywhere.
    const nearMiss = other.token.slice(0, -1) + (other.token.endsWith("0") ? "1" : "0");
    const answers: string[] = [];
    const printed = await printedDuring(async () => {
      answers.push(await (await release(nearMiss, bodyOf(other))).text());
      answers.push(await (await release(live.token, bodyOf(live))).text());
      answers.push(await (await release(stale.token, bodyOf(stale))).text());
      answers.push(await (await release(live.token, bodyOf(live))).text());
      answers.push(
        await (
          await release(live.token, bodyOf(live), env({ PRESCREEN_CALLBACK_SECRET: undefined }))
        ).text(),
      );
    });
    for (const t of [live.token, stale.token, other.token, nearMiss]) {
      expect(printed).not.toContain(t);
      for (const a of answers) expect(a).not.toContain(t);
      expect(JSON.stringify(db.query("SELECT * FROM publication_requests").all())).not.toContain(t);
      expect(JSON.stringify(db.query("SELECT * FROM audit_log").all())).not.toContain(t);
    }
    expect(printed).not.toMatch(/[0-9a-f]{64}/i);
    // Control: the checks above looked at real output (the release did log and answer).
    expect(printed.length).toBeGreaterThan(0);
    expect(answers[1]).toContain("released");
  });
});
