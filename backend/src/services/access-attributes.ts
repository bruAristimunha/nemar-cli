/**
 * The ACCESS gateway-attributes report of every Slurm job (epic #2005 phase A8, #2013; ADR 0118
 * decision 9; design section 9). ACCESS requires a community-account gateway to report the end user of
 * every job: the Slurm job id, the submission time, the resource name and the gateway user, which is
 * the pseudonym NEMAR stores for the account (`compute_gateway_users`; `nemar-pipelines` for NEMAR's own
 * jobs) and never a name, an email or the sign-in subject.
 *
 *   the row      `ACCESS_REPORT_PENDING_SQL`: the row of `compute_access_reports` (migration 0119) that the
 *                lifecycle writes in the SAME BATCH as the job row first showing its Slurm id, so every
 *                Slurm job is owed exactly one report and none is owed for a job the scheduler never saw;
 *   the sender   `sendAccessReport`: claim, POST, record outcome, for one job;
 *   the tick     `runAccessReportCron`: the 30-minute tick's production-only call, ten due rows at a time.
 *
 * THE GUARANTEE, and what it is not. TOWARDS ACCESS A REPORT IS SENT AT MOST ONCE for every outcome this
 * code cannot judge, and is retried only when ACCESS visibly did not process the request:
 *  - THE CLAIM. The row is taken by ONE conditional UPDATE (`pending` to `attempting`, a lease stamp,
 *    the attempt counted) BEFORE the POST. Two overlapping ticks, a tick and a retry, or two Workers
 *    cannot both send: only the one that changed the row goes on. The claim is the only thing that
 *    makes a request; nothing sends without it.
 *  - WHAT IS RETRIED. ONLY AN ANSWER THAT SHOWS THE REQUEST WAS NOT PROCESSED: a 4xx other than 409 (a
 *    refusal of the request itself), 408 and 429 (the server did not take it) and 503 (the service is
 *    unavailable, which a server says before it reads the request). The row goes back to `pending` with
 *    an exponential delay (an hour, doubling, a day at most) and ends `failed` only when the attempts
 *    run out. That is a retry of a request ACCESS did not process, not a second report.
 *  - WHAT IS NOT. Everything else is an outcome this code cannot judge, and it is the same as no answer:
 *    NO ANSWER (a timeout, a lost or refused connection: a runtime cannot tell the last from a reset
 *    after the request left); a 500, 502 or 504 (a gateway in front of a server that already stored the
 *    request answers 502 or 504, and a server answers 500 after the write); every 3xx (303, "created,
 *    see other", is the usual reply to a POST that stored something, and a redirect is never followed);
 *    409 (which may turn out to mean "already recorded"); a sender that died holding its lease, which
 *    may have died before or after the POST. Each ends the row `failed` with `outcome_unknown`, and
 *    NOTHING IN CODE SENDS IT AGAIN: a person looks (ACCESS can say whether it holds the job) and
 *    resolves it. The lease is ten minutes, far longer than the fifteen seconds a POST may take, and the
 *    tick reaps an expired one.
 *  - THE OUTCOME IS WRITTEN UNDER THE SENDER'S OWN STAMP (`AND claimed_at = ?`), so a sender whose lease
 *    was reaped cannot overwrite the truth with a late answer.
 * So the residual is a LOST report, never a doubled one: a report that may have been recorded and is not
 * known to have been is not sent a second time, because the design says a second report double-counts a
 * person and nothing in the interface (UNVERIFIED) promises that a duplicate is ignored. If the owner
 * learns that `job_attributes` stores ONE record per (job id, resource), so that a duplicate is
 * ignored, the only change is the classification in `classifyAnswer` (the unknown outcomes become
 * retries); nothing else depends on it. That is a question for ACCESS, and an owner action.
 *
 * NO NETWORK CALL RUNS INSIDE A DATABASE BATCH: the claim, the POST and the outcome are three separate
 * steps, and the POST is made between two statements, never in a batch (a test scans for it).
 *
 * THE KEY AND THE SPELLING ARE UNVERIFIED. The ACCESS key is the Worker secret `ACCESS_GATEWAY_ATTRIBUTES_KEY`
 * and the resource name the secret `ACCESS_RESOURCE_NAME`, both optional: unset, a row stays `pending`
 * with `unconfigured` and nothing is sent. Neither is ever logged, stored or put in a job. No response
 * from the real interface has been seen: the name of the header that carries the key
 * (`ACCESS_KEY_HEADER`) and the spelling of the body (`ACCESS_BODY_FIELDS`, and the time format of
 * `accessSubmitTime`) are each ONE constant here, from the design page and the phase issue, to be
 * confirmed against the real interface when the key is issued. Outside production the body carries
 * `debug`, which the design says the interface offers for tests (also UNVERIFIED as a body field).
 * LOGS carry counts and fixed words only.
 */

import type { ComputeAccessReportError } from "../../../shared/compute-state.js";
import type { Bindings } from "../types/bindings.js";
import { isExactProduction } from "./repull-switches.js";

// --- What is unverified, each in one place -------------------------------------------------------

/** The ACCESS gateway-attributes interface, without the final path segment. Public, not a secret. */
export const ACCESS_ATTRIBUTES_BASE = "https://allocations-api.access-ci.org/acdb/gateway/v2";

/** UNVERIFIED: the header that carries the key. The design page does not name it; this is the one the ACCESS accounting interfaces use. */
export const ACCESS_KEY_HEADER = "XA-API-KEY";

/**
 * UNVERIFIED: the body's field names, as the design page and the phase issue spell them. The time is
 * written by {@link accessSubmitTime} (ISO 8601 in UTC with a `Z`), also unverified.
 */
export const ACCESS_BODY_FIELDS = {
  jobId: "jobid",
  submitTime: "submittime",
  resource: "xsederesourcename",
  gatewayUser: "gatewayuser",
  debug: "debug",
} as const;

// --- Limits ----------------------------------------------------------------------------------------

/** How many times a report is claimed before a refusal ends it `failed`. */
export const ACCESS_REPORT_MAX_ATTEMPTS = 8;

/** How long a sender may hold a row: far longer than one POST, so an expired lease is a dead sender. */
export const ACCESS_REPORT_LEASE_MINUTES = 10;

/** The longest a POST may take, answer included. */
export const ACCESS_REPORT_TIMEOUT_MS = 15_000;

/** Rows a tick sends at most. */
export const ACCESS_REPORT_ROWS_PER_TICK = 10;

/**
 * How long a tick keeps CLAIMING new rows, from its start. Ten POSTs of up to fifteen seconds each, one
 * after the other, could run for minutes; a Worker killed mid-tick leaves its claimed row `attempting`,
 * and that row is reaped as `outcome_unknown` (lost, never doubled). So after about twenty seconds (one
 * POST's fifteen and a margin) the tick takes no new row and returns: the rows it did not claim are
 * still `pending` and wait for the next tick.
 */
export const ACCESS_REPORT_TICK_BUDGET_MS = 20_000;

/**
 * A row that has used this many attempts with a retry class (`refused`, `busy`, `unavailable`) is a
 * PERSISTENT refusal (a key ACCESS refuses, a wrong address): at the doubling delays the eighth attempt
 * is about 79 hours away, so from the third attempt on every tick logs an error-level line.
 */
export const ACCESS_REPORT_PERSISTENT_ATTEMPTS = 3;

/** The first delay after a refusal, and the longest, in minutes. */
const RETRY_FIRST_MINUTES = 60;
const RETRY_LONGEST_MINUTES = 24 * 60;

/** How long a row that cannot be sent yet (no submission time) waits before it is looked at again. */
const DEFER_MINUTES = 60;

/**
 * How long, from the first sight of the Slurm id, a record may go without the scheduler's submission time
 * before the row ends `failed` (`no_submit_time`) for a person to look at: a terminal job is never read
 * from Tapis again, so a time that is not there by now will not come, and the row would otherwise come
 * back into the ten-row window every hour for ever.
 */
export const ACCESS_SUBMIT_TIME_WAIT_DAYS = 7;

/** The delay after the `attempts`-th claim was refused: an hour doubled each time, a day at most. Pure. */
export function accessRetryDelayMinutes(attempts: number): number {
  if (!Number.isFinite(attempts) || attempts < 1) return RETRY_FIRST_MINUTES;
  return Math.min(RETRY_FIRST_MINUTES * 2 ** (Math.floor(attempts) - 1), RETRY_LONGEST_MINUTES);
}

// --- Statements ------------------------------------------------------------------------------------

/**
 * The report a job owes, made when its row shows a Slurm id. `?1` the job. Run in the batch of the
 * transition that wrote the id (`LIVE_TRANSITION_SQL` and `TERMINAL_TRANSITION_SQL`), after it. The
 * statement reads the JOB ROW and not the record the caller holds, so it makes a row only for a job
 * that has an id NOW, and `OR IGNORE` is what makes a replayed read (the same record again, the next
 * live state, a repair of a terminal row) add nothing and leave a row that has moved on (`attempting`,
 * `sent`, `failed`) exactly as it is. A plain `INSERT` here would throw on the primary key at the
 * second read and roll the transition back with it. Only an `accounting = 'su'` job owes a report: a runner job
 * is not on the allocation, so a Slurm id it may carry never makes one (ADR 0121 decision 1).
 */
export const ACCESS_REPORT_PENDING_SQL = `INSERT OR IGNORE INTO compute_access_reports (job_id)
  SELECT id FROM compute_jobs WHERE id = ?1 AND slurm_job_id IS NOT NULL AND accounting = 'su'`;

/** The pending rows that are due, soonest first (the partial index `compute_access_reports_due` serves it). `?1` the limit. */
export const ACCESS_REPORT_DUE_SQL = `SELECT job_id FROM compute_access_reports
  WHERE state = 'pending' AND next_attempt_at <= datetime('now')
  ORDER BY next_attempt_at ASC LIMIT ?1`;

/** One report with what the body is made of, from the job row. `?1` the job. */
export const ACCESS_REPORT_ROW_SQL = `SELECT r.state AS state, r.attempts AS attempts,
    CASE WHEN r.next_attempt_at <= datetime('now') THEN 1 ELSE 0 END AS due,
    CASE WHEN r.created_at < datetime('now', '-${ACCESS_SUBMIT_TIME_WAIT_DAYS} days') THEN 1 ELSE 0 END
      AS overdue,
    j.slurm_job_id AS slurm_job_id, j.remote_submitted_at AS remote_submitted_at,
    j.gateway_user AS gateway_user
  FROM compute_access_reports r JOIN compute_jobs j ON j.id = r.job_id
  WHERE r.job_id = ?1`;

/**
 * THE CLAIM: `pending` to `attempting`, the attempt counted, the lease stamped. `?1` the job, `?2` the
 * sender's lease stamp (its own time, to the millisecond, which is also how it knows the lease is its
 * own). One conditional UPDATE: only the sender that changes the row goes on to the POST.
 */
export const ACCESS_REPORT_CLAIM_SQL = `UPDATE compute_access_reports SET
    state = 'attempting', claimed_at = ?2, attempts = attempts + 1
  WHERE job_id = ?1 AND state = 'pending' AND next_attempt_at <= datetime('now')`;

/** ACCESS accepted it. `?1` the job, `?2` the stamp the sender claimed with: only a lease still that sender's is written. */
export const ACCESS_REPORT_SENT_SQL = `UPDATE compute_access_reports SET
    state = 'sent', sent_at = datetime('now'), claimed_at = NULL, last_error_code = NULL
  WHERE job_id = ?1 AND state = 'attempting' AND claimed_at = ?2`;

/**
 * ACCESS answered that it did not process the request: back to `pending` after a delay, or `failed` when this was the
 * last attempt. `?1` the job, `?2` the stamp, `?3` the error word, `?4` the delay as a SQLite modifier
 * (`+60 minutes`), `?5` the most attempts.
 */
export const ACCESS_REPORT_RETRY_SQL = `UPDATE compute_access_reports SET
    state = CASE WHEN attempts >= ?5 THEN 'failed' ELSE 'pending' END,
    claimed_at = NULL, last_error_code = ?3,
    next_attempt_at = CASE WHEN attempts >= ?5 THEN next_attempt_at ELSE datetime('now', ?4) END
  WHERE job_id = ?1 AND state = 'attempting' AND claimed_at = ?2`;

/** The outcome cannot be judged: `failed`, and never sent again by code. `?1` the job, `?2` the stamp, `?3` the error word. */
export const ACCESS_REPORT_UNKNOWN_SQL = `UPDATE compute_access_reports SET
    state = 'failed', claimed_at = NULL, last_error_code = ?3
  WHERE job_id = ?1 AND state = 'attempting' AND claimed_at = ?2`;

/** A sender that held its lease past it is dead; whether its POST left is not known. */
export const ACCESS_REPORT_REAP_SQL = `UPDATE compute_access_reports SET
    state = 'failed', claimed_at = NULL, last_error_code = 'outcome_unknown'
  WHERE state = 'attempting' AND claimed_at < datetime('now', '-${ACCESS_REPORT_LEASE_MINUTES} minutes')`;

/** A row that cannot be sent for want of a pseudonym is `failed` at once: nothing was sent. `?1` the job. */
export const ACCESS_REPORT_NO_USER_SQL = `UPDATE compute_access_reports SET
    state = 'failed', last_error_code = 'no_gateway_user'
  WHERE job_id = ?1 AND state = 'pending'`;

/** A row whose record has no submission time yet waits an hour, and costs no attempt. `?1` the job. */
export const ACCESS_REPORT_DEFER_SQL = `UPDATE compute_access_reports SET
    last_error_code = 'no_submit_time', next_attempt_at = datetime('now', '+${DEFER_MINUTES} minutes')
  WHERE job_id = ?1 AND state = 'pending'`;

/** The wait for the submission time is over: `failed`, so a person is told. Nothing was sent. `?1` the job. */
export const ACCESS_REPORT_NO_TIME_FAIL_SQL = `UPDATE compute_access_reports SET
    state = 'failed', last_error_code = 'no_submit_time'
  WHERE job_id = ?1 AND state = 'pending'`;

/**
 * How many pending rows have been refused (a retry class) at least `?1` times: what the tick's error-level
 * line counts, whether or not any row is due. Only the pending rows are read (the partial index).
 */
export const ACCESS_REPORT_PERSISTENT_SQL = `SELECT COUNT(*) AS n FROM compute_access_reports
  WHERE state = 'pending' AND attempts >= ?1
    AND last_error_code IN ('refused', 'busy', 'unavailable')`;

/** With no key or no resource name every due row says so, and nothing else changes. */
export const ACCESS_REPORT_UNCONFIGURED_SQL = `UPDATE compute_access_reports SET
    last_error_code = 'unconfigured'
  WHERE state = 'pending' AND next_attempt_at <= datetime('now')
    AND last_error_code IS NOT 'unconfigured'`;

// --- Small helpers ---------------------------------------------------------------------------------

const present = (value: string | undefined): value is string =>
  typeof value === "string" && value.trim() !== "";

/** The address reports are POSTed to: the test override `globalThis.NEMAR_ACCESS_ATTRIBUTES_URL`, else ACCESS's. */
export function accessAttributesUrl(): string {
  const override = (globalThis as { NEMAR_ACCESS_ATTRIBUTES_URL?: string })
    .NEMAR_ACCESS_ATTRIBUTES_URL;
  const base = present(override) ? override.trim() : ACCESS_ATTRIBUTES_BASE;
  return `${base.replace(/\/+$/, "")}/job_attributes`;
}

/** The key and the resource name, or null when either is not set (a blank value is not set). */
export function accessReportConfig(
  env: Pick<Bindings, "ACCESS_GATEWAY_ATTRIBUTES_KEY" | "ACCESS_RESOURCE_NAME">,
): { key: string; resource: string } | null {
  const key = env.ACCESS_GATEWAY_ATTRIBUTES_KEY;
  const resource = env.ACCESS_RESOURCE_NAME;
  if (!present(key) || !present(resource)) return null;
  return { key: key.trim(), resource: resource.trim() };
}

/**
 * The only users ACCESS is ever told of: the stored pseudonym (`gw_` and 20 base32 characters) or the
 * pipelines' literal. Anything else (a name, an email, an ORCID iD, a subject) is not reportable, and the
 * table's own CHECK says the same of the column. Pure.
 */
export function reportableGatewayUser(value: unknown): value is string {
  return typeof value === "string" && /^(gw_[a-z2-7]{20}|nemar-pipelines)$/.test(value);
}

/** The scheduler's submission time as ACCESS is sent it (UNVERIFIED format): ISO 8601 in UTC with a `Z`; null when there is none. */
export function accessSubmitTime(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(value);
  return m ? `${m[1]}T${m[2]}Z` : null;
}

/** A lease stamp: a UTC time as the row writes its own, with milliseconds (`YYYY-MM-DD HH:MM:SS.mmm`). */
function leaseStamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace("T", " ").replace("Z", "");
}

const errorClassName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/**
 * What an answer means, in one place. `null` is NO ANSWER: the outcome is unknown. A 2xx is accepted. A
 * retry is only an answer that shows the request was NOT processed: 408 and 429 are `busy`, 503 is
 * `unavailable`, and a 4xx other than 409 is `refused`. EVERYTHING ELSE is unknown and is never resent: a
 * 500, 502 or 504 (a gateway in front of a server that already stored the request, a server that failed
 * after the write), every 3xx (303 is the usual reply to a POST that created something; a redirect is
 * never followed), 409 (which may mean "already recorded") and any other status. If ACCESS is found to
 * keep one record per job id and resource, so that a duplicate is ignored, the unknown cases become
 * retries here and nowhere else.
 */
export function classifyAnswer(
  status: number | null,
): { kind: "sent" } | { kind: "unknown" } | { kind: "retry"; word: ComputeAccessReportError } {
  if (status === null) return { kind: "unknown" };
  if (status >= 200 && status < 300) return { kind: "sent" };
  if (status === 408 || status === 429) return { kind: "retry", word: "busy" };
  if (status === 503) return { kind: "retry", word: "unavailable" };
  if (status >= 400 && status < 500 && status !== 409) return { kind: "retry", word: "refused" };
  return { kind: "unknown" };
}

/**
 * A throw that proves NOTHING LEFT the Worker: the runtime refused the call before it was made (the
 * subrequest limit of one invocation). It is recognized by the runtime's own message, because the runtime
 * gives no code or class for it; the list is closed on purpose. A timeout, a reset, a refused or lost
 * connection and every other throw are NOT in it: a runtime cannot tell those from a reset after the request
 * left, so they stay unknown and are never resent (ADR 0118, review fixes of 2026-11-06). Guessing wider
 * would send a report twice, which ACCESS is not known to ignore.
 */
export function throwedBeforeSend(err: unknown): boolean {
  return err instanceof Error && /too many subrequests|subrequest limit/i.test(err.message);
}

/**
 * One POST: the status of the answer; null when none came (a timeout, a lost or refused connection: the
 * request may have left); `"not_sent"` when the runtime refused the call before it was made. The body is
 * discarded unread.
 */
async function post(
  url: string,
  key: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<number | null | "not_sent"> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", [ACCESS_KEY_HEADER]: key },
      body: JSON.stringify(body),
      // The key travels in a header that a runtime would not remove at a redirect to another origin.
      redirect: "manual",
      signal,
    });
    await res.body?.cancel().catch(() => {});
    return res.status;
  } catch (err) {
    return throwedBeforeSend(err) ? "not_sent" : null;
  }
}

// --- One report ------------------------------------------------------------------------------------

/**
 * What `sendAccessReport` did for one job: `sent`; `retry` (refused, pending again, delayed); `not_sent` (the
 * runtime refused the call before it was made: pending again like `retry`, and the tick stops claiming); `failed` (the
 * attempts ran out, or the job has no pseudonym); `outcome_unknown` (no answer: failed, never sent again by
 * code); `unconfigured` and `no_submit_time` (waiting, no attempt spent; the latter for a week at most, and then `failed`); and the ones that sent nothing
 * because the row was not this sender's to send: `not_found`, `not_pending` (sent, failed or claimed
 * already), `not_due`, `claim_lost` (another sender won the claim) and `lease_lost` (this sender's lease was
 * reaped while its POST was in flight: the row keeps what the reaper wrote).
 */
export type AccessSendOutcome =
  | "sent"
  | "retry"
  | "not_sent"
  | "failed"
  | "outcome_unknown"
  | "unconfigured"
  | "no_submit_time"
  | "no_gateway_user"
  | "not_found"
  | "not_pending"
  | "not_due"
  | "claim_lost"
  | "lease_lost";

interface ReportJoin {
  state: string;
  attempts: number;
  due: number;
  overdue: number;
  slurm_job_id: string | null;
  remote_submitted_at: string | null;
  gateway_user: string | null;
}

/**
 * Report one job to ACCESS: claim its row, POST, record the outcome (see the header for the guarantee).
 * Never runs a batch and never throws for what ACCESS does. Not production-fenced: it is the unit a test
 * drives outside production (where the body carries `debug`); the only caller in the Worker is
 * `runAccessReportCron`, which is.
 */
export async function sendAccessReport(
  env: Bindings,
  jobId: string,
  options: { timeoutMs?: number; nowMs?: number } = {},
): Promise<AccessSendOutcome> {
  const db = env.DB;
  const config = accessReportConfig(env);
  if (config === null) {
    await db.prepare(ACCESS_REPORT_UNCONFIGURED_SQL).run();
    return "unconfigured";
  }
  const row = await db.prepare(ACCESS_REPORT_ROW_SQL).bind(jobId).first<ReportJoin>();
  if (!row) return "not_found";
  if (row.state !== "pending") return "not_pending";
  if (row.due !== 1) return "not_due";
  if (!reportableGatewayUser(row.gateway_user)) {
    await db.prepare(ACCESS_REPORT_NO_USER_SQL).bind(jobId).run();
    return "no_gateway_user";
  }
  const submitTime = accessSubmitTime(row.remote_submitted_at);
  if (submitTime === null || row.slurm_job_id === null) {
    // It waits for the time, an hour at a time, and costs no attempt; after a week it ends `failed`.
    if (row.overdue === 1) {
      await db.prepare(ACCESS_REPORT_NO_TIME_FAIL_SQL).bind(jobId).run();
      return "failed";
    }
    await db.prepare(ACCESS_REPORT_DEFER_SQL).bind(jobId).run();
    return "no_submit_time";
  }

  // THE CLAIM. Nothing below runs unless this one statement changed the row.
  const stamp = leaseStamp(options.nowMs ?? Date.now());
  const claimed = await db.prepare(ACCESS_REPORT_CLAIM_SQL).bind(jobId, stamp).run();
  if ((claimed.meta?.changes ?? 0) !== 1) return "claim_lost";
  const attempts = row.attempts + 1;

  const body: Record<string, unknown> = {
    [ACCESS_BODY_FIELDS.jobId]: row.slurm_job_id,
    [ACCESS_BODY_FIELDS.submitTime]: submitTime,
    [ACCESS_BODY_FIELDS.resource]: config.resource,
    [ACCESS_BODY_FIELDS.gatewayUser]: row.gateway_user,
    ...(isExactProduction(env) ? {} : { [ACCESS_BODY_FIELDS.debug]: true }),
  };
  const timeout = Math.min(
    Number.isFinite(options.timeoutMs) && (options.timeoutMs as number) > 0
      ? Math.floor(options.timeoutMs as number)
      : ACCESS_REPORT_TIMEOUT_MS,
    ACCESS_REPORT_TIMEOUT_MS,
  );
  // THE POST: between two statements, never inside a batch.
  const posted = await post(accessAttributesUrl(), config.key, body, timeout);
  // Nothing left the Worker (the invocation's subrequest limit): the report is simply not sent yet, so it
  // goes back to pending through the ordinary retry (an attempt is spent and the delay applies; the bound
  // still ends it). It is NOT `outcome_unknown`, which code never resends.
  const answer: ReturnType<typeof classifyAnswer> =
    posted === "not_sent" ? { kind: "retry", word: "unavailable" } : classifyAnswer(posted);

  if (answer.kind === "sent") {
    const wrote = await db.prepare(ACCESS_REPORT_SENT_SQL).bind(jobId, stamp).run();
    return (wrote.meta?.changes ?? 0) === 1 ? "sent" : "lease_lost";
  }
  if (answer.kind === "unknown") {
    const wrote = await db
      .prepare(ACCESS_REPORT_UNKNOWN_SQL)
      .bind(jobId, stamp, "outcome_unknown" satisfies ComputeAccessReportError)
      .run();
    return (wrote.meta?.changes ?? 0) === 1 ? "outcome_unknown" : "lease_lost";
  }
  const wrote = await db
    .prepare(ACCESS_REPORT_RETRY_SQL)
    .bind(
      jobId,
      stamp,
      answer.word,
      `+${accessRetryDelayMinutes(attempts)} minutes`,
      ACCESS_REPORT_MAX_ATTEMPTS,
    )
    .run();
  if ((wrote.meta?.changes ?? 0) !== 1) return "lease_lost";
  if (attempts >= ACCESS_REPORT_MAX_ATTEMPTS) return "failed";
  return posted === "not_sent" ? "not_sent" : "retry";
}

// --- The tick --------------------------------------------------------------------------------------

export interface AccessReportTick {
  /** Due rows taken. */
  examined: number;
  sent: number;
  /** Refused and pending again. */
  retry: number;
  /** Ended `failed` (the attempts ran out, or no pseudonym). */
  failed: number;
  /** No answer: ended `failed`, `outcome_unknown`, never sent again by code. */
  unknown: number;
  /** Rows left waiting because the key or the resource name is not set. */
  unconfigured: number;
  /** Rows left waiting for the scheduler's submission time. */
  deferred: number;
  /** Rows whose sender died holding its lease, ended `failed`, `outcome_unknown`. */
  reaped: number;
  /** Pending rows refused (a retry class) at least `ACCESS_REPORT_PERSISTENT_ATTEMPTS` times, counted whether or not any is due. */
  persistent: number;
  /** Due rows this tick did not claim (its time budget was spent, or an outcome it could not judge stopped it): they wait for the next tick. */
  skipped: number;
  /** Fixed words; never a message. */
  errors: string[];
  errorClass: string | null;
}

const emptyTick = (): AccessReportTick => ({
  examined: 0,
  sent: 0,
  retry: 0,
  failed: 0,
  unknown: 0,
  unconfigured: 0,
  deferred: 0,
  reaped: 0,
  skipped: 0,
  persistent: 0,
  errors: [],
  errorClass: null,
});

/**
 * One tick: the rows whose sender died are ended (`outcome_unknown`), then up to ten due rows are sent,
 * oldest first, each in its own try and catch that records only a fixed word and the error's class.
 * Null outside exact production, before anything is read or written. It reads the database first and
 * touches nothing else when no row is due. With no key or resource name set it sends nothing and says
 * `unconfigured` on the due rows. It reads no switch: the reports are owed for jobs that already ran.
 * It stops claiming new rows after `ACCESS_REPORT_TICK_BUDGET_MS`, so a run that is killed does not
 * strand a claimed row, and after the first unjudgeable outcome (`outcome_unknown`), so a systematic
 * fault loses one report a tick and not ten; the rest wait for the next tick. `now` is the clock, for a test.
 */
export async function runAccessReportCron(
  env: Bindings,
  options: { timeoutMs?: number; now?: () => number } = {},
): Promise<AccessReportTick | null> {
  if (!isExactProduction(env)) return null;
  const r = emptyTick();
  await runAccessReportTick(env, options, r);
  // A persistent refusal is counted at the END of every tick, due rows or none, so it is never silent.
  try {
    r.persistent =
      (
        await env.DB.prepare(ACCESS_REPORT_PERSISTENT_SQL)
          .bind(ACCESS_REPORT_PERSISTENT_ATTEMPTS)
          .first<{ n: number }>()
      )?.n ?? 0;
  } catch (err) {
    r.errors.push("count_failed");
    r.errorClass = errorClassName(err);
  }
  return r;
}

async function runAccessReportTick(
  env: Bindings,
  options: { timeoutMs?: number; now?: () => number },
  r: AccessReportTick,
): Promise<void> {
  const clock = options.now ?? Date.now;
  const started = clock();
  try {
    r.reaped = (await env.DB.prepare(ACCESS_REPORT_REAP_SQL).run()).meta?.changes ?? 0;
    const due = (
      await env.DB.prepare(ACCESS_REPORT_DUE_SQL)
        .bind(ACCESS_REPORT_ROWS_PER_TICK)
        .all<{ job_id: string }>()
    ).results;
    r.examined = due.length;
    if (due.length === 0) return;
    if (accessReportConfig(env) === null) {
      await env.DB.prepare(ACCESS_REPORT_UNCONFIGURED_SQL).run();
      r.unconfigured = due.length;
      return;
    }
    for (const [index, { job_id }] of due.entries()) {
      // THE TIME BUDGET: no new row is claimed once it is spent (see ACCESS_REPORT_TICK_BUDGET_MS).
      if (clock() - started >= ACCESS_REPORT_TICK_BUDGET_MS) {
        r.skipped = due.length - index;
        break;
      }
      try {
        const outcome = await sendAccessReport(
          env,
          job_id,
          options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
        );
        if (outcome === "sent") r.sent++;
        else if (outcome === "retry" || outcome === "not_sent") r.retry++;
        else if (outcome === "failed" || outcome === "no_gateway_user") r.failed++;
        else if (outcome === "outcome_unknown") r.unknown++;
        else if (outcome === "no_submit_time") r.deferred++;
        // THE FIRST UNJUDGEABLE OUTCOME ENDS THE CLAIMING: a deploy's 502, a 500, a redirect from a wrong
        // address or a timeout may be the first sign of a fault that every later row would meet the same
        // way, and each such row is lost for good. So one report is lost, not ten; the rows not claimed
        // stay `pending` with no attempt spent for the next tick, and the error-level log line (an
        // unknown outcome needs a person) has a margin of thirty minutes to be noticed in. An answer that
        // proves the request was not processed (a retry) does not stop the tick.
        // A call the runtime refused before it was made (the invocation's subrequest limit) ends the claiming
        // too: every later row would meet the same limit and spend an attempt for nothing.
        if (outcome === "outcome_unknown" || outcome === "not_sent") {
          r.skipped = due.length - index - 1;
          break;
        }
      } catch (err) {
        r.errors.push("row_failed");
        r.errorClass = errorClassName(err);
        console.error(`[access-report] job ${job_id}: its report failed (${r.errorClass})`);
      }
    }
  } catch (err) {
    r.errors.push("tick_failed");
    r.errorClass = errorClassName(err);
  }
}

/**
 * The tick's one log line, or null when it changed nothing and nothing failed. A tick that found rows
 * waiting for the key or the resource name is NOT silent (`unconfigured`): the same rows waiting for a
 * retry say nothing, but rows that wait for the owner must. Counts and fixed words only: no key,
 * address, Slurm id or pseudonym. Error level when a row needs a person (it ended `failed`, it waits for
 * the key or the resource name, or a refusal persists: a row has used `ACCESS_REPORT_PERSISTENT_ATTEMPTS`
 * attempts with a retry class, which a key ACCESS refuses or a wrong address does for about 79 hours
 * before the row fails) or anything threw.
 */
export function accessReportsLogLine(
  r: AccessReportTick,
): { level: "info" | "error"; line: string } | null {
  // A row waiting for the key or the resource name needs a person too, and says so on EVERY tick:
  // silence while there is work to do is evidence of nothing (ADR 0053, 0054).
  const needsPerson =
    r.failed + r.unknown + r.reaped + r.unconfigured + r.persistent > 0 || r.errors.length > 0;
  const acted = r.sent + r.retry + r.deferred + r.skipped;
  if (!needsPerson && acted === 0) return null;
  const line = [
    "[access-report]",
    `examined=${r.examined}`,
    `sent=${r.sent}`,
    `retry=${r.retry}`,
    `failed=${r.failed}`,
    `unknown=${r.unknown}`,
    `unconfigured=${r.unconfigured}`,
    `deferred=${r.deferred}`,
    `reaped=${r.reaped}`,
    `skipped=${r.skipped}`,
    `persistent=${r.persistent}`,
    `errors=${r.errors.length > 0 ? r.errors.join(",") : "none"}`,
    r.errorClass === null ? "" : `class=${r.errorClass}`,
  ]
    .filter((part) => part !== "")
    .join(" ");
  return { level: needsPerson ? "error" : "info", line };
}
