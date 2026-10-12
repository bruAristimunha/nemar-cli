/**
 * What the limiter logs when its own machinery fails (#1709).
 *
 * A fault is one outage for every request of a bucket kind, so a log line per
 * request only buries the one that matters: each kind speaks once per window per
 * isolate, says how many lines it swallowed, and names the error class and
 * nothing else (a cache key is a URL that carries the caller's address, and a
 * runtime may quote it in a message).
 */

import { describe, expect, spyOn, test } from "bun:test";
import {
  __limits,
  checkDataMissBudget,
  checkPrivateGrantBudget,
} from "../src/middleware/rateLimit";
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
  test("a thousand data-plane requests, a handful of lines, and every request is served", async () => {
    install(new PutFailingCache());
    const app = buildApp();
    for (let i = 0; i < 1000; i++) {
      const res = await hit(app, edge(ADDRESS), "/data/nm000108/v1.0.0/x");
      expect(res.status).toBe(200);
    }
    // The line that opens the window, then the 11th and the 101st call speak, each
    // reporting only the calls swallowed since the previous line: the burst's size
    // without a line per request.
    expect(faults().map((c) => (c[1] as { suppressed: number }).suppressed)).toEqual([0, 9, 89]);
    expect(faults()[0]?.[1]).toMatchObject({ keyKind: "data-ip", error: "Error" });
  });

  test("each bucket kind has its own line, so one outage is not hidden behind another", async () => {
    install(new PutFailingCache());
    const app = buildApp();
    for (let i = 0; i < 5; i++) {
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
    for (let i = 0; i < 5; i++) {
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
    for (let i = 0; i < 5; i++) await hit(app, edge(ADDRESS));
    expect(faults().length).toBe(1);
    expect(faults()[0]?.[1]).toMatchObject({ suppressed: 0, sinceMs: 0 });

    h.clock = T0 + __limits.WINDOW_SIZE * 1000 - 1;
    await hit(app, edge(ADDRESS));
    expect(faults().length).toBe(1);

    h.clock = T0 + __limits.WINDOW_SIZE * 1000;
    await hit(app, edge(ADDRESS));
    expect(faults().length).toBe(2);
    expect(faults()[1]?.[1]).toMatchObject({ suppressed: 5 });
  });

  test("a burst that ends inside the window is sized on its own lines: the 11th, 101st and 1001st call speak", async () => {
    install(new PutFailingCache());
    const app = buildApp();
    const spoke: number[] = [];
    for (let i = 0; i < 1100; i++) {
      h.clock = T0 + i;
      const before = faults().length;
      await hit(app, edge(ADDRESS));
      if (faults().length > before) spoke.push(i + 1);
    }
    // The opening call, then the 11th, 101st and 1001st: four lines and no more.
    expect(spoke).toEqual([1, 11, 101, 1001]);
    // Each line reports the calls swallowed since the previous line, not the one speaking,
    // so the lines and what they swallowed add up to the calls made up to the last line.
    const swallowed = faults().map((c) => (c[1] as { suppressed: number }).suppressed);
    expect(swallowed).toEqual([0, 9, 89, 899]);
    expect(swallowed.reduce((a, b) => a + b, 0) + faults().length).toBe(1001);
    // Each line says how long ago the previous one was (a call a millisecond).
    expect(faults().map((c) => (c[1] as { sinceMs: number }).sinceMs)).toEqual([0, 10, 90, 900]);
  });

  test("the next window's first line reports the calls swallowed since the last line, milestone or not", async () => {
    install(new PutFailingCache());
    const app = buildApp();
    // 15 calls: the opening line, the 11th call's line, then 4 swallowed.
    for (let i = 0; i < 15; i++) await hit(app, edge(ADDRESS));
    expect(faults().length).toBe(2);
    h.clock = T0 + __limits.WINDOW_SIZE * 1000;
    await hit(app, edge(ADDRESS));
    expect(faults().length).toBe(3);
    expect(faults()[2]?.[1]).toMatchObject({ suppressed: 4 });
  });

  test("a clock that went backwards does not silence the line, and sinceMs is never negative", async () => {
    install(new PutFailingCache());
    const app = buildApp();
    await hit(app, edge(ADDRESS));
    h.clock = T0 - 5000;
    await hit(app, edge(ADDRESS));
    expect(faults().length).toBe(2);
    expect(faults()[1]?.[1]).toMatchObject({ sinceMs: 0 });
  });

  test("sinceMs is never negative on a milestone line either, when the clock steps back inside a window", async () => {
    install(new PutFailingCache());
    const app = buildApp();
    // The 11th call at +30 s, then the clock steps back to +20 s for the 101st.
    for (let i = 0; i < 10; i++) {
      h.clock = T0 + 1000;
      await hit(app, edge(ADDRESS));
    }
    h.clock = T0 + 30_000;
    await hit(app, edge(ADDRESS));
    h.clock = T0 + 20_000;
    for (let i = 0; i < 90; i++) await hit(app, edge(ADDRESS));
    const since = faults().map((c) => (c[1] as { sinceMs: number }).sinceMs);
    expect(since.length).toBe(3);
    for (const ms of since) expect(ms).toBeGreaterThanOrEqual(0);
    expect(since[2]).toBe(0);
  });

  test("a write fault does not hide a later fault of another phase on the same bucket", async () => {
    // The limiter's own logic fails ten seconds after a transient stall in the write:
    // keyed by kind alone, the second would be swallowed for the rest of the window.
    class ThenMatchFails extends InMemoryCache {
      failMatch = false;
      async put(): Promise<void> {
        throw new TypeError("a transient write fault");
      }
      async match(request: RequestInfo | URL): Promise<Response | undefined> {
        if (this.failMatch) throw new RangeError("a later lookup fault");
        return super.match(request);
      }
    }
    const cache = new ThenMatchFails();
    install(cache);
    const app = buildApp();
    await hit(app, edge(ADDRESS));
    h.clock = T0 + 10_000;
    cache.failMatch = true;
    await hit(app, edge(ADDRESS));
    const lines = faults().map((c) => c[1] as { phase: string; error: string });
    expect(lines.map((l) => [l.phase, l.error])).toEqual([
      ["put", "TypeError"],
      ["match", "RangeError"],
    ]);
  });

  test("a transient fault does not hide a persistent one of another class in the same phase", async () => {
    // A write fails once with a TypeError and then, every time, with a RangeError.
    class WriteFaultChanges extends InMemoryCache {
      puts = 0;
      async put(): Promise<void> {
        this.puts++;
        if (this.puts === 1) throw new TypeError("a transient write fault");
        throw new RangeError("a persistent write fault");
      }
    }
    install(new WriteFaultChanges());
    const app = buildApp();
    for (let i = 0; i < 5; i++) await hit(app, edge(ADDRESS));
    const lines = faults().map((c) => c[1] as { phase: string; error: string; suppressed: number });
    // One line for each class, and the persistent one swallows its repeats.
    expect(lines.map((l) => [l.phase, l.error])).toEqual([
      ["put", "TypeError"],
      ["put", "RangeError"],
    ]);
    expect(lines[1]?.suppressed).toBe(0);
  });

  test("a stalled write does not hide a persistent fault in the same phase", async () => {
    // The first write never settles and is given up on; every later one fails outright.
    class StallsOnceThenFails extends InMemoryCache {
      puts = 0;
      put(): Promise<void> {
        this.puts++;
        if (this.puts === 1) return new Promise<void>(() => {});
        return Promise.reject(new TypeError("a persistent write fault"));
      }
    }
    install(new StallsOnceThenFails());
    const app = buildApp();
    for (let i = 0; i < 4; i++) await hit(app, edge(ADDRESS));
    const lines = faults().map((c) => c[1] as { phase: string; error: string });
    expect(lines.map((l) => [l.phase, l.error])).toEqual([
      ["put", "CacheStallError"],
      ["put", "TypeError"],
    ]);
  });

  test("error names a runtime invents share one key, so the key space has a ceiling", async () => {
    let n = 0;
    class InventiveWrites extends InMemoryCache {
      async put(): Promise<void> {
        const error = new Error("a write fault");
        error.name = `Fault${n++}`;
        throw error;
      }
    }
    install(new InventiveWrites());
    const app = buildApp();
    for (let i = 0; i < 6; i++) await hit(app, edge(ADDRESS));
    // The first names itself on its line; the rest are the same unnamed class.
    expect(faults().length).toBe(1);
    expect(faults()[0]?.[1]).toMatchObject({ phase: "put", error: "Fault0" });
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
    for (let i = 0; i < 5; i++) {
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
    for (let i = 0; i < 5; i++) {
      expect((await hit(app, edge("203.0.113.80"))).status).toBe(429);
    }
    expect(refusals().length).toBe(1);
    expect(refusals()[0]?.[1]).toEqual({
      keyKind: "ip",
      caller: "edge",
      maxRequests: __limits.MAX_REQUESTS,
      retryAfter: 30,
      suppressed: 0,
      sinceMs: 0,
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
    expect(refusals()[1]?.[1]).toMatchObject({ suppressed: 4, retryAfter: 60 });
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
      {
        keyKind: "auth-ip",
        caller: "edge",
        maxRequests: 10,
        retryAfter: 60,
        suppressed: 0,
        sinceMs: 0,
      },
      {
        keyKind: "auth-ip",
        caller: "site",
        maxRequests: 10,
        retryAfter: 60,
        suppressed: 0,
        sinceMs: 0,
      },
      {
        keyKind: "auth-ip",
        caller: "unattributed",
        maxRequests: 10,
        retryAfter: 60,
        suppressed: 0,
        sinceMs: 0,
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

describe("a fault line says where the work failed", () => {
  const phaseOf = () => (faults()[0]?.[1] as { phase?: string; error?: string } | undefined) ?? {};

  test("the lookup", async () => {
    class MatchFails extends InMemoryCache {
      async match(): Promise<Response | undefined> {
        throw new Error("the lookup failed");
      }
    }
    install(new MatchFails());
    await hit(buildApp(), edge(ADDRESS));
    expect(phaseOf()).toMatchObject({ phase: "match", error: "Error" });
  });

  test("the read of the record's body", async () => {
    class BodyFails extends InMemoryCache {
      async match(): Promise<Response | undefined> {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("network connection lost"));
            },
          }),
        );
      }
    }
    install(new BodyFails());
    await hit(buildApp(), edge(ADDRESS));
    expect(phaseOf()).toMatchObject({ phase: "read", error: "Error" });
  });

  test("the write", async () => {
    install(new PutFailingCache());
    await hit(buildApp(), edge(ADDRESS));
    expect(phaseOf()).toMatchObject({ phase: "put" });
  });

  test("the limiter's own logic is a different phase, so a bug there is not mistaken for the cache", async () => {
    // The observe-only warning hashes the key before it logs; a platform that cannot
    // hash makes the limiter itself fail after the cache answered.
    await h.seed(`ip:${ADDRESS}`, {
      count: __limits.MAX_REQUESTS,
      warned: false,
      windowEnd: T0 + 30_000,
    });
    const digest = spyOn(crypto.subtle, "digest").mockImplementation(() => {
      throw new TypeError("digest is unavailable");
    });
    try {
      const res = await hit(buildApp({ observeOnly: true }), edge(ADDRESS));
      expect(res.status).toBe(200);
    } finally {
      digest.mockRestore();
    }
    // It is the limiter failing, not the cache, and the line says so.
    const limiterFaults = h.error.mock.calls.filter((c) => c[0] === "[rate-limit] limiter fault");
    expect(limiterFaults.length).toBe(1);
    expect(limiterFaults[0]?.[1]).toMatchObject({ phase: "decide", error: "TypeError" });
    expect(faults()).toEqual([]);
  });

  describe("a bug in reading the record is the limiter's, not the read's", () => {
    // A record whose `count` throws when the limiter looks at it: the body arrived and
    // parsed, and what fails is the limiter's own interpretation of it.
    class HostileRecord extends InMemoryCache {
      puts = 0;
      async put(request: RequestInfo | URL, response: Response): Promise<void> {
        this.puts++;
        return super.put(request, response);
      }
      async match(): Promise<Response | undefined> {
        const response = new Response("{}");
        response.json = async () =>
          Object.defineProperty({}, "count", {
            get() {
              throw new RangeError("the record is hostile");
            },
          });
        return response;
      }
    }
    const limiterFaults = () =>
      h.error.mock.calls.filter((c) => c[0] === "[rate-limit] limiter fault");

    test("on the request path", async () => {
      const cache = new HostileRecord();
      install(cache);
      const res = await hit(buildApp(), edge(ADDRESS));
      expect(res.status).toBe(200);
      expect(limiterFaults().length).toBe(1);
      expect(limiterFaults()[0]?.[1]).toMatchObject({ phase: "decide", error: "RangeError" });
      expect(faults()).toEqual([]);
      // It failed open: nothing was counted, so nothing was written and nothing announced.
      expect(cache.puts).toBe(0);
      expect([...res.headers.keys()].filter((name) => name.startsWith("x-ratelimit"))).toEqual([]);
    });

    test("on the keyed-budget path", async () => {
      const env = { ENVIRONMENT: "production" } as Pick<
        Bindings,
        "ENVIRONMENT" | "TEST_BYPASS_TOKEN"
      >;
      const cache = new HostileRecord();
      install(cache);
      const outcome = await checkDataMissBudget(
        env,
        new Request("http://localhost/data/x", { headers: edge(ADDRESS) }),
        undefined,
      );
      expect(outcome.allowed).toBe(true);
      // Failed open: no count was written.
      expect(cache.puts).toBe(0);
      expect(limiterFaults().length).toBe(1);
      expect(limiterFaults()[0]?.[1]).toMatchObject({
        keyKind: "data-miss-ip",
        phase: "decide",
        error: "RangeError",
      });
      expect(faults()).toEqual([]);
    });
  });

  test("a line that comes back says how long ago the burst it reports began", async () => {
    install(new PutFailingCache());
    const app = buildApp();
    await hit(app, edge(ADDRESS));
    await hit(app, edge(ADDRESS));
    h.clock = T0 + __limits.WINDOW_SIZE * 1000 + 250;
    await hit(app, edge(ADDRESS));
    expect(faults()[0]?.[1]).toMatchObject({ suppressed: 0, sinceMs: 0 });
    expect(faults()[1]?.[1]).toMatchObject({ suppressed: 1, sinceMs: 60_250 });
  });
});

describe("the identity lines", () => {
  const siteLines = () =>
    h.log.mock.calls.filter((c) => String(c[0]).includes("counting a request without"));
  const unattributedLines = () =>
    h.warn.mock.calls.filter((c) => String(c[0]).includes("request with neither"));

  test("the healthy site line is one per window, however many calls the website makes", async () => {
    const app = buildApp();
    for (let i = 0; i < 1100; i++) {
      h.clock = T0 + i;
      await hit(app, viaBinding(ADDRESS));
    }
    expect(siteLines().length).toBe(1);
    // The window ends: the next line reports what the first window swallowed.
    h.clock = T0 + __limits.WINDOW_SIZE * 1000;
    await hit(app, viaBinding(ADDRESS));
    expect(siteLines().length).toBe(2);
    expect(siteLines()[1]?.[1]).toMatchObject({ suppressed: 1099 });
  });

  test("a caller that names nobody is a symptom and keeps its milestones", async () => {
    const app = buildApp();
    for (let i = 0; i < 1100; i++) {
      h.clock = T0 + i;
      await hit(app, {});
    }
    expect(unattributedLines().length).toBe(4);
  });
});

describe("the once-per-window machinery", () => {
  const failing = () => {
    install(new PutFailingCache());
    return buildApp();
  };

  test("a line that has come back is still once per window, not once per call", async () => {
    const app = failing();
    await hit(app, edge(ADDRESS));
    h.clock = T0 + __limits.WINDOW_SIZE * 1000;
    await hit(app, edge(ADDRESS));
    expect(faults().length).toBe(2);
    for (const offset of [1, 1000, 30_000, __limits.WINDOW_SIZE * 1000 - 1]) {
      h.clock = T0 + __limits.WINDOW_SIZE * 1000 + offset;
      await hit(app, edge(ADDRESS));
    }
    expect(faults().length).toBe(2);
    h.clock = T0 + 2 * __limits.WINDOW_SIZE * 1000;
    await hit(app, edge(ADDRESS));
    expect(faults().length).toBe(3);
    expect(faults()[2]?.[1]).toMatchObject({ suppressed: 4 });
  });

  test("a fault line names the route", async () => {
    await hit(failing(), edge(ADDRESS), "/auth/login");
    expect(faults()[0]?.[1]).toMatchObject({ keyKind: "auth-ip", route: "/auth/login" });
  });

  test("a site caller and an unattributed one on the SAME bucket each get their line", async () => {
    const app = buildApp();
    await hit(app, viaBinding("203.0.113.151"), "/auth/login");
    await hit(app, {}, "/auth/login");
    expect(h.log.mock.calls.length).toBe(1);
    expect(h.warn.mock.calls.filter((c) => String(c[0]).startsWith("[rate-limit]")).length).toBe(1);
    expect(h.warn.mock.calls[0]?.[1]).toMatchObject({ keyKind: "auth-ip", reason: "absent" });
  });

  test("the two lines an operator greps for read exactly as the ADR says", async () => {
    const app = buildApp();
    await hit(app, viaBinding("203.0.113.152"));
    await hit(app, {});
    expect(h.log.mock.calls[0]?.[0]).toBe(
      "[rate-limit] counting a request without CF-Connecting-IP by its forwarded visitor",
    );
    expect(h.warn.mock.calls[0]?.[0]).toBe(
      "[rate-limit] request with neither CF-Connecting-IP nor a usable X-Forwarded-For; counted in a shared bucket",
    );
  });

  describe("a repair is logged once per bucket kind AND kind of damage", () => {
    const repaired = () =>
      h.warn.mock.calls
        .filter((c) => c[0] === "[rate-limit] repaired a damaged counter record")
        .map((c) => c[1]);

    test("two kinds of damage on one bucket kind are two lines", async () => {
      const app = buildApp();
      await h.seed("ip:203.0.113.153", "not json", 3600);
      await h.seed("ip:203.0.113.154", { count: "lots", windowEnd: T0 + 30_000 }, 3600);
      await hit(app, edge("203.0.113.153"));
      await hit(app, edge("203.0.113.154"));
      expect(repaired()).toEqual([
        { keyKind: "ip", damage: "unparseable", suppressed: 0, sinceMs: 0 },
        { keyKind: "ip", damage: "bad-count", suppressed: 0, sinceMs: 0 },
      ]);
    });

    test("one kind of damage on two bucket kinds is two lines", async () => {
      const app = buildApp();
      await h.seed("ip:203.0.113.155", "not json", 3600);
      await h.seed("auth-ip:203.0.113.156", "not json", 3600);
      await hit(app, edge("203.0.113.155"));
      await hit(app, edge("203.0.113.156"), "/auth/login");
      expect(repaired().map((r) => (r as { keyKind: string }).keyKind)).toEqual(["ip", "auth-ip"]);
    });

    test("the budgets name their own kind", async () => {
      const env = { ENVIRONMENT: "production" } as Pick<
        Bindings,
        "ENVIRONMENT" | "TEST_BYPASS_TOKEN"
      >;
      await h.seed(`data-miss-ip:${ADDRESS}`, "not json", 3600);
      await h.seed("private-grant-account:user-5", "not json", 3600);
      await checkDataMissBudget(
        env,
        new Request("http://localhost/data/x", { headers: edge(ADDRESS) }),
        undefined,
      );
      await checkPrivateGrantBudget(env, new Request("http://localhost/x"), 5, undefined);
      expect(repaired().map((r) => (r as { keyKind: string }).keyKind)).toEqual([
        "data-miss-ip",
        "private-grant-account",
      ]);
    });
  });
});
