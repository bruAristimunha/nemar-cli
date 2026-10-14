/**
 * One Origin rule for the whole admin router (#1603, #1584; ADR 0103 decision 10).
 *
 * A session cookie rides along with any cross-site request a browser can be made to send, so a
 * cookie-authenticated write has to come from a NEMAR page; a bearer key cannot be forged
 * cross-site and a terminal sends no Origin, so it is not asked for one. Four routes each carried
 * their own copy of that rule (`approve-dispatch`, `identifier-screen`, `review/start`, `comment`)
 * and every other write on the router had none, so the rule is now one middleware,
 * `cookieOriginGuard`, mounted on the router after the role check.
 *
 * Nothing here lists the routes that must be guarded. The sweep iterates `adminRoutes.routes` the
 * way `admin-nonadmin-sweep.test.ts` does, so a write added to the router tomorrow is swept the day
 * it is registered, and a route that opts out of the guard cannot hide from it.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the real admin router
 * behind its real auth middleware (a hashed API key, and a real web session for the cookie path),
 * and no secret in the environment. The sweep's "must not be refused" halves run every handler of
 * the router once, and some of them reach for public hosts, so `fetch` is a tripwire for the whole
 * file: it refuses every call that is not to the loopback stand-in and records it, so no request can
 * leave the machine. The refused halves assert the record is empty, which is the proof that no
 * handler ran.
 *
 * CI TIER: unit-pure. Offline: the engine is in memory and the tripwire refuses every outbound call.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { OriginNotAllowedBody } from "../../shared/contract/publication-review-admin";
import { cookieOriginGuard } from "../src/middleware/auth";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { withFakeResend } from "./helpers/resend";

const ADMIN_KEY = "origin-admin-key-0123456789abcdef0123456789abcdef";
const APP_ORIGIN = "https://app.nemar.org";
const FOREIGN_ORIGIN = "https://evil.example";
const DATASET = "nm098765";

/** The three ways a cross-site or script-made request lacks a NEMAR origin. */
const REFUSED_ORIGINS: Array<{ label: string; headers: Record<string, string> }> = [
  { label: "a foreign Origin", headers: { Origin: FOREIGN_ORIGIN } },
  { label: "no Origin", headers: {} },
  { label: "the literal null Origin", headers: { Origin: "null" } },
];

const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let adminId: number;
let cookie: string;
let outbound: string[] = [];
let realFetch: typeof fetch;
const realConsole = { error: console.error, warn: console.warn, log: console.log };

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test" } as Bindings;
}

async function seedAdmin(): Promise<number> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('originadmin', 'originadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const row = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'originadmin'")
    .get();
  if (!row) throw new Error("seed: the admin insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    row.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
  return row.id;
}

/** A concrete URL for a registered route pattern, as the other router-wide sweeps build it. */
function concreteUrl(path: string): string {
  return `/admin${path.replace(/:[A-Za-z_]+/g, "nm000123")}`;
}

/** Every registered admin endpoint once, minus the router-level middleware entries. */
function adminEndpoints(): Array<{ method: string; path: string }> {
  const seen = new Set<string>();
  const out: Array<{ method: string; path: string }> = [];
  for (const r of adminRoutes.routes) {
    if (r.method === "ALL") continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method: r.method, path: r.path });
  }
  return out;
}

const unsafeEndpoints = () => adminEndpoints().filter((e) => !SAFE_METHODS.includes(e.method));
const readEndpoints = () => adminEndpoints().filter((e) => e.method === "GET");

interface Credentials {
  /** `cookie` sends the session; `key` sends the bearer key; neither is no credential. */
  as: "cookie" | "key";
  headers?: Record<string, string>;
}

function send(
  method: string,
  path: string,
  { as, headers = {} }: Credentials,
  body: unknown = {},
  bindings: Bindings = env(),
): Promise<Response> {
  const auth: Record<string, string> =
    as === "cookie" ? { Cookie: cookie } : { Authorization: `Bearer ${ADMIN_KEY}` };
  return app.request(
    path.startsWith("/admin") ? path : concreteUrl(path),
    {
      method,
      headers: { ...auth, "content-type": "application/json", ...headers },
      body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
    },
    bindings,
  );
}

/** Whether a response is the guard's refusal, read as text so a non-JSON 500 cannot throw. */
async function isOriginRefusal(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  return (await res.text()).includes('"origin_not_allowed"');
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  adminId = await seedAdmin();
  const { cookieIdRaw } = await issueSession(
    env(),
    adminId,
    false,
    "test-agent",
    "127.0.0.1",
    "orcid",
  );
  cookie = `nemar_session=${cookieIdRaw}`;
  outbound = [];
  // The sweeps run every handler on an empty database with no secret, and each one logs why it
  // could not do its work. That is expected and says nothing about the guard.
  console.error = () => {};
  console.warn = () => {};
  console.log = () => {};
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    // The Resend stand-in listens on loopback; everything else is a call that must not happen.
    if (new URL(request.url).hostname === "127.0.0.1") return realFetch(request);
    outbound.push(request.url);
    return Promise.reject(new Error("the test refuses every outbound call"));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realConsole.error;
  console.warn = realConsole.warn;
  console.log = realConsole.log;
});

describe("the sweep covers the router", () => {
  test("it sees every write, including the four routes that used to carry their own copy", () => {
    // An assertion over an empty list passes, so pin that the list is populated and names the
    // four routes whose private copies the router-wide rule replaced.
    const unsafe = unsafeEndpoints().map((e) => `${e.method} ${e.path}`);
    expect(unsafe.length).toBeGreaterThan(50);
    for (const route of [
      "POST /publish/:id/approve-dispatch",
      "POST /publish/:id/identifier-screen",
      "POST /publish/:id/review/start",
      "POST /publish/:id/comment",
    ]) {
      expect(unsafe).toContain(route);
    }
    // ...and writes that never had a rule of their own: the point of making it router-wide.
    expect(unsafe).toContain("POST /publish/:id/deny");
    expect(unsafe).toContain("POST /publish/:id/approve");
    expect(unsafe.some((r) => r.startsWith("PATCH "))).toBe(true);
    expect(unsafe.some((r) => r.startsWith("PUT "))).toBe(true);
    expect(unsafe.some((r) => r.startsWith("DELETE "))).toBe(true);
  });
});

describe("a session cookie on a write", () => {
  test("is refused 403 origin_not_allowed on EVERY unsafe admin route without a NEMAR origin", async () => {
    const surprises: string[] = [];
    for (const { method, path } of unsafeEndpoints()) {
      for (const { label, headers } of REFUSED_ORIGINS) {
        const res = await send(method, path, { as: "cookie", headers });
        const text = await res.text();
        if (res.status !== 403 || !text.includes('"origin_not_allowed"')) {
          surprises.push(`${method} ${path} with ${label} -> ${res.status}`);
        }
      }
    }
    // One assertion carrying every offender: a per-route expect would stop at the first.
    expect(surprises).toEqual([]);
    expect(outbound).toEqual([]);
  }, 30_000);

  test("passes the guard on EVERY unsafe admin route from a NEMAR origin", async () => {
    const surprises: string[] = [];
    for (const { method, path } of unsafeEndpoints()) {
      const res = await send(method, path, { as: "cookie", headers: { Origin: APP_ORIGIN } });
      // Whatever the handler answers on an empty database is its own business; what is pinned is
      // that the guard is not what answered.
      if (await isOriginRefusal(res)) surprises.push(`${method} ${path} -> ${res.status}`);
    }
    expect(surprises).toEqual([]);
  }, 30_000);

  test("a localhost origin passes too, because dev tools bind to ephemeral ports", async () => {
    const res = await send("POST", "/publish/nm000123/deny", {
      as: "cookie",
      headers: { Origin: "http://localhost:4321" },
    });
    expect(await isOriginRefusal(res)).toBe(false);
  });

  test("the refusal names the code and says why, in the sentence the four old copies sent", async () => {
    const res = await send("POST", "/publish/nm000123/deny", { as: "cookie" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "origin_not_allowed",
      code: "origin_not_allowed",
      message: "This request did not come from a NEMAR page, so it was not accepted.",
    } satisfies OriginNotAllowedBody);
  });
});

describe("a bearer key on a write", () => {
  test("is not asked for an Origin on ANY unsafe admin route, with none or with a foreign one", async () => {
    const surprises: string[] = [];
    for (const { method, path } of unsafeEndpoints()) {
      for (const { label, headers } of REFUSED_ORIGINS) {
        const res = await send(method, path, { as: "key", headers });
        if (await isOriginRefusal(res)) surprises.push(`${method} ${path} with ${label}`);
      }
    }
    expect(surprises).toEqual([]);
  }, 30_000);
});

describe("a read", () => {
  test("by cookie needs no Origin on any GET route, and a foreign one changes nothing", async () => {
    const surprises: string[] = [];
    for (const { path } of readEndpoints()) {
      for (const headers of [{}, { Origin: FOREIGN_ORIGIN }]) {
        const res = await send("GET", path, { as: "cookie", headers });
        if (await isOriginRefusal(res)) surprises.push(`GET ${path}`);
      }
    }
    expect(surprises).toEqual([]);
  }, 30_000);

  test("by cookie with no Origin is answered by the route", async () => {
    const res = await send("GET", "/users", { as: "cookie" });
    expect(res.status).toBe(200);
  });

  test("HEAD and OPTIONS with a cookie and no Origin are not refused by the guard", async () => {
    for (const method of ["HEAD", "OPTIONS"]) {
      const res = await send(method, "/users", { as: "cookie" });
      expect(await isOriginRefusal(res), method).toBe(false);
    }
  });
});

describe("approve and deny (the issue's acceptance)", () => {
  function seedRequest(status: string): number {
    db.run(
      `INSERT INTO publication_requests (dataset_id, status, requested_by, requested_at, updated_at)
       VALUES (?, ?, ?, datetime('now', '-3 hours'), datetime('now', '-3 hours'))`,
      [DATASET, status, adminId],
    );
    const id = db
      .query<{ id: number }, []>("SELECT MAX(id) AS id FROM publication_requests")
      .get()?.id;
    if (id === undefined) throw new Error("seed: the request insert failed");
    return id;
  }

  /** Everything a refused write must leave alone: every request row and every audit row. */
  function snapshot(): string {
    return JSON.stringify({
      requests: db.query("SELECT * FROM publication_requests ORDER BY id").all(),
      audit: db.query("SELECT * FROM audit_log ORDER BY id").all(),
    });
  }

  const override = { review_id: null, reasons: ["question_failed"] };

  /** The denial mails the request's depositor, who here is the seeded administrator. */
  const mailEnv = (): Bindings =>
    ({
      ...env(),
      RESEND_API_KEY: "re_test",
      DEV_EMAIL_ALLOWLIST: "originadmin@example.org",
    }) as Bindings;

  const statusOf = (id: number) =>
    db.query("SELECT status FROM publication_requests WHERE id = ?").get(id);

  test("deny: a cookie with a foreign Origin, no Origin or null is 403, changes nothing and mails nobody", async () => {
    const id = seedRequest("requested");
    const before = snapshot();
    await withFakeResend(async (mailed) => {
      for (const { label, headers } of REFUSED_ORIGINS) {
        const res = await send(
          "POST",
          `/admin/publish/${DATASET}/deny`,
          { as: "cookie", headers },
          { reason: "not a dataset" },
          mailEnv(),
        );
        expect(res.status, label).toBe(403);
        expect(((await res.json()) as { error: string }).error, label).toBe("origin_not_allowed");
      }
      expect(mailed).toHaveLength(0);
    });
    expect(snapshot()).toBe(before);
    expect(statusOf(id)).toEqual({ status: "requested" });
  });

  test("deny: a bearer key with no Origin works", async () => {
    const id = seedRequest("requested");
    await withFakeResend(async (mailed) => {
      const res = await send(
        "POST",
        `/admin/publish/${DATASET}/deny`,
        { as: "key" },
        { reason: "not a dataset" },
        mailEnv(),
      );
      expect(res.status).toBe(200);
      expect(mailed).toHaveLength(1);
    });
    expect(statusOf(id)).toEqual({ status: "denied" });
  });

  test("deny: a cookie from the app origin passes the guard", async () => {
    const id = seedRequest("requested");
    await withFakeResend(async (mailed) => {
      const res = await send(
        "POST",
        `/admin/publish/${DATASET}/deny`,
        { as: "cookie", headers: { Origin: APP_ORIGIN } },
        { reason: "not a dataset" },
        mailEnv(),
      );
      expect(res.status).toBe(200);
      expect(mailed).toHaveLength(1);
    });
    expect(statusOf(id)).toEqual({ status: "denied" });
  });

  test("approve: a cookie with a foreign Origin, no Origin or null is 403 and changes nothing", async () => {
    seedRequest("blocked");
    const before = snapshot();
    for (const { label, headers } of REFUSED_ORIGINS) {
      const res = await send("POST", `/admin/publish/${DATASET}/approve`, {
        as: "cookie",
        headers,
      });
      expect(res.status, label).toBe(403);
      expect(((await res.json()) as { error: string }).error, label).toBe("origin_not_allowed");
    }
    expect(snapshot()).toBe(before);
  });

  test("approve: a bearer key with no Origin reaches the approval", async () => {
    seedRequest("blocked");
    const res = await send("POST", `/admin/publish/${DATASET}/approve`, { as: "key" });
    // A blocked request is the approval's own, early, deterministic refusal.
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("request_blocked");
  });

  test("approve: a cookie from the app origin passes the guard and reaches the approval", async () => {
    seedRequest("blocked");
    const res = await send("POST", `/admin/publish/${DATASET}/approve`, {
      as: "cookie",
      headers: { Origin: APP_ORIGIN },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("request_blocked");
  });

  test("approve: an override still needs an API key behind the guard, even from the app origin", async () => {
    seedRequest("blocked");
    const before = snapshot();
    // The guard answers a cookie without a NEMAR origin; the route's own stricter rule answers
    // the one that has it, in its own sentence.
    const fromApp = await send(
      "POST",
      `/admin/publish/${DATASET}/approve`,
      { as: "cookie", headers: { Origin: APP_ORIGIN } },
      { override_publication_review: override },
    );
    expect(fromApp.status).toBe(403);
    const body = (await fromApp.json()) as { error: string; message: string };
    expect(body.error).toBe("origin_not_allowed");
    expect(body.message).toContain("approve-dispatch");

    const foreign = await send(
      "POST",
      `/admin/publish/${DATASET}/approve`,
      { as: "cookie", headers: { Origin: FOREIGN_ORIGIN } },
      { override_publication_review: override },
    );
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as { message: string }).message).not.toContain(
      "approve-dispatch",
    );
    expect(snapshot()).toBe(before);

    // An API key carries the override through to the approval, which refuses a blocked request.
    const withKey = await send(
      "POST",
      `/admin/publish/${DATASET}/approve`,
      { as: "key" },
      { override_publication_review: override },
    );
    expect(withKey.status).toBe(409);
    expect(((await withKey.json()) as { error: string }).error).toBe("request_blocked");
  });
});

describe("the guard on its own", () => {
  /** A router with nothing but the guard in front of one handler, and `authMethod` set as asked. */
  function guarded(authMethod: "token" | "cookie" | undefined) {
    const router = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    router.use("*", async (c, next) => {
      if (authMethod !== undefined) c.set("authMethod", authMethod);
      await next();
    });
    router.use("*", cookieOriginGuard);
    router.all("*", (c) => c.text("reached"));
    return router;
  }

  const call = (
    router: ReturnType<typeof guarded>,
    method: string,
    headers: Record<string, string> = {},
  ) => router.request("/anything", { method, headers });

  test("an authMethod nothing set fails closed: a write with no Origin is 403", async () => {
    const res = await call(guarded(undefined), "POST");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("origin_not_allowed");
  });

  test("an authMethod nothing set still lets a NEMAR origin through, and still reads", async () => {
    const router = guarded(undefined);
    expect((await call(router, "POST", { Origin: APP_ORIGIN })).status).toBe(200);
    expect((await call(router, "GET")).status).toBe(200);
  });

  test("every write method is refused without a NEMAR origin, a method it does not know included", async () => {
    // `new Request` upper-cases only the standard methods, so "patch" reaches the guard as written.
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "patch", "PURGE"]) {
      for (const authMethod of ["cookie", undefined] as const) {
        const res = await call(guarded(authMethod), method);
        expect(res.status, `${method} ${authMethod}`).toBe(403);
      }
    }
  });

  test("a read passes whatever the credential and whatever the Origin", async () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      for (const authMethod of ["token", "cookie", undefined] as const) {
        for (const headers of [{}, { Origin: FOREIGN_ORIGIN }]) {
          const res = await call(guarded(authMethod), method, headers);
          expect(res.status, `${method} ${authMethod}`).toBe(200);
        }
      }
    }
  });

  test("a token is never asked for an Origin, and a cookie is", async () => {
    expect((await call(guarded("token"), "POST")).status).toBe(200);
    expect((await call(guarded("token"), "POST", { Origin: FOREIGN_ORIGIN })).status).toBe(200);
    expect((await call(guarded("cookie"), "POST")).status).toBe(403);
    expect((await call(guarded("cookie"), "POST", { Origin: FOREIGN_ORIGIN })).status).toBe(403);
    expect((await call(guarded("cookie"), "POST", { Origin: "null" })).status).toBe(403);
    expect((await call(guarded("cookie"), "POST", { Origin: APP_ORIGIN })).status).toBe(200);
  });

  test("an Origin that only looks like NEMAR's is refused", async () => {
    for (const origin of [
      "https://nemar.org.evil.example",
      "https://evilnemar.org",
      "https://evil.example/nemar.org",
    ]) {
      const res = await call(guarded("cookie"), "POST", { Origin: origin });
      expect(res.status, origin).toBe(403);
    }
  });
});
