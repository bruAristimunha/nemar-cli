/**
 * What the limiter logs when its own machinery fails (#1709).
 *
 * A fault is one outage for every request of a bucket kind, so a log line per
 * request only buries the one that matters: each kind speaks once per window per
 * isolate, says how many lines it swallowed, and names the error class and
 * nothing else (a cache key is a URL that carries the caller's address, and a
 * runtime may quote it in a message).
 */

import { describe, expect, test } from "bun:test";
import { __limits, checkDataMissBudget } from "../src/middleware/rateLimit";
import type { Bindings } from "../src/types/bindings";
import { InMemoryCache } from "./helpers/cache";
import {
  T0,
  buildApp,
  edge,
  hit,
  useRateLimitHarness,
  viaBinding,
} from "./helpers/rate-limit-harness";

const h = useRateLimitHarness();

const ADDRESS = "203.0.113.77";
const FAULT = "[rate-limit] cache failure";

/** A cache whose writes fail with a message that quotes the key, as a runtime might. */
class PutFailingCache extends InMemoryCache {
  async put(request: RequestInfo | URL): Promise<void> {
    throw new Error(`put failed for ${(request as Request).url}`);
  }
}

function install(cache: InMemoryCache): void {
  (globalThis as { caches?: unknown }).caches = { default: cache };
}

const faults = () => h.error.mock.calls.filter((c) => c[0] === FAULT);

describe("a failing cache write is logged once per kind per window", () => {
  test("a thousand data-plane requests, one line, and every request is served", async () => {
    install(new PutFailingCache());
    const app = buildApp();
    for (let i = 0; i < 1000; i++) {
      const res = await hit(app, edge(ADDRESS), "/data/nm000108/v1.0.0/x");
      expect(res.status).toBe(200);
    }
    expect(faults().length).toBe(1);
    expect(faults()[0]?.[1]).toMatchObject({ keyKind: "data-ip", error: "Error" });
  });

  test("each bucket kind has its own line, so one outage is not hidden behind another", async () => {
    install(new PutFailingCache());
    const app = buildApp();
    for (let i = 0; i < 20; i++) {
      await hit(app, edge(ADDRESS));
      await hit(app, viaBinding(ADDRESS));
      await hit(app, edge(ADDRESS), "/auth/login");
    }
    const kinds = faults().map((c) => (c[1] as { keyKind: string }).keyKind);
    expect(kinds.sort()).toEqual(["auth-ip", "ip", "site-ip"]);
  });

  test("the miss budget's failing write is logged once as well", async () => {
    install(new PutFailingCache());
    const env = { ENVIRONMENT: "production" } as Pick<
      Bindings,
      "ENVIRONMENT" | "TEST_BYPASS_TOKEN"
    >;
    for (let i = 0; i < 20; i++) {
      const outcome = await checkDataMissBudget(
        env,
        new Request("http://localhost/data/x", { headers: edge(ADDRESS) }),
        undefined,
      );
      expect(outcome.allowed).toBe(true);
    }
    expect(faults().length).toBe(1);
    expect(faults()[0]?.[1]).toMatchObject({ keyKind: "data-miss-ip" });
  });

  test("the line comes back after a window and says how many it swallowed", async () => {
    install(new PutFailingCache());
    const app = buildApp();
    for (let i = 0; i < 20; i++) await hit(app, edge(ADDRESS));
    expect(faults().length).toBe(1);
    expect(faults()[0]?.[1]).toMatchObject({ suppressed: 0 });

    h.clock = T0 + __limits.WINDOW_SIZE * 1000 - 1;
    await hit(app, edge(ADDRESS));
    expect(faults().length).toBe(1);

    h.clock = T0 + __limits.WINDOW_SIZE * 1000;
    await hit(app, edge(ADDRESS));
    expect(faults().length).toBe(2);
    expect(faults()[1]?.[1]).toMatchObject({ suppressed: 20 });
  });

  test("a clock that went backwards does not silence the line", async () => {
    install(new PutFailingCache());
    const app = buildApp();
    await hit(app, edge(ADDRESS));
    h.clock = T0 - 5000;
    await hit(app, edge(ADDRESS));
    expect(faults().length).toBe(2);
  });
});

describe("what a fault line may contain", () => {
  test("the error class, the bucket kind and the route: never a message, a key or an address", async () => {
    install(new PutFailingCache());
    const app = buildApp();
    await hit(app, edge(ADDRESS));
    await hit(app, viaBinding(ADDRESS));
    const text = JSON.stringify(h.error.mock.calls);
    expect(text).not.toContain(ADDRESS);
    expect(text).not.toContain("rate-limit.internal");
    expect(text).not.toContain("put failed");
  });
});

describe("the privileged-token lookup", () => {
  test("a failing lookup warns once per window, by error class", async () => {
    const app = buildApp();
    const headers = { ...edge(ADDRESS), Authorization: `Bearer ${"a".repeat(48)}` };
    for (let i = 0; i < 20; i++) {
      // This suite has no database, so every lookup fails and the request is
      // counted in the ordinary token bucket.
      const res = await hit(app, headers, "/admin/users");
      expect(res.headers.get("X-RateLimit-Bucket")).toBe("token");
    }
    const lookups = h.warn.mock.calls.filter((c) => String(c[0]).includes("admin-flag lookup"));
    expect(lookups.length).toBe(1);
    expect(lookups[0]?.[1]).toMatchObject({ error: "TypeError", suppressed: 0 });
  });
});

describe("refusals are logged once per window per bucket kind", () => {
  const refusals = () => h.warn.mock.calls.filter((c) => c[0] === "[rate-limit] refusing");

  test("the first refusal says which bucket, its cap and when it ends; the rest are counted", async () => {
    const app = buildApp();
    await h.seed("ip:203.0.113.80", {
      count: __limits.MAX_REQUESTS,
      warned: false,
      windowEnd: T0 + 30_000,
    });
    for (let i = 0; i < 50; i++) {
      expect((await hit(app, edge("203.0.113.80"))).status).toBe(429);
    }
    expect(refusals().length).toBe(1);
    expect(refusals()[0]?.[1]).toEqual({
      keyKind: "ip",
      caller: "edge",
      maxRequests: __limits.MAX_REQUESTS,
      retryAfter: 30,
      suppressed: 0,
    });
    // A minute later, in another full window: one more line, which says how many
    // refusals the quiet period swallowed.
    h.clock = T0 + __limits.WINDOW_SIZE * 1000;
    await h.seed("ip:203.0.113.80", {
      count: __limits.MAX_REQUESTS,
      warned: false,
      windowEnd: h.clock + __limits.WINDOW_SIZE * 1000,
    });
    await hit(app, edge("203.0.113.80"));
    expect(refusals().length).toBe(2);
    expect(refusals()[1]?.[1]).toMatchObject({ suppressed: 49, retryAfter: 60 });
  });

  test("a different caller on the same bucket has a line of its own, so noise cannot hide a site outage", async () => {
    const app = buildApp();
    const full = { count: __limits.AUTH_MAX_REQUESTS, warned: false, windowEnd: T0 + 60_000 };
    await h.seed("auth-ip:203.0.113.90", full);
    await h.seed("auth-ip:site:203.0.113.91", full);
    await h.seed("auth-ip:unattributed", full);
    // Ordinary public brute-force noise first...
    for (let i = 0; i < 5; i++) await hit(app, edge("203.0.113.90"), "/auth/login");
    // ...and then the website being refused on the same bucket.
    await hit(app, viaBinding("203.0.113.91"), "/auth/login");
    await hit(app, {}, "/auth/login");
    expect(refusals().map((c) => c[1])).toEqual([
      { keyKind: "auth-ip", caller: "edge", maxRequests: 10, retryAfter: 60, suppressed: 0 },
      { keyKind: "auth-ip", caller: "site", maxRequests: 10, retryAfter: 60, suppressed: 0 },
      {
        keyKind: "auth-ip",
        caller: "unattributed",
        maxRequests: 10,
        retryAfter: 60,
        suppressed: 0,
      },
    ]);
  });

  test("each bucket kind has its own line, and none holds an address", async () => {
    const app = buildApp();
    await h.seed("auth-ip:203.0.113.81", {
      count: __limits.AUTH_MAX_REQUESTS,
      windowEnd: T0 + 60_000,
    });
    await h.seed("site-ip:site:203.0.113.82", {
      count: __limits.SITE_IP_MAX_REQUESTS,
      windowEnd: T0 + 60_000,
    });
    await hit(app, edge("203.0.113.81"), "/auth/login");
    await hit(app, viaBinding("203.0.113.82"));
    expect(refusals().map((c) => (c[1] as { keyKind: string }).keyKind)).toEqual([
      "auth-ip",
      "site-ip",
    ]);
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain("203.0.113.8");
  });

  test("the miss budget's refusals are logged too", async () => {
    const env = { ENVIRONMENT: "production" } as Pick<
      Bindings,
      "ENVIRONMENT" | "TEST_BYPASS_TOKEN"
    >;
    await h.seed("data-miss-ip:203.0.113.83", {
      count: __limits.DATA_MISS_MAX_REQUESTS,
      windowEnd: T0 + 20_000,
    });
    for (let i = 0; i < 5; i++) {
      const outcome = await checkDataMissBudget(
        env,
        new Request("http://localhost/data/x", { headers: edge("203.0.113.83") }),
        undefined,
      );
      expect(outcome.allowed).toBe(false);
    }
    expect(refusals().length).toBe(1);
    expect(refusals()[0]?.[1]).toMatchObject({ keyKind: "data-miss-ip", retryAfter: 20 });
  });
});
