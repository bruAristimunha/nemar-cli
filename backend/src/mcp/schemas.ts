/**
 * zod 4 registration mirrors of the phase 2 tool schemas (epic #1065 phase
 * 2, issue #1294; `.context/mcp-server-design.md` section 12's "tool
 * registration under the two-copy zod split").
 *
 * `registerTool` in `@modelcontextprotocol/server@2.0.0` takes a Standard
 * Schema that also emits JSON Schema (`~standard.jsonSchema`), which zod 4
 * implements and the repo's zod 3.25.76 does not (checked in phase 1:
 * `node_modules/zod/v4/core/standard-schema.d.ts` has no `jsonSchema`
 * member). So the zod 3 schemas in `shared/contract/mcp.ts` stay the WIRE
 * CONTRACT and the test oracle -- everything outside this SDK boundary
 * (route logic, tool implementations, output validation) parses against
 * them, unchanged. These are mirrors ONLY: same field names, defaults,
 * caps and regexes, built against the `zod4` npm alias
 * (`"zod4": "npm:zod@^4.2.0"`, resolved via Bun without touching the
 * repo-wide `zod` pin) so `registerTool` gets a schema shape it can convert
 * to JSON Schema. `backend/test/mcp-schema-parity.test.ts` is the drift
 * test: it runs the same input table through both copies and asserts
 * identical accept/reject verdicts and identical parsed values, done by
 * behavior rather than by comparing two JSON Schema generators' output.
 *
 * Every field carries `.describe()` so the JSON Schema `tools/list` and
 * `server/discover` publish teaches the calling agent what the field means,
 * not just its type.
 */

import * as z4 from "zod4";
import {
  GET_EVENTS_DEFAULT_LIMIT,
  GET_EVENTS_MAX_COLUMNS,
  GET_EVENTS_MAX_LIMIT,
  GET_EVENTS_MAX_WHERE_COLUMNS,
  GET_EVENTS_MAX_WHERE_VALUES,
  GET_EVENTS_SUMMARY_MAX_VALUES,
  GET_EVENTS_SUMMARY_MAX_VALUE_CHARS,
  LIST_RECORDINGS_DEFAULT_LIMIT,
  LIST_RECORDINGS_MAX_LIMIT,
  NEXT_CHEAPEST_TOOL_VALUES,
  READ_WINDOW_TASTE_MAX_CHANNELS,
  READ_WINDOW_TASTE_MAX_CHANNEL_SECONDS,
  READ_WINDOW_TASTE_MAX_DURATION_S,
  RECIPE_SANITY_MAX_CHANNELS,
  RECIPE_SANITY_MAX_DURATION_S,
  RENDER_OVERVIEW_DEFAULT_WIDTH_PX,
  RENDER_OVERVIEW_MAX_WIDTH_PX,
  SEARCH_DATASETS_DEFAULT_LIMIT,
  SEARCH_DATASETS_MAX_LIMIT,
  ZARR_STATUS_VALUES,
  ZARR_VERIFY_STATUS_VALUES,
} from "../../../shared/contract/mcp.js";
import { DATASET_ID_RE, SOURCE_COMMIT_RE } from "../../../shared/contract/zarr-index.js";
import { FACETS, describeFacet } from "../../../shared/facets.js";

const DATASET_ID_DESCRIPTION =
  "NEMAR dataset id: two lowercase letters (nm/on/xx) followed by six digits, e.g. nm000132 (ERP CORE).";

// ---------------------------------------------------------------------------
// search_datasets
// ---------------------------------------------------------------------------
// SEARCH_DATASETS_DEFAULT_LIMIT / SEARCH_DATASETS_MAX_LIMIT are imported from
// the zod 3 wire contract above, not redefined here -- a mirror must never
// own a number the contract already owns (the parity test would still catch
// a silent drift, but there is no reason to give it something to catch).

/**
 * The declared facets, as described string parameters keyed by wire name.
 *
 * Generated from `shared/facets.ts`, exactly like the zod 3 contract's
 * `facetInputShape`, because THIS is the schema the model reads: `registerTool`
 * advertises it, so a facet missing here is a filter the assistant does not know
 * exists. Hand-maintaining the list is what let the NEMAR prompt drift onto
 * `modality_filter`, a parameter nothing declared, which `.passthrough()` then
 * accepted and dropped.
 *
 * The description is built from the facet's own `label`, `unit` and
 * `enumValues`, so the wording a caller sees comes from the same declaration as
 * the filter itself (ADR 0032).
 */
const facetInputShape4 = Object.fromEntries(
  FACETS.map((facet) => [facet.queryParam, z4.string().optional().describe(describeFacet(facet))]),
);

export const searchDatasetsInputSchema4 = z4
  .object({
    query: z4
      .string()
      .optional()
      .describe(
        "Free-text search over dataset name, description, authors, tasks and modalities. " +
          "Omit to browse the public catalog instead (a plain, filtered list).",
      ),
    modality: z4
      .string()
      .optional()
      .describe("Filter to datasets whose modalities include this substring (e.g. 'eeg', 'meg')."),
    task: z4.string().optional().describe("Filter to datasets whose tasks include this substring."),
    has_hed: z4
      .boolean()
      .optional()
      .describe("Filter to datasets with HED (Hierarchical Event Descriptors) annotations."),
    has_zarr: z4
      .boolean()
      .optional()
      .describe(
        "Filter to datasets with a converted Zarr serving copy (has_zarr means converted, " +
          "never fidelity-verified -- see describe_dataset's zarr_verify_status for that).",
      ),
    author: z4
      .string()
      .optional()
      .describe("Filter to datasets one of whose authors matches this name."),
    has_doi: z4
      .boolean()
      .optional()
      .describe("Filter to datasets that carry a DOI, i.e. the citable ones."),
    has_zarr_verified: z4
      .boolean()
      .optional()
      .describe(
        "Filter to datasets whose Zarr copy PASSED the standing fidelity sweep. A strict " +
          "narrowing of has_zarr: a fresh conversion is has_zarr until the sweep reaches it.",
      ),
    data_complete: z4
      .boolean()
      .optional()
      .describe(
        "Filter to datasets verified to hold all of their declared content, each file stored " +
          "whole or as a complete chunk set.",
      ),
    recent: z4
      .number()
      .int()
      .positive()
      .optional()
      .describe("Filter to datasets published within this many days."),
    license: z4
      .string()
      .optional()
      .describe(
        "Comma-separated license tiers: public, attribution, sharealike, noncommercial, " +
          "noderiv, unknown. Unrecognized tokens are dropped.",
      ),
    include_unknown: z4
      .boolean()
      .optional()
      .describe(
        "Widen every ACTIVE facet filter to also admit datasets whose value is unknown. " +
          "Several facet columns are only partly populated, so a filter's recall can be low " +
          "because the data is missing rather than because it did not match.",
      ),
    ...facetInputShape4,
    limit: z4
      .number()
      .int()
      .positive()
      .max(SEARCH_DATASETS_MAX_LIMIT)
      .default(SEARCH_DATASETS_DEFAULT_LIMIT)
      .describe(
        `Maximum number of results to return (default ${SEARCH_DATASETS_DEFAULT_LIMIT}, capped at ${SEARCH_DATASETS_MAX_LIMIT}).`,
      ),
  })
  .passthrough();

const searchDatasetsHitSchema4 = z4
  .object({
    dataset_id: z4.string().regex(DATASET_ID_RE).describe(DATASET_ID_DESCRIPTION),
    name: z4.string().describe("Dataset title."),
    doi: z4
      .string()
      .nullable()
      .optional()
      .describe("Concept DOI, or null when none has been minted."),
    license: z4
      .string()
      .nullable()
      .optional()
      .describe("SPDX-ish license identifier, or null when unset."),
    modalities: z4.array(z4.string()).optional().describe("Recorded modalities (e.g. ['eeg'])."),
    tasks: z4.array(z4.string()).optional().describe("Task names present in the dataset."),
    subject_count: z4
      .number()
      .int()
      .nullable()
      .optional()
      .describe("Number of subjects, when known."),
    has_hed: z4
      .boolean()
      .nullable()
      .optional()
      .describe("Whether the dataset carries HED annotations; null when not yet classified."),
    has_zarr: z4
      .boolean()
      .describe(
        "Whether this dataset has a converted Zarr serving copy (converted, not necessarily verified).",
      ),
  })
  .passthrough();

export const searchDatasetsOutputSchema4 = z4
  .object({
    results: z4.array(searchDatasetsHitSchema4).describe("The page of matching dataset rows."),
    count: z4
      .number()
      .int()
      .nonnegative()
      .describe("Total number of matching datasets (not just this page)."),
    limit: z4.number().int().describe("The limit this response was paged against."),
    note: z4
      .string()
      .nullable()
      .optional()
      .describe("A caveat to surface verbatim, e.g. a degraded search index or an unresolved hit."),
    truncated: z4
      .boolean()
      .optional()
      .describe("True when more rows matched than this response's candidate window could return."),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// describe_dataset
// ---------------------------------------------------------------------------

export const describeDatasetInputSchema4 = z4
  .object({
    dataset_id: z4.string().regex(DATASET_ID_RE).describe(DATASET_ID_DESCRIPTION),
  })
  .passthrough();

const describeDatasetCostHintSchema4 = z4
  .object({
    next_cheapest_tool: z4
      .enum(NEXT_CHEAPEST_TOOL_VALUES)
      .describe("The cheapest tool to call next for more detail on this dataset."),
    reason: z4
      .string()
      .describe("Why that tool is the suggested next step (states the Zarr status)."),
  })
  .passthrough();

export const describeDatasetOutputSchema4 = z4
  .object({
    dataset_id: z4.string().regex(DATASET_ID_RE).describe(DATASET_ID_DESCRIPTION),
    name: z4.string().describe("Dataset title."),
    doi: z4.string().nullable().describe("Concept DOI, or null when none has been minted."),
    license: z4.string().nullable().describe("SPDX-ish license identifier, or null when unset."),
    citation: z4
      .string()
      .nullable()
      .describe("A ready-to-paste citation string, or null when the row lacks a name."),
    modalities: z4.array(z4.string()).optional().describe("Recorded modalities (e.g. ['eeg'])."),
    tasks: z4.array(z4.string()).optional().describe("Task names present in the dataset."),
    subject_count: z4
      .number()
      .int()
      .nullable()
      .optional()
      .describe("Number of subjects, when known."),
    has_hed: z4
      .boolean()
      .nullable()
      .optional()
      .describe("Whether the dataset carries HED annotations; null when not yet classified."),
    hed_version: z4.string().nullable().optional().describe("HED schema version, when known."),
    recording_count: z4
      .number()
      .int()
      .nullable()
      .optional()
      .describe("Number of recordings in the dataset."),
    total_recording_duration_s: z4
      .number()
      .nullable()
      .optional()
      .describe("Total recording duration across the dataset, in seconds."),
    zarr_status: z4
      .enum(ZARR_STATUS_VALUES)
      .nullable()
      .optional()
      .describe("Zarr conversion status: pending (not yet converted), ready, or failed."),
    zarr_verify_status: z4
      .enum(ZARR_VERIFY_STATUS_VALUES)
      .nullable()
      .optional()
      .describe(
        "The standing fidelity sweep's verdict for this dataset's Zarr copy. Null until the " +
          "daily sweep reaches a freshly-converted dataset; never a filter default.",
      ),
    zarr_source_commit: z4
      .string()
      .nullable()
      .optional()
      .describe("The commit the zarr_status/zarr_verify_status verdict was reached against."),
    zarr_store_count: z4
      .number()
      .int()
      .nullable()
      .optional()
      .describe("Number of converted Zarr stores backing zarr_status."),
    cost_hint: describeDatasetCostHintSchema4.describe("What to call next, and why."),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Provenance envelope (epic #1065 phase 3, issue #1295) -- nested inside the
// three recording-level tools' output schemas below, so it needs its own
// mirror even though it is never a top-level registerTool schema itself.
// ---------------------------------------------------------------------------

const zarrSssSchema4 = z4
  .object({
    applied: z4.boolean().optional(),
    method: z4.string().optional(),
    calibration: z4.string().optional(),
    cross_talk: z4.string().optional(),
    mne_version: z4.string().optional(),
  })
  .passthrough()
  .describe("ADR 0028 Signal-Space Separation record; present exactly when derived is true.");

const zarrUnitsReportSchema4 = z4
  .object({
    converted: z4.number().int().nonnegative().optional(),
    relabelled: z4.number().int().nonnegative().optional(),
    kept_importer_unit: z4.number().int().nonnegative().optional(),
    units_column_present: z4.boolean().optional(),
    sidecar: z4.string().optional(),
    sidecar_supplied: z4.boolean().optional(),
    unmatched_channels: z4
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Store channels no channels.tsv row reached, so they kept the importer's type and unit. A row reaches the channel it names exactly and, from biosigio 1.2.10, the one channel it names in another letter case when that is unambiguous (counted in matched_case_only). 0 means every channel met a row. Absent when there was no join: no store labels, no name column in the sidecar, or no units_report at all.",
      ),
    unmatched_case_only: z4
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Of unmatched_channels, those a row names in a different letter case but that were not matched: converted before biosigio 1.2.10 (exact matching), or the case-insensitive match was ambiguous.",
      ),
    matched_case_only: z4
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Store channels a channels.tsv row reached only by ignoring letter case (biosigio 1.2.10 and later); the sidecar's type and unit were applied, converting a unit that differed from the file's.",
      ),
    matched_case_only_examples: z4
      .array(z4.string())
      .max(5)
      .optional()
      .describe(
        "Up to five of the matched_case_only matches, as '<channels.tsv name> -> <store label>'.",
      ),
    unmatched_raw_label: z4
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Of unmatched_channels, those the store de-duplicated (T8-P8 -> T8-P8-0) while channels.tsv names the file's repeated label.",
      ),
    unmatched_examples: z4
      .array(z4.string())
      .max(5)
      .optional()
      .describe("Up to five unmatched store labels, in store order."),
  })
  .passthrough();

/** Mirrors `assertSssIffDerived` (`shared/contract/zarr-index.ts`): `sss` is
 *  present if and only if `derived` is true (ADR 0028). */
function assertSssIffDerived4(
  value: { derived: boolean; sss?: unknown },
  ctx: z4.RefinementCtx,
): void {
  const hasSss = value.sss !== undefined;
  if (value.derived !== hasSss) {
    ctx.addIssue({
      code: z4.ZodIssueCode.custom,
      path: ["sss"],
      message: value.derived
        ? "derived is true but sss is absent (ADR 0028: the two travel together)"
        : "sss is present but derived is false (ADR 0028: the two travel together)",
    });
  }
}

export const provenanceEnvelopeSchema4 = z4
  .object({
    dataset_id: z4.string().regex(DATASET_ID_RE).describe(DATASET_ID_DESCRIPTION),
    doi: z4.string().nullable().describe("Concept DOI, or null when none has been minted."),
    license: z4.string().nullable().describe("SPDX-ish license identifier, or null when unset."),
    citation: z4.string().nullable().describe("A ready-to-paste citation string, or null."),
    source_commit: z4
      .string()
      .regex(SOURCE_COMMIT_RE)
      .describe("The 40-hex commit the served Zarr copy was converted from."),
    index_etag: z4
      .string()
      .nullable()
      .describe("The index.json HTTP response's ETag, when the caller kept it; null when unknown."),
    engine_version: z4.string().describe("The Zarr conversion engine's version stamp."),
    source_tree: z4.literal("raw").describe("Always raw -- ADR 0027 made discovery raw-only."),
    derived: z4.boolean().describe("True for a processed (e.g. ADR 0028 SSS-filtered) store."),
    sss: zarrSssSchema4.optional(),
    lossy: z4
      .boolean()
      .describe(
        "Always true today: every served level-0 array is int16-quantized and rate-capped.",
      ),
    dtype: z4
      .string()
      .nullable()
      .describe(
        "The level-0 array's dtype, from that array's own zarr.json. Null when the answering tool did not read that document, so in practice only read_window populates it: render_overview reads the view pyramid, never zarr.json.",
      ),
    effective_rate_hz: z4
      .number()
      .nullable()
      .describe("The SERVING rate after the NEMAR modality cap."),
    source_rate_hz: z4.number().nullable().describe("The recording's own rate before the cap."),
    units_report: zarrUnitsReportSchema4.nullable().optional(),
    zarr_verify_status: z4
      .enum(ZARR_VERIFY_STATUS_VALUES)
      .nullable()
      .describe(
        "The standing fidelity sweep's verdict; null until the daily sweep reaches this dataset.",
      ),
    note: z4
      .string()
      .nullable()
      .optional()
      .describe("A short caveat the caller should surface verbatim; null when there is none."),
  })
  .passthrough()
  .superRefine(assertSssIffDerived4);

// ---------------------------------------------------------------------------
// list_recordings
// ---------------------------------------------------------------------------

export const listRecordingsInputSchema4 = z4
  .object({
    dataset_id: z4.string().regex(DATASET_ID_RE).describe(DATASET_ID_DESCRIPTION),
    modality: z4
      .string()
      .optional()
      .describe(
        "Case-insensitive equality filter against a group's modality or the store's modalities.",
      ),
    min_duration_s: z4
      .number()
      .nonnegative()
      .optional()
      .describe("Filter to recordings whose longest group duration is at least this many seconds."),
    include_derived: z4
      .boolean()
      .default(false)
      .describe("Include ADR 0028 SSS-filtered (derived) stores; default false."),
    limit: z4
      .number()
      .int()
      .positive()
      .max(LIST_RECORDINGS_MAX_LIMIT)
      .default(LIST_RECORDINGS_DEFAULT_LIMIT)
      .describe(
        `Maximum number of recordings to return (default ${LIST_RECORDINGS_DEFAULT_LIMIT}, capped at ${LIST_RECORDINGS_MAX_LIMIT}).`,
      ),
    offset: z4
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("Pagination offset into the filtered set."),
  })
  .passthrough();

const recordingGroupSummarySchema4 = z4
  .object({
    name: z4.string(),
    modality: z4.string().nullable().optional(),
    rate: z4.number().nullable().optional().describe("The SERVING sample rate in Hz."),
    n_channels: z4.number().int().nullable().optional(),
    duration_s: z4.number().nullable().optional(),
    n_view_levels: z4
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .describe("How many view/* pyramid levels this group publishes; null/0 means no pyramid."),
    n_samples: z4.number().int().nonnegative().nullable().optional(),
    view_chunk_columns: z4.number().int().positive().nullable().optional(),
  })
  .passthrough();

const recordingSummarySchema4 = z4
  .object({
    path: z4.string().describe("The recording's source file path within the dataset."),
    zarr: z4
      .string()
      .describe("The recording's Zarr store path, relative to contract_base/data_base."),
    source_tree: z4.literal("raw"),
    derived: z4.boolean(),
    groups: z4.array(recordingGroupSummarySchema4).optional(),
    n_events: z4.number().int().nonnegative().optional(),
    sss: zarrSssSchema4.optional(),
    units_report: zarrUnitsReportSchema4.optional(),
  })
  .passthrough()
  .superRefine(assertSssIffDerived4);

export const listRecordingsOutputSchema4 = z4
  .object({
    dataset_id: z4.string().regex(DATASET_ID_RE).describe(DATASET_ID_DESCRIPTION),
    source_commit: z4
      .string()
      .regex(SOURCE_COMMIT_RE)
      .nullable()
      .describe(
        "The 40-hex commit this listing was read from; null when the index carries none usable.",
      ),
    recordings: z4.array(recordingSummarySchema4),
    total_count: z4.number().int().nonnegative(),
    excluded_derived_count: z4.number().int().nonnegative(),
    limit: z4.number().int(),
    offset: z4.number().int(),
    index_format_version: z4
      .number()
      .int()
      .describe("The source index document's own format_version."),
    discovered_count: z4.number().int().nonnegative().nullable(),
    failure_count: z4.number().int().nonnegative().nullable(),
    pending_count: z4.number().int().nonnegative().nullable(),
    excluded_legacy_non_raw_count: z4.number().int().nonnegative(),
    note: z4.string().nullable().optional(),
    envelope: provenanceEnvelopeSchema4.optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// get_events
// ---------------------------------------------------------------------------

const eventColumnNameSchema4 = z4.string().min(1).max(64);

export const getEventsInputSchema4 = z4
  .object({
    dataset_id: z4.string().regex(DATASET_ID_RE).describe(DATASET_ID_DESCRIPTION),
    recording: z4
      .string()
      .describe("A store's path or zarr field -- either identifies the recording."),
    group: z4.string().optional().describe("Filter to one channel group's events by name."),
    limit: z4
      .number()
      .int()
      .positive()
      .max(GET_EVENTS_MAX_LIMIT)
      .default(GET_EVENTS_DEFAULT_LIMIT)
      .describe(
        `Maximum number of event rows to return (default ${GET_EVENTS_DEFAULT_LIMIT}, capped at ${GET_EVENTS_MAX_LIMIT}).`,
      ),
    offset: z4.number().int().nonnegative().default(0),
    where: z4
      .record(
        eventColumnNameSchema4,
        z4
          .array(z4.union([z4.string(), z4.number()]))
          .min(1)
          .max(GET_EVENTS_MAX_WHERE_VALUES),
      )
      .refine(
        (w) => {
          const n = Object.keys(w).length;
          return n >= 1 && n <= GET_EVENTS_MAX_WHERE_COLUMNS;
        },
        { message: `where names 1 to ${GET_EVENTS_MAX_WHERE_COLUMNS} columns` },
      )
      .optional()
      .describe(
        "Keep only rows whose value in each named column, compared as a string, is one of those " +
          'listed, e.g. {"trial_type": ["stimulus"]}. total_count counts the rows kept. ' +
          "columns_summary names the columns and their values, so a call with limit 1 shows what to ask for.",
      ),
    columns: z4
      .array(eventColumnNameSchema4)
      .min(1)
      .max(GET_EVENTS_MAX_COLUMNS)
      .optional()
      .describe(
        'Return only these columns, e.g. ["trial_type"]; onset_s and sample_index always come back. ' +
          "Omit for every column.",
      ),
  })
  .passthrough();

const eventRowSchema4 = z4
  .object({
    store_path: z4.string(),
    group_name: z4.string(),
    onset_s: z4.number(),
    duration_s: z4.number().nullable().optional(),
    sample_index: z4.number().int().nonnegative(),
    trial_type: z4.string().nullable().optional(),
    value: z4.union([z4.string(), z4.number()]).nullable().optional(),
    hed: z4.string().nullable().optional(),
  })
  .passthrough();

const eventRowOutputSchema4 = eventRowSchema4
  .partial()
  .required({ onset_s: true, sample_index: true });

const eventColumnSummarySchema4 = z4
  .object({
    name: z4.string(),
    distinct_count: z4.number().int().nonnegative(),
    null_count: z4.number().int().nonnegative(),
    values: z4
      .array(z4.object({ value: z4.string(), count: z4.number().int().positive() }).passthrough())
      .nullable()
      .describe(
        `Each distinct value and its row count, most common first; null over ${GET_EVENTS_SUMMARY_MAX_VALUES} ` +
          `distinct values or for a value over ${GET_EVENTS_SUMMARY_MAX_VALUE_CHARS} characters.`,
      ),
  })
  .passthrough();

export const getEventsOutputSchema4 = z4
  .object({
    dataset_id: z4.string().regex(DATASET_ID_RE).describe(DATASET_ID_DESCRIPTION),
    recording: z4.string(),
    events: z4.array(eventRowOutputSchema4),
    source: z4
      .enum(["events_parquet", "events_tsv_fallback"])
      .describe("events_parquet is exact; events_tsv_fallback's sample_index is estimated."),
    estimated: z4.boolean(),
    total_count: z4.number().int().nonnegative(),
    limit: z4.number().int(),
    offset: z4.number().int(),
    truncated: z4.boolean(),
    note: z4.string().nullable().optional(),
    columns_summary: z4
      .array(eventColumnSummarySchema4)
      .optional()
      .describe(
        "Every column of this recording's events except onset_s, sample_index, store_path and group_name, before where is applied.",
      ),
    envelope: provenanceEnvelopeSchema4.optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// render_overview
// ---------------------------------------------------------------------------

export const renderOverviewInputSchema4 = z4
  .object({
    dataset_id: z4.string().regex(DATASET_ID_RE).describe(DATASET_ID_DESCRIPTION),
    recording: z4
      .string()
      .describe("A store's path or zarr field -- either identifies the recording."),
    group: z4
      .string()
      .optional()
      .describe("Which channel group to render; defaults to the first group."),
    width_px: z4
      .number()
      .int()
      .positive()
      .max(RENDER_OVERVIEW_MAX_WIDTH_PX)
      .default(RENDER_OVERVIEW_DEFAULT_WIDTH_PX)
      .describe(
        `Rendered image width in pixels (default ${RENDER_OVERVIEW_DEFAULT_WIDTH_PX}, capped at ${RENDER_OVERVIEW_MAX_WIDTH_PX}).`,
      ),
  })
  .passthrough();

export const renderOverviewOutputSchema4 = z4
  .object({
    dataset_id: z4.string().regex(DATASET_ID_RE).describe(DATASET_ID_DESCRIPTION),
    recording: z4.string(),
    group: z4.string(),
    level: z4.number().int().positive().describe("The view pyramid level actually read."),
    width_px: z4.number().int().positive(),
    height_px: z4.number().int().positive(),
    mime_type: z4.literal("image/png"),
    columns_read: z4.number().int().nonnegative(),
    chunks_read: z4.number().int().nonnegative(),
    bytes_read: z4.number().int().nonnegative(),
    envelope: provenanceEnvelopeSchema4.optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// read_window (epic #1065 phase 4, issue #1296)
// ---------------------------------------------------------------------------

const rangeSchema4 = z4
  .object({
    start: z4.number().int().nonnegative(),
    end: z4.number().int().nonnegative(),
  })
  .passthrough()
  .refine((v) => v.end >= v.start, { message: "end must be >= start", path: ["end"] });

export const readRecipeHowToSchema4 = z4
  .object({
    python_zarr: z4
      .string()
      .describe(
        "Python for desktop and HPC: zarr + anonymous S3. NOT usable in a browser -- " +
          "zarr.open is synchronous and starts an IO thread, which Pyodide cannot. " +
          "Use python_browser there.",
      ),
    zarrita: z4
      .string()
      .describe(
        "The TypeScript/JavaScript lane, zarrita. Runs in a browser and in Node. " +
          "For Python in a browser use python_browser, not this.",
      ),
    python_browser: z4
      .string()
      .describe(
        "Python in a browser (Pyodide), via eegprep-lean over HTTPS range requests. " +
          "Async throughout. At level 0 it leads with read_window, which returns physical " +
          "units with channel labels; the open_array read that follows it returns stored " +
          "digital counts. Carries no install line: eegprep-lean is not on PyPI and the " +
          "executing runtime pins and installs it.",
      ),
  })
  .passthrough();

const readRecipeSchema4 = z4
  .object({
    contract_base: z4.string(),
    data_base: z4.string(),
    s3_uri: z4.string(),
    s3_region: z4.string(),
    s3_anonymous: z4.boolean(),
    zarr: z4.string().describe("The store's zarr path."),
    group: z4.string().describe("The channel group name."),
    level: z4
      .union([z4.literal("0"), z4.number().int().positive()])
      .describe('"0" for the level-0 signal array, or a positive integer view level.'),
    array_path: z4.string().describe("Absolute URL: contract_base plus the array's own path."),
    dtype: z4
      .string()
      .nullable()
      .describe("Zarr's data_type from the array's zarr.json; null when that fetch was not made."),
    codecs: z4.array(z4.unknown()).optional(),
    chunk_samples: z4.number().int().positive().nullable(),
    shard_samples: z4.number().int().positive().nullable(),
    n_channels: z4.number().int().nonnegative().nullable(),
    sample_slice: rangeSchema4.optional().describe("Half-open [start, end) sample range."),
    channel_slice: rangeSchema4.optional().describe("Half-open [start, end) channel range."),
    scale_offset: z4
      .string()
      .describe("Where to find the physical-units conversion (not the values themselves)."),
    how_to: readRecipeHowToSchema4,
  })
  .passthrough();

export const readWindowInputSchema4 = z4
  .object({
    dataset_id: z4.string().regex(DATASET_ID_RE).describe(DATASET_ID_DESCRIPTION),
    recording: z4
      .string()
      .describe("A store's path or zarr field -- either identifies the recording."),
    group: z4
      .string()
      .optional()
      .describe("Which channel group to read; defaults to the first group."),
    start_s: z4.number().nonnegative().default(0).describe("Window start, in seconds."),
    duration_s: z4
      .number()
      .positive()
      .max(RECIPE_SANITY_MAX_DURATION_S)
      .default(10)
      .describe(
        `Window length in seconds. Recipe mode's ceiling is generous (${RECIPE_SANITY_MAX_DURATION_S} s); ` +
          `a taste (taste: true) is additionally capped at ${READ_WINDOW_TASTE_MAX_DURATION_S} s.`,
      ),
    channels: z4
      .array(z4.number().int().nonnegative())
      .max(RECIPE_SANITY_MAX_CHANNELS)
      .optional()
      .describe(
        `Channel indices; REQUIRED when taste is true (list_recordings reports each group's n_channels). Recipe mode's ceiling is generous (${RECIPE_SANITY_MAX_CHANNELS}); a taste is additionally capped at ${READ_WINDOW_TASTE_MAX_CHANNELS} channels.`,
      ),
    taste: z4
      .boolean()
      .default(false)
      .describe(
        "false (default): return a read recipe, zero signal bytes touched. true: decode a small, " +
          "capped window inline and return the physical values.",
      ),
  })
  .passthrough()
  .superRefine((val, ctx) => {
    if (!val.taste) return;
    // Mirrors the zod 3 contract's identical fix: an EMPTY array is not
    // `undefined` and used to slip past this guard.
    if (!val.channels || val.channels.length === 0) {
      ctx.addIssue({
        code: z4.ZodIssueCode.custom,
        message:
          "taste requires channels: name the channel indices you want " +
          "(list_recordings reports each group's n_channels), or omit taste for a recipe",
        path: ["channels"],
      });
      return;
    }
    if (val.duration_s > READ_WINDOW_TASTE_MAX_DURATION_S) {
      ctx.addIssue({
        code: z4.ZodIssueCode.custom,
        message: `taste duration_s (${val.duration_s}) exceeds the ${READ_WINDOW_TASTE_MAX_DURATION_S} s cap; omit taste for a recipe instead`,
        path: ["duration_s"],
      });
    }
    if (val.channels.length > READ_WINDOW_TASTE_MAX_CHANNELS) {
      ctx.addIssue({
        code: z4.ZodIssueCode.custom,
        message: `taste channels (${val.channels.length}) exceeds the ${READ_WINDOW_TASTE_MAX_CHANNELS}-channel cap; omit taste for a recipe instead`,
        path: ["channels"],
      });
    }
    const channelSeconds = val.duration_s * val.channels.length;
    if (channelSeconds > READ_WINDOW_TASTE_MAX_CHANNEL_SECONDS) {
      ctx.addIssue({
        code: z4.ZodIssueCode.custom,
        message:
          `taste exceeds the cap of ${READ_WINDOW_TASTE_MAX_CHANNEL_SECONDS} channel-seconds ` +
          `(duration_s x channels = ${channelSeconds}); omit taste for a recipe instead`,
        path: ["duration_s"],
      });
    }
  });

const readWindowRecipeResultSchema4 = z4
  .object({
    mode: z4.literal("recipe"),
    recipe: readRecipeSchema4,
    envelope: provenanceEnvelopeSchema4,
  })
  .passthrough();

const readWindowTasteResultSchema4 = z4
  .object({
    mode: z4.literal("taste"),
    start_s: z4.number(),
    duration_s: z4.number(),
    channels: z4.array(z4.number().int()),
    sample_rate_hz: z4.number(),
    values: z4
      .array(z4.array(z4.number()))
      .describe(
        "[channel][sample], already scaled to physical units and rounded to six significant digits.",
      ),
    recipe: readRecipeSchema4.describe(
      "A fully-populated recipe -- this taste already fetched the array metadata.",
    ),
    chunks_read: z4
      .number()
      .int()
      .nonnegative()
      .describe(
        "How many inner chunks were actually fetched and decoded; an absent, fill-valued chunk contributes 0.",
      ),
    bytes_read: z4
      .number()
      .int()
      .nonnegative()
      .describe(
        "Total upstream bytes fetched for this call: the array-metadata GET (0 on a cache hit) " +
          "plus every shard-footer Range read plus every inner-chunk Range read (each 0 on a cache hit).",
      ),
    filled_ranges: z4
      .array(
        z4
          .object({
            start_sample: z4.number().int().nonnegative(),
            end_sample: z4.number().int().nonnegative(),
            start_s: z4.number(),
            end_s: z4.number(),
          })
          .passthrough(),
      )
      .describe(
        "Every sample span (clipped to this window) that had no stored inner chunk and was " +
          "fill-substituted with the channel's baseline offset rather than real recorded data. " +
          "Always present, even when empty.",
      ),
    note: z4
      .string()
      .nullable()
      .optional()
      .describe(
        "A caveat to surface verbatim -- always names the six-significant-digit rounding; also " +
          "names filled_ranges when non-empty.",
      ),
    envelope: provenanceEnvelopeSchema4,
  })
  .passthrough();

export const readWindowOutputSchema4 = z4.discriminatedUnion("mode", [
  readWindowRecipeResultSchema4,
  readWindowTasteResultSchema4,
]);
