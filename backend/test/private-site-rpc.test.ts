/**
 * The `NemarApiRpc` methods, driven through the env-level functions the
 * entrypoint class shims over (ADR 0078, ADR 0079).
 *
 * Real engine throughout: bun:sqlite behind `realD1` with every migration
 * applied, real grants minted by the real `POST /auth/private/grant` route
 * from real `issueSession()` sessions, real hashing. No mocks. The class
 * itself cannot load under bun (`cloudflare:workers`), so its wiring is
 * proven in workerd by `private-site-rpc-entry.test.ts`; everything the
 * methods DECIDE is proven here.
 *
 * THE SCOPE-ISOLATION BLOCK MATTERS MOST. A private session is a
 * `web_sessions` row like an app or docs session, so the only thing keeping
 * it from authenticating the management API is that every reader names the
 * scope it wants. ADR 0056's review found a reader that did not, and the docs
 * credential authenticated `/admin/*`. So a private value is presented to
 * each reader in turn, through the real middleware.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { DOCS_SESSION_HEADER } from "../../shared/contract/docs-auth.js";
import {
  type ExchangePrivateGrantResult,
  PRIVATE_SESSION_TTL_SECONDS,
  type Principal,
} from "../../shared/contract/private-site.js";
import worker from "../src/index";
import { authMiddleware } from "../src/middleware/auth";
import { maintenanceMode } from "../src/middleware/maintenance";
import { __resetRateLimitLogsForTests } from "../src/middleware/rateLimit";
import { authDocsRoutes } from "../src/routes/auth-docs";
import { authPrivateRoutes } from "../src/routes/auth-private";
import { authWebRoutes } from "../src/routes/auth-web";
import { resolvePrincipal } from "../src/rpc/principal";
import { exchangePrivateGrant, revokePrivateSession } from "../src/rpc/private-session";
import { hashGrantCode } from "../src/services/docs-auth";
import { hashApiKey } from "../src/services/token";
import { hashCookieId, hashIp, issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const APP = "https://app.nemar.org";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

function env(extra: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    APP_BASE_URL: APP,
    WEB_SESSION_COOKIE_DOMAIN: "",
    ...extra,
  } as unknown as Bindings;
}

beforeEach(() => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authWebRoutes);
  app.route("/auth", authDocsRoutes);
  app.route("/auth", authPrivateRoutes);
});

// --------------------------------------------------------------------------
// Seeding
// --------------------------------------------------------------------------

interface SeedOptions {
  role?: string;
  status?: string;
  username?: string | null;
}

let seeded = 0;

function seedUser(email: string, opts: SeedOptions = {}): number {
  seeded += 1;
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, signup_source, email_verified,
                        given_name, family_name, orcid, orcid_verified, account_kind)
     VALUES (?, ?, 'x', ?, ?, 'web', 1, 'Ada', 'Lovelace', ?, 1, 'person')`,
    [
      opts.username === undefined ? email.split("@")[0] : opts.username,
      email,
      opts.status ?? "verified",
      opts.role ?? "member",
      // users.orcid is unique, so each seeded account gets its own iD.
      `0000-0002-1825-${String(seeded).padStart(4, "0")}`,
    ],
  );
  const row = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!row) throw new Error("seed failed");
  return row.id;
}

async function seedApiKey(userId: number, apiKey: string, expiresSql = "NULL"): Promise<string> {
  db.run(
    `INSERT INTO tokens (user_id, api_key_hash, api_key_prefix, expires_at)
     VALUES (?, ?, ?, ${expiresSql})`,
    [userId, await hashApiKey(apiKey), apiKey.slice(0, 8)],
  );
  return apiKey;
}

async function appSession(userId: number): Promise<string> {
  const { cookieIdRaw } = await issueSession(env(), userId, false, "ua", "127.0.0.1", "orcid");
  return cookieIdRaw;
}

/** The browser's `state`: 43 base64url characters, as 256 random bits make. */
const STATE = "BrowserStateForTests-0123456789_abcdefghijk";

/** A one-time code from the real grant route, bound to `state`. */
async function privateCode(userId: number, state = STATE): Promise<string> {
  const res = await app.request(
    "/auth/private/grant",
    {
      method: "POST",
      headers: {
        Cookie: `nemar_session=${await appSession(userId)}`,
        Origin: APP,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state }),
    },
    env(),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { code: string }).code;
}

/** Leave the `state` field out of the request entirely. */
const NO_STATE = Symbol("no state");

function exchange(code: unknown, extra: Partial<Bindings> = {}, state: unknown = STATE) {
  return exchangePrivateGrant(env(extra), {
    code,
    ...(state === NO_STATE ? {} : { state }),
    userAgent: "private-site-visitor",
    clientIp: "198.51.100.23",
  });
}

async function signInToPrivate(userId: number): Promise<string> {
  const result = await exchange(await privateCode(userId));
  if (!result.ok) throw new Error(`exchange refused: ${result.error}`);
  return result.session;
}

async function docsSession(userId: number): Promise<string> {
  const cookie = await appSession(userId);
  const granted = await app.request(
    "/auth/docs/grant",
    { method: "POST", headers: { Cookie: `nemar_session=${cookie}`, Origin: APP } },
    env(),
  );
  const { code } = (await granted.json()) as { code: string };
  const exchanged = await app.request(
    "/auth/docs/exchange",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    },
    env(),
  );
  return ((await exchanged.json()) as { session: string }).session;
}

function privateRows(userId: number) {
  return db
    .query<
      {
        remember: number;
        auth_method: string | null;
        user_agent: string | null;
        ip_hash: string | null;
        revoked_at: string | null;
        ttl: number;
      },
      [number]
    >(
      `SELECT remember, auth_method, user_agent, ip_hash, revoked_at,
              CAST(ROUND((julianday(expires_at) - julianday('now')) * 86400) AS INTEGER) AS ttl
         FROM web_sessions WHERE user_id = ? AND scope = 'private' ORDER BY id`,
    )
    .all(userId);
}

function grantCount(): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM private_grants").get()?.n ?? 0;
}

function expectPrincipal(principal: Principal, userId: number, username: string | null) {
  const stored = db
    .query<{ email: string; orcid: string }, [number]>(
      "SELECT email, orcid FROM users WHERE id = ?",
    )
    .get(userId);
  expect(principal).toEqual({
    userId,
    username,
    orcid: stored?.orcid ?? "missing",
    orcidVerified: true,
    givenName: "Ada",
    familyName: "Lovelace",
    email: stored?.email ?? "missing",
    emailVerified: true,
    role: "member",
    status: "verified",
    accountKind: "person",
  });
}

// --------------------------------------------------------------------------
// exchangePrivateGrant
// --------------------------------------------------------------------------

describe("exchangePrivateGrant", () => {
  test("trades a live code for an eight-hour private session and the principal", async () => {
    const userId = seedUser("exchange@nemar.test");
    const result = await exchange(await privateCode(userId));
    if (!result.ok) throw new Error(result.error);

    expect(result.maxAgeSeconds).toBe(PRIVATE_SESSION_TTL_SECONDS);
    expect(result.session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expectPrincipal(result.principal, userId, "exchange");

    const [row] = privateRows(userId);
    expect(row?.remember).toBe(0);
    // Carried from the app session through the grant.
    expect(row?.auth_method).toBe("orcid");
    expect(row?.user_agent).toBe("private-site-visitor");
    // Hashed with the API's own helper, never stored as sent.
    expect(row?.ip_hash).toBe(await hashIp("198.51.100.23"));
    // SQL-side TTL, on the database's clock.
    expect(row?.ttl).toBeGreaterThan(PRIVATE_SESSION_TTL_SECONDS - 5);
    expect(row?.ttl).toBeLessThanOrEqual(PRIVATE_SESSION_TTL_SECONDS);
    // The session value is stored only as its hash.
    const stored = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM web_sessions WHERE cookie_id_hash = ?",
      )
      .get(await hashCookieId(result.session));
    expect(stored?.n).toBe(1);
  });

  test("is single use: the second exchange of a code is invalid_grant", async () => {
    const userId = seedUser("once@nemar.test");
    const code = await privateCode(userId);
    expect((await exchange(code)).ok).toBe(true);
    expect(await exchange(code)).toEqual({ ok: false, error: "invalid_grant" });
    expect(privateRows(userId)).toHaveLength(1);
    expect(grantCount()).toBe(0);
  });

  test("an unknown or malformed code is invalid_grant", async () => {
    for (const code of ["never-issued", "", 42, null, "x".repeat(257)]) {
      expect(await exchange(code)).toEqual({ ok: false, error: "invalid_grant" });
    }
    expect(await exchangePrivateGrant(env(), null)).toEqual({ ok: false, error: "invalid_grant" });
  });

  test("the state the grant was minted with is the one that spends it", async () => {
    const userId = seedUser("state-match@nemar.test");
    expect((await exchange(await privateCode(userId, STATE), {}, STATE)).ok).toBe(true);
  });

  test("a grant minted with state A cannot be spent with state B, and survives for A", async () => {
    // The login-CSRF case: the code reached a browser that did not start the
    // sign-in, and that browser's cookie holds a different state (or none).
    const userId = seedUser("state-swap@nemar.test");
    const stateA = "A".repeat(43);
    const stateB = "B".repeat(43);
    const code = await privateCode(userId, stateA);
    expect(await exchange(code, {}, stateB)).toEqual({ ok: false, error: "invalid_grant" });
    expect(privateRows(userId)).toHaveLength(0);
    expect(grantCount()).toBe(1);
    expect((await exchange(code, {}, stateA)).ok).toBe(true);
  });

  for (const [what, state] of [
    ["missing", NO_STATE],
    ["empty", ""],
    ["31 characters long", "s".repeat(31)],
    ["257 characters long", "s".repeat(257)],
    ["outside the base64url alphabet", `${"s".repeat(42)}/`],
    ["not a string", 42],
  ] as const) {
    test(`a state that is ${what} is invalid_grant, and the grant is not consumed`, async () => {
      const userId = seedUser(`state-bad-${what.replace(/\W+/g, "-")}@nemar.test`);
      const code = await privateCode(userId);
      expect(await exchange(code, {}, state)).toEqual({ ok: false, error: "invalid_grant" });
      expect(privateRows(userId)).toHaveLength(0);
      // Still spendable by the browser that holds the right state.
      expect((await exchange(code)).ok).toBe(true);
    });
  }

  test("an expired code is invalid_grant", async () => {
    const userId = seedUser("expired-code@nemar.test");
    const code = await privateCode(userId);
    db.run("UPDATE private_grants SET expires_at = datetime('now', '-1 second')");
    expect(await exchange(code)).toEqual({ ok: false, error: "invalid_grant" });
    expect(privateRows(userId)).toHaveLength(0);
  });

  test("a docs grant code is not spendable here", async () => {
    // Separate tables, so the separation is structural rather than a predicate.
    const userId = seedUser("docs-code@nemar.test", { role: "admin" });
    const res = await app.request(
      "/auth/docs/grant",
      {
        method: "POST",
        headers: { Cookie: `nemar_session=${await appSession(userId)}`, Origin: APP },
      },
      env(),
    );
    const { code } = (await res.json()) as { code: string };
    expect(await exchange(code)).toEqual({ ok: false, error: "invalid_grant" });
  });

  for (const [what, change] of [
    ["revoked", "UPDATE users SET status = 'revoked' WHERE id = ?"],
    ["left pending", "UPDATE users SET status = 'pending' WHERE id = ?"],
    ["deleted", "UPDATE users SET deleted_at = datetime('now') WHERE id = ?"],
  ] as const) {
    test(`an account ${what} between grant and exchange gets invalid_grant`, async () => {
      // The mint re-reads the account in the statement that writes, because
      // state can change between the two halves of a handoff.
      const userId = seedUser(`between-${what.replace(" ", "-")}@nemar.test`);
      const code = await privateCode(userId);
      db.run(change, [userId]);
      expect(await exchange(code)).toEqual({ ok: false, error: "invalid_grant" });
      expect(privateRows(userId)).toHaveLength(0);
    });
  }

  test("a role is not required: an admin and a member both exchange", async () => {
    const member = seedUser("role-member@nemar.test");
    const admin = seedUser("role-admin@nemar.test", { role: "admin" });
    expect((await exchange(await privateCode(member))).ok).toBe(true);
    const adminResult = await exchange(await privateCode(admin));
    expect(adminResult.ok && adminResult.principal.role).toBe("admin");
  });

  for (const mode of ["read-only", "full"] as const) {
    test(`maintenance mode ${mode} answers unavailable and writes nothing`, async () => {
      // RPC bypasses the HTTP middleware, so the method mirrors it itself.
      const userId = seedUser(`maint-${mode}@nemar.test`);
      const code = await privateCode(userId);
      expect(await exchange(code, { MAINTENANCE_MODE: mode })).toEqual({
        ok: false,
        error: "unavailable",
      });
      expect(privateRows(userId)).toHaveLength(0);
      // The code survives, so the visitor can finish once the API is back.
      expect((await exchange(code)).ok).toBe(true);
    });
  }

  test("an unparseable role after the mint is a THROW, with the grant spent and the row left", async () => {
    // The one fault the exchange cannot turn into a value: the grant is
    // already consumed when the read-back finds a role `parseRole` rejects.
    // The session's value is never returned, so the row it leaves is held by
    // nobody.
    const userId = seedUser("fault@nemar.test");
    const code = await privateCode(userId);
    db.run("UPDATE users SET role = 'superuser' WHERE id = ?", [userId]);
    await expect(exchange(code)).rejects.toThrow(/did not resolve \(unresolved_account\)/);
    const left = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM private_grants WHERE code_hash = ?",
      )
      .get(await hashGrantCode(code));
    expect(left?.n).toBe(0);
    expect(privateRows(userId)).toHaveLength(1);
  });

  test("a user agent longer than 512 characters is truncated, not refused", async () => {
    const userId = seedUser("long-ua@nemar.test");
    const result = await exchangePrivateGrant(env(), {
      code: await privateCode(userId),
      state: STATE,
      userAgent: "u".repeat(600),
      clientIp: null,
    });
    expect(result.ok).toBe(true);
    expect(privateRows(userId)[0]?.user_agent).toBe("u".repeat(512));
  });

  test("a client IP longer than 64 characters, or not a string, is dropped", async () => {
    for (const [what, clientIp] of [
      ["long", "1".repeat(65)],
      ["numeric", 1921680001],
    ] as const) {
      const userId = seedUser(`ip-${what}@nemar.test`);
      const result = await exchangePrivateGrant(env(), {
        code: await privateCode(userId),
        state: STATE,
        userAgent: null,
        clientIp,
      });
      expect(result.ok).toBe(true);
      expect(privateRows(userId)[0]?.ip_hash).toBeNull();
    }
    // A 64-character value is still an address worth hashing.
    const userId = seedUser("ip-edge@nemar.test");
    await exchangePrivateGrant(env(), {
      code: await privateCode(userId),
      state: STATE,
      userAgent: null,
      clientIp: "2".repeat(64),
    });
    expect(privateRows(userId)[0]?.ip_hash).toBe(await hashIp("2".repeat(64)));
  });

  test("a 257-character code is refused before it is looked up", async () => {
    // A live grant is planted under that code's hash, so only the length
    // check can be what refuses it.
    const userId = seedUser("long-code@nemar.test");
    const code = "c".repeat(257);
    db.run(
      "INSERT INTO private_grants (code_hash, state_hash, user_id, expires_at) VALUES (?, ?, ?, datetime('now', '+60 seconds'))",
      [await hashGrantCode(code), await hashGrantCode(STATE), userId],
    );
    expect(await exchange(code)).toEqual({ ok: false, error: "invalid_grant" });
    expect(privateRows(userId)).toHaveLength(0);
  });

  test("hands the session touch to waitUntil when given a context", async () => {
    const userId = seedUser("wait-until@nemar.test");
    const pending: Promise<unknown>[] = [];
    const result = await exchangePrivateGrant(
      env(),
      { code: await privateCode(userId), state: STATE, userAgent: null, clientIp: null },
      { waitUntil: (p) => pending.push(p) },
    );
    expect(result.ok).toBe(true);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
  });
});

// --------------------------------------------------------------------------
// resolvePrincipal, session kind
// --------------------------------------------------------------------------

describe("resolvePrincipal: a private-site session", () => {
  async function resolveSession(value: unknown) {
    return resolvePrincipal(env(), { kind: "session", value });
  }

  test("resolves to the same principal the exchange returned", async () => {
    const userId = seedUser("resolve@nemar.test");
    const exchanged = (await exchange(await privateCode(userId))) as Extract<
      ExchangePrivateGrantResult,
      { ok: true }
    >;
    expect(await resolveSession(exchanged.session)).toEqual({
      ok: true,
      principal: exchanged.principal,
    });
  });

  test("reports the live role, not the one at mint", async () => {
    const userId = seedUser("live-role@nemar.test");
    const session = await signInToPrivate(userId);
    db.run("UPDATE users SET role = 'admin' WHERE id = ?", [userId]);
    const result = await resolveSession(session);
    expect(result.ok && result.principal.role).toBe("admin");
  });

  test("refuses an app session value", async () => {
    const userId = seedUser("app-value@nemar.test");
    expect(await resolveSession(await appSession(userId))).toEqual({
      ok: false,
      error: "invalid_credential",
    });
  });

  test("refuses a docs session value", async () => {
    const userId = seedUser("docs-value@nemar.test", { role: "admin" });
    const docs = await docsSession(userId);
    expect(docs.length).toBeGreaterThan(20);
    expect(await resolveSession(docs)).toEqual({ ok: false, error: "invalid_credential" });
  });

  test("refuses a revoked session", async () => {
    const userId = seedUser("revoked-session@nemar.test");
    const session = await signInToPrivate(userId);
    db.run("UPDATE web_sessions SET revoked_at = datetime('now') WHERE scope = 'private'");
    expect(await resolveSession(session)).toEqual({ ok: false, error: "invalid_credential" });
  });

  test("refuses an expired session", async () => {
    const userId = seedUser("expired-session@nemar.test");
    const session = await signInToPrivate(userId);
    db.run(
      "UPDATE web_sessions SET expires_at = datetime('now', '-1 second') WHERE scope = 'private'",
    );
    expect(await resolveSession(session)).toEqual({ ok: false, error: "invalid_credential" });
  });

  test("a live session stops resolving when the account drops to pending", async () => {
    // The standing check must not be looser than the entry check:
    // `findSessionByCookieId` admits `pending`, so the rule is re-applied.
    const userId = seedUser("status-drop@nemar.test");
    const session = await signInToPrivate(userId);
    db.run("UPDATE users SET status = 'pending' WHERE id = ?", [userId]);
    expect(await resolveSession(session)).toEqual({ ok: false, error: "inactive_account" });
  });

  test("refuses once the account is revoked", async () => {
    const userId = seedUser("account-revoked@nemar.test");
    const session = await signInToPrivate(userId);
    db.run("UPDATE users SET status = 'revoked' WHERE id = ?", [userId]);
    expect(await resolveSession(session)).toEqual({ ok: false, error: "invalid_credential" });
  });

  test("refuses once the account is deleted", async () => {
    const userId = seedUser("account-deleted@nemar.test");
    const session = await signInToPrivate(userId);
    db.run("UPDATE users SET deleted_at = datetime('now') WHERE id = ?", [userId]);
    expect(await resolveSession(session)).toEqual({ ok: false, error: "invalid_credential" });
  });

  test("an unrecognised role is unresolved_account, not a guessed principal", async () => {
    const userId = seedUser("odd-role@nemar.test");
    const session = await signInToPrivate(userId);
    db.run("UPDATE users SET role = 'superuser' WHERE id = ?", [userId]);
    expect(await resolveSession(session)).toEqual({ ok: false, error: "unresolved_account" });
  });

  test("an unknown kind is refused even when its value is a live session", async () => {
    // A live value, so treating an unknown kind as a session would resolve it.
    const userId = seedUser("unknown-kind@nemar.test");
    const session = await signInToPrivate(userId);
    expect(await resolvePrincipal(env(), { kind: "session", value: session })).toMatchObject({
      ok: true,
    });
    for (const kind of ["cookie", "Session", "", undefined]) {
      expect(await resolvePrincipal(env(), { kind, value: session })).toEqual({
        ok: false,
        error: "invalid_credential",
      });
    }
  });

  test("a 513-character credential is refused on both kinds, before it is looked up", async () => {
    // A live session and a live key are planted under that value's hashes,
    // so only the length check can be what refuses them.
    const userId = seedUser("long-credential@nemar.test");
    const value = "v".repeat(513);
    db.run(
      `INSERT INTO web_sessions (user_id, cookie_id_hash, expires_at, scope)
       VALUES (?, ?, datetime('now', '+1 hour'), 'private')`,
      [userId, await hashCookieId(value)],
    );
    await seedApiKey(userId, value);
    for (const kind of ["session", "api_key"]) {
      expect(await resolvePrincipal(env(), { kind, value })).toEqual({
        ok: false,
        error: "invalid_credential",
      });
    }
  });

  test("a malformed credential is invalid_credential", async () => {
    for (const credential of [
      null,
      "a-bare-string",
      {},
      { kind: "session" },
      { kind: "session", value: 7 },
      { kind: "session", value: "" },
    ]) {
      expect(await resolvePrincipal(env(), credential)).toEqual({
        ok: false,
        error: "invalid_credential",
      });
    }
  });
});

// --------------------------------------------------------------------------
// resolvePrincipal, api_key kind
// --------------------------------------------------------------------------

describe("resolvePrincipal: an API key", () => {
  const KEY = "nm_private-site-rpc-key-0123456789abcdef0123";

  function resolveKey(value: string) {
    return resolvePrincipal(env(), { kind: "api_key", value });
  }

  test("resolves to the principal and touches the key's last_used_at", async () => {
    const userId = seedUser("key@nemar.test");
    await seedApiKey(userId, KEY);
    const result = await resolveKey(KEY);
    if (!result.ok) throw new Error(result.error);
    expectPrincipal(result.principal, userId, "key");
    const touched = db
      .query<{ last_used_at: string | null }, [number]>(
        "SELECT last_used_at FROM tokens WHERE user_id = ?",
      )
      .get(userId);
    expect(touched?.last_used_at).not.toBeNull();
  });

  test("an account without a username resolves with username null", async () => {
    const userId = seedUser("no-username@nemar.test", { username: null });
    await seedApiKey(userId, KEY);
    const result = await resolveKey(KEY);
    expect(result.ok && result.principal.username).toBeNull();
  });

  test("refuses a revoked key", async () => {
    const userId = seedUser("key-revoked@nemar.test");
    await seedApiKey(userId, KEY);
    db.run("UPDATE tokens SET revoked_at = datetime('now') WHERE user_id = ?", [userId]);
    expect(await resolveKey(KEY)).toEqual({ ok: false, error: "invalid_credential" });
  });

  test("refuses an expired key", async () => {
    // The `expires_at` predicate `optionalAuthMiddleware`'s copy lacks: this
    // path goes through the one lookup that has it.
    const userId = seedUser("key-expired@nemar.test");
    await seedApiKey(userId, KEY, "datetime('now', '-1 second')");
    expect(await resolveKey(KEY)).toEqual({ ok: false, error: "invalid_credential" });
  });

  test("accepts a key whose expiry is still ahead", async () => {
    const userId = seedUser("key-future@nemar.test");
    await seedApiKey(userId, KEY, "datetime('now', '+1 day')");
    expect((await resolveKey(KEY)).ok).toBe(true);
  });

  test("refuses a value too short to be a key, without a lookup", async () => {
    expect(await resolveKey("nm_short")).toEqual({ ok: false, error: "invalid_credential" });
  });

  test("refuses an unknown key", async () => {
    expect(await resolveKey(KEY)).toEqual({ ok: false, error: "invalid_credential" });
  });

  test("a live key on a pending account is inactive_account", async () => {
    const userId = seedUser("key-pending@nemar.test", { status: "pending" });
    await seedApiKey(userId, KEY);
    expect(await resolveKey(KEY)).toEqual({ ok: false, error: "inactive_account" });
  });

  test("a live key on a revoked account is invalid_credential, as a session is", async () => {
    // The key lookup reports a revoked account (the HTTP API answers it 403);
    // the entrypoint maps it to the same answer the session kind gives, whose
    // SELECT filters revoked accounts out, so `inactive_account` means only
    // "not active yet".
    const userId = seedUser("key-account-revoked@nemar.test", { status: "revoked" });
    await seedApiKey(userId, KEY);
    expect(await resolveKey(KEY)).toEqual({ ok: false, error: "invalid_credential" });
  });

  test("a key on a deleted account is invalid_credential", async () => {
    const userId = seedUser("key-deleted@nemar.test");
    await seedApiKey(userId, KEY);
    db.run("UPDATE users SET deleted_at = datetime('now') WHERE id = ?", [userId]);
    expect(await resolveKey(KEY)).toEqual({ ok: false, error: "invalid_credential" });
  });

  test("an unrecognised role is unresolved_account", async () => {
    const userId = seedUser("key-odd-role@nemar.test", { role: "superuser" });
    await seedApiKey(userId, KEY);
    expect(await resolveKey(KEY)).toEqual({ ok: false, error: "unresolved_account" });
  });

  test("a private session value is not an API key", async () => {
    const userId = seedUser("session-as-key@nemar.test");
    const session = await signInToPrivate(userId);
    expect(await resolveKey(session)).toEqual({ ok: false, error: "invalid_credential" });
  });
});

// --------------------------------------------------------------------------
// One mapping, both kinds, two account shapes
// --------------------------------------------------------------------------

describe("the principal is the same full object on both credential kinds", () => {
  const KEY = "nm_private-site-principal-key-0123456789abcdef";

  /** A different shape on every field the first seed fixes: an approved
   *  service owner, both verification flags off, no names, no ORCID. */
  function seedServiceOwner(): number {
    db.run(
      `INSERT INTO users (username, email, password_hash, status, role, signup_source, email_verified,
                          given_name, family_name, orcid, orcid_verified, account_kind)
       VALUES ('svc-owner', 'svc-owner@nemar.test', 'x', 'approved', 'owner', 'web', 0,
               NULL, NULL, NULL, 0, 'service')`,
    );
    return (
      db.query<{ id: number }, []>("SELECT id FROM users WHERE username = 'svc-owner'").get()?.id ??
      0
    );
  }

  async function bothKinds(userId: number) {
    await seedApiKey(userId, KEY);
    const session = await signInToPrivate(userId);
    return [
      await resolvePrincipal(env(), { kind: "session", value: session }),
      await resolvePrincipal(env(), { kind: "api_key", value: KEY }),
    ];
  }

  test("a verified member with names, an ORCID iD and both flags set", async () => {
    const userId = seedUser("both-kinds@nemar.test");
    const orcid = db
      .query<{ orcid: string }, [number]>("SELECT orcid FROM users WHERE id = ?")
      .get(userId)?.orcid;
    const expected = {
      ok: true,
      principal: {
        userId,
        username: "both-kinds",
        orcid,
        orcidVerified: true,
        givenName: "Ada",
        familyName: "Lovelace",
        email: "both-kinds@nemar.test",
        emailVerified: true,
        role: "member",
        status: "verified",
        accountKind: "person",
      },
    };
    for (const result of await bothKinds(userId)) expect(result).toEqual(expected);
  });

  test("a typed but unverified ORCID iD: the two flags are read separately", async () => {
    // Mixed flags, so a mapping that cross-wires `orcidVerified` and
    // `emailVerified` is visible; the other two shapes have them equal.
    const userId = seedUser("mixed-flags@nemar.test");
    db.run("UPDATE users SET orcid_verified = 0 WHERE id = ?", [userId]);
    for (const result of await bothKinds(userId)) {
      expect(result).toMatchObject({
        ok: true,
        principal: { orcidVerified: false, emailVerified: true },
      });
    }
  });

  test("an approved service owner with no names, no ORCID iD and both flags off", async () => {
    const userId = seedServiceOwner();
    const expected = {
      ok: true,
      principal: {
        userId,
        username: "svc-owner",
        orcid: null,
        orcidVerified: false,
        givenName: null,
        familyName: null,
        email: "svc-owner@nemar.test",
        emailVerified: false,
        role: "owner",
        status: "approved",
        accountKind: "service",
      },
    };
    for (const result of await bothKinds(userId)) expect(result).toEqual(expected);
  });
});

// --------------------------------------------------------------------------
// revokePrivateSession
// --------------------------------------------------------------------------

describe("revokePrivateSession", () => {
  test("ends the session it is given", async () => {
    const userId = seedUser("signout@nemar.test");
    const session = await signInToPrivate(userId);
    expect(await revokePrivateSession(env(), { value: session })).toEqual({ ok: true });
    expect(await resolvePrincipal(env(), { kind: "session", value: session })).toEqual({
      ok: false,
      error: "invalid_credential",
    });
  });

  test("is idempotent: a repeat changes nothing, including the revocation time", async () => {
    const userId = seedUser("signout-twice@nemar.test");
    const session = await signInToPrivate(userId);
    await revokePrivateSession(env(), { value: session });
    db.run("UPDATE web_sessions SET revoked_at = '2026-01-01 00:00:00' WHERE scope = 'private'");
    expect(await revokePrivateSession(env(), { value: session })).toEqual({ ok: true });
    expect(privateRows(userId)[0]?.revoked_at).toBe("2026-01-01 00:00:00");
  });

  test("ends only that session, not the account's others", async () => {
    const userId = seedUser("signout-one@nemar.test");
    const first = await signInToPrivate(userId);
    const second = await signInToPrivate(userId);
    await revokePrivateSession(env(), { value: first });
    expect((await resolvePrincipal(env(), { kind: "session", value: second })).ok).toBe(true);
  });

  test("handed an app session value, it leaves the app session alone", async () => {
    const userId = seedUser("signout-app@nemar.test");
    const cookie = await appSession(userId);
    expect(await revokePrivateSession(env(), { value: cookie })).toEqual({ ok: true });
    const me = await app.request(
      "/auth/me",
      { headers: { Cookie: `nemar_session=${cookie}` } },
      env(),
    );
    expect(((await me.json()) as { user: unknown }).user).not.toBeNull();
  });

  test("handed a docs session value, it leaves the docs session alone", async () => {
    const userId = seedUser("signout-docs@nemar.test", { role: "admin" });
    const docs = await docsSession(userId);
    expect(await revokePrivateSession(env(), { value: docs })).toEqual({ ok: true });
    const verified = await app.request(
      "/auth/docs/verify",
      { headers: { [DOCS_SESSION_HEADER]: docs } },
      env(),
    );
    expect(verified.status).toBe(200);
  });

  test("an unknown or malformed value is ok and changes nothing", async () => {
    const userId = seedUser("signout-unknown@nemar.test");
    const session = await signInToPrivate(userId);
    for (const request of [{ value: "not-a-session" }, { value: 3 }, {}, null]) {
      expect(await revokePrivateSession(env(), request)).toEqual({ ok: true });
    }
    expect((await resolvePrincipal(env(), { kind: "session", value: session })).ok).toBe(true);
  });

  test("maintenance mode answers unavailable and leaves the session live", async () => {
    const userId = seedUser("signout-maint@nemar.test");
    const session = await signInToPrivate(userId);
    expect(
      await revokePrivateSession(env({ MAINTENANCE_MODE: "read-only" }), { value: session }),
    ).toEqual({ ok: false, error: "unavailable" });
    expect((await resolvePrincipal(env(), { kind: "session", value: session })).ok).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Scope isolation: a private session value is nothing anywhere else
// --------------------------------------------------------------------------

describe("a private session is not a session anywhere else", () => {
  test("authMiddleware refuses it as the app cookie", async () => {
    // The reader that once lacked a scope predicate (ADR 0056).
    const userId = seedUser("iso-api@nemar.test", { role: "owner" });
    const session = await signInToPrivate(userId);
    const api = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    api.use("*", authMiddleware);
    api.get("/probe", (c) => c.json({ reached: true }));
    const res = await api.request(
      "/probe",
      { headers: { Cookie: `nemar_session=${session}` } },
      env(),
    );
    expect(res.status).toBe(401);
  });

  test("webSessionMiddleware finds no session in it", async () => {
    const userId = seedUser("iso-web@nemar.test");
    const session = await signInToPrivate(userId);
    const me = await app.request(
      "/auth/me",
      { headers: { Cookie: `nemar_session=${session}` } },
      env(),
    );
    expect(await me.json()).toEqual({ user: null });
  });

  test("the docs gate refuses it", async () => {
    const userId = seedUser("iso-docs@nemar.test", { role: "admin" });
    const session = await signInToPrivate(userId);
    const res = await app.request(
      "/auth/docs/verify",
      { headers: { [DOCS_SESSION_HEADER]: session } },
      env(),
    );
    expect(res.status).toBe(401);
  });

  test("it cannot mint a new grant, so it cannot renew itself", async () => {
    const userId = seedUser("iso-renew@nemar.test");
    const session = await signInToPrivate(userId);
    const before = grantCount();
    const res = await app.request(
      "/auth/private/grant",
      { method: "POST", headers: { Cookie: `nemar_session=${session}`, Origin: APP } },
      env(),
    );
    expect(res.status).toBe(401);
    expect(grantCount()).toBe(before);
  });

  test("a private grant code is not spendable at the docs exchange", async () => {
    const userId = seedUser("iso-code@nemar.test", { role: "admin" });
    const code = await privateCode(userId);
    const res = await app.request(
      "/auth/docs/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      },
      env(),
    );
    expect(res.status).toBe(400);
    // And it is still there to be spent where it belongs.
    const row = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM private_grants WHERE code_hash = ?",
      )
      .get(await hashGrantCode(code));
    expect(row?.n).toBe(1);
  });
});

// --------------------------------------------------------------------------
// Maintenance mode: the entrypoint answers as the HTTP API would
// --------------------------------------------------------------------------

describe("maintenance mode on every method", () => {
  let round = 0;

  /** Everything each method needs, signed in with maintenance OFF. Unique per
   *  call, so one test can ask about several modes. */
  async function fixture() {
    round += 1;
    const key = `nm_private-site-maintenance-key-0123456789-${round}`;
    const userId = seedUser(`maint-matrix-${round}@nemar.test`);
    await seedApiKey(userId, key);
    const session = await signInToPrivate(userId);
    const code = await privateCode(userId);
    db.run("UPDATE tokens SET last_used_at = NULL WHERE user_id = ?", [userId]);
    return { userId, key, session, code };
  }

  /** Each method's answer under one mode, as "ok" or its error. */
  async function answers(mode: string | undefined) {
    const { userId, key, session, code } = await fixture();
    const e = env({ MAINTENANCE_MODE: mode } as Partial<Bindings>);
    const outcome = (r: { ok: boolean; error?: string }) => (r.ok ? "ok" : r.error);
    return {
      userId,
      session,
      resolveSession: outcome(await resolvePrincipal(e, { kind: "session", value: session })),
      resolveKey: outcome(await resolvePrincipal(e, { kind: "api_key", value: key })),
      exchange: outcome(
        await exchangePrivateGrant(e, { code, state: STATE, userAgent: null, clientIp: null }),
      ),
      revoke: outcome(await revokePrivateSession(e, { value: session })),
    };
  }

  test("full refuses all three, and writes nothing", async () => {
    const got = await answers("full");
    expect(got).toMatchObject({
      resolveSession: "unavailable",
      resolveKey: "unavailable",
      exchange: "unavailable",
      revoke: "unavailable",
    });
    // No key touch, no new session, no revocation.
    const token = db
      .query<{ last_used_at: string | null }, [number]>(
        "SELECT last_used_at FROM tokens WHERE user_id = ?",
      )
      .get(got.userId);
    expect(token?.last_used_at).toBeNull();
    expect(privateRows(got.userId)).toHaveLength(1);
    expect(privateRows(got.userId)[0]?.revoked_at).toBeNull();
  });

  test("read-only keeps resolvePrincipal answering and refuses the two writes", async () => {
    const got = await answers("read-only");
    expect(got).toMatchObject({
      resolveSession: "ok",
      resolveKey: "ok",
      exchange: "unavailable",
      revoke: "unavailable",
    });
    expect(privateRows(got.userId)).toHaveLength(1);
  });

  for (const mode of [undefined, "off", "not-a-mode"]) {
    test(`${mode ?? "unset"} refuses nothing`, async () => {
      // An unrecognised value is parsed as off, exactly as the middleware does.
      const got = await answers(mode);
      expect(got).toMatchObject({
        resolveSession: "ok",
        resolveKey: "ok",
        exchange: "ok",
        revoke: "ok",
      });
    });
  }

  test("each answer matches what the HTTP middleware does to a GET and a POST", async () => {
    // The claim is that the entrypoint mirrors the HTTP API exactly, so the
    // real middleware is asked too, mode by mode: a read is refused where a
    // GET is, and a write where a POST is.
    const http = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    http.use("*", maintenanceMode);
    http.get("/probe", (c) => c.json({ ok: true }));
    http.post("/probe", (c) => c.json({ ok: true }));
    for (const mode of [undefined, "off", "read-only", "full", "not-a-mode"]) {
      const e = env({ MAINTENANCE_MODE: mode } as Partial<Bindings>);
      const getRefused = (await http.request("/probe", {}, e)).status === 503;
      const postRefused = (await http.request("/probe", { method: "POST" }, e)).status === 503;
      const got = await answers(mode);
      expect({
        mode,
        read: got.resolveKey === "unavailable",
        write: got.exchange === "unavailable",
      }).toEqual({ mode, read: getRefused, write: postRefused });
      expect(got.resolveSession === "unavailable").toBe(getRefused);
      expect(got.revoke === "unavailable").toBe(postRefused);
    }
  });
});

// --------------------------------------------------------------------------
// Secrets stay out of the logs
// --------------------------------------------------------------------------

describe("no log line carries the state, the code or the session value", () => {
  test("across a grant through the real worker, an exchange, a resolve and a sign-out", async () => {
    // Everything printed through every console method is captured and
    // searched for the three values that must never be written down. The
    // grant goes through `worker.fetch` in a non-development environment, so
    // the rate limiters run (and, with no Cache API under bun, log their fault
    // line: the dedupe is reset so that line is printed here). Hono's request
    // logger holds its own reference to `console.log`, taken when the app was
    // built, so it is captured separately below.
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const lines: string[] = [];
    const spies = methods.map((method) =>
      spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(
          args.map((a) => (typeof a === "string" ? a : (JSON.stringify(a) ?? String(a)))).join(" "),
        );
      }),
    );
    __resetRateLimitLogsForTests();
    let code = "";
    let session = "";
    try {
      console.error("capture-canary");
      const userId = seedUser("no-logs@nemar.test");
      const ctx = {
        waitUntil: (p: Promise<unknown>) => {
          p.catch(() => {});
        },
        passThroughOnException: () => {},
      } as unknown as ExecutionContext;
      const granted = await worker.fetch(
        new Request("https://api.nemar.org/auth/private/grant", {
          method: "POST",
          headers: {
            Cookie: `nemar_session=${await appSession(userId)}`,
            Origin: APP,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ state: STATE }),
        }),
        env(),
        ctx,
      );
      expect(granted.status).toBe(200);
      code = ((await granted.json()) as { code: string }).code;

      // A refused exchange first (wrong state), then the real one.
      expect((await exchange(code, {}, "W".repeat(43))).ok).toBe(false);
      const exchanged = await exchange(code);
      if (!exchanged.ok) throw new Error(exchanged.error);
      session = exchanged.session;
      expect((await resolvePrincipal(env(), { kind: "session", value: session })).ok).toBe(true);
      expect(await revokePrivateSession(env(), { value: session })).toEqual({ ok: true });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    // The capture works, and saw the limiter's own line, so an empty search
    // below is a real result and not a broken spy.
    expect(lines).toContain("capture-canary");
    expect(lines.some((line) => line.includes("[rate-limit]"))).toBe(true);
    for (const secret of [STATE, code, session]) {
      expect(secret.length).toBeGreaterThan(20);
      expect(lines.filter((line) => line.includes(secret))).toEqual([]);
    }
  });

  test("the request logger the app mounts first prints neither the state nor the code", async () => {
    // Hono's `logger()` is the first middleware in `index.ts`; built here with
    // a capturing print function in front of the same grant route.
    const printed: string[] = [];
    const logged = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    logged.use(
      "*",
      logger((line: string) => printed.push(line)),
    );
    logged.route("/auth", authPrivateRoutes);
    const userId = seedUser("no-logs-logger@nemar.test");
    const res = await logged.request(
      "/auth/private/grant",
      {
        method: "POST",
        headers: {
          Cookie: `nemar_session=${await appSession(userId)}`,
          Origin: APP,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ state: STATE }),
      },
      env(),
    );
    expect(res.status).toBe(200);
    const { code } = (await res.json()) as { code: string };
    expect(printed.some((line) => line.includes("/auth/private/grant"))).toBe(true);
    for (const secret of [STATE, code]) {
      expect(printed.filter((line) => line.includes(secret))).toEqual([]);
    }
  });
});
