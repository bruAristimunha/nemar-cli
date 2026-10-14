/**
 * POST /admin/users/backfill-usernames (ADR 0042, #1253, epic #1250).
 *
 * 19 live accounts have `username = NULL`: web/ORCID sign-ups, where the column
 * has been NULL by design since migration 0026. 16 of them have a full name on
 * the row, 3 have a given name only, and 18 have never verified their inbox.
 * This sweep gives the 16 a handle derived from their own name, lists the 3 for
 * a human, and sends each finished row the one verify-your-email message that
 * lets its owner sign in and use it.
 *
 * Real engine: bun:sqlite behind realD1 with every migration applied, the real
 * admin router (authMiddleware + adminMiddleware, real hashed tokens), real zod
 * validation, the real `issueEmailVerificationCode` including its non-production
 * fence. ORCID's public API and Resend are local `Bun.serve()` instances
 * (helpers/resend.ts), so `fetchOrcidName`'s own parse runs and a failing record
 * is a real HTTP failure rather than a thrown stub.
 *
 * The load-bearing assertions are about restraint: a dry run writes nothing, a
 * one-part name is never guessed at, and in a non-production environment no
 * address outside the synthetic allow-list is written to or mailed at all
 * (AGENTS.md -- the dev D1 holds roughly 609 real addresses behind a live
 * Resend key).
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import { USERNAME_SUFFIX_LIMIT } from "../src/services/username";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { withFakeResend } from "./helpers/resend";

const ADMIN_KEY = "backfill-usernames-admin-key-0123456789abcd";

/** ORCID iD -> what the local public API returns for it. */
let records: Record<string, { status: number; body: unknown }>;
let server: ReturnType<typeof Bun.serve>;
let base: string;

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

function fullName(given: string, family: string) {
  return {
    status: 200,
    body: { name: { "given-names": { value: given }, "family-name": { value: family } } },
  };
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const m = url.pathname.match(/\/v3\.0\/([^/]+)\/personal-details$/);
      const record = m ? records[m[1]] : undefined;
      if (!record) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(record.body), {
        status: record.status,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    ORCID_PUB_API_BASE: base,
    RESEND_API_KEY: "fake-resend-key",
    // Everything the fence would let through in a non-production environment.
    // The synthetic-target rule inside issueEmailVerificationCode is narrower
    // still (@nemar.test only), which is what the fence tests below rely on.
    DEV_EMAIL_ALLOWLIST: "@nemar.test,@example.org",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
    ENCRYPTION_KEY: "backfill-usernames-test-encryption-key-0123",
  } as unknown as Bindings;
}

async function seedAdmin(): Promise<void> {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        given_name, family_name)
     VALUES ('unameadmin', 'unameadmin@nemar.test', 'x', 'approved', 'admin', 1, 'Root', 'Admin')`,
  ).run();
  const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='unameadmin'").get();
  if (!u) throw new Error("seed: admin insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
}

interface CandidateOptions {
  given_name?: string | null;
  family_name?: string | null;
  orcid?: string | null;
  email_verified?: number;
}

/** An unrelated account already holding a handle, to take it out of the pool. */
function seedTaken(username: string): void {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES (?, ?, 'x', 'approved', 'member', 1)`,
  ).run(username, `${username}@example.org`);
}

/** A username-less row, the shape the sweep exists for. */
function seedCandidate(email: string, options: CandidateOptions = {}): number {
  const row = {
    given_name: "Ada",
    family_name: "Lovelace",
    orcid: null,
    email_verified: 0,
    ...options,
  };
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        given_name, family_name, orcid, orcid_verified, signup_source)
     VALUES (NULL, ?, 'x', 'pending', 'member', ?, ?, ?, ?, ?, 'web')`,
  ).run(email, row.email_verified, row.given_name, row.family_name, row.orcid, row.orcid ? 1 : 0);
  const u = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!u) throw new Error(`seed failed for ${email}`);
  return u.id;
}

/**
 * The same bindings with ENVIRONMENT="production".
 *
 * Needed by the delivery-failure tests, and the reason is the fence itself
 * working: outside production `issueEmailVerificationCode` either echoes a
 * code for a synthetic `@nemar.test` target (no send at all) or refuses
 * outright, so `verify: "failed"` is UNREACHABLE in a test environment. The
 * only way to exercise the production path is to declare the environment the
 * fence keys on -- with `api.resend.com` still redirected to the local server
 * by helpers/resend.ts, so nothing leaves the machine.
 */
function prodEnv(): Bindings {
  return { ...env(), ENVIRONMENT: "production" } as Bindings;
}

function run(body: Record<string, unknown> = {}, bindings: Bindings = env()): Promise<Response> {
  return app.request(
    "/admin/users/backfill-usernames",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    bindings,
  );
}

function usernameOf(id: number): string | null {
  return (
    db
      .query<{ username: string | null }, [number]>("SELECT username FROM users WHERE id = ?")
      .get(id)?.username ?? null
  );
}

function codesFor(email: string): number {
  return (
    db
      .query<{ n: number }, [string]>("SELECT COUNT(*) as n FROM auth_codes WHERE email = ?")
      .get(email)?.n ?? 0
  );
}

beforeEach(async () => {
  db = freshDb();
  records = {};
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedAdmin();
});

describe("backfill-usernames: dry run", () => {
  test("reports the exact usernames apply would assign, and writes nothing", async () => {
    const id = seedCandidate("ada@nemar.test");

    const body = await (await withFakeResend(() => run())).json();
    expect(body.apply).toBe(false);
    expect(body.would_assign).toBe(1);
    expect(body.assigned).toBe(0);
    expect(body.results[0]).toMatchObject({
      id,
      outcome: "would_assign",
      username: "alovelace",
      verify: "not_attempted",
    });

    expect(usernameOf(id)).toBeNull();
    expect(codesFor("ada@nemar.test")).toBe(0);
    // Still a candidate, so `remaining` counts it.
    expect(body.remaining).toBe(1);
  });

  test("a dry run sends nothing at all", async () => {
    seedCandidate("ada@nemar.test");

    const calls = await withFakeResend(async (captured) => {
      await run();
      return captured;
    });
    expect(calls).toHaveLength(0);
  });
});

describe("backfill-usernames: apply", () => {
  test("assigns the suggested username and audits the batch", async () => {
    const id = seedCandidate("ada@nemar.test", { email_verified: 1 });

    const body = await (await withFakeResend(() => run({ apply: true }))).json();
    expect(body.assigned).toBe(1);
    expect(usernameOf(id)).toBe("alovelace");
    expect(body.remaining).toBe(0);

    // The 0079 column, which is the STATE half and the reason the sweep must go
    // through `usernameClaimStatement` rather than write its own UPDATE: the
    // "we chose this from your name, change it if you like" offer renders on
    // every page load and cannot scan an audit log for permission to appear.
    expect(
      db
        .query<{ username_auto_assigned: number }, [number]>(
          "SELECT username_auto_assigned FROM users WHERE id = ?",
        )
        .get(id)?.username_auto_assigned,
    ).toBe(1);

    const audit = db
      .query<{ details: string | null }, [string]>("SELECT details FROM audit_log WHERE action = ?")
      .all("usernames_backfilled");
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].details ?? "{}")).toMatchObject({ assigned: 1, user_ids: [id] });

    // And the PER-ROW event, which is the same action the three sign-in doors
    // write and is told apart from them only by `source` (#1268, ADR 0045). The
    // batch row above has no `user_id` subject, so without this one an operator
    // cannot ask "how did THIS account get its handle".
    const perRow = db
      .query<{ user_id: number; details: string | null }, [string]>(
        "SELECT user_id, details FROM audit_log WHERE action = ?",
      )
      .all("username_auto_assigned");
    expect(perRow).toHaveLength(1);
    expect(perRow[0].user_id).toBe(id);
    expect(JSON.parse(perRow[0].details ?? "{}")).toEqual({
      username: "alovelace",
      source: "admin_backfill",
    });
  });

  test("two rows sharing a suggestion get a collision suffix", async () => {
    // End to end: whichever mechanism resolves it (here the first row's write
    // is already visible to the second row's scan, because the loop is
    // sequential), two accounts must never come out of one batch sharing a
    // handle. The dry-run test below is the one that pins the in-batch
    // reservation set, which is the only thing standing between those two rows
    // when nothing has been written yet.
    const first = seedCandidate("ada@nemar.test", { email_verified: 1 });
    const second = seedCandidate("alan@nemar.test", {
      given_name: "Alan",
      family_name: "Lovelace",
      email_verified: 1,
    });

    const body = await (await withFakeResend(() => run({ apply: true }))).json();
    expect(body.assigned).toBe(2);
    expect(usernameOf(first)).toBe("alovelace");
    expect(usernameOf(second)).toBe("alovelace-2");
  });

  test("a dry run over two rows sharing a suggestion also suffixes", async () => {
    seedCandidate("ada@nemar.test");
    seedCandidate("alan@nemar.test", { given_name: "Alan", family_name: "Lovelace" });

    const body = await (await withFakeResend(() => run())).json();
    expect(body.results.map((r: { username: string }) => r.username)).toEqual([
      "alovelace",
      "alovelace-2",
    ]);
  });

  test("suffixes past a username an existing account already holds", async () => {
    db.query(
      "INSERT INTO users (username, email, password_hash, status) VALUES ('ALovelace', 'held@example.org', 'x', 'approved')",
    ).run();
    const id = seedCandidate("ada@nemar.test", { email_verified: 1 });

    await withFakeResend(() => run({ apply: true }));
    // COLLATE NOCASE: `ALovelace` takes `alovelace`.
    expect(usernameOf(id)).toBe("alovelace-2");
  });

  test("a re-run walks forward instead of re-doing the batch", async () => {
    const id = seedCandidate("ada@nemar.test", { email_verified: 1 });

    await withFakeResend(() => run({ apply: true }));
    const second = await (await withFakeResend(() => run({ apply: true }))).json();
    expect(second.scanned).toBe(0);
    expect(second.remaining).toBe(0);
    expect(usernameOf(id)).toBe("alovelace");
  });
});

describe("backfill-usernames: rows it will not guess at", () => {
  test("a saturated base is `exhausted`, which is not a retryable conflict", async () => {
    // The suffix search is bounded, and exhausting it used to be reported as a
    // `conflict` -- a value whose whole meaning is "retry, it will pick the next
    // suffix", which this case never will. The bound is
    // `pickAvailableUsername`'s own constant, imported rather than written down
    // here so the fixture follows it instead of pinning a copy. It also proves
    // the search terminates rather than looping inside a Worker request.
    seedTaken("alovelace");
    for (let n = 2; n <= USERNAME_SUFFIX_LIMIT; n++) seedTaken(`alovelace-${n}`);
    const id = seedCandidate("ada@nemar.test", { email_verified: 1 });

    const body = await (await withFakeResend(() => run({ apply: true }))).json();

    expect(body.exhausted).toBe(1);
    expect(body.conflict).toBe(0);
    expect(body.assigned).toBe(0);
    expect(body.results[0]).toMatchObject({
      id,
      outcome: "exhausted",
      error: "No free variant of 'alovelace' within the suffix limit",
    });
    expect(usernameOf(id)).toBeNull();
    // Still a candidate, and it will be one after every future run too.
    expect(body.remaining).toBe(1);
  });

  test("a one-part name is reported, not derived from the email", async () => {
    // 3 of the 19 production rows are exactly this. `pemberly@nemar.test` would
    // make a perfectly plausible handle and is not this person's name.
    const id = seedCandidate("pemberly@nemar.test", { given_name: "Prince", family_name: null });

    const body = await (await withFakeResend(() => run({ apply: true }))).json();
    expect(body.single_name).toBe(1);
    expect(body.assigned).toBe(0);
    expect(body.results[0]).toMatchObject({ outcome: "single_name", given_name: "Prince" });
    expect(usernameOf(id)).toBeNull();
  });

  test("no name at all is a different outcome from one name", async () => {
    seedCandidate("blank@nemar.test", { given_name: null, family_name: null });

    const body = await (await withFakeResend(() => run({ apply: true }))).json();
    expect(body.no_name).toBe(1);
    expect(body.single_name).toBe(0);
  });

  test("reads a missing family name from the ORCID record", async () => {
    records["0000-0002-1825-0097"] = fullName("Ada", "Lovelace");
    const id = seedCandidate("orcidname@nemar.test", {
      given_name: null,
      family_name: null,
      orcid: "0000-0002-1825-0097",
      email_verified: 1,
    });

    const body = await (await withFakeResend(() => run({ apply: true }))).json();
    expect(body.assigned).toBe(1);
    expect(usernameOf(id)).toBe("alovelace");
  });

  test("an ORCID read failure is transient, not a verdict", async () => {
    records["0000-0002-1825-0097"] = { status: 503, body: { error: "upstream" } };
    const id = seedCandidate("flaky@nemar.test", {
      given_name: null,
      family_name: null,
      orcid: "0000-0002-1825-0097",
    });

    const body = await (await withFakeResend(() => run({ apply: true }))).json();
    expect(body.lookup_failed).toBe(1);
    expect(body.no_name).toBe(0);
    expect(usernameOf(id)).toBeNull();
    // Still a candidate: the next run retries it.
    expect(body.remaining).toBe(1);
  });
});

describe("backfill-usernames: the verify-your-email message", () => {
  test("issues one code for an unverified row it just finished", async () => {
    const id = seedCandidate("ada@nemar.test");

    const body = await (await withFakeResend(() => run({ apply: true }))).json();
    expect(body.results[0]).toMatchObject({ outcome: "assigned", verify: "sent" });
    expect(body.verify_sent).toBe(1);
    expect(codesFor("ada@nemar.test")).toBe(1);
    expect(usernameOf(id)).toBe("alovelace");
  });

  test("skips a row whose inbox is already verified", async () => {
    seedCandidate("ada@nemar.test", { email_verified: 1 });

    const body = await (await withFakeResend(() => run({ apply: true }))).json();
    expect(body.results[0].verify).toBe("already_verified");
    expect(body.verify_sent).toBe(0);
    expect(codesFor("ada@nemar.test")).toBe(0);
  });

  test("never reaches a real address in a non-production environment", async () => {
    // THE FENCE. `example.org` is on DEV_EMAIL_ALLOWLIST above, so the generic
    // sendEmail fence would have let it through -- what stops it is the
    // narrower synthetic-target rule inside issueEmailVerificationCode, which
    // writes NOTHING for an address that is not a test fixture. This is the
    // property that makes the sweep safe to run against the dev deployment,
    // whose users table holds roughly 609 real addresses (AGENTS.md).
    const id = seedCandidate("a.real.person@example.org");

    const calls = await withFakeResend(async (captured) => {
      const body = await (await run({ apply: true })).json();
      expect(body.results[0]).toMatchObject({ outcome: "assigned", verify: "skipped_fence" });
      expect(body.verify_sent).toBe(0);
      return captured;
    });

    expect(calls).toHaveLength(0);
    expect(codesFor("a.real.person@example.org")).toBe(0);
    // The username IS written: the fence is about delivery, not about the sweep.
    expect(usernameOf(id)).toBe("alovelace");
  });

  test("a row it could not finish is not mailed", async () => {
    // Nothing to sign in to yet: the account still has no username, and an
    // operator has to pick one by hand.
    seedCandidate("pemberly@nemar.test", { given_name: "Prince", family_name: null });

    const body = await (await withFakeResend(() => run({ apply: true }))).json();
    expect(body.verify_sent).toBe(0);
    expect(codesFor("pemberly@nemar.test")).toBe(0);
  });

  test("a second apply run cannot mail the same account twice", async () => {
    // Guaranteed by the candidate predicate rather than by a flag: an assigned
    // row no longer has a NULL username, so it is never scanned again.
    seedCandidate("ada@nemar.test");

    await withFakeResend(() => run({ apply: true }));
    const second = await (await withFakeResend(() => run({ apply: true }))).json();
    expect(second.scanned).toBe(0);
    expect(codesFor("ada@nemar.test")).toBe(1);
  });
});

describe("backfill-usernames: the verify-retry pass", () => {
  /** A row an earlier run already named, whose inbox is still unproven. */
  function seedNamedButUnverified(email: string, username: string): number {
    db.query(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                          given_name, family_name, signup_source)
       VALUES (?, ?, 'x', 'pending', 'member', 0, 'Ada', 'Lovelace', 'web')`,
    ).run(username, email);
    const u = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
    if (!u) throw new Error(`seed failed for ${email}`);
    return u.id;
  }

  test("a failed message is counted, not silently dropped", async () => {
    // The Resend fake refuses, so issueEmailVerificationCode rolls its code row
    // back and reports send_failed -- which used to appear in neither the
    // summary nor the exit code.
    const id = seedCandidate("ada@nemar.test");

    const body = await (
      await withFakeResend(() => run({ apply: true }, prodEnv()), { status: 500 })
    ).json();
    expect(body.results[0]).toMatchObject({ outcome: "assigned", verify: "failed" });
    expect(body.verify_failed).toBe(1);
    expect(body.verify_sent).toBe(0);
    // The username IS written: the message is best-effort, the handle is not.
    expect(usernameOf(id)).toBe("alovelace");
    expect(codesFor("ada@nemar.test")).toBe(0);
  });

  test("the next run re-attempts a row whose message failed", async () => {
    // Without this pass the row is unreachable forever: it has a username, so
    // it no longer matches the assignment predicate, and nothing else in the
    // product mails these accounts. "One message per account" would become
    // "none" for exactly the accounts whose one attempt failed.
    seedCandidate("ada@nemar.test");
    await withFakeResend(() => run({ apply: true }, prodEnv()), { status: 500 });

    const body = await (await withFakeResend(() => run({ apply: true }))).json();
    expect(body.scanned).toBe(0);
    expect(body.verify_retries).toHaveLength(1);
    expect(body.verify_retries[0]).toMatchObject({ email: "ada@nemar.test", verify: "sent" });
    expect(body.verify_sent).toBe(1);
    expect(codesFor("ada@nemar.test")).toBe(1);
  });

  test("a row holding a live code is left alone", async () => {
    // Convergence: a successful send writes a code, which drops the row out of
    // the retry population until it expires or is used. Without that predicate
    // every run would re-mail every unverified account.
    seedCandidate("ada@nemar.test");
    await withFakeResend(() => run({ apply: true }));

    const body = await (await withFakeResend(() => run({ apply: true }))).json();
    expect(body.verify_retries).toHaveLength(0);
    expect(codesFor("ada@nemar.test")).toBe(1);
  });

  test("a row named by THIS run is not also retried", async () => {
    // The retry pass runs first, so a row about to be named has no username yet
    // and cannot appear in it. Nothing is mailed twice in one sweep.
    seedCandidate("ada@nemar.test");

    const body = await (
      await withFakeResend(() => run({ apply: true }, prodEnv()), { status: 500 })
    ).json();
    expect(body.verify_retries).toHaveLength(0);
    expect(body.assigned).toBe(1);
  });

  test("a dry run lists the retries and sends nothing", async () => {
    seedNamedButUnverified("named@nemar.test", "alovelace");

    const calls = await withFakeResend(async (captured) => {
      const body = await (await run()).json();
      expect(body.verify_retries).toEqual([
        { id: expect.any(Number), email: "named@nemar.test", verify: "not_attempted" },
      ]);
      expect(body.verify_sent).toBe(0);
      return captured;
    });
    expect(calls).toHaveLength(0);
    expect(codesFor("named@nemar.test")).toBe(0);
  });

  test("a CLI account is not mailed a dashboard code", async () => {
    // A CLI signup proves its inbox through the signup verification LINK, a
    // different flow with its own resend command.
    db.query(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified, signup_source)
       VALUES ('clidude', 'clidude@nemar.test', 'x', 'pending', 'member', 0, 'cli')`,
    ).run();

    const body = await (await withFakeResend(() => run({ apply: true }))).json();
    expect(body.verify_retries).toHaveLength(0);
  });

  test("a verified row is never in the retry population", async () => {
    const id = seedNamedButUnverified("done@nemar.test", "adone");
    db.query("UPDATE users SET status = 'verified', email_verified = 1 WHERE id = ?").run(id);

    const body = await (await withFakeResend(() => run({ apply: true }))).json();
    expect(body.verify_retries).toHaveLength(0);
  });
});

describe("backfill-usernames: batching", () => {
  test("limit bounds the batch and remaining reports the rest", async () => {
    seedCandidate("a@nemar.test", { given_name: "Ada", family_name: "Aardvark" });
    seedCandidate("b@nemar.test", { given_name: "Ben", family_name: "Bishop" });
    seedCandidate("c@nemar.test", { given_name: "Cleo", family_name: "Carver" });

    const body = await (await withFakeResend(() => run({ apply: true, limit: 2 }))).json();
    expect(body.scanned).toBe(2);
    expect(body.assigned).toBe(2);
    expect(body.remaining).toBe(1);
  });

  test("a tombstoned row is not a candidate", async () => {
    const id = seedCandidate("gone@nemar.test");
    db.query("UPDATE users SET deleted_at = datetime('now') WHERE id = ?").run(id);

    const body = await (await withFakeResend(() => run({ apply: true }))).json();
    expect(body.scanned).toBe(0);
    expect(body.remaining).toBe(0);
  });

  test("one failed claim is one row's outcome, not the batch's (#1274)", async () => {
    // The ORCID read was wrapped per row; the claim that follows it was not.
    // A write failure threw out of the loop into a bare 500, discarding the
    // summary of every username already assigned AND of the verify messages
    // already sent -- so an operator could not tell what the run had done, and
    // a re-run was the only option.
    const blocked = seedCandidate("blocked@nemar.test", {
      given_name: "Ada",
      family_name: "Aardvark",
    });
    const survivor = seedCandidate("survivor@nemar.test", {
      given_name: "Ben",
      family_name: "Bishop",
    });
    // Row-scoped, so the other candidate's claim still lands.
    db.run(
      `CREATE TRIGGER refuse_one_claim BEFORE UPDATE ON users
       WHEN NEW.id = ${blocked}
       BEGIN SELECT RAISE(ABORT, 'claim blocked for this row'); END`,
    );

    const res = await withFakeResend(() => run({ apply: true }));
    // NOT a 500: the batch completed, one row did not.
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.assigned).toBe(1);
    expect(body.write_failed).toBe(1);
    // Reported as its own outcome, not as a conflict: nobody else took the
    // handle, our own write refused it.
    expect(body.conflict).toBe(0);
    const failed = body.results.find((r: { id: number }) => r.id === blocked);
    expect(failed.outcome).toBe("write_failed");
    expect(failed.error).toContain("claim blocked for this row");
    expect(failed.verify).toBe("not_attempted");

    expect(usernameOf(survivor)).toBe("bbishop");
    expect(usernameOf(blocked)).toBeNull();
    // Still a candidate: the next run retries it.
    expect(body.remaining).toBe(1);
  });
});
