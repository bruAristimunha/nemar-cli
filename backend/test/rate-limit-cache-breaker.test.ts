/**
 * The cache-stall breaker (#1715).
 *
 * Every limiter call to the Cache API is bounded at 500 ms and then fails open
 * (`rate-limit-cache-stall.test.ts`). The bound remembers nothing, so while the
 * cache stays stalled every request would pay it. The breaker remembers, per
 * isolate: three stalls within a window open it, an open breaker skips the cache at
 * once for a cool-down, and then one probe decides whether it closes.
 *
 * Driven through the real limiter and a real Hono app. The one stand-in is the
 * harness's cache, which a test can make stall: the platform failing is the thing a
 * test cannot get from the real runtime. Stalls use real timers (the bound is 500
 * ms); the breaker's own clock is the harness's held `Date.now`, so a cool-down is
 * walked across without a real wait.
 */

import { describe, expect, test } from "bun:test";
import {
  __cacheBreakerForTests,
  __limits,
  __stallLimits,
  checkDataMissBudget,
} from "../src/middleware/rateLimit";
import { hashApiKey } from "../src/services/token";
import type { Bindings } from "../src/types/bindings";
import { InMemoryCache } from "./helpers/cache";
import { freshDb, realD1 } from "./helpers/d1";
import {
  PROD_ENV,
  T0,
  buildApp,
  edge,
  hit,
  useRateLimitHarness,
  viaBinding,
} from "./helpers/rate-limit-harness";

const h = useRateLimitHarness();

const {
  BREAKER_STALLS_TO_OPEN: STALLS_TO_OPEN,
  BREAKER_STALL_WINDOW_MS: STALL_WINDOW_MS,
  BREAKER_COOL_DOWN_MS: COOL_DOWN_MS,
  RATE_LIMIT_WRITE_STALL_MS: BOUND_MS,
} = __stallLimits;

/** A wait that was felt: most of the bound. */
const WAITED_MS = 400;
/** A request that did not wait: well under the bound. */
const NO_WAIT_MS = BOUND_MS / 2;
const AT_MOST_MS = 4000;
/** For a test that meets several stalls one after another, each a real 500 ms. */
const SLOW_TEST_MS = 20_000;

const OPEN_LINE = "[rate-limit] the cache keeps stalling; skipping it and failing open";
const CLOSE_LINE = "[rate-limit] the cache answered again; no longer skipping it";
const FAULT = "[rate-limit] cache failure";

const opened = () => h.error.mock.calls.filter((c) => c[0] === OPEN_LINE);
const closed = () => h.log.mock.calls.filter((c) => c[0] === CLOSE_LINE);
const skips = (keyKind: string) =>
  h.error.mock.calls.filter(
    (c) =>
      c[0] === FAULT &&
      (c[1] as { keyKind: string; error: string }).keyKind === keyKind &&
      (c[1] as { error: string }).error === "CacheSkippedError",
  );
const isOpen = () => __cacheBreakerForTests().open;

async function timed<T>(work: Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await work;
  return { value, ms: performance.now() - started };
}

/** `count` visitors meet a stalled cache at once, each on the anonymous `ip` bucket. */
async function stallAtOnce(count: number, prefix = "198.51.100"): Promise<Response[]> {
  h.cache.stalled = true;
  const app = buildApp();
  return Promise.all(Array.from({ length: count }, (_, i) => hit(app, edge(`${prefix}.${i + 1}`))));
}

/** Open the breaker the way production would: enough requests meeting a stalled cache. */
async function openByStalls(): Promise<void> {
  await stallAtOnce(STALLS_TO_OPEN);
  expect(isOpen()).toBe(true);
}

const env = { ENVIRONMENT: "production" } as Pick<Bindings, "ENVIRONMENT" | "TEST_BYPASS_TOKEN">;
const missBudget = (
  address: string,
  waitUntil: ((work: Promise<unknown>) => void) | undefined = undefined,
) =>
  checkDataMissBudget(
    env,
    new Request("http://localhost/data/x", { headers: edge(address) }),
    waitUntil,
  );

/** A `waitUntil` that keeps what it is handed, the way the runtime does until it settles. */
function collector() {
  const work: Promise<unknown>[] = [];
  const waitUntil = (p: Promise<unknown>) => {
    work.push(p);
  };
  return {
    waitUntil,
    executionCtx: { waitUntil, passThroughOnException: () => {} } as unknown as ExecutionContext,
    settled: () => Promise.all(work),
  };
}

/** A cached record whose body never finishes, for the requests whose key matches `which`. */
class HangingBody extends InMemoryCache {
  constructor(private readonly which: (url: string) => boolean = () => true) {
    super();
  }
  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    if (!this.which((request as Request).url)) return super.match(request);
    return new Response(new ReadableStream<Uint8Array>({ start() {} }));
  }
}

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

describe("the numbers", () => {
  test("three stalls within one window open it, for ten seconds", () => {
    // Pinned so a change is a decision. More than one stall, so a single slow call
    // (already bounded) never switches counting off; a cool-down well inside a
    // window, so counting resumes soon after the cache recovers.
    expect(STALLS_TO_OPEN).toBe(3);
    expect(STALL_WINDOW_MS).toBe(__limits.WINDOW_SIZE * 1000);
    expect(COOL_DOWN_MS).toBe(10_000);
    expect(BOUND_MS).toBe(500);
  });
});

describe("a healthy cache", () => {
  test("is untouched by the breaker: every call reaches the cache and every request is counted", async () => {
    const app = buildApp();
    for (let i = 1; i <= 50; i++) {
      const { value: res, ms } = await timed(hit(app, edge("203.0.113.10")));
      expect(res.status).toBe(200);
      expect(res.headers.get("X-RateLimit-Remaining")).toBe(String(__limits.MAX_REQUESTS - i));
      expect(ms).toBeLessThan(NO_WAIT_MS);
    }
    // A lookup and a write for each request: nothing skipped.
    expect(h.cache.calls).toBe(100);
    expect(isOpen()).toBe(false);
    expect(__cacheBreakerForTests().stallsRemembered).toBe(0);
    expect(opened()).toEqual([]);
    expect(h.error.mock.calls).toEqual([]);
  });
});

describe("stalls open it", () => {
  test("a single stall still costs the bound, serves the request, and does not open it", async () => {
    h.cache.stalled = true;
    const { value: res, ms } = await timed(hit(buildApp(), edge("203.0.113.20")));
    expect(res.status).toBe(200);
    expect(ms).toBeGreaterThanOrEqual(WAITED_MS);
    expect(ms).toBeLessThan(AT_MOST_MS);
    expect(isOpen()).toBe(false);
    expect(__cacheBreakerForTests().stallsRemembered).toBe(1);

    // The cache answers again and the next request is counted as usual.
    h.cache.stalled = false;
    const next = await hit(buildApp(), edge("203.0.113.20"));
    expect(next.headers.get("X-RateLimit-Remaining")).toBe(String(__limits.MAX_REQUESTS - 1));
  });

  test(
    "each of the first stalls waits, and the third opens it",
    async () => {
      h.cache.stalled = true;
      const app = buildApp();
      for (let i = 1; i <= STALLS_TO_OPEN; i++) {
        const { value: res, ms } = await timed(hit(app, edge(`203.0.113.${30 + i}`)));
        expect(res.status).toBe(200);
        expect(ms).toBeGreaterThanOrEqual(WAITED_MS);
        expect(isOpen()).toBe(i === STALLS_TO_OPEN);
      }
      expect(opened().length).toBe(1);
      expect(opened()[0]?.[1]).toMatchObject({ trigger: "stalls", coolDownMs: COOL_DOWN_MS });
    },
    SLOW_TEST_MS,
  );

  test(
    "stalls spread over more than a window do not open it",
    async () => {
      await stallAtOnce(STALLS_TO_OPEN - 1);
      expect(isOpen()).toBe(false);
      // The two old stalls fall out of the window as it ends: one more is not three.
      h.clock += STALL_WINDOW_MS;
      await stallAtOnce(1);
      expect(isOpen()).toBe(false);
      await stallAtOnce(1);
      expect(isOpen()).toBe(false);
      // Three inside one window are.
      await stallAtOnce(1);
      expect(isOpen()).toBe(true);
    },
    SLOW_TEST_MS,
  );

  test("a call that fails fast is not a stall", async () => {
    class FailsFast extends InMemoryCache {
      async match(): Promise<Response | undefined> {
        throw new Error("the cache refused");
      }
    }
    (globalThis as { caches?: unknown }).caches = { default: new FailsFast() };
    const app = buildApp();
    for (let i = 0; i < 10; i++) {
      const { value: res, ms } = await timed(hit(app, edge("203.0.113.40")));
      expect(res.status).toBe(200);
      expect(ms).toBeLessThan(NO_WAIT_MS);
    }
    expect(isOpen()).toBe(false);
    expect(__cacheBreakerForTests().stallsRemembered).toBe(0);
  });

  test("stalls met through different callers and buckets add up: a stall is the platform's", async () => {
    h.cache.stalled = true;
    const app = buildApp();
    await Promise.all([
      hit(app, edge("203.0.113.51")),
      hit(app, viaBinding("203.0.113.52"), "/datasets"),
      hit(app, edge("203.0.113.53"), "/auth/login"),
    ]);
    expect(isOpen()).toBe(true);
    // A caller none of them was, on a bucket none of them used, does not wait.
    const callsBefore = h.cache.calls;
    const { value: res, ms } = await timed(
      hit(app, edge("192.0.2.200"), "/data/nm000108/v1.0.0/x"),
    );
    expect(res.status).toBe(200);
    expect(ms).toBeLessThan(NO_WAIT_MS);
    expect(h.cache.calls).toBe(callsBefore);
  });

  test("however many callers stall, it remembers at most three stalls", async () => {
    // All of these are let through before any of them settles, so each reports a stall.
    await stallAtOnce(40, "198.18.0");
    expect(isOpen()).toBe(true);
    expect(__cacheBreakerForTests().stallsRemembered).toBe(STALLS_TO_OPEN);
    // And a probe that is answered still closes it.
    h.cache.stalled = false;
    h.clock += COOL_DOWN_MS;
    await hit(buildApp(), edge("198.18.0.1"));
    expect(isOpen()).toBe(false);
  });
});

describe("an open breaker", () => {
  test("serves a request at once, without calling the cache, and counts the skips in the fault line", async () => {
    await openByStalls();
    const callsBefore = h.cache.calls;
    const app = buildApp();
    for (let i = 0; i < 20; i++) {
      const { value: res, ms } = await timed(hit(app, edge("203.0.113.60")));
      expect(res.status).toBe(200);
      expect(ms).toBeLessThan(NO_WAIT_MS);
      // Nothing was counted, so nothing is claimed, exactly as after a stall.
      expect(res.headers.get("X-RateLimit-Remaining")).toBeNull();
    }
    expect(h.cache.calls).toBe(callsBefore);
    // One line opens the window and the 11th call speaks again with the ten it
    // swallowed: the skipped requests are counted without a line each.
    expect(skips("ip").map((c) => (c[1] as { suppressed: number }).suppressed)).toEqual([0, 9]);
  });

  test("never refuses and never counts: an exhausted bucket is let through, and is still exhausted after", async () => {
    const address = "203.0.113.61";
    await h.seed(`ip:${address}`, {
      count: __limits.MAX_REQUESTS,
      warned: false,
      windowEnd: h.clock + 50_000,
    });
    await openByStalls();
    const res = await hit(buildApp(), edge(address));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Bucket")).toBeNull();

    // Fail-open, not a reset: once the cache answers, the same bucket refuses again.
    h.cache.stalled = false;
    h.clock += COOL_DOWN_MS;
    const after = await hit(buildApp(), edge(address));
    expect(after.status).toBe(429);
    expect((await h.stored(`ip:${address}`))?.count).toBe(__limits.MAX_REQUESTS);
  });

  test("skips the admin-flag lookup and the miss budget as well", async () => {
    await openByStalls();
    const callsBefore = h.cache.calls;

    const token = { ...edge("203.0.113.62"), Authorization: `Bearer ${"a".repeat(48)}` };
    const { value: res, ms } = await timed(hit(buildApp(), token, "/admin/users"));
    expect(res.status).toBe(200);
    expect(ms).toBeLessThan(NO_WAIT_MS);
    expect(res.headers.get("X-RateLimit-Bucket")).toBeNull();
    const lookups = h.warn.mock.calls.filter(
      (c) => c[0] === "[rate-limit] admin-flag lookup failed",
    );
    expect(lookups[0]?.[1]).toMatchObject({ phase: "match", error: "CacheSkippedError" });

    const { value: outcome, ms: missMs } = await timed(missBudget("203.0.113.62"));
    expect(outcome.allowed).toBe(true);
    expect(missMs).toBeLessThan(NO_WAIT_MS);
    expect(skips("data-miss-ip").length).toBe(1);

    expect(h.cache.calls).toBe(callsBefore);
  });

  test("is opened by writes that stall, and then skips the writes too", async () => {
    // The lookup answers and only the write hangs: a request on a strict bucket waits
    // on its write until the breaker opens, and not after.
    h.cache.putsStall = true;
    const app = buildApp();
    await Promise.all(
      Array.from({ length: STALLS_TO_OPEN }, (_, i) =>
        hit(app, edge(`203.0.113.${63 + i}`), "/auth/login"),
      ),
    );
    expect(isOpen()).toBe(true);
    const { value: res, ms } = await timed(hit(app, edge("203.0.113.66"), "/auth/login"));
    expect(res.status).toBe(200);
    expect(ms).toBeLessThan(NO_WAIT_MS);
  });

  test("is opened by stalls in the miss budget too", async () => {
    h.cache.stalled = true;
    await Promise.all(
      Array.from({ length: STALLS_TO_OPEN }, (_, i) => missBudget(`203.0.113.${70 + i}`)),
    );
    expect(isOpen()).toBe(true);
    const { ms } = await timed(hit(buildApp(), edge("203.0.113.80")));
    expect(ms).toBeLessThan(NO_WAIT_MS);
  });
});

describe("every place the limiter calls the cache is behind the breaker", () => {
  // One test per call site: three stalls there, and nowhere else, open the breaker.
  // The lookups of the counter, the admin flag and the miss budget, and the counter's
  // write on a strict bucket, are covered above.

  test(
    "the data plane's counter write handed to waitUntil",
    async () => {
      h.cache.putsStall = true;
      const app = buildApp();
      const ctxs = Array.from({ length: STALLS_TO_OPEN }, () => collector());
      const answers = await Promise.all(
        ctxs.map((ctx, i) =>
          app.fetch(
            new Request("http://localhost/data/nm000108/v1.0.0/x", {
              headers: edge(`198.51.100.${i + 1}`),
            }),
            PROD_ENV,
            ctx.executionCtx,
          ),
        ),
      );
      // Answered at once: nothing waited on the write, so nothing has stalled yet.
      expect(answers.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(isOpen()).toBe(false);
      await Promise.all(ctxs.map((ctx) => ctx.settled()));
      expect(isOpen()).toBe(true);
    },
    SLOW_TEST_MS,
  );

  test(
    "the miss budget's write handed to waitUntil",
    async () => {
      h.cache.putsStall = true;
      const ctxs = Array.from({ length: STALLS_TO_OPEN }, () => collector());
      await Promise.all(ctxs.map((ctx, i) => missBudget(`198.51.100.${10 + i}`, ctx.waitUntil)));
      await Promise.all(ctxs.map((ctx) => ctx.settled()));
      expect(isOpen()).toBe(true);
    },
    SLOW_TEST_MS,
  );

  test(
    "the data plane's counter write with no execution context",
    async () => {
      h.cache.putsStall = true;
      const app = buildApp();
      await Promise.all(
        Array.from({ length: STALLS_TO_OPEN }, (_, i) =>
          hit(app, edge(`198.51.100.${20 + i}`), "/data/nm000108/v1.0.0/x"),
        ),
      );
      expect(isOpen()).toBe(true);
    },
    SLOW_TEST_MS,
  );

  test(
    "the miss budget's write with no execution context",
    async () => {
      h.cache.putsStall = true;
      await Promise.all(
        Array.from({ length: STALLS_TO_OPEN }, (_, i) => missBudget(`198.51.100.${60 + i}`)),
      );
      expect(isOpen()).toBe(true);
    },
    SLOW_TEST_MS,
  );

  test(
    "the read of a counter record's body",
    async () => {
      (globalThis as { caches?: unknown }).caches = { default: new HangingBody() };
      const app = buildApp();
      await Promise.all(
        Array.from({ length: STALLS_TO_OPEN }, (_, i) => hit(app, edge(`198.51.100.${30 + i}`))),
      );
      expect(isOpen()).toBe(true);
    },
    SLOW_TEST_MS,
  );

  test(
    "the read of an admin-flag record's body",
    async () => {
      const flagsOnly = new HangingBody((url) => url.includes("admin-flag"));
      (globalThis as { caches?: unknown }).caches = { default: flagsOnly };
      const app = buildApp();
      await Promise.all(
        Array.from({ length: STALLS_TO_OPEN }, (_, i) =>
          hit(
            app,
            { ...edge(`198.51.100.${40 + i}`), ...bearer(`flag-${i}-${"k".repeat(40)}`) },
            "/admin/users",
          ),
        ),
      );
      expect(isOpen()).toBe(true);
    },
    SLOW_TEST_MS,
  );

  test(
    "the write of an admin flag the database answered",
    async () => {
      const db = freshDb();
      db.run(
        `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access, sandbox_completed)
         VALUES ('breaker-admin', 'breaker-admin@example.org', 'x', 'approved', 'admin', 1, 1, 1)`,
      );
      const user = db
        .query<{ id: number }, []>("SELECT id FROM users WHERE username='breaker-admin'")
        .get();
      if (!user) throw new Error("seed failed");
      const adminKey = `breaker-admin-${"k".repeat(36)}`;
      db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
        user.id,
        await hashApiKey(adminKey),
        adminKey.slice(0, 8),
      );
      const withDb = { ...PROD_ENV, DB: realD1(db) } as Bindings;
      h.cache.putsStall = true;
      const app = buildApp();
      await Promise.all(
        Array.from({ length: STALLS_TO_OPEN }, (_, i) =>
          hit(
            app,
            { ...edge(`198.51.100.${50 + i}`), ...bearer(adminKey) },
            "/admin/users",
            withDb,
          ),
        ),
      );
      expect(isOpen()).toBe(true);
    },
    SLOW_TEST_MS,
  );
});

describe("the end of the cool-down", () => {
  test(
    "is not pushed away by a stall that settles after the breaker opened",
    async () => {
      h.cache.stalled = true;
      const app = buildApp();
      // Three calls open it at T0.
      const first = Array.from({ length: STALLS_TO_OPEN }, (_, i) =>
        hit(app, edge(`198.51.100.${70 + i}`)),
      );
      // A fourth is let through 300 ms in, while it is still closed, and so settles
      // 300 ms after it opened.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const late = hit(app, edge("198.51.100.79"));
      await Promise.all(first);
      expect(isOpen()).toBe(true);
      // Six seconds pass on the limiter's clock before the late stall settles.
      h.clock += 6_000;
      await late;
      // The cool-down still ends ten seconds after it opened, not after the late stall.
      h.cache.stalled = false;
      h.clock = T0 + COOL_DOWN_MS;
      const probe = await hit(app, edge("198.51.100.80"));
      expect(probe.headers.get("X-RateLimit-Remaining")).not.toBeNull();
      expect(isOpen()).toBe(false);
    },
    SLOW_TEST_MS,
  );

  test("is never further away than one cool-down, even when the clock goes backwards", async () => {
    await openByStalls();
    h.cache.stalled = false;
    // An hour back: the stored end of the cool-down is now an hour and ten seconds away.
    h.clock = T0 - 3_600_000;
    const res = await hit(buildApp(), edge("198.51.100.90"));
    expect(res.headers.get("X-RateLimit-Remaining")).not.toBeNull();
    expect(isOpen()).toBe(false);
  });
});

describe("the probe", () => {
  test(
    "that stalls reopens it and says so, as a probe, once the log line's window has turned",
    async () => {
      await openByStalls();
      // Past the cool-down, and past the window of the line that reported the opening,
      // so the next opening speaks instead of being counted as swallowed.
      h.clock = T0 + __limits.WINDOW_SIZE * 1000;
      const { ms } = await timed(hit(buildApp(), edge("203.0.113.130")));
      expect(ms).toBeGreaterThanOrEqual(WAITED_MS);
      expect(isOpen()).toBe(true);
      expect(opened().map((c) => (c[1] as { trigger: string }).trigger)).toEqual([
        "stalls",
        "probe",
      ]);
    },
    SLOW_TEST_MS,
  );

  test("after the cool-down one call is let through, and an answer closes the breaker", async () => {
    await openByStalls();
    const openedAt = h.clock;
    h.cache.stalled = false;
    const app = buildApp();
    const callsBefore = h.cache.calls;

    // Requests during the cool-down skip, and do not push its end away: traffic
    // alone cannot hold the breaker open.
    for (const offset of [1, 5_000, COOL_DOWN_MS - 1]) {
      h.clock = openedAt + offset;
      const res = await hit(app, edge("203.0.113.90"));
      expect(res.headers.get("X-RateLimit-Remaining")).toBeNull();
    }
    expect(h.cache.calls).toBe(callsBefore);
    expect(isOpen()).toBe(true);

    // At the end of the cool-down the next call is the probe; the cache answers.
    h.clock = openedAt + COOL_DOWN_MS;
    const probe = await hit(app, edge("203.0.113.90"));
    expect(probe.headers.get("X-RateLimit-Remaining")).toBe(String(__limits.MAX_REQUESTS - 1));
    expect(isOpen()).toBe(false);
    expect(closed().length).toBe(1);

    // And counting carries on as before.
    const next = await hit(app, edge("203.0.113.90"));
    expect(next.headers.get("X-RateLimit-Remaining")).toBe(String(__limits.MAX_REQUESTS - 2));
  });

  test(
    "a probe that stalls costs one bounded wait and keeps it open for another cool-down",
    async () => {
      await openByStalls();
      const openedAt = h.clock;
      const app = buildApp();

      h.clock = openedAt + COOL_DOWN_MS;
      const { ms: probeMs } = await timed(hit(app, edge("203.0.113.100")));
      expect(probeMs).toBeGreaterThanOrEqual(WAITED_MS);
      expect(probeMs).toBeLessThan(AT_MOST_MS);
      expect(isOpen()).toBe(true);

      // Skipping again at once, and until a cool-down after the probe.
      for (const at of [openedAt + COOL_DOWN_MS, openedAt + 2 * COOL_DOWN_MS - 1]) {
        h.clock = at;
        const { ms } = await timed(hit(app, edge("203.0.113.101")));
        expect(ms).toBeLessThan(NO_WAIT_MS);
      }

      h.cache.stalled = false;
      h.clock = openedAt + 2 * COOL_DOWN_MS;
      await hit(app, edge("203.0.113.102"));
      expect(isOpen()).toBe(false);
      // The re-opening is the same condition as the opening, and the line is rate limited.
      expect(opened().length).toBe(1);
    },
    SLOW_TEST_MS,
  );

  test(
    "while the probe is out, the calls behind it do not wait",
    async () => {
      await openByStalls();
      h.clock += COOL_DOWN_MS;
      const app = buildApp();
      const callsBefore = h.cache.calls;

      // The probe meets a cache that is still stalled.
      const probe = timed(hit(app, edge("203.0.113.110")));
      for (let i = 1; i <= 5; i++) {
        const { value: res, ms } = await timed(hit(app, edge(`203.0.113.${110 + i}`)));
        expect(res.status).toBe(200);
        expect(ms).toBeLessThan(NO_WAIT_MS);
      }
      // Only the probe reached the cache.
      expect(h.cache.calls).toBe(callsBefore + 1);
      const { ms: probeMs } = await probe;
      expect(probeMs).toBeGreaterThanOrEqual(WAITED_MS);
      expect(isOpen()).toBe(true);
    },
    SLOW_TEST_MS,
  );

  test(
    "a flapping cache does not wedge it open, and recovery forgets the stalls",
    async () => {
      const app = buildApp();
      for (let cycle = 0; cycle < 3; cycle++) {
        await openByStalls();
        h.cache.stalled = false;
        h.clock += COOL_DOWN_MS;
        const probe = await hit(app, edge("203.0.113.120"));
        expect(probe.headers.get("X-RateLimit-Remaining")).not.toBeNull();
        expect(isOpen()).toBe(false);

        // The stalls that opened it were forgotten when it closed: one more is one, not four.
        await stallAtOnce(1);
        expect(isOpen()).toBe(false);
        h.cache.stalled = false;
        const counted = await hit(app, edge("203.0.113.120"));
        expect(counted.headers.get("X-RateLimit-Remaining")).not.toBeNull();
      }
      // Three cycles inside one window: each transition logged once, not once a cycle.
      expect(opened().length).toBe(1);
      expect(closed().length).toBe(1);
    },
    SLOW_TEST_MS,
  );
});
