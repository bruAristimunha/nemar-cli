/**
 * data.nemar.org end to end over a streamed manifest (#1502): the real
 * `dataRoutes` app, a real D1 (every migration applied), and a real local
 * HTTP server standing in for S3 through `S3_ENDPOINT_URL`.
 *
 * Every route that used to call `loadManifest` is driven here, and every
 * expectation is computed by the WHOLE-PARSE reference functions over
 * `JSON.parse` of the same bytes the server is serving (`resolveFile`,
 * `diffRemovedSince`, `findLastSeenVersion`, `renderIndexHtml`,
 * `digestManifest`). So each test asks one question: does the route, reading
 * the manifest as a stream, answer byte for byte what the parse-it-whole
 * route answered?
 *
 * Two manifests:
 *  - nm000132's real published v1.1.1 manifest, and a v1.0.0 derived from it
 *    by ADDING a few entries, so v1.1.1 has "removed" files for the tombstone
 *    walk and the "removed since" footer (the real v1.0.0 lists the same
 *    paths as v1.1.1, so it cannot exercise either);
 *  - a generated 150,000-entry manifest in nm000281's measured shape
 *    (`helpers/large-manifest.ts`), 63 MB, where the route's memory is
 *    sampled while it answers and the manifest.json bound is reached.
 */

import { heapStats } from "bun:jsc";
import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { MAX_MANIFEST_JSON_ENTRIES, dataRoutes } from "../src/routes/data";
import { addPrivateDataset, buildPublicAccessPolicy } from "../src/services/bucket-policy";
import {
  buildBytesUrl,
  contentTypeForBidsPath,
  diffRemovedSince,
  digestManifest,
  findLastSeenVersion,
  renderIndexHtml,
  resolveFile,
  toHttpDate,
} from "../src/services/data-router";
import { gitFileCacheKey } from "../src/services/git-file-cache";
import type { ManifestFile, VersionManifest } from "../src/services/manifest";
import { manifestJsonCacheKey } from "../src/services/manifest-json-cache";
import {
  MANIFEST_TRUST_WINDOW_MS,
  manifestCacheKey,
  resetManifestAnswerMemo,
} from "../src/services/manifest-source";
import type { Bindings, Variables } from "../src/types/bindings";
import { DrainingCache, StalledCache } from "./helpers/cache";
import { freshDb, realD1 } from "./helpers/d1";
import {
  LARGE_MANIFEST_TEST_TIMEOUT_MS,
  largeManifestEntryCount,
  largeManifestPaths,
  largeManifestText,
} from "./helpers/large-manifest";
import { type S3ManifestStandin, startS3ManifestStandin } from "./helpers/s3-manifest-standin";

const CURRENT_TEXT = readFileSync(
  join(import.meta.dir, "fixtures/manifest-nm000132-v1.1.1.json"),
  "utf8",
);
const CURRENT: VersionManifest = JSON.parse(CURRENT_TEXT);

/** v1.0.0: the real v1.1.1 plus three entries that v1.1.1 no longer has. */
const REMOVED_FILE = "sub-001/eeg/sub-001_task-ERN_desc-old_eeg.set";
const REMOVED_ROOT = "CITATION.cff";
const REMOVED_DIR_FILE = "sub-999/eeg/sub-999_task-ERN_eeg.set";
const PRIOR: VersionManifest = {
  ...CURRENT,
  version: "1.0.0",
  files: Object.fromEntries(
    [
      ...Object.entries(CURRENT.files),
      [REMOVED_FILE, { key: "SHA256E-s10--aaaa.set", size: 10, checksum: "sha256:aaaa" }],
      [REMOVED_ROOT, { key: "git:bbbb", size: 20, checksum: "git:bbbb" }],
      [REMOVED_DIR_FILE, { key: "SHA256E-s30--cccc.set", size: 30, checksum: "sha256:cccc" }],
    ].sort(([a], [b]) => ((a as string) < (b as string) ? -1 : 1)),
  ),
};
const PRIOR_TEXT = JSON.stringify(PRIOR, null, 2);

const SMALL = "nm000132";
const SMALL_OBJECT = `/${SMALL}/version/v1.1.1.json`;
const LARGE_ID = "nm000281";
const LARGE_OPTS = { subjects: 374, runsPerSession: 50, datasetId: LARGE_ID };
// Sized above the former presigned bound and below the shared 38,000 bound:
// 88 subjects * 401 entries/subject + 5 root entries = 35,293.
const MID_ID = "nm000283";
const MID_OPTS = { subjects: 88, runsPerSession: 50, datasetId: MID_ID };

let s3: S3ManifestStandin;
let db: Database;
let largeText: string;
let large: VersionManifest;

function seed(id: string, visibility: "public" | "private", versions: [string, string][]): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox)
     VALUES (?, ?, 1, 'active', ?, 0)`,
  ).run(id, id, visibility);
  for (const [version, createdAt] of versions) {
    db.prepare(
      `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at)
       VALUES (?, ?, ?, 'ezid', ?)`,
    ).run(id, version, `10.5072/FK2${id}${version}`, createdAt);
  }
}

beforeAll(() => {
  s3 = startS3ManifestStandin();
  largeText = largeManifestText(LARGE_OPTS);
  large = JSON.parse(largeText);
  s3.put(`/${LARGE_ID}/version/v1.0.3.json`, largeText);
  s3.put(`/${MID_ID}/version/v1.0.0.json`, largeManifestText(MID_OPTS));
});

afterAll(() => {
  s3.stop();
});

beforeEach(() => {
  db = freshDb();
  seed(SMALL, "public", [
    ["1.0.0", "2026-03-14 12:20:43"],
    ["1.1.1", "2026-04-04 06:05:15"],
  ]);
  seed(LARGE_ID, "public", [["1.0.3", "2026-08-31 00:21:32"]]);
  s3.put(`/${SMALL}/version/v1.1.1.json`, CURRENT_TEXT);
  s3.put(`/${SMALL}/version/v1.0.0.json`, PRIOR_TEXT);
  s3.log.length = 0;
  // No bucket policy is required to construct a public manifest; this fixture
  // remains available to assert that an exclusion does not change its URLs.
  s3.setBucketPolicy(null);
  // The per-isolate answer memo (#1494 amendment) is a module-level
  // singleton, and `bun test` at the repo root runs every test file in ONE
  // process (.memory/bun-test-shared-process-root-and-backend.md) -- without
  // this, a memo entry from one test (or another test FILE, since nm000132's
  // fixture and its ETag are shared across suites) could answer a later
  // test's request instead of the fresh D1 row and S3 object that test just
  // set up.
  resetManifestAnswerMemo();
});

function app(): Hono<{ Bindings: Bindings; Variables: Variables }> {
  const hono = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  hono.route("/", dataRoutes);
  return hono;
}

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    DATA_BASE_URL: "https://data.nemar.org",
    S3_ENDPOINT_URL: s3.url,
    S3_BUCKET: "nemar",
    AWS_REGION: "us-east-2",
    AWS_ACCESS_KEY_ID: "AKIATEST",
    AWS_SECRET_ACCESS_KEY: "secret",
  } as Bindings;
}

async function get(path: string, init: RequestInit = {}): Promise<Response> {
  return app().request(`https://data.nemar.org${path}`, init, env());
}

/**
 * The S3 requests made for one dataset's objects since the log was last
 * cleared, as `GET [INM ]<status> <path>`. The stand-in is shared by the whole
 * file, so a test counts its own dataset's reads and never the whole log: a
 * test that timed out keeps running (Bun does not stop it) and its reads of
 * another dataset can land in a later test's window.
 */
function readsOf(datasetId: string): string[] {
  return s3.log
    .filter((r) => r.path.startsWith(`/${datasetId}/`))
    .map((r) => `${r.method} ${r.ifNoneMatch ? "INM " : ""}${r.status} ${r.path}`);
}

/**
 * Monkey-patches `Date.now` forward by `ms` for the duration of `fn`, so a
 * route-level test can push a cached manifest copy outside the trust window
 * (#1494 amendment) without a real sleep. The route builds its own
 * `ManifestSource` from scratch per request (`queryManifest` in
 * `routes/data.ts`) with no clock seam exposed to a caller -- unlike
 * `manifest-source.test.ts`'s direct `ManifestSource.now`, which is the seam
 * to prefer when a test does not need a real HTTP round trip -- so this is
 * the one place in this suite that reaches for the global clock directly.
 */
async function withClockAdvanced<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => real() + ms;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

const JSON_ACCEPT = { headers: { Accept: "application/json" } };
const HTML_ACCEPT = { headers: { Accept: "text/html" } };

describe("file and directory requests answer what the whole parse answered", () => {
  const ANNEX = Object.keys(CURRENT.files).find((p) => !CURRENT.files[p].key.startsWith("git:"));
  const GIT = "participants.tsv";

  test("HEAD on an annexed file carries the manifest's size, checksum and date", async () => {
    if (!ANNEX) throw new Error("fixture has no annexed file");
    const res = await get(`/${SMALL}/v1.1.1/${ANNEX}`, { method: "HEAD" });
    expect(res.status).toBe(200);
    const file = CURRENT.files[ANNEX];
    expect(res.headers.get("Content-Length")).toBe(String(file.size));
    expect(res.headers.get("ETag")).toBe(`"${file.checksum}"`);
    expect(res.headers.get("Last-Modified")).toBe(toHttpDate(CURRENT.created));
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(res.headers.get("Content-Type")).toBe(contentTypeForBidsPath(ANNEX));
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
  });

  test("HEAD on a git-tracked file adds the inert content type", async () => {
    const res = await get(`/${SMALL}/v1.1.1/${GIT}`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(contentTypeForBidsPath(GIT));
    expect(res.headers.get("ETag")).toBe(`"${CURRENT.files[GIT].checksum}"`);
  });

  test("HEAD on a directory and on a missing path", async () => {
    const dir = await get(`/${SMALL}/v1.1.1/sub-001/`, { method: "HEAD" });
    expect(dir.status).toBe(200);
    expect(dir.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const missing = await get(`/${SMALL}/v1.1.1/${REMOVED_FILE}`, { method: "HEAD" });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe("public, max-age=60");
  });

  for (const dir of ["", "sub-001", "sub-001/eeg", "stimuli", "code"]) {
    test(`JSON listing of /${dir}`, async () => {
      const res = await get(`/${SMALL}/v1.1.1/${dir}${dir ? "/" : ""}`, JSON_ACCEPT);
      expect(res.status).toBe(200);
      const resolved = resolveFile(CURRENT, dir);
      if (resolved.kind !== "directory") throw new Error("expected a directory");
      expect(await res.text()).toBe(
        JSON.stringify({
          dataset_id: SMALL,
          version: "v1.1.1",
          path: resolved.path,
          kind: "directory",
          children: resolved.children,
        }),
      );
      expect(res.headers.get("Vary")).toBe("Accept");
    });

    test(`HTML listing of /${dir}, footer and picker included`, async () => {
      const res = await get(`/${SMALL}/v1.1.1/${dir}${dir ? "/" : ""}`, HTML_ACCEPT);
      expect(res.status).toBe(200);
      const resolved = resolveFile(CURRENT, dir);
      if (resolved.kind !== "directory") throw new Error("expected a directory");
      const removed = diffRemovedSince(resolved.children, PRIOR, resolved.path);
      expect(await res.text()).toBe(
        renderIndexHtml({
          datasetId: SMALL,
          version: "v1.1.1",
          path: resolved.path,
          entries: resolved.children,
          availableVersions: [
            { version: "v1.1.1", isCurrent: true },
            { version: "v1.0.0", isCurrent: false },
          ],
          removedSinceNote:
            removed.length > 0 ? { lastSeenVersion: "v1.0.0", names: removed } : null,
        }),
      );
    });
  }

  // Without this, the footer comparisons above could all be comparing two
  // empty footers.
  test("the footer really fires where v1.0.0 had more", async () => {
    const root = resolveFile(CURRENT, "");
    if (root.kind !== "directory") throw new Error("expected a directory");
    expect(diffRemovedSince(root.children, PRIOR, "")).toEqual([REMOVED_ROOT, "sub-999"]);
    const html = await (await get(`/${SMALL}/v1.1.1/`, HTML_ACCEPT)).text();
    expect(html).toContain("Files removed since v1.0.0 (2)");
  });

  test("a file removed since v1.0.0 answers the tombstone", async () => {
    // The trailing-slash form is the one the walk has to strip before it asks.
    for (const path of [REMOVED_FILE, REMOVED_ROOT, REMOVED_DIR_FILE, `${REMOVED_FILE}/`]) {
      const res = await get(`/${SMALL}/v1.1.1/${path}`);
      expect(res.status).toBe(404);
      const lastSeen = await findLastSeenVersion({
        path: path.replace(/\/+$/, ""),
        olderVersions: ["v1.0.0"],
        loadManifest: async (v) => (v === "v1.0.0" ? PRIOR : null),
      });
      expect(lastSeen).toEqual({ version: "v1.0.0" });
      expect(await res.json()).toEqual({
        error: "File not found",
        version: "v1.1.1",
        path,
        reason: "removed",
        last_seen_version: "v1.0.0",
        last_seen_url: `https://data.nemar.org/${SMALL}/v1.0.0/${path}`,
      });
    }
  });

  // Synthetic: no real manifest has a null entry, and the old route answered
  // one with a TypeError, i.e. a 500. What must not happen is that error
  // being swallowed as a failed read and relabeled "Version not published".
  test("a null entry still reaches the error handler, as it did", async () => {
    const text =
      '{"version":"1.0.0","created":"2026-01-01T00:00:00Z","files":{"d/a":null,"e/b":{"key":"git:1","size":1,"checksum":"git:1"}}}';
    seed("nm000903", "public", [["1.0.0", "2026-01-01 00:00:00"]]);
    s3.put("/nm000903/version/v1.0.0.json", text);
    expect(() => resolveFile(JSON.parse(text), "d")).toThrow(TypeError);
    expect((await get("/nm000903/v1.0.0/d/?format=json")).status).toBe(500);
    expect((await get("/nm000903/v1.0.0/e/?format=json")).status).toBe(200);
  });

  test("a path that never existed is a plain 404", async () => {
    const res = await get(`/${SMALL}/v1.1.1/sub-001/never.txt`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "File not found",
      version: "v1.1.1",
      path: "sub-001/never.txt",
    });
  });

  test("a broken manifest is 'Version not published', not a partial answer", async () => {
    s3.put(`/${SMALL}/version/v1.1.1.json`, `${CURRENT_TEXT.slice(0, -2)}`);
    for (const path of ["", "participants.tsv", "sub-001/"]) {
      const res = await get(`/${SMALL}/v1.1.1/${path}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Version not published" });
    }
  });
});

describe("manifest.json", () => {
  test("below the bound, every entry uses its stable data-plane URL", async () => {
    const res = await get(`/${SMALL}/v1.1.1/manifest.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    const entries = (await res.json()) as {
      path: string;
      size: number;
      checksum_algorithm: string;
      checksum: string;
      url: string | null;
      bytes_url: string;
    }[];
    const expected = Object.entries(CURRENT.files);
    expect(entries.map((e) => e.path)).toEqual(expected.map(([p]) => p));
    for (const [i, [path, file]] of expected.entries()) {
      const e = entries[i];
      expect(e.size).toBe(file.size);
      expect(`${e.checksum_algorithm}:${e.checksum}`).toBe(file.checksum);
      expect(e.bytes_url).toBe(
        buildBytesUrl({
          datasetId: SMALL,
          version: "v1.1.1",
          bidsPath: path,
          origin: "https://data.nemar.org",
        }),
      );
      expect(e.url).toBe(e.bytes_url);
    }
  });

  test("the field set and order are pinned against today's contract", async () => {
    const res = await get(`/${SMALL}/v1.1.1/manifest.json`);
    const entries = (await res.json()) as Record<string, unknown>[];
    expect(entries.length).toBeGreaterThan(0);
    const annex = entries.find((e) => !CURRENT.files[e.path]?.key.startsWith("git:"));
    const git = entries.find((e) => CURRENT.files[e.path]?.key.startsWith("git:"));
    expect(annex).toBeDefined();
    expect(git).toBeDefined();
    expect(annex?.url).toBe(annex?.bytes_url);
    expect(git?.url).toBe(git?.bytes_url);
    // Object.keys reflects INSERTION order, which is what JSON.stringify
    // serializes -- this is the same order external consumers (the eegdash
    // viewer, third-party downloaders, nemar-py) see on the wire. Neither
    // row carries `error`: both URLs build successfully today.
    const expectedOrder = ["path", "size", "checksum_algorithm", "checksum", "bytes_url", "url"];
    expect(Object.keys(annex as Record<string, unknown>)).toEqual(expectedOrder);
    expect(Object.keys(git as Record<string, unknown>)).toEqual(expectedOrder);
  });

  test("a dataset excluded by bucket policy still emits stable data-plane URLs", async () => {
    s3.setBucketPolicy(addPrivateDataset(buildPublicAccessPolicy("nemar", []), "nemar", SMALL));
    const res = await get(`/${SMALL}/v1.1.1/manifest.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    const entries = (await res.json()) as { url: string | null; bytes_url: string }[];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.url === entry.bytes_url)).toBe(true);
  });

  test(
    `above ${MAX_MANIFEST_JSON_ENTRIES} entries it refuses, naming the listing`,
    async () => {
      expect(Object.keys(large.files).length).toBeGreaterThan(MAX_MANIFEST_JSON_ENTRIES);
      for (const version of ["v1.0.3", "latest"]) {
        const res = await get(`/${LARGE_ID}/${version}/manifest.json`);
        expect(res.status).toBe(413);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.dataset_id).toBe(LARGE_ID);
        expect(body.version).toBe("v1.0.3");
        expect(body.limit).toBe(MAX_MANIFEST_JSON_ENTRIES);
        expect(body.listing_url).toBe(`https://data.nemar.org/${LARGE_ID}/v1.0.3/?format=json`);
        expect(String(body.error)).toContain(String(body.listing_url));
        // And the listing it names does work.
        const listing = await get(`/${LARGE_ID}/v1.0.3/?format=json`);
        expect(listing.status).toBe(200);
      }
    },
    LARGE_MANIFEST_TEST_TIMEOUT_MS,
  );

  test(
    "one 38,000-entry bound applies regardless of bucket policy",
    async () => {
      const midCount = largeManifestEntryCount(MID_OPTS);
      expect(midCount).toBeLessThan(MAX_MANIFEST_JSON_ENTRIES);
      seed(MID_ID, "public", [["1.0.0", "2026-09-01 00:00:00"]]);

      // Bucket policy does not affect URL construction or the manifest bound.
      s3.setBucketPolicy(addPrivateDataset(buildPublicAccessPolicy("nemar", []), "nemar", MID_ID));
      const presigned = await get(`/${MID_ID}/v1.0.0/manifest.json`);
      expect(presigned.status).toBe(200);
      const entries = (await presigned.json()) as { url: string | null; bytes_url: string }[];
      expect(entries.length).toBe(midCount);
      expect(entries.every((entry) => entry.url === entry.bytes_url)).toBe(true);

      s3.setBucketPolicy(null);
      const unsigned = await get(`/${MID_ID}/v1.0.0/manifest.json`);
      expect(unsigned.status).toBe(200);
      expect(await unsigned.text()).toBe(JSON.stringify(entries));
    },
    LARGE_MANIFEST_TEST_TIMEOUT_MS,
  );

  test(
    "through the /data mount, the listing URL keeps the mount",
    async () => {
      const mounted = new Hono<{ Bindings: Bindings; Variables: Variables }>();
      mounted.route("/data", dataRoutes);
      const res = await mounted.request(
        `https://api.nemar.org/data/${LARGE_ID}/latest/manifest.json`,
        {},
        env(),
      );
      expect(res.status).toBe(413);
      expect(((await res.json()) as { listing_url: string }).listing_url).toBe(
        `https://api.nemar.org/data/${LARGE_ID}/v1.0.3/?format=json`,
      );
    },
    LARGE_MANIFEST_TEST_TIMEOUT_MS,
  );
});

describe("the manifest.json response cache sits behind the visibility gate", () => {
  let cache: DrainingCache;
  let original: unknown;

  beforeAll(() => {
    original = (globalThis as { caches?: unknown }).caches;
  });

  beforeEach(() => {
    cache = new DrainingCache();
    (globalThis as { caches?: unknown }).caches = { default: cache };
  });

  afterAll(() => {
    (globalThis as { caches?: unknown }).caches = original;
  });

  test("a hit within the window makes zero S3 calls (#1494 amendment)", async () => {
    const first = await get(`/${SMALL}/v1.1.1/manifest.json`);
    expect(first.status).toBe(200);
    const key = manifestJsonCacheKey("https://data.nemar.org", SMALL, "v1.1.1");
    expect(cache.store.has(key)).toBe(true);
    s3.log.length = 0;
    const second = await get(`/${SMALL}/v1.1.1/manifest.json`);
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(await first.clone().text());
    expect(second.headers.get("Cache-Control")).toBe("public, max-age=300");
    // The freshness check rides the entry-count query's own ETag rather than
    // a conditional GET of its own; that query goes through the manifest
    // trust window (manifest-source.ts) exactly like any other query, so a
    // hit confirmed within the window costs no S3 call at all -- not even
    // the single conditional GET a rebuilt-from-scratch response would have
    // needed.
    expect(readsOf(SMALL)).toEqual([]);
  });

  test("a hit past the window still costs exactly one conditional GET", async () => {
    const first = await get(`/${SMALL}/v1.1.1/manifest.json`);
    expect(first.status).toBe(200);
    const key = manifestJsonCacheKey("https://data.nemar.org", SMALL, "v1.1.1");
    expect(cache.store.has(key)).toBe(true);
    s3.log.length = 0;
    const second = await withClockAdvanced(MANIFEST_TRUST_WINDOW_MS + 1_000, () =>
      get(`/${SMALL}/v1.1.1/manifest.json`),
    );
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(await first.clone().text());
    expect(second.headers.get("Cache-Control")).toBe("public, max-age=300");
    // Once the window has passed, the count query pays one conditional GET
    // to confirm the ETag (and restamp the copy's window) -- and nothing
    // else: no second, uncached read of the raw manifest object.
    expect(readsOf(SMALL)).toEqual([`GET INM 304 ${SMALL_OBJECT}`]);
  });

  test("a manifest rewrite invalidates the cached document only once the window passes", async () => {
    const first = await get(`/${SMALL}/v1.1.1/manifest.json`);
    const firstText = await first.text();
    const key = manifestJsonCacheKey("https://data.nemar.org", SMALL, "v1.1.1");
    expect(cache.store.has(key)).toBe(true);
    const rewritten: VersionManifest = {
      ...CURRENT,
      files: {
        ...CURRENT.files,
        "NEW-FILE.txt": {
          key: "git:cafefacecafeface00000000000000000000ff",
          size: 1,
          checksum: "git:cafe",
        },
      },
    };
    s3.put(`/${SMALL}/version/v1.1.1.json`, JSON.stringify(rewritten, null, 2));

    // Still inside the trust window: the count query answers from the
    // now-stale-but-still-trusted edge copy (or its own memo entry keyed
    // under the old ETag) without asking S3, so the rewrite is invisible and
    // the response cache still serves the OLD document -- the same bounded
    // staleness every other reader of this manifest already accepts
    // (manifest-source.ts), never later than the window.
    const stillCached = await get(`/${SMALL}/v1.1.1/manifest.json`);
    expect(await stillCached.text()).toBe(firstText);

    // Past the window: the count query's own conditional GET sees the new
    // ETag, the response cache is rejected, and the document is rebuilt from
    // the rewrite.
    const second = await withClockAdvanced(MANIFEST_TRUST_WINDOW_MS + 1_000, () =>
      get(`/${SMALL}/v1.1.1/manifest.json`),
    );
    const secondText = await second.text();
    expect(secondText).not.toBe(firstText);
    const entries = JSON.parse(secondText) as { path: string }[];
    expect(entries.some((e) => e.path === "NEW-FILE.txt")).toBe(true);
  });

  test("a dataset gone private is refused before the cache or S3 is touched", async () => {
    await get(`/${SMALL}/v1.1.1/manifest.json`);
    expect(cache.store.size).toBeGreaterThan(0);
    db.prepare("UPDATE datasets SET visibility = 'private' WHERE dataset_id = ?").run(SMALL);
    const matchesBefore = cache.matches;
    s3.log.length = 0;
    const res = await get(`/${SMALL}/v1.1.1/manifest.json`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Dataset not found" });
    expect(cache.matches).toBe(matchesBefore);
    expect(readsOf(SMALL)).toEqual([]);
  });

  test("a bucket-policy-excluded dataset's stable URL document is cached", async () => {
    s3.setBucketPolicy(addPrivateDataset(buildPublicAccessPolicy("nemar", []), "nemar", SMALL));
    const res = await get(`/${SMALL}/v1.1.1/manifest.json`);
    expect(res.status).toBe(200);
    const key = manifestJsonCacheKey("https://data.nemar.org", SMALL, "v1.1.1");
    expect(cache.store.has(key)).toBe(true);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    const entries = (await res.json()) as { url: string | null; bytes_url: string }[];
    expect(entries.every((entry) => entry.url === entry.bytes_url)).toBe(true);
  });

  test("changing bucket policy leaves the cached stable URL contract unchanged", async () => {
    const annexPath = Object.keys(CURRENT.files).find(
      (p) => !CURRENT.files[p].key.startsWith("git:"),
    );
    if (!annexPath) throw new Error("fixture has no annexed file");

    // Warm the deterministic response cache.
    const first = await get(`/${SMALL}/v1.1.1/manifest.json`);
    expect(first.status).toBe(200);
    const key = manifestJsonCacheKey("https://data.nemar.org", SMALL, "v1.1.1");
    expect(cache.store.has(key)).toBe(true);
    const firstAnnex = (
      JSON.parse(await first.text()) as { path: string; url: string | null }[]
    ).find((e) => e.path === annexPath);
    expect(firstAnnex?.url).not.toBeNull();
    expect(firstAnnex?.url).toBe(firstAnnex?.bytes_url);

    // The bucket policy now excludes the dataset from public read.
    s3.setBucketPolicy(addPrivateDataset(buildPublicAccessPolicy("nemar", []), "nemar", SMALL));

    // The policy does not change stable route URLs or their 300-second cache.
    const second = await get(`/${SMALL}/v1.1.1/manifest.json`);
    expect(second.status).toBe(200);
    const secondAnnex = (
      JSON.parse(await second.text()) as { path: string; url: string | null }[]
    ).find((e) => e.path === annexPath);
    expect(secondAnnex?.url).not.toBeNull();
    expect(secondAnnex?.url).toBe(secondAnnex?.bytes_url);
    expect(secondAnnex?.url).toBe(firstAnnex?.url);
    expect(second.headers.get("Cache-Control")).toBe("public, max-age=300");
  });
});

describe("metadata.json", () => {
  interface MetadataShape {
    sessions: string[];
    sessions_count: number | null;
    data_summary: { total_files: number; size_bytes: number } | null;
    extensions: { nemar: { bids_index: { version: string; subjects: unknown } | null } };
  }

  for (const [id, manifest] of [
    [SMALL, () => CURRENT],
    [LARGE_ID, () => large],
  ] as const) {
    test(
      `${id}: the manifest-derived fields equal digestManifest's`,
      async () => {
        const res = await get(`/${id}/metadata.json`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as MetadataShape;
        const digest = digestManifest(manifest());
        expect(body.data_summary?.total_files).toBe(digest.files);
        expect(body.data_summary?.size_bytes).toBe(digest.bytes);
        expect(body.sessions).toEqual(digest.sessions);
        expect(body.sessions_count).toBe(
          digest.sessions.length > 0 ? digest.sessions.length : null,
        );
        expect(body.extensions.nemar.bids_index).toEqual({
          version: `v${manifest().version}`,
          subjects: digest.subjects,
        });
      },
      LARGE_MANIFEST_TEST_TIMEOUT_MS,
    );
  }

  // Synthetic: every real manifest is sorted. An unsorted one cannot be proven
  // free of repeated keys without keeping every key, so its totals come from
  // the catalog row (as for an unreadable manifest) and nothing reads it twice.
  test("an unsorted manifest keeps its index and takes its totals from the catalog row", async () => {
    const unsorted: VersionManifest = {
      ...CURRENT,
      files: Object.fromEntries(Object.entries(CURRENT.files).reverse()),
    };
    seed("nm000909", "public", [["1.1.1", "2026-04-04 06:05:15"]]);
    db.prepare("UPDATE datasets SET file_size = ?, total_files = ? WHERE dataset_id = ?").run(
      123456,
      789,
      "nm000909",
    );
    s3.put("/nm000909/version/v1.1.1.json", JSON.stringify(unsorted));
    const res = await get("/nm000909/metadata.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as MetadataShape;
    const digest = digestManifest(unsorted);
    expect(body.data_summary?.total_files).toBe(789);
    expect(body.data_summary?.size_bytes).toBe(123456);
    expect(body.sessions).toEqual(digest.sessions);
    expect(body.extensions.nemar.bids_index?.subjects).toEqual(digest.subjects);
    expect(readsOf("nm000909")).toEqual(["GET 200 /nm000909/version/v1.1.1.json"]);
  });
});

describe("the large manifest: answers, and memory that does not follow it", () => {
  function liveBytes(): number {
    Bun.gc(true);
    const h = heapStats();
    return h.heapSize + h.extraMemorySize;
  }

  /** Run a request while sampling live memory every few milliseconds. */
  async function sampled(run: () => Promise<Response>) {
    const baseline = liveBytes();
    const samples: number[] = [];
    const timer = setInterval(() => samples.push(liveBytes()), 3);
    try {
      const res = await run();
      const body = await res.text();
      return {
        res,
        body,
        peak: Math.max(...samples, baseline) - baseline,
        samples: samples.length,
      };
    } finally {
      clearInterval(timer);
    }
  }

  // The case #1502's first fix still read whole: keys out of order. The
  // metadata digest used to materialize the manifest for it.
  const DESCENDING_ID = "nm000282";
  beforeAll(() => {
    s3.put(
      `/${DESCENDING_ID}/version/v1.0.3.json`,
      largeManifestText({ ...LARGE_OPTS, datasetId: DESCENDING_ID, descending: true }),
    );
  });

  test(
    "metadata.json over the large manifest in descending order stays flat",
    async () => {
      seed(DESCENDING_ID, "public", [["1.0.3", "2026-08-31 00:21:32"]]);
      db.prepare("UPDATE datasets SET total_files = ? WHERE dataset_id = ?").run(42, DESCENDING_ID);
      const { res, body, peak, samples } = await sampled(() =>
        get(`/${DESCENDING_ID}/metadata.json`),
      );
      expect(res.status).toBe(200);
      const doc = JSON.parse(body) as {
        data_summary: { total_files: number } | null;
        extensions: { nemar: { bids_index: { subjects: unknown } | null } };
      };
      expect(doc.data_summary?.total_files).toBe(42);
      expect(doc.extensions.nemar.bids_index?.subjects).toEqual(digestManifest(large).subjects);
      expect(samples).toBeGreaterThan(3);
      expect(peak).toBeLessThan(16 * 1024 * 1024);
      expect(readsOf(DESCENDING_ID)).toEqual([`GET 200 /${DESCENDING_ID}/version/v1.0.3.json`]);
    },
    LARGE_MANIFEST_TEST_TIMEOUT_MS,
  );

  const paths = [...largeManifestPaths(LARGE_OPTS)];
  // An annexed recording deep in the manifest. HEAD remains metadata-only;
  // GET storage acceptance needs an isolated non-synthetic S3 sample.
  const deep = paths.slice(123_457).find((p) => p.endsWith(".bdf")) as string;

  test(
    "a file, a directory and a miss, each against the reference",
    async () => {
      const head = await get(`/${LARGE_ID}/v1.0.3/${deep}`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("Content-Length")).toBe(String(large.files[deep].size));
      expect(head.headers.get("ETag")).toBe(`"${large.files[deep].checksum}"`);

      const dir = deep.split("/").slice(0, -1).join("/");
      const listing = await get(`/${LARGE_ID}/v1.0.3/${dir}/?format=json`);
      const resolved = resolveFile(large, dir);
      if (resolved.kind !== "directory") throw new Error("expected a directory");
      expect(await listing.text()).toBe(
        JSON.stringify({
          dataset_id: LARGE_ID,
          version: "v1.0.3",
          path: dir,
          kind: "directory",
          children: resolved.children,
        }),
      );

      const miss = await get(`/${LARGE_ID}/v1.0.3/sub-000/nope.tsv`);
      expect(miss.status).toBe(404);
    },
    LARGE_MANIFEST_TEST_TIMEOUT_MS,
  );

  test(
    "the route's peak memory is a small fraction of the manifest",
    async () => {
      const bytes = new TextEncoder().encode(largeText).length;
      expect(bytes).toBeGreaterThan(55_000_000);
      for (const run of [
        () => get(`/${LARGE_ID}/v1.0.3/${deep}`, { method: "HEAD" }),
        () => get(`/${LARGE_ID}/v1.0.3/sub-200/ses-01/emg/`, HTML_ACCEPT),
        () => get(`/${LARGE_ID}/metadata.json`),
        () => get(`/${LARGE_ID}/v1.0.3/manifest.json`),
      ]) {
        const { res, peak, samples } = await sampled(run);
        expect(res.status).toBeLessThan(500);
        expect(samples).toBeGreaterThan(3);
        // A whole parse holds the text (63 MB) and then a graph larger still.
        expect(peak).toBeLessThan(16 * 1024 * 1024);
      }
    },
    LARGE_MANIFEST_TEST_TIMEOUT_MS,
  );
});

describe("the edge cache sits behind the visibility gate", () => {
  let cache: DrainingCache;
  let original: unknown;

  beforeAll(() => {
    original = (globalThis as { caches?: unknown }).caches;
  });

  beforeEach(() => {
    cache = new DrainingCache();
    (globalThis as { caches?: unknown }).caches = { default: cache };
  });

  afterAll(() => {
    (globalThis as { caches?: unknown }).caches = original;
  });

  test("a public dataset is cached, then revalidated with a bodiless 304", async () => {
    const first = await get(`/${SMALL}/v1.1.1/sub-001/`, JSON_ACCEPT);
    expect(first.status).toBe(200);
    expect(cache.store.has(manifestCacheKey("https://data.nemar.org", SMALL, "v1.1.1"))).toBe(true);
    s3.log.length = 0;
    // Past the trust window (#1494 amendment): otherwise this second request,
    // happening microseconds after the first, would be answered from the
    // copy without asking S3 at all -- see the "within the trust window"
    // describe block below for that behavior.
    const second = await withClockAdvanced(MANIFEST_TRUST_WINDOW_MS + 1_000, () =>
      get(`/${SMALL}/v1.1.1/sub-001/`, JSON_ACCEPT),
    );
    expect(await second.text()).toBe(await first.clone().text());
    // Every nm000132 read, not only this manifest's: a JSON listing has no
    // reason to touch any other object of the dataset (the prior version is
    // read only for the HTML footer), so one conditional GET is the whole of it.
    expect(readsOf(SMALL)).toEqual([`GET INM 304 ${SMALL_OBJECT}`]);
  });

  test("two manifests read at the same time each store an intact copy", async () => {
    // Concurrent requests in one isolate each have their own cache write; the
    // copies must not mix. Both are then answered from the copy after a 304.
    // A slow cache read keeps the two writes in flight at once.
    cache = new DrainingCache({ readDelayMs: 20 });
    (globalThis as { caches?: unknown }).caches = { default: cache };
    const paths = [`/${SMALL}/v1.1.1/sub-001/`, `/${SMALL}/v1.0.0/sub-001/`];
    const first = await Promise.all(paths.map((p) => get(p, JSON_ACCEPT)));
    const decoder = new TextDecoder();
    for (const [version, text] of [
      ["v1.1.1", CURRENT_TEXT],
      ["v1.0.0", PRIOR_TEXT],
    ] as const) {
      const copy = cache.store.get(manifestCacheKey("https://data.nemar.org", SMALL, version));
      expect(copy && decoder.decode(copy.body)).toBe(text);
    }
    s3.log.length = 0;
    // Past the trust window: see the equivalent comment above.
    const second = await withClockAdvanced(MANIFEST_TRUST_WINDOW_MS + 1_000, () =>
      Promise.all(paths.map((p) => get(p, JSON_ACCEPT))),
    );
    for (const [i, res] of second.entries()) {
      expect(await res.text()).toBe(await first[i].text());
    }
    // Exactly one conditional GET per version: each request revalidates its
    // own copy once. Only the order between the two is up to the scheduler.
    expect(readsOf(SMALL).sort()).toEqual([
      `GET INM 304 /${SMALL}/version/v1.0.0.json`,
      `GET INM 304 ${SMALL_OBJECT}`,
    ]);
  });

  test("a dataset gone private is refused before the cache or S3 is touched", async () => {
    await get(`/${SMALL}/v1.1.1/sub-001/`, JSON_ACCEPT);
    expect(cache.store.size).toBeGreaterThan(0);
    db.prepare("UPDATE datasets SET visibility = 'private' WHERE dataset_id = ?").run(SMALL);
    const matchesBefore = cache.matches;
    s3.log.length = 0;
    for (const path of ["sub-001/", "participants.tsv", "manifest.json"]) {
      const res = await get(`/${SMALL}/v1.1.1/${path}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Dataset not found" });
    }
    expect((await get(`/${SMALL}/metadata.json`)).status).toBe(404);
    expect(cache.matches).toBe(matchesBefore);
    expect(readsOf(SMALL)).toEqual([]);
  });

  test("the differential: the same request for the public dataset does touch both", async () => {
    const matchesBefore = cache.matches;
    await get(`/${SMALL}/v1.1.1/participants.tsv`, { method: "HEAD" });
    expect(cache.matches).toBeGreaterThan(matchesBefore);
    expect(readsOf(SMALL)).toEqual([`GET 200 ${SMALL_OBJECT}`]);
  });
});

describe("the trust window and answer memo at the route (#1494 amendment)", () => {
  let cache: DrainingCache;
  let original: unknown;

  // Real `git hash-object` of RAW_STANDIN_BODY (review, #1494/0.10.8): the
  // git-file broker verifies the downloaded content's own blob SHA against
  // the manifest's declared one for every git-tracked GET, so a stand-in for
  // the raw content host has to serve bytes that actually hash to this value
  // -- recompute with `printf '%s' '<RAW_STANDIN_BODY>' | git hash-object --stdin`.
  const RAW_STANDIN_SHA = "8150e793495a4bc88b1af95f8129dc4c5eab759f";
  const RAW_STANDIN_BODY = '{"raw-standin":"participants substitute for the 0.10.8 review test"}';
  const RAW_STANDIN_PATH = "RAW-STANDIN-TEST.json";

  /**
   * A real local raw-content-host stand-in (mirrors `git-file-broker.test.ts`),
   * so "a dataset flipped private is refused..." below issues a real GET for a
   * git-tracked file without reaching production `raw.githubusercontent.com`
   * (review finding: this test previously had no `GITHUB_RAW_BASE` override at
   * all). Scoped to this describe block: it is the only place in this file
   * that GETs (not HEADs) a git-tracked file's bytes.
   */
  let rawServer: import("bun").Server;
  let rawBase: string;

  beforeAll(() => {
    original = (globalThis as { caches?: unknown }).caches;
    rawServer = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === `/nemarDatasets/${SMALL}/v1.1.1/${RAW_STANDIN_PATH}`) {
          return new Response(RAW_STANDIN_BODY, { status: 200 });
        }
        return new Response("no route", { status: 404 });
      },
    });
    rawBase = `http://127.0.0.1:${rawServer.port}`;
  });

  beforeEach(() => {
    cache = new DrainingCache();
    (globalThis as { caches?: unknown }).caches = { default: cache };
  });

  afterAll(() => {
    (globalThis as { caches?: unknown }).caches = original;
    rawServer.stop(true);
  });

  /** `env()` plus the raw-host override above, for the one test that GETs a
   *  git-tracked file's bytes rather than only HEADing or listing it. */
  function envWithRawStandin(): Bindings {
    return { ...env(), GITHUB_RAW_BASE: rawBase };
  }

  /** A manifest identical to CURRENT, plus one synthetic git-tracked entry
   *  whose content and blob SHA this test fully controls. */
  function manifestWithRawStandinEntry(): string {
    return JSON.stringify({
      ...CURRENT,
      files: {
        ...CURRENT.files,
        [RAW_STANDIN_PATH]: {
          key: `git:${RAW_STANDIN_SHA}`,
          size: RAW_STANDIN_BODY.length,
          checksum: `git:${RAW_STANDIN_SHA}`,
        },
      },
    });
  }

  test("within the window, a repeat request for a different file costs no manifest S3 traffic", async () => {
    const first = await get(`/${SMALL}/v1.1.1/participants.tsv`, { method: "HEAD" });
    expect(first.status).toBe(200);
    s3.log.length = 0;
    const second = await get(`/${SMALL}/v1.1.1/sub-001/`, JSON_ACCEPT);
    expect(second.status).toBe(200);
    expect(readsOf(SMALL)).toEqual([]);
  });

  test("Server-Timing names which tier answered the manifest read", async () => {
    // HEAD on a FILE goes through `applyServerTiming`; HEAD on a directory
    // does not (rclone-style HEAD probes never render HTML chrome, so the
    // route skips it there) -- these probe two distinct files for exactly
    // that reason.
    const cold = await get(`/${SMALL}/v1.1.1/participants.tsv`, { method: "HEAD" });
    expect(cold.headers.get("Server-Timing")).toMatch(/manifest;dur=[\d.]+;desc="rewrite"/);

    const warm = await get(`/${SMALL}/v1.1.1/sub-001/eeg/sub-001_coordsystem.json`, {
      method: "HEAD",
    });
    expect(warm.headers.get("Server-Timing")).toMatch(/manifest;dur=[\d.]+;desc="fresh"/);

    // Same path again: now the per-isolate memo answers it, not just the
    // trust window.
    const memoed = await get(`/${SMALL}/v1.1.1/sub-001/eeg/sub-001_coordsystem.json`, {
      method: "HEAD",
    });
    expect(memoed.headers.get("Server-Timing")).toMatch(/manifest;dur=[\d.]+;desc="memo"/);

    // A THIRD, never-before-queried file: past the window, so this still
    // costs a conditional GET, but the review's fix means a 304 now checks
    // the memo first too (see the "a 304 at a window boundary..." test in
    // manifest-source.test.ts). A path with no memo entry yet is what
    // actually exercises "revalidated" now -- `participants.tsv` itself
    // would answer from its own now-confirmed-current memo entry instead.
    const revalidated = await withClockAdvanced(MANIFEST_TRUST_WINDOW_MS + 1_000, () =>
      get(`/${SMALL}/v1.1.1/dataset_description.json`, { method: "HEAD" }),
    );
    expect(revalidated.headers.get("Server-Timing")).toMatch(
      /manifest;dur=[\d.]+;desc="revalidated"/,
    );
  });

  test("a 304 right at the window boundary answers from the memo, at the route (review, #1526)", async () => {
    const first = await get(`/${SMALL}/v1.1.1/participants.tsv`, { method: "HEAD" });
    expect(first.status).toBe(200);
    expect(first.headers.get("Server-Timing")).toMatch(/manifest;dur=[\d.]+;desc="rewrite"/);

    s3.log.length = 0;
    // Past the window: a conditional GET must still happen (an S3 read), but
    // the memo -- keyed by the now-304-confirmed ETag -- must answer this
    // exact query without a second scan, not just without a second S3 body
    // transfer.
    const second = await withClockAdvanced(MANIFEST_TRUST_WINDOW_MS + 1_000, () =>
      get(`/${SMALL}/v1.1.1/participants.tsv`, { method: "HEAD" }),
    );
    expect(second.status).toBe(200);
    expect(second.headers.get("Server-Timing")).toMatch(/manifest;dur=[\d.]+;desc="memo"/);
    expect(readsOf(SMALL)).toEqual([`GET INM 304 ${SMALL_OBJECT}`]);
  });

  test("a dataset flipped private is refused even with a warm memo and a fresh trust window", async () => {
    // A git-tracked path this test fully controls (see `manifestWithRawStandinEntry`
    // and the raw-host stand-in above) rather than a real file fetched from
    // production -- this test issues a real GET, not a HEAD, so it actually
    // reaches the git-file broker.
    s3.put(`/${SMALL}/version/v1.1.1.json`, manifestWithRawStandinEntry());
    const path = `/${SMALL}/v1.1.1/${RAW_STANDIN_PATH}`;

    // Warm the trust window AND the per-isolate answer memo for this exact
    // path while the dataset is still public.
    const before = await app().request(
      `https://data.nemar.org${path}`,
      JSON_ACCEPT,
      envWithRawStandin(),
    );
    expect(before.status).toBe(200);
    expect(await before.text()).toBe(RAW_STANDIN_BODY);
    const again = await app().request(
      `https://data.nemar.org${path}`,
      JSON_ACCEPT,
      envWithRawStandin(),
    );
    expect(again.headers.get("Server-Timing")).toMatch(/manifest;dur=[\d.]+;desc="memo"/);

    db.prepare("UPDATE datasets SET visibility = 'private' WHERE dataset_id = ?").run(SMALL);
    const matchesBefore = cache.matches;
    s3.log.length = 0;

    // Still well inside the trust window, and the memo still holds this
    // exact answer -- neither matters, because `loadPublishedDataset` runs
    // before either is ever consulted (ADR 0066, ADR 0072).
    const after = await app().request(
      `https://data.nemar.org${path}`,
      JSON_ACCEPT,
      envWithRawStandin(),
    );
    expect(after.status).toBe(404);
    expect(await after.json()).toEqual({ error: "Dataset not found" });
    expect(cache.matches).toBe(matchesBefore);
    expect(readsOf(SMALL)).toEqual([]);
  });

  test("a flip to private refuses every route at once, with all three caches warm for this dataset/version (review: no test covered all three together)", async () => {
    // Each of the three caches below is proven individually elsewhere in this
    // file ("the manifest.json response cache...", "the edge cache sits
    // behind the visibility gate", and the memo test just above) -- but never
    // all three warm for the SAME dataset/version at once, in one sequence,
    // before the flip. This is that sequence.
    s3.put(`/${SMALL}/version/v1.1.1.json`, manifestWithRawStandinEntry());
    const filePath = `/${SMALL}/v1.1.1/${RAW_STANDIN_PATH}`;
    const dirPath = `/${SMALL}/v1.1.1/`;
    const manifestJsonPath = `/${SMALL}/v1.1.1/manifest.json`;

    // 1) The manifest edge copy + trust window (any manifest read stores it).
    // 2) The git-file cache (a real GET on a git-tracked file's bytes).
    const fileRes = await app().request(
      `https://data.nemar.org${filePath}`,
      JSON_ACCEPT,
      envWithRawStandin(),
    );
    expect(fileRes.status).toBe(200);
    // 3) The manifest.json response cache.
    const manifestJsonRes = await app().request(
      `https://data.nemar.org${manifestJsonPath}`,
      {},
      envWithRawStandin(),
    );
    expect(manifestJsonRes.status).toBe(200);

    // Prove all three are actually warm before flipping -- otherwise a
    // refusal below would be meaningless (nothing to have served stale).
    expect(cache.store.has(manifestCacheKey("https://data.nemar.org", SMALL, "v1.1.1"))).toBe(true);
    expect(
      cache.store.has(gitFileCacheKey("https://data.nemar.org", SMALL, "v1.1.1", RAW_STANDIN_PATH)),
    ).toBe(true);
    expect(cache.store.has(manifestJsonCacheKey("https://data.nemar.org", SMALL, "v1.1.1"))).toBe(
      true,
    );

    db.prepare("UPDATE datasets SET visibility = 'private' WHERE dataset_id = ?").run(SMALL);
    const matchesBefore = cache.matches;
    s3.log.length = 0;

    // Every route that touches one of the three warm caches refuses, still
    // before any of them is ever consulted.
    for (const path of [filePath, dirPath, manifestJsonPath]) {
      const res = await app().request(
        `https://data.nemar.org${path}`,
        JSON_ACCEPT,
        envWithRawStandin(),
      );
      expect(res.status).toBe(404);
    }
    expect(cache.matches).toBe(matchesBefore);
    expect(readsOf(SMALL)).toEqual([]);
  });
});

describe("a broken or stalled edge cache never breaks the route", () => {
  let original: unknown;

  beforeAll(() => {
    original = (globalThis as { caches?: unknown }).caches;
  });

  afterAll(() => {
    (globalThis as { caches?: unknown }).caches = original;
  });

  /** A Workers execution context: `waitUntil` collects, nothing else is used. */
  function executionContext() {
    const deferred: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (work: Promise<unknown>) => {
        deferred.push(work);
      },
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
    return { ctx, deferred };
  }

  const expectedListing = () => {
    const resolved = resolveFile(CURRENT, "sub-001");
    if (resolved.kind !== "directory") throw new Error("expected a directory");
    return JSON.stringify({
      dataset_id: SMALL,
      version: "v1.1.1",
      path: resolved.path,
      kind: "directory",
      children: resolved.children,
    });
  };

  test("a put that never reads and never settles: answered at once, the write deferred", async () => {
    const cache = new StalledCache();
    (globalThis as { caches?: unknown }).caches = { default: cache };
    const { ctx, deferred } = executionContext();
    const started = performance.now();
    const res = await app().request(
      `https://data.nemar.org/${SMALL}/v1.1.1/sub-001/`,
      JSON_ACCEPT,
      env(),
      ctx,
    );
    expect(await res.text()).toBe(expectedListing());
    // Far under the 5 s stall bound: the wedged put was handed to waitUntil
    // instead of being waited for.
    expect(performance.now() - started).toBeLessThan(2000);
    expect(cache.puts).toBe(1);
    expect(deferred.length).toBeGreaterThan(0);
  });

  test("without an execution context the wait is bounded, and the answer still right", async () => {
    (globalThis as { caches?: unknown }).caches = { default: new StalledCache() };
    const res = await get(`/${SMALL}/v1.1.1/sub-001/`, JSON_ACCEPT);
    expect(await res.text()).toBe(expectedListing());
  }, 15_000);

  test("a cache whose match and put both throw: answered from S3", async () => {
    (globalThis as { caches?: unknown }).caches = {
      default: {
        match: async () => {
          throw new Error("cache down");
        },
        put: async () => {
          throw new Error("cache down");
        },
      },
    };
    const res = await get(`/${SMALL}/v1.1.1/sub-001/`, JSON_ACCEPT);
    expect(await res.text()).toBe(expectedListing());
    expect(readsOf(SMALL)).toEqual([`GET 200 ${SMALL_OBJECT}`]);
  });
});
