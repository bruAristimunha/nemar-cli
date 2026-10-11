/**
 * Dataset metadata column helpers (epic #417 phase 2).
 *
 * Computes and persists the first-class metadata columns added to the
 * `datasets` table by migration 0020: subject_count, modalities, age_min,
 * age_max, file_size, total_files, tasks, metadata_updated_at.
 *
 * Source data is reused from existing helpers — see references on each
 * field — so the two callers (the LLM enrichment webhook and the
 * post-version-DOI metadata refresh) compute identical values.
 *
 * NULL semantics: when an input is missing, the corresponding output field
 * is null rather than 0/"" so downstream queries can distinguish
 * "not populated yet" from "really zero".
 */

import { licenseTier } from "../lib/license.js";
import { ANONYMOUS_AUTHORS_LABEL } from "./anonymity.js";
import { countSubjectDirs, extractTasks, parseParticipantsTsv } from "./bids-tree.js";
import { detectModalitiesFromTree } from "./datacite.js";
import type { DatasetVersionIntegrityResult } from "./import-integrity.js";

export interface DatasetMetadataColumns {
  subject_count: number | null;
  modalities: string | null;
  age_min: number | null;
  age_max: number | null;
  file_size: number | null;
  total_files: number | null;
  tasks: string | null;
  /** Representative EEG channel count (#854/#858). */
  n_channels: number | null;
  /** Scalp montage class: 10-20|10-10|10-05|biosemi|egi-geodesic|other (#854/#858). */
  electrode_system: string | null;
  /** `SamplingFrequency` (Hz) from the preferred `*_eeg.json` sidecar (epic
   *  #1144 Phase 2b, #1153). Serves `signal_defaults.sampling_frequency`.
   *  One exemplar sidecar's declared value, not a verified per-dataset
   *  aggregate -- see migration 0072's caveat. */
  sampling_frequency: number | null;
  /** `PowerLineFrequency` (Hz), coerced to exactly 50 or 60 (#1153). Serves
   *  `signal_defaults.power_line_frequency`. */
  power_line_frequency: number | null;
  /** `EEGReference` from the preferred sidecar (#1153). Serves
   *  `signal_defaults.reference`; named `eeg_reference` to avoid the SQL
   *  keyword. */
  eeg_reference: string | null;
  /** `EEGPlacementScheme` from the preferred sidecar (#1153). Serves
   *  `signal_defaults.placement_scheme`. */
  placement_scheme: string | null;
  /** HED presence as 0/1, or null when not classified yet (#869). */
  has_hed: number | null;
  /** Declared `HEDVersion` (array form comma-joined), or null (#869). */
  hed_version: string | null;
  /** Actual bytes present in S3, from the same LIST used to verify
   *  completeness -- distinct from file_size when data_complete=0 (#970). */
  bytes_present: number | null;
  /** Data completeness, or null when not audited yet (#970). */
  data_complete: 0 | 1 | null;
}

export interface MetadataColumnInputs {
  /** Paths of all files in the dataset tree (used for modality and task detection). */
  treePaths: string[];
  /** Raw contents of participants.tsv at the same ref, or null if absent. */
  participantsTsv: string | null;
  /** S3 size and object count, or null if the lookup failed/was skipped. */
  s3Stats: { totalSize: number; objectCount: number | undefined } | null;
  /**
   * Modalities resolved truncation-immune via `getBidsTreeStats` (#820).
   * When provided (non-empty) this is authoritative and replaces detection from
   * `treePaths` -- which can be a truncated git tree missing every raw
   * `sub-<id>/<datatype>/` path. Omit/empty to fall back to the path-list detector.
   */
  modalities?: string[];
  /**
   * Complete root-level `sub-*` count from `getBidsTreeStats` (#827). The
   * truncated `treePaths` can drop every raw subject dir (on006110 -> NULL), so
   * when provided (> 0) this wins over `countSubjectDirs(treePaths)`. Omit/0 to
   * fall back to the tree-path count (then participants.tsv).
   */
  subjectCount?: number;
  /**
   * Task labels from `getBidsTreeStats` (#827, sampled subjects). UNIONed with
   * the tree-path tasks rather than replacing them: the sample can miss a task
   * present only in unsampled subjects, and the (possibly truncated) tree still
   * carries derivative task labels, so union never loses one.
   */
  tasks?: string[];
  /**
   * Representative EEG channel count from `getBidsTreeStats` (#858, exemplar
   * `*_channels.tsv` / `*_eeg.json`). Omit when no EEG recording was sampled.
   */
  nChannels?: number;
  /**
   * Scalp montage class from `getBidsTreeStats` (#858). Omit when undetermined.
   */
  electrodeSystem?: string;
  /**
   * `SamplingFrequency` (Hz) from `getBidsTreeStats`'s root-preferred `*_eeg.json`
   * sidecar (#1153). Omit when no sidecar was sampled or the key was
   * absent/invalid. One exemplar sidecar's declared value, not a verified
   * per-dataset aggregate -- see migration 0072's caveat.
   */
  samplingFrequency?: number;
  /**
   * `PowerLineFrequency` (Hz) from `getBidsTreeStats`, already coerced to
   * exactly 50 or 60 (#1153). Omit when absent or out-of-enum.
   */
  powerLineFrequency?: number;
  /**
   * `EEGReference` from `getBidsTreeStats`'s preferred sidecar (#1153). Omit
   * when absent, non-string, or the BIDS "n/a" placeholder.
   */
  eegReference?: string;
  /**
   * `EEGPlacementScheme` from `getBidsTreeStats`'s preferred sidecar (#1153).
   * Omit when absent or the "n/a" placeholder.
   */
  placementScheme?: string;
  /**
   * HED presence from `getBidsTreeStats` probeHed (#869): true/false when the ref
   * was probed, omit when the probe couldn't run (-> column stays NULL).
   */
  hasHed?: boolean;
  /**
   * Declared `HEDVersion` string from probeHed (#869). Omit when none.
   */
  hedVersion?: string;
  /**
   * The full result of a `verifyDatasetVersionS3` check (#970), collapsed into
   * ONE optional object rather than three independent optional fields --
   * verifyDatasetVersionS3 either fully resolves a manifest and returns all
   * three together, or it doesn't and returns none, so a caller can never
   * legitimately have e.g. `complete` without `totals`. Splitting them back
   * into independent optionals would make that invalid combination
   * representable again (and it happened: an earlier version of this type let
   * a caller pass `dataComplete` with no `manifestTotals`, producing
   * data_complete=1 while file_size stayed null -- a state the column's own
   * doc says shouldn't exist). Omit the whole object for a pre-manifest
   * dataset or an unverifiable one; `s3Stats` (the S3-objects sum) is then the
   * only available signal for file_size/total_files/bytes_present, and
   * data_complete stays NULL (not audited).
   */
  manifestVerification?: {
    /** Honest declared totals: summed `files[].size` (declared size, not what's
     *  actually in S3) and the key count. WINS over `s3Stats` for
     *  file_size/total_files. */
    totals: { bytes: number; files: number };
    /** Actual bytes present in S3, from the same LIST used to check
     *  completeness. WINS over `s3Stats.totalSize` for bytes_present. Visually
     *  distinct from `totals.bytes` (declared) so the two are never transposed
     *  at the call site. */
    bytesPresent: number;
    /** Whether every annex-keyed manifest entry is present at its declared size,
     *  whole or as a complete chunk set (`verifyDatasetVersionS3().complete`). */
    complete: boolean;
  };
}

/**
 * Pure transformation from collected inputs to the column shape.
 *
 * The truncation-immune `getBidsTreeStats` overrides (#827, #820) take
 * precedence over the `treePaths`-derived values when supplied, since a
 * truncated git tree can drop every raw `sub-*` path:
 * - subject_count: the `subjectCount` override when > 0; else the count of
 *   root-level `sub-*` dirs via `countSubjectDirs` (#759); else the
 *   participants.tsv row count. age_min / age_max derive from participants.tsv
 *   via `parseParticipantsTsv` (`backend/src/services/bids-tree.ts`).
 * - modalities: the `modalities` override when non-empty; else
 *   `detectModalitiesFromTree` (`backend/src/services/datacite.ts`), sorted CSV.
 * - tasks: the `tasks` override UNIONed with `extractTasks(treePaths)`
 *   (`backend/src/services/bids-tree.ts`) so neither a missed sample subject
 *   nor a truncated tree loses one; else just the tree-path tasks. Sorted, deduped.
 * - file_size / total_files / bytes_present / data_complete: the honest
 *   `manifestVerification` result (#970) when available; else
 *   `getDatasetS3Stats` output (`backend/src/services/s3.ts:251`) for
 *   file_size/total_files/bytes_present on a pre-manifest dataset, and
 *   data_complete stays null (not audited).
 */
export function computeDatasetMetadataColumns(input: MetadataColumnInputs): DatasetMetadataColumns {
  // Prefer the truncation-immune walk result (#820); fall back to detecting
  // from the (possibly truncated) tree path list when it wasn't supplied.
  const modalitiesArr = input.modalities?.length
    ? [...new Set(input.modalities)].sort()
    : input.treePaths.length
      ? [...detectModalitiesFromTree(input.treePaths)].sort()
      : [];
  // tasks: union the truncation-immune walk result (#827) with the tree-path
  // tasks so neither a missed sample subject nor a truncated tree loses one.
  const treeTasks = input.treePaths.length ? extractTasks(input.treePaths) : [];
  const tasksArr = input.tasks?.length
    ? [...new Set([...input.tasks, ...treeTasks])].sort()
    : treeTasks;

  // subject_count: prefer the BIDS-canonical count of root-level sub-* dirs in
  // the tree (#759). participants.tsv is an enrolled roster that can be far
  // larger than the released subjects (on005752: 1859 rows vs 251 sub-* dirs),
  // so it is only the fallback when the tree has no resolvable subjects (e.g.
  // the placeholder-participants path). age_min/age_max still come from
  // participants.tsv, which carries the per-subject demographics.
  // Prefer the complete walk count (#827): the truncated treePaths can drop
  // every raw sub-* dir (on006110 -> 0/NULL). Fall back to the tree-path count
  // (then participants.tsv) only when the walk didn't supply one.
  const subjectDirCount =
    input.subjectCount && input.subjectCount > 0
      ? input.subjectCount
      : input.treePaths.length
        ? countSubjectDirs(input.treePaths)
        : 0;

  let ageMin: number | null = null;
  let ageMax: number | null = null;
  let participantsRowCount = 0;
  if (input.participantsTsv) {
    const stats = parseParticipantsTsv(input.participantsTsv);
    participantsRowCount = stats.count;
    ageMin = stats.ageMin;
    ageMax = stats.ageMax;
  }
  // count=0 maps to null so the column reflects "not populated yet" rather than
  // "really zero subjects".
  const subjectCount: number | null =
    subjectDirCount > 0 ? subjectDirCount : participantsRowCount > 0 ? participantsRowCount : null;

  return {
    subject_count: subjectCount,
    modalities: modalitiesArr.length ? modalitiesArr.join(",") : null,
    age_min: ageMin,
    age_max: ageMax,
    // Manifest-first (#970 honest size), S3-objects-sum fallback for
    // pre-manifest datasets.
    file_size: input.manifestVerification
      ? input.manifestVerification.totals.bytes
      : (input.s3Stats?.totalSize ?? null),
    total_files: input.manifestVerification
      ? input.manifestVerification.totals.files
      : (input.s3Stats?.objectCount ?? null),
    tasks: tasksArr.length ? tasksArr.join(",") : null,
    n_channels: input.nChannels ?? null,
    electrode_system: input.electrodeSystem ?? null,
    sampling_frequency: input.samplingFrequency ?? null,
    power_line_frequency: input.powerLineFrequency ?? null,
    eeg_reference: input.eegReference ?? null,
    placement_scheme: input.placementScheme ?? null,
    // Tri-state via `== null` (intentionally catches undefined AND null): probe
    // didn't run -> null = not classified yet; false -> 0 = checked, no HED;
    // true -> 1 = checked, has HED.
    has_hed: input.hasHed == null ? null : input.hasHed ? 1 : 0,
    hed_version: input.hedVersion ?? null,
    bytes_present: input.manifestVerification
      ? input.manifestVerification.bytesPresent
      : (input.s3Stats?.totalSize ?? null),
    // Same tri-state idiom as has_hed: not verified -> null; verified
    // incomplete -> 0; verified complete -> 1.
    data_complete:
      input.manifestVerification == null ? null : input.manifestVerification.complete ? 1 : 0,
  };
}

/**
 * Persist the computed columns to D1. Updates metadata_updated_at to now().
 *
 * COALESCE semantics: a NULL input means "no fresh measurement for this
 * field", so the existing column value is preserved. This lets callers
 * partially refresh — e.g., if the S3 lookup failed, file_size/total_files
 * are NULL on the input and the previously-stored values stay intact rather
 * than being silently overwritten with NULL.
 *
 * The metadata_updated_at timestamp always advances, so operators can still
 * see when the most recent refresh attempt ran.
 */
export async function writeDatasetMetadataColumns(
  db: D1Database,
  datasetId: string,
  cols: DatasetMetadataColumns,
): Promise<{ changes: number }> {
  const result = await db
    .prepare(
      `UPDATE datasets
       SET subject_count = COALESCE(?, subject_count),
           modalities = COALESCE(?, modalities),
           age_min = COALESCE(?, age_min),
           age_max = COALESCE(?, age_max),
           file_size = COALESCE(?, file_size),
           total_files = COALESCE(?, total_files),
           tasks = COALESCE(?, tasks),
           n_channels = COALESCE(?, n_channels),
           electrode_system = COALESCE(?, electrode_system),
           sampling_frequency = COALESCE(?, sampling_frequency),
           power_line_frequency = COALESCE(?, power_line_frequency),
           eeg_reference = COALESCE(?, eeg_reference),
           placement_scheme = COALESCE(?, placement_scheme),
           has_hed = COALESCE(?, has_hed),
           hed_version = COALESCE(?, hed_version),
           bytes_present = COALESCE(?, bytes_present),
           data_complete = COALESCE(?, data_complete),
           sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.metadata_updated_at', datetime('now')),
           updated_at = datetime('now')
       WHERE dataset_id = ?`,
    )
    .bind(
      cols.subject_count,
      cols.modalities,
      cols.age_min,
      cols.age_max,
      cols.file_size,
      cols.total_files,
      cols.tasks,
      cols.n_channels,
      cols.electrode_system,
      cols.sampling_frequency,
      cols.power_line_frequency,
      cols.eeg_reference,
      cols.placement_scheme,
      cols.has_hed,
      cols.hed_version,
      cols.bytes_present,
      cols.data_complete,
      datasetId,
    )
    .run();

  // D1 returns meta.changes = 0 when the WHERE clause matched no rows.
  // Surface that explicitly: a 0-row update is almost always a race with
  // dataset deletion or a dataset_id mismatch, and the project rule against
  // silent failures requires we log it.
  const changes = result.meta?.changes ?? 0;
  if (changes === 0) {
    console.warn(
      `[metadata-columns] No rows updated for ${datasetId} - dataset may have been deleted or renamed`,
    );
  }
  return { changes };
}

/**
 * Persist HED detection to the per-version `dataset_versions` row (#869). This is
 * the source of truth per version; the `datasets.has_hed/hed_version` columns
 * (written by writeDatasetMetadataColumns) denormalize only the latest version.
 *
 * Direct assignment, NOT COALESCE: a version's content is immutable, so the
 * freshly-probed values are authoritative for that row. No `updated_at` bump
 * (dataset_versions has none). Callers only invoke this once they HAVE a
 * classification (`hasHed` non-null); a probe that didn't run leaves the row
 * NULL for the phase-3 sweep to fill.
 *
 * When `version` is null the latest-by-`created_at` row is targeted -- the same
 * "latest" definition the /datasets projection and data-router use.
 */
export async function writeVersionHed(
  db: D1Database,
  datasetId: string,
  version: string | null,
  hasHed: number,
  hedVersion: string | null,
): Promise<{ changes: number }> {
  const result = await db
    .prepare(
      `UPDATE dataset_versions
       SET has_hed = ?, hed_version = ?
       WHERE dataset_id = ?
         AND version = COALESCE(
           ?,
           (SELECT version FROM dataset_versions WHERE dataset_id = ?
            ORDER BY created_at DESC LIMIT 1)
         )`,
    )
    .bind(hasHed, hedVersion, datasetId, version, datasetId)
    .run();

  const changes = result.meta?.changes ?? 0;
  if (changes === 0) {
    // error (not warn): dataset_versions is the per-version source of truth with
    // no COALESCE safety net, so a 0-row write means the HED data is lost until a
    // re-probe -- worth surfacing above warn-level noise.
    console.error(
      `[metadata-columns] No dataset_versions row updated for ${datasetId} version=${version ?? "latest"} - per-version HED not persisted`,
    );
  }
  return { changes };
}

/**
 * Persist honest size/completeness to the per-version `dataset_versions` row
 * (#970, epic #967 Phase 3). This is the source of truth per version; the
 * `datasets.file_size/total_files/bytes_present/data_complete` columns
 * (written by writeDatasetMetadataColumns) denormalize only the latest version.
 *
 * Direct assignment, NOT COALESCE: a version's content is immutable, so a
 * fresh verification is authoritative for that row -- mirrors writeVersionHed.
 * No `updated_at` bump (dataset_versions has none). When `version` is null the
 * latest-by-`created_at` row is targeted, the same "latest" definition the
 * /datasets projection and data-router use.
 */
export async function writeVersionSize(
  db: D1Database,
  datasetId: string,
  version: string | null,
  cols: {
    file_size: number | null;
    total_files: number | null;
    bytes_present: number | null;
    data_complete: number | null;
  },
): Promise<{ changes: number }> {
  const result = await db
    .prepare(
      `UPDATE dataset_versions
       SET file_size = ?, total_files = ?, bytes_present = ?, data_complete = ?
       WHERE dataset_id = ?
         AND version = COALESCE(
           ?,
           (SELECT version FROM dataset_versions WHERE dataset_id = ?
            ORDER BY created_at DESC LIMIT 1)
         )`,
    )
    .bind(
      cols.file_size,
      cols.total_files,
      cols.bytes_present,
      cols.data_complete,
      datasetId,
      version,
      datasetId,
    )
    .run();

  const changes = result.meta?.changes ?? 0;
  if (changes === 0) {
    // error (not warn): dataset_versions is the per-version source of truth with
    // no COALESCE safety net, so a 0-row write means the honest-size data is lost
    // until a re-verify -- worth surfacing above warn-level noise.
    console.error(
      `[metadata-columns] No dataset_versions row updated for ${datasetId} version=${version ?? "latest"} - per-version size not persisted`,
    );
  }
  return { changes };
}

/**
 * Stamp a dataset's completeness columns from an already-computed
 * {@link DatasetVersionIntegrityResult} (or null when no verification could be
 * attempted). Shared source of truth for every caller that resolves a
 * completeness result -- the data-integrity-sweep, the forced-verify route,
 * and the retry engine's recover/reclassify paths (epic #967 Phase 3
 * follow-up, issue #980) -- so they all stamp identically instead of each
 * hand-rolling the write order.
 *
 * `integrity.version` set: writes the per-version `dataset_versions` row
 * FIRST via {@link writeVersionSize}, then the `datasets` row LAST. Order is
 * deliberate for recoverability -- a failure between the two leaves the
 * dataset unstamped, so a plain re-run redoes both rather than leaving a
 * split state where `dataset_versions` is fresh but `datasets` stays stale.
 *
 * DELIBERATE CHOICE: if `writeVersionSize` matches 0 rows (no such
 * `dataset_versions` row -- e.g. the version was never recorded, or
 * `datasetId`/`version` diverge from what's on file), `datasets` is stamped
 * ANYWAY. The `integrity` result reflects a real, fresh S3 measurement
 * independent of whether a `dataset_versions` row exists for it, so
 * `datasets` (the catalog's source of truth for the LATEST version) is
 * correct to update regardless; the divergence itself is logged (not
 * silently swallowed -- `writeVersionSize` already errors on its own 0-row
 * case, but this adds an explicit line naming the datasets/dataset_versions
 * split so it isn't lost among per-write logs).
 *
 * `integrity` null, or has no resolvable `version` (verify threw, or no
 * manifest could be resolved): completeness can't be classified this pass, so
 * only `data_checked_at` advances -- an existing `data_complete` value is left
 * untouched (never nulled), since a transient verify miss must not clobber a
 * classification a prior pass (or the reindex/enrichment path) already wrote.
 */
export async function stampDatasetIntegrity(
  db: D1Database,
  datasetId: string,
  integrity: DatasetVersionIntegrityResult | null,
): Promise<"complete" | "incomplete" | "unknown"> {
  if (integrity?.version) {
    const dataCompleteInt = integrity.complete ? 1 : 0;
    const versionWrite = await writeVersionSize(db, datasetId, integrity.version, {
      file_size: integrity.declaredBytes,
      total_files: integrity.declaredFiles,
      bytes_present: integrity.bytesPresent,
      data_complete: dataCompleteInt,
    });
    if (versionWrite.changes === 0) {
      console.error(
        `[stamp] datasets stamped but no dataset_versions row for ${datasetId}@${integrity.version} - per-version completeness absent`,
      );
    }
    await db
      .prepare(
        `UPDATE datasets
         SET file_size = ?, total_files = ?, data_complete = ?, bytes_present = ?,
             sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.data_checked_at', datetime('now'))
         WHERE dataset_id = ?`,
      )
      .bind(
        integrity.declaredBytes,
        integrity.declaredFiles,
        dataCompleteInt,
        integrity.bytesPresent,
        datasetId,
      )
      .run();
    return integrity.complete ? "complete" : "incomplete";
  }

  await db
    .prepare(
      "UPDATE datasets SET sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.data_checked_at', datetime('now')) WHERE dataset_id = ?",
    )
    .bind(datasetId)
    .run();
  return "unknown";
}

/** Max readme length stored on `datasets.readme` (matches the 0028 fold's substr). */
const README_MAX = 8192;

/**
 * Fact columns written directly to the `datasets` source of truth by the
 * enrichment/reindex hooks (#646 Phase 2 dual-write). Complements
 * writeDatasetMetadataColumns (which owns subject_count/modalities/age/
 * file_size/total_files/tasks) -- no column overlap. Every field is optional
 * and COALESCE-preserved, so a hook that lacks a value (e.g. reindex has no
 * LLM authors) leaves the existing column untouched. `name`/`description` are
 * preserved too: a reindex without a fresh LLM title must not clobber a better
 * one. `datasets` is the single source of truth (#646).
 */
export interface DatasetCatalogFields {
  name?: string | null;
  description?: string | null;
  authors?: string | null;
  license?: string | null;
  readme?: string | null;
  bids_version?: string | null;
  /**
   * Distinct `ses-*` directory count from the BIDS tree, computed by the
   * enrich/reindex hooks via `countSessionDirs` (#657). Null when the dataset
   * has no `ses-*` layer, so COALESCE preserves any value backfilled from the
   * legacy catalog rather than overwriting it with 0.
   */
  sessions_count?: number | null;
}

export async function writeDatasetCatalogFields(
  db: D1Database,
  datasetId: string,
  fields: DatasetCatalogFields,
): Promise<{ changes: number }> {
  const readme = fields.readme != null ? fields.readme.slice(0, README_MAX) : null;
  // Derive the license tier from the same value being written so license and
  // license_tier never drift (#653). Bound as NULL when no license is supplied,
  // so the COALESCE preserves the existing tier rather than clobbering it to
  // 'unknown' on a license-less update.
  const licenseTierValue = fields.license != null ? licenseTier(fields.license) : null;
  const result = await db
    .prepare(
      // `authors` is withheld for an anonymous deposit HERE, in the single
      // UPDATE, rather than at the caller (#1407). This is the only writer of
      // the column in the backend, and the column is fed into `datasets_fts`
      // by a trigger with no visibility predicate -- so a filter applied
      // anywhere else would leave the real names searchable in the index
      // while the API dutifully hid them, and a blind applied at the caller
      // would be a rule the next caller could forget. Deciding it in SQL from
      // the row itself means there is no argument a caller can get wrong.
      `UPDATE datasets
       SET name = COALESCE(?, name),
           description = COALESCE(?, description),
           authors = CASE WHEN anonymous = 1 THEN ? ELSE COALESCE(?, authors) END,
           license = COALESCE(?, license),
           license_tier = COALESCE(?, license_tier),
           readme = COALESCE(?, readme),
           bids_version = COALESCE(?, bids_version),
           sessions_count = COALESCE(?, sessions_count),
           updated_at = datetime('now')
       WHERE dataset_id = ?`,
    )
    .bind(
      fields.name ?? null,
      fields.description ?? null,
      ANONYMOUS_AUTHORS_LABEL,
      fields.authors ?? null,
      fields.license ?? null,
      licenseTierValue,
      readme,
      fields.bids_version ?? null,
      fields.sessions_count ?? null,
      datasetId,
    )
    .run();

  const changes = result.meta?.changes ?? 0;
  if (changes === 0) {
    console.warn(
      `[catalog-fields] No rows updated for ${datasetId} - dataset may have been deleted or renamed`,
    );
  }
  return { changes };
}

/**
 * Extract a comma-joined author string from an enrichment_json blob.
 * The enrichment pipeline stores authors as `{ "First Last": { ... }, ... }`
 * (object form, ORCID/affiliation as the value) for most datasets and an
 * array of `{name, ...}` objects for some legacy rows. Returns null when
 * the shape is unrecognized or empty so the COALESCE in
 * writeDatasetCatalogFields preserves the existing value.
 */
export function authorsFromEnrichment(
  enrichment: { authors?: unknown } | null | undefined,
): string | null {
  if (!enrichment) return null;
  const raw = enrichment.authors;
  if (raw == null) return null;
  let names: string[] = [];
  if (Array.isArray(raw)) {
    names = raw
      .map((a) => {
        if (typeof a === "string") return a;
        if (a && typeof a === "object" && "name" in a && typeof a.name === "string") return a.name;
        return null;
      })
      .filter((n): n is string => Boolean(n?.trim()));
  } else if (typeof raw === "object") {
    names = Object.keys(raw as Record<string, unknown>).filter((n) => n.trim());
  }
  return names.length > 0 ? names.join(", ") : null;
}
