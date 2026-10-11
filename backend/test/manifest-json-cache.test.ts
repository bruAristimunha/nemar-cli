/**
 * The manifest.json response cache (#1522).
 *
 * Unit-level, against the real (in-memory) Cache API implementations
 * `test/helpers/cache.ts` already provides for the manifest and git-file
 * caches, since `bun test` has no `caches.default` of its own. The
 * route-level behavior (the gate runs first, a bucket-policy-excluded
 * dataset uses the same stable URL document, and a private flip is refused
 * before the cache is touched) is covered
 * in `data-route-manifest-stream.test.ts`'s "the manifest.json response
 * cache sits behind the visibility gate" describe block, which drives the
 * real `dataRoutes` app; this file pins the cache module's own contract in
 * isolation: the key shape, hit/miss, ETag-carried headers, and what a
 * faulty or stalled cache costs.
 */

import { describe, expect, test } from "bun:test";
import {
  MANIFEST_JSON_CACHE_STALL_MS,
  manifestJsonCacheKey,
  matchManifestJsonCache,
  scheduleManifestJsonCacheWrite,
} from "../src/services/manifest-json-cache";
import type { ManifestCache } from "../src/services/manifest-source";
import { DrainingCache, InMemoryCache, StalledCache } from "./helpers/cache";

const ORIGIN = "https://data.nemar.org";
const ETAG = '"abc123"';
const OTHER_ETAG = '"def456"';

function body(text: string): string {
  return text;
}

describe("manifestJsonCacheKey", () => {
  test("dataset- and version-scoped, never content-addressed", () => {
    const key = manifestJsonCacheKey(ORIGIN, "nm000132", "v1.1.1");
    expect(key).toBe(`${ORIGIN}/__nemar-internal/manifest-json-cache/v2/nm000132/v1.1.1.json`);
    // A bare version gets the `v` prefix folded in, like manifestCacheKey and
    // gitFileCacheKey.
    expect(manifestJsonCacheKey(ORIGIN, "nm000132", "1.1.1")).toBe(key);
    expect(manifestJsonCacheKey(ORIGIN, "nm000133", "v1.1.1")).not.toBe(key);
    expect(manifestJsonCacheKey(ORIGIN, "nm000132", "v1.1.2")).not.toBe(key);
  });

  test("lives under a path no public data route serves", () => {
    expect(manifestJsonCacheKey(ORIGIN, "nm000132", "v1.1.1")).toContain("/__nemar-internal/");
  });

  test("a different origin is a different key, like the other caches on this data plane", () => {
    const a = manifestJsonCacheKey("https://data.nemar.org", "nm000132", "v1.1.1");
    const b = manifestJsonCacheKey("https://api.nemar.org", "nm000132", "v1.1.1");
    expect(a).not.toBe(b);
  });
});

describe("matchManifestJsonCache", () => {
  const KEY = manifestJsonCacheKey(ORIGIN, "nm000132", "v1.1.1");

  test("an empty cache is a miss", async () => {
    const cache = new InMemoryCache();
    expect(await matchManifestJsonCache(cache, KEY)).toBeNull();
  });

  test("a stored document is a hit, with its etag and client Cache-Control restored", async () => {
    const cache = new InMemoryCache();
    await scheduleManifestJsonCacheWrite(
      { cache, key: KEY, etag: ETAG, body: body("[]"), clientCacheControl: "public, max-age=300" },
      undefined,
    );
    const hit = await matchManifestJsonCache(cache, KEY);
    expect(hit).not.toBeNull();
    expect(hit?.body).toBe("[]");
    expect(hit?.etag).toBe(ETAG);
    expect(hit?.clientCacheControl).toBe("public, max-age=300");
  });

  test("the internal client-Cache-Control marker is never handed back as itself", async () => {
    const cache = new InMemoryCache();
    await scheduleManifestJsonCacheWrite(
      { cache, key: KEY, etag: ETAG, body: body("[]"), clientCacheControl: "public, max-age=300" },
      undefined,
    );
    const raw = await cache.match(new Request(KEY));
    expect(raw?.headers.get("Cache-Control")).toBe(`max-age=${7 * 24 * 60 * 60}`);
    expect(raw?.headers.get("X-Nemar-Cache-Client-Cache-Control")).toBe("public, max-age=300");
  });

  test("the stored copy's OWN freshness is not the client's 300s (mirrors the git-file broker's TTL-bug test)", async () => {
    // Same bug class `git-file-broker.test.ts`'s "the stored copy's OWN
    // freshness is not the client's 300s" test catches: if this module ever
    // reused the client-facing `clientCacheControl` verbatim as the STORED
    // response's own `Cache-Control`, a real Cache API would expire the entry
    // after 300s regardless of the 7-day TTL the module documents
    // (`X-Nemar-Cache-Client-Cache-Control` exists precisely so the two never
    // share one header). `DrainingCache.getNow` simulates the clock advancing
    // without a real five-minute sleep.
    const cache = new DrainingCache();
    await scheduleManifestJsonCacheWrite(
      { cache, key: KEY, etag: ETAG, body: body("[]"), clientCacheControl: "public, max-age=300" },
      undefined,
    );
    const storedAt = Date.now();

    // 301 seconds later: past the CLIENT's 300s Cache-Control, well inside
    // the stored copy's own 7-day TTL.
    cache.getNow = () => storedAt + 301_000;
    const hit = await matchManifestJsonCache(cache, KEY);

    expect(hit).not.toBeNull();
    expect(hit?.body).toBe("[]");
    expect(hit?.etag).toBe(ETAG);
    // Still today's 300s value, not the internal seven-day one.
    expect(hit?.clientCacheControl).toBe("public, max-age=300");
  });

  test("a cache that throws on match is a miss, not a failure", async () => {
    const broken: ManifestCache = {
      match: async () => {
        throw new Error("cache down");
      },
      put: async () => {
        throw new Error("cache down");
      },
    };
    expect(await matchManifestJsonCache(broken, KEY)).toBeNull();
  });

  test("an entry with no ETag is treated as absent", async () => {
    const cache = new InMemoryCache();
    await cache.put(
      new Request(KEY),
      new Response(body("[]"), { status: 200, headers: { "Cache-Control": "max-age=60" } }),
    );
    expect(await matchManifestJsonCache(cache, KEY)).toBeNull();
  });

  // The caller (routes/data.ts) decides freshness by comparing this etag
  // against a fresh conditional GET; this module has no opinion on whether
  // ETAG or OTHER_ETAG is "current". Pinning both here just proves the
  // module hands back whatever etag was stored, unmodified.
  test("hands back exactly the etag it was given, not a canonicalized one", async () => {
    const cache = new InMemoryCache();
    await scheduleManifestJsonCacheWrite(
      {
        cache,
        key: KEY,
        etag: OTHER_ETAG,
        body: body("[]"),
        clientCacheControl: "public, max-age=60",
      },
      undefined,
    );
    expect((await matchManifestJsonCache(cache, KEY))?.etag).toBe(OTHER_ETAG);
  });
});

describe("scheduleManifestJsonCacheWrite", () => {
  const KEY = manifestJsonCacheKey(ORIGIN, "nm000132", "v1.1.1");

  test("with a waitUntil, the write is handed off and this resolves at once", async () => {
    const cache = new StalledCache();
    const deferred: Promise<unknown>[] = [];
    const started = performance.now();
    await scheduleManifestJsonCacheWrite(
      { cache, key: KEY, etag: ETAG, body: body("[]"), clientCacheControl: "public, max-age=300" },
      (work) => deferred.push(work),
    );
    expect(performance.now() - started).toBeLessThan(100);
    expect(cache.puts).toBe(1);
    expect(deferred).toHaveLength(1);
  });

  test("without a waitUntil, a stalled cache is abandoned after the bound, and the call never throws", async () => {
    const cache = new StalledCache();
    const started = performance.now();
    await scheduleManifestJsonCacheWrite(
      { cache, key: KEY, etag: ETAG, body: body("[]"), clientCacheControl: "public, max-age=300" },
      undefined,
    );
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(MANIFEST_JSON_CACHE_STALL_MS);
    expect(elapsed).toBeLessThan(MANIFEST_JSON_CACHE_STALL_MS + 2000);
  });

  test("without a waitUntil, a healthy cache settles well under the stall bound", async () => {
    const cache = new InMemoryCache();
    const started = performance.now();
    await scheduleManifestJsonCacheWrite(
      { cache, key: KEY, etag: ETAG, body: body("[]"), clientCacheControl: "public, max-age=300" },
      undefined,
    );
    expect(performance.now() - started).toBeLessThan(MANIFEST_JSON_CACHE_STALL_MS);
    expect(await matchManifestJsonCache(cache, KEY)).not.toBeNull();
  });

  test("a cache.put that throws never rejects the caller, with or without a waitUntil", async () => {
    const faulty: ManifestCache = {
      match: async () => undefined,
      put: async () => {
        throw new Error("Cache API quota exceeded");
      },
    };
    await expect(
      scheduleManifestJsonCacheWrite(
        {
          cache: faulty,
          key: KEY,
          etag: ETAG,
          body: body("[]"),
          clientCacheControl: "public, max-age=300",
        },
        undefined,
      ),
    ).resolves.toBeUndefined();

    const deferred: Promise<unknown>[] = [];
    await expect(
      scheduleManifestJsonCacheWrite(
        {
          cache: faulty,
          key: KEY,
          etag: ETAG,
          body: body("[]"),
          clientCacheControl: "public, max-age=300",
        },
        (work) => deferred.push(work),
      ),
    ).resolves.toBeUndefined();
    expect(deferred).toHaveLength(1);
    await expect(deferred[0]).resolves.toBeUndefined();
  });

  test("a real DrainingCache round-trip: what is put is what is matched", async () => {
    const cache = new DrainingCache();
    await scheduleManifestJsonCacheWrite(
      {
        cache,
        key: KEY,
        etag: ETAG,
        body: body('[{"path":"README.md"}]'),
        clientCacheControl: "public, max-age=300",
      },
      undefined,
    );
    const hit = await matchManifestJsonCache(cache, KEY);
    expect(hit?.body).toBe('[{"path":"README.md"}]');
    expect(hit?.etag).toBe(ETAG);
  });
});
