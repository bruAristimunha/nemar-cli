/**
 * `get_events` (epic #1065 phase 3, issue #1295).
 *
 * **Primary path** (`index.events_parquet` present, every v3 index that
 * parsed at least one events.tsv): reads the WHOLE parquet file once with
 * `hyparquet` on a per-store cache miss, groups rows by `store_path` (the
 * producer's own name for the store's `zarr` path --
 * `scripts/zarr/generate_zarr.py`'s `events_schema`), and writes EVERY
 * store's rows (`events/<zarr>`) to the projection cache in one pass -- one
 * dataset-wide
 * parquet read serves every recording's future `get_events` call, not just
 * the one this request named, up to {@link MAX_STORE_FANOUT_ENTRIES}
 * stores. `sample_index` comes back from hyparquet as a
 * `BigInt` (parquet INT64); converted to `Number` here, once, before the
 * value is cached or returned, with a `Number.isSafeInteger` guard -- the
 * whole point of the primary path is that `sample_index` is EXACT, so a
 * value that cannot round-trip through `Number` losslessly must throw, not
 * silently publish a wrong index. `source: "events_parquet"`,
 * `estimated: false` always on this path.
 *
 * **The parquet is the data source whenever the index names one; only the
 * PROJECTION CACHE is gated on a usable `source_commit`.** A dataset can, in
 * principle, have `events_parquet` set but no 40-hex commit to key a cache
 * entry on (the schema does not force one to imply the other); in that case
 * the cache is bypassed -- read fresh every call -- but the parquet is still
 * read, never silently swapped for the strictly-worse `events.tsv` fallback.
 *
 * **Codec: a hand-rolled ZSTD-only `compressors` map, not the
 * `hyparquet-compressors` package.** That package's `compressors` export
 * eagerly constructs its `SNAPPY` entry at module load
 * (`snappyUncompressor()` from the `hysnappy` dependency), which compiles a
 * WASM module synchronously -- `WebAssembly.Module(): Wasm code generation
 * disallowed by embedder`, reproduced under real workerd via `bunx wrangler
 * dev --local` against `mcp-smoke-entry.ts`, the SAME failure class
 * `blosc-decode.ts`'s module doc documents for `numcodecs`. This crashes the
 * WHOLE bundle at isolate startup, for every request, not just a
 * `get_events` call -- unacceptable regardless of whether any dataset's
 * parquet ever uses SNAPPY (none does today: every column in the live
 * nm000329 fixture is ZSTD). So `hyparquet-compressors` was removed from
 * `package.json`, and this file builds the one-entry `compressors` map
 * itself, straight from `fzstd` (the same pure-JS decoder `blosc-decode.ts`
 * already uses) -- functionally identical to what the package would have
 * supplied for ZSTD, with none of its SNAPPY baggage. A dataset whose
 * parquet ever used a codec other than ZSTD would throw here (hyparquet's
 * own error for a missing compressor entry), which is preferable to a
 * bundle that cannot start at all.
 *
 * Deliberately reads every column the parquet file has (no `columns` filter
 * on `parquetReadObjects`) rather than restricting to the eight named
 * fields on `eventRowSchema`: the schema is `.passthrough()` specifically
 * so `subject`/`session`/`task`/`run` (and any `x_`-prefixed extra) reach
 * the caller unchanged, which only holds if this read actually fetches
 * them.
 *
 * **A store the parquet has no rows for** (the converter never found or
 * parsed its events.tsv, distinct from a store with a genuinely empty
 * events.tsv, which is indistinguishable from this on the wire either way)
 * still gets, below the
 * {@link MAX_STORE_FANOUT_ENTRIES} bound, a `[]` cache entry written in the
 * SAME pass as every other store -- so a repeat call for that store is a
 * cache hit, never a re-read of the whole file. Either way the response
 * carries a `note` saying so explicitly rather than a bare empty list a
 * caller could misread as "this recording truly has no events".
 *
 * **Fallback path** (no `events_parquet` -- every v1/v2 index today):
 * derives the sibling `<prefix>_events.tsv` from the recording's `path`
 * (BIDS naming: replace the trailing `_<suffix>.<ext>` with `_events.tsv`)
 * and fetches it credential-free from `raw.githubusercontent.com` via the
 * SAME URL builder the zarr fidelity sweep uses
 * (`rawContentUrl`, `services/zarr-fidelity-sweep.ts`) rather than
 * duplicating it -- `ref` is the resolved 40-hex `source_commit` when
 * usable, else `main`. `sample_index` is computed locally against the
 * chosen group's SERVING `rate`; `source: "events_tsv_fallback"`,
 * `estimated: true` always -- the estimate is off by a sub-sample amount
 * wherever source and target rates are not integer multiples.
 * **Only a clean 404 means absence** (a missing file, OR a private repo,
 * which reads identically to an anonymous GET): that answers `events: []`
 * with a note; BIDS inheritance (walking up to a session/subject/
 * root-level events.tsv) is explicitly out of scope, and the note says so.
 * ANY OTHER non-2xx, or a thrown fetch (a network failure), is an
 * INFRASTRUCTURE failure, not an absence -- it answers a tool error naming
 * the HTTP status (or the thrown message) and the tsv path, and
 * `total_count` never comes from that failure (there is no total_count at
 * all; the call errors outright, mirroring `render_overview`'s
 * chunk-fetch-failure result).
 *
 * Never the data host (`data.nemar.org`): its file branch is a redirect,
 * not something this Worker can read in-process (`routes/data.ts` has no
 * injectable `fetch`).
 */

import type { CallToolResult } from "@modelcontextprotocol/server";
import { decompress as fzstdDecompress } from "fzstd";
import { asyncBufferFromUrl, parquetMetadataAsync, parquetReadObjects } from "hyparquet";
import type { Compressors, FileMetaData } from "hyparquet";
import { z } from "zod";
import {
  type EventColumnSummary,
  type EventRow,
  type EventRowOutput,
  GET_EVENTS_SUMMARY_MAX_VALUES,
  GET_EVENTS_SUMMARY_MAX_VALUE_CHARS,
  type GetEventsInput,
  type GetEventsOutput,
  eventRowSchema,
  getEventsOutputSchema,
} from "../../../../shared/contract/mcp.js";
import { SOURCE_COMMIT_RE } from "../../../../shared/contract/zarr-index.js";
import { rawContentUrl } from "../../services/github/shared.js";
import {
  datasetNotFoundResult,
  isZarrReady,
  loadPublicDatasetRow,
  zarrNotReadyResult,
} from "../catalog-row.js";
import { NO_COMMIT_NOTE, buildEnvelopeForStore } from "../envelope.js";
import { projectionUrl, readJsonProjection, writeJsonProjection } from "../projection-cache.js";
import type { RecordingToolDeps, ToolOutcome } from "../tool-types.js";
import {
  groupNotFoundResult,
  loadRecordingsProjection,
  recordingNotFoundResult,
  resolveRecording,
} from "./list-recordings.js";

const NO_EVENTS_FILE_NOTE =
  "no events file was found next to this recording (BIDS inheritance -- walking up to a " +
  "session/subject/root-level events.tsv -- is out of scope; only the exact sibling path was tried)";
const NO_RATE_NOTE =
  "the resolved recording/group has no known sampling rate, so events.tsv was NOT fetched at " +
  "all: every event row requires a sample_index and none could be computed. This is not a " +
  "statement that the recording has no events";
const NO_PARQUET_ROWS_NOTE =
  "events.parquet has no rows for this store (the converter may not have found or parsed its " +
  "events.tsv); the result may be incomplete";

function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function parquetReadFailedResult(
  datasetId: string,
  recording: string,
  detail: string,
): CallToolResult {
  return toolError(
    `get_events could not read events.parquet for recording "${recording}" in dataset ` +
      `"${datasetId}": ${detail}`,
  );
}

function tsvFetchFailedResult(
  datasetId: string,
  recording: string,
  tsvPath: string,
  detail: string,
): CallToolResult {
  return toolError(
    `get_events could not read the events.tsv fallback for recording "${recording}" in dataset ` +
      `"${datasetId}" (${tsvPath}): ${detail}`,
  );
}

/** `sample_index` is published as an EXACT int64; a value that cannot
 *  round-trip through `Number` losslessly (beyond `Number.MAX_SAFE_INTEGER`)
 *  would silently publish a wrong index, which is precisely the failure
 *  mode this column exists to prevent (`#1060`'s "exact, not estimated"
 *  promise). Throws with dataset/store context rather than truncating --
 *  this should never happen for a real recording (no dataset in the
 *  catalog is anywhere close to 2^53 samples), so a throw here means the
 *  parquet itself is corrupt, not that a cap was reached in practice. */
function toSafeSampleIndex(value: unknown, datasetId: string, storeZarr: string): number {
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(
      `get_events: sample_index ${String(value)} for store "${storeZarr}" in dataset ` +
        `"${datasetId}" is not a safe integer -- refusing to publish a lossy value`,
    );
  }
  return n;
}

/** ZSTD only -- see the module doc's "Codec" section for why this is not
 *  the `hyparquet-compressors` package. `outputLength` (the second
 *  parameter `Compressors[K]` is typed to accept) is unused, mirroring
 *  that package's own `ZSTD` entry: `fzstd`'s frame already carries its
 *  own decompressed size. */
const EVENTS_PARQUET_COMPRESSORS: Compressors = {
  ZSTD: (input) => fzstdDecompress(input),
};

/** Cached payload schemas (`projection-cache.ts`'s `readJsonProjection`
 *  validates every hit against one), declared next to the payload types
 *  they check -- a cache entry that fails validation (a stale shape from
 *  before `PROJECTION_SCHEMA_VERSION` was bumped, or simple corruption) is
 *  a miss, not a crash. */
/** Upper bound on the per-store `events/<zarr>` entries one parquet miss
 *  fans out into. The requested store's entry is ALWAYS written; the
 *  placeholder pass for every other store is skipped above this bound.
 *
 *  Store counts in the live catalog are not bounded by anything this code
 *  controls: nm000281 publishes 25,253 stores, on005873 10,944 (measured
 *  2026-09-08 from `zarr.nemar.org/catalog.json`). Writing one Response
 *  plus one `JSON.stringify` per store for a dataset that size, inside a
 *  single request's `waitUntil`, is a cost with no ceiling and no cache
 *  benefit proportional to it -- the fan-out exists so a SECOND call for a
 *  neighbouring store is a hit, which pays for itself on an ordinary
 *  dataset and not on a pathological one. Above the bound each store's
 *  first call re-reads the parquet, which is the behaviour that existed
 *  before the fan-out; the read itself is unchanged and still reported as
 *  a miss. */
export const MAX_STORE_FANOUT_ENTRIES = 2000;

/**
 * Upper bounds on the `events.parquet` this tool will read WHOLE.
 *
 * The fan-out bound above reasoned correctly that "store counts in the live
 * catalog are not bounded by anything this code controls" and then bounded only
 * the cache WRITES, not the read that precedes them. The read is the bigger
 * number. Measured 2026-09-09 against the live bucket: 285 public datasets
 * publish an `events.parquet`; 13 are over 5 MB, 6 over 20 MB, and nm000104 is
 * 99,863,763 bytes with 5,411,570 rows across 1131 stores.
 *
 * So `get_events(dataset_id: "nm000104", limit: 1)` -- anonymous, no auth --
 * used to pull 95 MB through the Worker, zstd-decompress it in pure JS,
 * materialize 5.4 M row objects, run 5.4 M zod parses, and only then apply
 * `limit`/`offset`. That cannot fit in a 128 MB isolate, and the failure
 * RE-AMPLIFIES: the isolate dies before `waitUntil` runs, so nothing is cached,
 * so the next attempt repeats the whole read. At the anonymous per-IP bucket
 * (500 per 60 s when this was measured) that is tens of GB/min of S3 egress from one IP with zero cache
 * progress.
 *
 * A file over either bound is not read whole, but it is not refused outright
 * either (#1498): the producer writes the file sorted by `store_path`, and every
 * row group carries min/max statistics for it, so the row groups that can hold
 * the requested store are known from the footer alone. Those are read, and the
 * same two bounds are applied to them instead of the file
 * ({@link storeRowGroupSpan}). The refusal that used to answer every recording
 * of a large dataset now answers only a recording whose own row groups are over
 * a bound, or a file without `store_path` statistics. nm000132 (ERP CORE) is
 * why: its file is 2.4 MB but 153,722 rows, so the row bound refused every one
 * of its 240 recordings, each a few hundred rows in one row group of about
 * 66,000.
 *
 * A refusal still costs the caller little: `index.json` publishes
 * `events_parquet` as a PUBLIC URL, so a client that genuinely wants 5.4 M rows
 * can fetch and query the file itself. Handing over a URL instead of streaming
 * bytes is exactly the recipe-first posture ADR 0049 sets for signal data.
 *
 * Both bounds are checked from `parquetMetadataAsync`, which this path already
 * fetches before any row is read, so a refusal costs one footer read.
 */
export const MAX_EVENTS_PARQUET_BYTES = 16 * 1024 * 1024;
export const MAX_EVENTS_PARQUET_ROWS = 100_000;

/** Thrown by {@link readEventsParquet} when a bound is exceeded. The
 *  caller already turns a throw from this path into a typed tool error, so this
 *  rides that seam rather than adding a second failure channel. */
export class EventsParquetTooLargeError extends Error {}

/** The cached per-store payload. The dropped-row COUNT travels with the rows,
 *  which it did not use to: the entry held a bare `EventRow[]`, so
 *  `invalidRowCount` was reported only to the one caller that happened to MISS,
 *  and every later call for that store was a hit reporting 0 dropped rows with
 *  `note: null` and a `total_count` that quietly omitted them. ADR 0005 wants
 *  the gap reported, not `console.warn`ed once on somebody else's request. */
const eventRowsProjectionSchema = z.object({
  rows: z.array(eventRowSchema),
  invalidRowCount: z.number().int().nonnegative(),
});

/** Byte order, as parquet compares BYTE_ARRAY statistics: JavaScript's `<`
 *  compares UTF-16 code units, which disagrees with UTF-8 byte order for a path
 *  holding a character above U+FFFF next to one in U+E000-U+FFFF. */
function compareUtf8(a: string, b: string): number {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return x.length - y.length;
}

/** The contiguous run of row groups that can hold `storeZarr`'s rows, from each
 *  row group's `store_path` min/max statistics, with what reading it costs.
 *  `null` when any row group has no usable statistics for `store_path`: then
 *  nothing short of reading the file says where a store's rows are. A run with
 *  no row groups (`rows: 0`) means the statistics prove the store has none.
 *
 *  Only `min_value`/`max_value` count, never the deprecated `min`/`max`, which
 *  older writers computed with a signed byte comparison. The run spans every
 *  row group between the first and last match, so a file that is not sorted
 *  after all is still read correctly, only less cheaply, and the bounds see
 *  that cost. Exported for its unit tests. */
export function storeRowGroupSpan(
  metadata: FileMetaData,
  storeZarr: string,
): { rowStart: number; rowEnd: number; rows: number; compressedBytes: number } | null {
  let first = -1;
  let last = -1;
  for (const [index, rowGroup] of metadata.row_groups.entries()) {
    const chunk = rowGroup.columns.find(
      (c) => c.meta_data?.path_in_schema.join(".") === "store_path",
    );
    const stats = chunk?.meta_data?.statistics;
    const min = stats?.min_value;
    const max = stats?.max_value;
    if (typeof min !== "string" || typeof max !== "string") return null;
    if (compareUtf8(min, storeZarr) <= 0 && compareUtf8(storeZarr, max) <= 0) {
      if (first === -1) first = index;
      last = index;
    }
  }
  if (first === -1) return { rowStart: 0, rowEnd: 0, rows: 0, compressedBytes: 0 };
  let rowStart = 0;
  for (let i = 0; i < first; i++) rowStart += Number(metadata.row_groups[i].num_rows);
  let rows = 0;
  let compressedBytes = 0;
  for (let i = first; i <= last; i++) {
    const rowGroup = metadata.row_groups[i];
    rows += Number(rowGroup.num_rows);
    compressedBytes += Number(
      rowGroup.total_compressed_size ??
        rowGroup.columns.reduce((sum, c) => sum + (c.meta_data?.total_compressed_size ?? 0n), 0n),
    );
  }
  return { rowStart, rowEnd: rowStart + rows, rows, compressedBytes };
}

/** Reads the whole file when it is within both bounds, and otherwise only the
 *  row groups that can hold `storeZarr` (see {@link MAX_EVENTS_PARQUET_BYTES}).
 *  `scope` says which: on `"store"`, `byStore` is complete for `storeZarr`
 *  alone, since the other stores in those row groups may continue outside them. */
async function readEventsParquet(
  deps: RecordingToolDeps,
  datasetId: string,
  eventsParquetUrl: string,
  storeZarr: string,
): Promise<{
  byStore: Map<string, EventRow[]>;
  bytesFetched: number;
  invalidRowCountByStore: Map<string, number>;
  scope: "file" | "store";
}> {
  let bytesFetched = 0;
  const countingFetch: typeof fetch = async (input, init) => {
    const res = await deps.fetch(input, init);
    // `content-length` first, but fall back to the body's own byte length when
    // the header is absent or unparseable -- the same thing `array-metadata.ts`
    // does, and for the same reason: this figure is what would reveal an
    // oversized read, so it must not silently report 0.
    const header = Number(res.headers.get("content-length"));
    if (Number.isFinite(header) && header > 0) {
      bytesFetched += header;
      return res;
    }
    const buf = await res.clone().arrayBuffer();
    bytesFetched += buf.byteLength;
    return res;
  };
  const file = await asyncBufferFromUrl({
    url: eventsParquetUrl,
    fetch: countingFetch,
    requestInit: { headers: { "User-Agent": "nemar-mcp" } },
  });
  const metadata = await parquetMetadataAsync(file);

  // Bounds BEFORE the read, from the footer this path already had to fetch.
  // See MAX_EVENTS_PARQUET_BYTES for the measurements and why refusing beats
  // paging here.
  const rowCount = Number(metadata.num_rows ?? 0);
  const byteLength = file.byteLength;
  const limit = `the ${MAX_EVENTS_PARQUET_BYTES}-byte / ${MAX_EVENTS_PARQUET_ROWS}-row limit`;
  const remedy = `The file is public at ${eventsParquetUrl} -- read it directly (it is one row per event and channel group, with a store_path column) rather than through this tool.`;
  const wholeFile = byteLength <= MAX_EVENTS_PARQUET_BYTES && rowCount <= MAX_EVENTS_PARQUET_ROWS;
  let span: ReturnType<typeof storeRowGroupSpan> = null;
  if (!wholeFile) {
    const tooLarge = `dataset "${datasetId}"'s events.parquet is too large for this server to read inline: ${byteLength} bytes and ${rowCount} rows, over ${limit}`;
    span = storeRowGroupSpan(metadata, storeZarr);
    if (!span) {
      throw new EventsParquetTooLargeError(
        `${tooLarge}, and its row groups carry no store_path statistics to find one recording's rows by. ${remedy}`,
      );
    }
    if (span.rows > MAX_EVENTS_PARQUET_ROWS || span.compressedBytes > MAX_EVENTS_PARQUET_BYTES) {
      throw new EventsParquetTooLargeError(
        `${tooLarge}, and the row groups that hold this recording are over it too: ${span.compressedBytes} bytes and ${span.rows} rows. ${remedy}`,
      );
    }
  }

  // No `columns` filter: every column (the eight named on eventRowSchema
  // plus subject/session/task/run and any x_-prefixed extra) is wanted, so
  // `.passthrough()` on the wire schema has something real to pass through.
  // A span of no row groups (the statistics prove the store has no rows) reads
  // nothing: an empty row range fetches no pages.
  const rawRows = await parquetReadObjects({
    file,
    metadata,
    compressors: EVENTS_PARQUET_COMPRESSORS,
    ...(span ? { rowStart: span.rowStart, rowEnd: span.rowEnd } : {}),
  });

  const byStore = new Map<string, EventRow[]>();
  const invalidRowCountByStore = new Map<string, number>();
  let totalInvalid = 0;
  for (const raw of rawRows) {
    const storePath = String((raw as { store_path?: unknown }).store_path ?? "");
    // Reading by row group: another store's rows here may be only part of its
    // rows, so they are neither validated nor kept.
    if (span && storePath !== storeZarr) continue;
    const candidate = {
      ...raw,
      sample_index: toSafeSampleIndex(
        (raw as { sample_index?: unknown }).sample_index,
        datasetId,
        storePath,
      ),
    };
    // Never cache an unvalidated row: a row that fails eventRowSchema (a
    // malformed store_path, a negative sample_index toSafeSampleIndex's
    // narrower "is it a safe integer" check would not have caught, ...) is
    // dropped and counted rather than written to the cache or returned.
    const parsed = eventRowSchema.safeParse(candidate);
    if (!parsed.success) {
      invalidRowCountByStore.set(storePath, (invalidRowCountByStore.get(storePath) ?? 0) + 1);
      totalInvalid++;
      continue;
    }
    const row = parsed.data as EventRow;
    const list = byStore.get(storePath);
    if (list) list.push(row);
    else byStore.set(storePath, [row]);
  }
  if (totalInvalid > 0) {
    console.warn(
      `[get_events] ${datasetId}: ${totalInvalid} parquet row(s) failed eventRowSchema validation and were omitted`,
    );
  }
  return { byStore, bytesFetched, invalidRowCountByStore, scope: span ? "store" : "file" };
}

/** Primary path: `events/<zarr>` cache entry per store, all written in one
 *  pass on a miss (see module doc), including a `[]` placeholder for every
 *  store the recordings projection knows about that the parquet had no
 *  rows for -- so a repeat call for THAT store is a cache hit too, never a
 *  re-read of the whole file. Bounded by {@link MAX_STORE_FANOUT_ENTRIES};
 *  above it only the requested store's entry is written.
 *
 *  `sourceCommit` gates the CACHE only (decision: the parquet is the data
 *  source whenever `eventsParquetUrl` is set, unconditionally) -- when it
 *  is `null`, this reads the parquet fresh every call and never touches
 *  `readJsonProjection`/`writeJsonProjection` at all. Throws (parquet
 *  parse/decode failures, an unsafe `sample_index`) rather than catching
 *  internally; the caller wraps this call and turns a throw into a typed
 *  tool error, mirroring `render_overview`'s chunk-fetch-failure handling. */
async function loadEventsFromParquet(
  deps: RecordingToolDeps,
  datasetId: string,
  sourceCommit: string | null,
  /** D1's `zarr_converted_at`, part of every cache key here: a re-conversion
   *  republishes `events.parquet` and can do so at an unchanged commit. */
  convertedAt: string | null,
  eventsParquetUrl: string,
  storeZarr: string,
  allStoreZarrs: string[],
): Promise<{
  rows: EventRow[];
  cacheStatus: "hit" | "miss";
  upstreamBytes: number;
  /** Rows dropped for THIS store by `eventRowSchema` validation. Reported on a
   *  cache HIT as well as a miss, because the count is stored in the entry
   *  alongside the rows. It used to be `0` on a hit, reasoned as "the cached
   *  rows already passed validation, so there is nothing new to report" -- but
   *  the thing worth reporting is that rows were DROPPED, which stays true for
   *  the life of the entry, and only the caller who happened to miss ever heard
   *  about it. */
  invalidRowCount: number;
}> {
  if (sourceCommit) {
    const cacheKey = projectionUrl({
      env: deps.env,
      datasetId,
      sourceCommit,
      convertedAt,
      projection: `events/${storeZarr}`,
    });
    const cached = await readJsonProjection(deps.cache(), cacheKey, eventRowsProjectionSchema);
    if (cached.status === "hit") {
      return {
        rows: cached.value.rows,
        cacheStatus: "hit",
        upstreamBytes: 0,
        // Carried in the entry, so a hit reports the same omission a miss did.
        invalidRowCount: cached.value.invalidRowCount,
      };
    }
  }

  const { byStore, bytesFetched, invalidRowCountByStore, scope } = await readEventsParquet(
    deps,
    datasetId,
    eventsParquetUrl,
    storeZarr,
  );
  // A `[]` placeholder says "the parquet has no rows for this store", which only
  // a whole-file read can say about a store it did not ask for.
  if (scope === "file") {
    for (const zarr of allStoreZarrs) {
      if (!byStore.has(zarr)) byStore.set(zarr, []);
    }
  } else if (!byStore.has(storeZarr)) {
    byStore.set(storeZarr, []);
  }

  if (sourceCommit) {
    // The requested store is always cached; the rest only below the fan-out
    // bound.
    //
    // There used to be an `events/_stores` summary written here too, one entry
    // per parquet miss listing every store and its row count. Nothing ever read
    // it -- only a test did -- so it was a cache write and a schema per miss
    // buying nothing. Removed rather than kept for a hypothetical future
    // reader; it is three lines to reinstate against a real caller.
    const fanOut = byStore.size <= MAX_STORE_FANOUT_ENTRIES;
    for (const [zarr, rows] of byStore.entries()) {
      if (fanOut || zarr === storeZarr) {
        writeJsonProjection(
          deps.executionCtx,
          deps.cache(),
          projectionUrl({
            env: deps.env,
            datasetId,
            sourceCommit,
            convertedAt,
            projection: `events/${zarr}`,
          }),
          { rows, invalidRowCount: invalidRowCountByStore.get(zarr) ?? 0 },
        );
      }
    }
  }

  return {
    rows: byStore.get(storeZarr) ?? [],
    cacheStatus: "miss",
    upstreamBytes: bytesFetched,
    invalidRowCount: invalidRowCountByStore.get(storeZarr) ?? 0,
  };
}

interface ParsedEventsTsv {
  columns: string[];
  rows: string[][];
}

/** Mirrors `parse_events_tsv` in `scripts/zarr/generate_zarr.py`: strip a
 *  leading UTF-8 BOM (a spreadsheet-exported events.tsv can carry one, which
 *  would otherwise poison the first column's name), drop blank lines
 *  anywhere (also handles a CRLF file: the `\r` is not part of any cell,
 *  since the split is on `\r?\n`, and a trailing `\r` a lone `\r?\n` split
 *  might otherwise leave on the last cell of a line never occurs because
 *  the split consumes it), tab-split.
 */
function parseEventsTsvText(text: string): ParsedEventsTsv {
  const lines = text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((ln) => ln.trim().length > 0);
  if (lines.length === 0) return { columns: [], rows: [] };
  return {
    columns: lines[0].split("\t").map((c) => c.trim()),
    rows: lines.slice(1).map((ln) => ln.split("\t")),
  };
}

function cellOrNull(fields: string[], col: number): string | null {
  if (col < 0 || col >= fields.length) return null;
  const value = fields[col].trim();
  return !value || value.toLowerCase() === "n/a" ? null : value;
}

/** BIDS: replace the trailing `_<suffix>.<ext>` with `_events.tsv`, e.g.
 *  `sub-1_task-x_eeg.bdf` -> `sub-1_task-x_events.tsv`. */
function siblingEventsTsvPath(storePath: string): string {
  return storePath.replace(/_[^_/.]+\.[^./]+$/, "_events.tsv");
}

type TsvFallbackResult =
  | { kind: "rows"; rows: EventRow[]; note: string | null; bytesFetched: number }
  | { kind: "error"; detail: string; tsvPath: string };

async function loadEventsFromTsvFallback(
  deps: RecordingToolDeps,
  datasetId: string,
  storePath: string,
  ref: string,
  storeZarr: string,
  groupName: string,
  rate: number | null,
): Promise<TsvFallbackResult> {
  if (rate === null) {
    return { kind: "rows", rows: [], note: NO_RATE_NOTE, bytesFetched: 0 };
  }
  const tsvPath = siblingEventsTsvPath(storePath);
  const url = rawContentUrl(deps.rawGithubBase, datasetId, ref, tsvPath);

  let response: Response;
  try {
    response = await deps.fetch(url, { headers: { "User-Agent": "nemar-mcp" } });
  } catch (err) {
    return {
      kind: "error",
      tsvPath,
      detail: `network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Only a clean 404 is "absent" -- BIDS inheritance is out of scope, so a
  // missing sibling file is a normal, expected outcome for a v1 dataset,
  // not an error. A private repo reads identically to a missing file
  // (anonymous raw.githubusercontent.com access), which is exactly the
  // ambiguity the note below is honest about.
  if (response.status === 404) {
    return { kind: "rows", rows: [], note: NO_EVENTS_FILE_NOTE, bytesFetched: 0 };
  }
  if (!response.ok) {
    return { kind: "error", tsvPath, detail: `HTTP ${response.status}` };
  }

  const text = await response.text();
  const contentLengthHeader = response.headers.get("content-length");
  const bytesFetched = contentLengthHeader
    ? Number(contentLengthHeader)
    : new TextEncoder().encode(text).length;

  const parsed = parseEventsTsvText(text);
  const lower = parsed.columns.map((c) => c.toLowerCase());
  const onsetCol = lower.indexOf("onset");
  const durationCol = lower.indexOf("duration");
  const trialTypeCol = lower.indexOf("trial_type");
  const valueCol = lower.indexOf("value");
  const hedCol = lower.indexOf("hed");

  const rows: EventRow[] = [];
  for (const fields of parsed.rows) {
    const onsetRaw = cellOrNull(fields, onsetCol);
    if (onsetRaw === null) continue;
    const onsetS = Number(onsetRaw);
    if (!Number.isFinite(onsetS)) continue;
    const durationRaw = cellOrNull(fields, durationCol);
    const durationS = durationRaw === null ? null : Number(durationRaw);
    rows.push({
      store_path: storeZarr,
      group_name: groupName,
      onset_s: onsetS,
      duration_s: durationS !== null && Number.isFinite(durationS) ? durationS : null,
      sample_index: Math.floor(onsetS * rate + 0.5),
      trial_type: cellOrNull(fields, trialTypeCol),
      value: cellOrNull(fields, valueCol),
      hed: cellOrNull(fields, hedCol),
    });
  }
  return { kind: "rows", rows, note: null, bytesFetched };
}

/** The columns `rows` carry, in the order they first appear. */
function eventColumnNames(rows: readonly EventRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) seen.add(key);
  }
  return [...seen];
}

/** Not summarized: the two times, which differ on every row, and the store and
 *  group, which the request already named. `where` and `columns` still accept
 *  them. */
const UNSUMMARIZED_COLUMNS = new Set(["onset_s", "sample_index", "store_path", "group_name"]);

/** `columns_summary` (#1500): each column but {@link UNSUMMARIZED_COLUMNS}, with
 *  its distinct values when there are few enough to list, so a caller can build a
 *  `where` from one small call instead of reading every row to find what to ask
 *  for. Exported for its unit tests. */
export function summarizeEventColumns(
  rows: readonly EventRow[],
  names: readonly string[],
): EventColumnSummary[] {
  const summary: EventColumnSummary[] = [];
  for (const name of names) {
    if (UNSUMMARIZED_COLUMNS.has(name)) continue;
    const counts = new Map<string, number>();
    let nullCount = 0;
    for (const row of rows) {
      const value = (row as Record<string, unknown>)[name];
      if (value === null || value === undefined) {
        nullCount++;
        continue;
      }
      const key = String(value);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const listable =
      counts.size <= GET_EVENTS_SUMMARY_MAX_VALUES &&
      [...counts.keys()].every((v) => v.length <= GET_EVENTS_SUMMARY_MAX_VALUE_CHARS);
    summary.push({
      name,
      distinct_count: counts.size,
      null_count: nullCount,
      values: listable
        ? [...counts]
            .map(([value, count]) => ({ value, count }))
            .sort(
              (a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
            )
        : null,
    });
  }
  return summary;
}

/** `where` keeps a row when every named column holds, as a string, one of the
 *  values listed for it. A null never matches: there is no value to compare. */
function matchesWhere(row: EventRow, allowed: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  for (const [column, values] of allowed) {
    const value = (row as Record<string, unknown>)[column];
    if (value === null || value === undefined || !values.has(String(value))) return false;
  }
  return true;
}

/** A row with only the columns asked for, after the two it cannot do without. */
function projectEventRow(row: EventRow, columns: readonly string[]): EventRowOutput {
  const projected: EventRowOutput & Record<string, unknown> = {
    onset_s: row.onset_s,
    sample_index: row.sample_index,
  };
  for (const column of columns) {
    if (column in projected) continue;
    projected[column] = (row as Record<string, unknown>)[column] ?? null;
  }
  return projected;
}

function unknownColumnsResult(
  datasetId: string,
  recording: string,
  input: "where" | "columns",
  unknown: string[],
  known: string[],
): CallToolResult {
  return toolError(
    `get_events: ${input} names ${unknown.map((c) => `"${c}"`).join(", ")}, which recording ` +
      `"${recording}" in dataset "${datasetId}" has no column for. Its events have: ${known.join(", ")}.`,
  );
}

export async function getEventsTool(
  deps: RecordingToolDeps,
  args: GetEventsInput,
): Promise<ToolOutcome> {
  const row = await loadPublicDatasetRow(deps.env.DB, args.dataset_id);
  if (!row) {
    return { result: datasetNotFoundResult(args.dataset_id) };
  }
  if (!isZarrReady(row)) {
    return { result: zarrNotReadyResult(args.dataset_id, row) };
  }

  const loaded = await loadRecordingsProjection(deps, row, args.dataset_id);
  if (!loaded.ok) {
    return { result: loaded.result };
  }
  const { projection, upstreamBytes: recordingsBytes } = loaded;

  const matched = resolveRecording(projection, args.recording);
  if (!matched) {
    return { result: recordingNotFoundResult(args.dataset_id, args.recording, projection) };
  }

  // Resolve `group` exactly as render_overview does: an explicit group that
  // does not exist on this recording is a tool error naming the real group
  // names, never a confident-looking empty result (found in PR review --
  // previously a typo in `group` silently answered `events: []`).
  const groups = matched.groups ?? [];
  let targetGroup: (typeof groups)[number] | undefined;
  if (args.group) {
    targetGroup = groups.find((g) => g.name === args.group);
    if (!targetGroup) {
      return {
        result: groupNotFoundResult(
          args.dataset_id,
          args.recording,
          args.group,
          groups.map((g) => g.name),
        ),
      };
    }
  } else {
    targetGroup = groups[0];
  }

  const sourceCommitFinal = projection.sourceCommit || null;
  const eventsParquetUrl = projection.eventsParquetUrl;

  let rows: EventRow[];
  let source: GetEventsOutput["source"];
  let estimated: boolean;
  let note: string | null = null;
  let cacheStatus: "hit" | "miss" = "miss";
  let upstreamBytes = 0;

  if (eventsParquetUrl) {
    // The parquet is the data source whenever the index names one --
    // `sourceCommitFinal` gates the CACHE only (see the module doc); never
    // fall through to the strictly-worse tsv fallback just because a
    // commit happens to be unusable for caching.
    let result: Awaited<ReturnType<typeof loadEventsFromParquet>>;
    try {
      result = await loadEventsFromParquet(
        deps,
        args.dataset_id,
        sourceCommitFinal,
        row.zarr_converted_at,
        eventsParquetUrl,
        matched.zarr,
        projection.recordings.map((r) => r.zarr),
      );
    } catch (err) {
      // A size refusal is a deliberate decline with a workaround in it, not a
      // read failure, so it says so in its own words rather than borrowing
      // "could not read", which would read like an outage.
      if (err instanceof EventsParquetTooLargeError) {
        return { result: toolError(`get_events declines this request: ${err.message}`) };
      }
      return {
        result: parquetReadFailedResult(
          args.dataset_id,
          args.recording,
          err instanceof Error ? err.message : String(err),
        ),
      };
    }
    rows = result.rows;
    source = "events_parquet";
    estimated = false;
    cacheStatus = result.cacheStatus;
    upstreamBytes = result.upstreamBytes;
    // The "no rows" note is NOT computed here. It used to be, on the PRE-filter
    // rows, so a group that exists but has no events answered `events: []`,
    // `total_count: 0`, `note: null` -- indistinguishable from a confident "this
    // group has no events". It is computed after the group filter below.
    if (result.invalidRowCount > 0) {
      note = `${result.invalidRowCount} row(s) failed validation and were omitted`;
    }
  } else {
    const ref =
      sourceCommitFinal && SOURCE_COMMIT_RE.test(sourceCommitFinal) ? sourceCommitFinal : "main";
    const fallback = await loadEventsFromTsvFallback(
      deps,
      args.dataset_id,
      matched.path,
      ref,
      matched.zarr,
      targetGroup?.name ?? "",
      targetGroup?.rate ?? null,
    );
    if (fallback.kind === "error") {
      return {
        result: tsvFetchFailedResult(
          args.dataset_id,
          args.recording,
          fallback.tsvPath,
          fallback.detail,
        ),
      };
    }
    rows = fallback.rows;
    source = "events_tsv_fallback";
    estimated = true;
    note = fallback.note;
    upstreamBytes = fallback.bytesFetched;
    // The fallback always reads through raw.githubusercontent.com, which is
    // not the projection cache -- reported as a "miss" every time (never a
    // "hit"), matching the recordings-cache-bypass convention for an
    // unusable commit.
    cacheStatus = "miss";
  }

  // Filter by the RESOLVED group whether or not the caller named one.
  //
  // Defaulting to the first group is what `render_overview` and `read_window`
  // already do, and what this tool's own envelope already describes. Not
  // filtering was the outlier and it double-counted: `events.parquet` carries
  // one row per (event, CHANNEL GROUP), so a two-group store returned every
  // event twice and reported `total_count` as double, with no note, while the
  // envelope described only the first group's rates.
  const resolvedGroupName = targetGroup?.name ?? null;
  const notes: string[] = note ? [note] : [];
  if (resolvedGroupName) {
    rows = rows.filter((r) => r.group_name === resolvedGroupName);
    if (!args.group && groups.length > 1) {
      // Say which group answered, and how to ask for another. Silently picking
      // one of several is the part that would surprise a caller.
      notes.push(
        `group not specified, so these events are group "${resolvedGroupName}" only; ` +
          `this recording also has ${groups
            .filter((g) => g.name !== resolvedGroupName)
            .map((g) => `"${g.name}"`)
            .join(", ")}`,
      );
    }
  } else {
    // No group at all in the projection: nothing to filter by, so every row for
    // the store is returned. Rare (a malformed index), and worth saying.
    notes.push(
      "this recording's index entry names no channel groups, so these events are unfiltered " +
        "across whatever groups the events file contains",
    );
  }

  // Now that the rows are the ones being answered with, an empty result can be
  // described honestly, naming the group it was empty FOR.
  if (rows.length === 0) {
    notes.push(
      source === "events_parquet"
        ? `${NO_PARQUET_ROWS_NOTE}${resolvedGroupName ? ` (group "${resolvedGroupName}")` : ""}`
        : `no events.tsv rows resolved for this recording${resolvedGroupName ? ` (group "${resolvedGroupName}")` : ""}`,
    );
  }
  // `where` and `columns` (#1500). The summary and the column check describe
  // this group's rows BEFORE the filter, so a filter that keeps nothing still
  // answers with what it could have asked for. A recording with no rows has no
  // columns to check against; the note above already says why it is empty.
  const columnNames = eventColumnNames(rows);
  if (rows.length > 0) {
    const named = [
      ["where", Object.keys(args.where ?? {})],
      ["columns", args.columns ?? []],
    ] as const;
    for (const [input, columns] of named) {
      const unknown = columns.filter((c) => !columnNames.includes(c));
      if (unknown.length > 0) {
        return {
          result: unknownColumnsResult(
            args.dataset_id,
            args.recording,
            input,
            unknown,
            columnNames,
          ),
        };
      }
    }
  }
  // After the refusal, which needs only the names, so a refused request does not
  // pay for a pass over every value.
  const columnsSummary = summarizeEventColumns(rows, columnNames);
  if (args.where) {
    const allowed = new Map(
      Object.entries(args.where).map(([column, values]) => [column, new Set(values.map(String))]),
    );
    const before = rows.length;
    rows = rows.filter((r) => matchesWhere(r, allowed));
    if (before > 0 && rows.length === 0) {
      notes.push(
        `none of this recording's ${before} events matched where; columns_summary lists each column's values when it has few`,
      );
    }
  }
  note = notes.length > 0 ? notes.join(" ") : null;

  const totalCount = rows.length;
  const pageRows = rows.slice(args.offset, args.offset + args.limit);
  const columns = args.columns;
  const page = columns ? pageRows.map((r) => projectEventRow(r, columns)) : pageRows;
  const truncated = args.offset + page.length < totalCount;

  if (!sourceCommitFinal) {
    note = note ? `${note} ${NO_COMMIT_NOTE}` : NO_COMMIT_NOTE;
  }

  let envelope: GetEventsOutput["envelope"];
  if (sourceCommitFinal) {
    const built = buildEnvelopeForStore({
      indexFacts: projection.indexFacts,
      sourceCommit: sourceCommitFinal,
      indexEtag: projection.indexEtag,
      row,
      store: {
        path: matched.path,
        source_tree: matched.source_tree,
        derived: matched.derived,
        sss: matched.sss,
        units_report: matched.units_report,
      },
      group: targetGroup,
      dtype: null,
    });
    envelope = built.envelope ?? undefined;
    if (built.note && !note) note = built.note;
  }

  const output = getEventsOutputSchema.parse({
    dataset_id: args.dataset_id,
    recording: args.recording,
    events: page,
    source,
    estimated,
    total_count: totalCount,
    limit: args.limit,
    offset: args.offset,
    truncated,
    note,
    columns_summary: columnsSummary,
    envelope,
  } satisfies GetEventsOutput);

  return {
    result: {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    },
    // `cacheStatus` reflects the EVENTS cache specifically (the fact the
    // definition-of-done test cares about: "the second call served from
    // the per-store cache entry"); `upstreamBytes` sums whatever bytes were
    // actually fetched -- the recordings-projection read (when it missed
    // too) plus the events read (parquet OR the tsv fallback).
    metrics: { cacheStatus, upstreamBytes: upstreamBytes + recordingsBytes },
  };
}
