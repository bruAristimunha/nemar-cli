/**
 * POST /admin/users/by-id/:id/verify: the owner's recovery for a stuck
 * pending account (ADR 0040). Real engine: bun:sqlite behind realD1 with every
 * migration applied and the real admin router. No mocks.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { SYSTEM_USER_ID } from "../src/lib/constants";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, interceptingD1, realD1 } from "./helpers/d1";

const OWNER_KEY = "verify-route-owner-key-0123456789abcdef012345";
const ADMIN_KEY = "verify-route-admin-key-0123456789abcdef012345";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

async function seedActor(username: string, role: "owner" | "admin", apiKey: string) {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access)
     VALUES (?, ?, 'x', 'approved', ?, 1, 1)`,
  ).run(username, `${username}@example.org`, role);
  const u = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!u) throw new Error("seed: actor insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(apiKey),
    apiKey.slice(0, 8),
  );
}

let orcidCounter = 0;

function seedWeb(email: string, status: string, emailVerified = 0): number {
  orcidCounter += 1;
  // One ORCID per seeded row: the unique constraint (ADR 0043) makes a
  // collision here a failed seed, so the suffix comes from a counter, not luck.
  const orcid = `0000-0002-7777-${String(1000 + orcidCounter)}`;
  db.query(
    `INSERT INTO users (email, status, signup_source, email_verified, orcid, orcid_verified, service_access)
     VALUES (?, ?, 'web', ?, ?, 1, 0)`,
  ).run(email, status, emailVerified, orcid);
  const row = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!row) throw new Error("seed failed");
  return row.id;
}

function row(id: number) {
  return db
    .query<{ status: string; email_verified: number; service_access: number }, [number]>(
      "SELECT status, email_verified, service_access FROM users WHERE id = ?",
    )
    .get(id);
}

function verify(
  id: string | number,
  apiKey: string | null,
  d1: D1Database = realD1(db),
): Promise<Response> {
  return app.request(
    `/admin/users/by-id/${id}/verify`,
    { method: "POST", headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} },
    { DB: d1, ENVIRONMENT: "test" } as Bindings,
  );
}

function auditCount(action: string): number {
  return (
    db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?")
      .get(action)?.n ?? 0
  );
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedActor("verifyowner", "owner", OWNER_KEY);
  await seedActor("verifyadmin", "admin", ADMIN_KEY);
});

describe("POST /admin/users/by-id/:id/verify", () => {
  test("an owner moves a pending account to verified, grants no upload access, and is audited", async () => {
    const id = seedWeb("stuck@nemar.test", "pending");

    const res = await verify(id, OWNER_KEY);

    expect(res.status).toBe(200);
    expect(row(id)).toEqual({ status: "verified", email_verified: 1, service_access: 0 });
    const owner = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'verifyowner'")
      .get();
    const audit = db
      .query<{ user_id: number; resource_id: string }, []>(
        "SELECT user_id, resource_id FROM audit_log WHERE action = 'email_verified_by_owner'",
      )
      .all();
    expect(audit).toEqual([{ user_id: owner?.id as number, resource_id: String(id) }]);
    // The transition row records how it happened.
    const transition = db
      .query<{ details: string }, []>(
        "SELECT details FROM audit_log WHERE action = 'email_verified'",
      )
      .all();
    expect(transition.map((r) => JSON.parse(r.details).via)).toEqual(["owner_override"]);
  });

  test("a soft-deleted account is 404 and stays pending", async () => {
    const id = seedWeb("gone@nemar.test", "pending");
    db.run("UPDATE users SET deleted_at = datetime('now') WHERE id = ?", [id]);
    expect((await verify(id, OWNER_KEY)).status).toBe(404);
    expect(row(id)?.status).toBe("pending");
  });

  test("an admin who is not an owner gets 403 and nothing changes", async () => {
    const id = seedWeb("stuck2@nemar.test", "pending");
    expect((await verify(id, ADMIN_KEY)).status).toBe(403);
    expect(row(id)?.status).toBe("pending");
  });

  test("only pending accounts: verified, approved and revoked answer 409 and are left alone", async () => {
    const verified = seedWeb("v@nemar.test", "verified", 1);
    const approved = seedWeb("a@nemar.test", "approved", 1);
    const revoked = seedWeb("r@nemar.test", "revoked", 1);
    for (const [id, status] of [
      [verified, "verified"],
      [approved, "approved"],
      [revoked, "revoked"],
    ] as const) {
      const res = await verify(id, OWNER_KEY);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { status: string }).status).toBe(status);
      expect(row(id)?.status).toBe(status);
    }
    expect(auditCount("email_verified_by_owner")).toBe(0);
    expect(auditCount("email_verified")).toBe(0);
  });

  test("unknown id is 404, malformed or negative id is 400", async () => {
    expect((await verify(99999, OWNER_KEY)).status).toBe(404);
    expect((await verify("abc", OWNER_KEY)).status).toBe(400);
    expect((await verify(-5, OWNER_KEY)).status).toBe(400);
    expect((await verify(0, OWNER_KEY)).status).toBe(400);
  });

  test("the system user id is 400 even though its row exists and is not pending", async () => {
    expect(
      db.query<{ id: number }, [number]>("SELECT id FROM users WHERE id = ?").get(SYSTEM_USER_ID),
    ).not.toBeNull();
    const res = await verify(SYSTEM_USER_ID, OWNER_KEY);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Invalid user id");
  });

  test("no credentials is 401 and nothing changes", async () => {
    const id = seedWeb("stuck3@nemar.test", "pending");
    expect((await verify(id, null)).status).toBe(401);
    expect((await verify(id, "not-a-real-key-0123456789abcdef0123456789")).status).toBe(401);
    expect(row(id)?.status).toBe("pending");
  });

  test("a failed owner audit write is logged, not propagated: the verification stands", async () => {
    const id = seedWeb("auditgap@nemar.test", "pending");
    const failing = interceptingD1(realD1(db), (sql) => {
      if (sql.includes("INSERT INTO audit_log")) throw new Error("audit write refused");
    });

    const res = await verify(id, OWNER_KEY, failing);

    expect(res.status).toBe(200);
    expect(row(id)).toEqual({ status: "verified", email_verified: 1, service_access: 0 });
    expect(auditCount("email_verified_by_owner")).toBe(0);
  });

  test("losing the race to a concurrent revoke is 409, with no promotion and no audit rows", async () => {
    const id = seedWeb("raced@nemar.test", "pending");
    // A second writer revokes the account after the route has read it as
    // pending and before its promoting batch runs. The write goes through the
    // real database, so the conditional UPDATE inside applyEmailVerification
    // matches nothing for real; only the interleaving is arranged.
    let readAsPending = false;
    const racing = interceptingD1(realD1(db), (sql) => {
      if (sql.includes("SELECT id, status FROM users")) readAsPending = true;
    });
    const batch = racing.batch.bind(racing);
    racing.batch = ((stmts: Parameters<typeof batch>[0]) => {
      if (readAsPending) {
        readAsPending = false;
        db.run("UPDATE users SET status = 'revoked' WHERE id = ?", [id]);
      }
      return batch(stmts);
    }) as typeof racing.batch;

    const res = await verify(id, OWNER_KEY, racing);

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("User is not pending");
    // Neither the tier nor the flag moved: an owner override proves no inbox,
    // so losing the race must not leave `email_verified` stamped on a row the
    // owner never managed to verify.
    expect(row(id)).toEqual({ status: "revoked", email_verified: 0, service_access: 0 });
    expect(auditCount("email_verified_by_owner")).toBe(0);
    expect(auditCount("email_verified")).toBe(0);
  });
});
