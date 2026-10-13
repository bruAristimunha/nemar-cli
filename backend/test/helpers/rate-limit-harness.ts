// What every rate limiter suite that drives the REAL limiter through a real Hono
// app needs, in one place (#1709): the working in-memory Cache double installed as
// `caches.default` (one a test can make stall, #1715), one controllable clock that
// the limiter and the cache both read (`Date.now`, held by a spy; it is the only
// thing replaced), quiet console spies whose calls the log tests read, and an app
// with a route for every bucket. The limiter's module-level state (its log slots and
// its cache-stall breaker) is cleared before and after every test.
//
// Call `useRateLimitHarness()` once at the top level of a test file. It registers
// its own `beforeEach` and `afterEach`, and hands back a view onto the current
// test's cache, clock and spies.

import { afterEach, beforeEach, spyOn } from "bun:test";
import { Hono } from "hono";
import {
  type RateLimiterOptions,
  __resetCacheBreakerForTests,
  __resetRateLimitLogsForTests,
  rateLimiter,
} from "../../src/middleware/rateLimit";
import type { Bindings, Variables } from "../../src/types/bindings";
import { InMemoryCache } from "./cache";

export type AppEnv = { Bindings: Bindings; Variables: Variables };

/**
 * The harness's cache: the working `InMemoryCache`, which a test can make stall. While
 * `stalled` is true, `match` and `put` never settle, the way a Cache API that has
 * stopped answering behaves; while `putsStall` is true only `put` does. The limiter's
 * 500 ms bound and its breaker are what end the wait. `calls` counts the calls that
 * reached the cache, so a test can tell a call the breaker skipped from one it made.
 * Not a stand-in for business logic: the platform failing is the one thing a test
 * cannot get from the real runtime.
 */
export class ControllableCache extends InMemoryCache {
  stalled = false;
  putsStall = false;
  calls = 0;

  match(request: RequestInfo | URL): Promise<Response | undefined> {
    this.calls++;
    return this.stalled ? new Promise<never>(() => {}) : super.match(request);
  }

  put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.calls++;
    return this.stalled || this.putsStall
      ? new Promise<never>(() => {})
      : super.put(request, response);
  }
}

/** A whole second, so epoch-second arithmetic in a test is exact. */
export const T0 = 1_800_000_000_000;

export const PROD_ENV = {
  ENVIRONMENT: "production",
  API_BASE_URL: "http://localhost",
  FRONTEND_URL: "http://localhost",
  AWS_REGION: "us-east-2",
  S3_BUCKET: "nemar",
  DB: undefined as unknown as D1Database,
  TEST_BYPASS_TOKEN: "rate-limit-harness-bypass-token",
} satisfies Partial<Bindings> as unknown as Bindings;

/** An app behind the limiter with one route for each bucket the limiter chooses. */
export function buildApp(options: RateLimiterOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", (c, next) => rateLimiter(c, next, options));
  app.get("/datasets", (c) => c.json({ ok: true }));
  app.get("/raw", () => new Response("a handler that builds its own Response"));
  app.get("/auth/login", (c) => c.json({ ok: true }));
  app.get("/admin/users", (c) => c.json({ ok: true }));
  app.get("/neurobagel/index.json", (c) => c.json({ ok: true }));
  app.get("/data/*", (c) => c.json({ ok: true }));
  return app;
}

export async function hit(
  app: Hono<AppEnv>,
  headers: Record<string, string>,
  path = "/datasets",
  env: Bindings = PROD_ENV,
): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, { method: "GET", headers }), env);
}

/** A public request: Cloudflare sets `CF-Connecting-IP`. */
export const edge = (ip: string): Record<string, string> => ({ "CF-Connecting-IP": ip });

/** A request through a service binding: the visitor forwarded, no `CF-Connecting-IP`. */
export const viaBinding = (visitor: string): Record<string, string> => ({
  "X-Forwarded-For": visitor,
});

export interface RateLimitHarness {
  /** The cache installed for the current test. */
  readonly cache: ControllableCache;
  /** The current time, in epoch milliseconds, for the limiter and the cache alike. */
  clock: number;
  readonly log: ReturnType<typeof spyOn>;
  readonly warn: ReturnType<typeof spyOn>;
  readonly error: ReturnType<typeof spyOn>;
  /** Put a record under a bucket's key (`kind:key`), as the limiter itself would have. */
  seed(key: string, record: unknown, maxAgeSeconds?: number): Promise<void>;
  /** The record a bucket stores, parsed, or undefined. */
  stored(key: string): Promise<Record<string, unknown> | undefined>;
  /** Put the cached "is this token an admin" record for a token hash. */
  seedAdminFlag(tokenHash: string, record: unknown, maxAgeSeconds?: number): Promise<void>;
  /** The cached admin-flag record for a token hash, parsed, or undefined. */
  storedAdminFlag(tokenHash: string): Promise<Record<string, unknown> | undefined>;
}

export function useRateLimitHarness(): RateLimitHarness {
  let cache = new ControllableCache();
  let clock = T0;
  let originalCaches: unknown;
  let nowSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    clock = T0;
    nowSpy = spyOn(Date, "now").mockImplementation(() => clock);
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    cache = new ControllableCache();
    originalCaches = (globalThis as { caches?: unknown }).caches;
    (globalThis as { caches?: unknown }).caches = { default: cache };
    __resetRateLimitLogsForTests();
    __resetCacheBreakerForTests();
  });

  afterEach(() => {
    nowSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    (globalThis as { caches?: unknown }).caches = originalCaches;
    // The held clock is in the future: a slot left behind would silence the real
    // clock's logs for any later file in this process, and a breaker left open
    // would skip its cache.
    __resetRateLimitLogsForTests();
    __resetCacheBreakerForTests();
  });

  return {
    get cache() {
      return cache;
    },
    get clock() {
      return clock;
    },
    set clock(value: number) {
      clock = value;
    },
    get log() {
      return logSpy;
    },
    get warn() {
      return warnSpy;
    },
    get error() {
      return errorSpy;
    },
    async seed(key, record, maxAgeSeconds = 60) {
      await cache.put(
        new Request(`https://rate-limit.internal/rl:${key}`),
        new Response(typeof record === "string" ? record : JSON.stringify(record), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `max-age=${maxAgeSeconds}`,
          },
        }),
      );
    },
    async stored(key) {
      const res = await cache.match(new Request(`https://rate-limit.internal/rl:${key}`));
      return res ? ((await res.json()) as Record<string, unknown>) : undefined;
    },
    async seedAdminFlag(tokenHash, record, maxAgeSeconds = 60) {
      await cache.put(
        new Request(`https://rate-limit.internal/admin-flag:${tokenHash}`),
        new Response(typeof record === "string" ? record : JSON.stringify(record), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `max-age=${maxAgeSeconds}`,
          },
        }),
      );
    },
    async storedAdminFlag(tokenHash) {
      const res = await cache.match(
        new Request(`https://rate-limit.internal/admin-flag:${tokenHash}`),
      );
      return res ? ((await res.json()) as Record<string, unknown>) : undefined;
    },
  };
}
