/**
 * Who a request's address names, for the rate limiter (#1709, ADR 0098).
 *
 * The website calls this Worker through a service binding, which carries no
 * `CF-Connecting-IP`, and forwards its visitor in `X-Forwarded-For`. The
 * limiter counts such a request per forwarded visitor in its own bucket
 * (`site-ip`) and never lets `X-Forwarded-For` choose the bucket of a request
 * that has `CF-Connecting-IP`.
 *
 * Driven through the real Hono app and the real limiter, against the same
 * working in-memory Cache double every other limiter suite uses. What this file
 * cannot show is whether Cloudflare's service bindings really omit
 * `CF-Connecting-IP`; `site-binding-identity.test.ts` asks real workerd, and the
 * ADR says what remains for production.
 */

import { describe, expect, test } from "bun:test";
import {
  __firstForwardedIp,
  __limits,
  __readCallerIdentity,
  __resetIdentityLogForTests,
  __selectBucket,
  checkDataMissBudget,
} from "../src/middleware/rateLimit";
import type { Bindings } from "../src/types/bindings";
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

const A = "203.0.113.10";
const B = "203.0.113.11";
const CAP = __limits.SITE_IP_MAX_REQUESTS;

// --------------------------------------------------------------------------
// Reading an address
// --------------------------------------------------------------------------

describe("__firstForwardedIp", () => {
  test.each([
    ["203.0.113.7", "203.0.113.7"],
    ["  203.0.113.7  ", "203.0.113.7"],
    ["0.0.0.0", "0.0.0.0"],
    ["255.255.255.255", "255.255.255.255"],
    ["2001:db8::1", "2001:db8::1"],
    // The URL parser compresses and lowercases, so one visitor is one key.
    ["2001:DB8:0:0:0:0:0:1", "2001:db8::1"],
    ["::1", "::1"],
    ["::ffff:203.0.113.7", "::ffff:cb00:7107"],
    // Only the first entry counts, however many follow.
    ["203.0.113.7, 10.0.0.1, 10.0.0.2", "203.0.113.7"],
    ["203.0.113.7,10.0.0.1", "203.0.113.7"],
  ])("%j reads as %j", (header, expected) => {
    expect(__firstForwardedIp(header)).toBe(expected);
  });

  test.each([
    [undefined],
    [null],
    [""],
    ["   "],
    ["unknown"],
    ["not-an-ip"],
    ["example.com"],
    ["203.0.113"],
    ["203.0.113.256"],
    ["203.0.113.007"],
    ["203.0.113.7:8080"],
    ["[2001:db8::1]"],
    ["[2001:db8::1]:443"],
    ["fe80::1%eth0"],
    ["2001:db8::g"],
    ["2001:db8:::1"],
    ["1:2:3:4:5:6:7:8:9"],
    ["203.0.113.7\n10.0.0.1"],
    ["203.0.113.7;x"],
    // The FIRST entry decides: an unreadable one is not skipped to reach a later one.
    ["unknown, 203.0.113.7"],
    [", 203.0.113.7"],
  ])("%j is not an address", (header) => {
    expect(__firstForwardedIp(header)).toBeNull();
  });

  test("a header or an address over its length bound is not read", () => {
    expect(__firstForwardedIp(`203.0.113.7, ${"1.1.1.1, ".repeat(100)}`)).toBeNull();
    expect(__firstForwardedIp("a".repeat(600))).toBeNull();
    expect(__firstForwardedIp(`${"0".repeat(60)}:1`)).toBeNull();
  });
});

describe("__readCallerIdentity", () => {
  test("CF-Connecting-IP decides, and X-Forwarded-For is then never read", () => {
    expect(__readCallerIdentity("198.51.100.1", "203.0.113.7")).toEqual({
      source: "edge",
      key: "198.51.100.1",
    });
    expect(__readCallerIdentity("198.51.100.1", "garbage")).toEqual({
      source: "edge",
      key: "198.51.100.1",
    });
    expect(__readCallerIdentity("198.51.100.1", undefined)).toEqual({
      source: "edge",
      key: "198.51.100.1",
    });
  });

  test("without CF-Connecting-IP a valid first forwarded address is a site caller in its own keyspace", () => {
    expect(__readCallerIdentity(undefined, "203.0.113.7, 10.0.0.1")).toEqual({
      source: "site",
      key: "site:203.0.113.7",
    });
    expect(__readCallerIdentity(null, "2001:DB8::1")).toEqual({
      source: "site",
      key: "site:2001:db8::1",
    });
    // An empty header is an absent one, as it always was.
    expect(__readCallerIdentity("", "203.0.113.7").source).toBe("site");
  });

  test("with neither, or with an unreadable forward, the caller is unattributed", () => {
    for (const forwarded of [undefined, null, "", "unknown", "203.0.113.7:80", "a".repeat(600)]) {
      expect(__readCallerIdentity(undefined, forwarded)).toEqual({
        source: "unattributed",
        key: "unattributed",
      });
    }
  });

  test("a site key can never equal an address", () => {
    // The prefix starts with a letter that is not a hex digit, so no IPv4 or IPv6
    // literal an edge caller can present starts with it.
    expect(__readCallerIdentity(undefined, A).key.startsWith("s")).toBe(true);
    expect("site:".match(/^[0-9a-fA-F:.]+$/)).toBeNull();
  });
});

// --------------------------------------------------------------------------
// Bucket selection
// --------------------------------------------------------------------------

describe("__selectBucket by caller source", () => {
  test("the default source is edge, so every existing caller is unchanged", () => {
    const sel = __selectBucket("/datasets", undefined, "10.0.0.1");
    expect(sel).toEqual({ keyKind: "ip", rawKey: "10.0.0.1", maxRequests: __limits.MAX_REQUESTS });
  });

  test("a site caller on an anonymous path is counted in site-ip", () => {
    const sel = __selectBucket("/datasets", undefined, "site:203.0.113.7", "site");
    expect(sel).toEqual({
      keyKind: "site-ip",
      rawKey: "site:203.0.113.7",
      maxRequests: __limits.SITE_IP_MAX_REQUESTS,
    });
  });

  test("an unattributed caller on an anonymous path is counted in the shared bucket", () => {
    const sel = __selectBucket("/datasets", undefined, "unattributed", "unattributed");
    expect(sel).toEqual({
      keyKind: "site-unattributed",
      rawKey: "unattributed",
      maxRequests: __limits.SITE_UNATTRIBUTED_MAX_REQUESTS,
    });
  });

  test("the strict, data and Neurobagel buckets keep their kind and cap for every source", () => {
    const cases: Array<[string, string, number]> = [
      ["/auth/login", "auth-ip", __limits.AUTH_MAX_REQUESTS],
      ["/nemar/auth/code/request", "auth-ip", __limits.AUTH_MAX_REQUESTS],
      ["/data/nm000108/v1.0.0/x", "data-ip", __limits.DATA_MAX_REQUESTS],
      ["/nm000132/zarr/index.json", "data-ip", __limits.DATA_MAX_REQUESTS],
      ["/neurobagel/index.json", "neurobagel-ip", __limits.NEUROBAGEL_MAX_REQUESTS],
    ];
    for (const [path, keyKind, maxRequests] of cases) {
      const site = __selectBucket(path, undefined, "site:203.0.113.7", "site");
      expect(site).toEqual({ keyKind, rawKey: "site:203.0.113.7", maxRequests });
      const none = __selectBucket(path, undefined, "unattributed", "unattributed");
      expect(none).toEqual({ keyKind, rawKey: "unattributed", maxRequests });
    }
  });

  test("a bearer still selects the token bucket whatever the source", () => {
    const sel = __selectBucket(
      "/admin/users",
      `Bearer ${"a".repeat(48)}`,
      "site:203.0.113.7",
      "site",
    );
    expect(sel.keyKind).toBe("token");
    expect(sel.maxRequests).toBe(__limits.TOKEN_MAX_REQUESTS_AUTHED);
  });
});

describe("the caps", () => {
  test("a visitor through the website is never treated more strictly than a public caller", () => {
    expect(__limits.SITE_IP_MAX_REQUESTS).toBeGreaterThanOrEqual(__limits.MAX_REQUESTS);
  });

  test("the shared bucket for unattributed callers is above any one visitor's", () => {
    expect(__limits.SITE_UNATTRIBUTED_MAX_REQUESTS).toBeGreaterThan(__limits.SITE_IP_MAX_REQUESTS);
  });
});

// --------------------------------------------------------------------------
// End to end
// --------------------------------------------------------------------------

describe("a public request cannot choose its bucket with X-Forwarded-For", () => {
  test("it lands in ip, keyed by CF-Connecting-IP, whatever it forwards", async () => {
    const app = buildApp();
    const remaining: number[] = [];
    for (const forged of [B, "198.51.100.77", "unknown", "1.1.1.1, 2.2.2.2"]) {
      const res = await hit(app, { "CF-Connecting-IP": A, "X-Forwarded-For": forged });
      expect(res.status).toBe(200);
      expect(res.headers.get("X-RateLimit-Bucket")).toBe("ip");
      expect(res.headers.get("X-RateLimit-Limit")).toBe(String(__limits.MAX_REQUESTS));
      remaining.push(Number(res.headers.get("X-RateLimit-Remaining")));
    }
    // One counter across all four: the forged values changed nothing.
    expect(remaining).toEqual([
      __limits.MAX_REQUESTS - 1,
      __limits.MAX_REQUESTS - 2,
      __limits.MAX_REQUESTS - 3,
      __limits.MAX_REQUESTS - 4,
    ]);
  });

  test("forging a fresh address on every request does not escape an exhausted ip bucket", async () => {
    const app = buildApp();
    for (let i = 0; i < __limits.MAX_REQUESTS; i++) {
      await hit(app, { "CF-Connecting-IP": A });
    }
    for (let i = 1; i <= 5; i++) {
      const forged = await hit(app, {
        "CF-Connecting-IP": A,
        "X-Forwarded-For": `198.51.100.${i}`,
      });
      expect(forged.status).toBe(429);
      expect(forged.headers.get("X-RateLimit-Bucket")).toBe("ip");
    }
  });

  test("it cannot spend a site visitor's allowance either", async () => {
    const app = buildApp();
    await hit(app, { "CF-Connecting-IP": "198.51.100.5", "X-Forwarded-For": A });
    const site = await hit(app, viaBinding(A));
    expect(site.headers.get("X-RateLimit-Bucket")).toBe("site-ip");
    expect(site.headers.get("X-RateLimit-Remaining")).toBe(String(CAP - 1));
  });
});

describe("a request through the service binding is counted per forwarded visitor", () => {
  test("it lands in site-ip and says so", async () => {
    const res = await hit(buildApp(), viaBinding(A));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("site-ip");
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(CAP));
    expect(res.headers.get("X-RateLimit-Remaining")).toBe(String(CAP - 1));
  });

  test("the Nth request passes and the next is refused with Retry-After", async () => {
    const app = buildApp();
    let last: Response | undefined;
    for (let i = 0; i < CAP; i++) {
      last = await hit(app, viaBinding(A));
      expect(last.status).toBe(200);
    }
    expect(last?.headers.get("X-RateLimit-Remaining")).toBe("0");

    const over = await hit(app, viaBinding(A));
    expect(over.status).toBe(429);
    expect(over.headers.get("Retry-After")).toBe(String(__limits.WINDOW_SIZE));
    expect(over.headers.get("X-RateLimit-Bucket")).toBe("site-ip");
    expect(over.headers.get("X-RateLimit-Limit")).toBe(String(CAP));
    expect(over.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  test("two visitors have separate counts, and exhausting one refuses that one only", async () => {
    const app = buildApp();
    for (let i = 0; i < CAP; i++) await hit(app, viaBinding(A));
    expect((await hit(app, viaBinding(A))).status).toBe(429);

    const other = await hit(app, viaBinding(B));
    expect(other.status).toBe(200);
    expect(other.headers.get("X-RateLimit-Remaining")).toBe(String(CAP - 1));
    // And A is still refused after B was served.
    expect((await hit(app, viaBinding(A))).status).toBe(429);
  });

  test("only the first forwarded entry names the visitor", async () => {
    const app = buildApp();
    const first = await hit(app, viaBinding(`${A}, 10.0.0.1, 10.0.0.2`));
    const same = await hit(app, viaBinding(A));
    const behind = await hit(app, viaBinding(`${B}, ${A}`));
    expect(first.headers.get("X-RateLimit-Remaining")).toBe(String(CAP - 1));
    // The bare address is the same visitor as the first entry of a longer chain.
    expect(same.headers.get("X-RateLimit-Remaining")).toBe(String(CAP - 2));
    // A chain that merely ends in A is B's, and starts B's own count.
    expect(behind.headers.get("X-RateLimit-Remaining")).toBe(String(CAP - 1));
  });

  test("one IPv6 visitor is one bucket however the address is written", async () => {
    const app = buildApp();
    const first = await hit(app, viaBinding("2001:DB8:0:0:0:0:0:1"));
    const second = await hit(app, viaBinding("2001:db8::1"));
    expect(first.headers.get("X-RateLimit-Remaining")).toBe(String(CAP - 1));
    expect(second.headers.get("X-RateLimit-Remaining")).toBe(String(CAP - 2));
  });

  test("a site visitor and a public caller at the same address do not share a counter", async () => {
    const app = buildApp();
    // Exhaust the PUBLIC bucket for A...
    for (let i = 0; i < __limits.MAX_REQUESTS; i++) await hit(app, { "CF-Connecting-IP": A });
    expect((await hit(app, { "CF-Connecting-IP": A })).status).toBe(429);
    // ...the same address through the binding is untouched.
    const site = await hit(app, viaBinding(A));
    expect(site.status).toBe(200);
    expect(site.headers.get("X-RateLimit-Remaining")).toBe(String(CAP - 1));

    // And the other way round, on the strict bucket where the two caps are equal
    // and sharing a counter would have been coherent: the keyspaces are still apart.
    for (let i = 0; i < __limits.AUTH_MAX_REQUESTS; i++) {
      await hit(app, viaBinding(B), "/auth/login");
    }
    expect((await hit(app, viaBinding(B), "/auth/login")).status).toBe(429);
    expect((await hit(app, { "CF-Connecting-IP": B }, "/auth/login")).status).toBe(200);
  });

  test("a bearer still selects the token bucket", async () => {
    const res = await hit(
      buildApp(),
      { ...viaBinding(A), Authorization: `Bearer ${"a".repeat(48)}` },
      "/admin/users",
    );
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("token");
  });
});

describe("the strict bucket is per visitor for the website and shared for nobody", () => {
  test("a forwarded visitor gets ten sign-in requests of their own", async () => {
    const app = buildApp();
    for (let i = 0; i < __limits.AUTH_MAX_REQUESTS; i++) {
      expect((await hit(app, viaBinding(A), "/auth/login")).status).toBe(200);
    }
    const over = await hit(app, viaBinding(A), "/auth/login");
    expect(over.status).toBe(429);
    expect(over.headers.get("X-RateLimit-Bucket")).toBe("auth-ip");
    expect(over.headers.get("X-RateLimit-Limit")).toBe(String(__limits.AUTH_MAX_REQUESTS));
    // Another visitor is unaffected (#1354: they used to share these ten).
    expect((await hit(app, viaBinding(B), "/auth/login")).status).toBe(200);
  });

  test("unattributed callers share ONE strict bucket: it fails closed, not open", async () => {
    const app = buildApp();
    for (let i = 0; i < __limits.AUTH_MAX_REQUESTS; i++) {
      // Different unreadable values, none of which may buy a bucket of its own.
      const res = await hit(app, { "X-Forwarded-For": `junk-${i}` }, "/auth/login");
      expect(res.status).toBe(200);
    }
    const over = await hit(app, {}, "/auth/login");
    expect(over.status).toBe(429);
    expect(over.headers.get("X-RateLimit-Bucket")).toBe("auth-ip");
  });
});

describe("a request with no usable address shares one bucket", () => {
  const UNREADABLE: Array<Record<string, string>> = [
    {},
    { "X-Forwarded-For": "" },
    { "X-Forwarded-For": "not-an-ip" },
    { "X-Forwarded-For": "203.0.113.999" },
    { "X-Forwarded-For": "203.0.113.7:8080" },
    { "X-Forwarded-For": "unknown, 203.0.113.7" },
    { "X-Forwarded-For": "a".repeat(600) },
    { "X-Forwarded-For": `203.0.113.7, ${"1.1.1.1, ".repeat(100)}` },
  ];

  test("each is counted in site-unattributed, against ONE counter", async () => {
    const app = buildApp();
    const remaining: number[] = [];
    for (const headers of UNREADABLE) {
      const res = await hit(app, headers);
      expect(res.status).toBe(200);
      expect(res.headers.get("X-RateLimit-Bucket")).toBe("site-unattributed");
      expect(res.headers.get("X-RateLimit-Limit")).toBe(
        String(__limits.SITE_UNATTRIBUTED_MAX_REQUESTS),
      );
      remaining.push(Number(res.headers.get("X-RateLimit-Remaining")));
    }
    const top = __limits.SITE_UNATTRIBUTED_MAX_REQUESTS;
    expect(remaining).toEqual(UNREADABLE.map((_, i) => top - 1 - i));
  });

  test("the shared bucket still has a ceiling", async () => {
    const app = buildApp();
    await h.seed("site-unattributed:unattributed", {
      count: __limits.SITE_UNATTRIBUTED_MAX_REQUESTS - 1,
      warned: false,
      windowEnd: T0 + __limits.WINDOW_SIZE * 1000,
    });
    const last = await hit(app, {});
    expect(last.status).toBe(200);
    expect(last.headers.get("X-RateLimit-Remaining")).toBe("0");
    const over = await hit(app, { "X-Forwarded-For": "junk" });
    expect(over.status).toBe(429);
    expect(over.headers.get("Retry-After")).toBe(String(__limits.WINDOW_SIZE));
    expect(over.headers.get("X-RateLimit-Bucket")).toBe("site-unattributed");
  });

  test("it does not touch the allowance of a forwarded visitor or a public caller", async () => {
    const app = buildApp();
    await hit(app, {});
    expect((await hit(app, viaBinding(A))).headers.get("X-RateLimit-Remaining")).toBe(
      String(CAP - 1),
    );
    expect((await hit(app, { "CF-Connecting-IP": A })).headers.get("X-RateLimit-Remaining")).toBe(
      String(__limits.MAX_REQUESTS - 1),
    );
  });
});

describe("what is unchanged", () => {
  test("the test bypass header skips the limiter for a site caller too", async () => {
    const res = await hit(buildApp(), {
      ...viaBinding(A),
      "X-Test-Bypass": PROD_ENV.TEST_BYPASS_TOKEN as string,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Bucket")).toBeNull();
  });

  test("a wrong bypass value does not", async () => {
    const res = await hit(buildApp(), { ...viaBinding(A), "X-Test-Bypass": "nope" });
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("site-ip");
  });

  test("development still bypasses the limiter entirely", async () => {
    const dev = { ...PROD_ENV, ENVIRONMENT: "development" } as Bindings;
    const res = await hit(buildApp(), viaBinding(A), "/datasets", dev);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Bucket")).toBeNull();
  });

  test("the window still resets: an exhausted visitor gets a fresh allowance after it", async () => {
    const app = buildApp();
    for (let i = 0; i < CAP; i++) await hit(app, viaBinding(A));
    expect((await hit(app, viaBinding(A))).status).toBe(429);
    h.clock = T0 + __limits.WINDOW_SIZE * 1000 - 1;
    expect((await hit(app, viaBinding(A))).status).toBe(429);
    h.clock = T0 + __limits.WINDOW_SIZE * 1000;
    const fresh = await hit(app, viaBinding(A));
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("X-RateLimit-Remaining")).toBe(String(CAP - 1));
  });
});

describe("the log line", () => {
  test("a site caller is logged once per window and an ordinary one never", async () => {
    const app = buildApp();
    await hit(app, { "CF-Connecting-IP": A });
    expect(h.log.mock.calls.length).toBe(0);
    await hit(app, viaBinding(A));
    await hit(app, viaBinding(B));
    expect(h.log.mock.calls.length).toBe(1);
    // No address in it.
    expect(JSON.stringify(h.log.mock.calls[0])).not.toContain(A);
  });

  test("an unattributed caller is warned about once per window, then again after it", async () => {
    const app = buildApp();
    await hit(app, {});
    await hit(app, { "X-Forwarded-For": "junk" });
    const unattributed = () =>
      h.warn.mock.calls.filter((c) => String(c[0]).includes("unattributed"));
    expect(unattributed().length).toBe(1);
    __resetIdentityLogForTests();
    await hit(app, {});
    expect(unattributed().length).toBe(2);
  });
});

// --------------------------------------------------------------------------
// The per-route miss budget reads the same identity
// --------------------------------------------------------------------------

describe("checkDataMissBudget uses the same identity", () => {
  const MISS = __limits.DATA_MISS_MAX_REQUESTS;
  const env = { ENVIRONMENT: "production" } as Pick<Bindings, "ENVIRONMENT" | "TEST_BYPASS_TOKEN">;
  const ask = (headers: Record<string, string>) =>
    checkDataMissBudget(env, new Request("http://localhost/data/x", { headers }), undefined);
  const seed = (key: string, count: number) =>
    h.seed(`data-miss-ip:${key}`, { count, warned: false, windowEnd: T0 + 60_000 });

  test("a forwarded visitor spends their own budget", async () => {
    await seed(`site:${A}`, MISS);
    const refused = await ask(viaBinding(A));
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) {
      expect(refused.response.status).toBe(429);
      expect(refused.response.headers.get("X-RateLimit-Bucket")).toBe("data-miss-ip");
    }
    expect((await ask(viaBinding(B))).allowed).toBe(true);
  });

  test("a public caller is keyed by its address exactly as before", async () => {
    await seed(A, MISS);
    expect((await ask({ "CF-Connecting-IP": A })).allowed).toBe(false);
    // A forged forward changes nothing, and the same address through the binding is separate.
    expect((await ask({ "CF-Connecting-IP": A, "X-Forwarded-For": B })).allowed).toBe(false);
    expect((await ask(viaBinding(A))).allowed).toBe(true);
  });

  test("unattributed callers share one budget", async () => {
    await seed("unattributed", MISS);
    expect((await ask({})).allowed).toBe(false);
    expect((await ask({ "X-Forwarded-For": "junk" })).allowed).toBe(false);
    expect((await ask(viaBinding(A))).allowed).toBe(true);
  });
});
