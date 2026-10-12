/**
 * The headers the limiter puts on an answer survive whatever the handler builds
 * (#1709).
 *
 * They used to be set on the context before the handler ran, and a handler that
 * returns its own `Response` replaces the context's, so the headers vanished
 * while the cache was healthy: an absent `X-RateLimit-Bucket` then meant nothing
 * about the cache. They are set on the finished response now.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { __limits, rateLimiter } from "../src/middleware/rateLimit";
import { InMemoryCache } from "./helpers/cache";
import {
  type AppEnv,
  PROD_ENV,
  edge,
  hit,
  useRateLimitHarness,
  viaBinding,
} from "./helpers/rate-limit-harness";

const h = useRateLimitHarness();

function appWithHandlers(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", rateLimiter);
  app.get("/json", (c) => c.json({ ok: true }));
  app.get("/raw", () => new Response("built by the handler"));
  app.get("/redirect", () => Response.redirect("https://example.test/elsewhere", 302));
  app.get("/boom", () => {
    throw new Error("a handler fault");
  });
  return app;
}

const CAP = __limits.MAX_REQUESTS;

describe("headers on what a handler built", () => {
  test.each(["/json", "/raw", "/redirect"])("%s carries all four", async (path) => {
    const res = await hit(appWithHandlers(), edge("203.0.113.2"), path);
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("ip");
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(CAP));
    expect(res.headers.get("X-RateLimit-Remaining")).toBe(String(CAP - 1));
    expect(res.headers.get("X-RateLimit-Caller")).toBe("edge");
  });

  test("a raw Response keeps its own body and status", async () => {
    const res = await hit(appWithHandlers(), edge("203.0.113.3"), "/raw");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("built by the handler");
  });

  test("a redirect, whose headers are immutable, keeps its Location", async () => {
    const res = await hit(appWithHandlers(), viaBinding("203.0.113.4"), "/redirect");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://example.test/elsewhere");
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("site-ip");
    expect(res.headers.get("X-RateLimit-Caller")).toBe("site");
  });

  test("a response whose headers refuse a write is rebuilt, body and status kept", async () => {
    // What a Response from fetch() looks like in a Worker: its headers are immutable.
    const app = new Hono<AppEnv>();
    app.use("*", rateLimiter);
    app.get("/frozen", () => {
      const res = new Response("from upstream", {
        status: 203,
        headers: { "X-Upstream": "kept" },
      });
      res.headers.set = () => {
        throw new TypeError("immutable");
      };
      return res;
    });
    const res = await hit(app, edge("203.0.113.9"), "/frozen");
    expect(res.status).toBe(203);
    expect(await res.text()).toBe("from upstream");
    expect(res.headers.get("X-Upstream")).toBe("kept");
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("ip");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe(String(CAP - 1));
  });

  test("headers that cannot be set at all leave the answer as the handler made it, and say so once", async () => {
    // A response whose headers refuse every write and cannot be rebuilt either:
    // this must not turn a good answer into a 500.
    const app = new Hono<AppEnv>();
    app.use("*", rateLimiter);
    app.get("/hostile", () => {
      const res = new Response("fine", { status: 202 });
      Object.defineProperty(res, "headers", {
        get() {
          throw new TypeError("headers are unavailable");
        },
      });
      return res;
    });
    for (let i = 0; i < 3; i++) {
      const res = await hit(app, edge("203.0.113.14"), "/hostile");
      expect(res.status).toBe(202);
    }
    const told = h.warn.mock.calls.filter((c) =>
      String(c[0]).includes("could not set the rate limit headers"),
    );
    expect(told.length).toBe(1);
    expect(told[0]?.[1]).toMatchObject({ error: "TypeError" });
  });

  test("an answer to a handler that threw still says what the limiter counted", async () => {
    const res = await hit(appWithHandlers(), edge("203.0.113.5"), "/boom");
    expect(res.status).toBe(500);
    expect(res.headers.get("X-RateLimit-Bucket")).toBe("ip");
  });

  test("the count falls from one raw answer to the next", async () => {
    const app = appWithHandlers();
    const first = await hit(app, edge("203.0.113.6"), "/raw");
    const second = await hit(app, edge("203.0.113.6"), "/raw");
    expect(second.headers.get("X-RateLimit-Remaining")).toBe(
      String(Number(first.headers.get("X-RateLimit-Remaining")) - 1),
    );
  });
});

describe("when the cache fails", () => {
  class FailingCache extends InMemoryCache {
    async match(): Promise<Response | undefined> {
      throw new Error("the cache is down");
    }
  }

  test("the request is served and says nothing it did not count", async () => {
    (globalThis as { caches?: unknown }).caches = { default: new FailingCache() };
    const res = await hit(appWithHandlers(), edge("203.0.113.7"), "/raw");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Bucket")).toBeNull();
    expect(res.headers.get("X-RateLimit-Remaining")).toBeNull();
    expect(res.headers.get("X-RateLimit-Caller")).toBeNull();
  });
});

describe("when the limiter is bypassed", () => {
  test("development counts nothing and says nothing", async () => {
    const res = await hit(appWithHandlers(), edge("203.0.113.8"), "/raw", {
      ...PROD_ENV,
      ENVIRONMENT: "development",
    } as typeof PROD_ENV);
    expect(res.headers.get("X-RateLimit-Bucket")).toBeNull();
  });
});

describe("what a browser may read of the answer", () => {
  test("the rate limit's headers are exposed to cross-origin callers on nemar.org hosts", async () => {
    const { default: worker } = await import("../src/index");
    const res = await worker.fetch(
      new Request("https://api.nemar.org/health", { headers: { Origin: "https://nemar.org" } }),
      { ...PROD_ENV, ENVIRONMENT: "development" } as typeof PROD_ENV,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const exposed = (res.headers.get("Access-Control-Expose-Headers") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase());
    for (const name of [
      "x-request-id",
      "retry-after",
      "x-ratelimit-limit",
      "x-ratelimit-remaining",
      "x-ratelimit-reset",
      "x-ratelimit-bucket",
      "x-ratelimit-caller",
    ]) {
      expect(exposed).toContain(name);
    }
  });
});
