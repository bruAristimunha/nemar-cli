/**
 * Dataset Search Service
 *
 * Hybrid search over the `datasets` source of truth (#646): an id-only
 * Vectorize index (semanticSearchHydrated -> D1 hydration) fused with a
 * driftless FTS5 lexical index (ftsSearch) via reciprocal-rank fusion.
 * Vectors carry zero facts; every display field is hydrated from `datasets`.
 */

import { CONCEPT_DOI_SQL } from "./anonymity";
import { buildExcludedUnknownBreakdownSql, isAnyFacetActive } from "./dataset-facets";
import {
  type DatasetFilterOptions,
  type SearchViewer,
  buildDatasetFilterClauses,
  buildFtsMatch,
  buildViewerVisibilitySql,
} from "./dataset-filters";
import {
  DATASET_SUMMARY_SELECT_SQL,
  type DatasetSummaryRow,
  buildDatasetSummaryText,
} from "./dataset-summary-text";
import { type QueryAnalysis, analyzeQuery } from "./search-query";
import {
  LEG_SIZE,
  RERANK_POOL_MAX,
  rerankScores,
  rerankSuspended,
  selectRelevant,
  suspendRerank,
} from "./search-rerank";

const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";

/**
 * Whether non-public datasets are embedded. Tied to the layer-1 metadata
 * filter on purpose: without it the unfiltered top-K vector pool (Vectorize
 * caps it at 100) would fill with private candidates that layer 2 then drops,
 * costing anonymous semantic recall. Public vectors are always embedded and
 * labeled, so the relabel backfill can run before the flag goes on.
 */
export function embedsNonPublic(env: { VECTORIZE_VISIBILITY_FILTER?: string }): boolean {
  return env.VECTORIZE_VISIBILITY_FILTER === "1";
}

/**
 * Fixed candidate-window ceilings for GET /datasets/search (#1145, epic #1144
 * phase 1). Both legs used to fetch `limit * 2` candidates, which made the
 * reported `count` a function of the caller's page size rather than a
 * property of the query -- the more selective the filter, the worse the
 * drift. Pinning both windows to constants (independent of `limit`) is what
 * makes `count` -- now computed once by `countSearchMatches` -- stable across
 * every page size.
 */
// SEMANTIC_TOPK used to size a per-id `IN (?,?,...)` placeholder list, so it
// bounded the statement's parameter count directly. Since #1193 the ids travel
// as ONE json_each parameter, so raising it no longer moves that count at all.
// SEARCH_CANDIDATE_CEILING was always unrelated: a plain SQL `LIMIT` with no
// placeholder list behind it, so the two never needed to move in lockstep
// (#1145 review S2).
/**
 * Relevance floor for semantic results (epic #1144 phase 6, issue #1150,
 * D6). bge-small cosine scores against this catalog, measured across 12
 * representative queries at six thresholds:
 *
 * | Threshold | Queries losing the semantic tier |
 * |---|---|
 * | 0.50-0.60 | 0 of 12 |
 * | 0.65 (prior default) | 4 of 12: sleep, motor, seizure, infant (all single-word) |
 * | 0.70 | 6 of 12 |
 *
 * At 0.65 those four queries fell through to `text_fallback` silently --
 * the response carries no signal that the semantic tier was even
 * attempted, let alone skipped. 0.60 is the highest threshold at which
 * nothing in the measured set degrades, and it still filters real noise
 * (`motor` returns 16 results at 0.55 vs 11 at 0.60), so it is not simply
 * "off". Override per-request with ?min_score=0 to inspect the long tail.
 *
 * Lives HERE, not in the route module that reads the query parameter, because
 * this file needs it too: `executeDatasetSearch` applies the same floor when a
 * direct caller omits `minScore`, and its own doc advertises it as safely
 * reusable. D6 originally changed only the route's copy and left a second
 * hardcoded 0.65 in this file, so an HTTP request got 0.60 while a direct call
 * silently got 0.65 (#1174 review). One constant, both consumers.
 */
export const DEFAULT_MIN_SCORE = 0.6;

export const SEMANTIC_TOPK = 100;
export const SEARCH_CANDIDATE_CEILING = 300;

export interface SearchResult {
  id: string;
  name: string;
  modalities: string;
  participants: number;
  doi: string;
  tasks: string;
  authors: string;
  /** HED presence (#869): 1 = has HED, 0 = checked/none, null = not classified. */
  has_hed?: number | null;
  score: number;
  /** FTS5 highlight (#646). Additive-optional; ignored by existing CLI/website
   *  clients. */
  snippet?: string;
}

export type DatasetEmbedRow = DatasetSummaryRow;

/**
 * The embedding text for a `datasets` row -- the single embed-text builder
 * (#646); reembedDatasetVector is the only writer of dataset vectors. It is
 * the same text the reranker reads; see dataset-summary-text.ts for why it is
 * the abstract and keywords, not the README.
 */
export const buildDatasetEmbedText = buildDatasetSummaryText;

/**
 * Re-embed a single dataset's Vectorize vector from its current `datasets`
 * row (#646). The vector holds only routing labels (`visibility`, `dataset_id`),
 * so the upsert overwrites any stale 6-field metadata from earlier phases.
 * Every display field is hydrated from `datasets` by semanticSearchHydrated,
 * so no dataset fact is duplicated into the vector index.
 *
 * Fire-once + fully guarded: returns false without throwing when AI/Vectorize
 * are unconfigured, the row is missing, or any step fails -- so it can be
 * awaited inline at the enrich/reindex hooks without ever failing the request.
 * Returns true only when the vector was upserted and the dirty flag cleared.
 *
 * A non-public row is skipped (false, flag untouched) unless `embedNonPublic`
 * is set; see {@link embedsNonPublic}.
 */
export async function reembedDatasetVector(
  db: D1Database,
  ai: Ai | undefined,
  vectorize: VectorizeIndex | undefined,
  datasetId: string,
  embedNonPublic = false,
): Promise<boolean> {
  if (!ai || !vectorize) {
    console.log(`[reembed] AI/Vectorize not configured, skipping ${datasetId}`);
    return false;
  }
  try {
    const row = await db
      .prepare(
        `SELECT ${DATASET_SUMMARY_SELECT_SQL}, d.visibility AS visibility FROM datasets d WHERE d.dataset_id = ?`,
      )
      .bind(datasetId)
      .first<DatasetEmbedRow & { visibility: string | null }>();
    if (!row) {
      console.warn(`[reembed] No datasets row for ${datasetId}, skipping`);
      return false;
    }
    if (!embedNonPublic && row.visibility !== "public") {
      return false;
    }
    const text = buildDatasetSummaryText(row);
    if (!text.trim()) {
      console.warn(`[reembed] Empty embed text for ${datasetId} (all fields blank), skipping`);
      return false;
    }

    const embedding = await ai.run(EMBEDDING_MODEL, { text: [text] });
    const values = "data" in embedding ? embedding.data?.[0] : undefined;
    if (!values) {
      console.error(`[reembed] Empty embedding for ${datasetId}`);
      return false;
    }
    // The vector carries no dataset fact beyond two routing labels: `visibility`
    // narrows the candidate set of an anonymous or signed-in query (layer 1),
    // `dataset_id` lets a signed-in query name the private rows it may see.
    // Both are hints. Every hit is re-checked against the live `datasets` row
    // (layer 2), so a stale label can cost recall, never expose a dataset.
    await vectorize.upsert([
      {
        id: datasetId,
        values,
        metadata: { visibility: row.visibility ?? "private", dataset_id: datasetId },
      },
    ]);
    // #646 Phase 4: the vector is now fresh, so clear the dirty flag. A failed
    // embed above leaves embedding_dirty=1 for the next drain. embedding_dirty
    // is in no trigger OF list, so this UPDATE doesn't re-fire the triggers.
    await db
      .prepare("UPDATE datasets SET embedding_dirty = 0 WHERE dataset_id = ?")
      .bind(datasetId)
      .run();
    return true;
  } catch (err) {
    console.error(
      `[reembed] Failed for ${datasetId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * #646 Phase 4 drain: re-embed the datasets whose vectors are stale
 * (embedding_dirty>=1), up to `limit`, most recently changed first: a
 * visibility transition marks its row 2 (migration 0145), so a just-published
 * dataset is relabeled ahead of any backlog. Each successful
 * reembedDatasetVector clears the flag; failures stay dirty for the next run.
 * Used by the scheduled() cron. Fully guarded (never throws).
 */
export async function drainEmbeddingDirty(
  db: D1Database,
  ai: Ai | undefined,
  vectorize: VectorizeIndex | undefined,
  limit = 50,
  embedNonPublic = false,
): Promise<{ scanned: number; embedded: number }> {
  if (!ai || !vectorize) {
    return { scanned: 0, embedded: 0 };
  }
  try {
    // Embed every active, non-sandbox dataset when `embedNonPublic` (every
    // dataset is visible to someone), else only the public ones. The vector is
    // id-only; who may see a hit is decided against the live `datasets` row at
    // query time (see buildViewerVisibilitySql), never by the index. Archived,
    // sandbox and (flag off) non-public rows stay dirty. embedding_dirty = 2
    // (a visibility transition) sorts first.
    const rows = await db
      .prepare(
        `SELECT dataset_id FROM datasets
         WHERE embedding_dirty >= 1
           AND status = 'active'
           ${embedNonPublic ? "" : "AND visibility = 'public'"}
           AND (is_sandbox = 0 OR is_sandbox IS NULL OR is_exemplar = 1)
         ORDER BY embedding_dirty DESC, updated_at DESC LIMIT ?`,
      )
      .bind(limit)
      .all<{ dataset_id: string }>();
    const ids = (rows.results || []).map((r) => r.dataset_id);
    let embedded = 0;
    const failed: string[] = [];
    for (const id of ids) {
      if (await reembedDatasetVector(db, ai, vectorize, id, embedNonPublic)) embedded++;
      else failed.push(id);
    }
    console.log(`[embed-cron] drained ${embedded}/${ids.length} dirty vectors`);
    if (failed.length > 0) {
      console.warn(`[embed-cron] ${failed.length} ids failed to embed: ${failed.join(", ")}`);
    }
    // Record a summary so persistent drain failures / embedding drift are
    // admin-queryable via audit_log, not just visible in Worker console logs
    // (#646 review). Only when there was work, to avoid a daily no-op row.
    if (ids.length > 0 || failed.length > 0) {
      await writeEmbedDrainAudit(db, { scanned: ids.length, embedded, failed });
    }
    return { scanned: ids.length, embedded };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[embed-cron] drain failed: ${msg}`);
    await writeEmbedDrainAudit(db, { scanned: 0, embedded: 0, error: msg });
    return { scanned: 0, embedded: 0 };
  }
}

/**
 * Guarded audit-log write for the embed drain. drainEmbeddingDirty never
 * throws, so this swallows its own errors (logging them) rather than bubbling.
 */
async function writeEmbedDrainAudit(
  db: D1Database,
  details: { scanned: number; embedded: number; failed?: string[]; error?: string },
): Promise<void> {
  try {
    await db
      .prepare("INSERT INTO audit_log (action, details) VALUES (?, ?)")
      .bind(
        "embed_drain",
        JSON.stringify({
          scanned: details.scanned,
          embedded: details.embedded,
          failed: details.failed?.length ?? 0,
          failed_ids: details.failed?.slice(0, 20) ?? [],
          error: details.error,
        }),
      )
      .run();
  } catch (err) {
    console.error(
      `[embed-cron] failed to write drain audit log: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// #646: id-only Vectorize + D1 hydration, FTS5 lexical search, and
// reciprocal-rank-fusion hybrid -- all reading from the `datasets` source of
// truth (the single source after the nemar_catalog drop).
// ---------------------------------------------------------------------------

/** Match `d.dataset_id` against a list of ids using ONE bound parameter.
 *
 *  D1 caps bound parameters per statement well below SQLite's own ceiling, and
 *  a semantic leg contributes up to {@link SEMANTIC_TOPK} ids. Binding those
 *  one-per-id consumed nearly the whole budget, so appending even a single
 *  facet-filter parameter overflowed it and EVERY faceted text search returned
 *  `too many SQL variables` (#1193) -- while the catalog-list path, which has
 *  no semantic leg, kept working. `json_each` collapses the list to a single
 *  JSON parameter, so the count no longer scales with SEMANTIC_TOPK. */
// Re-exported so the search module stays the one import site for callers
// that need the ceiling; the guard itself lives with the filter builder that
// applies it (#1195 review I5).
export { MAX_BOUND_PARAMS, assertBoundParamBudget } from "./dataset-filters";

export const DATASET_ID_IN_JSON_LIST = "d.dataset_id IN (SELECT value FROM json_each(?))";

/** The single bound value for {@link DATASET_ID_IN_JSON_LIST}. */
export function datasetIdListParam(ids: string[]): string {
  return JSON.stringify(ids);
}

interface HydrateRow {
  id: string;
  name: string | null;
  modalities: string | null;
  participants: number | null;
  doi: string | null;
  tasks: string | null;
  authors: string | null;
  has_hed: number | null;
}

const toResult = (row: HydrateRow, score: number, snippet?: string): SearchResult => ({
  id: row.id,
  name: row.name || "",
  modalities: row.modalities || "",
  participants: row.participants || 0,
  doi: row.doi || "",
  tasks: row.tasks || "",
  authors: row.authors || "",
  has_hed: row.has_hed ?? null,
  score,
  ...(snippet ? { snippet } : {}),
});

/** Hydrate ordered dataset ids from the `datasets` source of truth, preserving
 *  the input ranking and dropping ids with no live row. The actual bug fix:
 *  display fields come from the row, not stale Vectorize metadata. Filters to
 *  active/non-sandbox rows the viewer may see (live visibility), so a vector
 *  for a private row can never surface for a caller without access. */
export async function hydrateDatasetsByIds(
  db: D1Database,
  ids: string[],
  filters: DatasetFilterOptions = {},
  viewer?: SearchViewer,
): Promise<SearchResult[]> {
  if (ids.length === 0) return [];
  const params: (string | number)[] = [datasetIdListParam(ids)];
  const visibility = buildViewerVisibilitySql(viewer, params);
  const filterClauses = buildDatasetFilterClauses(params, filters);
  const results = await db
    .prepare(
      `SELECT d.dataset_id AS id, d.name, d.modalities, d.subject_count AS participants,
              ${CONCEPT_DOI_SQL} AS doi, d.tasks, d.authors, d.has_hed
       FROM datasets d
       WHERE ${DATASET_ID_IN_JSON_LIST}
         AND d.status = 'active' AND ${visibility}
         AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL OR d.is_exemplar = 1)${filterClauses}`,
    )
    .bind(...params)
    .all<HydrateRow>();
  const byId = new Map((results.results || []).map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is HydrateRow => Boolean(r))
    .map((row) => toResult(row, 0));
}

/** Exact dataset-id lookup from `datasets` for the search exact-id tier.
 *  Active rows the viewer may see only, so it can't leak a private row. */
export async function lookupDatasetById(
  db: D1Database,
  datasetId: string,
  filters: DatasetFilterOptions = {},
  viewer?: SearchViewer,
): Promise<SearchResult | null> {
  // Match the dataset_id OR the source_id: an OpenNeuro source id (e.g.
  // ds005342) resolves to its managed mirror (on005342) even though the legacy
  // ds shadow row was deleted at import. Prefer a managed row (owner != -1) over
  // a legacy catalog shadow if both somehow match.
  const params: (string | number)[] = [datasetId, datasetId];
  const visibility = buildViewerVisibilitySql(viewer, params);
  // #1145 review C4 correction: the exact-id tier did NOT previously ignore
  // filters entirely. The pre-#1145 handler ran `applyHasHed(applyModality(rows))`
  // over the exact-id hit too, so a filtered-out hit already came back as
  // `results: [], count: 0, method: "exact_id"` -- it never returned the hit
  // regardless of the filter. What actually changed: the filter clauses now
  // run inside THIS query (SQL, not a JS array filter), and -- at the
  // executeDatasetSearch call site -- a filtered-out hit falls through to
  // try the FTS/semantic tiers instead of short-circuiting with an empty
  // `exact_id` envelope. That fallthrough, not filter enforcement itself, is
  // the behaviour change.
  const filterClauses = buildDatasetFilterClauses(params, filters);
  const row = await db
    .prepare(
      `SELECT d.dataset_id AS id, d.name, d.modalities, d.subject_count AS participants,
              ${CONCEPT_DOI_SQL} AS doi, d.tasks, d.authors, d.has_hed
       FROM datasets d
       WHERE (d.dataset_id = ? OR d.source_id = ?) AND d.status = 'active'
         AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL OR d.is_exemplar = 1) AND ${visibility}${filterClauses}
       ORDER BY (d.owner_user_id != -1) DESC
       LIMIT 1`,
    )
    .bind(...params)
    .first<HydrateRow>();
  return row ? toResult(row, 1.0) : null;
}

/** Embed the query and run the Vectorize similarity search, ranked and
 *  rounded. Split out of {@link semanticSearchHydrated} (#1145 review I3) so
 *  the caller can wrap ONLY this step in a try/catch -- the D1 hydration step
 *  that follows is a separate failure domain and must not be caught by the
 *  same handler that means "Vectorize is unavailable, fall back to text". */
async function embedAndQuery(
  ai: Ai,
  vectorize: VectorizeIndex,
  query: string,
  topK: number,
  scopes: VectorScope[] = [undefined],
): Promise<{ id: string; score: number }[]> {
  const embedding = await ai.run(EMBEDDING_MODEL, { text: [query] });
  const embeddingData = "data" in embedding ? embedding.data : undefined;
  if (!embeddingData?.[0]) {
    throw new Error("Failed to generate query embedding");
  }
  const vector = embeddingData[0];
  const one = async (filter: VectorScope) => {
    if (!filter) return vectorize.query(vector, { topK, returnMetadata: "none" });
    try {
      const filtered = await vectorize.query(vector, { topK, returnMetadata: "none", filter });
      if (filtered.matches.length === 0) {
        // Zero hits may mean "nothing matches" or "the metadata index does not
        // exist yet" (Vectorize filters silently on an unindexed property).
        // Retry unfiltered; layer 2 keeps the result visibility-safe.
        console.warn(
          "[search] filtered vector query returned no matches, retrying unfiltered (missing metadata index?)",
        );
        return vectorize.query(vector, { topK, returnMetadata: "none" });
      }
      return filtered;
    } catch (err) {
      // A filter the index cannot serve (no metadata index yet) degrades to the
      // unfiltered query; the live D1 check below still decides visibility.
      console.warn(
        `[search] vector metadata filter failed, querying unfiltered: ${err instanceof Error ? err.message : String(err)}`,
      );
      return vectorize.query(vector, { topK, returnMetadata: "none" });
    }
  };
  const best = new Map<string, number>();
  for (const result of await Promise.all(scopes.map(one))) {
    for (const m of result.matches) {
      best.set(m.id, Math.max(best.get(m.id) ?? 0, m.score));
    }
  }
  return [...best.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id, score]) => ({ id, score: Math.round(score * 100) / 100 }));
}

/** A Vectorize metadata filter, or `undefined` for none. */
type VectorScope = NonNullable<Parameters<VectorizeIndex["query"]>[1]>["filter"];

/** Most values Vectorize accepts in one `$in` filter. */
const VECTOR_IN_FILTER_MAX = 100;

/**
 * Layer 1 of search visibility: the metadata filters whose union is the
 * candidate set a viewer could possibly see. An anonymous query never makes a
 * private vector a candidate; a signed-in query adds the private ids it owns
 * or collaborates on (resolved in D1 now); an admin is unfiltered. Vectorize
 * cannot OR two fields in one filter, so a signed-in viewer gets two queries,
 * merged by score. More private ids than one `$in` takes means unfiltered
 * (over-fetch). The labels may be stale; see layer 2 in
 * {@link hydrateDatasetsByIds}.
 */
export async function vectorScopesForViewer(
  db: D1Database,
  viewer: SearchViewer | undefined,
): Promise<VectorScope[]> {
  if (!viewer) return [{ visibility: "public" }];
  if (viewer.isAdmin) return [undefined];
  const { results } = await db
    .prepare(
      `SELECT d.dataset_id AS id FROM datasets d
       WHERE d.visibility != 'public'
         AND (d.owner_user_id = ?
           OR EXISTS (SELECT 1 FROM dataset_collaborators dc WHERE dc.dataset_id = d.id AND dc.user_id = ?))
       LIMIT ?`,
    )
    .bind(viewer.userId, viewer.userId, VECTOR_IN_FILTER_MAX + 1)
    .all<{ id: string }>();
  const ids = (results ?? []).map((r) => r.id);
  if (ids.length === 0) return [{ visibility: "public" }];
  if (ids.length > VECTOR_IN_FILTER_MAX) return [undefined];
  return [{ visibility: "public" }, { dataset_id: { $in: ids } }];
}

/** Whether any filter in `filters` would actually narrow a query. Used only
 *  to qualify the stale-vector-drift warning in {@link semanticSearchHydrated}
 *  (#1145 review I2): an id dropped by hydrateDatasetsByIds might be a
 *  genuinely stale/deleted vector, or might simply have failed an active
 *  filter -- the two are indistinguishable from the count alone.
 *
 *  Epic #1144 phase 3 (#1147): folds in `isAnyFacetActive(filters.facets)`
 *  rather than hand-enumerating the twenty facet keys as a third
 *  hand-maintained list alongside this one and `dataset-facets.ts`'s own
 *  table -- exactly the enumeration-drift shape that left Phase 2b's
 *  untested OR-gate terms silently inert (see `.rules/testing.md`). Exported
 *  for direct unit testing of each OR-gate term (it is a leaf predicate, not
 *  an orchestration entry point -- reaching it only through
 *  {@link semanticSearchHydrated}'s console.warn side effect would mean
 *  scraping log output instead of asserting behaviour). */
export function hasActiveFilters(filters: DatasetFilterOptions): boolean {
  return Boolean(
    filters.search ||
      filters.modality ||
      filters.author ||
      filters.task ||
      filters.hasDoi ||
      filters.hasHed ||
      filters.hasZarr ||
      filters.hasZarrVerified ||
      filters.dataComplete ||
      (filters.recent && filters.recent > 0) ||
      (filters.licenseTiers && filters.licenseTiers.length > 0) ||
      isAnyFacetActive(filters.facets),
  );
}

/** Semantic search, id-only: query Vectorize with `returnMetadata:'none'`
 *  (lifts the topK ceiling to 100), then hydrate from `datasets` by id and
 *  re-attach the vector scores in rank order. */
export async function semanticSearchHydrated(
  ai: Ai,
  vectorize: VectorizeIndex,
  db: D1Database,
  query: string,
  topK = 20,
  filters: DatasetFilterOptions = {},
  viewer?: SearchViewer,
  metadataFilter = false,
): Promise<SearchResult[]> {
  const k = Math.min(Math.max(topK, 1), 100);
  let ranked: { id: string; score: number }[];
  try {
    const scopes = metadataFilter ? await vectorScopesForViewer(db, viewer) : [undefined];
    ranked = await embedAndQuery(ai, vectorize, query, k, scopes);
  } catch (err) {
    // #1145 review I3: tag so executeDatasetSearch's catch can tell "Vectorize
    // itself is unavailable" (safe to fall back to text-only) apart from a
    // hydration/filter-SQL bug below, which must not be silently swallowed
    // as "semantic tier unavailable".
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[embedding] ${msg}`);
  }
  if (ranked.length === 0) return [];
  const scoreById = new Map(ranked.map((r) => [r.id, r.score]));
  // The index is id-only (ADR 0003), so a modality/hasHed filter can't be
  // applied inside Vectorize; it lands here, in the D1 hydration, which
  // already carries the public/active/non-sandbox predicate. Deliberately
  // NOT wrapped in the try/catch above (#1145 review I3): an error here is a
  // D1/filter-SQL bug, not "Vectorize is unavailable", and must propagate as
  // such rather than being mislabeled.
  const hydrated = await hydrateDatasetsByIds(
    db,
    ranked.map((r) => r.id),
    filters,
    viewer,
  );
  // A vector id with no `datasets` row at all is stale (deleted dataset) and is
  // dropped; log it so index drift is observable. Hits dropped because the
  // caller may not see them (visibility), or because an active filter or the
  // status excluded them, are expected and counted apart, never warned about.
  if (hydrated.length < ranked.length) {
    const kept = new Set(hydrated.map((r) => r.id));
    const dropped = ranked.map((r) => r.id).filter((id) => !kept.has(id));
    const present = await db
      .prepare(`SELECT d.dataset_id AS id FROM datasets d WHERE ${DATASET_ID_IN_JSON_LIST}`)
      .bind(datasetIdListParam(dropped))
      .all<{ id: string }>();
    const have = new Set((present.results || []).map((r) => r.id));
    const missing = dropped.filter((id) => !have.has(id)).length;
    if (missing > 0) {
      console.warn(
        `[search] ${missing}/${ranked.length} vector ids had no datasets row (stale vectors or recent deletes); ${dropped.length - missing} more were not visible to the caller or excluded by status/filters`,
      );
    }
  }
  return hydrated.map((r) => ({ ...r, score: scoreById.get(r.id) ?? 0 }));
}

/**
 * Per-column bm25 weights for `datasets_fts(name, description, authors, tasks,
 * modalities, readme)`, in that order. A word in the title or the abstract says
 * what a dataset is about; the same word in a long README is usually passing
 * mention. Unweighted, a dataset that says "driving" in a long README can
 * outrank one named for it. Measured on 37 queries (scripts/search-eval/
 * calibrate.py): R-precision of the lexical leg 0.811 unweighted, 0.835 with
 * these weights.
 */
export const FTS_BM25_WEIGHTS = [10, 5, 1, 4, 1, 1] as const;
const FTS_BM25 = `bm25(datasets_fts, ${FTS_BM25_WEIGHTS.join(", ")})`;

/** FTS5 lexical search over `datasets_fts` (column-weighted bm25 ranking + readme snippet),
 *  hydrating display fields from the joined `datasets` row. */
export async function ftsSearch(
  db: D1Database,
  query: string,
  limit = 20,
  filters: DatasetFilterOptions = {},
  viewer?: SearchViewer,
): Promise<SearchResult[]> {
  const match = buildFtsMatch(query);
  if (!match) return [];
  return ftsSearchByMatch(db, match, limit, filters, viewer);
}

/** {@link ftsSearch} for a match expression the caller has already built. */
async function ftsSearchByMatch(
  db: D1Database,
  match: string,
  limit: number,
  filters: DatasetFilterOptions,
  viewer?: SearchViewer,
): Promise<SearchResult[]> {
  const params: (string | number)[] = [match];
  const visibility = buildViewerVisibilitySql(viewer, params);
  const filterClauses = buildDatasetFilterClauses(params, filters);
  const results = await db
    .prepare(
      `SELECT d.dataset_id AS id, d.name, d.modalities, d.subject_count AS participants,
              ${CONCEPT_DOI_SQL} AS doi, d.tasks, d.authors, d.has_hed,
              snippet(datasets_fts, 5, '<mark>', '</mark>', '…', 12) AS snippet
       FROM datasets_fts
       JOIN datasets d ON d.id = datasets_fts.rowid
       WHERE datasets_fts MATCH ?
         AND d.status = 'active' AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL OR d.is_exemplar = 1)
         AND ${visibility}${filterClauses}
       ORDER BY ${FTS_BM25}
       LIMIT ?`,
    )
    .bind(...params, limit)
    .all<HydrateRow & { snippet: string | null }>();
  return (results.results || []).map((row) => toResult(row, 1.0, row.snippet || undefined));
}

/**
 * Datasets whose name, authors or tasks contain EVERY one of `terms` (prefix
 * match, any order). The user's words are literally in the dataset's title or
 * byline, which is evidence a cross-encoder that never reads authors cannot
 * weigh, so these datasets are exempt from its verdict (see search-rerank.ts).
 * `terms` are alphanumeric tokens (see `queryTokens`), safe to quote.
 */
export async function literalMatchSearch(
  db: D1Database,
  terms: string[],
  limit: number,
  filters: DatasetFilterOptions = {},
  viewer?: SearchViewer,
): Promise<SearchResult[]> {
  if (terms.length === 0) return [];
  const match = `{name authors tasks} : (${terms.map((t) => `"${t}"*`).join(" AND ")})`;
  return ftsSearchByMatch(db, match, limit, filters, viewer);
}

/** The text each dataset is judged as (see dataset-summary-text.ts), by dataset id. */
async function fetchSummaryTexts(
  db: D1Database,
  ids: string[],
  viewer?: SearchViewer,
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const params: (string | number)[] = [datasetIdListParam(ids)];
  const visibility = buildViewerVisibilitySql(viewer, params);
  const { results } = await db
    .prepare(
      `SELECT d.dataset_id AS id, ${DATASET_SUMMARY_SELECT_SQL}
       FROM datasets d WHERE ${DATASET_ID_IN_JSON_LIST}
         AND d.status = 'active' AND ${visibility}
         AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL OR d.is_exemplar = 1)`,
    )
    .bind(...params)
    .all<DatasetSummaryRow & { id: string }>();
  return new Map((results ?? []).map((row) => [row.id, buildDatasetSummaryText(row)]));
}

/**
 * Exact total for GET /datasets/search (#1145, epic #1144 phase 1): one
 * `COUNT(*)` over the union predicate, independent of any candidate window --
 * the FTS disjunct is an UNBOUNDED subquery over `datasets_fts` (no `LIMIT`),
 * unlike `ftsSearch`, which is capped at `SEARCH_CANDIDATE_CEILING`. That is
 * deliberate (#1145 review C3 correction): it is what lets `count` reach the
 * true total (the issue's 189) even though `results` can only ever be drawn
 * from the smaller, fixed candidate windows (`SEARCH_CANDIDATE_CEILING`,
 * `SEMANTIC_TOPK`). Past those windows, `count` can legitimately exceed the
 * pageable pool -- `count` does NOT describe "the same population `results`
 * is sliced from".
 *
 * Each disjunct is omitted when its input is empty -- a punctuation-only
 * query has no FTS match expression, a failed/empty semantic tier has no ids
 * -- and both empty yields `count = 0` without a query. `semanticIds` is
 * expected to already be capped at `SEMANTIC_TOPK` (100), which is also
 * the semantic candidate window (bound as one json_each parameter since #1193).
 */
export async function countSearchMatches(
  db: D1Database,
  ftsMatch: string | null,
  semanticIds: string[],
  filters: DatasetFilterOptions = {},
  viewer?: SearchViewer,
): Promise<number> {
  const disjuncts: string[] = [];
  const params: (string | number)[] = [];
  if (ftsMatch) {
    disjuncts.push("d.id IN (SELECT rowid FROM datasets_fts WHERE datasets_fts MATCH ?)");
    params.push(ftsMatch);
  }
  if (semanticIds.length > 0) {
    disjuncts.push(DATASET_ID_IN_JSON_LIST);
    params.push(datasetIdListParam(semanticIds));
  }
  if (disjuncts.length === 0) return 0;
  const visibility = buildViewerVisibilitySql(viewer, params);
  const filterClauses = buildDatasetFilterClauses(params, filters);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total FROM datasets d
       WHERE d.status = 'active'
         AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL OR d.is_exemplar = 1)
         AND (${disjuncts.join(" OR ")}) AND ${visibility}${filterClauses}`,
    )
    .bind(...params)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/**
 * `countSearchMatches` wrapped so a count failure degrades the response
 * instead of 500ing it (#1145 review I1): `count` is a cosmetic reporting
 * query (ADR 0005 -- partial data still serves), not a precondition for
 * returning results already fetched. On failure, falls back to
 * `pageLowerBound` (the honest "at least this many exist" bound implied by
 * how far paging already reached: `offset + <rows actually returned>`) and
 * sets `warning`, mirroring `executeAndReturn`'s (catalog.ts) count-failure
 * fallback and its established `warning` vocabulary (the CLI already
 * surfaces `response.warning`).
 */
async function countSearchMatchesSafely(
  db: D1Database,
  ftsMatch: string | null,
  semanticIds: string[],
  filters: DatasetFilterOptions,
  pageLowerBound: number,
  viewer?: SearchViewer,
): Promise<{ count: number; warning?: string }> {
  try {
    return { count: await countSearchMatches(db, ftsMatch, semanticIds, filters, viewer) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[search] countSearchMatches failed, reporting a page-derived lower bound: ${msg}`,
    );
    return {
      count: pageLowerBound,
      warning:
        "Result count is temporarily unavailable; showing a lower bound based on the returned page.",
    };
  }
}

/**
 * Epic #1144 phase 3/4 (#1147/#1148), D4/D5: the widened COUNT(*) plus, in
 * the SAME scan, a conditional-aggregation SUM per active facet -- no extra
 * query beyond what Phase 3 already ran for the plain widened count. Unlike
 * `catalog.ts`'s `executeAndReturn`, this never needed a wrap-the-projection
 * fix (D5's "one structural change"): `countSearchMatches` already queried
 * `FROM datasets d ...` directly with no row projection to get in the way,
 * so `buildExcludedUnknownBreakdownSql`'s nullTest expressions (`d.<column>
 * IS NULL`) slot straight into the same SELECT list the COUNT(*) already
 * used.
 *
 * Returns `null` (not thrown) when the query yields no row at all, so the
 * caller can omit both fields the same way a thrown error would make it do.
 */
async function countWidenedWithBreakdown(
  db: D1Database,
  ftsMatch: string | null,
  semanticIds: string[],
  filters: DatasetFilterOptions,
  viewer?: SearchViewer,
): Promise<{ total: number; byFacet: Record<string, number> } | null> {
  const disjuncts: string[] = [];
  const params: (string | number)[] = [];
  if (ftsMatch) {
    disjuncts.push("d.id IN (SELECT rowid FROM datasets_fts WHERE datasets_fts MATCH ?)");
    params.push(ftsMatch);
  }
  if (semanticIds.length > 0) {
    disjuncts.push(DATASET_ID_IN_JSON_LIST);
    params.push(datasetIdListParam(semanticIds));
  }
  if (disjuncts.length === 0) return { total: 0, byFacet: {} };
  const visibility = buildViewerVisibilitySql(viewer, params);
  const widenedFilters: DatasetFilterOptions = { ...filters, includeUnknown: true };
  const filterClauses = buildDatasetFilterClauses(params, widenedFilters);
  const breakdown = buildExcludedUnknownBreakdownSql(widenedFilters.facets);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total${breakdown.selectFragment} FROM datasets d
       WHERE d.status = 'active'
         AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL OR d.is_exemplar = 1)
         AND (${disjuncts.join(" OR ")}) AND ${visibility}${filterClauses}`,
    )
    .bind(...params)
    .first<Record<string, number>>();
  if (!row || row.total == null) return null;
  const byFacet: Record<string, number> = {};
  breakdown.keysInOrder.forEach((key, i) => {
    byFacet[key] = Number(row[`unk_${i}`] ?? 0);
  });
  return { total: row.total, byFacet };
}

/** The two `excluded_unknown*` fields together -- see
 *  {@link DatasetSearchEnvelope} for what each means and why they do not sum. */
export interface ExcludedUnknownResult {
  excludedUnknown: number;
  excludedUnknownByFacet: Record<string, number>;
}

/**
 * Epic #1144 phase 3/4 (#1147/#1148), D4/D5: the count of rows that would
 * have matched if every active facet's NULL rows had been included, minus
 * the count that actually did -- i.e. how many rows the default
 * unknown-excluded policy is hiding right now -- plus, per D5, a breakdown
 * of how many of those widened-population rows are unknown in EACH active
 * facet individually. Skipped (returns `undefined`, not `0`) when no facet
 * is active, so an unfiltered search pays nothing for it. On failure, omits
 * both fields rather than degrading `count`/`results` or 500ing the
 * response -- ADR 0005: this is reporting, never a precondition for serving.
 *
 * `countSucceeded` (#1165 review C1) gates this the same way `catalog.ts`'s
 * `executeAndReturn` gates its own `excludedUnknown` diff on `countSucceeded`:
 * `actualCount` is only a real total when the primary count query itself
 * succeeded. Every caller here gets `actualCount` from
 * `countSearchMatchesSafely`, which on failure substitutes `pageLowerBound`
 * (an "at least this many" bound derived from the returned page, paired with
 * a `warning`) -- diffing a real widened count against that fallback would
 * report a confident-looking (and often wrong) number right next to a
 * warning that says the total is unreliable. Skip the diff entirely instead.
 */
async function computeExcludedUnknownCount(
  db: D1Database,
  ftsMatch: string | null,
  semanticIds: string[],
  filters: DatasetFilterOptions,
  actualCount: number,
  countSucceeded: boolean,
  viewer?: SearchViewer,
): Promise<ExcludedUnknownResult | undefined> {
  if (!isAnyFacetActive(filters.facets)) return undefined;
  if (!countSucceeded) return undefined;
  try {
    const widened = await countWidenedWithBreakdown(db, ftsMatch, semanticIds, filters, viewer);
    if (!widened) return undefined;
    return {
      excludedUnknown: Math.max(0, widened.total - actualCount),
      excludedUnknownByFacet: widened.byFacet,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[search] excluded_unknown count failed, omitting field: ${msg}`);
    return undefined;
  }
}

/** Reciprocal-rank fusion of semantic + lexical result lists (k=60). Dedups by
 *  id, keeps the FTS snippet, and sorts by fused score. */
export function rrfFuse(semantic: SearchResult[], lexical: SearchResult[], k = 60): SearchResult[] {
  const fused = new Map<string, number>();
  const byId = new Map<string, SearchResult>();
  for (const list of [semantic, lexical]) {
    list.forEach((r, i) => {
      fused.set(r.id, (fused.get(r.id) ?? 0) + 1 / (k + i + 1));
      const existing = byId.get(r.id);
      if (!existing) byId.set(r.id, { ...r });
      else if (!existing.snippet && r.snippet) existing.snippet = r.snippet;
    });
  }
  return Array.from(byId.values())
    .map((r) => ({ ...r, score: Math.round((fused.get(r.id) ?? 0) * 10000) / 10000 }))
    .sort((a, b) => b.score - a.score);
}

type EnvelopeBuilder = (
  rows: SearchResult[],
  method: string,
  count: number,
  warning?: string,
  excludedUnknown?: ExcludedUnknownResult,
) => DatasetSearchEnvelope;

/** Why {@link searchByRelevance} handed the query back to the fused path. */
type RelevanceFallback = "embedding-failed" | "rerank-failed";

/**
 * A phrase answered by relevance rather than by reach (see search-rerank.ts for
 * why and for the measurements).
 *
 * Gathers at most {@link LEG_SIZE} candidates from each of the lexical,
 * semantic and literal (name/authors/tasks) legs, has the cross-encoder judge
 * the pool, and returns only the datasets {@link selectRelevant} keeps, best
 * first. The legs are gathered under the visibility rules ALONE: none of the
 * request's filters narrows them, so the verdict on a dataset does not depend
 * on which filters are active (a narrow filter would otherwise leave the
 * semantic leg, which has no cosine floor here, "finding" every row it kept).
 * Every request filter is applied afterwards, by `hydrateDatasetsByIds`, and
 * `excluded_unknown` counts the relevant datasets the default unknown-excluded
 * policy then hides (ADR 0005). The price is that a filtered phrase search
 * draws from the best candidates overall, not the best within the filter.
 *
 * Returns why it could not answer when the semantic tier or the reranker is
 * unavailable, so the caller serves the fused list instead (ADR 0005: partial
 * data still serves). A failure that is neither (a SQL or filter bug, the text
 * fetch included) propagates.
 */
async function searchByRelevance(
  db: D1Database,
  ai: Ai,
  vectorize: VectorizeIndex,
  analysis: QueryAnalysis,
  filters: DatasetFilterOptions,
  buildEnvelope: EnvelopeBuilder,
  viewer?: SearchViewer,
  metadataFilter = false,
): Promise<DatasetSearchEnvelope | RelevanceFallback> {
  if (rerankSuspended()) return "rerank-failed";

  let lexical: SearchResult[];
  let literal: SearchResult[];
  let semantic: SearchResult[];
  try {
    [lexical, literal, semantic] = await Promise.all([
      ftsSearch(db, analysis.lexicalQuery, LEG_SIZE, {}, viewer),
      literalMatchSearch(db, analysis.informative, LEG_SIZE, {}, viewer),
      semanticSearchHydrated(
        ai,
        vectorize,
        db,
        analysis.semanticQuery,
        SEMANTIC_TOPK,
        {},
        viewer,
        metadataFilter,
      ),
    ]);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith("[embedding]")) throw err;
    console.error("[search] semantic tier failed, serving the fused list:", err);
    return "embedding-failed";
  }
  semantic = semantic.slice(0, LEG_SIZE);

  const pool = rrfFuse(semantic, lexical).slice(0, RERANK_POOL_MAX);
  const inPool = new Set(pool.map((r) => r.id));
  for (const r of literal) if (!inPool.has(r.id)) pool.push(r);
  if (pool.length === 0) return { ...buildEnvelope([], "semantic", 0), reranked: true };

  const lexicalIds = new Set(lexical.map((r) => r.id));
  const semanticIds = new Set(semantic.map((r) => r.id));
  const literalIds = new Set(literal.map((r) => r.id));

  // Outside the try below: a SQL failure here is a bug to surface, not "the reranker is down".
  const texts = await fetchSummaryTexts(
    db,
    pool.map((r) => r.id),
    viewer,
  );
  const started = Date.now();
  let probabilities: number[];
  try {
    probabilities = await rerankScores(
      ai,
      analysis.rerankQuery,
      pool.map((r) => texts.get(r.id) || r.name),
    );
  } catch (err) {
    suspendRerank();
    console.error(
      `[search] rerank unavailable after ${Date.now() - started} ms, serving the fused list: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "rerank-failed";
  }

  const kept = selectRelevant(
    pool.map((r, i) => ({
      id: r.id,
      p: probabilities[i] ?? 0,
      foundByBothLegs: lexicalIds.has(r.id) && semanticIds.has(r.id),
      literalMatch: literalIds.has(r.id),
    })),
  );
  console.log(
    `[search] relevance: pool=${pool.length} kept=${kept.length} rerank_ms=${Date.now() - started}`,
  );

  const keptIds = kept.map((k) => k.id);
  const scoreById = new Map(kept.map((k) => [k.id, Math.round(k.score * 1000) / 1000]));
  const snippetById = new Map(pool.flatMap((r) => (r.snippet ? [[r.id, r.snippet] as const] : [])));
  // Every one of the request's filters, unknown rows excluded, is applied here.
  const hydrated = await hydrateDatasetsByIds(db, keptIds, filters, viewer);
  const results = hydrated.map((r) => ({
    ...r,
    score: scoreById.get(r.id) ?? 0,
    ...(snippetById.has(r.id) ? { snippet: snippetById.get(r.id) } : {}),
  }));
  const excludedUnknown = await computeExcludedUnknownCount(
    db,
    null,
    keptIds,
    filters,
    results.length,
    true,
    viewer,
  );
  return {
    ...buildEnvelope(results, "semantic", results.length, undefined, excludedUnknown),
    reranked: true,
  };
}

/**
 * `rows` with the datasets that list one of `modalities` first, the more of
 * them the better, each group keeping its order. Whole-token, so asking for
 * `eeg` never promotes an `ieeg`-only dataset (ADR 0032, #1711).
 */
export function prioritizeModalities(rows: SearchResult[], modalities: string[]): SearchResult[] {
  if (modalities.length === 0) return rows;
  const matches = (r: SearchResult) => {
    const listed = new Set(r.modalities.split(",").map((m) => m.trim().toLowerCase()));
    return modalities.filter((m) => listed.has(m)).length;
  };
  return rows
    .map((r, order) => ({ r, order, m: matches(r) }))
    .sort((a, b) => b.m - a.m || a.order - b.order)
    .map(({ r }) => r);
}

/** Options for {@link executeDatasetSearch}. HTTP-layer concerns (parsing
 *  query-string values, defaulting) are the caller's job; `limit`/`offset`/
 *  `minScore` are expected to already be validated (e.g. via
 *  `parseSearchPagination`) -- this function still clamps them defensively
 *  (#1145 review S3) since it is designed for direct reuse. */
export interface ExecuteDatasetSearchOptions {
  query: string;
  filters: DatasetFilterOptions;
  limit: number;
  offset: number;
  minScore: number;
  /** The caller, for the visibility rule of GET /datasets/:id. Omit for an
   *  anonymous (public-only) search. */
  viewer?: SearchViewer;
  /** Layer 1: narrow the vector query by its `visibility`/`dataset_id` labels.
   *  Off until the metadata index exists and every vector carries the labels. */
  vectorMetadataFilter?: boolean;
}

/** Return shape of {@link executeDatasetSearch} -- the full GET
 *  /datasets/search envelope, built the same way regardless of which tier
 *  answered. `warning` is present only when a sub-query degraded (currently:
 *  `countSearchMatches` failing). `truncated` is true when `count` exceeds
 *  `candidate_ceiling` -- more rows match than this response's candidate
 *  window could ever supply, so paging past `candidate_ceiling` returns an
 *  empty page even though `count` is truthful. */
export interface DatasetSearchEnvelope {
  results: SearchResult[];
  count: number;
  returned: number;
  offset: number;
  limit: number;
  candidate_ceiling: number;
  truncated: boolean;
  method: string;
  min_score: number;
  /** True when the result list was cut by a cross-encoder relevance judgment
   *  (a phrase query with AI and Vectorize bound). Then `count` is the number
   *  of datasets judged to answer the query, `results[].score` is that judged
   *  probability (0..1; a name or author match is floored at 0.5), and `min_score` (a
   *  cosine floor) was not applied.
   *  Absent otherwise. */
  reranked?: true;
  /** The query as searched, present only when a word that matches no dataset
   *  was replaced by a catalog word one typo away ("bilinugual" ->
   *  "bilingual"). Clients should say so ("Showing results for ..."). */
  corrected_query?: string;
  /** Modalities the query named ("eeg" in "sleep eeg") whose datasets are
   *  listed first; absent when none. A preference, not a filter. */
  modality_boost?: string[];
  warning?: string;
  /** D4/ADR 0005: rows hidden by the default unknown-excluded facet policy
   *  (see {@link computeExcludedUnknownCount}). Absent when no facet is
   *  active, or when the widened count itself failed. */
  excluded_unknown?: number;
  /** D5: per-facet breakdown of `excluded_unknown` -- how many rows in the
   *  widened population are unknown for EACH active facet individually.
   *  Buckets do NOT sum to `excluded_unknown`: a row unknown in two active
   *  facets counts once toward the total but once in EACH bucket, so
   *  `sum(values) >= excluded_unknown`, with equality only when no row is
   *  unknown in more than one active facet. Always present together with
   *  `excluded_unknown` (same success/failure gate); never presented as a
   *  partition of it. */
  excluded_unknown_by_facet?: Record<string, number>;
}

/**
 * GET /datasets/search orchestration (#1145, epic #1144 phase 1), extracted
 * out of the route handler into a pure, directly-testable function -- the
 * handler now only parses query params and translates a thrown error into a
 * 500. This is what a regression test needs to actually exercise: calling
 * the individual retrieval functions in a loop over `limit` does NOT
 * reproduce the count-drifts-with-page-size bug, because that bug lived in
 * this orchestration (the old `ftsSearch(db, q, limit * 2)` /
 * `semanticSearchHydrated(..., limit * 2)` calls and `count: filtered.length`
 * taken from that limit-derived window), not in any individual query.
 *
 * Combines these strategies:
 *  - Exact dataset-ID lookup (nm###### / on###### managed mirrors / ds######
 *    legacy or OpenNeuro source) via D1, since embeddings and the FTS index
 *    (name/description/authors/tasks/modalities/readme) do not cover the id, so
 *    a literal id query would otherwise miss -- notably every `on######` mirror,
 *    whose NEMAR-assigned id appears in none of its OpenNeuro-sourced text.
 *  - A phrase (two or more content words) with AI and Vectorize bound is
 *    answered by relevance, not reach: {@link searchByRelevance} gathers a
 *    bounded pool, has a cross-encoder judge it, and returns only what it keeps
 *    (`reranked: true`; ADR 0116). Any failure there falls through to:
 *  - Vectorize semantic similarity (when `ai`/`vectorize` are provided),
 *    fused with FTS5 lexical search by reciprocal-rank fusion.
 *  - D1 FTS text search alone, also used to backfill semantic results when
 *    Vectorize returns no hits.
 *  Before any of these, {@link analyzeQuery} drops words found in over a quarter of
 *  datasets from the lexical query and replaces a word no dataset contains by a
 *  catalog word one typo away (`corrected_query`).
 *
 * `modality`/`has_hed` filter in SQL, pushed into every tier (including the
 * exact-id lookup) via `filters`, rather than being re-applied in JS on the
 * response. `count` is an exact `COUNT(*)` over the same union predicate
 * (`countSearchMatches`), independent of `limit`/`offset` -- and independent
 * of the candidate windows too (#1145 review C3 correction): it can
 * legitimately exceed what `results` was drawn from. A `countSearchMatches`
 * failure degrades to a page-derived lower bound plus `warning` rather than
 * 500ing (#1145 review I1). `results` is the fused list sliced to
 * `[offset, offset + limit)`.
 *
 * Preserved unchanged: exact-id tier ordering, RRF fusion, the
 * `text`/`text_fallback`/`semantic`/`exact_id`/`unavailable` method values and
 * the conditions that select them. Only the expected missing-FTS-table error
 * degrades (to `"unavailable"`, `count: 0`); any other error is re-thrown for
 * the caller to log once and translate into a 500 -- it is not masked, and
 * not double-logged, here (#1145 review S5).
 */
export async function executeDatasetSearch(
  db: D1Database,
  ai: Ai | undefined,
  vectorize: VectorizeIndex | undefined,
  opts: ExecuteDatasetSearchOptions,
): Promise<DatasetSearchEnvelope> {
  const { filters, viewer, vectorMetadataFilter } = opts;
  // #1145 review S3: a cheap defensive clamp, not a substitute for real
  // validation upstream (parseSearchPagination already does that for the
  // HTTP path) -- this function is meant to be safely reusable directly.
  const limit = Number.isFinite(opts.limit)
    ? Math.min(Math.max(Math.trunc(opts.limit), 1), 100)
    : 20;
  const offset = Number.isFinite(opts.offset) ? Math.max(Math.trunc(opts.offset), 0) : 0;
  const minScore = Number.isFinite(opts.minScore)
    ? Math.max(0, Math.min(opts.minScore, 1))
    : DEFAULT_MIN_SCORE;
  const trimmed = opts.query.trim();
  // Match every NEMAR id shape: nm (native), on (OpenNeuro mirror), and ds
  // (legacy catalog OR an OpenNeuro source id whose mirror is on######). `on`
  // was missing here, so `on######` ids fell through to FTS/semantic, which
  // don't index the id -> zero results (#808). lookupDatasetById resolves both
  // dataset_id and source_id, so `ds######` finds the on mirror too.
  const exactIdMatch = /^(nm|on|ds)\d{6}$/i.test(trimmed);

  // FTS5/exact hits carry score=1.0, so this cosine floor only filters the
  // semantic component. Applied BEFORE RRF fusion; the envelope builder does
  // not re-floor the fused scores.
  const applyMinScore = (rows: SearchResult[]): SearchResult[] =>
    minScore <= 0 ? rows : rows.filter((r) => r.score >= minScore);

  // Every return path builds the envelope through this one helper so the
  // shape is uniform (the pre-#1145 `unavailable` branch omitted `min_score`
  // entirely). `candidate_ceiling` (#1145 review S6) is the ACTUAL number of
  // candidates this response's tier gathered (`rows.length`) -- not always
  // the `SEARCH_CANDIDATE_CEILING` constant -- so it stays honest for the
  // semantic tier's larger (up to `SEARCH_CANDIDATE_CEILING + SEMANTIC_TOPK`,
  // deduped) pool, and for a query with fewer true matches than any ceiling.
  // `truncated` (#1145 review S1) is the derived signal a caller would
  // otherwise have to reconstruct by hand from `count`/`candidate_ceiling`.
  let correctedQuery: string | undefined;
  let modalityBoost: string[] = [];
  const buildEnvelope = (
    allRows: SearchResult[],
    method: string,
    count: number,
    warning?: string,
    excludedUnknown?: ExcludedUnknownResult,
  ): DatasetSearchEnvelope => {
    const rows = prioritizeModalities(allRows, modalityBoost);
    const page = rows.slice(offset, offset + limit);
    return {
      results: page,
      count,
      returned: page.length,
      offset,
      limit,
      candidate_ceiling: rows.length,
      truncated: count > rows.length,
      method,
      min_score: minScore,
      ...(correctedQuery !== undefined ? { corrected_query: correctedQuery } : {}),
      ...(modalityBoost.length > 0 ? { modality_boost: modalityBoost } : {}),
      ...(warning !== undefined ? { warning } : {}),
      ...(excludedUnknown !== undefined
        ? {
            excluded_unknown: excludedUnknown.excludedUnknown,
            excluded_unknown_by_facet: excludedUnknown.excludedUnknownByFacet,
          }
        : {}),
    };
  };

  try {
    if (exactIdMatch) {
      // The exact-id tier respects filters too (#1145): an id hit failing the
      // modality/hasHed filter falls through to the fused tiers below instead
      // of short-circuiting with an empty `exact_id` envelope (see the C4
      // correction on lookupDatasetById for what the prior behaviour
      // actually was).
      const idHit = await lookupDatasetById(db, trimmed.toLowerCase(), filters, viewer);
      if (idHit) return buildEnvelope([idHit], "exact_id", 1);
    }
    // What the query is made of: the words that discriminate between datasets
    // drive the lexical leg ("study" is in 59% of the catalog and must not
    // decide a match); the caller's own words drive the embedding.
    const analysis = await analyzeQuery(db, trimmed);
    correctedQuery = analysis.correctedQuery;
    modalityBoost = analysis.modalityBoost;
    let semanticFailed = false;
    if (analysis.isPhrase && ai && vectorize) {
      const byRelevance = await searchByRelevance(
        db,
        ai,
        vectorize,
        analysis,
        filters,
        buildEnvelope,
        viewer,
        vectorMetadataFilter,
      );
      if (typeof byRelevance !== "string") return byRelevance;
      // An embedding that just failed is not tried a second time on this request.
      semanticFailed = byRelevance === "embedding-failed";
    }
    const ftsMatch = buildFtsMatch(analysis.lexicalQuery);
    // Tier-specific log so a failure here is distinguishable from the
    // semantic/hydration tiers; re-throw so the outer catch still degrades.
    // Fetches a fixed SEARCH_CANDIDATE_CEILING candidates regardless of
    // `limit`, so the population `count` describes doesn't shrink at small
    // page sizes.
    const lexical = await ftsSearch(
      db,
      analysis.lexicalQuery,
      SEARCH_CANDIDATE_CEILING,
      filters,
      viewer,
    ).catch((ftsErr) => {
      console.error(
        `[search] FTS tier failed: ${ftsErr instanceof Error ? ftsErr.message : String(ftsErr)}`,
      );
      throw ftsErr;
    });
    // The answer when only the lexical leg is usable; `count` is the size of
    // the FTS match alone.
    const lexicalOnly = async (method: "text" | "text_fallback") => {
      const page = lexical.slice(offset, offset + limit);
      const { count, warning } = await countSearchMatchesSafely(
        db,
        ftsMatch,
        [],
        filters,
        offset + page.length,
        viewer,
      );
      const excludedUnknown = await computeExcludedUnknownCount(
        db,
        ftsMatch,
        [],
        filters,
        count,
        warning === undefined,
        viewer,
      );
      return buildEnvelope(lexical, method, count, warning, excludedUnknown);
    };
    if (!ai || !vectorize) return lexicalOnly("text");
    if (semanticFailed) return lexicalOnly("text_fallback");
    let semantic: SearchResult[] = [];
    try {
      // Fixed SEMANTIC_TOPK (also Vectorize's returnMetadata:'none' topK
      // ceiling), not `limit * 2`.
      semantic = await semanticSearchHydrated(
        ai,
        vectorize,
        db,
        analysis.semanticQuery,
        SEMANTIC_TOPK,
        filters,
        viewer,
        vectorMetadataFilter,
      );
    } catch (embErr) {
      const embMsg = embErr instanceof Error ? embErr.message : String(embErr);
      if (!embMsg.startsWith("[embedding]")) {
        // Not a Vectorize/embedding failure (e.g. a hydration/filter-SQL bug
        // inside semanticSearchHydrated) -- don't mask it as "semantic tier
        // unavailable, fall back to text" (#1145 review I3). Propagate it
        // the way the FTS tier's own `.catch()` does.
        throw embErr;
      }
      console.error("[search] semantic tier failed, using FTS only:", embErr);
      return lexicalOnly("text_fallback");
    }
    const semanticFiltered = applyMinScore(semantic);
    if (semanticFiltered.length === 0) return lexicalOnly("text_fallback");
    // The union `count` describes is exactly what the fused results are
    // drawn from: the FTS match plus the (min-score-filtered) semantic ids.
    const fused = rrfFuse(semanticFiltered, lexical);
    const page = fused.slice(offset, offset + limit);
    const semanticIds = semanticFiltered.map((r) => r.id);
    const { count, warning } = await countSearchMatchesSafely(
      db,
      ftsMatch,
      semanticIds,
      filters,
      offset + page.length,
      viewer,
    );
    const excludedUnknown = await computeExcludedUnknownCount(
      db,
      ftsMatch,
      semanticIds,
      filters,
      count,
      warning === undefined,
      viewer,
    );
    return buildEnvelope(fused, "semantic", count, warning, excludedUnknown);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Only the expected missing-FTS-table case degrades to "unavailable"
    // (and is logged, here, once); any other structural error is re-thrown
    // -- logging it here too would double-log the same failure once the
    // caller logs it again while translating it to a 500 (#1145 review S5).
    if (msg.includes("no such table: datasets_fts")) {
      console.warn(`[search] datasets_fts missing, degrading to unavailable: ${msg}`);
      return buildEnvelope([], "unavailable", 0);
    }
    throw err;
  }
}
