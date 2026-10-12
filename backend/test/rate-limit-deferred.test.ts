/**
 * Writes handed to `waitUntil` are bounded and logged like every other (#1709).
 *
 * The data plane's counter write, the miss budget's, and the private-grant
 * budget's are not waited on: in a Worker they go to `waitUntil`. A put that
 * fails or never settles there left no log line and no count, so the bucket
 * silently limited nothing. These tests hand the limiter a real `waitUntil` that
 * keeps what it is given, then wait for it, as the runtime does.
 */

import { describe, expect, test } from "bun:test";
import { checkDataMissBudget, checkPrivateGrantBudget } from "../src/middleware/rateLimit";
import type { Bindings } from "../src/types/bindings";
import { InMemoryCache } from "./helpers/cache";
import { PROD_ENV, buildApp, edge, useRateLimitHarness } from "./helpers/rate-limit-harness";

const h = useRateLimitHarness();

const ADDRESS = "203.0.113.120";
const FAULT = "[rate-limit] cache failure";
const env = { ENVIRONMENT: "production" } as Pick<Bindings, "ENVIRONMENT" | "TEST_BYPASS_TOKEN">;

class PutFailingCache extends InMemoryCache {
  async put(): Promise<void> {
    throw new Error("the put failed");
  }
}

class PutStalledCache extends InMemoryCache {
  put(): Promise<void> {
    return new Promise<void>(() => {});
  }
}

function install(cache: InMemoryCache): void {
  (globalThis as { caches?: unknown }).caches = { default: cache };
}

/** A `waitUntil` that keeps what it is handed, the way the runtime does until it is settled. */
function collector() {
  const work: Promise<unknown>[] = [];
  return {
    work,
    waitUntil: (p: Promise<unknown>) => {
      work.push(p);
    },
    executionCtx: {
      waitUntil: (p: Promise<unknown>) => {
        work.push(p);
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
    settled: () => Promise.all(work),
  };
}

const faults = () => h.error.mock.calls.filter((c) => c[0] === FAULT);

/** The count a bucket holds in a cache this file installed itself. */
async function countIn(cache: InMemoryCache, key: string): Promise<unknown> {
  const res = await cache.match(new Request(`https://rate-limit.internal/rl:${key}`));
  return res ? ((await res.json()) as { count?: unknown }).count : undefined;
}

async function viaCounter(cache: InMemoryCache) {
  install(cache);
  const ctx = collector();
  const res = await buildApp().fetch(
    new Request("http://localhost/data/nm000108/v1.0.0/x", { headers: edge(ADDRESS) }),
    PROD_ENV,
    ctx.executionCtx,
  );
  return { res, ctx };
}

async function viaMissBudget(cache: InMemoryCache) {
  install(cache);
  const ctx = collector();
  const outcome = await checkDataMissBudget(
    env,
    new Request("http://localhost/data/x", { headers: edge(ADDRESS) }),
    ctx.waitUntil,
  );
  return { outcome, ctx };
}

async function viaPrivateGrant(cache: InMemoryCache) {
  install(cache);
  const ctx = collector();
  const outcome = await checkPrivateGrantBudget(
    env,
    new Request("http://localhost/auth/private/grant"),
    77,
    ctx.waitUntil,
  );
  return { outcome, ctx };
}

describe("a deferred write that fails", () => {
  test("on the data plane's counter is logged, not lost", async () => {
    const { res, ctx } = await viaCounter(new PutFailingCache());
    expect(res.status).toBe(200);
    await ctx.settled();
    expect(faults().length).toBe(1);
    expect(faults()[0]?.[1]).toMatchObject({ keyKind: "data-ip", phase: "put", error: "Error" });
  });

  test("on the miss budget is logged, and the settled work does not reject", async () => {
    const { outcome, ctx } = await viaMissBudget(new PutFailingCache());
    expect(outcome.allowed).toBe(true);
    await ctx.settled();
    expect(faults()[0]?.[1]).toMatchObject({ keyKind: "data-miss-ip", error: "Error" });
  });

  test("on the private-grant budget is logged", async () => {
    const { outcome, ctx } = await viaPrivateGrant(new PutFailingCache());
    expect(outcome.allowed).toBe(true);
    await ctx.settled();
    expect(faults()[0]?.[1]).toMatchObject({ keyKind: "private-grant-account", error: "Error" });
  });
});

describe("a deferred write that never settles", () => {
  const AT_LEAST_MS = 400;
  const AT_MOST_MS = 4000;

  test.each([
    ["the data plane's counter", viaCounter, "data-ip"],
    ["the miss budget", viaMissBudget, "data-miss-ip"],
    ["the private-grant budget", viaPrivateGrant, "private-grant-account"],
  ] as const)("on %s is given up on after the bound and logged", async (_name, run, kind) => {
    const { ctx } = await run(new PutStalledCache());
    const started = performance.now();
    await ctx.settled();
    const ms = performance.now() - started;
    expect(ms).toBeGreaterThanOrEqual(AT_LEAST_MS - 100);
    expect(ms).toBeLessThan(AT_MOST_MS);
    expect(faults().length).toBe(1);
    expect(faults()[0]?.[1]).toMatchObject({ keyKind: kind, error: "CacheStallError" });
  });
});

describe("a write handed to waitUntil is handed over, counted, and never waited on", () => {
  test("the data plane's counter hands over exactly one write per request", async () => {
    const cache = new InMemoryCache();
    const { res, ctx } = await viaCounter(cache);
    expect(res.status).toBe(200);
    expect(ctx.work.length).toBe(1);
    await ctx.settled();
    expect(await countIn(cache, `data-ip:${ADDRESS}`)).toBe(1);
  });

  test("a write that never settles does not delay the response", async () => {
    const started = performance.now();
    const { res, ctx } = await viaCounter(new PutStalledCache());
    expect(res.status).toBe(200);
    expect(performance.now() - started).toBeLessThan(250);
    expect(ctx.work.length).toBe(1);
    // Let the abandoned write give up inside this test, not inside the next one.
    await ctx.settled();
  });

  test("the miss budget hands over one write, which lands", async () => {
    const cache = new InMemoryCache();
    const { outcome, ctx } = await viaMissBudget(cache);
    expect(outcome.allowed).toBe(true);
    expect(ctx.work.length).toBe(1);
    await ctx.settled();
    expect(await countIn(cache, `data-miss-ip:${ADDRESS}`)).toBe(1);
  });

  test("the private-grant budget hands over one write, which lands", async () => {
    const cache = new InMemoryCache();
    const { outcome, ctx } = await viaPrivateGrant(cache);
    expect(outcome.allowed).toBe(true);
    expect(ctx.work.length).toBe(1);
    await ctx.settled();
    expect(await countIn(cache, "private-grant-account:user-77")).toBe(1);
  });
});
