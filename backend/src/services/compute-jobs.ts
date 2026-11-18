/**
 * The compute gateway's job index and the one function that makes a job (epic #2005 phase A3, #2008;
 * ADR 0118, decisions 2, 3 and 9; design sections 5, 7 and 9).
 *
 * `createJob` validates a job, takes its hold and writes its index row in ONE batch, and only after
 * the batch has committed writes the job's records. Nothing submits to Tapis here: that is phase A5.
 *
 * THE RULES, each one deliberate:
 *  - A JOB AND ITS HOLD ARE ONE BATCH. The batch is the ledger's own hold statement
 *    (`holdStatements`, which carries the person's live-job limit as a guard READ INSIDE THE SAME
 *    STATEMENT, so two requests racing for the last slot cannot both win), then the pseudonym's
 *    `INSERT OR IGNORE`, then the job's INSERT, each of the last two gated on `EXISTS` of the hold row
 *    of this job. A refused hold therefore writes nothing at all: no job row, no ledger entry, no
 *    pseudonym. `changes` of the first statement says whether the hold was taken, and the reason is read
 *    after the refusal (`holdRefusalReason`), never decided by a second hold attempt.
 *  - A JOB ID HAS ONE HOLD FOR EVER (a partial unique index of the ledger enforces it): a job id is new
 *    for every request, so a resubmission is a new job; the hold's key is the job's (`holdKey`), so
 *    nobody picks one.
 *  - A RETRY FINDS ITS JOB. A request that carries an idempotency key and has a job under
 *    `(account, key)` returns that job, however its policy has changed since; the same key for another
 *    request is an error, never an answer with the first job (`ComputeJobError`, `idempotency_conflict`),
 *    because the caller would believe its other request was accepted. Two requests with one key racing
 *    each reach the batch, and the unique index refuses the second as a whole (a batch is one
 *    transaction): it then finds the first's job.
 *  - RECORDS ARE WRITTEN AFTER THE COMMIT, NEVER BEFORE: a bucket lock would make an orphan record for
 *    a refused job permanent. `records_written_at` is set when the job's own records have landed (for a
 *    job that uploads a code bundle or a partner's files, `finalizeBundle` or `finalizeSubmittedFiles`
 *    sets it, after the copy), and phase A5 refuses to
 *    submit without it. A write that fails after the commit leaves the job and its hold, says so
 *    (`recordsWritten: false`, one log line with the job id and a fixed word), and a replay of the same
 *    key writes what is missing; it never rewrites a record.
 *  - D1 JOB ROWS CARRY THE ACCOUNT ID AND FIXED WORDS ONLY. Identity is in `identity.json`, in the
 *    records bucket, and nowhere else. A log line carries a job id and a fixed word, never a path a
 *    person chose.
 *  - THE SPECIFICATION IS VALIDATED BEFORE ANY HOLD EXISTS: the schema, the dataset version tags that
 *    a launch needs (`datasetVersionWithoutTag`, `launchSpecFits`), the owner's per-job ceilings and the
 *    partitions offered to people, and the bundle's size. A refusal there is `invalid_spec`,
 *    `over_job_limit`, `partition_not_offered` or `bundle_too_large`, and writes nothing. What a route
 *    adds (runtime availability, the registries an image may come from, which datasets are eligible) is
 *    the route's.
 *  - `spec_digest` is the SHA-256 of the exact bytes of `records/<id>/spec.json`: the text is made once,
 *    before the INSERT, and the same text is written after the commit. It records what was ASKED FOR and
 *    never the launch specification, which carries a token. For a person's or a pipeline's job the text
 *    is the validated specification; for a PARTNER's job it is the partner's own hold body, byte for
 *    byte as it was sent (`holdBody`), so a respelled body is another request, and only the small fields
 *    a hold needs (`PartnerHoldBodySchema`) are read from it. A hold body is not a job specification,
 *    so none of the launch rules (the schema, `launchSpecFits`, the bundle) apply to it.
 *  - THE GATEWAY PSEUDONYM is `gw_` and 20 lowercase base32 characters, RANDOM, stored in
 *    `compute_gateway_users` on an account's first job and copied to every job of that account, never
 *    rotated and never reused. It is random and stored, not derived from a key: a derived value would
 *    change if the key were rotated. NEMAR's own pipeline jobs carry the literal `nemar-pipelines`.
 *  - The pipelines' own caps are not a person's limit: a pipeline job is held on the platform `pipelines`
 *    pool, names no budget, and meets no per-person guard. It meets the pipelines' LIVE cap instead
 *    (`PIPELINE_LIVE_JOBS_GUARD_SQL`, the owner's `pipelines.maxLiveJobs` for the job's pool, whatever the
 *    recipe and whoever dispatches it), read inside the hold's own statement exactly as the person's
 *    limit is, so the daily dispatcher, an administrator's run and a named dataset cannot together exceed
 *    it however they interleave. The daily count (`pipelines.dailyJobCap`) is the dispatchers' to read
 *    (`pipelineRoom`), not a guard: it clamps a run and does not refuse a dataset an administrator names
 *    (issue #2121, ADR 0118 amendment of 2026-11-10).
 *  - EVERY source also meets the TENANT ceiling (`tenantGuard`, `compute-tenant.ts`, phase P2 of #2121): NEMAR's
 *    total of live jobs and the slots kept for the other classes are counted in the same statement, so a job
 *    that would pass the ceiling or take a floor another class is owed is refused `platform_busy`. A refusal
 *    is worded after the batch by asking each guard again in order (`guardRefusal`): the class's own cap
 *    first, then the tenant. Whoever merges another branch into the `guards` block keeps both.
 *  - A RUNNER JOB HAS NO HOLD (portable compute, ADR 0121). `executor: "runner"` (a `pipeline` job only) takes the
 *    runner branch (`createRunnerJob`): the same validation, records and idempotency, then ONE statement,
 *    `RUNNER_JOB_INSERT_SQL`, gated on the runners' live cap (`RUNNER_LIVE_JOBS_GUARD_SQL`, the owner's
 *    `runners.maxLiveJobs` of the pool) and writing `executor = 'runner'`, `accounting = 'none'`, no hold link and
 *    no ledger entry. `estimateSuMilli`, the pool rows, the tenant guard and the hold statements are never reached,
 *    so a runner job occupies no Tapis slot and no budget; `JOB_INSERT_SQL`, `GATEWAY_USER_INSERT_SQL` and the
 *    hold are byte-for-byte what they were (a test pins their text).
 */

import { z } from "zod";
import {
  COMPUTE_EXECUTORS,
  COMPUTE_KINDS,
  COMPUTE_SOURCES,
  type ComputeAccounting,
  type ComputeExecutor,
  type ComputeKind,
  type ComputeRefusalCode,
  type ComputeSource,
  type ComputeState,
  type RunnerBackend,
} from "../../../shared/compute-state.js";
import { launchSpecFits } from "../../../shared/contract/compute-launch.js";
import {
  COMPUTE_IMAGE_DIGEST_RE,
  type ComputePool,
  type JobSpec,
  JobSpecSchema,
  PARTITIONS,
  PARTITION_NAMES,
  PIPELINES_TAPIS_OWNER,
  type PartitionName,
  computeSafeInt,
  datasetVersionWithoutTag,
  estimateSuMilli,
  runnersPolicyOf,
  tenantPolicyOf,
} from "../../../shared/contract/compute.js";
import {
  type HoldGuard,
  POOL_BY_HOLDER_SQL,
  type PoolRow,
  holdRefusalReason,
  holdStatements,
  platformPool,
} from "./compute-ledger.js";
import { fieldPath, getPolicy } from "./compute-policy.js";
import {
  type ComputeRecordsEnv,
  RECORDS_WRITTEN_SQL,
  copyableLimit,
  sha256Hex,
  writeIdentitySnapshot,
  writeSpec,
} from "./compute-records.js";
import {
  LIVE_STATES_SQL,
  TAPIS_REPORTING_STATES_SQL,
  TERMINAL_STATES_SQL,
} from "./compute-state-sql.js";
import { tenantClassOf, tenantGuard } from "./compute-tenant.js";

// --- Errors and shapes ---------------------------------------------------------------------------

export type ComputeJobErrorCode = "invalid_argument" | "idempotency_conflict" | "pool_not_found";

/**
 * What is not a refusal: an argument that is not what the table takes (a programming error, never a
 * person's request), a key reused for another request, a platform pool that is not there. Nothing has
 * been written when one is thrown.
 */
export class ComputeJobError extends Error {
  constructor(
    readonly code: ComputeJobErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ComputeJobError";
  }
}

const invalid = (message: string): never => {
  throw new ComputeJobError("invalid_argument", message);
};

/** A row of `compute_jobs`, every column, as D1 returns it. */
export interface ComputeJobRow {
  id: string;
  account_id: number | null;
  tapis_owner: string | null;
  gateway_user: string | null;
  idempotency_key: string | null;
  source: ComputeSource;
  client_id: string | null;
  kind: ComputeKind;
  state: ComputeState;
  failure_code: string | null;
  failure_detail: string | null;
  cancel_reason: string | null;
  cancel_requested_at: string | null;
  tapis_uuid: string | null;
  tapis_status: string | null;
  slurm_job_id: string | null;
  app_id: string;
  app_version: string;
  image_digest: string | null;
  spec_digest: string;
  partition: string;
  pool: ComputePool;
  nodes: number;
  cores_per_node: number;
  memory_mb: number | null;
  gpus: number;
  minutes: number;
  created_at: string;
  submitted_at: string | null;
  remote_submitted_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  tapis_synced_at: string | null;
  records_written_at: string | null;
  hold_ledger_id: number | null;
  held_milli: number;
  charged_milli: number;
  settled_provisional_at: string | null;
  settled_final_at: string | null;
  flag_unreserved: number;
  flag_unattributed: number;
  flag_mismatch: number;
  flag_overrun: number;
  retention_until: string | null;
  /**
   * UNUSED: always 0, and nothing reads or writes it. The hold that counts is a row of `compute_legal_holds`
   * (migration 0118), read by `heldSql` in `compute-legal-holds.ts`; the retention sweep and the reporting
   * both ask that table. The column is kept because dropping a column is a migration of its own.
   */
  legal_hold: number;
  webhook_nonce: string | null;
  /**
   * Phase A5 (migration 0116): the SHA-256 of the launch specification's JSON TEXT, which is what the
   * `NEMAR_LAUNCH_SPEC` value (base64url) decodes to, never of the encoded value; NULL until submit.
   */
  launch_spec_digest: string | null;
  results_verified_at: string | null;
  outputs_completed_at: string | null;
  /** The bytes the job declared to the outputs route, claimed against the results budget. */
  results_bytes: number | null;
  result_records_at: string | null;
  /** 1 when `isPlatformFailure` says NEMAR caused the failure: an information flag, never a ledger write. */
  platform_failure: number;
  /** The last time the 30-minute tick examined the row, successfully or not: the rotation's key. */
  examined_at: string | null;
  /** The submitter's lease: a submitter that holds it is the only one that may reach Tapis. */
  submit_claimed_at: string | null;
  /** A Tapis job NEMAR made that no row owns, whose cancel is still owed. */
  orphan_tapis_uuid: string | null;
  /** Portable compute (migration 0140, ADR 0121): who runs the job, `tapis` unless a runner pulls it. */
  executor: ComputeExecutor;
  /** `su` is the ledger in service units; `none` (a runner job only) writes no ledger entry. */
  accounting: ComputeAccounting;
  runner_backend: RunnerBackend | null;
  /** The registration that claimed the job, NULL while it waits. */
  runner_id: string | null;
  runner_claimed_at: string | null;
  lease_id: string | null;
  lease_expires_at: string | null;
  claim_attempts: number;
  runner_remote_id: string | null;
  /** The runner's own measurements, labeled "runner-reported" wherever shown, never SU. */
  runner_wall_seconds: number | null;
  runner_cpu_seconds: number | null;
  runner_max_rss_mb: number | null;
}

export type ComputeJobsEnv = ComputeRecordsEnv;

interface JobInputBase {
  /** The person the job is attributed to; null for a partner's job that no NEMAR account owns (a partner pool pays). */
  accountId: number | null;
  /** The partner client, for a partner job. Required when there is no account. */
  clientId?: string | null;
  /** The Tapis owner of a partner job. */
  tapisOwner?: string | null;
  /**
   * The caller's key, 8 to 128 characters of letters, digits and `. _ : -`; unique per account. A job
   * with no account takes none: the unique index treats NULL accounts as distinct, so a key could be
   * stored and never found. A partner's replay is keyed by the partner contract's own table
   * (#2024, #2025).
   */
  idempotencyKey?: string | null;
}

/** A person's or a pipeline's job: the job as every front door states it. */
export interface SpecJobInput extends JobInputBase {
  source: Exclude<ComputeSource, "partner">;
  /** Default `batch`. */
  kind?: ComputeKind;
  /** The Tapis application that runs it, and its version. */
  appId: string;
  appVersion: string;
  /** Checked again here with the strict schema. */
  spec: JobSpec;
  holdBody?: undefined;
  /**
   * Who runs the job (ADR 0121): `tapis` by default, or `runner`, which makes a job with no hold and no
   * ledger entry (`accounting = 'none'`) that a registered runner pulls. Only a `pipeline` job can name a
   * runner; any other source is refused as an argument error.
   */
  executor?: ComputeExecutor;
}

/** A partner's job: its hold body, as the exact text that was sent. */
export interface PartnerJobInput extends JobInputBase {
  source: "partner";
  /** The request body, byte for byte: its SHA-256 is the job's `spec_digest` and it is `spec.json`. */
  holdBody: string;
  spec?: undefined;
  kind?: undefined;
  appId?: undefined;
  appVersion?: undefined;
  executor?: undefined;
}

export type CreateJobInput = SpecJobInput | PartnerJobInput;

/** The most bytes of a hold body: it is nine small fields. */
export const PARTNER_HOLD_BODY_MAX_BYTES = 8192;

/**
 * What a partner's hold says (`POST /compute/holds`, #2025): the application, its version, the kind and
 * the resources, per node. Strict, like every request. The route (phase D4) may move this schema into
 * its own contract module; the fields are the ones the partner contract names.
 */
export const PartnerHoldBodySchema = z
  .object({
    app_id: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
    app_version: z.string().regex(/^[A-Za-z0-9._+-]{1,64}$/),
    kind: z.enum(COMPUTE_KINDS),
    partition: z.enum(PARTITION_NAMES),
    nodes: computeSafeInt(1, 64),
    cores: computeSafeInt(0, 256),
    memory_mb: computeSafeInt(1, 16_777_216).nullish(),
    gpus: computeSafeInt(0, 8),
    minutes: computeSafeInt(1, 10080),
  })
  .strict()
  .superRefine((body, ctx) => {
    const gpuPool = PARTITIONS[body.partition].pool === "gpu";
    if (gpuPool && body.gpus < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gpus"],
        message: "a GPU partition needs a GPU",
      });
    }
    if (!gpuPool && body.gpus !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gpus"],
        message: "a CPU partition takes no GPU",
      });
    }
  });

export type PartnerHoldBody = z.infer<typeof PartnerHoldBodySchema>;

export type CreateJobRefusal = Extract<
  ComputeRefusalCode,
  | "compute_disabled"
  | "invalid_spec"
  | "partition_not_offered"
  | "over_job_limit"
  | "bundle_too_large"
  | "insufficient_balance"
  | "suspended"
  | "platform_budget_exhausted"
  | "over_concurrency"
  | "platform_busy"
>;

export type CreateJobResult =
  | {
      ok: true;
      /** The job existed already under this key. */
      replayed: boolean;
      job: ComputeJobRow;
      /**
       * `spec.json` and `identity.json` have landed. That is NOT "ready to submit": a job that uploads
       * something (a code bundle, a partner's files) is ready only when `job.records_written_at` is set,
       * which `finalizeBundle` or `finalizeSubmittedFiles` does after the copy. False after a store
       * failure; a replay of the key retries it.
       */
      recordsWritten: boolean;
    }
  | { ok: false; code: CreateJobRefusal; field?: string };

// --- Ids -------------------------------------------------------------------------------------------

function randomHex(bytes: number): string {
  const buffer = crypto.getRandomValues(new Uint8Array(bytes));
  let out = "";
  for (let i = 0; i < buffer.length; i++)
    out += (buffer[i] as number).toString(16).padStart(2, "0");
  return out;
}

/** A new job id: `job_` and 24 lowercase hex digits (96 random bits). */
export const newJobId = (): string => `job_${randomHex(12)}`;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A new gateway pseudonym: `gw_` and 20 base32 characters (100 random bits, each byte taken mod 32). */
export function newGatewayUser(): string {
  const buffer = crypto.getRandomValues(new Uint8Array(20));
  let out = "gw_";
  for (let i = 0; i < buffer.length; i++) out += BASE32[(buffer[i] as number) % 32];
  return out;
}

// --- Statements ------------------------------------------------------------------------------------

// `legal_hold` is selected for the row type but UNUSED (always 0): the hold that counts is a row of
// `compute_legal_holds` (see `heldSql`).
const JOB_COLUMNS = `id, account_id, tapis_owner, gateway_user, idempotency_key, source, client_id, kind,
  state, failure_code, failure_detail, cancel_reason, cancel_requested_at, tapis_uuid, tapis_status,
  slurm_job_id, app_id, app_version, image_digest, spec_digest, partition, pool, nodes,
  cores_per_node, memory_mb, gpus, minutes, created_at, submitted_at, remote_submitted_at, started_at,
  ended_at, tapis_synced_at, records_written_at, hold_ledger_id, held_milli, charged_milli,
  settled_provisional_at, settled_final_at, flag_unreserved, flag_unattributed, flag_mismatch,
  flag_overrun, retention_until, legal_hold, webhook_nonce, launch_spec_digest, results_verified_at,
  outputs_completed_at, results_bytes, result_records_at, platform_failure, examined_at,
  submit_claimed_at, orphan_tapis_uuid, executor, accounting, runner_backend, runner_id,
  runner_claimed_at, lease_id, lease_expires_at, claim_attempts, runner_remote_id,
  runner_wall_seconds, runner_cpu_seconds, runner_max_rss_mb`;

export const JOB_BY_ID_SQL = `SELECT ${JOB_COLUMNS} FROM compute_jobs WHERE id = ?1`;

/** A retried request finds its job: `?1` the account, `?2` the key; the partial unique index answers it. */
export const JOB_BY_KEY_SQL = `SELECT ${JOB_COLUMNS} FROM compute_jobs
  WHERE account_id = ?1 AND idempotency_key = ?2`;

/** The live states as a SQL list, from the one list of them: the partial index answers only this literal. */
// The state lists live in compute-state-sql.ts (no cycle with the tenant guard); they stay importable here.
export { LIVE_STATES_SQL, TAPIS_REPORTING_STATES_SQL, TERMINAL_STATES_SQL };

/**
 * A person's live-job limit, as a guard on the hold (plain `?` placeholders: the account and the
 * limit). It counts rows INSIDE the hold's own statement, so two requests racing for the last slot
 * cannot both pass it; the count is answered by the partial index of migration 0115.
 */
export const LIVE_JOBS_GUARD_SQL = `(SELECT COUNT(*) FROM compute_jobs
   WHERE account_id = ? AND state IN (${LIVE_STATES_SQL})) < ?`;

/**
 * The pipeline jobs live in a pool, counted over the same live states as a person's (`?` the pool word),
 * so the planner answers it from a partial index of the live rows and never scans the table. A pipeline job's account is the pipelines service
 * account, or none, so the count does not name an account: the owner's cap is on NEMAR's pipelines in
 * total per pool, whatever the recipe. The dispatchers read it (`pipelineRoom`) and the hold guards on it
 * (`PIPELINE_LIVE_JOBS_GUARD_SQL`); one statement, so the room that is read and the room that is
 * enforced cannot differ. It counts `accounting = 'su'` jobs only: a runner job holds no Tapis slot and no
 * hold, so it is the runners' cap's (`RUNNER_LIVE_JOBS_SQL`), never this one's (ADR 0121 decision 1).
 */
export const PIPELINE_LIVE_JOBS_SQL = `SELECT COUNT(*) AS n FROM compute_jobs
   WHERE source = 'pipeline' AND accounting = 'su' AND pool = ? AND state IN (${LIVE_STATES_SQL})`;

/**
 * The pipelines' live cap, as a guard on the hold (plain `?` placeholders: the pool word, then the
 * limit `policy.pipelines.maxLiveJobs[pool]`). Counted INSIDE the hold's own statement, so two requests
 * racing for the last slot of a pool cannot both win; a refusal is `over_concurrency`.
 */
export const PIPELINE_LIVE_JOBS_GUARD_SQL = `(${PIPELINE_LIVE_JOBS_SQL}) < ?`;

/** A guard of the hold and the refusal word it answers with. */
interface NamedGuard {
  guard: HoldGuard;
  refusal: Extract<CreateJobRefusal, "over_concurrency" | "platform_busy">;
}

/**
 * The word for a hold that a guard refused (the balance and the pool were read first: see
 * `holdRefusalReason`): each guard is asked again, in order, with the binds it was given, and the first
 * that no longer passes names the refusal. A class's own cap therefore comes before the tenant ceiling.
 * If every guard passes now (a slot was freed between the refusal and this read) the first guard's word
 * is given: the request was refused, and it may ask again.
 */
async function guardRefusal(
  db: D1Database,
  guards: readonly NamedGuard[],
): Promise<NamedGuard["refusal"]> {
  for (const { guard, refusal: word } of guards) {
    const row = await db
      .prepare(`SELECT ${guard.sql} AS ok`)
      .bind(...(guard.binds ?? []))
      .first<{ ok: number | null }>();
    if (row?.ok !== 1) return word;
  }
  return (guards[0] as NamedGuard).refusal;
}

/** The hold row of a job exists: the one gate both of the batch's later statements wait behind. */
const holdExists = (jobParam: number): string =>
  `EXISTS (SELECT 1 FROM compute_ledger l WHERE l.kind = 'hold' AND l.job_id = ?${jobParam})`;

/**
 * An account's pseudonym, made once: `?1` the account, `?2` a new pseudonym, `?3` the job. It writes
 * only if THIS job's hold was taken, and an account that has one keeps it (`OR IGNORE`).
 */
export const GATEWAY_USER_INSERT_SQL = `INSERT OR IGNORE INTO compute_gateway_users (account_id, gateway_user)
  SELECT ?1, ?2
   WHERE ${holdExists(3)}`;

/**
 * The job's index row. `?1` id, `?2` account, `?3` Tapis owner, `?4` the pipelines' literal (or NULL,
 * and the pseudonym is then the account's), `?5` key, `?6` source, `?7` client, `?8` kind, `?9` app,
 * `?10` version, `?11` image digest, `?12` spec digest, `?13` partition, `?14` pool, `?15` nodes,
 * `?16` cores, `?17` memory, `?18` GPUs, `?19` minutes, `?20` held, `?21` webhook nonce. It writes
 * only if the hold row of this job exists (the EXISTS term: without it a refused hold would leave a
 * job), and links the hold's entry.
 */
export const JOB_INSERT_SQL = `INSERT INTO compute_jobs
  (id, account_id, tapis_owner, gateway_user, idempotency_key, source, client_id, kind, app_id,
   app_version, image_digest, spec_digest, partition, pool, nodes, cores_per_node, memory_mb, gpus,
   minutes, hold_ledger_id, held_milli, webhook_nonce)
  SELECT ?1, ?2, ?3,
         COALESCE(?4, (SELECT g.gateway_user FROM compute_gateway_users g WHERE g.account_id = ?2)),
         ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19,
         (SELECT l.id FROM compute_ledger l WHERE l.kind = 'hold' AND l.job_id = ?1),
         ?20, ?21
   WHERE ${holdExists(1)}`;

// --- Runner jobs (portable compute, ADR 0121) ---------------------------------------------------------

/**
 * The live `accounting = 'none'` runner jobs of a pool (`?1` the pool word), over the same live states as every
 * count above, so the room the administrator is shown (`runnerRoom`) is the room the guard enforces. It counts
 * the runners' own jobs and nothing else: a Tapis job is `accounting = 'su'` (a CHECK of migration 0140), so
 * neither count can see the other's rows.
 */
export const RUNNER_LIVE_JOBS_SQL = `SELECT COUNT(*) AS n FROM compute_jobs
   WHERE executor = 'runner' AND accounting = 'none' AND pool = ?1 AND state IN (${LIVE_STATES_SQL})`;

/**
 * The runners' live cap as the guard of a runner job's own INSERT: live runner jobs of the pool (`?21`) fewer
 * than the owner's `policy.runners.maxLiveJobs` for it (`?22`). It is counted INSIDE the INSERT's statement, so
 * two requests racing for the last slot cannot both win; a runner job has no hold to carry the guard, so this
 * statement is its only admission. The numbered placeholders continue those of {@link RUNNER_JOB_INSERT_SQL}.
 */
export const RUNNER_LIVE_JOBS_GUARD_SQL = `(SELECT COUNT(*) FROM compute_jobs
   WHERE executor = 'runner' AND accounting = 'none' AND pool = ?21 AND state IN (${LIVE_STATES_SQL})) < ?22`;

/**
 * A runner job's index row. `?1` id, `?2` account, `?3` Tapis owner, `?4` the pipelines' literal, `?5` key,
 * `?6` source, `?7` client, `?8` kind, `?9` app, `?10` version, `?11` image digest, `?12` spec digest, `?13`
 * partition (a sizing label), `?14` pool, `?15` nodes, `?16` cores, `?17` memory, `?18` GPUs, `?19` minutes,
 * `?20` webhook nonce, then the guard's `?21` and `?22`. It writes only while the runners' live cap has room
 * (`WHERE`), so a refused job leaves nothing; there is no hold (`hold_ledger_id` NULL, `held_milli` 0) and no
 * pseudonym row: only a pipeline job can be a runner job (a CHECK of migration 0140), and a pipeline job carries
 * the literal. `executor` and `accounting` are written as literals, never bound, so no caller can name another
 * class through this statement.
 */
export const RUNNER_JOB_INSERT_SQL = `INSERT INTO compute_jobs
  (id, account_id, tapis_owner, gateway_user, idempotency_key, source, client_id, kind, app_id,
   app_version, image_digest, spec_digest, partition, pool, nodes, cores_per_node, memory_mb, gpus,
   minutes, webhook_nonce, executor, accounting)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
         'runner', 'none'
   WHERE ${RUNNER_LIVE_JOBS_GUARD_SQL}`;

export async function getJob(db: D1Database, id: string): Promise<ComputeJobRow | null> {
  return db.prepare(JOB_BY_ID_SQL).bind(id).first<ComputeJobRow>();
}

// --- Arguments -----------------------------------------------------------------------------------

const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const CLIENT_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const OWNER_RE = /^[A-Za-z0-9_.@+-]{1,128}$/;
const APP_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
const APP_VERSION_RE = /^[A-Za-z0-9._+-]{1,64}$/;

interface Args {
  source: ComputeSource;
  executor: ComputeExecutor;
  /** Null for a partner's job until its hold body has been read. */
  kind: ComputeKind | null;
  accountId: number | null;
  clientId: string | null;
  tapisOwner: string | null;
  key: string | null;
  appId: string | null;
  appVersion: string | null;
}

function checkInput(input: CreateJobInput): Args {
  if (!(COMPUTE_SOURCES as readonly string[]).includes(input.source)) invalid("not a job source");
  const partner = input.source === "partner";
  if (partner) {
    if (typeof input.holdBody !== "string") invalid("a partner's job is its hold body, as text");
    if (input.spec !== undefined || input.appId !== undefined || input.appVersion !== undefined) {
      invalid("a partner's job names no specification, application or version of its own");
    }
  } else if (input.holdBody !== undefined) {
    invalid("only a partner's job is a hold body");
  }
  const executor = input.executor ?? "tapis";
  if (!(COMPUTE_EXECUTORS as readonly string[]).includes(executor)) invalid("not an executor");
  if (executor === "runner" && input.source !== "pipeline") {
    invalid("only a pipeline job can be a runner job");
  }
  const kind = input.kind ?? (partner ? null : "batch");
  if (kind !== null && !(COMPUTE_KINDS as readonly string[]).includes(kind))
    invalid("not a job kind");
  const accountId = input.accountId;
  if (accountId !== null && (!Number.isSafeInteger(accountId) || accountId < 1)) {
    invalid("an account is a positive whole number, or none");
  }
  const clientId = input.clientId ?? null;
  if (clientId !== null && !CLIENT_RE.test(clientId)) invalid("a partner client is a short word");
  if (accountId === null && input.source !== "pipeline") {
    if (input.source !== "partner" || clientId === null) {
      invalid("a job for a person names its account; a partner's job with none names its client");
    }
  }
  const tapisOwner = input.tapisOwner ?? null;
  if (tapisOwner !== null && !OWNER_RE.test(tapisOwner)) invalid("a Tapis owner is a short name");
  const key = input.idempotencyKey ?? null;
  if (key !== null && !KEY_RE.test(key)) {
    invalid("an idempotency key is 8 to 128 letters, digits and . _ : -");
  }
  if (key !== null && accountId === null) {
    invalid("an idempotency key needs an account: a job with none could never be replayed");
  }
  if (!partner) {
    if (typeof input.appId !== "string" || !APP_ID_RE.test(input.appId)) {
      invalid("not an application id");
    }
    if (typeof input.appVersion !== "string" || !APP_VERSION_RE.test(input.appVersion)) {
      invalid("not an application version");
    }
  }
  return {
    source: input.source,
    executor,
    kind: kind as ComputeKind | null,
    accountId,
    clientId,
    tapisOwner,
    key,
    appId: input.appId ?? null,
    appVersion: input.appVersion ?? null,
  };
}

/** What a hold body is read as, or the field that is wrong (never a value). */
type HoldBodyRead = { ok: true; body: PartnerHoldBody } | { ok: false; field?: string };

function readHoldBody(text: string): HoldBodyRead {
  if (new TextEncoder().encode(text).length > PARTNER_HOLD_BODY_MAX_BYTES) return { ok: false };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  const parsed = PartnerHoldBodySchema.safeParse(value);
  if (parsed.success) return { ok: true, body: parsed.data };
  const path = parsed.error.issues[0]?.path ?? [];
  return path.length > 0 ? { ok: false, field: fieldPath(path) } : { ok: false };
}

const looksUnique = (err: unknown) => /UNIQUE constraint failed/i.test(String(err));

const refusal = (code: CreateJobRefusal, field?: string): CreateJobResult =>
  field === undefined ? { ok: false, code } : { ok: false, code, field };

// --- Records, after the commit ---------------------------------------------------------------------

/**
 * Write a job's own records, the specification and the identity snapshot, and, for a job that uploads
 * nothing, mark them written. Never throws: a failure is one log line (the job id and the error's
 * class, nothing a person chose) and `false`, and the job is left as it is for a replay to finish.
 */
export async function writeRecords(
  env: ComputeJobsEnv,
  job: ComputeJobRow,
  specText: string,
  uploads: boolean,
): Promise<boolean> {
  try {
    await writeSpec(env, job.id, specText);
    await writeIdentitySnapshot(env, job.id, job.account_id);
    if (!uploads) await env.DB.prepare(RECORDS_WRITTEN_SQL).bind(job.id).run();
    return true;
  } catch (err) {
    console.error(
      `[compute-jobs] records_unavailable job=${job.id} error=${err instanceof Error ? err.name : "unknown"}`,
    );
    return false;
  }
}

/** The existing job a key found, as a replay: its records finished if they were not, never rewritten. */
async function replay(
  env: ComputeJobsEnv,
  existing: ComputeJobRow,
  specDigest: string,
  specText: string,
  uploads: boolean,
  executor: ComputeExecutor = "tapis",
): Promise<CreateJobResult> {
  // The same key for a request of another executor is another request, whatever its specification says.
  if (existing.spec_digest !== specDigest || existing.executor !== executor) {
    throw new ComputeJobError(
      "idempotency_conflict",
      "that idempotency key was used for a different request",
    );
  }
  let job = existing;
  let recordsWritten = existing.records_written_at !== null;
  if (!recordsWritten) {
    recordsWritten = await writeRecords(env, existing, specText, uploads);
    job = (await getJob(env.DB, existing.id)) ?? existing;
  }
  return { ok: true, replayed: true, job, recordsWritten };
}

// --- createJob -------------------------------------------------------------------------------------

/** What a hold prices and a job row records of the resources, per node. */
interface HoldResources {
  partition: PartitionName;
  nodes: number;
  cores: number;
  memory_mb?: number;
  gpus: number;
  minutes: number;
}

const imageDigestOf = (image: string | undefined): string | null => {
  const digest = image === undefined ? null : (/@(sha256:[0-9a-f]{64})$/.exec(image)?.[1] ?? null);
  return digest !== null && COMPUTE_IMAGE_DIGEST_RE.test(digest) ? digest : null;
};

/** What {@link createRunnerJob} needs of the validated request: everything `createJob` already decided. */
interface RunnerJobPlan {
  args: Args;
  resources: HoldResources;
  appId: string;
  appVersion: string;
  kind: ComputeKind;
  spec: JobSpec;
  specText: string;
  specDigest: string;
  uploads: boolean;
  maxLive: { cpu: number; gpu: number };
}

/**
 * The runner branch of {@link createJob}: the same validation, records and idempotency, with no hold. The
 * partition is a sizing label (`shared`): the FIXED ceiling of `PARTITIONS` applies (a runner job is not offered
 * to people, so the owner's per-person ceilings are not read), `estimateSuMilli` is never called, no pool row or
 * ledger entry is touched, and the one statement of the batch is {@link RUNNER_JOB_INSERT_SQL}, which the
 * runners' live cap gates. Nothing is written for a refusal; `over_concurrency` is the cap's word.
 */
async function createRunnerJob(env: ComputeJobsEnv, plan: RunnerJobPlan): Promise<CreateJobResult> {
  const { args, resources, spec, specText, specDigest, uploads } = plan;
  const db = env.DB;
  const label = PARTITIONS[resources.partition];
  const ceiling = label.ceiling;
  if (!ceiling) return refusal("partition_not_offered");
  if (
    resources.nodes > ceiling.maxNodes ||
    resources.cores > ceiling.maxCoresPerNode ||
    resources.gpus > ceiling.maxGpusPerNode ||
    resources.minutes > ceiling.maxMinutes
  ) {
    return refusal("over_job_limit");
  }
  const byKey = async (): Promise<CreateJobResult | null> => {
    if (args.key === null || args.accountId === null) return null;
    const existing = await db
      .prepare(JOB_BY_KEY_SQL)
      .bind(args.accountId, args.key)
      .first<ComputeJobRow>();
    return existing ? replay(env, existing, specDigest, specText, uploads, "runner") : null;
  };

  const jobId = newJobId();
  let changes: number;
  try {
    changes =
      (
        await db.batch([
          db
            .prepare(RUNNER_JOB_INSERT_SQL)
            .bind(
              jobId,
              args.accountId,
              args.tapisOwner,
              PIPELINES_TAPIS_OWNER,
              args.key,
              args.source,
              args.clientId,
              plan.kind,
              plan.appId,
              plan.appVersion,
              imageDigestOf(spec.image),
              specDigest,
              resources.partition,
              label.pool,
              resources.nodes,
              resources.cores,
              resources.memory_mb ?? null,
              resources.gpus,
              resources.minutes,
              crypto.randomUUID(),
              label.pool,
              plan.maxLive[label.pool],
            ),
        ])
      )[0]?.meta?.changes ?? 0;
  } catch (err) {
    // Another request with this key got there first: the batch was refused as a whole.
    if (looksUnique(err)) {
      const found = await byKey();
      if (found) return found;
    }
    throw err;
  }
  if (changes === 0) {
    // A retry that raced its own original request finds the job under its key; anything else is the cap.
    return (await byKey()) ?? refusal("over_concurrency");
  }

  const created = await getJob(db, jobId);
  if (!created) throw new Error("a job that was just written could not be read");
  const recordsWritten = await writeRecords(env, created, specText, uploads);
  const job = recordsWritten ? ((await getJob(db, jobId)) ?? created) : created;
  return { ok: true, replayed: false, job, recordsWritten };
}

/**
 * Make a job and its hold, or refuse, and leave no trace of a refusal. See the file's header for the
 * rules. Returns the job (`recordsWritten` says whether its records landed), or a refusal word of
 * `shared/compute-state.ts` (with the field named for `invalid_spec`); throws `ComputeJobError` for
 * an argument the table cannot take, for a key reused for another request, and for a platform pool
 * that is missing, and the ledger's own error for a pool it cannot find.
 */
export async function createJob(
  env: ComputeJobsEnv,
  input: CreateJobInput,
): Promise<CreateJobResult> {
  const args = checkInput(input);
  if (!env.COMPUTE_RECORDS) return refusal("compute_disabled");

  // What was asked for, as text and as the few fields a hold needs. A person's or a pipeline's job is
  // the strict specification; a partner's is its hold body, kept byte for byte.
  let specText: string;
  let spec: JobSpec | null = null;
  let resources: HoldResources;
  let appId: string;
  let appVersion: string;
  let kind: ComputeKind;
  if (input.source === "partner") {
    const read = readHoldBody(input.holdBody);
    if (!read.ok) return refusal("invalid_spec", read.field);
    const body = read.body;
    specText = input.holdBody;
    resources = {
      partition: body.partition,
      nodes: body.nodes,
      cores: body.cores,
      memory_mb: body.memory_mb ?? undefined,
      gpus: body.gpus,
      minutes: body.minutes,
    };
    appId = body.app_id;
    appVersion = body.app_version;
    kind = body.kind;
  } else {
    const parsed = JobSpecSchema.safeParse(input.spec);
    if (!parsed.success) {
      const path = parsed.error.issues[0]?.path ?? [];
      return refusal("invalid_spec", path.length > 0 ? fieldPath(path) : undefined);
    }
    spec = parsed.data;
    specText = JSON.stringify(spec);
    resources = spec;
    appId = args.appId as string;
    appVersion = args.appVersion as string;
    kind = args.kind as ComputeKind;
  }
  // The text is made ONCE; its digest is the job row's, and the same text is written after the commit.
  const specDigest = await sha256Hex(new TextEncoder().encode(specText));
  // A job that uploads something is complete only once its upload has been copied into the records
  // (`finalizeBundle`, or `finalizeSubmittedFiles` for a partner's own files): the bundle of a script,
  // and the files of a partner's batch job. An interactive session is its own record.
  const uploads = spec?.bundle !== undefined || (args.source === "partner" && kind === "batch");
  const db = env.DB;

  if (args.key !== null && args.accountId !== null) {
    const existing = await db
      .prepare(JOB_BY_KEY_SQL)
      .bind(args.accountId, args.key)
      .first<ComputeJobRow>();
    if (existing) return replay(env, existing, specDigest, specText, uploads, args.executor);
  }

  // Before any hold exists: what the owner's policy and the launch itself allow.
  const policy = (await getPolicy(db)).policy;
  if (args.source !== "pipeline") {
    const ceiling = policy.ceilings[resources.partition];
    if (!ceiling) return refusal("partition_not_offered");
    if (
      resources.nodes > ceiling.maxNodes ||
      resources.cores > ceiling.maxCoresPerNode ||
      resources.gpus > ceiling.maxGpusPerNode ||
      resources.minutes > ceiling.maxMinutes
    ) {
      return refusal("over_job_limit");
    }
  }
  if (spec !== null) {
    const untagged = datasetVersionWithoutTag(spec.datasets);
    if (untagged !== null) return refusal("invalid_spec", untagged);
    if (!launchSpecFits(spec)) return refusal("invalid_spec");
    // The owner's limit, and never more than R2 copies in one request.
    if (
      spec.bundle !== undefined &&
      spec.bundle.size > copyableLimit(policy.bundleLimits.maxTotalBytes)
    ) {
      return refusal("bundle_too_large");
    }
  }
  // A runner job has no hold: it is admitted by its own INSERT's guard and never priced (ADR 0121).
  if (args.executor === "runner") {
    return createRunnerJob(env, {
      args,
      resources,
      appId,
      appVersion,
      kind,
      spec: spec as JobSpec,
      specText,
      specDigest,
      uploads,
      maxLive: runnersPolicyOf(policy).maxLiveJobs,
    });
  }
  let amountMilli: number;
  try {
    amountMilli = estimateSuMilli(resources);
  } catch {
    return refusal("invalid_spec");
  }

  // The pools: the person's (or the partner's) and the platform budget their spend counts against, or
  // the pipelines' own with no budget. A person with no pool has nothing granted, and none is made.
  const word = PARTITIONS[resources.partition].pool;
  let poolId: number;
  let budgetPoolId: number | null = null;
  if (args.source === "pipeline") {
    const pipelines = await platformPool(db, "pipelines", word);
    if (!pipelines) throw new ComputeJobError("pool_not_found", "the pipelines pool is missing");
    poolId = pipelines.id;
  } else {
    const holderKind = args.accountId !== null ? "account" : "partner";
    const holderRef = args.accountId !== null ? String(args.accountId) : (args.clientId as string);
    const own = await db
      .prepare(POOL_BY_HOLDER_SQL)
      .bind(holderKind, holderRef, word)
      .first<PoolRow>();
    if (!own) return refusal("insufficient_balance");
    const people = await platformPool(db, "people", word);
    if (!people) throw new ComputeJobError("pool_not_found", "the people budget is missing");
    poolId = own.id;
    budgetPoolId = people.id;
  }

  const jobId = newJobId();
  // The guards, in the order a refusal is worded: the class's own cap (a person's live-job limit, or for
  // NEMAR's own pipelines the pipelines' live cap of this pool), then the tenant ceiling that EVERY source
  // meets. Each is in the hold's statement, and a refusal is worded after the batch by asking each guard
  // again (`guardRefusal`), so the word is the guard's and never a second hold's.
  const guards: NamedGuard[] = [];
  if (args.source === "pipeline") {
    guards.push({
      guard: {
        sql: PIPELINE_LIVE_JOBS_GUARD_SQL,
        binds: [word, policy.pipelines.maxLiveJobs[word]],
      },
      refusal: "over_concurrency",
    });
  } else if (args.accountId !== null) {
    guards.push({
      guard: { sql: LIVE_JOBS_GUARD_SQL, binds: [args.accountId, policy.maxLiveJobsPerPerson] },
      refusal: "over_concurrency",
    });
  }
  guards.push({
    guard: tenantGuard(tenantClassOf(args.source), tenantPolicyOf(policy)),
    refusal: "platform_busy",
  });
  const hold = {
    poolId,
    budgetPoolId,
    amountMilli,
    jobId,
    extraGuards: guards.map((g) => g.guard),
  };

  const statements = [...holdStatements(db, hold)];
  if (args.source !== "pipeline" && args.accountId !== null) {
    statements.push(
      db.prepare(GATEWAY_USER_INSERT_SQL).bind(args.accountId, newGatewayUser(), jobId),
    );
  }
  statements.push(
    db
      .prepare(JOB_INSERT_SQL)
      .bind(
        jobId,
        args.accountId,
        args.tapisOwner,
        args.source === "pipeline" ? PIPELINES_TAPIS_OWNER : null,
        args.key,
        args.source,
        args.clientId,
        kind,
        appId,
        appVersion,
        imageDigestOf(spec?.image),
        specDigest,
        resources.partition,
        word,
        resources.nodes,
        resources.cores,
        resources.memory_mb ?? null,
        resources.gpus,
        resources.minutes,
        amountMilli,
        crypto.randomUUID(),
      ),
  );

  let changes: number;
  try {
    changes = (await db.batch(statements))[0]?.meta?.changes ?? 0;
  } catch (err) {
    // Another request with this key got there first: the batch was refused as a whole (it is one
    // transaction), so nothing of this one remains, and the first one's job is the answer.
    if (looksUnique(err) && args.key !== null && args.accountId !== null) {
      const existing = await db
        .prepare(JOB_BY_KEY_SQL)
        .bind(args.accountId, args.key)
        .first<ComputeJobRow>();
      if (existing) return replay(env, existing, specDigest, specText, uploads);
    }
    throw err;
  }
  if (changes === 0) {
    // A retry that raced its own original request: the original took the slot (or the pool's last funds)
    // between this request's first read of the key and its hold, so the hold was refused, but the job
    // under this key now exists and is the answer. Asked BEFORE the refusal is worded, as a sequential
    // replay is answered before any guard.
    if (args.key !== null && args.accountId !== null) {
      const existing = await db
        .prepare(JOB_BY_KEY_SQL)
        .bind(args.accountId, args.key)
        .first<ComputeJobRow>();
      if (existing) return replay(env, existing, specDigest, specText, uploads);
    }
    const why = await holdRefusalReason(db, hold);
    return refusal(why === "guard_refused" ? await guardRefusal(db, guards) : why);
  }

  const created = await getJob(db, jobId);
  if (!created) throw new Error("a job that was just written could not be read");
  const recordsWritten = await writeRecords(env, created, specText, uploads);
  const job = recordsWritten ? ((await getJob(db, jobId)) ?? created) : created;
  return { ok: true, replayed: false, job, recordsWritten };
}
