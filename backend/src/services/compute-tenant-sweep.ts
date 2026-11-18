/**
 * The tenant sweep (epic #2005 phase A7, #2012; ADR 0118; design section 6, "Jobs that skipped the
 * reservation"): NEMAR proves that every job in the Tapis tenant is accounted for.
 *
 *   `sweepTenantJobs(env, "live")`   every 30 minutes: the jobs in the tenant that have not ended
 *   `sweepTenantJobs(env, "week")`   once a day: every job of the last seven days, and the rest of the
 *                                    day's reconciliation (Expanse's own figures against the ledger, and
 *                                    the ACCESS reports a person has to look at)
 *
 * WHAT IT DOES TO A TAPIS JOB NO ROW OWNS, in order:
 *  1. a job bound by `tapis_uuid` to a row is NEMAR's own (a pipeline job, a person's job, a partner's
 *     bound reservation) and is left alone;
 *  2. a job tagged `nemar_job:<id>` for a row that exists is NEMAR's: the submit race (the submitter's
 *     answer was lost, or the sweep met the job before the submitter bound it). A row that still has no
 *     Tapis job and can take it is BOUND to it and nothing is cancelled. A tag for a row that is bound to
 *     another job, or ended, or has a cancel pending, is a DUPLICATE of a NEMAR job: it is cancelled if
 *     it is live, the row is flagged `mismatch`, and it is never indexed, charged or counted as use that
 *     skipped the reservation. This is also what catches the second orphan of a row, which the row's one
 *     orphan slot (`orphan_tapis_uuid`) cannot hold: the sweep sees every duplicate on every run;
 *  3. anything else skipped the reservation. An index row is written FIRST (source `partner`, client
 *     `tenant`, `spec_digest` the SHA-256 of the Tapis fields read, `cancel_reason` `unreserved`, or
 *     `unattributed` when the owner maps to no active account, the flags set), then the job is cancelled
 *     at Tapis, then the row is followed to its end like any cancelled job and charged what it used to
 *     the PARTNER POOL `tenant` (counted against the `people` budget), NEVER to a person, however clear it
 *     is whose job it was. Moving the charge later is a ledger operation Epic D's partner-pool phase
 *     exposes; no route reaches the partner pool today. The row is written before the cancel so a crash
 *     between the two leaves a row to finish, not an unrecorded job.
 *
 * THE RULES.
 *  - PRODUCTION ONLY and only while compute is on (`computeEnabled`): the dev database shares real users,
 *    and a sweep that cancels in a tenant must be a tenant the owner has switched on. Both the cron wiring
 *    and this function refuse otherwise, before anything is read.
 *  - A TAPIS THAT CANNOT BE LISTED CHANGES NOTHING: a failed listing is a fixed word and no row is
 *    written, no job cancelled and no charge made. A listing cut off at its page bound is reported at
 *    error level, because a job past the bound is a job not seen.
 *  - BOUNDED: five pages of 1,000, at most 25 unbound jobs handled a run (the rest are `deferred` and
 *    taken next run), ten rows of its own to follow a run, one log line.
 *  - NOTHING IT READS IS TRUSTED: the owner, queue and resources of a Tapis record are clamped to what the
 *    table takes, an unknown partition prices at nothing (flagged `mismatch`), and a record that cannot be
 *    read is not guessed at.
 *  - THE ORDER OF A LISTING IS ASKED FOR, NOT KNOWN: `orderBy=created(desc)` is the spelling of Tapis's
 *    documentation and UNVERIFIED against a real tenant; if it is ignored, a tenant past 5,000 jobs would
 *    show only its oldest, which is why truncation is loud.
 *
 * The charge is an `overrun` entry of the ledger (`unreservedChargeStatements`): the table refuses a
 * `charge` that closes no hold, and a job that skipped the reservation has none.
 */

import {
  type ComputeState,
  isTerminalComputeState,
  stateFromTapisStatus,
} from "../../../shared/compute-state.js";
import { failureCodeFromTapisCondition } from "../../../shared/compute-state.js";
import { COMPUTE_TENANT_POOL_REF } from "../../../shared/compute-state.js";
import {
  COMPUTE_JOB_ID_RE,
  type ComputePool,
  PARTITION_NAMES,
  PIPELINES_TAPIS_OWNER,
} from "../../../shared/contract/compute.js";
import type { Bindings } from "../types/bindings.js";
import { ACCESS_REPORT_PENDING_SQL } from "./access-attributes.js";
import { ACTIVE_ACCOUNT_STATUS_SQL_LIST } from "./account-tier.js";
import { LIVE_STATES_SQL, getJob } from "./compute-jobs.js";
import { ensurePool, platformPool, unreservedChargeStatements } from "./compute-ledger.js";
import {
  BIND_TAPIS_JOB_SQL,
  FLAG_MISMATCH_SQL,
  STAMP_EXAMINED_SQL,
  TERMINAL_TRANSITION_SQL,
  TICK_READ,
  errorClassName,
  provisionalCharge,
  sqliteTime,
  tapisAccess,
} from "./compute-lifecycle.js";
import { settleObservedRows } from "./compute-observer.js";
import { getPolicy } from "./compute-policy.js";
import { sha256Hex } from "./compute-records.js";
import { listAccessReportFailures } from "./compute-reporting.js";
import { computeEnabled } from "./compute-switches.js";
import { tenantFacts } from "./compute-tenant.js";
import { isExactProduction } from "./repull-switches.js";
import {
  type TapisContext,
  type TapisJob,
  cancelJob,
  getJob as getTapisJob,
  listJobs,
} from "./tapis/client.js";
import { TapisError } from "./tapis/errors.js";
import { TAPIS_JOB_UUID_RE, TAPIS_OWNER_RE } from "./tapis/schemas.js";

export type TenantSweepMode = "live" | "week";

/** Jobs per listing page: Tapis's own maximum. */
export const TENANT_PAGE = 1000;
/** Pages a run reads at most. */
export const TENANT_MAX_PAGES = 5;
/** Unbound Tapis jobs a run handles at most; the rest wait for the next run. */
export const TENANT_NEW_PER_RUN = 25;
/** Rows of its own a run follows to their end. */
export const TENANT_FOLLOW_ROWS = 10;
/** The window of the daily sweep. */
export const TENANT_WEEK_DAYS = 7;
/** A followed row whose Tapis record stays unreadable this long is closed, flagged, with nothing charged. */
export const TENANT_GIVE_UP_DAYS = 7;

export interface TenantSweepResult {
  mode: TenantSweepMode;
  /** Tapis jobs read from the listing (before the scope filter). */
  listed: number;
  /** The listing was cut off at its page bound: a job past it was not seen. */
  truncated: boolean;
  /**
   * The listing was cut off AND its last page still held a job that has not ended, so a live job could be
   * hiding past the cut. A `live` run needs a person only for this; a cut that ends in ended jobs only
   * (the tenant has simply run more than 5,000 jobs) is counted in `truncated` and is not a problem.
   */
  liveMayHide: boolean;
  /** Jobs already bound to a row: left alone. */
  bound: number;
  /** Rows that took a Tapis job they had none of (the submit race). */
  raced: number;
  /** Duplicates of a NEMAR job, cancelled and never indexed. */
  duplicates: number;
  /** Jobs that skipped the reservation, indexed this run. */
  indexed: number;
  /** Of those, owned by nobody NEMAR can attribute. */
  unattributed: number;
  /** Cancels asked of Tapis this run (both kinds). */
  cancelled: number;
  /** Unbound jobs left for the next run (over the bound). */
  deferred: number;
  /** Own rows taken to their end and charged to the tenant pool. */
  finished: number;
  /** Own rows closed after their record stayed unreadable. */
  gaveUp: number;
  /** Expanse figures that settled a job finally (week mode). */
  settledFinal: number;
  /** ACCESS reports in `failed`, by their fixed word (week mode). */
  accessFailed: Record<string, number>;
  /**
   * A `live` run only: the jobs of the listing that have not ended, which is what the tenant's slots hold
   * as Tapis sees it (null in a `week` run, and when the run did not get as far as the listing). With
   * `occupied` and `ceiling` (NEMAR's own count and the owner's ceiling, null if the policy could not be
   * read) it is how a job NEMAR did not admit shows: more live jobs in the tenant than the ceiling. Both are
   * read BEFORE the run indexes or cancels anything, so the line says what the tenant held when it looked.
   */
  tenantLive: number | null;
  occupied: number | null;
  ceiling: number | null;
  /** Fixed words; never a message. */
  errors: string[];
  errorClass: string | null;
}

const emptyResult = (mode: TenantSweepMode): TenantSweepResult => ({
  mode,
  listed: 0,
  truncated: false,
  liveMayHide: false,
  bound: 0,
  raced: 0,
  duplicates: 0,
  indexed: 0,
  unattributed: 0,
  cancelled: 0,
  deferred: 0,
  finished: 0,
  gaveUp: 0,
  settledFinal: 0,
  tenantLive: null,
  occupied: null,
  ceiling: null,
  accessFailed: {},
  errors: [],
  errorClass: null,
});

// --- Statements ------------------------------------------------------------------------------------

/** The rows already bound to any of these Tapis uuids: `?1`.. the uuids. Built per chunk by `boundUuids`. */
const BOUND_CHUNK = 90;

/**
 * The index row of a job that skipped the reservation. `?1` id, `?2` the account it maps to (or NULL),
 * `?3` the Tapis owner (or NULL), `?4` the state, `?5` the cancel reason, `?6` the uuid, `?7` Tapis's
 * status, `?8` the Slurm id (or NULL), `?9` the application, `?10` its version, `?11` the spec digest,
 * `?12` the partition, `?13` the pool, `?14` nodes, `?15` cores, `?16` memory (or NULL), `?17` minutes,
 * `?18` the scheduler's submit time (or NULL), `?19` its start time (or NULL), `?20` unattributed 0 or 1,
 * `?21` the retention as a SQLite modifier. Source `partner` and client `tenant`: the use is the tenant
 * pool's. `OR` nothing: the uuid is UNIQUE, so a second writer's row is a conflict that does nothing.
 * `gateway_user` is the mapped account's pseudonym, copied as for a NEMAR job, and NULL for an owner that
 * maps to no account (that job's ACCESS report then ends `no_gateway_user`, so the gap is visible).
 */
export const INSERT_UNRESERVED_SQL = `INSERT INTO compute_jobs
  (id, account_id, tapis_owner, gateway_user, source, client_id, kind, state, cancel_reason, cancel_requested_at,
   tapis_uuid, tapis_status, slurm_job_id, app_id, app_version, spec_digest, partition, pool, nodes,
   cores_per_node, memory_mb, gpus, minutes, submitted_at, remote_submitted_at, started_at,
   tapis_synced_at, flag_unreserved, flag_unattributed, retention_until)
  VALUES (?1, ?2, ?3, (SELECT g.gateway_user FROM compute_gateway_users g WHERE g.account_id = ?2),
          'partner', '${COMPUTE_TENANT_POOL_REF}', 'batch', ?4, ?5, datetime('now'),
          ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 0, ?17, datetime('now'), ?18, ?19,
          datetime('now'), 1, ?20, datetime('now', ?21))
  ON CONFLICT (tapis_uuid) DO NOTHING`;

/**
 * The stamp that says an unreserved row's use was recorded: `?1` the job, `?2` the state it took.
 * There may be no ledger entry (a job that never started used nothing), so unlike the lifecycle's stamp
 * this does not need one; it takes the whole charge from the ledger, whatever it is. It does not set
 * `flag_overrun`: the entry is an `overrun` only because the table has no other kind for use without a
 * hold, and the row's `unreserved` flag already says what happened.
 */
export const STAMP_UNRESERVED_SQL = `UPDATE compute_jobs SET
    settled_provisional_at = datetime('now'),
    charged_milli = (SELECT COALESCE(SUM(e.charged_delta_milli), 0) FROM compute_ledger e
                      WHERE e.job_id = ?1)
  WHERE id = ?1 AND state = ?2 AND settled_provisional_at IS NULL`;

/** The gate of the charge statement: the row has taken the state `?` and has not been settled. */
const UNRESERVED_GATE_SQL = `EXISTS (SELECT 1 FROM compute_jobs
    WHERE id = ? AND state = ? AND settled_provisional_at IS NULL)`;

/** Rows of this sweep's own that have not ended: the rotation by last examination. */
export const FOLLOW_ROWS_SQL = `SELECT id FROM compute_jobs
  WHERE flag_unreserved = 1 AND state IN (${LIVE_STATES_SQL}) AND tapis_uuid IS NOT NULL
    AND executor = 'tapis'
  ORDER BY examined_at ASC, created_at ASC LIMIT ?1`;

/** The account a Tapis owner maps to, by the gateway pseudonym, if the account is active and not deleted. */
export const OWNER_ACCOUNT_SQL = `SELECT u.id AS id FROM compute_gateway_users g
  JOIN users u ON u.id = g.account_id
  WHERE g.gateway_user = ?1 AND u.deleted_at IS NULL AND u.status IN ${ACTIVE_ACCOUNT_STATUS_SQL_LIST}`;

// --- Small helpers ---------------------------------------------------------------------------------

function parseMs(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  const ms = Date.parse(hasZone ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : null;
}

const tapisWord = (err: unknown): string =>
  err instanceof TapisError
    ? `${err.kind}${err.outcomeUnknown ? "_unknown" : ""}`
    : errorClassName(err);

/** Whether Tapis says the job has ended. */
function tapisEnded(status: string): boolean {
  const state = stateFromTapisStatus(status);
  return state !== null && isTerminalComputeState(state);
}

const newJobId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `job_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
};

function clamp(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.trunc(value)))
    : null;
}

/** A word in the shape a column takes, or the fallback. */
function wordOr(value: unknown, re: RegExp, fallback: string): string {
  return typeof value === "string" && re.test(value) ? value : fallback;
}

/** What is known of a Tapis job, as the row stores it: every field in range, none guessed. */
export function rowFieldsOf(rec: TapisJob) {
  const queue = typeof rec.execSystemLogicalQueue === "string" ? rec.execSystemLogicalQueue : "";
  const partition = wordOr(queue.toLowerCase(), /^[a-z-]{1,32}$/, "unknown");
  const gpu = partition.startsWith("gpu");
  return {
    partition,
    pool: (gpu ? "gpu" : "cpu") as ComputePool,
    nodes: clamp(rec.nodeCount, 1, 64) ?? 1,
    cores: clamp(rec.coresPerNode, 0, 256) ?? 1,
    memory: clamp(rec.memoryMB, 1, 16_777_216),
    minutes: clamp(rec.maxMinutes, 1, 10_080) ?? 1,
    appId: wordOr(rec.appId, /^[A-Za-z0-9._-]{1,80}$/, "unknown"),
    appVersion: wordOr(rec.appVersion, /^[A-Za-z0-9._+-]{1,64}$/, "unknown"),
    owner: wordOr(rec.owner, /^[A-Za-z0-9_.@+-]{1,128}$/, ""),
    slurm: wordOr(rec.remoteJobId, /^[0-9A-Za-z_+.-]{1,64}$/, ""),
  };
}

/** The Tapis fields the digest covers, in a fixed order. */
function digestSource(rec: TapisJob): string {
  return JSON.stringify({
    uuid: rec.uuid,
    owner: rec.owner ?? null,
    appId: rec.appId ?? null,
    appVersion: rec.appVersion ?? null,
    queue: rec.execSystemLogicalQueue ?? null,
    nodeCount: rec.nodeCount ?? null,
    coresPerNode: rec.coresPerNode ?? null,
    memoryMB: rec.memoryMB ?? null,
    maxMinutes: rec.maxMinutes ?? null,
    created: rec.created ?? null,
    status: rec.status,
  });
}

// --- The listing -----------------------------------------------------------------------------------

async function listTenant(ctx: TapisContext, r: TenantSweepResult): Promise<TapisJob[]> {
  const out: TapisJob[] = [];
  let last: TapisJob[] = [];
  for (let page = 0; page < TENANT_MAX_PAGES; page++) {
    const jobs = await listJobs(ctx, {
      listType: "ALL_JOBS",
      limit: TENANT_PAGE,
      skip: page * TENANT_PAGE,
      orderBy: "created(desc)",
    });
    out.push(...jobs);
    if (jobs.length < TENANT_PAGE) return out;
    last = jobs;
  }
  // A full last page: there may be more behind it. The listing is newest first, so what is behind it is
  // older than everything read; a live job can be hiding there only if the last page itself still held one.
  r.truncated = true;
  r.liveMayHide = last.some((j) => !tapisEnded(j.status));
  return out;
}

/** The jobs of the listing this mode looks at. */
function inScope(jobs: TapisJob[], mode: TenantSweepMode, nowMs: number): TapisJob[] {
  return jobs.filter((j) => {
    if (!TAPIS_JOB_UUID_RE.test(j.uuid)) return false;
    if (mode === "live") return !tapisEnded(j.status);
    const created = parseMs(j.created);
    // A job whose creation time cannot be read is looked at: it is not known to be old.
    return created === null || nowMs - created <= TENANT_WEEK_DAYS * 86_400_000;
  });
}

/** The uuids of the given Tapis jobs that a row is bound to. */
async function boundUuids(db: D1Database, uuids: string[]): Promise<Set<string>> {
  const bound = new Set<string>();
  for (let i = 0; i < uuids.length; i += BOUND_CHUNK) {
    const chunk = uuids.slice(i, i + BOUND_CHUNK);
    const rows = (
      await db
        .prepare(
          `SELECT tapis_uuid FROM compute_jobs WHERE tapis_uuid IN (${chunk.map(() => "?").join(",")})`,
        )
        .bind(...chunk)
        .all<{ tapis_uuid: string }>()
    ).results;
    for (const row of rows) bound.add(row.tapis_uuid);
  }
  return bound;
}

// --- One unbound job -------------------------------------------------------------------------------

/** The `nemar_job:<id>` ids a record's tags name. */
function nemarTagIds(rec: TapisJob): string[] {
  const ids: string[] = [];
  for (const tag of rec.tags ?? []) {
    if (typeof tag === "string" && tag.startsWith("nemar_job:")) {
      const id = tag.slice("nemar_job:".length);
      if (COMPUTE_JOB_ID_RE.test(id)) ids.push(id);
    }
  }
  return ids;
}

async function cancelAtTapis(ctx: TapisContext, uuid: string, r: TenantSweepResult): Promise<void> {
  try {
    await cancelJob(ctx, uuid);
    r.cancelled++;
  } catch (err) {
    // Only a 409 means it is over. Any other refusal (a 400, a 403) or an unclear answer is a failure,
    // logged, and asked again by the next run (the job is still listed or its row is followed). Never
    // a message.
    if (!(err instanceof TapisError && err.status === 409)) {
      console.warn(`[compute-tenant] cancel_failed kind=${tapisWord(err)}`);
    }
  }
}

/**
 * One Tapis job no row is bound to. Returns after doing exactly one of: binding the submit race,
 * cancelling a duplicate of a NEMAR job, or indexing and cancelling a job that skipped the reservation.
 */
async function handleUnbound(
  env: Bindings,
  ctx: TapisContext,
  listed: TapisJob,
  r: TenantSweepResult,
): Promise<void> {
  const rec = await getTapisJob(ctx, listed.uuid);

  // Tagged for a row that exists: NEMAR's own. A tag is TRUSTED only on a job the NEMAR service identity
  // owns: NEMAR owns every Tapis job it submits, and anyone else can write any tag on a job of theirs, so
  // a foreign job that carries a NEMAR-looking tag is a job that skipped the reservation, not a
  // duplicate to be cancelled unrecorded.
  for (const id of rec.owner === ctx.owner ? nemarTagIds(rec) : []) {
    const row = await getJob(env.DB, id);
    if (row === null) continue;
    // The bound-uuid snapshot was taken before this read: the submitter may have bound this very job
    // since. Then it is the row's own, and nothing is flagged or cancelled.
    if (row.tapis_uuid === rec.uuid) {
      r.bound++;
      return;
    }
    if (row.tapis_uuid === null && row.cancel_requested_at === null) {
      const took = await env.DB.prepare(BIND_TAPIS_JOB_SQL)
        .bind(row.id, rec.uuid, rec.status, sqliteTime(rec.remoteSubmitted))
        .run();
      if ((took.meta?.changes ?? 0) === 1) {
        r.raced++;
        return;
      }
      // The bind lost a race: read the row again before judging it a duplicate.
      if ((await getJob(env.DB, id))?.tapis_uuid === rec.uuid) {
        r.bound++;
        return;
      }
    }
    // Bound to another job, ended, or with a cancel pending: a duplicate of a NEMAR job.
    await env.DB.prepare(FLAG_MISMATCH_SQL).bind(row.id).run();
    if (!tapisEnded(rec.status)) await cancelAtTapis(ctx, rec.uuid, r);
    r.duplicates++;
    return;
  }

  // Skipped the reservation.
  const fields = rowFieldsOf(rec);
  const mapped =
    fields.owner === ""
      ? null
      : await env.DB.prepare(OWNER_ACCOUNT_SQL).bind(fields.owner).first<{ id: number }>();
  const unattributed = mapped === null;
  const state: ComputeState = stateFromTapisStatus(rec.status) ?? "unreported";
  const live = isTerminalComputeState(state) ? "submitted" : state;
  const policy = (await getPolicy(env.DB)).policy;
  const id = newJobId();
  // The ACCESS report is owed in the same batch as the row, `OR IGNORE` and with no network call (decision 9):
  // it is made only if the row has a Slurm id NOW, and the close of the row makes it for an id that comes later.
  const [wrote] = await env.DB.batch([
    env.DB.prepare(INSERT_UNRESERVED_SQL).bind(
      id,
      mapped?.id ?? null,
      fields.owner === "" ? null : fields.owner,
      live,
      unattributed ? "unattributed" : "unreserved",
      rec.uuid,
      rec.status,
      fields.slurm === "" ? null : fields.slurm,
      fields.appId,
      fields.appVersion,
      await sha256Hex(new TextEncoder().encode(digestSource(rec))),
      fields.partition,
      fields.pool,
      fields.nodes,
      fields.cores,
      fields.memory,
      fields.minutes,
      sqliteTime(rec.remoteSubmitted),
      sqliteTime(rec.remoteStarted),
      unattributed ? 1 : 0,
      `+${policy.retention.recordsYears} years`,
    ),
    env.DB.prepare(ACCESS_REPORT_PENDING_SQL).bind(id),
  ]);
  if ((wrote?.meta?.changes ?? 0) === 1) {
    r.indexed++;
    if (unattributed) r.unattributed++;
  } else {
    // The insert did nothing: a row already has this Tapis job (another run of this sweep, or the
    // submitter, bound it since the snapshot). It is cancelled only if the row is the sweep's own;
    // a NEMAR job that a row owns is never cancelled here.
    const existing = await env.DB.prepare(
      "SELECT flag_unreserved FROM compute_jobs WHERE tapis_uuid = ?1",
    )
      .bind(rec.uuid)
      .first<{ flag_unreserved: number }>();
    if (existing === null || existing.flag_unreserved !== 1) {
      r.bound++;
      return;
    }
  }
  if (!tapisEnded(rec.status)) await cancelAtTapis(ctx, rec.uuid, r);
}

// --- Following the rows this sweep wrote ---------------------------------------------------------------

/**
 * Take one of this sweep's rows a step on: read its job; if Tapis says it ended, close the row and
 * charge what it used to the tenant pool in ONE batch; if not, cancel it again.
 */
async function followRow(
  env: Bindings,
  ctx: TapisContext,
  id: string,
  r: TenantSweepResult,
  nowMs: number,
): Promise<void> {
  const job = await getJob(env.DB, id);
  if (job === null || job.tapis_uuid === null || isTerminalComputeState(job.state)) return;
  let rec: TapisJob;
  try {
    rec = await getTapisJob(ctx, job.tapis_uuid);
  } catch (err) {
    // A job Tapis no longer has, or that no read has found for a week, is closed: flagged, charged
    // nothing. The week is counted from the last GOOD read (`tapis_synced_at`, which a good read of a live
    // row refreshes below), so one transient 5xx on an old row does not close it: only repeated failures
    // over the whole week do.
    const age = nowMs - (parseMs(job.tapis_synced_at ?? job.created_at) ?? nowMs);
    const gone = err instanceof TapisError && err.kind === "not_found";
    if (gone || age > TENANT_GIVE_UP_DAYS * 86_400_000) {
      if (await closeRow(env, job.id, job.state, "cancelled", null, null, true)) r.gaveUp++;
      return;
    }
    throw err;
  }
  const target = stateFromTapisStatus(rec.status);
  if (target !== "finished" && target !== "failed" && target !== "cancelled") {
    await env.DB.prepare("UPDATE compute_jobs SET tapis_synced_at = datetime('now') WHERE id = ?1")
      .bind(job.id)
      .run();
    await cancelAtTapis(ctx, rec.uuid, r);
    return;
  }
  const settlement = provisionalCharge({ ...job, held_milli: 0 }, rec, nowMs);
  const milli = settlement.kind === "charge" ? settlement.milli : 0;
  const mismatch = settlement.kind === "charge" && settlement.fallback;
  const fields = rowFieldsOf(rec);
  const closed = await closeRow(
    env,
    job.id,
    job.state,
    target,
    target === "failed" ? failureCodeFromTapisCondition(rec.condition) : null,
    {
      tapisStatus: rec.status,
      submitted: sqliteTime(rec.remoteSubmitted),
      started: sqliteTime(rec.remoteStarted),
      ended: sqliteTime(rec.remoteEnded) ?? sqliteTime(rec.ended),
      slurm: fields.slurm === "" ? null : fields.slurm,
      milli,
      pool: job.pool,
      mismatch,
    },
    false,
  );
  if (closed) r.finished++;
}

interface CloseFacts {
  tapisStatus: string;
  submitted: string | null;
  started: string | null;
  ended: string | null;
  slurm: string | null;
  milli: number;
  pool: ComputePool;
  mismatch: boolean;
}

/** The terminal write, the tenant-pool charge and the stamp, one batch. True when this call moved the row. */
async function closeRow(
  env: Bindings,
  id: string,
  from: ComputeState,
  to: "finished" | "failed" | "cancelled",
  failureCode: string | null,
  facts: CloseFacts | null,
  mismatch: boolean,
): Promise<boolean> {
  const db = env.DB;
  const policy = (await getPolicy(db)).policy;
  const pool = facts?.pool ?? "cpu";
  const charge =
    facts !== null && facts.milli > 0
      ? unreservedChargeStatements(
          db,
          {
            jobId: id,
            poolId: (await ensurePool(db, "partner", COMPUTE_TENANT_POOL_REF, pool)).id,
            budgetPoolId: ((await platformPool(db, "people", pool)) ?? failMissing()).id,
            chargeMilli: facts.milli,
          },
          { sql: UNRESERVED_GATE_SQL, binds: [id, to] },
        )
      : [];
  const results = await db.batch([
    db
      .prepare(TERMINAL_TRANSITION_SQL)
      .bind(
        id,
        from,
        to,
        failureCode,
        null,
        null,
        0,
        0,
        mismatch || facts?.mismatch ? 1 : 0,
        facts?.tapisStatus ?? null,
        facts?.submitted ?? null,
        facts?.started ?? null,
        facts?.ended ?? null,
        facts?.slurm ?? null,
        `+${policy.retention.recordsYears} years`,
        0,
      ),
    ...charge,
    db.prepare(STAMP_UNRESERVED_SQL).bind(id, to),
    // The report ACCESS is owed for an id that first shows at the END (as the lifecycle's close does).
    db
      .prepare(ACCESS_REPORT_PENDING_SQL)
      .bind(id),
  ]);
  // True only when THIS call moved the row: a no-op transition (another run closed it) is not counted.
  return (results[0]?.meta?.changes ?? 0) > 0;
}

function failMissing(): never {
  throw new Error("the platform people budget is missing");
}

// --- The sweep -------------------------------------------------------------------------------------------

/**
 * A `live` run's view of the tenant ceiling (issue #2121, phase P2): the live jobs its listing holds and,
 * beside them, NEMAR's own count of occupied slots and the owner's ceiling. Read-only. A policy that cannot
 * be read leaves the two numbers null and is an error word, never a guess.
 */
async function readTenantSlots(env: Bindings, r: TenantSweepResult, live: number): Promise<void> {
  r.tenantLive = live;
  try {
    const facts = await tenantFacts(env.DB, (await getPolicy(env.DB)).policy);
    r.occupied = facts.occupied;
    r.ceiling = facts.ceiling;
  } catch (err) {
    r.errors.push("tenant_unreadable");
    r.errorClass = errorClassName(err);
  }
}

/**
 * One run of the tenant sweep. Null outside exact production and while compute is off, before anything
 * is read. A listing that fails is `list_failed` and nothing at all is written.
 */
export async function sweepTenantJobs(
  env: Bindings,
  mode: TenantSweepMode,
  nowMs: number = Date.now(),
): Promise<TenantSweepResult | null> {
  if (!isExactProduction(env) || !computeEnabled(env)) return null;
  const r = emptyResult(mode);
  try {
    const ctx = tapisAccess(env, TICK_READ);
    if (ctx === null) {
      r.errors.push("unconfigured");
      return r;
    }
    let listed: TapisJob[];
    try {
      listed = await listTenant(ctx, r);
    } catch (err) {
      r.errors.push("list_failed");
      r.errorClass = tapisWord(err);
      return r;
    }
    r.listed = listed.length;
    const scope = inScope(listed, mode, nowMs);
    const bound = await boundUuids(
      env.DB,
      scope.map((j) => j.uuid),
    );
    r.bound = scope.filter((j) => bound.has(j.uuid)).length;
    const unbound = scope.filter((j) => !bound.has(j.uuid));
    if (mode === "live") await readTenantSlots(env, r, scope.length);
    for (const job of unbound.slice(0, TENANT_NEW_PER_RUN)) {
      try {
        await handleUnbound(env, ctx, job, r);
      } catch (err) {
        r.errors.push("job_failed");
        r.errorClass = tapisWord(err);
      }
    }
    r.deferred = Math.max(0, unbound.length - TENANT_NEW_PER_RUN);

    // This sweep's own rows, in rotation.
    const rows = (
      await env.DB.prepare(FOLLOW_ROWS_SQL).bind(TENANT_FOLLOW_ROWS).all<{ id: string }>()
    ).results;
    for (const { id } of rows) {
      await env.DB.prepare(STAMP_EXAMINED_SQL).bind(id).run();
      try {
        await followRow(env, ctx, id, r, nowMs);
      } catch (err) {
        r.errors.push("follow_failed");
        r.errorClass = tapisWord(err);
      }
    }

    if (mode === "week") {
      try {
        r.settledFinal = (await settleObservedRows(env)).settled;
      } catch (err) {
        r.errors.push("observed_failed");
        r.errorClass = errorClassName(err);
      }
      try {
        r.accessFailed = await listAccessReportFailures(env.DB);
      } catch (err) {
        r.errors.push("access_failed_unreadable");
        r.errorClass = errorClassName(err);
      }
    }
  } catch (err) {
    r.errors.push("sweep_failed");
    r.errorClass = errorClassName(err);
  }
  return r;
}

/**
 * The sweep's one log line. Null when it found nothing to say; error level when anything failed, a
 * listing was cut off, a job waits for the next run, or an ACCESS report needs a person. Counts and
 * fixed words only: no owner, uuid, job id or message.
 */
export function tenantLogLine(
  r: TenantSweepResult,
): { level: "info" | "warn" | "error"; line: string } | null {
  const accessFailed = Object.entries(r.accessFailed).reduce((n, [, c]) => n + c, 0);
  // A cut listing needs a person in a `week` pass (a job of the week may be missing) and, in a `live` pass,
  // only when a live job could be hiding past the cut.
  const cutMatters = r.truncated && (r.mode === "week" || r.liveMayHide);
  const needsPerson = r.errors.length > 0 || cutMatters || r.deferred > 0 || accessFailed > 0;
  const acted =
    r.indexed + r.raced + r.duplicates + r.cancelled + r.finished + r.gaveUp + r.settledFinal;
  // More live jobs in the tenant than the owner's ceiling: something NEMAR did not admit holds slots (a job
  // that skipped the reservation, a duplicate, a hand-run job), or the owner lowered the ceiling below what
  // is already live. Said at warning level, whatever else the run did.
  const overCeiling = r.tenantLive !== null && r.ceiling !== null && r.tenantLive > r.ceiling;
  if (!needsPerson && acted === 0 && !overCeiling) return null;
  const parts = [
    "[compute-tenant]",
    `mode=${r.mode}`,
    `listed=${r.listed}`,
    `bound=${r.bound}`,
    `raced=${r.raced}`,
    `duplicates=${r.duplicates}`,
    `indexed=${r.indexed}`,
    `unattributed=${r.unattributed}`,
    `cancelled=${r.cancelled}`,
    `finished=${r.finished}`,
    `gave_up=${r.gaveUp}`,
    `deferred=${r.deferred}`,
    `truncated=${r.truncated ? 1 : 0}`,
    `live_may_hide=${r.liveMayHide ? 1 : 0}`,
    ...(r.tenantLive === null
      ? []
      : [
          `tenant_live=${r.tenantLive}`,
          ...(r.occupied === null || r.ceiling === null
            ? []
            : [`occupied=${r.occupied}/${r.ceiling}`]),
        ]),
    ...(r.mode === "week" ? [`settled_final=${r.settledFinal}`] : []),
    ...Object.entries(r.accessFailed).map(([word, count]) => `access_${word}=${count}`),
    `errors=${r.errors.length > 0 ? [...new Set(r.errors)].join(",") : "none"}`,
    ...(r.errorClass === null ? [] : [`class=${r.errorClass}`]),
  ];
  return { level: needsPerson ? "error" : overCeiling ? "warn" : "info", line: parts.join(" ") };
}

// Re-exported so a test names the constants the sweep depends on from one place.
export { PARTITION_NAMES, PIPELINES_TAPIS_OWNER, TAPIS_OWNER_RE };
