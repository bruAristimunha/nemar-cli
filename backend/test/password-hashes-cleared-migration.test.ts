/**
 * Migration 0093_clear_password_hashes.sql (ADR 0097).
 *
 * Real engine, no mocks: bun:sqlite with every migration before 0093 applied,
 * `users` seeded at that schema, then 0093 applied and the table compared with
 * what was there before.
 *
 * The migration does one thing, so the properties worth pinning are the ways it
 * could do too little or too much:
 *   - too little: a hash left on some KIND of row. The seed carries a hash on
 *     every combination of status and role (pending and unverified rows are what
 *     signup wrote; admins and owners are the rows an over-narrow WHERE would
 *     skip), plus a soft-deleted row.
 *   - too much: any column other than `password_hash` changing, `updated_at`
 *     included, or the `tokens` table changing. API keys are in use and must
 *     survive: a migration that touched them would sign everyone out.
 *   - the column itself is still there and still nullable, because dropping it
 *     is deliberately not part of this change.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");
const TARGET = "0093_clear_password_hashes.sql";
const GUARD = "0094_guard_retired_password_signup.sql";
const HASH = "$2b$10$JmaHDE03Q2pjaBgWB4jeN.mgLCp9WdSWRpicN4J5gAiJ/YZBRPWIi";

const STATUSES = ["pending", "verified", "approved", "revoked"] as const;
const ROLES = ["member", "admin", "owner"] as const;
/** One hash per status and role, plus the soft-deleted row below. */
const HASHED_ROWS = STATUSES.length * ROLES.length + 1;

function dbBeforeTarget(): Database {
  const db = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && f < TARGET)
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }
  return db;
}

function applyTarget(db: Database): void {
  db.exec(readFileSync(join(MIGRATIONS_DIR, TARGET), "utf-8"));
}

function applyGuard(db: Database): void {
  db.exec(readFileSync(join(MIGRATIONS_DIR, GUARD), "utf-8"));
}

function applyGuardTriggerOnly(db: Database): void {
  const migration = readFileSync(join(MIGRATIONS_DIR, GUARD), "utf-8");
  const cleanup = migration.indexOf("UPDATE users SET password_hash");
  if (cleanup < 0) throw new Error("0094 hash cleanup statement is missing");
  db.exec(migration.slice(0, cleanup));
}

function seed(db: Database): void {
  // Every status x role, each with a hash. `email_verified` follows the status
  // the way signup left it, so the pending rows are the unverified ones.
  for (const status of STATUSES) {
    for (const role of ROLES) {
      db.run(
        `INSERT INTO users (username, email, password_hash, github_username, status, role,
                            signup_source, email_verified, description, city, country)
         VALUES (?, ?, ?, ?, ?, ?, 'cli', ?, 'a description worth keeping', 'San Diego', 'USA')`,
        [
          `${status}-${role}`,
          `${status}-${role}@example.org`,
          HASH,
          `${status}-${role}-gh`,
          status,
          role,
          status === "pending" ? 0 : 1,
        ],
      );
    }
  }
  // A soft-deleted row that somehow still carries a hash.
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role,
                        signup_source, email_verified, deleted_at)
     VALUES (NULL, 'deleted+9@deleted.invalid', ?, NULL, 'revoked', 'member',
             'cli', 1, '2026-01-01 00:00:00')`,
    [HASH],
  );
  // A web account: never had a password, the column is already NULL.
  db.run(
    `INSERT INTO users (username, email, github_username, status, role, signup_source, email_verified)
     VALUES (NULL, 'web@example.org', NULL, 'verified', 'member', 'web', 1)`,
  );
  // A live API key for a password-era account. Keys must survive the migration.
  db.run(
    `INSERT INTO tokens (user_id, api_key_hash, api_key_prefix, name)
     SELECT id, 'sha256-of-a-real-key', 'nemar_ab', 'kept'
       FROM users WHERE username = 'approved-member'`,
  );
}

function hashedCount(db: Database): number {
  return (
    db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users WHERE password_hash IS NOT NULL")
      .get()?.n ?? -1
  );
}

/** Every column of every user row except `password_hash`. `updated_at` is
 *  included on purpose: this migration has no reason to touch it. */
function everythingButHash(db: Database): unknown[] {
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(users)")
    .all()
    .map((c) => c.name)
    .filter((n) => n !== "password_hash");
  return db.query(`SELECT ${cols.join(", ")} FROM users ORDER BY id`).all();
}

describe("0093_clear_password_hashes", () => {
  test("no row keeps a hash, whatever its status, role or state", () => {
    const db = dbBeforeTarget();
    seed(db);
    expect(hashedCount(db)).toBe(HASHED_ROWS);

    applyTarget(db);

    expect(hashedCount(db)).toBe(0);
  });

  test("nothing but the hash changes, updated_at included", () => {
    const db = dbBeforeTarget();
    seed(db);
    const before = everythingButHash(db);
    // The seeded rows plus the internal system account (id -1, migration
    // 0029), which every database carries.
    expect(before.length).toBe(HASHED_ROWS + 1 + 1);

    applyTarget(db);

    expect(everythingButHash(db)).toEqual(before);
  });

  test("API keys are untouched", () => {
    const db = dbBeforeTarget();
    seed(db);
    const before = db.query("SELECT * FROM tokens ORDER BY id").all();
    expect(before.length).toBe(1);

    applyTarget(db);

    expect(db.query("SELECT * FROM tokens ORDER BY id").all()).toEqual(before);
  });

  test("it can be applied twice and the second run changes nothing", () => {
    const db = dbBeforeTarget();
    seed(db);
    applyTarget(db);
    const after = db.query("SELECT * FROM users ORDER BY id").all();

    applyTarget(db);

    expect(db.query("SELECT * FROM users ORDER BY id").all()).toEqual(after);
  });

  test("the column survives and stays nullable", () => {
    const db = dbBeforeTarget();
    applyTarget(db);
    const col = db
      .query<{ name: string; notnull: number }, []>("PRAGMA table_info(users)")
      .all()
      .find((c) => c.name === "password_hash");
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(0);
  });
});

describe("0094_guard_retired_password_signup", () => {
  test("clears a hash written during migration-first rollout and blocks the old signup insert", () => {
    const db = dbBeforeTarget();
    seed(db);
    applyTarget(db);

    // The previous Worker remains live briefly after 0093 and its old signup route
    // writes this pending, unverified CLI shape with a verification token.
    db.run(
      `INSERT INTO users (username, email, password_hash, verification_token)
       VALUES ('late-signup', 'late-signup@example.org', ?, 'verification-token')`,
      [HASH],
    );
    expect(hashedCount(db)).toBe(1);
    const usersBeforeGuard = everythingButHash(db);
    const tokensBeforeGuard = db.query("SELECT * FROM tokens ORDER BY id").all();

    // D1 may leave the first statement applied if the later UPDATE fails. A
    // replay must keep the guard and still finish clearing the late hash.
    applyGuardTriggerOnly(db);
    expect(hashedCount(db)).toBe(1);
    applyGuard(db);

    expect(hashedCount(db)).toBe(0);
    expect(everythingButHash(db)).toEqual(usersBeforeGuard);
    expect(db.query("SELECT * FROM tokens ORDER BY id").all()).toEqual(tokensBeforeGuard);
    const afterGuard = db.query("SELECT * FROM users ORDER BY id").all();
    applyGuard(db);
    expect(db.query("SELECT * FROM users ORDER BY id").all()).toEqual(afterGuard);
    expect(() =>
      db.run(
        `INSERT INTO users (username, email, password_hash, verification_token)
         VALUES ('blocked-signup', 'blocked-signup@example.org', ?, 'verification-token')`,
        [HASH],
      ),
    ).toThrow(/password sign-in has been retired/);
    expect(hashedCount(db)).toBe(0);
  });
});
