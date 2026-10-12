/**
 * `search_datasets` (epic #1065 phase 2, issue #1294; design doc section 5.1).
 *
 * Never an HTTP hop to the api host -- calls the same services the
 * `GET /datasets` / `GET /datasets/search` routes call, directly. Cost
 * class: one catalog fetch, no signal bytes, no `index.json` read.
 *
 *  - With `query`: `executeDatasetSearch` (FTS plus Vectorize, the same
 *    tiering `GET /datasets/search` uses). `SearchResult` rows carry
 *    neither `license` nor the zarr columns, so one follow-up D1 query
 *    (`dataset_id IN (...)`, via the shared json_each idiom) fills them for
 *    the page -- one query total, never one per hit. `executeDatasetSearch`
 *    DEGRADES rather than throwing when the FTS index itself is missing
 *    (`method: "unavailable"`); this tool answers that as a tool error
 *    rather than silently returning an empty page (ADR 0005 is about
 *    partial data still serving, not about masking an infra failure as "no
 *    matches").
 *  - Without `query`: the same public-catalog base (`buildPublicCatalogBase`)
 *    and filter clauses (`buildDatasetFilterClauses`) the list route uses, a
 *    compact SELECT of exactly the hit columns, ordered newest-published
 *    first by the shared `PUBLISHED_AT_SQL` (the list route's own default,
 *    #1477), and a `COUNT(*)` over the same
 *    predicate -- both in one `db.batch`. This branch selects license/zarr
 *    facts directly, so there is no follow-up query and no unresolved-hit
 *    case here.
 *
 * `has_zarr` means converted (`zarr_status === 'ready' && store_count > 0`),
 * never fidelity-verified -- the same predicate `buildZarrCatalog` defends.
 * A `count` of 0 is not an error; the tool description points a caller at
 * `describe_dataset` for facet vocabulary.
 */

import {
  SEARCH_DATASETS_MAX_FILTERS,
  type SearchDatasetsHit,
  type SearchDatasetsInput,
  flagToBoolean,
  searchDatasetsOutputSchema,
} from "../../../../shared/contract/mcp.js";
import { FACETS } from "../../../../shared/facets.js";
import { RangeParseError } from "../../../../shared/range.js";
import { parseLicenseTierFilter } from "../../lib/license.js";
import { CONCEPT_DOI_SQL } from "../../services/anonymity";
import { splitCsv } from "../../services/data-router.js";
import { FacetEnumParseError, parseFacetFilters } from "../../services/dataset-facets.js";
import {
  type DatasetFilterOptions,
  ModalityTokenLimitError,
  PUBLISHED_AT_SQL,
  buildDatasetFilterClauses,
  buildPublicCatalogBase,
  parseModalityFilter,
} from "../../services/dataset-filters.js";
import {
  DATASET_ID_IN_JSON_LIST,
  DEFAULT_MIN_SCORE,
  type SearchResult,
  datasetIdListParam,
  executeDatasetSearch,
} from "../../services/dataset-search.js";
import type { Bindings } from "../../types/bindings.js";
import type { ToolOutcome } from "../tool-types.js";

/** The license + zarr facts `SearchResult` (dataset-search.ts) does not
 *  carry, fetched in one follow-up query keyed by the page's dataset ids. */
interface LicenseAndZarr {
  dataset_id: string;
  license: string | null;
  zarr_status: string | null;
  zarr_store_count: number | null;
}

async function fetchLicenseAndZarr(
  db: D1Database,
  datasetIds: string[],
): Promise<Map<string, LicenseAndZarr>> {
  if (datasetIds.length === 0) return new Map();
  const rows = await db
    .prepare(
      // DATASET_ID_IN_JSON_LIST hardcodes the `d.` alias (dataset-search.ts),
      // so this query aliases `datasets` the same way rather than repeating
      // an unaliased duplicate of the predicate.
      `SELECT d.dataset_id, d.license, d.zarr_status, d.zarr_store_count FROM datasets d WHERE ${DATASET_ID_IN_JSON_LIST}`,
    )
    .bind(datasetIdListParam(datasetIds))
    .all<LicenseAndZarr>();
  return new Map((rows.results ?? []).map((r) => [r.dataset_id, r]));
}

function isConverted(zarrStatus: string | null, zarrStoreCount: number | null): boolean {
  return zarrStatus === "ready" && (zarrStoreCount ?? 0) > 0;
}

/** `SearchResult.has_hed` (dataset-search.ts) is typed `number | null` --
 *  wider than the catalog's actual `0 | 1 | null` convention (#869) -- so
 *  this reads it by explicit comparison rather than casting to the
 *  narrower type `flagToBoolean` expects. Any value other than exactly `1`
 *  or `0` (there should be none) is treated as "not yet classified", same
 *  as `flagToBoolean`'s own null/undefined case. */
function hasHedFromSearchResult(value: number | null | undefined): boolean | null {
  if (value === 1) return true;
  if (value === 0) return false;
  return null;
}

/** The compact row shape the no-`query` branch selects -- exactly the hit
 *  columns, nothing more. */
interface CatalogListRow {
  dataset_id: string;
  name: string | null;
  concept_doi: string | null;
  license: string | null;
  modalities: string | null;
  tasks: string | null;
  subject_count: number | null;
  has_hed: 0 | 1 | null;
  zarr_status: string | null;
  zarr_store_count: number | null;
}

export interface MergeHitsResult {
  hits: SearchDatasetsHit[];
  /** Dataset ids present in `results` but absent from `extra` -- the
   *  follow-up query found no `datasets` row for them (a race with a
   *  deletion, or a stale Vectorize id). Their hit still gets
   *  `license: null, has_zarr: false` (the closed shape the schema
   *  requires), but the caller must not present that as a confirmed
   *  absence -- see the `note` this drives in {@link searchDatasetsTool}. */
  unresolvedIds: string[];
}

/**
 * Merge `executeDatasetSearch`'s `SearchResult` rows with the follow-up
 * license/zarr map into the wire hit shape. Pure (no I/O), so the miss path
 * -- an id in `results` that `extra` has no entry for -- is unit-testable
 * with a real, deliberately incomplete `Map`, no fake D1 needed.
 */
export function mergeHitsWithCatalog(
  results: SearchResult[],
  extra: Map<string, LicenseAndZarr>,
): MergeHitsResult {
  const unresolvedIds: string[] = [];
  const hits = results.map((r) => {
    const e = extra.get(r.id);
    if (!e) unresolvedIds.push(r.id);
    return {
      dataset_id: r.id,
      name: r.name,
      doi: r.doi || null,
      license: e ? e.license : null,
      modalities: splitCsv(r.modalities),
      tasks: splitCsv(r.tasks),
      subject_count: r.participants,
      has_hed: hasHedFromSearchResult(r.has_hed),
      has_zarr: e ? isConverted(e.zarr_status, e.zarr_store_count) : false,
    };
  });
  return { hits, unresolvedIds };
}

/** A rejected filter value, reported so the caller can correct it.
 *
 *  Errors teach here (epic #1065): naming the parameter and what it received
 *  lets an agent re-plan, where a bare validation failure just ends the turn.
 *  This is also the guard against the failure that made this change necessary:
 *  the input schema is `.passthrough()`, so an argument the server does not
 *  declare is accepted and silently dropped, and unfiltered results then look
 *  filtered. A facet value that parses wrong is at least visible; see the
 *  `unknown argument` note below for the ones that cannot be. */
function badFilterOutcome(message: string): ToolOutcome {
  return {
    result: {
      isError: true,
      content: [{ type: "text", text: message }],
    },
  };
}

function unavailableOutcome(): ToolOutcome {
  return {
    result: {
      isError: true,
      content: [
        {
          type: "text",
          text:
            "The search index is temporarily unavailable. Try search_datasets again without a " +
            "query to browse the public catalog, or retry shortly.",
        },
      ],
    },
  };
}

/** The wire argument names mapped onto `DatasetFilterOptions`' own field
 *  names. Both directions of the mapping read this: {@link buildFilterOptions}
 *  writes the options, {@link activeFilterNames} names them back for the
 *  refusal message. A transposition here would be invisible to either, so
 *  `filter-count-matches-clauses.unit.test.ts` pins each wire name to the SQL
 *  its own clause contains. */
const BESPOKE_OPTION_FIELD = {
  modality: "modality",
  task: "task",
  has_hed: "hasHed",
  has_zarr: "hasZarr",
  author: "author",
  has_doi: "hasDoi",
  has_zarr_verified: "hasZarrVerified",
  data_complete: "dataComplete",
  recent: "recent",
  license: "licenseTiers",
} as const satisfies Record<string, keyof DatasetFilterOptions>;

/**
 * Whether a built option will actually produce a clause.
 *
 * Deliberately reads the MAPPED option and not the wire argument. The two are
 * not interchangeable, and an earlier revision of this file counted the wire
 * argument and was wrong for ten of the thirty filters: `license: "CC0-1.0"`
 * is a non-empty string that `parseLicenseTierFilter` reduces to no tiers, a
 * version facet given `"v"` parses to an empty prefix, an enum facet given
 * `","` parses to no values, and `modality: "  "` is whitespace that the
 * builder's raw truthiness test accepts (it still does: the clause binds an
 * empty token list and matches nothing, since #1711, where it used to bind
 * `%  %`). Every one of those disagreements disappears once the question is
 * asked after parsing.
 *
 * The rules themselves are the builders': `buildDatasetFilterClauses` guards
 * each bespoke clause on bare truthiness (`if (opts.modality)`, `if
 * (opts.hasDoi)` -- so `has_doi: false` builds NOTHING, and does not mean
 * "datasets without a DOI"), `recent` on `> 0`, and `licenseTiers` on a
 * non-empty array. `hasActiveFilters` (dataset-search.ts) applies the same
 * rules, but answers a different question: one boolean for the whole options
 * bag, including `search`, where this one has to say WHICH filters, by the
 * names the caller used.
 */
function optionNarrows(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "number") return value > 0;
  return Boolean(value);
}

/**
 * The filters these options will actually narrow by, under the wire names the
 * caller used, in the same order `SEARCH_DATASETS_FILTER_PARAMS` declares them
 * (bespoke first, then facets).
 *
 * The facet half reads the PARSED bag, so a facet the parser dropped is not
 * counted, and a facet added to `shared/facets.ts` is counted the day it is
 * declared.
 */
export function activeFilterNames(filters: DatasetFilterOptions): string[] {
  const names: string[] = [];
  for (const [wire, field] of Object.entries(BESPOKE_OPTION_FIELD)) {
    if (optionNarrows(filters[field])) names.push(wire);
  }
  const facets = filters.facets ?? {};
  for (const facet of FACETS) {
    if (facets[facet.key as keyof typeof facets] !== undefined) names.push(facet.queryParam);
  }
  return names;
}

/**
 * The wire argument names mapped onto `DatasetFilterOptions`' own field names
 * -- the one place the two spellings meet (`has_zarr_verified` ->
 * `hasZarrVerified`, `license` -> a parsed tier list).
 *
 * Exported so the cap's notion of an active filter can be checked against the
 * clauses these options actually build, instead of against a comment claiming
 * they match.
 */
export function buildFilterOptions(
  args: SearchDatasetsInput,
  facets: DatasetFilterOptions["facets"],
): DatasetFilterOptions {
  return {
    modality: args.modality,
    task: args.task,
    hasHed: args.has_hed,
    hasZarr: args.has_zarr,
    author: args.author,
    hasDoi: args.has_doi,
    hasZarrVerified: args.has_zarr_verified,
    dataComplete: args.data_complete,
    recent: args.recent,
    licenseTiers: parseLicenseTierFilter(args.license),
    facets,
    includeUnknown: args.include_unknown,
  };
}

export async function searchDatasetsTool(
  env: Pick<Bindings, "DB" | "AI" | "VECTORIZE">,
  args: SearchDatasetsInput,
): Promise<ToolOutcome> {
  // Every filter `buildDatasetFilterClauses` understands, not a hand-picked
  // four. The bespoke fields below and the declared facet table are the two
  // halves ADR 0032 deliberately keeps separate; both ride in the same options
  // bag, and both the query and no-query paths consume it.
  let facets: DatasetFilterOptions["facets"];
  try {
    facets = parseFacetFilters((key) => {
      const raw = (args as Record<string, unknown>)[key];
      return typeof raw === "string" ? raw : undefined;
    });
  } catch (err) {
    // Narrowed to the two declared parse errors, matching the HTTP route
    // (routes/datasets/catalog.ts). A broad catch would launder an internal
    // fault into "that filter value was not accepted", and the model would
    // retry differently shaped values forever against a fault that has nothing
    // to do with its input. Anything else rethrows into withToolMetrics, which
    // records outcome "exception" and logs it. ADR 0051: a specific error is
    // never overwritten by a generic one.
    if (!(err instanceof RangeParseError || err instanceof FacetEnumParseError)) throw err;
    const detail = err.message;
    return badFilterOutcome(
      `That filter value was not accepted: ${detail}. Ranges take \`10..20\`, \`64..\`, or \`..128\`; enum and version facets take a declared token.`,
    );
  }

  // #1711: an over-long modality list is refused, never truncated, and
  // reported by name like a malformed facet value (ADR 0051). Checked after
  // the facet parse so the more specific complaint comes first; the clause
  // builder enforces the same bound as a backstop.
  if (args.modality) {
    try {
      parseModalityFilter(args.modality);
    } catch (err) {
      if (!(err instanceof ModalityTokenLimitError)) throw err;
      return badFilterOutcome(`That filter value was not accepted. ${err.message}`);
    }
  }

  const filters = buildFilterOptions(args, facets);

  // The cap, checked on the BUILT options rather than the raw arguments, so
  // that what it counts and what the SQL carries cannot disagree. It sits
  // after the facet parse for the same reason: a malformed facet value is the
  // more specific complaint and is reported first (ADR 0051), and parsing
  // thirty in-memory strings costs nothing next to the D1 round trip this
  // guards. `assertBoundParamBudget` remains the backstop; see
  // SEARCH_DATASETS_MAX_FILTERS for why this cap is not that ceiling.
  const active = activeFilterNames(filters);
  if (active.length > SEARCH_DATASETS_MAX_FILTERS) {
    return badFilterOutcome(
      `Too many filters in one call: ${active.length}, and at most ${SEARCH_DATASETS_MAX_FILTERS} can be combined. Drop the least selective ones and filter the results yourself, or run narrower calls and intersect them. Supplied: ${active.join(", ")}.`,
    );
  }

  let hits: SearchDatasetsHit[];
  let count: number;
  let note: string | undefined;
  let truncated: boolean | undefined;

  if (args.query) {
    const envelope = await executeDatasetSearch(env.DB, env.AI, env.VECTORIZE, {
      query: args.query,
      filters,
      limit: args.limit,
      offset: 0,
      minScore: DEFAULT_MIN_SCORE,
    });
    if (envelope.method === "unavailable") {
      console.error("[search_datasets] search index unavailable (datasets_fts missing)");
      return unavailableOutcome();
    }
    const extra = await fetchLicenseAndZarr(
      env.DB,
      envelope.results.map((r) => r.id),
    );
    const merged = mergeHitsWithCatalog(envelope.results, extra);
    hits = merged.hits;
    count = envelope.count;
    truncated = envelope.truncated;
    const notes: string[] = [];
    if (envelope.warning) notes.push(envelope.warning);
    if (merged.unresolvedIds.length > 0) {
      console.warn(`[search_datasets] no catalog row for: ${merged.unresolvedIds.join(", ")}`);
      notes.push(
        `License and Zarr status could not be resolved for: ${merged.unresolvedIds.join(", ")}.`,
      );
    }
    note = notes.length > 0 ? notes.join(" ") : undefined;
  } else {
    const { from, params } = buildPublicCatalogBase("active", undefined, undefined);
    const filterClauses = buildDatasetFilterClauses(params, filters);
    const selectSql = `SELECT d.dataset_id, d.name, ${CONCEPT_DOI_SQL} AS concept_doi, d.license, d.modalities, d.tasks, d.subject_count, d.has_hed, d.zarr_status, d.zarr_store_count ${from}${filterClauses} ORDER BY ${PUBLISHED_AT_SQL} DESC LIMIT ?`;
    const countSql = `SELECT COUNT(*) AS total ${from}${filterClauses}`;
    const [rowsResult, countResult] = await env.DB.batch<CatalogListRow | { total: number }>([
      env.DB.prepare(selectSql).bind(...params, args.limit),
      env.DB.prepare(countSql).bind(...params),
    ]);
    const rows = (rowsResult.results ?? []) as CatalogListRow[];
    count = ((countResult.results?.[0] as { total: number } | undefined)?.total as number) ?? 0;
    hits = rows.map((row) => ({
      dataset_id: row.dataset_id,
      // NOT NULL in the schema; `?? ""` is defensive symmetry with
      // describe-dataset.ts's identical row.name handling, not a real gap.
      name: row.name ?? "",
      doi: row.concept_doi || null,
      license: row.license,
      modalities: splitCsv(row.modalities),
      tasks: splitCsv(row.tasks),
      subject_count: row.subject_count,
      has_hed: flagToBoolean(row.has_hed),
      has_zarr: isConverted(row.zarr_status, row.zarr_store_count),
    }));
  }

  const output = searchDatasetsOutputSchema.parse({
    results: hits,
    count,
    limit: args.limit,
    note,
    truncated,
  });
  return {
    result: {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    },
  };
}
