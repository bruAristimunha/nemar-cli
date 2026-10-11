/**
 * data.nemar.org route (epic #449).
 *
 * Public, anonymous HTTPS access to every published dataset, BIDS-shaped.
 * The same sub-app is reachable via two paths:
 *
 *   - https://data.nemar.org/<id>/<version>/...        (custom domain, production)
 *   - https://api.nemar.org/data/<id>/<version>/...    (mount, all envs incl. workers.dev dev)
 *
 * Private/unpublished datasets are not exposed here -- those stay on the
 * existing nemar-cli + git-annex flow.
 */

import { type Context, Hono } from "hono";
import { PUBLISHED_FILE_MISSING_ERROR } from "../../../shared/contract/data-plane";
import { checkDataMissBudget } from "../middleware/rateLimit";
import { recordAccess } from "../services/access-metrics";
import { CONCEPT_DOI_SQL } from "../services/anonymity";
import { shouldSkipArchive } from "../services/archive-policy";
import {
  CHUNK_GETS_USED_HEADER,
  CHUNK_GET_BUDGET_HEADER,
  MAX_SERVABLE_CHUNKS,
  resolveAnnexDelivery,
} from "../services/chunked-delivery";
import {
  type CatalogIndexBuildResult,
  type CatalogIndexRow,
  type DatasetRowForMetadata,
  type DatasetVersionRow,
  type ManifestDigest,
  PUBLIC_DATASET_VERSIONS_SQL,
  type PublicManifestEntry,
  type ResolvedVersion,
  type VersionPickerEntry,
  buildBytesUrl,
  buildCatalogIndexPayload,
  buildContentDisposition,
  buildDatasetMetadataFromDigest,
  buildLandingPayload,
  buildRedirectUrl,
  contentTypeForBidsPath,
  diffRemovedSinceResolved,
  findLastSeenVersionBy,
  pickResponseFormat,
  renderCatalogIndexHtml,
  renderDatasetLandingHtml,
  renderIndexHtml,
  renderTombstone404Html,
  resolveQaPath,
  resolveVersion,
  toHttpDate,
  toVersionTag,
  versionExists,
} from "../services/data-router";
import { parseNemarMetadata } from "../services/datacite";
import { isValidDatasetId } from "../services/datasetId";
import { resolveDataBaseOrigin } from "../services/environment";
import {
  gitFileCacheKey,
  matchGitFileCache,
  scheduleGitFileCacheWrite,
} from "../services/git-file-cache";
import { ORG_NAME } from "../services/github";
import { getDatasetsToken } from "../services/github-auth";
import { fetchGitTrackedFile } from "../services/github/git-file-broker";
import type { ManifestFile } from "../services/manifest";
import {
  type ManifestJsonCacheHit,
  manifestJsonCacheKey,
  matchManifestJsonCache,
  scheduleManifestJsonCacheWrite,
} from "../services/manifest-json-cache";
import {
  ContainsPathQuery,
  DigestQuery,
  EntriesQuery,
  EntryCountQuery,
  type ManifestQuery,
  ResolvePathQuery,
} from "../services/manifest-queries";
import type { ManifestHeader } from "../services/manifest-scan";
import {
  type ManifestCache,
  type ManifestRead,
  type ManifestReadSource,
  readManifest,
  rememberManifestAnswer,
} from "../services/manifest-source";
import { buildPageBundle } from "../services/page-bundle";
import {
  type PresignedUrlOptions,
  generatePresignedGetUrl,
  loadRecords,
  loadSummary,
  resolveArchiveKey,
} from "../services/s3";
import type { Bindings, Variables } from "../types/bindings";

export const dataRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

function s3OptionsFromEnv(env: Bindings): PresignedUrlOptions {
  return {
    bucket: env.S3_BUCKET,
    region: env.AWS_REGION,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    endpointUrl: env.S3_ENDPOINT_URL,
  };
}

/**
 * Resolve a dataset id to its public-readable D1 row. Collapses every
 * reject reason into the same `null` return so the route cannot leak
 * whether a private dataset exists, but emits one structured log line
 * per branch so operators can tell scraping from honest 404s.
 */
async function loadPublishedDataset(env: Bindings, datasetId: string) {
  if (!isValidDatasetId(datasetId)) {
    console.log(`[data] reject: invalid id format datasetId=${datasetId}`);
    return null;
  }
  const row = await env.DB.prepare(
    // archive_checked_at (#1514) is when the archive was last confirmed
    // ready/skipped (sweep_stamps.archive_checked_at); buildLandingPayload
    // uses it to tell a latest-version-current 'ready' from one that
    // predates a newer published version.
    `SELECT dataset_id, visibility, archive_status, archive_size, archive_skip_reason,
            json_extract(sweep_stamps, '$.archive_checked_at') AS archive_checked_at
       FROM datasets WHERE dataset_id = ?`,
  )
    .bind(datasetId)
    .first<{
      dataset_id: string;
      visibility: string;
      archive_status: string | null;
      archive_size: number | null;
      archive_skip_reason: string | null;
      archive_checked_at: string | null;
    }>();
  if (!row) {
    console.log(`[data] reject: not in catalog datasetId=${datasetId}`);
    return null;
  }
  if (row.visibility !== "public") {
    console.log(`[data] reject: visibility=${row.visibility ?? "null"} datasetId=${datasetId}`);
    return null;
  }
  return row;
}

/**
 * The Workers Cache API where there is one. `bun test` has none, so the
 * route suites run uncached unless a test installs a cache on
 * `globalThis.caches` (the seam the rate-limiter suites already use).
 */
function edgeCache(): ManifestCache | null {
  const storage = (globalThis as { caches?: { default?: ManifestCache } }).caches;
  return storage?.default ?? null;
}

/** Hands work to `executionCtx.waitUntil`, so it can outlive the response. */
type Defer = (work: Promise<unknown>) => void;

/**
 * The request's `waitUntil`, or undefined where there is no execution context
 * (Hono throws on `c.executionCtx` then, which is what `app.request` without
 * one gives the route suites). The edge-cache write uses it so a slow or
 * wedged `cache.put` never holds a response back.
 */
function deferOf(c: Context<{ Bindings: Bindings; Variables: Variables }>): Defer | undefined {
  try {
    const ctx = c.executionCtx;
    return (work) => ctx.waitUntil(work);
  } catch {
    return undefined;
  }
}

/**
 * Millisecond durations for `Server-Timing` on a data-plane FILE response
 * (#1516): the D1 visibility-and-version gate, the manifest read that
 * resolved the path, the brokered-file edge-cache lookup, and the upstream
 * GitHub fetch when the cache did not answer. Not every stage applies to
 * every response -- an annexed file never touches the git-file cache or
 * GitHub upstream (plain objects return 302; chunked objects read from S3),
 * and a cache hit never touches `upstream` -- so each field is
 * optional and only the stages that actually ran are reported.
 *
 * This exists so production uplift from the cache can be measured from
 * outside (`curl -w`, a browser's network panel) without a deploy that adds
 * logging first, per the issue this closes. It carries only durations: no
 * URL, no dataset id, no header or credential, so it is safe on every
 * response regardless of the dataset's visibility.
 */
interface FileTiming {
  gate?: number;
  manifest?: number;
  /**
   * Which tier answered the manifest read (#1494 amendment): `"memo"` and
   * `"fresh"` never asked S3, `"revalidated"` got a 304, `"rewrite"` got a
   * fresh 200 (or there was no usable copy at all). Only set alongside
   * `manifest`, and only reported when there is one -- this is what makes the
   * trust window's effect visible from outside without a deploy that adds
   * logging first, the same reason `Server-Timing` exists here at all.
   */
  manifestDesc?: ManifestReadSource;
  cache?: number;
  upstream?: number;
}

/** `null` when nothing was timed, so a caller can skip the header entirely. */
function serverTimingHeader(t: FileTiming): string | null {
  const parts: string[] = [];
  for (const key of ["gate", "manifest", "cache", "upstream"] as const) {
    const value = t[key];
    if (value === undefined) continue;
    const desc = key === "manifest" && t.manifestDesc ? `;desc="${t.manifestDesc}"` : "";
    parts.push(`${key};dur=${value.toFixed(1)}${desc}`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

/** Attach `Server-Timing` to `headers` in place, when there is anything to report. */
function applyServerTiming(headers: Headers, t: FileTiming): void {
  const header = serverTimingHeader(t);
  if (header) headers.set("Server-Timing", header);
}

/**
 * Read a version manifest and answer ONE question about it (#1502).
 *
 * This replaced `loadManifest`, which read the manifest whole and parsed it:
 * nm000281's is 43 MB, and every request for it exceeded the isolate's
 * memory. The manifest is now streamed through a scanner that keeps only what
 * `makeQuery`'s query asks for (`services/manifest-queries.ts`), from an edge
 * copy that S3 revalidates outside its 60-second trust window
 * (`services/manifest-source.ts`); inside that window, and on a per-isolate
 * answer memo hit, the read never asks S3 at all.
 *
 * Every failure still collapses to `null`, logged the way it always was:
 * the hot call sites (the tombstone walk fans out up to 10 reads per 404,
 * the "removed since" footer reads the prior version on every directory
 * render) must degrade to "no hint / no footer" on a transient S3 blip,
 * not 500 the whole response.
 *
 * `queryDescriptor` names WHICH question is being asked (a path, a fixed word
 * for the whole-manifest digest), so a warm isolate can skip re-scanning the
 * manifest for a query it has already answered (#1494 amendment; the memo
 * itself lives in `manifest-source.ts`, keyed by dataset, version, the
 * manifest's own ETag and this string). Every call site below passes one;
 * there is no call site in this file that deliberately opts out, so a new one
 * added later should pass one too rather than silently missing the memo.
 */
async function queryManifest<T>(
  env: Bindings,
  request: Request,
  datasetId: string,
  version: string,
  makeQuery: () => ManifestQuery<T>,
  queryDescriptor: string,
  defer: Defer | undefined,
): Promise<{
  header: ManifestHeader;
  answer: T;
  etag: string | null;
  source: ManifestReadSource;
} | null> {
  let read: ManifestRead<T>;
  try {
    read = await readManifest(
      {
        s3: s3OptionsFromEnv(env),
        cache: edgeCache(),
        cacheOrigin: new URL(request.url).origin,
        waitUntil: defer,
      },
      datasetId,
      version,
      makeQuery,
      queryDescriptor,
    );
  } catch (err) {
    console.error(
      `[data] manifest fetch failed dataset=${datasetId} version=${version}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  if (read.kind === "absent") return null;
  if (read.kind === "malformed") {
    console.error(
      `[data] malformed manifest JSON dataset=${datasetId} version=${version}:`,
      read.message,
    );
    return null;
  }
  if (read.kind === "no_files") {
    console.error(`[data] manifest missing 'files' object dataset=${datasetId} version=${version}`);
    return null;
  }
  // Outside the try on purpose: an exception from ANSWERING (a manifest entry
  // that is `null`, say) is not a failed read, and it reaches the app's error
  // handler exactly as it did when the answer was computed from a parsed
  // manifest after loadManifest returned.
  const answer = read.query.finish(read.header);
  // Also outside the try, and after `finish()` succeeded: a memo write is
  // never this function's business to attempt on an answer that has not
  // proven itself real (see `rememberManifestAnswer`'s own doc comment).
  // Only possible when `read.etag` is non-null too: a memoized answer must
  // carry a real ETag (`ManifestRead.ok.etag` is only ever null when S3
  // answered without one, which `rememberManifestAnswer` cannot key by).
  if (read.memoKey !== null && read.etag !== null) {
    rememberManifestAnswer(read.memoKey, read.header, read.etag, answer);
  }
  return { header: read.header, answer, etag: read.etag, source: read.source };
}

/**
 * Everything `metadata.json` needs from the latest manifest, in one streaming
 * pass that never holds the manifest (#1502). When the stream cannot prove the
 * totals (see `DigestQuery`), they come back null and the catalog row answers
 * for them; the BIDS index and sessions are exact either way. Both departures
 * from a clean manifest are logged, because a manifest that triggers them is
 * one the pipeline did not write the usual way.
 */
async function loadManifestDigest(
  env: Bindings,
  request: Request,
  datasetId: string,
  version: string,
  defer: Defer | undefined,
): Promise<ManifestDigest | null> {
  const read = await queryManifest(
    env,
    request,
    datasetId,
    version,
    () => new DigestQuery(),
    "digest",
    defer,
  );
  if (!read) return null;
  const { digest, unproven, excludedSizes } = read.answer;
  if (unproven !== null) {
    console.warn(
      `[data] metadata.json: ${unproven}; total_files and size_bytes come from the catalog row dataset=${datasetId} version=${version}`,
    );
  }
  if (excludedSizes > 0) {
    console.warn(
      `[data] metadata.json: ${excludedSizes} manifest entries have a size that is not a non-negative integer; counted in total_files, left out of size_bytes dataset=${datasetId} version=${version}`,
    );
  }
  return digest;
}

/**
 * Extra fields attached to a file 404. Always includes `version` and
 * `path` so a JSON consumer can self-describe the response without
 * re-parsing the request URL. When the path was removed in a recent
 * prior version, the `reason` + `last_seen_*` fields point the
 * consumer at the URL that still serves the bytes.
 */
interface FileNotFoundPayload {
  version: string;
  path: string;
  reason?: "removed" | "not_latest_version" | "archive_skipped";
  last_seen_version?: string;
  last_seen_url?: string;
  /** #1518: set alongside reason: "not_latest_version" -- the version whose
   *  archive is actually retained. */
  latest_version?: string;
  /** #1518: where to get this version's files instead of a zip. */
  browse_url?: string;
}

/** The 503 body for a fault while checking whether an archive can be served
 *  (a D1 read or the S3 HEAD): the client should retry, not treat the archive
 *  as absent. */
const ARCHIVE_CHECK_FAILED_MESSAGE = "Unable to check archive availability";

function notFound(message: string, payload?: FileNotFoundPayload, noStore = false) {
  const body = payload ? { error: message, ...payload } : { error: message };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // The JSON-artifact handlers (summary/records) opt into no-store on their
  // "dataset/version not found" early-exits so those 404s are never CDN-pinned
  // while the version row or artifact is still being written asynchronously
  // after a publish (matching the artifact-not-found path in the same handlers).
  if (noStore) headers["Cache-Control"] = "no-store";
  return new Response(JSON.stringify(body), { status: 404, headers });
}

/** A manifest-named file is not absent when its backing object is missing. */
function manifestObjectMissing(datasetId: string): Response {
  return new Response(
    JSON.stringify({ error: PUBLISHED_FILE_MISSING_ERROR, dataset_id: datasetId }),
    {
      status: 502,
      headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
    },
  );
}

/**
 * 404 for a file path that takes content negotiation into account.
 *
 * - Accept: text/html -> friendly HTML page, with the last-seen URL when known.
 * - everything else -> JSON, with `reason: "removed"` + `last_seen_*` when known.
 *
 * The "what does an absent path mean?" decision is shared between JSON
 * and HTML callers, so the format pick happens once at the route boundary
 * and the rest of the handler is shape-agnostic.
 */
function fileNotFound(args: {
  request: Request;
  datasetId: string;
  version: string;
  path: string;
  lastSeen: { version: string; href: string } | null;
}): Response {
  const { request, datasetId, version, path, lastSeen } = args;
  const accept = request.headers.get("accept");
  const formatParam = new URL(request.url).searchParams.get("format");
  const fmt = pickResponseFormat({ accept, formatParam });

  if (fmt === "html") {
    const html = renderTombstone404Html({ datasetId, version, path, lastSeen });
    return new Response(html, {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  if (lastSeen) {
    return notFound("File not found", {
      version,
      path,
      reason: "removed",
      last_seen_version: lastSeen.version,
      last_seen_url: lastSeen.href,
    });
  }
  return notFound("File not found", { version, path });
}

function parseChecksum(checksum: string): { algorithm: string; value: string } {
  const colon = checksum.indexOf(":");
  if (colon === -1) return { algorithm: "unknown", value: checksum };
  return { algorithm: checksum.slice(0, colon), value: checksum.slice(colon + 1) };
}

function chunkGetBudgetFromRequest(request: Request): number | undefined {
  const raw = request.headers.get(CHUNK_GET_BUDGET_HEADER);
  if (raw === null) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(raw)) return 0;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? Math.min(parsed, MAX_SERVABLE_CHUNKS) : 0;
}

function withChunkGetUsage(request: Request, response: Response, used: number): Response {
  if (!request.headers.has(CHUNK_GET_BUDGET_HEADER)) return response;
  const headers = new Headers(response.headers);
  headers.set(CHUNK_GETS_USED_HEADER, String(used));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Maximum entries held while one manifest response is built and serialized. */
export const MAX_MANIFEST_JSON_ENTRIES = 38_000;

/**
 * The refusal for a manifest over its bound. 413 because the refusal is about
 * size and is permanent for this version; a client should not retry it. It
 * names the way to enumerate the files that does scale: the per-directory JSON
 * listing, one directory per request.
 */
function manifestJsonTooLarge(
  request: Request,
  datasetId: string,
  version: string,
  limit: number,
): Response {
  const listing = new URL(`../${encodeURIComponent(version)}/?format=json`, request.url).toString();
  return new Response(
    JSON.stringify({
      error: `This version has more than ${limit} files, which is more than manifest.json can list in one response. Enumerate it one directory at a time instead: ${listing} lists the top level, and each directory's URL with ?format=json lists that directory's own files and subdirectories.`,
      dataset_id: datasetId,
      version,
      limit,
      listing_url: listing,
    }),
    {
      status: 413,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" },
    },
  );
}

/** ADR 0066's maximum downstream authorization-staleness window. */
const MANIFEST_JSON_CACHE_CONTROL = "public, max-age=300";

/** Shared manifest fields, computed once for both annex and git-tracked files. */
function manifestEntryBase(
  env: Bindings,
  datasetId: string,
  version: string,
  path: string,
  file: ManifestFile,
): Omit<PublicManifestEntry, "url"> {
  const checksum = parseChecksum(file.checksum);
  return {
    path,
    size: file.size,
    checksum_algorithm: checksum.algorithm,
    checksum: checksum.value,
    bytes_url: buildBytesUrl({
      datasetId,
      version,
      bidsPath: path,
      origin: resolveDataBaseOrigin(env),
    }),
  };
}

/**
 * Build the deterministic public manifest. `url` and `bytes_url` are the same
 * stable route for every entry, so the cached document carries no direct S3
 * capability and does not depend on bucket policy or chunk layout.
 */
function buildManifestEntries(
  env: Bindings,
  datasetId: string,
  version: string,
  files: Record<string, ManifestFile>,
): PublicManifestEntry[] {
  return Object.entries(files).map(([path, file]) => {
    const base = manifestEntryBase(env, datasetId, version, path, file);
    return { ...base, url: base.bytes_url };
  });
}

/**
 * GET /<id>/<version>/manifest.json -> public file index.
 *
 * Every entry uses the stable, dataset/version/path route for both `url` and
 * `bytes_url`. The built document is a pure function of the source manifest,
 * so it is cached behind the visibility gate and revalidated against the
 * source manifest's ETag before ever answering from the cache
 * (`manifest-json-cache.ts`). That revalidation rides the entry-count query below
 * rather than a conditional GET of its own: the count query already goes
 * through the manifest trust window (`manifest-source.ts`), so a cache hit
 * confirmed within the window costs no S3 call at all, and a hit confirmed
 * past the window costs exactly the one conditional GET the count query
 * already pays to restamp the window for the read that would otherwise
 * follow it.
 */
async function manifestJsonHandler(
  env: Bindings,
  request: Request,
  datasetId: string,
  versionParam: string,
  defer: Defer | undefined,
): Promise<Response> {
  const dataset = await loadPublishedDataset(env, datasetId);
  if (!dataset) return notFound("Dataset not found");

  const resolved = await resolveVersion(env.DB, datasetId, versionParam);
  if (!resolved.ok) return notFound("Version not found");

  const clientCacheControl = MANIFEST_JSON_CACHE_CONTROL;
  const cache = edgeCache();
  const cacheKey = manifestJsonCacheKey(new URL(request.url).origin, datasetId, resolved.version);
  const hit = cache ? await matchManifestJsonCache(cache, cacheKey) : null;
  const bound = MAX_MANIFEST_JSON_ENTRIES;

  // Count first, keeping nothing, so the refusal for an oversized manifest
  // costs what any other lookup costs, and so a cache hit's freshness is
  // confirmed by THIS query's own (windowed) ETag rather than a second S3
  // round trip. The second read is the one that answers on a miss, and it
  // enforces the bound itself, so a manifest rewritten between the two, or
  // one whose keys do not ascend (the count cannot rule out a repeated key
  // then), still cannot exceed it.
  const counted = await queryManifest(
    env,
    request,
    datasetId,
    resolved.version,
    () => new EntryCountQuery(),
    "count",
    defer,
  );
  if (!counted) return notFound("Version not published");
  if (counted.answer.kind === "count" && counted.answer.count > bound) {
    return manifestJsonTooLarge(request, datasetId, resolved.version, bound);
  }

  if (hit && counted.etag !== null && counted.etag === hit.etag) {
    return new Response(hit.body, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": hit.clientCacheControl ?? clientCacheControl,
      },
    });
  }

  const read = await queryManifest(
    env,
    request,
    datasetId,
    resolved.version,
    () => new EntriesQuery(bound),
    `entries:${bound}`,
    defer,
  );
  if (!read) return notFound("Version not published");
  if (read.answer.kind === "over_limit") {
    return manifestJsonTooLarge(request, datasetId, resolved.version, bound);
  }

  const entries = buildManifestEntries(env, datasetId, resolved.version, read.answer.files);

  const body = JSON.stringify(entries);

  if (cache && read.etag) {
    await scheduleManifestJsonCacheWrite(
      { cache, key: cacheKey, etag: read.etag, body, clientCacheControl },
      defer,
    );
  }

  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": clientCacheControl,
    },
  });
}

/**
 * Fetch every published version row for a dataset, newest-first.
 * Returns the same shape used by metadataJsonHandler and the landing
 * page. Empty array means "dataset exists but unpublished" *or* the D1
 * query threw -- callers cannot distinguish, by design.
 *
 * D1 errors are absorbed and returned as an empty array so that
 * presentational features in `fileOrIndexHandler` (version picker,
 * "removed since" footer, tombstone walk) cannot 500 a file redirect
 * that would otherwise succeed. The landing page does need this data
 * to do its job, but degrading to "empty version list" there is still
 * better than a 500 -- the page can render a "no published versions"
 * notice instead.
 */
async function loadVersionRows(env: Bindings, datasetId: string): Promise<DatasetVersionRow[]> {
  try {
    const result = await env.DB.prepare(PUBLIC_DATASET_VERSIONS_SQL)
      .bind(datasetId)
      .all<DatasetVersionRow>();
    return result.results ?? [];
  } catch (err) {
    console.error(
      `[data] dataset_versions query failed dataset=${datasetId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/**
 * Ceiling on a git-tracked file the Worker will carry. Chosen far above any
 * real BIDS sidecar so it is a guard against an annex-policy slip, not a
 * working limit.
 */
const MAX_BROKERED_FILE_BYTES = 32 * 1024 * 1024;

/** Is this manifest entry carried by git rather than git-annex (ADR 0015)? */
export function isGitTrackedFile(file: ManifestFile): boolean {
  return file.key.startsWith("git:");
}

/**
 * Serve a git-tracked file's bytes from the data plane itself.
 *
 * The visibility gate has already run in the caller, and it runs before this
 * function is ever reached: nothing here mints a token or touches GitHub for
 * a dataset the catalog will not serve. The two identifiers this uses are
 * both ours rather than the caller's -- the repo is the catalog row's
 * `dataset_id`, and the path and blob SHA come from the manifest entry the
 * resolver matched. A request cannot name a repo, a ref or a blob.
 *
 * Nothing caches by blob SHA. The edge caches this response under its request
 * URL, which is dataset- and version-scoped; a SHA-keyed entry would be
 * content-addressed and therefore shared between datasets, so an identical
 * `dataset_description.json` in a private dataset and a public one would be
 * one cache entry and the gate would be bypassed for whoever asked second.
 */
async function streamGitTrackedFile(args: {
  env: Bindings;
  datasetId: string;
  version: string;
  bidsPath: string;
  file: ManifestFile;
  createdIso: string;
  /**
   * Offered the verified bytes and the exact headers about to be sent,
   * ONLY on the buffered branch's 200 (#1516). Absent when there is no edge
   * cache to write to (`edgeCache()` returned null, e.g. `bun test` with no
   * `caches.default` installed).
   */
  cacheWrite?: (body: Uint8Array, headers: Headers) => Promise<void>;
}): Promise<Response> {
  const { env, datasetId, version, bidsPath, file, createdIso, cacheWrite } = args;

  // Read anonymously when no credential is CONFIGURED: a public repo serves
  // fine without one, and a local or preview deployment with no GitHub App
  // should not lose every metadata file. What must not happen is the
  // anonymous read then being mistaken for proof of absence -- GitHub answers
  // 404, not 403, for a repo the caller cannot see -- so the broker refuses
  // to report `absent` without a credential, and a mint FAILURE (as opposed
  // to no credentials at all) is reported rather than downgraded: during a
  // key rotation every git file in every dataset would otherwise 404 and log
  // itself as a data-integrity event.
  let token: string | null = null;
  try {
    token = await getDatasetsToken(env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (env.GITHUB_APP_ID || env.GITHUB_ADMIN_PAT) {
      console.error(
        `[data] git-file broker could not mint a token dataset=${datasetId}: ${message}`,
      );
      return new Response(
        JSON.stringify({ error: "Upstream content host unavailable", dataset_id: datasetId }),
        {
          status: 503,
          headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
        },
      );
    }
    console.warn(`[data] no GitHub credential configured dataset=${datasetId}: ${message}`);
  }

  // git is supposed to carry metadata (ADR 0015), and ADR 0031 records that
  // the annex policy is a judgment call rather than a law of nature. One slip
  // that commits a recording to git would otherwise make this Worker proxy a
  // multi-gigabyte file -- the shape the zarr plane refuses on purpose. The
  // ceiling is far above any real sidecar (the largest measured across the
  // catalog is 283 KB) so it never fires in normal operation, and when it
  // does it names the policy rather than timing out.
  if (file.size > MAX_BROKERED_FILE_BYTES) {
    console.error(
      `[data] git-tracked file exceeds the broker ceiling dataset=${datasetId} path=${bidsPath} size=${file.size}`,
    );
    return new Response(
      JSON.stringify({
        error: "File is too large to serve from git; it should be annexed (ADR 0031)",
        dataset_id: datasetId,
      }),
      { status: 502, headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } },
    );
  }

  const outcome = await fetchGitTrackedFile({
    repo: datasetId,
    ref: version,
    path: bidsPath,
    // `key` is what `isGitTrackedFile` matched on; `checksum` carries the
    // same value today, but taking it from the field the branch was
    // decided by is what keeps them from drifting apart.
    blobSha: file.key.replace(/^git:/, ""),
    token,
    // Test seam, and the same shape ORCID_API_BASE uses: unset in production,
    // where the broker's own default (the real raw host) applies.
    rawBase: env.GITHUB_RAW_BASE,
  });

  if (outcome.kind === "absent") {
    // The manifest promised a blob GitHub does not have. That is a
    // data-integrity event, not a path absent from the manifest. Keep it
    // distinct from the 404 that the gather treats as an optional table.
    console.error(
      `[data] MANIFEST DRIFT: git blob absent dataset=${datasetId} version=${version} path=${bidsPath} sha=${file.checksum}`,
    );
    return manifestObjectMissing(datasetId);
  }

  if (outcome.kind === "unavailable") {
    console.error(
      `[data] git-file broker unavailable dataset=${datasetId} version=${version} path=${bidsPath}: ${outcome.message}`,
    );
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    });
    if (outcome.retryAfter) headers.set("Retry-After", outcome.retryAfter);
    return new Response(
      JSON.stringify({ error: "Upstream content host unavailable", dataset_id: datasetId }),
      { status: outcome.status, headers: headers },
    );
  }

  // A size that disagrees with the manifest means the tag moved under us, so
  // these are not the bytes the manifest describes. Refusing is the same rule
  // the CLI applies to a short write (#1402): a wrong-length file that looks
  // healthy is worse than an error.
  //
  // This is the FAST path, not the guarantee: it fires only when upstream
  // declared a length, and it does not on a real raw fetch. The runtime owns
  // `Accept-Encoding`, so the broker's `identity` request never reaches
  // GitHub, the raw host gzips, and workerd strips `Content-Length` when it
  // decodes (ADR 0066, amendment 2026-09-16). Nothing has been observed to
  // make this fire in production; it is kept because it is cheap, because it
  // would catch a mismatch before the body is read at all if a runtime or
  // host change ever restored the declaration, and because the unit suite
  // exercises it. The measurement below is what actually holds.
  const where = { datasetId, version, bidsPath, blobSha: file.key.replace(/^git:/, "") };
  if (outcome.contentLength !== null && outcome.contentLength !== file.size) {
    console.error(
      `[data] SIZE MISMATCH (upstream header) dataset=${datasetId} version=${version} path=${bidsPath} sha=${where.blobSha} source=${outcome.source} manifest=${file.size} upstream=${outcome.contentLength}`,
    );
    // Nothing will read this body. Cancelling releases the upstream
    // connection now rather than leaving it to the runtime.
    await outcome.body.cancel("upstream declared a length the manifest does not").catch(() => {});
    return new Response(JSON.stringify({ error: "Upstream content did not match the manifest" }), {
      status: 502,
      headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
    });
  }

  const outgoing = await sizeCheckedBody(outcome.body, file.size, bufferCeiling(env), where);
  if (outgoing.kind === "mismatch") {
    console.error(
      `[data] SIZE MISMATCH (buffered) dataset=${datasetId} version=${version} path=${bidsPath} sha=${where.blobSha} source=${outcome.source} manifest=${file.size} delivered=${outgoing.atLeast ? ">=" : ""}${outgoing.measured}`,
    );
    return new Response(JSON.stringify({ error: "Upstream content did not match the manifest" }), {
      status: 502,
      headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
    });
  }
  if (outgoing.kind === "content-mismatch") {
    // The right NUMBER of bytes and the wrong bytes: a same-size edit behind
    // a moved tag. Louder than a length mismatch, because a length mismatch
    // is usually an accident and this is a file whose content changed while
    // its identifier did not.
    console.error(
      `[data] CONTENT MISMATCH dataset=${datasetId} version=${version} path=${bidsPath} manifest_sha=${where.blobSha} upstream_sha=${outgoing.sha} source=${outcome.source} size=${file.size}`,
    );
    return new Response(JSON.stringify({ error: "Upstream content did not match the manifest" }), {
      status: 502,
      headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
    });
  }
  if (outgoing.kind === "unreadable") {
    console.error(
      `[data] git-file broker body failed mid-read dataset=${datasetId} version=${version} path=${bidsPath} sha=${where.blobSha} source=${outcome.source}: ${outgoing.message}`,
    );
    return new Response(
      // Its own sentence, not the `unavailable` branch's: "started sending
      // and stopped" is a different thing for a client to retry than "refused
      // us", and a mid-body drop is the most transient failure in this
      // function, so it gets the Retry-After that branch forwards.
      JSON.stringify({
        error: "Upstream content host dropped the transfer",
        dataset_id: datasetId,
      }),
      {
        status: 502,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
          "Retry-After": "5",
        },
      },
    );
  }
  // Counted before the client finishes reading, so an aborted download still
  // counts as a full delivery. Closer than the redirect it replaces (which
  // could only ever record intent), and worth stating rather than
  // overclaiming.
  //
  // "The response is known to be a delivery" holds only on the BUFFERED
  // branch, where the length and the content have already been checked above.
  // On the streamed branch nothing has been read yet, so a body that later
  // fails `countedStream` has already been recorded here as `file.size`
  // delivered. Accepted because that branch is unreachable for any real
  // dataset (283 KB measured maximum against an 8 MB ceiling); revisit if it
  // stops being.
  recordAccess(env, {
    datasetId,
    source: "file",
    detail: `git-${outcome.source}`,
    bytes: file.size,
  });

  const headers = new Headers(fileResponseHeaders(file, createdIso, false));
  headers.set("Content-Type", contentTypeForBidsPath(bidsPath));
  // NOT immutable, and not a year. The content at this URL is immutable --
  // it is version-pinned and content-addressed -- but the AUTHORIZATION is
  // not: `applyVisibilityTransition` can take a dataset private, and it
  // purges nothing (per-URL purge caps at 30 URLs and prefix purge is
  // Enterprise-only, services/cloudflare.ts). A year-long `immutable` would
  // leave every shared cache serving a withdrawn dataset's participants and
  // sidecars to other readers, with no recovery and no revalidation. The
  // redirect this replaces bounded that at 300s; so does this.
  headers.set("Cache-Control", "public, max-age=300");
  // The raw host answered `Access-Control-Allow-Origin: *` on exactly these
  // bytes, and bytes_url invites a consumer to persist the URL. Moving the
  // host must not quietly revoke browser access for a notebook or a viewer
  // that is not on a nemar.org origin: this is anonymous public data and the
  // request carries no credentials.
  headers.set("Access-Control-Allow-Origin", "*");
  // A dataset is user-supplied content served from our own origin now. The
  // type is already an inert one from the allowlist; nosniff stops a browser
  // from deciding otherwise, and the sandbox CSP makes it inert even then.
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
  // Declared only on the buffered branch, where the bytes are in hand and
  // have just been checked against the manifest. On the streamed branch it is
  // deliberately absent: a header set on a streamed body does not survive the
  // runtime (workerd sends it chunked and drops the header, measured on the
  // deployed worker), so setting one there would be a claim the response does
  // not carry rather than a fact about it. Pinned by a test asserting the
  // header is null above the ceiling -- without one, restoring the
  // unconditional set that #1420 shipped passes the whole suite.
  if (outgoing.kind === "buffered") {
    headers.set("Content-Length", String(outgoing.body.byteLength));
    // Cache exactly what is about to be sent -- same bytes, same headers --
    // so a hit is indistinguishable from a fresh fetch to the client. Never
    // offered for the streamed branch: above the buffer ceiling there is no
    // declared length either, and nothing here should encourage raising the
    // ceiling to grow the cache.
    if (cacheWrite) await cacheWrite(outgoing.body, headers);
  }
  return new Response(outgoing.body, { status: 200, headers });
}

/**
 * The cache-then-broker front door for a git-tracked file GET (#1516).
 *
 * Runs strictly AFTER the caller's visibility gate and manifest resolution --
 * the same ordering `streamGitTrackedFile` always ran under, now with a cache
 * lookup inserted at the same point a token mint used to be the first thing
 * that happened. A hit never mints a token and never reaches GitHub: the
 * cached bytes already passed the size and blob-SHA check the first time they
 * were fetched, and they are compared, on every use, against the manifest
 * entry (`file`, below) the caller already resolved for THIS request -- which
 * may itself have answered from the trust window or the per-isolate answer
 * memo rather than a fresh S3 read, never a fresh GitHub round trip either
 * way. That comparison is what makes a manifest rewrite (ADR 0072) a miss
 * rather than a stale answer.
 *
 * `timing` is mutated in place: `cache` always gets a value when there is an
 * edge cache to ask (0 when there is none, so the header still reports a
 * completed stage rather than silently omitting it), and `upstream` is set
 * only when this fell through to `streamGitTrackedFile`.
 */
async function serveGitTrackedFile(args: {
  env: Bindings;
  request: Request;
  datasetId: string;
  version: string;
  bidsPath: string;
  file: ManifestFile;
  createdIso: string;
  defer: Defer | undefined;
  timing: FileTiming;
}): Promise<Response> {
  const { env, request, datasetId, version, bidsPath, file, createdIso, defer, timing } = args;
  const cache = edgeCache();
  const key = cache
    ? gitFileCacheKey(new URL(request.url).origin, datasetId, version, bidsPath)
    : null;

  if (cache && key) {
    const start = performance.now();
    const hit = await matchGitFileCache(cache, key, file);
    timing.cache = performance.now() - start;
    if (hit) {
      // Same accounting the served-from-GitHub path gets, under its own
      // detail so the observability dashboard can tell a cache hit from an
      // upstream fetch; the bytes delivered are identical either way.
      recordAccess(env, { datasetId, source: "file", detail: "git-cache", bytes: file.size });
      return new Response(hit.body, { status: hit.status, headers: hit.headers });
    }
  } else {
    timing.cache = 0;
  }

  // A MISS, about to go upstream: the expensive path (a token mint plus a
  // real GitHub request), bounded per IP by its own budget (#1516 review) --
  // a hit above must never be throttled by how many OTHER requests missed.
  // Refused here means upstream never ran, so `timing.upstream` stays unset.
  const missBudget = await checkDataMissBudget(env, request, defer);
  if (!missBudget.allowed) return missBudget.response;

  const start = performance.now();
  const response = await streamGitTrackedFile({
    env,
    datasetId,
    version,
    bidsPath,
    file,
    createdIso,
    cacheWrite:
      cache && key
        ? (body, headers) =>
            scheduleGitFileCacheWrite(
              { cache, key, blobSha: file.key.replace(/^git:/, ""), body, headers },
              defer,
            )
        : undefined,
  });
  timing.upstream = performance.now() - start;
  return response;
}

/**
 * Default size at or below which a brokered git file is read into memory
 * before it is answered, so the runtime can declare a `Content-Length`.
 *
 * Far above anything real -- the largest git-tracked file measured across the
 * catalog is 283 KB, against the 32 MB ceiling `MAX_BROKERED_FILE_BYTES`
 * enforces -- so the buffered branch is what every actual dataset takes and
 * the streamed branch is the escape hatch for a file that should have been
 * annexed.
 *
 * What bounds the MEMORY is this ceiling, not that average, and the budget is
 * shared: 128 MB is per ISOLATE across every concurrent request (see
 * `mcp/taste.ts`), and the read below holds the chunks and then the joined
 * copy, so a worst-case brokered file costs about twice the ceiling while it
 * is being assembled. That puts the worst case near six simultaneous
 * ceiling-sized files, not sixteen. Real traffic is three orders of magnitude
 * under either number; the point is that RAISING this constant raises a
 * concurrency limit, not just a file limit.
 */
const DEFAULT_BROKER_BUFFER_MAX_BYTES = 8 * 1024 * 1024;

function bufferCeiling(env: Bindings): number {
  const raw = env.BROKER_BUFFER_MAX_BYTES;
  if (raw === undefined) return DEFAULT_BROKER_BUFFER_MAX_BYTES;
  // A bare integer or nothing. `Number.parseInt` stops at the first non-digit
  // and returns what it got, so "8MB" -- the obvious spelling, and the one
  // this binding's own doc comment writes in prose -- would parse as a
  // ceiling of EIGHT BYTES. Every file would then exceed it, every response
  // would take the streamed branch, and every response would ship without a
  // `Content-Length`: precisely the production state #1419 was filed about,
  // reached silently through a plausible typo. Refuse it and name the value.
  if (!/^\d+$/.test(raw.trim())) {
    console.error(
      `[data] BROKER_BUFFER_MAX_BYTES is not a byte count; using the default: value=${JSON.stringify(raw)} default=${DEFAULT_BROKER_BUFFER_MAX_BYTES}`,
    );
    return DEFAULT_BROKER_BUFFER_MAX_BYTES;
  }
  return Number.parseInt(raw, 10);
}

/**
 * `buffered` and `streamed` are separate variants rather than one `body` that
 * is narrowed with `instanceof` later: which branch ran is known here, and
 * recovering it downstream by testing the runtime type is how a missed check
 * turns into `Content-Length: undefined` on the wire.
 */
type BrokeredBody =
  | { kind: "buffered"; body: Uint8Array }
  | { kind: "streamed"; body: ReadableStream<Uint8Array> }
  /** `atLeast` marks a count cut short by the read bound, not a final total. */
  | { kind: "mismatch"; measured: number; atLeast: boolean }
  | { kind: "content-mismatch"; sha: string }
  | { kind: "unreadable"; message: string };

/**
 * Make the body prove the manifest before it is answered.
 *
 * WHY THIS BUFFERS, when the obvious shape is to stream. Setting
 * `Content-Length` by hand on a streamed `Response` does not survive: workerd
 * sends it chunked and drops the header. Measured against the deployed data
 * plane on 2026-09-16 (`0.10.4-dev17`, the first build that set it): still no
 * `Content-Length` on the response. A body of known byte length is the only
 * shape the runtime will declare a length for, so a length that reaches the
 * client has to be one we already hold.
 *
 * It buys the stronger failure too. A mismatch found in a buffer is a clean
 * 502 before a byte is sent, where a mismatch found mid-stream can only be an
 * aborted transfer. That matters because the check itself is the point: the
 * upstream-header comparison it backstops never once ran in production, so
 * "the tag moved under us and these are not the manifest's bytes" was going
 * unnoticed rather than being caught.
 *
 * THE READ IS BOUNDED BY THE MANIFEST, which is the difference between this
 * and `new Response(body).arrayBuffer()`. Both size gates upstream of here
 * test `file.size`, the number the MANIFEST claims; nothing bounds what
 * GitHub actually sends. Draining first and comparing afterwards would mean a
 * retag that put a recording where a sidecar was gets read into a 128 MB
 * isolate in full -- an isolate kill, which takes every unrelated in-flight
 * request with it and cannot even be caught and logged. The stream this
 * replaced could not do that: it refused at `seen > expected`. So this reads
 * chunk by chunk, stops the moment the count passes what was promised, and
 * cancels upstream.
 *
 * AND THE BYTES ARE IDENTIFIED, not just counted. The raw fetch is by REF,
 * not by blob SHA (`git-file-broker.ts`), so a moved tag serves the new blob
 * at that path and a length comparison only notices when the size changed
 * too. A same-size edit -- one participant ID swapped for another, a version
 * string bumped -- passed every check here and was served as a 200 whose
 * `ETag` named the OLD blob, cached for five minutes. The manifest already
 * carries the git object name and the complete bytes are now in hand, so the
 * real check costs one SHA-1 over a few hundred kilobytes: see `gitBlobSha`.
 *
 * Above the ceiling it degrades to the stream with a counter, which can
 * neither declare a length nor identify the content, but still refuses to let
 * a short or overrun body finish looking complete.
 */
async function sizeCheckedBody(
  body: ReadableStream<Uint8Array>,
  expected: number,
  ceiling: number,
  where: { datasetId: string; version: string; bidsPath: string; blobSha: string },
): Promise<BrokeredBody> {
  if (expected > ceiling) {
    // Not silent: this branch is supposed to be unreachable for every real
    // dataset, so one line per occurrence is the right cost for something
    // that should occur zero times. It is also the line that would catch a
    // misconfigured ceiling on the first request rather than on the next
    // release check.
    console.warn(
      `[data] brokered file above the buffer ceiling, streaming without a declared length dataset=${where.datasetId} version=${where.version} path=${where.bidsPath} size=${expected} ceiling=${ceiling}`,
    );
    return { kind: "streamed", body: countedStream(body, expected, where) };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      seen += value.byteLength;
      if (seen > expected) {
        await reader.cancel("body exceeds the size the manifest declared").catch(() => {});
        return { kind: "mismatch", measured: seen, atLeast: true };
      }
      chunks.push(value);
    }
  } catch (err) {
    // A locked or disturbed stream is OUR bug -- something read the body
    // before this did -- and relabeling it as an upstream outage would send
    // an operator to GitHub's status page for a defect in this file. Let it
    // reach the app's error handler with its stack instead.
    if (err instanceof TypeError && /locked|disturbed/i.test(err.message)) throw err;
    return { kind: "unreadable", message: err instanceof Error ? err.message : String(err) };
  }
  if (seen !== expected) return { kind: "mismatch", measured: seen, atLeast: false };

  const bytes = new Uint8Array(seen);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }

  const sha = await gitBlobSha(bytes);
  if (sha !== where.blobSha) return { kind: "content-mismatch", sha };
  return { kind: "buffered", body: bytes };
}

/**
 * The git object name for a blob's contents: SHA-1 over `blob <len>\0<bytes>`,
 * which is what `git hash-object` computes and what the manifest records as a
 * git-tracked entry's `checksum`. Verified against a live manifest entry
 * (`xx099904` `dataset_description.json`, 1414 bytes,
 * `a57e20458be6b7845f583c1e3af58ff261b626e3`).
 *
 * SHA-1 is the weak hash git uses; this is an integrity check against an
 * accidental retag, not a defense against a chosen-prefix attacker, and the
 * manifest's own identifier is the same SHA-1 either way.
 */
async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const framed = new Uint8Array(header.byteLength + bytes.byteLength);
  framed.set(header, 0);
  framed.set(bytes, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", framed);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The streamed fallback for a file too large to hold: count the bytes and
 * error the stream if the total disagrees with the manifest.
 *
 * The response carries no `Content-Length` on this path, because one set here
 * would not survive (see `sizeCheckedBody`). What it does carry is a wrong
 * length REFUSED at the source: erroring the stream means the terminating
 * chunk is never written, so a strict client (rclone, a browser) sees an
 * incomplete transfer -- the same signal a short write gives the CLI
 * (`file-download.ts`, #1402). Note what that depends on: a LENIENT client
 * that treats connection-close as end-of-body sees a short file and a 200,
 * with no length to cross-check. So this is weaker than the buffered branch's
 * clean 502, which is a further reason for the ceiling to be generous rather
 * than tight. The CLI is unaffected either way; it checks the manifest's size
 * rather than the header.
 */
function countedStream(
  body: ReadableStream<Uint8Array>,
  expected: number,
  where: { datasetId: string; version: string; bidsPath: string; blobSha: string },
): ReadableStream<Uint8Array> {
  let seen = 0;
  const describe = () =>
    `dataset=${where.datasetId} version=${where.version} path=${where.bidsPath} sha=${where.blobSha} manifest=${expected} delivered=${seen}`;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        // Refuse the overrun rather than passing bytes beyond the manifest's
        // length: past `expected` the response is already not what the
        // manifest describes, and the extra bytes are what a client would
        // have to discard.
        if (seen > expected) {
          console.error(`[data] SIZE MISMATCH (overrun) ${describe()}`);
          controller.error(new Error("Upstream content did not match the manifest"));
          return;
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (seen !== expected) {
          console.error(`[data] SIZE MISMATCH (short) ${describe()}`);
          controller.error(new Error("Upstream content did not match the manifest"));
        }
      },
    }),
  );
}

/**
 * Build the rclone-friendly file metadata headers for a manifest entry.
 *
 * `ETag` is the manifest checksum verbatim (`"sha256:<hex>"` for
 * git-annex files, `"git:<sha>"` for inline git content). Content-
 * addressed and stable across re-publications of identical content.
 * RFC 7232 requires the value be quoted, hence the wrapping.
 *
 * `withContentLength` controls whether `Content-Length` is emitted.
 * Per RFC 9110 §8.6 the field describes the message body, not the
 * resource. For a HEAD 200 with no body, `Content-Length: <size>`
 * advertises what a subsequent GET would return -- standard and what
 * every HTTP client (rclone, browsers, curl) expects on HEAD. One
 * exception since #1419: a git-tracked file ABOVE the broker's buffer
 * ceiling is streamed and its GET carries no `Content-Length` at all,
 * so HEAD promises a length the GET does not repeat. Accepted rather
 * than fixed -- the ceiling is 8 MB against a 283 KB measured maximum,
 * so no real dataset reaches it -- but see `sizeCheckedBody` before
 * assuming the pair always agrees. For a
 * GET 302 with no body, emitting `Content-Length: <size>` is a spec
 * deviation: the message body is empty, the field would describe the
 * redirect target. Some intermediaries can mis-frame a long-`Content-
 * Length` 302 as a hung response, so the GET 302 branch deliberately
 * omits it and relies on the redirect target's S3 GET to advertise
 * size. `Last-Modified` and `ETag` remain on the 302 -- both are
 * valid on redirects per RFC 9110 §8.8.
 */
function fileResponseHeaders(
  file: ManifestFile,
  createdIso: string,
  withContentLength: boolean,
): HeadersInit {
  const base: Record<string, string> = {
    "Last-Modified": toHttpDate(createdIso),
    ETag: `"${file.checksum}"`,
    "Cache-Control": "public, max-age=300",
  };
  if (withContentLength) base["Content-Length"] = String(file.size);
  return base;
}

/**
 * GET /<id>/<version>/<path> -> 302 to file bytes, or HTML directory listing.
 * HEAD /<id>/<version>/<path> -> 200 with file metadata headers (no body),
 * or 200 with text/html content-type (no body) for directories.
 *
 * HEAD lets the rclone HTTP backend resolve every file's size and mtime
 * without following a redirect (rclone's HTTP backend does NOT follow
 * HEAD redirects by default). The tombstone walk is intentionally
 * skipped on HEAD: rclone fans out HEAD across every file it doesn't
 * have locally, and a 10-version walk per missing-path HEAD would
 * balloon a sync against a divergent local copy.
 */
async function fileOrIndexHandler(
  env: Bindings,
  request: Request,
  datasetId: string,
  versionParam: string,
  rawPath: string,
  defer: Defer | undefined,
): Promise<Response> {
  const isHead = request.method === "HEAD";
  const timing: FileTiming = {};

  const gateStart = performance.now();
  const dataset = await loadPublishedDataset(env, datasetId);
  if (!dataset) return notFound("Dataset not found");

  const resolved = await resolveVersion(env.DB, datasetId, versionParam);
  timing.gate = performance.now() - gateStart;
  if (!resolved.ok) return notFound("Version not found");

  // One scan answers the file-or-directory question; it keeps the entry, or
  // this directory's immediate children, and nothing else (#1502).
  const manifestStart = performance.now();
  const read = await queryManifest(
    env,
    request,
    datasetId,
    resolved.version,
    () => new ResolvePathQuery(rawPath),
    `resolve:${rawPath}`,
    defer,
  );
  timing.manifest = performance.now() - manifestStart;
  if (read) timing.manifestDesc = read.source;
  if (!read) return notFound("Version not published");

  const result = read.answer;
  const createdIso = read.header.created;

  // HEAD branch: serve from `result` alone -- no D1 round-trip for
  // picker/footer (HEAD doesn't render HTML chrome), no tombstone walk
  // (rclone just needs the 404). Keeps `rclone sync` cheap per file. It also
  // never touches the git-file cache or GitHub (#1516): HEAD's shape has not
  // changed, only GET's has, and a rewritten Content-Type/HEAD-vs-GET
  // agreement contract is exactly what #1403 was careful about the first
  // time.
  if (isHead) {
    if (result.kind === "file") {
      const headers = new Headers(fileResponseHeaders(result.file, createdIso, true));
      // HEAD remains metadata-only; annex availability is checked only by GET.
      // Its file type and range capability still describe the GET response.
      headers.set("Content-Type", contentTypeForBidsPath(result.path));
      if (!isGitTrackedFile(result.file)) headers.set("Accept-Ranges", "bytes");
      applyServerTiming(headers, timing);
      return new Response(null, { status: 200, headers });
    }
    if (result.kind === "directory") {
      return new Response(null, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=60",
        },
      });
    }
    // not_found
    return new Response(null, {
      status: 404,
      headers: { "Cache-Control": "public, max-age=60" },
    });
  }

  // One D1 round-trip for the picker, the "removed since" diff, and the
  // tombstone walk. The query is cheap and used by every render path
  // below; fetching once keeps the handler at a single dataset_versions
  // read per request regardless of how many of those features fire.
  const versionRows = await loadVersionRows(env, datasetId);
  const versionTags = versionRows.map((r) => toVersionTag(r.version));
  const availableVersions: VersionPickerEntry[] = versionTags.map((tag) => ({
    version: tag,
    isCurrent: tag === resolved.version,
  }));

  if (result.kind === "not_found") {
    // Tombstone lookup: walk older versions newest-first looking for the
    // first one that contained this exact path. Cheap when the path
    // never existed (caps out at TOMBSTONE_LOOKBACK fetches) and useful
    // when the path was removed in a recent version.
    const currentIdx = versionTags.indexOf(resolved.version);
    const olderVersions =
      currentIdx === -1 ? versionTags.slice(1) : versionTags.slice(currentIdx + 1);
    const tombstonePath = rawPath.replace(/^\/+/, "").replace(/\/+$/, "");
    const lastSeen = await findLastSeenVersionBy({
      olderVersions,
      containsPath: async (v) => {
        const found = await queryManifest(
          env,
          request,
          datasetId,
          v,
          () => new ContainsPathQuery(tombstonePath),
          `contains:${tombstonePath}`,
          defer,
        );
        return found ? found.answer : null;
      },
    });
    const urlObj = new URL(request.url);
    const lastSeenHref = lastSeen
      ? `${urlObj.protocol}//${urlObj.host}/${datasetId}/${lastSeen.version}/${rawPath.replace(/^\/+/, "")}`
      : null;
    return fileNotFound({
      request,
      datasetId,
      version: resolved.version,
      path: rawPath,
      lastSeen: lastSeen && lastSeenHref ? { version: lastSeen.version, href: lastSeenHref } : null,
    });
  }

  if (result.kind === "file") {
    // git-tracked bytes are served from here rather than redirected to
    // GitHub (#1403): it is the only way a dataset whose repo is private
    // stays readable, and it is the only way we can count what we delivered.
    if (isGitTrackedFile(result.file)) {
      const response = await serveGitTrackedFile({
        env,
        request,
        datasetId: dataset.dataset_id,
        version: resolved.version,
        bidsPath: result.path,
        file: result.file,
        createdIso,
        defer,
        timing,
      });
      applyServerTiming(response.headers, timing);
      return withChunkGetUsage(request, response, 0);
    }
    const etag = `"${result.file.checksum}"`;
    const lastModified = toHttpDate(createdIso);
    const delivery = await resolveAnnexDelivery({
      options: s3OptionsFromEnv(env),
      datasetId: dataset.dataset_id,
      file: result.file,
      rangeHeader: request.headers.get("range"),
      ifRange: request.headers.get("if-range"),
      etag,
      lastModified,
      maxChunkGetRequests: chunkGetBudgetFromRequest(request),
    });
    if (delivery.kind === "missing") {
      console.error(
        `[data] ANNEX OBJECT MISSING dataset=${dataset.dataset_id} version=${resolved.version} path=${result.path} key=${result.file.key}`,
      );
      return manifestObjectMissing(dataset.dataset_id);
    }
    if (delivery.kind === "unavailable") {
      console.error(
        `[data] annex delivery unavailable dataset=${dataset.dataset_id} version=${resolved.version} path=${result.path}: ${delivery.reason}`,
      );
      return new Response(
        JSON.stringify({
          error:
            delivery.status === 502
              ? "Stored object does not match the published manifest"
              : "Unable to check stored object availability",
          dataset_id: dataset.dataset_id,
        }),
        {
          status: delivery.status,
          headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
        },
      );
    }

    if (delivery.kind === "plain") {
      const url = await buildRedirectUrl({
        datasetId: dataset.dataset_id,
        version: resolved.version,
        bidsPath: result.path,
        file: result.file,
        s3Options: s3OptionsFromEnv(env),
      });
      // Content-Length is omitted on the 302: it describes the empty message
      // body, not the redirect target. S3 answers with the selected byte count.
      const headers = new Headers(fileResponseHeaders(result.file, createdIso, false));
      headers.set("Location", url);
      headers.set("Accept-Ranges", "bytes");
      headers.set("Access-Control-Allow-Origin", "*");
      applyServerTiming(headers, timing);
      return withChunkGetUsage(request, new Response(null, { status: 302, headers }), 0);
    }

    const headers = new Headers(fileResponseHeaders(result.file, createdIso, false));
    headers.set("Content-Length", String(delivery.contentLength));
    headers.set("Content-Type", contentTypeForBidsPath(result.path));
    headers.set(
      "Content-Disposition",
      buildContentDisposition(result.path.split("/").pop() ?? result.path),
    );
    headers.set("Accept-Ranges", "bytes");
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set(
      "Access-Control-Expose-Headers",
      "Accept-Ranges, Content-Length, Content-Range, ETag",
    );
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
    if (delivery.contentRange) {
      headers.set("Content-Range", delivery.contentRange);
    }
    if (delivery.status === 416) headers.set("Cache-Control", "no-store");
    applyServerTiming(headers, timing);
    return withChunkGetUsage(
      request,
      new Response(delivery.body, { status: delivery.status, headers }),
      delivery.chunkGetRequests,
    );
  }

  if (result.kind === "directory") {
    // JSON content negotiation runs BEFORE the removed-since diff so the
    // JSON path doesn't pay an extra D1 round-trip + manifest fetch it
    // doesn't need. Follows the same `pickResponseFormat` + early-return
    // approach as `qaHandler` and `datasetRootResponse` further down,
    // though `qaHandler` additionally folds HEAD into its JSON branch
    // (HEAD on this directory route stays text/html — see line ~371 —
    // for rclone-style consumers that ignore Accept).
    //
    // Shape note: the QA equivalent carries `truncated` because its
    // resolver is backed by a paged S3 ListObjectsV2. The manifest-
    // backed `resolveFile` here materialises every child up-front, so
    // a `truncated` field would always be false — omitting it
    // deliberately rather than emitting a permanent-`false`.
    //
    // `Vary: "Accept"` is required: HTML and JSON share the same URL,
    // and a shared cache without Vary in its key would mix them. The
    // `?format=` variant sidesteps the issue because the URL differs,
    // but `Accept`-only requests need it.
    //
    // Programmatic consumers (the website's tree UI primarily — see
    // nemarOrg/website#76 for the pivot off summary.json) get the same
    // `result.children` shape the HTML renderer consumes, no parallel
    // serializer to drift out of sync. Issue #636.
    const accept = request.headers.get("accept");
    const formatParam = new URL(request.url).searchParams.get("format");
    const fmt = pickResponseFormat({ accept, formatParam });

    if (fmt === "json") {
      const body = {
        dataset_id: datasetId,
        version: resolved.version,
        path: result.path,
        kind: "directory" as const,
        children: result.children,
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=60",
          Vary: "Accept",
        },
      });
    }

    // Compare this directory's listing against the immediately-prior
    // version. The prior version is the next row in versionTags after
    // the current one (rows are sorted newest-first). Skip the diff
    // when there is no older version, or when the prior manifest
    // isn't available -- the absence of a footer is harmless.
    const currentIdx = versionTags.indexOf(resolved.version);
    let removedSinceNote: { lastSeenVersion: string; names: string[] } | null = null;
    if (currentIdx >= 0 && currentIdx < versionTags.length - 1) {
      const priorVersion = versionTags[currentIdx + 1];
      const prior = await queryManifest(
        env,
        request,
        datasetId,
        priorVersion,
        () => new ResolvePathQuery(result.path),
        `resolve:${result.path}`,
        defer,
      );
      if (prior) {
        const removed = diffRemovedSinceResolved(result.children, prior.answer);
        if (removed.length > 0) {
          removedSinceNote = { lastSeenVersion: priorVersion, names: removed };
        }
      }
    }

    const html = renderIndexHtml({
      datasetId,
      version: resolved.version,
      path: result.path,
      entries: result.children,
      availableVersions,
      removedSinceNote,
    });
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=60",
        Vary: "Accept",
      },
    });
  }

  // Exhaustive guard: if a future ResolvedFile arm is added without
  // updating this handler, TypeScript fails the build right here.
  const _exhaustive: never = result;
  throw new Error(`unhandled ResolvedFile kind: ${JSON.stringify(_exhaustive)}`);
}

dataRoutes.get("/:datasetId/:version/manifest.json", (c) => {
  const { datasetId, version } = c.req.param();
  return manifestJsonHandler(c.env, c.req.raw, datasetId, version, deferOf(c));
});

/**
 * GET /<id>/<version>/summary.json -> static-passthrough summary artifact
 * (epic #559, PR-1, issue #558).
 *
 * Sibling to manifest.json. Emitted by the central manifest-generation
 * workflow on `nemarDatasets/.github` (Stream A; relocated #564) at S3 key
 * `<id>/version/v<X.Y.Z>-summary.json`. Stream A's writer owns the shape
 * contract; this handler serves the bytes verbatim with no per-request
 * mutation (no presigned URLs, no field rewriting). That's why it gets a
 * long s-maxage: every byte is deterministic from the published version.
 *
 * Cache policy diverges intentionally from manifest.json:
 *  - manifest.json uses max-age=300 to bound authorization staleness
 *    (ADR 0066). Its stable data-plane URLs do not depend on bucket policy,
 *    but a manifest can be rewritten in place and dataset visibility can
 *    change.
 *  - summary.json is path-only and immutable for the (datasetId, version)
 *    pair, so it gets s-maxage=86400 with stale-while-revalidate.
 */
async function summaryJsonHandler(
  env: Bindings,
  datasetId: string,
  versionParam: string,
): Promise<Response> {
  const dataset = await loadPublishedDataset(env, datasetId);
  if (!dataset) return notFound("Dataset not found", undefined, true);

  const resolved = await resolveVersion(env.DB, datasetId, versionParam);
  if (!resolved.ok) return notFound("Version not found", undefined, true);

  let raw: string | null;
  try {
    raw = await loadSummary(s3OptionsFromEnv(env), datasetId, resolved.version);
  } catch (err) {
    console.error(
      `[data] summary fetch failed dataset=${datasetId} version=${resolved.version}:`,
      err instanceof Error ? err.message : String(err),
    );
    // 5xx S3 outages, SigV4 failures, IAM drift (403 from loadSummary)
    // must NOT collapse into a cacheable 404. Return an uncached 500 so
    // an operator-side alert fires and the CDN doesn't pin the failure.
    return new Response(JSON.stringify({ error: "Failed to retrieve summary" }), {
      status: 500,
      // Uncached: a transient S3/SigV4/IAM failure must not be CDN-pinned.
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  if (raw === null) {
    // No negative caching: the primary consumer is the post-publish
    // refresh, where a CDN-cached 404 from before Stream A's workflow
    // wrote the summary would confuse publishers. `no-store` ensures a
    // freshly-published summary becomes visible on the next request.
    return new Response(JSON.stringify({ error: "Summary not found for this version" }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  }

  return new Response(raw, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300, s-maxage=86400, stale-while-revalidate=86400",
    },
  });
}

dataRoutes.get("/:datasetId/:version/summary.json", (c) => {
  const { datasetId, version } = c.req.param();
  return summaryJsonHandler(c.env, datasetId, version);
});

/**
 * GET /<id>/<version>/records.json -> static-passthrough records artifact (#615).
 *
 * Sibling to summary.json. Emitted by the central generate-records workflow
 * on `nemarDatasets/.github` at S3 key `<id>/version/v<X.Y.Z>-records.json`
 * (an array of neuroschema v0.4.1 `record` docs, one per primary signal
 * file). The emitter owns the shape contract; this handler serves the bytes
 * verbatim. Same cache policy as summary.json: immutable per (id, version),
 * so a long s-maxage; a missing artifact is `no-store` 404 (no negative
 * caching) so a freshly-published records.json appears on the next request.
 */
async function recordsJsonHandler(
  env: Bindings,
  datasetId: string,
  versionParam: string,
): Promise<Response> {
  const dataset = await loadPublishedDataset(env, datasetId);
  if (!dataset) return notFound("Dataset not found", undefined, true);

  const resolved = await resolveVersion(env.DB, datasetId, versionParam);
  if (!resolved.ok) return notFound("Version not found", undefined, true);

  let raw: string | null;
  try {
    raw = await loadRecords(s3OptionsFromEnv(env), datasetId, resolved.version);
  } catch (err) {
    console.error(
      `[data] records fetch failed dataset=${datasetId} version=${resolved.version}:`,
      err instanceof Error ? err.message : String(err),
    );
    // 5xx S3 outages, SigV4 failures, IAM drift (403 from loadRecords) must
    // NOT collapse into a cacheable 404. Return an uncached 500 so an
    // operator-side alert fires and the CDN doesn't pin the failure.
    return new Response(JSON.stringify({ error: "Failed to retrieve records" }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  if (raw === null) {
    // No negative caching: records.json is generated asynchronously after
    // the version tag (it can lag the publish, esp. before the records
    // workflow runs). `no-store` ensures a freshly-published records.json
    // becomes visible on the next request rather than serving a pinned 404.
    return new Response(JSON.stringify({ error: "Records not found for this version" }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  }

  return new Response(raw, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300, s-maxage=86400, stale-while-revalidate=86400",
    },
  });
}

dataRoutes.get("/:datasetId/:version/records.json", (c) => {
  const { datasetId, version } = c.req.param();
  return recordsJsonHandler(c.env, datasetId, version);
});

/**
 * GET /<id>/metadata.json -> dataset-level neuroschema v0.4.1 document.
 *
 * Combines the D1 catalog row, the parsed nemar_metadata.json enrichment
 * payload, and (when at least one version exists) a derived BIDS index from
 * the latest version's S3 manifest. Public datasets only; private/unknown
 * collapse to 404 with no existence leak. Partial-enrichment cases never
 * 500: missing inputs degrade to null fields in the response.
 *
 * MUST be registered before `/:datasetId/:version` -- otherwise Hono's
 * param-matching captures `metadata.json` as a version string.
 */
async function metadataJsonHandler(
  env: Bindings,
  request: Request,
  datasetId: string,
  defer: Defer | undefined,
): Promise<Response> {
  const gate = await loadPublishedDataset(env, datasetId);
  if (!gate) return notFound("Dataset not found");

  const row = await env.DB.prepare(
    `SELECT dataset_id, name, description, github_repo, concept_doi, anonymous,
            modalities, subject_count, age_min, age_max,
            file_size, total_files, tasks, enrichment_json,
            data_complete, bytes_present,
            total_recording_duration, recording_duration_min, recording_duration_max,
            recording_count, recordings_unavailable, recordings_measured,
            channel_count_min, channel_count_max,
            sampling_frequency, power_line_frequency, eeg_reference,
            placement_scheme, electrode_system, data_papers
     FROM datasets
     WHERE dataset_id = ?`,
  )
    .bind(datasetId)
    .first<DatasetRowForMetadata & { enrichment_json: string | null }>();
  if (!row) {
    // The visibility gate just succeeded, so a null here means the row was
    // deleted (or replaced) between the two reads -- an infra anomaly worth
    // surfacing so it can be correlated with deletion events / D1 replica
    // lag, not a normal traffic pattern.
    console.warn(
      `[data] metadata.json: row disappeared after visibility gate dataset=${datasetId}`,
    );
    return notFound("Dataset not found");
  }

  const versionsResult = await env.DB.prepare(PUBLIC_DATASET_VERSIONS_SQL)
    .bind(datasetId)
    .all<DatasetVersionRow>();
  const versions = versionsResult.results ?? [];

  let parsedEnrichment = null;
  if (row.enrichment_json) {
    try {
      parsedEnrichment = parseNemarMetadata(JSON.parse(row.enrichment_json));
    } catch (err) {
      // Persistent data corruption (pipeline wrote invalid JSON), not a
      // transient issue. Surface at error level so it shows up in any future
      // exception-aggregation pipeline.
      console.error(
        `[data] metadata.json: corrupt enrichment_json dataset=${datasetId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  let manifestDigest: ManifestDigest | null = null;
  if (versions.length > 0) {
    const latest = versions[0];
    const versionTag = toVersionTag(latest.version);
    manifestDigest = await loadManifestDigest(env, request, datasetId, versionTag, defer);
    if (!manifestDigest) {
      console.warn(
        `[data] metadata.json: latest manifest unavailable dataset=${datasetId} version=${versionTag}; bids_index will be null`,
      );
    }
  }

  const payload = buildDatasetMetadataFromDigest({
    row: {
      dataset_id: row.dataset_id,
      name: row.name,
      description: row.description,
      github_repo: row.github_repo,
      anonymous: row.anonymous,
      concept_doi: row.concept_doi,
      modalities: row.modalities,
      subject_count: row.subject_count,
      age_min: row.age_min,
      age_max: row.age_max,
      file_size: row.file_size,
      total_files: row.total_files,
      tasks: row.tasks,
      data_complete: row.data_complete,
      bytes_present: row.bytes_present,
      total_recording_duration: row.total_recording_duration,
      recording_duration_min: row.recording_duration_min,
      recording_duration_max: row.recording_duration_max,
      recording_count: row.recording_count,
      recordings_unavailable: row.recordings_unavailable,
      recordings_measured: row.recordings_measured,
      channel_count_min: row.channel_count_min,
      channel_count_max: row.channel_count_max,
      sampling_frequency: row.sampling_frequency,
      power_line_frequency: row.power_line_frequency,
      eeg_reference: row.eeg_reference,
      placement_scheme: row.placement_scheme,
      electrode_system: row.electrode_system,
      data_papers: row.data_papers,
    },
    parsedEnrichment,
    versions,
    manifestDigest,
    githubOrg: ORG_NAME,
  });

  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60",
    },
  });
}

dataRoutes.get("/:datasetId/metadata.json", (c) => {
  const { datasetId } = c.req.param();
  return metadataJsonHandler(c.env, c.req.raw, datasetId, deferOf(c));
});

/**
 * GET /<id>/page-bundle.json?v=<version>
 *
 * One-RTT bundle of everything the dataset detail page needs at SSR time:
 * landing (versions, latest), enriched metadata (neuroschema), summary
 * (path-only, with embedded README at schema 1.1), and the catalog row.
 *
 * Designed for `ww2.nemar.org` to collapse its current 4-parallel SSR +
 * 2-deferred-client fetch waterfall to one. The website still renders the
 * BIDS tree progressively from `summary.paths` (nemarOrg/website#64).
 *
 * Cache policy:
 * - `complete=true` -> long s-maxage (the same dataset+version returns the
 *   same payload until a new publish updates either metadata or summary).
 * - `complete=false` (any upstream failed) -> `no-store` so a transient
 *   blip isn't pinned at the edge with stale-while-revalidate.
 *
 * MUST be registered before any `/:datasetId/:version/*` route (and before
 * the bare `/:datasetId/:version/*` catch-all near the bottom of this file)
 * so Hono doesn't treat `page-bundle.json` as a `:version` param. Same
 * registration-order rule that `metadata.json` and `qa` follow above.
 *
 * Epic #618 / phase 3 (#621).
 */
async function pageBundleHandler(
  env: Bindings,
  datasetId: string,
  versionParam: string | null,
): Promise<Response> {
  const gate = await loadPublishedDataset(env, datasetId);
  if (!gate) return notFound("Dataset not found");

  let bundle: Awaited<ReturnType<typeof buildPageBundle>>;
  try {
    bundle = await buildPageBundle(env, datasetId, versionParam);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[data] page-bundle assembly crashed dataset=${datasetId}:`, msg);
    return new Response(JSON.stringify({ error: "Failed to build page bundle" }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  return new Response(JSON.stringify(bundle), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": bundle.complete
        ? "public, max-age=60, s-maxage=300, stale-while-revalidate=86400"
        : "no-store",
    },
  });
}

dataRoutes.get("/:datasetId/page-bundle.json", (c) => {
  const { datasetId } = c.req.param();
  const version = new URL(c.req.url).searchParams.get("v");
  return pageBundleHandler(c.env, datasetId, version);
});

// ===========================================================================
// QA artifact route: /<id>/qa/*  (see #511)
//
// Mirrors `/data/qumulo/openneuro/processed/<id>/` from SDSC Hallu into
// `s3://nemar/<id>/qa/` via `scripts/hallu-qa-sync.sh` (hourly cron). This
// route exposes that tree at `data.nemar.org/<id>/qa/...`:
//
//   GET /<id>/qa/                                 -> directory listing (root)
//   GET /<id>/qa/dataqual.json                    -> 302 to presigned S3 GET
//   GET /<id>/qa/sub-001/                         -> directory listing
//   GET /<id>/qa/sub-001/eeg/foo_icaact.svg       -> 302 to presigned S3 GET
//
// Registered BEFORE `/:datasetId/:version/*` so the Hono router does not
// interpret `qa` as a version param. The QA tree is NOT version-locked --
// it reflects whichever pipeline run last published; the website expects
// `/<id>/qa/...` not `/<id>/<v>/qa/...`. Phase 3 punts per-version QA.
//
// Visibility: same gate as the rest of this sub-app — public datasets
// only. Private/unknown datasets 404 with no existence leak.
//
// Cache-Control: 300s — QA artifacts are stable per pipeline run; 5 min is
// a reasonable client-side cache while leaving the website responsive to
// post-sync refreshes.
// ===========================================================================
async function qaHandler(
  env: Bindings,
  request: Request,
  datasetId: string,
  rawPath: string,
): Promise<Response> {
  const dataset = await loadPublishedDataset(env, datasetId);
  if (!dataset) return notFound("Dataset not found");

  const s3 = s3OptionsFromEnv(env);
  let resolved: Awaited<ReturnType<typeof resolveQaPath>>;
  try {
    resolved = await resolveQaPath({ s3Options: s3, datasetId, rawPath });
  } catch (err) {
    console.error(
      `[data] QA resolve crashed dataset=${datasetId} path=${rawPath}:`,
      err instanceof Error ? err.message : String(err),
    );
    return notFound("QA path not found");
  }

  if (resolved.kind === "not_found") {
    return notFound("QA path not found");
  }

  const isHead = request.method === "HEAD";

  if (resolved.kind === "file") {
    if (isHead) {
      // Mirror the version-route HEAD semantics: 200 with metadata headers,
      // no presign round-trip required so rclone can size+mtime cheaply.
      return new Response(null, {
        status: 200,
        headers: {
          "Content-Length": String(resolved.size),
          "Last-Modified": toHttpDate(resolved.lastModified),
          ETag: `"${resolved.size}-${resolved.lastModified}"`,
          "Cache-Control": "public, max-age=300",
        },
      });
    }
    // QA files in S3 already have BIDS-shaped keys (the sync mirrors paths
    // directly under `<id>/qa/<bids-path>`), so the presigned URL basename
    // is already the BIDS name. No Content-Disposition override needed
    // here — that fix in #513 only applies to annex-keyed dataset files
    // where the S3 key is content-addressed (`SHA256E-...`).
    const url = await generatePresignedGetUrl(s3, resolved.key, 3600);
    return new Response(null, {
      status: 302,
      headers: {
        Location: url,
        "Cache-Control": "public, max-age=300",
        "Last-Modified": toHttpDate(resolved.lastModified),
        ETag: `"${resolved.size}-${resolved.lastModified}"`,
      },
    });
  }

  // Directory listing.
  const accept = request.headers.get("accept");
  const formatParam = new URL(request.url).searchParams.get("format");
  const fmt = pickResponseFormat({ accept, formatParam });

  if (fmt === "json" || isHead) {
    const body = {
      dataset_id: datasetId,
      path: resolved.path,
      kind: "directory" as const,
      children: resolved.children,
      truncated: resolved.truncated,
    };
    return new Response(isHead ? null : JSON.stringify(body), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
        Vary: "Accept",
      },
    });
  }

  const html = renderIndexHtml({
    datasetId,
    // The QA tree is not version-locked. Reuse the existing index renderer
    // by passing a synthetic "qa" version label so the breadcrumb reads
    // sensibly to humans. There is no version-picker UI to surface here.
    version: "qa",
    path: resolved.path,
    entries: resolved.children,
    availableVersions: [],
    removedSinceNote: null,
  });
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      Vary: "Accept",
    },
  });
}

dataRoutes.get("/:datasetId/qa", async (c) => {
  // Redirect /<id>/qa -> /<id>/qa/ for trailing-slash consistency with the
  // version route. Pre-check visibility so we don't echo a 308 Location for
  // a private or nonexistent dataset (information disclosure parity with the
  // version-route 308 handler).
  const { datasetId } = c.req.param();
  const dataset = await loadPublishedDataset(c.env, datasetId);
  if (!dataset) return notFound("Dataset not found");
  const url = new URL(c.req.url);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return new Response(null, {
    status: 308,
    headers: { Location: url.toString(), "Cache-Control": "public, max-age=300" },
  });
});

dataRoutes.get("/:datasetId/qa/", (c) => {
  return qaHandler(c.env, c.req.raw, c.req.param("datasetId"), "");
});

dataRoutes.get("/:datasetId/qa/*", (c) => {
  const datasetId = c.req.param("datasetId");
  const prefix = `/${datasetId}/qa/`;
  const idx = c.req.path.indexOf(prefix);
  const rawPath = idx === -1 ? "" : c.req.path.slice(idx + prefix.length);
  return qaHandler(c.env, c.req.raw, datasetId, rawPath);
});

// Redirect /<id>/<version> -> /<id>/<version>/ so the relative `../` link in
// the rendered index resolves correctly. Only redirect when the dataset is
// actually public so we don't echo private/nonexistent ids back in a 308
// Location header.
dataRoutes.get("/:datasetId/:version", async (c) => {
  const { datasetId, version } = c.req.param();
  const dataset = await loadPublishedDataset(c.env, datasetId);
  if (!dataset) return notFound("Dataset not found");

  // Archive zip download: /<id>/<version>.zip -> 302 to the presigned S3
  // archive (stored at <id>/archives/<id>_v<version>.zip since #1491; the
  // pre-#1491 <id>/archives/v<version>.zip is read as a fallback during the
  // rename sweep's transition window, see resolveArchiveKey in services/s3).
  // The website's archiveZipUrl() links here (nemarOrg/website
  // src/lib/data-api.ts) and expects the Worker to resolve+presign. Without
  // this branch the request falls through to the 308 below, then
  // resolveVersion("v1.0.0.zip") fails the version regex and 404s even
  // though the archive exists. (#670)
  if (version.endsWith(".zip")) {
    // `resolveVersion` only checked the STRING SHAPE for a non-"latest"
    // version (review finding): a well-formed but never-published version
    // (e.g. `v99.99.99`) resolves `ok: true` exactly like a real one. Left
    // unchecked, that fell into the `not_latest_version` branch below with a
    // `browse_url` that itself 404s, rather than a plain "not found." Confirm
    // the version actually exists BEFORE asking whether it is the latest one.
    //
    // Both calls can read D1 (`resolveVersion` does for `latest.zip`,
    // `versionExists` always does), so both sit in one try: a D1 fault here
    // is a 503, like the size lookup and the archive HEAD below, never a
    // bare 500.
    let resolved: ResolvedVersion;
    let published = false;
    try {
      resolved = await resolveVersion(c.env.DB, datasetId, version.slice(0, -4));
      if (resolved.ok) published = await versionExists(c.env.DB, datasetId, resolved.version);
    } catch (err) {
      console.error(`[data] archive version lookup failed for ${datasetId}:`, err);
      return c.json({ error: ARCHIVE_CHECK_FAILED_MESSAGE }, 503);
    }
    if (!resolved.ok || !published) return notFound("Version not found");

    // ADR 0012 review, and review-of-the-review: the size policy is checked
    // HERE, before the not-latest check below, deliberately. An over-policy
    // dataset never gets an archive for ANY version, so "not the latest" is
    // misleading for it too -- reproduced: a 130 GiB dataset with published
    // versions v1.0.0 and v1.0.1 (latest) answered `GET /<id>/v1.0.0.zip`
    // with `reason: "not_latest_version"`, which reads as "download v1.0.1
    // instead," but v1.0.1 has no archive either and never will. Checking
    // policy first means EVERY version of an over-policy dataset answers the
    // same honest `archive_skipped`, not just the latest one.
    //
    // An over-policy dataset's zip is never GENERATED, but a zip built before
    // the dataset grew past the policy -- or before the policy applied to it
    // at all -- can still be sitting in S3 (measured in production: nm000323
    // v1.0.4 and nm000348 v1.0.5 were serving 302s to a 120 GiB and a 109 GiB
    // zip that predated the policy). This route used to check only whether
    // the S3 object existed, never the policy, so a stray zip served fine,
    // and once an operator deleted it the request fell through to "not yet
    // available" below, which is false for a dataset that will never get an
    // archive. Decide the policy from the SAME rule the archive-ready
    // dispatcher and the admin sweep already use (`shouldSkipArchive`), never
    // a second copy of the thresholds, and do it BEFORE resolving the S3 key
    // at all so a stray zip is never served. A D1 fault here is a 503, the
    // same as a fault in the archive-key HEAD below -- never a bare 500.
    let sizeRow: { file_size: number | null; total_files: number | null } | null;
    try {
      sizeRow = await c.env.DB.prepare(
        "SELECT file_size, total_files FROM datasets WHERE dataset_id = ?",
      )
        .bind(datasetId)
        .first<{ file_size: number | null; total_files: number | null }>();
    } catch (err) {
      console.error(`[data] archive size-policy lookup failed for ${datasetId}:`, err);
      return c.json({ error: ARCHIVE_CHECK_FAILED_MESSAGE }, 503);
    }
    const sizePolicy = shouldSkipArchive({
      totalBytes: sizeRow?.file_size,
      totalFiles: sizeRow?.total_files,
    });
    if (sizePolicy.skip) {
      return notFound(sizePolicy.reason ?? "archive skipped (size policy)", {
        version: resolved.version,
        path: `${resolved.version}.zip`,
        reason: "archive_skipped",
        browse_url: `/${datasetId}/${resolved.version}/`,
      });
    }

    // #1518: only the latest version keeps a retained archive -- an
    // older-version zip is deleted once the newer one's upload is confirmed
    // (going forward), and the lead's one-time sweep already removed what
    // existed for older versions before this shipped. Without this check an
    // older version's zip request falls through to the "not yet available"
    // 404 below, which reads as "still building" for a zip that will never
    // exist under any name; say so plainly and point at the browsable files
    // instead of a failed download. Reached only for a WITHIN-policy dataset
    // now: an over-policy one already returned above, for every version.
    let latestResolved: ResolvedVersion;
    try {
      latestResolved = await resolveVersion(c.env.DB, datasetId, "latest");
    } catch (err) {
      console.error(`[data] archive latest-version lookup failed for ${datasetId}:`, err);
      return c.json({ error: ARCHIVE_CHECK_FAILED_MESSAGE }, 503);
    }
    if (latestResolved.ok && resolved.version !== latestResolved.version) {
      return notFound(
        "Only the latest version has a downloadable archive; download files directly.",
        {
          version: resolved.version,
          path: `${resolved.version}.zip`,
          reason: "not_latest_version",
          latest_version: latestResolved.version,
          browse_url: `/${datasetId}/${resolved.version}/`,
        },
      );
    }

    const s3 = s3OptionsFromEnv(c.env);
    // Resolve (HEAD) the archive key ONCE: the archive is generated
    // asynchronously after publish, so a download click in that window
    // would otherwise 302 to a presigned URL that dumps an S3 NoSuchKey XML
    // error; return a clean 404 instead. A credentials/5xx error throws ->
    // 503. (#670, review). PR review: this used to call headArchive() then
    // getArchiveUrl() separately, each independently re-running
    // resolveArchiveKey's new-name/old-name fallback -- up to four
    // sequential HEADs during the #1491 transition window for what is one
    // decision. Resolving once and presigning the resolved key directly
    // halves that to at most two.
    let archiveKeyResolved: string | null;
    try {
      archiveKeyResolved = await resolveArchiveKey(s3, datasetId, resolved.version);
    } catch (err) {
      console.error(`[data] archive HEAD failed for ${datasetId} ${resolved.version}:`, err);
      return c.json({ error: ARCHIVE_CHECK_FAILED_MESSAGE }, 503);
    }
    if (!archiveKeyResolved) {
      // Reached only for a WITHIN-policy dataset (the over-policy case
      // returned above, before this HEAD): a missing zip here really is
      // still being built, never a zip that will never exist.
      return notFound(
        "Archive not yet available for this version (generation may still be in progress)",
      );
    }
    const archiveUrl = await generatePresignedGetUrl(s3, archiveKeyResolved);
    // Count the download (not HEAD probes). bytes=0: the Worker 302s to S3 and
    // never streams the archive, so it can't measure transferred bytes.
    if (c.req.method === "GET") {
      recordAccess(c.env, { datasetId, source: "archive", detail: resolved.version });
    }
    // no-store: the Location carries a presigned, time-limited S3 URL; don't
    // let a CDN serve one shared signed URL to many clients.
    return new Response(null, {
      status: 302,
      headers: { Location: archiveUrl, "Cache-Control": "no-store" },
    });
  }

  const url = new URL(c.req.url);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  // Response.redirect emits no Cache-Control. Without one, downstream
  // caches apply heuristic TTLs (often very long for 308) and a
  // client following the redirect repeatedly would still hit the
  // Worker each time only because the URL changes. Pin to 300s for
  // consistency with the rest of the route's caching matrix.
  return new Response(null, {
    status: 308,
    headers: {
      Location: url.toString(),
      "Cache-Control": "public, max-age=300",
    },
  });
});

// Hono v4 auto-derives HEAD from the registered GET handler -- it
// re-dispatches the original Request (method still "HEAD") through
// this handler and strips the body. The `isHead` branch inside
// `fileOrIndexHandler` reads `request.method` and short-circuits to
// a 200 + metadata headers for files (or 200 + text/html for
// directories) without doing the buildRedirectUrl S3 presign or the
// tombstone walk. So `rclone sync :http:...` can size+mtime+ETag
// every file in one cheap round-trip per file. No explicit HEAD
// route registration is needed.
dataRoutes.get("/:datasetId/:version/*", (c) => {
  const { datasetId, version } = c.req.param();
  // Trailing-slash archive form (/<id>/<version>.zip/) -> redirect to the
  // canonical no-slash URL, which the /:datasetId/:version handler presigns.
  // (#670 -- otherwise resolveVersion("v1.0.0.zip") 404s here.)
  if (version.endsWith(".zip")) {
    return new Response(null, {
      status: 308,
      headers: { Location: `/${datasetId}/${version}`, "Cache-Control": "public, max-age=300" },
    });
  }
  const prefix = `/${datasetId}/${version}/`;
  const idx = c.req.path.indexOf(prefix);
  const rawPath = idx === -1 ? "" : c.req.path.slice(idx + prefix.length);
  return fileOrIndexHandler(c.env, c.req.raw, datasetId, version, rawPath, deferOf(c));
});

/**
 * GET /<id> and /<id>/ -> sitemap-style landing page listing every
 * published version of the dataset.
 *
 * Content negotiation: HTML for browsers (Accept: text/html), JSON
 * for everything else. The JSON shape is `LandingPayload` and is the
 * machine entry point for "what versions does this dataset have?".
 *
 * Unknown / private datasets 404 with no existence leak (the same
 * pattern loadPublishedDataset enforces everywhere else). A dataset
 * that exists but has no published versions returns the landing page
 * with an empty version list and an "unpublished" notice (status 200) --
 * the row is real, just not ready to serve files yet.
 */
async function datasetRootResponse(
  env: Bindings,
  request: Request,
  datasetId: string,
): Promise<Response> {
  const dataset = await loadPublishedDataset(env, datasetId);
  if (!dataset) return notFound("Dataset not found");

  const versionRows = await loadVersionRows(env, datasetId);
  const payload = buildLandingPayload({
    datasetId,
    versionRows,
    archive: {
      status: dataset.archive_status,
      size: dataset.archive_size,
      skip_reason: dataset.archive_skip_reason,
      checked_at: dataset.archive_checked_at,
    },
  });

  const accept = request.headers.get("accept");
  const formatParam = new URL(request.url).searchParams.get("format");
  const fmt = pickResponseFormat({ accept, formatParam });

  // Vary: Accept tells shared caches that the response body depends on
  // the Accept header, so a browser request (HTML) and a machine request
  // (JSON) don't poison each other's cached copy at the same URL.
  if (fmt === "json") {
    return new Response(JSON.stringify(payload), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60",
        Vary: "Accept",
      },
    });
  }

  const html = renderDatasetLandingHtml(payload);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      Vary: "Accept",
    },
  });
}

dataRoutes.get("/:datasetId", (c) =>
  datasetRootResponse(c.env, c.req.raw, c.req.param("datasetId")),
);
dataRoutes.get("/:datasetId/", (c) =>
  datasetRootResponse(c.env, c.req.raw, c.req.param("datasetId")),
);

/**
 * GET / -> catalog index of every publicly-hosted dataset.
 *
 * SQL filter (`visibility='public' AND dataset_id NOT LIKE 'xx%' AND
 * dataset_id <> 'nm099999'`) mirrors the predicate `loadPublishedDataset`
 * enforces on every per-id route, with `xx*` and the E2E-test id stripped.
 * `buildCatalogIndexPayload` re-asserts the id filter (including a strict
 * `isValidDatasetId` shape check) in pure TS as defense in depth, so a
 * malformed id can never reach the renderer or an `href=` attribute.
 *
 * D1 failure path returns 503 with `Retry-After`, not a 200 with an empty
 * list. The whole response *is* the D1 result here, so silently degrading
 * to "no datasets hosted" would misrepresent system state to humans and
 * starve monitoring of the 5xx signal. The response is not cached, so the
 * next request retries naturally once D1 recovers.
 */
export async function catalogIndexResponse(env: Bindings, request: Request): Promise<Response> {
  const cfRay = request.headers.get("cf-ray") ?? "unknown";
  const accept = request.headers.get("accept");
  const formatParam = new URL(request.url).searchParams.get("format");
  const fmt = pickResponseFormat({ accept, formatParam });

  let rows: CatalogIndexRow[] | null = null;
  try {
    const result = await env.DB.prepare(
      `SELECT
         d.dataset_id,
         d.name,
         ${CONCEPT_DOI_SQL} AS concept_doi,
         d.is_exemplar,
         (SELECT version FROM dataset_versions dv
            WHERE dv.dataset_id = d.dataset_id
            ORDER BY dv.created_at DESC LIMIT 1) AS latest_version,
         (SELECT created_at FROM dataset_versions dv
            WHERE dv.dataset_id = d.dataset_id
            ORDER BY dv.created_at DESC LIMIT 1) AS latest_published_at
       FROM datasets d
       WHERE d.visibility = 'public'
         AND (d.dataset_id NOT LIKE 'xx%' OR d.is_exemplar = 1)
         AND d.dataset_id <> 'nm099999'
       ORDER BY d.dataset_id`,
    ).all<CatalogIndexRow>();
    rows = result.results ?? [];
  } catch (err) {
    console.error(
      `[data] catalog index D1 query failed cf-ray=${cfRay}:`,
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
  }

  if (rows === null) {
    return catalogUnavailableResponse(fmt);
  }

  const built: CatalogIndexBuildResult = buildCatalogIndexPayload({ rows });
  if (built.droppedIds.length > 0) {
    // SQL and TS filters disagree -> schema drift, not a routine case.
    console.warn(
      `[data] catalog index dropped ${built.droppedIds.length} ids that SQL accepted: ${built.droppedIds.join(",")}`,
    );
  }

  if (fmt === "json") {
    return new Response(JSON.stringify(built.payload), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60",
        Vary: "Accept",
      },
    });
  }

  return new Response(renderCatalogIndexHtml(built.payload), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      Vary: "Accept",
    },
  });
}

function catalogUnavailableResponse(fmt: "html" | "json"): Response {
  const baseHeaders = {
    "Retry-After": "30",
    Vary: "Accept",
  };
  if (fmt === "json") {
    return new Response(JSON.stringify({ error: "catalog_unavailable" }), {
      status: 503,
      headers: { ...baseHeaders, "Content-Type": "application/json" },
    });
  }
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>data.nemar.org</title>
<style>body{font-family:ui-monospace,Menlo,Consolas,monospace;margin:1.5em;max-width:60em}h1{font-size:1.1em}.foot{color:#888;font-size:.9em;margin-top:2em}</style>
</head><body>
<h1>Catalog temporarily unavailable</h1>
<p>The dataset catalog could not be loaded right now. Please try again in a few seconds.</p>
<div class="foot">data.nemar.org</div>
</body></html>
`;
  return new Response(html, {
    status: 503,
    headers: { ...baseHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
}

dataRoutes.get("/", (c) => catalogIndexResponse(c.env, c.req.raw));
