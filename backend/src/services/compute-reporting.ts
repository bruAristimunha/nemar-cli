/**
 * What an administrator reads about compute jobs, people and quarters, and the one thing an owner does
 * to an ACCESS report that failed (epic #2005 phase A7, #2012; ADR 0118; design section 9).
 *
 * Every view here is FIXED WORDS, NUMBERS AND TIMES. None carries identity: not a name, an email, an
 * ORCID iD, a country or an affiliation, none a specification, a token, an address or a log. A job's
 * account is its number, as `jobView` always showed it. The identity snapshot and a submitted file are
 * reached only through `readRecordObject` (owner-only, reasoned, audited), and the provenance and
 * manifest summaries below are read from the records bucket without them: the launcher's provenance
 * names an image digest, timings and dataset versions, and the manifest summary is a count and a size,
 * never a path.
 *
 *   `listJobRows`                 jobs by flag, state, account, executor, accounting and runner, newest
 *                                 first, keyset-paged
 *   `listUnmatchedSacct`          Expanse's rows that no job claims
 *   `resolveJobRef`               a NEMAR job id, a Tapis uuid or a Slurm id, in that order
 *   `recordSummary`               one job: the index row, its ledger entries, provenance, manifest
 *   `accountReport`               one account's jobs and charge in a date range; runner jobs are listed and
 *                                 totaled APART, in the runner's own figures, never in service units
 *   `runnersUsageReport`          every runner registration's usage in a date range, never in service units
 *   `accessReport`                distinct gateway users and jobs by partition and source in a quarter
 *   `listAccessReportFailures`    `failed` ACCESS report rows, counted by their fixed word
 *   `listAccessReports`           those rows, listed
 *   `requeueAccessReport`         OWNER-ONLY: put a `failed` row back to `pending`, on the owner's
 *                                 explicit word that ACCESS did NOT record it
 */

import {
  COMPUTE_ACCOUNTING,
  COMPUTE_EXECUTORS,
  COMPUTE_JOB_FLAGS,
  COMPUTE_STATES,
  type ComputeAccounting,
  type ComputeExecutor,
  type ComputeJobFlag,
  type ComputeState,
} from "../../../shared/compute-state.js";
import type { ComputeRecordStatus } from "../../../shared/contract/compute-admin.js";
import { COMPUTE_RUNNER_REPORT_DAYS_MAX } from "../../../shared/contract/compute-admin.js";
import { RUNNER_ID_RE } from "../../../shared/contract/compute-runner.js";
import { COMPUTE_JOB_ID_RE } from "../../../shared/contract/compute.js";
import { LAUNCHER_FILES, RECORDS_RESULT_MANIFEST_FILE } from "../../../shared/contract/compute.js";
import type { Bindings } from "../types/bindings.js";
import { ACTIVE_ACCOUNT_STATUS_SQL_LIST } from "./account-tier.js";
import { FLAG_COLUMN, type FlagColumns, flagsOf } from "./compute-job-flags.js";
import { type ComputeJobRow, getJob } from "./compute-jobs.js";
import { ACTIVE_OWNER_SQL, heldSql } from "./compute-legal-holds.js";
import { jobView } from "./compute-lifecycle.js";
import { recordKey } from "./compute-records.js";

/** The most rows a list answers with at once. */
export const REPORT_PAGE_MAX = 200;
/** The most jobs one account report carries; the rest is `truncated`. */
export const ACCOUNT_REPORT_ROWS_MAX = 5000;

// --- Jobs -----------------------------------------------------------------------------------------------

export interface JobListQuery {
  flag?: ComputeJobFlag;
  state?: ComputeState;
  account?: number;
  /** Who runs the job: `tapis` or `runner`. */
  executor?: ComputeExecutor;
  /** How the job is accounted for: `su` (service units) or `none` (a runner's own figures only). */
  accounting?: ComputeAccounting;
  /** A runner registration's id (`RUNNER_ID_RE`): the jobs that runner claimed. */
  runner?: string;
  limit: number;
  /** The `seq` of the last job of the previous page. */
  after?: number;
}

/**
 * A job row as the reports read it: the index row with the column the shared row type does not list,
 * whether the runner marked its usage partial (1 or 0; null for a Tapis job and for a runner job that has
 * not completed).
 */
export type ReportedJobRow = ComputeJobRow & { runner_usage_partial: number | null };

/** The stored 1, 0 or NULL as the views carry it: true, false or null (not reported). */
const partialOf = (stored: number | null | undefined): boolean | null =>
  stored === null || stored === undefined ? null : stored === 1;

/**
 * The job as `jobView` shows it, plus whether the runner marked its usage partial. Every report that
 * shows a runner's figures goes through this, so a partial figure is marked wherever it is shown.
 */
export function reportedJobView(job: ReportedJobRow) {
  return { ...jobView(job), runner_usage_partial: partialOf(job.runner_usage_partial) };
}

/**
 * The job row with the mark `getJob`'s column list does not select: for a route that answers with a job read
 * by `getJob` (the cancel answer of a runner job that already ended carries the usage its runner reported,
 * and so the mark that says whether it is whole).
 */
export async function withUsageMark(db: D1Database, job: ComputeJobRow): Promise<ReportedJobRow> {
  const stored = await db
    .prepare("SELECT runner_usage_partial FROM compute_jobs WHERE id = ?1")
    .bind(job.id)
    .first<{ runner_usage_partial: number | null }>();
  return { ...job, runner_usage_partial: stored?.runner_usage_partial ?? null };
}

/**
 * A page of jobs, newest first, with the keyset `next_after` (the oldest row's `seq`, its rowid) or null
 * at the end. Every filter is a column test with a bound value; the flag's column comes from a fixed map.
 */
export async function listJobRows(
  db: D1Database,
  q: JobListQuery,
): Promise<{ jobs: ReportedJobRow[]; next_after: number | null }> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q.flag !== undefined) {
    if (!(COMPUTE_JOB_FLAGS as readonly string[]).includes(q.flag))
      throw new RangeError("not a flag");
    where.push(`${FLAG_COLUMN[q.flag]} = 1`);
  }
  if (q.state !== undefined) {
    if (!(COMPUTE_STATES as readonly string[]).includes(q.state))
      throw new RangeError("not a state");
    where.push("state = ?");
    binds.push(q.state);
  }
  if (q.account !== undefined) {
    where.push("account_id = ?");
    binds.push(q.account);
  }
  if (q.executor !== undefined) {
    if (!(COMPUTE_EXECUTORS as readonly string[]).includes(q.executor))
      throw new RangeError("not an executor");
    where.push("executor = ?");
    binds.push(q.executor);
  }
  if (q.accounting !== undefined) {
    if (!(COMPUTE_ACCOUNTING as readonly string[]).includes(q.accounting))
      throw new RangeError("not an accounting class");
    where.push("accounting = ?");
    binds.push(q.accounting);
  }
  if (q.runner !== undefined) {
    if (!RUNNER_ID_RE.test(q.runner)) throw new RangeError("not a runner id");
    where.push("runner_id = ?");
    binds.push(q.runner);
  }
  if (q.after !== undefined) {
    where.push("rowid < ?");
    binds.push(q.after);
  }
  const limit = Math.min(Math.max(1, Math.trunc(q.limit)), REPORT_PAGE_MAX);
  const rows = (
    await db
      .prepare(
        `SELECT rowid AS seq, * FROM compute_jobs ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY rowid DESC LIMIT ?`,
      )
      .bind(...binds, limit + 1)
      .all<ReportedJobRow & { seq: number }>()
  ).results;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    jobs: page,
    next_after: rows.length > limit && last !== undefined ? last.seq : null,
  };
}

export interface UnmatchedRow {
  slurm_job_id: string;
  partition: string;
  state: string;
  elapsed_seconds: number;
  alloc_nodes: number;
  alloc_cpus: number;
  alloc_gpus: number;
  charged_milli: number | null;
  ingested_at: string;
}

/** Expanse's rows that no job claims, newest first. */
export async function listUnmatchedSacct(
  db: D1Database,
  limit: number,
): Promise<{ rows: UnmatchedRow[]; total: number }> {
  const rows = (
    await db
      .prepare(
        `SELECT slurm_job_id, partition, state, elapsed_seconds, alloc_nodes, alloc_cpus, alloc_gpus,
                charged_milli, ingested_at
           FROM compute_sacct_rows WHERE matched_job_id IS NULL ORDER BY ingested_at DESC, slurm_job_id
          LIMIT ?`,
      )
      .bind(Math.min(Math.max(1, Math.trunc(limit)), REPORT_PAGE_MAX))
      .all<UnmatchedRow>()
  ).results;
  const total = await db
    .prepare("SELECT COUNT(*) AS n FROM compute_sacct_rows WHERE matched_job_id IS NULL")
    .first<{ n: number }>();
  return { rows, total: total?.n ?? 0 };
}

// --- One job, by any of its three names --------------------------------------------------------------------

/** The job a reference names: a NEMAR job id, else a Tapis job uuid, else a Slurm job id. Null when none. */
export async function resolveJobRef(db: D1Database, ref: string): Promise<ComputeJobRow | null> {
  if (typeof ref !== "string" || ref.length === 0 || ref.length > 128) return null;
  if (COMPUTE_JOB_ID_RE.test(ref)) return getJob(db, ref);
  const byUuid = await db
    .prepare("SELECT id FROM compute_jobs WHERE tapis_uuid = ?1")
    .bind(ref)
    .first<{ id: string }>();
  if (byUuid !== null) return getJob(db, byUuid.id);
  const bySlurm = await db
    .prepare("SELECT id FROM compute_jobs WHERE slurm_job_id = ?1 ORDER BY created_at DESC LIMIT 1")
    .bind(ref)
    .first<{ id: string }>();
  return bySlurm === null ? null : getJob(db, bySlurm.id);
}

/** The launcher's provenance, reduced to the fields that name no one. */
const PROVENANCE_FIELDS = [
  "launch_spec_digest",
  "bundle_digest",
  "image",
  "runtime_version",
  "timings",
  "slurm_job_id",
  "entry_exit_code",
] as const;

/** The most bytes of a record read for a summary. */
const SUMMARY_READ_MAX = 1024 * 1024;

async function readJsonRecord(
  env: Bindings,
  key: string,
): Promise<{ kind: "ok"; value: unknown } | { kind: "missing" } | { kind: "unreadable" }> {
  if (!env.COMPUTE_RECORDS) return { kind: "unreadable" };
  try {
    const object = await env.COMPUTE_RECORDS.get(key);
    if (object === null) return { kind: "missing" };
    if (object.size > SUMMARY_READ_MAX) return { kind: "unreadable" };
    return { kind: "ok", value: JSON.parse(await object.text()) };
  } catch {
    return { kind: "unreadable" };
  }
}

/** A record that was read but whose value is not the shape a summary needs is unreadable, not present. */
function statusOf(kind: ComputeRecordStatus, view: unknown): ComputeRecordStatus {
  return kind === "ok" && view === null ? "unreadable" : kind;
}

export interface LedgerLine {
  id: number;
  kind: string;
  pool_id: number;
  budget_pool_id: number | null;
  granted_delta_milli: number;
  held_delta_milli: number;
  charged_delta_milli: number;
  reason: string | null;
  created_at: string;
}

/**
 * One job as an administrator reads it: the index row, its ledger entries, provenance, manifest summary.
 * A runner job's usage is marked partial here too, as in every list.
 */
export async function recordSummary(env: Bindings, job: ComputeJobRow) {
  const ledger = (
    await env.DB.prepare(
      `SELECT id, kind, pool_id, budget_pool_id, granted_delta_milli, held_delta_milli,
              charged_delta_milli, reason, created_at
         FROM compute_ledger WHERE job_id = ?1 ORDER BY id`,
    )
      .bind(job.id)
      .all<LedgerLine>()
  ).results;
  const held = await env.DB.prepare(
    `SELECT CASE WHEN ${heldSql("j")} THEN 1 ELSE 0 END AS held,
            j.runner_usage_partial AS runner_usage_partial
       FROM compute_jobs j WHERE j.id = ?1`,
  )
    .bind(job.id)
    .first<{ held: number; runner_usage_partial: number | null }>();

  const provenance = await readJsonRecord(env, recordKey(job.id, "provenance.json"));
  const manifest = await readJsonRecord(env, recordKey(job.id, RECORDS_RESULT_MANIFEST_FILE));
  let provenanceView: Record<string, unknown> | null = null;
  if (
    provenance.kind === "ok" &&
    typeof provenance.value === "object" &&
    provenance.value !== null
  ) {
    const source = provenance.value as Record<string, unknown>;
    provenanceView = {};
    for (const field of PROVENANCE_FIELDS) {
      if (field in source) provenanceView[field] = source[field];
    }
  }
  let manifestView: { files: number; bytes: number } | null = null;
  if (manifest.kind === "ok" && typeof manifest.value === "object" && manifest.value !== null) {
    const files = (manifest.value as { files?: unknown }).files;
    if (Array.isArray(files)) {
      let bytes = 0;
      for (const f of files) {
        const size = (f as { size?: unknown } | null)?.size;
        if (typeof size === "number" && Number.isSafeInteger(size) && size >= 0) bytes += size;
      }
      manifestView = { files: files.length, bytes };
    }
  }
  return {
    job: reportedJobView({ ...job, runner_usage_partial: held?.runner_usage_partial ?? null }),
    identifiers: {
      tapis_uuid: job.tapis_uuid,
      slurm_job_id: job.slurm_job_id,
      app_id: job.app_id,
      app_version: job.app_version,
      image_digest: job.image_digest,
      spec_digest: job.spec_digest,
      launch_spec_digest: job.launch_spec_digest,
    },
    ledger,
    provenance: provenanceView,
    provenance_status: statusOf(provenance.kind, provenanceView),
    manifest: manifestView,
    manifest_status: statusOf(manifest.kind, manifestView),
    legal_hold: (held?.held ?? 0) === 1,
    retention_until: job.retention_until,
    // Every launcher file name, so a reader of the summary knows which records exist to be asked for.
    launcher_files: Object.values(LAUNCHER_FILES),
  };
}

// --- A person, a range ---------------------------------------------------------------------------------------

export interface AccountReport {
  account_id: number;
  from: string;
  to: string;
  /**
   * `charged_milli` is what is CHARGED so far. A job whose settlement has not been written still has
   * its hold open and charges 0, so `unsettled` counts those jobs and `open_hold_milli` is what they
   * still hold: the account has used at least `charged_milli` and may owe up to
   * `charged_milli + open_hold_milli`.
   */
  totals: { jobs: number; charged_milli: number; unsettled: number; open_hold_milli: number };
  by_pool: Record<
    string,
    { jobs: number; charged_milli: number; unsettled: number; open_hold_milli: number }
  >;
  /**
   * The runner jobs, APART from `totals` and `by_pool` (ADR 0121: a runner-reported core-hour is never
   * added to a service-unit total). `totals` and `by_pool` count `accounting = 'su'` jobs only; this holds
   * the jobs a runner ran, in the runner's own figures. `core_hours` is `cpu_seconds / 3600` rounded down
   * to three decimals. `reported_jobs` counts the jobs whose runner has reported usage: a job that has not
   * adds to `jobs` and nothing else, so `reported_jobs` below `jobs` says that a sum leaves jobs out and a
   * zero sum is not zero usage. `partial_jobs` counts the jobs whose usage the runner marked partial, so the
   * sums are a lower bound when it is above zero, and `unmarked_jobs` those that reported usage with no mark
   * (completed before the mark was stored): whether they are whole is unknown, never assumed.
   */
  runner_totals: RunnerTotals;
  jobs: Array<{
    id: string;
    created_at: string;
    ended_at: string | null;
    state: string;
    partition: string;
    pool: string;
    source: string;
    charged_milli: number;
    /** False while the job's hold is open: `charged_milli` is not its final figure yet. */
    settled: boolean;
    /** The hold the job still has open: 0 once it is settled (the hold was closed by the settlement). */
    open_hold_milli: number;
    flags: string[];
    /** Who ran the job (`tapis` or `runner`) and how it is accounted for (`su` or `none`). */
    executor: string;
    accounting: string;
    /** The runner registration that claimed the job; null for a Tapis job and for an unclaimed job. */
    runner_id: string | null;
    /**
     * A runner job's own figures, never service units: null for a Tapis job; each figure is null until
     * the runner reports. `partial` is true when the runner marked them partial (Docker or Podman).
     */
    runner_usage: RunnerUsage | null;
  }>;
  truncated: boolean;
}

/** What a runner measured for one job, in whole numbers. */
export interface RunnerUsage {
  wall_seconds: number | null;
  cpu_seconds: number | null;
  max_rss_mb: number | null;
  partial: boolean | null;
}

/** Runner usage summed over jobs, in the runner's own figures. */
export interface RunnerTotals {
  jobs: number;
  wall_seconds: number;
  cpu_seconds: number;
  core_hours: number;
  reported_jobs: number;
  partial_jobs: number;
  unmarked_jobs: number;
}

/**
 * Runner-reported core-hours: `cpu_seconds / 3600`, rounded DOWN to three decimals. Whole-number arithmetic,
 * so no rounding error enters. It is the runner's own figure and is never added to a service-unit total.
 */
export function runnerCoreHours(cpuSeconds: number): number {
  return Number((BigInt(Math.trunc(cpuSeconds)) * 1000n) / 3600n) / 1000;
}

/** An account's jobs created from `from` to the end of `to` (dates, `YYYY-MM-DD`), and what they cost. */
export async function accountReport(
  db: D1Database,
  input: { account: number; from: string; to: string },
): Promise<AccountReport> {
  const rows = (
    await db
      .prepare(
        `SELECT id, created_at, ended_at, state, partition, pool, source, charged_milli,
                held_milli, settled_provisional_at, flag_unreserved, flag_unattributed, flag_mismatch, flag_overrun,
                executor, accounting, runner_id, runner_wall_seconds, runner_cpu_seconds,
                runner_max_rss_mb, runner_usage_partial
           FROM compute_jobs
          WHERE account_id = ?1 AND created_at >= ?2 AND created_at < date(?3, '+1 day')
          ORDER BY created_at ASC, id ASC LIMIT ?4`,
      )
      .bind(input.account, input.from, input.to, ACCOUNT_REPORT_ROWS_MAX + 1)
      .all<
        FlagColumns & {
          id: string;
          created_at: string;
          ended_at: string | null;
          state: string;
          partition: string;
          pool: string;
          source: string;
          charged_milli: number;
          held_milli: number;
          settled_provisional_at: string | null;
          executor: string;
          accounting: string;
          runner_id: string | null;
          runner_wall_seconds: number | null;
          runner_cpu_seconds: number | null;
          runner_max_rss_mb: number | null;
          runner_usage_partial: number | null;
        }
      >()
  ).results;
  const truncated = rows.length > ACCOUNT_REPORT_ROWS_MAX;
  const page = rows.slice(0, ACCOUNT_REPORT_ROWS_MAX);
  const byPool: AccountReport["by_pool"] = {};
  const totals = { jobs: 0, charged_milli: 0, unsettled: 0, open_hold_milli: 0 };
  const runnerSums = {
    jobs: 0,
    wall_seconds: 0,
    cpu_seconds: 0,
    reported_jobs: 0,
    partial_jobs: 0,
    unmarked_jobs: 0,
  };
  const jobs = page.map((r) => {
    const settled = r.settled_provisional_at !== null;
    const openHold = settled ? 0 : r.held_milli;
    // Service units: only a job accounted in them is counted here. A runner job is not, whatever it used.
    if (r.accounting === "su") {
      const entry = byPool[r.pool] ?? {
        jobs: 0,
        charged_milli: 0,
        unsettled: 0,
        open_hold_milli: 0,
      };
      byPool[r.pool] = entry;
      for (const t of [entry, totals]) {
        t.jobs++;
        t.charged_milli += r.charged_milli;
        t.open_hold_milli += openHold;
        if (!settled) t.unsettled++;
      }
    }
    // The runner's own figures, in a total of their own.
    const ranOnRunner = r.executor === "runner";
    if (ranOnRunner) {
      runnerSums.jobs++;
      runnerSums.wall_seconds += r.runner_wall_seconds ?? 0;
      runnerSums.cpu_seconds += r.runner_cpu_seconds ?? 0;
      if (r.runner_wall_seconds !== null) {
        runnerSums.reported_jobs++;
        if (r.runner_usage_partial === null) runnerSums.unmarked_jobs++;
      }
      if (r.runner_usage_partial === 1) runnerSums.partial_jobs++;
    }
    return {
      id: r.id,
      created_at: r.created_at,
      ended_at: r.ended_at,
      state: r.state,
      partition: r.partition,
      pool: r.pool,
      source: r.source,
      charged_milli: r.charged_milli,
      settled,
      open_hold_milli: openHold,
      flags: flagsOf(r),
      executor: r.executor,
      accounting: r.accounting,
      runner_id: r.runner_id,
      runner_usage: ranOnRunner
        ? {
            wall_seconds: r.runner_wall_seconds,
            cpu_seconds: r.runner_cpu_seconds,
            max_rss_mb: r.runner_max_rss_mb,
            partial: partialOf(r.runner_usage_partial),
          }
        : null,
    };
  });
  return {
    account_id: input.account,
    from: input.from,
    to: input.to,
    totals,
    by_pool: byPool,
    runner_totals: { ...runnerSums, core_hours: runnerCoreHours(runnerSums.cpu_seconds) },
    jobs,
    truncated,
  };
}

// --- Every runner, a range -----------------------------------------------------------------------------------------

/**
 * Calendar days from `from` to `to` counting both, for two dates (`YYYY-MM-DD`) that are real calendar days;
 * null when either is not one (February 30 is not), and a number below 1 when `from` is after `to`.
 */
export function reportRangeDays(from: string, to: string): number | null {
  const day = (text: string): number | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (m === null) return null;
    const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return new Date(at).toISOString().slice(0, 10) === text ? at : null;
  };
  const a = day(from);
  const b = day(to);
  if (a === null || b === null) return null;
  return Math.round((b - a) / 86_400_000) + 1;
}

export interface RunnersUsageReport {
  from: string;
  to: string;
  runners: Array<{
    id: string;
    name: string;
    site: string;
    trust: string;
    revoked: boolean;
    /** The jobs the runner claimed that were created in the range, and how many are in each state. */
    jobs: number;
    by_state: Record<string, number>;
    wall_seconds: number;
    cpu_seconds: number;
    core_hours: number;
    max_rss_mb: number | null;
    /** The jobs whose runner has reported usage: below `jobs`, the sums leave some out (a zero is not zero usage). */
    reported_jobs: number;
    /** Jobs whose usage the runner marked partial (Docker or Podman): the sums are a lower bound. */
    partial_jobs: number;
    /** Jobs that reported usage with no mark (completed before it was stored): whole or not is unknown. */
    unmarked_jobs: number;
  }>;
  totals: RunnerTotals;
}

/**
 * EVERY runner registration's usage over the jobs created from `from` to the end of `to` (the same range
 * `accountReport` reads, at most `COMPUTE_RUNNER_REPORT_DAYS_MAX` days: the caller checks it with
 * `reportRangeDays`). The figures are the runners' OWN (wall and CPU seconds, the largest resident memory)
 * and are never service units. Groups by registration only: no name, email or account of a person is read.
 * A registration with no job in the range is listed with zeros; a revoked one stays listed.
 */
export async function runnersUsageReport(
  db: D1Database,
  input: { from: string; to: string },
): Promise<RunnersUsageReport> {
  const days = reportRangeDays(input.from, input.to);
  if (days === null || days < 1 || days > COMPUTE_RUNNER_REPORT_DAYS_MAX) {
    throw new RangeError("not a range this report answers");
  }
  const registrations = (
    await db
      .prepare(
        `SELECT id, name, site, trust, revoked_at FROM compute_runners
          ORDER BY registered_at ASC, id ASC`,
      )
      .all<{ id: string; name: string; site: string; trust: string; revoked_at: string | null }>()
  ).results;
  const groups = (
    await db
      .prepare(
        `SELECT runner_id, state, COUNT(*) AS jobs,
                COALESCE(SUM(runner_wall_seconds), 0) AS wall_seconds,
                COALESCE(SUM(runner_cpu_seconds), 0) AS cpu_seconds,
                MAX(runner_max_rss_mb) AS max_rss_mb,
                COALESCE(SUM(CASE WHEN runner_wall_seconds IS NOT NULL THEN 1 ELSE 0 END), 0) AS reported_jobs,
                COALESCE(SUM(CASE WHEN runner_usage_partial = 1 THEN 1 ELSE 0 END), 0) AS partial_jobs,
                COALESCE(SUM(CASE WHEN runner_wall_seconds IS NOT NULL AND runner_usage_partial IS NULL
                                  THEN 1 ELSE 0 END), 0) AS unmarked_jobs
           FROM compute_jobs
          WHERE executor = 'runner' AND runner_id IS NOT NULL
            AND created_at >= ?1 AND created_at < date(?2, '+1 day')
          GROUP BY runner_id, state`,
      )
      .bind(input.from, input.to)
      .all<{
        runner_id: string;
        state: string;
        jobs: number;
        wall_seconds: number;
        cpu_seconds: number;
        max_rss_mb: number | null;
        reported_jobs: number;
        partial_jobs: number;
        unmarked_jobs: number;
      }>()
  ).results;
  const totals = {
    jobs: 0,
    wall_seconds: 0,
    cpu_seconds: 0,
    reported_jobs: 0,
    partial_jobs: 0,
    unmarked_jobs: 0,
  };
  const runners = registrations.map((r) => {
    const own = groups.filter((g) => g.runner_id === r.id);
    const sum = {
      jobs: 0,
      wall_seconds: 0,
      cpu_seconds: 0,
      reported_jobs: 0,
      partial_jobs: 0,
      unmarked_jobs: 0,
    };
    const byState: Record<string, number> = {};
    let maxRss: number | null = null;
    for (const g of own) {
      byState[g.state] = g.jobs;
      sum.jobs += g.jobs;
      sum.wall_seconds += g.wall_seconds;
      sum.cpu_seconds += g.cpu_seconds;
      sum.reported_jobs += g.reported_jobs;
      sum.partial_jobs += g.partial_jobs;
      sum.unmarked_jobs += g.unmarked_jobs;
      if (g.max_rss_mb !== null) maxRss = Math.max(maxRss ?? 0, g.max_rss_mb);
    }
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += sum[key];
    return {
      id: r.id,
      name: r.name,
      site: r.site,
      trust: r.trust,
      revoked: r.revoked_at !== null,
      jobs: sum.jobs,
      by_state: byState,
      wall_seconds: sum.wall_seconds,
      cpu_seconds: sum.cpu_seconds,
      core_hours: runnerCoreHours(sum.cpu_seconds),
      max_rss_mb: maxRss,
      reported_jobs: sum.reported_jobs,
      partial_jobs: sum.partial_jobs,
      unmarked_jobs: sum.unmarked_jobs,
    };
  });
  return {
    from: input.from,
    to: input.to,
    runners,
    totals: { ...totals, core_hours: runnerCoreHours(totals.cpu_seconds) },
  };
}

// --- A quarter, for ACCESS ----------------------------------------------------------------------------------------

const QUARTER_RE = /^(\d{4})Q([1-4])$/;

/** `2026Q4` as its first day and the first day of the next quarter, or null. */
export function quarterBounds(quarter: string): { start: string; end: string } | null {
  const m = QUARTER_RE.exec(quarter);
  if (m === null) return null;
  const year = Number(m[1]);
  const q = Number(m[2]);
  const month = (q - 1) * 3 + 1;
  const pad = (n: number) => String(n).padStart(2, "0");
  const next = q === 4 ? { y: year + 1, m: 1 } : { y: year, m: month + 3 };
  return {
    start: `${year}-${pad(month)}-01 00:00:00`,
    end: `${next.y}-${pad(next.m)}-01 00:00:00`,
  };
}

export interface AccessReport {
  quarter: string;
  rows: Array<{ partition: string; source: string; distinct_users: number; jobs: number }>;
  totals: { distinct_users: number; jobs: number };
}

/**
 * For ACCESS, the jobs the scheduler took in the quarter: the distinct gateway users (pseudonyms,
 * counted and never listed) and the jobs, by partition and source. A job counts when it has a Slurm id
 * and its `remote_submitted_at` (the scheduler's own submission time, UTC) falls in the quarter, which
 * is exactly what the ACCESS reporter sends; `submitted_at` (NEMAR's bind to Tapis) is not used, so a
 * job Tapis accepted that never reached the scheduler is not counted, and one bound late on the last
 * day of a quarter and scheduled in the next belongs to the next. A job that skipped the reservation or
 * whose owner NEMAR could not attribute is excluded: it has no gateway user to report, and ACCESS is
 * not told of use NEMAR did not authorise as the person's. A runner job (`accounting = 'none'`) is never counted:
 * it did not run on the allocation. A person is counted once however many jobs.
 */
export async function accessReport(db: D1Database, quarter: string): Promise<AccessReport | null> {
  const bounds = quarterBounds(quarter);
  if (bounds === null) return null;
  const where = `slurm_job_id IS NOT NULL AND remote_submitted_at >= ?1 AND remote_submitted_at < ?2
      AND flag_unattributed = 0 AND flag_unreserved = 0 AND gateway_user IS NOT NULL
      AND accounting = 'su'`;
  const rows = (
    await db
      .prepare(
        `SELECT partition, source, COUNT(DISTINCT gateway_user) AS distinct_users, COUNT(*) AS jobs
           FROM compute_jobs WHERE ${where} GROUP BY partition, source ORDER BY partition, source`,
      )
      .bind(bounds.start, bounds.end)
      .all<{ partition: string; source: string; distinct_users: number; jobs: number }>()
  ).results;
  const totals = await db
    .prepare(
      `SELECT COUNT(DISTINCT gateway_user) AS distinct_users, COUNT(*) AS jobs
         FROM compute_jobs WHERE ${where}`,
    )
    .bind(bounds.start, bounds.end)
    .first<{ distinct_users: number; jobs: number }>();
  return {
    quarter,
    rows,
    totals: { distinct_users: totals?.distinct_users ?? 0, jobs: totals?.jobs ?? 0 },
  };
}

// --- ACCESS reports that failed ------------------------------------------------------------------------------------------

/** `failed` ACCESS report rows counted by their fixed word (`outcome_unknown`, `no_gateway_user`, ...). */
export async function listAccessReportFailures(db: D1Database): Promise<Record<string, number>> {
  const rows = (
    await db
      .prepare(
        `SELECT last_error_code AS word, COUNT(*) AS n FROM compute_access_reports
          WHERE state = 'failed' GROUP BY last_error_code ORDER BY last_error_code`,
      )
      .all<{ word: string; n: number }>()
  ).results;
  return Object.fromEntries(rows.map((r) => [r.word, r.n]));
}

export interface AccessReportRow {
  job_id: string;
  state: string;
  attempts: number;
  last_error_code: string | null;
  next_attempt_at: string;
  sent_at: string | null;
  created_at: string;
}

/** ACCESS report rows in one state, oldest first, keyset-paged by creation order. */
export async function listAccessReports(
  db: D1Database,
  input: { state: string; limit: number; after?: string },
): Promise<{ rows: AccessReportRow[]; counts: Record<string, number>; next_after: string | null }> {
  const limit = Math.min(Math.max(1, Math.trunc(input.limit)), REPORT_PAGE_MAX);
  const rows = (
    await db
      .prepare(
        `SELECT job_id, state, attempts, last_error_code, next_attempt_at, sent_at, created_at
           FROM compute_access_reports
          WHERE state = ?1 AND (?2 IS NULL OR job_id > ?2) ORDER BY job_id ASC LIMIT ?3`,
      )
      .bind(input.state, input.after ?? null, limit + 1)
      .all<AccessReportRow>()
  ).results;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const counts = await listAccessReportFailures(db);
  return {
    rows: page,
    counts,
    next_after: rows.length > limit && last !== undefined ? last.job_id : null,
  };
}

/**
 * Put a `failed` ACCESS report back to `pending`, due now, with its attempts cleared. OWNER-ONLY, and
 * only on the owner's explicit acknowledgement that the report is confirmed NOT recorded at ACCESS: an
 * unknown outcome is never sent again by code (a report may be lost, never doubled), so a person has
 * looked and says so. Audited in the same batch, with the word the row failed with. The role is read in
 * the statement itself.
 */
export const REQUEUE_ACCESS_REPORT_SQL = `UPDATE compute_access_reports SET
    state = 'pending', attempts = 0, next_attempt_at = datetime('now'), claimed_at = NULL,
    last_error_code = NULL
  WHERE job_id = ?1 AND state = 'failed'
    AND EXISTS (SELECT 1 FROM users u WHERE u.id = ?2 AND u.role = 'owner' AND u.deleted_at IS NULL
                  AND u.status IN ${ACTIVE_ACCOUNT_STATUS_SQL_LIST})`;

export const REQUEUE_AUDIT_ACTION = "compute.access_report.requeue";

export type RequeueResult =
  | { ok: true; previous: string | null }
  | { ok: false; code: "not_owner" | "report_not_found" };

export async function requeueAccessReport(
  db: D1Database,
  input: { jobId: string; ownerId: number },
): Promise<RequeueResult> {
  const before = await db
    .prepare("SELECT state, last_error_code FROM compute_access_reports WHERE job_id = ?1")
    .bind(input.jobId)
    .first<{ state: string; last_error_code: string | null }>();
  const results = await db.batch([
    db.prepare(REQUEUE_ACCESS_REPORT_SQL).bind(input.jobId, input.ownerId),
    db
      .prepare(
        `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
         SELECT ?1, '${REQUEUE_AUDIT_ACTION}', 'compute_job', ?2, json_object('previous', ?3)
          WHERE changes() > 0`,
      )
      .bind(input.ownerId, input.jobId, before?.last_error_code ?? null),
  ]);
  if ((results[0]?.meta?.changes ?? 0) === 1) {
    return { ok: true, previous: before?.last_error_code ?? null };
  }
  const owner = await db.prepare(ACTIVE_OWNER_SQL).bind(input.ownerId).first();
  return { ok: false, code: owner === null ? "not_owner" : "report_not_found" };
}
