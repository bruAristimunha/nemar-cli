/**
 * Real behavioral test for the user tombstone (soft delete), epic #695.
 *
 * Runs against the FULL migrated schema (`freshDb()`, every migration applied in order, so the
 * test sees the columns and tables production has) and drives the SHARED cascade the endpoint and
 * the scheduled sweep both call (`tombstoneUserCascade` from backend/src/db/user-tombstone.ts), so
 * a statement added to it is exercised here without anyone remembering to copy it. It asserts the
 * load-bearing security properties:
 *   - PII is masked + credentials revoked
 *   - the original email/username/github are freed for re-signup (UNIQUE-safe)
 *   - the auth chokepoint predicates (`u.deleted_at IS NULL`) exclude the row
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  USER_TOMBSTONE_MASK_SQL,
  maskedDeletedEmail,
  tombstoneUserCascade,
} from "../backend/src/db/user-tombstone";
import { freshDb, realD1 } from "../backend/test/helpers/d1";

function seed(db: Database) {
  // Populate every column the mask is supposed to null/rewrite, so an assertion
  // can prove the mask actually cleared it (a column NULL in the seed would pass
  // even if the mask SQL typo'd its name).
  db.run(
    `INSERT INTO users (id, username, email, password_hash, github_username, status, email_verified,
        verification_token, verification_expires_at, role, orcid, orcid_verified, description,
        aws_iam_username, aws_access_key_id_encrypted, aws_secret_access_key_encrypted,
        service_access, service_access_granted_at, service_access_granted_by,
        upload_access_requested_at)
     VALUES (42, 'testuser', 'real@example.com', 'argon2hash', 'ghuser', 'approved', 1,
        'verifytok', '2099-01-01T00:00:00Z', 'member', '0000-0002-1974-1293', 1, 'a bio',
        'iam-user', 'enc-key-id', 'enc-secret',
        1, '2026-09-01T00:00:00Z', 7,
        '2026-08-30T00:00:00Z')`,
  );
  db.run(
    "INSERT INTO tokens (user_id, api_key_hash, api_key_prefix, revoked_at) VALUES (42, 'tokenhash', 'tokenpfx', NULL)",
  );
  db.run(
    "INSERT INTO web_sessions (user_id, cookie_id_hash, revoked_at, expires_at) VALUES (42, 'cookiehash', NULL, datetime('now', '+30 days'))",
  );
  // An outstanding (unused) login code issued for the original email.
  db.run(
    "INSERT INTO auth_codes (email, code_hash, used_at, expires_at) VALUES ('real@example.com', 'codehash', NULL, datetime('now', '+10 minutes'))",
  );
}

// The real cascade, through the D1-shaped passthrough over the migrated SQLite database.
async function tombstone(db: Database, id: number, originalEmail = "real@example.com") {
  await tombstoneUserCascade(realD1(db), id, originalEmail);
}

describe("user tombstone (soft delete)", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb(); // every real migration, including 0037's deleted_at column
    seed(db);
  });

  test("migration 0037 adds a queryable deleted_at column", () => {
    const cols = db.query("PRAGMA table_info(users)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "deleted_at")).toBe(true);
  });

  test("masks PII, zeroes both verified flags, stamps deleted_at, revokes creds", async () => {
    await tombstone(db, 42);
    const row = db
      .query(
        "SELECT email, username, github_username, password_hash, orcid, orcid_verified, description, email_preferences, email_verified, verification_token, verification_expires_at, aws_iam_username, aws_access_key_id_encrypted, aws_secret_access_key_encrypted, status, deleted_at, revoked_at FROM users WHERE id = 42",
      )
      .get() as Record<string, unknown>;
    expect(row.email).toBe("deleted+42@deleted.invalid");
    expect(row.username).toBeNull();
    expect(row.github_username).toBeNull();
    expect(row.password_hash).toBeNull();
    expect(row.orcid).toBeNull();
    // Cleared WITH users.orcid (#1254, ADR 0043). Leaving it at 1 leaves the
    // row asserting it proved an iD it no longer has -- observed on production
    // row 42 after it was soft-deleted, and the same half-state that made 42
    // and 43 two accounts for one person in the first place.
    expect(row.orcid_verified).toBe(0);
    expect(row.description).toBeNull();
    expect(row.email_preferences).toBeNull();
    expect(row.email_verified).toBe(0);
    expect(row.verification_token).toBeNull();
    expect(row.verification_expires_at).toBeNull();
    expect(row.aws_iam_username).toBeNull();
    expect(row.aws_access_key_id_encrypted).toBeNull();
    expect(row.aws_secret_access_key_encrypted).toBeNull();
    expect(row.status).toBe("revoked");
    expect(row.deleted_at).not.toBeNull();
    expect(row.revoked_at).not.toBeNull();

    const tok = db.query("SELECT revoked_at FROM tokens WHERE user_id = 42").get() as {
      revoked_at: string | null;
    };
    const sess = db.query("SELECT revoked_at FROM web_sessions WHERE user_id = 42").get() as {
      revoked_at: string | null;
    };
    expect(tok.revoked_at).not.toBeNull();
    expect(sess.revoked_at).not.toBeNull();
  });

  test("clears the upload grant and the request behind it (ADR 0040/0042)", async () => {
    // The mask used to leave all four set while forcing status='revoked', so a
    // tombstoned row sat on the granted side of the `status='approved' <=>
    // service_access=1` invariant, and `upload_access_requested_at` with no
    // grant is what the admin review queue reads as an OPEN request -- from an
    // account with nobody left to review. POST /admin/revoke has always cleared
    // exactly these four; the harder stop has to clear at least as much.
    const columns =
      "service_access, service_access_granted_at, service_access_granted_by, upload_access_requested_at";
    const before = db.query(`SELECT ${columns} FROM users WHERE id = 42`).get() as Record<
      string,
      unknown
    >;
    // Proves the assertions below are clearing something: a seed that left
    // these NULL would pass even if the mask never named the columns.
    expect(before).toEqual({
      service_access: 1,
      service_access_granted_at: "2026-09-01T00:00:00Z",
      service_access_granted_by: 7,
      upload_access_requested_at: "2026-08-30T00:00:00Z",
    });

    await tombstone(db, 42);

    const after = db.query(`SELECT ${columns} FROM users WHERE id = 42`).get() as Record<
      string,
      unknown
    >;
    expect(after).toEqual({
      service_access: 0,
      service_access_granted_at: null,
      service_access_granted_by: null,
      upload_access_requested_at: null,
    });
  });

  test("expires outstanding login codes for the original email", async () => {
    await tombstone(db, 42);
    const code = db
      .query("SELECT used_at FROM auth_codes WHERE email = 'real@example.com'")
      .get() as { used_at: string | null };
    expect(code.used_at).not.toBeNull();
  });

  test("two tombstones produce distinct masked emails (no UNIQUE collision)", async () => {
    db.run(
      "INSERT INTO users (id, username, email, status) VALUES (43, 'u43', 'u43@example.com', 'approved')",
    );
    await tombstone(db, 42);
    await expect(tombstone(db, 43, "u43@example.com")).resolves.toBeUndefined();
    const emails = db.query("SELECT email FROM users WHERE id IN (42, 43) ORDER BY id").all() as {
      email: string;
    }[];
    expect(emails.map((e) => e.email)).toEqual([
      "deleted+42@deleted.invalid",
      "deleted+43@deleted.invalid",
    ]);
  });

  test("frees the original email/username/github for re-signup (UNIQUE-safe)", async () => {
    await tombstone(db, 42);
    // A fresh signup reusing the deleted user's identifiers must not 409.
    expect(() =>
      db.run(
        "INSERT INTO users (username, email, github_username, status) VALUES ('testuser', 'real@example.com', 'ghuser', 'pending')",
      ),
    ).not.toThrow();
  });

  test("re-running the mask is idempotent (matches 0 rows, no error)", async () => {
    await tombstone(db, 42);
    const before = db.query("SELECT deleted_at FROM users WHERE id = 42").get() as {
      deleted_at: string;
    };
    // The `AND deleted_at IS NULL` guard means the second mask updates nothing.
    db.query(USER_TOMBSTONE_MASK_SQL).run(maskedDeletedEmail(42), 42);
    const after = db.query("SELECT deleted_at FROM users WHERE id = 42").get() as {
      deleted_at: string;
    };
    expect(after.deleted_at).toBe(before.deleted_at);
  });

  test("bearer-token auth predicate excludes the tombstoned user", async () => {
    await tombstone(db, 42);
    // Mirrors middleware/auth.ts authMiddleware: token JOIN users with the new
    // `AND u.deleted_at IS NULL` guard. Returns no row even though we query the
    // (revoked) token directly — independent of token cleanup.
    const row = db
      .query(
        `SELECT u.id FROM tokens t JOIN users u ON t.user_id = u.id
         WHERE t.api_key_hash = 'tokenhash' AND u.deleted_at IS NULL`,
      )
      .get();
    expect(row).toBeNull();
  });

  test("cookie-session auth predicate excludes the tombstoned user", async () => {
    await tombstone(db, 42);
    // Mirrors resolveCookieUser / findSessionByCookieId with `AND u.deleted_at IS NULL`.
    const row = db
      .query(
        `SELECT u.id FROM web_sessions ws JOIN users u ON u.id = ws.user_id
         WHERE ws.cookie_id_hash = 'cookiehash' AND u.deleted_at IS NULL`,
      )
      .get();
    expect(row).toBeNull();
  });

  test("admin list/stats predicate hides the tombstone but a live user remains", async () => {
    db.run(
      "INSERT INTO users (id, username, email, status) VALUES (43, 'live', 'live@example.com', 'approved')",
    );
    await tombstone(db, 42);
    const approved = db
      .query("SELECT COUNT(*) AS n FROM users WHERE status = 'approved' AND deleted_at IS NULL")
      .get() as { n: number };
    expect(approved.n).toBe(1); // only the live user, not the tombstoned one
  });
});
