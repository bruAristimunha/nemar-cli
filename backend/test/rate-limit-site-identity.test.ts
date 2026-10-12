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
  __parseForwardedFor,
  __readCallerIdentity,
  __resetRateLimitLogsForTests,
  __selectBucket,
  checkDataMissBudget,
} from "../src/middleware/rateLimit";
import { createMcpRoutes } from "../src/routes/mcp";
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
    ["255.255.255.255", "255.255.255.255"],
    // Only the exact unspecified address is refused, not its neighbors.
    ["0.0.0.1", "0.0.0.1"],
    ["126.255.255.255", "126.255.255.255"],
    ["128.0.0.1", "128.0.0.1"],
    ["2001:db8::1", "2001:db8::1"],
    // The URL parser compresses and lowercases, so one visitor is one key.
    ["2001:DB8:0:0:0:0:0:1", "2001:db8::1"],
    // An IPv4-mapped address is the IPv4 visitor it wraps, however it is written.
    ["::ffff:203.0.113.7", "203.0.113.7"],
    ["::FFFF:CB00:7107", "203.0.113.7"],
    ["0:0:0:0:0:ffff:cb00:7107", "203.0.113.7"],
    // Only the first entry counts, however many follow.
    ["203.0.113.7, 10.0.0.1, 10.0.0.2", "203.0.113.7"],
    ["203.0.113.7,10.0.0.1", "203.0.113.7"],
    // Only `::ffff:` followed by exactly two groups is the mapped range. Its neighbors
    // keep their own keys, so no visitor whose address merely ends in `::ffff:x:y`
    // is read as an IPv4 one.
    ["2001:db8::ffff:1:2", "2001:db8::ffff:1:2"],
    ["2001:db9::ffff:1:2", "2001:db9::ffff:1:2"],
    ["::ffff:1:2:3", "::ffff:1:2:3"],
    ["1::ffff:1:2", "1::ffff:1:2"],
    ["ffff::ffff:1:2", "ffff::ffff:1:2"],
    ["::abcd:102:304", "::abcd:102:304"],
    // The longest legitimate literal is 45 characters, and is accepted (as the IPv4 it wraps).
    ["0000:0000:0000:0000:0000:ffff:255.255.255.255", "255.255.255.255"],
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
    // An octet above 255 is refused in every position, including 256 to 259.
    ["256.1.1.1"],
    ["1.256.1.1"],
    ["1.1.256.1"],
    ["259.0.0.1"],
    ["1.1.1.259"],
    ["1.1.300.1"],
    // A leading zero is refused whatever the octet (some parsers read it as octal).
    ["203.0.113.07"],
    ["203.0.113.007"],
    ["203.0.113.00"],
    ["203.0.113.010"],
    ["01.2.3.4"],
    ["203.0.113.7:8080"],
    ["[2001:db8::1]"],
    ["[2001:db8::1]:443"],
    ["fe80::1%eth0"],
    ["2001:db8::g"],
    ["2001:db8:::1"],
    ["1:2:3:4:5:6:7:8:9"],
    ["203.0.113.7\n10.0.0.1"],
    ["203.0.113.7;x"],
    // Junk after an address that the URL parser alone would take for a path: it reads
    // the candidate between brackets, so a closing bracket in it ends the host early.
    ["2001:db8::5]/x"],
    ["2001:db8::5]?x"],
    ["2001:db8::5]#x"],
    ["2001:db8::5]\\x"],
    ["::1]/@[::2"],
    // The FIRST entry decides: an unreadable one is not skipped to reach a later one.
    ["unknown, 203.0.113.7"],
    [", 203.0.113.7"],
    // A placeholder is no visitor: counting it would put thousands of them in one key.
    ["0.0.0.0"],
    ["::"],
    ["0:0:0:0:0:0:0:0"],
    ["127.0.0.1"],
    ["127.255.255.255"],
    ["::1"],
    ["0:0:0:0:0:0:0:1"],
    ["::ffff:127.0.0.1"],
    ["::ffff:0.0.0.0"],
  ])("%j is not an address", (header) => {
    expect(__firstForwardedIp(header)).toBeNull();
  });

  test("the header bound is exact: 512 characters are read and 513 are not", () => {
    const padded = (length: number) => `203.0.113.7,${" ".repeat(length - "203.0.113.7,".length)}`;
    expect(padded(512)).toHaveLength(512);
    expect(__firstForwardedIp(padded(512))).toBe("203.0.113.7");
    expect(__firstForwardedIp(padded(513))).toBeNull();
  });

  test("an address over its own length bound is not read", () => {
    expect(__firstForwardedIp(`203.0.113.7, ${"1.1.1.1, ".repeat(100)}`)).toBeNull();
    expect(__firstForwardedIp("a".repeat(600))).toBeNull();
    expect(__firstForwardedIp(`${"0".repeat(60)}:1`)).toBeNull();
  });
});

describe("__parseForwardedFor says why there is no address", () => {
  test.each([
    [undefined, "absent", 0],
    [null, "absent", 0],
    ["", "absent", 0],
    ["a".repeat(513), "too-long", 513],
    ["unknown", "first-entry-not-an-ip", 7],
    ["0.0.0.0", "unspecified-or-loopback", 7],
    ["::", "unspecified-or-loopback", 2],
    ["127.0.0.1, 203.0.113.7", "unspecified-or-loopback", 22],
    ["::1", "unspecified-or-loopback", 3],
    ["::ffff:127.0.0.1", "unspecified-or-loopback", 16],
  ] as const)("%j is %s (length %d)", (header, reason, forwardedLength) => {
    const parsed = __parseForwardedFor(header);
    expect(parsed.ok).toBe(false);
    expect(parsed).toMatchObject({ reason, forwardedLength });
  });

  test.each([
    ["", "empty"],
    ["   ", "empty"],
    ["unknown", "word"],
    ["_hidden", "word"],
    ["203.0.113.7:8080", "ipv4-with-port"],
    ["[2001:db8::1]", "bracketed"],
    ["[2001:db8::1]:443", "bracketed"],
    ["fe80::1%eth0", "zone-id"],
    ["2001:db8::g1", "other"],
    ["2001:db8:::1", "malformed-ipv6"],
    ["203.0.113", "malformed-ipv4"],
    ["203.0.113.256", "malformed-ipv4"],
    ["not an address!", "other"],
  ])("a first entry of %j has the shape %s", (header, shape) => {
    const parsed = __parseForwardedFor(header.trim() === "" ? `${header},203.0.113.7` : header);
    expect(parsed).toMatchObject({ ok: false, reason: "first-entry-not-an-ip", shape });
  });

  test("the shape is a class and the reason a fixed word: neither carries the value", () => {
    const value = "secret-token-value";
    const parsed = __parseForwardedFor(value);
    expect(JSON.stringify(parsed)).not.toContain(value);
  });

  test("a readable address has no reason", () => {
    expect(__parseForwardedFor("203.0.113.7")).toEqual({ ok: true, ip: "203.0.113.7" });
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

  test("with neither, or with an unreadable forward, the caller is unattributed, with the reason", () => {
    const cases = [
      [undefined, "absent"],
      [null, "absent"],
      ["", "absent"],
      ["unknown", "first-entry-not-an-ip"],
      ["203.0.113.7:80", "first-entry-not-an-ip"],
      ["a".repeat(600), "too-long"],
      ["0.0.0.0", "unspecified-or-loopback"],
    ] as const;
    for (const [forwarded, reason] of cases) {
      expect(__readCallerIdentity(undefined, forwarded)).toMatchObject({
        source: "unattributed",
        key: "unattributed",
        detail: { reason },
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
  test("the website's caps are the numbers the owner chose", () => {
    expect(__limits.SITE_IP_MAX_REQUESTS).toBe(2000);
    expect(__limits.SITE_UNATTRIBUTED_MAX_REQUESTS).toBe(20_000);
  });

  test("the Neurobagel and miss-budget caps are the numbers they were sized to", () => {
    // The tables elsewhere read their numbers from `__limits`, so they could not see
    // one of these change.
    expect(__limits.NEUROBAGEL_MAX_REQUESTS).toBe(1200);
    expect(__limits.DATA_MISS_MAX_REQUESTS).toBe(10_000);
  });

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

  test("an IPv4 visitor written as an IPv4-mapped IPv6 address is the same visitor", async () => {
    const app = buildApp();
    const plain = await hit(app, viaBinding("203.0.113.30"));
    const mapped = await hit(app, viaBinding("::ffff:203.0.113.30"));
    const hex = await hit(app, viaBinding("::FFFF:CB00:711E"));
    expect(plain.headers.get("X-RateLimit-Remaining")).toBe(String(CAP - 1));
    expect(mapped.headers.get("X-RateLimit-Remaining")).toBe(String(CAP - 2));
    expect(hex.headers.get("X-RateLimit-Remaining")).toBe(String(CAP - 3));
  });

  test("a placeholder address names nobody: it is counted with the unattributed", async () => {
    const app = buildApp();
    for (const placeholder of ["0.0.0.0", "::", "127.0.0.1", "::1"]) {
      const res = await hit(app, viaBinding(placeholder));
      expect(res.headers.get("X-RateLimit-Bucket")).toBe("site-unattributed");
      expect(res.headers.get("X-RateLimit-Caller")).toBe("unattributed");
    }
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

describe("the response says how the caller was identified", () => {
  test("edge, site and unattributed callers each carry X-RateLimit-Caller", async () => {
    const app = buildApp();
    expect((await hit(app, edge(A))).headers.get("X-RateLimit-Caller")).toBe("edge");
    expect((await hit(app, viaBinding(A))).headers.get("X-RateLimit-Caller")).toBe("site");
    expect((await hit(app, {})).headers.get("X-RateLimit-Caller")).toBe("unattributed");
  });

  test("it is there on the buckets whose own header cannot tell the sources apart", async () => {
    const app = buildApp();
    for (const [path, bucket] of [
      ["/auth/login", "auth-ip"],
      ["/data/nm000108/v1.0.0/x", "data-ip"],
      ["/neurobagel/index.json", "neurobagel-ip"],
    ] as const) {
      const none = await hit(app, {}, path);
      expect(none.headers.get("X-RateLimit-Bucket")).toBe(bucket);
      expect(none.headers.get("X-RateLimit-Caller")).toBe("unattributed");
      const site = await hit(app, viaBinding(B), path);
      expect(site.headers.get("X-RateLimit-Bucket")).toBe(bucket);
      expect(site.headers.get("X-RateLimit-Caller")).toBe("site");
    }
  });

  test("a refusal carries it too", async () => {
    const app = buildApp();
    for (let i = 0; i < __limits.AUTH_MAX_REQUESTS; i++)
      await hit(app, viaBinding(A), "/auth/login");
    const over = await hit(app, viaBinding(A), "/auth/login");
    expect(over.status).toBe(429);
    expect(over.headers.get("X-RateLimit-Caller")).toBe("site");
    expect(over.headers.get("X-RateLimit-Bucket")).toBe("auth-ip");
  });

  test("the X-RateLimit-Bucket values are the same as before", async () => {
    const app = buildApp();
    expect((await hit(app, edge(A))).headers.get("X-RateLimit-Bucket")).toBe("ip");
    expect((await hit(app, viaBinding(A))).headers.get("X-RateLimit-Bucket")).toBe("site-ip");
    expect((await hit(app, {})).headers.get("X-RateLimit-Bucket")).toBe("site-unattributed");
  });
});

describe("the identity log", () => {
  const lines = () =>
    [...h.log.mock.calls, ...h.warn.mock.calls].filter((c) =>
      String(c[0]).startsWith("[rate-limit]"),
    );

  test("a public request logs nothing", async () => {
    const app = buildApp();
    await hit(app, edge(A));
    await hit(app, edge(A), "/auth/login");
    expect(lines()).toEqual([]);
  });

  test("a bearer chooses the token bucket, so no line claims the address did", async () => {
    // The key is the token, not the visitor and not the shared bucket.
    const app = buildApp();
    const token = { Authorization: `Bearer ${"t".repeat(48)}` };
    await hit(app, { ...viaBinding(A), ...token }, "/admin/users");
    await hit(app, { ...token }, "/admin/users");
    expect(lines().filter((c) => String(c[0]).includes("CF-Connecting-IP"))).toEqual([]);
    // The answers still say how the caller was identified.
    const site = await hit(app, { ...viaBinding(B), ...token }, "/admin/users");
    expect(site.headers.get("X-RateLimit-Bucket")).toBe("token");
    expect(site.headers.get("X-RateLimit-Caller")).toBe("site");
  });

  test("a site caller is logged once per window per bucket, with the bucket and its cap", async () => {
    const app = buildApp();
    await hit(app, viaBinding(A));
    await hit(app, viaBinding(B));
    expect(h.log.mock.calls.length).toBe(1);
    expect(h.log.mock.calls[0]?.[1]).toMatchObject({
      keyKind: "site-ip",
      maxRequests: CAP,
      path: "/datasets",
      suppressed: 0,
    });
    // A second bucket is a second line: the first would otherwise hide it.
    await hit(app, viaBinding(A), "/auth/login");
    expect(h.log.mock.calls.length).toBe(2);
    expect(h.log.mock.calls[1]?.[1]).toMatchObject({
      keyKind: "auth-ip",
      maxRequests: __limits.AUTH_MAX_REQUESTS,
    });
    // No address in either.
    expect(JSON.stringify(h.log.mock.calls)).not.toContain(A);
    expect(JSON.stringify(h.log.mock.calls)).not.toContain(B);
  });

  test("the line is held back until the window ends, then says how many it swallowed", async () => {
    const app = buildApp();
    await hit(app, viaBinding(A));
    h.clock = T0 + __limits.WINDOW_SIZE * 1000 - 1;
    await hit(app, viaBinding(A));
    await hit(app, viaBinding(B));
    expect(h.log.mock.calls.length).toBe(1);
    h.clock = T0 + __limits.WINDOW_SIZE * 1000;
    await hit(app, viaBinding(A));
    expect(h.log.mock.calls.length).toBe(2);
    expect(h.log.mock.calls[1]?.[1]).toMatchObject({ suppressed: 2 });
  });

  test("an unattributed caller is warned about on EVERY bucket it reaches, with the reason", async () => {
    const app = buildApp();
    // The same reason, repeated, is one line per bucket however many requests carry it.
    await hit(app, {});
    await hit(app, {});
    await hit(app, {}, "/auth/login");
    await hit(app, {}, "/auth/login");
    await hit(app, {}, "/data/nm000108/v1.0.0/x");
    const warnings = h.warn.mock.calls.filter((c) => String(c[0]).startsWith("[rate-limit]"));
    expect(warnings.map((c) => (c[1] as { keyKind: string }).keyKind).sort()).toEqual([
      "auth-ip",
      "data-ip",
      "site-unattributed",
    ]);
    const anonymous = warnings.find(
      (c) => (c[1] as { keyKind: string }).keyKind === "site-unattributed",
    );
    expect(anonymous?.[1]).toMatchObject({
      maxRequests: __limits.SITE_UNATTRIBUTED_MAX_REQUESTS,
      reason: "absent",
      forwardedLength: 0,
    });
    const strict = warnings.find((c) => (c[1] as { keyKind: string }).keyKind === "auth-ip");
    expect(strict?.[1]).toMatchObject({
      maxRequests: __limits.AUTH_MAX_REQUESTS,
      reason: "absent",
    });
  });

  test("the reason and the shape say what was wrong without saying the value", async () => {
    const secret = "leaky-secret-value-9";
    const app = buildApp();
    await hit(app, { "X-Forwarded-For": secret });
    const [call] = h.warn.mock.calls.filter((c) => String(c[0]).startsWith("[rate-limit]"));
    expect(call?.[1]).toMatchObject({
      reason: "first-entry-not-an-ip",
      forwardedLength: secret.length,
      shape: "other",
    });
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain(secret);
  });

  test("a different reason on the same bucket is a different line, so one cannot hide another", async () => {
    const app = buildApp();
    await hit(app, {});
    await hit(app, {});
    await hit(app, { "X-Forwarded-For": "unknown" });
    await hit(app, { "X-Forwarded-For": "unknown" });
    await hit(app, { "X-Forwarded-For": "0.0.0.0" });
    const reasons = h.warn.mock.calls
      .filter((c) => String(c[0]).startsWith("[rate-limit]"))
      .map((c) => (c[1] as { reason: string }).reason);
    expect(reasons).toEqual(["absent", "first-entry-not-an-ip", "unspecified-or-loopback"]);
  });

  test("each kind of unreadable header is told apart in the one line it gets", async () => {
    const cases = [
      [{}, "absent"],
      [{ "X-Forwarded-For": "203.0.113.7:8080" }, "first-entry-not-an-ip"],
      [{ "X-Forwarded-For": "x".repeat(600) }, "too-long"],
      [{ "X-Forwarded-For": "0.0.0.0" }, "unspecified-or-loopback"],
    ] as const;
    for (const [headers, reason] of cases) {
      __resetRateLimitLogsForTests();
      h.warn.mockClear();
      await hit(buildApp(), headers);
      expect(h.warn.mock.calls[0]?.[1]).toMatchObject({ reason });
    }
  });
});

describe("the other entry points count a forwarded visitor too", () => {
  test("the MCP sub-app (anonymousSurface) counts it in site-ip", async () => {
    const app = createMcpRoutes();
    const res = await app.fetch(
      new Request("http://mcp.nemar.org/", { headers: viaBinding(A) }),
      PROD_ENV,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("site-ip");
    expect(res.headers.get("X-RateLimit-Caller")).toBe("site");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe(String(CAP - 1));
  });

  test("and refuses it at the same cap, saying who it was", async () => {
    await h.seed(`site-ip:site:${B}`, {
      count: CAP,
      warned: false,
      windowEnd: T0 + __limits.WINDOW_SIZE * 1000,
    });
    const res = await createMcpRoutes().fetch(
      new Request("http://mcp.nemar.org/", { headers: viaBinding(B) }),
      PROD_ENV,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("site-ip");
    expect(res.headers.get("X-RateLimit-Caller")).toBe("site");
  });

  test("observe-only counting (the zarr redirect) keeps a forwarded visitor's own count and never refuses", async () => {
    const app = buildApp({ observeOnly: true });
    await h.seed(`site-ip:site:${A}`, {
      count: CAP,
      warned: false,
      windowEnd: T0 + __limits.WINDOW_SIZE * 1000,
    });
    const res = await hit(app, viaBinding(A));
    expect(res.status).toBe(200);
    expect((await h.stored(`site-ip:site:${A}`))?.count).toBe(CAP + 1);
    // The public bucket at the same address was not touched.
    expect(await h.stored(`ip:${A}`)).toBeUndefined();
    // And it said so once, with the hash of the key and not the address.
    const tripped = h.warn.mock.calls.filter((c) =>
      String(c[0]).includes("observe-only bucket would have tripped"),
    );
    expect(tripped.length).toBe(1);
    expect(JSON.stringify(tripped)).not.toContain(A);
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
      expect(refused.response.headers.get("X-RateLimit-Caller")).toBe("site");
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

describe("the token bucket is keyed by the bearer, whoever forwarded it", () => {
  const A_KEY = `a${"x".repeat(47)}`;
  const B_KEY = `b${"x".repeat(47)}`;

  test("selection keys the bucket on the bearer for a site and an unattributed caller", () => {
    const site = __selectBucket("/admin/users", `Bearer ${A_KEY}`, "site:203.0.113.7", "site");
    expect(site).toMatchObject({ keyKind: "token", rawKey: A_KEY });
    const none = __selectBucket("/admin/users", `Bearer ${A_KEY}`, "unattributed", "unattributed");
    expect(none).toMatchObject({ keyKind: "token", rawKey: A_KEY });
  });

  test("one bearer from two visitors is one count; two bearers from one visitor are two", async () => {
    const app = buildApp();
    const as = (key: string, visitor: string) => ({
      ...viaBinding(visitor),
      Authorization: `Bearer ${key}`,
    });
    const first = await hit(app, as(A_KEY, "203.0.113.120"), "/admin/users");
    const second = await hit(app, as(A_KEY, "203.0.113.121"), "/admin/users");
    const other = await hit(app, as(B_KEY, "203.0.113.120"), "/admin/users");
    const cap = __limits.TOKEN_MAX_REQUESTS_AUTHED;
    expect(first.headers.get("X-RateLimit-Remaining")).toBe(String(cap - 1));
    expect(second.headers.get("X-RateLimit-Remaining")).toBe(String(cap - 2));
    expect(other.headers.get("X-RateLimit-Remaining")).toBe(String(cap - 1));
  });
});

describe("two visitors whose addresses differ only in the prefix are two buckets", () => {
  test("end to end", async () => {
    const app = buildApp();
    const a = await hit(app, viaBinding("2001:db8::ffff:1:2"));
    const b = await hit(app, viaBinding("2001:db9::ffff:1:2"));
    expect(a.headers.get("X-RateLimit-Remaining")).toBe(String(CAP - 1));
    expect(b.headers.get("X-RateLimit-Remaining")).toBe(String(CAP - 1));
  });
});
