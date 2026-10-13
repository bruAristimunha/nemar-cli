/**
 * Dataset filter-clause builder (#646), relocated in #1145 (epic #1144 phase 1).
 *
 * Moved verbatim from `backend/src/routes/datasets/catalog.ts`, where it
 * originally lived alongside the `GET /datasets` list handler. `dataset-search.ts`
 * needs to apply these same clauses inside its own queries (threading filters
 * into the search endpoint's SQL, rather than filtering in JS after the fact),
 * but `catalog.ts` (a route module) already imports from `dataset-search.ts`
 * (a service module) -- so a service importing back from a route module would
 * be both a circular import and a layering inversion. This file is the shared
 * home both sides import from; `catalog.ts` re-exports both names so the
 * existing test files that import them from there
 * (`datasets-search.unit.test.ts`, `data-complete-filter.test.ts`,
 * `has-hed-filter.test.ts`, `license-tier.test.ts`) keep passing unchanged.
 *
 * This file has NO imports from `dataset-search.ts` (review round 3 caught an
 * earlier version that imported `buildFtsMatch` back from there, recreating a
 * two-file cycle one layer down -- harmless at runtime since both are hoisted
 * function declarations, but it contradicted this docstring, so `buildFtsMatch`
 * lives here now instead). `dataset-search.ts` imports FROM this file only.
 */

import { MAX_MODALITY_FILTER_TOKENS } from "../../../shared/modality-filter.js";
import type { LicenseTier } from "../lib/license";
import type { AuthUser } from "../types/bindings";
import { hasRole } from "../types/bindings";
import { type FacetFilterValues, buildFacetClauses } from "./dataset-facets";
import { ZARR_VERIFY_STATUS_PATH } from "./sweep-stamps";

/**
 * When a dataset reached the public catalog (#1477): its first publication
 * (migration 0085, stamped for imports and native publications alike), else a
 * legacy folded-catalog row's `publish_date`, else its row creation.
 * `created_at` alone is when a draft row was made, so a dataset drafted in
 * July and published in September sorted, and filtered as "recent", as if it
 * were from July. ONE definition for every reader: the list route's
 * newest/oldest sort and citations tiebreak, `?recent=`, and the MCP
 * `search_datasets` browse order. Assumes the `datasets d` alias.
 */
export const PUBLISHED_AT_SQL = "COALESCE(d.first_published_at, d.publish_date, d.created_at)";

/** Build an injection-safe FTS5 MATCH expression: tokenize to alphanumerics
 *  (dropping all FTS5 operator chars), quote each token and prefix-match it,
 *  OR them for recall. Returns null when there is nothing to match. Lives
 *  here (not dataset-search.ts) so this file has no outgoing imports from
 *  dataset-search.ts -- the whole point of the #1145 move was to let
 *  dataset-search.ts depend on this file, not the other way around. */
export function buildFtsMatch(query: string): string | null {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}

/**
 * The tokens of `d.modalities`, one row per token, as the head of a
 * `WITH RECURSIVE` named `modality_tokens(tok, rest)`: the list is lower-cased,
 * split on every comma, and each token trimmed of surrounding whitespace, so
 * `beh , EEG` yields `beh` and `eeg`, `ieeg` never yields `eeg`, and a space
 * INSIDE a token (`e eg`) stays inside it. A NULL list yields no token at all:
 * `LOWER(NULL)` is NULL, so the seed row carries a NULL `rest`, the recursion's
 * condition is NULL and so not true, and no wanted token can equal the NULL
 * seed token. The first row is that NULL seed token, not an empty string, so it
 * equals nothing: `NULL IN (...)` is never true, and even an empty wanted token
 * (which {@link parseTokenList} drops, but which would otherwise match the seed
 * of EVERY row) can only match a row that really holds an empty token.
 *
 * Splitting in SQL is what makes this the same tokenizing as
 * `parseTokenList` (split, trim, lower-case), and so as the facet vocabulary's
 * tally (`dataset-facet-vocabulary.ts`): a value the vocabulary advertises
 * always filters to its advertised count, including a stored `e eg` (one
 * token, not `eeg`). The trim here covers space, tab, CR and LF, the
 * whitespace a stored list can carry; JS `trim` also covers exotic Unicode
 * spaces, which nothing writes here.
 *
 * Termination: a step runs only while `rest` still contains a comma, and each
 * step removes everything up to and including that comma, so `rest` strictly
 * shortens and the recursion stops after one step per comma. It deliberately
 * does NOT stop on `rest = ''`, which holds only if every step drains `rest`
 * completely: SQLite's SUBSTR stops at an embedded NUL byte, so a stored value
 * like `x,y,z<NUL>,eeg` can leave `rest` non-empty and comma-free, INSTR returns
 * 0, SUBSTR(rest, 1) returns `rest` unchanged, and an `rest <> ''` condition
 * repeats that row until the database's time limit (30 s on D1) ends the
 * statement. No writer produces a NUL, but one such row would stall every
 * modality-filtered request. `modality-tokenizer-termination.test.ts` runs it in
 * a child process with a hard timeout, because a hung bun:sqlite call cannot be
 * interrupted from inside the test.
 *
 * Used as `EXISTS (${MODALITY_TOKENS_SQL} SELECT 1 FROM modality_tokens WHERE
 * tok IN (SELECT value FROM json_each(?)))`, which references the outer `d`.
 */
export const MODALITY_TOKENS_SQL = `WITH RECURSIVE modality_tokens(tok, rest) AS (
    SELECT NULL, LOWER(d.modalities) || ','
    UNION ALL
    SELECT TRIM(SUBSTR(rest, 1, INSTR(rest, ',') - 1), ' ' || CHAR(9) || CHAR(10) || CHAR(13)),
           SUBSTR(rest, INSTR(rest, ',') + 1)
    FROM modality_tokens WHERE INSTR(rest, ',') > 0
  )`;

/**
 * The distinct, trimmed, lower-cased tokens of a comma-separated value; empty
 * tokens are dropped. `"EEG, meg,eeg"` is `["eeg", "meg"]`, and `" , "` is
 * `[]`. Whitespace INSIDE a token is kept, so `"eeg meg"` is one token and
 * not a list. The wanted side of {@link MODALITY_TOKENS_SQL}'s comparison, and
 * the tokenizer the facet vocabulary tallies stored lists with.
 */
export function parseTokenList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(",")
        .map((token) => token.trim().toLowerCase())
        .filter((token) => token !== ""),
    ),
  ];
}

/**
 * Thrown when a `modality` filter names more than
 * {@link MAX_MODALITY_FILTER_TOKENS} distinct tokens. A rejection the caller
 * translates into a 400 (the HTTP routes) or a refused tool call (MCP), the
 * way a malformed facet range is; truncating to the first 32 would answer a
 * different question than the one asked. The message states the count and the
 * limit and does not echo the value.
 */
export class ModalityTokenLimitError extends Error {
  constructor(
    readonly distinct: number,
    readonly limit: number = MAX_MODALITY_FILTER_TOKENS,
  ) {
    super(
      [
        `The modality filter names ${distinct} distinct values and at most ${limit} are accepted.`,
        "The catalog has about a dozen modalities, so pass fewer.",
      ].join(" "),
    );
    this.name = "ModalityTokenLimitError";
  }
}

/**
 * {@link parseTokenList} for a `modality` filter value, refusing one that names
 * more than {@link MAX_MODALITY_FILTER_TOKENS} DISTINCT tokens (counted after
 * normalising, so `eeg,EEG, eeg` is one). The limit is an input contract, not a
 * cost guard (the clause's cost is flat in the number of wanted tokens; see
 * `shared/modality-filter.ts`): it keeps a caller-controlled value small and
 * predictable. It is checked once at the parse step of every entry point, and
 * again in {@link buildDatasetFilterClauses} so a future caller that skips the
 * parse cannot reach the clause with an unbounded list.
 *
 * @throws {ModalityTokenLimitError}
 */
export function parseModalityFilter(raw: string): string[] {
  const tokens = parseTokenList(raw);
  if (tokens.length > MAX_MODALITY_FILTER_TOKENS) {
    throw new ModalityTokenLimitError(tokens.length);
  }
  return tokens;
}

// Escape SQLite LIKE wildcards in user input so a literal '%' or '_' in the
// search term means itself rather than "match everything" / "match any
// character". Paired with `ESCAPE '\\'` on every LIKE predicate that uses
// these patterns. Exported for unit testing.
export function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, "\\$&");
}

/**
 * Options accepted by {@link buildDatasetFilterClauses}. Named so both the
 * catalog list endpoint and the search endpoint's SQL-side filtering (#1145)
 * can share the exact same shape rather than each hand-rolling a subset.
 */
export interface DatasetFilterOptions {
  search?: string;
  /** Modality, matched as a WHOLE token of the dataset's comma-joined
   *  `modalities` list, case-insensitively (#1711): `eeg` matches `eeg` and
   *  `eeg,meg` but not `ieeg`. A comma-separated value matches a dataset
   *  holding ANY of its tokens, the same OR the `license` filter uses, and
   *  names at most {@link MAX_MODALITY_FILTER_TOKENS} distinct tokens (more is
   *  a {@link ModalityTokenLimitError}). See {@link MODALITY_TOKENS_SQL} and
   *  {@link parseTokenList}. A non-empty value that names no token
   *  (whitespace, bare commas) is a filter that matches nothing, never an
   *  unfiltered list. */
  modality?: string;
  author?: string;
  task?: string;
  hasDoi?: boolean;
  hasHed?: boolean;
  /** Only datasets with a ready Zarr copy holding at least one store (issue
   *  #1062, epic #1181 phase 2). Same nullable-safe bespoke-filter shape as
   *  hasHed/dataComplete above -- not a facet-table entry, because the
   *  underlying `zarr` facet (dataset-facets.ts) already exists as an ENUM
   *  match on the raw `zarr_status` value; this is a distinct derived
   *  predicate (ready AND store_count > 0). `hasZarr`'s meaning is STABLE:
   *  phase 8 adds a SEPARATE `has_zarr_verified` filter for "converted AND
   *  verified" rather than redefining this one out from under existing
   *  callers (PR #1201 review, item 9). */
  hasZarr?: boolean;
  /** Only datasets whose Zarr copy has PASSED the standing fidelity
   *  verification sweep (issue #1068, epic #1181 phase 8):
   *  `has_zarr AND zarr_verify_status = 'verified'`. A strict narrowing of
   *  `hasZarr` above, not a replacement for it -- a fresh conversion is
   *  `has_zarr=true` with `zarr_verify_status` still null until the daily
   *  sweep (services/zarr-fidelity-sweep.ts) reaches it; the viewer keeps
   *  reading index.json regardless (ADR 0005). Same nullable-safe
   *  bespoke-filter shape as `hasZarr`, not a facet-table entry. */
  hasZarrVerified?: boolean;
  dataComplete?: boolean;
  recent?: number;
  licenseTiers?: LicenseTier[];
  /**
   * The declared facet vocabulary (epic #1144 phase 3, #1147) --
   * `shared/facets.ts` + `dataset-facets.ts`. Kept separate from the flat
   * legacy fields above rather than folded in: those nine fields have
   * irregular, bespoke semantics (FTS routing, LIKE-joined `author` and
   * `task` lists, a whole-token `modality` list) that don't fit a declared
   * table, while every facet here shares one of five regular shapes. See
   * ADR 0032.
   */
  facets?: FacetFilterValues;
  /** Widens every ACTIVE facet's predicate with its declared NULL test
   *  (D4/ADR 0005): a NULL never satisfies a SQL comparison, so unknown rows
   *  are excluded by default, and this is the explicit escape hatch. Has no
   *  effect on the legacy filters above (none of them are facet-table
   *  entries) or when `facets` is empty/absent. */
  includeUnknown?: boolean;
}

/**
 * #646 filter clauses for the single-table `datasets` list -- and, since
 * #1145 (epic #1144 phase 1), for every GET /datasets/search tier too
 * (exact-id, FTS, semantic-hydration all call this via dataset-search.ts).
 * Reads d.* only (no nemar_catalog), and routes free-text `search` through the
 * FTS5 index (`d.id IN (SELECT rowid FROM datasets_fts WHERE … MATCH …)`) plus
 * dataset_id/source_id LIKE, replacing the old `c.search_text` LIKE.
 */
/** D1's per-statement bound-parameter ceiling. */
export const MAX_BOUND_PARAMS = 100;

/** Throw before binding if a statement would exceed {@link MAX_BOUND_PARAMS}.
 *
 *  Local SQLite allows far more variables than D1 does, so a query that
 *  overflows on D1 runs fine in tests -- which is how #1193 shipped: every
 *  faceted text search 500'd in production with D1's opaque
 *  `too many SQL variables`, and no local test could reproduce it. Applied
 *  centrally in {@link buildDatasetFilterClauses} rather than per call site,
 *  because the facet vocabulary is a growing surface and a new caller should
 *  inherit the ceiling instead of having to remember it (#1195 review I5). */
export function assertBoundParamBudget(params: readonly unknown[], context: string): void {
  if (params.length > MAX_BOUND_PARAMS) {
    throw new Error(
      `${context}: ${params.length} bound parameters exceeds D1's limit of ${MAX_BOUND_PARAMS}. Collapse per-item placeholder lists into a single json_each parameter.`,
    );
  }
}

export function buildDatasetFilterClauses(
  params: (string | number)[],
  opts: DatasetFilterOptions,
): string {
  let clauses = "";

  if (opts.search) {
    const pattern = `%${escapeLikePattern(opts.search.toLowerCase())}%`;
    const match = buildFtsMatch(opts.search);
    if (match) {
      clauses +=
        " AND (LOWER(d.dataset_id) LIKE ? ESCAPE '\\'" +
        " OR LOWER(COALESCE(d.source_id, '')) LIKE ? ESCAPE '\\'" +
        " OR d.id IN (SELECT rowid FROM datasets_fts WHERE datasets_fts MATCH ?))";
      params.push(pattern, pattern, match);
    } else {
      // No FTS-usable tokens (e.g. all punctuation): fall back to id/name LIKE.
      clauses +=
        " AND (LOWER(d.dataset_id) LIKE ? ESCAPE '\\'" +
        " OR LOWER(COALESCE(d.source_id, '')) LIKE ? ESCAPE '\\'" +
        " OR LOWER(d.name) LIKE ? ESCAPE '\\'" +
        " OR LOWER(COALESCE(d.description, '')) LIKE ? ESCAPE '\\')";
      params.push(pattern, pattern, pattern, pattern);
    }
  }

  if (opts.modality) {
    // #1711: a whole-token match, not `LIKE '%eeg%'` (which also matched
    // `ieeg`, and treated a `%` or `_` in the value as a wildcard). The wanted
    // tokens travel as ONE json_each parameter, so a comma list costs the same
    // single bound parameter as one value (D1's ceiling is MAX_BOUND_PARAMS)
    // and nothing here is a LIKE pattern to escape. An empty list binds `[]`
    // and matches nothing, which is what a filter that was asked for and names
    // no modality should do. More than MAX_MODALITY_FILTER_TOKENS throws.
    clauses += ` AND EXISTS (${MODALITY_TOKENS_SQL} SELECT 1 FROM modality_tokens WHERE tok IN (SELECT value FROM json_each(?)))`;
    params.push(JSON.stringify(parseModalityFilter(opts.modality)));
  }
  if (opts.author) {
    clauses += " AND LOWER(COALESCE(d.authors, '')) LIKE ?";
    params.push(`%${opts.author.toLowerCase()}%`);
  }
  if (opts.task) {
    clauses += " AND LOWER(COALESCE(d.tasks, '')) LIKE ?";
    params.push(`%${opts.task.toLowerCase()}%`);
  }
  if (opts.licenseTiers && opts.licenseTiers.length > 0) {
    // OR across tiers = IN (...). Tiers are pre-validated against LICENSE_TIERS
    // by parseLicenseTierFilter, so they're a safe, bounded placeholder list.
    // license_tier is NOT NULL (migration 0034), so no NULL branch is needed.
    const placeholders = opts.licenseTiers.map(() => "?").join(", ");
    clauses += ` AND d.license_tier IN (${placeholders})`;
    params.push(...opts.licenseTiers);
  }
  if (opts.hasDoi) {
    clauses += " AND (d.concept_doi IS NOT NULL AND d.concept_doi != '')";
  }
  if (opts.hasHed) {
    // #869: has_hed is nullable (NULL = not classified yet), so `= 1` cleanly
    // excludes both 0 (checked, no HED) and NULL. Backed by idx_datasets_has_hed.
    clauses += " AND d.has_hed = 1";
  }
  if (opts.hasZarr) {
    // #1062: zarr_status is nullable (NULL/'pending'/'failed' all excluded by
    // `= 'ready'`); COALESCE'd store_count guards a 'ready' row whose count
    // was never populated (an older converter run). Backed by the existing
    // idx_datasets_zarr_status (migration 0035/0071) -- no new index needed.
    clauses += " AND d.zarr_status = 'ready' AND COALESCE(d.zarr_store_count, 0) > 0";
  }
  if (opts.hasZarrVerified) {
    // #1068: has_zarr's predicate ANDed with the sweep's stamped verdict.
    // json_extract returns SQL NULL for a never-swept row (sweep_stamps NULL
    // or the key absent/JSON-null -- ADR 0035), which never equals the
    // string literal, so an unswept or non-'verified' row is excluded, same
    // as has_hed/has_zarr's own NULL-excludes-by-default convention.
    clauses += ` AND d.zarr_status = 'ready' AND COALESCE(d.zarr_store_count, 0) > 0 AND json_extract(d.sweep_stamps, '${ZARR_VERIFY_STATUS_PATH}') = 'verified'`;
  }
  if (opts.dataComplete) {
    // #970: same nullable-safe idiom as has_hed -- `= 1` excludes both 0
    // (checked, incomplete) and NULL (not audited yet). Backed by
    // idx_datasets_data_complete.
    clauses += " AND d.data_complete = 1";
  }
  if (opts.recent && opts.recent > 0) {
    // "Recently published" (the CLI's own --recent help), so it reads the same
    // date the newest sort orders by (#1477). Before that it was
    // COALESCE(publish_date, created_at), and managed rows leave publish_date
    // NULL (#646), so a draft made weeks before publication never counted as
    // recent. Guarded to > 0 (#1145 review S4): a negative value would build
    // `datetime('now', '--5 days')`, a malformed SQLite modifier that
    // silently matches nothing rather than erroring loudly.
    clauses += ` AND ${PUBLISHED_AT_SQL} > datetime('now', ?)`;
    params.push(`-${opts.recent} days`);
  }

  // Epic #1144 phase 3 (#1147): the declared facet table's generic walk,
  // appended after the bespoke clauses above rather than merged into them --
  // see the `facets` field doc comment on DatasetFilterOptions and ADR 0032.
  clauses += buildFacetClauses(params, opts.facets, opts.includeUnknown ?? false);

  assertBoundParamBudget(params, "dataset filter query");
  return clauses;
}

/**
 * FROM/JOIN/WHERE base for the public (non-`?mine`) `GET /datasets`
 * population. Extracted out of that handler's own `buildPublicBase()`
 * closure in epic #1144 phase 5a (#1170, D4): the facets vocabulary
 * (`dataset-facet-vocabulary.ts`) must count over EXACTLY the population an
 * anonymous caller can already list, and a hand-copied second WHERE clause
 * is exactly how the vocabulary would end up advertising a value no list
 * query can actually return. The list handler now calls this with its own
 * request-scoped `status`/`user`/`owner`; the facets endpoint calls it with
 * the literal `("active", undefined, undefined)` -- no `?status=` override,
 * no admin bypass, no `?owner=` filter, which is precisely the anonymous
 * default.
 *
 * `user` only needs `role` (not the full `AuthUser`) but takes the whole
 * shape so callers can pass `c.get("user")` directly without picking fields.
 */
export function buildPublicCatalogBase(
  status: string,
  user: AuthUser | undefined,
  owner: string | undefined,
): { from: string; params: (string | number)[] } {
  const prefixParams: (string | number)[] = [status];
  let from = `
    FROM datasets d
    LEFT JOIN users u ON d.owner_user_id = u.id
    WHERE d.status = ?
      AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL OR d.is_exemplar = 1)
  `;
  if (!user || !hasRole(user.role, "admin")) {
    from += " AND d.visibility = 'public'";
  }
  if (owner) {
    // The uploader column was dropped in #1182 (0 non-null rows in
    // production); the owning user's username is the only owner label.
    from += " AND u.username = ?";
    prefixParams.push(owner);
    // #1407: this clause matches on the REAL username, which no projection
    // can reach -- OWNER_USERNAME_SQL nulls what is returned, not what is
    // matched. An anonymous deposit is `visibility = 'public'`, so it sits
    // inside this population, and a hit with `owner_username: null` confirms
    // that this named person deposited it. Usernames are not secret; every
    // non-anonymous dataset publishes one, so the oracle needs nothing but a
    // guess. Excluded for everyone except the two callers entitled to the
    // answer: an admin (R5 -- anonymity is toward the public, never toward
    // the archive) and the depositor asking about their own datasets.
    const entitled = !!user && (hasRole(user.role, "admin") || user.username === owner);
    if (!entitled) {
      from += " AND d.anonymous = 0";
    }
  }
  return { from, params: prefixParams };
}
