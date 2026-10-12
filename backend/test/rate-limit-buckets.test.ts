/**
 * Rate limiter bucket-selection tests (issue #275).
 *
 * Covers two layers:
 *  1. `__selectBucket` — pure function that picks the bucket kind, raw
 *     key material, and cap. Hit every branch (auth path, token,
 *     IP-fallback).
 *  2. End-to-end through `rateLimiter` against a real Hono app, with a
 *     real in-memory Cache implementation (not a mock — a working
 *     Cache backed by Map that satisfies the shape we actually use).
 *     Verifies that an authenticated client can fire >100 requests
 *     without 429ing (the regression in #275: admins running batch
 *     publish-approves hit the per-IP 100/60s cap), and that an
 *     unauthenticated client still 429s at the IP cap.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import {
  __limits,
  __normalizeMountPath,
  __readBearerTokenFromHeader,
  __resetCacheFaultLogForTests,
  __selectBucket,
  rateLimiter,
} from "../src/middleware/rateLimit";
import { createMcpRoutes } from "../src/routes/mcp";
import { neurobagelRoutes } from "../src/routes/neurobagel";
import type { Bindings, Variables } from "../src/types/bindings";
import { InMemoryCache } from "./helpers/cache";

type AppEnv = { Bindings: Bindings; Variables: Variables };

// The shared real (in-memory) Cache double (#1516 review; `helpers/cache.ts`):
// not a mock, a working Cache backed by a Map, and the same one every other
// suite in this codebase trusts for `caches.default`. It models real Workers
// Cache API expiry rules this file's own hand-rolled double did NOT (an entry
// with no `Cache-Control` at all never expires here, rather than defaulting
// to a permissive 60s -- see `beforeEach` below for where that mattered).
let ourCache = new InMemoryCache();
let originalCaches: typeof caches | undefined;

// Cloudflare exposes a `caches.default` singleton. Bun has no `caches`
// global by default — install a real working in-memory implementation
// for the duration of this suite. Restored in `afterAll` so other
// suites that legitimately expect Bun's default state still see it.
beforeAll(() => {
  // biome-ignore lint/suspicious/noExplicitAny: test-only runtime patch
  originalCaches = (globalThis as any).caches;
});

afterAll(() => {
  // biome-ignore lint/suspicious/noExplicitAny: test-only runtime restore
  (globalThis as any).caches = originalCaches as CacheStorage;
});

beforeEach(() => {
  // A fresh instance per test, the same reset convention every other
  // consumer of this shared double uses (rather than a `.clear()` method the
  // shared double does not provide -- it is deliberately minimal).
  ourCache = new InMemoryCache();
  // biome-ignore lint/suspicious/noExplicitAny: test-only runtime patch
  (globalThis as any).caches = { default: ourCache } as unknown as CacheStorage;
});

// --------------------------------------------------------------------------
// __selectBucket — pure function
// --------------------------------------------------------------------------

const VALID_TOKEN = "a".repeat(48); // ≥32 chars, matches auth middleware floor
const VALID_TOKEN_2 = "b".repeat(48);
const SHORT_TOKEN = "a".repeat(10);

describe("__selectBucket", () => {
  test("auth-path requests bucket on IP regardless of bearer", () => {
    const sel = __selectBucket("/auth/login", `Bearer ${VALID_TOKEN}`, "10.0.0.1");
    expect(sel.keyKind).toBe("auth-ip");
    expect(sel.rawKey).toBe("10.0.0.1");
    expect(sel.maxRequests).toBe(__limits.AUTH_MAX_REQUESTS);
  });

  test("the email-verification endpoints are in the auth bucket, request path included", () => {
    // One AUTH_PATHS entry covers both because the matcher treats entries as
    // prefixes. Asserted on the SUB-PATH as well as the entry itself: if that
    // prefix behaviour ever changes, /auth/email/verify/request silently
    // falls to the 500/min IP bucket and a code-mailing endpoint loses its
    // floor.
    for (const path of ["/auth/email/verify", "/auth/email/verify/request"]) {
      const sel = __selectBucket(path, null, "10.0.0.1");
      expect(sel.keyKind).toBe("auth-ip");
      expect(sel.maxRequests).toBe(__limits.AUTH_MAX_REQUESTS);
    }
  });

  test("the upload-access request is in the strict bucket, bearer or not", () => {
    // ADR 0042, #1253. It is NOT an /auth path, so nothing about its shape
    // puts it here -- only the explicit AUTH_PATHS entry does. Every attempt
    // spends a live GitHub call on the shared installation token and a refused
    // one writes nothing, so on the token bucket one verified account could
    // replay ~1000 GitHub calls a minute. Asserted WITH a bearer because that
    // is how it is always called: the token branch must not win.
    for (const auth of [undefined, `Bearer ${VALID_TOKEN}`]) {
      const sel = __selectBucket("/users/me/upload-access/request", auth, "10.0.0.1");
      expect(sel.keyKind).toBe("auth-ip");
      expect(sel.rawKey).toBe("10.0.0.1");
      expect(sel.maxRequests).toBe(__limits.AUTH_MAX_REQUESTS);
    }
  });

  test("the CLI ORCID surface is in the strict bucket; the callback is not", () => {
    // #1266, ADR 0044. All three are bearer-reachable now, so without their
    // AUTH_PATHS entries a token would put them in the 1000/min bucket -- on
    // an identity-link mint, on the step that turns a leaked intent into an
    // ORCID redirect, and on the unlink. /continue is asserted separately
    // because it relies on the matcher's prefix behaviour.
    for (const path of [
      "/auth/orcid/cli-start",
      "/auth/orcid/cli-handoff",
      "/auth/orcid/cli-handoff/continue",
      "/auth/orcid/unlink",
    ]) {
      const sel = __selectBucket(path, `Bearer ${VALID_TOKEN}`, "10.0.0.1");
      expect(sel.keyKind).toBe("auth-ip");
      expect(sel.rawKey).toBe("10.0.0.1");
      expect(sel.maxRequests).toBe(__limits.AUTH_MAX_REQUESTS);
    }
  });

  test("the ORCID callback stays OUT of the strict bucket", () => {
    // A browser landing on a shared egress IP, and the one ORCID path a
    // careless prefix entry ("/auth/orcid") would drag to 10/min -- which
    // would rate-limit the website's own sign-in flow, not the CLI's.
    const sel = __selectBucket("/auth/orcid/callback?code=x&state=y", undefined, "10.0.0.1");
    expect(sel.keyKind).not.toBe("auth-ip");
  });

  test("the device authorization grant's browser-facing paths and /auth/keys are strict, with or without a bearer", () => {
    // #1281, ADR 0047. A person starts, looks up, confirms, or denies a
    // sign-in a handful of times, not in a loop -- same reasoning as the
    // CLI ORCID surface above. `/auth/keys/12` and `/auth/keys/current`
    // prove the prefix match covers the named-key routes too.
    for (const path of [
      "/auth/device/start",
      "/auth/device/lookup",
      "/auth/device/confirm",
      "/auth/device/deny",
      "/auth/keys",
      "/auth/keys/12",
      "/auth/keys/current",
    ]) {
      for (const auth of [undefined, `Bearer ${VALID_TOKEN}`]) {
        const sel = __selectBucket(path, auth, "10.0.0.1");
        expect(sel.keyKind).toBe("auth-ip");
        expect(sel.rawKey).toBe("10.0.0.1");
        expect(sel.maxRequests).toBe(__limits.AUTH_MAX_REQUESTS);
      }
    }
  });

  test("/auth/device/token stays OUT of the strict bucket -- it rides `ip` with MAX_REQUESTS", () => {
    // Deliberately absent from AUTH_PATHS (comment there explains why): at a
    // 5-second poll cadence, 10 polls fit inside the strict bucket's 60s
    // window and the 11th trips it, about 50 seconds in -- not the "third
    // poll" a looser count might suggest. An unauthenticated poll (no key
    // collected yet, so no bearer to carry) lands on the plain `ip` bucket
    // at `MAX_REQUESTS`.
    const sel = __selectBucket("/auth/device/token", undefined, "10.0.0.1");
    expect(sel.keyKind).toBe("ip");
    expect(sel.maxRequests).toBe(__limits.MAX_REQUESTS);
  });

  test("the rest of /users keeps the ordinary token bucket", () => {
    // The AUTH_PATHS matcher is a prefix match, so an over-broad entry
    // ("/users") would drag the dashboard's own polling into a 10/min cap.
    const sel = __selectBucket("/users/me", `Bearer ${VALID_TOKEN}`, "10.0.0.1");
    expect(sel.keyKind).toBe("token");
    expect(sel.maxRequests).toBe(__limits.TOKEN_MAX_REQUESTS_AUTHED);
  });

  test("authenticated non-auth requests bucket on token with higher cap", () => {
    const sel = __selectBucket(
      "/admin/publish/nm000110/approve",
      `Bearer ${VALID_TOKEN}`,
      "10.0.0.1",
    );
    expect(sel.keyKind).toBe("token");
    expect(sel.rawKey).toBe(VALID_TOKEN);
    expect(sel.maxRequests).toBe(__limits.TOKEN_MAX_REQUESTS_AUTHED);
    // Never stricter than an anonymous caller. Equal since #1709 raised the
    // anonymous cap to the token cap; see the comment on MAX_REQUESTS.
    expect(sel.maxRequests).toBeGreaterThanOrEqual(__limits.MAX_REQUESTS);
  });

  test("unauthenticated requests bucket on IP with legacy cap", () => {
    const sel = __selectBucket("/datasets", undefined, "10.0.0.2");
    expect(sel.keyKind).toBe("ip");
    expect(sel.rawKey).toBe("10.0.0.2");
    expect(sel.maxRequests).toBe(__limits.MAX_REQUESTS);
  });

  test("malformed Authorization header falls through to IP bucket", () => {
    // The auth middleware rejects sub-32-char tokens. The rate limiter
    // must match that floor so a "Bearer abc" client can't trade up to
    // the higher authenticated cap.
    expect(__selectBucket("/datasets", `Bearer ${SHORT_TOKEN}`, "1.2.3.4").keyKind).toBe("ip");
    expect(__selectBucket("/datasets", "Bearer ", "1.2.3.4").keyKind).toBe("ip");
    expect(__selectBucket("/datasets", "Token abc", "1.2.3.4").keyKind).toBe("ip");
    expect(__selectBucket("/datasets", "", "1.2.3.4").keyKind).toBe("ip");
  });

  test("the MCP transport is IP-bucketed even WITH a bearer (epic #1065)", () => {
    // `/mcp` matches neither AUTH_PATHS nor the data-plane patterns, so on the
    // raw path the bearer branch wins -- documented here because it is exactly
    // why `anonymousSurface` exists rather than a path pattern.
    const withHeader = __selectBucket("/mcp", `Bearer ${VALID_TOKEN}`, "10.0.0.3");
    expect(withHeader.keyKind).toBe("token");

    // The MCP sub-app passes `anonymousSurface: true`, which the limiter
    // implements by withholding the header from this function. Nothing in that
    // sub-app validates a bearer, so honoring one let a caller rotate a fresh
    // 32-character string per request for a fresh 1000/min bucket, bypassing
    // the 500/min IP floor, and drove a D1 tokens-to-users lookup per novel
    // token. Keying on the IP is what closes both.
    const anonymous = __selectBucket("/mcp", undefined, "10.0.0.3");
    expect(anonymous.keyKind).toBe("ip");
    expect(anonymous.rawKey).toBe("10.0.0.3");
    expect(anonymous.maxRequests).toBe(__limits.MAX_REQUESTS);
    expect(anonymous.maxRequests).toBeLessThanOrEqual(__limits.TOKEN_MAX_REQUESTS_AUTHED);
  });

  test("admin paths use the token bucket (not exempt)", () => {
    // Pre-#275 the middleware exempted /admin/* entirely. The new
    // behavior is "still bounded, just with a higher cap" — verify the
    // 500/60s cap actually applies rather than an exempt path being
    // silently re-introduced.
    const sel = __selectBucket("/admin/users", `Bearer ${VALID_TOKEN}`, "10.0.0.1");
    expect(sel.keyKind).toBe("token");
    expect(sel.maxRequests).toBe(__limits.TOKEN_MAX_REQUESTS_AUTHED);
  });

  test("data plane + zarr serving paths use the generous data-ip bucket (#901)", () => {
    for (const path of [
      "/data/nm000108/v1.0.0/foo",
      "/nemar/data/x",
      // Host-fork shape (zarr.nemar.org -> zarrDataRoutes.fetch, path stripped):
      "/nm000132/zarr/0/0/0",
      // Path-mount shape (api.nemar.org/workers.dev /zarrproxy): Hono PREPENDS the
      // mount prefix, so c.req.path keeps /zarrproxy. Must still bucket to data-ip.
      "/zarrproxy/nm000132/zarr/0/0/0",
      "/zarrproxy/on000045/zarr/zarr.json",
    ]) {
      const sel = __selectBucket(path, undefined, "10.0.0.9");
      expect(sel.keyKind).toBe("data-ip");
      expect(sel.maxRequests).toBe(__limits.DATA_MAX_REQUESTS);
    }
    // A tokened zarr request is still charged to the data bucket, not the token one.
    expect(__selectBucket("/nm000132/zarr/x", `Bearer ${VALID_TOKEN}`, "10.0.0.9").keyKind).toBe(
      "data-ip",
    );
    // Neither the management API nor a non-zarr /zarrproxy-lookalike is the data plane.
    expect(__selectBucket("/datasets", undefined, "10.0.0.9").keyKind).toBe("ip");
    expect(__selectBucket("/zarrproxything/nm000132", undefined, "10.0.0.9").keyKind).toBe("ip");
  });
});

describe("__readBearerTokenFromHeader", () => {
  test("returns the token for a well-formed header", () => {
    expect(__readBearerTokenFromHeader(`Bearer ${VALID_TOKEN}`)).toBe(VALID_TOKEN);
  });

  test("returns null for missing/malformed/short headers", () => {
    expect(__readBearerTokenFromHeader(undefined)).toBeNull();
    expect(__readBearerTokenFromHeader("")).toBeNull();
    expect(__readBearerTokenFromHeader("Token abc")).toBeNull();
    expect(__readBearerTokenFromHeader(`Bearer ${SHORT_TOKEN}`)).toBeNull();
  });
});

// --------------------------------------------------------------------------
// End-to-end through the middleware
// --------------------------------------------------------------------------

function buildApp(env: Bindings): { app: Hono<AppEnv>; env: Bindings } {
  const app = new Hono<AppEnv>();
  app.use("*", rateLimiter);
  app.get("/datasets", (c) => c.json({ ok: true }));
  app.get("/admin/users", (c) => c.json({ ok: true }));
  app.get("/data/*", (c) => c.json({ ok: true }));
  return { app, env };
}

const PROD_ENV = {
  ENVIRONMENT: "production",
  API_BASE_URL: "http://localhost",
  FRONTEND_URL: "http://localhost",
  AWS_REGION: "us-east-2",
  S3_BUCKET: "nemar",
  DB: undefined as unknown as D1Database,
  GITHUB_ADMIN_PAT: "",
  AWS_ACCESS_KEY_ID: "",
  AWS_SECRET_ACCESS_KEY: "",
  RESEND_API_KEY: "",
  ZENODO_API_KEY: "",
  EZID_USERNAME: "",
  EZID_PASSWORD: "",
} satisfies Partial<Bindings> as unknown as Bindings;

async function hit(
  app: Hono<AppEnv>,
  env: Bindings,
  path: string,
  headers: Record<string, string>,
): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, { method: "GET", headers }), env);
}

describe("the MCP sub-app really passes anonymousSurface (epic #1065)", () => {
  // Driven through the REAL sub-app, not by calling __selectBucket again: the
  // whole point of the option is the WIRING, and a helper-level test passes
  // just as happily when nothing passes the flag. The descriptor at `/` is the
  // cheapest route that still goes through the limiter and needs no D1.
  test("a bearer on the MCP descriptor is bucketed on IP, not on the token", async () => {
    const app = createMcpRoutes();
    const res = await app.fetch(
      new Request("http://mcp.nemar.org/", {
        method: "GET",
        headers: { Authorization: `Bearer ${VALID_TOKEN}`, "CF-Connecting-IP": "10.77.0.1" },
      }),
      PROD_ENV,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("ip");
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(__limits.MAX_REQUESTS));
  });

  test("two different rotated bearers from one IP share ONE bucket", async () => {
    // The exploit the option closes: a fresh 32-character string per request
    // used to mint a fresh 1000/min bucket. Sharing a bucket is visible as the
    // remaining count decreasing across requests that carry different bearers.
    const app = createMcpRoutes();
    const remaining: number[] = [];
    for (const bearer of ["a".repeat(40), "b".repeat(40), "c".repeat(40)]) {
      const res = await app.fetch(
        new Request("http://mcp.nemar.org/", {
          method: "GET",
          headers: { Authorization: `Bearer ${bearer}`, "CF-Connecting-IP": "10.77.0.2" },
        }),
        PROD_ENV,
      );
      remaining.push(Number(res.headers.get("X-RateLimit-Remaining")));
    }
    expect(remaining[1]).toBe(remaining[0] - 1);
    expect(remaining[2]).toBe(remaining[0] - 2);
  });
});

describe("the anonymous cap (#1709)", () => {
  test("is 1000, and no stricter for a token holder or for the website's visitors", () => {
    // Pinned so a change to the number is a decision. It may not exceed the token
    // cap without raising that one (a holder must not be limited more strictly
    // than someone with no token), and the website's per-visitor bucket may not
    // fall below it.
    expect(__limits.MAX_REQUESTS).toBe(1000);
    expect(__limits.MAX_REQUESTS).toBeLessThanOrEqual(__limits.TOKEN_MAX_REQUESTS_AUTHED);
    expect(__limits.MAX_REQUESTS).toBeLessThanOrEqual(__limits.SITE_IP_MAX_REQUESTS);
  });

  test("the 1000th request from one address passes and the 1001st is refused", async () => {
    const { app, env } = buildApp(PROD_ENV);
    const headers = { "CF-Connecting-IP": "10.99.0.8" };
    let last: Response | undefined;
    for (let i = 0; i < 1000; i++) {
      last = await hit(app, env, "/datasets", headers);
      expect(last.status).toBe(200);
    }
    expect(last?.headers.get("X-RateLimit-Remaining")).toBe("0");
    const over = await hit(app, env, "/datasets", headers);
    expect(over.status).toBe(429);
    expect(over.headers.get("X-RateLimit-Limit")).toBe("1000");
    // The seconds left in the window, which depend on how long the loop above
    // took; `rate-limit-fixed-window.test.ts` pins the exact value with a held clock.
    expect(Number(over.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(Number(over.headers.get("Retry-After"))).toBeLessThanOrEqual(__limits.WINDOW_SIZE);
  });
});

describe("rateLimiter end-to-end", () => {
  test("authenticated client survives 150 requests (used to 429 at 100)", async () => {
    // Pre-#275: an admin running `publish approve` on a few datasets
    // back-to-back blew through the per-IP 100/60s cap and the resume
    // attempts then 429'd. After the fix, the same volume sits in the
    // 500/60s token bucket and goes through cleanly.
    const { app, env } = buildApp(PROD_ENV);
    const headers = {
      Authorization: `Bearer ${VALID_TOKEN}`,
      "CF-Connecting-IP": "10.99.0.1",
    };

    let okCount = 0;
    let rateLimitedCount = 0;
    for (let i = 0; i < 150; i++) {
      const res = await hit(app, env, "/admin/users", headers);
      if (res.status === 200) okCount++;
      else if (res.status === 429) rateLimitedCount++;
    }
    expect(okCount).toBe(150);
    expect(rateLimitedCount).toBe(0);
  });

  test("unauthenticated client still 429s once the IP cap is exhausted", async () => {
    const { app, env } = buildApp(PROD_ENV);
    const headers = { "CF-Connecting-IP": "10.99.0.2" };

    let okCount = 0;
    let rateLimitedCount = 0;
    // Loop the cap + a fixed overrun. Mirrors the authed-bucket test
    // pattern so the assertion stays correct when MAX_REQUESTS changes
    // (most recently 100 → 500 in #639).
    const total = __limits.MAX_REQUESTS + 25;
    for (let i = 0; i < total; i++) {
      const res = await hit(app, env, "/datasets", headers);
      if (res.status === 200) okCount++;
      else if (res.status === 429) rateLimitedCount++;
    }
    // The unauth cap is exactly MAX_REQUESTS — anything beyond should 429.
    expect(okCount).toBe(__limits.MAX_REQUESTS);
    expect(rateLimitedCount).toBe(25);
  });

  test("two authenticated clients on the same IP don't share a bucket", async () => {
    // The point of per-token bucketing: admin A's heavy orchestration
    // sweep does not consume admin B's quota even though they share an
    // egress IP (common when both admins run from the same office). 250
    // requests from each should both succeed (each under the 500 cap).
    const { app, env } = buildApp(PROD_ENV);
    const ip = "10.99.0.3";

    let aOk = 0;
    let bOk = 0;
    for (let i = 0; i < 250; i++) {
      const aRes = await hit(app, env, "/admin/users", {
        Authorization: `Bearer ${VALID_TOKEN}`,
        "CF-Connecting-IP": ip,
      });
      const bRes = await hit(app, env, "/admin/users", {
        Authorization: `Bearer ${VALID_TOKEN_2}`,
        "CF-Connecting-IP": ip,
      });
      if (aRes.status === 200) aOk++;
      if (bRes.status === 200) bOk++;
    }
    expect(aOk).toBe(250);
    expect(bOk).toBe(250);
  });

  test("a single authenticated client still 429s once its bucket is exhausted", async () => {
    // The cap exists to bound a malformed loop. Run past 500 and
    // confirm the next request 429s — the floor must not be silently
    // absent.
    const { app, env } = buildApp(PROD_ENV);
    const headers = {
      Authorization: `Bearer ${VALID_TOKEN}`,
      "CF-Connecting-IP": "10.99.0.4",
    };

    let okCount = 0;
    let rateLimitedCount = 0;
    const total = __limits.TOKEN_MAX_REQUESTS_AUTHED + 25;
    for (let i = 0; i < total; i++) {
      const res = await hit(app, env, "/admin/users", headers);
      if (res.status === 200) okCount++;
      else if (res.status === 429) rateLimitedCount++;
    }
    expect(okCount).toBe(__limits.TOKEN_MAX_REQUESTS_AUTHED);
    expect(rateLimitedCount).toBe(25);
  });

  test("429 response exposes the X-RateLimit-Bucket header", async () => {
    const { app, env } = buildApp(PROD_ENV);
    const headers = { "CF-Connecting-IP": "10.99.0.5" };

    // Exhaust the unauth bucket
    for (let i = 0; i < __limits.MAX_REQUESTS; i++) {
      await hit(app, env, "/datasets", headers);
    }
    const res = await hit(app, env, "/datasets", headers);
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("ip");
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(__limits.MAX_REQUESTS));
  });

  test("development environment bypasses rate limiting entirely", async () => {
    // Sanity check: the dev-skip branch is intact after the bucket
    // refactor.
    const devEnv = { ...PROD_ENV, ENVIRONMENT: "development" } as Bindings;
    const { app, env } = buildApp(devEnv);
    const headers = { "CF-Connecting-IP": "10.99.0.6" };

    for (let i = 0; i < 200; i++) {
      const res = await hit(app, env, "/datasets", headers);
      expect(res.status).toBe(200);
    }
  });

  test("bucket resets exactly when its window ends", async () => {
    // One clock for the limiter and the cache (`Date.now`, held by a spy), so the
    // window the limiter stores and the entry's expiry are both walked across.
    let fakeNow = 1_800_000_000_000;
    const nowSpy = spyOn(Date, "now").mockImplementation(() => fakeNow);
    try {
      const { app, env } = buildApp(PROD_ENV);
      const headers = { "CF-Connecting-IP": "10.99.0.7" };

      // Exhaust the unauthenticated IP bucket.
      for (let i = 0; i < __limits.MAX_REQUESTS; i++) {
        const res = await hit(app, env, "/datasets", headers);
        expect(res.status).toBe(200);
      }
      // Next request must be rate-limited.
      expect((await hit(app, env, "/datasets", headers)).status).toBe(429);

      // A millisecond before the window ends it still is.
      fakeNow += __limits.WINDOW_SIZE * 1000 - 1;
      expect((await hit(app, env, "/datasets", headers)).status).toBe(429);

      // At the end the client gets a fresh quota.
      fakeNow += 1;
      const resetRes = await hit(app, env, "/datasets", headers);
      expect(resetRes.status).toBe(200);
      expect(resetRes.headers.get("X-RateLimit-Remaining")).toBe(String(__limits.MAX_REQUESTS - 1));
    } finally {
      nowSpy.mockRestore();
    }
  });
});

// --------------------------------------------------------------------------
// The data-plane bucket, raised and taken off the hot path (#1516)
// --------------------------------------------------------------------------

describe("the data-ip bucket after #1516", () => {
  test("DATA_MAX_REQUESTS is well above the previous 10,000 cap", () => {
    // The number itself is justified with arithmetic where it is declared
    // (rateLimit.ts); this just pins that it was actually raised, not only
    // documented as raised.
    expect(__limits.DATA_MAX_REQUESTS).toBeGreaterThanOrEqual(100_000);
  });

  test("a burst of a thousand small data-plane requests never 429s", async () => {
    // Representative of one session's sidecar fetches (small, IP-keyed,
    // well under the new cap) -- the shape #1494 measured as thousands of
    // requests for one dataset download, scaled down so the test stays fast.
    const { app, env } = buildApp(PROD_ENV);
    const headers = { "CF-Connecting-IP": "10.99.1.1" };

    let okCount = 0;
    for (let i = 0; i < 1000; i++) {
      const res = await hit(app, env, "/data/nm000108/v1.0.0/dataset_description.json", headers);
      if (res.status === 200) okCount++;
    }
    expect(okCount).toBe(1000);
  }, 20_000);

  test("the bucket still enforces its cap at the boundary", async () => {
    // Reaching DATA_MAX_REQUESTS by looping real requests would be slow and
    // would not test anything the loop above doesn't already; instead, seed
    // the bucket's own cache record one under the cap (the same
    // `{count, warned}` shape and `rl:<kind>:<key>` URL the middleware itself
    // writes) and confirm the very next request is the one that trips it.
    const { app, env } = buildApp(PROD_ENV);
    const ip = "10.99.1.2";
    const cacheKeyUrl = `https://rate-limit.internal/rl:data-ip:${ip}`;
    await ourCache.put(
      new Request(cacheKeyUrl),
      new Response(JSON.stringify({ count: __limits.DATA_MAX_REQUESTS - 1, warned: false }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "max-age=60" },
      }),
    );

    const last = await hit(app, env, "/data/nm000108/v1.0.0/x", { "CF-Connecting-IP": ip });
    expect(last.status).toBe(200);
    expect(last.headers.get("X-RateLimit-Remaining")).toBe("0");

    const over = await hit(app, env, "/data/nm000108/v1.0.0/x", { "CF-Connecting-IP": ip });
    expect(over.status).toBe(429);
    expect(over.headers.get("X-RateLimit-Bucket")).toBe("data-ip");
  });

  test("a stalled cache write never blocks a data-plane response", async () => {
    // `app.fetch(request, env)` below supplies no execution context, so this
    // exercises the bounded-wait fallback (`RATE_LIMIT_WRITE_STALL_MS`), not
    // the `waitUntil` handoff a real Worker invocation would take -- the
    // `keyKind !== "data-ip"` branch is untouched, so every other bucket
    // keeps awaiting its write exactly as it always did.
    class StalledPutCache implements Cache {
      async match(): Promise<Response | undefined> {
        return undefined;
      }
      put(): Promise<void> {
        return new Promise<void>(() => {});
      }
      async add(): Promise<void> {
        throw new Error("not implemented");
      }
      async addAll(): Promise<void> {
        throw new Error("not implemented");
      }
      async delete(): Promise<boolean> {
        return false;
      }
      async keys(): Promise<readonly Request[]> {
        return [];
      }
      async matchAll(): Promise<readonly Response[]> {
        return [];
      }
    }
    const saved = (globalThis as { caches?: CacheStorage }).caches;
    // biome-ignore lint/suspicious/noExplicitAny: test-only runtime patch
    (globalThis as any).caches = { default: new StalledPutCache() } as unknown as CacheStorage;
    try {
      const { app, env } = buildApp(PROD_ENV);
      const started = performance.now();
      const res = await hit(app, env, "/data/nm000108/v1.0.0/x", {
        "CF-Connecting-IP": "10.99.1.3",
      });
      const elapsed = performance.now() - started;
      expect(res.status).toBe(200);
      // Bounded by RATE_LIMIT_WRITE_STALL_MS (500ms), not hung indefinitely.
      expect(elapsed).toBeLessThan(2000);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test-only runtime restore
      (globalThis as any).caches = saved as CacheStorage;
    }
  });
});

// --------------------------------------------------------------------------
// logCacheFaultOnce dedup (review: no test previously covered this -- a
// reviewer removed the dedup outright and all other tests in this file
// still passed).
// --------------------------------------------------------------------------

describe("logCacheFaultOnce dedup", () => {
  // A full `Cache`, matching the `StalledPutCache` pattern above: `match`
  // rejects, standing in for a real Cache API outage (the platform failing,
  // not business logic under test). `rateLimiter` fails open on this --
  // every request still 200s -- but must log the fault at most once per
  // window per isolate rather than once per request.
  class FaultingCache implements Cache {
    async match(): Promise<Response | undefined> {
      throw new Error("simulated cache outage");
    }
    async put(): Promise<void> {
      throw new Error("simulated cache outage");
    }
    async add(): Promise<void> {
      throw new Error("not implemented");
    }
    async addAll(): Promise<void> {
      throw new Error("not implemented");
    }
    async delete(): Promise<boolean> {
      return false;
    }
    async keys(): Promise<readonly Request[]> {
      return [];
    }
    async matchAll(): Promise<readonly Response[]> {
      return [];
    }
  }

  test("two faults inside one window log once; a third after the window resets logs again", async () => {
    // Module-level state (`lastCacheFaultLoggedAt`), and this file shares a
    // process with the rest of the suite -- start from a known-clean slate
    // rather than trusting nothing else tripped it first.
    __resetCacheFaultLogForTests();
    const saved = (globalThis as { caches?: CacheStorage }).caches;
    // biome-ignore lint/suspicious/noExplicitAny: test-only runtime patch
    (globalThis as any).caches = { default: new FaultingCache() } as unknown as CacheStorage;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { app, env } = buildApp(PROD_ENV);
      const headers = { "CF-Connecting-IP": "10.99.3.1" };

      const first = await hit(app, env, "/datasets", headers);
      const second = await hit(app, env, "/datasets", headers);
      // Fails open: the cache outage never blocks the request itself.
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const faultLines = errorSpy.mock.calls.filter((c) => c[0] === "[rate-limit] cache failure");
      expect(faultLines.length).toBe(1);

      // Advancing the real 60s window is not worth a real sleep; the reset
      // hook exists for exactly this ("let a test see the very next fault
      // log again rather than waiting out a real window").
      __resetCacheFaultLogForTests();

      const third = await hit(app, env, "/datasets", headers);
      expect(third.status).toBe(200);
      const faultLinesAfterReset = errorSpy.mock.calls.filter(
        (c) => c[0] === "[rate-limit] cache failure",
      );
      expect(faultLinesAfterReset.length).toBe(2);
    } finally {
      errorSpy.mockRestore();
      // biome-ignore lint/suspicious/noExplicitAny: test-only runtime restore
      (globalThis as any).caches = saved as CacheStorage;
      __resetCacheFaultLogForTests();
    }
  });
});

// --------------------------------------------------------------------------
// The /nemar mount prefix (found reviewing #1384)
// --------------------------------------------------------------------------

describe("the API is mounted twice, and both spellings must bucket alike", () => {
  // `backend/src/index.ts` does `app.route("/nemar", api)` AND
  // `app.route("/", api)`, and Hono gives middleware the full request path. So
  // every path rule in rateLimit.ts saw `/nemar/auth/login` for one of the two
  // spellings and matched none of them. This was true of EVERY `AUTH_PATHS`
  // entry, not just the docs route whose review found it: a strict 10/min floor
  // that one extra path segment stepped over, landing in the 500/min ip bucket
  // or, with a bearer, the 1000/min token bucket and the admin bypass past it.
  const IP = "203.0.113.44";

  test("the prefix is stripped, and only as a whole segment", () => {
    expect(__normalizeMountPath("/nemar/auth/login")).toBe("/auth/login");
    expect(__normalizeMountPath("/auth/login")).toBe("/auth/login");
    expect(__normalizeMountPath("/nemar")).toBe("/");
    // Not a prefix match on the string: a real route that merely starts with
    // those characters must survive intact.
    expect(__normalizeMountPath("/nemarx/auth/login")).toBe("/nemarx/auth/login");
  });

  test.each([
    "/auth/login",
    "/auth/code/request",
    "/auth/keys",
    "/auth/device/start",
    "/auth/docs/grant",
    "/auth/docs/exchange",
    "/auth/docs/cli-session",
    "/users/me/upload-access/request",
  ])("%s buckets identically with and without the prefix", (route) => {
    const plain = __selectBucket(route, undefined, IP);
    const prefixed = __selectBucket(`/nemar${route}`, undefined, IP);
    expect(plain.keyKind).toBe("auth-ip");
    expect(prefixed.keyKind).toBe(plain.keyKind);
    expect(prefixed.maxRequests).toBe(plain.maxRequests);
  });

  test("a bearer does not buy the prefixed spelling a looser bucket", () => {
    // The worst version of the hole: `token` is 1000/min AND an admin or owner
    // token skips the limiter entirely (`isPrivilegedToken`), which is exactly
    // the population that can mint a docs session.
    const prefixed = __selectBucket(
      "/nemar/auth/docs/cli-session",
      "Bearer nk_some_admin_key_0123456789abcdef",
      IP,
    );
    expect(prefixed.keyKind).toBe("auth-ip");
    expect(prefixed.maxRequests).toBe(__limits.AUTH_MAX_REQUESTS);
  });

  test("the data and zarr planes keep their own buckets under the prefix too", () => {
    const zarr = __selectBucket("/nemar/nm000123/zarr/index.json", undefined, IP);
    expect(zarr.keyKind).toBe("data-ip");
  });
});

describe("the Neurobagel read route has its own IP-keyed bucket (epic #1586 phase 4)", () => {
  const IP = "203.0.113.77";
  const ROUTES = [
    "/neurobagel/index.json",
    "/neurobagel/nm000132.jsonld",
    "/neurobagel",
    "/neurobagel/",
    "/nemar/neurobagel/index.json",
  ];

  test("every spelling is IP-keyed whatever bearer it carries, at the route's own cap", () => {
    for (const route of ROUTES) {
      for (const auth of [
        undefined,
        `Bearer ${VALID_TOKEN}`,
        "Bearer made-up-0123456789abcdef0123456789abcdef",
      ]) {
        const sel = __selectBucket(route, auth, IP);
        expect(sel.keyKind).toBe("neurobagel-ip");
        expect(sel.rawKey).toBe(IP);
        expect(sel.maxRequests).toBe(__limits.NEUROBAGEL_MAX_REQUESTS);
      }
    }
  });

  test("the cap holds a first load of about 800 datasets (index + 3 files each) and is not unbounded", () => {
    // The loader fetches the index and then up to three files per dataset in one run.
    expect(__limits.NEUROBAGEL_MAX_REQUESTS).toBeGreaterThan(MAX_ANONYMOUS_FLOOR_FOR_LOADER);
    expect(__limits.NEUROBAGEL_MAX_REQUESTS).toBeLessThanOrEqual(5000);
  });

  test("a lookalike path is not the route", () => {
    for (const route of [
      "/neurobagelx/index.json",
      "/xneurobagel/index.json",
      "/datasets/neurobagel",
    ]) {
      expect(__selectBucket(route, undefined, IP).keyKind).toBe("ip");
    }
  });

  test("rotating made-up bearers neither mint a bucket per request nor reach the privileged-token lookup", async () => {
    // The hole `anonymousSurface` documents for /mcp: with the bearer branch the bucket
    // would be keyed on the bearer, so each fresh string would get a fresh allowance, and
    // each would cost a D1 lookup (here DB is undefined, so a lookup would throw: a 500).
    const app = new Hono<AppEnv>();
    app.use("*", rateLimiter);
    app.route("/neurobagel", neurobagelRoutes);
    const env = PROD_ENV;
    // The privileged-token lookup logs when it cannot reach D1 (here there is none), so
    // a log line is the witness that a lookup was attempted.
    const lookups: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      lookups.push(args.map(String).join(" "));
    };
    let limited = 0;
    let served = 0;
    const total = __limits.NEUROBAGEL_MAX_REQUESTS + 10;
    for (let i = 0; i < total; i++) {
      const res = await hit(app, env, "/neurobagel/index.json", {
        Authorization: `Bearer rotating-${i}-0123456789abcdef0123456789abcdef`,
        "CF-Connecting-IP": IP,
      });
      // No token or bucket is configured on this env, so the route itself answers 404;
      // what is under test is that the limiter counts all of them against ONE bucket.
      if (res.status === 429) limited++;
      else if (res.status === 404) served++;
      else throw new Error(`unexpected status ${res.status}`);
    }
    console.warn = originalWarn;
    expect(served).toBe(__limits.NEUROBAGEL_MAX_REQUESTS);
    expect(limited).toBe(10);
    expect(lookups.filter((l) => l.includes("admin-flag lookup"))).toEqual([]);
  });

  test("another IP has its own allowance", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", rateLimiter);
    app.route("/neurobagel", neurobagelRoutes);
    for (let i = 0; i < __limits.NEUROBAGEL_MAX_REQUESTS + 3; i++) {
      await hit(app, PROD_ENV, "/neurobagel/index.json", { "CF-Connecting-IP": "198.51.100.1" });
    }
    const other = await hit(app, PROD_ENV, "/neurobagel/index.json", {
      "CF-Connecting-IP": "198.51.100.2",
    });
    expect(other.status).toBe(404);
    const over = await hit(app, PROD_ENV, "/neurobagel/index.json", {
      "CF-Connecting-IP": "198.51.100.1",
    });
    expect(over.status).toBe(429);
    expect(over.headers.get("X-RateLimit-Bucket")).toBe("neurobagel-ip");
  });
});

/** The anonymous floor a first load would overrun: three files for each of ~800 datasets, sequentially. */
const MAX_ANONYMOUS_FLOOR_FOR_LOADER = 500;
