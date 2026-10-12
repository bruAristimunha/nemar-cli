/**
 * Public catalog: listing with filters, hybrid search, source-id resolution,
 * and the dataset detail endpoint. GET /search must stay registered before
 * GET /:id (monolith order preserved within this file).
 *
 * Moved verbatim from routes/datasets.ts (#906, epic #902); the only
 * intentional changes are import paths and the register-function wrapper.
 */

import type { z } from "zod";
import { formatFileSize } from "../../../../shared/bytes.js";
import {
  datasetDetailEnvelopeSchema,
  datasetListEnvelopeSchema,
} from "../../../../shared/contract/dataset.js";
import { toVersionTag } from "../../../../shared/contract/index.js";
import type { FacetKey } from "../../../../shared/facets.js";
import { RangeParseError } from "../../../../shared/range.js";
import { SYSTEM_USER_ID } from "../../lib/constants";
import { parseLicenseTierFilter } from "../../lib/license";
import { optionalAuthMiddleware } from "../../middleware/auth";
import {
  OWNER_GITHUB_SQL,
  OWNER_USERNAME_SQL,
  isAnonymous,
  withheldWhileAnonymous,
} from "../../services/anonymity";
import { zarrCacheBaseUrl } from "../../services/cloudflare";
import { getFacetVocabulary } from "../../services/dataset-facet-vocabulary";
import {
  FacetEnumParseError,
  buildExcludedUnknownBreakdownSql,
  isAnyFacetActive,
  parseFacetFilters,
} from "../../services/dataset-facets";
import {
  type DatasetFilterOptions,
  ModalityTokenLimitError,
  PUBLISHED_AT_SQL,
  buildDatasetFilterClauses,
  buildPublicCatalogBase,
  escapeLikePattern,
  parseModalityFilter,
} from "../../services/dataset-filters";
import { DEFAULT_MIN_SCORE, executeDatasetSearch } from "../../services/dataset-search";
import { isValidDatasetId } from "../../services/datasetId";
import {
  ANONYMITY_CHECKED_AT_PATH,
  ANONYMITY_FINDINGS_PATH,
  ANONYMITY_STATUS_PATH,
  ANONYMITY_UNCHECKED_PATH,
  ZARR_REQUEUE_AT_PATH,
  ZARR_VERIFIED_AT_PATH,
  ZARR_VERIFY_STATUS_PATH,
} from "../../services/sweep-stamps";
import { type Bindings, hasRole } from "../../types/bindings";
import type { DatasetsRouter } from "./shared";

/**
 * Epic #1144 phase 3 (#1147), D7: every column the facet filter table binds
 * to must also be projected -- raw, un-COALESCEd so NULL stays NULL -- or a
 * user could filter on a fact they can never see the value of (the D7
 * describe block in backend/test/facet-table-correspondence.unit.test.ts
 * enforces this). One shared fragment so
 * both `GET /datasets` branches (the `?mine` shape, formerly 28 columns, and
 * the public shape, formerly 33) stay in lockstep rather than drifting apart
 * as two hand-copied column lists.
 *
 * `subject_count` and `file_size` are here for a reason worth stating,
 * because they look redundant (#1177 integration review). Both are ALSO
 * projected as `COALESCE(..., 0) AS participants` / `AS file_size`, a display
 * convention that predates this epic and that the website depends on. Phase 3
 * then made both filterable facets whose nullTest treats NULL as "unknown",
 * so `include_unknown=1` deliberately returns rows whose value was never
 * measured -- and the COALESCE rendered every one of them as a confident `0`,
 * indistinguishable from a measured zero. That is the exact "unknown reported
 * as a value" failure ADR 0005 and ADR 0032 exist to prevent, arrived at by
 * composing a pre-existing display convention with a new filter contract.
 *
 * The raw columns are additive, so the COALESCEd aliases keep working for
 * existing consumers. Do not "simplify" by dropping either half: the aliases
 * are the wire contract, these are the honest values.
 */
const FACET_PROJECTION_COLUMNS = `d.subject_count,
               d.file_size AS file_size_bytes,
               d.sessions_count,
               d.age_min,
               d.age_max,
               d.bids_version,
               d.zarr_status,
               -- Issue #1062 (epic #1181 phase 2): zarr conversion facts
               -- beyond the bare status, so a client can decide
               -- stream-versus-download without probing <id>/zarr/index.json
               -- per dataset. ADR 0034: all seven already exist as columns
               -- (migrations 0035/0046); nothing new is stored here.
               d.zarr_store_count,
               d.zarr_converted_at,
               d.zarr_source_commit,
               d.zarr_errors,
               d.zarr_failure_count,
               d.zarr_deterministic,
               d.zarr_failed_at,
               -- Issue #1068 (epic #1181 phase 8): the standing fidelity
               -- verification sweep's verdict, derived from the JSON
               -- sweep_stamps column (ADR 0034/0035 -- no new column).
               -- Null until the sweep reaches this dataset.
               json_extract(d.sweep_stamps, '${ZARR_VERIFY_STATUS_PATH}') AS zarr_verify_status,
               json_extract(d.sweep_stamps, '${ZARR_VERIFIED_AT_PATH}') AS zarr_verified_at,
               -- Issue #1409 (epic #1406): when the archive last asked for
               -- this dataset's stores to be rebuilt. Read by
               -- scripts/zarr/zarr_queue.py off this row, because the
               -- conversion queue lives in SQLite on Hallu and there was no
               -- other way for the backend to say "re-convert this one".
               -- Same derived-field pattern, same reason: no new column.
               json_extract(d.sweep_stamps, '${ZARR_REQUEUE_AT_PATH}') AS zarr_requeue_at,
               d.total_recording_duration,
               d.recording_duration_min,
               d.recording_duration_max,
               d.recording_count,
               d.recordings_unavailable,
               d.channel_count_min,
               d.channel_count_max,
               d.sampling_frequency,
               d.power_line_frequency,
               d.eeg_reference,
               d.placement_scheme`;

// Moved to services/dataset-filters.ts (#1145, epic #1144 phase 1): a service
// (dataset-search.ts) needs these too, and importing them from this route
// module would be both a circular import and a layering inversion. Re-exported
// here so the existing test files that import them from this module keep
// passing unchanged.
export { buildDatasetFilterClauses, escapeLikePattern };

/**
 * `latest_version_at`: when the dataset's newest version was released, read
 * from the newest `dataset_versions` row by `created_at`, the same ordering the
 * `latest_version` subqueries use (two rows minted in the same second share the
 * date either way). The row is recorded when the version's DOI is minted on the
 * inline publish paths, and when the manifest-ready callback arrives under the
 * central manifest flow (after the manifest is built); the admin repair path
 * backfills a missing one and stamps the repair time.
 * `datasets.updated_at` cannot stand in for it: enrichment reindex, finalize
 * and the DOI callbacks all bump it, so a catalog-wide sweep made every
 * dataset look freshly updated. Expects the `datasets` table aliased as `d`.
 * NULL when the dataset has no version row.
 */
const LATEST_VERSION_AT_SQL = `(
  SELECT dv.created_at FROM dataset_versions dv
  WHERE dv.dataset_id = d.dataset_id
  ORDER BY dv.created_at DESC
  LIMIT 1
) AS latest_version_at`;

/**
 * Emit `latest_version` in the canonical `vX.Y.Z` tag form (epic #896 #899).
 * D1's `dataset_versions.version` stores a mix of bare (`1.0.0`) and tagged
 * (`v1.0.0`) rows; the catalog plane historically forwarded them raw while the
 * data plane already normalized to the tag. Consumers that build data-plane
 * URLs from this value (hallu-sync `archives/<id>_<v>.zip` since #1491,
 * hallu-zarr) need the tag form, and the website double-prefixed a bare
 * value as `v1.0.0` but an
 * already-tagged one as `vv1.0.0`. Idempotent; leaves null untouched.
 * Exported for unit testing.
 */
export function withCanonicalLatestVersion<T extends Record<string, unknown>>(row: T): T {
  const v = row.latest_version;
  return typeof v === "string" && v ? { ...row, latest_version: toVersionTag(v) } : row;
}

/**
 * `file_size_formatted` is a contract field (shared/contract/dataset.ts) but
 * no longer a stored column (#1182): derive it from the row's `file_size` at
 * read time. MUST use `formatFileSize` from `shared/bytes.ts` -- it is the
 * one CONTRACTUAL formatter of the five that module declares (binary/1024,
 * the formatter the old write path used). The decimal/1000 outlier that
 * used to live at services/s3.ts and would silently shift every displayed
 * size is gone (epic #1225 phase 4, issue #1227): do not reintroduce a
 * second byte formatter here, add to `shared/bytes.ts` instead.
 * formatFileSize returns null for null/0/non-finite input, mirroring the
 * old writer's "nothing to display". Exported for unit testing.
 */
export function deriveFileSizeFormatted(fileSize: unknown): string | null {
  return typeof fileSize === "number" ? formatFileSize(fileSize) : null;
}

/**
 * Explode the stored `attestation` JSON (#1182, migration 0071) back into
 * the six flat attestation_* fields the detail contract declares
 * (shared/contract/dataset.ts datasetDetailSchema) — the wire shape is
 * unchanged from when they were six columns, so the CLI is unaffected. A
 * NULL/absent column means "no attestation on record" (ADR 0024) and
 * serves six nulls, exactly as six NULL columns did. Exported for unit
 * testing.
 */
export function explodeAttestationFields(raw: unknown): Record<string, unknown> {
  let parsed: Record<string, unknown> = {};
  if (typeof raw === "string" && raw) {
    try {
      const val: unknown = JSON.parse(raw);
      if (val && typeof val === "object" && !Array.isArray(val)) {
        parsed = val as Record<string, unknown>;
      }
    } catch {
      // json_valid CHECK makes this unreachable for stored rows; serve
      // six nulls rather than 500 if it ever happens.
    }
  }
  return {
    attestation_deposit_type: parsed.deposit_type ?? null,
    attestation_key_status: parsed.key_status ?? null,
    attestation_deidentified: parsed.deidentified ?? null,
    attestation_no_duplicate: parsed.no_duplicate ?? null,
    attestation_upstream_source: parsed.upstream_source ?? null,
    attestation_accepted_at: parsed.accepted_at ?? null,
  };
}

/**
 * Derived, not stored (issue #1062, epic #1181 phase 2): the absolute URL of
 * a dataset's published Zarr index, or null when there is nothing ready to
 * point at. `zarrBaseUrl` is the Zarr cache host origin (`zarrCacheBaseUrl`,
 * services/cloudflare.ts, backed by `ZARR_CACHE_BASE_URL`) -- null when that
 * env var is unset, in which case this always returns null rather than
 * emitting a relative/broken URL. Exported for unit testing.
 */
export function deriveZarrIndexUrl(
  zarrBaseUrl: string | null,
  datasetId: unknown,
  zarrStatus: unknown,
): string | null {
  if (!zarrBaseUrl || zarrStatus !== "ready") return null;
  if (typeof datasetId !== "string" || !datasetId) return null;
  // PR #1201 review, item 8: strip a trailing slash so a base carrying one
  // (zarrCacheBaseUrl already strips it, but this function's own contract
  // shouldn't rely on every caller pre-normalizing) never produces a
  // double slash -- matches zarr-catalog.ts#buildZarrCatalog's contractBase
  // normalization for the identical `<base>/<id>/zarr/index.json` shape.
  const base = zarrBaseUrl.replace(/\/+$/, "");
  return `${base}/${datasetId}/zarr/index.json`;
}

/**
 * Parse the stored `zarr_data_failures` JSON (#1191, migration 0074) into
 * the bounded summary object the contract declares,
 * instead of forwarding the raw stored string -- served only by `GET
 * /datasets/:id`'s `SELECT d.*` passthrough (list/search never project this
 * column). Defensive against a legacy ARRAY value: migration 0074 compacted
 * every existing array-shaped row in place, and every write path since
 * (#1190) writes the object shape directly, so an array should not exist any
 * more -- but this stays defensive per the issue's instruction rather than
 * trusting that invariant. An absent/null value serves null (no known
 * failures on record), matching the column's own NULL semantics -- SILENTLY,
 * since that is the expected, common case.
 *
 * A NON-EMPTY value this function cannot make sense of -- a string that
 * fails `JSON.parse`, or a value that parses/arrives as neither an object
 * nor an array (a bare number, boolean, or `null`-via-`"null"`) -- also
 * serves null (PR #1201 review, item 1: never 500 the response over one
 * dataset's malformed bookkeeping column), but is NOT silent: it is a data
 * anomaly worth an operator's attention, so it is logged at `console.error`
 * with the dataset id and a reason before returning. `datasetId` is
 * threaded in for exactly that message. Exported for unit testing.
 *
 * **Every key the writer puts in this object has to be projected here.** The
 * writer is `zarrFailureColumns` in `routes/callbacks/zarr-ready.ts`, and the
 * column is served only through this function, so a key it writes and this
 * projection drops does not exist as far as any consumer is concerned -- which
 * is what happened to `pending`/`discovered`: #1197 added them to the stored
 * summary specifically so a dataset could say "2 of 43", and the detail route
 * silently served neither. `events_upload_failed`/`manifest_upload_failed` are
 * the same shape (a sibling document the converter could not publish). The
 * contract in `shared/contract/dataset.ts` declares the object `.passthrough()`,
 * so an undeclared key it receives survives rather than being stripped -- but
 * that is a backstop, not the mechanism: a key this projection never reads is
 * never in the object to begin with. A new key still needs three edits --
 * writer, this projection, contract -- and the round-trip test in
 * `backend/test/catalog-has-zarr.test.ts` fails when one is missing.
 */
export function parseZarrDataFailures(
  raw: unknown,
  datasetId: string,
): {
  count: number;
  detail_ref: string;
  compacted_by?: string;
  pending?: number;
  discovered?: number;
  events_upload_failed?: boolean;
  manifest_upload_failed?: boolean;
} | null {
  const unparseable = (reason: string): null => {
    console.error("[catalog] zarr_data_failures unparseable, treating as none", {
      dataset_id: datasetId,
      reason,
    });
    return null;
  };

  let parsed: unknown;
  if (typeof raw === "string") {
    if (!raw) return null;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return unparseable(err instanceof Error ? err.message : String(err));
    }
  } else if (raw != null) {
    parsed = raw;
  } else {
    return null;
  }

  if (Array.isArray(parsed)) {
    return { count: parsed.length, detail_ref: "zarr/index.json" };
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const count = typeof obj.count === "number" ? obj.count : 0;
    const detail_ref = typeof obj.detail_ref === "string" ? obj.detail_ref : "zarr/index.json";
    const compacted_by = typeof obj.compacted_by === "string" ? obj.compacted_by : undefined;
    // Each optional key is projected only when the stored value has the type the
    // contract declares: a garbage `pending` is dropped rather than served, for
    // the same reason the whole object falls back to null rather than 500ing.
    const counted = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
    const pending = counted(obj.pending);
    const discovered = counted(obj.discovered);
    // Written only when true (see zarrFailureColumns), so absence means "not
    // reported as failed", which is the same reading as false.
    const events_upload_failed = obj.events_upload_failed === true ? true : undefined;
    const manifest_upload_failed = obj.manifest_upload_failed === true ? true : undefined;
    return {
      count,
      detail_ref,
      ...(compacted_by === undefined ? {} : { compacted_by }),
      ...(pending === undefined ? {} : { pending }),
      ...(discovered === undefined ? {} : { discovered }),
      ...(events_upload_failed === undefined ? {} : { events_upload_failed }),
      ...(manifest_upload_failed === undefined ? {} : { manifest_upload_failed }),
    };
  }
  return unparseable(
    `parsed value is ${parsed === null ? "null" : typeof parsed}, expected an object or array`,
  );
}

/**
 * Shared list-row shaping: canonical latest_version tag, the derived
 * file_size_formatted, and (#1062) the derived zarr_index_url. The list
 * projections previously served `COALESCE(d.file_size_formatted, '')`, so
 * the list fallback for an unmeasured/zero size stays `''` (the detail route
 * serves null instead, matching its old raw-column passthrough). Guarded on
 * `file_size` being selected so the degraded fallback query (which projects
 * neither field, nor zarr_status) passes through unchanged.
 */
function toListRow<T extends Record<string, unknown>>(
  row: T,
  zarrBaseUrl: string | null,
  // #1408: false for a public reader, so an anonymous deposit's private
  // repository and its reserved, non-resolving DOI are withheld here the same
  // way `data-router.ts` withholds them from `external_links`. True for the
  // owner's own listing and for an admin, whose tooling reads `github_repo`
  // to clone and commit -- including the commit that ends the anonymity.
  viewerMayKnowIdentifiers = false,
): T {
  const shaped = withheldWhileAnonymous(withCanonicalLatestVersion(row), viewerMayKnowIdentifiers);
  if (!("file_size" in shaped)) return shaped;
  return {
    ...shaped,
    file_size_formatted: deriveFileSizeFormatted(shaped.file_size) ?? "",
    ...("zarr_status" in shaped
      ? {
          zarr_index_url: deriveZarrIndexUrl(
            zarrBaseUrl,
            shaped.dataset_id,
            (shaped as Record<string, unknown>).zarr_status,
          ),
        }
      : {}),
  };
}

// Re-exported so existing importers keep their path; the constant itself
// now lives with executeDatasetSearch, the other consumer (#1174 review).
export { DEFAULT_MIN_SCORE };

/**
 * Clamp raw `limit`/`offset` query values for GET /datasets/search (#1145),
 * mirroring the list endpoint's clamping idiom (see the `GET /` handler
 * below) but with search's own historical default/ceiling: `limit` defaults
 * to 20 and is capped at 100 (the Vectorize candidate-window ceiling),
 * and -- new in #1145 -- `offset` is now accepted and clamped; there was no
 * offset support before, so nothing past the first 100 results was reachable.
 * Fixes two adjacent bugs: `limit=-5` used to fall through to
 * `results.slice(0, -5)` (silently dropping the last five rows) and
 * `limit=abc` produced `slice(0, NaN)` (an empty list). Exported for unit
 * testing.
 */
export function parseSearchPagination(
  limitRaw: string | undefined,
  offsetRaw: string | undefined,
): { limit: number; offset: number } {
  const rawLimit = Number.parseInt(limitRaw ?? "", 10);
  const limit = Math.min(Math.max(Number.isNaN(rawLimit) ? 20 : rawLimit, 1), 100);
  const rawOffset = Number.parseInt(offsetRaw ?? "", 10);
  const offset = Math.max(Number.isNaN(rawOffset) ? 0 : rawOffset, 0);
  return { limit, offset };
}

/** Minimal shape both `GET /datasets` and `GET /datasets/search` share --
 *  just enough of Hono's Context to read query params, so this stays
 *  testable without constructing a real Context. */
interface FilterQueryContext {
  req: { query: (name: string) => string | undefined };
}

/**
 * Parse and clamp the `min_score` query param, defaulting to
 * {@link DEFAULT_MIN_SCORE}. Exported for unit testing (#1150 D6): a test
 * pins this function's no-param result to `DEFAULT_MIN_SCORE` so a silent
 * revert to the old 0.65 fails.
 */
export function parseMinScore(c: FilterQueryContext): number {
  const minScoreParam = c.req.query("min_score");
  const parsed = minScoreParam === undefined ? Number.NaN : Number.parseFloat(minScoreParam);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, 1)) : DEFAULT_MIN_SCORE;
}

/**
 * Parse every filter query param -- the legacy bespoke filters (nine as of
 * epic #1144 phase 3, #1147, D6; has_zarr added by issue #1062;
 * has_zarr_verified added by issue #1068, epic #1181 phase 8) plus the
 * full facet table -- into one
 * `DatasetFilterOptions`, shared by both catalog endpoints so they can no
 * longer drift apart on which filters they honour. Before this, `GET
 * /datasets/search` built only `{ modality, hasHed }` and silently ignored
 * `license`, `author`, `task`, `has_doi`, `recent` and `data_complete`, which
 * the list endpoint has honoured since #646/#653/#970.
 *
 * `includeSearch: false` (the search handler's case) omits `filters.search`:
 * that handler's free text is already the `q` parameter driving FTS/semantic
 * matching, and setting both would AND the query against itself through two
 * different matchers.
 *
 * Throws {@link RangeParseError} on an invalid facet range (`shared/range.ts`),
 * `FacetEnumParseError` on an unrecognised enum token (#1165 review P1,
 * ADR 0032), or `ModalityTokenLimitError` on a `modality` value naming more
 * than `MAX_MODALITY_FILTER_TOKENS` distinct tokens (#1711); the caller is
 * expected to translate any of them into a 400. The
 * pre-existing `license` param keeps its original drop-unrecognised
 * behaviour (`parseLicenseTierFilter`) -- a deliberate asymmetry, not an
 * oversight, since it predates this table and the website already depends
 * on its current semantics.
 */
export function parseFilterQuery(
  c: FilterQueryContext,
  { includeSearch = true }: { includeSearch?: boolean } = {},
): DatasetFilterOptions {
  const hasDoi = c.req.query("has_doi") === "true";
  // #869: accept the website FilterSidebar's `has_hed=1` and a `true` for parity.
  const hasHed = c.req.query("has_hed") === "1" || c.req.query("has_hed") === "true";
  // #1062: same `1`/`true` convention as has_hed. Any other value --
  // `has_zarr=false`, `has_zarr=yes`, `has_zarr=0`, ... -- is IGNORED, same
  // as the equivalent has_hed values: only the two literal strings above
  // switch the filter on, so anything else is indistinguishable from the
  // param being absent (no filtering, not "explicitly excluded"). PR #1201
  // review, item 8: documented here because it is easy to assume `=false`
  // means "exclude zarr datasets" when it silently means "no filter".
  const hasZarr = c.req.query("has_zarr") === "1" || c.req.query("has_zarr") === "true";
  // #1068 (epic #1181 phase 8): same `1`/`true` convention as has_zarr, and
  // deliberately a SEPARATE param rather than a stricter value for
  // `has_zarr` -- see dataset-filters.ts's `hasZarrVerified` doc comment for
  // why `has_zarr`'s existing meaning must not narrow under callers already
  // relying on it.
  const hasZarrVerified =
    c.req.query("has_zarr_verified") === "1" || c.req.query("has_zarr_verified") === "true";
  // #970: same `1`/`true` convention.
  const dataComplete =
    c.req.query("data_complete") === "1" || c.req.query("data_complete") === "true";
  const recentParam = c.req.query("recent");
  const recent = recentParam ? Number.parseInt(recentParam, 10) : undefined;
  // #653: comma-separated license tiers, OR semantics. Invalid tokens are
  // dropped; an empty result means "no license filter".
  const licenseTiers = parseLicenseTierFilter(c.req.query("license"));
  // D4/ADR 0005: same `1`/`true` convention as has_hed/data_complete.
  const includeUnknownRaw = c.req.query("include_unknown");
  const includeUnknown = includeUnknownRaw === "1" || includeUnknownRaw === "true";
  const facets = parseFacetFilters((key) => c.req.query(key));
  // #1711: refuse an over-long modality list here, at the parse step, so it is
  // a 400 on both endpoints and never reaches a statement. The clause builder
  // enforces the same bound as a backstop.
  const modality = c.req.query("modality");
  if (modality) parseModalityFilter(modality);

  const filters: DatasetFilterOptions = {
    modality,
    author: c.req.query("author"),
    task: c.req.query("task"),
    hasDoi,
    hasHed,
    hasZarr,
    hasZarrVerified,
    dataComplete,
    recent,
    licenseTiers,
    facets,
    includeUnknown,
  };
  if (includeSearch) {
    filters.search = c.req.query("search");
  }
  return filters;
}

/**
 * Issue #1152: `GET /datasets`, `GET /datasets/search`, and `GET
 * /datasets/resolve/:id` require no auth, so a raw `Error#message` returned
 * as `details` on their failure paths -- table/column names, query shape,
 * occasionally file-path fragments -- reaches any anonymous caller. The full
 * message is still logged server-side via `console.error`/`console.warn`
 * immediately before each of these is returned; this constant only changes
 * what crosses the wire. Deliberately scoped to these three endpoints
 * (`catalog.ts`) per the issue -- other route files with the same `details:
 * msg` idiom are authenticated/admin contexts where the detail is actionable
 * rather than a disclosure risk, and are the issue's own stated follow-up,
 * not this fix.
 *
 * Exported so tests import the real string (backend/test/catalog-anonymous-
 * error-details.test.ts) instead of hand-copying it -- a copy would keep
 * passing if this wording ever changed underneath it.
 */
export const ANONYMOUS_ERROR_DETAILS =
  "An internal error occurred while processing this request. Please try again; if it persists, contact support.";

function buildSortClause(sort: string): string {
  switch (sort) {
    case "oldest":
      return ` ORDER BY ${PUBLISHED_AT_SQL} ASC`;
    case "name":
      return " ORDER BY d.name ASC";
    case "participants":
      return " ORDER BY participants DESC";
    case "size":
      return " ORDER BY file_size DESC";
    case "citations":
      // Most-cited first; ties fall back to newest so the order is stable (#804).
      // The total is derived from the two NOT NULL DEFAULT 0 addends (#1182);
      // there is no stored num_citations column any more.
      return ` ORDER BY (d.num_dataset_citations + d.num_datapaper_citations) DESC, ${PUBLISHED_AT_SQL} DESC`;
    default:
      return ` ORDER BY ${PUBLISHED_AT_SQL} DESC`;
  }
}

/**
 * Issue #1207: nothing parses a live catalog/detail response against the
 * shared contract schemas (`shared/contract/dataset.ts`), so a production
 * regression in a derive path ships data the contract calls invalid and
 * only surfaces when some consumer's own parse throws -- the #1206 review
 * found exactly this (`SELECT d.*` serving a numeric `id` where the schema
 * declared a string; fixed at the source in the detail route below, but
 * still the motivating example for why this hook exists). `logContractViolation`
 * is log-not-throw: a malformed response still reaches the caller unchanged
 * (ADR 0005 -- reporting is never a precondition for serving).
 *
 * Cost gate: development/test validates every response -- there, a
 * violation is a real bug worth failing loudly and immediately, and traffic
 * is low enough that the extra `safeParse` is free. Production instead
 * samples at `CONTRACT_VALIDATION_SAMPLE_RATE`: `GET /datasets` can return
 * up to 200 rows per page, so validating every production response would
 * add non-negligible CPU cost at catalog traffic volume. One sampling rate
 * applied uniformly to both routes (rather than, say, always validating the
 * single-row detail route) keeps the cost/coverage tradeoff the same for
 * both rather than special-casing one endpoint as "always cheap enough" --
 * a random check per request avoids needing shared mutable counter state
 * across Worker isolates.
 *
 * #1224 review: what is actually guaranteed is response-latency isolation,
 * not zero cost -- `shouldValidateContract`/`safeParse`/`logContractViolation`
 * is still real CPU work, just moved off the response's critical path via
 * `deferContractCheck` (below), which schedules it on `executionCtx.waitUntil`
 * the same way `afterResponse()` (routes/auth-orcid.ts) defers a best-effort
 * post-response fetch. The response is built and returned first; the check
 * runs after, and Cloudflare keeps the isolate alive just long enough for it
 * to finish. It still costs Worker CPU time (billed under `waitUntil`, per
 * Cloudflare's usual model) -- the sampling above is what keeps THAT bounded
 * in production, not the deferral, which only protects response latency.
 */
const CONTRACT_VALIDATION_SAMPLE_RATE = 0.02; // ~1 in 50 production responses

function shouldValidateContract(env: Bindings): boolean {
  if (env.ENVIRONMENT === "development" || env.ENVIRONMENT === "test") return true;
  return Math.random() < CONTRACT_VALIDATION_SAMPLE_RATE;
}

/** One bounded console.error per violating response: the route label, the
 *  dataset id(s) involved, and the first few zod issues -- enough to act on
 *  without risking an unbounded log line for a badly-shaped response. */
function logContractViolation(route: string, datasetIds: unknown, issues: z.ZodIssue[]): void {
  console.error(`[contract] ${route} response violates the shared contract`, {
    dataset_id: datasetIds,
    issues: issues
      .slice(0, 5)
      .map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });
}

/**
 * #1224 review (suggestion 4): a violation on `GET /datasets` used to log
 * every row's dataset_id on the page (up to 200), regardless of how many
 * actually failed -- noisy, and it buries "which row" in a wall of ids that
 * mostly validated fine. `datasetListEnvelopeSchema`'s zod issues for a row
 * problem always path through `datasets.<index>.<field...>`, so the row
 * index is `issue.path[1]` whenever `issue.path[0] === "datasets"`; map
 * those indices back to the row's own `dataset_id`, dedup (one bad row can
 * fail more than one field), and cap at `limit` so a badly-shaped page
 * can't blow up the log line the way the uncapped array could.
 */
function failedListRowIds(
  datasets: { dataset_id?: unknown }[],
  issues: z.ZodIssue[],
  limit = 5,
): unknown[] {
  const ids: unknown[] = [];
  const seen = new Set<unknown>();
  for (const issue of issues) {
    const [collection, index] = issue.path;
    if (collection !== "datasets" || typeof index !== "number") continue;
    const id = datasets[index]?.dataset_id;
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return ids;
}

/**
 * #1224 review: defers `check` off the response's critical path via
 * `executionCtx.waitUntil`, mirroring `afterResponse()` (routes/auth-orcid.ts)
 * -- accessing `c.executionCtx` THROWS when no ExecutionContext was provided
 * (Hono's own documented behavior for `Context#executionCtx`), which is why
 * this needs a try/catch rather than plain optional chaining: `c.executionCtx?.`
 * would still evaluate (and throw on) the getter before the `?.` ever
 * short-circuits. `p` is created unconditionally, before the try/catch, so
 * the SAME fire-and-forget microtask runs `check` even when there is no
 * ExecutionContext to hand it to (e.g. bun:test's `app.request()` called
 * without an explicit fourth `ctx` argument) -- that is what lets a test
 * still observe the log without needing one. Tests that need this
 * deterministically (rather than racing Hono's own internal await chain)
 * should instead pass an explicit `ctx` and await `Promise.allSettled` over
 * what it collected, the way `backend/test/zarr-data-cache.test.ts`'s
 * `requestWith` already does for cache-put work deferred the same way.
 */
function deferContractCheck(
  c: { executionCtx?: { waitUntil(p: Promise<unknown>): void } },
  check: () => void,
): void {
  const p = Promise.resolve().then(check);
  try {
    c.executionCtx?.waitUntil(p);
  } catch {
    void p;
  }
}

async function executeAndReturn(
  c: {
    json: (data: unknown, status?: number) => Response;
    executionCtx?: { waitUntil(p: Promise<unknown>): void };
  },
  db: D1Database,
  env: Bindings,
  baseQuery: string,
  baseParams: (string | number)[],
  pagination: { limit: number; offset: number },
  // Epic #1144 phase 3/4 (#1147/#1148), D4/D5/ADR 0005: when provided (only
  // when a facet is active), a single query over the SAME base FROM/WHERE
  // (not the row projection -- see the call sites' `*Base` helpers) that
  // computes both the widened COUNT(*) (excluded_unknown = this minus the
  // real count) and, in the same scan, a conditional-aggregation SUM per
  // active facet (excluded_unknown_by_facet). `keysInOrder[i]` names the
  // FacetKey whose count lives in the result row's `unk_<i>` column. Joins
  // the existing Promise.allSettled so a failure here can never turn a good
  // response into a 500; it just omits both fields.
  excludedUnknownQuery?: { query: string; params: (string | number)[]; keysInOrder: FacetKey[] },
  // #1408: does THIS caller get to see an anonymous deposit's private
  // repository and its reserved DOI? True for the `?mine` listing and for an
  // admin; false for the public catalog, which is what every unauthenticated
  // reader gets. Threaded in rather than derived here because this helper is
  // shared by both branches and has no view of the request's identity.
  viewerMayKnowIdentifiers = false,
) {
  const { limit, offset } = pagination;
  // #1062: computed once per request, reused for every row's derived
  // zarr_index_url (both the main result set and the degraded fallback
  // below) rather than re-reading env per row.
  const zarrBaseUrl = zarrCacheBaseUrl(env);
  try {
    const paginatedQuery = `${baseQuery} LIMIT ? OFFSET ?`;
    const countQuery = `SELECT COUNT(*) AS total FROM (${baseQuery})`;

    // Run main query, count, and (when applicable) the widened
    // excluded_unknown count in parallel; allSettled so neither the count
    // nor the excluded_unknown query can prevent returning the main results.
    //
    // The count query is wrapped in an async IIFE (not called inline) for
    // the exact reason the excluded-unknown branch below already is: a
    // SYNCHRONOUS throw from prepare()/bind()/first() would otherwise abort
    // the array literal itself -- before Promise.allSettled even runs --
    // taking the main list query's own (unrelated, unfailed) result down
    // with it. This gap had no test until epic #1144 phase 4 (#1148) added
    // one exercising a synchronously-throwing count query for GET /datasets;
    // GET /datasets/search never had the analogous bug because its count
    // query already runs inside its own try/catch (countSearchMatchesSafely),
    // not inline in an array literal. The main query is deliberately left
    // unwrapped: an unrecoverable failure there should propagate to this
    // function's outer try/catch and its own fallback/500 handling, not be
    // isolated away.
    const [mainSettled, countSettled, excludedSettled] = await Promise.allSettled([
      db
        .prepare(paginatedQuery)
        .bind(...baseParams, limit, offset)
        .all(),
      (async () =>
        db
          .prepare(countQuery)
          .bind(...baseParams)
          .first<{ total: number }>())(),
      // Wrapped in an async IIFE (not called inline) so a SYNCHRONOUS throw
      // from prepare()/bind()/first() -- e.g. a driver that validates bound
      // parameter counts immediately -- becomes a genuine promise rejection
      // Promise.allSettled can isolate, rather than throwing while this
      // array literal is still being constructed and aborting the WHOLE
      // Promise.allSettled call (which would 500 the main list too). ADR
      // 0005: excluded_unknown's own query must never be able to take the
      // primary response down with it.
      //
      // `excludedUnknownQuery.query` is already the complete, ready-to-run
      // statement (`SELECT COUNT(*) AS total, SUM(...) AS unk_0, ... FROM
      // datasets d WHERE ...`) built against the base FROM/WHERE directly --
      // D5's fix for the trap where wrapping it as `SELECT COUNT(*) FROM
      // (<projected query>)` put the SUM's nullTest expressions out of scope
      // of the raw `d.*` columns they read.
      excludedUnknownQuery
        ? (async () =>
            db
              .prepare(excludedUnknownQuery.query)
              .bind(...excludedUnknownQuery.params)
              .first<Record<string, number>>())()
        : Promise.resolve(undefined),
    ]);

    if (mainSettled.status === "rejected") {
      throw mainSettled.reason;
    }

    const result = mainSettled.value;
    if (!result?.results) {
      return c.json({ error: "Database query failed" }, 500);
    }

    let totalCount = result.results.length;
    let countSucceeded = false;
    if (countSettled.status === "fulfilled" && countSettled.value?.total != null) {
      totalCount = countSettled.value.total;
      countSucceeded = true;
    } else if (countSettled.status === "rejected") {
      console.warn(
        "[datasets] COUNT query failed, using result length:",
        countSettled.reason instanceof Error
          ? countSettled.reason.message
          : String(countSettled.reason),
      );
    }

    // Only meaningful relative to a real (non-fallback) total: if the main
    // count itself degraded to a page-derived length, diffing against the
    // widened count would report a bogus/negative-clamped number rather
    // than omitting the field (ADR 0005 -- reporting must never masquerade
    // as more certain than it is). Both fields are gated together: a
    // breakdown without a trustworthy total (or vice versa) is worse than
    // neither.
    let excludedUnknown: number | undefined;
    let excludedUnknownByFacet: Record<string, number> | undefined;
    if (excludedUnknownQuery && countSucceeded) {
      if (excludedSettled.status === "fulfilled" && excludedSettled.value?.total != null) {
        const row = excludedSettled.value;
        excludedUnknown = Math.max(0, row.total - totalCount);
        const byFacet: Record<string, number> = {};
        excludedUnknownQuery.keysInOrder.forEach((key, i) => {
          byFacet[key] = Number(row[`unk_${i}`] ?? 0);
        });
        excludedUnknownByFacet = byFacet;
      } else if (excludedSettled.status === "rejected") {
        console.warn(
          "[datasets] excluded_unknown COUNT query failed, omitting field:",
          excludedSettled.reason instanceof Error
            ? excludedSettled.reason.message
            : String(excludedSettled.reason),
        );
      }
    }

    const responseBody = {
      datasets: result.results.map((row) => toListRow(row, zarrBaseUrl, viewerMayKnowIdentifiers)),
      count: result.results.length,
      total_count: totalCount,
      limit,
      offset,
      ...(excludedUnknown !== undefined ? { excluded_unknown: excludedUnknown } : {}),
      ...(excludedUnknownByFacet !== undefined
        ? { excluded_unknown_by_facet: excludedUnknownByFacet }
        : {}),
    };

    // Issue #1207 / #1224 review: log-not-throw contract check, deferred via
    // deferContractCheck (see its doc comment) so it runs after this
    // response is already on its way out, not before. Skipped on the
    // degraded/fallback shape below (a different, known "catalog
    // unavailable" projection the contract was never meant to describe).
    deferContractCheck(c, () => {
      if (!shouldValidateContract(env)) return;
      const parsed = datasetListEnvelopeSchema.safeParse(responseBody);
      if (!parsed.success) {
        logContractViolation(
          "GET /datasets",
          failedListRowIds(responseBody.datasets, parsed.error.issues),
          parsed.error.issues,
        );
      }
    });

    return c.json(responseBody);
  } catch (dbError) {
    const msg = dbError instanceof Error ? dbError.message : String(dbError);

    // Permanent defense-in-depth net (#646): the main query no longer touches
    // nemar_catalog (dropped in Phase 6), but if any code path ever hits a
    // missing-catalog error, a missing datasets_fts (the search filter injects
    // an FTS subquery), or a missing consolidation column (this Worker deployed
    // before migrations 0029-0033 applied -- a cutover-order slip), degrade to
    // the basic datasets-only query (which selects only pre-consolidation
    // columns) instead of 500ing, matching the /datasets/search endpoint's
    // graceful degradation rather than failing the whole list.
    if (
      msg.includes("no such table: nemar_catalog") ||
      msg.includes("no such table: datasets_fts") ||
      msg.includes("no such column")
    ) {
      console.warn(
        `[datasets] missing catalog/FTS table or consolidation column (${msg}); falling back to basic query`,
      );
      try {
        const fallback = await db
          .prepare(
            `SELECT d.dataset_id, d.name, d.description, d.status, d.visibility, d.anonymous,
                    d.github_repo, d.concept_doi, d.created_at, d.updated_at,
                    ${OWNER_USERNAME_SQL},
                    -- API contract: every list entry exposes latest_version
                    -- (null when no minted DOI version yet) so callers
                    -- (e.g. scripts/hallu-sync.sh) can rely on its presence
                    -- without falling back to per-dataset /manifest calls.
                    (
                      SELECT version FROM dataset_versions dv
                      WHERE dv.dataset_id = d.dataset_id
                      ORDER BY created_at DESC
                      LIMIT 1
                    ) AS latest_version,
                    ${LATEST_VERSION_AT_SQL}
             FROM datasets d
             JOIN users u ON d.owner_user_id = u.id
             WHERE d.status = 'active' AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL OR d.is_exemplar = 1)
               AND d.visibility = 'public'
             ORDER BY d.created_at DESC LIMIT ? OFFSET ?`,
          )
          .bind(limit, offset)
          .all();
        return c.json({
          datasets: (fallback.results || []).map((row) =>
            toListRow(row, zarrBaseUrl, viewerMayKnowIdentifiers),
          ),
          count: fallback.results?.length || 0,
          total_count: fallback.results?.length || 0,
          limit,
          offset,
          fallback: true,
          warning: "Catalog not available; filters and catalog datasets not included",
        });
      } catch (fallbackErr) {
        const fallbackMsg =
          fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        // #1152: this catch had no console.error before -- the raw message was
        // only ever visible in the (also-raw) `details` field being removed here.
        console.error("Failed to query datasets (fallback):", fallbackMsg);
        return c.json(
          { error: "Failed to retrieve datasets", details: ANONYMOUS_ERROR_DETAILS },
          500,
        );
      }
    }

    console.error("Failed to query datasets:", msg);
    // #1152: anonymous callers get a generic, stable string; the real message
    // is already logged above.
    return c.json({ error: "Failed to retrieve datasets", details: ANONYMOUS_ERROR_DETAILS }, 500);
  }
}

export function registerCatalogRoutes(datasetRoutes: DatasetsRouter): void {
  /**
   * GET /datasets - List datasets (unified catalog)
   *
   * Single-table read from the `datasets` source of truth (#646). Managed and
   * folded legacy-catalog rows coexist in one table, discriminated by the
   * sentinel owner; source_type distinguishes them in the response.
   *
   * Visibility rules:
   * - --mine flag: show only the authenticated user's managed datasets (private + public + sandbox)
   * - No --mine flag (public catalog): merge managed + catalog-only datasets
   *   - Sandbox datasets are ALWAYS excluded
   *   - Unauthenticated: public datasets only
   *   - Authenticated non-admin: public datasets only
   *   - Admin: all datasets (including private managed datasets)
   *
   * Filter params: modality, author, task, has_doi, recent, sort, search, owner,
   * license, data_complete, has_hed, has_zarr, has_zarr_verified, include_unknown,
   * and the facet table
   * (epic #1144 phase 3, #1147) -- see shared/facets.ts for the full list of
   * facet query params (subjects, channels, sessions, size, files, citations,
   * duration, recording_length, recordings, unavailable, age, rate,
   * powerline, reference, placement, electrode_system, source, zarr,
   * bids_version, hed_version -- snake_case on the wire per #1165 review I3,
   * even though the four multi-word ones stay hyphenated as CLI flags).
   * Pagination: limit (1-200, default 50), offset (>= 0, default 0)
   * Response includes total_count, limit, offset for client-side pagination
   */
  datasetRoutes.get("/", optionalAuthMiddleware, async (c) => {
    // Safe Cache-Control default: every early-return error path inherits
    // no-store. The single success branch that's actually shareable
    // (anonymous browsing of the union catalog) overrides this below with
    // a `public + Vary: Authorization` block. Hono replaces same-named
    // headers, so the later set wins. Issue #639.
    c.header("Cache-Control", "no-store");
    const mine = c.req.query("mine") === "true";
    const status = c.req.query("status") || "active";
    const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
    const limit = Math.min(Math.max(Number.isNaN(rawLimit) ? 50 : rawLimit, 1), 200);
    const rawOffset = Number.parseInt(c.req.query("offset") ?? "", 10);
    const offset = Math.max(Number.isNaN(rawOffset) ? 0 : rawOffset, 0);
    const owner = c.req.query("owner");
    const user = c.get("user");
    const db = c.env.DB;

    // Epic #1144 phase 3 (#1147): every filter (the nine legacy bespoke ones
    // plus the full facet table) parsed in one place, shared with GET
    // /datasets/search below. Filters on `datasets.license_tier` etc. so
    // they cover the whole catalog, not just the page the website already
    // fetched.
    let filters: DatasetFilterOptions;
    try {
      filters = parseFilterQuery(c);
    } catch (err) {
      if (
        err instanceof RangeParseError ||
        err instanceof FacetEnumParseError ||
        err instanceof ModalityTokenLimitError
      ) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }
    const sort = c.req.query("sort") || "newest";

    if (mine) {
      // --mine: only managed datasets, no catalog
      if (!user) {
        // Distinguish "no auth header sent" from "auth header sent but token
        // invalid/expired/revoked". The latter is what trips CLI users who
        // `nemar auth login` succeeded weeks ago and then had their token
        // revoked or the backend rotated — `isAuthenticated()` is presence-only
        // so the CLI happily fires the request and the user sees a vague
        // "Authentication required" with no hint to re-login.
        // See nemarOrg/nemar-cli#447.
        const attempted = c.get("authAttempted");
        if (attempted) {
          return c.json(
            {
              error:
                "Your API key was rejected. Run 'nemar auth login' to re-authenticate, or 'nemar auth regenerate-key' if your key was revoked.",
            },
            401,
          );
        }
        return c.json({ error: "Authentication required to view your datasets" }, 401);
      }

      // Read managed facts from the `datasets` source of truth (#646). 46-column
      // ?mine wire shape (+ #869 HED has_hed/hed_version + #970 total_files/
      // data_complete/bytes_present + #1147 citations/facet columns).
      // latest_version is the most recently minted DOI version (null when
      // none); scripts/hallu-sync.sh reads it to skip the per-dataset
      // /manifest call, so keep the ordering in sync with
      // /datasets/:id/manifest.
      //
      // The FROM/JOIN/WHERE base is kept separate from the SELECT column
      // list (epic #1144 phase 4, #1148, D5): the excluded_unknown_by_facet
      // breakdown below runs its own SUM(...) query directly against this
      // base, and its nullTest expressions (e.g. `d.subject_count IS NULL`)
      // must see the raw `d` columns, not the COALESCEd/aliased projection.
      const mineBase = `
        FROM datasets d
        JOIN users u ON d.owner_user_id = u.id
        WHERE d.status = ? AND d.owner_user_id = ?
      `;
      const minePrefix = `
        SELECT d.dataset_id, d.name, d.description, d.status, d.visibility, d.anonymous,
               d.github_repo, d.concept_doi, d.created_at, d.updated_at,
               ${OWNER_USERNAME_SQL},
               d.source, d.source_id,
               COALESCE(d.modalities, '') AS modalities,
               COALESCE(d.subject_count, 0) AS participants,
               COALESCE(d.tasks, '') AS tasks,
               COALESCE(d.authors, '') AS authors,
               COALESCE(d.license, '') AS license,
               COALESCE(d.file_size, 0) AS file_size,
               -- #804: added here in #1147 -- the citations facet's value
               -- must be visible on this branch too (it was previously
               -- projected only on the public branch below). Derived from
               -- the two NOT NULL DEFAULT 0 addends (#1182); no stored
               -- num_citations column exists any more.
               (d.num_dataset_citations + d.num_datapaper_citations) AS num_citations,
               -- #854: NULL until phase 2/3 populate them; the website's channel +
               -- montage filter reads NULL as "not classified yet".
               d.n_channels,
               d.electrode_system,
               -- #869: HED presence (0/1) + HEDVersion; NULL until phase 2/3
               -- populate. Website reads NULL as "not classified yet".
               d.has_hed,
               d.hed_version,
               -- #970: honest total_files + data completeness/bytes-present; NULL
               -- until reindex/the data-integrity-sweep populate them.
               d.total_files,
               d.data_complete,
               d.bytes_present,
               -- #1477: the date the newest/oldest sort orders by (with
               -- created_at as its fallback), so a reader can see why.
               d.first_published_at,
               ${FACET_PROJECTION_COLUMNS},
               'managed' AS source_type,
               (
                 SELECT version FROM dataset_versions dv
                 WHERE dv.dataset_id = d.dataset_id
                 ORDER BY created_at DESC
                 LIMIT 1
               ) AS latest_version,
               ${LATEST_VERSION_AT_SQL}
        ${mineBase}
      `;
      const params: (string | number)[] = [status, user.id];
      let query = minePrefix;
      query += buildDatasetFilterClauses(params, filters);
      query += buildSortClause(sort);

      // D4/D5/ADR 0005: only pay for the widened breakdown query when a
      // facet is actually active -- an unfiltered ?mine list costs nothing
      // extra. #1165 review M5: wrapped in its own try/catch -- this is a
      // reporting-only extra (excluded_unknown/excluded_unknown_by_facet),
      // so a throw building it must omit both fields, not 500 the whole
      // (otherwise-good) list response the way an uncaught throw here
      // would. Dormant today (buildFacetClauses has no path that throws for
      // validated `filters`), but the primary query build above stays
      // unwrapped on purpose: without it there is no valid response to
      // return anyway.
      let excludedUnknownQuery:
        | { query: string; params: (string | number)[]; keysInOrder: FacetKey[] }
        | undefined;
      if (isAnyFacetActive(filters.facets)) {
        try {
          const widenedParams: (string | number)[] = [status, user.id];
          const widenedWhere =
            mineBase +
            buildDatasetFilterClauses(widenedParams, { ...filters, includeUnknown: true });
          const breakdown = buildExcludedUnknownBreakdownSql(filters.facets);
          excludedUnknownQuery = {
            query: `SELECT COUNT(*) AS total${breakdown.selectFragment} ${widenedWhere}`,
            params: widenedParams,
            keysInOrder: breakdown.keysInOrder,
          };
        } catch (err) {
          console.warn(
            "[datasets] failed to build excluded_unknown widened query, omitting field:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // --mine path is always authed and per-user; the no-store default
      // set at the top of the handler is the right header here. See #639
      // + the union-path Vary block below for the anonymous-shareable case.
      return executeAndReturn(
        c,
        db,
        c.env,
        query,
        params,
        { limit, offset },
        excludedUnknownQuery,
        // The `?mine` listing is scoped to the caller's own rows.
        true,
      );
    }

    // Single-table read from the `datasets` source of truth (#646). Folded legacy
    // catalog rows are first-class here, discriminated by the sentinel owner
    // (source_type='catalog'); managed datasets are source_type='managed'.
    // 50-column wire shape: the pre-consolidation UNION path + #653 `license` +
    // the #804 citation counts (num_citations / num_dataset_citations /
    // num_datapaper_citations) + #854 channel/montage (n_channels,
    // electrode_system) + #869 HED (has_hed, hed_version) + #970 honest size
    // (total_files, data_complete, bytes_present) + #1147 facet columns.
    //
    // The visibility/owner predicate is a function (not inlined once) because
    // #1147's excluded_unknown computation needs a SECOND, independently
    // parameterized copy of this exact base -- widened with
    // includeUnknown:true -- and a hand-duplicated copy would drift the two
    // out of sync with `user`/`owner` silently. Split into a FROM/JOIN/WHERE
    // base and the SELECT column list (epic #1144 phase 4, #1148, D5): the
    // excluded_unknown_by_facet breakdown runs its own SUM(...) query
    // directly against the base, and its nullTest expressions need the raw
    // `d` columns the projection's COALESCE/aliasing would otherwise hide.
    // Epic #1144 phase 5a (#1170), D4: this exact FROM/JOIN/WHERE base is
    // also what GET /datasets/facets must count over (the population an
    // anonymous caller can already list), so it now lives in
    // dataset-filters.ts and both call sites share it -- see that function's
    // doc comment. This closure just supplies the handler's own
    // request-scoped `status`/`user`/`owner`.
    const buildPublicBase = (): { from: string; params: (string | number)[] } =>
      buildPublicCatalogBase(status, user, owner);

    const buildPublicPrefix = (): { sql: string; params: (string | number)[] } => {
      const { from, params: prefixParams } = buildPublicBase();
      const sql = `
      SELECT d.dataset_id, d.dataset_id AS id, d.name, d.description, d.status, d.visibility, d.anonymous,
             d.github_repo, d.concept_doi, d.concept_doi AS doi, d.created_at, d.updated_at,
             ${OWNER_USERNAME_SQL},
             d.source, d.source_id,
             COALESCE(d.modalities, '') AS modalities,
             COALESCE(d.subject_count, 0) AS participants,
             COALESCE(d.tasks, '') AS tasks,
             COALESCE(d.authors, '') AS authors,
             COALESCE(d.license, '') AS license,
             COALESCE(d.file_size, 0) AS file_size,
             (d.num_dataset_citations + d.num_datapaper_citations) AS num_citations,
             COALESCE(d.num_dataset_citations, 0) AS num_dataset_citations,
             COALESCE(d.num_datapaper_citations, 0) AS num_datapaper_citations,
             -- #854: NULL until phase 2/3 populate them; the website's channel +
             -- montage filter reads NULL as "not classified yet".
             d.n_channels,
             d.electrode_system,
             -- #869: HED presence (0/1) + HEDVersion; NULL until phase 2/3
             -- populate. Website reads NULL as "not classified yet".
             d.has_hed,
             d.hed_version,
             -- #970: honest total_files + data completeness/bytes-present; NULL
             -- until reindex/the data-integrity-sweep populate them.
             d.total_files,
             d.data_complete,
             d.bytes_present,
             -- #1477: the date the newest/oldest sort orders by (with
             -- created_at as its fallback), so a reader can see why.
             d.first_published_at,
             ${FACET_PROJECTION_COLUMNS},
             CASE WHEN d.owner_user_id = ${SYSTEM_USER_ID} THEN 'catalog' ELSE 'managed' END AS source_type,
             (
               SELECT version FROM dataset_versions dv
               WHERE dv.dataset_id = d.dataset_id
               ORDER BY created_at DESC
               LIMIT 1
             ) AS latest_version,
             ${LATEST_VERSION_AT_SQL}
      ${from}
    `;
      return { sql, params: prefixParams };
    };

    const { sql: publicPrefix, params } = buildPublicPrefix();
    let query = publicPrefix;
    query += buildDatasetFilterClauses(params, filters);
    query += buildSortClause(sort);

    // #1165 review M5: same try/catch as the ?mine branch above -- a
    // reporting-only field must degrade on its own failure, not 500 the
    // whole list. See that branch's comment for the full rationale.
    let excludedUnknownQuery:
      | { query: string; params: (string | number)[]; keysInOrder: FacetKey[] }
      | undefined;
    if (isAnyFacetActive(filters.facets)) {
      try {
        const { from: widenedFrom, params: widenedParams } = buildPublicBase();
        const widenedWhere =
          widenedFrom +
          buildDatasetFilterClauses(widenedParams, { ...filters, includeUnknown: true });
        const breakdown = buildExcludedUnknownBreakdownSql(filters.facets);
        excludedUnknownQuery = {
          query: `SELECT COUNT(*) AS total${breakdown.selectFragment} ${widenedWhere}`,
          params: widenedParams,
          keysInOrder: breakdown.keysInOrder,
        };
      } catch (err) {
        console.warn(
          "[datasets] failed to build excluded_unknown widened query, omitting field:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // CF edge cache: anonymous list responses are identical for all callers
    // (no private rows leak — the SQL already filters visibility), so share
    // them at the edge. Authed callers may have additional visibility into
    // private rows their owner / collaborator / admin status grants, so
    // their responses stay no-store (the handler-top default). Without the
    // public branch every SSR call from the website's Worker pool hits
    // origin + decrements the per-IP rate-limit bucket; a handful of
    // concurrent visitors of ww2 then trips the cap (#639). Catalog
    // mutations are rare, so s-maxage of 5 min + SWR is plenty fresh.
    //
    // `Vary: Authorization` is required: anonymous and authed callers share
    // the same URL; without Vary an intermediate cache could serve a cached
    // anonymous response to an authed user (or vice versa). CF honors
    // `private` directives natively and won't store authed responses
    // regardless, but Vary is the RFC-correct way to tell every cache on
    // the path (corp proxies, browser cache) that the response key
    // includes the Authorization header.
    if (!user) {
      c.header("Cache-Control", "public, max-age=30, s-maxage=300, stale-while-revalidate=600");
      c.header("Vary", "Authorization");
    }
    return executeAndReturn(
      c,
      db,
      c.env,
      query,
      params,
      { limit, offset },
      excludedUnknownQuery,
      // The public catalog. Only an admin sees a concealed deposit's
      // repository and reserved DOI here.
      hasRole(user?.role, "admin"),
    );
  });

  /**
   * GET /datasets/search - Semantic dataset search
   *
   * Combines exact dataset-ID lookup, Vectorize semantic similarity (when
   * bindings are configured), and D1 FTS5 text search -- see
   * `executeDatasetSearch` in dataset-search.ts for the tier logic, `count`
   * semantics, and pagination. This handler only parses query-string params
   * and translates a thrown error into a 500 (extracted in #1145, epic #1144
   * phase 1, so the orchestration -- the thing the count-drifts-with-page-
   * size bug actually lived in -- is directly unit-testable without the
   * Worker runtime).
   *
   * Epic #1144 phase 3 (#1147), D6: filters now come from the SAME
   * `parseFilterQuery` the list endpoint uses, closing a gap where this
   * handler built only `{ modality, hasHed }` and silently ignored
   * `license`, `author`, `task`, `has_doi`, `recent`, `data_complete`, and
   * every facet -- filters the list endpoint has honoured since
   * #646/#653/#970. `includeSearch: false` because this handler's free text
   * is already `q`, driving FTS/semantic matching; setting `filters.search`
   * too would AND the query against itself through a second matcher.
   */
  datasetRoutes.get("/search", optionalAuthMiddleware, async (c) => {
    // Safe Cache-Control default, set BEFORE any early return like every other
    // handler in this file: the missing-`q` 400, a bad-filter 400 (an invalid
    // range or enum, or a `modality` list over the token limit) and the 500
    // all inherit no-store. This handler used to send no Cache-Control at all,
    // so its 400s could be cached by a shared cache while the same 400s on
    // GET /datasets were not.
    c.header("Cache-Control", "no-store");
    const query = c.req.query("q");
    if (!query) {
      return c.json({ error: "Search query parameter 'q' is required" }, 400);
    }

    const { limit, offset } = parseSearchPagination(c.req.query("limit"), c.req.query("offset"));
    let filters: DatasetFilterOptions;
    try {
      filters = parseFilterQuery(c, { includeSearch: false });
    } catch (err) {
      if (
        err instanceof RangeParseError ||
        err instanceof FacetEnumParseError ||
        err instanceof ModalityTokenLimitError
      ) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    const minScore = parseMinScore(c);

    try {
      const envelope = await executeDatasetSearch(c.env.DB, c.env.AI, c.env.VECTORIZE, {
        query,
        filters,
        limit,
        offset,
        minScore,
      });
      return c.json(envelope);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Dataset search failed:", msg);
      // #1152: anonymous callers get a generic, stable string; the real
      // message is already logged above.
      return c.json({ error: "Search failed", details: ANONYMOUS_ERROR_DETAILS }, 500);
    }
  });

  /**
   * GET /datasets/facets - Facet vocabulary with counts (epic #1144 phase 5a,
   * #1170, D1). Lets the CLI validate/autocomplete values like `--task`
   * (1040 distinct labels) or `--electrode-system` (six values nobody has
   * written down outside the source) against what the catalog actually
   * contains, instead of accepting free text blind.
   *
   * MUST be registered before `GET /:id` below: this file already carries
   * one warning about that trap (`GET /search` above), and a literal path
   * segment registered AFTER a `:id` param route is shadowed by it -- every
   * request to `/facets` would instead hit the `:id` handler, fail
   * `isValidDatasetId("facets")` -- a synchronous regex check, so it returns
   * 400 there and never reaches that handler's later not-found branch.
   * This is the SECOND instance of the same trap in this file.
   *
   * Response shape (D2): most keys are a `{ value, count }[]` vocabulary;
   * `task` alone carries `{ values, distinct_total, truncated }` since a
   * truncated list that looks complete is the exact failure mode this
   * endpoint exists to prevent for its 1040 real values. A key is ABSENT
   * (not `[]`) when its underlying query failed (D5/ADR 0005) -- `warning`
   * is set only then; see dataset-facet-vocabulary.ts for the full policy.
   */
  datasetRoutes.get("/facets", async (c) => {
    // Safe default, matching every other handler in this file: an error
    // path (there is none today, since getFacetVocabulary never throws --
    // see its own doc comment) would inherit no-store rather than being
    // cached at the edge by accident.
    c.header("Cache-Control", "no-store");
    const db = c.env.DB;
    const { vocabulary, warning } = await getFacetVocabulary(db);

    if (!warning) {
      // D4: this response is identical for every caller -- no user-scoped
      // branching, no query params, nothing auth-dependent changes the
      // answer -- so it takes the same edge-cache header the resolve and
      // detail endpoints use. Unlike those two (and the list endpoint),
      // there is no `Vary: Authorization` here: this handler never reads
      // `c.get("user")` and the SQL never branches on auth, so there is no
      // auth-dependent cache key to separate in the first place -- not
      // "the same reasoning as the list endpoint", a different one. A
      // degraded (warning-carrying) response is left at the no-store
      // default above rather than cached for the full 5-minute s-maxage
      // window, so a transient query failure doesn't get pinned at the edge.
      c.header("Cache-Control", "public, max-age=30, s-maxage=300, stale-while-revalidate=600");
    }

    return c.json({ ...vocabulary, ...(warning ? { warning } : {}) });
  });

  /**
   * GET /datasets/resolve/:sourceId - Resolve an OpenNeuro source ID to its NEMAR counterpart
   *
   * Returns the NEMAR dataset_id if a dataset was imported from the given source_id.
   * Used by the CLI to redirect ds###### downloads to the NEMAR backend when available.
   * Returns { found: true, ... } on match, or { found: false } when no match exists.
   * Always returns 200 (except on validation or server errors).
   */
  datasetRoutes.get("/resolve/:sourceId", optionalAuthMiddleware, async (c) => {
    // Safe default: validation 400s + the catch's 500 emit no-store. The
    // success branch below overrides for the resolved-match case only —
    // an unresolved `{ found: false }` doesn't get cached either, because
    // a dataset could publish moments later and we don't want CF to keep
    // serving the negative answer through the s-maxage + SWR window.
    c.header("Cache-Control", "no-store");
    const sourceId = c.req.param("sourceId");

    if (!/^ds\d{6}$/.test(sourceId)) {
      return c.json({ error: "Invalid source ID format. Expected ds followed by 6 digits." }, 400);
    }

    const db = c.env.DB;

    try {
      const match = await db
        .prepare(
          `SELECT d.dataset_id, d.name, d.github_repo, ${OWNER_USERNAME_SQL}
           FROM datasets d
           JOIN users u ON d.owner_user_id = u.id
           WHERE d.source_id = ? AND d.status = 'active' AND d.visibility = 'public'
           LIMIT 1`,
        )
        .bind(sourceId)
        .first<{
          dataset_id: string;
          name: string;
          github_repo: string | null;
          // Null for an anonymous deposit -- OWNER_USERNAME_SQL withholds it.
          owner_username: string | null;
        }>();

      if (!match) {
        // Negative result stays no-store (handler default). A dataset
        // could publish moments later; CF holding `found: false` for the
        // s-maxage window would mask that for everyone.
        return c.json({ found: false });
      }

      // CF edge cache: the query is restricted to `visibility = 'public'`
      // and `status = 'active'`, so the response is identical for any
      // caller regardless of auth — safe to share at the edge. The
      // canonical-resolve mapping changes only when a dataset is
      // re-published, which is rare; s-maxage of 5 min + SWR is plenty.
      // Issue #639.
      c.header("Cache-Control", "public, max-age=30, s-maxage=300, stale-while-revalidate=600");
      return c.json({
        found: true,
        dataset_id: match.dataset_id,
        name: match.name,
        github_repo: match.github_repo,
        owner_username: match.owner_username,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[resolve] Failed to resolve source_id ${sourceId}:`, msg);
      // #1152: anonymous callers get a generic, stable string; the real
      // message is already logged above.
      return c.json({ error: "Failed to resolve dataset", details: ANONYMOUS_ERROR_DETAILS }, 500);
    }
  });

  /**
   * GET /datasets/:id - Get dataset details
   *
   * Visibility rules:
   * - Public datasets: accessible to everyone
   * - Private datasets: accessible to owner, admin, or collaborator
   */
  datasetRoutes.get("/:id", optionalAuthMiddleware, async (c) => {
    // Safe Cache-Control default: every early-return error path (400 /
    // 404 / 401) inherits no-store. The anonymous-success branch overrides
    // below with `public + Vary: Authorization`. Hono replaces same-named
    // headers, so the later set wins. Issue #639.
    c.header("Cache-Control", "no-store");
    const datasetId = c.req.param("id");
    const user = c.get("user");
    const db = c.env.DB;

    if (!isValidDatasetId(datasetId)) {
      return c.json({ error: "Invalid dataset ID format" }, 400);
    }

    const dataset = await db
      .prepare(
        `
      SELECT
        d.*,
        -- Contract parity with the list endpoints (#853): expose subject_count
        -- under its API name and compute latest_version, which aren't raw
        -- columns. Kept ALONGSIDE d.* so existing consumers of the raw
        -- subject_count column are unaffected (additive, no regression).
        COALESCE(d.subject_count, 0) AS participants,
        -- num_citations is a contract field (shared/contract/dataset.ts) but
        -- no longer a stored column (#1182): serve the sum of the two
        -- NOT NULL DEFAULT 0 addends.
        (d.num_dataset_citations + d.num_datapaper_citations) AS num_citations,
        (
          SELECT version FROM dataset_versions dv
          WHERE dv.dataset_id = d.dataset_id
          ORDER BY created_at DESC
          LIMIT 1
        ) AS latest_version,
        ${LATEST_VERSION_AT_SQL},
        -- Issue #1068 (epic #1181 phase 8): same derivation as the list
        -- projection above (FACET_PROJECTION_COLUMNS) -- d.* alone does not
        -- surface a json_extract expression.
        json_extract(d.sweep_stamps, '${ZARR_VERIFY_STATUS_PATH}') AS zarr_verify_status,
        json_extract(d.sweep_stamps, '${ZARR_VERIFIED_AT_PATH}') AS zarr_verified_at,
        -- #1409: the anonymity verdict, so the depositor can read back what the
        -- sweep found without waiting for mail they may have deleted. Withheld
        -- from everyone but the owner and an admin below, because "this deposit
        -- has findings" is itself information about the concealed person.
        json_extract(d.sweep_stamps, '${ANONYMITY_STATUS_PATH}') AS anonymity_status,
        json_extract(d.sweep_stamps, '${ANONYMITY_CHECKED_AT_PATH}') AS anonymity_checked_at,
        json_extract(d.sweep_stamps, '${ANONYMITY_FINDINGS_PATH}') AS anonymity_findings,
        json_extract(d.sweep_stamps, '${ANONYMITY_UNCHECKED_PATH}') AS anonymity_unchecked,
        ${OWNER_USERNAME_SQL},
        ${OWNER_GITHUB_SQL}
      FROM datasets d
      JOIN users u ON d.owner_user_id = u.id
      WHERE d.dataset_id = ?
    `,
      )
      .bind(datasetId)
      // `d.*` carries every column, but the row type has to SAY it carries
      // `anonymous`: `isAnonymous` requires the field so that a projection
      // which stops selecting it is a compile error rather than a silent "not
      // anonymous" (#1408).
      .first<Record<string, unknown> & { anonymous: number | null }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    // Enforce visibility restrictions for private datasets
    if (dataset.visibility !== "public") {
      if (!user || (!hasRole(user.role, "admin") && user.id !== dataset.owner_user_id)) {
        // Check if user is a collaborator before returning 404
        const isCollaborator = user
          ? await db
              .prepare(
                "SELECT 1 FROM dataset_collaborators dc JOIN datasets d ON dc.dataset_id = d.id WHERE d.dataset_id = ? AND dc.user_id = ?",
              )
              .bind(datasetId, user.id)
              .first()
          : null;
        if (!isCollaborator) {
          // If the caller sent a Bearer token that was rejected, give a
          // re-login hint instead of "Dataset not found" — same bug class
          // as nemarOrg/nemar-cli#447 but for the single-dataset route.
          if (!user && c.get("authAttempted")) {
            return c.json(
              {
                error:
                  "Your API key was rejected. Run 'nemar auth login' to re-authenticate, or 'nemar auth regenerate-key' if your key was revoked.",
              },
              401,
            );
          }
          return c.json({ error: "Dataset not found" }, 404);
        }
      }
    }

    // CF edge cache only for anonymous traffic. Authed responses may
    // include private datasets that this user can see (owner, collaborator,
    // admin) — they stay no-store (the handler default). `Vary: Authorization`
    // tells intermediate caches the response key depends on the auth
    // header, so an anonymous cached response is never served to an authed
    // caller and vice versa. See the list handler (GET /) above for the
    // matching pattern + the Worker-egress-IP-pooling rationale (#639).
    if (!user) {
      c.header("Cache-Control", "public, max-age=30, s-maxage=300, stale-while-revalidate=600");
      c.header("Vary", "Authorization");
    }
    // Detail keeps the old raw-column shape for file_size_formatted: a
    // string when file_size is measured and positive, null otherwise (the
    // list branches coalesce to '' instead — see toListRow). The stored
    // attestation JSON is dropped from the payload and served as the six
    // flat contract fields instead (wire shape unchanged from the
    // six-column era). #1191: zarr_data_failures is likewise dropped as a
    // raw string and re-served as the parsed {count, detail_ref} object.
    const {
      attestation: attestationRaw,
      zarr_data_failures: zarrDataFailuresRaw,
      owner_user_id: ownerUserIdRaw,
      ...rest
    } = withCanonicalLatestVersion(dataset as Record<string, unknown>);
    const detail = {
      ...rest,
      // #1407: `SELECT d.*` carries the raw owner FK, which OWNER_USERNAME_SQL
      // cannot reach. Left in place it would de-anonymize a deposit in one
      // request -- fetch the anonymous dataset's owner_user_id, then find any
      // other public dataset with the same value and read its disclosed
      // owner_username -- and it is a stable pseudonymous handle linking a
      // depositor's several anonymous deposits to each other even when there
      // is no second dataset to join against. It is not in the contract
      // (shared/contract/dataset.ts), so it is withheld rather than nulled for
      // anonymous rows only: nothing declares a use for it.
      owner_user_id: isAnonymous(dataset) ? null : ownerUserIdRaw,
      // #1419 release review: the same `SELECT d.*` trap, one column over.
      // The anonymity sweep writes its verdict ONLY into `sweep_stamps`
      // (`ANONYMITY_SWEEP_STAMP_SQL`), and the four flat `anonymity_*` fields
      // below are aliases read back out of it. Nulling the aliases for a
      // viewer who may not know the identifiers -- which the block at the end
      // of this function does, deliberately -- left the raw column beside
      // them carrying the same values, so a public reader of an anonymous
      // deposit could learn that the concealment is leaking AND which file to
      // fetch to break it (`check` + `file`, in prose addressed to the
      // depositor). This release is also what makes that file publicly
      // fetchable. Withheld rather than nulled, for everyone: the column is
      // not in the contract (`shared/contract/dataset.ts`, zero hits in
      // `shared/openapi.json`), the flat fields are the declared surface, and
      // an operator who needs the stamps reads them through the admin routes.
      sweep_stamps: undefined,
      // ADR 0077: the same `SELECT d.*` trap again. `data_papers` is served
      // parsed, as a key of `data.nemar.org/<id>/metadata.json`; the raw JSON
      // text is not in the contract (`shared/contract/dataset.ts`, zero hits in
      // `shared/openapi.json`), so it is withheld here rather than leaked as a
      // string beside the declared fields.
      data_papers: undefined,
      // #1207 review: `SELECT d.*` serves the raw numeric primary key here,
      // but the contract (shared/contract/dataset.ts) declares `id: string`
      // -- the list route's `id` is `d.dataset_id AS id`, already a string
      // (see catalogItemObjectSchema's comment on the two `id` shapes).
      // Stringify at the source rather than leaving every consumer --
      // including this route's own contract-validation hook below -- to
      // special-case the detail route's `id`. `rest.id` is always present
      // (the NOT NULL integer primary key); String(undefined) is never
      // reachable here.
      id: String((rest as Record<string, unknown>).id),
      file_size_formatted: deriveFileSizeFormatted(dataset.file_size),
      zarr_data_failures: parseZarrDataFailures(zarrDataFailuresRaw, dataset.dataset_id as string),
      // #1062: derived from the raw zarr_status this SELECT d.* already
      // carries -- same helper the list rows use (toListRow).
      zarr_index_url: deriveZarrIndexUrl(
        zarrCacheBaseUrl(c.env),
        dataset.dataset_id,
        dataset.zarr_status,
      ),
      ...explodeAttestationFields(attestationRaw),
    };

    // Issue #1207 / #1224 review: same log-not-throw contract check as GET
    // /datasets, deferred via deferContractCheck (see its doc comment) so
    // it runs after this response is already on its way out.
    deferContractCheck(c, () => {
      if (!shouldValidateContract(c.env)) return;
      const parsed = datasetDetailEnvelopeSchema.safeParse({ dataset: detail });
      if (!parsed.success) {
        logContractViolation("GET /datasets/:id", datasetId, parsed.error.issues);
      }
    });

    // #1408: the same withholding the list rows and the data plane apply --
    // a concealed deposit's repository is private and its DOI is reserved, so
    // neither is offered to a reader who is not its owner or an admin. Applied
    // LAST, over the assembled payload, because `SELECT d.*` puts both columns
    // into `rest` without either being named anywhere above.
    const viewerMayKnowIdentifiers = Boolean(
      user && (hasRole(user.role, "admin") || user.id === dataset.owner_user_id),
    );
    // The verdict rides the same gate as the identifiers: a reader who may not
    // know WHO deposited this must not be told that the concealment is leaking.
    const shaped: Record<string, unknown> = {
      ...withheldWhileAnonymous(detail, viewerMayKnowIdentifiers),
    };
    if (!viewerMayKnowIdentifiers) {
      shaped.anonymity_status = null;
      shaped.anonymity_checked_at = null;
      shaped.anonymity_findings = null;
      shaped.anonymity_unchecked = null;
    }
    return c.json({ dataset: shaped });
  });
}
