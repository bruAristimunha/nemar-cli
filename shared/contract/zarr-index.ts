/**
 * Zarr serving index (format_version 3) wire vocabulary, mirroring
 * `shared/zarr-index.schema.json` on the TypeScript side (issue #1293, phase 1
 * of epic #1065's MCP server).
 *
 * `shared/zarr-index.schema.json` is the CLOSED contract the Python producer
 * (`scripts/zarr/generate_zarr.py`) validates against before publishing --
 * every object there is `additionalProperties: false`. This reader follows the
 * repository's established lower-bound convention instead (see
 * `shared/contract/dataset.ts`'s module doc): every object schema here is
 * `.passthrough()`, so a field the JSON Schema does not yet know about (the
 * producer landing an additive v3 field before this reader is updated) does
 * not break a consumer that only reads the fields it names. The producer-side
 * closed contract stays the JSON Schema; this reader is a client-side lower
 * bound on it.
 *
 * `backend/src/services/s3.ts`'s `ZarrIndexJson` stays `unknown`-typed for the
 * sweeps and is untouched by this file -- the sweeps parse defensively field by
 * field and do not want a schema that could reject a document they still need
 * to read something out of.
 */

import { z } from "zod";

/** NEMAR dataset id: two lowercase letters, six digits (nm/on/xx band). */
export const DATASET_ID_RE = /^[a-z]{2}[0-9]{6}$/;

/** The producer refuses to publish an index without a full 40-hex commit SHA
 *  (#1197) -- see the schema's `source_commit` description. */
export const SOURCE_COMMIT_RE = /^[0-9a-f]{40}$/;

/** One channel group inside a store (biosigIO names them `<modality>_<rate>hz`).
 *  Groups are concurrent streams of one recording; a store's duration is the
 *  max over its groups, never their sum. */
export const zarrGroupSchema = z
  .object({
    name: z.string(),
    modality: z.string().nullable().optional(),
    /** The SERVING rate after the NEMAR modality cap, not the acquisition rate. */
    rate: z.number().nullable().optional(),
    n_channels: z.number().int().nonnegative().nullable().optional(),
    n_samples: z.number().int().nonnegative().nullable().optional(),
    duration_s: z.number().nonnegative().nullable().optional(),
    /** The recording's own sampling rate before the cap (level-0 attr). */
    source_rate_hz: z.number().nullable().optional(),
    n_view_levels: z.number().int().nonnegative().optional(),
    view_chunk_columns: z.number().int().positive().optional(),
    chunk_samples: z.number().int().positive().optional(),
    shard_samples: z.number().int().positive().optional(),
  })
  .passthrough();
export type ZarrGroup = z.infer<typeof zarrGroupSchema>;

/** biosigIO's per-file account of what a BIDS `channels.tsv` `units` column
 *  did (biosigio#125). Present exactly when a sidecar was applied; never means
 *  "applied cleanly". */
export const zarrUnitsReportSchema = z
  .object({
    converted: z.number().int().nonnegative().optional(),
    relabelled: z.number().int().nonnegative().optional(),
    kept_importer_unit: z.number().int().nonnegative().optional(),
    units_column_present: z.boolean().optional(),
    sidecar: z.string().optional(),
    sidecar_supplied: z.boolean().optional(),
    /** Store channels no channels.tsv row reached; the sidecar's type and
     *  unit never reached them. A row reaches the channel it names exactly
     *  and, from biosigio 1.2.10, the one channel it names in another letter
     *  case when that is unambiguous (`matched_case_only`). 0 means every
     *  channel met a row. Absent when there was no join: the store records no
     *  labels, the sidecar has no `name` column, or there is no
     *  `units_report` at all. */
    unmatched_channels: z.number().int().nonnegative().optional(),
    /** Of those, a row names them in another letter case but did not match:
     *  converted before biosigio 1.2.10 (exact matching), or the
     *  case-insensitive match was ambiguous (biosigio#136). */
    unmatched_case_only: z.number().int().positive().optional(),
    /** Store channels a row reached only by ignoring letter case (biosigio
     *  >= 1.2.10); the sidecar's type and unit WERE applied. The bounded
     *  republication of biosigio's per-channel `matched_case_insensitive`
     *  map, which the index never carries. */
    matched_case_only: z.number().int().positive().optional(),
    /** Up to five of those, as `"<channels.tsv name> -> <store label>"`. */
    matched_case_only_examples: z.array(z.string()).max(5).optional(),
    /** Of those, the file repeated the label, the store de-duplicated it
     *  (`T8-P8` -> `T8-P8-0`), and the sidecar names the repeated one. */
    unmatched_raw_label: z.number().int().positive().optional(),
    unmatched_examples: z.array(z.string()).max(5).optional(),
  })
  .passthrough();
export type ZarrUnitsReport = z.infer<typeof zarrUnitsReportSchema>;

/** The recording's channels.tsv declares more channels than its data file
 *  holds, while the store serves every channel the file's own header declares
 *  (faithful to the data; the sidecar over-declares). Mirrors the schema's
 *  closed `channels_tsv_count_mismatch` object. */
export const zarrChannelsTsvCountMismatchSchema = z
  .object({
    channels_tsv: z.number().int().positive(),
    in_file: z.number().int().nonnegative(),
    in_store: z.number().int().nonnegative(),
  })
  .passthrough();

/** ADR 0028 Signal-Space Separation record, present exactly when a store's
 *  `derived` is true. The keys named here are what `generate_zarr.py`'s
 *  `apply_sss` writes today; anything it adds later passes through, so the
 *  provenance envelope's `sss` field never drops a fact the converter
 *  recorded. */
export const zarrSssSchema = z
  .object({
    applied: z.boolean().optional(),
    method: z.string().optional(),
    calibration: z.string().optional(),
    cross_talk: z.string().optional(),
    mne_version: z.string().optional(),
  })
  .passthrough();
export type ZarrSss = z.infer<typeof zarrSssSchema>;

/** ADR 0028: `sss` is present exactly when `derived` is true. The producer
 *  guarantees it (`derived` is set from the presence of `sss`), so a document
 *  where the two disagree is corrupt rather than merely unusual, and the
 *  reader refuses it even though `shared/zarr-index.schema.json` only states
 *  the pairing in prose. Shared with the provenance envelope in `mcp.ts`. */
export function assertSssIffDerived(
  value: { derived: boolean; sss?: unknown },
  ctx: z.RefinementCtx,
): void {
  const hasSss = value.sss !== undefined;
  if (value.derived !== hasSss) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sss"],
      message: value.derived
        ? "derived is true but sss is absent (ADR 0028: the two travel together)"
        : "sss is present but derived is false (ADR 0028: the two travel together)",
    });
  }
}

/** One converted recording. Read the bytes at `<contract_base><zarr>/`. */
export const zarrStoreSchema = z
  .object({
    path: z.string(),
    zarr: z.string().regex(/\.zarr$/, "must end in .zarr"),
    updated_utc: z.string().optional(),
    /** Always "raw": ADR 0027 made discovery raw-only, and a carried-over
     *  store under derivatives/, sourcedata/ or code/ is dropped from the
     *  index rather than republished. */
    source_tree: z.literal("raw"),
    /** True when the served signal is PROCESSED rather than the source signal
     *  quantized and rate-capped (today: an ADR 0028 SSS-filtered MEG store,
     *  which also carries `sss`). Distinct from `source_tree`. */
    derived: z.boolean(),
    modalities: z.array(z.string()).optional(),
    groups: z.array(zarrGroupSchema).optional(),
    power_line_frequency: z.number().nullable().optional(),
    event_description_count: z.number().int().nonnegative().optional(),
    n_events: z.number().int().nonnegative().optional(),
    /** Counts per trial_type value. A key is the value itself up to 128 Unicode
     *  code points (not bytes or UTF-16 units; the value is stripped first); a
     *  longer value is keyed `<first 13 code points>~<14 hex digits of the
     *  SHA-256 of its UTF-8 bytes>` (28 characters). Values that fit claim their
     *  own key first, then long values sorted by code point (not JavaScript's
     *  UTF-16 order); when a long value's key is already taken it is re-hashed
     *  over the decimal salt n = 1, 2, ..., a NUL byte, and the value, until its
     *  key is free. Distinct values keep distinct keys and no counts are
     *  merged, so a dataset that stores a whole record in the column still has a
     *  key per distinct value, about 33 bytes each instead of the record's
     *  length. An index published before this rule carries the literal value for
     *  a longer one: look it up first, then the digest form. The full value is
     *  in events.parquet when `events_parquet` is listed. Consumers stay lenient
     *  about key length for that reason. */
    trial_types: z.record(z.string(), z.number().int().nonnegative()).optional(),
    units_report: zarrUnitsReportSchema.optional(),
    channels_tsv_read_error: z.boolean().optional(),
    channels_tsv_count_mismatch: zarrChannelsTsvCountMismatchSchema.optional(),
    split_members: z.array(z.string()).optional(),
    sss: zarrSssSchema.optional(),
  })
  .passthrough()
  .superRefine(assertSssIffDerived);
export type ZarrStore = z.infer<typeof zarrStoreSchema>;

/** A recording that has no store for a reason that retrying in the same state will not change. */
export const zarrFailureSchema = z
  .object({
    path: z.string(),
    zarr: z
      .string()
      .regex(/\.zarr$/, "must end in .zarr")
      .optional(),
    code: z.string(),
    reason: z.string(),
    detail: z.string().nullable().optional(),
    attempts: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type ZarrFailure = z.infer<typeof zarrFailureSchema>;

/** The closed set `generate_zarr.py`'s `PendingReason` mirrors. */
export const zarrPendingReasonSchema = z.enum(["infra_failure", "memory_budget", "not_attempted"]);
export type ZarrPendingReason = z.infer<typeof zarrPendingReasonSchema>;

/** A discovered recording with no store yet that is still expected to convert. */
export const zarrPendingSchema = z
  .object({
    path: z.string(),
    zarr: z.string().regex(/\.zarr$/, "must end in .zarr"),
    reason: zarrPendingReasonSchema,
    attempts: z.number().int().nonnegative(),
    last_error: z.string().nullable().optional(),
    last_attempt_utc: z.string().nullable().optional(),
  })
  .passthrough();
export type ZarrPending = z.infer<typeof zarrPendingSchema>;

/**
 * How to turn an index's numbers into reads, so an MCP recipe is computable
 * from `index.json` plus one array-metadata fetch, with no probing (#1064).
 * The four required members are `const` in the JSON Schema (a client may
 * hardcode them once `format_version` is checked); `events` is optional the
 * same way `events_parquet` is, since it states the events file's location
 * against `data_base` rather than a store path.
 */
export const zarrLayoutSchema = z
  .object({
    level0: z.literal("<zarr>/<group>/0"),
    view: z.literal("<zarr>/<group>/view/<L>"),
    view_levels: z.literal("1..n_view_levels from the group attrs"),
    scale_offset: z.literal(
      "level-0 array attrs scale[] and offset[]; physical = digital * scale + offset",
    ),
    events: z.literal("<data_base>events.parquet").optional(),
  })
  .passthrough();
export type ZarrLayout = z.infer<typeof zarrLayoutSchema>;

/**
 * The mandatory entry point to a dataset's Zarr serving copy, format_version 3
 * (`shared/zarr-index.schema.json`). Anonymous `ListBucket` is denied on the
 * serving bucket, so this document -- not a listing -- is how a client
 * discovers what is served, where to read it from, and why a recording is
 * missing.
 */
export const zarrIndexSchema = z
  .object({
    format: z.literal("nemar-zarr-index"),
    format_version: z.literal(3),
    dataset_id: z.string().regex(DATASET_ID_RE, "NEMAR dataset id (nm/on/xx band)"),
    /** The only base a client may hardcode. */
    contract_base: z.string().regex(/^https:\/\//, "must be https"),
    /** Where the bytes are served from TODAY -- re-read rather than hardcode. */
    data_base: z.string().regex(/^https:\/\//, "must be https"),
    data_base_kind: z.literal("s3-public"),
    s3_uri: z.string().regex(/^s3:\/\//, "must be an s3:// URI"),
    s3_region: z.string().min(1),
    s3_anonymous: z.boolean(),
    source_commit: z.string().regex(SOURCE_COMMIT_RE, "must be a full 40-hex SHA"),
    engine_version: z.string().min(1),
    biosigio_version: z.string().nullable().optional(),
    updated_utc: z.string(),
    /** Raw recordings found at source_commit; the coverage denominator.
     *  INVARIANT (documented by the producer, not enforced here):
     *  discovered_count == store_count + failure_count + pending_count. */
    discovered_count: z.number().int().nonnegative(),
    /** Recordings with a served store. Authoritative -- prefer to stores.length. */
    store_count: z.number().int().nonnegative(),
    /** Alias of store_count, kept for the #1059 field list. */
    n_recordings: z.number().int().nonnegative(),
    /** Recordings that failed in THIS run -- a run statistic, not a coverage total. */
    errors: z.number().int().nonnegative(),
    failure_count: z.number().int().nonnegative(),
    pending_count: z.number().int().nonnegative(),
    stores: z.array(zarrStoreSchema),
    failures: z.array(zarrFailureSchema),
    pending: z.array(zarrPendingSchema),
    /** Concept DOI, hoisted from the store attrs so a citation tool needs only
     *  this document. Null when the catalog has none yet. */
    doi: z.string().nullable().optional(),
    license: z.string().nullable().optional(),
    citation: z.string().nullable().optional(),
    hed_version: z.string().nullable().optional(),
    /** Absent means there is no file to read -- never assume the path exists. */
    events_parquet: z
      .string()
      .regex(/^https:\/\//, "must be https")
      .optional(),
    /** Rows in events_parquet. NOT the event count -- see the schema's field doc. */
    events_row_count: z.number().int().nonnegative().optional(),
    layout: zarrLayoutSchema,
  })
  .passthrough();
export type ZarrIndex = z.infer<typeof zarrIndexSchema>;

/** A Zarr v3 codec entry as the array metadata lists it (`bytes`, `blosc`,
 *  `sharding_indexed`, `crc32c`, ...). `configuration` is codec-specific. */
export const zarrCodecSchema = z
  .object({
    name: z.string(),
    configuration: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type ZarrCodec = z.infer<typeof zarrCodecSchema>;

/**
 * The `zarr.json` of one served ARRAY (`<zarr>/<group>/0` or a view level):
 * Zarr v3 array metadata, the ONE extra fetch a recipe caller makes to learn
 * `data_type` and `codecs`. Wire names are Zarr's (`data_type`, not `dtype`);
 * `buildReadRecipe` in `mcp.ts` does the one rename. Lower bound like every
 * other schema here, so a future Zarr extension key passes through.
 */
export const zarrArrayMetadataSchema = z
  .object({
    zarr_format: z.literal(3),
    node_type: z.literal("array"),
    shape: z.array(z.number().int().nonnegative()),
    data_type: z.string(),
    chunk_grid: z
      .object({
        name: z.string(),
        configuration: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough(),
    codecs: z.array(zarrCodecSchema),
    fill_value: z.unknown().optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
    dimension_names: z.array(z.string().nullable()).optional(),
  })
  .passthrough();
export type ZarrArrayMetadata = z.infer<typeof zarrArrayMetadataSchema>;

/** Parse and validate an index document, returning the typed reader shape. */
export function parseZarrIndex(doc: unknown): ZarrIndex {
  return zarrIndexSchema.parse(doc);
}

/** Non-throwing variant, for a caller that wants to report a schema mismatch
 *  as a tool error rather than crash the request. */
export function safeParseZarrIndex(doc: unknown): z.SafeParseReturnType<unknown, ZarrIndex> {
  return zarrIndexSchema.safeParse(doc);
}

// ---------------------------------------------------------------------------
// Legacy (pre-v3) index documents (epic #1065 phase 3, issue #1295).
//
// About half the catalog still publishes format_version 1 while the ADR 0033
// engine bump re-converts the back catalog (`backend/src/mcp/index-reader.ts`'s
// module doc). A v1 document has no `layout`, no `events_parquet`, no
// `source_tree`/`derived` on its stores, no `engine_version`, and a group may
// carry no `n_view_levels` at all -- none of `zarrIndexSchema`'s required
// fields hold, so a v1 document fails that schema outright rather than
// partially validating. This is a DELIBERATELY MINIMAL lower bound (a true
// lower bound of "whatever format_version 1 and 2 ever published"), not a
// full mirror of `zarrIndexSchema`: the MCP tools serve v1 honestly (no
// pyramid, no events.parquet, an inferred `source_tree`/`derived`) rather
// than pretending it is v3. `source_commit` is `z.string()` with NO regex --
// v1 predates the 40-hex guarantee (#1197) and on008083 once published `""`;
// a reader must not crash on that, only treat it as "no usable commit".
// -----------------------------------------------------------------------

/** A legacy store entry: only `path`/`zarr` are guaranteed; `groups`/
 *  `modalities` are the two fields the phase 3 tools actually read off it.
 *  No `source_tree`/`derived` -- those are v3-only and inferred by the
 *  caller from `path` instead (ADR 0027). */
export const zarrLegacyStoreSchema = z
  .object({
    path: z.string(),
    zarr: z.string().regex(/\.zarr$/, "must end in .zarr"),
    groups: z.array(zarrGroupSchema).optional(),
    modalities: z.array(z.string()).optional(),
  })
  .passthrough();
export type ZarrLegacyStore = z.infer<typeof zarrLegacyStoreSchema>;

/** Lower-bound schema for a pre-v3 (`format_version` 1 or 2) index document.
 *  `format_version` is any int, not `z.literal(3)` -- this schema is the
 *  catch-all for "not v3", not a schema for one specific legacy version. */
export const zarrIndexLegacySchema = z
  .object({
    format: z.literal("nemar-zarr-index"),
    format_version: z.number().int(),
    dataset_id: z.string().regex(DATASET_ID_RE, "NEMAR dataset id (nm/on/xx band)"),
    /** ANY string, including empty -- v1 predates the 40-hex guarantee. */
    source_commit: z.string(),
    stores: z.array(zarrLegacyStoreSchema),
  })
  .passthrough();
export type ZarrIndexLegacy = z.infer<typeof zarrIndexLegacySchema>;

/** Either shape an index document may take, narrowed by `format_version`. */
export type ZarrIndexAny = ZarrIndex | ZarrIndexLegacy;
