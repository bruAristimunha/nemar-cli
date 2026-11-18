/**
 * The observer: Expanse's own accounting, posted to NEMAR, and the final settlement it makes possible
 * (epic #2005 phase A7, #2012; ADR 0118, decision 8; design sections 5 and 8).
 *
 * A small posting service runs on the cluster, summarizes the queue per partition (every 15 minutes) and,
 * once a day, exports `sacct` for the community account, and posts a `nemar.observation.v1` document to
 * `POST /compute/observer` with `Authorization: Bearer <token>`, a token valid for ONE run. The Worker
 * adopted the observer's document as it is (`shared/contract/compute-observation.ts`; the mapping to the
 * rows below is `./compute-observation.ts`). This module mints that token, takes the post, and settles
 * jobs against it.
 *
 *   `mintObserverRun`      an administrator mints a one-hour run; the token is `<run id>.<digest>`
 *   `ingestObserverPost`   the one post a run may make: the snapshots and the rows are stored, then the
 *                          jobs that can be settled are
 *   `settleObservedRows`   match stored rows to jobs by Slurm id and settle the ones whose job has ended
 *
 * THE OBSERVER IS AN UNSIGNED SENDER. It holds one token for one run: an HMAC (domain tag
 * `compute-observer`) over the run id and the run's own nonce, so nothing it posts is trusted beyond its
 * bounds. The token is checked in constant time against the run row; a wrong, an expired and a reused
 * token get ONE refusal, the same status and body, and a refusal writes nothing. The run is spent by
 * one conditional UPDATE made BEFORE anything is stored, so two posts racing make one. The body is
 * bounded (1 MiB and 5,000 rows) and every row is validated to the shape of its column; a row that is
 * not valid refuses the post, and the run is NOT spent by a body that failed validation (the check runs
 * first), so the observer can post again.
 *
 * FINAL SETTLEMENT. A row matches the job whose `slurm_job_id` it carries. When that job has ended and
 * has a provisional charge and no final one, the job is settled to Expanse's figure through the ledger's
 * `settleFinal` (one `adjust`, once per job): the row's own `charged_milli` when it sent one, else the
 * figure the rate table gives for the allocation it reports (`suMilliFor`, per node: the row's CPUs,
 * memory and GPUs are totals). A difference within the policy's tolerance (`settle.toleranceMilli`, or
 * `settle.tolerancePercent` of the provisional charge) is routine and silent; a larger one sets
 * `flag_mismatch` and the job is STILL settled to Expanse's figure. A job that skipped the reservation
 * (`flag_unreserved`) has no hold, so `settleFinal` has nothing to correct: its row is matched and
 * listed, and an administrator moves the charge by an `adjust` entry if it is warranted. A row whose
 * job has not ended waits (`applied_at` stays NULL), and the daily sweep tries it again; a row that
 * can never settle is judged once (`applied_at` set, the job flagged) and never tried again.
 * Rows that match no job stay `matched_job_id` NULL and are listed to the administrators.
 */

import { z } from "zod";
import { SACCT_COLUMN_MAX } from "../../../shared/contract/compute-observation.js";
import {
  type ComputePolicy,
  PARTITION_NAMES,
  type PartitionName,
  suMilliFor,
} from "../../../shared/contract/compute.js";
import { auditLogStatement } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import { TERMINAL_STATES_SQL } from "./compute-jobs.js";
import { settleFinal } from "./compute-ledger.js";
import { getPolicy } from "./compute-policy.js";
import { NO_NONCE, signComputeToken, verifyComputeToken } from "./compute-tokens.js";

/**
 * The observer's token, from its `Authorization` header: `Bearer <token>` and nothing else. Never a URL,
 * which reaches logs. The scheme is matched without regard to case (RFC 9110, 11.1); anything else, and
 * no header, is the empty string, which no run's token is.
 */
export function observerBearerToken(header: string | undefined): string {
  const found = /^Bearer ([\x21-\x7e]{1,200})$/i.exec(header ?? "");
  return found?.[1] ?? "";
}

/** How long a run's token lives. */
export const OBSERVER_RUN_MINUTES = 60;

/** The most bytes of a post, and the most rows (partitions and accounting jobs together). */
export const OBSERVER_BODY_MAX_BYTES = 1024 * 1024;
export const OBSERVER_ROWS_MAX = 5000;

/** The most jobs one pass settles: each is a few statements, and a Worker may make 1,000 subrequests. */
export const OBSERVER_SETTLE_PER_PASS = 150;

/** Rows of `compute_sacct_rows` one INSERT carries: 13 bound values each, 7 rows under D1's 100. */
const ROWS_PER_INSERT = 7;
/** Statements per `db.batch` call. */
const STATEMENTS_PER_BATCH = 50;

/**
 * Slurm states in which a job has ended: only such a row is Expanse's figure for the job. A row for a
 * job still pending or running is stored (it is a fact) and waits.
 */
export const SACCT_ENDED_STATES = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
  "OUT_OF_MEMORY",
  "NODE_FAIL",
  "PREEMPTED",
  "BOOT_FAIL",
  "DEADLINE",
] as const;

const ENDED_SQL = `(${SACCT_ENDED_STATES.map((s) => `'${s}'`).join(", ")})`;

// --- The body -----------------------------------------------------------------------------------------

const PARTITION_RE = /^[a-z-]{1,32}$/;
const SLURM_RE = /^[0-9A-Za-z_+.-]{1,64}$/;
const count = (max: number) => z.number().int().min(0).max(max);
const timeText = z.string().min(10).max(40);

/**
 * THE ROWS THE WORKER STORES, which a document of the observer's is mapped to (`./compute-observation.ts`).
 * Not a wire format: nothing posts these shapes any more.
 */
export const ObserverSnapshotSchema = z
  .object({
    partition: z.string().regex(PARTITION_RE),
    pending: count(1_000_000_000),
    running: count(1_000_000_000),
  })
  .strict();

export const ObserverSacctRowSchema = z
  .object({
    slurm_job_id: z.string().regex(SLURM_RE),
    partition: z.string().regex(PARTITION_RE),
    // `sacct` may print "CANCELLED by 1234" or "CANCELLED+": the state is the first word, which is all that is stored.
    state: z
      .string()
      .regex(/^[A-Z_]{1,32}(?:[ +][ -~]{0,48})?$/)
      .transform((v) => (/^[A-Z_]+/.exec(v) as RegExpExecArray)[0]),
    elapsed_seconds: count(SACCT_COLUMN_MAX.elapsedSeconds),
    alloc_nodes: count(SACCT_COLUMN_MAX.nodes),
    alloc_cpus: count(SACCT_COLUMN_MAX.cpus),
    alloc_gpus: count(SACCT_COLUMN_MAX.gpus),
    alloc_mem_mb: count(SACCT_COLUMN_MAX.memMb),
    submit_time: timeText.nullish(),
    start_time: timeText.nullish(),
    end_time: timeText.nullish(),
    charged_milli: count(Number.MAX_SAFE_INTEGER).nullish(),
  })
  .strict();

export const ObserverBodySchema = z
  .object({
    snapshots: z.array(ObserverSnapshotSchema).max(OBSERVER_ROWS_MAX),
    sacct: z.array(ObserverSacctRowSchema).max(OBSERVER_ROWS_MAX),
  })
  .strict()
  .refine((b) => b.snapshots.length + b.sacct.length <= OBSERVER_ROWS_MAX, {
    message: "a post is at most 5,000 rows",
  });

export type ObserverBody = z.infer<typeof ObserverBodySchema>;

// --- Statements ---------------------------------------------------------------------------------------

export const INSERT_RUN_SQL = `INSERT INTO compute_observer_runs (id, nonce, expires_at)
  VALUES (?1, ?2, datetime('now', '+${OBSERVER_RUN_MINUTES} minutes'))`;

export const RUN_BY_ID_SQL =
  "SELECT id, nonce, status, expires_at, created_at FROM compute_observer_runs WHERE id = ?1";

/**
 * Spend a run: `?1` the run. One conditional UPDATE, so the first of two posts racing is the only one
 * to change a row, and a run past its hour changes none.
 */
export const CLAIM_RUN_SQL = `UPDATE compute_observer_runs SET status = 'ingested'
  WHERE id = ?1 AND status = 'issued' AND expires_at > datetime('now')`;

/** Give back a run whose store failed: `?1` the run. Only a run that was spent, and only within its hour. */
export const REOPEN_RUN_SQL = `UPDATE compute_observer_runs SET status = 'issued'
  WHERE id = ?1 AND status = 'ingested' AND expires_at > datetime('now')`;

/** Match stored rows to the jobs that carry their Slurm id. */
export const MATCH_ROWS_SQL = `UPDATE compute_sacct_rows SET matched_job_id =
    (SELECT j.id FROM compute_jobs j WHERE j.slurm_job_id = compute_sacct_rows.slurm_job_id LIMIT 1)
  WHERE matched_job_id IS NULL
    AND EXISTS (SELECT 1 FROM compute_jobs j WHERE j.slurm_job_id = compute_sacct_rows.slurm_job_id)`;

/**
 * The rows that can be settled now: matched to a job that has ended, has a provisional charge (a
 * `charge` entry closed its hold) and no final settlement, and whose Slurm state says it ended. Oldest
 * first; a row judged is never listed again (`applied_at`).
 */
export const CANDIDATE_ROWS_SQL = `SELECT s.slurm_job_id, s.partition AS sacct_partition, s.elapsed_seconds,
    s.alloc_nodes, s.alloc_cpus, s.alloc_gpus, s.alloc_mem_mb, s.charged_milli AS sacct_charged,
    j.id AS job_id, j.partition AS job_partition, j.charged_milli AS provisional_milli
  FROM compute_sacct_rows s JOIN compute_jobs j ON j.id = s.matched_job_id
  WHERE s.applied_at IS NULL AND s.state IN ${ENDED_SQL}
    AND j.state IN (${TERMINAL_STATES_SQL}) AND j.settled_provisional_at IS NOT NULL
    AND j.settled_final_at IS NULL AND j.flag_unreserved = 0 AND j.accounting = 'su'
    AND EXISTS (SELECT 1 FROM compute_ledger c WHERE c.job_id = j.id AND c.kind = 'charge')
  ORDER BY s.ingested_at ASC, s.slurm_job_id ASC LIMIT ?1`;

/** Stamp a job's final settlement from the ledger: `?1` the job, `?2` 1 to flag a mismatch. */
export const STAMP_FINAL_SQL = `UPDATE compute_jobs SET
    settled_final_at = datetime('now'),
    charged_milli = (SELECT COALESCE(SUM(e.charged_delta_milli), 0) FROM compute_ledger e
                      WHERE e.job_id = ?1),
    flag_mismatch = CASE WHEN ?2 = 1 THEN 1 ELSE flag_mismatch END
  WHERE id = ?1 AND settled_final_at IS NULL
    AND EXISTS (SELECT 1 FROM compute_ledger f WHERE f.idempotency_key = 'job:' || ?1 || ':final')`;

export const FLAG_ONLY_SQL = "UPDATE compute_jobs SET flag_mismatch = 1 WHERE id = ?1";

export const APPLIED_SQL =
  "UPDATE compute_sacct_rows SET applied_at = datetime('now') WHERE slurm_job_id = ?1 AND applied_at IS NULL";

// --- Minting -------------------------------------------------------------------------------------------

export type MintResult =
  | { ok: true; runId: string; token: string; expiresInMinutes: number }
  | { ok: false; code: "unconfigured" };

/**
 * Mint a one-hour run for the observer. The token is shown once, here; only the run is stored. The audit
 * row is in the same batch as the run. Needs the callback secret the other compute tokens use.
 */
export async function mintObserverRun(env: Bindings, actorUserId: number): Promise<MintResult> {
  const secret = env.PRESCREEN_CALLBACK_SECRET;
  if (!secret) return { ok: false, code: "unconfigured" };
  const runId = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(INSERT_RUN_SQL).bind(runId, nonce),
    auditLogStatement(env.DB, {
      userId: actorUserId,
      action: "compute.observer.mint",
      resourceType: "compute_observer_run",
      resourceId: runId,
      details: JSON.stringify({ minutes: OBSERVER_RUN_MINUTES }),
    }),
  ]);
  const digest = await signComputeToken("observer", { jobId: runId, nonce }, secret);
  return { ok: true, runId, token: `${runId}.${digest}`, expiresInMinutes: OBSERVER_RUN_MINUTES };
}

// --- Authorising a post -----------------------------------------------------------------------------------

const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface RunRow {
  id: string;
  nonce: string;
  status: string;
  expires_at: string;
}

/**
 * The run a token is for, or null for ANY reason: no token, a malformed token, an unknown run, a wrong
 * digest, a run that is spent, and a run past its hour. The same HMAC is computed whether or not the
 * run exists, so a missing run costs what a real one does. Nothing is written.
 */
export async function authorizeObserverRun(env: Bindings, token: string): Promise<RunRow | null> {
  const secret = env.PRESCREEN_CALLBACK_SECRET;
  const [runId = "", digest = "", ...rest] = token.split(".");
  const wellFormed = rest.length === 0 && RUN_ID_RE.test(runId) && /^[0-9a-f]{64}$/.test(digest);
  const row = wellFormed ? await env.DB.prepare(RUN_BY_ID_SQL).bind(runId).first<RunRow>() : null;
  const verified =
    !!secret &&
    (await verifyComputeToken(
      "observer",
      digest,
      { jobId: wellFormed ? runId : NO_NONCE, nonce: row?.nonce ?? NO_NONCE },
      secret,
    ));
  if (!verified || !wellFormed || row === null || row.status !== "issued") return null;
  const open = await env.DB.prepare(
    "SELECT 1 AS open FROM compute_observer_runs WHERE id = ?1 AND expires_at > datetime('now')",
  )
    .bind(row.id)
    .first<{ open: number }>();
  return open === null ? null : row;
}

// --- Ingest ---------------------------------------------------------------------------------------------

export interface IngestResult {
  snapshots: number;
  sacctRows: number;
  matched: number;
  settled: number;
  mismatched: number;
  unmatched: number;
  /** The rows are stored but the settlement failed; the daily sweep settles them. */
  settlementFailed?: true;
}

/**
 * A Slurm id seen again. The export repeats jobs, and a job first seen PENDING or RUNNING must not stay
 * that row for ever: while the stored row is not applied and its state is not an ended one, the new row
 * replaces it (the match to a job, `matched_job_id`, is kept). A row in an ended state, or one already
 * applied to the ledger, is Expanse's final word and keeps its first values.
 */
export const SACCT_UPSERT = `ON CONFLICT (slurm_job_id) DO UPDATE SET
    run_id = excluded.run_id, partition = excluded.partition, state = excluded.state,
    elapsed_seconds = excluded.elapsed_seconds, alloc_nodes = excluded.alloc_nodes,
    alloc_cpus = excluded.alloc_cpus, alloc_gpus = excluded.alloc_gpus,
    alloc_mem_mb = excluded.alloc_mem_mb, submit_time = excluded.submit_time,
    start_time = excluded.start_time, end_time = excluded.end_time,
    charged_milli = excluded.charged_milli, ingested_at = datetime('now')
  WHERE compute_sacct_rows.applied_at IS NULL AND compute_sacct_rows.state NOT IN ${ENDED_SQL}`;

const SACCT_COLUMNS =
  "(slurm_job_id, run_id, partition, state, elapsed_seconds, alloc_nodes, alloc_cpus, alloc_gpus, alloc_mem_mb, submit_time, start_time, end_time, charged_milli)";

/**
 * Spend the run and store the post. `null` when the run could not be spent (it was spent or expired
 * between the check and now); nothing is stored then. The body has been validated.
 */
export async function ingestObserverPost(
  env: Bindings,
  runId: string,
  body: ObserverBody,
): Promise<IngestResult | null> {
  const claimed = await env.DB.prepare(CLAIM_RUN_SQL).bind(runId).run();
  if ((claimed.meta?.changes ?? 0) !== 1) return null;

  const statements: D1PreparedStatement[] = [];
  for (const s of body.snapshots) {
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO compute_queue_snapshots (run_id, partition, pending, running) VALUES (?1, ?2, ?3, ?4)",
      ).bind(runId, s.partition, s.pending, s.running),
    );
  }
  for (let i = 0; i < body.sacct.length; i += ROWS_PER_INSERT) {
    const chunk = body.sacct.slice(i, i + ROWS_PER_INSERT);
    const values = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    statements.push(
      env.DB.prepare(
        `INSERT INTO compute_sacct_rows ${SACCT_COLUMNS} VALUES ${values} ${SACCT_UPSERT}`,
      ).bind(
        ...chunk.flatMap((r) => [
          r.slurm_job_id,
          runId,
          r.partition,
          r.state,
          r.elapsed_seconds,
          r.alloc_nodes,
          r.alloc_cpus,
          r.alloc_gpus,
          r.alloc_mem_mb,
          r.submit_time ?? null,
          r.start_time ?? null,
          r.end_time ?? null,
          r.charged_milli ?? null,
        ]),
      ),
    );
  }
  try {
    for (let i = 0; i < statements.length; i += STATEMENTS_PER_BATCH) {
      await env.DB.batch(statements.slice(i, i + STATEMENTS_PER_BATCH));
    }
  } catch (err) {
    // The run was spent before anything was stored; a store that failed partway must not leave a spent
    // token and half a post. The rows are idempotent (an upsert on the Slurm id, the snapshots ignore a
    // repeat), so the same token may post again. If even this fails, the run stays spent and an
    // administrator mints another.
    await env.DB.prepare(REOPEN_RUN_SQL)
      .bind(runId)
      .run()
      .catch(() => undefined);
    throw err;
  }

  // The rows are stored, so the post stands; a settlement that fails is the daily sweep's to do again.
  let settled: SettlePassResult = { matched: 0, settled: 0, mismatched: 0 };
  let settlementFailed = false;
  try {
    settled = await settleObservedRows(env);
  } catch (err) {
    settlementFailed = true;
    console.error(
      `[compute-observer] settlement_failed class=${err instanceof Error ? err.name : typeof err}`,
    );
  }
  const unmatched = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM compute_sacct_rows WHERE run_id = ?1 AND matched_job_id IS NULL",
  )
    .bind(runId)
    .first<{ n: number }>();
  return {
    snapshots: body.snapshots.length,
    sacctRows: body.sacct.length,
    matched: settled.matched,
    settled: settled.settled,
    mismatched: settled.mismatched,
    unmatched: unmatched?.n ?? 0,
    ...(settlementFailed ? { settlementFailed: true } : {}),
  };
}

// --- The settlement ----------------------------------------------------------------------------------------

/**
 * Whether a final figure is routine against the provisional one: within the policy's tolerance in milli-SU,
 * or within its tolerance as a percentage of the provisional charge. Integers throughout.
 */
export function isRoutineDifference(
  finalMilli: number,
  provisionalMilli: number,
  settle: ComputePolicy["settle"],
): boolean {
  const difference = Math.abs(finalMilli - provisionalMilli);
  return (
    difference <= settle.toleranceMilli ||
    difference * 100 <= settle.tolerancePercent * provisionalMilli
  );
}

const ceilDiv = (a: number, b: number): number => Math.ceil(a / Math.max(1, b));

interface Candidate {
  slurm_job_id: string;
  sacct_partition: string;
  elapsed_seconds: number;
  alloc_nodes: number;
  alloc_cpus: number;
  alloc_gpus: number;
  alloc_mem_mb: number;
  sacct_charged: number | null;
  job_id: string;
  job_partition: string;
  provisional_milli: number;
}

/** Expanse's figure for a row: what it says, else what the rate table gives for what it allocated; null when neither. */
export function expanseFigureMilli(c: Candidate): number | null {
  if (c.sacct_charged !== null) return c.sacct_charged;
  const partition = (PARTITION_NAMES as readonly string[]).includes(c.sacct_partition)
    ? c.sacct_partition
    : c.job_partition;
  if (!(PARTITION_NAMES as readonly string[]).includes(partition)) return null;
  const nodes = Math.max(1, c.alloc_nodes);
  try {
    return suMilliFor(
      partition as PartitionName,
      {
        nodes,
        cores: ceilDiv(c.alloc_cpus, nodes),
        memory_mb: ceilDiv(c.alloc_mem_mb, nodes),
        gpus: ceilDiv(c.alloc_gpus, nodes),
      },
      c.elapsed_seconds,
    );
  } catch {
    return null;
  }
}

export interface SettlePassResult {
  matched: number;
  settled: number;
  mismatched: number;
}

/**
 * Match every stored row that has a job, then settle up to `limit` of the rows whose job can take Expanse's
 * figure. Idempotent: a row settled is `applied_at`, a job settled has `settled_final_at`, and the
 * ledger's own key makes a second `settleFinal` a replay.
 */
export async function settleObservedRows(
  env: Bindings,
  limit: number = OBSERVER_SETTLE_PER_PASS,
): Promise<SettlePassResult> {
  const out: SettlePassResult = { matched: 0, settled: 0, mismatched: 0 };
  const matched = await env.DB.prepare(MATCH_ROWS_SQL).run();
  out.matched = matched.meta?.changes ?? 0;
  const { policy } = await getPolicy(env.DB);
  const rows = (await env.DB.prepare(CANDIDATE_ROWS_SQL).bind(limit).all<Candidate>()).results;
  for (const c of rows) {
    const figure = expanseFigureMilli(c);
    if (figure === null) {
      // Cannot be priced: flag it once and judge the row, so it is not tried for ever.
      await env.DB.batch([
        env.DB.prepare(FLAG_ONLY_SQL).bind(c.job_id),
        env.DB.prepare(APPLIED_SQL).bind(c.slurm_job_id),
      ]);
      out.mismatched++;
      continue;
    }
    const mismatch = !isRoutineDifference(figure, c.provisional_milli, policy.settle);
    const result = await settleFinal(env.DB, { jobId: c.job_id, finalMilli: figure });
    if (result.ok || result.code === "already_final") {
      await env.DB.batch([
        env.DB.prepare(STAMP_FINAL_SQL).bind(c.job_id, mismatch ? 1 : 0),
        env.DB.prepare(APPLIED_SQL).bind(c.slurm_job_id),
      ]);
      out.settled++;
      if (mismatch) out.mismatched++;
    } else {
      // `not_settled`, `refunded` or `would_go_negative`: the pools cannot take the correction. Flag and judge.
      await env.DB.batch([
        env.DB.prepare(FLAG_ONLY_SQL).bind(c.job_id),
        env.DB.prepare(APPLIED_SQL).bind(c.slurm_job_id),
      ]);
      out.mismatched++;
    }
  }
  return out;
}
