/**
 * Requests this Worker makes of itself are not callers (#1709, ADR 0098).
 *
 * An MCP tool reads a dataset's `index.json` through the zarr gateway, and the
 * Neurobagel gatherer reads the data plane, by building a bare `Request` and
 * handing it to the sub-app in process. Such a request carries neither
 * `CF-Connecting-IP` nor `X-Forwarded-For`. It used to get a random bucket, which
 * is no limit at all; once a caller with no address is pooled it would share the
 * data plane's pooled bucket and miss budget with whatever else lacks one, warn on
 * a healthy system, and be answered 429 whenever a public flood filled that pool.
 * They carry a mark the limiter can see and nothing a client sends can claim.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { internalRequest, isInternalRequest } from "../src/lib/internal-request";
import { readZarrIndex } from "../src/mcp/index-reader";
import { __limits, checkDataMissBudget } from "../src/middleware/rateLimit";
import { createZarrDataRoutes } from "../src/routes/zarr-data";
import { gatherNeurobagelInput } from "../src/services/neurobagel-gather";
import type { Bindings } from "../src/types/bindings";
import nm000329Index from "./fixtures/mcp/nm000329-index.json";
import { InMemoryCache } from "./helpers/cache";
import { freshDb, realD1 } from "./helpers/d1";
import { type FixtureServer, startFixtureServer } from "./helpers/fixture-server";
import { T0, buildApp, hit, useRateLimitHarness } from "./helpers/rate-limit-harness";

const h = useRateLimitHarness();

const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const WINDOW_END = T0 + __limits.WINDOW_SIZE * 1000;
const identityLines = () =>
  [...h.log.mock.calls, ...h.warn.mock.calls].filter((c) =>
    String(c[0]).startsWith("[rate-limit]"),
  );

describe("the mark", () => {
  test("is held by the request object, so a copy of a marked request is not marked", () => {
    const marked = internalRequest(new Request("http://localhost/x"));
    expect(isInternalRequest(marked)).toBe(true);
    expect(isInternalRequest(new Request(marked))).toBe(false);
    expect(isInternalRequest(marked.clone())).toBe(false);
    expect(isInternalRequest(new Request("http://localhost/x"))).toBe(false);
  });

  test("cannot be claimed with a header", () => {
    const claimed = new Request("http://localhost/x", {
      headers: {
        "X-Internal": "1",
        "X-RateLimit-Caller": "internal",
        "X-Forwarded-For": "internal",
      },
    });
    expect(isInternalRequest(claimed)).toBe(false);
  });
});

describe("the limiter", () => {
  test("lets an internal request through without counting, pooling or warning", async () => {
    const app = buildApp();
    // The pooled bucket is full: a caller with no address would be refused.
    await h.seed("site-unattributed:unattributed", {
      count: __limits.SITE_UNATTRIBUTED_MAX_REQUESTS,
      warned: false,
      windowEnd: WINDOW_END,
    });
    await h.seed("data-ip:unattributed", {
      count: __limits.DATA_MAX_REQUESTS,
      warned: false,
      windowEnd: WINDOW_END,
    });
    const url = "http://localhost/data/nm000108/v1.0.0/x";
    const internal = await app.fetch(internalRequest(new Request(url)), {
      ENVIRONMENT: "production",
    } as unknown as Bindings);
    expect(internal.status).toBe(200);
    expect(internal.headers.get("X-RateLimit-Bucket")).toBeNull();
    expect(identityLines()).toEqual([]);
    expect((await h.stored("data-ip:unattributed"))?.count).toBe(__limits.DATA_MAX_REQUESTS);

    // A caller that only failed to say who it is gets no such pass.
    const pooled = await hit(app, {}, "/data/nm000108/v1.0.0/x");
    expect(pooled.status).toBe(429);
  });

  test("lets an internal request past the miss budget, and writes nothing", async () => {
    await h.seed("data-miss-ip:unattributed", {
      count: __limits.DATA_MISS_MAX_REQUESTS,
      warned: false,
      windowEnd: WINDOW_END,
    });
    const env = { ENVIRONMENT: "production" } as Pick<
      Bindings,
      "ENVIRONMENT" | "TEST_BYPASS_TOKEN"
    >;
    const request = () => new Request("http://localhost/data/x");
    expect((await checkDataMissBudget(env, internalRequest(request()), undefined)).allowed).toBe(
      true,
    );
    expect((await h.stored("data-miss-ip:unattributed"))?.count).toBe(
      __limits.DATA_MISS_MAX_REQUESTS,
    );
    // No budget of its own either: nothing was written for it.
    expect(await h.stored("data-miss-ip:internal")).toBeUndefined();
    expect(identityLines()).toEqual([]);
    // Control: the same request unmarked is the pooled caller, and is refused.
    expect((await checkDataMissBudget(env, request(), undefined)).allowed).toBe(false);
  });
});

describe("MCP index reads go through the real zarr sub-app", () => {
  const ID = "nm000329";
  let db: Database;
  let server: FixtureServer;
  let zarrApp: ReturnType<typeof createZarrDataRoutes>;
  let env: Bindings;

  beforeAll(() => {
    server = startFixtureServer({
      [`${ID}/zarr/index.json`]: new TextEncoder().encode(JSON.stringify(nm000329Index)),
    });
    zarrApp = createZarrDataRoutes({
      cache: () => new InMemoryCache(),
      fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
      s3Base: server.url,
    });
  });
  afterAll(() => server.stop());

  beforeEach(() => {
    db = freshDb();
    // Production, so the limiter really runs in the zarr sub-app.
    env = { DB: realD1(db), ENVIRONMENT: "production" } as unknown as Bindings;
    db.query(
      `INSERT INTO datasets (dataset_id, owner_user_id, name, visibility, status, is_sandbox)
       VALUES (?, -1, ?, 'public', 'active', 0)`,
    ).run(ID, ID);
  });

  test("a read is served while the pooled data-plane bucket is full, and warns of nothing", async () => {
    await h.seed("data-ip:unattributed", {
      count: __limits.DATA_MAX_REQUESTS,
      warned: false,
      windowEnd: WINDOW_END,
    });
    const result = await readZarrIndex({ zarrRoutes: zarrApp }, env, ctx, ID);
    expect(result.status).toBe("ok");
    expect(identityLines()).toEqual([]);
    expect((await h.stored("data-ip:unattributed"))?.count).toBe(__limits.DATA_MAX_REQUESTS);
  });

  test("control: the same read as an unmarked caller is refused by the pooled bucket", async () => {
    await h.seed("data-ip:unattributed", {
      count: __limits.DATA_MAX_REQUESTS,
      warned: false,
      windowEnd: WINDOW_END,
    });
    const res = await zarrApp.fetch(new Request(`${server.url}/${ID}/zarr/index.json`), env, ctx);
    expect(res.status).toBe(429);
  });
});

describe("the Neurobagel gatherer's data-plane requests", () => {
  test("are all marked as the Worker's own", async () => {
    const seen: Request[] = [];
    await expect(
      gatherNeurobagelInput({ ENVIRONMENT: "production" } as unknown as Bindings, "nm000108", {
        dataPlane: async (request) => {
          seen.push(request);
          return new Response("", { status: 404 });
        },
      }),
    ).rejects.toThrow();
    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) expect(isInternalRequest(request)).toBe(true);
  });
});
