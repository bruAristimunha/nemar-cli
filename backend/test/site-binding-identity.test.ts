/**
 * What the rate limiter sees over a service binding, in real workerd (#1709, ADR 0098).
 *
 * The limiter counts a request without `CF-Connecting-IP` by the visitor its
 * caller forwards in `X-Forwarded-For`. That rests on a property of service
 * bindings, that a call over one arrives with no `CF-Connecting-IP`, and the
 * bun tests (`rate-limit-site-identity.test.ts`) can only assume it by leaving
 * the header off. This file asks workerd instead.
 *
 * The API Worker is bundled by the production bundler and run through Miniflare
 * (the harness ADR 0078 describes) with `ENVIRONMENT=production`, so the real
 * limiter runs against workerd's real Cache API. Beside it sit a caller Worker
 * holding a service binding to the DEFAULT entrypoint, which is what the
 * website will hold, and a small reporter Worker that says which headers reached
 * it, so the question is answered without the limiter in the way.
 *
 * WHAT THIS CANNOT SHOW. Local workerd is not the Cloudflare edge. It says what
 * the workerd implementation of a service binding does, not what Cloudflare's
 * production network does, and the two can differ. The development Worker skips
 * the limiter entirely (`ENVIRONMENT=development`), so the keying below can be
 * seen on the production Worker and nowhere else. ADR 0098 says how to check it
 * after a deploy.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { __limits } from "../src/middleware/rateLimit";
import { bundleWorker, wranglerCompatibility } from "./helpers/worker-bundle";

/** The callee that reports what reached it: no limiter, no app. */
const REPORTER = `export default {
  async fetch(request) {
    const h = request.headers;
    return Response.json({
      cfConnectingIp: h.get("cf-connecting-ip"),
      xForwardedFor: h.get("x-forwarded-for"),
      xRealIp: h.get("x-real-ip"),
      hasCf: request.cf !== undefined && request.cf !== null,
    });
  },
};`;

/** The caller: the shape of the website's Worker, one service binding per target. */
const CALLER = `export default {
  async fetch(request, env) {
    const { target, path, headers } = await request.json();
    const res = await env[target].fetch("http://callee.test" + path, { headers });
    return Response.json({
      status: res.status,
      limit: res.headers.get("x-ratelimit-limit"),
      remaining: res.headers.get("x-ratelimit-remaining"),
      bucket: res.headers.get("x-ratelimit-bucket"),
      retryAfter: res.headers.get("retry-after"),
      body: await res.json(),
    });
  },
};`;

interface Seen {
  status: number;
  limit: string | null;
  remaining: string | null;
  bucket: string | null;
  retryAfter: string | null;
  // biome-ignore lint/suspicious/noExplicitAny: the reporter's JSON or the API's, by target
  body: any;
}

let mf: Miniflare;

/** A call from the caller Worker over a service binding. `getWorker()` rather
 *  than `dispatchFetch`, which under bun cannot route by hostname (the existing
 *  entry test explains) and so always reaches the first worker. */
async function overBinding(
  target: "API" | "REPORTER",
  path: string,
  headers: Record<string, string> = {},
): Promise<Seen> {
  const caller = await mf.getWorker("caller");
  const res = await caller.fetch("http://caller.test/", {
    method: "POST",
    body: JSON.stringify({ target, path, headers }),
  });
  return (await res.json()) as Seen;
}

beforeAll(async () => {
  const { date, flags } = wranglerCompatibility();
  mf = new Miniflare({
    workers: [
      {
        name: "nemar-api",
        modules: [{ type: "ESModule", path: "worker.js", contents: bundleWorker() }],
        compatibilityDate: date,
        compatibilityFlags: flags,
        d1Databases: { DB: "nemar-db-site-binding-test" },
        // Production, so the limiter runs. `/health` needs nothing else.
        bindings: { ENVIRONMENT: "production" },
      },
      {
        name: "reporter",
        modules: true,
        script: REPORTER,
        compatibilityDate: date,
      },
      {
        name: "caller",
        modules: true,
        script: CALLER,
        compatibilityDate: date,
        // No `entrypoint`: the default export, whose `fetch` is the whole HTTP app.
        serviceBindings: { API: "nemar-api", REPORTER: "reporter" },
      },
    ],
  });
  await mf.ready;
});

afterAll(async () => {
  await mf?.dispose();
});

describe("what workerd hands a callee over a service binding", () => {
  test("no CF-Connecting-IP, no X-Real-IP and no cf object arrive; the forwarded visitor does", async () => {
    const seen = await overBinding("REPORTER", "/", { "X-Forwarded-For": "203.0.113.7" });
    expect(seen.body).toEqual({
      cfConnectingIp: null,
      xForwardedFor: "203.0.113.7",
      xRealIp: null,
      hasCf: false,
    });
  });

  test("a call that forwards nothing arrives with neither header", async () => {
    const seen = await overBinding("REPORTER", "/");
    expect(seen.body.cfConnectingIp).toBeNull();
    expect(seen.body.xForwardedFor).toBeNull();
  });

  test("a header the caller sets itself arrives as set: the account is the boundary", async () => {
    // Why ADR 0078 and ADR 0098 name the account as the trust boundary: nothing
    // between two Workers in an account vouches for a header. A caller that
    // forwards its own visitor's CF-Connecting-IP is believed, which is right
    // when the caller is the website and the reason the website must SET these.
    const seen = await overBinding("REPORTER", "/", { "CF-Connecting-IP": "198.51.100.1" });
    expect(seen.body.cfConnectingIp).toBe("198.51.100.1");
  });

  test("a request from outside the Worker gets CF-Connecting-IP and a cf object", async () => {
    // The contrast that makes the first test mean something: this harness does
    // give a public-style request the header, so its absence over the binding is
    // a property of the binding and not of the runtime leaving it out everywhere.
    // Reaches the first worker (the API), which echoes nothing; ask it for the
    // header it keyed on instead.
    const res = (await mf.dispatchFetch("http://localhost/health", {
      headers: { "X-Forwarded-For": "203.0.113.7" },
    } as never)) as unknown as Response;
    expect(res.status).toBe(200);
    // Counted by the injected CF-Connecting-IP, in the ordinary bucket, with the
    // forged forward ignored.
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("ip");
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(__limits.MAX_REQUESTS));
  });
});

describe("the real limiter, in workerd, over the default entrypoint of the real bundle", () => {
  test("a forwarded visitor is counted in site-ip, and the count survives across calls", async () => {
    const visitor = "203.0.113.21";
    const first = await overBinding("API", "/health", { "X-Forwarded-For": visitor });
    expect(first.status).toBe(200);
    expect(first.bucket).toBe("site-ip");
    expect(first.limit).toBe(String(__limits.SITE_IP_MAX_REQUESTS));
    expect(first.remaining).toBe(String(__limits.SITE_IP_MAX_REQUESTS - 1));

    const second = await overBinding("API", "/health", { "X-Forwarded-For": visitor });
    expect(second.remaining).toBe(String(__limits.SITE_IP_MAX_REQUESTS - 2));
  });

  test("another visitor has a count of their own", async () => {
    const seen = await overBinding("API", "/health", { "X-Forwarded-For": "203.0.113.22" });
    expect(seen.bucket).toBe("site-ip");
    expect(seen.remaining).toBe(String(__limits.SITE_IP_MAX_REQUESTS - 1));
  });

  test("only the first entry of a forwarded chain names the visitor", async () => {
    const chain = await overBinding("API", "/health", {
      "X-Forwarded-For": "203.0.113.23, 10.0.0.1",
    });
    const alone = await overBinding("API", "/health", { "X-Forwarded-For": "203.0.113.23" });
    expect(chain.remaining).toBe(String(__limits.SITE_IP_MAX_REQUESTS - 1));
    expect(alone.remaining).toBe(String(__limits.SITE_IP_MAX_REQUESTS - 2));
  });

  test("a call that forwards no usable visitor shares the unattributed bucket", async () => {
    const none = await overBinding("API", "/health");
    const junk = await overBinding("API", "/health", { "X-Forwarded-For": "not-an-ip" });
    expect(none.bucket).toBe("site-unattributed");
    expect(junk.bucket).toBe("site-unattributed");
    expect(none.limit).toBe(String(__limits.SITE_UNATTRIBUTED_MAX_REQUESTS));
    // One counter: the second call sees one fewer than the first.
    expect(Number(junk.remaining)).toBeLessThan(Number(none.remaining));
  });

  test("CF-Connecting-IP beats X-Forwarded-For when a caller sends both", async () => {
    const seen = await overBinding("API", "/health", {
      "CF-Connecting-IP": "198.51.100.31",
      "X-Forwarded-For": "203.0.113.24",
    });
    expect(seen.bucket).toBe("ip");
    expect(seen.limit).toBe(String(__limits.MAX_REQUESTS));
  });
});
