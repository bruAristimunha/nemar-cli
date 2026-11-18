/**
 * The compute gateway's 30-minute tick (epic #2005 phase A5, #2010; ADR 0118): every 30 minutes, in
 * production only, take each live job one step on, retry what is owed to a finished one, and retry the
 * Tapis cancellations that people asked for.
 *
 *   `runComputeAdvanceCron`        the backstop for the webhook hints. For each live row it reads the
 *                                  job back from Tapis and applies it (`advanceComputeJob`), which
 *                                  submits a `created` job, follows a submitted one, marks one whose
 *                                  last good read is more than a day old `unreported`, and repairs a
 *                                  terminal row whose settlement or copy of its files is owed. It also
 *                                  clears the webhook nonce one day after a job is terminal, so the
 *                                  address a token in a URL belongs to stops working.
 *   `sweepComputeCancellations`    every live row with a recorded cancel is cancelled at Tapis, again
 *                                  and again until Tapis says it is over (a network call never runs
 *                                  inside a batch, so the batch records the intent and this retries).
 *
 * PRODUCTION ONLY, twice over: both are called only from the 30-minute tick's production block of
 * `scheduled()` and are absent from `DEV_CRON_ALLOWLIST`, and each refuses outside exact production by
 * itself (the dev database shares real users and the GitHub org, and development advances a job by its
 * webhook, by a read and by an administrator's command). Neither reads a switch, so a job that is
 * live is never stranded by turning compute off; the switch is read only where a job is submitted.
 * A database read of the live rows comes first: a Worker with no Tapis configuration and no jobs does
 * nothing at all.
 *
 * TEN ROWS A TICK in each of four lists (the live rows Tapis has accepted, the `created` rows still to
 * be submitted, the terminal rows owed a settlement, and those owed a copy of their files), each in
 * its own try and catch that records only a fixed word and the error's class, and one log line a tick
 * (counts and fixed words: no job output, token, name or path).
 *
 * THE ROTATION IS BY EXAMINATION, NOT BY SUCCESS. The two live lists are ordered by `examined_at`
 * (never-examined first), and every row a tick takes is stamped BEFORE its step runs, so a row that
 * cannot make progress (a job Tapis cannot be read for, a `created` job that cannot be submitted while
 * compute is off) goes to the back of the line like any other and never holds a slot for good. Ordered
 * by the last good read (`tapis_synced_at`), as the first version was, such rows kept the ten slots
 * and a healthy running job was never read. The two live lists do not share their quota, for the same
 * reason the terminal lists do not: no kind of row can starve another.
 *
 * COST, counted as subrequests (every fetch and, assumed, every D1 and R2 binding call; whether a binding
 * call counts toward the allowance is UNVERIFIED, so it is counted as if it does). A live row is one
 * Tapis read, at most two attempts of at most ten seconds each (`TICK_READ`), and a few database
 * statements: about 6, or up to about 25 for the row whose read says FINISHED, which is VERIFIED
 * before it may stand: three launcher documents, the recorded specification, the outputs listed once
 * per 1,000 declared (up to five pages at the default `maxFiles` of 5,000) and the launcher's files
 * listed once. A `created` row adds a tag search and at most one submit: about 12. A terminal row
 * owed a settlement is verified the same way (about 25); one owed a copy of its files writes at most
 * five objects, reads as many and downloads one log (two attempts at most): about 15. The worst tick
 * is ten rows of each list at its worst, about 800, against the 1,000 a paid Worker invocation may
 * make, and that allowance is shared with the rest of the 30-minute block: which is why each list is
 * capped at ten and the lists do not share a quota. A request's own reads are one attempt of at most
 * eight seconds (`REQUEST_READ`).
 */

import type { Bindings } from "../types/bindings.js";
import { LIVE_STATES_SQL } from "./compute-jobs.js";
import {
  type AdvanceResult,
  CLEAR_NONCES_SQL,
  COPY_ABANDONED_RECENT_SQL,
  MARK_COPY_ABANDONED_SQL,
  STAMP_CANCEL_ATTEMPT_SQL,
  STAMP_EXAMINED_SQL,
  TICK_READ,
  UNCOPIED_TERMINAL_SQL,
  UNSETTLED_TERMINAL_SQL,
  advanceComputeJob,
  countCancelPendingFailed,
  driveCancel,
  errorClassName,
  retryOrphanCancel,
} from "./compute-lifecycle.js";
import { isExactProduction } from "./repull-switches.js";

/** Rows of each list one tick examines at most. */
export const ADVANCE_ROWS_PER_TICK = 10;

/**
 * The live rows Tapis has accepted (a `tapis_uuid`), least recently EXAMINED first (a row never
 * examined comes first: SQLite sorts NULL before every value): NEMAR's own jobs, and a partner's once
 * Tapis has accepted it. The ORDER BY names the bare column so that the partial index
 * `compute_jobs_examined` (live rows only, by `examined_at`) serves it; with `COALESCE(examined_at, '')`
 * in its place the planner could not use the index and walked every row that ever had a Tapis job
 * (`compute-lifecycle-submit.test.ts` pins the plan).
 */
export const BOUND_ROWS_SQL = `SELECT id FROM compute_jobs
  WHERE state IN (${LIVE_STATES_SQL}) AND tapis_uuid IS NOT NULL AND flag_unreserved = 0
  ORDER BY examined_at ASC, created_at ASC LIMIT ?1`;

/**
 * The `created` and `uploading` rows with no Tapis job, least recently examined first: the ones to be
 * submitted. A partner's reservation that has no Tapis job yet is the partner contract's, not this
 * tick's.
 */
export const CREATED_ROWS_SQL = `SELECT id FROM compute_jobs
  WHERE state IN ('created', 'uploading') AND tapis_uuid IS NULL AND source <> 'partner'
    AND executor = 'tapis'
  ORDER BY examined_at ASC, created_at ASC LIMIT ?1`;

/**
 * Rows with a Tapis job NEMAR made that no row owns, whose cancel is still owed, in rotation. A row that
 * has ended is never stamped by the live lists, so its `examined_at` would never move and ten orphans that
 * cannot be cancelled would sit at the head for ever: the sweep stamps each row it takes BEFORE its retry
 * (phase A7, #2012), so the order is by the last time this list took the row.
 */
export const ORPHAN_ROWS_SQL = `SELECT id FROM compute_jobs
  WHERE orphan_tapis_uuid IS NOT NULL ORDER BY examined_at ASC, created_at ASC LIMIT ?1`;

/**
 * Live rows with a cancel recorded, in rotation by the last time THIS sweep took the row (never taken
 * first, then the oldest request). A partner's reservation with no Tapis job yet is the partner
 * contract's and `driveCancel` leaves it alone, so it is not listed either: it would hold one of the ten
 * slots for ever (the same exclusion as `CREATED_ROWS_SQL`). A job that skipped the reservation is the
 * tenant sweep's. The first version took the ten oldest requests every tick, so ten cancels that could
 * not complete blocked every newer one, and the revocation cascade adds many intents at once: each row
 * taken is stamped (`cancel_attempted_at`) before its cancel is driven, and goes to the back (phase A7,
 * #2012). The partial index `compute_jobs_cancelling` serves it.
 */
export const CANCEL_ROWS_SQL = `SELECT id FROM compute_jobs
  WHERE state IN (${LIVE_STATES_SQL}) AND cancel_requested_at IS NOT NULL
    AND flag_unreserved = 0 AND executor = 'tapis'
    AND NOT (source = 'partner' AND tapis_uuid IS NULL)
  ORDER BY cancel_attempted_at ASC, cancel_requested_at ASC LIMIT ?1`;

export interface ComputeTickResult {
  /** Live rows examined: the bound ones and the `created` ones. */
  examined: number;
  submitted: number;
  /** Rows that moved, were refreshed or ended. */
  advanced: number;
  /** Rows whose submit is waiting on something (a configuration, an upload, Tapis). */
  waiting: number;
  /** Rows Tapis could not be read for. */
  unreachable: number;
  /** Rows whose Tapis status is a word NEMAR does not know: nothing is refreshed, and the row goes `unreported` after a day. */
  unknown_status: number;
  /** Terminal rows whose owed settlement and copy are now both done. */
  repaired: number;
  /** Terminal rows a repair was attempted for and something is still owed (the next tick tries again). */
  repair_attempted: number;
  /** Webhook nonces cleared. */
  cleared: number;
  /**
   * Terminal rows past the days their copy of the launcher files is retried and still uncopied, whose
   * window closed within the last 30 days, flagged or not (`countCopyAbandoned` is the running total).
   * Error level, on every tick while any exists.
   */
  copy_abandoned: number;
  /** Fixed words; never a message. */
  errors: string[];
  errorClass: string | null;
}

const emptyResult = (): ComputeTickResult => ({
  examined: 0,
  submitted: 0,
  advanced: 0,
  waiting: 0,
  unreachable: 0,
  unknown_status: 0,
  repaired: 0,
  repair_attempted: 0,
  cleared: 0,
  copy_abandoned: 0,
  errors: [],
  errorClass: null,
});

function tally(r: ComputeTickResult, answer: AdvanceResult): void {
  switch (answer.outcome) {
    case "submitted":
      r.submitted++;
      break;
    case "waiting":
      r.waiting++;
      break;
    case "unreachable":
      r.unreachable++;
      break;
    case "unknown_status":
      r.unknown_status++;
      break;
    case "terminal":
      // Only what a repair really finished is a repair; an attempt that left something owed is counted apart.
      if (answer.repair === "finished") r.repaired++;
      else if (answer.repair === "incomplete") r.repair_attempted++;
      break;
    case "advanced":
    case "refreshed":
    case "terminal_committed":
      r.advanced++;
      break;
    default:
      break;
  }
}

/**
 * One tick of the backstop. Null outside exact production, before anything is read or written. In
 * production it reads the live rows first and returns at once, having touched neither Tapis nor a
 * bucket, when there is nothing to do.
 */
export async function runComputeAdvanceCron(env: Bindings): Promise<ComputeTickResult | null> {
  if (!isExactProduction(env)) return null;
  const r = emptyResult();
  try {
    const bound = (
      await env.DB.prepare(BOUND_ROWS_SQL).bind(ADVANCE_ROWS_PER_TICK).all<{ id: string }>()
    ).results;
    const created = (
      await env.DB.prepare(CREATED_ROWS_SQL).bind(ADVANCE_ROWS_PER_TICK).all<{ id: string }>()
    ).results;
    const unsettled = (
      await env.DB.prepare(UNSETTLED_TERMINAL_SQL).bind(ADVANCE_ROWS_PER_TICK).all<{ id: string }>()
    ).results;
    const uncopied = (
      await env.DB.prepare(UNCOPIED_TERMINAL_SQL).bind(ADVANCE_ROWS_PER_TICK).all<{ id: string }>()
    ).results;
    const cleared = await env.DB.prepare(CLEAR_NONCES_SQL).run();
    r.cleared = cleared.meta?.changes ?? 0;
    await env.DB.prepare(MARK_COPY_ABANDONED_SQL).run();
    r.copy_abandoned =
      (await env.DB.prepare(COPY_ABANDONED_RECENT_SQL).first<{ n: number }>())?.n ?? 0;

    // Every row taken is stamped BEFORE its step: whatever the step does (a read that fails, a
    // submit that cannot go, an exception) the row has had its turn and goes to the back of the line.
    // That includes the two repair lists (phase A7, #2012): a settlement or a copy that fails on every
    // attempt no longer holds one of its ten slots, which the first version ordered by age.
    const live = [...bound, ...created];
    r.examined = live.length;
    const stamped = [...new Set([...live, ...unsettled, ...uncopied].map((row) => row.id))];
    if (stamped.length > 0) {
      await env.DB.batch(stamped.map((id) => env.DB.prepare(STAMP_EXAMINED_SQL).bind(id)));
    }
    const ids = [...new Set([...live, ...unsettled, ...uncopied].map((row) => row.id))];
    for (const id of ids) {
      try {
        const answer = await advanceComputeJob(env, id, { read: TICK_READ });
        tally(r, answer);
      } catch (err) {
        // The job by its id, the failure by its class: never its message.
        r.errors.push("row_failed");
        r.errorClass = errorClassName(err);
        console.error(`[compute-advance] job ${id}: its step failed (${r.errorClass})`);
      }
    }
  } catch (err) {
    r.errors.push("tick_failed");
    r.errorClass = errorClassName(err);
  }
  return r;
}

/** How loud a tick's line is: `warn` for a fault that mends itself or waits (Tapis unreachable, an unknown status, a repair that did not finish), `error` for one that needs a person. */
export type TickLogLevel = "info" | "warn" | "error";

/**
 * The tick's one log line, or null when it changed nothing and nothing is wrong, so a tick that found the
 * same jobs waiting says nothing. Counts and fixed words only: never a job id, a token or a message.
 *  - `error`: a row's step failed (`errors`), or a terminal row's copy was abandoned (`copy_abandoned`);
 *  - `warn`: Tapis could not be read for a row (`unreachable`), a status NEMAR does not know
 *    (`unknown_status`), or a repair that was tried and left something owed (`repair_attempted`). A tick
 *    where Tapis is unreachable for EVERY row used to log nothing at all;
 *  - `info`: the tick moved something (submitted, advanced, repaired, cleared a nonce).
 */
export function computeAdvanceLogLine(
  r: ComputeTickResult,
): { level: TickLogLevel; line: string } | null {
  const error = r.errors.length > 0 || r.copy_abandoned > 0;
  const warn = r.unreachable > 0 || r.unknown_status > 0 || r.repair_attempted > 0;
  const acted = r.submitted + r.advanced + r.repaired + r.cleared;
  if (!error && !warn && acted === 0) return null;
  const line = [
    "[compute-advance]",
    `examined=${r.examined}`,
    `submitted=${r.submitted}`,
    `advanced=${r.advanced}`,
    `waiting=${r.waiting}`,
    `unreachable=${r.unreachable}`,
    `unknown_status=${r.unknown_status}`,
    `repaired=${r.repaired}`,
    `repair_attempted=${r.repair_attempted}`,
    `nonces_cleared=${r.cleared}`,
    `copy_abandoned=${r.copy_abandoned}`,
    `errors=${r.errors.length > 0 ? r.errors.join(",") : "none"}`,
    r.errorClass === null ? "" : `class=${r.errorClass}`,
  ]
    .filter((part) => part !== "")
    .join(" ");
  return { level: error ? "error" : warn ? "warn" : "info", line };
}

export interface CancelSweepResult {
  /** Rows with a recorded cancel, and rows with an orphaned Tapis job, taken this tick. */
  examined: number;
  /**
   * Cancels this tick that Tapis did not take and that are not shown to have ended (a row's cancel, or an
   * orphan's): a COUNT, never a job id or an account. A tick where it is above 0 logs at error level.
   */
  cancel_failed: number;
  /** Live rows whose cancel is still not carried out an hour after it was asked for ({@link countCancelPendingFailed}). */
  cancel_pending_failed: number;
  errors: string[];
  errorClass: string | null;
}

/**
 * Carry out every recorded cancel as far as Tapis allows, ten rows a tick. A job that never reached
 * Tapis is ended and its hold released; one that did is cancelled at Tapis and read back, and becomes
 * `cancelled` when Tapis says so. Null outside exact production, before anything is read.
 */
export async function sweepComputeCancellations(env: Bindings): Promise<CancelSweepResult | null> {
  if (!isExactProduction(env)) return null;
  const r: CancelSweepResult = {
    examined: 0,
    cancel_failed: 0,
    cancel_pending_failed: 0,
    errors: [],
    errorClass: null,
  };
  try {
    const rows = (
      await env.DB.prepare(CANCEL_ROWS_SQL).bind(ADVANCE_ROWS_PER_TICK).all<{ id: string }>()
    ).results;
    r.examined = rows.length;
    for (const { id } of rows) {
      try {
        await env.DB.prepare(STAMP_CANCEL_ATTEMPT_SQL).bind(id).run();
        if ((await driveCancel(env, id, TICK_READ)) === "failed") r.cancel_failed++;
      } catch (err) {
        r.errors.push("row_failed");
        r.errorClass = errorClassName(err);
        console.error(`[compute-cancel] job ${id}: its cancel failed (${r.errorClass})`);
      }
    }
    // A Tapis job NEMAR made that no row owns, whose cancel failed when it was made: asked again.
    const orphans = (
      await env.DB.prepare(ORPHAN_ROWS_SQL).bind(ADVANCE_ROWS_PER_TICK).all<{ id: string }>()
    ).results;
    r.examined += orphans.length;
    for (const { id } of orphans) {
      try {
        await env.DB.prepare(STAMP_EXAMINED_SQL).bind(id).run();
        if ((await retryOrphanCancel(env, id, TICK_READ)) === "failed") r.cancel_failed++;
      } catch (err) {
        r.errors.push("orphan_failed");
        r.errorClass = errorClassName(err);
        console.error(`[compute-cancel] job ${id}: its orphan cancel failed (${r.errorClass})`);
      }
    }
    r.cancel_pending_failed = await countCancelPendingFailed(env.DB);
  } catch (err) {
    r.errors.push("sweep_failed");
    r.errorClass = errorClassName(err);
  }
  return r;
}

/**
 * The cancel sweep's one log line, or null when there was nothing to do and nothing failed. Error level
 * when a row failed or any cancel was not taken (a persistent failure shows every tick it persists).
 * Counts and fixed words only: never a job id, an account or a message.
 */
export function cancellationsLogLine(
  r: CancelSweepResult,
): { level: "info" | "error"; line: string } | null {
  if (
    r.examined === 0 &&
    r.errors.length === 0 &&
    r.cancel_failed === 0 &&
    r.cancel_pending_failed === 0
  )
    return null;
  const loud = r.errors.length > 0 || r.cancel_failed > 0 || r.cancel_pending_failed > 0;
  return {
    level: loud ? "error" : "info",
    line: `[compute-cancel] examined=${r.examined} cancel_failed=${r.cancel_failed} cancel_pending_failed=${r.cancel_pending_failed} errors=${r.errors.length > 0 ? r.errors.join(",") : "none"}${r.errorClass === null ? "" : ` class=${r.errorClass}`}`,
  };
}
