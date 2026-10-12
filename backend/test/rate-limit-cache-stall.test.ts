/**
 * A stalled Cache API cannot hang the limiter (#1709).
 *
 * The limiter sits in front of every API request, the website's server-side
 * renders included (`site-ip` carries them all), so a `match` or `put` that never
 * settles must cost a bounded wait and then fail open, logging the fault, not leave
 * the request pending. These tests use real timers: the bound is 500 ms.
 */

import { describe, expect, test } from "bun:test";
import { checkDataMissBudget } from "../src/middleware/rateLimit";
import type { Bindings } from "../src/types/bindings";
import { InMemoryCache } from "./helpers/cache";
import { buildApp, edge, hit, useRateLimitHarness, viaBinding } from "./helpers/rate-limit-harness";

const h = useRateLimitHarness();

const ADDRESS = "203.0.113.90";
const FAULT = "[rate-limit] cache failure";
/** Slow enough to prove the bound is applied, quick enough to prove it is a bound. */
const AT_LEAST_MS = 400;
const AT_MOST_MS = 4000;

const never = <T>() => new Promise<T>(() => {});

class StalledMatchCache extends InMemoryCache {
  match(): Promise<Response | undefined> {
    return never();
  }
}

class StalledPutCache extends InMemoryCache {
  put(): Promise<void> {
    return never();
  }
}

function install(cache: InMemoryCache): void {
  (globalThis as { caches?: unknown }).caches = { default: cache };
}

async function timed<T>(work: Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await work;
  return { value, ms: performance.now() - started };
}

const faults = () => h.error.mock.calls.filter((c) => c[0] === FAULT);
const env = { ENVIRONMENT: "production" } as Pick<Bindings, "ENVIRONMENT" | "TEST_BYPASS_TOKEN">;

describe("a stalled cache read", () => {
  test("costs the bound, serves the request and logs the fault", async () => {
    install(new StalledMatchCache());
    const { value: res, ms } = await timed(hit(buildApp(), edge(ADDRESS)));
    expect(res.status).toBe(200);
    expect(ms).toBeGreaterThanOrEqual(AT_LEAST_MS);
    expect(ms).toBeLessThan(AT_MOST_MS);
    expect(faults().length).toBe(1);
    expect(faults()[0]?.[1]).toMatchObject({ keyKind: "ip", error: "CacheStallError" });
    // Nothing was counted, so nothing is claimed.
    expect(res.headers.get("X-RateLimit-Bucket")).toBeNull();
  });

  test("the miss budget gives up the same way", async () => {
    install(new StalledMatchCache());
    const { value: outcome, ms } = await timed(
      checkDataMissBudget(
        env,
        new Request("http://localhost/data/x", { headers: edge(ADDRESS) }),
        undefined,
      ),
    );
    expect(outcome.allowed).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(AT_LEAST_MS);
    expect(ms).toBeLessThan(AT_MOST_MS);
    expect(faults()[0]?.[1]).toMatchObject({ keyKind: "data-miss-ip", error: "CacheStallError" });
  });

  test("a stalled admin-flag lookup falls back to the ordinary token bucket", async () => {
    class StalledAdminFlag extends InMemoryCache {
      match(request: RequestInfo | URL): Promise<Response | undefined> {
        return (request as Request).url.includes("admin-flag") ? never() : super.match(request);
      }
    }
    install(new StalledAdminFlag());
    const headers = { ...edge(ADDRESS), Authorization: `Bearer ${"a".repeat(48)}` };
    const { value: res, ms } = await timed(hit(buildApp(), headers, "/admin/users"));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("token");
    expect(ms).toBeLessThan(AT_MOST_MS);
    const lookups = h.warn.mock.calls.filter((c) => String(c[0]).includes("admin-flag lookup"));
    expect(lookups[0]?.[1]).toMatchObject({ error: "CacheStallError" });
  });
});

describe("a stalled cache write", () => {
  test.each([
    ["ip", edge(ADDRESS), "/datasets"],
    ["site-ip", viaBinding(ADDRESS), "/datasets"],
    ["auth-ip", edge(ADDRESS), "/auth/login"],
    ["data-ip", edge(ADDRESS), "/data/nm000108/v1.0.0/x"],
  ] as const)(
    "on %s costs the bound, serves the request and logs the fault",
    async (kind, headers, path) => {
      install(new StalledPutCache());
      const { value: res, ms } = await timed(hit(buildApp(), headers, path));
      expect(res.status).toBe(200);
      expect(ms).toBeGreaterThanOrEqual(AT_LEAST_MS);
      expect(ms).toBeLessThan(AT_MOST_MS);
      expect(faults().length).toBe(1);
      expect(faults()[0]?.[1]).toMatchObject({ keyKind: kind, error: "CacheStallError" });
      // The data plane's write is not waited on (in a Worker it is handed to
      // `waitUntil`), so its answer states a count whether or not the write lands;
      // every other bucket waits and says nothing it did not count.
      expect(res.headers.get("X-RateLimit-Bucket")).toBe(kind === "data-ip" ? kind : null);
    },
  );

  test("on the miss budget it is logged", async () => {
    install(new StalledPutCache());
    const { value: outcome, ms } = await timed(
      checkDataMissBudget(
        env,
        new Request("http://localhost/data/x", { headers: edge(ADDRESS) }),
        undefined,
      ),
    );
    expect(outcome.allowed).toBe(true);
    expect(ms).toBeLessThan(AT_MOST_MS);
    expect(faults()[0]?.[1]).toMatchObject({ keyKind: "data-miss-ip", error: "CacheStallError" });
  });

  test("a write that fails after the bound is not an unhandled rejection", async () => {
    class LateFailure extends InMemoryCache {
      put(): Promise<void> {
        return new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 700));
      }
    }
    install(new LateFailure());
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const res = await hit(buildApp(), edge(ADDRESS));
      expect(res.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(unhandled).toEqual([]);
  });
});

describe("a record whose body cannot be read", () => {
  // A body that errors or never finishes says nothing about the record. It is a
  // cache fault (fail open, loud, bounded), not a damaged record to be "repaired"
  // into a counter that restarts at zero on every request and never limits.
  const damaged = () =>
    h.warn.mock.calls.filter((c) => c[0] === "[rate-limit] repaired a damaged counter record");

  class BodyCache extends InMemoryCache {
    constructor(private readonly body: () => ReadableStream<Uint8Array>) {
      super();
    }
    async match(): Promise<Response | undefined> {
      return new Response(this.body(), { headers: { "Content-Type": "application/json" } });
    }
  }

  const erroring = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("network connection lost"));
      },
    });
  const hanging = () => new ReadableStream<Uint8Array>({ start() {} });

  test("a stream that errors is a cache fault, not a damaged record", async () => {
    install(new BodyCache(erroring));
    const app = buildApp();
    for (let i = 0; i < 5; i++) {
      const res = await hit(app, edge(ADDRESS));
      expect(res.status).toBe(200);
      // Nothing was counted, so nothing is claimed: not "remaining 999" five times.
      expect(res.headers.get("X-RateLimit-Remaining")).toBeNull();
    }
    expect(damaged()).toEqual([]);
    expect(faults().length).toBe(1);
    expect(faults()[0]?.[1]).toMatchObject({ keyKind: "ip", error: "Error" });
  });

  test("a body that never finishes costs the bound, then fails open and logs", async () => {
    install(new BodyCache(hanging));
    const { value: res, ms } = await timed(hit(buildApp(), edge(ADDRESS)));
    expect(res.status).toBe(200);
    expect(ms).toBeGreaterThanOrEqual(AT_LEAST_MS);
    expect(ms).toBeLessThan(AT_MOST_MS);
    expect(damaged()).toEqual([]);
    expect(faults()[0]?.[1]).toMatchObject({ keyKind: "ip", error: "CacheStallError" });
  });

  test("the miss budget treats an unreadable record the same way", async () => {
    install(new BodyCache(erroring));
    const outcome = await checkDataMissBudget(
      env,
      new Request("http://localhost/data/x", { headers: edge(ADDRESS) }),
      undefined,
    );
    expect(outcome.allowed).toBe(true);
    expect(damaged()).toEqual([]);
    expect(faults()[0]?.[1]).toMatchObject({ keyKind: "data-miss-ip" });
  });

  test("a body that is not JSON is still a damaged record, and is repaired", async () => {
    class NotJson extends InMemoryCache {
      async match(): Promise<Response | undefined> {
        return new Response("this is not json");
      }
    }
    install(new NotJson());
    const res = await hit(buildApp(), edge(ADDRESS));
    expect(res.status).toBe(200);
    expect(damaged().length).toBe(1);
    expect(faults()).toEqual([]);
  });
});
