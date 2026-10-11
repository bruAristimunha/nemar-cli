/**
 * GET /admin/users?awaiting_approval=1 (ADR 0042, #1253, epic #1250).
 *
 * Phase 1 could only approximate "awaiting approval" as "verified and holding
 * no grant" -- every browse-only account in the catalog, asked or not -- because
 * there was no request to read. `upload_access_requested_at` is that request,
 * and this is the query an admin's work queue is built from.
 *
 * Real engine: bun:sqlite behind realD1 with every migration applied, the real
 * admin router (authMiddleware + adminMiddleware, real hashed tokens). Nothing
 * here touches the network.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "awaiting-admin-key-0123456789abcdef01234567";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

async function seedAdmin(): Promise<void> {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access)
     VALUES ('awaitadmin', 'awaitadmin@example.org', 'x', 'approved', 'admin', 1, 1)`,
  ).run();
  const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='awaitadmin'").get();
  if (!u) throw new Error("seed: admin insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
}

function seedUser(
  username: string,
  opts: { status: string; serviceAccess: 0 | 1; requestedAt: string | null },
): void {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        service_access, upload_access_requested_at)
     VALUES (?, ?, 'x', ?, 'member', 1, ?, ?)`,
  ).run(username, `${username}@example.org`, opts.status, opts.serviceAccess, opts.requestedAt);
}

function get(path: string): Promise<Response> {
  return app.request(path, { headers: { Authorization: `Bearer ${ADMIN_KEY}` } }, {
    DB: realD1(db),
    ENVIRONMENT: "test",
  } as Bindings);
}

/** The seeded rows only: the acting admin and the `nemar-system` service row a
 *  migration plants are noise in every assertion here. */
const FIXTURE_NOISE = new Set(["awaitadmin", "nemar-system"]);

async function usernames(path: string): Promise<string[]> {
  const body = await (await get(path)).json();
  return body.users
    .map((u: { username: string | null }) => u.username)
    .filter((u: string | null): u is string => u !== null && !FIXTURE_NOISE.has(u))
    .sort();
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedAdmin();
});

describe("GET /admin/users/:username", () => {
  test("carries the request stamp and the why text", async () => {
    // The route selects an explicit list of every non-secret column
    // (`ADMIN_USER_NON_SECRET_SELECT`, ADR 0096), and these two are on it. That
    // is exactly why this is worth an assertion: nemarOrg/website#306 builds the
    // admin review panel on them, and a column dropped from that list would lose
    // them silently.
    seedUser("asked", {
      status: "verified",
      serviceAccess: 0,
      requestedAt: "2026-09-04T12:00:00Z",
    });
    db.query(
      "UPDATE users SET description = 'Depositing a 64-channel EEG study.' WHERE username = 'asked'",
    ).run();

    const body = await (await get("/admin/users/asked")).json();
    expect(body.user.upload_access_requested_at).toBe("2026-09-04T12:00:00Z");
    expect(body.user.description).toBe("Depositing a 64-channel EEG study.");
  });
});

describe("POST /admin/revoke closes an open upload request", () => {
  test("revoke clears both request stamps", async () => {
    // Without this, revoking a grantee puts them straight back into the admin
    // review queue as "awaiting approval" -- the one account an admin has just
    // decided about. The review is of a person at a moment, and revocation
    // ends that moment; a re-instated account asks again.
    seedUser("grantee", {
      status: "approved",
      serviceAccess: 1,
      requestedAt: "2026-09-01T12:00:00Z",
    });
    db.query(
      "UPDATE users SET upload_access_notified_at = '2026-09-01T12:05:00Z' WHERE username = 'grantee'",
    ).run();

    const res = await app.request(
      "/admin/revoke/grantee",
      { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      { DB: realD1(db), ENVIRONMENT: "test" } as Bindings,
    );
    expect(res.status).toBe(200);

    const row = db
      .query<
        {
          status: string;
          upload_access_requested_at: string | null;
          upload_access_notified_at: string | null;
        },
        []
      >(
        "SELECT status, upload_access_requested_at, upload_access_notified_at FROM users WHERE username = 'grantee'",
      )
      .get();
    expect(row?.status).toBe("revoked");
    expect(row?.upload_access_requested_at).toBeNull();
    expect(row?.upload_access_notified_at).toBeNull();
    expect(await usernames("/admin/users?awaiting_approval=1")).toEqual([]);
  });
});

describe("GET /admin/users: the open-request filter", () => {
  beforeEach(() => {
    seedUser("neverasked", { status: "verified", serviceAccess: 0, requestedAt: null });
    seedUser("asked", {
      status: "verified",
      serviceAccess: 0,
      requestedAt: "2026-09-04T12:00:00Z",
    });
    seedUser("granted", {
      status: "approved",
      serviceAccess: 1,
      requestedAt: "2026-09-01T12:00:00Z",
    });
  });

  test("narrows to accounts that asked and were not granted", async () => {
    // The whole point: a base-tier account that never asked is NOT work for an
    // admin, and phase 1's approximation could not tell the two apart.
    expect(await usernames("/admin/users?awaiting_approval=1")).toEqual(["asked"]);
  });

  test("without the parameter the listing is unfiltered", async () => {
    expect(await usernames("/admin/users")).toEqual(["asked", "granted", "neverasked"]);
  });

  test("only the literal 1 turns it on", async () => {
    // A missing or malformed value must widen to the whole listing rather than
    // silently narrowing an admin's queue to something they did not ask for.
    expect(await usernames("/admin/users?awaiting_approval=0")).toEqual([
      "asked",
      "granted",
      "neverasked",
    ]);
    expect(await usernames("/admin/users?awaiting_approval=true")).toEqual([
      "asked",
      "granted",
      "neverasked",
    ]);
  });

  test("a revoked account is never an open request", async () => {
    // Revoke clears the request stamps (ADR 0042), so this row should not exist
    // -- which is exactly why the fixture is here. The filter itself constrains
    // status, so a row that reaches this shape some other way still cannot be
    // put back into an admin's queue, and website#301 gets the right meaning
    // without knowing to add a status param.
    seedUser("askedrevoked", {
      status: "revoked",
      serviceAccess: 0,
      requestedAt: "2026-09-03T12:00:00Z",
    });
    // (The revoke route's other spelling, `revoked_iam_pending`, cannot be
    // seeded at all: migration 0001's CHECK on `status` does not allow it, so
    // that branch of the revoke route can never have written a row. Noted, not
    // fixed here -- it predates this phase.)

    expect(await usernames("/admin/users?awaiting_approval=1")).toEqual(["asked"]);
  });

  test("combines with an explicit status filter rather than replacing it", async () => {
    expect(await usernames("/admin/users?awaiting_approval=1&status=verified")).toEqual(["asked"]);
    // A contradictory pair returns nothing rather than quietly dropping one.
    expect(await usernames("/admin/users?awaiting_approval=1&status=approved")).toEqual([]);
  });

  test("the request timestamp is in the listing, for asked and granted alike", async () => {
    const body = await (await get("/admin/users")).json();
    const row = (name: string) =>
      body.users.find((u: { username: string | null }) => u.username === name);

    expect(row("asked").upload_access_requested_at).toBe("2026-09-04T12:00:00Z");
    // A granted account keeps the stamp: it records WHEN they asked, and is not
    // a queue flag that approval clears.
    expect(row("granted").upload_access_requested_at).toBe("2026-09-01T12:00:00Z");
    expect(row("neverasked").upload_access_requested_at).toBeNull();
  });
});
