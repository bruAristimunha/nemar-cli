/**
 * The daily sweep of the accounts the live integration tests leave behind (#1789).
 *
 * Real engine throughout: bun:sqlite behind `realD1` with every migration applied, the real
 * sweep, the real tombstone statements, and (for the route that shares them) real Hono dispatch.
 * No mocks.
 *
 * The thing under test is a predicate that is allowed to delete accounts on a database that
 * shares about 600 real people with the test accounts, so most of this file is rows that must
 * NOT move. Each such row is compared whole, before and after, so a sweep that touched any column
 * of it fails here, not only one that tombstoned it.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { maskedDeletedEmail, tombstoneUserCascade } from "../src/db/user-tombstone";
import { adminRoutes } from "../src/routes/admin";
import { NONPROD_TEST_ACCOUNT } from "../src/services/auth-code";
import {
  GENERATED_TEST_ACCOUNT_EMAIL,
  TEST_ACCOUNT_SWEEP_BATCH,
  TEST_ACCOUNT_SWEEP_CANDIDATES_SQL,
  TEST_ACCOUNT_SWEEP_MIN_AGE_DAYS,
  TEST_ACCOUNT_SWEEP_NOT_RUN,
  TEST_ACCOUNT_SWEEP_SCAN_CAP,
  cleanUpLiveTestAccounts,
  sweepCiTestAccounts,
} from "../src/services/test-account-sweep";
import { hashApiKey } from "../src/services/token";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, interceptingD1, realD1 } from "./helpers/d1";

const SEED_SQL = join(import.meta.dir, "../../scripts/seed-dev-db.sql");
const OWNER_KEY = "sweep-owner-key-0123456789abcdef0123456789abcdef";

let db: Database;
let counter = 0;

/** `env()` is a test environment; `env(undefined)` is a Worker whose ENVIRONMENT binding is unset. */
function env(...given: [string | undefined] | []): Pick<Bindings, "DB" | "ENVIRONMENT"> {
  const environment = given.length === 0 ? "test" : given[0];
  return { DB: realD1(db), ENVIRONMENT: environment } as unknown as Pick<
    Bindings,
    "DB" | "ENVIRONMENT"
  >;
}

/** An address of the shape a live test generates: prefix, label, 13-digit clock, 6 base36. */
function generated(prefix: "dcli" | "df" | "pl", label = "full-loop"): string {
  counter++;
  return `${prefix}-${label}-${1_760_000_000_000 + counter}-ab${String(counter).padStart(4, "0")}@nemar.test`;
}

/** The passwordless suite's `pl-gate-<clock>-<random>@example.com` seed. */
function generatedGate(): string {
  counter++;
  return `pl-gate-${1_760_000_000_000 + counter}-gt${String(counter).padStart(4, "0")}@example.com`;
}

interface SeedOpts {
  kind?: "person" | "service" | "test";
  source?: "web" | "cli";
  role?: "member" | "admin" | "owner";
  status?: "pending" | "verified" | "approved" | "revoked";
  ageDays?: number;
  deleted?: boolean;
  iam?: string | null;
  uploadRequested?: boolean;
  serviceAccess?: boolean;
}

/** Insert a user shaped like a live-test account unless told otherwise. */
function seedUser(email: string, o: SeedOpts = {}): number {
  const status = o.status ?? "verified";
  db.run(
    `INSERT INTO users (email, status, signup_source, role, account_kind, aws_iam_username,
                        upload_access_requested_at, service_access, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), datetime('now', ?))`,
    [
      email,
      status,
      o.source ?? "web",
      o.role ?? "member",
      o.kind ?? "person",
      o.iam ?? null,
      o.uploadRequested ? "2026-01-01 00:00:00" : null,
      o.serviceAccess ? 1 : 0,
      o.deleted ? "2026-01-02 00:00:00" : null,
      `-${o.ageDays ?? 30} days`,
      `-${o.ageDays ?? 30} days`,
    ],
  );
  const row = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!row) throw new Error(`seed failed for ${email}`);
  return row.id;
}

function snapshot(id: number): string {
  return JSON.stringify(db.query("SELECT * FROM users WHERE id = ?").get(id));
}

function isTombstoned(id: number): boolean {
  const row = db
    .query<{ deleted_at: string | null }, [number]>("SELECT deleted_at FROM users WHERE id = ?")
    .get(id);
  return row?.deleted_at != null;
}

function count(sql: string, ...params: number[]): number {
  return db.query<{ n: number }, number[]>(sql).get(...params)?.n ?? 0;
}

beforeEach(() => {
  db = freshDb();
  counter = 0;
});

describe("what the sweep tombstones", () => {
  test("every generated shape, with the same masking and cascade as the owner-only delete", async () => {
    const dcli = seedUser(generated("dcli", "full-loop"));
    const df = seedUser(generated("df", "pending-confirm"));
    const pl = seedUser(generated("pl", "cookie572-bearerwins"));
    const gate = seedUser(generatedGate());
    const target = seedUser(generated("pl", "happy"));
    const email = db
      .query<{ email: string }, [number]>("SELECT email FROM users WHERE id = ?")
      .get(target)?.email as string;

    // The credentials the tombstone has to end, all of them.
    await db
      .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
      .run(target, await hashApiKey("k".repeat(40)), "kkkkkkkk");
    await issueSession(env() as Bindings, target, false, "agent", "127.0.0.1", "email_code");
    db.run(
      "INSERT INTO docs_grants (code_hash, user_id, expires_at) VALUES ('g', ?, datetime('now', '+1 hour'))",
      [target],
    );
    db.run(
      "INSERT INTO private_grants (code_hash, user_id, state_hash, expires_at) VALUES ('p', ?, 's', datetime('now', '+1 hour'))",
      [target],
    );
    db.run(
      "INSERT INTO user_s3_permissions (user_id, s3_prefix, permission) VALUES (?, 'nm099999/', 'read')",
      [target],
    );
    db.run(
      "INSERT INTO auth_codes (email, code_hash, expires_at) VALUES (?, 'c', datetime('now', '+1 hour'))",
      [email],
    );

    const result = await sweepCiTestAccounts(env());

    expect(result).toEqual({ ran: true, examined: 5, tombstoned: 5, skipped: 0, errors: 0 });
    for (const id of [dcli, df, pl, gate, target]) {
      const row = db
        .query<{ email: string; status: string; deleted_at: string | null }, [number]>(
          "SELECT email, status, deleted_at FROM users WHERE id = ?",
        )
        .get(id);
      expect(row?.email).toBe(maskedDeletedEmail(id));
      expect(row?.status).toBe("revoked");
      expect(row?.deleted_at).not.toBeNull();
    }
    expect(
      count("SELECT COUNT(*) AS n FROM tokens WHERE user_id = ? AND revoked_at IS NULL", target),
    ).toBe(0);
    expect(
      count(
        "SELECT COUNT(*) AS n FROM web_sessions WHERE user_id = ? AND revoked_at IS NULL",
        target,
      ),
    ).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM docs_grants WHERE user_id = ?", target)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM private_grants WHERE user_id = ?", target)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM user_s3_permissions WHERE user_id = ?", target)).toBe(
      0,
    );
    expect(
      db
        .query<{ used_at: string | null }, [string]>(
          "SELECT used_at FROM auth_codes WHERE email = ?",
        )
        .get(email)?.used_at,
    ).not.toBeNull();
  });

  test("an account still holding a live key is tombstoned: revocation is the point", async () => {
    const id = seedUser(generated("df"));
    await db
      .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
      .run(id, await hashApiKey("z".repeat(40)), "zzzzzzzz");
    const result = await sweepCiTestAccounts(env());
    expect(result.tombstoned).toBe(1);
    expect(
      count("SELECT COUNT(*) AS n FROM tokens WHERE user_id = ? AND revoked_at IS NULL", id),
    ).toBe(0);
  });

  test("a test-kind account with a generated address is swept too", async () => {
    const id = seedUser(generated("pl"), { kind: "test" });
    expect((await sweepCiTestAccounts(env())).tombstoned).toBe(1);
    expect(isTombstoned(id)).toBe(true);
  });

  test("an account just over the age floor is swept, and just under it is not", async () => {
    const over = seedUser(generated("pl"), { ageDays: TEST_ACCOUNT_SWEEP_MIN_AGE_DAYS + 1 });
    const under = seedUser(generated("pl"), { ageDays: TEST_ACCOUNT_SWEEP_MIN_AGE_DAYS - 1 });
    const before = snapshot(under);
    await sweepCiTestAccounts(env());
    expect(isTombstoned(over)).toBe(true);
    expect(snapshot(under)).toBe(before);
  });
});

describe("what the sweep must never touch", () => {
  /** Each row is untouched whole: a changed `updated_at` counts. */
  function untouched(label: string, make: () => number): [string, () => number] {
    return [label, make];
  }

  const cases: Array<[string, () => number]> = [
    untouched("a real-looking address", () => seedUser("jane.doe@example.org")),
    untouched("a real address that starts like a generated one", () =>
      seedUser("dcli-full-loop-1760000000001-abcdef@example.com"),
    ),
    untouched("a generated shape at a lookalike domain", () =>
      seedUser("dcli-full-loop-1760000000002-abcdef@nemar.test.example.org"),
    ),
    untouched("a generated shape at a subdomain", () =>
      seedUser("dcli-full-loop-1760000000003-abcdef@sub.nemar.test"),
    ),
    untouched("a generated shape at the real org domain", () =>
      seedUser("df-full-loop-1760000000004-abcdef@nemar.org"),
    ),
    untouched("the prefix appearing later in the string", () =>
      seedUser("x-dcli-full-loop-1760000000005-abcdef@nemar.test"),
    ),
    untouched("the prefix as part of the local part of a longer address", () =>
      seedUser("jane.pl-full-loop-1760000000006-abcdef@nemar.test"),
    ),
    untouched("an upper-case rendering of a generated address", () =>
      seedUser("DCLI-FULL-LOOP-1760000000007-ABCDEF@NEMAR.TEST"),
    ),
    untouched("a fixed fixture address that merely starts with a prefix", () =>
      seedUser("pl-profile-patch@nemar.test"),
    ),
    untouched("a generated shape with a short clock", () =>
      seedUser("pl-happy-17600000000-abcdef@nemar.test"),
    ),
    untouched("a generated shape with a second at-sign", () =>
      seedUser("pl-happy-1760000000008-ab@cdef@nemar.test"),
    ),
    untouched("the seeded fixture test-user", () =>
      seedUser("test-user@nemar.test", { kind: "test", status: "approved", serviceAccess: true }),
    ),
    untouched("the shared QA account", () =>
      seedUser(NONPROD_TEST_ACCOUNT, { status: "approved", serviceAccess: true }),
    ),
    untouched("a service account with a generated address", () =>
      seedUser(generated("dcli"), { kind: "service" }),
    ),
    untouched("an account that signed up from the CLI", () =>
      seedUser(generated("dcli"), { source: "cli" }),
    ),
    untouched("an admin with a generated address", () =>
      seedUser(generated("pl"), { role: "admin" }),
    ),
    untouched("an owner with a generated address", () =>
      seedUser(generated("pl"), { role: "owner" }),
    ),
    untouched("an account younger than the age floor", () =>
      seedUser(generated("pl"), { ageDays: 1 }),
    ),
    untouched("a pl-gate shape at a real mail domain", () =>
      seedUser("pl-gate-1760000000010-abcdef@gmail.com"),
    ),
    untouched("a pl-gate shape at a lookalike of the reserved domain", () =>
      seedUser("pl-gate-1760000000011-abcdef@example.com.evil.org"),
    ),
    untouched("a pl-gate shape at another example domain", () =>
      seedUser("pl-gate-1760000000012-abcdef@example.org"),
    ),
    untouched("the pl-gate label with another prefix at the example domain", () =>
      seedUser("df-gate-1760000000013-abcdef@example.com"),
    ),
    untouched("a real-looking address at the example domain", () =>
      seedUser("jane.doe@example.com"),
    ),
    untouched("an account holding only an encrypted AWS access key id", () => {
      const id = seedUser(generated("pl"));
      db.run("UPDATE users SET aws_access_key_id_encrypted = 'enc' WHERE id = ?", [id]);
      return id;
    }),
    untouched("an account with legacy IAM credentials", () =>
      seedUser(generated("pl"), { iam: "legacy-iam-user" }),
    ),
    untouched("an account with an open upload-access request", () =>
      seedUser(generated("pl"), { uploadRequested: true }),
    ),
    untouched("an account holding upload access", () =>
      seedUser(generated("pl"), { status: "approved", serviceAccess: true }),
    ),
    untouched("an account that owns a dataset", () => {
      const id = seedUser(generated("pl"));
      db.run(
        "INSERT INTO datasets (dataset_id, name, owner_user_id, status) VALUES ('xx090123', 't', ?, 'active')",
        [id],
      );
      return id;
    }),
    untouched("an account that collaborates on a dataset", () => {
      const owner = seedUser("owner@example.org", { ageDays: 1 });
      const id = seedUser(generated("pl"));
      db.run(
        "INSERT INTO datasets (dataset_id, name, owner_user_id, status) VALUES ('xx090124', 't', ?, 'active')",
        [owner],
      );
      db.run(
        "INSERT INTO dataset_collaborators (dataset_id, user_id, access_type) SELECT id, ?, 'invited' FROM datasets WHERE dataset_id = 'xx090124'",
        [id],
      );
      return id;
    }),
    untouched("an account with a publication request", () => {
      const id = seedUser(generated("pl"));
      db.run("INSERT INTO publication_requests (dataset_id, requested_by) VALUES ('xx090125', ?)", [
        id,
      ]);
      return id;
    }),
    untouched("an account with a pending access request", () => {
      const owner = seedUser("owner2@example.org", { ageDays: 1 });
      const id = seedUser(generated("pl"));
      db.run(
        "INSERT INTO datasets (dataset_id, name, owner_user_id, status) VALUES ('xx090126', 't', ?, 'active')",
        [owner],
      );
      db.run(
        "INSERT INTO access_requests (dataset_id, user_id, status) SELECT id, ?, 'pending' FROM datasets WHERE dataset_id = 'xx090126'",
        [id],
      );
      return id;
    }),
    untouched("an already tombstoned account", () =>
      seedUser(generated("pl"), { deleted: true, status: "revoked" }),
    ),
  ];

  for (const [label, make] of cases) {
    test(label, async () => {
      const id = make();
      const before = snapshot(id);
      const result = await sweepCiTestAccounts(env());
      expect(snapshot(id)).toBe(before);
      expect(isTombstoned(id)).toBe(label === "an already tombstoned account");
      expect(result.tombstoned).toBe(0);
    });
  }

  test("none of the seeded fixture accounts, however old", async () => {
    db.exec(readFileSync(SEED_SQL, "utf-8"));
    db.run("UPDATE users SET created_at = datetime('now', '-400 days')");
    const before = JSON.stringify(db.query("SELECT * FROM users ORDER BY id").all());
    expect(
      count("SELECT COUNT(*) AS n FROM users WHERE username LIKE 'test-%'"),
    ).toBeGreaterThanOrEqual(7);

    const result = await sweepCiTestAccounts(env());

    expect(result.tombstoned).toBe(0);
    expect(JSON.stringify(db.query("SELECT * FROM users ORDER BY id").all())).toBe(before);
  });

  test("a real account and a swept one side by side: only the swept one moves", async () => {
    const real = seedUser("someone.real@university.edu", {
      status: "approved",
      serviceAccess: true,
    });
    const synthetic = seedUser(generated("df"));
    const before = snapshot(real);
    const result = await sweepCiTestAccounts(env());
    expect(result.tombstoned).toBe(1);
    expect(snapshot(real)).toBe(before);
    expect(isTombstoned(synthetic)).toBe(true);
  });
});

describe("the predicate itself", () => {
  test("accepts exactly the three generated shapes", () => {
    for (const p of ["dcli", "df", "pl"] as const) {
      expect(GENERATED_TEST_ACCOUNT_EMAIL.test(generated(p, "a"))).toBe(true);
      expect(GENERATED_TEST_ACCOUNT_EMAIL.test(generated(p, "cookie572-bearerwins"))).toBe(true);
    }
    expect(GENERATED_TEST_ACCOUNT_EMAIL.test(generatedGate())).toBe(true);
    for (const bad of [
      "pl-gate-1760000000001-abcdef@example.org",
      "pl-gate-1760000000001-abcdef@example.com.evil.org",
      "pl-gate-1760000000001-abcdef@sub.example.com",
      "pl-gate-1760000000001-abcdef@EXAMPLE.COM",
      "df-gate-1760000000001-abcdef@example.com",
      "x-pl-gate-1760000000001-abcdef@example.com",
      "pl-gate-17600000000-abcdef@example.com",
      "pl-gate-176000000000-abcdef@example.com",
      "pl-gate-17600000000000-abcdef@example.com",
      "pl-gate-1760000000001-abcdef@example.com\n",
      "\npl-gate-1760000000001-abcdef@example.com",
      "mask-1760000000001@example.test",
      "ec-real-mfx1abcd@example.com",
      "ab-full-loop-1760000000001-abcdef@nemar.test",
      "dcli--1760000000001-abcdef@nemar.test",
      "dcli-full-loop-1760000000001-@nemar.test",
      "dcli-full-loop-1760000000001-abcdefg@nemar.test",
      "dcli-full-loop-1760000000001-abcdef@nemar.test\n",
      "\ndcli-full-loop-1760000000001-abcdef@nemar.test",
      "dcli-full-loop-1760000000001-abcdef@nemar.test.evil.com",
      "dcli-full.loop-1760000000001-abcdef@nemar.test",
    ]) {
      expect(GENERATED_TEST_ACCOUNT_EMAIL.test(bad)).toBe(false);
    }
  });
});

describe("the batch bound", () => {
  test("a run takes the oldest accounts up to the bound, and the next run takes the rest", async () => {
    const total = TEST_ACCOUNT_SWEEP_BATCH + 7;
    const ids: number[] = [];
    for (let i = 0; i < total; i++) ids.push(seedUser(generated("pl", "bulk")));

    const first = await sweepCiTestAccounts(env());
    expect(first.tombstoned).toBe(TEST_ACCOUNT_SWEEP_BATCH);
    expect(ids.slice(0, TEST_ACCOUNT_SWEEP_BATCH).every(isTombstoned)).toBe(true);
    expect(ids.slice(TEST_ACCOUNT_SWEEP_BATCH).some(isTombstoned)).toBe(false);

    const second = await sweepCiTestAccounts(env());
    expect(second.tombstoned).toBe(7);
    expect(ids.every(isTombstoned)).toBe(true);

    const third = await sweepCiTestAccounts(env());
    expect(third.tombstoned).toBe(0);
  });

  test("rows the pattern rejects do not starve the batch", async () => {
    // Rows the SQL prefilter admits (it is looser than the pattern) but the pattern rejects: an
    // upper-case label. Enough of them, and OLDER than every real candidate, so a scan that
    // stopped at the first page of rejects would never reach the generated accounts behind them.
    for (let i = 0; i < TEST_ACCOUNT_SWEEP_BATCH + 20; i++) {
      seedUser(`pl-UPPER${i}-${1_760_000_100_000 + i}-abcdef@nemar.test`, { ageDays: 90 });
    }
    const target = seedUser(generated("pl"), { ageDays: 10 });
    const result = await sweepCiTestAccounts(env());
    expect(isTombstoned(target)).toBe(true);
    expect(result.tombstoned).toBe(1);
    expect(result.skipped).toBe(TEST_ACCOUNT_SWEEP_BATCH + 20);
  });
});

describe("it cannot run in production", () => {
  for (const environment of ["production", "prod", "", "Production-Mirror", undefined]) {
    test(`ENVIRONMENT ${JSON.stringify(environment)} does nothing`, async () => {
      const id = seedUser(generated("dcli"));
      const before = snapshot(id);
      const result = await sweepCiTestAccounts(env(environment));
      expect(result).toEqual({ ran: false, examined: 0, tombstoned: 0, skipped: 0, errors: 0 });
      expect(snapshot(id)).toBe(before);
    });
  }

  for (const environment of ["development", "staging", "test"]) {
    test(`ENVIRONMENT ${environment} runs`, async () => {
      seedUser(generated("dcli"));
      expect((await sweepCiTestAccounts(env(environment))).ran).toBe(true);
    });
  }
});

describe("the owner-only delete route shares the tombstone", () => {
  test("the route and the sweep leave the same row and the same cascade", async () => {
    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app.route("/admin", adminRoutes);
    db.run(
      `INSERT INTO users (username, email, status, role, email_verified, account_kind)
       VALUES ('sweepowner', 'sweepowner@nemar.test', 'approved', 'owner', 1, 'service')`,
    );
    const ownerId = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'sweepowner'")
      .get()?.id as number;
    await db
      .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
      .run(ownerId, await hashApiKey(OWNER_KEY), OWNER_KEY.slice(0, 8));

    const viaRoute = seedUser(generated("pl", "route"));
    const viaSweep = seedUser(generated("pl", "sweep"));
    for (const id of [viaRoute, viaSweep]) {
      await db
        .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
        .run(id, await hashApiKey(`key-${id}`.padEnd(40, "x")), `key-${id}`.padEnd(8, "x"));
      db.run(
        "INSERT INTO docs_grants (code_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))",
        [`g${id}`, id],
      );
    }

    const res = await app.request(
      `/admin/users/by-id/${viaRoute}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${OWNER_KEY}` } },
      {
        DB: realD1(db),
        ENVIRONMENT: "test",
        RESEND_API_KEY: "",
      } as unknown as Bindings,
    );
    expect(res.status).toBe(200);
    await sweepCiTestAccounts(env());

    const shape = (id: number) => {
      const u = db.query("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown>;
      // Fields that legitimately differ between two rows.
      const { id: _id, email, created_at: _c, updated_at: _u, deleted_at, revoked_at, ...rest } = u;
      return JSON.stringify({
        ...rest,
        masked: email === maskedDeletedEmail(id),
        deleted: deleted_at != null,
        revoked: revoked_at != null,
        tokens: count(
          "SELECT COUNT(*) AS n FROM tokens WHERE user_id = ? AND revoked_at IS NULL",
          id,
        ),
        grants: count("SELECT COUNT(*) AS n FROM docs_grants WHERE user_id = ?", id),
      });
    };
    expect(shape(viaSweep)).toBe(shape(viaRoute));
    expect(JSON.parse(shape(viaRoute)).masked).toBe(true);
  });
});

/** A real trigger that makes the tombstone of one id fail, as a constraint violation would. */
function failTombstoneOf(id: number): void {
  db.exec(
    `CREATE TRIGGER fail_tombstone_${id} BEFORE UPDATE ON users
     WHEN OLD.id = ${id} AND NEW.deleted_at IS NOT NULL
     BEGIN SELECT RAISE(ABORT, 'forced failure'); END`,
  );
}

describe("failures", () => {
  test("a failed tombstone leaves the row whole, the loop goes on, and it counts toward the batch", async () => {
    const ids: number[] = [];
    for (let i = 0; i < TEST_ACCOUNT_SWEEP_BATCH + 10; i++)
      ids.push(seedUser(generated("pl", "bulk")));
    const failing = ids.slice(0, 3);
    const failingBefore = failing.map(snapshot);
    for (const id of failing) failTombstoneOf(id);
    // A live key on a failing row: the batch is one transaction, so it must survive too.
    await db
      .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
      .run(failing[0], await hashApiKey("f".repeat(40)), "ffffffff");

    const result = await sweepCiTestAccounts(env());

    expect(result.errors).toBe(3);
    expect(result.tombstoned).toBe(TEST_ACCOUNT_SWEEP_BATCH - 3);
    expect(failing.map(snapshot)).toEqual(failingBefore);
    expect(
      count(
        "SELECT COUNT(*) AS n FROM tokens WHERE user_id = ? AND revoked_at IS NULL",
        failing[0],
      ),
    ).toBe(1);
    // The loop went past the failures, and the bound counted them: 97 done, 3 failed, 10 untouched.
    expect(ids.slice(3, TEST_ACCOUNT_SWEEP_BATCH).every(isTombstoned)).toBe(true);
    expect(ids.slice(TEST_ACCOUNT_SWEEP_BATCH).some(isTombstoned)).toBe(false);
  });

  test("a candidate read that fails after some work keeps the tally and reports the error", async () => {
    // Three real candidates, then enough look-alikes to fill the first page, so a second read
    // is needed and is the one that fails.
    for (let i = 0; i < 3; i++) seedUser(generated("df", "early"));
    for (let i = 0; i < TEST_ACCOUNT_SWEEP_BATCH - 3; i++) {
      seedUser(`pl-UPPER${i}-${1_760_000_200_000 + i}-abcdef@nemar.test`);
    }
    let reads = 0;
    const flaky = interceptingD1(realD1(db), (sql) => {
      if (sql === TEST_ACCOUNT_SWEEP_CANDIDATES_SQL && ++reads === 2) {
        throw new Error("candidate read failed");
      }
    });

    const result = await sweepCiTestAccounts({ DB: flaky, ENVIRONMENT: "test" });

    expect(reads).toBe(2);
    expect(result).toEqual({
      ran: true,
      examined: TEST_ACCOUNT_SWEEP_BATCH,
      tombstoned: 3,
      skipped: TEST_ACCOUNT_SWEEP_BATCH - 3,
      errors: 1,
    });
  });

  test("more look-alikes than the scan cap: the run still ends, reading at most the cap", async () => {
    for (let i = 0; i < TEST_ACCOUNT_SWEEP_SCAN_CAP + 20; i++) {
      seedUser(`pl-UPPER${i}-${1_760_000_300_000 + i}-abcdef@nemar.test`, { ageDays: 90 });
    }
    const behind = seedUser(generated("pl"), { ageDays: 10 });

    const result = await sweepCiTestAccounts(env());

    expect(result.examined).toBe(TEST_ACCOUNT_SWEEP_SCAN_CAP);
    expect(result.skipped).toBe(TEST_ACCOUNT_SWEEP_SCAN_CAP);
    // The documented ceiling: the real candidate sits behind the window, and the audit row shows it
    // (examined at the cap, tombstoned at zero).
    expect(result.tombstoned).toBe(0);
    expect(isTombstoned(behind)).toBe(false);
  });

  test("a row whose address changed between the read and the write is left whole", async () => {
    const id = seedUser(generated("pl", "racy"));
    await db
      .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
      .run(id, await hashApiKey("r".repeat(40)), "rrrrrrrr");
    db.run(
      "INSERT INTO auth_codes (email, code_hash, expires_at) SELECT email, 'c', datetime('now', '+1 hour') FROM users WHERE id = ?",
      [id],
    );
    const real = realD1(db);
    // Another writer lands between the sweep's read and its write, through the real database.
    const racing = {
      ...real,
      batch: async (stmts: unknown[]) => {
        db.run("UPDATE users SET email = 'someone.real@example.org' WHERE id = ?", [id]);
        return (real as unknown as { batch(s: unknown[]): Promise<unknown> }).batch(stmts);
      },
    } as unknown as D1Database;

    const result = await sweepCiTestAccounts({ DB: racing, ENVIRONMENT: "test" });

    expect(result).toEqual({ ran: true, examined: 1, tombstoned: 0, skipped: 1, errors: 0 });
    const row = db
      .query<{ email: string; status: string; deleted_at: string | null }, [number]>(
        "SELECT email, status, deleted_at FROM users WHERE id = ?",
      )
      .get(id);
    expect(row).toEqual({
      email: "someone.real@example.org",
      status: "verified",
      deleted_at: null,
    });
    expect(
      count("SELECT COUNT(*) AS n FROM tokens WHERE user_id = ? AND revoked_at IS NULL", id),
    ).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM auth_codes WHERE used_at IS NOT NULL")).toBe(0);
  });
});

describe("the cleanup section the audit row is built from", () => {
  test("success: the sweep's tally, in exactly the audit row's shape", async () => {
    seedUser(generated("dcli"));
    seedUser(generatedGate());
    const tally = await cleanUpLiveTestAccounts(env());
    expect(tally).toEqual({ ran: true, examined: 2, tombstoned: 2, skipped: 0, errors: 0 });
    expect(Object.keys(tally).sort()).toEqual(Object.keys(TEST_ACCOUNT_SWEEP_NOT_RUN).sort());
  });

  test("failure: the error is in the tally, and the run still returns", async () => {
    const bad = seedUser(generated("df"));
    const good = seedUser(generated("df"));
    failTombstoneOf(bad);
    const tally = await cleanUpLiveTestAccounts(env());
    expect(tally).toEqual({ ran: true, examined: 2, tombstoned: 1, skipped: 0, errors: 1 });
    expect(isTombstoned(bad)).toBe(false);
    expect(isTombstoned(good)).toBe(true);
  });

  for (const environment of ["production", "", undefined]) {
    test(`ENVIRONMENT ${JSON.stringify(environment)}: did not run, nothing touched`, async () => {
      const id = seedUser(generated("pl"));
      const before = snapshot(id);
      expect(await cleanUpLiveTestAccounts(env(environment))).toEqual(TEST_ACCOUNT_SWEEP_NOT_RUN);
      expect(snapshot(id)).toBe(before);
    });
  }

  test("the not-run tally is frozen, so a caller cannot corrupt the shared constant", () => {
    expect(Object.isFrozen(TEST_ACCOUNT_SWEEP_NOT_RUN)).toBe(true);
  });
});

describe("tombstoneUserCascade", () => {
  function seedCollaboration(userId: number, datasetId: string): void {
    const owner = seedUser(`owner-${datasetId}@example.org`, { ageDays: 1 });
    db.run(
      "INSERT INTO datasets (dataset_id, name, owner_user_id, status) VALUES (?, 't', ?, 'active')",
      [datasetId, owner],
    );
    db.run(
      "INSERT INTO dataset_collaborators (dataset_id, user_id, access_type) SELECT id, ?, 'invited' FROM datasets WHERE dataset_id = ?",
      [userId, datasetId],
    );
  }

  const collaborations = (id: number) =>
    count("SELECT COUNT(*) AS n FROM dataset_collaborators WHERE user_id = ?", id);

  test("removes the user's collaborations, called directly with and without the address guard", async () => {
    const plain = seedUser("plain@example.org");
    const guarded = seedUser("guarded@example.org");
    seedCollaboration(plain, "xx090201");
    seedCollaboration(guarded, "xx090202");

    expect((await tombstoneUserCascade(realD1(db), plain, "plain@example.org")).tombstoned).toBe(
      true,
    );
    expect(
      (
        await tombstoneUserCascade(
          realD1(db),
          guarded,
          "guarded@example.org",
          "guarded@example.org",
        )
      ).tombstoned,
    ).toBe(true);

    expect(collaborations(plain)).toBe(0);
    expect(collaborations(guarded)).toBe(0);
  });

  test("the address guard protects every statement, not only the mask", async () => {
    const id = seedUser("guarded2@example.org");
    seedCollaboration(id, "xx090203");
    await db
      .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
      .run(id, await hashApiKey("g".repeat(40)), "gggggggg");
    db.run(
      "INSERT INTO docs_grants (code_hash, user_id, expires_at) VALUES ('gg', ?, datetime('now', '+1 hour'))",
      [id],
    );
    db.run(
      "INSERT INTO user_s3_permissions (user_id, s3_prefix, permission) VALUES (?, 'p/', 'read')",
      [id],
    );
    const before = snapshot(id);

    const done = await tombstoneUserCascade(
      realD1(db),
      id,
      "guarded2@example.org",
      "other@example.org",
    );

    expect(done).toEqual({ tombstoned: false, tokensRevoked: 0, sessionsRevoked: 0 });
    expect(snapshot(id)).toBe(before);
    expect(collaborations(id)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM docs_grants WHERE user_id = ?", id)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM user_s3_permissions WHERE user_id = ?", id)).toBe(1);
    expect(
      count("SELECT COUNT(*) AS n FROM tokens WHERE user_id = ? AND revoked_at IS NULL", id),
    ).toBe(1);
  });

  test("a guarded call on an already-masked row leaves the address's new holder's login codes alone", async () => {
    const address = "reused@example.org";
    const old = seedUser(address);
    // An earlier tombstone masked the row, and the address was registered again.
    await tombstoneUserCascade(realD1(db), old, address);
    seedUser(address);
    db.run(
      "INSERT INTO auth_codes (email, code_hash, expires_at) VALUES (?, 'c', datetime('now', '+1 hour'))",
      [address],
    );

    const done = await tombstoneUserCascade(realD1(db), old, address, address);

    expect(done.tombstoned).toBe(false);
    expect(count("SELECT COUNT(*) AS n FROM auth_codes WHERE used_at IS NOT NULL")).toBe(0);
  });

  test("the owner-only route removes collaborations through the same function", async () => {
    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app.route("/admin", adminRoutes);
    db.run(
      `INSERT INTO users (username, email, status, role, email_verified, account_kind)
       VALUES ('collabowner', 'collabowner@nemar.test', 'approved', 'owner', 1, 'service')`,
    );
    const ownerId = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'collabowner'")
      .get()?.id as number;
    await db
      .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
      .run(ownerId, await hashApiKey(OWNER_KEY), OWNER_KEY.slice(0, 8));
    const target = seedUser("route-target@example.org");
    seedCollaboration(target, "xx090204");
    expect(collaborations(target)).toBe(1);

    const res = await app.request(
      `/admin/users/by-id/${target}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${OWNER_KEY}` } },
      { DB: realD1(db), ENVIRONMENT: "test", RESEND_API_KEY: "" } as unknown as Bindings,
    );

    expect(res.status).toBe(200);
    expect(collaborations(target)).toBe(0);
  });
});
