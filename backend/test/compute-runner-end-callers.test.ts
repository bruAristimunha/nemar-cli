/**
 * Ending an owner ends the runners they registered (portable compute, card DM-05, decision D5;
 * AGENTS.md, "Revocation cascades, always"). Two halves, both over real code:
 *
 * THE LIST HELD TO THE CODE. `RUNNER_END_CALLERS` (`services/compute-runners.ts`) documents the functions
 * that run `runnerEndStatements`: THREE, `finalizeRevocation`, `tombstoneUserCascade` and the role
 * demotion handler. The syntax-tree scan of `helpers/compute-end-scan.ts` (the one that holds
 * `COMPUTE_END_CALLERS`, pointed at this module) checks the list in both directions and every way of
 * reaching the function, fails on a function that revokes all of an account's keys and sessions and neither
 * runs the set nor is named in `RUNNER_END_EXCEPTIONS`, refuses loudly what it cannot follow, and is shown
 * to FIRE on planted files. The docblock of each SQL constant spells the count it lists, and the deliberate
 * non-paths (a key revocation, a sign-out) keep the sentence that says they are deliberate.
 *
 * THE BEHAVIOUR THROUGH THE REAL ROUTES. The admin revoke (by username and by id), the owner's soft delete
 * and a role demotion each end an owner's registrations in the SAME batch as their own credential
 * revocations: tokens deleted (a token stops working at once), an unstarted claim released, a started job
 * `unreported` with no lease, the registration revoked with the reason of the path; another owner's runner
 * and every job that ended are untouched. A key revocation leaves the registrations. The guarded call of
 * the scheduled sweep (`onlyIfEmail`) changes nothing under a false guard, statement by statement.
 * MUTATIONS, each run alone: remove the statements from each caller (the scan names the function and the
 * route test fails); move the registration's own revoke before the owner-keyed statements; drop the
 * `revoked_at IS NULL` or the owner term of a statement; drop a statement.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { RUNNER_PROTOCOL } from "../../shared/contract/compute-runner";
import { MASK_APPLIED_SQL, tombstoneUserCascade } from "../src/db/user-tombstone";
import { adminRoutes } from "../src/routes/admin";
import { computeRunnerRoutes } from "../src/routes/compute-runners";
import {
  RUNNER_END_CALLERS,
  RUNNER_END_EXCEPTIONS,
  RUNNER_REVOKE_REASONS,
  RunnerOwnerNotStanding,
  findRunnerBySecret,
  hashRunnerCredential,
  registerRunner,
  runnerEndStatements,
  runnerRevokeStatements,
} from "../src/services/compute-runners";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { type ScanTarget, analyse } from "./helpers/compute-end-scan";
import { freshDb, realD1 } from "./helpers/d1";
import { SRC, createTree } from "./helpers/ts-scan";

/** A row or a JSON body read back by a test, whose fields the assertions name. */
// biome-ignore lint/suspicious/noExplicitAny: test rows and bodies are read field by field
type Loose = Record<string, any>;

const TARGET: ScanTarget = { module: "compute-runners", fn: "runnerEndStatements" };
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const real = analyse(createTree(), TARGET);

describe("the list is held to the code", () => {
  test("the scan sees what it is meant to see (it is not vacuous)", () => {
    expect(real.ends).toEqual(
      expect.arrayContaining([
        "db/user-tombstone.ts#tombstoneUserCascade",
        "routes/admin/users.ts#finalizeRevocation",
        "routes/admin/users.ts#POST /users/:username/role",
        "routes/auth.ts#GET /confirm-key-regeneration",
      ]),
    );
    expect(real.users.length).toBe(3);
  });

  test("the functions that run the set are exactly RUNNER_END_CALLERS, and there are three", () => {
    expect(real.users).toEqual([...RUNNER_END_CALLERS].sort());
    expect(RUNNER_END_CALLERS).toHaveLength(3);
  });

  test("every function that ends every credential runs the set, or is a deliberate exception with a reason", () => {
    expect(real.unsatisfied.filter((key) => !(key in RUNNER_END_EXCEPTIONS))).toEqual([]);
    for (const [key, reason] of Object.entries(RUNNER_END_EXCEPTIONS)) {
      expect([key, real.ends.includes(key)]).toEqual([key, true]);
      expect([key, reason.length >= 40]).toEqual([key, true]);
      expect(RUNNER_END_CALLERS as readonly string[]).not.toContain(key);
    }
  });

  test("nothing in the tree is a use the scan cannot follow", () => {
    expect(real.unfollowable).toEqual([]);
  });

  test("the docblock of every constant spells the number of callers it lists", () => {
    const source = read("services/compute-runners.ts");
    const WORDS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4 };
    const spelled = (constant: string): number | null => {
      const at = source.indexOf(`export const ${constant}`);
      expect(at).toBeGreaterThan(0);
      const close = source.lastIndexOf("*/", at);
      const open = source.lastIndexOf("/**", close);
      const m = /\b(ONE|TWO|THREE|FOUR) CALLERS?\b/.exec(source.slice(open, close));
      return m ? (WORDS[m[1] as string] as number) : null;
    };
    for (const c of [
      "RUNNER_END_TOKENS_SQL",
      "RUNNER_END_RELEASE_SQL",
      "RUNNER_END_UNREPORT_SQL",
      "RUNNER_END_SQL",
    ]) {
      expect([c, spelled(c)]).toEqual([c, RUNNER_END_CALLERS.length]);
    }
    for (const c of [
      "RUNNER_REVOKE_TOKENS_SQL",
      "RUNNER_REVOKE_RELEASE_SQL",
      "RUNNER_REVOKE_UNREPORT_SQL",
      "RUNNER_REVOKE_SQL",
    ]) {
      expect([c, spelled(c)]).toEqual([c, 1]);
    }
    expect(source).toMatch(/THREE CALLERS of \{@link runnerEndStatements\}/);
  });

  test("the deliberate non-paths keep their sentence: a key revocation and a sign-out are not callers", () => {
    const source = read("services/compute-runners.ts");
    expect(source).toContain("DELIBERATELY NOT CALLED");
    expect(source).toMatch(/an API key revocation/);
    expect(source).toMatch(/a sign-out/);
    for (const file of [
      "routes/admin/user-keys.ts",
      "routes/auth-keys.ts",
      "services/docs-auth.ts",
      "routes/auth-web.ts",
    ]) {
      expect(RUNNER_END_CALLERS.some((c) => c.startsWith(file))).toBe(false);
    }
  });

  test("each caller really runs the set, so removing it fails the scan (MUTATION per caller)", () => {
    const cases: Array<[string, string, string]> = [
      [
        "routes/admin/users.ts",
        '...runnerEndStatements(user.id, "account_revoked").map((s) =>\n      db.prepare(s.sql).bind(...s.binds),\n    ),',
        "routes/admin/users.ts#finalizeRevocation",
      ],
      [
        "routes/admin/users.ts",
        '...runnerEndStatements(target.id, "role_demoted").map((s) =>\n              db.prepare(s.sql).bind(...s.binds),\n            ),',
        "routes/admin/users.ts#POST /users/:username/role",
      ],
      [
        "db/user-tombstone.ts",
        '...runnerEndStatements(id, "account_deleted").map((s) => step(s.sql, ...s.binds)),',
        "db/user-tombstone.ts#tombstoneUserCascade",
      ],
    ];
    for (const [file, line, key] of cases) {
      const text = read(file);
      expect([file, text.includes(line)]).toEqual([file, true]);
      const found = analyse(createTree({ [file]: text.replace(line, "") }), TARGET);
      expect([key, found.users.includes(key)]).toEqual([key, false]);
      expect([key, found.unsatisfied.includes(key)]).toEqual([key, true]);
    }
  }, 60_000);

  const TOKENS = `"UPDATE tokens SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL"`;
  const SESSIONS = `"UPDATE web_sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL"`;

  test("a new function that ends every credential and forgot the runners is named; one that runs them is satisfied", () => {
    const planted = analyse(
      createTree({
        "routes/admin/planted-forgot.ts": `
          export async function mergeAccounts(db: D1Database, id: number) {
            await db.batch([db.prepare(${TOKENS}).bind(id), db.prepare(${SESSIONS}).bind(id)]);
          }`,
        "routes/admin/planted-ok.ts": `
          import { runnerEndStatements as ending } from "../../services/compute-runners";
          export async function suspendAccount(db: D1Database, id: number) {
            await db.batch([db.prepare(${TOKENS}).bind(id), db.prepare(${SESSIONS}).bind(id),
              ...ending(id, "account_revoked").map((s) => db.prepare(s.sql).bind(...s.binds))]);
          }`,
      }),
      TARGET,
    );
    expect(planted.unsatisfied).toContain("routes/admin/planted-forgot.ts#mergeAccounts");
    expect(planted.unsatisfied).not.toContain("routes/admin/planted-ok.ts#suspendAccount");
    expect(planted.users).toContain("routes/admin/planted-ok.ts#suspendAccount");
  }, 60_000);

  test("every way of reaching the set is seen as a use, and what the scan cannot follow is refused", () => {
    const uses: Record<string, string> = {
      named: `import { runnerEndStatements } from "../services/compute-runners";
        export function a(id: number) { return runnerEndStatements(id, "account_revoked"); }`,
      aliased: `import { runnerEndStatements as x } from "../services/compute-runners.js";
        export function a(id: number) { return x(id, "account_revoked"); }`,
      namespace: `import * as r from "../services/compute-runners";
        export function a(id: number) { return r.runnerEndStatements(id, "account_revoked"); }`,
      "local alias": `import { runnerEndStatements } from "../services/compute-runners";
        const run = runnerEndStatements;
        export function a(id: number) { return run(id, "account_revoked"); }`,
      "as a value": `import { runnerEndStatements } from "../services/compute-runners";
        export function a(ids: number[]) { return ids.map(runnerEndStatements); }`,
    };
    const overlay = Object.fromEntries(
      Object.entries(uses).map(([name, body]) => [
        `routes/planted-use-${name.replace(/\W+/g, "-")}.ts`,
        body,
      ]),
    );
    const found = analyse(createTree(overlay), TARGET);
    for (const name of Object.keys(uses)) {
      const key = `routes/planted-use-${name.replace(/\W+/g, "-")}.ts#a`;
      expect([name, found.users.includes(key)]).toEqual([name, true]);
    }
    const unfollowable = analyse(
      createTree({
        "routes/planted-dynamic.ts": `export async function a(id: number) {
          const m = await import("../services/compute-runners.js");
          return m.runnerEndStatements(id, "account_revoked"); }`,
        "routes/planted-reexport.ts": `export { runnerEndStatements } from "../services/compute-runners";`,
        "routes/planted-top.ts": `import { runnerEndStatements } from "../services/compute-runners";
          export const later = runnerEndStatements;`,
      }),
      TARGET,
    );
    for (const file of ["planted-dynamic.ts", "planted-reexport.ts", "planted-top.ts"]) {
      expect([file, unfollowable.unfollowable.some((m) => m.includes(file))]).toEqual([file, true]);
    }
  }, 60_000);
});

describe("the statements", () => {
  const RUNNER = `rnr_${"a".repeat(24)}`;

  test("every statement ends in a WHERE clause with plain placeholders, one bind each, and the registration is revoked LAST", () => {
    for (const [name, statements] of [
      ["revoke", runnerRevokeStatements(RUNNER, "owner_revoked")],
      ["end", runnerEndStatements(7, "account_revoked")],
    ] as const) {
      expect(statements).toHaveLength(4);
      for (const s of statements) {
        expect(s.sql).not.toMatch(/\?\d/);
        expect([name, (s.sql.match(/\?/g) ?? []).length]).toEqual([name, s.binds.length]);
        expect(s.sql).toMatch(/\bWHERE\b/);
        expect(s.sql.trim()).not.toMatch(/;$/);
      }
      const order = statements.map((s) => /^\s*(DELETE FROM \w+|UPDATE \w+)/.exec(s.sql)?.[1]);
      expect(order).toEqual([
        "DELETE FROM compute_runner_tokens",
        "UPDATE compute_jobs",
        "UPDATE compute_jobs",
        "UPDATE compute_runners",
      ]);
    }
  });

  test("a bad id, owner or reason is a RangeError before anything is built", () => {
    expect(() => runnerRevokeStatements("rnr_x", "owner_revoked")).toThrow(RangeError);
    expect(() => runnerRevokeStatements(RUNNER, "other" as never)).toThrow(RangeError);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => runnerEndStatements(bad, "account_revoked")).toThrow(RangeError);
    }
    expect(() => runnerEndStatements(1, "nope" as never)).toThrow(RangeError);
    for (const reason of RUNNER_REVOKE_REASONS) {
      expect(() => runnerEndStatements(1, reason)).not.toThrow();
    }
  });
});

// --- The behaviour through the real routes -------------------------------------------------------

const KEYS = {
  actor: "runner-actor-key-0123456789abcdef0123456789abcdef0",
  target: "runner-target-key-0123456789abcdef0123456789abcdef",
  bystander: "runner-bystand-key-0123456789abcdef0123456789abcdef",
} as const;
type Who = keyof typeof KEYS;

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
app.route("/admin", adminRoutes);
app.route("/compute/runners", computeRunnerRoutes);

let db: Database;
let userIds: Record<Who, number>;
let d1: D1Database;
/** When set, the Worker's database for one request: `d1` with something injected after its first batch. */
let dbOverride: D1Database | null = null;

/**
 * The runner routes need the switches on, which needs `production` or `development`; the revoke, delete and
 * demotion routes would then try to mail the person, so they are called under `ENVIRONMENT: "test"` with no
 * mail key (IAM, GitHub and mail all no-op, as in `admin-credential-cascade.test.ts`). The database is the
 * same one either way.
 */
const env = (quiet: boolean): Bindings =>
  ({
    DB: dbOverride ?? d1,
    ENVIRONMENT: quiet ? "test" : "production",
    COMPUTE_ENABLED: "1",
    COMPUTE_RUNNERS_ENABLED: "1",
    RESEND_API_KEY: "",
    WEB_SESSION_COOKIE_DOMAIN: "",
  }) as unknown as Bindings;

/** The paths whose handlers may mail a person: the account-ending and role routes. */
const mails = (path: string) => path.startsWith("/admin/revoke") || path.startsWith("/admin/users");

async function seedUsers(): Promise<void> {
  const roles: Record<Who, string> = { actor: "owner", target: "owner", bystander: "owner" };
  for (const who of Object.keys(KEYS) as Who[]) {
    db.run(
      `INSERT INTO users (username, email, password_hash, github_username, status, role, email_verified, account_kind)
       VALUES (?, ?, 'x', ?, 'approved', ?, 1, 'person')`,
      [`rn-${who}`, `rn-${who}@nemar.test`, `rn-${who}-gh`, roles[who]],
    );
    const id = (
      db.query("SELECT id FROM users WHERE username = ?").get(`rn-${who}`) as { id: number }
    ).id;
    userIds = { ...userIds, [who]: id };
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      id,
      await hashApiKey(KEYS[who]),
      KEYS[who].slice(0, 8),
    );
  }
}

beforeEach(async () => {
  db = freshDb();
  d1 = realD1(db);
  dbOverride = null;
  userIds = {} as Record<Who, number>;
  await seedUsers();
});

async function api(method: string, path: string, as: Who | null, body?: unknown, bearer?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearer !== undefined) headers.Authorization = `Bearer ${bearer}`;
  else if (as) headers.Authorization = `Bearer ${KEYS[as]}`;
  const res = await app.request(
    path,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
    env(mails(path)),
  );
  const text = await res.text();
  let json: Loose = {};
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body: json };
}

const REGISTRATION = {
  pool: "cpu",
  cores: 8,
  memory_mb: 16_000,
  gpus: 0,
  scratch_gb: 100,
  backend: "local",
  runtimes: ["docker"],
  arch: "amd64",
  accounting: "none",
  site: "lab_a",
  trust: "lab",
};

let jobSeq = 0;
const jobId = () => `job_${(++jobSeq).toString(16).padStart(24, "0")}`;
const lease = () => (++jobSeq).toString(16).padStart(32, "0");

function seedJob(over: Record<string, unknown>): string {
  const row: Record<string, unknown> = {
    id: jobId(),
    source: "pipeline",
    kind: "batch",
    app_id: "nemar-launch",
    app_version: "1.0.0",
    spec_digest: "b".repeat(64),
    partition: "shared",
    pool: "cpu",
    nodes: 1,
    cores_per_node: 4,
    minutes: 60,
    executor: "runner",
    accounting: "none",
    ...over,
  };
  const cols = Object.keys(row);
  db.query(
    `INSERT INTO compute_jobs (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  ).run(...(cols.map((c) => row[c]) as never[]));
  return row.id as string;
}

const job = (id: string) => db.query("SELECT * FROM compute_jobs WHERE id = ?").get(id) as Loose;
const runnerRow = (id: string) =>
  db.query("SELECT * FROM compute_runners WHERE id = ?").get(id) as Loose;

interface World {
  /** What the target registered: two runners, each with a live token and jobs. */
  runners: Array<{ id: string; token: string }>;
  claimed: string[];
  started: string[];
  finished: string;
  bystander: { id: string; token: string; claimed: string; started: string };
}

const claim = (runnerId: string, extra: Record<string, unknown> = {}) =>
  seedJob({
    runner_id: runnerId,
    runner_claimed_at: "2026-11-13 10:00:00",
    lease_id: lease(),
    lease_expires_at: "2026-11-13 10:10:00",
    claim_attempts: 1,
    ...extra,
  });

async function register(who: Who, name: string) {
  const res = await api("POST", "/admin/compute/runners", who, { ...REGISTRATION, name });
  expect(res.status).toBe(201);
  const ex = await api(
    "POST",
    "/compute/runners/token",
    null,
    { protocol: RUNNER_PROTOCOL, runner_version: "0.1.0" },
    res.body.secret,
  );
  expect(ex.status).toBe(200);
  return { id: res.body.runner_id as string, token: ex.body.access_token as string };
}

async function seedWorld(): Promise<World> {
  const a = await register("target", "target_a");
  const b = await register("target", "target_b");
  const by = await register("bystander", "bystander_a");
  return {
    runners: [a, b],
    claimed: [claim(a.id), claim(b.id)],
    started: [
      claim(a.id, { state: "queued", runner_backend: "slurm" }),
      claim(a.id, { state: "running", started_at: "2026-11-13 10:01:00" }),
      claim(b.id, { state: "archiving", started_at: "2026-11-13 10:01:00" }),
    ],
    finished: claim(a.id, {
      state: "finished",
      started_at: "2026-11-13 10:01:00",
      ended_at: "2026-11-13 10:05:00",
    }),
    bystander: {
      id: by.id,
      token: by.token,
      claimed: claim(by.id),
      started: claim(by.id, { state: "running", started_at: "2026-11-13 10:01:00" }),
    },
  };
}

const me = (token: string) => api("GET", "/compute/runners/me", null, undefined, token);

/** Everything the cascade must have done for the target's registrations, and nothing it must not. */
async function expectEnded(
  w: World,
  reason: string,
  bystanderBefore: string,
  finishedBefore: string,
) {
  for (const r of w.runners) {
    const row = runnerRow(r.id);
    expect([r.id, row.revoke_reason]).toEqual([r.id, reason]);
    expect(typeof row.revoked_at).toBe("string");
    // The token stopped at once.
    expect((await me(r.token)).status).toBe(401);
    expect(
      db.query("SELECT COUNT(*) AS n FROM compute_runner_tokens WHERE runner_id = ?").get(r.id),
    ).toEqual({ n: 0 });
  }
  for (const id of w.claimed) {
    expect(job(id)).toMatchObject({
      state: "created",
      runner_id: null,
      runner_claimed_at: null,
      lease_id: null,
      lease_expires_at: null,
    });
  }
  for (const id of w.started) {
    expect(job(id)).toMatchObject({ state: "unreported", lease_id: null, lease_expires_at: null });
    expect(job(id).runner_id).not.toBeNull();
  }
  expect(JSON.stringify(job(w.finished))).toBe(finishedBefore);
  // The bystander owner's runner, token and jobs are as they were.
  expect(runnerRow(w.bystander.id).revoked_at).toBeNull();
  expect((await me(w.bystander.token)).status).toBe(200);
  expect(JSON.stringify([job(w.bystander.claimed), job(w.bystander.started)])).toBe(
    bystanderBefore,
  );
}

const snapshotOf = (w: World) => ({
  bystander: JSON.stringify([job(w.bystander.claimed), job(w.bystander.started)]),
  finished: JSON.stringify(job(w.finished)),
});

describe("the three callers end the owner's runners, through their real routes", () => {
  test("an admin revoke by username (finalizeRevocation)", async () => {
    const w = await seedWorld();
    const before = snapshotOf(w);
    const res = await api("POST", "/admin/revoke/rn-target", "actor");
    expect(res.status).toBe(200);
    await expectEnded(w, "account_revoked", before.bystander, before.finished);
  });

  test("an admin revoke by id (the same function)", async () => {
    const w = await seedWorld();
    const before = snapshotOf(w);
    const res = await api("POST", `/admin/revoke/by-id/${userIds.target}`, "actor");
    expect(res.status).toBe(200);
    await expectEnded(w, "account_revoked", before.bystander, before.finished);
  });

  test("the owner's soft delete (tombstoneUserCascade)", async () => {
    const w = await seedWorld();
    const before = snapshotOf(w);
    const res = await api("DELETE", `/admin/users/by-id/${userIds.target}`, "actor");
    expect(res.status).toBe(200);
    await expectEnded(w, "account_deleted", before.bystander, before.finished);
  });

  test("a role demotion of the owner (the third caller)", async () => {
    const w = await seedWorld();
    const before = snapshotOf(w);
    const res = await api("POST", "/admin/users/rn-target/role", "actor", { role: "admin" });
    expect(res.status).toBe(200);
    await expectEnded(w, "role_demoted", before.bystander, before.finished);
  });

  test("a role change that is a PROMOTION leaves the registrations (only a demotion is a caller's cause)", async () => {
    const w = await seedWorld();
    // Registered while an owner; made an admin by hand, so the route's change to owner is a promotion.
    db.run("UPDATE users SET role = 'admin' WHERE id = ?", [userIds.target]);
    const promoted = await api("POST", "/admin/users/rn-target/role", "actor", { role: "owner" });
    expect(promoted.status).toBe(200);
    for (const r of w.runners) expect(runnerRow(r.id).revoked_at).toBeNull();
    expect((await me(w.runners[0]?.token as string)).status).toBe(200);
  });

  test("revoking an API key leaves the registrations, their tokens and their jobs alone (deliberately not a caller)", async () => {
    const w = await seedWorld();
    db.run(
      "INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, 'extra-key-hash', 'extrakey')",
      [userIds.target],
    );
    const key = db.query("SELECT id FROM tokens WHERE api_key_hash = 'extra-key-hash'").get() as {
      id: number;
    };
    const before = JSON.stringify({
      runners: db.query("SELECT * FROM compute_runners ORDER BY id").all(),
      tokens: db.query("SELECT * FROM compute_runner_tokens ORDER BY token_hash").all(),
      jobs: db.query("SELECT * FROM compute_jobs ORDER BY id").all(),
    });
    const res = await api("DELETE", `/admin/users/rn-target/keys/${key.id}`, "actor");
    expect(res.status).toBe(200);
    expect(
      JSON.stringify({
        runners: db.query("SELECT * FROM compute_runners ORDER BY id").all(),
        tokens: db.query("SELECT * FROM compute_runner_tokens ORDER BY token_hash").all(),
        jobs: db.query("SELECT * FROM compute_jobs ORDER BY id").all(),
      }),
    ).toBe(before);
    expect((await me(w.runners[0]?.token as string)).status).toBe(200);
  });

  test("a revoked registration's reason stands: the cascade does not overwrite it", async () => {
    const w = await seedWorld();
    const first = w.runners[0] as { id: string };
    expect((await api("POST", `/admin/compute/runners/${first.id}/revoke`, "actor")).status).toBe(
      200,
    );
    expect((await api("POST", "/admin/revoke/rn-target", "actor")).status).toBe(200);
    expect(runnerRow(first.id).revoke_reason).toBe("owner_revoked");
    expect(runnerRow((w.runners[1] as { id: string }).id).revoke_reason).toBe("account_revoked");
  });
});

describe("the guarded call of the scheduled sweep, and replay", () => {
  const snapshot = () =>
    JSON.stringify({
      runners: db.query("SELECT * FROM compute_runners ORDER BY id").all(),
      tokens: db.query("SELECT * FROM compute_runner_tokens ORDER BY token_hash").all(),
      jobs: db.query("SELECT * FROM compute_jobs ORDER BY id").all(),
    });

  test("under a false guard each statement, alone, changes nothing; under a true one the set ends the runners", async () => {
    const w = await seedWorld();
    const statements = runnerEndStatements(userIds.target, "account_deleted");
    const before = snapshot();
    for (const s of statements) {
      db.prepare(`${s.sql}${MASK_APPLIED_SQL}`).run(
        ...(s.binds as never[]),
        userIds.target,
        "no-such-address@nemar.test",
      );
      expect(snapshot()).toBe(before);
    }
    const email = (
      db.query("SELECT email FROM users WHERE id = ?").get(userIds.target) as { email: string }
    ).email;
    for (const s of statements) {
      db.prepare(`${s.sql}${MASK_APPLIED_SQL}`).run(...(s.binds as never[]), userIds.target, email);
    }
    expect(snapshot()).not.toBe(before);
    expect(runnerRow((w.runners[0] as { id: string }).id).revoke_reason).toBe("account_deleted");
  });

  test("the sweep's own call (`onlyIfEmail`) touches no runner when the row's address changed, and ends them when it matches", async () => {
    const w = await seedWorld();
    const original = (
      db.query("SELECT email FROM users WHERE id = ?").get(userIds.target) as { email: string }
    ).email;
    const before = snapshot();
    const refused = await tombstoneUserCascade(
      d1,
      userIds.target,
      original,
      "someone-else@nemar.test",
    );
    expect(refused.tombstoned).toBe(false);
    expect(snapshot()).toBe(before);
    const done = await tombstoneUserCascade(d1, userIds.target, original, original);
    expect(done.tombstoned).toBe(true);
    for (const r of w.runners) expect(runnerRow(r.id).revoke_reason).toBe("account_deleted");
  });

  test("the statements are replayable and keyed by the owner: a second run changes nothing, and another owner's are out of reach", async () => {
    const w = await seedWorld();
    const run = (userId: number) =>
      d1.batch(
        runnerEndStatements(userId, "account_revoked").map((s) =>
          d1.prepare(s.sql).bind(...s.binds),
        ),
      );
    await run(userIds.target);
    const once = snapshot();
    await run(userIds.target);
    expect(snapshot()).toBe(once);
    // A user with no registrations ends nothing.
    await run(userIds.actor);
    expect(snapshot()).toBe(once);
    expect(runnerRow(w.bystander.id).revoked_at).toBeNull();
  });

  test("the registration is revoked LAST: written first, the owner-keyed statements would find nothing (MUTATION: reorder)", async () => {
    const w = await seedWorld();
    const [tokens, release, unreport, end] = runnerEndStatements(userIds.target, "account_revoked");
    // Run the registration's revoke FIRST: the three that select it as live then reach nothing.
    for (const s of [end, tokens, release, unreport]) {
      db.prepare(s?.sql as string).run(...((s?.binds ?? []) as never[]));
    }
    expect(
      db
        .query("SELECT COUNT(*) AS n FROM compute_runner_tokens WHERE runner_id = ?")
        .get((w.runners[0] as { id: string }).id),
    ).toEqual({ n: 1 });
    expect(job(w.claimed[0] as string).runner_id).not.toBeNull();
  });
});

describe("a registration that was past authentication when the owner's cascade committed", () => {
  const LATE = { ...REGISTRATION, name: "late_one" } as Parameters<typeof registerRunner>[2];

  const PATHS: Array<[string, () => Promise<{ status: number }>]> = [
    ["an admin revoke (finalizeRevocation)", () => api("POST", "/admin/revoke/rn-target", "actor")],
    [
      "a role demotion",
      () => api("POST", "/admin/users/rn-target/role", "actor", { role: "admin" }),
    ],
    [
      "the owner's soft delete (tombstoneUserCascade)",
      () => api("DELETE", `/admin/users/by-id/${userIds.target}`, "actor"),
    ],
  ];

  for (const [name, end] of PATHS) {
    test(`after ${name}: the late registration is refused and writes nothing, and a row it would have left is dead`, async () => {
      expect((await end()).status).toBe(200);
      // The request authenticated before the cascade; its write now meets an owner who no longer stands.
      await expect(registerRunner(d1, userIds.target, LATE)).rejects.toBeInstanceOf(
        RunnerOwnerNotStanding,
      );
      expect(db.query("SELECT COUNT(*) AS n FROM compute_runners").get()).toEqual({ n: 0 });
      expect(
        db
          .query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'compute.runner.registered'")
          .get(),
      ).toEqual({ n: 0 });

      // And if such a row exists all the same (written before this guard, or by hand), neither its secret
      // nor its token is honoured: the owner has to stand at every use.
      const secret = `nmr_${"e".repeat(64)}`;
      const token = `nmra_${"f".repeat(64)}`;
      const id = `rnr_${"9".repeat(24)}`;
      db.run(
        `INSERT INTO compute_runners (id, name, pool, cores, memory_mb, gpus, scratch_gb, backend, runtimes, arch,
           accounting, site, trust, secret_hash, registered_by)
         VALUES (?, 'late_row', 'cpu', 1, 1, 0, 1, 'local', '["docker"]', 'amd64', 'none', 's', 'lab', ?, ?)`,
        [id, await hashRunnerCredential(secret), userIds.target],
      );
      db.run(
        "INSERT INTO compute_runner_tokens (token_hash, runner_id, expires_at) VALUES (?, ?, datetime('now', '+900 seconds'))",
        [await hashRunnerCredential(token), id],
      );
      const ex = await api(
        "POST",
        "/compute/runners/token",
        null,
        { protocol: RUNNER_PROTOCOL, runner_version: "0.1.0" },
        secret,
      );
      expect([ex.status, ex.body]).toEqual([401, { error: "runner_unknown" }]);
      expect((await me(token)).status).toBe(401);
      expect(
        db.query("SELECT COUNT(*) AS n FROM compute_runner_tokens WHERE runner_id = ?").get(id),
      ).toEqual({ n: 1 });
    });
  }

  test("a key revocation does NOT take a standing owner's runner or stop a new registration (ADR 0121's deliberate exception is untouched)", async () => {
    const w = await seedWorld();
    db.run(
      "INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, 'late-key-hash', 'latekey1')",
      [userIds.target],
    );
    const key = db.query("SELECT id FROM tokens WHERE api_key_hash = 'late-key-hash'").get() as {
      id: number;
    };
    expect((await api("DELETE", `/admin/users/rn-target/keys/${key.id}`, "actor")).status).toBe(
      200,
    );
    expect((await me((w.runners[0] as { token: string }).token)).status).toBe(200);
    await expect(registerRunner(d1, userIds.target, LATE)).resolves.toMatchObject({
      runnerId: expect.stringMatching(/^rnr_/),
    });
  });
});

describe("the cascade and the status are one atomic step, so a late registration cannot survive a re-approval", () => {
  /**
   * The Worker's database with ONE thing injected: `late` runs right after the first batch commits, which
   * is where a request that was already past authentication lands its write. Everything else is the real
   * database, statement for statement.
   */
  function injectAfterFirstBatch(late: () => Promise<void>): D1Database {
    let fired = false;
    return {
      prepare: (sql: string) => d1.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        const result = await d1.batch(statements);
        if (!fired) {
          fired = true;
          await late();
        }
        return result;
      },
    } as unknown as D1Database;
  }

  const LATE = { ...REGISTRATION, name: "late_two" } as Parameters<typeof registerRunner>[2];

  const PATHS: Array<[string, () => Promise<{ status: number }>]> = [
    [
      "finalizeRevocation (the admin revoke)",
      () => api("POST", "/admin/revoke/rn-target", "actor"),
    ],
    [
      "the role demotion",
      () => api("POST", "/admin/users/rn-target/role", "actor", { role: "admin" }),
    ],
    [
      "tombstoneUserCascade (the soft delete)",
      () => api("DELETE", `/admin/users/by-id/${userIds.target}`, "actor"),
    ],
  ];

  for (const [name, end] of PATHS) {
    test(`${name}: end batch, then registerRunner, then status, then re-approval: the secret does not resolve`, async () => {
      let secret: string | null = null;
      let refused: unknown = null;
      dbOverride = injectAfterFirstBatch(async () => {
        try {
          secret = (await registerRunner(d1, userIds.target, LATE)).secret;
        } catch (err) {
          refused = err;
        }
      });
      expect((await end()).status).toBe(200);
      dbOverride = null;
      // The registration landed after the cascade committed and was refused: the owner's status (or role,
      // or deletion) was already in the same batch.
      expect(refused).toBeInstanceOf(RunnerOwnerNotStanding);
      expect(secret).toBeNull();
      // Re-approval, as an admin would do it (and a re-promotion, for the demotion): nothing comes back.
      db.run(
        "UPDATE users SET status = 'approved', role = 'owner', deleted_at = NULL WHERE id = ?",
        [userIds.target],
      );
      expect(
        db.query("SELECT COUNT(*) AS n FROM compute_runners WHERE name = 'late_two'").get(),
      ).toEqual({ n: 0 });
      if (secret !== null) expect(await findRunnerBySecret(d1, secret)).toBeNull();
    });
  }
});
