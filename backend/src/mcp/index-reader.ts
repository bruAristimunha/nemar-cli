/**
 * `index.json` reader for the recording-level MCP tools (epic #1065 phase 3,
 * issue #1295).
 *
 * Fetches `index.json` IN PROCESS through the real zarr sub-app
 * (`deps.zarrRoutes.fetch(request, env, ctx)`, `createZarrDataRoutes` in
 * `backend/src/routes/zarr-data.ts`) rather than re-implementing any of its
 * behavior: the D1 public-visibility gate, the `canonicalCacheUrl` edge
 * cache, and the `ZARR_DATASET_DOCUMENTS` purge list all apply exactly as
 * they do for a browser or `zarrita` client hitting `zarr.nemar.org`
 * directly. `zarrBase` is `zarrCacheBaseUrl(env)` (`services/cloudflare.ts`)
 * when set, else the production host, `DEFAULT_ZARR_BASE` below -- a NEW
 * fallback introduced by this file, not shared with `zarrPurgeTargets()`
 * (`services/cloudflare.ts`, which returns an empty target list when the
 * env var is unset -- it has nothing to fall back TO) or `s3PublicUrl`
 * (`routes/zarr-data.ts`, whose own fallback is the S3 bucket URL, a
 * different host entirely).
 *
 * ABOUT HALF THE CATALOG STILL PUBLISHES `format_version` 1 (as of
 * 2026-09-08) while the ADR 0033 engine bump re-converts the back catalog
 * (AGENTS.md's "widening of discovery reaches the back catalog only
 * through the engine stamp" paragraph). A v1 document has no `layout`, no
 * `events_parquet`, no `source_tree`/`derived` on its stores, no
 * `engine_version`, and a group may carry no `n_view_levels` at all --
 * none of `zarrIndexSchema`'s required fields hold, so this reader
 * inspects the document's own `format_version` BEFORE choosing a schema,
 * parsing a genuine v3 document with `zarrIndexSchema` and everything else
 * with the lower-bound `zarrIndexLegacySchema`
 * (`shared/contract/zarr-index.ts`). The three phase 3 tools serve v1
 * honestly (an inferred `source_tree`/`derived`, no pyramid, no
 * `events.parquet`) rather than failing outright on half the catalog.
 *
 * `sourceCommit` is the document's `source_commit` when it matches
 * `SOURCE_COMMIT_RE` (a full 40-hex SHA), else `null` -- v1 predates the
 * 40-hex guarantee (#1197: on008083 once published `""`), and a reader must
 * not crash on that, only report "no usable commit" so callers can bypass
 * the projection cache rather than key it on a guess (catalog-row.ts's
 * module doc).
 */

import {
  SOURCE_COMMIT_RE,
  type ZarrIndex,
  type ZarrIndexLegacy,
  zarrIndexLegacySchema,
  zarrIndexSchema,
} from "../../../shared/contract/zarr-index.js";
import { internalRequest } from "../lib/internal-request.js";
import { zarrCacheBaseUrl } from "../services/cloudflare.js";
import type { Bindings } from "../types/bindings.js";

/** Production zarr.nemar.org, used when `ZARR_CACHE_BASE_URL` is unset --
 *  see the module doc for why this fallback is NOT shared with
 *  `zarrPurgeTargets()` or `s3PublicUrl`, which each answer that question
 *  differently. */
export const DEFAULT_ZARR_BASE = "https://zarr.nemar.org";

/** The subset of `Hono<...>`'s instance surface this reader needs: a
 *  request/env/executionCtx-shaped `fetch`, matching `createZarrDataRoutes()`'s
 *  return type exactly (so the real sub-app satisfies this with no adapter)
 *  while keeping this file free of a direct `hono` import. */
export interface ZarrRoutesLike {
  fetch(
    request: Request,
    env?: unknown,
    executionCtx?: ExecutionContext,
  ): Response | Promise<Response>;
}

export interface IndexReaderDeps {
  zarrRoutes: ZarrRoutesLike;
}

export type ZarrIndexDocument = ZarrIndex | ZarrIndexLegacy;

export type IndexReadResult =
  | {
      status: "ok";
      index: ZarrIndexDocument;
      formatVersion: number;
      etag: string | null;
      sourceCommit: string | null;
      /** `Content-Length` off the zarr sub-app's response, best-effort (0
       *  when the header is absent) -- the `upstream_bytes` metrics fact for
       *  a tool call that had to read `index.json` (never set on a
       *  projection-cache hit, which skips this read entirely). */
      bytes: number;
    }
  /** The zarr sub-app itself answered 404 -- an unknown/private/sandboxed
   *  dataset id, or a public dataset whose `index.json` object is missing
   *  despite the D1 row saying `zarr_status: 'ready'` (an inconsistency the
   *  caller should surface, not silently swallow). */
  | { status: "not_found" }
  /** index.json fetched but did not parse as JSON, or parsed but matched
   *  neither `zarrIndexSchema` nor `zarrIndexLegacySchema`. */
  | { status: "invalid"; detail: string }
  /** The document is larger than {@link MAX_INDEX_BYTES}. Distinct from
   *  `invalid`: the document is presumably fine, this server just declines to
   *  parse it inline. Carries the figures and the public URL so the refusal is
   *  actionable. */
  | { status: "too_large"; detail: string };

/**
 * Upper bound on an `index.json` this server will parse inline.
 *
 * The document's size is not bounded by anything this code controls: it grows
 * with a dataset's store count, and store counts in the live catalog run to
 * 25,253 (nm000281, whose index.json is 12,846,915 bytes). Parsing that costs a
 * `JSON.parse` plus a full zod validation, and up to four copies are alive at
 * peak (raw text, parsed document, validated clone, and the projection about to
 * be serialized). The warm path is not free either: the cached projection for
 * nm000281 is 9.9 MB of JSON, and every later call re-parses and re-validates
 * it, so the cache removes the S3 fetch but not the parse.
 *
 * 24 MiB clears today's largest with meaningful headroom and still refuses a
 * document twice that size, which is the point: `describe_dataset`'s own tool
 * description already advertises that it never reads index.json because "the
 * largest index in the catalog is 12.8 MB", so the risk was recognized for one
 * tool and left unbounded for the three that do read it.
 */
export const MAX_INDEX_BYTES = 24 * 1024 * 1024;

/** True when a raw parsed JSON value's own `format_version` field is
 *  exactly the number `3` -- checked BEFORE schema selection so a broken
 *  v3 document is reported as an invalid v3 document (against the schema it
 *  actually claims to satisfy) rather than silently re-tried against the
 *  legacy lower bound, which could parse a differently-broken document by
 *  accident. */
function claimsFormatVersion3(doc: unknown): boolean {
  return (
    typeof doc === "object" &&
    doc !== null &&
    "format_version" in doc &&
    (doc as { format_version: unknown }).format_version === 3
  );
}

function usableSourceCommit(raw: string): string | null {
  return SOURCE_COMMIT_RE.test(raw) ? raw : null;
}

/**
 * Read and parse `index.json` for one dataset. Never throws on a malformed
 * or legacy document -- every failure mode is a typed `IndexReadResult`
 * variant a tool turns into its own tool error text.
 */
export async function readZarrIndex(
  deps: IndexReaderDeps,
  env: Bindings,
  executionCtx: ExecutionContext,
  datasetId: string,
): Promise<IndexReadResult> {
  const zarrBase = zarrCacheBaseUrl(env) ?? DEFAULT_ZARR_BASE;
  const request = internalRequest(new Request(`${zarrBase}/${datasetId}/zarr/index.json`));
  const response = await deps.zarrRoutes.fetch(request, env, executionCtx);

  if (response.status === 404) {
    return { status: "not_found" };
  }
  if (!response.ok) {
    return {
      status: "invalid",
      detail: `index.json fetch answered HTTP ${response.status}`,
    };
  }

  const etag = response.headers.get("etag");
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_INDEX_BYTES) {
    return {
      status: "too_large",
      detail: `dataset "${datasetId}"'s index.json is ${declaredBytes} bytes, over this server's ${MAX_INDEX_BYTES}-byte inline-parse limit. It is public at ${zarrBase}/${datasetId}/zarr/index.json -- read it directly.`,
    };
  }

  // Read the body as TEXT first, so the size is known even when the header was
  // absent or unparseable, and so a document that lies about its length cannot
  // get past the bound above by omitting the header.
  let raw: string;
  try {
    raw = await response.text();
  } catch (err) {
    return {
      status: "invalid",
      detail: `index.json body could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const bytes = Number.isFinite(declaredBytes) && declaredBytes > 0 ? declaredBytes : raw.length;
  if (raw.length > MAX_INDEX_BYTES) {
    return {
      status: "too_large",
      detail: `dataset "${datasetId}"'s index.json is ${raw.length} bytes, over this server's ${MAX_INDEX_BYTES}-byte inline-parse limit. It is public at ${zarrBase}/${datasetId}/zarr/index.json -- read it directly.`,
    };
  }

  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return {
      status: "invalid",
      detail: `index.json did not parse as JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (claimsFormatVersion3(doc)) {
    const parsed = zarrIndexSchema.safeParse(doc);
    if (!parsed.success) {
      return {
        status: "invalid",
        detail: `index.json claims format_version 3 but failed zarrIndexSchema: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      };
    }
    return {
      status: "ok",
      index: parsed.data,
      formatVersion: 3,
      etag,
      sourceCommit: usableSourceCommit(parsed.data.source_commit),
      bytes,
    };
  }

  const legacy = zarrIndexLegacySchema.safeParse(doc);
  if (!legacy.success) {
    return {
      status: "invalid",
      detail: `index.json matched neither zarrIndexSchema nor zarrIndexLegacySchema: ${legacy.error.issues[0]?.message ?? "unknown"}`,
    };
  }
  return {
    status: "ok",
    index: legacy.data,
    formatVersion: legacy.data.format_version,
    etag,
    sourceCommit: usableSourceCommit(legacy.data.source_commit),
    bytes,
  };
}

/** Narrows a parsed index document to the v3 shape. */
export function isV3Index(index: ZarrIndexDocument): index is ZarrIndex {
  return index.format_version === 3;
}
