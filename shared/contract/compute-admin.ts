/**
 * The owner and admin routes of the compute gateway's allocation ledger and policy (epic #2005
 * phase A2, #2007; ADR 0118): their error words, request shapes and the RESPONSES the command-line
 * interface (CLI) parses.
 *
 * Every response schema here is open. A released CLI must keep working when the Worker adds a key,
 * so each object accepts and keeps one it does not know, at the top level and nested, and a word
 * the Worker may grow (a holder kind, a ledger kind) is a string here and not an enum. The strict
 * schema of the owner policy (`ComputePolicySchema` in `./compute.ts`) checks what the owner SENDS
 * and what the Worker WRITES; no response is parsed with it, and this file never imports it (a test
 * keeps every file under shared/contract but `compute.ts` and `compute-launch.ts` from doing so).
 *
 * It also holds the status route's response (epic #2005 phase A4, #2009): booleans and fixed words
 * only, never a secret value, an address or a name of the tenant.
 *
 * Money is whole thousandths of a service unit (SU) throughout: `*_milli` is an integer, `12.5`
 * SU is 12500 (`parseSuToMilli` and `formatSu` in `./compute.ts`).
 */

import { z } from "zod";
import { PIPELINE_STAMP_STATES, type RecipeInput } from "../compute-recipes.js";
import {
  COMPUTE_REFUSAL_STATUS,
  type ComputeExecutor,
  type ComputeRefusalCode,
  RUNNER_REFUSAL_STATUS,
} from "../compute-state.js";
import type { ComputePool } from "./compute.js";

// --- Words -----------------------------------------------------------------------------------

/** Whose pool it is: a person, one of NEMAR's two platform budgets, or a partner client. */
export const COMPUTE_POOL_HOLDER_KINDS = ["account", "platform", "partner"] as const;

export type ComputePoolHolderKind = (typeof COMPUTE_POOL_HOLDER_KINDS)[number];

/** NEMAR's own pipelines' share of the platform budget, and the one nobody else's spend is counted against. */
export const COMPUTE_PIPELINES_BUDGET = "pipelines" as const;

/** Everyone else's share: the budget every account's and partner's spend is counted against. */
export const COMPUTE_PEOPLE_BUDGET = "people" as const;

/** NEMAR's own two budgets. The migration seeds each of them, for cpu and for gpu. */
export const COMPUTE_PLATFORM_KEYS = [COMPUTE_PIPELINES_BUDGET, COMPUTE_PEOPLE_BUDGET] as const;

export type ComputePlatformKey = (typeof COMPUTE_PLATFORM_KEYS)[number];

/** Whether a word is the key of one of the platform's budgets. */
export function isComputePlatformKey(word: string): word is ComputePlatformKey {
  return (COMPUTE_PLATFORM_KEYS as readonly string[]).includes(word);
}

/**
 * The most SU one request may grant or move, in milli-SU: 2^40, about a billion SU, far above any
 * grant and far below the 2^53 - 1 that a stored total may not pass (a total that would pass it is
 * refused too, as `would_exceed_limit`).
 */
export const COMPUTE_REQUEST_MILLI_MAX = 2 ** 40;

/** Which total an admin's adjustment corrects. */
export const COMPUTE_ADJUST_TARGETS = ["granted", "charged"] as const;

export type ComputeAdjustTarget = (typeof COMPUTE_ADJUST_TARGETS)[number];

/** The most pools a listing answers with at once. */
export const COMPUTE_POOLS_PAGE_MAX = 200;

/**
 * The `Idempotency-Key` header a grant or an adjustment must carry: 8 to 100 letters, digits and
 * `. _ -` (a UUID fits). The ledger stores it behind a prefix of its own, so a key an admin sends
 * can never be the key of an entry the Worker writes for a job.
 */
export const COMPUTE_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._-]{8,100}$/;

/** The words an administrator's route answers with, in `{ error: <sentence>, code: <word> }`. */
export const COMPUTE_ADMIN_ERROR_CODES = [
  "invalid_body",
  "invalid_query",
  "idempotency_key_required",
  "idempotency_key_invalid",
  "idempotency_conflict",
  "owner_only",
  "account_not_found",
  "pool_not_found",
  "would_go_negative",
  "would_exceed_limit",
  "policy_unreadable",
  "internal",
  // Phase A7 (#2012): reporting, legal holds, the observer and the ACCESS re-queue.
  "job_not_found",
  "hold_exists",
  "hold_not_found",
  "target_not_found",
  "acknowledgement_required",
  "report_not_found",
  "invalid_reason",
  "record_missing",
  "compute_disabled",
  "audit_failed",
] as const;

export type ComputeAdminErrorCode = (typeof COMPUTE_ADMIN_ERROR_CODES)[number];

/** The HTTP status of each word, declared once so no route picks its own. */
export const COMPUTE_ADMIN_ERROR_STATUS = {
  invalid_body: 400,
  invalid_query: 400,
  idempotency_key_required: 400,
  idempotency_key_invalid: 400,
  idempotency_conflict: 409,
  owner_only: 403,
  account_not_found: 404,
  pool_not_found: 404,
  would_go_negative: 409,
  would_exceed_limit: 409,
  policy_unreadable: 503,
  internal: 500,
  job_not_found: 404,
  hold_exists: 409,
  hold_not_found: 404,
  target_not_found: 404,
  acknowledgement_required: 400,
  report_not_found: 404,
  invalid_reason: 400,
  record_missing: 404,
  compute_disabled: 503,
  audit_failed: 500,
} as const satisfies Record<ComputeAdminErrorCode, number>;

// --- Requests (plain types: the Worker validates them, the CLI builds them) -------------------

/** `PUT /admin/compute/policy`: the whole policy (the strict schema decides) and an optional note. */
export interface ComputePolicyPutRequest {
  policy: unknown;
  note?: string;
}

/** `POST /admin/compute/pools/.../grant`: SU into one pool. The reason is a fixed word. */
export interface ComputePoolGrantRequest {
  pool: ComputePool;
  amount_milli: number;
  reason?: string;
}

/** `POST /admin/compute/pools/.../adjust`: a correction of the grant or of the charge, either way. */
export interface ComputePoolAdjustRequest {
  pool: ComputePool;
  target: ComputeAdjustTarget;
  /** Never 0; negative takes away. */
  delta_milli: number;
  reason: string;
}

// --- Responses (open) ------------------------------------------------------------------------

const milli = z.number().int();

/** A pool as the Worker reports it; `available_milli` is granted - held - charged and may be negative. */
export const ComputePoolViewSchema = z
  .object({
    id: z.number().int(),
    holder_kind: z.string(),
    holder_ref: z.string(),
    pool: z.string(),
    granted_milli: milli,
    held_milli: milli,
    charged_milli: milli,
    available_milli: milli,
    frozen: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

export type ComputePoolView = z.infer<typeof ComputePoolViewSchema>;

/** One ledger entry. */
export const ComputeLedgerEntryViewSchema = z
  .object({
    id: z.number().int(),
    kind: z.string(),
    pool_id: z.number().int(),
    budget_pool_id: z.number().int().nullable(),
    granted_delta_milli: milli,
    held_delta_milli: milli,
    charged_delta_milli: milli,
    job_id: z.string().nullable(),
    hold_ref: z.number().int().nullable(),
    reason: z.string().nullable(),
    actor_user_id: z.number().int().nullable(),
    created_at: z.string(),
  })
  .passthrough();

export type ComputeLedgerEntryView = z.infer<typeof ComputeLedgerEntryViewSchema>;

/** `GET /admin/compute/pools`: a keyset page, newest last; `next_after` continues it. */
export const ComputePoolsResponseSchema = z
  .object({
    pools: z.array(ComputePoolViewSchema),
    next_after: z.number().int().nullable(),
  })
  .passthrough();

export type ComputePoolsResponse = z.infer<typeof ComputePoolsResponseSchema>;

/** `GET /admin/compute/pools/by-id/:accountId`: the account's pools; none yet is an empty list. */
export const ComputeAccountPoolsResponseSchema = z
  .object({
    account_id: z.number().int(),
    pools: z.array(ComputePoolViewSchema),
  })
  .passthrough();

export type ComputeAccountPoolsResponse = z.infer<typeof ComputeAccountPoolsResponseSchema>;

/** A grant or an adjustment: the pool afterwards, the entry, and whether the key had been used. */
export const ComputePoolWriteResponseSchema = z
  .object({
    pool: ComputePoolViewSchema,
    entry: ComputeLedgerEntryViewSchema,
    replayed: z.boolean(),
  })
  .passthrough();

export type ComputePoolWriteResponse = z.infer<typeof ComputePoolWriteResponseSchema>;

/**
 * `GET` and `PUT /admin/compute/policy`. `version` is null and `is_default` true while no version
 * has been set (the policy in force is then the default); `policy` is the policy as an open object,
 * so a key the Worker adds later still reaches the CLI.
 */
export const ComputePolicyResponseSchema = z
  .object({
    version: z.number().int().nullable(),
    is_default: z.boolean(),
    policy: z.object({}).passthrough(),
    set_by: z.number().int().nullable(),
    note: z.string().nullable(),
    created_at: z.string().nullable(),
  })
  .passthrough();

export type ComputePolicyResponse = z.infer<typeof ComputePolicyResponseSchema>;

/**
 * `GET /admin/compute/status` (epic #2005 phase A4, #2009): what the Worker reads of the two dark
 * switches, whether Tapis, the two compute buckets with their signing secrets and the ACCESS key are
 * configured, and the result of ONE token mint and ONE health call, as fixed words. Booleans and
 * words only: no secret value, no address, no tenant name, no username.
 *
 *  - `switches.environment` is `production`, `development` or `other`, never the value;
 *  - `tapis.strategy` is `password`, `service` or null (not usable); `tapis.problems` are the names
 *    of what is wrong (`TAPIS_PASSWORD:missing`), empty when it is usable;
 *  - `tapis.token` and `tapis.health` are `ok`, `unconfigured`, `skipped` (no username to probe
 *    with under the service strategy) or the kind of the error the call failed with
 *    (`unauthorized`, `not_found`, `rejected`, `unavailable`, `invalid_response`): a string here,
 *    not an enum, so a word the Worker adds does not break a released CLI;
 *  - `runtime_image` is whether the runtime image variable is set and valid, and its digest;
 *  - `prerequisites`, `reconciliation` and `attention` are presence booleans and counts (see each field).
 */
export const ComputeStatusResponseSchema = z
  .object({
    switches: z
      .object({
        environment: z.string(),
        compute_enabled: z.boolean(),
        pipelines_dispatch_enabled: z.boolean(),
      })
      .passthrough(),
    tapis: z
      .object({
        configured: z.boolean(),
        strategy: z.string().nullable(),
        problems: z.array(z.string()),
        token: z.string(),
        health: z.string(),
      })
      .passthrough(),
    storage: z
      .object({
        records_binding: z.boolean(),
        results_binding: z.boolean(),
        signing_configured: z.boolean(),
      })
      .passthrough(),
    /**
     * Whether the two secrets the ACCESS reports wait for are SET (presence only, never a value): the key
     * and, optional so a CLI that reads a Worker from before the field existed still parses its answer,
     * the resource name.
     */
    access: z
      .object({ key_configured: z.boolean(), resource_name_configured: z.boolean().optional() })
      .passthrough(),
    /**
     * `COMPUTE_RUNTIME_IMAGE`, NEMAR's own image for a `python` job: whether it is `set`, whether it is a
     * `valid` digest-pinned reference, and its `digest` (null unless valid; the reference is never sent).
     * Optional so a CLI that reads a Worker from before the field existed still parses its answer.
     */
    runtime_image: z
      .object({ set: z.boolean(), valid: z.boolean(), digest: z.string().nullable() })
      .passthrough()
      .optional(),
    /**
     * What every launch needs besides the Tapis credential and the buckets, as presence only (never a
     * value): the callback secret that signs the job, webhook and observer tokens, the API base address
     * the launcher calls back, NEMAR's pipelines service account (approved, kind service), a current
     * owner policy, and a grant on the `people` and `pipelines` platform pools. Optional so a CLI that
     * reads an older Worker still parses its answer.
     */
    prerequisites: z
      .object({
        callback_secret: z.boolean(),
        api_base_url: z.boolean(),
        pipelines_account: z.boolean(),
        policy_set: z.boolean(),
        people_pool_granted: z.boolean(),
        pipelines_pool_granted: z.boolean(),
      })
      .passthrough()
      .optional(),
    /**
     * Whether the reconciliation that follows jobs without a webhook is paused: the tenant sweep (the
     * week-mode final settlement, the failed ACCESS report listing and the following of rows nobody
     * reserved) does not run while compute is switched off, so a job that ended while it was off waits.
     */
    reconciliation: z.object({ paused: z.boolean() }).passthrough().optional(),
    /**
     * Counts of things that need a person to look, by fixed word. Each value today is a count and zero
     * means nothing waits; the value is not narrowed, so a key the Worker adds in another shape (open,
     * like every response here) does not break a released CLI, which prints only the positive counts.
     * Today: `access_reports_failed` (ACCESS reports that ended failed), `cancel_pending_failed` (a
     * recorded cancel still not carried out an hour after it was asked for) and `copy_abandoned` (a
     * terminal job whose launcher files were never copied and no longer will be),
     * `tenant_over_ceiling` (slots occupied above the tenant ceiling: a job NEMAR did not admit, or a
     * ceiling lowered below what is already live) and `policy_unreadable` (1 when the stored owner policy
     * cannot be read, which fails every hold, run and limit closed; then `tenant` is absent).
     */
    attention: z.record(z.unknown()).optional(),
    /**
     * NEMAR's tenant-wide ceiling on live jobs (issue #2121, phase P2): the owner's `ceiling`, the slots
     * `occupied` by NEMAR's own count (live jobs and the orphans not yet canceled), the count `by_class`
     * and the floors `reserved` per class. Optional so a CLI that reads an older Worker still parses its
     * answer, and open like every response here. Absent when the policy cannot be read just now.
     */
    tenant: z
      .object({
        ceiling: z.number(),
        occupied: z.number(),
        by_class: z
          .object({
            people: z.number(),
            pipelines: z.number(),
            partner: z.number(),
            other: z.number(),
          })
          .passthrough(),
        reserved: z
          .object({ people: z.number(), pipelines: z.number(), partner: z.number() })
          .passthrough(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type ComputeStatusResponse = z.infer<typeof ComputeStatusResponseSchema>;

const nullableString = z.string().nullable();

/**
 * A job as an administrator's command prints it (epic #2005 phase A5, #2010): fixed words, numbers and
 * times. No identity, no specification, no token, no address and no log. `platform_failure` is an
 * INFORMATION flag, true when NEMAR, the node, the runtime or the contract caused the failure, so that an
 * administrator can compensate it by a manual grant: nothing is refunded automatically. Every word is a
 * string here, not an enum, so a word the Worker adds does not break a released CLI.
 */
export const ComputeJobViewSchema = z
  .object({
    id: z.string(),
    account_id: z.number().int().nullable(),
    source: z.string(),
    kind: z.string(),
    state: z.string(),
    tapis_status: nullableString,
    failure_code: nullableString,
    failure_detail: nullableString,
    platform_failure: z.boolean(),
    cancel_requested: z.boolean(),
    cancel_reason: nullableString,
    partition: z.string(),
    pool: z.string(),
    held_milli: milli,
    charged_milli: milli,
    settled: z.boolean(),
    flags: z.array(z.string()),
    created_at: z.string(),
    submitted_at: nullableString,
    started_at: nullableString,
    ended_at: nullableString,
    tapis_synced_at: nullableString,
    outputs_completed: z.boolean(),
    results_verified: z.boolean(),
    results_bytes: z.number().int().nullable(),
    records_copied: z.boolean(),
    /**
     * Portable compute (ADR 0121): who runs the job and how it is accounted, and, for a runner job, the
     * runner's claim and the usage it measured (a runner's own figures, never SU). Optional so a CLI that
     * reads an older Worker still parses its answer; a Tapis job shows `tapis` and `su` and nulls.
     */
    executor: z.string().optional(),
    accounting: z.string().optional(),
    runner_backend: nullableString.optional(),
    runner_id: nullableString.optional(),
    runner_claimed_at: nullableString.optional(),
    runner_wall_seconds: z.number().int().nullable().optional(),
    runner_cpu_seconds: z.number().int().nullable().optional(),
    runner_max_rss_mb: z.number().int().nullable().optional(),
  })
  .passthrough();

export type ComputeJobView = z.infer<typeof ComputeJobViewSchema>;

/** `POST /admin/compute/jobs/:id/cancel` and `.../advance`: what happened, and the job as it is now. */
export const ComputeJobAdminResponseSchema = z
  .object({
    ok: z.boolean(),
    outcome: z.string(),
    submit: z.string().optional(),
    job: ComputeJobViewSchema.nullable(),
  })
  .passthrough();

export type ComputeJobAdminResponse = z.infer<typeof ComputeJobAdminResponseSchema>;

// --- NEMAR's own pipelines (epic #2005 phase A6, #2011) ---------------------------------------------------

/**
 * The attention words of the runner queue (portable compute, ADR 0121), counted in `GET /admin/compute/status`'s
 * `attention` block and printed by `nemar admin compute status` as `Attention: <word> <n>` when positive:
 * `runner_cancel_pending_failed` (a live runner job whose recorded cancel is more than 60 minutes old: its
 * runner never took it) and `runner_copy_abandoned` (a terminal runner job whose records copy never happened
 * and no longer will) and `runner_records_unwritten` (a waiting runner job whose records never landed and were
 * neither replayed nor given up on well past the window: the lease sweep is not running or is starved).
 */
export const COMPUTE_RUNNER_ATTENTION_WORDS = [
  "runner_cancel_pending_failed",
  "runner_copy_abandoned",
  "runner_records_unwritten",
] as const;

/**
 * The most datasets one `--eligible` request may ASK for. It is not what a run dispatches: a run is also
 * bounded by the policy's live cap, the policy's daily cap and {@link COMPUTE_PIPELINE_RUN_PER_INVOCATION},
 * whichever is smallest, and the answer's `room` says which one it was.
 */
export const COMPUTE_PIPELINE_RUN_LIMIT_MAX = 100;

/**
 * The most datasets ONE invocation dispatches, whoever asks and whatever the limit and the caps say. A
 * Worker request cannot be trusted to carry 100 dispatches: one dispatch is about 25 subrequests (the
 * dataset and version reads, the claim, the job's batch and records, the submit), so 100 are about 2,500
 * against an allowance of about 1,000 per invocation in this project's older model (ADR 0118 records
 * 10,000 for the compute crons and asks for a measurement; none has been taken for this route), and each
 * one waits on the job platform in turn. The count of about 25 treats every D1 and R2 binding call as a
 * subrequest, although whether they count is UNVERIFIED (the daily dispatcher's header says the same).
 * It is also the daily dispatcher's bound per tick (`CRON_DISPATCH_PER_TICK` is this constant); a run
 * that wants more is asked again. Raising it needs a measurement first.
 */
export const COMPUTE_PIPELINE_RUN_PER_INVOCATION = 10;

/**
 * What bounded a run over the eligible datasets, the smallest of: the number asked for (`limit`), the
 * per-invocation bound, what is left of the daily cap (`daily_cap`), what is left of the live cap of
 * the recipe's pool (`live_cap`) and what is left of NEMAR's tenant ceiling for the pipelines' class
 * (`tenant`, issue #2121). On a tie the first of these in this order is named, so a run that ends at exactly
 * the number it was asked for was not "limited", and the tenant is named only when it alone is the smallest.
 */
export const COMPUTE_PIPELINE_LIMITED_BY = [
  "limit",
  "per_invocation",
  "daily_cap",
  "live_cap",
  "tenant",
] as const;

export type ComputePipelineLimitedBy = (typeof COMPUTE_PIPELINE_LIMITED_BY)[number];

/** The default number of datasets an `--eligible` run takes when none is named. */
export const COMPUTE_PIPELINE_RUN_LIMIT_DEFAULT = 10;

/** The states a stamp is filtered by: the registry's own list (`shared/compute-recipes.ts`), not a copy of it. */
export const COMPUTE_PIPELINE_STAMP_STATES = PIPELINE_STAMP_STATES;

/** The most stamps one status page answers with. */
export const COMPUTE_PIPELINE_STATUS_PAGE_MAX = 200;

/**
 * `POST /admin/compute/pipeline/run`: a recipe, then ONE dataset (with an optional version) or the
 * queue (`eligible`, with a `limit`), and `dry_run`. The Worker validates it strictly; the request
 * names nothing else, because the dataset row, the version row, the account and the pool are the
 * Worker's own.
 */
export interface ComputePipelineRunRequest {
  recipe: string;
  /**
   * Who runs the job: `tapis` (the default) or `runner` (ADR 0121). A recipe lists the executors it may
   * be dispatched to, and a runner run names one dataset, not the queue.
   */
  executor?: ComputeExecutor;
  /**
   * What the run reads (plan D12): `bids` (the dataset's files, on Tapis) or `zarr` (its Zarr serving copy, on a
   * runner). The executor's own when absent: `bids` for `tapis`, `zarr` for `runner`. An input the recipe does
   * not list, or one the executor does not run, is refused `invalid_spec` naming `input`, before anything is
   * written.
   */
  input?: RecipeInput;
  dataset?: string;
  version?: string;
  eligible?: boolean;
  limit?: number;
  dry_run?: boolean;
}

/**
 * The refusal words only a pipeline run has. Their statuses are declared here; every other word a run
 * is refused with is one of the ledger's (`COMPUTE_REFUSAL_CODES`) and keeps the status
 * `COMPUTE_REFUSAL_STATUS` gives it, so no status is declared twice.
 *  - `runners_disabled`: a runner run while the runners switch is off (503, the runner protocol's status).
 *  - `tapis_unconfigured`: a Tapis-executor run while the Worker has no usable Tapis configuration (503).
 *    It is refused before anything is written, so no hold waits for a submit that cannot happen; it is
 *    the same for every dataset, recipe and pool, so it stops a run over the queue and ends the daily one.
 *  - `create_failed`: the job could not be written (502); `run_failed`: the run stopped on an
 *    unexpected error (500), a platform fault and not a refusal of the request.
 *  - `daily_cap_reached`: NEMAR's pipelines have made as many jobs today as the owner allows (409). It
 *    stops a run over the eligible datasets; a single named dataset is counted and never refused by it.
 *    No path answers it as an HTTP status today: it appears only as `stopped_by` of a 200 or 201 run, and
 *    the status is declared because every word a run can stop with has one.
 */
export const COMPUTE_PIPELINE_ONLY_REFUSAL_STATUS = {
  recipe_not_automatic: 422,
  recipe_placeholder: 422,
  registry_drift: 409,
  version_not_found: 404,
  version_untagged: 422,
  too_many_files: 422,
  /** A Zarr recipe over a version older than the newest, whose copy the row does not describe (DM-06). */
  zarr_version_not_newest: 422,
  /** A Zarr recipe over a dataset whose copy is not `ready` with a store. */
  zarr_copy_not_ready: 409,
  /**
   * A Zarr recipe over a dataset whose serving copy could not be shown to be the version's data (DM-06b): not the
   * tag's commit and not a metadata-only step after it, or a check out of its limits; the `reason` says which.
   */
  zarr_source_mismatch: 409,
  /**
   * The serving copy's commit or the tag's commit could not be read (a timeout, a refusal, no index, no
   * credentials in production): nothing is known, so nothing is dispatched, and the same dispatch may succeed
   * later (DM-06b).
   */
  zarr_source_unverifiable: 503,
  /** The runners switch is off (portable compute): the status is the runner protocol's, declared once. */
  runners_disabled: RUNNER_REFUSAL_STATUS.runners_disabled,
  /**
   * A Tapis-executor run (`nemar-floor`, one dataset or `eligible`, from an administrator, the daily
   * dispatcher or any other caller) while the Worker has no usable Tapis configuration: refused before any
   * stamp, hold, ledger entry, job, record or audit row is written, and nothing reaches a tenant.
   */
  tapis_unconfigured: 503,
  daily_cap_reached: 409,
  create_failed: 502,
  run_failed: 500,
} as const;

/** Every word a pipeline run can be refused with. */
export type ComputePipelineRefusal =
  | ComputeRefusalCode
  | keyof typeof COMPUTE_PIPELINE_ONLY_REFUSAL_STATUS;

/**
 * The HTTP status of each word a pipeline run is refused with, declared once so no route picks its own.
 * Typed against the union of the words, so a word added to it without a status here does not compile,
 * and the route has no fallback status to hide the omission.
 */
export const COMPUTE_PIPELINE_REFUSAL_STATUS: Readonly<Record<ComputePipelineRefusal, number>> = {
  ...COMPUTE_REFUSAL_STATUS,
  ...COMPUTE_PIPELINE_ONLY_REFUSAL_STATUS,
};

/** One dataset's outcome in a run: dispatched (a job and a stamp) or refused (a word). Words are strings. */
export const ComputePipelineResultSchema = z
  .object({
    dataset_id: z.string(),
    ok: z.boolean(),
    version: z.string().optional(),
    job_id: z.string().optional(),
    stamp_id: z.number().int().optional(),
    attempt: z.number().int().optional(),
    submit: z.string().optional(),
    /** A runner job only: false when its records did not land (`submit` is then `records_not_written`). */
    records_written: z.boolean().optional(),
    code: z.string().optional(),
    blocked_by: z.array(z.string()).optional(),
    /** A Zarr source refusal's reason: a fixed word (`zarr_source_mismatch`, `zarr_source_unverifiable`). */
    reason: z.string().optional(),
  })
  .passthrough();

export type ComputePipelineResult = z.infer<typeof ComputePipelineResultSchema>;

/**
 * The room a run over the eligible datasets had: what is left of the daily cap, what is left of the live
 * cap of the recipe's pool, both read before the run, and what bounded the run (see
 * {@link COMPUTE_PIPELINE_LIMITED_BY}). A dry run reports the same, so its preview matches a live run.
 * `tenant_left` is the slots the pipelines' class could take under the tenant ceiling (optional, so a CLI
 * that reads an older Worker still parses its answer).
 */
export const ComputePipelineRoomSchema = z
  .object({
    daily_left: z.number().int(),
    live_left: z.number().int(),
    tenant_left: z.number().int().optional(),
    limited_by: z.string(),
  })
  .passthrough();

export type ComputePipelineRoom = z.infer<typeof ComputePipelineRoomSchema>;

/**
 * What a runner run has room for: the live `accounting = 'none'` runner jobs of the recipe's pool against the
 * owner's `runners.maxLiveJobs` for it. Neither the daily cap nor the tenant ceiling applies to a runner job.
 */
const ComputePipelineRunnerRoomSchema = z
  .object({ live_left: z.number().int(), live_cap: z.number().int() })
  .passthrough();

export type ComputePipelineRunnerRoom = z.infer<typeof ComputePipelineRunnerRoomSchema>;

/**
 * The answer of a pipeline run, live or dry. A live run has `results`, `dispatched` and `stopped_by`;
 * a dry run has the estimate, the config a real run needs, what would be dispatched and what blocks the
 * rest. Every field of the other kind is optional, so one schema reads both, and the response is open.
 */
export const ComputePipelineRunResponseSchema = z
  .object({
    ok: z.boolean(),
    dry_run: z.boolean(),
    recipe: z.string(),
    results: z.array(ComputePipelineResultSchema).optional(),
    dispatched: z.number().int().optional(),
    stopped_by: z.string().nullable().optional(),
    /** For a run over the eligible datasets, live or dry: the room it had and what bounded it. */
    room: ComputePipelineRoomSchema.optional(),
    /** Who the run was for (`tapis` or `runner`); absent from an older Worker, which has only Tapis. */
    executor: z.string().optional(),
    /** What the run read (`bids` or `zarr`); absent from a Worker from before inputs, whose runs all read `bids`. */
    input: z.string().optional(),
    /** For a runner run, live or dry: the room under the runners' live cap (there is no `room`). */
    runner_room: ComputePipelineRunnerRoomSchema.optional(),
    /** True when the run was made and the Worker could not write its audit row: nothing is lost but the row. */
    audit_pending: z.boolean().optional(),
    estimate_milli_per_job: milli.optional(),
    estimate_milli_total: milli.optional(),
    config: z
      .object({
        compute_enabled: z.boolean(),
        runtime_image: z.boolean(),
        pipelines_account: z.boolean(),
        /** Portable compute: `computeRunnersEnabled`; optional for an older Worker. */
        runners_enabled: z.boolean().optional(),
        /** Whether a Tapis job could be submitted; only in the dry run of a Tapis run, optional for an older Worker. */
        tapis_configured: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    would_dispatch: z
      .array(z.object({ dataset_id: z.string(), version: z.string() }).passthrough())
      .optional(),
    blocked: z
      .object({
        code: z.string(),
        blocked_by: z.array(z.string()),
        version: z.string().optional(),
        reason: z.string().optional(),
      })
      .passthrough()
      .optional(),
    blocked_by_term: z.record(z.unknown()).optional(),
  })
  .passthrough();

export type ComputePipelineRunResponse = z.infer<typeof ComputePipelineRunResponseSchema>;

/** A stamp as an administrator is shown it: a tuple, a state, a job and a fixed word. */
export const ComputePipelineStampViewSchema = z
  .object({
    id: z.number().int(),
    dataset_id: z.string(),
    version: z.string(),
    recipe: z.string(),
    recipe_version: z.string(),
    engine: z.string(),
    /**
     * What the run reads, the fifth word of the tuple (`bids` or `zarr`). Optional so a CLI that reads a
     * Worker from before inputs still parses its answer; every stamp that Worker made read `bids`.
     */
    input: z.string().optional(),
    attempt: z.number().int(),
    state: z.string(),
    job_id: nullableString,
    refusal_code: nullableString,
    /** A succeeded Zarr stamp: the reader that decoded the stores (`eegprep-lean@<version>+<commit>`). */
    reader: nullableString.optional(),
    /** A succeeded Zarr stamp: the Zarr engine version of the serving index the run read. */
    input_engine: nullableString.optional(),
    /** A succeeded stamp: `sha256:` and what a Zarr run read, or `git:` and the commit a BIDS run read. */
    input_digest: nullableString.optional(),
    created_at: z.string(),
    /** While `dispatched`: when the Worker last examined the stamp. Once ended: when it ended. */
    updated_at: z.string(),
  })
  .passthrough();

export type ComputePipelineStampView = z.infer<typeof ComputePipelineStampViewSchema>;

/** `GET /admin/compute/pipeline/status`: a page of stamps, newest first, after the stamps were synced. */
export const ComputePipelineStatusResponseSchema = z
  .object({
    stamps: z.array(ComputePipelineStampViewSchema),
    next_before: z.number().int().nullable(),
  })
  .passthrough();

export type ComputePipelineStatusResponse = z.infer<typeof ComputePipelineStatusResponseSchema>;

// --- Reporting, holds, the observer and ACCESS reports (epic #2005 phase A7, #2012) ---------------------------

/** The most rows a listing answers with at once. */
export const COMPUTE_REPORT_PAGE_MAX = 200;

/** The shortest and longest reason an owner states for reading a record (the records bucket's own bounds). */
export const COMPUTE_RECORD_REASON_MIN = 8;
export const COMPUTE_RECORD_REASON_MAX = 200;

/** `GET /admin/compute/jobs`: a page of jobs, newest first; `next_after` continues it. */
export const ComputeJobsListResponseSchema = z
  .object({
    jobs: z.array(ComputeJobViewSchema),
    next_after: z.number().int().nullable(),
  })
  .passthrough();

export type ComputeJobsListResponse = z.infer<typeof ComputeJobsListResponseSchema>;

/** `GET /admin/compute/jobs?unmatched=1`: Expanse's rows that no job claims. */
export const ComputeUnmatchedResponseSchema = z
  .object({
    rows: z.array(
      z
        .object({
          slurm_job_id: z.string(),
          partition: z.string(),
          state: z.string(),
          elapsed_seconds: z.number().int(),
          alloc_nodes: z.number().int(),
          alloc_cpus: z.number().int(),
          alloc_gpus: z.number().int(),
          charged_milli: z.number().int().nullable(),
          ingested_at: z.string(),
        })
        .passthrough(),
    ),
    total: z.number().int(),
  })
  .passthrough();

export type ComputeUnmatchedResponse = z.infer<typeof ComputeUnmatchedResponseSchema>;

/** What reading one record for a job's summary found: present, absent, or present and unusable. */
export const COMPUTE_RECORD_STATUSES = ["ok", "missing", "unreadable"] as const;
export type ComputeRecordStatus = (typeof COMPUTE_RECORD_STATUSES)[number];

/**
 * `GET /admin/compute/records/:ref`: one job's index row, ledger entries, provenance and manifest summary.
 * OPEN (passthrough): the CLI never parses it with a strict compute schema (the amendment on #2006).
 */
export const ComputeRecordResponseSchema = z
  .object({
    job: ComputeJobViewSchema,
    identifiers: z.object({}).passthrough(),
    ledger: z.array(z.object({}).passthrough()),
    provenance: z.object({}).passthrough().nullable(),
    // Why `provenance` or `manifest` is null: the object is not there (`missing`) or is there and
    // cannot be read (`unreadable`); `ok` means the value is present, however empty. Optional so a
    // CLI newer than its Worker still reads the answer.
    provenance_status: z.enum(COMPUTE_RECORD_STATUSES).optional(),
    manifest: z
      .object({ files: z.number().int(), bytes: z.number().int() })
      .passthrough()
      .nullable(),
    manifest_status: z.enum(COMPUTE_RECORD_STATUSES).optional(),
    legal_hold: z.boolean(),
    retention_until: z.string().nullable().optional(),
    launcher_files: z.array(z.string()).optional(),
  })
  .passthrough();

export type ComputeRecordResponse = z.infer<typeof ComputeRecordResponseSchema>;

/** `POST /admin/compute/records/:ref/read`: an owner's reasoned read of one record. */
export const ComputeRecordReadResponseSchema = z
  .object({
    job_id: z.string(),
    name: z.string(),
    kind: z.string(),
    content: z.unknown().optional(),
    url: z.string().optional(),
    expires_at: z.string().optional(),
  })
  .passthrough();

export type ComputeRecordReadResponse = z.infer<typeof ComputeRecordReadResponseSchema>;

/** `GET /admin/compute/report`: one account's jobs and charge in a date range. */
export const ComputeAccountReportResponseSchema = z
  .object({
    account_id: z.number().int(),
    from: z.string(),
    to: z.string(),
    // `unsettled` and `open_hold_milli` are optional so a CLI newer than its Worker still reads the
    // answer; a job whose hold is open has charged nothing yet, and these say how much it still holds.
    totals: z
      .object({
        jobs: z.number().int(),
        charged_milli: z.number().int(),
        unsettled: z.number().int().optional(),
        open_hold_milli: z.number().int().optional(),
      })
      .passthrough(),
    // Each value is an open object (`jobs`, `charged_milli`, `unsettled`, `open_hold_milli`): a word the Worker adds is kept.
    by_pool: z.record(z.object({}).passthrough()),
    jobs: z.array(z.object({}).passthrough()),
    truncated: z.boolean(),
  })
  .passthrough();

export type ComputeAccountReportResponse = z.infer<typeof ComputeAccountReportResponseSchema>;

/** `GET /admin/compute/access-report`: for ACCESS, distinct gateway users and jobs by partition and source. */
export const ComputeAccessReportResponseSchema = z
  .object({
    quarter: z.string(),
    rows: z.array(
      z
        .object({
          partition: z.string(),
          source: z.string(),
          distinct_users: z.number().int(),
          jobs: z.number().int(),
        })
        .passthrough(),
    ),
    totals: z.object({ distinct_users: z.number().int(), jobs: z.number().int() }).passthrough(),
  })
  .passthrough();

export type ComputeAccessReportResponse = z.infer<typeof ComputeAccessReportResponseSchema>;

/** A legal hold. */
export const ComputeHoldViewSchema = z
  .object({
    id: z.number().int(),
    scope: z.string(),
    ref: z.string(),
    reason: z.string(),
    placed_by: z.number().int(),
    placed_at: z.string(),
    released_at: z.string().nullable(),
  })
  .passthrough();

export type ComputeHoldView = z.infer<typeof ComputeHoldViewSchema>;

/** `GET /admin/compute/holds`. */
export const ComputeHoldsResponseSchema = z
  .object({
    holds: z.array(ComputeHoldViewSchema),
    // True when more than 200 holds are active and this list is the oldest 200. Optional so a CLI that
    // reads an older Worker (which cut the list without saying so) still parses its answer.
    truncated: z.boolean().optional(),
  })
  .passthrough();

export type ComputeHoldsResponse = z.infer<typeof ComputeHoldsResponseSchema>;

/** `POST` and `DELETE /admin/compute/holds`. */
export const ComputeHoldResponseSchema = z.object({ hold: ComputeHoldViewSchema }).passthrough();

export type ComputeHoldResponse = z.infer<typeof ComputeHoldResponseSchema>;

/** `GET /admin/compute/access-reports`: ACCESS report rows in one state, and the `failed` rows counted by word. */
export const ComputeAccessReportsResponseSchema = z
  .object({
    rows: z.array(
      z
        .object({
          job_id: z.string(),
          state: z.string(),
          attempts: z.number().int(),
          last_error_code: z.string().nullable(),
          next_attempt_at: z.string(),
          sent_at: z.string().nullable(),
          created_at: z.string(),
        })
        .passthrough(),
    ),
    // Fixed word to count; open, so a word the Worker adds is kept as it came.
    failed_by_word: z.record(z.unknown()),
    next_after: z.string().nullable(),
  })
  .passthrough();

export type ComputeAccessReportsResponse = z.infer<typeof ComputeAccessReportsResponseSchema>;

/** `POST /admin/compute/access-reports/:jobId/requeue`. */
export const ComputeRequeueResponseSchema = z
  .object({ ok: z.boolean(), job_id: z.string(), previous: z.string().nullable() })
  .passthrough();

export type ComputeRequeueResponse = z.infer<typeof ComputeRequeueResponseSchema>;

/** `POST /admin/compute/observer-runs`: the run and its token, shown once. */
export const ComputeObserverRunResponseSchema = z
  .object({ run_id: z.string(), token: z.string(), expires_in_minutes: z.number().int() })
  .passthrough();

export type ComputeObserverRunResponse = z.infer<typeof ComputeObserverRunResponseSchema>;
