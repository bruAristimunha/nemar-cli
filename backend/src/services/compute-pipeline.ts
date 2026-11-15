/**
 * NEMAR's own pipeline dispatch (epic #2005 phase A6, #2011; ADR 0118; design section 10): run a
 * processing recipe over one version of one public EEG dataset through the compute gateway, leave one
 * stamp per dataset version, recipe, recipe version, engine and input so the queue knows what is current,
 * and read the stamps back to their end.
 *
 *   `dispatchPipelineJob`   claim the stamp, resolve the recipe into a complete job, make the job and
 *                           its hold (`createJob`), link the stamp, and submit (`submitComputeJob`)
 *   `syncPipelineStamps`    move `dispatched` stamps to `succeeded` or `failed` from their job's end
 *   `listPipelineStamps`    a page of stamps, filtered, after a sync
 *   `pipelineCandidates`    the eligible datasets a recipe has not been run over at their newest version
 *   `dispatchEligible`      a run over the next `limit` of them, each through `dispatchPipelineJob`
 *   `pipelineDryRun`        what a run would dispatch, the estimated SU, and what blocks the rest; reads only
 *
 * THE RULES, each one deliberate:
 *  - THE WORKER SUPPLIES THE FACTS, NEVER THE REQUEST. The dataset row (eligibility, ADR 0065: the
 *    stored `anonymous` column and nothing a caller says), the version row, the service account, the
 *    pool and the runtime image all come from the Worker's own tables and configuration. A request names
 *    a recipe, a dataset and optionally a version; it names nothing else.
 *  - THE RECIPE IS RESOLVED BEFORE `createJob` (the phase's amendment of 2026-11-04). The job is made
 *    from a complete specification: the recipe's name beside the runtime (`image`), NEMAR's own runtime
 *    image (`COMPUTE_RUNTIME_IMAGE`, a digest-pinned reference), the command, and the arguments with
 *    the image digest. So `spec.json`, `spec_digest` and `launch_spec_digest` describe what actually
 *    ran, and no recipe job ever exists in a form the launch-specification builder would refuse. The
 *    recipe is never run with an image other than the one its `--image-digest` names: the digest is
 *    taken from the same reference the job's `image` is, and the Worker compares it with the
 *    launcher's provenance before it accepts a result (`verifyResults`).
 *  - THE STAMP IS CLAIMED FIRST. A `dispatched` row for the tuple is inserted before anything else is
 *    written, and a partial unique index refuses a second live or succeeded row for one tuple, so two
 *    runs racing for a tuple produce one stamp and one job. The tuple names the INPUT the run reads
 *    (`bids` or `zarr`, plan D12): a recipe's two inputs are two tuples, so a BIDS run and a Zarr run of
 *    one dataset version coexist. A refused hold ends the stamp `refused` with the ledger's word; nothing
 *    else is left (the job's creation is atomic with its hold).
 *  - ONE KEY FOR ONE ATTEMPT. The job's idempotency key is made from the tuple and the attempt number,
 *    so a crash between the job's creation and the stamp's link is found again by the key: the sync
 *    links the job instead of failing the stamp.
 *  - THE STAMP SAYS WHAT RAN. It is claimed with the recipe table's version and engine and, when the
 *    job succeeds, rewritten from the recipe's own dataset record (`readRecipeRecord`), which also gives it
 *    what the run READ: the reader, the Zarr engine and the input digest of a Zarr run, the source commit
 *    of a BIDS run (`stampInputFields`; a value that does not fit its column is never stored). A record
 *    that is missing, unreadable, or names another recipe ends the stamp `failed`; the job is untouched. A
 *    record that names another input than the stamp claimed ends the stamp `failed` with `tuple_mismatch`, which
 *    holds the claimed tuple (a stamp that says what ran never says "read zarr" of a run that read another input).
 *  - NOTHING HERE TOUCHES GITHUB OR MAIL. A run reaches D1, the compute buckets and Tapis, all through
 *    the gateway's own services.
 */

import {
  type ComputeRecipe,
  type RecipeExecutor,
  type RecipeInput,
  type RecipeRecord,
  type ZarrCommitAttestation,
  defaultInput,
  findRecipe,
  readRecipeRecord,
  recipeArguments,
  recipeCommand,
  recipeRequiredOutputs,
  recipeRunsInput,
  recipeRunsOn,
  recipeZarrArguments,
  recipeZarrBase,
  stampInputFields,
} from "../../../shared/compute-recipes.js";
import { PLATFORM_FAILURE_CODES } from "../../../shared/compute-state.js";
import {
  COMPUTE_PIPELINE_RUN_PER_INVOCATION,
  type ComputePipelineLimitedBy,
} from "../../../shared/contract/compute-admin.js";
import { resultsOutputKey } from "../../../shared/contract/compute-launch.js";
import {
  type ComputePolicy,
  type ComputePool,
  JobSpecSchema,
  PARTITIONS,
  PIPELINES_TAPIS_OWNER,
  type PartitionName,
  dataTagForVersion,
  estimateSuMilli,
  runnersPolicyOf,
} from "../../../shared/contract/compute.js";
import type { Bindings } from "../types/bindings.js";
import {
  ComputeJobError,
  type ComputeJobRow,
  type CreateJobRefusal,
  JOB_BY_KEY_SQL,
  PIPELINE_LIVE_JOBS_SQL,
  RUNNER_LIVE_JOBS_SQL,
  createJob,
} from "./compute-jobs.js";
import {
  type SubmitOutcome,
  submitComputeJob,
  tapisSubmitConfigured,
} from "./compute-lifecycle.js";
import {
  NEWEST_VERSION_SQL,
  PIPELINE_ELIGIBLE_SQL,
  PIPELINE_ELIGIBLE_SQL_NONPROD,
  PIPELINE_ROW_COLUMNS,
  type PipelineRow,
  type PipelineTermId,
  type PipelineVersion,
  VERSIONS_OF_SQL,
  VERSION_TAG_SQL,
  failedPipelineTerms,
  isPipelineEligible,
  loadPipelineRow,
  pickVersion,
  pipelineTermsFor,
} from "./compute-pipeline-eligibility.js";
import { getPolicy } from "./compute-policy.js";
import { sha256Hex } from "./compute-records.js";
import { readRuntimeImage } from "./compute-runtime-image.js";
import { computeEnabled, computeRunnersEnabled } from "./compute-switches.js";
import { tenantFacts, tenantRoom } from "./compute-tenant.js";
import { isNonProductionEnv } from "./environment.js";
import { checkZarrSource } from "./zarr-source-check.js";

// --- Words ------------------------------------------------------------------------------------------

/** The username of the service account NEMAR's own jobs are made for: the same literal as the Tapis owner. */
export const PIPELINES_ACCOUNT_USERNAME = PIPELINES_TAPIS_OWNER;

/**
 * The most entries one dataset's manifest may hold for a launcher to stage it: the data plane's own
 * bound (`MAX_MANIFEST_JSON_ENTRIES` of routes/data.ts, which a test holds this to).
 */
export const PIPELINE_MANIFEST_MAX_ENTRIES = 38_000;

/** A stamp whose claim was never followed by a job is failed after this many minutes. */
export const STAMP_NO_JOB_MINUTES = 30;

/**
 * INITIAL values (the issue states none; the owner adjusts them with the pilot). A tuple whose stamp
 * failed is not a candidate of the queue for this many days, and not at all once it has failed this
 * many times, so a head of failing datasets cannot take every slot of every run.
 */
export const RETRY_COOLDOWN_DAYS = 7;
export const MAX_FAILED_ATTEMPTS = 3;

/**
 * Platform failure words that happen AFTER the run consumed service units: the job ran, then its results
 * could not be taken or checked. Re-dispatching on the next day would spend the pool again with no
 * cooldown, so these count toward the cooldown and the cap like a dataset's own failure (ADR 0118, review
 * fixes of 2026-11-06). A failed job that was charged anything counts the same whatever its word, which
 * the queue reads from the linked job row ({@link CHARGED_FAILURE_SQL}); a failure before any charge
 * (staging, `tapis_submit_failed`) stays an immediate candidate.
 */
export const CONSUMED_FAILURE_WORDS: readonly string[] = [
  "result_upload_failed",
  "result_verification_failed",
  // The job may have run for real; its record is gone and nothing was charged, so it cannot be told apart.
  "tapis_record_lost",
];

/**
 * The words of a `failed` stamp that are NOT the dataset's doing, so they never count toward the cooldown
 * or the cap: the platform's own failure codes (`PLATFORM_FAILURE_CODES`: Tapis, staging, launch, archive,
 * verification, records, and the launcher's fetch and upload codes, whose detail is not kept on the
 * stamp), a cancel, and the words this file writes for its own faults and the registry's: the claim never
 * followed by a job (`no_job`), a job row that is gone (`job_missing`), a creation that threw
 * (`create_failed`), a recipe the table no longer names (`recipe_unknown`), and the tuple words
 * (`tuple_mismatch`, a hold; `tuple_already_stamped` and `tuple_attempt_taken`, a run that was good). Three transient database errors
 * on three days must not shut a dataset out until its version changes. What remains counts: the
 * submitter-side launcher codes (`runtime_error`, `time_limit`, `out_of_memory`, `entry_not_found`), a
 * job that failed with no word we know (`job_failed`), and the recipe's own output faults
 * (`outputs_missing`, `record_unreadable`, `record_mismatch`).
 */
export const NON_DATASET_FAILURE_WORDS: readonly string[] = [
  ...PLATFORM_FAILURE_CODES.filter((w) => !CONSUMED_FAILURE_WORDS.includes(w)),
  "job_cancelled",
  "no_job",
  "job_missing",
  "create_failed",
  "recipe_unknown",
  "tuple_mismatch",
  "tuple_already_stamped",
  "tuple_attempt_taken",
  // GitHub or the serving index could not be read: nothing was learned of the dataset (it is a pre-claim
  // refusal and writes no stamp today; the word is listed so that a path that did would not count it).
  "zarr_source_unverifiable",
];

/** The list as SQL: fixed words of this tree, never a caller's. */
const NON_DATASET_FAILURE_SQL = NON_DATASET_FAILURE_WORDS.map((w) => `'${w}'`).join(", ");

/**
 * A failed stamp counts (cooldown and cap) when its word is the dataset's, or when its linked job failed
 * after being charged. `x` is the stamp alias; the job is read by the stamp's `job_id`.
 */
const COUNTS_AS_FAILURE_SQL = (x: string): string =>
  `(${x}.refusal_code NOT IN (${NON_DATASET_FAILURE_SQL})
    OR EXISTS (SELECT 1 FROM compute_jobs cj
                WHERE cj.id = ${x}.job_id AND cj.state = 'failed' AND cj.charged_milli > 0))`;

/** Stamps one sync examines at most. */
export const SYNC_STAMPS_PER_CALL = 50;

/** The words a dispatch refuses with, before or after the claim. The first group is `COMPUTE_REFUSAL_CODES`. */
export type PipelineRefusal =
  | "compute_disabled"
  | "recipe_unknown"
  | "dataset_not_eligible"
  | "pipelines_account_missing"
  | "live_attempt_exists"
  | "runtime_unavailable"
  | "version_not_found"
  | "version_untagged"
  | "too_many_files"
  | "zarr_version_not_newest"
  | "zarr_copy_not_ready"
  | "zarr_source_mismatch"
  | "zarr_source_unverifiable"
  | "recipe_not_automatic"
  | "recipe_placeholder"
  | "runners_disabled"
  | "tapis_unconfigured"
  | "registry_drift"
  | "daily_cap_reached"
  | "run_failed"
  | "create_failed"
  | CreateJobRefusal;

/** What the cron or an administrator is acting as. A cron may dispatch only an automatic recipe. */
export type PipelineActor = { kind: "admin"; userId: number } | { kind: "cron" };

export interface DispatchInput {
  recipe: string;
  datasetId: string;
  /** Any spelling the data plane takes (`1.0.2`, `v1.0.2`, `latest`); the newest version when absent. */
  version?: string;
  actor: PipelineActor;
  /**
   * Who runs the job (ADR 0121): `tapis` when absent. A recipe lists the executors it may be dispatched to
   * (`invalid_spec` for one it does not), and `runner` needs the runners switch (`runners_disabled`). A runner
   * job is made with no hold and no ledger entry, is never submitted, and waits for a runner to pull it.
   */
  executor?: RecipeExecutor;
  /**
   * What the run reads (plan D12): `bids` or `zarr`, the executor's default when absent (`defaultInput`:
   * `bids` for Tapis, `zarr` for a runner). An input the recipe does not list, or one the executor does not
   * run, is `invalid_spec` naming `input`, refused before anything is claimed.
   */
  input?: RecipeInput;
}

export type DispatchResult =
  | {
      ok: true;
      stampId: number;
      jobId: string;
      datasetId: string;
      version: string;
      recipe: string;
      attempt: number;
      /**
       * What the immediate submit said; a job that waits is submitted by the 30-minute tick. A runner job is
       * never submitted: `waiting_for_runner` says it waits to be pulled.
       */
      submit: SubmitOutcome | "waiting_for_runner" | "records_not_written";
      /**
       * A runner job only: whether its records (`spec.json`, `identity.json`) landed. False after a store
       * failure that a second try did not mend, and then `submit` says `records_not_written`: nothing here
       * repairs the records (a runner job is not submitted by the tick), so the claim must (DM-07).
       */
      recordsWritten?: boolean;
    }
  | {
      ok: false;
      code: PipelineRefusal;
      datasetId: string;
      version?: string;
      /** The terms of the eligibility predicate the dataset fails, for `dataset_not_eligible`. */
      blockedBy?: PipelineTermId[];
      /** The stamp the refusal ended, when one had been claimed. */
      stampId?: number;
      /** The field of the specification that was invalid, for `invalid_spec`. */
      field?: string;
      /** For a Zarr source refusal: one of `ZARR_SOURCE_REASONS`, a fixed word that says what was not shown. */
      reason?: string;
    };

// --- Rows -------------------------------------------------------------------------------------------

export interface StampRow {
  id: number;
  dataset_id: string;
  version: string;
  recipe: string;
  recipe_version: string;
  engine: string;
  /** What the run reads: the fifth word of the tuple's claim, `bids` for every stamp made before inputs existed. */
  input: RecipeInput;
  attempt: number;
  state: "dispatched" | "succeeded" | "failed" | "refused";
  job_id: string | null;
  refusal_code: string | null;
  /** A succeeded Zarr stamp: the reader that decoded the stores, from the recipe's record; null otherwise. */
  reader: string | null;
  /** A succeeded Zarr stamp: the Zarr engine version of the serving index the run read; null otherwise. */
  input_engine: string | null;
  /** A succeeded stamp: `sha256:` and what a Zarr run read, or `git:` and the commit a BIDS run read; null otherwise. */
  input_digest: string | null;
  created_at: string;
  updated_at: string;
}

export const STAMP_COLUMNS = `id, dataset_id, version, recipe, recipe_version, engine, input, attempt,
  state, job_id, refusal_code, reader, input_engine, input_digest, created_at, updated_at`;

/**
 * Claim a tuple: `?1` dataset, `?2` version tag, `?3` recipe, `?4` recipe version, `?5` engine, `?6` input.
 * The attempt number is read INSIDE the statement, over the same tuple and input, so it is atomic with the
 * insert; a live or succeeded stamp for the tuple and input makes the insert fail on the partial unique index.
 */
export const CLAIM_STAMP_SQL = `INSERT INTO compute_pipeline_stamps
  (dataset_id, version, recipe, recipe_version, engine, input, attempt, state)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6,
         COALESCE((SELECT MAX(s.attempt) FROM compute_pipeline_stamps s
                    WHERE s.dataset_id = ?1 AND s.version = ?2 AND s.recipe = ?3
                      AND s.recipe_version = ?4 AND s.engine = ?5 AND s.input = ?6), 0) + 1,
         'dispatched'`;

const STAMP_BY_ID_SQL = `SELECT ${STAMP_COLUMNS} FROM compute_pipeline_stamps WHERE id = ?1`;

/** Link the job a claimed stamp made: only while the stamp is still open and has none. */
export const LINK_STAMP_SQL = `UPDATE compute_pipeline_stamps
   SET job_id = ?2, updated_at = datetime('now')
 WHERE id = ?1 AND state = 'dispatched' AND job_id IS NULL`;

/** End an open stamp `failed` or `refused` with a fixed word. `?2` the state, `?3` the word. */
export const END_STAMP_SQL = `UPDATE compute_pipeline_stamps
   SET state = ?2, refusal_code = ?3, updated_at = datetime('now')
 WHERE id = ?1 AND state = 'dispatched'`;

/**
 * End an open stamp `succeeded` with the recipe's own version and engine, and what the run read: `?2`
 * version, `?3` engine, `?4` reader, `?5` Zarr engine version, `?6` input digest (each of the last three NULL
 * or in the shape of its column: `stampInputFields` made it so). The stamp's `input` is the claim's and is
 * never rewritten. May meet the partial unique index, which the caller handles.
 */
export const SUCCEED_STAMP_SQL = `UPDATE compute_pipeline_stamps
   SET state = 'succeeded', recipe_version = ?2, engine = ?3, refusal_code = NULL,
       reader = ?4, input_engine = ?5, input_digest = ?6, updated_at = datetime('now')
 WHERE id = ?1 AND state = 'dispatched' AND job_id IS NOT NULL`;

const looksUnique = (err: unknown) => /UNIQUE constraint failed/i.test(String(err));

/** The stamp of an id. */
export async function getStamp(db: D1Database, id: number): Promise<StampRow | null> {
  return db.prepare(STAMP_BY_ID_SQL).bind(id).first<StampRow>();
}

/**
 * The one key of an attempt: `pl:` and 40 hex digits of the SHA-256 of the tuple, the input and the attempt.
 * A pure function of the stamp, so the sync can find a job whose creation committed and whose link did not.
 * The input is part of the text for every input but `bids`: a `bids` stamp's key is what it was before
 * stamps had an input (a stamp claimed then still finds its job), and a `zarr` stamp of the same dataset,
 * version, recipe, recipe version, engine and attempt number gets a key of its own (the attempt numbers of
 * two inputs both start at 1).
 */
export async function pipelineKey(
  stamp: Pick<
    StampRow,
    "dataset_id" | "version" | "recipe" | "recipe_version" | "engine" | "input" | "attempt"
  >,
): Promise<string> {
  const text = [
    stamp.dataset_id,
    stamp.version,
    stamp.recipe,
    stamp.recipe_version,
    stamp.engine,
    ...(stamp.input === "bids" ? [] : [stamp.input]),
    String(stamp.attempt),
  ].join("|");
  return `pl:${(await sha256Hex(new TextEncoder().encode(text))).slice(0, 40)}`;
}

/** The service account jobs are made for, or null: approved, not deleted, and explicitly a service. */
export const PIPELINES_ACCOUNT_SQL = `SELECT id FROM users
  WHERE username = ?1 AND account_kind = 'service' AND status = 'approved' AND deleted_at IS NULL`;

export async function pipelinesAccountId(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare(PIPELINES_ACCOUNT_SQL)
    .bind(PIPELINES_ACCOUNT_USERNAME)
    .first<{ id: number }>();
  return row?.id ?? null;
}

// --- The job a recipe is ----------------------------------------------------------------------------

/**
 * The origin a Zarr recipe job reads in this environment (portable compute, plan S1 and D12): outside
 * production the Worker's own `ZARR_HOSTNAME` (a staging fixture is read from the staging copy), and in
 * production, for an unset or misspelled `ENVIRONMENT`, and for a host name that is not a bare lower-case
 * one, the production host. The classification is `isNonProductionEnv`'s, the one the eligibility predicate
 * uses.
 */
export function pipelineZarrBase(env: Pick<Bindings, "ENVIRONMENT" | "ZARR_HOSTNAME">): string {
  return recipeZarrBase({
    nonProduction: isNonProductionEnv(env),
    zarrHostname: env.ZARR_HOSTNAME,
  });
}

/** The partition of a recipe, as the type `JobSpecSchema` takes. */
const partitionOf = (recipe: ComputeRecipe) => recipe.partition as PartitionName;

/**
 * The complete job specification of a recipe over a dataset version, with NEMAR's runtime image: the
 * recipe's name beside an `image` runtime, the command and the arguments that carry the image digest.
 * Parsed with the strict schema, so a registry entry that is not a valid job is a programming error that
 * a test also catches.
 *
 * A `zarr` run stages no dataset (`datasets: []`): its command names the input (`nemar-recipe run <name> --input
 * zarr`, `recipeCommand`; a BIDS run's command is what it always was) and its arguments carry the commit
 * attestation that `resolveRun` verified (`zarrSource`: the serving index's commit, the tag's commit, how they
 * are equivalent and the paths between them) and the one origin it may read, which is the ENVIRONMENT's own
 * Zarr host ({@link pipelineZarrBase}, from `env`, never from a request or a dataset row). A `zarr` run with
 * no verified attestation is a programming error here, never a job, and so is an input the recipe does not
 * list.
 */
export function recipeJobSpec(
  recipe: ComputeRecipe,
  input: {
    datasetId: string;
    tag: string;
    /** What the job reads; one the recipe lists (the stamp's claimed input, the dispatch's, or the default). */
    input: RecipeInput;
    image: { ref: string; digest: string };
    /** Required for a `zarr` input, never read for a `bids` one. */
    zarrSource?: ZarrCommitAttestation | null;
    /** The Worker's bindings the Zarr origin is read from; only a `zarr` input reads them. */
    env: Pick<Bindings, "ENVIRONMENT" | "ZARR_HOSTNAME">;
  },
) {
  if (!recipe.inputs.includes(input.input)) {
    throw new RangeError("the recipe does not read that input");
  }
  const zarr = input.input === "zarr";
  return JobSpecSchema.parse({
    name: `${recipe.name} ${input.datasetId} ${input.tag}`.slice(0, 80),
    runtime: "image",
    image: input.image.ref,
    recipe: recipe.name,
    command: recipeCommand(recipe, input.input),
    args: zarr
      ? recipeZarrArguments({
          datasetId: input.datasetId,
          tag: input.tag,
          attestation: input.zarrSource as ZarrCommitAttestation,
          imageDigest: input.image.digest,
          zarrBase: pipelineZarrBase(input.env),
        })
      : recipeArguments({
          datasetId: input.datasetId,
          tag: input.tag,
          imageDigest: input.image.digest,
        }),
    datasets: zarr ? [] : [{ id: input.datasetId, version: input.tag }],
    partition: recipe.partition,
    nodes: recipe.nodes,
    cores: recipe.cores,
    ...(recipe.memoryMb === undefined ? {} : { memory_mb: recipe.memoryMb }),
    gpus: recipe.gpus,
    minutes: recipe.minutes,
  });
}

/** What one job of a recipe is held for, in milli-SU: the hold `createJob` takes. */
export function recipeEstimateMilli(recipe: ComputeRecipe): number {
  return estimateSuMilli({
    partition: partitionOf(recipe),
    nodes: recipe.nodes,
    cores: recipe.cores,
    memory_mb: recipe.memoryMb,
    gpus: recipe.gpus,
    minutes: recipe.minutes,
  });
}

// --- What a run needs of the dataset ------------------------------------------------------------------

type ResolvedRun =
  | {
      ok: true;
      tag: string;
      /**
       * For a recipe that reads the Zarr serving copy: the verified commit attestation of the tagged version
       * (`checkZarrSource`: the serving index's commit S, the tag's commit T, `exact` or `metadata_only`, the
       * paths between them); null for a `bids` recipe.
       */
      zarrSource: ZarrCommitAttestation | null;
    }
  | {
      ok: false;
      code:
        | "dataset_not_eligible"
        | "version_not_found"
        | "version_untagged"
        | "too_many_files"
        | "zarr_version_not_newest"
        | "zarr_copy_not_ready"
        | "zarr_source_mismatch"
        | "zarr_source_unverifiable";
      extra: { version?: string; blockedBy?: PipelineTermId[]; reason?: string };
    };

/**
 * What the dataset row says of its Zarr serving copy (`zarr-ready` writes it): the conversion's state and its
 * store count. Every consumer of the copy reads it only while `zarr_status = 'ready'` and there is a store (as
 * `zarr-catalog.ts` does). The commit the copy was built from is NOT read from the row (it can be left over
 * from a conversion that has since failed): it is the serving index's own, read by `checkZarrSource`.
 */
const ZARR_COPY_SQL = "SELECT zarr_status, zarr_store_count FROM datasets WHERE dataset_id = ?1";

/**
 * The part of a run that is decided from the dataset's own rows, in one place so the dry run and the
 * run cannot disagree: the eligibility predicate over the row (ADR 0065), the version row (the newest,
 * or the one named) with a data-plane tag, and the manifest bound. It is the one place a Zarr recipe's identity
 * is decided, so the dry run and the run cannot disagree.
 *
 * A run over the `zarr` input reads the dataset's ONE serving copy, which describes the NEWEST version, so it is run only for
 * the newest (`zarr_version_not_newest`) and only while the copy is `ready` with at least one store
 * (`zarr_copy_not_ready`: a `pending` or `failed` conversion leaves the previous copy's row values in place);
 * both refusals come before any index read or GitHub request. Then `checkZarrSource` proves the copy's own
 * commit S is the tag's commit T, or differs from it by metadata only (`zarr_source_mismatch` when it is
 * not, `zarr_source_unverifiable` when GitHub or the index could not be read), and the verified attestation is
 * what the recipe is given. Nothing is written by a refusal, so no stamp, hold or job comes of one. The manifest
 * bound (`too_many_files`) is a BIDS staging limit: a Zarr run stages no files. The input is the LAST
 * parameter (the order of the others is another card's merge checklist). A caller refuses an input the recipe
 * does not list before it gets here, so meeting one is a programming error and a throw.
 */
async function resolveRun(
  db: D1Database,
  datasetId: string,
  wanted: string | undefined,
  recipe: ComputeRecipe | undefined,
  env: Bindings,
  input: RecipeInput,
): Promise<ResolvedRun> {
  if (recipe !== undefined && !recipe.inputs.includes(input)) {
    throw new RangeError("the recipe does not read that input");
  }
  const loaded = await loadPipelineRow(db, datasetId, env);
  if (!loaded.eligible) {
    return { ok: false, code: "dataset_not_eligible", extra: { blockedBy: loaded.blockedBy } };
  }
  const versions = (await db.prepare(VERSIONS_OF_SQL).bind(datasetId).all<PipelineVersion>())
    .results;
  const picked = pickVersion(versions, wanted);
  if (!picked.ok) return { ok: false, code: picked.code, extra: {} };
  const zarr = input === "zarr";
  if (
    !zarr &&
    picked.version.total_files !== null &&
    picked.version.total_files > PIPELINE_MANIFEST_MAX_ENTRIES
  ) {
    return { ok: false, code: "too_many_files", extra: { version: picked.tag } };
  }
  if (!zarr) return { ok: true, tag: picked.tag, zarrSource: null };
  if (picked.version.version !== versions[0]?.version) {
    return { ok: false, code: "zarr_version_not_newest", extra: { version: picked.tag } };
  }
  const copy = await db.prepare(ZARR_COPY_SQL).bind(datasetId).first<{
    zarr_status: string | null;
    zarr_store_count: number | null;
  }>();
  if (copy?.zarr_status !== "ready" || (copy.zarr_store_count ?? 0) <= 0) {
    return { ok: false, code: "zarr_copy_not_ready", extra: { version: picked.tag } };
  }
  const checked = await checkZarrSource(env, datasetId, picked.tag);
  if (!checked.ok) {
    // The reason is one of this tree's fixed words (no path, address or token), for the operator's log.
    console.error(
      `[compute-pipeline] zarr_source dataset=${datasetId} code=${checked.code} reason=${checked.reason}`,
    );
    return {
      ok: false,
      code: checked.code,
      extra: { version: picked.tag, reason: checked.reason },
    };
  }
  return {
    ok: true,
    tag: picked.tag,
    zarrSource: {
      sourceCommit: checked.sourceCommit,
      tagCommit: checked.tagCommit,
      equivalence: checked.equivalence,
      deltaPaths: checked.deltaPaths,
    },
  };
}

// --- A result that is not the tuple that was claimed ------------------------------------------------

/** The word of the stamp that holds a registry tuple: a finished result named another tuple than its stamp claimed. */
export const TUPLE_MISMATCH_WORD = "tuple_mismatch";

/**
 * Is a registry tuple (`?1` recipe, `?2` version, `?3` engine, `?4` input) held? A hold is a failed stamp with
 * the mismatch word. The input is part of the tuple: a Zarr run that showed a wrong engine or a wrong input
 * holds the Zarr tuple and leaves the BIDS tuple of the same recipe free. One runtime image serves both
 * executors (`COMPUTE_RUNTIME_IMAGE`), so a wrong image can show itself on either input; the hold is the
 * claimed input's alone, and a run that shows the drift on the other input holds that one when it finishes.
 */
export const TUPLE_HELD_SQL = `SELECT 1 FROM compute_pipeline_stamps
  WHERE recipe = ?1 AND recipe_version = ?2 AND engine = ?3 AND input = ?4
    AND state = 'failed' AND refusal_code = '${TUPLE_MISMATCH_WORD}' LIMIT 1`;

/**
 * Hold the tuple a stamp CLAIMED (`?1` dataset, `?2` version, `?3` recipe, `?4` claimed version, `?5`
 * claimed engine, `?6` the job, `?7` the claimed input). The hold is a `failed` stamp of the claimed tuple
 * with the job that showed the mismatch, and is written once per job. It does not clear by time. It clears
 * when the registry declares another tuple (a version bump), or when its rows are deleted, which deleting the
 * dataset they name does (the cascade is the rule); the next mismatch on any dataset holds the tuple again.
 */
export const HOLD_TUPLE_SQL = `INSERT INTO compute_pipeline_stamps
  (dataset_id, version, recipe, recipe_version, engine, input, attempt, state, job_id, refusal_code)
  SELECT ?1, ?2, ?3, ?4, ?5, ?7,
         COALESCE((SELECT MAX(s.attempt) FROM compute_pipeline_stamps s
                    WHERE s.dataset_id = ?1 AND s.version = ?2 AND s.recipe = ?3
                      AND s.recipe_version = ?4 AND s.engine = ?5 AND s.input = ?7), 0) + 1,
         'failed', ?6, '${TUPLE_MISMATCH_WORD}'
   WHERE NOT EXISTS (SELECT 1 FROM compute_pipeline_stamps h
                      WHERE h.job_id = ?6 AND h.refusal_code = '${TUPLE_MISMATCH_WORD}')`;

/** Whether the registry's tuple for a recipe, over one input, is held. */
export async function tupleHeld(
  db: D1Database,
  recipe: ComputeRecipe,
  input: RecipeInput,
): Promise<boolean> {
  const row = await db
    .prepare(TUPLE_HELD_SQL)
    .bind(recipe.name, recipe.version, recipe.engine, input)
    .first();
  return row !== null;
}

// --- dispatchPipelineJob ----------------------------------------------------------------------------

const fail = (
  code: PipelineRefusal,
  datasetId: string,
  extra: Partial<Extract<DispatchResult, { ok: false }>> = {},
): DispatchResult => ({ ok: false, code, datasetId, ...extra });

async function finishStamp(
  db: D1Database,
  stampId: number,
  state: "failed" | "refused",
  word: string,
): Promise<void> {
  await db.prepare(END_STAMP_SQL).bind(stampId, state, word).run();
}

/**
 * Run a recipe over one dataset version. Never throws for a refusal: every refusal is a word. See the
 * file's header for the rules.
 */
export async function dispatchPipelineJob(
  env: Bindings,
  input: DispatchInput,
): Promise<DispatchResult> {
  const { datasetId } = input;
  const db = env.DB;
  const recipe = findRecipe(input.recipe);
  if (recipe === null) return fail("recipe_unknown", datasetId);
  if (!computeEnabled(env)) return fail("compute_disabled", datasetId);
  if (input.actor.kind === "cron" && !recipe.autoDispatch) {
    return fail("recipe_not_automatic", datasetId);
  }
  // The executor, decided from the registry: a recipe is run only where it lists, and a runner needs its
  // switch. The route has said so already in its own words; this is the boundary that holds if another caller
  // reaches the service (the cron passes none, so it is always `tapis`). It is asked before the placeholder, so
  // that where a recipe may run is answered for every recipe in the registry, a placeholder included.
  const executor = input.executor ?? "tapis";
  if (!recipeRunsOn(recipe, executor)) {
    return fail("invalid_spec", datasetId, { field: "executor" });
  }
  // A placeholder is on no path: not an administrator's run, not the queue, not the cron.
  if (recipe.placeholder === true) return fail("recipe_placeholder", datasetId);
  // The cron is the Tapis queue's: `autoDispatch` says a recipe may be run automatically on Tapis, and a runner
  // run is an administrator's (the daily dispatcher never names an executor, so this holds for any other caller).
  if (input.actor.kind === "cron" && executor !== "tapis") {
    return fail("recipe_not_automatic", datasetId);
  }
  // The input, named or the executor's own: one the recipe does not list, or one the executor does not run
  // (`bids` on a runner, `zarr` on Tapis), is refused here, before any switch, read or claim.
  const recipeInput = input.input ?? defaultInput(executor);
  if (!recipeRunsInput(recipe, recipeInput, executor)) {
    return fail("invalid_spec", datasetId, { field: "input" });
  }
  if (executor === "runner" && !computeRunnersEnabled(env)) {
    return fail("runners_disabled", datasetId);
  }
  // A Tapis job is made only where it can be submitted: with no usable Tapis configuration the hold, the
  // stamp and the job would wait for a submit that cannot happen, and nothing but a cancel would end them.
  // Before every read of the dataset and every write, for every caller (the route, the queue, the cron).
  if (executor === "tapis" && !tapisSubmitConfigured(env)) {
    return fail("tapis_unconfigured", datasetId);
  }
  // The registry names a tuple that a finished result has shown is not what runs: nothing is claimed.
  if (await tupleHeld(db, recipe, recipeInput)) return fail("registry_drift", datasetId);

  // The dataset and its version, decided from the rows (ADR 0065): nothing a caller said is read.
  const resolved = await resolveRun(db, datasetId, input.version, recipe, env, recipeInput);
  if (!resolved.ok) return fail(resolved.code, datasetId, resolved.extra);
  const { tag } = resolved;

  const image = readRuntimeImage(env);
  if (image.state !== "ok") return fail("runtime_unavailable", datasetId, { version: tag });
  const accountId = await pipelinesAccountId(db);
  if (accountId === null) return fail("pipelines_account_missing", datasetId, { version: tag });

  // The specification, BEFORE the claim: a registry entry or an image the job schema refuses is a word
  // (`invalid_spec`) with nothing written, never a throw that leaves a claimed stamp and aborts a run.
  let spec: ReturnType<typeof recipeJobSpec>;
  try {
    spec = recipeJobSpec(recipe, {
      datasetId,
      tag,
      input: recipeInput,
      image,
      zarrSource: resolved.zarrSource,
      env,
    });
  } catch (err) {
    console.error(
      `[compute-pipeline] spec_unbuildable recipe=${recipe.name} error=${err instanceof Error ? err.name : "unknown"}`,
    );
    return fail("invalid_spec", datasetId, { version: tag });
  }

  // The claim, first: a live or succeeded stamp for the tuple refuses it.
  let stampId: number;
  try {
    const claimed = await db
      .prepare(CLAIM_STAMP_SQL)
      .bind(datasetId, tag, recipe.name, recipe.version, recipe.engine, recipeInput)
      .run();
    const id = claimed.meta?.last_row_id;
    if (typeof id !== "number") throw new Error("a stamp that was just claimed has no id");
    stampId = id;
  } catch (err) {
    if (looksUnique(err)) return fail("live_attempt_exists", datasetId, { version: tag });
    throw err;
  }
  const stamp = await getStamp(db, stampId);
  if (stamp === null) {
    // The stamp was claimed a moment ago and is gone: the dataset was deleted in between (the deletion
    // cascades its stamps). Nothing was created, no hold was taken, and there is no tuple left to hold.
    console.error(`[compute-pipeline] stamp_gone stamp=${stampId}`);
    return fail("dataset_not_eligible", datasetId, { version: tag });
  }
  const key = await pipelineKey(stamp);

  // The job, from the specification built above. The stamp is ended whatever happens next.
  let created: Awaited<ReturnType<typeof createJob>>;
  try {
    created = await createJob(env, {
      source: "pipeline",
      accountId,
      tapisOwner: PIPELINES_TAPIS_OWNER,
      idempotencyKey: key,
      appId: recipe.appId,
      appVersion: recipe.appVersion,
      spec,
      executor,
    });
    // A job whose records did not land is finished by a replay of its key; one try.
    if (created.ok && !created.recordsWritten) {
      created = await createJob(env, {
        source: "pipeline",
        accountId,
        tapisOwner: PIPELINES_TAPIS_OWNER,
        idempotencyKey: key,
        appId: recipe.appId,
        appVersion: recipe.appVersion,
        spec,
        executor,
      });
    }
  } catch (err) {
    // A throw may come after the batch committed (the read of the job it just wrote can fail), and then
    // the key finds the job: it is linked and left to the 30-minute tick, which submits a created job. A
    // key that was used for ANOTHER request (`idempotency_conflict`) names a job that is not this one's
    // and is never linked.
    const conflict = err instanceof ComputeJobError && err.code === "idempotency_conflict";
    let lookupFailed = false;
    let existing: ComputeJobRow | null = null;
    if (!conflict) {
      try {
        existing = await db.prepare(JOB_BY_KEY_SQL).bind(accountId, key).first<ComputeJobRow>();
      } catch {
        lookupFailed = true;
      }
    }
    const cause =
      err instanceof ComputeJobError ? err.code : err instanceof Error ? err.name : "unknown";
    if (lookupFailed) {
      // The job may exist and the database could not say: ending the stamp would let a later attempt
      // make a second job. It stays `dispatched`; the sync finds the job by its key, or fails the claim
      // after the grace period when there is none.
      console.error(
        `[compute-pipeline] create_threw stamp=${stampId} lookup_failed error=${cause}`,
      );
      return fail("create_failed", datasetId, { version: tag, stampId });
    }
    if (existing) {
      await db.prepare(LINK_STAMP_SQL).bind(stampId, existing.id).run();
      console.error(`[compute-pipeline] create_threw job=${existing.id} error=${cause}`);
      return {
        ok: true,
        stampId,
        jobId: existing.id,
        datasetId,
        version: tag,
        recipe: recipe.name,
        attempt: stamp.attempt,
        submit: executor === "runner" ? "waiting_for_runner" : "unavailable",
      };
    }
    await finishStamp(db, stampId, "failed", "create_failed");
    console.error(`[compute-pipeline] create_threw stamp=${stampId} error=${cause}`);
    return fail("create_failed", datasetId, { version: tag, stampId });
  }
  if (!created.ok) {
    await finishStamp(db, stampId, "refused", created.code);
    return fail(created.code, datasetId, {
      version: tag,
      stampId,
      ...(created.field === undefined ? {} : { field: created.field }),
    });
  }

  const job = created.job;
  await db.prepare(LINK_STAMP_SQL).bind(stampId, job.id).run();
  // A runner job is never submitted: it waits for a runner to pull it (ADR 0121). Its records may not have
  // landed (the store was down for both tries): the answer says so, as a fixed word.
  if (executor === "runner") {
    return {
      ok: true,
      stampId,
      jobId: job.id,
      datasetId,
      version: tag,
      recipe: recipe.name,
      attempt: stamp.attempt,
      submit: created.recordsWritten ? "waiting_for_runner" : "records_not_written",
      recordsWritten: created.recordsWritten,
    };
  }
  // The submit is the lifecycle's: one attempt now; the 30-minute tick covers a job that waits.
  let submit: SubmitOutcome = "unavailable";
  try {
    submit = (await submitComputeJob(env, job.id)).outcome;
  } catch (err) {
    console.error(
      `[compute-pipeline] submit_threw job=${job.id} error=${err instanceof Error ? err.name : "unknown"}`,
    );
  }
  return {
    ok: true,
    stampId,
    jobId: job.id,
    datasetId,
    version: tag,
    recipe: recipe.name,
    attempt: stamp.attempt,
    submit,
  };
}

// --- syncPipelineStamps ---------------------------------------------------------------------------------

export interface SyncResult {
  examined: number;
  succeeded: number;
  failed: number;
  /** Stamps with a job that was created but never linked, found again by its key. */
  linked: number;
  /** Stamps left open because what decides them could not be read yet (the next sync tries again). */
  later: number;
  /** Stamps whose sync threw (a database fault, say): left as they were, and counted so the line is not blind to them. */
  errored: number;
}

/** The open stamps, oldest update first: the partial index `compute_pipeline_stamps_open` serves it. */
export const OPEN_STAMPS_SQL = `SELECT ${STAMP_COLUMNS} FROM compute_pipeline_stamps
  WHERE state = 'dispatched' ORDER BY updated_at ASC, id ASC LIMIT ?1`;

interface JobEnd {
  id: string;
  state: string;
  failure_code: string | null;
}

const TOUCH_STAMP_SQL = `UPDATE compute_pipeline_stamps SET updated_at = datetime('now')
 WHERE id = ?1 AND state = 'dispatched'`;

const JOB_END_SQL = "SELECT id, state, failure_code FROM compute_jobs WHERE id = ?1";

/** A job's failure word, or `job_failed`; the shape is checked because the stamp's column is. */
function failureWord(job: JobEnd): string {
  if (job.state === "cancelled") return "job_cancelled";
  return job.failure_code !== null && /^[a-z0-9_]{1,64}$/.test(job.failure_code)
    ? job.failure_code
    : "job_failed";
}

/** The largest dataset record the sync reads: the recipe caps it at 256 KB. */
const RECORD_READ_MAX_BYTES = 512 * 1024;

type RecordRead =
  | {
      kind: "ok";
      version: string;
      engine: string;
      /** The input the record says it read (`bids` when it states none). */
      inputKind: string;
      /** What the run read, each value in the shape of its stamp column or null, for the INPUT the stamp claimed. */
      fields: ReturnType<typeof stampInputFields>;
    }
  | { kind: "failed"; word: "outputs_missing" | "record_unreadable" | "record_mismatch" }
  | { kind: "later"; reason: "results_unbound" | "read_failed" };

/**
 * Read the recipe's own record of a finished job, and check the files a run must have written. A results
 * bucket that is not bound, or a read that throws, is `later`: the stamp stays open and the next sync
 * asks again; nothing is decided from what could not be read.
 */
async function readFinishedRecord(
  env: Bindings,
  recipe: ComputeRecipe,
  jobId: string,
  input: RecipeInput,
): Promise<RecordRead> {
  const bucket = env.COMPUTE_RESULTS;
  if (!bucket) return { kind: "later", reason: "results_unbound" };
  const wanted = recipeRequiredOutputs(recipe);
  try {
    const table = await bucket.head(resultsOutputKey(jobId, wanted.table));
    const head = await bucket.head(resultsOutputKey(jobId, wanted.record));
    if (!table || !head) return { kind: "failed", word: "outputs_missing" };
    if (head.size > RECORD_READ_MAX_BYTES) return { kind: "failed", word: "record_unreadable" };
    const object = await bucket.get(resultsOutputKey(jobId, wanted.record));
    if (!object) return { kind: "failed", word: "outputs_missing" };
    let value: unknown;
    try {
      value = JSON.parse(await object.text());
    } catch {
      return { kind: "failed", word: "record_unreadable" };
    }
    const record: RecipeRecord | null = readRecipeRecord(value);
    if (record === null) return { kind: "failed", word: "record_unreadable" };
    if (record.recipe !== recipe.name) return { kind: "failed", word: "record_mismatch" };
    return {
      kind: "ok",
      version: record.version,
      engine: record.engine,
      inputKind: record.inputKind,
      fields: stampInputFields(value, input),
    };
  } catch {
    return { kind: "later", reason: "read_failed" };
  }
}

/** Whether a stamp is older than `minutes`, on SQLite's own clock (the column is `datetime('now')`). */
const OLDER_THAN_SQL = "SELECT (julianday('now') - julianday(?1)) * 1440 AS minutes";

async function ageMinutes(db: D1Database, timestamp: string): Promise<number> {
  const row = await db.prepare(OLDER_THAN_SQL).bind(timestamp).first<{ minutes: number | null }>();
  return row?.minutes ?? 0;
}

/**
 * Bring the open stamps up to date. A stamp with a job follows it: `finished` reads the recipe's own
 * record (the stamp then carries what ran), `failed` and `cancelled` end it; a stamp with no job yet
 * looks for one by its key and, after {@link STAMP_NO_JOB_MINUTES}, fails (a crash between the claim and
 * the job). At most {@link SYNC_STAMPS_PER_CALL} stamps a call, oldest first, each in its own try so one
 * bad row cannot hold the rest. Runs before every dispatch and every status read.
 */
export async function syncPipelineStamps(
  env: Bindings,
  limit: number = SYNC_STAMPS_PER_CALL,
): Promise<SyncResult> {
  const db = env.DB;
  const result: SyncResult = {
    examined: 0,
    succeeded: 0,
    failed: 0,
    linked: 0,
    later: 0,
    errored: 0,
  };
  const open = (await db.prepare(OPEN_STAMPS_SQL).bind(limit).all<StampRow>()).results;
  for (const stamp of open) {
    result.examined++;
    try {
      // Every stamp visited goes to the back of the line (the open list is ordered by `updated_at`), so
      // a stamp that cannot move on cannot starve the ones behind it. The state is not touched.
      await db.prepare(TOUCH_STAMP_SQL).bind(stamp.id).run();
      let jobId = stamp.job_id;
      if (jobId === null) {
        const account = await pipelinesAccountId(db);
        const key = await pipelineKey(stamp);
        const found =
          account === null
            ? null
            : await db.prepare(JOB_BY_KEY_SQL).bind(account, key).first<ComputeJobRow>();
        if (found) {
          await db.prepare(LINK_STAMP_SQL).bind(stamp.id, found.id).run();
          jobId = found.id;
          result.linked++;
        } else if ((await ageMinutes(db, stamp.created_at)) > STAMP_NO_JOB_MINUTES) {
          await finishStamp(db, stamp.id, "failed", "no_job");
          result.failed++;
          continue;
        } else {
          continue;
        }
      }
      const job = await db.prepare(JOB_END_SQL).bind(jobId).first<JobEnd>();
      if (!job) {
        await finishStamp(db, stamp.id, "failed", "job_missing");
        result.failed++;
        continue;
      }
      if (job.state === "failed" || job.state === "cancelled") {
        await finishStamp(db, stamp.id, "failed", failureWord(job));
        result.failed++;
        continue;
      }
      if (job.state !== "finished") continue;

      const recipe = findRecipe(stamp.recipe);
      if (recipe === null) {
        await finishStamp(db, stamp.id, "failed", "recipe_unknown");
        result.failed++;
        continue;
      }
      const read = await readFinishedRecord(env, recipe, job.id, stamp.input);
      if (read.kind === "later") {
        // Nothing is decided from what could not be read; say so, with ids and the reason only.
        console.error(
          `[compute-pipeline] sync_later stamp=${stamp.id} dataset=${stamp.dataset_id} reason=${read.reason}`,
        );
        result.later++;
        continue;
      }
      if (read.kind === "failed") {
        await finishStamp(db, stamp.id, "failed", read.word);
        result.failed++;
        continue;
      }
      // The input the record says it read is part of the tuple, and a stamp says what ran: a record of another
      // input than the stamp claimed ends the stamp `failed` with `tuple_mismatch`, never `succeeded`. That
      // stamp IS the hold of the claimed tuple (a failed `tuple_mismatch` stamp of its recipe, version, engine
      // and input), so no separate hold row is written; a stamp that says "read zarr" of a run that read
      // something else would keep the tuple's live slot and could be keyed from. Nothing it read is stored.
      if (read.inputKind !== stamp.input) {
        await finishStamp(db, stamp.id, "failed", TUPLE_MISMATCH_WORD);
        console.error(
          `[compute-pipeline] tuple_mismatch stamp=${stamp.id} dataset=${stamp.dataset_id} job=${job.id} input_kind_differs`,
        );
        result.failed++;
        continue;
      }
      if (read.version !== stamp.recipe_version || read.engine !== stamp.engine) {
        // The result carries a tuple other than the one claimed: hold the CLAIMED tuple (the registry is
        // out of date, or the image is), before the stamp is rewritten and the claim is lost.
        await db
          .prepare(HOLD_TUPLE_SQL)
          .bind(
            stamp.dataset_id,
            stamp.version,
            stamp.recipe,
            stamp.recipe_version,
            stamp.engine,
            job.id,
            stamp.input,
          )
          .run();
        console.error(
          `[compute-pipeline] tuple_mismatch stamp=${stamp.id} dataset=${stamp.dataset_id} job=${job.id}`,
        );
      }
      // What the run read: each value is stored only in the shape of its column, and a value that is not (or
      // that the record does not show covers the whole input) is named in the log (a field name and a fixed
      // reason word, never the value) and left null.
      const fields = read.fields;
      for (const field of fields.refused) {
        console.error(
          `[compute-pipeline] stamp_field_refused field=${field} reason=${fields.reasons[field] ?? "bad_shape"} stamp=${stamp.id} dataset=${stamp.dataset_id} job=${job.id}`,
        );
      }
      for (const field of fields.absent) {
        console.error(
          `[compute-pipeline] stamp_field_absent field=${field} stamp=${stamp.id} dataset=${stamp.dataset_id} job=${job.id}`,
        );
      }
      try {
        const moved = await db
          .prepare(SUCCEED_STAMP_SQL)
          .bind(
            stamp.id,
            read.version,
            read.engine,
            fields.reader,
            fields.input_engine,
            fields.input_digest,
          )
          .run();
        if ((moved.meta?.changes ?? 0) > 0) result.succeeded++;
      } catch (err) {
        // The RUN may be good; this stamp cannot carry the tuple its record names, and the word says why.
        // Two unique indexes can refuse the rewrite, and they mean different things: the live index (the
        // tuple already holds a live or succeeded stamp) and the attempt index (the tuple has a row with
        // this attempt number, history only). The message names the columns of the one that refused, and
        // only the attempt index names the attempt column.
        if (!looksUnique(err)) throw err;
        const word = String(err).includes("compute_pipeline_stamps.attempt")
          ? "tuple_attempt_taken"
          : "tuple_already_stamped";
        console.error(
          `[compute-pipeline] ${word} stamp=${stamp.id} dataset=${stamp.dataset_id} job=${job.id}`,
        );
        await finishStamp(db, stamp.id, "failed", word);
        result.failed++;
      }
    } catch (err) {
      console.error(
        `[compute-pipeline] sync_failed stamp=${stamp.id} error=${err instanceof Error ? err.name : "unknown"}`,
      );
      result.errored++;
    }
  }
  return result;
}

// --- Reading ------------------------------------------------------------------------------------------

export interface StampFilter {
  recipe?: string;
  dataset?: string;
  state?: StampRow["state"];
  /** Rows with an id below this, for the next page of newest-first. */
  before?: number;
  limit: number;
}

/** A page of stamps, newest first. The filters are bound, never spliced. */
export async function listPipelineStamps(
  db: D1Database,
  filter: StampFilter,
): Promise<{ stamps: StampRow[]; nextBefore: number | null }> {
  const rows = (
    await db
      .prepare(
        `SELECT ${STAMP_COLUMNS} FROM compute_pipeline_stamps
          WHERE (?1 IS NULL OR recipe = ?1) AND (?2 IS NULL OR dataset_id = ?2)
            AND (?3 IS NULL OR state = ?3) AND (?4 IS NULL OR id < ?4)
          ORDER BY id DESC LIMIT ?5`,
      )
      .bind(
        filter.recipe ?? null,
        filter.dataset ?? null,
        filter.state ?? null,
        filter.before ?? null,
        filter.limit + 1,
      )
      .all<StampRow>()
  ).results;
  const more = rows.length > filter.limit;
  const stamps = more ? rows.slice(0, filter.limit) : rows;
  return { stamps, nextBefore: more ? (stamps[stamps.length - 1]?.id ?? null) : null };
}

// --- The queue and the dry run ----------------------------------------------------------------------------

/** A dataset that is eligible and whose newest version has no live or succeeded stamp for the recipe's tuple and input. */
export interface Candidate {
  dataset_id: string;
  version: string;
  tag: string;
}

/**
 * The candidate statement, over a predicate (`eligible`): the eligible datasets whose newest version has no live
 * or succeeded stamp for the tuple and whose failures are inside the cooldown and the cap. `?1` the cursor,
 * `?2` recipe, `?3` recipe version, `?4` engine, `?5` page size, `?6` the cooldown, `?7` the cap, `?8` the
 * input (a dataset a Zarr run has stamped is still a candidate of the BIDS run, and the other way round).
 * Built twice at module load, once per predicate, and never at call time: a call picks one with
 * {@link pipelineCandidatesSql}.
 */
const candidatesSql = (eligible: string): string => `SELECT ${PIPELINE_ROW_COLUMNS},
                  (${NEWEST_VERSION_SQL("d")}) AS newest_version,
                  (${NEWEST_VERSION_SQL("d", "total_files")}) AS newest_total_files
             FROM datasets d
            WHERE d.dataset_id > ?1
              AND ${eligible}
              AND NOT EXISTS (
                SELECT 1 FROM compute_pipeline_stamps s
                 WHERE s.dataset_id = d.dataset_id AND s.recipe = ?2 AND s.recipe_version = ?3
                   AND s.engine = ?4 AND s.input = ?8 AND s.state IN ('dispatched', 'succeeded')
                   AND s.version = ${VERSION_TAG_SQL(`(${NEWEST_VERSION_SQL("s")})`)})
              AND NOT EXISTS (
                SELECT 1 FROM compute_pipeline_stamps f
                 WHERE f.dataset_id = d.dataset_id AND f.recipe = ?2 AND f.recipe_version = ?3
                   AND f.engine = ?4 AND f.input = ?8 AND f.state = 'failed'
                   AND ${COUNTS_AS_FAILURE_SQL("f")}
                   AND f.updated_at >= datetime('now', ?6)
                   AND f.version = ${VERSION_TAG_SQL(`(${NEWEST_VERSION_SQL("f")})`)})
              AND (
                SELECT COUNT(*) FROM compute_pipeline_stamps c
                 WHERE c.dataset_id = d.dataset_id AND c.recipe = ?2 AND c.recipe_version = ?3
                   AND c.engine = ?4 AND c.input = ?8 AND c.state = 'failed'
                   AND ${COUNTS_AS_FAILURE_SQL("c")}
                   AND c.version = ${VERSION_TAG_SQL(`(${NEWEST_VERSION_SQL("c")})`)}) < ?7
            ORDER BY d.dataset_id LIMIT ?5`;

/** The candidate statement of production: the production predicate, byte for byte what it was before portable compute's S1. */
export const PIPELINE_CANDIDATES_SQL = candidatesSql(PIPELINE_ELIGIBLE_SQL);

/** The candidate statement of a recognized non-production environment: the widened predicate (the compute fixture). */
export const PIPELINE_CANDIDATES_SQL_NONPROD = candidatesSql(PIPELINE_ELIGIBLE_SQL_NONPROD);

/** The candidate statement an environment runs: the widened one only when `ENVIRONMENT` is recognized as not production. */
export function pipelineCandidatesSql(env: Pick<Bindings, "ENVIRONMENT">): string {
  return isNonProductionEnv(env) ? PIPELINE_CANDIDATES_SQL_NONPROD : PIPELINE_CANDIDATES_SQL;
}

/**
 * The eligible datasets a recipe has not been run over at the newest version, over one input (`bids`, the
 * input of the Tapis queue, unless a caller names another), by id, at most `limit`.
 * The SQL selects (the predicate and the absence of a live or succeeded stamp); the TypeScript re-checks
 * every row it returns, and a version with no data-plane tag is skipped. A dataset the sync has not
 * caught up with is not a candidate: its open stamp holds the tuple. A tuple whose stamp FAILED is not a
 * candidate for {@link RETRY_COOLDOWN_DAYS} days after the failure, nor once it has failed
 * {@link MAX_FAILED_ATTEMPTS} times (a refusal is not a failure: the pool's word is not the dataset's),
 * decided in the SQL so that failing datasets at the head of the order do not fill the page.
 *
 * Which predicate is the environment's: the production one unless `env.ENVIRONMENT` is recognized as not
 * production, where the compute fixture is let through as well (plan S1); the statement and the re-check
 * take the same decision.
 */
export async function pipelineCandidates(
  env: Pick<Bindings, "DB" | "ENVIRONMENT">,
  recipe: ComputeRecipe,
  limit: number,
  after = "",
  input: RecipeInput = defaultInput("tapis"),
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  let cursor = after;
  const statement = pipelineCandidatesSql(env);
  // A page may hold rows skipped for want of a tag; read on until the limit or the end.
  for (let page = 0; page < 20 && out.length < limit; page++) {
    const rows = (
      await env.DB.prepare(statement)
        .bind(
          cursor,
          recipe.name,
          recipe.version,
          recipe.engine,
          Math.max(limit, 25),
          `-${RETRY_COOLDOWN_DAYS} days`,
          MAX_FAILED_ATTEMPTS,
          input,
        )
        .all<PipelineRow & { newest_version: string | null; newest_total_files: number | null }>()
    ).results;
    if (rows.length === 0) break;
    for (const row of rows) {
      cursor = row.dataset_id;
      if (out.length >= limit) break;
      if (!isPipelineEligible(row, env) || row.newest_version === null) continue;
      // A version no launcher can stage (no data-plane tag, or a manifest over the bound) is never a
      // candidate: it would be refused again on every run and hold a place in the queue for good.
      const tag = dataTagForVersion(row.newest_version);
      if (tag === null) continue;
      if (
        row.newest_total_files !== null &&
        row.newest_total_files > PIPELINE_MANIFEST_MAX_ENTRIES
      ) {
        continue;
      }
      out.push({ dataset_id: row.dataset_id, version: row.newest_version, tag });
    }
    if (rows.length < Math.max(limit, 25)) break;
  }
  return out;
}

// --- The dry run ---------------------------------------------------------------------------------------------

export interface DryRunInput {
  recipe: string;
  /** One dataset (and optionally a version), or none for the queue. */
  datasetId?: string;
  version?: string;
  /** For the queue: how many datasets to list. */
  limit?: number;
  /** Who the run would be for; `tapis` when absent. A runner run names one dataset. */
  executor?: RecipeExecutor;
  /** What the run would read; the executor's default when absent (`defaultInput`). */
  input?: RecipeInput;
}

export interface DryRunConfig {
  /** `computeEnabled`: a real run needs it. */
  compute_enabled: boolean;
  /** `COMPUTE_RUNTIME_IMAGE` is a digest-pinned reference. */
  runtime_image: boolean;
  /** The service account exists, is approved and is a service. */
  pipelines_account: boolean;
  /** `computeRunnersEnabled`: a runner run needs it. Present only in the dry run of a runner run. */
  runners_enabled?: boolean;
  /**
   * `tapisSubmitConfigured`: a Tapis run needs it (`tapis_unconfigured`). Present only in the dry run of a
   * Tapis run, as `runners_enabled` is only in a runner's.
   */
  tapis_configured?: boolean;
}

export type DryRunResult =
  | {
      ok: false;
      code: "recipe_unknown" | "recipe_placeholder" | "invalid_spec";
      /** For `invalid_spec`: the field that is invalid, when the refusal names one (`input`). */
      field?: string;
    }
  | {
      ok: true;
      recipe: string;
      /** Who the run would be for. */
      executor: RecipeExecutor;
      /** What the run would read. */
      input: RecipeInput;
      /** For a runner run: the room under the runners' live cap (a runner run has no `room`). */
      runner_room?: RunnerRoom;
      /** What the hold of one job is, in milli-SU; 0 for a runner job, which has none. */
      estimate_milli_per_job: number;
      /** The same for every dataset listed. */
      estimate_milli_total: number;
      config: DryRunConfig;
      /** The datasets a run would dispatch (a named dataset that would be refused is not here). */
      would_dispatch: Array<{ dataset_id: string; version: string }>;
      /**
       * The room a run would have in the recipe's pool and what would bound it, as a live run reads it
       * (`clampRun`); `would_dispatch` of the queue is trimmed to it. Absent only when the recipe's tuple
       * is held (`registry_drift`), which stops a run before the caps are read.
       */
      room?: {
        daily_left: number;
        live_left: number;
        tenant_left: number;
        limited_by: ComputePipelineLimitedBy;
      };
      /**
       * Why a named dataset would be refused, or the count of the catalog's datasets that fail each term
       * of the predicate, over every dataset the queue read. A dataset fails every term it fails, so the
       * counts add up to more than the number of datasets.
       */
      blocked?: { code: string; blocked_by: PipelineTermId[]; version?: string };
      blocked_by_term?: Record<string, number>;
    };

/** A live or succeeded stamp for the tuple of a recipe over one dataset version and input: the claim would be refused. */
const liveStamp = (
  db: D1Database,
  datasetId: string,
  tag: string,
  recipe: ComputeRecipe,
  input: RecipeInput,
) =>
  db
    .prepare(
      `SELECT 1 FROM compute_pipeline_stamps
        WHERE dataset_id = ?1 AND version = ?2 AND recipe = ?3 AND recipe_version = ?4
          AND engine = ?5 AND input = ?6 AND state IN ('dispatched', 'succeeded')`,
    )
    .bind(datasetId, tag, recipe.name, recipe.version, recipe.engine, input)
    .first();

/**
 * The dry run of a runner run over ONE named dataset: the very verdict a run would give (`resolveRun`, a live
 * stamp for the tuple, the runners' live cap), with no estimate (a runner job has no hold) and the runners'
 * room in place of the daily cap and the tenant ceiling, which a runner job does not meet.
 */
async function runnerDryRun(
  env: Bindings,
  recipe: ComputeRecipe,
  base: {
    ok: true;
    recipe: string;
    executor: RecipeExecutor;
    input: RecipeInput;
    estimate_milli_per_job: number;
    config: DryRunConfig;
  },
  input: DryRunInput,
  room: RunnerRoom,
): Promise<DryRunResult> {
  const db = env.DB;
  const datasetId = input.datasetId as string;
  const shown = { ...base, runner_room: room, estimate_milli_total: 0 };
  const resolved = await resolveRun(db, datasetId, input.version, recipe, env, base.input);
  if (!resolved.ok) {
    return {
      ...shown,
      would_dispatch: [],
      blocked: {
        code: resolved.code,
        blocked_by: resolved.extra.blockedBy ?? [],
        ...(resolved.extra.version === undefined ? {} : { version: resolved.extra.version }),
        ...(resolved.extra.reason === undefined ? {} : { reason: resolved.extra.reason }),
      },
    };
  }
  const blocked = (code: string) => ({
    ...shown,
    would_dispatch: [],
    blocked: { code, blocked_by: [] as PipelineTermId[], version: resolved.tag },
  });
  if (await liveStamp(db, datasetId, resolved.tag, recipe, base.input)) {
    return blocked("live_attempt_exists");
  }
  if (room.live_left <= 0) return blocked("over_concurrency");
  return { ...shown, would_dispatch: [{ dataset_id: datasetId, version: resolved.tag }] };
}

/** The most dataset rows the dry run reads to count what blocks each term. */
const DRY_RUN_SCAN_ROWS = 5000;

/**
 * What a run would do, with nothing written: the eligible datasets (the queue trimmed to the room a live
 * run would have, `clampRun`), the estimated SU per job and in total, and what blocks the ineligible ones. It reads D1 and the configuration and nothing else, makes
 * no stamp, no job and no hold, calls neither Tapis nor a bucket, and works in every environment
 * (a non-production Worker answers from its own catalog). For one named dataset it gives the very
 * verdict a run would (`resolveRun`, and a live stamp for the tuple); for the queue it lists the next
 * candidates and, for the datasets that are not candidates, how many fail each term.
 */
export async function pipelineDryRun(env: Bindings, input: DryRunInput): Promise<DryRunResult> {
  const recipe = findRecipe(input.recipe);
  if (recipe === null) return { ok: false, code: "recipe_unknown" };
  const executor = input.executor ?? "tapis";
  // The route refuses these in its own words; a direct caller meets the boundary here. The executor is asked
  // before the placeholder, as `dispatchPipelineJob` asks it.
  if (!recipeRunsOn(recipe, executor)) {
    return { ok: false, code: "invalid_spec", field: "executor" };
  }
  if (recipe.placeholder === true) return { ok: false, code: "recipe_placeholder" };
  const recipeInput = input.input ?? defaultInput(executor);
  if (!recipeRunsInput(recipe, recipeInput, executor)) {
    return { ok: false, code: "invalid_spec", field: "input" };
  }
  if (executor === "runner" && input.datasetId === undefined) {
    return { ok: false, code: "invalid_spec" };
  }
  const db = env.DB;
  // A runner job is never priced (`estimateSuMilli` is not called for it).
  const perJob = executor === "runner" ? 0 : recipeEstimateMilli(recipe);
  const config: DryRunConfig = {
    compute_enabled: computeEnabled(env),
    runtime_image: readRuntimeImage(env).state === "ok",
    pipelines_account: (await pipelinesAccountId(db)) !== null,
    // Only a runner run asks for the switch: a Tapis run's answer is what it was before ADR 0121.
    ...(executor === "runner"
      ? { runners_enabled: computeRunnersEnabled(env) }
      : { tapis_configured: tapisSubmitConfigured(env) }),
  };
  const base = {
    ok: true as const,
    recipe: recipe.name,
    executor,
    input: recipeInput,
    estimate_milli_per_job: perJob,
    config,
  };
  if (await tupleHeld(db, recipe, recipeInput)) {
    return {
      ...base,
      estimate_milli_total: 0,
      would_dispatch: [],
      blocked: { code: "registry_drift", blocked_by: [] },
    };
  }

  // The caps, read as a live run reads them.
  const policy = (await getPolicy(db)).policy;
  if (executor === "runner") {
    return runnerDryRun(
      env,
      recipe,
      base,
      input,
      await runnerRoom(db, policy, poolOfRecipe(recipe)),
    );
  }
  const caps = await pipelineRoom(db, policy, poolOfRecipe(recipe));

  if (input.datasetId !== undefined) {
    // A named dataset is bounded by the live cap and only counted by the daily one (see `dispatchEligible`).
    const named = {
      ...caps,
      limited_by:
        caps.live_left <= 0
          ? ("live_cap" as const)
          : caps.tenant_left <= 0
            ? ("tenant" as const)
            : ("limit" as const),
    };
    const resolved = await resolveRun(db, input.datasetId, input.version, recipe, env, recipeInput);
    if (!resolved.ok) {
      return {
        ...base,
        room: named,
        estimate_milli_total: 0,
        would_dispatch: [],
        blocked: {
          code: resolved.code,
          blocked_by: resolved.extra.blockedBy ?? [],
          ...(resolved.extra.version === undefined ? {} : { version: resolved.extra.version }),
          ...(resolved.extra.reason === undefined ? {} : { reason: resolved.extra.reason }),
        },
      };
    }
    const live = await liveStamp(db, input.datasetId, resolved.tag, recipe, recipeInput);
    if (live) {
      return {
        ...base,
        room: named,
        estimate_milli_total: 0,
        would_dispatch: [],
        blocked: { code: "live_attempt_exists", blocked_by: [], version: resolved.tag },
      };
    }
    if (caps.live_left <= 0) {
      return {
        ...base,
        room: named,
        estimate_milli_total: 0,
        would_dispatch: [],
        blocked: { code: "over_concurrency", blocked_by: [], version: resolved.tag },
      };
    }
    // The tenant ceiling, worded after the class cap as a refused hold is.
    if (caps.tenant_left <= 0) {
      return {
        ...base,
        room: named,
        estimate_milli_total: 0,
        would_dispatch: [],
        blocked: { code: "platform_busy", blocked_by: [], version: resolved.tag },
      };
    }
    return {
      ...base,
      room: named,
      estimate_milli_total: perJob,
      would_dispatch: [{ dataset_id: input.datasetId, version: resolved.tag }],
    };
  }

  const room = clampRun(input.limit ?? 20, caps);
  const candidates =
    room.attempts > 0 ? await pipelineCandidates(env, recipe, room.attempts, "", recipeInput) : [];
  // Everything else: what the datasets that are not eligible fail, counted per term.
  const rows = (
    await db
      .prepare(`SELECT ${PIPELINE_ROW_COLUMNS} FROM datasets d ORDER BY d.dataset_id LIMIT ?1`)
      .bind(DRY_RUN_SCAN_ROWS)
      .all<PipelineRow>()
  ).results;
  const blockedByTerm: Record<string, number> = Object.fromEntries(
    pipelineTermsFor(env).map((t) => [t.id, 0]),
  );
  for (const row of rows) {
    for (const term of failedPipelineTerms(row, env))
      blockedByTerm[term] = (blockedByTerm[term] ?? 0) + 1;
  }
  return {
    ...base,
    room: {
      daily_left: room.daily_left,
      live_left: room.live_left,
      tenant_left: room.tenant_left,
      limited_by: room.limited_by,
    },
    estimate_milli_total: perJob * candidates.length,
    would_dispatch: candidates.map((c) => ({ dataset_id: c.dataset_id, version: c.tag })),
    blocked_by_term: blockedByTerm,
  };
}

// --- The room a run has --------------------------------------------------------------------------------------

/** The pool a recipe's jobs are held in, from the partition its job asks for. */
export const poolOfRecipe = (recipe: ComputeRecipe): ComputePool =>
  PARTITIONS[recipe.partition as PartitionName].pool;

/**
 * Pipeline jobs made today (UTC): `created_at` is `datetime('now')`, so a day starts at `date('now')`. The
 * daily cap paces spending and Tapis use, so it counts `accounting = 'su'` jobs only: a runner job is the
 * runners' cap's (ADR 0121).
 */
export const PIPELINE_JOBS_TODAY_SQL = `SELECT COUNT(*) AS n FROM compute_jobs
  WHERE source = 'pipeline' AND accounting = 'su' AND created_at >= date('now')`;

const countOf = async (db: D1Database, sql: string, ...binds: unknown[]): Promise<number> =>
  (
    await db
      .prepare(sql)
      .bind(...binds)
      .first<{ n: number }>()
  )?.n ?? 0;

/** Pipeline jobs made today (UTC), across every recipe and every pool, whoever dispatched them. */
export const pipelineJobsToday = (db: D1Database): Promise<number> =>
  countOf(db, PIPELINE_JOBS_TODAY_SQL);

/** What is left of NEMAR's pipelines' two caps, read from the owner's policy, for one pool. */
export interface PipelineRoom {
  /** `pipelines.dailyJobCap` minus the pipeline jobs made today, never below 0. */
  daily_left: number;
  /** `pipelines.maxLiveJobs` of the pool minus the pipeline jobs live in it, never below 0. */
  live_left: number;
  /**
   * The slots the pipelines' class could take under the tenant ceiling (`tenantRoom`), never below 0: the
   * ceiling less everything occupied less the slots the other classes' floors are still owed.
   */
  tenant_left: number;
}

/**
 * The room the pipelines have in a pool right now: the one reading of both caps, used by the daily
 * dispatcher, an administrator's run and the dry run. The live count is the statement the hold guards on
 * (`PIPELINE_LIVE_JOBS_SQL`), so the room that is read is the room that is enforced; the daily count
 * is a read and nothing more (a clamp, never a guard: see {@link dispatchEligible}). The tenant room is
 * the guard's own arithmetic over one read of the tenant counts (`TENANT_COUNTS_SQL`, which scans the table
 * for orphans), read once per call.
 *
 * `PIPELINE_JOBS_TODAY_SQL` is a full scan of `compute_jobs` (no index serves a count by `created_at`
 * over every account), so a caller that has the day's count already passes it as `today` and the scan is
 * not made again: the daily dispatcher counts once per tick, and `dispatchEligible` is handed the room
 * it computed instead of reading its own.
 */
export async function pipelineRoom(
  db: D1Database,
  policy: ComputePolicy,
  pool: ComputePool,
  today?: number,
): Promise<PipelineRoom> {
  const madeToday = today ?? (await pipelineJobsToday(db));
  const live = await countOf(db, PIPELINE_LIVE_JOBS_SQL, pool);
  return {
    daily_left: Math.max(0, policy.pipelines.dailyJobCap - madeToday),
    live_left: Math.max(0, policy.pipelines.maxLiveJobs[pool] - live),
    tenant_left: tenantRoom(await tenantFacts(db, policy), "pipelines"),
  };
}

/** What is left of the runners' live cap in one pool (ADR 0121): the room a runner run is enforced against. */
export interface RunnerRoom {
  /** `runners.maxLiveJobs` of the pool minus the live runner jobs in it, never below 0. */
  live_left: number;
  /** The owner's cap for the pool (the policy's default when it names none). */
  live_cap: number;
}

/**
 * The room the runners have in a pool right now. The live count is the statement the runner job's own INSERT
 * guards on (`RUNNER_LIVE_JOBS_SQL`), so the room that is read is the room that is enforced. Neither the
 * daily cap nor the tenant ceiling is read: a runner job holds no Tapis slot and spends no allocation.
 */
export async function runnerRoom(
  db: D1Database,
  policy: ComputePolicy,
  pool: ComputePool,
): Promise<RunnerRoom> {
  const cap = runnersPolicyOf(policy).maxLiveJobs[pool];
  const live = await countOf(db, RUNNER_LIVE_JOBS_SQL, pool);
  return { live_left: Math.max(0, cap - live), live_cap: cap };
}

/** How many datasets one run may try, and what bounded it. */
export interface RunRoom extends PipelineRoom {
  /** `min(limit, per-invocation bound, daily_left, live_left, tenant_left)`. */
  attempts: number;
  limited_by: ComputePipelineLimitedBy;
}

/**
 * The number of datasets a run over the eligible ones may try: the smallest of what was asked for, the
 * per-invocation bound (`COMPUTE_PIPELINE_RUN_PER_INVOCATION`: a Worker request cannot carry 100
 * dispatches, about 25 subrequests each against an allowance of about 1,000), what is left of the daily
 * cap, what is left of the pool's live cap and what is left of the tenant ceiling for the pipelines' class.
 * The same clamp serves the live run and the dry run, so a preview is what a run would do (the hold's own
 * guard still decides what is made, so a run that races another is refused there). On a tie the first of
 * `COMPUTE_PIPELINE_LIMITED_BY` is named (limit, per_invocation, daily_cap, live_cap, tenant), so a run that
 * ends at exactly the number it was asked for was not "limited".
 */
export function clampRun(limit: number, room: PipelineRoom): RunRoom {
  const candidates: Array<[ComputePipelineLimitedBy, number]> = [
    ["limit", limit],
    ["per_invocation", COMPUTE_PIPELINE_RUN_PER_INVOCATION],
    ["daily_cap", room.daily_left],
    ["live_cap", room.live_left],
    ["tenant", room.tenant_left],
  ];
  let [limited_by, attempts] = candidates[0] as [ComputePipelineLimitedBy, number];
  for (const [by, n] of candidates) {
    if (n < attempts) {
      attempts = n;
      limited_by = by;
    }
  }
  return { ...room, attempts, limited_by };
}

/** The word a run stops with when a cap, and not its own limit, ended it; null for the bound or the limit. */
export const stopWordOf = (by: ComputePipelineLimitedBy): PipelineRefusal | null =>
  by === "live_cap"
    ? "over_concurrency"
    : by === "daily_cap"
      ? "daily_cap_reached"
      : by === "tenant"
        ? "platform_busy"
        : null;

// --- A run over the queue ---------------------------------------------------------------------------------------

/** The refusals that would repeat for the next dataset, so a run over the queue stops at the first. */
const STOPS_A_RUN: ReadonlySet<PipelineRefusal> = new Set<PipelineRefusal>([
  "compute_disabled",
  "runtime_unavailable",
  "pipelines_account_missing",
  // The same for every dataset: no Tapis job can be submitted from this Worker.
  "tapis_unconfigured",
  "recipe_placeholder",
  "invalid_spec",
  "insufficient_balance",
  "platform_budget_exhausted",
  "suspended",
  "over_concurrency",
  // The tenant ceiling is full for the pipelines' class: the next dataset meets the same count.
  "platform_busy",
  "create_failed",
]);

export interface EligibleRun {
  results: DispatchResult[];
  dispatched: number;
  /** The refusal that stopped the run before the limit, if one did. */
  stoppedBy: PipelineRefusal | null;
  /** The room the run had and what bounded it; null when the run ended before it was read. */
  room: RunRoom | null;
}

/**
 * Dispatch a recipe over the next datasets it has not been run over: the stamps are synced first,
 * candidates are taken in dataset order, and every one goes through {@link dispatchPipelineJob}, so each
 * is checked again from its own row. A refusal that would repeat for the next dataset (a hold refused,
 * the switch off, no image, no account) stops the run; a refusal about one dataset does not.
 *
 * THE CAPS APPLY TO EVERY ACTOR. A run tries at most `min(limit, the per-invocation bound, daily_left,
 * live_left)` datasets (`clampRun`), read from the policy and the tables before it starts. When the
 * room is 0 nothing is tried and the run stops with `daily_cap_reached` or `over_concurrency`; when a
 * cap, and not the number asked for, ended a run that dispatched everything it tried, it stops with that
 * cap's word too (the per-invocation bound is no refusal: the run is asked again). The live cap is also a
 * guard inside every hold (`PIPELINE_LIVE_JOBS_GUARD_SQL`), so a run that raced another for the last slot
 * is refused there. The daily cap is only this read, a clamp and not a guard, for two reasons of P1:
 * `PIPELINE_JOBS_TODAY_SQL` is a full scan of `compute_jobs` (no index serves it), which a guard would
 * run inside every pipeline hold's write; and the ways around that (an account-bound count served by
 * `compute_jobs_account_created`, or a new index) need an account bind or a migration, which P1 has not.
 * So runs that race can together pass it: by up to (the number of racing runs minus 1) times
 * min(the per-invocation bound, the daily room, the live room), the bound of one run each time. The money
 * ceiling is a different fence: the pipelines pool's balance, enforced atomically by the same hold
 * (`HOLD_INSERT_SQL`; pipelines have no budget pool), though an overrun can push it below zero, so both
 * caps only pace spending. A single named dataset is bounded by the live guard and the pool's balance
 * and is only COUNTED by the daily cap, never refused by it (the owner ruled this for P1 and may override
 * later). An atomic daily guard, if wanted, belongs in P2 beside the tenant-ceiling guard, with an
 * account-bound count.
 */
export async function dispatchEligible(
  env: Bindings,
  input: {
    recipe: string;
    limit: number;
    actor: PipelineActor;
    after?: string;
    /** False when the caller has just synced the stamps itself (the cron, once for all its recipes). */
    sync?: boolean;
    /**
     * The room the caller has just read for this recipe's pool (`pipelineRoom`): used as it is, so the
     * day's count is not scanned a second time. Without it the run reads its own.
     */
    room?: PipelineRoom;
  },
): Promise<EligibleRun> {
  const run: EligibleRun = { results: [], dispatched: 0, stoppedBy: null, room: null };
  const recipe = findRecipe(input.recipe);
  if (recipe === null || recipe.placeholder === true) {
    const code = recipe === null ? "recipe_unknown" : "recipe_placeholder";
    run.results.push(fail(code, ""));
    run.stoppedBy = code;
    return run;
  }
  if (input.sync !== false) await syncPipelineStamps(env);
  // The queue is the Tapis executor's (a runner run names one dataset), so it reads the input Tapis runs.
  const recipeInput = defaultInput("tapis");
  if (await tupleHeld(env.DB, recipe, recipeInput)) {
    run.results.push(fail("registry_drift", ""));
    run.stoppedBy = "registry_drift";
    return run;
  }
  const caps =
    input.room ??
    (await pipelineRoom(env.DB, (await getPolicy(env.DB)).policy, poolOfRecipe(recipe)));
  const room = clampRun(input.limit, caps);
  run.room = room;
  if (room.attempts <= 0) {
    run.stoppedBy = stopWordOf(room.limited_by);
    return run;
  }
  try {
    for (const candidate of await pipelineCandidates(
      env,
      recipe,
      room.attempts,
      input.after,
      recipeInput,
    )) {
      if (run.dispatched >= room.attempts) break;
      const result = await dispatchPipelineJob(env, {
        recipe: recipe.name,
        datasetId: candidate.dataset_id,
        version: candidate.tag,
        actor: input.actor,
        executor: "tapis",
        input: recipeInput,
      });
      run.results.push(result);
      if (result.ok) {
        run.dispatched++;
      } else if (STOPS_A_RUN.has(result.code)) {
        run.stoppedBy = result.code;
        break;
      }
    }
    // A cap ended the run, not the number asked for and not a refusal: say which cap.
    if (run.stoppedBy === null && run.dispatched >= room.attempts) {
      run.stoppedBy = stopWordOf(room.limited_by);
    }
  } catch (err) {
    // What was dispatched before the throw is real (jobs exist, holds are taken): the run reports it
    // instead of losing the count to the exception, and says it was cut short.
    console.error(
      `[compute-pipeline] run_failed recipe=${recipe.name} dispatched=${run.dispatched} error=${err instanceof Error ? err.name : "unknown"}`,
    );
    run.stoppedBy = "run_failed";
  }
  return run;
}
