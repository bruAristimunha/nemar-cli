/**
 * The counter is a fixed window (#1709, ADR 0099).
 *
 * A bucket's window starts with the first request that finds none and ends 60
 * seconds later; an allowed request writes back with the time that remains, a
 * refusal writes nothing, and a block ends where the window does. A rate below the
 * cap per window is therefore never refused, whatever the rate.
 *
 * Driven through the real Hono app and the real limiter against the shared
 * in-memory Cache double, with one controllable clock that the limiter and the
 * cache both read (`Date.now`, held by a spy), so a window can be walked across
 * second by second. The clock is the only thing replaced.
 */

import { describe, expect, test } from "bun:test";
import {
  __limits,
  __readCounter,
  checkDataMissBudget,
  checkPrivateGrantBudget,
} from "../src/middleware/rateLimit";
import { hashApiKey } from "../src/services/token";
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

const WINDOW = __limits.WINDOW_SIZE;
const WINDOW_MS = WINDOW * 1000;
const ANON_CAP = __limits.MAX_REQUESTS;

const h = useRateLimitHarness();

/** Walk one client at a steady `rate` per second for `seconds` and count the outcomes. */
async function steady(
  app: ReturnType<typeof buildApp>,
  headers: Record<string, string>,
  rate: number,
  seconds: number,
): Promise<{ ok: number; refused: number }> {
  let ok = 0;
  let refused = 0;
  const step = 1000 / rate;
  const start = h.clock;
  for (let t = 0; t < seconds * 1000; t += step) {
    h.clock = start + t;
    const res = await hit(app, headers);
    if (res.status === 200) ok++;
    else if (res.status === 429) refused++;
    else throw new Error(`unexpected status ${res.status}`);
  }
  return { ok, refused };
}

// --------------------------------------------------------------------------
// The pure reading of a record
// --------------------------------------------------------------------------

describe("__readCounter", () => {
  const now = T0;

  test("no record is a new window that starts now", () => {
    expect(__readCounter(undefined, now)).toEqual({
      count: 0,
      warned: false,
      windowEnd: now + WINDOW_MS,
    });
  });

  test("a live window is read as written, and its end is not moved", () => {
    const end = now + 17_000;
    expect(__readCounter({ count: 40, warned: true, windowEnd: end }, now)).toEqual({
      count: 40,
      warned: true,
      windowEnd: end,
    });
  });

  test("a window that has ended is a new one, even if the cache still holds the record", () => {
    for (const end of [now, now - 1, now - 5 * WINDOW_MS]) {
      expect(__readCounter({ count: 999, warned: true, windowEnd: end }, now)).toEqual({
        count: 0,
        warned: false,
        windowEnd: now + WINDOW_MS,
      });
    }
  });

  test("a record from before windows were stored keeps its count and gets a full window as its bound", () => {
    expect(__readCounter({ count: 7, warned: true }, now)).toEqual({
      count: 7,
      warned: true,
      windowEnd: now + WINDOW_MS,
    });
    expect(__readCounter({ count: 7 }, now)).toEqual({
      count: 7,
      warned: false,
      windowEnd: now + WINDOW_MS,
    });
  });

  test("an end more than a window away is cut to one window", () => {
    const state = __readCounter({ count: 1, windowEnd: now + 10 * 86_400_000 }, now);
    expect(state.windowEnd).toBe(now + WINDOW_MS);
  });

  test("damaged values cannot wedge a bucket, and are reported as damage", () => {
    const read = (record: unknown) => __readCounter(record, now);
    // A count that is not a whole number at or above zero.
    expect(read({ count: "lots", windowEnd: now + 1000 })).toMatchObject({
      count: 0,
      damage: "bad-count",
    });
    expect(read({ count: -5, windowEnd: now + 1000 })).toMatchObject({
      count: 0,
      damage: "bad-count",
    });
    expect(read({ count: 3.9, windowEnd: now + 1000 })).toMatchObject({
      count: 3,
      damage: "bad-count",
    });
    expect(read({ windowEnd: now + 1000 })).toMatchObject({ count: 0, damage: "bad-count" });
    expect(read({ count: Number.POSITIVE_INFINITY, windowEnd: now + 1000 })).toMatchObject({
      count: 0,
      damage: "bad-count",
    });
    // An end that is not a number, or lies well past one window.
    expect(read({ count: 3, windowEnd: "soon" })).toMatchObject({
      windowEnd: now + WINDOW_MS,
      damage: "bad-end",
    });
    expect(read({ count: 3, windowEnd: null })).toMatchObject({
      windowEnd: now + WINDOW_MS,
      damage: "bad-end",
    });
    expect(read({ count: 3, windowEnd: now + 10 * 86_400_000 })).toMatchObject({
      windowEnd: now + WINDOW_MS,
      damage: "bad-end",
    });
    // Anything that is not a record.
    for (const junk of [null, 5, "text", true, [1, 2]]) {
      expect(read(junk)).toEqual({
        count: 0,
        warned: false,
        windowEnd: now + WINDOW_MS,
        damage: "unparseable",
      });
    }
  });

  test("what is normal is not damage", () => {
    const read = (record: unknown) => __readCounter(record, now);
    expect(read(undefined).damage).toBeUndefined();
    expect(read({ count: 7, warned: false }).damage).toBeUndefined();
    expect(read({ count: 0, warned: false, windowEnd: now + 1000 }).damage).toBeUndefined();
    // An ended window, however stale, is simply over.
    expect(read({ count: 9, windowEnd: now - 1 }).damage).toBeUndefined();
    expect(read({ count: "lots", windowEnd: now - 1 }).damage).toBeUndefined();
    // The few seconds two isolates' clocks may differ by are cut, not reported.
    expect(read({ count: 1, windowEnd: now + WINDOW_MS + 1 })).toMatchObject({
      windowEnd: now + WINDOW_MS,
    });
    expect(read({ count: 1, windowEnd: now + WINDOW_MS + 1 }).damage).toBeUndefined();
    expect(read({ count: 1, windowEnd: now + WINDOW_MS + 5000 }).damage).toBeUndefined();
    expect(read({ count: 1, windowEnd: now + WINDOW_MS + 5001 }).damage).toBe("bad-end");
  });
});

// --------------------------------------------------------------------------
// The behavior #1709 was about
// --------------------------------------------------------------------------

describe("a steady rate below the cap is never refused", () => {
  test.each([
    [5, "the production pool's measured 5 a second"],
    [8, "the production pool's measured 8 a second"],
    [10, "ten a second, 600 a window"],
  ])("%d requests a second for 30 minutes", async (rate) => {
    const result = await steady(buildApp(), edge("203.0.113.1"), rate, 1800);
    expect(result.refused).toBe(0);
    expect(result.ok).toBe(rate * 1800);
  });

  test("the same rates against the website's per-visitor bucket", async () => {
    const result = await steady(buildApp(), { "X-Forwarded-For": "203.0.113.2" }, 10, 1800);
    expect(result.refused).toBe(0);
  });
});

describe("a rate above the cap is refused exactly the excess a fixed window must refuse", () => {
  test("25 a second against the cap of 1000 is refused one request in three", async () => {
    // 25 a second is 1500 a window, 1000 of them admitted and 500 refused, in
    // every window: 1 - cap / (rate * 60).
    const result = await steady(buildApp(), edge("203.0.113.3"), 25, 1800);
    const total = result.ok + result.refused;
    expect(total).toBe(25 * 1800);
    expect(result.ok).toBe(30 * ANON_CAP);
    expect(result.refused / total).toBeCloseTo(1 - ANON_CAP / (25 * WINDOW), 6);
  });

  test("the strict bucket, at half a request a second, is refused two in three", async () => {
    // 30 a window against a cap of 10: 20 refused.
    const app = buildApp();
    let ok = 0;
    let refused = 0;
    for (let t = 0; t < 1800 * 1000; t += 2000) {
      h.clock = T0 + t;
      const res = await hit(app, edge("203.0.113.4"), "/auth/login");
      if (res.status === 200) ok++;
      else refused++;
    }
    expect(ok).toBe(30 * __limits.AUTH_MAX_REQUESTS);
    expect(refused).toBe(30 * (30 - __limits.AUTH_MAX_REQUESTS));
  });
});

describe("a burst at the cap is refused for the rest of its window only", () => {
  test("it is admitted again at the boundary, not a second sooner or later", async () => {
    const app = buildApp();
    const headers = edge("203.0.113.5");
    for (let i = 0; i < ANON_CAP; i++) {
      expect((await hit(app, headers)).status).toBe(200);
    }

    const second = (n: number) => T0 + n * 1000;
    const refusedAt = async (at: number) => {
      h.clock = at;
      return hit(app, headers);
    };

    let res = await refusedAt(second(0));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");

    res = await refusedAt(second(30));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");

    res = await refusedAt(second(60) - 1);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("1");

    res = await refusedAt(second(60));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Remaining")).toBe(String(ANON_CAP - 1));
  });

  test("hammering during the block does not extend it", async () => {
    const app = buildApp();
    const headers = edge("203.0.113.6");
    for (let i = 0; i < ANON_CAP; i++) await hit(app, headers);
    // A request every 50 ms for the whole window, every one of them refused...
    for (let t = 50; t < WINDOW_MS; t += 50) {
      h.clock = T0 + t;
      expect((await hit(app, headers)).status).toBe(429);
    }
    // ...and the first at the boundary is admitted all the same.
    h.clock = T0 + WINDOW_MS;
    expect((await hit(app, headers)).status).toBe(200);
  });

  test("the next window is a full one of its own", async () => {
    const app = buildApp();
    const headers = edge("203.0.113.7");
    for (let i = 0; i < ANON_CAP; i++) await hit(app, headers);
    h.clock = T0 + WINDOW_MS;
    let ok = 0;
    for (let i = 0; i < ANON_CAP + 5; i++) {
      if ((await hit(app, headers)).status === 200) ok++;
    }
    expect(ok).toBe(ANON_CAP);
    // It began at T0 + 60 s, so it ends at T0 + 120 s.
    const res = await hit(app, headers);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("X-RateLimit-Reset"))).toBe((T0 + 2 * WINDOW_MS) / 1000);
  });

  test("requests inside a window never move its end", async () => {
    const app = buildApp();
    const headers = edge("203.0.113.8");
    await hit(app, headers);
    const first = await h.stored("ip:203.0.113.8");
    h.clock = T0 + 40_000;
    await hit(app, headers);
    const second = await h.stored("ip:203.0.113.8");
    expect(first?.windowEnd).toBe(T0 + WINDOW_MS);
    expect(second?.windowEnd).toBe(T0 + WINDOW_MS);
    expect(second?.count).toBe(2);
  });
});

describe("Retry-After and X-RateLimit-Reset agree with the window", () => {
  test("both name the window's end, and waiting Retry-After seconds is enough", async () => {
    const app = buildApp();
    const headers = edge("203.0.113.9");
    for (let i = 0; i < ANON_CAP; i++) await hit(app, headers);

    h.clock = T0 + 12_300;
    const res = await hit(app, headers);
    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get("Retry-After"));
    const reset = Number(res.headers.get("X-RateLimit-Reset"));
    const body = (await res.json()) as { retry_after: number; message: string };

    expect(reset).toBe((T0 + WINDOW_MS) / 1000);
    expect(retryAfter).toBe(Math.ceil((reset * 1000 - h.clock) / 1000));
    expect(retryAfter).toBe(48);
    expect(body.retry_after).toBe(retryAfter);
    expect(body.message).toContain(`${retryAfter} seconds`);
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(ANON_CAP));
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("ip");

    // Never undershoots: a client that waits exactly Retry-After is let in.
    h.clock += retryAfter * 1000;
    expect((await hit(app, headers)).status).toBe(200);
  });

  test("Retry-After is never zero and never more than a window", async () => {
    const app = buildApp();
    const headers = edge("203.0.113.10");
    for (let i = 0; i < ANON_CAP; i++) await hit(app, headers);
    for (const at of [0, 1, 999, 30_000, WINDOW_MS - 1]) {
      h.clock = T0 + at;
      const res = await hit(app, headers);
      const retryAfter = Number(res.headers.get("Retry-After"));
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(WINDOW);
    }
  });

  test("the cache entry expires with the window, not a full window after the last request", async () => {
    const app = buildApp();
    const headers = edge("203.0.113.11");
    await hit(app, headers);
    h.clock = T0 + 50_000;
    await hit(app, headers);
    // 10 seconds remain. The record was written with max-age=10, so at T0 + 61 s
    // the cache itself has dropped it, with no help from the limiter.
    h.clock = T0 + 61_000;
    expect(await h.stored("ip:203.0.113.11")).toBeUndefined();
  });
});

describe("a window that starts mid-second", () => {
  test("X-RateLimit-Reset rounds UP, and waiting until it is enough", async () => {
    const app = buildApp();
    const headers = edge("203.0.113.60");
    h.clock = T0 + 250; // the window ends at T0 + 60_250
    for (let i = 0; i < __limits.AUTH_MAX_REQUESTS; i++) await hit(app, headers, "/auth/login");
    h.clock = T0 + 10_000;
    const over = await hit(app, headers, "/auth/login");
    expect(over.status).toBe(429);
    const reset = Number(over.headers.get("X-RateLimit-Reset"));
    // 60.25 seconds after T0 is T0/1000 + 61 whole seconds, not 60.
    expect(reset).toBe(T0 / 1000 + 61);
    expect(over.headers.get("Retry-After")).toBe("51");
    // A client that waits until the advertised Reset is let in...
    h.clock = reset * 1000;
    expect((await hit(app, headers, "/auth/login")).status).toBe(200);
  });

  test("and one that retries a second early is not", async () => {
    const app = buildApp();
    const headers = edge("203.0.113.61");
    h.clock = T0 + 250;
    for (let i = 0; i < __limits.AUTH_MAX_REQUESTS; i++) await hit(app, headers, "/auth/login");
    h.clock = T0 + 60_249;
    expect((await hit(app, headers, "/auth/login")).status).toBe(429);
    h.clock = T0 + 60_250;
    expect((await hit(app, headers, "/auth/login")).status).toBe(200);
  });
});

describe("the price of a fixed window: up to twice the cap across a boundary", () => {
  // ADR 0099 accepts this, and this test is where the acceptance is pinned: a full
  // cap at the end of one window and a full cap at the start of the next are both
  // admitted, and nothing beyond them is.
  test("2 x cap - 1 requests are admitted in the second around the boundary, and no more", async () => {
    const app = buildApp();
    const headers = edge("203.0.113.62");
    await hit(app, headers); // opens the window at T0
    h.clock = T0 + WINDOW_MS - 1000;
    let admitted = 0;
    for (let i = 0; i < ANON_CAP + 5; i++) {
      if ((await hit(app, headers)).status === 200) admitted++;
    }
    expect(admitted).toBe(ANON_CAP - 1); // the cap, counting the one that opened the window
    h.clock = T0 + WINDOW_MS;
    for (let i = 0; i < ANON_CAP + 5; i++) {
      if ((await hit(app, headers)).status === 200) admitted++;
    }
    expect(admitted).toBe(2 * ANON_CAP - 1);
    expect((await hit(app, headers)).status).toBe(429);
  });
});

describe("concurrent requests", () => {
  // The counter is a read, then a write, against a cache with no atomic increment, so
  // requests in flight together can each read the same count and each write the same
  // next one: the cap can be overrun by the concurrency, never by more than that.
  // What must hold is that every request is answered and the record stays whole.
  test("eleven at once on the strict bucket are all answered and leave a well-formed record", async () => {
    const app = buildApp();
    const headers = viaBinding("203.0.113.63");
    const answers = await Promise.all(
      Array.from({ length: __limits.AUTH_MAX_REQUESTS + 1 }, () =>
        hit(app, headers, "/auth/login"),
      ),
    );
    for (const res of answers) expect([200, 429]).toContain(res.status);
    const record = await h.stored("auth-ip:site:203.0.113.63");
    expect(Number.isInteger(record?.count)).toBe(true);
    expect(record?.count as number).toBeGreaterThanOrEqual(1);
    expect(record?.count as number).toBeLessThanOrEqual(__limits.AUTH_MAX_REQUESTS + 1);
    expect(record?.windowEnd).toBe(T0 + WINDOW_MS);
  });
});

describe("the clock is read after the cache answers", () => {
  // A Worker's clock only moves at I/O. A cache whose lookup takes two seconds is
  // the way to see which side of it the limiter reads: before the lookup, a record
  // that ends in one second still looks live; after, it has ended.
  test("a window that ends during the lookup is a new window", async () => {
    class SlowMatch extends InMemoryCache {
      async match(request: RequestInfo | URL): Promise<Response | undefined> {
        const found = await super.match(request);
        h.clock += 2000;
        return found;
      }
    }
    const slow = new SlowMatch();
    (globalThis as { caches?: unknown }).caches = { default: slow };
    await slow.put(
      new Request("https://rate-limit.internal/rl:ip:203.0.113.64"),
      new Response(JSON.stringify({ count: ANON_CAP, warned: false, windowEnd: T0 + 1000 }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "max-age=3600" },
      }),
    );
    const res = await hit(buildApp(), edge("203.0.113.64"));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Remaining")).toBe(String(ANON_CAP - 1));
  });
});

describe("a record written before windows were stored is read safely", () => {
  test("below the cap it is counted on and given a window of its own", async () => {
    await h.seed("ip:203.0.113.20", { count: ANON_CAP - 1, warned: false });
    const app = buildApp();
    const last = await hit(app, edge("203.0.113.20"));
    expect(last.status).toBe(200);
    expect(last.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect((await h.stored("ip:203.0.113.20"))?.windowEnd).toBe(T0 + WINDOW_MS);
    const over = await hit(app, edge("203.0.113.20"));
    expect(over.status).toBe(429);
  });

  test("at the cap it refuses with a window as the bound, and is gone once its entry is", async () => {
    await h.seed("ip:203.0.113.21", { count: ANON_CAP, warned: false });
    const app = buildApp();
    const res = await hit(app, edge("203.0.113.21"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("X-RateLimit-Reset")).toBe(String((T0 + WINDOW_MS) / 1000));

    // Refusals write nothing, so the old entry runs out on its own TTL.
    h.clock = T0 + WINDOW_MS + 1000;
    const after = await hit(app, edge("203.0.113.21"));
    expect(after.status).toBe(200);
    expect(after.headers.get("X-RateLimit-Remaining")).toBe(String(ANON_CAP - 1));
  });

  test("a count-only record, as the budgets used to write, behaves the same", async () => {
    await h.seed("ip:203.0.113.22", { count: ANON_CAP });
    expect((await hit(buildApp(), edge("203.0.113.22"))).status).toBe(429);
  });
});

describe("a damaged or stale record does not wedge a bucket", () => {
  test("an end far in the future holds the bucket for one window at most", async () => {
    await h.seed("ip:203.0.113.30", { count: ANON_CAP, windowEnd: T0 + 10 * 86_400_000 });
    const app = buildApp();
    const res = await hit(app, edge("203.0.113.30"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    h.clock = T0 + WINDOW_MS + 1000;
    expect((await hit(app, edge("203.0.113.30"))).status).toBe(200);
  });

  test("a window that has ended but whose entry the cache still holds is a new window", async () => {
    await h.seed("ip:203.0.113.31", { count: ANON_CAP, warned: false, windowEnd: T0 - 1 }, 3600);
    const res = await hit(buildApp(), edge("203.0.113.31"));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Remaining")).toBe(String(ANON_CAP - 1));
    expect((await h.stored("ip:203.0.113.31"))?.windowEnd).toBe(T0 + WINDOW_MS);
  });

  test("a body that is not JSON is replaced, not trusted and not failed open on", async () => {
    await h.seed("ip:203.0.113.32", "this is not json", 3600);
    const app = buildApp();
    const first = await hit(app, edge("203.0.113.32"));
    expect(first.status).toBe(200);
    expect(first.headers.get("X-RateLimit-Remaining")).toBe(String(ANON_CAP - 1));
    expect((await h.stored("ip:203.0.113.32"))?.count).toBe(1);
  });

  test("every repair is logged once per window per bucket and kind of damage, without the record", async () => {
    const app = buildApp();
    const damaged = () =>
      h.warn.mock.calls.filter((c) => c[0] === "[rate-limit] repaired a damaged counter record");
    // Three buckets, each with a different kind of damage.
    await h.seed("ip:203.0.113.33", "this is not json", 3600);
    await h.seed("site-ip:site:203.0.113.34", { count: "lots", windowEnd: T0 + 30_000 }, 3600);
    await h.seed("auth-ip:203.0.113.35", { count: 2, windowEnd: "soon" }, 3600);
    await hit(app, edge("203.0.113.33"));
    await hit(app, { "X-Forwarded-For": "203.0.113.34" });
    await hit(app, edge("203.0.113.35"), "/auth/login");
    expect(damaged().map((c) => c[1])).toEqual([
      { keyKind: "ip", damage: "unparseable", suppressed: 0 },
      { keyKind: "site-ip", damage: "bad-count", suppressed: 0 },
      { keyKind: "auth-ip", damage: "bad-end", suppressed: 0 },
    ]);
    // The repair wrote a good record, so the same buckets are quiet from here on.
    await hit(app, edge("203.0.113.33"));
    expect(damaged().length).toBe(3);
    // Nothing in the lines quotes a record or an address.
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain("this is not json");
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain("203.0.113.3");
  });

  test("a bucket repaired again later in the window is counted, not repeated", async () => {
    const app = buildApp();
    const damaged = () =>
      h.warn.mock.calls.filter((c) => c[0] === "[rate-limit] repaired a damaged counter record");
    for (let i = 0; i < 4; i++) {
      await h.seed("ip:203.0.113.36", "garbage", 3600);
      await hit(app, edge("203.0.113.36"));
    }
    expect(damaged().length).toBe(1);
    h.clock = T0 + WINDOW_MS;
    await h.seed("ip:203.0.113.36", "garbage", 3600);
    await hit(app, edge("203.0.113.36"));
    expect(damaged().length).toBe(2);
    expect(damaged()[1]?.[1]).toMatchObject({ suppressed: 3 });
  });
});

// --------------------------------------------------------------------------
// One code path for every counter
// --------------------------------------------------------------------------

describe("every bucket kind keeps its window's end and ends its block there", () => {
  const BEARER = "b".repeat(48);
  const cases: Array<{
    kind: string;
    key: () => Promise<string>;
    cap: number;
    path: string;
    headers: Record<string, string>;
  }> = [
    {
      kind: "ip",
      key: async () => "ip:203.0.113.40",
      cap: __limits.MAX_REQUESTS,
      path: "/datasets",
      headers: edge("203.0.113.40"),
    },
    {
      kind: "site-ip",
      key: async () => "site-ip:site:203.0.113.41",
      cap: __limits.SITE_IP_MAX_REQUESTS,
      path: "/datasets",
      headers: { "X-Forwarded-For": "203.0.113.41" },
    },
    {
      kind: "site-unattributed",
      key: async () => "site-unattributed:unattributed",
      cap: __limits.SITE_UNATTRIBUTED_MAX_REQUESTS,
      path: "/datasets",
      headers: {},
    },
    {
      kind: "auth-ip",
      key: async () => "auth-ip:203.0.113.42",
      cap: __limits.AUTH_MAX_REQUESTS,
      path: "/auth/login",
      headers: edge("203.0.113.42"),
    },
    {
      kind: "token",
      key: async () => `token:${await hashApiKey(BEARER)}`,
      cap: __limits.TOKEN_MAX_REQUESTS_AUTHED,
      path: "/admin/users",
      headers: { ...edge("203.0.113.43"), Authorization: `Bearer ${BEARER}` },
    },
    {
      kind: "neurobagel-ip",
      key: async () => "neurobagel-ip:203.0.113.44",
      cap: __limits.NEUROBAGEL_MAX_REQUESTS,
      path: "/neurobagel/index.json",
      headers: edge("203.0.113.44"),
    },
    {
      kind: "data-ip",
      key: async () => "data-ip:203.0.113.45",
      cap: __limits.DATA_MAX_REQUESTS,
      path: "/data/nm000108/v1.0.0/x",
      headers: edge("203.0.113.45"),
    },
  ];

  test.each(cases)("$kind (cap $cap)", async ({ kind, key, cap, path, headers }) => {
    // Thirty seconds into a window, three requests from the cap.
    const k = await key();
    await h.seed(k, { count: cap - 3, warned: false, windowEnd: T0 + 30_000 }, 30);
    const app = buildApp();

    for (let left = 2; left >= 0; left--) {
      const res = await hit(app, headers, path);
      expect(res.status).toBe(200);
      expect(res.headers.get("X-RateLimit-Bucket")).toBe(kind);
      expect(res.headers.get("X-RateLimit-Remaining")).toBe(String(left));
    }
    // Writing back kept the end where it was.
    expect((await h.stored(k))?.windowEnd).toBe(T0 + 30_000);

    const over = await hit(app, headers, path);
    expect(over.status).toBe(429);
    expect(over.headers.get("X-RateLimit-Bucket")).toBe(kind);
    expect(over.headers.get("Retry-After")).toBe("30");
    expect(over.headers.get("X-RateLimit-Reset")).toBe(String((T0 + 30_000) / 1000));

    h.clock = T0 + 29_999;
    expect((await hit(app, headers, path)).status).toBe(429);
    h.clock = T0 + 30_000;
    const fresh = await hit(app, headers, path);
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("X-RateLimit-Remaining")).toBe(String(cap - 1));
    expect((await h.stored(k))?.windowEnd).toBe(T0 + 30_000 + WINDOW_MS);
  });

  test("the miss budget of the data plane", async () => {
    const env = { ENVIRONMENT: "production" } as Pick<
      Bindings,
      "ENVIRONMENT" | "TEST_BYPASS_TOKEN"
    >;
    const ask = () =>
      checkDataMissBudget(
        env,
        new Request("http://localhost/data/x", { headers: edge("203.0.113.46") }),
        undefined,
      );
    const cap = __limits.DATA_MISS_MAX_REQUESTS;
    await h.seed("data-miss-ip:203.0.113.46", { count: cap - 1, windowEnd: T0 + 20_000 }, 20);
    expect((await ask()).allowed).toBe(true);
    const refused = await ask();
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) {
      expect(refused.response.headers.get("Retry-After")).toBe("20");
      expect(refused.response.headers.get("X-RateLimit-Reset")).toBe(String((T0 + 20_000) / 1000));
      expect(refused.response.headers.get("X-RateLimit-Bucket")).toBe("data-miss-ip");
    }
    h.clock = T0 + 20_000;
    expect((await ask()).allowed).toBe(true);
  });

  test("the private-grant budget, per account", async () => {
    const env = { ENVIRONMENT: "production" } as Pick<
      Bindings,
      "ENVIRONMENT" | "TEST_BYPASS_TOKEN"
    >;
    const ask = () =>
      checkPrivateGrantBudget(env, new Request("http://localhost/x"), 77, undefined);
    for (let i = 0; i < __limits.PRIVATE_GRANT_MAX_REQUESTS; i++) {
      expect((await ask()).allowed).toBe(true);
    }
    h.clock = T0 + 45_000;
    const refused = await ask();
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) {
      expect(refused.response.headers.get("Retry-After")).toBe("15");
    }
    h.clock = T0 + WINDOW_MS;
    expect((await ask()).allowed).toBe(true);
  });
});

describe("observe-only counting follows the same window", () => {
  test("the one warning per window resets at the boundary, with the count", async () => {
    const observe = (text: string) =>
      h.warn.mock.calls.filter((c) => String(c[0]).includes(text)).length;
    const app = buildApp({ observeOnly: true });
    const headers = edge("203.0.113.50");
    await h.seed("ip:203.0.113.50", { count: ANON_CAP, warned: false, windowEnd: T0 + 20_000 }, 20);

    // Observe-only never refuses.
    expect((await hit(app, headers)).status).toBe(200);
    expect((await hit(app, headers)).status).toBe(200);
    expect(observe("observe-only bucket would have tripped")).toBe(1);
    expect((await h.stored("ip:203.0.113.50"))?.windowEnd).toBe(T0 + 20_000);

    // The window ends: the count and the warning start over.
    h.clock = T0 + 20_000;
    expect((await hit(app, headers)).status).toBe(200);
    expect((await h.stored("ip:203.0.113.50"))?.count).toBe(1);
    expect((await h.stored("ip:203.0.113.50"))?.warned).toBe(false);
  });
});
