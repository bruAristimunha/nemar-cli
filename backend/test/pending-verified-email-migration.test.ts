/**
 * Migration 0096_pending_cannot_have_verified_email.sql (ADR 0103).
 *
 * Real engine, no mocks: bun:sqlite with every migration before 0096 applied,
 * rows seeded at that schema, then 0096 applied. Pins the repair (a stranded
 * row is promoted, nothing else moves) and the guard (the stranded shape can no
 * longer be written, while the legitimate transitions still can).
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");
const TARGET = "0096_pending_cannot_have_verified_email.sql";

function dbBeforeTarget(): Database {
  const db = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && f < TARGET)
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

function insert(db: Database, email: string, status: string, verified: number, deleted = false) {
  db.run(
    `INSERT INTO users (email, status, signup_source, email_verified, deleted_at, service_access)
     VALUES (?, ?, 'web', ?, ${deleted ? "datetime('now')" : "NULL"}, 0)`,
    [email, status, verified],
  );
}

function row(db: Database, email: string) {
  return db
    .query<{ status: string; email_verified: number; service_access: number }, [string]>(
      "SELECT status, email_verified, service_access FROM users WHERE email = ?",
    )
    .get(email);
}

describe("0096 pending cannot have a verified email", () => {
  test("promotes stranded rows and leaves every other row alone", () => {
    const db = dbBeforeTarget();
    insert(db, "stranded@nemar.test", "pending", 1);
    insert(db, "unverified@nemar.test", "pending", 0);
    insert(db, "verified@nemar.test", "verified", 1);
    insert(db, "approved@nemar.test", "approved", 1);
    insert(db, "revoked@nemar.test", "revoked", 1);
    insert(db, "deleted@nemar.test", "pending", 1, true);

    db.exec(readFileSync(join(MIGRATIONS_DIR, TARGET), "utf8"));

    expect(row(db, "stranded@nemar.test")).toEqual({
      status: "verified",
      email_verified: 1,
      service_access: 0,
    });
    // One audit row, for the repaired account only.
    const audit = db
      .query<{ resource_id: string; details: string }, []>(
        "SELECT resource_id, details FROM audit_log WHERE action = 'email_verified'",
      )
      .all();
    const strandedId = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE email = 'stranded@nemar.test'")
      .get()?.id;
    expect(audit.map((r) => r.resource_id)).toEqual([String(strandedId)]);
    expect(JSON.parse(audit[0].details).via).toBe("migration_0096");
    expect(row(db, "unverified@nemar.test")?.status).toBe("pending");
    expect(row(db, "verified@nemar.test")?.status).toBe("verified");
    expect(row(db, "approved@nemar.test")?.status).toBe("approved");
    expect(row(db, "revoked@nemar.test")?.status).toBe("revoked");
    expect(row(db, "deleted@nemar.test")?.status).toBe("pending");
  });

  test("the guard refuses the stranded shape and allows the real transitions", () => {
    const db = dbBeforeTarget();
    db.exec(readFileSync(join(MIGRATIONS_DIR, TARGET), "utf8"));
    insert(db, "a@nemar.test", "pending", 0);

    // Stamping the flag alone is the bug.
    expect(() =>
      db.run("UPDATE users SET email_verified = 1 WHERE email = 'a@nemar.test'"),
    ).toThrow(/pending account cannot have a verified email/);
    expect(row(db, "a@nemar.test")?.email_verified).toBe(0);

    // Both columns in one statement is the promotion.
    db.run("UPDATE users SET status = 'verified', email_verified = 1 WHERE email = 'a@nemar.test'");
    expect(row(db, "a@nemar.test")?.status).toBe("verified");

    // A verified account moving to revoked, or an admin edit that resets the
    // flag, are not the guarded shape.
    db.run("UPDATE users SET status = 'revoked' WHERE email = 'a@nemar.test'");
    db.run("UPDATE users SET status = 'pending', email_verified = 0 WHERE email = 'a@nemar.test'");
    expect(row(db, "a@nemar.test")?.status).toBe("pending");
  });
});
