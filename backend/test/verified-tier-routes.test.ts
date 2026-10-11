/**
 * Real route tests for the `verified` base tier (ADR 0040 phase 2, #1252).
 *
 * Before this change every authenticated path required `status='approved'`,
 * so migration 0075 — which moves auto-approved web accounts down to
 * `verified`/`pending` — would have locked those accounts out of the tier they
 * now hold. These pin the widening at the boundary: which statuses can
 * authenticate, which cannot, and what a refused one is told to do.
 *
 * Real engine throughout: bun:sqlite behind realD1 with every migration
 * applied, real Hono dispatch through authMiddleware and real hashed API keys.
 * No mocks. RESEND_API_KEY is unset so no route here attempts a send.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { authRoutes } from "../src/routes/auth";
import { datasetRoutes } from "../src/routes/datasets";
import { sandboxRoutes } from "../src/routes/sandbox";
import { userRoutes } from "../src/routes/users";
import { hashApiKey } from "../src/services/token";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const KEY_PREFIX = "tierkey-0123456789abcdef0123456789abcdef-";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test", API_BASE_URL: "https://api.test" } as Bindings;
}

interface Seeded {
  id: number;
  username: string;
  email: string;
  apiKey: string;
}

/**
 * A CLI-shaped account at `status`, with a real password hash and (unless
 * `withToken` is false) a real hashed API key.
 */
async function seedUser(
  username: string,
  status: string,
  opts: { withToken?: boolean; serviceAccess?: 0 | 1; sandbox?: 0 | 1 } = {},
): Promise<Seeded> {
  const { withToken = true, serviceAccess = 0, sandbox = 0 } = opts;
  const email = `${username}@example.org`;
  db.run(
    `INSERT INTO users (username, email, github_username, status, role,
                        signup_source, email_verified, service_access, sandbox_completed)
     VALUES (?, ?, ?, ?, 'member', 'cli', ?, ?, ?)`,
    [
      username,
      email,
      `${username}-gh`,
      status,
      status === "pending" ? 0 : 1,
      serviceAccess,
      sandbox,
    ],
  );
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!row) throw new Error(`seed failed for ${username}`);
  const apiKey = `${KEY_PREFIX}${username}`;
  if (withToken) {
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      row.id,
      await hashApiKey(apiKey),
      apiKey.slice(0, 8),
    );
  }
  return { id: row.id, username, email, apiKey };
}

function authed(path: string, apiKey: string, init: RequestInit = {}): Promise<Response> {
  return app.request(
    path,
    { ...init, headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) } },
    env(),
  );
}

function postJson(path: string, body: unknown): Promise<Response> {
  return app.request(
    path,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    env(),
  );
}

beforeEach(() => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authRoutes);
  app.route("/users", userRoutes);
  app.route("/sandbox", sandboxRoutes);
  app.route("/datasets", datasetRoutes);
});

describe("the bearer-token middleware", () => {
  test("accepts a token held by a `verified` account", async () => {
    const user = await seedUser("tierverified", "verified");
    const res = await authed("/users/me", user.apiKey);
    expect(res.status).toBe(200);
    expect((await res.json()).user.username).toBe("tierverified");
  });

  test("still accepts a token held by an `approved` account", async () => {
    const user = await seedUser("tierapproved", "approved", { serviceAccess: 1 });
    expect((await authed("/users/me", user.apiKey)).status).toBe(200);
  });

  test("refuses a `pending` token, and tells it to verify the email", async () => {
    const user = await seedUser("tierpending", "pending");
    const res = await authed("/users/me", user.apiKey);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.status).toBe("pending");
    expect(body.message).toContain("Verify your email");
    // The instruction this replaced. Asserted negatively because it is the
    // specific wrong answer: nothing an admin does unblocks a pending
    // account, so telling it to wait for one is a dead end.
    expect(body.message).not.toContain("awaiting admin approval");
  });

  test("refuses a `revoked` token", async () => {
    const user = await seedUser("tierrevoked", "revoked");
    const res = await authed("/users/me", user.apiKey);
    expect(res.status).toBe(403);
    expect((await res.json()).message).toContain("revoked");
  });
});

describe("the cookie path of the same middleware", () => {
  async function cookieFor(userId: number): Promise<string> {
    const { cookieIdRaw } = await issueSession(env(), userId, false, null, null, "email_code");
    return `nemar_session=${cookieIdRaw}`;
  }

  function withCookie(path: string, cookie: string): Promise<Response> {
    return app.request(path, { headers: { Cookie: cookie } }, env());
  }

  test("accepts a `verified` session", async () => {
    const user = await seedUser("cookieverified", "verified", { withToken: false });
    const res = await withCookie("/users/me", await cookieFor(user.id));
    expect(res.status).toBe(200);
    expect((await res.json()).user.email).toBe(user.email);
  });

  test("refuses a `pending` session with the actionable 403, not a 401", async () => {
    // The bug this pins: a bare `null` from the cookie lookup fell through to
    // "Missing Authorization header" -- a 401 telling a signed-in browser it
    // sent no credentials, with nothing to act on.
    const user = await seedUser("cookiepending", "pending", { withToken: false });
    const res = await withCookie("/users/me", await cookieFor(user.id));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.status).toBe("pending");
    expect(body.message).toContain("Verify your email");
    expect(body.error).not.toContain("Missing Authorization");
  });

  test("refuses a `revoked` session the same way", async () => {
    const user = await seedUser("cookierevoked", "revoked", { withToken: false });
    const res = await withCookie("/users/me", await cookieFor(user.id));
    expect(res.status).toBe(403);
    expect((await res.json()).message).toContain("revoked");
  });

  test("no cookie at all is still the 401 it always was", async () => {
    const res = await app.request("/users/me", {}, env());
    expect(res.status).toBe(401);
    expect((await res.json()).error).toContain("Missing Authorization");
  });
});

describe("POST /auth/login", () => {
  test("a `verified` account can log in with its key", async () => {
    const user = await seedUser("loginverified", "verified");
    const res = await postJson("/auth/login", { api_key: user.apiKey });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.user.username).toBe("loginverified");
  });

  test("a `pending` account cannot, and is told why", async () => {
    const user = await seedUser("loginpending", "pending");
    const res = await postJson("/auth/login", { api_key: user.apiKey });
    expect(res.status).toBe(403);
    expect((await res.json()).message).toContain("Verify your email");
  });
});

// `POST /auth/retrieve-key` used to be tested here. It is retired (ADR 0097) and
// is pinned through the production entry point in password-routes-retired.test.ts.

describe("the sandbox routes", () => {
  test("a `verified` account can read its training status", async () => {
    const user = await seedUser("sandboxverified", "verified");
    const res = await authed("/sandbox/status", user.apiKey);
    expect(res.status).toBe(200);
    expect((await res.json()).sandbox_completed).toBe(false);
  });

  test("a `verified` account can complete training — no admin involved", async () => {
    // Sandbox training is the step a user takes BEFORE asking for upload
    // access, so requiring the upload grant to reach it would be circular.
    const user = await seedUser("sandboxrunner", "verified");
    db.run(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, is_sandbox, visibility, status)
       VALUES ('xx090001', 'Training run', ?, 1, 'private', 'active')`,
      [user.id],
    );

    const res = await authed("/sandbox/complete", user.apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataset_id: "xx090001" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).sandbox_completed).toBe(true);
    expect(
      db
        .query<{ sandbox_completed: number }, [number]>(
          "SELECT sandbox_completed FROM users WHERE id = ?",
        )
        .get(user.id)?.sandbox_completed,
    ).toBe(1);
  });

  test("a `pending` account cannot", async () => {
    const user = await seedUser("sandboxpending", "pending");
    expect((await authed("/sandbox/status", user.apiKey)).status).toBe(403);
  });
});

describe("the optional-auth middleware (GET /datasets?mine=true)", () => {
  test("resolves a `verified` token instead of falling through to anonymous", async () => {
    // A separate SQL predicate from authMiddleware's, so it can be (and was)
    // left behind: a token that resolves here returns the user's datasets,
    // and one that does not gets the 401 below instead.
    const user = await seedUser("optionalverified", "verified");
    const res = await authed("/datasets?mine=true", user.apiKey);
    expect(res.status).toBe(200);
    expect((await res.json()).datasets).toEqual([]);
  });

  test("a `pending` COOKIE degrades to anonymous rather than 403", async () => {
    // authMiddleware answers an inactive cookie with a 403 (it must, or a
    // signed-in browser is told it sent nothing). This middleware must NOT:
    // its whole job is to leave the route's anonymous branch reachable, and
    // a browser carrying a stale cookie should still be able to read the
    // public catalog.
    const user = await seedUser("optionalcookiepending", "pending", { withToken: false });
    const { cookieIdRaw } = await issueSession(env(), user.id, false, null, null, "email_code");

    const res = await app.request(
      "/datasets",
      { headers: { Cookie: `nemar_session=${cookieIdRaw}` } },
      env(),
    );

    expect(res.status).toBe(200);
    // The anonymous shape: the public catalog, not a user-scoped list.
    const body = await res.json();
    expect(Array.isArray(body.datasets)).toBe(true);
    // ...and it is genuinely anonymous: ?mine=true, which requires a resolved
    // user, is refused for the same cookie.
    const mine = await app.request(
      "/datasets?mine=true",
      { headers: { Cookie: `nemar_session=${cookieIdRaw}` } },
      env(),
    );
    expect(mine.status).toBe(401);
  });

  test("does not resolve a `pending` token", async () => {
    const user = await seedUser("optionalpending", "pending");
    const res = await authed("/datasets?mine=true", user.apiKey);
    expect(res.status).toBe(401);
    // authAttempted is still set, so the caller is told the KEY was
    // rejected rather than that they sent no header.
    expect((await res.json()).error).toContain("API key was rejected");
  });
});

describe("GET /users/me", () => {
  test("reports the upload grant separately from the tier", async () => {
    // The whole point of ADR 0040: an active account and an upload-capable
    // account are different things, and the CLI reads them off two fields.
    const base = await seedUser("mebase", "verified");
    const granted = await seedUser("megranted", "approved", { serviceAccess: 1 });

    expect((await (await authed("/users/me", base.apiKey)).json()).user.service_access).toBe(false);
    expect((await (await authed("/users/me", granted.apiKey)).json()).user.service_access).toBe(
      true,
    );
  });
});
