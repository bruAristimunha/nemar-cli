/**
 * Dataset wire-shape contract (epic #896, #898).
 *
 * Single source of truth for the dataset shapes the CLI, website, data plane,
 * and third parties (EEGDash, ...) exchange. Three related shapes:
 *  - catalogItemSchema  : api.nemar.org GET /datasets list/search rows
 *  - datasetDetailSchema: api.nemar.org GET /datasets/:id (superset of the item)
 *  - neuroschemaDatasetSchema: data.nemar.org landing payload, which conforms to
 *    the neuroschema v0.4.1 `core/dataset.schema.json` (the canonical, language-
 *    agnostic dataset-metadata schema; enforced against the vendored JSON Schema
 *    in test/contract/neuroschema-conformance.test.ts).
 *
 * Objects are `.passthrough()` on purpose: the contract asserts REQUIRED fields
 * and their types (a lower bound), so additive backend fields never break it.
 * `latest_version` uses the coercing versionTagSchema, so today's bare-version
 * rows still validate while the canonical output is the `vX.Y.Z` tag.
 *
 * Zero deps beyond zod (extraction-ready for @nemar/contract).
 */

import { z } from "zod";
import { versionTagSchema } from "./version.js";

/**
 * neuroschema version this contract's dataset shape conforms to. Single source;
 * backend services/data-router.ts imports this instead of a hardcoded literal.
 */
export const NEUROSCHEMA_VERSION = "0.4.1";

/** neuroschema `source` enum. */
export const datasetSourceSchema = z.enum(["openneuro", "nemar", "gin", "other"]);
export type DatasetSource = z.infer<typeof datasetSourceSchema>;

/** 0/1 tri-state used across the catalog columns (1/0, or null = not classified). */
const zeroOneNullable = z.union([z.literal(0), z.literal(1)]).nullable();

/**
 * api.nemar.org catalog row (GET /datasets, public + "mine" branches).
 * Mirrors backend/src/routes/datasets/catalog.ts. Comma-joined string fields
 * (modalities/tasks/authors) are the current wire form; #899 does not change them.
 */
const catalogItemObjectSchema = z
  .object({
    dataset_id: z.string(),
    // Aliased `d.dataset_id AS id` on the public branch, but the ?mine=true
    // branch selects dataset_id WITHOUT the alias, so `id` is not universally
    // present. dataset_id is the reliable key; id is optional.
    id: z.string().optional(),
    name: z.string(),
    description: z.string().nullable().optional(),
    status: z.string(),
    visibility: z.string(),
    // #1408: an anonymous deposit is `visibility: "public"` -- listed,
    // browsable, downloadable -- while its depositor is withheld and its
    // repository stays private. So visibility does NOT imply the dataset is
    // attributed, and a consumer that wants to say who deposited something has
    // to read this too. 1 while concealed, 0 otherwise.
    //
    // Optional because this schema also validates rows that predate the
    // column and hand-built payloads in tests; every live projection selects
    // it, the `?mine=true` branch included. A consumer that treats a missing
    // value as "not anonymous" is making the wrong-way assumption -- treat it
    // as unknown.
    anonymous: z.number().int().nullable().optional(),
    // Null for an anonymous deposit unless the reader is its owner or an
    // admin: the identifier is registered `reserved` at EZID, so it does not
    // resolve and must not be cited. The same withholding applies to
    // `github_repo` (not in this schema) and to `external_links` on the data
    // plane. It becomes a real, resolving DOI when the deposit is published.
    concept_doi: z.string().nullable().optional(),
    doi: z.string().nullable().optional(),
    created_at: z.string(),
    updated_at: z.string().optional(),
    // #1477: when the dataset first went public (migration 0085). `sort=newest`,
    // `sort=oldest` and `recent=` read this, falling back to a legacy row's
    // publish_date and then created_at when null (never published, e.g. a
    // `?mine=true` draft). Absent on older backends.
    first_published_at: z.string().nullable().optional(),
    owner_username: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    modalities: z.string().optional(),
    participants: z.number().int().nonnegative(),
    tasks: z.string().optional(),
    authors: z.string().optional(),
    license: z.string().optional(),
    // #895: value is fixed by #970 (epic #967 Phase 3) -- file_size now sources
    // from the version manifest's declared total, not the annex-blind S3-objects
    // sum; the SHAPE was stable throughout and stays so here.
    file_size: z.number().nonnegative(),
    file_size_formatted: z.string().optional(),
    // Honest total file count (manifest-first, S3-sum fallback for pre-manifest
    // datasets), added alongside data_complete/bytes_present in #970. Absent on
    // older backends.
    total_files: z.number().nonnegative().nullable().optional(),
    num_citations: z.number().int().nonnegative().optional(),
    n_channels: z.number().int().nullable().optional(),
    electrode_system: z.string().nullable().optional(),
    has_hed: zeroOneNullable.optional(),
    hed_version: z.string().nullable().optional(),
    // Data completeness of the latest version (#970): 1 = every annex-keyed
    // manifest entry verified present at its declared size, whole or as a complete
    // chunk set (#1565), 0 = incomplete (the #967 signature), null = not audited yet.
    data_complete: zeroOneNullable.optional(),
    // Actual bytes present in S3 (#970) -- distinct from file_size when
    // data_complete=0.
    bytes_present: z.number().nonnegative().nullable().optional(),
    // Canonical output is the vX.Y.Z tag; coercing schema keeps today's bare
    // rows valid. null when the dataset has no published version yet.
    latest_version: versionTagSchema.nullable().optional(),
    // When `latest_version` was released: the `created_at` of its
    // `dataset_versions` row, as SQLite UTC (`YYYY-MM-DD HH:MM:SS`, the same
    // form as `created_at`). `updated_at` is bumped by any row write
    // (enrichment reindex, finalize, DOI callbacks), so it says when the row
    // was last touched, not when the data last changed; this moves only when a
    // new version is released. null when the dataset has no version yet.
    // Absent on older backends.
    latest_version_at: z.string().nullable().optional(),
    // Epic #1144 phase 3 (#1147), D7: every column the facet filter table
    // (shared/facets.ts + backend/src/services/dataset-facets.ts) can filter
    // on is also projected here, raw and nullable -- a facet a caller can
    // filter by but never see the value of is a result set with no way to
    // check. Absent on older backends (additive, passthrough).
    // Raw, un-COALESCEd counterparts of `participants` and `file_size`
    // (#1177 integration review). Those two are display aliases that render an
    // unmeasured NULL as 0, which made `include_unknown=1` return rows whose
    // value was never measured looking like a confident zero. These carry the
    // honest value; the aliases above stay for existing consumers.
    subject_count: z.number().int().nullable().optional(),
    file_size_bytes: z.number().nullable().optional(),
    sessions_count: z.number().int().nullable().optional(),
    age_min: z.number().nullable().optional(),
    age_max: z.number().nullable().optional(),
    bids_version: z.string().nullable().optional(),
    zarr_status: z.enum(["pending", "ready", "failed"]).nullable().optional(),
    // Issue #1062 (epic #1181 phase 2): zarr conversion facts beyond the
    // bare status (migrations 0035/0046; ADR 0034 -- derive, don't add
    // columns, these already exist). zarr_index_url is DERIVED at read time
    // (not a stored column): the absolute <ZARR_HOSTNAME>/<id>/zarr/index.json
    // URL when zarr_status is 'ready', else null.
    zarr_store_count: z.number().int().nullable().optional(),
    zarr_converted_at: z.string().nullable().optional(),
    zarr_source_commit: z.string().nullable().optional(),
    zarr_errors: z.number().int().nullable().optional(),
    zarr_failure_count: z.number().int().nullable().optional(),
    zarr_deterministic: zeroOneNullable.optional(),
    zarr_failed_at: z.string().nullable().optional(),
    zarr_index_url: z.string().nullable().optional(),
    // Issue #1068 (epic #1181 phase 8): the standing fidelity verification
    // sweep's verdict, derived at read time from the JSON sweep_stamps
    // column (ADR 0034/0035, no new column) -- see
    // assertZarrVerifiedAtOnlyWhenStatusKnown below for the invariant. Both
    // stay null/absent until the sweep (daily plus on-demand) reaches a
    // freshly-converted dataset; a client that wants "converted AND
    // verified" filters on `has_zarr_verified` rather than reading these
    // two fields itself.
    zarr_verify_status: z.enum(["verified", "failed", "unverifiable"]).nullable().optional(),
    zarr_verified_at: z.string().nullable().optional(),
    // #1409: when the ARCHIVE last asked for this dataset's stores to be
    // rebuilt, which is a different question from when they were last
    // verified. The only consumer is `scripts/zarr/zarr_queue.py`: the
    // conversion queue's state lives in SQLite on the Hallu node, so this row
    // is the one channel the backend has for "re-convert this one dataset".
    // It exists because de-anonymizing a deposit changes neither the dataset
    // version nor the global engine stamp, which were the only two triggers.
    zarr_requeue_at: z.string().nullable().optional(),
    // #1409: the last anonymity verdict, on the DETAIL route only and only for
    // the owner or an admin. A depositor who deleted the notification mail
    // reads it back with `nemar dataset status`; everyone else is served null,
    // because "this deposit has findings" is itself a fact about the person
    // being concealed.
    anonymity_status: z.enum(["verified", "findings", "unverifiable"]).nullable().optional(),
    anonymity_checked_at: z.string().nullable().optional(),
    /** JSON array as stored; the CLI parses it for display. */
    anonymity_findings: z.string().nullable().optional(),
    anonymity_unchecked: z.string().nullable().optional(),
    total_recording_duration: z.number().nullable().optional(),
    recording_duration_min: z.number().nullable().optional(),
    recording_duration_max: z.number().nullable().optional(),
    recording_count: z.number().int().nullable().optional(),
    recordings_unavailable: z.number().int().nullable().optional(),
    channel_count_min: z.number().int().nullable().optional(),
    channel_count_max: z.number().int().nullable().optional(),
    sampling_frequency: z.number().nullable().optional(),
    power_line_frequency: z.number().nullable().optional(),
    eeg_reference: z.string().nullable().optional(),
    placement_scheme: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * Cross-field contract invariant (PR #1201 review, item 3): `zarr_index_url`
 * is DERIVED at read time (backend/src/routes/datasets/catalog.ts's
 * `deriveZarrIndexUrl`) and must be null/absent unless `zarr_status` is
 * exactly `'ready'` -- the same guard that derivation function itself
 * enforces. Asserting it here at the contract level means a regression in
 * that derivation (or a future write path that sets the two fields
 * independently) fails schema validation instead of silently shipping a
 * URL that points at a store which was never converted. Shared by both
 * `catalogItemSchema` and `datasetDetailSchema` (below) since both carry
 * the pair.
 */
function assertZarrIndexUrlOnlyWhenReady(
  val: { zarr_index_url?: string | null; zarr_status?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (val.zarr_index_url != null && val.zarr_status !== "ready") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "zarr_index_url must be null/absent unless zarr_status is 'ready'",
      path: ["zarr_index_url"],
    });
  }
}

/**
 * Cross-field contract invariant (issue #1068, epic #1181 phase 8):
 * `zarr_verified_at` is a timestamp of the LAST sweep run that produced
 * `zarr_verify_status`, so it must be null/absent whenever the status itself
 * is -- a dataset the sweep has never reached has neither. The reverse is
 * not asserted: a non-null status with a null timestamp would be a stranger
 * bug (the sweep only ever writes both together, see
 * ZARR_FIDELITY_SWEEP_STAMP_SQL), but this direction is the one a producer
 * could plausibly get wrong (stamping a status without its timestamp), so it
 * is the one enforced. Shared by both schemas below, like
 * assertZarrIndexUrlOnlyWhenReady.
 */
function assertZarrVerifiedAtRequiresStatus(
  val: { zarr_verify_status?: string | null; zarr_verified_at?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (val.zarr_verified_at != null && val.zarr_verify_status == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "zarr_verified_at must be null/absent unless zarr_verify_status is non-null",
      path: ["zarr_verified_at"],
    });
  }
}

export const catalogItemSchema = catalogItemObjectSchema.superRefine((val, ctx) => {
  assertZarrIndexUrlOnlyWhenReady(val, ctx);
  assertZarrVerifiedAtRequiresStatus(val, ctx);
});
export type CatalogItem = z.infer<typeof catalogItemObjectSchema>;

/**
 * GET /datasets/:id detail. Backend returns `SELECT d.* , participants,
 * latest_version, owner_username, owner_github` — a superset of the catalog row
 * (#853/#864 parity). Unlike the list query, the detail query does NOT COALESCE
 * the metadata columns, so file_size/modalities/tasks/authors/license come
 * through as raw JSON `null` for an un-backfilled dataset — override them to
 * nullable here (the list schema keeps them strict because the list COALESCEs).
 * Passthrough covers the many other raw `d.*` columns.
 *
 * Extends `catalogItemObjectSchema` -- the PRE-refine object -- rather than
 * `catalogItemSchema` (the exported, refined one): `.extend()` is a
 * `ZodObject` method that `.superRefine()`'s `ZodEffects` wrapper does not
 * have, so the base object is what every consumer of the shared shape
 * extends from; the zarr_index_url/zarr_status invariant is re-applied at
 * the end of this chain instead of inherited.
 */
export const datasetDetailSchema = catalogItemObjectSchema
  .extend({
    file_size: z.number().nonnegative().nullable(),
    // #1224 review: the detail route deliberately keeps the old raw-column
    // shape here -- a string when file_size is measured and positive, null
    // otherwise -- while the list route's toListRow coalesces the same
    // derivation to '' (see catalog.ts's comment on that divergence, right
    // above where `detail` is built). That split predates this contract and
    // the website depends on the detail route's null meaning "unmeasured";
    // widening the contract to describe it is the non-breaking fix, versus
    // changing the detail route's runtime behavior to match the list route,
    // which would be a breaking change for existing consumers. The base
    // object's `z.string().optional()` (no `.nullable()`) stays correct for
    // the list route, which never emits null for this field.
    file_size_formatted: z.string().nullable().optional(),
    modalities: z.string().nullable().optional(),
    tasks: z.string().nullable().optional(),
    authors: z.string().nullable().optional(),
    license: z.string().nullable().optional(),
    owner_github: z.string().nullable().optional(),
    // Deposit attestation (migration 0067). NULL on rows created before the
    // policy, by server-side imports, or by pre-attestation CLIs.
    attestation_deposit_type: z.enum(["owner", "redistribution"]).nullable().optional(),
    attestation_key_status: z.enum(["destroyed", "retained"]).nullable().optional(),
    attestation_deidentified: zeroOneNullable.optional(),
    attestation_no_duplicate: zeroOneNullable.optional(),
    attestation_upstream_source: z.string().nullable().optional(),
    attestation_accepted_at: z.string().nullable().optional(),
    // #1191 (fixes #1188): the stored JSON is parsed server-side into this
    // bounded summary before being served -- never the raw string, and (a
    // legacy shape that should not exist post migration-0074, but is
    // rejected here defensively) never a bare array of per-file entries.
    // detail_ref points at the published Zarr index's `failures` list,
    // which is where the full per-recording detail now lives.
    //
    // `.passthrough()` like every other object here, and for the reason the
    // module doc gives: the contract is a LOWER bound, so an additive backend
    // field never breaks an older client. It was previously the one nested
    // object without it AND without the fields, which is the worst of both --
    // `pending`/`discovered` were written into this object by #1197, and
    // `datasetDetailSchema.parse()` silently stripped them back out, so the
    // counts existed in D1 and reached no consumer.
    //
    // Declaring them is what fixes that; passthrough only stops the next one
    // from being invisible in the same way. Every key below is written by
    // `zarrFailureColumns` (routes/callbacks/zarr-ready.ts) and projected by
    // `parseZarrDataFailures` (routes/datasets/catalog.ts) -- a new key means
    // editing all three, and the round-trip test in
    // backend/test/catalog-has-zarr.test.ts fails when one is missed.
    zarr_data_failures: z
      .object({
        count: z.number().int().nonnegative(),
        detail_ref: z.string(),
        compacted_by: z.string().optional(),
        /** Recordings with no store the converter still expects to convert (#1197). */
        pending: z.number().int().nonnegative().optional(),
        /** Raw recordings the walker found: the coverage denominator (#1197). */
        discovered: z.number().int().nonnegative().optional(),
        /**
         * index.json was published without its sibling. Present only when true;
         * absence reads as "not reported as failed", so a later clean run clears
         * the claim by writing a summary without the key.
         */
        events_upload_failed: z.literal(true).optional(),
        manifest_upload_failed: z.literal(true).optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()
  .superRefine((val, ctx) => {
    assertZarrIndexUrlOnlyWhenReady(val, ctx);
    assertZarrVerifiedAtRequiresStatus(val, ctx);
  });
export type DatasetDetail = z.infer<typeof datasetDetailSchema>;

/**
 * GET /datasets/search hit (reduced projection, services/dataset-search.ts
 * SearchResult). The id is aliased `d.dataset_id AS id` — the wire key is `id`,
 * NOT `dataset_id` — and there is no `latest_version`. The columns are selected
 * raw (no COALESCE), so the string fields can be null; participants (subject_count)
 * can be null too.
 */
export const searchHitSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    modalities: z.string().nullable().optional(),
    participants: z.number().int().nullable().optional(),
    doi: z.string().nullable().optional(),
    tasks: z.string().nullable().optional(),
    authors: z.string().nullable().optional(),
    has_hed: zeroOneNullable.optional(),
    score: z.number().optional(),
    snippet: z.string().optional(),
  })
  .passthrough();
export type SearchHit = z.infer<typeof searchHitSchema>;

/**
 * Epic #1144 phase 4 (#1148), D5: per-facet breakdown of `excluded_unknown`,
 * keyed by `FacetKey` (`shared/facets.ts`) -- how many rows in the WIDENED
 * population are unknown for EACH active facet individually. Buckets do NOT
 * sum to `excluded_unknown`: a row unknown in two active facets counts once
 * toward the total but once in EACH bucket, so `sum(values) >=
 * excluded_unknown`, with equality only when no row is unknown in more than
 * one active facet. A consumer must never present these as a partition of
 * the total. Always present together with `excluded_unknown` (same
 * success/failure gate: both are computed by one query and both are omitted
 * together on failure), never on its own.
 */
const excludedUnknownByFacetSchema = z.record(z.string(), z.number().int().nonnegative());

/** Envelope for GET /datasets. */
export const datasetListEnvelopeSchema = z
  .object({
    datasets: z.array(catalogItemSchema),
    count: z.number().int().nonnegative(),
    total_count: z.number().int().nonnegative().optional(),
    limit: z.number().int().optional(),
    offset: z.number().int().optional(),
    // Epic #1144 phase 3 (#1147), D4/ADR 0005: rows hidden by the default
    // unknown-excluded facet policy -- the count that would have matched
    // with `include_unknown=1`, minus the count that did. Present only when
    // a facet is active; absent (never 0-as-a-substitute) when the widened
    // count itself failed, so its absence never masquerades as "nothing was
    // excluded".
    excluded_unknown: z.number().int().nonnegative().optional(),
    excluded_unknown_by_facet: excludedUnknownByFacetSchema.optional(),
  })
  .passthrough();
export type DatasetListEnvelope = z.infer<typeof datasetListEnvelopeSchema>;

/**
 * Envelope for GET /datasets/search. `count` (#1145, epic #1144 phase 1) is
 * the true total matching the query + filters, independent of page size --
 * and independent of the candidate windows `results` is drawn from, so it
 * can legitimately exceed `candidate_ceiling` (review round 3 C3: `count` is
 * NOT "the same population `results` is sliced from"). `truncated` is a
 * derived convenience: `count > candidate_ceiling`. `warning` is set only
 * when the exact count query itself failed and `count` fell back to a
 * page-derived lower bound (review round 3 I1) -- mirrors
 * datasetListEnvelopeSchema's established `warning` vocabulary.
 * `returned`/`offset`/`limit`/`candidate_ceiling` are additive, mirroring the
 * naming precedent of datasetListEnvelopeSchema above. `method` is one of the
 * five values the backend actually emits (review round 3 I6/I7); still
 * optional since not every historical/degraded response is guaranteed to set it.
 */
export const datasetSearchEnvelopeSchema = z
  .object({
    results: z.array(searchHitSchema),
    count: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative().optional(),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().optional(),
    candidate_ceiling: z.number().int().optional(),
    truncated: z.boolean().optional(),
    method: z.enum(["exact_id", "text", "text_fallback", "semantic", "unavailable"]).optional(),
    min_score: z.number().optional(),
    warning: z.string().optional(),
    // Epic #1144 phase 3 (#1147), D4/ADR 0005: see datasetListEnvelopeSchema's
    // `excluded_unknown` for the exact semantics -- identical field, mirrored
    // here since /datasets/search now shares the same facet engine.
    excluded_unknown: z.number().int().nonnegative().optional(),
    excluded_unknown_by_facet: excludedUnknownByFacetSchema.optional(),
  })
  .passthrough();

/** Envelope for GET /datasets/:id. */
export const datasetDetailEnvelopeSchema = z.object({ dataset: datasetDetailSchema }).passthrough();

/**
 * Envelope for GET /datasets/facets (epic #1144 phase 5a, #1170, D2): the
 * facet vocabulary -- distinct values with counts -- the CLI needs to
 * validate/autocomplete flags like `--task` (1040 distinct labels measured
 * against the real catalog) or `--electrode-system` (six values nobody has
 * written down outside the source) against what the catalog actually
 * contains. Six keys reuse their `shared/facets.ts` FacetKey verbatim as the
 * response key (the four ENUM-kind facets `electrode-system`/`source`/
 * `zarr`/`powerline`, plus the two VERSION-kind facets `bids-version`/
 * `hed-version`); `license`/`modality`/`task` are the pre-existing legacy
 * filters that predate the facet table and never had a FacetKey to reuse.
 *
 * `task` alone carries `distinct_total`/`truncated` instead of a bare array:
 * a truncated list that looks complete is the exact failure mode this
 * endpoint exists to prevent for its 1040 real values.
 *
 * Every key is OPTIONAL and ABSENT (not `[]`) when its backing query failed
 * (D5/ADR 0005) -- `[]` means the query succeeded and found genuinely no
 * values (`hed-version`/`powerline` may legitimately be `[]` today). `warning`
 * is set only when at least one key was omitted this way.
 */
const facetVocabularyEntrySchema = z.object({
  value: z.string(),
  count: z.number().int().nonnegative(),
});

const facetTaskVocabularySchema = z.object({
  values: z.array(facetVocabularyEntrySchema),
  distinct_total: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export const datasetFacetsEnvelopeSchema = z
  .object({
    "electrode-system": z.array(facetVocabularyEntrySchema).optional(),
    source: z.array(facetVocabularyEntrySchema).optional(),
    zarr: z.array(facetVocabularyEntrySchema).optional(),
    powerline: z.array(facetVocabularyEntrySchema).optional(),
    "bids-version": z.array(facetVocabularyEntrySchema).optional(),
    "hed-version": z.array(facetVocabularyEntrySchema).optional(),
    license: z.array(facetVocabularyEntrySchema).optional(),
    modality: z.array(facetVocabularyEntrySchema).optional(),
    task: facetTaskVocabularySchema.optional(),
    warning: z.string().optional(),
  })
  .passthrough();
export type DatasetFacetsEnvelope = z.infer<typeof datasetFacetsEnvelopeSchema>;

/**
 * data.nemar.org landing payload — conforms to neuroschema v0.4.1
 * core/dataset.schema.json. Passthrough + optional on the deep nested blocks
 * (demographics/data_summary/provenance/extensions) which neuroschema fully
 * specifies and the JSON-Schema conformance test enforces; here we pin the
 * required envelope + identity fields.
 */
export const neuroschemaDatasetSchema = z
  .object({
    schema_version: z.literal(NEUROSCHEMA_VERSION),
    doc_type: z.literal("dataset"),
    dataset_id: z.string().regex(/^[a-z]{2}\d+$/, "neuroschema dataset_id pattern"),
    name: z.string(),
    source: datasetSourceSchema,
    recording_modality: z.array(z.string()).min(1),
    description: z.string().nullable().optional(),
    bids_version: z.string().nullable().optional(),
    license: z.string().nullable().optional(),
  })
  .passthrough();
export type NeuroschemaDataset = z.infer<typeof neuroschemaDatasetSchema>;

/**
 * The `session_modalities` key that stands for "this datatype sits directly
 * under the subject, in no session directory" (epic #1586 Phase 2, #1588).
 *
 * It is a key, not a session label, and it can never be mistaken for one:
 * the index only treats `ses-<label>` as a session when the label is
 * alphanumeric (`[A-Za-z0-9]+`), so a label can never contain the hyphen
 * this key does. A reader must therefore look a label up by its own name and
 * ask for this key by name; it must never build a `ses-<key>` identifier from
 * it. It is declared here, once, and everything that reads or writes
 * `session_modalities` imports it, the way every other sentinel in this
 * repository is declared where it is allocated and never guessed at a call
 * site.
 */
export const NO_SESSION_KEY = "no-session";

/** `modalities.<datatype>` of one subject in `bids_index`. */
const bidsIndexModalitySchema = z
  .object({
    tasks: z.record(z.object({ runs: z.array(z.string()) }).passthrough()),
  })
  .passthrough();

/**
 * One subject in `extensions.nemar.bids_index.subjects` of `metadata.json`.
 *
 *  - `sessions`: the subject's session labels (no `ses-` prefix), sorted.
 *  - `modalities`: every datatype directory the subject has, across all of
 *    its sessions, with that datatype's tasks and runs. A set per subject:
 *    it says WHAT the subject has, not in which session.
 *  - `session_modalities` (additive, #1588): which datatypes each session
 *    holds, the pairing `sessions` and `modalities` lose. One key per session
 *    label, plus {@link NO_SESSION_KEY} when the subject has a datatype
 *    directory outside every session directory. Each value is the sorted list
 *    of datatype directories in that session; a session that only has
 *    session-level files (a `scans.tsv`) is present with `[]`. The union of
 *    the values equals the keys of `modalities`, and the keys other than
 *    {@link NO_SESSION_KEY} equal `sessions`.
 *
 *    "Datatype" here means ANY directory name found directly under the
 *    subject or a session directory; it is not checked against the BIDS
 *    datatype list, and neither are the keys of `modalities`. A directory
 *    that is not a session (`ses-pre-op`, whose label is not alphanumeric,
 *    or `sourcedata`) appears as a datatype of that name. A consumer that
 *    needs real datatypes, such as the Neurobagel transform, must filter
 *    against an allowlist of the ones it understands.
 *
 *    A subject with no session directories carries `{ "no-session": [...] }`
 *    rather than an empty map, and that entry is not decoration: an absent or
 *    empty map reads as "not known" or "nothing here", so omitting the entry
 *    would make absence ambiguous and would break the invariant that the
 *    union of the lists equals the keys of `modalities`.
 *
 *    OPTIONAL on purpose: a data plane that predates the field (and any
 *    response cached before it deployed, for up to a minute) does not send
 *    it. A consumer must read an absent key as "not known" and a present one,
 *    including `{}`, as the whole truth. Key order on the wire is not part of
 *    the contract (JavaScript objects serialize integer-like labels such as
 *    `"1"` and `"10"` first and in numeric order); read `sessions` for order.
 */
export const bidsIndexSubjectSchema = z
  .object({
    sessions: z.array(z.string()),
    modalities: z.record(bidsIndexModalitySchema),
    session_modalities: z.record(z.array(z.string())).optional(),
  })
  .passthrough();
// Kept for the Neurobagel transform (epic #1586 Phase 1) to import rather than redeclare
// the shape; today only the builder's compile-time check in data-router.ts uses this one.
export type BidsIndexSubjectWire = z.infer<typeof bidsIndexSubjectSchema>;

/**
 * `extensions.nemar.bids_index` of `metadata.json`: the BIDS subject tree of
 * the dataset's latest version, derived from its manifest. `null` on the wire
 * when no version has a readable manifest, so a consumer parses
 * `bidsIndexSchema.nullable()`.
 *
 * Standalone rather than part of {@link neuroschemaDatasetSchema}: neuroschema
 * declares `extensions.nemar` with `additionalProperties: true` and does not
 * describe this block, so the vendored JSON Schema neither requires nor
 * forbids it, and a live-response check that hard-failed on its shape would
 * turn a cosmetic difference in one dataset into a red contract run.
 */
export const bidsIndexSchema = z
  .object({
    version: z.string(),
    subjects: z.record(bidsIndexSubjectSchema),
  })
  .passthrough();
// No consumer yet; kept for the Neurobagel transform (epic #1586 Phase 1) to import
// rather than redeclare the shape.
export type BidsIndexWire = z.infer<typeof bidsIndexSchema>;
