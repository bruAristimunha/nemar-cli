/**
 * Real route tests for the docs admin gate (epic #1336 phase 0, issue #1338).
 *
 * Real engine throughout: bun:sqlite behind `realD1` with every migration
 * applied, real Hono dispatch via `app.request()`, real zod validation, real
 * session issuance via `issueSession()`, real SHA-256 hashing of the one-time
 * code. No mocks.
 *
 * THE TESTS THAT MATTER MOST are the two scope-crossing ones, and the second was
 * added after review found the hole it covers. Both scopes live in one
 * `web_sessions` table, so the only thing keeping them apart is a `scope`
 * predicate at every reader -- and there are TWO readers:
 * `findSessionByCookieId`, and a second copy of the same SELECT in
 * `middleware/auth.ts` that backs the whole management API. The first version of
 * this change put the predicate on the first reader only, so the docs credential
 * authenticated `/admin/*`: a read-only documentation session was an owner-grade
 * API session. So the crossing is asserted in BOTH directions here, the
 * docs-to-app direction against the real `authMiddleware`, not against
 * `webSessionMiddleware` -- testing the wrong middleware is exactly how that hole
 * survived a suite that claimed to cover it.
 *
 * WHAT THIS FILE CANNOT EXERCISE, BY CONSTRUCTION (`.rules/testing.md`: say so
 * when real data cannot falsify a rule). The actual concurrent race that
 * `DOCS_MINT_CONSUME_SQL`'s `EXISTS` gate closes -- two exchanges spending one
 * code simultaneously -- cannot be produced here: bun:sqlite is a single writer
 * with no interleaving hook, so the "second attempt is refused" assertions
 * below prove the statement's own mutual exclusion over sequential calls, not
 * that two simultaneous callers cannot both win.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  DOCS_CLI_SESSION_TTL_SECONDS,
  DOCS_GRANT_TTL_SECONDS,
  DOCS_SESSION_HEADER,
  DOCS_SESSION_TTL_SECONDS,
} from "../../shared/contract/docs-auth.js";
import worker from "../src/index";
import { notFoundBody } from "../src/lib/not-found";
import { authMiddleware } from "../src/middleware/auth";
import { __selectBucket } from "../src/middleware/rateLimit";
import { authDocsRoutes } from "../src/routes/auth-docs";
import { authWebRoutes } from "../src/routes/auth-web";
import { DOCS_CLI_MINT_INSERT_SQL, hashGrantCode } from "../src/services/docs-auth";
import { hashApiKey } from "../src/services/token";
import { type AuthMethod, issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const APP = "https://app.nemar.org";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    APP_BASE_URL: APP,
    WEB_SESSION_COOKIE_DOMAIN: "",
    API_BASE_URL: "http://localhost:8787",
  } as unknown as Bindings;
}

beforeEach(() => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authWebRoutes);
  app.route("/auth", authDocsRoutes);
});

// --------------------------------------------------------------------------
// Seeding
// --------------------------------------------------------------------------

function seedUser(email: string, role: "member" | "admin" | "owner" = "admin"): number {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, signup_source, email_verified, account_kind)
     VALUES (?, ?, 'x', 'approved', ?, 'web', 1, 'person')`,
    [email.split("@")[0], email, role],
  );
  const row = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!row) throw new Error("seed failed");
  return row.id;
}

/** Give a seeded account a live CLI API key and return the plaintext. */
async function seedApiKey(userId: number, apiKey: string): Promise<string> {
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    userId,
    await hashApiKey(apiKey),
    apiKey.slice(0, 8),
  );
  return apiKey;
}

async function cliSession(apiKey?: string, extraHeaders: Record<string, string> = {}) {
  return app.request(
    "/auth/docs/cli-session",
    {
      method: "POST",
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...extraHeaders,
      },
    },
    env(),
  );
}

async function appSession(userId: number, authMethod: AuthMethod = "orcid"): Promise<string> {
  const { cookieIdRaw } = await issueSession(
    env(),
    userId,
    false,
    "test-agent",
    "127.0.0.1",
    authMethod,
  );
  return cookieIdRaw;
}

function grantRow(codeHash: string) {
  return db
    .query<
      { code_hash: string; user_id: number; auth_method: string | null; expires_at: string },
      [string]
    >("SELECT code_hash, user_id, auth_method, expires_at FROM docs_grants WHERE code_hash = ?")
    .get(codeHash);
}

function docsSessionCount(userId: number): number {
  const row = db
    .query<{ n: number }, [number]>(
      "SELECT COUNT(*) AS n FROM web_sessions WHERE user_id = ? AND scope = 'docs'",
    )
    .get(userId);
  return row?.n ?? 0;
}

async function grant(cookie: string): Promise<Response> {
  return app.request(
    "/auth/docs/grant",
    { method: "POST", headers: { Cookie: `nemar_session=${cookie}`, Origin: APP } },
    env(),
  );
}

async function exchange(code: string): Promise<Response> {
  return app.request(
    "/auth/docs/exchange",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    },
    env(),
  );
}

async function verify(sessionValue: string): Promise<Response> {
  return app.request(
    "/auth/docs/verify",
    { headers: { [DOCS_SESSION_HEADER]: sessionValue } },
    env(),
  );
}

/** The whole flow, for tests whose subject is what happens afterwards. */
async function signInToDocs(userId: number): Promise<string> {
  const cookie = await appSession(userId);
  const granted = await grant(cookie);
  expect(granted.status).toBe(200);
  const { code } = (await granted.json()) as { code: string };
  const exchanged = await exchange(code);
  expect(exchanged.status).toBe(200);
  const { session } = (await exchanged.json()) as { session: string };
  return session;
}

// --------------------------------------------------------------------------
// POST /auth/docs/grant
// --------------------------------------------------------------------------

describe("POST /auth/docs/grant", () => {
  test("refuses a request with no session", async () => {
    // Origin is present so this isolates the missing session: the Origin check
    // runs first, deliberately, so omitting it here would assert 403 and prove
    // nothing about authentication.
    const res = await app.request(
      "/auth/docs/grant",
      { method: "POST", headers: { Origin: APP } },
      env(),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unauthenticated");
  });

  test("refuses a request with no Origin header", async () => {
    // A server-side fetch sends no Origin of its own, so the website's authorize
    // page must pin one. Without this check the route would be a cross-site POST
    // that mints a code from someone's ambient cookie.
    const userId = seedUser("admin-noorigin@nemar.test", "admin");
    const cookie = await appSession(userId);
    const res = await app.request(
      "/auth/docs/grant",
      { method: "POST", headers: { Cookie: `nemar_session=${cookie}` } },
      env(),
    );
    expect(res.status).toBe(403);
  });

  test("refuses a foreign Origin", async () => {
    const userId = seedUser("admin-badorigin@nemar.test", "admin");
    const cookie = await appSession(userId);
    const res = await app.request(
      "/auth/docs/grant",
      {
        method: "POST",
        headers: { Cookie: `nemar_session=${cookie}`, Origin: "https://evil.example" },
      },
      env(),
    );
    expect(res.status).toBe(403);
  });

  test("accepts the staging origin, not just production", async () => {
    // The caller pins its own request origin rather than a hardcoded host, so
    // test.nemar.org has to pass the *.nemar.org rule.
    const userId = seedUser("admin-staging@nemar.test", "admin");
    const cookie = await appSession(userId);
    const res = await app.request(
      "/auth/docs/grant",
      {
        method: "POST",
        headers: { Cookie: `nemar_session=${cookie}`, Origin: "https://test.nemar.org" },
      },
      env(),
    );
    expect(res.status).toBe(200);
  });

  test("answers 404, not 403, for a signed-in non-admin", async () => {
    // Mirrors adminGate on the website: someone who does not already know the
    // operations documentation exists must not learn it from a status code. The
    // body is the global handler's, not a distinct one -- see the
    // indistinguishability tests at the end of this file for why.
    const userId = seedUser("member@nemar.test", "member");
    const res = await grant(await appSession(userId));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("Not Found");
  });

  test("writes no grant row for a non-admin", async () => {
    const userId = seedUser("member2@nemar.test", "member");
    await grant(await appSession(userId));
    const row = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM docs_grants").get();
    expect(row?.n).toBe(0);
  });

  test("mints a code for an admin", async () => {
    const userId = seedUser("admin@nemar.test", "admin");
    const res = await grant(await appSession(userId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; expires_in: number };
    expect(body.expires_in).toBe(DOCS_GRANT_TTL_SECONDS);
    expect(body.code.length).toBeGreaterThan(20);
  });

  test("mints a code for an owner", async () => {
    const userId = seedUser("owner@nemar.test", "owner");
    const res = await grant(await appSession(userId));
    expect(res.status).toBe(200);
  });

  test("stores the code hashed, never in plaintext", async () => {
    const userId = seedUser("admin3@nemar.test", "admin");
    const res = await grant(await appSession(userId));
    const { code } = (await res.json()) as { code: string };
    expect(grantRow(await hashGrantCode(code))).toBeTruthy();
    const plaintext = db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM docs_grants WHERE code_hash = ?")
      .get(code);
    expect(plaintext?.n).toBe(0);
  });

  test("carries auth_method across from the app session", async () => {
    // So the docs session records that the identity behind it was proven by
    // ORCID, rather than resetting that history at the host boundary.
    const userId = seedUser("admin4@nemar.test", "admin");
    const res = await grant(await appSession(userId, "orcid"));
    const { code } = (await res.json()) as { code: string };
    expect(grantRow(await hashGrantCode(code))?.auth_method).toBe("orcid");
  });

  test("refuses a revoked app session", async () => {
    const userId = seedUser("admin5@nemar.test", "admin");
    const cookie = await appSession(userId);
    db.run("UPDATE web_sessions SET revoked_at = datetime('now') WHERE user_id = ?", [userId]);
    expect((await grant(cookie)).status).toBe(401);
  });

  test("a docs session cannot mint another grant", async () => {
    // The `ws.scope = 'app'` predicate in DOCS_GRANT_INSERT_SQL: without it one
    // eight-hour docs session could renew itself forever without ever
    // revisiting the app host.
    const userId = seedUser("admin6@nemar.test", "admin");
    const docsSession = await signInToDocs(userId);
    const res = await grant(docsSession);
    expect(res.status).toBe(401);
  });
});

// --------------------------------------------------------------------------
// POST /auth/docs/exchange
// --------------------------------------------------------------------------

describe("POST /auth/docs/exchange", () => {
  test("trades a live code for a docs session", async () => {
    const userId = seedUser("admin7@nemar.test", "admin");
    const granted = await grant(await appSession(userId));
    const { code } = (await granted.json()) as { code: string };

    const res = await exchange(code);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: string; max_age_seconds: number };
    expect(body.max_age_seconds).toBe(DOCS_SESSION_TTL_SECONDS);
    expect(body.session.length).toBeGreaterThan(20);
    expect(docsSessionCount(userId)).toBe(1);
  });

  test("consumes the grant, so the same code cannot be spent twice", async () => {
    const userId = seedUser("admin8@nemar.test", "admin");
    const granted = await grant(await appSession(userId));
    const { code } = (await granted.json()) as { code: string };

    expect((await exchange(code)).status).toBe(200);
    const second = await exchange(code);
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error: string }).error).toBe("invalid_grant");
    // And no second session was created by the refused attempt.
    expect(docsSessionCount(userId)).toBe(1);
  });

  test("leaves no grant row behind after a successful exchange", async () => {
    const userId = seedUser("admin9@nemar.test", "admin");
    const granted = await grant(await appSession(userId));
    const { code } = (await granted.json()) as { code: string };
    await exchange(code);
    expect(grantRow(await hashGrantCode(code))).toBeNull();
  });

  test("refuses a code that never existed", async () => {
    const res = await exchange("not-a-real-code-at-all");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });

  test("refuses an expired grant", async () => {
    const userId = seedUser("admin10@nemar.test", "admin");
    const granted = await grant(await appSession(userId));
    const { code } = (await granted.json()) as { code: string };
    db.run("UPDATE docs_grants SET expires_at = datetime('now', '-1 second') WHERE code_hash = ?", [
      await hashGrantCode(code),
    ]);
    expect((await exchange(code)).status).toBe(400);
    expect(docsSessionCount(userId)).toBe(0);
  });

  test("refuses when the account was demoted after the grant", async () => {
    // Every gate is re-checked by the statement that mints, because state can
    // change between the two halves of a handoff.
    const userId = seedUser("admin11@nemar.test", "admin");
    const granted = await grant(await appSession(userId));
    const { code } = (await granted.json()) as { code: string };
    db.run("UPDATE users SET role = 'member' WHERE id = ?", [userId]);
    expect((await exchange(code)).status).toBe(400);
    expect(docsSessionCount(userId)).toBe(0);
  });

  test("refuses when the account was revoked after the grant", async () => {
    const userId = seedUser("admin12@nemar.test", "admin");
    const granted = await grant(await appSession(userId));
    const { code } = (await granted.json()) as { code: string };
    db.run("UPDATE users SET status = 'revoked' WHERE id = ?", [userId]);
    expect((await exchange(code)).status).toBe(400);
    expect(docsSessionCount(userId)).toBe(0);
  });

  test("the minted session is scoped docs and is not a remember-me session", async () => {
    const userId = seedUser("admin13@nemar.test", "admin");
    await signInToDocs(userId);
    const row = db
      .query<{ scope: string; remember: number; auth_method: string | null }, [number]>(
        "SELECT scope, remember, auth_method FROM web_sessions WHERE user_id = ? AND scope = 'docs'",
      )
      .get(userId);
    expect(row?.scope).toBe("docs");
    expect(row?.remember).toBe(0);
    expect(row?.auth_method).toBe("orcid");
  });
});

// --------------------------------------------------------------------------
// GET /auth/docs/verify
// --------------------------------------------------------------------------

describe("GET /auth/docs/verify", () => {
  test("refuses a request with no session header", async () => {
    const res = await app.request("/auth/docs/verify", {}, env());
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_session");
  });

  test("accepts a live docs session and reports the role", async () => {
    const userId = seedUser("admin14@nemar.test", "admin");
    const session = await signInToDocs(userId);
    const res = await verify(session);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; role: string; username: string | null };
    expect(body.ok).toBe(true);
    expect(body.role).toBe("admin");
    expect(body.username).toBe("admin14");
  });

  test("REFUSES AN APP SESSION COOKIE presented as a docs session", async () => {
    // The privilege crossing this gate would otherwise open: both scopes live
    // in one table, so without the scope predicate any dashboard cookie would
    // read the gated documentation.
    const userId = seedUser("admin15@nemar.test", "admin");
    const cookie = await appSession(userId);
    const res = await verify(cookie);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_session");
  });

  test("refuses an unknown session value", async () => {
    expect((await verify("nonsense-value")).status).toBe(401);
  });

  test("refuses once the docs session is revoked", async () => {
    const userId = seedUser("admin16@nemar.test", "admin");
    const session = await signInToDocs(userId);
    db.run("UPDATE web_sessions SET revoked_at = datetime('now') WHERE scope = 'docs'");
    expect((await verify(session)).status).toBe(401);
  });

  test("refuses once the docs session has expired", async () => {
    const userId = seedUser("admin17@nemar.test", "admin");
    const session = await signInToDocs(userId);
    db.run(
      "UPDATE web_sessions SET expires_at = datetime('now', '-1 second') WHERE scope = 'docs'",
    );
    expect((await verify(session)).status).toBe(401);
  });

  test("answers 403 when the account is demoted while holding a docs session", async () => {
    // Re-read on every call, so revoking an admin takes effect on the next page
    // view rather than eight hours later.
    const userId = seedUser("admin18@nemar.test", "admin");
    const session = await signInToDocs(userId);
    db.run("UPDATE users SET role = 'member' WHERE id = ?", [userId]);
    const res = await verify(session);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("not_authorized");
  });

  test("refuses when the account itself is revoked", async () => {
    const userId = seedUser("admin19@nemar.test", "admin");
    const session = await signInToDocs(userId);
    db.run("UPDATE users SET status = 'revoked' WHERE id = ?", [userId]);
    expect((await verify(session)).status).toBe(401);
  });
});

// --------------------------------------------------------------------------
// Cascade from the app's own sign-out
// --------------------------------------------------------------------------

describe("logout cascades to docs sessions", () => {
  test("signing out of the app revokes the docs session too", async () => {
    const userId = seedUser("admin20@nemar.test", "admin");
    const appCookie = await appSession(userId);
    const granted = await grant(appCookie);
    const { code } = (await granted.json()) as { code: string };
    const { session } = (await (await exchange(code)).json()) as { session: string };
    expect((await verify(session)).status).toBe(200);

    const out = await app.request(
      "/auth/logout",
      { method: "POST", headers: { Cookie: `nemar_session=${appCookie}`, Origin: APP } },
      env(),
    );
    expect(out.status).toBe(200);

    // Without the cascade this stays 200 for the rest of the eight hours.
    expect((await verify(session)).status).toBe(401);
  });

  test("one account's sign-out leaves another's docs session alone", async () => {
    const first = seedUser("admin21@nemar.test", "admin");
    const second = seedUser("admin22@nemar.test", "admin");
    const firstDocs = await signInToDocs(first);
    const secondDocs = await signInToDocs(second);

    const secondApp = await appSession(second);
    await app.request(
      "/auth/logout",
      { method: "POST", headers: { Cookie: `nemar_session=${secondApp}`, Origin: APP } },
      env(),
    );

    expect((await verify(secondDocs)).status).toBe(401);
    expect((await verify(firstDocs)).status).toBe(200);
  });
});

// --------------------------------------------------------------------------
// Scope crossing in the docs-to-app direction: the management API
// --------------------------------------------------------------------------

describe("a docs session is not an API session", () => {
  /** The real middleware the management API is mounted behind. */
  function apiApp(): Hono<{ Bindings: Bindings; Variables: Variables }> {
    const api = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    api.use("*", authMiddleware);
    api.get("/probe", (c) => c.json({ reached: true, user: c.var.user?.username ?? null }));
    return api;
  }

  test("REFUSES a docs session presented as the app cookie", async () => {
    // The critical case. Before the fix this answered 200, so the eight-hour
    // credential the docs host holds was a full API session: read every user's
    // email, promote an account, delete a dataset.
    const userId = seedUser("admin-crossing@nemar.test", "admin");
    const docsSession = await signInToDocs(userId);
    const res = await apiApp().request(
      "/probe",
      { headers: { Cookie: `nemar_session=${docsSession}` } },
      env(),
    );
    expect(res.status).toBe(401);
  });

  test("still accepts an ordinary app session on the same route", async () => {
    // The other half: the fix must not have broken cookie auth for the API.
    const userId = seedUser("admin-appcookie@nemar.test", "admin");
    const cookie = await appSession(userId);
    const res = await apiApp().request(
      "/probe",
      { headers: { Cookie: `nemar_session=${cookie}` } },
      env(),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reached: boolean }).reached).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Sign-out ends what can still create access
// --------------------------------------------------------------------------

describe("logout purges outstanding grants", () => {
  test("a code minted before sign-out cannot be spent after it", async () => {
    // A grant is a 60-second licence to create a new eight-hour session, held by
    // whoever has the code, and the mint checks the account rather than the app
    // session that authorized it. So revoking sessions alone left a captured code
    // redeemable after sign-out.
    const userId = seedUser("admin-grantlogout@nemar.test", "admin");
    const cookie = await appSession(userId);
    const granted = await grant(cookie);
    const { code } = (await granted.json()) as { code: string };

    const out = await app.request(
      "/auth/logout",
      { method: "POST", headers: { Cookie: `nemar_session=${cookie}`, Origin: APP } },
      env(),
    );
    expect(out.status).toBe(200);

    expect((await exchange(code)).status).toBe(400);
    expect(docsSessionCount(userId)).toBe(0);
  });

  test("no grant row survives sign-out", async () => {
    const userId = seedUser("admin-grantrows@nemar.test", "admin");
    const cookie = await appSession(userId);
    await grant(cookie);
    await app.request(
      "/auth/logout",
      { method: "POST", headers: { Cookie: `nemar_session=${cookie}`, Origin: APP } },
      env(),
    );
    const row = db
      .query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM docs_grants WHERE user_id = ?")
      .get(userId);
    expect(row?.n).toBe(0);
  });

  test("an app session that has already lapsed still ends docs access", async () => {
    // The gap review found: the cascade was keyed off `c.var.webUser`, which
    // exists only while the app session is live. A docs session runs eight hours
    // from its mint and a non-remember app session 24 hours from sign-in, so the
    // windows do not nest and this state is ordinary rather than contrived --
    // sign out the next morning and it is exactly what you have. Sign-out then
    // answered `ok`, cleared the cookie, and left both the docs session and an
    // unspent grant fully usable.
    const userId = seedUser("admin-lapsed@nemar.test", "admin");
    const appCookie = await appSession(userId);
    const { code } = (await (await grant(appCookie)).json()) as { code: string };
    const { session } = (await (await exchange(code)).json()) as { session: string };
    const { code: unspent } = (await (await grant(appCookie)).json()) as { code: string };
    expect((await verify(session)).status).toBe(200);

    db.run(
      "UPDATE web_sessions SET expires_at = datetime('now', '-1 hour') WHERE user_id = ? AND scope = 'app'",
      [userId],
    );

    const out = await app.request(
      "/auth/logout",
      { method: "POST", headers: { Cookie: `nemar_session=${appCookie}`, Origin: APP } },
      env(),
    );
    expect(out.status).toBe(200);

    expect((await verify(session)).status).toBe(401);
    expect((await exchange(unspent)).status).toBe(400);
    const rows = db
      .query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM docs_grants WHERE user_id = ?")
      .get(userId);
    expect(rows?.n).toBe(0);
  });

  test("a failed cascade leaves nothing revoked, so the retry can still finish it", async () => {
    // Why this is one `db.batch` and not two round trips. The app-row revoke and
    // the docs cascade constrain each other: the account can only be resolved
    // from an UNREVOKED row (or a signed-out cookie value would stay a revoke
    // handle forever), so revoking first and failing second used to leave docs
    // access live with the app row already gone -- and then retrying the same
    // request resolved nothing and did nothing. Unrecoverable through the route,
    // which is the shape `finalizeRevocation` orders its own statements to avoid.
    //
    // The fault is real rather than injected: `docs_grants` is renamed out from
    // under the last statement, so D1's batch -- one transaction -- rolls the
    // whole thing back. Renaming it back is the "D1 recovered" half.
    const userId = seedUser("admin-atomic@nemar.test", "admin");
    const appCookie = await appSession(userId);
    const { code } = (await (await grant(appCookie)).json()) as { code: string };
    const { session } = (await (await exchange(code)).json()) as { session: string };
    const logout = () =>
      app.request(
        "/auth/logout",
        { method: "POST", headers: { Cookie: `nemar_session=${appCookie}`, Origin: APP } },
        env(),
      );

    db.run("ALTER TABLE docs_grants RENAME TO docs_grants_broken");
    expect((await logout()).status).toBe(200);
    // Nothing landed: the app row is still live, which is what keeps the retry
    // able to resolve the account.
    const live = db
      .query<{ n: number }, [number]>(
        "SELECT COUNT(*) AS n FROM web_sessions WHERE user_id = ? AND scope = 'app' AND revoked_at IS NULL",
      )
      .get(userId);
    expect(live?.n).toBe(1);
    expect((await verify(session)).status).toBe(200);

    db.run("ALTER TABLE docs_grants_broken RENAME TO docs_grants");
    expect((await logout()).status).toBe(200);
    expect((await verify(session)).status).toBe(401);
  });

  test("a REVOKED cookie cannot tear down the session signed in after it", async () => {
    // The other side of resolving the account from the cookie: the lookup keeps
    // `revoked_at IS NULL`, so a value that has already been signed out confers
    // nothing -- including the power to revoke. Without that predicate, an old
    // cookie value became a permanent handle for ending this account's docs
    // access on demand, and nothing prunes `web_sessions`, so it would never
    // stop working.
    const userId = seedUser("admin-replay@nemar.test", "admin");
    const firstCookie = await appSession(userId);
    const logout = (cookie: string) =>
      app.request(
        "/auth/logout",
        { method: "POST", headers: { Cookie: `nemar_session=${cookie}`, Origin: APP } },
        env(),
      );
    await logout(firstCookie);

    // Sign in again: new app session, new docs session, new grant.
    const secondCookie = await appSession(userId);
    const { code } = (await (await grant(secondCookie)).json()) as { code: string };
    const { session } = (await (await exchange(code)).json()) as { session: string };
    const { code: unspent } = (await (await grant(secondCookie)).json()) as { code: string };
    expect((await verify(session)).status).toBe(200);

    // Replay the dead cookie.
    expect((await logout(firstCookie)).status).toBe(200);

    expect((await verify(session)).status).toBe(200);
    expect((await exchange(unspent)).status).toBe(200);
  });

  test("one account's sign-out leaves another's grant alone", async () => {
    const first = seedUser("admin-g1@nemar.test", "admin");
    const second = seedUser("admin-g2@nemar.test", "admin");
    const firstGrant = (await (await grant(await appSession(first))).json()) as { code: string };
    const secondCookie = await appSession(second);
    await grant(secondCookie);
    await app.request(
      "/auth/logout",
      { method: "POST", headers: { Cookie: `nemar_session=${secondCookie}`, Origin: APP } },
      env(),
    );
    expect((await exchange(firstGrant.code)).status).toBe(200);
  });
});

// --------------------------------------------------------------------------
// The status gate matches the API's own
// --------------------------------------------------------------------------

describe("account status", () => {
  test("a pending account cannot mint a docs session", async () => {
    // The gate used to be a hand-rolled `!= 'revoked'`, which admitted `pending` --
    // a status the API's own cookie path refuses. An admin-only surface must not be
    // easier to enter than the API it documents.
    const userId = seedUser("admin-pending@nemar.test", "admin");
    db.run("UPDATE users SET status = 'pending', email_verified = 0 WHERE id = ?", [userId]);
    const cookie = await appSession(userId);
    const granted = await grant(cookie);
    expect(granted.status).toBe(200);
    const { code } = (await granted.json()) as { code: string };
    expect((await exchange(code)).status).toBe(400);
    expect(docsSessionCount(userId)).toBe(0);
  });

  test("a LIVE docs session stops verifying when the account leaves that status", async () => {
    // The other half of the same rule, and the half that was missing: the mint
    // applied `ACTIVE_ACCOUNT_STATUSES` while the standing check inherited
    // `findSessionByCookieId`'s looser `!= 'revoked'`, so the entry gate was
    // stricter than the gate on every subsequent page view. That reader has to
    // stay loose (a `pending` account reaches Settings through it to fix the
    // address that made it pending), so `verify` applies the rule itself.
    const userId = seedUser("admin-statusdrop@nemar.test", "admin");
    const session = await signInToDocs(userId);
    expect((await verify(session)).status).toBe(200);

    db.run("UPDATE users SET status = 'pending', email_verified = 0 WHERE id = ?", [userId]);
    const res = await verify(session);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_session");
  });

  test("`verified` still verifies, so the rule is the API's and not approved-only", async () => {
    // ADR 0040's base tier. Refusing it here would lock out an admin whose
    // account is perfectly able to authenticate against the API.
    const userId = seedUser("admin-verified@nemar.test", "admin");
    const session = await signInToDocs(userId);
    db.run("UPDATE users SET status = 'verified' WHERE id = ?", [userId]);
    expect((await verify(session)).status).toBe(200);
  });
});

// --------------------------------------------------------------------------
// The non-admin 404 against the 404 the worker really produces
// --------------------------------------------------------------------------

/**
 * WHY THIS DRIVES `worker.fetch` AND NOT THE LOCAL `app`. The first version of
 * these tests built a bare Hono app with two sub-apps and no notFound handler,
 * then asserted a hand-TYPED copy of the body it expected. It never compared the
 * two responses, so it could not see what review found: `api.notFound` in
 * index.ts is unreachable from the worker entry, because Hono's `route()` copies
 * a sub-app's routes and not its notFound handler. Every genuinely unrouted
 * request to api.nemar.org was answering Hono's plain-text default while this
 * route answered JSON, so the 404 announced itself by content type. A
 * transcription cannot catch that; only the real entry point can.
 *
 * `ENVIRONMENT: "development"` is the documented rate-limit bypass, the same
 * infrastructure concession `mcp-fork.test.ts` makes to drive this entry point.
 */
describe("the non-admin 404 is the same 404 an unrouted path gets", () => {
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      p.catch(() => {});
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;

  function workerEnv(environment = "development"): Bindings {
    return {
      DB: realD1(db),
      ENVIRONMENT: environment,
      APP_BASE_URL: APP,
      WEB_SESSION_COOKIE_DOMAIN: "",
    } as unknown as Bindings;
  }

  function workerPost(path: string, cookie?: string, environment?: string): Promise<Response> {
    return worker.fetch(
      new Request(`https://api.nemar.org${path}`, {
        method: "POST",
        headers: { Origin: APP, ...(cookie ? { Cookie: `nemar_session=${cookie}` } : {}) },
      }),
      workerEnv(environment),
      ctx,
    );
  }

  test("the body comes from the shared builder rather than a copy of it", async () => {
    const userId = seedUser("member-404@nemar.test", "member");
    const res = await workerPost("/auth/docs/grant", await appSession(userId));
    expect(res.status).toBe(404);
    // `notFoundBody` is what `app.notFound` is registered with, imported here
    // instead of retyped: a test that retypes the body passes whatever the
    // production 404 later becomes.
    expect(await res.json()).toEqual(notFoundBody("POST", "/auth/docs/grant"));
  });

  test("an actually-unrouted neighbour answers in the same format", async () => {
    // The assertion that failed before `app.notFound` existed: this path
    // returned `text/plain` with the body `404 Not Found`, so the two were
    // trivially distinguishable.
    const res = await workerPost("/auth/docs/grant-not-a-route");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual(notFoundBody("POST", "/auth/docs/grant-not-a-route"));
  });

  test("the two responses agree on every header the gate itself controls", async () => {
    // Under the rate-limit bypass this is a total header match, which is the
    // narrow claim: nothing on the refusal path adds a header of its OWN. Note
    // which examples that does and does not cover -- `Cache-Control` is not one
    // of them, because global middleware already puts `no-store` on both
    // responses, so adding it here would be a no-op. What it does catch is a
    // header only the refusal carries (an `X-Docs-Gate`, a differing content
    // type), which is what the hand-built version of this response was at risk
    // of growing.
    const userId = seedUser("member-404b@nemar.test", "member");
    const refused = await workerPost("/auth/docs/grant", await appSession(userId));
    const unrouted = await workerPost("/auth/docs/grxnt");
    expect(refused.status).toBe(unrouted.status);
    const headers = (res: Response) =>
      [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).sort();
    expect(headers(refused)).toEqual(headers(unrouted));
  });

  test("but in production the rate-limit bucket gives the route away regardless", async () => {
    // The header match above holds only under the rate-limit bypass, and the
    // first version of this block generalised from that to production. It does
    // not hold there: `/auth/docs/grant` is in `AUTH_PATHS`, so it answers from
    // the strict `auth-ip` bucket while an unrouted neighbour falls to the
    // generic `ip` bucket, and `rateLimiter` puts the bucket name and its limit
    // in `X-RateLimit-*` on both. So the refusal is distinguishable by anyone
    // who looks, without a session.
    //
    // Asserted through `__selectBucket` rather than by driving the worker in a
    // rate-limited environment, because `caches.default` does not exist under
    // `bun test` -- the limiter logs a cache failure, fails open, and sets no
    // headers at all, so a worker-driven version of this test would "pass" by
    // finding no difference whatsoever. The classification is the fact worth
    // pinning anyway.
    //
    // Pinned rather than fixed, deliberately: hiding it would mean taking this
    // route out of the strict bucket, a real protection, to buy a disguise the
    // family already gives up (`exchange` answers 400 to a malformed body,
    // `verify` 401 to any caller, neither needing a session). The 404 is there
    // for parity with `adminGate`, not for non-disclosure, and this is the
    // evidence for saying so out loud.
    const refused = __selectBucket("/auth/docs/grant", undefined, "203.0.113.7");
    const unrouted = __selectBucket("/auth/docs/grxnt", undefined, "203.0.113.7");
    expect(refused.keyKind).toBe("auth-ip");
    expect(unrouted.keyKind).toBe("ip");
    expect(refused.maxRequests).not.toBe(unrouted.maxRequests);
  });
});

// --------------------------------------------------------------------------
// POST /auth/docs/cli-session (epic #1336 phase 3, issue #1341)
// --------------------------------------------------------------------------

describe("POST /auth/docs/cli-session", () => {
  const KEY = "nk_test_cli_session_key_0123456789abcdef";

  test("mints a docs session for an admin holding an API key", async () => {
    const userId = seedUser("admin-cli@nemar.test", "admin");
    await seedApiKey(userId, KEY);

    const res = await cliSession(KEY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: string;
      max_age_seconds: number;
      username: string | null;
    };
    expect(typeof body.session).toBe("string");
    expect(body.session.length).toBeGreaterThan(20);
    expect(body.max_age_seconds).toBe(DOCS_CLI_SESSION_TTL_SECONDS);
    expect(body.username).toBe("admin-cli");
    expect(docsSessionCount(userId)).toBe(1);
  });

  test("the row it writes is docs-scoped, not remembered, and records the key", async () => {
    const userId = seedUser("admin-cli-row@nemar.test", "owner");
    await seedApiKey(userId, KEY);
    expect((await cliSession(KEY)).status).toBe(200);

    const row = db
      .query<{ scope: string; remember: number; auth_method: string | null }, [number]>(
        "SELECT scope, remember, auth_method FROM web_sessions WHERE user_id = ? AND scope = 'docs'",
      )
      .get(userId);
    expect(row?.scope).toBe("docs");
    expect(row?.remember).toBe(0);
    // Not 'orcid' and not 'email_code': this session's identity was proven by a
    // key, and the column should say so rather than inherit a browser's story.
    expect(row?.auth_method).toBe("api_key");
  });

  test("the TTL is much shorter than the browser session's", async () => {
    // Not a restatement of the constant: the point is the RELATION. A program's
    // credential reaches shell histories and agent transcripts, so it must not
    // simply inherit the eight hours a person at a keyboard gets.
    expect(DOCS_CLI_SESSION_TTL_SECONDS).toBeLessThan(DOCS_SESSION_TTL_SECONDS);
  });

  test("the minted value passes verify and reports the role", async () => {
    const userId = seedUser("admin-cli-verify@nemar.test", "admin");
    await seedApiKey(userId, KEY);
    const { session } = (await (await cliSession(KEY)).json()) as { session: string };

    const res = await verify(session);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      username: "admin-cli-verify",
      role: "admin",
    });
  });

  test("refuses a request with no Authorization header", async () => {
    const res = await cliSession();
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unauthenticated");
  });

  test("refuses a key that does not exist", async () => {
    const res = await cliSession("nk_not_a_real_key_0123456789abcdefghij");
    expect(res.status).toBe(401);
  });

  test("refuses a revoked key, and mints nothing", async () => {
    const userId = seedUser("admin-cli-revoked@nemar.test", "admin");
    await seedApiKey(userId, KEY);
    db.run("UPDATE tokens SET revoked_at = datetime('now') WHERE user_id = ?", [userId]);

    expect((await cliSession(KEY)).status).toBe(401);
    expect(docsSessionCount(userId)).toBe(0);
  });

  test("refuses a live key on a non-admin account with 404, and mints nothing", async () => {
    // The same disguise `grant` gives a signed-in non-admin. Asserted here
    // because the two entrances must answer alike: one of them saying 403 would
    // tell a caller their account was checked and found wanting. Like the
    // demotion test below, this is a claim about the ANSWER, not about which of
    // the two role gates produced it.
    const userId = seedUser("member-cli@nemar.test", "member");
    await seedApiKey(userId, KEY);

    const res = await cliSession(KEY);
    expect(res.status).toBe(404);
    expect(docsSessionCount(userId)).toBe(0);
  });

  test("refuses a live key on an account that is not active, and mints nothing", async () => {
    // `pending` is the case that matters: `findSessionByCookieId` admits it so a
    // pending account can reach Settings to fix its address, and an admin-only
    // reading surface must never be easier to enter than the API it documents.
    const userId = seedUser("admin-cli-pending@nemar.test", "admin");
    await seedApiKey(userId, KEY);
    db.run("UPDATE users SET status = 'pending', email_verified = 0 WHERE id = ?", [userId]);

    const res = await cliSession(KEY);
    expect(res.status).toBe(403);
    expect(docsSessionCount(userId)).toBe(0);
  });

  test("an account demoted after its key was issued gets nothing", async () => {
    // Role is read per request, not carried on the token: a key minted while
    // the account was an admin buys nothing once it is not. That is what this
    // proves, and NOT which layer refuses -- the route's own check and the mint
    // statement's WHERE clause each suffice on their own, so removing either
    // alone leaves this test green (measured). The statement-level test below
    // is what pins the redundant layer.
    const userId = seedUser("admin-cli-demoted@nemar.test", "admin");
    await seedApiKey(userId, KEY);
    db.run("UPDATE users SET role = 'member' WHERE id = ?", [userId]);

    expect((await cliSession(KEY)).status).toBe(404);
    expect(docsSessionCount(userId)).toBe(0);
  });

  test("THE APP COOKIE IS NOT ACCEPTED HERE", async () => {
    // The load-bearing one. `authMiddleware` would take either credential, and
    // taking the cookie here would make this route a cross-site POST away from
    // minting a docs credential from a browser's ambient session -- `grant`
    // checks `Origin` before anything else precisely because it does accept a
    // cookie. This route resolves the bearer itself so the cookie path is
    // absent rather than merely discouraged.
    const userId = seedUser("admin-cli-cookie@nemar.test", "admin");
    const cookie = await appSession(userId);

    const res = await cliSession(undefined, { Cookie: `nemar_session=${cookie}` });
    expect(res.status).toBe(401);
    expect(docsSessionCount(userId)).toBe(0);
  });

  test("the minted value does not authenticate the management API", async () => {
    // The scope crossing, asserted against the real `authMiddleware` rather
    // than `webSessionMiddleware`: testing the wrong middleware is how the
    // original version of this hole survived a suite that claimed to cover it.
    const userId = seedUser("admin-cli-scope@nemar.test", "admin");
    await seedApiKey(userId, KEY);
    const { session } = (await (await cliSession(KEY)).json()) as { session: string };

    const guarded = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    guarded.get("/protected", authMiddleware, (c) => c.json({ ok: true }));
    const res = await guarded.request(
      "/protected",
      { headers: { Cookie: `nemar_session=${session}` } },
      env(),
    );
    expect(res.status).toBe(401);
  });

  test("neither the credential nor ANY refusal may be cached", async () => {
    const userId = seedUser("admin-cli-cache@nemar.test", "admin");
    await seedApiKey(userId, KEY);
    expect((await cliSession(KEY)).headers.get("Cache-Control")).toBe("no-store");
    // The 401 path builds its response inside `resolveBearerUser`, which knows
    // nothing about this file's cache rule, so the route has to add it -- and a
    // dropped header there would otherwise be invisible.
    expect(
      (await cliSession("nk_not_a_real_key_0123456789abcdefghij")).headers.get("Cache-Control"),
    ).toBe("no-store");

    // THE 404 WAS THE GAP. This test used to cover the 200 and the 401 only,
    // i.e. the two paths that already complied, while its title claimed the
    // file-wide invariant. Both 404s here return `notFoundResponse`, which
    // carried no cache header at all, so the invariant was false and nothing
    // said so. It is set in `lib/not-found.ts` now, which keeps the refusal
    // byte-identical to a genuinely unrouted 404 (see the disguise tests below)
    // instead of making it distinguishable by one header.
    const memberId = seedUser("member-cli-cache@nemar.test", "member");
    await seedApiKey(memberId, "nk_member_cache_key_0123456789abcdef");
    const disguised = await cliSession("nk_member_cache_key_0123456789abcdef");
    expect(disguised.status).toBe(404);
    expect(disguised.headers.get("Cache-Control")).toBe("no-store");
  });

  describe("the mint statement's own gates", () => {
    // RUN DIRECTLY, because through the route they cannot be observed. The
    // route refuses a non-admin before reaching this statement, so removing the
    // statement's role gate changes no response; removing the route's check
    // changes none either, because the statement then refuses. Each layer hides
    // the other, which is what defense in depth means and also why a
    // route-level test can never pin either one. These run the SQL against the
    // same real schema the routes use and assert the contract the constant
    // claims for itself: it mints, or it inserts nothing.
    //
    // The bindings are the route's, in the route's order: cookieIdHash,
    // ttlSeconds, userAgent, ipHash, userId.
    function mintDirect(userId: number, cookieHash = `hash-${userId}`): number {
      return (
        db.query(DOCS_CLI_MINT_INSERT_SQL).run(cookieHash, 900, "test-agent", null, userId)
          .changes ?? 0
      );
    }

    test("inserts one row for an active admin", () => {
      const userId = seedUser("stmt-admin@nemar.test", "admin");
      expect(mintDirect(userId)).toBe(1);
      expect(docsSessionCount(userId)).toBe(1);
    });

    test("inserts nothing for a member", () => {
      const userId = seedUser("stmt-member@nemar.test", "member");
      expect(mintDirect(userId)).toBe(0);
      expect(docsSessionCount(userId)).toBe(0);
    });

    test("inserts nothing for an admin whose account is not active", () => {
      const userId = seedUser("stmt-pending@nemar.test", "admin");
      db.run("UPDATE users SET status = 'pending', email_verified = 0 WHERE id = ?", [userId]);
      expect(mintDirect(userId)).toBe(0);
    });

    test("inserts nothing for a soft-deleted admin", () => {
      const userId = seedUser("stmt-deleted@nemar.test", "admin");
      db.run("UPDATE users SET deleted_at = datetime('now') WHERE id = ?", [userId]);
      expect(mintDirect(userId)).toBe(0);
    });

    test("writes scope=docs and remember=0 as literals, not as binds", () => {
      // What this actually checks: the statement, run in the route's binding
      // order, produces a docs-scoped non-remembered row, and it goes red if
      // either literal changes. It does NOT exercise other argument orders, so
      // it cannot support the stronger claim its name used to make -- that no
      // bindings mistake could turn this into an app session. Reading the SQL
      // is still the evidence for that; this is the evidence for the default.
      const userId = seedUser("stmt-scope@nemar.test", "owner");
      expect(mintDirect(userId)).toBe(1);
      const row = db
        .query<{ scope: string; remember: number }, [number]>(
          "SELECT scope, remember FROM web_sessions WHERE user_id = ?",
        )
        .get(userId);
      expect(row?.scope).toBe("docs");
      expect(row?.remember).toBe(0);
    });
  });

  test("rides the strict per-IP rate-limit bucket", async () => {
    // Per-IP is a real per-caller key for this route, unlike `grant` and
    // `exchange`, which arrive from Worker egress addresses. Asserted through
    // `__selectBucket` because `caches.default` does not exist under bun test,
    // so a worker-driven version would fail open and find no difference at all.
    const selected = __selectBucket("/auth/docs/cli-session", `Bearer ${KEY}`, "203.0.113.9");
    expect(selected.keyKind).toBe("auth-ip");

    // AND UNDER THE OTHER MOUNT. `backend/src/index.ts` mounts the API at both
    // `/` and `/nemar`, and middleware sees the full path, so asserting only the
    // first spelling is how this route sat in the 500/min ip bucket (or, with a
    // bearer, the 1000/min token bucket and the admin bypass past it) for
    // anyone who typed the prefix. Every AUTH_PATHS entry had the same hole;
    // `rate-limit-buckets.test.ts` covers the family.
    const prefixed = __selectBucket("/nemar/auth/docs/cli-session", `Bearer ${KEY}`, "203.0.113.9");
    expect(prefixed.keyKind).toBe("auth-ip");
  });
});
