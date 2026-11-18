/**
 * The launcher's three job callbacks (epic #2005 phase A5, #2010; ADR 0118; design section 7, "The
 * launcher on Expanse" and "The launch specification"):
 *
 *   POST /compute/jobs/:id/bundle             a 10-minute presigned GET of THIS job's own code bundle
 *   POST /compute/jobs/:id/outputs            what the job produced, and an upload address for each file
 *   POST /compute/jobs/:id/outputs/complete   the uploads are done
 *
 * They are registered on the compute router with no session: the launcher runs on a node, holds no
 * account and no storage credential, and authenticates with ONE per-job token.
 *
 * THE TOKEN is the launch specification's `job_token`, an HMAC (domain tag `compute-job`) over the job
 * and its `webhook_nonce`, sent in the header `X-Compute-Job-Token` and NEVER in a URL (a token in a
 * URL reaches logs, and a token in the address of a request that has no header is refused like any
 * other). It is checked in constant time against the job's nonce, and it stops working the moment the
 * job is TERMINAL (the extra day the webhook address lives is for the webhook only): a launcher that
 * outlives its job, a cancelled one included, is refused.
 *
 * EVERY REFUSAL OF THE TOKEN IS ONE ANSWER, the same status and body on all three routes: a wrong
 * token, another job's token, a cleared nonce, a terminal job, no header, a malformed job id and a job
 * that does not exist (and, for `bundle`, a job that has no bundle). The door says nothing about which
 * jobs exist or why it refused. Only then, for a verified token, are the other answers given.
 *
 * The bundle address is made by `presignBundleRead`, from the job id the token was verified for and
 * nothing the request carries: no path, no key and no query is read, so there is nothing to steer it to
 * another record. Bodies are bounded (1 MiB for `bundle` and `complete`, which need none; the outputs
 * route derives its bound from the owner's `maxFiles`, never under 1 MiB, see `outputsBodyLimitBytes`).
 *
 * A RUNNER JOB ALSO NEEDS THE CURRENT LEASE (portable compute, ADR 0121 decision 4: at most once acceptance).
 * For `executor = 'runner'` only, the header `X-Compute-Lease` must be a well-formed lease id and equal to the
 * row's `lease_id`, which must itself be present: a missing header, a malformed one, or a row whose lease was
 * cleared (a revoke does that) is the same single refusal, never compared as equal. A Tapis job's path is
 * untouched.
 *
 * Nothing here logs a token, an address or a path: a line carries the job id and a fixed word.
 */

import type { Context, Hono } from "hono";
import {
  COMPUTE_REFUSAL_STATUS,
  COMPUTE_ROUTE_SENTENCES,
  type ComputeRouteSentenceCode,
  isTerminalComputeState,
} from "../../../../shared/compute-state.js";
import { COMPUTE_JOB_TOKEN_HEADER } from "../../../../shared/contract/compute-launch.js";
import { LEASE_ID_RE, RUNNER_LEASE_HEADER } from "../../../../shared/contract/compute-runner.js";
import { COMPUTE_JOB_ID_RE } from "../../../../shared/contract/compute.js";
import { type ComputeJobRow, getJob } from "../../services/compute-jobs.js";
import { handleComplete, handleOutputs, outputsBodyCap } from "../../services/compute-outputs.js";
import { presignBundleRead } from "../../services/compute-records.js";
import { NO_NONCE, verifyComputeToken } from "../../services/compute-tokens.js";
import type { Bindings, Variables } from "../../types/bindings.js";
import { readBoundedJsonObject } from "./bounded-json.js";

type Router = Hono<{ Bindings: Bindings; Variables: Variables }>;
type Ctx = Context<{ Bindings: Bindings; Variables: Variables }>;

/** The most bytes a body without a schema may declare: the launcher's own request cap. */
const SMALL_BODY_BYTES = 1024 * 1024;

/** The one refusal of a token, a job and a bundle: `job_not_found`, which never says why. */
const refused = (c: Ctx) =>
  c.json(
    { error: COMPUTE_ROUTE_SENTENCES.job_not_found, code: "job_not_found" },
    COMPUTE_REFUSAL_STATUS.job_not_found,
  );

/** A refusal with a word of the gateway's own (the three outputs refusals, `results_incomplete`, ...). */
const answer = (c: Ctx, status: number, code: ComputeRouteSentenceCode, extra: object = {}) =>
  c.json({ error: COMPUTE_ROUTE_SENTENCES[code], code, ...extra }, status as 400);

/** The job a verified token names, or null for any reason at all. */
async function authorize(c: Ctx): Promise<ComputeJobRow | null> {
  const id = c.req.param("id") ?? "";
  const token = c.req.header(COMPUTE_JOB_TOKEN_HEADER) ?? "";
  const secret = c.env.PRESCREEN_CALLBACK_SECRET;
  const wellFormed = COMPUTE_JOB_ID_RE.test(id);
  const job = wellFormed ? await getJob(c.env.DB, id) : null;
  const nonce = job?.webhook_nonce ?? null;
  // The same HMAC whether or not the job exists, so a missing job costs what a real one does.
  const valid =
    !!secret &&
    (await verifyComputeToken("job", token, { jobId: id, nonce: nonce ?? NO_NONCE }, secret));
  if (!valid || !job || nonce === null || isTerminalComputeState(job.state)) return null;
  // FAIL CLOSED: anything that is not a Tapis job needs the lease, so a row read without its `executor`
  // (a column list that lost it in a merge) is refused rather than let through.
  if (job.executor !== "tapis" && !holdsCurrentLease(c, job)) return null;
  return job;
}

/**
 * Whether the request carries the runner job's current lease: the header and the row's value must BOTH be
 * present and well formed, and equal. A NULL on either side is a refusal (`(header ?? null) === row.lease_id`
 * would call two NULLs equal, which is the bug this is written to avoid).
 */
function holdsCurrentLease(c: Ctx, job: ComputeJobRow): boolean {
  const header = c.req.header(RUNNER_LEASE_HEADER);
  const held = job.lease_id;
  if (typeof header !== "string" || typeof held !== "string") return false;
  if (!LEASE_ID_RE.test(header) || !LEASE_ID_RE.test(held)) return false;
  return header === held;
}

/** A body that declares more than `max` bytes is refused before a byte of it is read. */
const declaredTooLarge = (c: Ctx, max: number): boolean => {
  const declared = Number(c.req.header("Content-Length") ?? "0");
  return Number.isFinite(declared) && declared > max;
};

export function registerComputeJobCallbackRoutes(router: Router): void {
  router.post("/jobs/:id/bundle", async (c) => {
    const job = await authorize(c);
    if (!job) return refused(c);
    if (declaredTooLarge(c, SMALL_BODY_BYTES)) return answer(c, 413, "invalid_spec");
    // The key is the job's own, made from the verified id: nothing in the request is read.
    const signed = await presignBundleRead(c.env, job.id);
    if (!signed.ok) {
      return signed.code === "compute_disabled"
        ? answer(c, COMPUTE_REFUSAL_STATUS.compute_disabled, "compute_disabled")
        : refused(c);
    }
    return c.json({ url: signed.url, expires_at: signed.expires_at });
  });

  router.post("/jobs/:id/outputs", async (c) => {
    const job = await authorize(c);
    if (!job) return refused(c);
    let cap: number;
    try {
      cap = await outputsBodyCap(c.env);
    } catch {
      // The cap comes from the owner's policy, read from the database: a failure here is a transient fault
      // of the Worker's own, not the platform being off. 503 as before, with its own word, so the launcher
      // is not told that compute is disabled (and does not stop) because a read failed.
      return answer(c, COMPUTE_REFUSAL_STATUS.policy_unavailable, "policy_unavailable");
    }
    const read = await readBoundedJsonObject(c, cap);
    // A body over the derived cap is more outputs than the owner allows: the submitter's, and charged.
    const body: unknown = read.ok ? read.body : read.status === 413 ? "too_large" : null;
    if (body === null) return answer(c, 400, "invalid_spec");
    const result = await handleOutputs(c.env, job, body);
    if (result.ok) return c.json({ uploads: result.uploads, expires_at: result.expires_at });
    return answer(c, result.status, result.code, {
      ...(result.field === undefined ? {} : { field: result.field }),
      ...(result.uploads === undefined
        ? {}
        : { uploads: result.uploads, expires_at: result.expires_at }),
    });
  });

  router.post("/jobs/:id/outputs/complete", async (c) => {
    const job = await authorize(c);
    if (!job) return refused(c);
    if (declaredTooLarge(c, SMALL_BODY_BYTES)) return answer(c, 413, "invalid_spec");
    const result = await handleComplete(c.env, job);
    if (result.ok) return c.json({ ok: true });
    return answer(c, result.status, result.code);
  });
}
