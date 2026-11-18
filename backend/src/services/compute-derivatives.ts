/**
 * The derivative store (portable compute, card V1b; ADR 0123 as amended 2026-11-16; plan D14): a finished
 * pipeline job's product becomes a keyed, retained derivative in a private bucket of its own.
 *
 *   `syncDerivatives`        one bounded pass: free what is due, key the stamps that have no derivative, and copy
 *   `runComputeDerivativesCron`  the daily call: production only, one `syncDerivatives`
 *   `promoteDerivative`      `canary` to `catalog` (an administrator), `catalog` to `published` (the owner only)
 *   `listDerivatives`, `getDerivativeView`   what an administrator reads
 *
 * THE RULES, each one deliberate:
 *  - DARK UNTIL BOUND. With the derivatives binding or its bucket name absent (or the results or records
 *    binding, or the S3 signer, which a copy needs) every entry point answers `derivatives_unavailable` and
 *    writes nothing. No compute switch is read and none is added: the binding is the switch, and the owner
 *    adds it in a reviewed change.
 *  - THE KEY IS THE CONTRACT'S. `derivativeKey` of `shared/contract/derivatives.ts`, from the stamp's own
 *    columns; the input digest of a Zarr input is RECOMPUTED here with `inputDigestV2` and never the
 *    version 1 `inputDigest`, so nothing is ever keyed under version 1. A first derivative stands: a second
 *    job with the same key adds nothing (`ON CONFLICT(key) DO NOTHING`).
 *  - A STAMP IS KEYED ONLY WHEN EVERY CHECK OF THE ADR HOLDS (`keyStamp`, in the ADR's order). One that fails
 *    a check writes no derivative, is counted under its word and is remembered in `compute_derivative_skips`
 *    so it is not read again; one whose records could not be read is left to the next call. A throw from the
 *    shared contract module ends that one stamp as unkeyable and never the sync.
 *  - IMMUTABLE, AND NEVER DELETED BY CODE WHEN PUBLISHED. Objects are copied once under `d/<key>/`, each
 *    checked against its source by size and etag. Only a `canary` or `catalog` row that is due, or whose
 *    dataset was deleted, is expired: its row is marked `expired` first (one guarded statement that never
 *    selects a `published` row), then its objects are deleted in bounded batches, and the row stays. No
 *    code lowers a class, deletes a row or writes a DOI.
 *  - BOUNDED. A call copies at most `maxObjects` objects (each copy is four subrequests: the source's head,
 *    the copy, the target's head and the count in D1), deletes at most `maxDeletes` keys (a budget of its own,
 *    so a large expiry cannot starve copying, and one R2 delete call takes up to 1,000 keys), and examines at
 *    most `DERIVATIVE_STAMPS_PER_CALL` stamps, because the Worker makes at most 1,000 subrequests per
 *    invocation and the daily tick shares them. The progress is in D1: `copied` is the copy cursor of a row,
 *    a decided stamp leaves the candidate set, and the rows take turns (`last_attempt_at`).
 *  - ISOLATION. The bucket is reached by this binding and by a server-side copy only; no address is ever
 *    signed for it and no route returns an object's bytes. Only `description` (`derivative.json`) is read
 *    back, by an administrator, through the route.
 *  - NOTHING HERE TOUCHES A DOI, GITHUB OR MAIL. A log line carries ids and fixed words, never a path.
 */

import {
  RECIPE_PRODUCT_OUTPUT_PREFIX,
  type RecipeInput,
  findRecipe,
  recipeImageDigestArg,
  recipeRequiredOutputs,
} from "../../../shared/compute-recipes.js";
import { resultsLauncherKey, resultsOutputKey } from "../../../shared/contract/compute-launch.js";
import { LAUNCHER_FILES, ResultManifestSchema } from "../../../shared/contract/compute.js";
import {
  CANARY_DAYS,
  DerivativeContractError,
  type DerivativeKeyFields,
  type RetentionClass,
  SERVING_PROFILE_SENTENCE,
  SUPERSEDED_GRACE_DAYS,
  type StoreRowV2,
  derivativeKey,
  derivativeKeyText,
  inputDigestV2,
  validateDerivativeKeyFields,
} from "../../../shared/contract/derivatives.js";
import { AUDIT_IF_PREVIOUS_CHANGED_SQL, auditLogParams } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import { VERSION_DOI_SQL } from "./anonymity.js";
import {
  PIPELINE_ELIGIBLE_SQL,
  type PipelineEnv,
  VERSION_TAG_SQL,
  pipelineEligibleSql,
} from "./compute-pipeline-eligibility.js";
import { OUTPUTS_BODY_CEILING_BYTES } from "./compute-records.js";
import {
  type ComputeS3,
  ComputeS3Error,
  computeS3,
  copyObject,
  objectKeyProblem,
} from "./compute-s3.js";
import { readDoc, readRecordedSpec } from "./compute-verify.js";
import { isExactProduction } from "./repull-switches.js";

// --- Words and bounds ---------------------------------------------------------------------------------------

/** What a call copies at most when it is not told: each object is one unit. */
export const DERIVATIVE_DEFAULT_MAX_OBJECTS = 100;

/**
 * The most an administrator may ask one call to copy. A copy makes four subrequests (the source's head, the
 * copy, the target's head and the advance of its count in D1) and a Worker invocation makes at most 1,000, so
 * 150 copies are 600 and leave room for the keying reads and the deletes.
 */
export const DERIVATIVE_MAX_OBJECTS = 150;

/** The keys one call deletes at most (one R2 delete call takes up to 1,000), whatever `maxObjects` is. */
export const DERIVATIVE_DELETE_KEYS_PER_CALL = 1000;

/** The turns in a row a copying row may make no progress before it ends `failed` with `copy_failed`. */
export const DERIVATIVE_MAX_ATTEMPTS = 5;

/** The succeeded stamps one call examines at most (about seven reads each, at the worst). */
export const DERIVATIVE_STAMPS_PER_CALL = 20;

/** The failed or expired rows one call cleans at most. */
export const DERIVATIVE_ROWS_PER_CLEANUP = 10;

/** The most a derivative row's objects are named by: `d/<key>/<relative path>`. */
export const DERIVATIVE_OBJECT_PREFIX = "d/";

/** The description a stored derivative carries, beside its files. */
export const DERIVATIVE_DESCRIPTION_FILE = "derivative.json";

/** The first field of the description, so a reader knows which definition it is. */
export const DERIVATIVE_DESCRIPTION_FORMAT = "nemar.derivative.v1";

/** The audit actions of this store: shape and counts only, never a path. */
export const DERIVATIVE_PROMOTE_AUDIT_ACTION = "compute.derivative.promoted";
export const DERIVATIVE_SYNC_AUDIT_ACTION = "compute.derivatives.sync";

/** The recipe's dataset record is at most 256 KB; the read bound is the stamp sync's own. */
const RECORD_READ_MAX_BYTES = 512 * 1024;

/** The recordings table of a dataset of 25,000 stores is a few megabytes; this is a bound, not a size. */
const TABLE_READ_MAX_BYTES = 32 * 1024 * 1024;

/** The most JSON the record's `process` block may be for the description to carry it. */
const PROCESS_BLOCK_MAX_BYTES = 16 * 1024;

/**
 * The failure codes of a recording that a rerun under the same key could differ on (ADR 0123 decision 7): a
 * memory kill, a fault of the recipe's own, the disk, the time budget. A deterministic failure (`load_failed`,
 * `ica_degenerate`) is keyed.
 */
export const TRANSIENT_RECORDING_CODES: readonly string[] = Object.freeze([
  "out_of_memory",
  "internal_error",
  "disk_error",
  "time_budget",
]);

/**
 * Why a stamp is not keyed, one fixed word each. The first group is the ADR's (decision 7, as card V1b item 9
 * orders it); the second is what this store itself cannot read or write. `field` of a refusal is logged
 * beside the word, never in it.
 */
export const UNKEYABLE_WORDS = [
  "no_input_digest",
  "spec_unreadable",
  "recording_subset",
  "table_unreadable",
  "transient_failure",
  "record_unreadable",
  "stores_unread",
  "no_stores_content",
  "stores_differ",
  "undigestable",
  "digest_mismatch",
  "key_invalid",
  "manifest_unreadable",
  "derivative_name_taken",
  "recipe_unknown",
  "dataset_gone",
] as const;

export type UnkeyableWord = (typeof UNKEYABLE_WORDS)[number];

/** What a stamp is remembered as in the skip log: an unkeyable word, or a second stamp of one key. */
export type SkipWord = UnkeyableWord | "duplicate_key";

/** The words a derivative row says it failed with. */
export const DERIVATIVE_FAILURE_WORDS = ["copy_mismatch", "source_missing", "copy_failed"] as const;

export type DerivativeFailure = (typeof DERIVATIVE_FAILURE_WORDS)[number];

export type DerivativeState = "copying" | "stored" | "failed" | "expired";

export interface DerivativeRow {
  key: string;
  dataset_id: string;
  version: string;
  recipe: string;
  recipe_version: string;
  engine: string;
  input: RecipeInput;
  profile: "serving" | "archive";
  input_digest: string;
  image_digest: string;
  job_id: string;
  stamp_id: number;
  state: DerivativeState;
  retention: RetentionClass;
  failure: string | null;
  copied: number;
  object_count: number;
  bytes: number;
  attempts: number;
  last_attempt_at: string | null;
  ended_at: string | null;
  created_at: string;
  stored_at: string | null;
  superseded_at: string | null;
  expires_at: string | null;
  doi: string | null;
}

export const DERIVATIVE_COLUMNS = `key, dataset_id, version, recipe, recipe_version, engine, input, profile,
  input_digest, image_digest, job_id, stamp_id, state, retention, failure, copied, object_count, bytes,
  attempts, last_attempt_at, ended_at, created_at, stored_at, superseded_at, expires_at, doi`;

// --- Availability -------------------------------------------------------------------------------------------

const present = (value: string | undefined): value is string =>
  typeof value === "string" && value.trim() !== "";

/**
 * Whether the derivatives bucket is bound and named: what every read entry point needs. The name must not be
 * the records or the results bucket's own (the signer refuses it too): those are presignable, and the results
 * bucket expires its objects.
 */
export function derivativesBound(env: Bindings): boolean {
  const name = env.COMPUTE_DERIVATIVES_BUCKET_NAME;
  return (
    Boolean(env.COMPUTE_DERIVATIVES) &&
    present(name) &&
    name.trim() !== env.COMPUTE_RECORDS_BUCKET_NAME?.trim() &&
    name.trim() !== env.COMPUTE_RESULTS_BUCKET_NAME?.trim()
  );
}

/** What a sync reaches: the three buckets by binding and the signer for the server-side copy. */
interface Stores {
  results: R2Bucket;
  records: R2Bucket;
  derivatives: R2Bucket;
  s3: ComputeS3;
}

/** The stores a sync needs, or null when any is missing (the store is then dark and writes nothing). */
function storesOf(env: Bindings): Stores | null {
  const s3 = computeS3(env);
  if (
    !derivativesBound(env) ||
    !env.COMPUTE_DERIVATIVES ||
    !env.COMPUTE_RESULTS ||
    !env.COMPUTE_RECORDS ||
    !s3 ||
    s3.derivatives === null
  ) {
    return null;
  }
  return {
    results: env.COMPUTE_RESULTS,
    records: env.COMPUTE_RECORDS,
    derivatives: env.COMPUTE_DERIVATIVES,
    s3,
  };
}

// --- The product ----------------------------------------------------------------------------------------------

/** One file of a job's product: where it is in the results bucket, and where it goes under the key. */
export interface ProductFile {
  /** The manifest's path, `product/<relative path>`. */
  source: string;
  /** The path under `d/<key>/`. */
  path: string;
  size: number;
  sha256: string;
}

type ProductRead = { kind: "ok"; files: ProductFile[] } | { kind: "absent" } | { kind: "invalid" };

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The files of a job's product, from the launcher's manifest in the results bucket, sorted by path (the
 * order `copied` counts in). The product is what the manifest lists under `product/`; the manifest names
 * every output of the job and its own job id, which must be this job's. A throw of the bucket is the
 * caller's (a transient fault).
 */
export async function readProductFiles(results: R2Bucket, jobId: string): Promise<ProductRead> {
  const doc = await readDoc(
    results,
    resultsLauncherKey(jobId, LAUNCHER_FILES.manifest),
    ResultManifestSchema,
    OUTPUTS_BODY_CEILING_BYTES,
  );
  if (doc.kind !== "ok") return { kind: doc.kind };
  if (doc.value.job_id !== jobId) return { kind: "invalid" };
  const files: ProductFile[] = [];
  const seen = new Set<string>();
  for (const f of doc.value.files) {
    if (!f.path.startsWith(RECIPE_PRODUCT_OUTPUT_PREFIX)) continue;
    const path = f.path.slice(RECIPE_PRODUCT_OUTPUT_PREFIX.length);
    if (path.length === 0 || seen.has(path)) return { kind: "invalid" };
    seen.add(path);
    files.push({ source: f.path, path, size: f.size, sha256: f.sha256 });
  }
  if (files.length === 0) return { kind: "invalid" };
  files.sort((a, b) => compareCodeUnits(a.path, b.path));
  return { kind: "ok", files };
}

const objectKeyOf = (key: string, path: string): string =>
  `${DERIVATIVE_OBJECT_PREFIX}${key}/${path}`;

const prefixOf = (key: string): string => `${DERIVATIVE_OBJECT_PREFIX}${key}/`;

// --- Keying ----------------------------------------------------------------------------------------------------

/** A succeeded stamp that has a finished job and no derivative, as the scan reads it. */
interface CandidateStamp {
  id: number;
  dataset_id: string;
  version: string;
  recipe: string;
  recipe_version: string;
  engine: string;
  input: RecipeInput;
  job_id: string;
  input_digest: string | null;
  spec_digest: string;
}

type Keying =
  | {
      kind: "keyed";
      fields: DerivativeKeyFields;
      key: string;
      imageDigest: string;
      objectCount: number;
      bytes: number;
    }
  | { kind: "unkeyable"; word: UnkeyableWord; field?: string }
  | { kind: "later" };

const unkeyable = (word: UnkeyableWord, field?: string): Keying =>
  field === undefined ? { kind: "unkeyable", word } : { kind: "unkeyable", word, field };

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Accept any parsed JSON value: the checks below read only what they name. */
const anyJson = {
  safeParse: (value: unknown) => ({ success: true as const, data: value }),
};

/** The text of a bucket object, at most `maxBytes`: absent, too large, or the text. A bucket throw is the caller's. */
async function readText(
  bucket: R2Bucket,
  key: string,
  maxBytes: number,
): Promise<{ kind: "ok"; text: string } | { kind: "absent" } | { kind: "invalid" }> {
  const head = await bucket.head(key);
  if (!head) return { kind: "absent" };
  if (head.size > maxBytes) return { kind: "invalid" };
  const object = await bucket.get(key);
  if (!object) return { kind: "absent" };
  return { kind: "ok", text: await object.text() };
}

/** Whether the recordings table has a row with a code a rerun could differ on; null when it cannot be read. */
function tableHasTransientCode(text: string): boolean | null {
  const lines = text.split("\n");
  const header = (lines[0] ?? "").replace(/\r$/, "").split("\t");
  const at = header.indexOf("code");
  if (at < 0) return null;
  for (let i = 1; i < lines.length; i++) {
    const line = (lines[i] ?? "").replace(/\r$/, "");
    if (line === "") continue;
    const code = line.split("\t")[at];
    if (code !== undefined && TRANSIENT_RECORDING_CODES.includes(code)) return true;
  }
  return false;
}

/**
 * Decide one stamp, in the order of ADR 0123 decision 7 and card V1b item 9, the first check that fails
 * deciding the word: the stamp states a digest; the spec names no `--recording`; no row of the recordings
 * table has a transient code; for a Zarr input the record's `stores_unread` is an empty list, its
 * `stores_content` a non-empty list, the paths of its rows exactly its `stores` (each once), and the
 * RECOMPUTED `inputDigestV2` of those rows equals the record's `input_digest` and the stamp's; last, the eight
 * key fields are accepted by the contract's validator. Every function of the shared contract module may throw
 * `DerivativeContractError`, and here that is one stamp's `undigestable` or `key_invalid`, never the sync's.
 * A bucket that throws is `later`: nothing is decided from what could not be read.
 */
export async function keyStamp(stores: Stores, stamp: CandidateStamp): Promise<Keying> {
  if (stamp.input_digest === null) return unkeyable("no_input_digest");
  const recipe = findRecipe(stamp.recipe);
  if (recipe === null) return unkeyable("recipe_unknown");
  try {
    // 1. The spec: a subset run would take its full run's key, and the record cannot say it was one.
    const spec = await readRecordedSpec(stores.records, {
      id: stamp.job_id,
      spec_digest: stamp.spec_digest,
    });
    if (spec === null) return unkeyable("spec_unreadable");
    const argv = [...(spec.command ?? []), ...spec.args];
    if (argv.some((a) => a === "--recording" || a.startsWith("--recording="))) {
      return unkeyable("recording_subset");
    }
    const imageDigest = recipeImageDigestArg(spec.args);
    if (imageDigest === null) return unkeyable("spec_unreadable");

    // 2. The recordings table, every row: a rerun under the same key could differ on a transient code.
    const wanted = recipeRequiredOutputs(recipe);
    const table = await readText(
      stores.results,
      resultsOutputKey(stamp.job_id, wanted.table),
      TABLE_READ_MAX_BYTES,
    );
    if (table.kind !== "ok") return unkeyable("table_unreadable");
    const transient = tableHasTransientCode(table.text);
    if (transient === null) return unkeyable("table_unreadable");
    if (transient) return unkeyable("transient_failure");

    // 3. The recipe's own record.
    const recordDoc = await readDoc(
      stores.results,
      resultsOutputKey(stamp.job_id, wanted.record),
      anyJson,
      RECORD_READ_MAX_BYTES,
    );
    if (recordDoc.kind !== "ok") return unkeyable("record_unreadable");
    const nemar = asObject(asObject(asObject(recordDoc.value)?.extensions)?.nemar);

    // 4. A Zarr input: what the run read must be shown whole, and its digest recomputed, version 2 only.
    if (stamp.input === "zarr") {
      const block = asObject(nemar?.input);
      const unread = block?.stores_unread;
      if (!Array.isArray(unread) || unread.length !== 0) return unkeyable("stores_unread");
      const rows = block?.stores_content;
      if (!Array.isArray(rows) || rows.length === 0) return unkeyable("no_stores_content");
      const paths: string[] = [];
      for (const row of rows) {
        const path = asObject(row)?.path;
        if (typeof path !== "string") return unkeyable("stores_differ");
        paths.push(path);
      }
      const named = block?.stores;
      if (!Array.isArray(named) || named.some((p) => typeof p !== "string")) {
        return unkeyable("stores_differ");
      }
      const wantedPaths = [...(named as string[])].sort(compareCodeUnits);
      const gotPaths = [...paths].sort(compareCodeUnits);
      if (
        wantedPaths.length !== gotPaths.length ||
        wantedPaths.some((p, i) => p !== gotPaths[i]) ||
        new Set(gotPaths).size !== gotPaths.length
      ) {
        return unkeyable("stores_differ");
      }
      let digest: string;
      try {
        digest = await inputDigestV2(rows as StoreRowV2[]);
      } catch (err) {
        if (err instanceof DerivativeContractError) return unkeyable("undigestable", err.field);
        throw err;
      }
      if (block?.input_digest !== digest || stamp.input_digest !== digest) {
        return unkeyable("digest_mismatch");
      }
    }

    // 5. The eight fields, and the key. A BIDS stamp's `git:` digest is the stamp's own and is not recomputed.
    const fields = {
      dataset: stamp.dataset_id,
      version: stamp.version,
      recipe: stamp.recipe,
      recipe_version: stamp.recipe_version,
      engine: stamp.engine,
      input: stamp.input,
      profile: stamp.input === "zarr" ? "serving" : "archive",
      input_digest: stamp.input_digest,
    };
    const checked = validateDerivativeKeyFields(fields);
    if (!checked.ok) return unkeyable("key_invalid", checked.field);
    let key: string;
    try {
      key = await derivativeKey(checked.fields);
    } catch (err) {
      if (err instanceof DerivativeContractError) return unkeyable("key_invalid", err.field);
      throw err;
    }

    // 6. The product: what the manifest lists under `product/`, every name one the bucket can hold.
    const product = await readProductFiles(stores.results, stamp.job_id);
    if (product.kind !== "ok") return unkeyable("manifest_unreadable");
    let bytes = 0;
    for (const f of product.files) {
      if (f.path === DERIVATIVE_DESCRIPTION_FILE) return unkeyable("derivative_name_taken");
      if (objectKeyProblem(objectKeyOf(key, f.path)) !== null)
        return unkeyable("manifest_unreadable");
      bytes += f.size;
    }
    if (!Number.isSafeInteger(bytes)) return unkeyable("manifest_unreadable");
    return {
      kind: "keyed",
      fields: checked.fields,
      key,
      imageDigest,
      objectCount: product.files.length,
      bytes,
    };
  } catch (err) {
    if (err instanceof DerivativeContractError) return unkeyable("key_invalid", err.field);
    console.error(
      `[compute-derivatives] key_read_failed stamp=${stamp.id} error=${err instanceof Error ? err.name : typeof err}`,
    );
    return { kind: "later" };
  }
}

// --- Statements ---------------------------------------------------------------------------------------------------

/**
 * The stamps to decide: succeeded, with a finished job, no derivative of their own and no decision in the
 * skip log, whose dataset STILL passes the pipeline eligibility predicate (one that was unpublished, withdrawn,
 * made anonymous or tombstoned after its job finished is neither keyed nor copied), oldest first. `?1` the most
 * to read.
 */
const candidateStampsSql = (
  eligible: string,
): string => `SELECT s.id, s.dataset_id, s.version, s.recipe, s.recipe_version, s.engine,
       s.input, s.job_id, s.input_digest, j.spec_digest
  FROM compute_pipeline_stamps s JOIN compute_jobs j ON j.id = s.job_id
 WHERE s.state = 'succeeded' AND j.state = 'finished'
   AND NOT EXISTS (SELECT 1 FROM compute_derivatives d WHERE d.stamp_id = s.id)
   AND NOT EXISTS (SELECT 1 FROM compute_derivative_skips k WHERE k.stamp_id = s.id)
   AND EXISTS (SELECT 1 FROM datasets d WHERE d.dataset_id = s.dataset_id AND ${eligible})
 ORDER BY s.id ASC LIMIT ?1`;

/** The production text of the scan; an environment gets its own through {@link derivativeSql}. */
export const CANDIDATE_STAMPS_SQL = candidateStampsSql(PIPELINE_ELIGIBLE_SQL);

/**
 * Make a derivative's row: `?1` key, `?2` dataset, `?3` version, `?4` recipe, `?5` recipe version, `?6` engine,
 * `?7` input, `?8` profile, `?9` input digest, `?10` image digest, `?11` job, `?12` stamp, `?13` file count,
 * `?14` bytes. A second job with the same key adds nothing: the first derivative stands. And nothing is made
 * for a dataset that is gone or no longer eligible (a deletion or an unpublish between the scan and the insert): a derivative of a deleted dataset
 * must not outlive the deletion's dating of its rows.
 */
const insertDerivativeSql = (eligible: string): string => `INSERT INTO compute_derivatives
  (key, dataset_id, version, recipe, recipe_version, engine, input, profile, input_digest, image_digest,
   job_id, stamp_id, object_count, bytes)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14
   WHERE EXISTS (SELECT 1 FROM datasets d WHERE d.dataset_id = ?2 AND ${eligible})
  ON CONFLICT(key) DO NOTHING`;

export const INSERT_DERIVATIVE_SQL = insertDerivativeSql(PIPELINE_ELIGIBLE_SQL);

/**
 * Remember a stamp decided without a derivative. `?1` the stamp, `?2` the word. Not for a stamp that has a
 * derivative of its own (a second call made it between the read and here): its row says what became of it.
 */
export const SKIP_STAMP_SQL = `INSERT OR IGNORE INTO compute_derivative_skips (stamp_id, word)
  SELECT ?1, ?2 WHERE NOT EXISTS (SELECT 1 FROM compute_derivatives WHERE stamp_id = ?1)`;

/**
 * Mark every row that is due `expired`, in one statement: not a `published` row, ever, and only a row with a
 * date that has passed. The row's objects are deleted afterwards (`CLEAN_ROWS_SQL`); `copied` becomes the
 * number of objects that may stand, an upper bound, and `ended_at` says when.
 */
export const EXPIRE_DUE_SQL = `UPDATE compute_derivatives
   SET state = 'expired', copied = object_count, ended_at = datetime('now')
 WHERE retention <> 'published' AND state IN ('copying', 'stored')
   AND expires_at IS NOT NULL AND expires_at <= datetime('now')`;

/**
 * Rows that are failed or expired and may still have objects under their prefix, oldest first. `?1` the most.
 * `settled` is 1 once a day has passed since the row ended: only then may an empty listing set `copied` to 0,
 * because a copy that was in flight when the row ended (a copy times out after 30 seconds) can land an object
 * after the first empty listing.
 */
export const CLEAN_ROWS_SQL = `SELECT key, copied,
       (ended_at IS NULL OR ended_at <= datetime('now', '-1 days')) AS settled
  FROM compute_derivatives
 WHERE state IN ('failed', 'expired') AND copied > 0 ORDER BY created_at ASC, key ASC LIMIT ?1`;

/**
 * Rows still copying that nothing has dated (a dated row is expiring, not copying), the row that was worked
 * on longest ago first (a row never worked on first), so rows take turns. `?1` the most.
 */
export const COPYING_ROWS_SQL = `SELECT ${DERIVATIVE_COLUMNS} FROM compute_derivatives
 WHERE state = 'copying' AND expires_at IS NULL
 ORDER BY last_attempt_at IS NOT NULL, last_attempt_at ASC, created_at ASC, key ASC LIMIT ?1`;

/** A row's turn: when the sync last worked on it. `?1` key. */
export const TOUCH_ROW_SQL = `UPDATE compute_derivatives SET last_attempt_at = datetime('now')
 WHERE key = ?1 AND state = 'copying'`;

/** A turn that made no progress for a reason that may pass (a read or a copy that could not be done). `?1` key. */
export const NOTE_FAILED_TURN_SQL = `UPDATE compute_derivatives SET attempts = attempts + 1
 WHERE key = ?1 AND state = 'copying'`;

/**
 * Count one more file copied: only the caller that holds the count, so two syncs cannot both advance it, and
 * never on a row that has been dated (a deletion's dating, or an expiry, ends the copy). Progress sets the
 * failed turns back to 0.
 */
export const ADVANCE_COPIED_SQL = `UPDATE compute_derivatives SET copied = copied + 1, attempts = 0
 WHERE key = ?1 AND state = 'copying' AND copied = ?2 AND expires_at IS NULL`;

/** End a copying row `failed` with a word; its objects are cleaned afterwards. `?1` key, `?2` word. */
export const FAIL_ROW_SQL = `UPDATE compute_derivatives
   SET state = 'failed', failure = ?2, copied = object_count, ended_at = datetime('now')
 WHERE key = ?1 AND state = 'copying'`;

/**
 * Store a row whose files are all copied and whose description is written, and date its life: `canary`
 * expires `CANARY_DAYS` after it is stored. Both times are one `datetime('now')`.
 */
export const STORE_ROW_SQL = `UPDATE compute_derivatives
   SET state = 'stored', stored_at = datetime('now'),
       expires_at = datetime('now', '+${CANARY_DAYS} days')
 WHERE key = ?1 AND state = 'copying' AND copied = object_count AND expires_at IS NULL`;

/**
 * A promotion needs a derivative that is still LIVE: a row whose date has passed (a canary past its 30 days
 * that the sync has not swept yet, or one a dataset's deletion dated to now) is already going and is never
 * kept by a promotion, and neither is a row whose dataset is gone or no longer passes the pipeline eligibility
 * predicate (unpublished, withdrawn, anonymous, tombstoned). A canary always has a date, so for
 * `catalog` the date must be in the future; `published` is raised from a catalog row, which has none or a
 * future one (a superseded row).
 */
const liveSql = (eligible: string): string =>
  `AND EXISTS (SELECT 1 FROM datasets d WHERE d.dataset_id = compute_derivatives.dataset_id AND ${eligible})`;

/** `canary` to `catalog`, only a stored canary row that is not yet due. `?1` key. */
const promoteCatalogSql = (
  eligible: string,
): string => `UPDATE compute_derivatives SET retention = 'catalog', expires_at = NULL
 WHERE key = ?1 AND retention = 'canary' AND state = 'stored'
   AND expires_at > datetime('now') ${liveSql(eligible)}`;

export const PROMOTE_CATALOG_SQL = promoteCatalogSql(PIPELINE_ELIGIBLE_SQL);

/**
 * A later `catalog` row supersedes every other one of its dataset, recipe, input and profile: it is dated
 * `SUPERSEDED_GRACE_DAYS` ahead, once. It runs right after the promotion's audit row and only if that
 * inserted one, which it does only if the promotion changed a row (`changes()`), so a promotion that matched
 * nothing supersedes nothing. `?1` dataset, `?2` recipe, `?3` input, `?4` profile, `?5` the promoted key.
 */
export const SUPERSEDE_CATALOG_SQL = `UPDATE compute_derivatives
   SET superseded_at = datetime('now'), expires_at = datetime('now', '+${SUPERSEDED_GRACE_DAYS} days')
 WHERE dataset_id = ?1 AND recipe = ?2 AND input = ?3 AND profile = ?4
   AND retention = 'catalog' AND superseded_at IS NULL AND key <> ?5 AND changes() > 0`;

/** `catalog` to `published`, only a stored catalog row that is not due; it never expires after this. `?1` key. */
const promotePublishedSql = (
  eligible: string,
): string => `UPDATE compute_derivatives SET retention = 'published', expires_at = NULL
 WHERE key = ?1 AND retention = 'catalog' AND state = 'stored'
   AND (expires_at IS NULL OR expires_at > datetime('now')) ${liveSql(eligible)}`;

export const PROMOTE_PUBLISHED_SQL = promotePublishedSql(PIPELINE_ELIGIBLE_SQL);

/**
 * The four eligibility-bound statements of an environment: production's text, or, in a recognized
 * non-production environment, the one over the widened predicate that lets the compute fixture through.
 * Built per call from the (precomputed) predicate text; the exported constants are production's.
 */
export function derivativeSql(env: PipelineEnv) {
  const eligible = pipelineEligibleSql(env);
  return {
    candidates: candidateStampsSql(eligible),
    insert: insertDerivativeSql(eligible),
    promoteCatalog: promoteCatalogSql(eligible),
    promotePublished: promotePublishedSql(eligible),
  };
}

const BY_KEY_SQL = `SELECT ${DERIVATIVE_COLUMNS} FROM compute_derivatives WHERE key = ?1`;

const looksUnique = (err: unknown, column: string): boolean =>
  new RegExp(`UNIQUE constraint failed: compute_derivatives\\.${column}\\b`, "i").test(String(err));

// --- The sync ------------------------------------------------------------------------------------------------------

export interface DerivativeSyncCounts {
  /** Stamps read for keying. */
  examined: number;
  /** Derivative rows made. */
  created: number;
  /** Stamps whose key a first derivative already holds: nothing was added. */
  duplicate: number;
  /** Stamps skipped, by fixed word (`UnkeyableWord`). */
  derivative_unkeyable: Partial<Record<UnkeyableWord, number>>;
  /** Objects copied this call. */
  copied: number;
  /** Rows that became `stored`. */
  stored: number;
  /** Rows that ended `failed`. */
  failed: number;
  /** Rows marked `expired`. */
  expired: number;
  /** Objects deleted this call, expiry and failure together. */
  deleted: number;
  /** Stamps or rows left to the next call because a read or a copy could not be done. */
  later: number;
  /** Stamps or rows whose handling threw (a database fault, say): left as they were. */
  errored: number;
}

export type DerivativeSyncResult =
  | ({ available: true } & DerivativeSyncCounts)
  | { available: false };

const emptyCounts = (): DerivativeSyncCounts => ({
  examined: 0,
  created: 0,
  duplicate: 0,
  derivative_unkeyable: {},
  copied: 0,
  stored: 0,
  failed: 0,
  expired: 0,
  deleted: 0,
  later: 0,
  errored: 0,
});

interface Budget {
  left: number;
}

/** The two budgets of a call: objects copied, and keys deleted (a budget of its own, see the header). */
interface Budgets {
  copies: Budget;
  deletes: Budget;
}

const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/**
 * Delete up to the budget's worth of keys under a prefix, in one batch of at most 1,000, and say whether
 * none can be left. A throw is the caller's.
 */
async function deleteSome(
  bucket: R2Bucket,
  prefix: string,
  budget: Budget,
): Promise<{ deleted: number; done: boolean }> {
  const limit = Math.min(1000, budget.left);
  if (limit < 1) return { deleted: 0, done: false };
  const listed = await bucket.list({ prefix, limit });
  const keys = listed.objects.map((o) => o.key);
  if (keys.length === 0) return { deleted: 0, done: true };
  await bucket.delete(keys);
  budget.left -= keys.length;
  return { deleted: keys.length, done: !listed.truncated };
}

/**
 * Delete the objects of failed and expired rows, a bounded number a call, and count each row down. An empty
 * listing sets `copied` to 0 only once a day has passed since the row ended (`settled`): before that the row
 * is listed again by a later sync, because a copy that was in flight when it ended can land after this one.
 */
async function cleanRows(
  stores: Stores,
  db: D1Database,
  budget: Budget,
  counts: DerivativeSyncCounts,
): Promise<void> {
  const rows = (
    await db
      .prepare(CLEAN_ROWS_SQL)
      .bind(DERIVATIVE_ROWS_PER_CLEANUP)
      .all<{ key: string; copied: number; settled: number }>()
  ).results;
  for (const row of rows) {
    if (budget.left < 1) return;
    try {
      const { deleted, done } = await deleteSome(stores.derivatives, prefixOf(row.key), budget);
      counts.deleted += deleted;
      if (!done) {
        await db
          .prepare(
            "UPDATE compute_derivatives SET copied = MAX(copied - ?2, 1) WHERE key = ?1 AND state IN ('failed', 'expired')",
          )
          .bind(row.key, deleted)
          .run();
      } else if (row.settled === 1) {
        await db
          .prepare(
            "UPDATE compute_derivatives SET copied = 0 WHERE key = ?1 AND state IN ('failed', 'expired')",
          )
          .bind(row.key)
          .run();
      }
    } catch (err) {
      console.error(
        `[compute-derivatives] clean_failed key=${row.key.slice(0, 12)} error=${errorName(err)}`,
      );
      counts.errored++;
    }
  }
}

/** Remember a stamp decided without a derivative, and count it under its word. */
async function skipStamp(
  db: D1Database,
  stamp: CandidateStamp,
  word: SkipWord,
  counts: DerivativeSyncCounts,
  field?: string,
): Promise<void> {
  await db.prepare(SKIP_STAMP_SQL).bind(stamp.id, word).run();
  if (word === "duplicate_key") {
    counts.duplicate++;
    return;
  }
  counts.derivative_unkeyable[word] = (counts.derivative_unkeyable[word] ?? 0) + 1;
  // The field of the refusal is logged BESIDE the word, never in it, and never a value.
  console.warn(
    `[compute-derivatives] derivative_unkeyable stamp=${stamp.id} dataset=${stamp.dataset_id} word=${word}${
      field === undefined ? "" : ` field=${field}`
    }`,
  );
}

/** Decide up to `DERIVATIVE_STAMPS_PER_CALL` stamps, each in its own try so one bad one cannot hold the rest. */
async function keyNewStamps(
  env: Bindings,
  stores: Stores,
  db: D1Database,
  counts: DerivativeSyncCounts,
): Promise<void> {
  const sql = derivativeSql(env);
  const candidates = (
    await db.prepare(sql.candidates).bind(DERIVATIVE_STAMPS_PER_CALL).all<CandidateStamp>()
  ).results;
  for (const stamp of candidates) {
    counts.examined++;
    try {
      const decision = await keyStamp(stores, stamp);
      if (decision.kind === "later") {
        counts.later++;
        continue;
      }
      if (decision.kind === "unkeyable") {
        await skipStamp(db, stamp, decision.word, counts, decision.field);
        continue;
      }
      const f = decision.fields;
      let inserted: D1Result;
      try {
        inserted = await db
          .prepare(sql.insert)
          .bind(
            decision.key,
            f.dataset,
            f.version,
            f.recipe,
            f.recipe_version,
            f.engine,
            f.input,
            f.profile,
            f.input_digest,
            decision.imageDigest,
            stamp.job_id,
            stamp.id,
            decision.objectCount,
            decision.bytes,
          )
          .run();
      } catch (err) {
        // Another call made this stamp's own row between the read and the insert: it is made, not an error.
        if (!looksUnique(err, "stamp_id")) throw err;
        counts.duplicate++;
        continue;
      }
      if ((inserted.meta?.changes ?? 0) > 0) {
        counts.created++;
        continue;
      }
      // Nothing was added: the key is held by a first derivative, the dataset is gone, or the dataset became
      // ineligible (unpublished or withdrawn) between the scan and this insert. Only the first two are final: an
      // ineligible dataset can become eligible again, so its stamp is left undecided for a later scan, which
      // applies the same eligibility rule and keys it once the dataset qualifies.
      const held = await db
        .prepare("SELECT 1 AS held FROM compute_derivatives WHERE key = ?1")
        .bind(decision.key)
        .first<{ held: number }>();
      if (!held) {
        const exists = await db
          .prepare("SELECT 1 AS present FROM datasets WHERE dataset_id = ?1")
          .bind(stamp.dataset_id)
          .first<{ present: number }>();
        if (exists) continue;
      }
      await skipStamp(db, stamp, held ? "duplicate_key" : "dataset_gone", counts);
    } catch (err) {
      console.error(`[compute-derivatives] stamp_failed stamp=${stamp.id} error=${errorName(err)}`);
      counts.errored++;
    }
  }
}

/** End a copying row `failed` with a word and clean what it had copied, within what is left of the budget. */
async function failRow(
  stores: Stores,
  db: D1Database,
  row: DerivativeRow,
  word: DerivativeFailure,
  budgets: Budgets,
  counts: DerivativeSyncCounts,
): Promise<void> {
  const ended = await db.prepare(FAIL_ROW_SQL).bind(row.key, word).run();
  if ((ended.meta?.changes ?? 0) > 0) {
    counts.failed++;
    console.warn(
      `[compute-derivatives] derivative_failed key=${row.key.slice(0, 12)} dataset=${row.dataset_id} word=${word}`,
    );
  }
  await cleanRows(stores, db, budgets.deletes, counts);
}

/**
 * A turn that made no progress for a reason that may pass (a copy the interface refused, a target the binding
 * does not see): counted `later`, and the row stays `copying` to be tried again, until it has failed
 * `DERIVATIVE_MAX_ATTEMPTS` turns in a row, when it ends `failed` with `copy_failed` and is no longer a copying
 * row for good. `attempts` is the count as it stands after this call's own progress.
 */
async function failedTurn(
  stores: Stores,
  db: D1Database,
  row: DerivativeRow,
  attempts: number,
  budgets: Budgets,
  counts: DerivativeSyncCounts,
): Promise<void> {
  counts.later++;
  if (attempts + 1 >= DERIVATIVE_MAX_ATTEMPTS) {
    await failRow(stores, db, row, "copy_failed", budgets, counts);
    return;
  }
  await db.prepare(NOTE_FAILED_TURN_SQL).bind(row.key).run();
}

/**
 * A copy that landed after its row ended must not be forgotten: when the count could not be advanced (or the
 * row could not be stored) and the row has meanwhile ended `failed` or `expired`, the object just written is
 * deleted, because the cleanup of that row may already have listed its prefix for the last time.
 */
async function dropLateObject(
  stores: Stores,
  db: D1Database,
  row: DerivativeRow,
  objectKey: string,
): Promise<void> {
  const now = await getDerivative(db, row.key);
  if (now !== null && (now.state === "failed" || now.state === "expired")) {
    await stores.derivatives.delete(objectKey);
  }
}

/** `derivative.json`: what the derivative is, so it never stands without saying what it was made from. */
async function describe(
  stores: Stores,
  db: D1Database,
  row: DerivativeRow,
  files: ProductFile[],
): Promise<string | null> {
  const recipe = findRecipe(row.recipe);
  if (recipe === null) return null;
  const wanted = recipeRequiredOutputs(recipe);
  const recordDoc = await readDoc(
    stores.results,
    resultsOutputKey(row.job_id, wanted.record),
    anyJson,
    RECORD_READ_MAX_BYTES,
  );
  if (recordDoc.kind !== "ok") return null;
  const stated = asObject(asObject(asObject(recordDoc.value)?.extensions)?.nemar)?.process;
  const processBlock =
    asObject(stated) !== null && JSON.stringify(stated).length <= PROCESS_BLOCK_MAX_BYTES
      ? stated
      : null;
  // The version DOI is read through the repository's one rule (`VERSION_DOI_SQL`, which withholds it from an
  // anonymous dataset: its identifier is reserved and does not resolve), never by hand. The description is
  // an administrator's, but a citation that names an unresolvable identifier would be wrong all the same.
  const versionRow = await db
    .prepare(
      `SELECT ${VERSION_DOI_SQL} FROM dataset_versions dv JOIN datasets d ON d.dataset_id = dv.dataset_id
        WHERE dv.dataset_id = ?1 AND ${VERSION_TAG_SQL("dv.version")} = ?2
        ORDER BY dv.id ASC LIMIT 1`,
    )
    .bind(row.dataset_id, row.version)
    .first<{ doi: string | null }>();
  const doi =
    typeof versionRow?.doi === "string" && /^10\.[0-9]{4,9}\/[!-~]{1,200}$/.test(versionRow.doi)
      ? versionRow.doi
      : null;
  const fields: DerivativeKeyFields = {
    dataset: row.dataset_id,
    version: row.version,
    recipe: row.recipe,
    recipe_version: row.recipe_version,
    engine: row.engine,
    input: row.input,
    profile: row.profile,
    input_digest: row.input_digest,
  };
  const citation = `Derived from ${row.dataset_id} version ${row.version}${
    doi === null ? "" : ` (DOI ${doi})`
  } by NEMAR's ${row.recipe} ${row.recipe_version}.`;
  const description: Record<string, unknown> = {
    format: DERIVATIVE_DESCRIPTION_FORMAT,
    key_text: derivativeKeyText(fields),
    key: row.key,
    GeneratedBy: {
      recipe: row.recipe,
      recipe_version: row.recipe_version,
      engine: row.engine,
      image_digest: row.image_digest,
      job_id: row.job_id,
      process: processBlock,
    },
    SourceDatasets: [{ id: row.dataset_id, version: row.version, doi }],
    Profile: row.profile,
    ...(row.profile === "serving" ? { Description: SERVING_PROFILE_SENTENCE } : {}),
    Citation: citation,
    files: files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
  };
  return `${JSON.stringify(description, null, 2)}\n`;
}

/** Copy a copying row's files within the budget, each checked, and store it when all are in and described. */
async function copyRow(
  stores: Stores,
  db: D1Database,
  row: DerivativeRow,
  budgets: Budgets,
  counts: DerivativeSyncCounts,
): Promise<void> {
  // The row's turn: rows are worked on by the longest wait, so ten that cannot be copied starve nothing.
  await db.prepare(TOUCH_ROW_SQL).bind(row.key).run();
  const product = await readProductFiles(stores.results, row.job_id);
  if (product.kind !== "ok") return failRow(stores, db, row, "source_missing", budgets, counts);
  const files = product.files;
  if (files.length !== row.object_count) {
    return failRow(stores, db, row, "copy_mismatch", budgets, counts);
  }
  let copied = row.copied;
  let attempts = row.attempts;
  while (copied < files.length && budgets.copies.left > 0) {
    const file = files[copied] as ProductFile;
    const sourceKey = resultsOutputKey(row.job_id, file.source);
    const targetKey = objectKeyOf(row.key, file.path);
    const source = await stores.results.head(sourceKey);
    if (!source) return failRow(stores, db, row, "source_missing", budgets, counts);
    // The platform verified the declared sizes when the job ended; a source that no longer says so is not copied.
    if (source.size !== file.size) {
      return failRow(stores, db, row, "copy_mismatch", budgets, counts);
    }
    try {
      await copyObject(
        stores.s3,
        { bucket: "results", key: sourceKey },
        { bucket: "derivatives", key: targetKey },
      );
    } catch (err) {
      if (!(err instanceof ComputeS3Error)) throw err;
      // The code and the HTTP status of the refusal: the message holds no key and no secret.
      console.error(
        `[compute-derivatives] copy_failed key=${row.key.slice(0, 12)} code=${err.code}${
          err.status === undefined ? "" : ` status=${err.status}`
        }`,
      );
      return failedTurn(stores, db, row, attempts, budgets, counts);
    }
    budgets.copies.left--;
    const target = await stores.derivatives.head(targetKey);
    if (!target) {
      // A copy the interface accepted that the binding cannot see: the binding and the bucket name do not
      // name one bucket, or the store is slow to show it. That is not a bad copy, so the row is not failed
      // for it (a failed row is final for its key): it waits and is tried again.
      console.error(`[compute-derivatives] target_missing key=${row.key.slice(0, 12)}`);
      return failedTurn(stores, db, row, attempts, budgets, counts);
    }
    if (target.size !== source.size || target.etag !== source.etag) {
      return failRow(stores, db, row, "copy_mismatch", budgets, counts);
    }
    const advanced = await db.prepare(ADVANCE_COPIED_SQL).bind(row.key, copied).run();
    if ((advanced.meta?.changes ?? 0) === 0) {
      // Another call, or an expiry, or a dataset's deletion, took the row: this call stops on it, and an object
      // it just wrote under a row that has ended is not left behind.
      await dropLateObject(stores, db, row, targetKey);
      return;
    }
    copied++;
    attempts = 0;
    counts.copied++;
  }
  if (copied < files.length) return;
  const text = await describe(stores, db, row, files);
  if (text === null) return failRow(stores, db, row, "source_missing", budgets, counts);
  const descriptionKey = objectKeyOf(row.key, DERIVATIVE_DESCRIPTION_FILE);
  await stores.derivatives.put(descriptionKey, text, {
    httpMetadata: { contentType: "application/json" },
  });
  const stored = await db.prepare(STORE_ROW_SQL).bind(row.key).run();
  if ((stored.meta?.changes ?? 0) > 0) counts.stored++;
  else await dropLateObject(stores, db, row, descriptionKey);
}

export interface DerivativeSyncOptions {
  /** Objects copied at most this call. Default 100, at most `DERIVATIVE_MAX_OBJECTS`. */
  maxObjects?: number;
  /** Keys deleted at most this call, a budget of its own. Default and most `DERIVATIVE_DELETE_KEYS_PER_CALL`. */
  maxDeletes?: number;
}

/** A requested bound as a whole number from 1 to `most`, the default when none was asked for. */
const bounded = (requested: number | undefined, fallback: number, most: number): number => {
  const value = requested ?? fallback;
  return Math.max(1, Math.min(most, Number.isFinite(value) ? Math.floor(value) : 1));
};

/**
 * One bounded pass over the store: mark what is due `expired` and delete the objects of failed and expired rows,
 * decide the stamps that have no derivative (a row for each keyable one), and copy. Nothing here throws for a
 * stamp or a row: each is handled in its own try and counted. With the store dark it answers
 * `{ available: false }` and writes nothing.
 */
export async function syncDerivatives(
  env: Bindings,
  options: DerivativeSyncOptions = {},
): Promise<DerivativeSyncResult> {
  const stores = storesOf(env);
  if (stores === null) return { available: false };
  const budgets: Budgets = {
    copies: {
      left: bounded(options.maxObjects, DERIVATIVE_DEFAULT_MAX_OBJECTS, DERIVATIVE_MAX_OBJECTS),
    },
    deletes: {
      left: bounded(
        options.maxDeletes,
        DERIVATIVE_DELETE_KEYS_PER_CALL,
        DERIVATIVE_DELETE_KEYS_PER_CALL,
      ),
    },
  };
  const db = env.DB;
  const counts = emptyCounts();

  // 1. What is due goes: the date passes (or the dataset was deleted), the row stays. Deleting has a budget
  //    of its own, so a large expiry cannot take the copies' turn.
  try {
    const due = await db.prepare(EXPIRE_DUE_SQL).run();
    counts.expired = due.meta?.changes ?? 0;
    await cleanRows(stores, db, budgets.deletes, counts);
  } catch (err) {
    console.error(`[compute-derivatives] expire_failed error=${errorName(err)}`);
    counts.errored++;
  }

  // 2. The stamps that have no derivative are decided, and a keyable one gets its row.
  try {
    await keyNewStamps(env, stores, db, counts);
  } catch (err) {
    console.error(`[compute-derivatives] scan_failed error=${errorName(err)}`);
    counts.errored++;
  }

  // 3. Rows copy, the row that waited longest first, with what is left of the copy budget.
  try {
    const rows = (
      await db.prepare(COPYING_ROWS_SQL).bind(DERIVATIVE_ROWS_PER_CLEANUP).all<DerivativeRow>()
    ).results;
    for (const row of rows) {
      if (budgets.copies.left < 1) break;
      try {
        await copyRow(stores, db, row, budgets, counts);
      } catch (err) {
        console.error(
          `[compute-derivatives] row_failed key=${row.key.slice(0, 12)} error=${errorName(err)}`,
        );
        counts.errored++;
        // A turn that threw is a turn without progress: it counts toward the row's tries.
        await db
          .prepare(NOTE_FAILED_TURN_SQL)
          .bind(row.key)
          .run()
          .catch(() => undefined);
      }
    }
  } catch (err) {
    console.error(`[compute-derivatives] copy_scan_failed error=${errorName(err)}`);
    counts.errored++;
  }
  return { available: true, ...counts };
}

/**
 * The daily call: production only (it refuses anywhere else by itself, and the cron places it in the
 * production block too), one `syncDerivatives` with the default budget. Null when it did not run.
 */
export async function runComputeDerivativesCron(
  env: Bindings,
): Promise<DerivativeSyncResult | null> {
  if (!isExactProduction(env)) return null;
  const result = await syncDerivatives(env, { maxObjects: DERIVATIVE_DEFAULT_MAX_OBJECTS });
  return result.available ? result : null;
}

/** The one log line of a daily call, only when something happened: counts, never a key or a path. */
export function derivativesLogLine(
  result: DerivativeSyncResult,
): { level: "error" | "log"; line: string } | null {
  if (!result.available) return null;
  const unkeyable = Object.values(result.derivative_unkeyable).reduce((a, b) => a + (b ?? 0), 0);
  const active =
    result.created +
    result.duplicate +
    unkeyable +
    result.copied +
    result.stored +
    result.failed +
    result.expired +
    result.deleted +
    result.later +
    result.errored;
  if (active === 0) return null;
  return {
    level: result.errored > 0 ? "error" : "log",
    line:
      `[compute-derivatives] examined=${result.examined} created=${result.created} duplicate=${result.duplicate} ` +
      `unkeyable=${unkeyable} copied=${result.copied} stored=${result.stored} failed=${result.failed} ` +
      `expired=${result.expired} deleted=${result.deleted} later=${result.later} errored=${result.errored}`,
  };
}

// --- Reading -------------------------------------------------------------------------------------------------------

/** The most rows a listing returns. */
export const DERIVATIVE_LIST_MAX = 200;

/** A dataset's derivatives (or every one), newest first. */
export async function listDerivatives(
  db: D1Database,
  filter: { dataset?: string; limit?: number },
): Promise<DerivativeRow[]> {
  const limit = Math.min(DERIVATIVE_LIST_MAX, Math.max(1, filter.limit ?? 50));
  const statement =
    filter.dataset === undefined
      ? db
          .prepare(
            `SELECT ${DERIVATIVE_COLUMNS} FROM compute_derivatives ORDER BY created_at DESC, key ASC LIMIT ?1`,
          )
          .bind(limit)
      : db
          .prepare(
            `SELECT ${DERIVATIVE_COLUMNS} FROM compute_derivatives WHERE dataset_id = ?1
              ORDER BY created_at DESC, key ASC LIMIT ?2`,
          )
          .bind(filter.dataset, limit);
  return (await statement.all<DerivativeRow>()).results;
}

export async function getDerivative(db: D1Database, key: string): Promise<DerivativeRow | null> {
  return db.prepare(BY_KEY_SQL).bind(key).first<DerivativeRow>();
}

/**
 * One derivative as an administrator reads it: its row and, when it is stored, its description (`derivative.json`
 * parsed). A description that cannot be read is `null`, and nothing else of the bucket is ever returned.
 */
export async function getDerivativeView(
  env: Bindings,
  key: string,
): Promise<{ row: DerivativeRow; description: unknown } | null> {
  const row = await getDerivative(env.DB, key);
  if (row === null) return null;
  let description: unknown = null;
  if (row.state === "stored" && env.COMPUTE_DERIVATIVES) {
    try {
      const object = await env.COMPUTE_DERIVATIVES.get(
        objectKeyOf(row.key, DERIVATIVE_DESCRIPTION_FILE),
      );
      if (object) description = JSON.parse(await object.text());
    } catch (err) {
      // The row is still answered; the description is null, and why is logged (the error's name, never a key).
      console.error(
        `[compute-derivatives] description_unreadable key=${row.key.slice(0, 12)} error=${errorName(err)}`,
      );
      description = null;
    }
  }
  return { row, description };
}

// --- Promotion -----------------------------------------------------------------------------------------------------

export type PromoteResult =
  | { ok: true; row: DerivativeRow }
  | {
      ok: false;
      code: "derivatives_unavailable" | "owner_only" | "derivative_not_found" | "not_promotable";
    };

/**
 * Raise a derivative's class, one step: `catalog` (any administrator, only a stored `canary` row; every other
 * `catalog` row of its dataset, recipe, input and profile is superseded in the same batch) or `published`
 * (the OWNER only, only a stored `catalog` row). No path lowers a class. THE OWNER RULE IS HERE and nowhere
 * else, before any row is read, so no route can forget it; the audit row is written in the same batch and only
 * if the promotion changed a row.
 */
export async function promoteDerivative(
  env: Bindings,
  input: { key: string; to: "catalog" | "published"; userId: number; role: string },
): Promise<PromoteResult> {
  if (!derivativesBound(env)) return { ok: false, code: "derivatives_unavailable" };
  if (input.to === "published" && input.role !== "owner") return { ok: false, code: "owner_only" };
  const db = env.DB;
  const row = await getDerivative(db, input.key);
  if (row === null) return { ok: false, code: "derivative_not_found" };
  const from = input.to === "catalog" ? "canary" : "catalog";
  if (row.retention !== from || row.state !== "stored")
    return { ok: false, code: "not_promotable" };
  const sql = derivativeSql(env);
  const audit = db.prepare(AUDIT_IF_PREVIOUS_CHANGED_SQL).bind(
    ...auditLogParams({
      userId: input.userId,
      action: DERIVATIVE_PROMOTE_AUDIT_ACTION,
      resourceType: "compute_derivative",
      resourceId: input.key,
      details: JSON.stringify({ from, to: input.to }),
    }),
  );
  const results =
    input.to === "catalog"
      ? await db.batch([
          db.prepare(sql.promoteCatalog).bind(input.key),
          audit,
          db
            .prepare(SUPERSEDE_CATALOG_SQL)
            .bind(row.dataset_id, row.recipe, row.input, row.profile, row.key),
        ])
      : await db.batch([db.prepare(sql.promotePublished).bind(input.key), audit]);
  const now = await getDerivative(db, input.key);
  if ((results[0]?.meta?.changes ?? 0) === 0 || now === null) {
    return { ok: false, code: now === null ? "derivative_not_found" : "not_promotable" };
  }
  return { ok: true, row: now };
}
