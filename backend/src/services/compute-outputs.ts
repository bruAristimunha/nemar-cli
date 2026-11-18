/**
 * The launcher's outputs and complete steps (epic #2005 phase A5, #2010; ADR 0118; design section 7,
 * "The launcher on Expanse" and "Results"): what happens between a launcher declaring its results and
 * the Worker letting a Tapis `FINISHED` stand.
 *
 * THE ORDER IS THE POINT. No upload address is issued before every check has passed:
 *  1. the request is a valid `OutputsRequest` (closed, the contract's own path predicate, each launcher
 *     file named once, no path twice);
 *  2. the number of outputs is within the policy's `resultLimits.maxFiles` (`too_many_outputs`);
 *  3. no file is over `RESULT_MAX_FILE_BYTES` (5 GB, until presigned multipart is verified on R2) and
 *     the whole is within the job limit `resultLimits.maxJobBytes` (`results_too_large`);
 *  4. the bytes are CLAIMED in ONE conditional UPDATE of `results_bytes` whose WHERE holds the person's
 *     share and the platform's total (`results_quota_exceeded`): the two sums are read INSIDE the
 *     statement that writes, so two jobs racing for the last bytes cannot both win. (Reading a sum in
 *     one query and writing in another is the mistake that statement exists to prevent.) A job with no
 *     account has no person's share, and the platform total still applies. The quota counts a job's bytes
 *     until its results have expired (the job ended longer ago than the policy's results retention).
 * `limits.max_total_bytes` of the launch specification bounds the dataset selection and is NOT this
 * limit: the per-job results limit is the policy's own, and the two numbers are never one.
 *
 * A REFUSAL records itself: the word is written as the job's `failure_detail` (a conditional UPDATE that
 * never replaces one already there, so the first refusal is the reason), the launcher's four own files
 * are STILL presigned (its result and log are how the failure is explained), and the job then ends
 * `result_upload_failed`, charged, because the submitter caused it (`isPlatformFailure` knows each).
 * The launcher then asks again with no outputs, which is accepted: the declared file and the claimed bytes
 * are those of the launcher's four files alone, and no quota is applied to them (they are small, NEMAR's
 * own, and the job is already failing); `failure_detail` is never cleared. A request that names outputs
 * after a refusal is refused again with the recorded word.
 *
 * `declared.json` (under the job's prefix, outside the two prefixes an address is signed for) is written
 * through the binding after the claim, and is what `complete` and the verification read. A replay of the
 * same request re-presigns and changes nothing; another body for a job that has claimed is `bad_state`.
 * Addresses live one hour and are asked for again after expiry, never after `complete` (a holder of the
 * token could otherwise overwrite objects with same-size content before verification).
 *
 * `complete` lists the declared objects (not one head each: a job may declare thousands, and a Worker
 * invocation makes a bounded number of subrequests) and answers 409 `results_incomplete`, retryable, for
 * a missing or short one; it sets `outputs_completed_at` once and is idempotent.
 */

import {
  COMPUTE_REFUSAL_STATUS,
  TERMINAL_COMPUTE_STATES,
  resultRefusalOf,
} from "../../../shared/compute-state.js";
import {
  OutputsRequestSchema,
  resultsLauncherKey,
  resultsOutputKey,
} from "../../../shared/contract/compute-launch.js";
import {
  LAUNCHER_FILES,
  LAUNCHER_FILE_NAMES,
  RESULT_MAX_FILE_BYTES,
  computeIsWellFormed,
} from "../../../shared/contract/compute.js";
import type { Bindings } from "../types/bindings.js";
import { type ComputeJobRow, TERMINAL_STATES_SQL, getJob } from "./compute-jobs.js";
import { getPolicy } from "./compute-policy.js";
import { outputsBodyLimitBytes } from "./compute-records.js";
import { COMPUTE_UPLOAD_SECONDS, computeS3, objectKeyProblem, presignPut } from "./compute-s3.js";
import { declaredKey, declaredText, firstIncomplete, readDeclared } from "./compute-verify.js";

/**
 * Claim the declared bytes: `?1` the job, `?2` the bytes, `?3` 1 to skip the quotas (the launcher's own
 * files after a refusal), `?4` the window as a SQLite modifier (`-30 days`), `?5` the person's share,
 * `?6` the platform's total. ONE statement: the person's other unexpired totals and every other job's
 * unexpired totals are read inside it, so D1 serialises two claims and the second sees the first.
 * `meta.changes` is the winner test, and a refused claim writes nothing.
 *
 * `?3 = 1` (the launcher's follow-up, its own four files after a refusal) skips only the PERSON'S share:
 * those files are small and the person did not choose them. The platform's total is NEVER skipped
 * (round 1 of #2041): a follow-up claim is bytes in the bucket like any other, and a launcher that could
 * declare any size there would not be held to the platform's limit at all. Each launcher file is also
 * capped on its own (`launcherFileCap`).
 *
 * `?7` and `?8` are the LEASE a runner job's caller proved (ADR 0121, at most once acceptance): `?7` is 1 for
 * a job that is not a Tapis job and `?8` the lease id the route checked against the header; the row must
 * STILL hold that lease (`IS`, so a cleared one is no match), so a request that passed the route's check
 * before the lease was released or revoked changes nothing. A Tapis job binds 0 and NULL.
 */
export const CLAIM_RESULTS_BYTES_SQL = `UPDATE compute_jobs SET results_bytes = ?2
  WHERE id = ?1 AND results_bytes IS NULL AND outputs_completed_at IS NULL
    AND state NOT IN (${TERMINAL_STATES_SQL}) AND (?7 = 0 OR lease_id IS ?8)
    AND (?3 = 1 OR account_id IS NULL OR (SELECT COALESCE(SUM(o.results_bytes), 0) FROM compute_jobs o
         WHERE o.account_id = compute_jobs.account_id AND o.id <> compute_jobs.id
           AND o.results_bytes IS NOT NULL
           AND (o.ended_at IS NULL OR o.ended_at > datetime('now', ?4))) + ?2 <= ?5)
    AND (SELECT COALESCE(SUM(o.results_bytes), 0) FROM compute_jobs o
          WHERE o.id <> compute_jobs.id AND o.results_bytes IS NOT NULL
            AND (o.ended_at IS NULL OR o.ended_at > datetime('now', ?4))) + ?2 <= ?6`;

/**
 * A refusal records itself as the job's `failure_detail`, once: `?1` the job, `?2` the word, `?3` and `?4` the
 * lease of a runner job as in {@link CLAIM_RESULTS_BYTES_SQL} (`?3` 1 for a non-Tapis job, `?4` the lease).
 */
export const RECORD_REFUSAL_SQL = `UPDATE compute_jobs SET failure_detail = ?2
  WHERE id = ?1 AND failure_detail IS NULL AND state NOT IN (${TERMINAL_STATES_SQL})
    AND (?3 = 0 OR lease_id IS ?4)`;

/**
 * The launcher completed: once, and only while the job is live. `?1` the job, `?2` and `?3` the lease of a
 * runner job as in {@link CLAIM_RESULTS_BYTES_SQL} (`?2` 1 for a non-Tapis job, `?3` the lease).
 */
export const COMPLETE_OUTPUTS_SQL = `UPDATE compute_jobs SET outputs_completed_at = datetime('now')
  WHERE id = ?1 AND outputs_completed_at IS NULL AND state NOT IN (${TERMINAL_STATES_SQL})
    AND (?2 = 0 OR lease_id IS ?3)`;

/** The lease a runner job's caller proved, as the two binds of the statements above: `[flag, lease]`. */
const leaseBinds = (job: Pick<ComputeJobRow, "executor" | "lease_id">): [number, string | null] => [
  job.executor === "tapis" ? 0 : 1,
  job.lease_id ?? null,
];

/**
 * The most bytes the launcher's log may declare: 16 MiB. The records keep the first 5 MiB of it
 * (`LOG_COPY_MAX_BYTES`), so the launcher is expected to stay far below; this is the Worker's own bound,
 * so a launcher cannot declare an unbounded file as one of its "own four".
 */
export const LAUNCHER_LOG_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The most one launcher file may declare: a JSON document is bounded by what the records copy accepts
 * (the outputs body's bound for the owner's `maxFiles`, since the manifest lists every output) and the
 * log by `LAUNCHER_LOG_MAX_BYTES`.
 */
export function launcherFileCap(name: string, maxFiles: number): number {
  return name === LAUNCHER_FILES.log ? LAUNCHER_LOG_MAX_BYTES : outputsBodyLimitBytes(maxFiles);
}

export type OutputsRefusalCode =
  | "too_many_outputs"
  | "results_too_large"
  | "results_quota_exceeded"
  | "invalid_spec"
  | "bad_state"
  | "compute_disabled";

export interface Upload {
  path: string;
  url: string;
}

export type OutputsResult =
  | { ok: true; status: 200; uploads: Upload[]; expires_at: string }
  | {
      ok: false;
      code: OutputsRefusalCode;
      status: number;
      /** For a refusal the submitter caused: the launcher's own four files, still presigned. */
      uploads?: Upload[];
      expires_at?: string;
      field?: string;
    };

const refuse = (code: OutputsRefusalCode, field?: string): OutputsResult =>
  field === undefined
    ? { ok: false, code, status: COMPUTE_REFUSAL_STATUS[code] }
    : { ok: false, code, status: COMPUTE_REFUSAL_STATUS[code], field };

/** The four launcher files of a job, presigned for an hour; null when the signer is not configured. */
async function presignLauncher(
  env: Bindings,
  jobId: string,
): Promise<{ uploads: Upload[]; expires_at: string } | null> {
  const s3 = computeS3(env);
  if (!s3) return null;
  const uploads: Upload[] = [];
  let expires = "";
  for (const name of LAUNCHER_FILE_NAMES) {
    const signed = await presignPut(s3, "results", resultsLauncherKey(jobId, name), {
      expiresIn: COMPUTE_UPLOAD_SECONDS,
    });
    uploads.push({ path: `launcher/${name}`, url: signed.url });
    expires = expires === "" || signed.expires_at < expires ? signed.expires_at : expires;
  }
  return { uploads, expires_at: expires };
}

/** Refuse for a reason the submitter caused: record it, and still presign the launcher's four files. */
async function refuseAndRecord(
  env: Bindings,
  job: ComputeJobRow,
  code: "too_many_outputs" | "results_too_large" | "results_quota_exceeded",
): Promise<OutputsResult> {
  await env.DB.prepare(RECORD_REFUSAL_SQL)
    .bind(job.id, code, ...leaseBinds(job))
    .run();
  console.warn(`[compute-outputs] refused job=${job.id} code=${code}`);
  const launcher = await presignLauncher(env, job.id);
  return launcher === null
    ? refuse(code)
    : { ...refuse(code), uploads: launcher.uploads, expires_at: launcher.expires_at };
}

/**
 * The outputs route's decision for an authorised job and a parsed or unparsed body. `body` is the JSON
 * the launcher sent (any value: it is checked here), or `"too_large"` for a body over the derived cap.
 */
export async function handleOutputs(
  env: Bindings,
  job: ComputeJobRow,
  body: unknown,
): Promise<OutputsResult> {
  const bucket = env.COMPUTE_RESULTS;
  if (!bucket || !computeS3(env)) return refuse("compute_disabled");
  let policy: Awaited<ReturnType<typeof getPolicy>>["policy"];
  try {
    policy = (await getPolicy(env.DB)).policy;
  } catch {
    return refuse("compute_disabled");
  }
  // After `complete` no address is issued: a token holder could overwrite same-size objects.
  if (job.outputs_completed_at !== null) return refuse("bad_state");

  const recorded = resultRefusalOf(job.failure_detail);
  if (body === "too_large") return refuseAndRecord(env, job, recorded ?? "too_many_outputs");

  const parsed = OutputsRequestSchema.safeParse(body);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path ?? [];
    return refuse("invalid_spec", path.length > 0 ? path.join(".") : undefined);
  }
  const { outputs, launcher } = parsed.data;
  const seen = new Set<string>();
  for (const [i, o] of outputs.entries()) {
    if (seen.has(o.path)) return refuse("invalid_spec", `outputs.${i}.path`);
    seen.add(o.path);
    // A path the schema accepts can still be one no address can be signed for (the key is over 1,024
    // bytes of UTF-8 for a long multi-byte name, or the name holds a lone surrogate, which the stored
    // declaration and the key would each write differently). Found here, BEFORE the claim; found after
    // it, the route answered 500 and the replay 409 with the bytes claimed for nothing.
    if (
      !computeIsWellFormed(o.path) ||
      objectKeyProblem(resultsOutputKey(job.id, o.path)) !== null
    ) {
      return refuse("invalid_spec", `outputs.${i}.path`);
    }
  }

  // A refusal already recorded: a follow-up with no outputs is the launcher's way to upload its own
  // files and is accepted; a request that names outputs is refused again with the recorded word.
  if (recorded !== null && outputs.length > 0) return refuseAndRecord(env, job, recorded);

  if (outputs.length > policy.resultLimits.maxFiles) {
    return refuseAndRecord(env, job, "too_many_outputs");
  }
  const sizes = [...outputs.map((o) => o.size), ...launcher.map((f) => f.size)];
  const total = sizes.reduce((sum, n) => sum + n, 0);
  if (
    sizes.some((n) => n > RESULT_MAX_FILE_BYTES) ||
    launcher.some((f) => f.size > launcherFileCap(f.name, policy.resultLimits.maxFiles)) ||
    total > policy.resultLimits.maxJobBytes
  ) {
    return refuseAndRecord(env, job, "results_too_large");
  }
  if (!Number.isSafeInteger(total)) return refuseAndRecord(env, job, "results_too_large");

  // The claim: ONE conditional UPDATE, the sums read inside it.
  const claimed = await env.DB.prepare(CLAIM_RESULTS_BYTES_SQL)
    .bind(
      job.id,
      total,
      recorded !== null ? 1 : 0,
      `-${policy.retention.resultsDays} days`,
      policy.resultLimits.maxStoredBytesPerPerson,
      policy.resultLimits.maxStoredBytesTotal,
      ...leaseBinds(job),
    )
    .run();
  const text = declaredText(job.id, outputs, launcher);
  if ((claimed.meta?.changes ?? 0) !== 1) {
    const now = await getJob(env.DB, job.id);
    if (!now || TERMINAL_COMPUTE_STATES.includes(now.state as never)) return refuse("bad_state");
    // A runner job whose lease is no longer the one this request proved belongs to another holder: this
    // request is stale. It records nothing (a refusal written here would land under the NEW lease and count
    // against the new holder's job) and presigns nothing.
    if (job.executor !== "tapis" && now.lease_id !== job.lease_id) return refuse("bad_state");
    if (now.results_bytes === null) return refuseAndRecord(env, now, "results_quota_exceeded");
    // Claimed already: a replay is the same declaration, and only that.
    const same = now.results_bytes === total && (await declaredMatches(bucket, job.id, text));
    if (!same) return refuse("bad_state");
  }

  // The declared file, written through the binding; an existing one must be this request's.
  const there = await readDeclaredText(bucket, job.id);
  if (there === null) {
    await bucket.put(declaredKey(job.id), new TextEncoder().encode(text), {
      httpMetadata: { contentType: "application/json" },
    });
  } else if (there !== text) {
    return refuse("bad_state");
  }

  const s3 = computeS3(env);
  if (!s3) return refuse("compute_disabled");
  const uploads: Upload[] = [];
  let expires = "";
  for (const o of outputs) {
    const signed = await presignPut(s3, "results", resultsOutputKey(job.id, o.path), {
      expiresIn: COMPUTE_UPLOAD_SECONDS,
    });
    uploads.push({ path: `outputs/${o.path}`, url: signed.url });
    expires = expires === "" || signed.expires_at < expires ? signed.expires_at : expires;
  }
  const own = await presignLauncher(env, job.id);
  if (own === null) return refuse("compute_disabled");
  uploads.push(...own.uploads);
  if (expires === "" || own.expires_at < expires) expires = own.expires_at;
  return { ok: true, status: 200, uploads, expires_at: expires };
}

async function readDeclaredText(bucket: R2Bucket, jobId: string): Promise<string | null> {
  const object = await bucket.get(declaredKey(jobId));
  return object ? await object.text() : null;
}

async function declaredMatches(bucket: R2Bucket, jobId: string, text: string): Promise<boolean> {
  const there = await readDeclaredText(bucket, jobId);
  return there === null || there === text;
}

export type CompleteResult =
  | { ok: true; status: 200; replayed: boolean }
  | { ok: false; status: number; code: "results_incomplete" | "bad_state" | "compute_disabled" };

/**
 * The launcher says its upload is done. Every declared object (the outputs and the four launcher files)
 * must be in the bucket with the exact declared size, else 409 `results_incomplete`, which is retryable
 * (the launcher uploads what is missing and asks again). It sets `outputs_completed_at` once; a second
 * call, on a 409 the launcher saw or an answer it lost, answers the same 200 and writes nothing.
 */
export async function handleComplete(env: Bindings, job: ComputeJobRow): Promise<CompleteResult> {
  const bucket = env.COMPUTE_RESULTS;
  if (!bucket)
    return { ok: false, status: COMPUTE_REFUSAL_STATUS.compute_disabled, code: "compute_disabled" };
  if (job.outputs_completed_at !== null) return { ok: true, status: 200, replayed: true };
  const declared = await readDeclared(bucket, job.id);
  if (declared.kind !== "ok") {
    return { ok: false, status: COMPUTE_REFUSAL_STATUS.bad_state, code: "bad_state" };
  }
  if ((await firstIncomplete(bucket, declared.value)) !== null) {
    return {
      ok: false,
      status: COMPUTE_REFUSAL_STATUS.results_incomplete,
      code: "results_incomplete",
    };
  }
  const wrote = await env.DB.prepare(COMPLETE_OUTPUTS_SQL)
    .bind(job.id, ...leaseBinds(job))
    .run();
  if ((wrote.meta?.changes ?? 0) === 1) return { ok: true, status: 200, replayed: false };
  const now = await getJob(env.DB, job.id);
  if (now?.outputs_completed_at != null) return { ok: true, status: 200, replayed: true };
  return { ok: false, status: COMPUTE_REFUSAL_STATUS.bad_state, code: "bad_state" };
}

/** The body cap of the outputs route for the owner's current policy: derived from `maxFiles`, never under 1 MiB. */
export async function outputsBodyCap(env: Bindings): Promise<number> {
  const { policy } = await getPolicy(env.DB);
  return outputsBodyLimitBytes(policy.resultLimits.maxFiles);
}
