/**
 * A runner's own routes, mounted at `/compute/runners` (portable compute, card DM-05; decision D4;
 * protocol `nemar.runner.v1`):
 *
 *   POST /compute/runners/token   the runner's SECRET (`Authorization: Bearer nmr_...`) buys one access
 *                                 token for 900 seconds; the body is `RunnerTokenRequestSchema`
 *   GET  /compute/runners/me      the runner's id, name and capacity, with an ACCESS token (`nmra_...`)
 *   POST /compute/runners/claim      up to `free_slots` waiting jobs, each with its own lease (DM-07)
 *   POST /compute/runners/heartbeat  renew one job's lease, report its phase, learn whether to stop it
 *   POST /compute/runners/complete   the end of one job, idempotent for `(job, lease_id)`
 *
 * The last three take an ACCESS token (`runnerAccess`) and strict bodies of at most 4 KiB (a claim) or 8 KiB.
 * The claim runs `sweepRunnerLeases` first, so a runner that polls drives the lease rules in every
 * environment. `lease_lost` (409) is the one answer for a job that is not this runner's current lease.
 *
 * No session and no API key: a runner holds neither. The two credentials are refused by every other path
 * (`middleware/auth.ts`, `runner_credential_not_accepted`), and `runnerAccess` below is the ONLY door an
 * access token opens. Every refusal is `{ error: <word> }` with the status of `RUNNER_REFUSAL_STATUS`,
 * the words of `RUNNER_REFUSALS`: a runner reads the word, never a sentence.
 *
 * THE ORDER IS THE POINT. The switch comes first (`runners_disabled`, 503, whatever the credential);
 * then the credential, with ONE answer for every way it can be wrong (`runner_unknown`: no header, a
 * header of another shape, a secret that was never issued or is revoked); and only for a valid secret is
 * the body read, so a caller without one learns nothing about what a body must hold. The body is read
 * under a 1 KiB bound. A protocol other than `nemar.runner.v1` is `protocol_unsupported` (426), and any
 * other body fault is `invalid_body`. An access token that is past its end is `runner_token_expired`;
 * one a revoke deleted is `runner_unknown`.
 *
 * The routes are pinned by `backend/test/compute-route-inventory.test.ts`. Nothing here logs a credential,
 * and no credential is ever in a URL.
 */

import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { RUNNER_REFUSAL_STATUS, type RunnerRefusal } from "../../../shared/compute-state.js";
import {
  RUNNER_ACCESS_TOKEN_RE,
  RUNNER_PROTOCOL,
  RUNNER_SECRET_RE,
  RunnerClaimRequestSchema,
  RunnerCompleteRequestSchema,
  RunnerHeartbeatRequestSchema,
  RunnerTokenRequestSchema,
} from "../../../shared/contract/compute-runner.js";
import {
  RUNNER_MIN_VERSION,
  claimRunnerJobs,
  completeRunnerJob,
  heartbeatRunnerJob,
  runnerLeaseLogLine,
  runnerVersionAtLeast,
  sweepRunnerLeases,
} from "../services/compute-runner-queue.js";
import {
  exchangeRunnerSecret,
  findRunnerBySecret,
  resolveRunnerAccess,
} from "../services/compute-runners.js";
import { computeRunnersEnabled } from "../services/compute-switches.js";
import type { Bindings, Variables } from "../types/bindings.js";
import { readBoundedJsonObject } from "./callbacks/bounded-json.js";

type Env = { Bindings: Bindings; Variables: Variables };
type Ctx = Context<Env>;

/** The most bytes the token request reads: its two fields are at most a few dozen characters. */
export const RUNNER_TOKEN_BODY_MAX_BYTES = 1024;

/** The most bytes a claim reads: a protocol word, a count, up to three runtimes, an architecture and a version. */
export const RUNNER_CLAIM_BODY_MAX_BYTES = 4096;

/** The most bytes a heartbeat or a completion reads: a few ids, words and numbers. */
export const RUNNER_REPORT_BODY_MAX_BYTES = 8192;

export const computeRunnerRoutes = new Hono<Env>();

const refuse = (c: Ctx, word: RunnerRefusal) =>
  c.json({ error: word }, RUNNER_REFUSAL_STATUS[word]);

/** The bearer value of the request, or "" when the header is absent or is not `Bearer <value>`. */
function bearerOf(c: Ctx): string {
  const header = c.req.header("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.substring(7) : "";
}

/**
 * The door of a runner's access token: the switch, then an `nmra_` token of an unrevoked registration
 * that has not expired. Sets `c.var.runner`. Named so the inventory test can see it on a route.
 */
export const runnerAccess: MiddlewareHandler<Env> = async function runnerAccess(c, next) {
  if (!computeRunnersEnabled(c.env)) return refuse(c, "runners_disabled");
  const token = bearerOf(c);
  if (!RUNNER_ACCESS_TOKEN_RE.test(token)) return refuse(c, "runner_unknown");
  const access = await resolveRunnerAccess(c.env.DB, token);
  if (access.kind === "expired") return refuse(c, "runner_token_expired");
  if (access.kind !== "ok") return refuse(c, "runner_unknown");
  c.set("runner", access.runner);
  await next();
};

computeRunnerRoutes.post("/token", async (c) => {
  if (!computeRunnersEnabled(c.env)) return refuse(c, "runners_disabled");
  c.header("Cache-Control", "no-store");
  const secret = bearerOf(c);
  const runner = RUNNER_SECRET_RE.test(secret) ? await findRunnerBySecret(c.env.DB, secret) : null;
  if (!runner) return refuse(c, "runner_unknown");

  const read = await readBoundedJsonObject(c, RUNNER_TOKEN_BODY_MAX_BYTES);
  if (!read.ok) return refuse(c, "invalid_body");
  // Another protocol is its own answer, so a runner built for a later one is told to upgrade and is not
  // told its body was malformed.
  if (typeof read.body.protocol === "string" && read.body.protocol !== RUNNER_PROTOCOL) {
    return refuse(c, "protocol_unsupported");
  }
  const parsed = RunnerTokenRequestSchema.safeParse(read.body);
  if (!parsed.success) return refuse(c, "invalid_body");

  const issued = await exchangeRunnerSecret(c.env.DB, runner.id, parsed.data.runner_version);
  // A revoke between the lookup and the batch leaves no token: the same answer as an unknown secret.
  if (!issued) return refuse(c, "runner_unknown");
  return c.json({ access_token: issued.accessToken, expires_at: issued.expiresAt });
});

computeRunnerRoutes.get("/me", runnerAccess, (c) => {
  const runner = c.get("runner");
  if (!runner) return refuse(c, "runner_unknown");
  return c.json({
    runner_id: runner.id,
    name: runner.name,
    pool: runner.pool,
    cores: runner.cores,
    memory_mb: runner.memory_mb,
    gpus: runner.gpus,
    scratch_gb: runner.scratch_gb,
    backend: runner.backend,
    runtimes: runner.runtimes,
    arch: runner.arch,
    accounting: runner.accounting,
    site: runner.site,
    trust: runner.trust,
  });
});

/** The body of an authenticated runner request, bounded, with another protocol answered as its own refusal. */
async function readRunnerBody(c: Ctx, max: number) {
  const read = await readBoundedJsonObject(c, max);
  if (!read.ok) return { ok: false as const, response: refuse(c, "invalid_body") };
  if (typeof read.body.protocol === "string" && read.body.protocol !== RUNNER_PROTOCOL) {
    return { ok: false as const, response: refuse(c, "protocol_unsupported") };
  }
  return { ok: true as const, body: read.body };
}

computeRunnerRoutes.post("/claim", runnerAccess, async (c) => {
  const runner = c.get("runner");
  if (!runner) return refuse(c, "runner_unknown");
  c.header("Cache-Control", "no-store");
  const read = await readRunnerBody(c, RUNNER_CLAIM_BODY_MAX_BYTES);
  if (!read.ok) return read.response;
  const parsed = RunnerClaimRequestSchema.safeParse(read.body);
  if (!parsed.success) return refuse(c, "invalid_body");
  if (!runnerVersionAtLeast(parsed.data.runner_version)) return refuse(c, "runner_outdated");
  // The lease rules run whenever a runner polls, in every environment; a fault here never fails the claim.
  // Only the cheap steps run before the answer: the verification of outputs, the replay of records and the
  // copies of the launcher's files go to `waitUntil`, so a poll never waits on the results bucket.
  let deferred = false;
  const defer = (work: Promise<unknown>) => {
    deferred = true;
    try {
      c.executionCtx.waitUntil(work);
    } catch {
      void work;
    }
  };
  try {
    const swept = await sweepRunnerLeases(c.env, c.env.DB, { defer });
    const line = deferred ? null : runnerLeaseLogLine(swept);
    if (line?.level === "error") console.error(line.line);
    else if (line) console.log(line.line);
  } catch (err) {
    console.error(
      `[compute-runner-queue] sweep_failed class=${err instanceof Error ? err.name : typeof err}`,
    );
  }
  const claimed = await claimRunnerJobs(c.env, runner, parsed.data.free_slots);
  return c.json({ jobs: claimed.jobs, min_runner_version: RUNNER_MIN_VERSION });
});

computeRunnerRoutes.post("/heartbeat", runnerAccess, async (c) => {
  const runner = c.get("runner");
  if (!runner) return refuse(c, "runner_unknown");
  c.header("Cache-Control", "no-store");
  const read = await readRunnerBody(c, RUNNER_REPORT_BODY_MAX_BYTES);
  if (!read.ok) return read.response;
  const parsed = RunnerHeartbeatRequestSchema.safeParse(read.body);
  if (!parsed.success) return refuse(c, "invalid_body");
  const beat = await heartbeatRunnerJob(c.env, runner, parsed.data);
  if (!beat.ok) return refuse(c, beat.refusal);
  return c.json({ lease_expires_at: beat.lease_expires_at, cancel: beat.cancel });
});

computeRunnerRoutes.post("/complete", runnerAccess, async (c) => {
  const runner = c.get("runner");
  if (!runner) return refuse(c, "runner_unknown");
  c.header("Cache-Control", "no-store");
  const read = await readRunnerBody(c, RUNNER_REPORT_BODY_MAX_BYTES);
  if (!read.ok) return read.response;
  const parsed = RunnerCompleteRequestSchema.safeParse(read.body);
  if (!parsed.success) return refuse(c, "invalid_body");
  const done = await completeRunnerJob(c.env, runner, parsed.data);
  if (!done.ok) return refuse(c, done.refusal);
  // The copy of the launcher's files into the records follows the terminal batch and may not fail the answer;
  // a copy that does not finish is repaired by the lease sweep.
  const after = done.after;
  if (after !== null) {
    const run = after().catch((err) =>
      console.error(
        `[compute-runner-queue] after_terminal_failed class=${err instanceof Error ? err.name : typeof err}`,
      ),
    );
    try {
      c.executionCtx.waitUntil(run);
    } catch {
      await run;
    }
  }
  return c.json({ state: done.state });
});
