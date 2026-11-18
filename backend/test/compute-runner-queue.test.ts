/**
 * The runner queue through NEMAR's REAL routes (portable compute, card DM-07; ADR 0121 decisions 2, 4 and 6;
 * plan D2, D4 and D6): claim, heartbeat, complete, leases, deadlines, cancels and the settlement of an
 * `accounting = 'none'` job, over a real migrated database (bun:sqlite behind `realD1`, and Miniflare's D1
 * for the races), Miniflare's R2 and the real local S3 interface the presigned PUTs reach.
 *
 * THE RUNNER IS A CLIENT OF THE REAL ROUTES over a real loopback port: it claims, sends heartbeats, uploads
 * its outputs through the bundle-less outputs and complete routes WITH the lease header and its job token,
 * and completes. The only thing played is what a container would write (the launcher's three documents), built
 * from the launch specification the Worker answered, never from a number the Worker stored. NO NEMAR DECISION
 * IS STOOD IN FOR: rows are aged and states are set with SQL the tables accept, where a case is about what
 * the sweep does with a row in that shape.
 *
 * What is pinned, each group with the mutation that kills it named in its tests (the list is in the PR):
 *  (a) the claim: the winner test (50 races on both engines never give a job to two runners), a list of
 *      three, a misfit that is skipped, a dataset made private after dispatch, `runner_outdated`, the
 *      statement's predicates;
 *  (b) a whole run: claim, `started`, outputs through the routes under the lease, `uploading`, `complete`;
 *      finished, digest set, usage set, settled with charge 0, no ledger row, records copied, a repeat
 *      answers the same state, a stale lease is refused;
 *  (c) leases and deadlines: three unstarted expiries, a silent started job, outputs that completed, a
 *      revoked runner's job, a deadline, a cancel that reaches the runner;
 *  (d) security: a claim that outlived a revoke, a demotion or a deletion wins nothing; a cleared lease
 *      refuses the three launcher routes; a cleared nonce is minted again; every state, revoked and expiry of
 *      a cancel-requested job; the statements' text;
 *  (e) lifecycle: records that never landed are replayed, a waiting job's cancel ends in SQL and frees its
 *      tuple and its slot, the records copy, the two attention words, and a cancel-requested `unreported`
 *      row that DM-05's revoke left.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { findRecipe } from "../../shared/compute-recipes";
import { LAUNCHER_FILES } from "../../shared/contract/compute";
import { ComputeStatusResponseSchema } from "../../shared/contract/compute-admin";
import { LaunchSpecSchema, decodeLaunchSpecEnv } from "../../shared/contract/compute-launch";
import {
  RUNNER_LEASE_HEADER,
  RUNNER_PROTOCOL,
  RunnerClaimResponseSchema,
  RunnerCompleteResponseSchema,
  RunnerHeartbeatResponseSchema,
} from "../../shared/contract/compute-runner";
import { adminRoutes } from "../src/routes/admin";
import { computeRoutes } from "../src/routes/compute";
import { computeRunnerRoutes } from "../src/routes/compute-runners";
import { getJob } from "../src/services/compute-jobs";
import { UNCOPIED_TERMINAL_SQL } from "../src/services/compute-lifecycle";
import { RUNNER_TERMINAL_TRANSITION_SQL } from "../src/services/compute-lifecycle";
import { dispatchPipelineJob } from "../src/services/compute-pipeline";
import { recordKey, sha256Hex } from "../src/services/compute-records";
import {
  CLAIM_RUNNER_JOB_SQL,
  claimRunnerJobs,
  completeRunnerJob,
  runnerVersionAtLeast,
  sweepRunnerLeases,
} from "../src/services/compute-runner-queue";
import {
  type RunnerPrincipal,
  exchangeRunnerSecret,
  registerRunner,
  resolveRunnerAccess,
} from "../src/services/compute-runners";
import type { Bindings, Variables } from "../src/types/bindings";
import { COMPUTE_KEYS, seedComputeUsers } from "./helpers/compute-app";
import {
  type LifecycleFixture,
  RUNTIME_IMAGE_DIGEST,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { seedEegDataset, seedPipelinesAccount } from "./helpers/compute-pipeline-fixture";
import { roundTripD1, seedUser, setPolicy } from "./helpers/compute-seed";
import {
  type GithubCompareStandin,
  startGithubCompareStandin,
} from "./helpers/github-compare-standin";

// --- The world ---------------------------------------------------------------------------------------

let fx: LifecycleFixture;
let ids: Record<keyof typeof COMPUTE_KEYS, number>;
let env: Bindings;
let base = "";
let server: ReturnType<typeof Bun.serve>;
const pending: Promise<unknown>[] = [];

/**
 * The two external services the Zarr source check reads (GitHub, and the serving copy's index), as one real
 * loopback server: the happy world is the tag and the index naming one commit. A Zarr dispatch runs in
 * `development` (the check honors its seams only outside production).
 */
let github: GithubCompareStandin;
const seams = globalThis as { NEMAR_GITHUB_API_URL?: string; NEMAR_ZARR_INDEX_BASE?: string };
const previousSeams = { github: seams.NEMAR_GITHUB_API_URL, index: seams.NEMAR_ZARR_INDEX_BASE };

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
app.route("/admin", adminRoutes);
app.route("/compute/runners", computeRunnerRoutes);
app.route("/compute", computeRoutes);
const handle = (req: Request, e: Bindings) =>
  app.fetch(req, e, {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext);

/** Wait for everything the routes handed to `waitUntil` (the records copy after a completion). */
const flush = async () => {
  while (pending.length > 0) await pending.shift();
};

beforeAll(async () => {
  fx = await startLifecycleFixture({ withD1: true });
  github = startGithubCompareStandin();
  seams.NEMAR_GITHUB_API_URL = github.url;
  seams.NEMAR_ZARR_INDEX_BASE = github.indexBase;
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => handle(req, env),
  });
  base = `http://127.0.0.1:${server.port}`;
}, 120_000);

beforeEach(async () => {
  // What the last case handed to `waitUntil` runs against that case's database: let it end first.
  await flush();
  github?.reset();
  await fx.reset();
  ids = await seedComputeUsers(fx.harness.db);
  env = fx.env({ ENVIRONMENT: "development", COMPUTE_RUNNERS_ENABLED: "1", API_BASE_URL: base });
  await seedPipelinesAccount(env);
});

afterAll(async () => {
  server?.stop(true);
  github?.stop();
  seams.NEMAR_GITHUB_API_URL = previousSeams.github;
  seams.NEMAR_ZARR_INDEX_BASE = previousSeams.index;
  await fx?.dispose();
}, 30_000);

/** A row or a JSON body read back by a case, whose fields the assertions name. */
// biome-ignore lint/suspicious/noExplicitAny: test rows and bodies are read field by field
type Loose = Record<string, any>;

const sql = (statement: string, ...binds: unknown[]) =>
  env.DB.prepare(statement)
    .bind(...binds)
    .run();
const row = async (id: string) =>
  (await env.DB.prepare("SELECT * FROM compute_jobs WHERE id = ?1")
    .bind(id)
    .first<Loose>()) as Loose;
const count = async (statement: string, ...binds: unknown[]) =>
  (
    await env.DB.prepare(statement)
      .bind(...binds)
      .first<{ n: number }>()
  )?.n ?? 0;

// --- Seeds ---------------------------------------------------------------------------------------------

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/**
 * The minutes a job of the Zarr input is sized for: the registry's, so a number the owner adjusts there is
 * the number these cases age by (the runner's deadline is these minutes plus a 15-minute grace).
 */
const FLOOR_MINUTES = (findRecipe("nemar-floor") as NonNullable<ReturnType<typeof findRecipe>>)
  .minutes;
let seq = 0;

/** A public EEG dataset with a ready Zarr serving copy, and its id. */
async function dataset(e: Bindings = env): Promise<string> {
  const id = `nm${String(1000 + ++seq).padStart(6, "0")}`;
  await seedEegDataset(e, id);
  github.tag(id, "v1.0.0", COMMIT);
  github.index(id, { source_commit: COMMIT, store_count: 3 });
  await e.DB.prepare(
    "UPDATE datasets SET zarr_source_commit = ?1, zarr_status = 'ready', zarr_store_count = 3 WHERE dataset_id = ?2",
  )
    .bind(COMMIT, id)
    .run();
  return id;
}

/** A runner job dispatched the way an administrator dispatches one: stamp, job, records. Its id. */
async function dispatch(e: Bindings = env, datasetId?: string): Promise<string> {
  const id = datasetId ?? (await dataset(e));
  const admin = ids?.admin ?? 1;
  const r = await dispatchPipelineJob(e, {
    recipe: "nemar-floor",
    datasetId: id,
    actor: { kind: "admin", userId: admin },
    executor: "runner",
  });
  if (!r.ok) throw new Error(`could not dispatch: ${r.code}`);
  return r.jobId;
}

const REGISTRATION = {
  name: "lab_a_cpu",
  pool: "cpu",
  cores: 16,
  memory_mb: 64_000,
  gpus: 0,
  scratch_gb: 500,
  backend: "local",
  runtimes: ["docker"],
  arch: "amd64",
  accounting: "none",
  site: "lab_a",
  trust: "lab",
} as const;

interface Runner {
  id: string;
  token: string;
  principal: RunnerPrincipal;
}

/** A registered runner with an access token: the owner's registration and the runner's exchange, as production does them. */
async function runner(
  e: Bindings = env,
  over: Record<string, unknown> = {},
  owner: number = ids.owner,
): Promise<Runner> {
  const body = { ...REGISTRATION, name: `runner_${++seq}`, ...over } as Parameters<
    typeof registerRunner
  >[2];
  const { runnerId, secret } = await registerRunner(e.DB, owner, body);
  void secret;
  const issued = await exchangeRunnerSecret(e.DB, runnerId, "0.1.0");
  if (!issued) throw new Error("no token");
  const access = await resolveRunnerAccess(e.DB, issued.accessToken);
  if (access.kind !== "ok") throw new Error("no access");
  return { id: runnerId, token: issued.accessToken, principal: access.runner };
}

interface Reply {
  status: number;
  body: Loose;
}

async function post(path: string, token: string | null, body: unknown): Promise<Reply> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Loose = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body: parsed };
}

const CLAIM = (free_slots: number, over: Record<string, unknown> = {}) => ({
  protocol: RUNNER_PROTOCOL,
  free_slots,
  runtimes: ["docker"],
  arch: "amd64",
  runner_version: "0.1.0",
  ...over,
});

const claim = (r: Runner, n = 1, over: Record<string, unknown> = {}) =>
  post("/compute/runners/claim", r.token, CLAIM(n, over));
const heartbeat = (r: Runner, job_id: string, lease_id: string, phase: "started" | "uploading") =>
  post("/compute/runners/heartbeat", r.token, { job_id, lease_id, phase });
const complete = (
  r: Runner,
  job_id: string,
  lease_id: string,
  over: Record<string, unknown> = {},
) =>
  post("/compute/runners/complete", r.token, {
    job_id,
    lease_id,
    exit_number: 0,
    launcher_failure_code: null,
    launcher_detail: null,
    usage: { wall_seconds: 120, cpu_seconds: 400, max_rss_mb: 2048 },
    usage_partial: false,
    scratch_discarded: true,
    ...over,
  });

type Claimed = { id: string; lease_id: string; launch_spec_env: string; lease_expires_at: string };

/** Claim one job and return its entry (and fail the case if the answer is not one entry). */
async function claimOne(r: Runner): Promise<Claimed> {
  const res = await claim(r, 1);
  expect(res.status).toBe(200);
  const parsed = RunnerClaimResponseSchema.parse(res.body);
  expect(parsed.jobs).toHaveLength(1);
  return parsed.jobs[0] as unknown as Claimed;
}

/** A job dispatched and claimed, and the runner that holds it. */
async function claimed(over: Record<string, unknown> = {}) {
  const r = await runner(env, over);
  const jobId = await dispatch();
  const entry = await claimOne(r);
  expect(entry.id).toBe(jobId);
  return { r, jobId, entry };
}

const sha = async (text: string) => sha256Hex(new TextEncoder().encode(text));

interface Uploaded {
  outputs: number;
  puts: number[];
  complete: number;
}

/**
 * What the runner's launcher does with the routes, from the launch specification the Worker answered: the
 * outputs call, the presigned PUTs, the complete call. `lease` is the `X-Compute-Lease` value sent (null: no
 * header). Never asserts: a refusal is a status the case reads.
 */
async function uploadAs(
  entry: Claimed,
  o: {
    lease?: string | null;
    files?: Array<{ path: string; content: string }>;
    /** Declare and upload, but never call outputs-complete (a runner that went silent first). */
    skipComplete?: boolean;
  } = {},
): Promise<Uploaded> {
  const decoded = decodeLaunchSpecEnv(entry.launch_spec_env);
  if (!decoded.ok) throw new Error("the launcher would refuse the launch specification");
  const spec = LaunchSpecSchema.parse(JSON.parse(decoded.text));
  const files = o.files ?? [{ path: "report.txt", content: "the report" }];
  const enc = new TextEncoder();
  const launcherText: Record<string, string> = {
    [LAUNCHER_FILES.result]: JSON.stringify({
      job_id: entry.id,
      failure_code: null,
      detail: null,
      exit_number: 0,
      entry_exit_code: 0,
    }),
    [LAUNCHER_FILES.provenance]: JSON.stringify({
      job_id: entry.id,
      // What the launcher hashed: the text it decoded, never a number the Worker stored.
      launch_spec_digest: await sha(decoded.text),
      bundle_digest: null,
      image: { uri: spec.image.uri, digest: RUNTIME_IMAGE_DIGEST },
      runtime_version: "queue-test 1.0",
      staging: [],
      timings: { run: 1 },
      slurm_job_id: null,
      entry_exit_code: 0,
    }),
    [LAUNCHER_FILES.manifest]: JSON.stringify({
      job_id: entry.id,
      files: await Promise.all(
        files.map(async (f) => ({
          path: f.path,
          size: enc.encode(f.content).length,
          sha256: await sha(f.content),
        })),
      ),
    }),
    [LAUNCHER_FILES.log]: "launcher log line\n",
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Compute-Job-Token": spec.job_token,
  };
  const lease = o.lease === undefined ? entry.lease_id : o.lease;
  if (lease !== null) headers[RUNNER_LEASE_HEADER] = lease;
  const outputsRes = await fetch(`${spec.api_base}/compute/jobs/${entry.id}/outputs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      outputs: await Promise.all(
        files.map(async (f) => ({
          path: f.path,
          size: enc.encode(f.content).length,
          sha256: await sha(f.content),
        })),
      ),
      launcher: Object.values(LAUNCHER_FILES).map((name) => ({
        name,
        size: enc.encode(launcherText[name] as string).length,
      })),
    }),
  });
  const result: Uploaded = { outputs: outputsRes.status, puts: [], complete: 0 };
  if (outputsRes.status === 200) {
    const { uploads } = (await outputsRes.json()) as {
      uploads: Array<{ path: string; url: string }>;
    };
    for (const u of uploads) {
      const content = u.path.startsWith("outputs/")
        ? (files.find((f) => `outputs/${f.path}` === u.path)?.content as string)
        : (launcherText[u.path.replace("launcher/", "")] as string);
      const put = await fetch(u.url, { method: "PUT", body: enc.encode(content) });
      result.puts.push(put.status);
    }
  } else {
    await outputsRes.text();
  }
  if (o.skipComplete) return result;
  const completeRes = await fetch(`${spec.api_base}/compute/jobs/${entry.id}/outputs/complete`, {
    method: "POST",
    headers,
  });
  result.complete = completeRes.status;
  await completeRes.text();
  return result;
}

const age = (id: string, column: string, modifier: string) =>
  sql(`UPDATE compute_jobs SET ${column} = datetime('now', ?2) WHERE id = ?1`, id, modifier);

/** The admin routes, as an owner or an administrator. */
async function admin(
  method: "GET" | "POST",
  path: string,
  who: "owner" | "admin" = "admin",
  body?: unknown,
) {
  const res = await handle(
    new Request(`http://api.test/admin${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${COMPUTE_KEYS[who]}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
  const text = await res.text();
  let parsed: Loose = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body: parsed };
}

const revokeRunner = (id: string) => admin("POST", `/compute/runners/${id}/revoke`, "owner", {});

/** A real bucket that fails its next `n` writes, as an outage of the store would. */
const failing = (n: number): R2Bucket => {
  let left = n;
  const real = fx.harness.records;
  return {
    put: async (key: string, value: unknown, options?: unknown) => {
      if (left-- > 0) throw new Error("the store is down");
      return real.put(key, value as ArrayBuffer, options as Parameters<R2Bucket["put"]>[2]);
    },
    get: (key: string) => real.get(key),
    head: (key: string) => real.head(key),
    delete: (key: string) => real.delete(key),
    list: (o?: Parameters<R2Bucket["list"]>[0]) => real.list(o),
  } as unknown as R2Bucket;
};

// --- (a) The claim -----------------------------------------------------------------------------------------

describe("the claim", () => {
  test("answers the lease, the specification and the image, and records the claim (MUTATION: drop the launch digest write)", async () => {
    const r = await runner();
    const jobId = await dispatch();
    const res = await claim(r, 1);
    expect(res.status).toBe(200);
    const parsed = RunnerClaimResponseSchema.parse(res.body);
    expect(parsed.min_runner_version).toBe("0.1.0");
    expect(parsed.jobs).toHaveLength(1);
    const entry = parsed.jobs[0] as unknown as Claimed & {
      image: { digest: string };
      cores: number;
      memory_mb: number;
      minutes: number;
    };
    expect(entry).toMatchObject({ id: jobId, cores: 4, memory_mb: 16384, minutes: FLOOR_MINUTES });
    expect(entry.image.digest).toBe(RUNTIME_IMAGE_DIGEST);
    const job = await row(jobId);
    expect(job).toMatchObject({
      state: "created",
      runner_id: r.id,
      runner_backend: "local",
      lease_id: entry.lease_id,
      claim_attempts: 1,
      executor: "runner",
      accounting: "none",
    });
    expect(job.runner_claimed_at).not.toBeNull();
    expect(job.lease_expires_at).not.toBeNull();
    // The digest is the SHA-256 of the specification TEXT the runner decodes from what it was answered.
    const decoded = decodeLaunchSpecEnv(entry.launch_spec_env);
    expect(decoded.ok).toBe(true);
    expect(job.launch_spec_digest).toBe(await sha((decoded as { text: string }).text));
    // Nothing waits for the same runner any more.
    expect(RunnerClaimResponseSchema.parse((await claim(r, 1)).body).jobs).toHaveLength(0);
  });

  test("a claim for three slots with three fitting jobs answers three distinct jobs with three distinct leases", async () => {
    const r = await runner();
    const wanted = [await dispatch(), await dispatch(), await dispatch()];
    // `created_at` has one-second resolution: make the order they were made in a fact of the rows.
    for (const [i, id] of wanted.entries()) await age(id, "created_at", `-${3 - i} minutes`);
    const res = await claim(r, 3);
    const jobs = RunnerClaimResponseSchema.parse(res.body).jobs as unknown as Claimed[];
    expect(new Set(jobs.map((j) => j.id))).toEqual(new Set(wanted));
    expect(new Set(jobs.map((j) => j.lease_id)).size).toBe(3);
    // The oldest first: the order they were made in.
    expect(jobs.map((j) => j.id)).toEqual(wanted);
  });

  test("a job the runner cannot hold is not claimed, and does not block a newer one that fits (MUTATION: drop the cores term)", async () => {
    const small = await runner(env, { cores: 2 });
    const big = await runner();
    const jobId = await dispatch();
    expect(RunnerClaimResponseSchema.parse((await claim(small, 1)).body).jobs).toHaveLength(0);
    expect((await row(jobId)).runner_id).toBeNull();
    expect((await claimOne(big)).id).toBe(jobId);
    // A memory misfit and a GPU misfit likewise.
    const lean = await runner(env, { memory_mb: 1000 });
    await dispatch();
    expect(RunnerClaimResponseSchema.parse((await claim(lean, 1)).body).jobs).toHaveLength(0);
  });

  test("a runner of another pool claims nothing", async () => {
    const gpu = await runner(env, { pool: "gpu", gpus: 1 });
    await dispatch();
    expect(RunnerClaimResponseSchema.parse((await claim(gpu, 1)).body).jobs).toHaveLength(0);
  });

  test("a dataset made private after dispatch is not claimed, and its waiting job is ended by the sweep the claim runs (MUTATION: drop the eligibility term)", async () => {
    const r = await runner();
    const id = await dataset();
    const jobId = await dispatch(env, id);
    await sql("UPDATE datasets SET visibility = 'private' WHERE dataset_id = ?1", id);
    // Past the sweep's minimum age (a job seconds old may still be linking its stamp).
    await age(jobId, "created_at", "-11 minutes");
    expect(RunnerClaimResponseSchema.parse((await claim(r, 1)).body).jobs).toHaveLength(0);
    expect((await row(jobId)).runner_id).toBeNull();
    // The claim route's own sweep already ended it: a second sweep finds nothing.
    expect(await sweepRunnerLeases(env)).toMatchObject({ ineligible: 0 });
    expect(await row(jobId)).toMatchObject({
      state: "failed",
      failure_detail: "dataset_ineligible",
    });
  });

  test("a job whose cancel is recorded, or whose claims are used up, is not claimed", async () => {
    const r = await runner();
    const a = await dispatch();
    const b = await dispatch();
    await sql("UPDATE compute_jobs SET cancel_requested_at = datetime('now') WHERE id = ?1", a);
    await sql("UPDATE compute_jobs SET claim_attempts = 3 WHERE id = ?1", b);
    expect(RunnerClaimResponseSchema.parse((await claim(r, 2)).body).jobs).toHaveLength(0);
  });

  test("an outdated runner is refused runner_outdated before anything is claimed; another protocol is its own word; a bad body is invalid_body", async () => {
    const r = await runner();
    await dispatch();
    const old = await claim(r, 1, { runner_version: "0.0.9" });
    expect([old.status, old.body.error]).toEqual([426, "runner_outdated"]);
    const other = await post(
      "/compute/runners/claim",
      r.token,
      CLAIM(1, { protocol: "nemar.runner.v2" }),
    );
    expect([other.status, other.body.error]).toEqual([426, "protocol_unsupported"]);
    const bad = await post("/compute/runners/claim", r.token, CLAIM(0));
    expect([bad.status, bad.body.error]).toEqual([400, "invalid_body"]);
    const extra = await post("/compute/runners/claim", r.token, { ...CLAIM(1), surprise: 1 });
    expect([extra.status, extra.body.error]).toEqual([400, "invalid_body"]);
    expect(await count("SELECT COUNT(*) AS n FROM compute_jobs WHERE runner_id IS NOT NULL")).toBe(
      0,
    );
    const none = await post("/compute/runners/claim", null, CLAIM(1));
    expect([none.status, none.body.error]).toEqual([401, "runner_unknown"]);
  });

  test("the version rule: at least 0.1.0, a pre-release below its release", () => {
    expect(runnerVersionAtLeast("0.1.0")).toBe(true);
    expect(runnerVersionAtLeast("0.1.1")).toBe(true);
    expect(runnerVersionAtLeast("1.0.0")).toBe(true);
    expect(runnerVersionAtLeast("0.0.9")).toBe(false);
    expect(runnerVersionAtLeast("0.1.0-rc1")).toBe(false);
    expect(runnerVersionAtLeast("0.2.0-rc1")).toBe(true);
    expect(runnerVersionAtLeast("not a version")).toBe(false);
  });

  test("the statement carries every predicate, literally, for the picked row AND the row written (MUTATION: delete any one)", () => {
    const s = CLAIM_RUNNER_JOB_SQL;
    // The terms of `claimable`: each is there twice, once over the subselect's `j` and once over the outer row.
    for (const alias of ["j", "compute_jobs"]) {
      for (const term of [
        `${alias}.executor = 'runner'`,
        `${alias}.accounting = 'none'`,
        `${alias}.state = 'created'`,
        `${alias}.runner_claimed_at IS NULL`,
        `${alias}.records_written_at IS NOT NULL`,
        `${alias}.cancel_requested_at IS NULL`,
        `${alias}.claim_attempts < ?5`,
        `${alias}.pool = ?6`,
        `+ ${alias}.cores_per_node <= ?7`,
        `+ COALESCE(${alias}.memory_mb, 0) <= ?8`,
        `+ ${alias}.gpus <= ?9`,
        `WHERE s.job_id = ${alias}.id AND d.status = 'active'`,
      ]) {
        expect([alias, term, s.includes(term)]).toEqual([alias, term, true]);
      }
    }
    for (const term of [
      "FROM compute_runners r JOIN users u ON u.id = r.registered_by",
      "r.revoked_at IS NULL",
      "u.role = 'owner' AND u.status = 'approved' AND u.deleted_at IS NULL",
      "d.visibility = 'public'",
      "d.anonymous = 0",
      "ORDER BY j.created_at ASC",
      "l.runner_id = ?1",
    ]) {
      expect(s).toContain(term);
    }
  });
});

// --- The race ---------------------------------------------------------------------------------------------------

describe("two runners racing for one job", () => {
  const worlds = () => [
    {
      name: "bun:sqlite",
      d1: fx.env().DB,
      racing: (e: Bindings) => ({ ...e, DB: roundTripD1(e.DB) }),
    },
    { name: "Miniflare D1", d1: fx.harness.d1 as D1Database, racing: (e: Bindings) => e },
  ];
  for (const which of [0, 1]) {
    test(`50 rounds never give a job to both [${which === 0 ? "bun:sqlite" : "Miniflare D1"}] (MUTATION: drop runner_claimed_at IS NULL from the claim)`, async () => {
      const w = worlds()[which] as ReturnType<typeof worlds>[number];
      const e = fx.env({
        ENVIRONMENT: "development",
        DB: w.d1,
        COMPUTE_RUNNERS_ENABLED: "1",
        API_BASE_URL: base,
      });
      if (which === 1) {
        await seedPipelinesAccount(e, { reuse: true });
      }
      const owner = which === 0 ? ids.owner : await seedUser(w.d1, { role: "owner" });
      // Room for every round: a runner is handed only what its registered capacity still holds.
      const big = { cores: 256, memory_mb: 16_777_216 };
      const a = await runner(e, big, owner);
      const b = await runner(e, big, owner);
      const racing = w.racing(e);
      let rounds = 0;
      for (let i = 0; i < 50; i++) {
        const jobId = await dispatch(e);
        const [x, y] = await Promise.all([
          claimRunnerJobs(racing, a.principal, 1),
          claimRunnerJobs(racing, b.principal, 1),
        ]);
        expect(x.jobs.length + y.jobs.length).toBe(1);
        const job = (await getJob(e.DB, jobId)) as NonNullable<Awaited<ReturnType<typeof getJob>>>;
        expect(job.claim_attempts).toBe(1);
        expect([a.id, b.id]).toContain(job.runner_id as string);
        const winner = x.jobs.length === 1 ? x.jobs[0] : y.jobs[0];
        expect(job.lease_id).toBe(winner?.lease_id as string);
        rounds++;
      }
      expect(rounds).toBe(50);
    }, 240_000);
  }
});

// --- (b) A whole run ----------------------------------------------------------------------------------------------

describe("one job's whole run through the routes", () => {
  test("claim, started, outputs under the lease, uploading, complete: finished, settled with charge 0, no ledger, records copied (MUTATION: write a ledger row, or drop settled_final_at from the stamp)", async () => {
    const r = await runner();
    const jobId = await dispatch();
    const entry = await claimOne(r);
    const beat = await heartbeat(r, jobId, entry.lease_id, "started");
    expect(beat.status).toBe(200);
    expect(RunnerHeartbeatResponseSchema.parse(beat.body).cancel).toBe(false);
    expect(await row(jobId)).toMatchObject({ state: "running" });
    expect((await row(jobId)).started_at).not.toBeNull();

    const up = await uploadAs(entry);
    expect(up.outputs).toBe(200);
    expect(up.puts.every((s) => s === 200)).toBe(true);
    expect(up.complete).toBe(200);
    expect((await row(jobId)).outputs_completed_at).not.toBeNull();

    expect((await heartbeat(r, jobId, entry.lease_id, "uploading")).status).toBe(200);
    expect(await row(jobId)).toMatchObject({ state: "archiving" });

    const done = await complete(r, jobId, entry.lease_id);
    expect(done.status).toBe(200);
    expect(RunnerCompleteResponseSchema.parse(done.body).state).toBe("finished");
    await flush();

    const job = await row(jobId);
    expect(job).toMatchObject({
      state: "finished",
      failure_code: null,
      charged_milli: 0,
      held_milli: 0,
      runner_wall_seconds: 120,
      runner_cpu_seconds: 400,
      runner_max_rss_mb: 2048,
      executor: "runner",
      accounting: "none",
      lease_id: entry.lease_id,
    });
    expect(job.launch_spec_digest).not.toBeNull();
    expect(job.results_verified_at).not.toBeNull();
    expect(job.settled_provisional_at).not.toBeNull();
    expect(job.settled_final_at).not.toBeNull();
    expect(job.ended_at).not.toBeNull();
    expect(job.result_records_at).not.toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM compute_ledger WHERE job_id = ?1", jobId)).toBe(
      0,
    );
    expect(await fx.harness.records.head(recordKey(jobId, "result.json"))).not.toBeNull();
    expect(await fx.harness.records.head(recordKey(jobId, "provenance.json"))).not.toBeNull();

    // A repeat answers the same state and writes nothing; a different usage is not taken.
    const again = await complete(r, jobId, entry.lease_id, {
      usage: { wall_seconds: 9, cpu_seconds: 9, max_rss_mb: 9 },
    });
    expect(again.status).toBe(200);
    expect(again.body.state).toBe("finished");
    expect(await row(jobId)).toMatchObject({ runner_wall_seconds: 120, ended_at: job.ended_at });
    // The lease is kept, so a heartbeat on a terminal job is lease_lost.
    const late = await heartbeat(r, jobId, entry.lease_id, "uploading");
    expect([late.status, late.body.error]).toEqual([409, "lease_lost"]);
  });

  test("a stale lease's outputs and complete are refused: a lease the sweep released and another runner replaced (MUTATION: drop the lease header check)", async () => {
    const a = await runner();
    const b = await runner();
    const jobId = await dispatch();
    const first = await claimOne(a);
    await age(jobId, "lease_expires_at", "-1 minute");
    await sweepRunnerLeases(env);
    expect((await row(jobId)).runner_id).toBeNull();
    const second = await claimOne(b);
    expect(second.lease_id).not.toBe(first.lease_id);
    expect(await row(jobId)).toMatchObject({ claim_attempts: 2, runner_id: b.id });

    // The first runner's lease: outputs, outputs-complete, heartbeat and complete are all refused.
    const stale = await uploadAs(first, { lease: first.lease_id });
    expect(stale.outputs).toBe(404);
    expect(stale.complete).toBe(404);
    expect((await heartbeat(a, jobId, first.lease_id, "started")).body.error).toBe("lease_lost");
    const late = await complete(a, jobId, first.lease_id);
    expect([late.status, late.body.error]).toEqual([409, "lease_lost"]);
    expect((await row(jobId)).state).toBe("created");
    // The second runner's lease is the one that works, with the first claim's token (the token is the job's).
    const ok = await uploadAs(second);
    expect(ok.outputs).toBe(200);
  });

  test("a failure the runner reports without launcher documents: its declared code and detail, the code its exit number names, or runner_lost", async () => {
    const reports: Array<[Record<string, unknown>, string, string | null]> = [
      [
        {
          exit_number: 13,
          launcher_failure_code: "runtime_error",
          launcher_detail: "entry_failed",
        },
        "runtime_error",
        "entry_failed",
      ],
      // A detail not declared for its code is not used; the exit number names the code.
      [
        { exit_number: 13, launcher_failure_code: "runtime_error", launcher_detail: "made_up" },
        "runtime_error",
        null,
      ],
      [{ exit_number: 15, launcher_failure_code: null, launcher_detail: null }, "time_limit", null],
      [
        { exit_number: 99, launcher_failure_code: null, launcher_detail: null },
        "runner_lost",
        "lease_expired",
      ],
    ];
    for (const [over, code, detail] of reports) {
      const { r, jobId, entry } = await claimed();
      const res = await complete(r, jobId, entry.lease_id, over);
      expect(res.body.state).toBe("failed");
      await flush();
      const job = await row(jobId);
      expect([job.failure_code, job.failure_detail]).toEqual([code, detail]);
      expect(job).toMatchObject({ charged_milli: 0 });
      expect(job.settled_final_at).not.toBeNull();
      expect(await count("SELECT COUNT(*) AS n FROM compute_ledger WHERE job_id = ?1", jobId)).toBe(
        0,
      );
    }
  });

  test("a lease that is not the job's, a job of another runner and a job nobody made are all lease_lost, on heartbeat and complete (MUTATION: drop the lease compare of complete)", async () => {
    const { r, jobId, entry } = await claimed();
    const other = await runner();
    const wrong = "ab".repeat(16);
    for (const phase of ["started", "uploading"] as const) {
      const beat = await heartbeat(r, jobId, wrong, phase);
      expect([beat.status, beat.body.error]).toEqual([409, "lease_lost"]);
      expect((await heartbeat(other, jobId, entry.lease_id, phase)).body.error).toBe("lease_lost");
      expect((await heartbeat(r, `job_${"0".repeat(24)}`, wrong, phase)).body.error).toBe(
        "lease_lost",
      );
    }
    for (const [who, lease] of [
      [r, wrong],
      [other, entry.lease_id],
    ] as const) {
      const res = await complete(who, jobId, lease);
      expect([res.status, res.body.error]).toEqual([409, "lease_lost"]);
    }
    expect(await row(jobId)).toMatchObject({ state: "created", runner_wall_seconds: null });
  });

  test("the usage is written once per job (MUTATION: drop the IS NULL term)", async () => {
    const { r, jobId, entry } = await claimed();
    await sql("UPDATE compute_jobs SET runner_wall_seconds = 5 WHERE id = ?1", jobId);
    expect((await complete(r, jobId, entry.lease_id, { exit_number: 13 })).body.state).toBe(
      "failed",
    );
    expect((await row(jobId)).runner_wall_seconds).toBe(5);
  });

  test("an exit of 0 with no outputs completed fails verification (result_upload_failed, not_completed)", async () => {
    const { r, jobId, entry } = await claimed();
    const res = await complete(r, jobId, entry.lease_id);
    expect(res.body.state).toBe("failed");
    expect(await row(jobId)).toMatchObject({
      failure_code: "result_upload_failed",
      failure_detail: "not_completed",
    });
  });

  test("two completions at once end the job once (acceptance is at most once)", async () => {
    const { r, jobId, entry } = await claimed();
    await heartbeat(r, jobId, entry.lease_id, "started");
    await uploadAs(entry);
    const racing = [complete(r, jobId, entry.lease_id), complete(r, jobId, entry.lease_id)];
    const answers = await Promise.all(racing);
    expect(answers.map((a) => a.body.state)).toEqual(["finished", "finished"]);
    await flush();
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM compute_jobs WHERE id = ?1 AND state = 'finished'",
        jobId,
      ),
    ).toBe(1);
  });
});

// --- (c) Leases, deadlines and cancels -----------------------------------------------------------------------------------

describe("leases and deadlines", () => {
  test("three unstarted expiries release the claim twice and then fail claims_exhausted (MUTATION: claim_attempts >= to > in the exhausted rows)", async () => {
    const r = await runner();
    const jobId = await dispatch();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const entry = await claimOne(r);
      expect(entry.id).toBe(jobId);
      expect((await row(jobId)).claim_attempts).toBe(attempt);
      await age(jobId, "lease_expires_at", "-1 minute");
      await sweepRunnerLeases(env);
      if (attempt < 3) {
        expect(await row(jobId)).toMatchObject({
          state: "created",
          runner_id: null,
          lease_id: null,
        });
      }
    }
    const job = await row(jobId);
    expect(job).toMatchObject({
      state: "failed",
      failure_code: "runner_lost",
      failure_detail: "claims_exhausted",
      platform_failure: 1,
      charged_milli: 0,
    });
    expect(job.settled_final_at).not.toBeNull();
  });

  test("a job whose last claim a revoke gave back is failed claims_exhausted too, not left waiting for ever", async () => {
    const r = await runner();
    const jobId = await dispatch();
    await claimOne(r);
    await sql("UPDATE compute_jobs SET claim_attempts = 3 WHERE id = ?1", jobId);
    expect((await revokeRunner(r.id)).status).toBe(200);
    expect(await row(jobId)).toMatchObject({ state: "created", runner_id: null });
    await sweepRunnerLeases(env);
    expect(await row(jobId)).toMatchObject({ state: "failed", failure_detail: "claims_exhausted" });
  });

  test("a silent started job goes unreported keeping its lease, then fails lease_expired after the give-up wait (MUTATION: unreport on a current lease)", async () => {
    const { r, jobId, entry } = await claimed();
    await heartbeat(r, jobId, entry.lease_id, "started");
    // A lease that is still current changes nothing.
    await sweepRunnerLeases(env);
    expect((await row(jobId)).state).toBe("running");
    await age(jobId, "lease_expires_at", "-1 minute");
    await sweepRunnerLeases(env);
    expect(await row(jobId)).toMatchObject({ state: "unreported", lease_id: entry.lease_id });
    // Not yet: the give-up wait is 60 minutes.
    await sweepRunnerLeases(env);
    expect((await row(jobId)).state).toBe("unreported");
    await age(jobId, "lease_expires_at", "-61 minutes");
    await sweepRunnerLeases(env);
    expect(await row(jobId)).toMatchObject({
      state: "failed",
      failure_code: "runner_lost",
      failure_detail: "lease_expired",
      charged_milli: 0,
    });
  });

  test("a heartbeat renews an unreported job's lease, so a runner that is still alive is not given up on (MUTATION: renew only live-state rows other than unreported)", async () => {
    const { r, jobId, entry } = await claimed();
    await heartbeat(r, jobId, entry.lease_id, "started");
    await age(jobId, "lease_expires_at", "-1 minute");
    await sweepRunnerLeases(env);
    expect(await row(jobId)).toMatchObject({ state: "unreported", lease_id: entry.lease_id });
    // The runner was only partitioned: its next heartbeat is accepted and renews the lease.
    const beat = await heartbeat(r, jobId, entry.lease_id, "uploading");
    expect(beat.status).toBe(200);
    // Past the give-up wait since the ORIGINAL expiry, but the lease was renewed, so it is not given up on.
    await sweepRunnerLeases(env);
    expect((await row(jobId)).state).toBe("unreported");
    await age(jobId, "lease_expires_at", "-61 minutes");
    await sweepRunnerLeases(env);
    expect(await row(jobId)).toMatchObject({ state: "failed", failure_detail: "lease_expired" });
  });

  test("a job whose outputs completed is verified to finished when its runner goes silent (MUTATION: fail it instead)", async () => {
    const { r, jobId, entry } = await claimed();
    await heartbeat(r, jobId, entry.lease_id, "started");
    expect((await uploadAs(entry)).complete).toBe(200);
    await age(jobId, "lease_expires_at", "-1 minute");
    await sweepRunnerLeases(env);
    const job = await row(jobId);
    expect(job).toMatchObject({ state: "finished", charged_milli: 0, failure_code: null });
    expect(job.results_verified_at).not.toBeNull();
    expect(job.settled_final_at).not.toBeNull();
    // The copy of its files followed in the same call.
    expect(job.result_records_at).not.toBeNull();
  });

  test("a revoked runner's started job without completed outputs fails runner_revoked on the next sweep; one whose outputs completed is verified (MUTATION: wait the give-up minutes)", async () => {
    const r = await runner();
    const silent = await dispatch();
    const loaded = await dispatch();
    await age(silent, "created_at", "-2 minutes");
    await age(loaded, "created_at", "-1 minutes");
    const [s, l] = RunnerClaimResponseSchema.parse((await claim(r, 2)).body)
      .jobs as unknown as Claimed[];
    expect([s?.id, l?.id]).toEqual([silent, loaded]);
    for (const e of [s, l] as Claimed[]) await heartbeat(r, e.id, e.lease_id, "started");
    expect((await uploadAs(l as Claimed)).complete).toBe(200);

    const revoked = await revokeRunner(r.id);
    expect(revoked.status).toBe(200);
    for (const id of [silent, loaded]) {
      expect(await row(id)).toMatchObject({
        state: "unreported",
        lease_id: null,
        lease_expires_at: null,
        runner_id: r.id,
      });
    }
    // The dead runner's lease can no longer land anything.
    expect((await uploadAs(s as Claimed)).outputs).toBe(404);

    await sweepRunnerLeases(env);
    expect(await row(silent)).toMatchObject({
      state: "failed",
      failure_code: "runner_lost",
      failure_detail: "runner_revoked",
    });
    const verified = await row(loaded);
    expect(verified).toMatchObject({ state: "finished", failure_code: null });
    expect(verified.results_verified_at).not.toBeNull();
  });

  test("runner_revoked is written nowhere but the queue (a source search)", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, e.name);
        if (e.isDirectory()) walk(path);
        else if (e.name.endsWith(".ts")) {
          // Code lines only: a comment may name the word.
          const code = readFileSync(path, "utf8")
            .split("\n")
            .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
            .join("\n");
          if (/["'`]runner_revoked["'`]/.test(code))
            hits.push(path.replace(/^.*backend\/src\//, ""));
        }
      }
    };
    walk(join(import.meta.dir, "../src"));
    expect(hits).toEqual(["services/compute-runner-queue.ts"]);
  });

  test("a started job past its minutes plus the grace fails deadline_exceeded, even with its lease current (MUTATION: drop the grace)", async () => {
    const { r, jobId, entry } = await claimed();
    await heartbeat(r, jobId, entry.lease_id, "started");
    // The recipe's minutes plus 15: not yet one minute short of it, past one minute over it.
    await age(jobId, "started_at", `-${FLOOR_MINUTES + 14} minutes`);
    await sweepRunnerLeases(env);
    expect((await row(jobId)).state).toBe("running");
    await age(jobId, "started_at", `-${FLOOR_MINUTES + 16} minutes`);
    await sweepRunnerLeases(env);
    expect(await row(jobId)).toMatchObject({
      state: "failed",
      failure_code: "runner_lost",
      failure_detail: "deadline_exceeded",
    });
  });

  test("a cancel reaches the runner on its heartbeat and the job ends cancelled; a started heartbeat cannot walk it back (MUTATION: drop the cancel guard of the started write)", async () => {
    const { r, jobId, entry } = await claimed();
    const cancelled = await admin("POST", `/compute/jobs/${jobId}/cancel`);
    expect(cancelled.status).toBe(200);
    // A claimed job keeps the intent; nothing ended it.
    expect(cancelled.body.job.state).toBe("created");
    const beat = await heartbeat(r, jobId, entry.lease_id, "started");
    expect(RunnerHeartbeatResponseSchema.parse(beat.body).cancel).toBe(true);
    expect((await row(jobId)).state).toBe("created");
    const done = await complete(r, jobId, entry.lease_id, { exit_number: 143 });
    expect(done.body.state).toBe("cancelled");
    await flush();
    const job = await row(jobId);
    expect(job).toMatchObject({ state: "cancelled", cancel_reason: "admin", charged_milli: 0 });
    expect(job.settled_final_at).not.toBeNull();
    expect(job.result_records_at).not.toBeNull();
  });
});

// --- (d) Security -----------------------------------------------------------------------------------------------------------

describe("a claim that outlived the runner's standing wins nothing", () => {
  test("a runner context captured before a revoke admits nothing after the revoke committed (MUTATION: drop the revoked_at term)", async () => {
    const r = await runner();
    const jobId = await dispatch();
    expect((await revokeRunner(r.id)).status).toBe(200);
    const claimedNow = await claimRunnerJobs(env, r.principal, 3);
    expect(claimedNow.jobs).toEqual([]);
    expect(await row(jobId)).toMatchObject({
      runner_id: null,
      claim_attempts: 0,
      state: "created",
    });
  });

  test("so does one whose registering owner was demoted, or deleted (MUTATION: drop the owner standing term)", async () => {
    const jobId = await dispatch();
    for (const change of [
      "UPDATE users SET role = 'admin' WHERE id = ?1",
      "UPDATE users SET deleted_at = datetime('now') WHERE id = ?1",
      "UPDATE users SET status = 'revoked' WHERE id = ?1",
    ]) {
      const owner = await seedUser(env.DB, { role: "owner" });
      const r = await runner(env, {}, owner);
      await sql(change, owner);
      expect((await claimRunnerJobs(env, r.principal, 3)).jobs).toEqual([]);
    }
    expect(await row(jobId)).toMatchObject({ runner_id: null, claim_attempts: 0 });
  });
});

describe("the launcher routes of a runner job need the current lease", () => {
  test("with the row's lease_id NULL, bundle, outputs and outputs-complete are refused, with no header and with a well-formed one (MUTATION: compare (header ?? null) === lease_id)", async () => {
    const { jobId, entry } = await claimed();
    await sql("UPDATE compute_jobs SET lease_id = NULL WHERE id = ?1", jobId);
    const decoded = decodeLaunchSpecEnv(entry.launch_spec_env) as { text: string };
    const spec = LaunchSpecSchema.parse(JSON.parse(decoded.text));
    for (const lease of [null, entry.lease_id, "0".repeat(32)]) {
      for (const path of ["bundle", "outputs", "outputs/complete"]) {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "X-Compute-Job-Token": spec.job_token,
        };
        if (lease !== null) headers[RUNNER_LEASE_HEADER] = lease;
        const res = await fetch(`${base}/compute/jobs/${jobId}/${path}`, {
          method: "POST",
          headers,
          body: path === "outputs" ? JSON.stringify({ outputs: [], launcher: [] }) : undefined,
        });
        expect([lease, path, res.status]).toEqual([lease, path, 404]);
        expect((await res.json()) as { code: string }).toMatchObject({ code: "job_not_found" });
      }
    }
  });

  test("a missing or malformed header is refused while the lease is set, and the right one is accepted", async () => {
    const { entry } = await claimed();
    expect((await uploadAs(entry, { lease: null })).outputs).toBe(404);
    expect((await uploadAs(entry, { lease: "XYZ" })).outputs).toBe(404);
    expect((await uploadAs(entry, { lease: entry.lease_id.toUpperCase() })).outputs).toBe(404);
    expect((await uploadAs(entry)).outputs).toBe(200);
  });

  test("a claimed job whose webhook nonce was cleared gets a fresh one, and its job token works (MUTATION: drop the COALESCE)", async () => {
    const r = await runner();
    const jobId = await dispatch();
    await sql("UPDATE compute_jobs SET webhook_nonce = NULL WHERE id = ?1", jobId);
    const entry = await claimOne(r);
    expect((await row(jobId)).webhook_nonce).not.toBeNull();
    expect((await uploadAs(entry)).outputs).toBe(200);
  });

  test("a Tapis job's launcher routes do not look at a lease header", async () => {
    // The lease check is for `executor = 'runner'` only: the Tapis callbacks suite pins the Tapis path, and
    // a runner job's check is the only branch that reads the header (a source search).
    const src = readFileSync(
      join(import.meta.dir, "../src/routes/callbacks/compute-job-callbacks.ts"),
      "utf8",
    );
    expect(src).toContain('job.executor !== "tapis" && !holdsCurrentLease(c, job)');
  });
});

describe("no cancel-requested runner job stays live unless its lease is current", () => {
  const STATES = ["created", "running", "archiving", "unreported"] as const;
  for (const state of STATES) {
    for (const revoked of [false, true]) {
      for (const expired of [false, true]) {
        test(`${state}, runner revoked ${revoked}, lease expired ${expired} (MUTATION: drop the expiry term of the cancelled rows)`, async () => {
          const { r, jobId, entry } = await claimed();
          if (state !== "created") {
            await sql(
              "UPDATE compute_jobs SET state = ?2, started_at = datetime('now', '-5 minutes') WHERE id = ?1",
              jobId,
              state,
            );
          }
          await admin("POST", `/compute/jobs/${jobId}/cancel`);
          expect((await row(jobId)).cancel_requested_at).not.toBeNull();
          if (revoked) {
            await sql(
              "UPDATE compute_runners SET revoked_at = datetime('now'), revoke_reason = 'owner_revoked' WHERE id = ?1",
              r.id,
            );
          }
          if (expired) await age(jobId, "lease_expires_at", "-1 minute");
          await sweepRunnerLeases(env);
          const after = await row(jobId);
          if (!revoked && !expired) {
            expect(["created", "running", "archiving", "unreported"]).toContain(after.state);
            expect(after.state).toBe(state);
          } else {
            expect(after.state).toBe("cancelled");
            expect(after.settled_final_at).not.toBeNull();
            expect(after.charged_milli).toBe(0);
          }
          void entry;
        });
      }
    }
  }
});

describe("the statements' text (a source search)", () => {
  const src = readFileSync(
    join(import.meta.dir, "../src/services/compute-runner-queue.ts"),
    "utf8",
  );
  const literals = [...src.matchAll(/`([^`]*)`/g)].map((m) => m[1] as string);

  test("every statement that writes a live state to a runner job carries cancel_requested_at IS NULL (MUTATION: drop it from one)", () => {
    const writers = literals.filter((t) => {
      if (!/^\s*UPDATE compute_jobs\b/.test(t)) return false;
      const set = /\bSET\b([\s\S]*?)\bWHERE\b/.exec(t)?.[1] ?? "";
      return /\bstate\s*=\s*'(running|archiving|unreported)'/.test(set);
    });
    // Three: the started write, the uploading write, and the move to unreported.
    expect(writers).toHaveLength(3);
    for (const w of writers) expect(w).toContain("cancel_requested_at IS NULL");
  });

  test("the claim statement contains the compute_runners revoked_at IS NULL predicate", () => {
    expect(CLAIM_RUNNER_JOB_SQL).toMatch(/FROM compute_runners r[\s\S]*r\.revoked_at IS NULL/);
  });
});

// --- (e) Lifecycle ------------------------------------------------------------------------------------------------------------

describe("records that never landed", () => {
  test("a runner job created with recordsWritten false is not claimed; after the replay sweep the next claim admits it (MUTATION: skip the replay)", async () => {
    const r = await runner();
    const bad = fx.env({
      ENVIRONMENT: "development",
      COMPUTE_RUNNERS_ENABLED: "1",
      API_BASE_URL: base,
      COMPUTE_RECORDS: failing(2),
    });
    const id = await dataset();
    const made = await dispatchPipelineJob(bad, {
      recipe: "nemar-floor",
      datasetId: id,
      actor: { kind: "admin", userId: ids.admin },
      executor: "runner",
    });
    expect(made.ok && made.recordsWritten).toBe(false);
    const jobId = (made as { jobId: string }).jobId;
    expect((await row(jobId)).records_written_at).toBeNull();
    expect(RunnerClaimResponseSchema.parse((await claim(r, 1)).body).jobs).toHaveLength(0);

    // Too young to replay: the dispatch's own retry is not over.
    await sweepRunnerLeases(env);
    expect((await row(jobId)).records_written_at).toBeNull();
    await age(jobId, "created_at", "-6 minutes");
    const swept = await sweepRunnerLeases(env);
    expect(swept.replayed).toBe(1);
    expect((await row(jobId)).records_written_at).not.toBeNull();
    expect((await claimOne(r)).id).toBe(jobId);
  });

  test("a row whose specification cannot be rebuilt as the recorded digest is left alone, not written with another", async () => {
    const bad = fx.env({
      ENVIRONMENT: "development",
      COMPUTE_RUNNERS_ENABLED: "1",
      API_BASE_URL: base,
      COMPUTE_RECORDS: failing(2),
    });
    const id = await dataset();
    const made = await dispatchPipelineJob(bad, {
      recipe: "nemar-floor",
      datasetId: id,
      actor: { kind: "admin", userId: ids.admin },
      executor: "runner",
    });
    const jobId = (made as { jobId: string }).jobId;
    await age(jobId, "created_at", "-6 minutes");
    // The tag moved since: the rebuilt text is another text (or the check cannot say).
    github.tag(id, "v1.0.0", "f".repeat(40));
    const swept = await sweepRunnerLeases(env);
    expect(swept.replayed).toBe(0);
    expect((await row(jobId)).records_written_at).toBeNull();
    expect(await fx.harness.records.head(recordKey(jobId, "spec.json"))).toBeNull();
  });
});

describe("a waiting job whose stamp carries the retired recipe name", () => {
  test("cannot be rebuilt: the replay finds a mismatch and writes nothing, and a stale one is given up on, while the same job with the live name is replayed (MUTATION: fall back to nemar-floor when the stamp's recipe is unknown)", async () => {
    const bad = fx.env({
      ENVIRONMENT: "development",
      COMPUTE_RUNNERS_ENABLED: "1",
      API_BASE_URL: base,
      COMPUTE_RECORDS: failing(4),
    });
    const wait = async () => {
      const id = await dataset();
      const made = await dispatchPipelineJob(bad, {
        recipe: "nemar-floor",
        datasetId: id,
        actor: { kind: "admin", userId: ids.admin },
        executor: "runner",
      });
      if (!made.ok) throw new Error("could not dispatch");
      expect(made.recordsWritten).toBe(false);
      return made.jobId;
    };
    const old = await wait();
    const live = await wait();
    // A job that was waiting when migration 0141 landed: its stamp says the old name, with input zarr.
    await sql(
      "UPDATE compute_pipeline_stamps SET recipe = 'nemar-floor-zarr' WHERE job_id = ?1",
      old,
    );
    for (const jobId of [old, live]) await age(jobId, "created_at", "-6 minutes");

    // The control is rebuilt and written; the old name is a mismatch (the registry has lost the recipe),
    // which writes nothing and, being young, is left alone.
    const first = await sweepRunnerLeases(env);
    expect([first.replayed, first.records_lost]).toEqual([1, 0]);
    expect((await row(live)).records_written_at).not.toBeNull();
    expect((await row(old)).records_written_at).toBeNull();
    expect(await fx.harness.records.head(recordKey(old, "spec.json"))).toBeNull();
    expect((await row(old)).state).toBe("created");

    // Past the window, only a mismatch is given up on (an unreachable source is not), so the job ends.
    await age(old, "created_at", "-61 minutes");
    await age(old, "examined_at", "-10 minutes");
    const second = await sweepRunnerLeases(env);
    expect(second.records_lost).toBe(1);
    expect(await row(old)).toMatchObject({ state: "failed", failure_code: "records_unavailable" });
  });
});

describe("the cancel of a waiting runner job", () => {
  test("ends in SQL: cancelled, settled with charge 0, the slot and the tuple freed (MUTATION: drop the stamp end, or the settled stamp)", async () => {
    const owner = ids.owner;
    await setPolicy(env.DB, owner, { runners: { maxLiveJobs: { cpu: 1, gpu: 8 } } });
    const id = await dataset();
    const first = await dispatch(env, id);
    // The cap is full: a second job is refused.
    const second = await dispatchPipelineJob(env, {
      recipe: "nemar-floor",
      datasetId: await dataset(),
      actor: { kind: "admin", userId: ids.admin },
      executor: "runner",
    });
    expect(second).toMatchObject({ ok: false, code: "over_concurrency" });
    // The tuple is held: the same dataset again is a live attempt.
    const again = await dispatchPipelineJob(env, {
      recipe: "nemar-floor",
      datasetId: id,
      actor: { kind: "admin", userId: ids.admin },
      executor: "runner",
    });
    expect(again).toMatchObject({ ok: false, code: "live_attempt_exists" });

    const res = await admin("POST", `/compute/jobs/${first}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.job).toMatchObject({ state: "cancelled", settled: true, charged_milli: 0 });
    // The answer says it ended in this call, not that a cancel was merely recorded.
    expect(res.body.outcome).toBe("cancelled");
    const job = await row(first);
    expect(job).toMatchObject({ state: "cancelled", cancel_reason: "admin", charged_milli: 0 });
    expect(job.settled_provisional_at).not.toBeNull();
    expect(job.settled_final_at).not.toBeNull();
    expect(job.ended_at).not.toBeNull();
    expect(job.retention_until).not.toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM compute_ledger WHERE job_id = ?1", first)).toBe(
      0,
    );
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM compute_pipeline_stamps WHERE job_id = ?1 AND state = 'dispatched'",
        first,
      ),
    ).toBe(0);

    // The slot is free: a second runner job fits; the tuple is free: a new dispatch of it succeeds.
    const fits = await dispatchPipelineJob(env, {
      recipe: "nemar-floor",
      datasetId: id,
      actor: { kind: "admin", userId: ids.admin },
      executor: "runner",
    });
    expect(fits.ok).toBe(true);
    // And the person's route says the same for a job that is already over.
    const replay = await admin("POST", `/compute/jobs/${first}/cancel`);
    expect(replay.body.outcome).toBe("already_cancelled");
  });

  test("a claim that won first keeps the intent: nothing ends the job from under its runner", async () => {
    const { r, jobId, entry } = await claimed();
    const res = await admin("POST", `/compute/jobs/${jobId}/cancel`);
    expect(res.body.job.state).toBe("created");
    expect(res.body.outcome).toBe("cancel_requested");
    expect((await row(jobId)).cancel_requested_at).not.toBeNull();
    expect(
      RunnerHeartbeatResponseSchema.parse(
        (await heartbeat(r, jobId, entry.lease_id, "started")).body,
      ).cancel,
    ).toBe(true);
  });

  test("an unclaimed job whose cancel was recorded and never carried out is ended by the sweep", async () => {
    const jobId = await dispatch();
    await sql(
      "UPDATE compute_jobs SET cancel_requested_at = datetime('now'), cancel_reason = 'user' WHERE id = ?1",
      jobId,
    );
    await sweepRunnerLeases(env);
    expect(await row(jobId)).toMatchObject({ state: "cancelled", cancel_reason: "user" });
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM compute_pipeline_stamps WHERE job_id = ?1 AND state = 'dispatched'",
        jobId,
      ),
    ).toBe(0);
  });

  test("an unreported row DM-05's revoke left (runner set, lease and expiry NULL) with a cancel ends cancelled on one sweep", async () => {
    const { jobId } = await claimed();
    await sql(
      `UPDATE compute_jobs SET state = 'unreported', lease_id = NULL, lease_expires_at = NULL,
              started_at = datetime('now', '-3 minutes'), cancel_requested_at = datetime('now') WHERE id = ?1`,
      jobId,
    );
    const swept = await sweepRunnerLeases(env);
    expect(swept.cancelled).toBe(1);
    expect(await row(jobId)).toMatchObject({ state: "cancelled", charged_milli: 0 });
  });
});

describe("the records copy of a runner job", () => {
  test("complete copies the records; one whose first copy failed is copied by the sweep (MUTATION: drop the sweep's copy step)", async () => {
    const r = await runner();
    const jobId = await dispatch();
    const entry = await claimOne(r);
    await heartbeat(r, jobId, entry.lease_id, "started");
    expect((await uploadAs(entry)).complete).toBe(200);
    // The store is down for the completion's copy: the answer still says finished.
    const saved = env;
    env = fx.env({ ENVIRONMENT: "development", COMPUTE_RUNNERS_ENABLED: "1", API_BASE_URL: base });
    const down = failing(1000);
    env = { ...env, COMPUTE_RECORDS: down };
    const done = await complete(r, jobId, entry.lease_id);
    expect(done.body.state).toBe("finished");
    await flush();
    expect((await row(jobId)).result_records_at).toBeNull();
    env = saved;
    const swept = await sweepRunnerLeases(env);
    expect(swept.copied).toBe(1);
    expect((await row(jobId)).result_records_at).not.toBeNull();
    expect(await fx.harness.records.head(recordKey(jobId, "result.json"))).not.toBeNull();
  });
});

describe("the two attention words", () => {
  test("GET /admin/compute/status counts a live runner row cancelled 61 minutes ago and a terminal row left uncopied past the window (MUTATION: drop the executor term)", async () => {
    const { jobId } = await claimed();
    await sql(
      "UPDATE compute_jobs SET cancel_requested_at = datetime('now', '-61 minutes') WHERE id = ?1",
      jobId,
    );
    const other = await dispatch();
    await sql(
      `UPDATE compute_jobs SET state = 'finished', settled_provisional_at = datetime('now'),
              settled_final_at = datetime('now'), ended_at = datetime('now', '-4 days'),
              results_verified_at = datetime('now'), outputs_completed_at = datetime('now') WHERE id = ?1`,
      other,
    );
    const res = await admin("GET", "/compute/status");
    expect(res.status).toBe(200);
    expect(ComputeStatusResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.attention).toMatchObject({
      runner_cancel_pending_failed: 1,
      runner_copy_abandoned: 1,
      cancel_pending_failed: 0,
      copy_abandoned: 0,
    });
  });

  test("a cancel 59 minutes old and a terminal row inside the window are not counted", async () => {
    const { jobId } = await claimed();
    await sql(
      "UPDATE compute_jobs SET cancel_requested_at = datetime('now', '-59 minutes') WHERE id = ?1",
      jobId,
    );
    const other = await dispatch();
    await sql(
      `UPDATE compute_jobs SET state = 'finished', settled_provisional_at = datetime('now'),
              settled_final_at = datetime('now'), ended_at = datetime('now', '-2 days') WHERE id = ?1`,
      other,
    );
    const res = await admin("GET", "/compute/status");
    expect(res.body.attention).toMatchObject({
      runner_cancel_pending_failed: 0,
      runner_copy_abandoned: 0,
    });
  });
});

describe("the recipe of a runner job is the recipe's", () => {
  test("the registry entry the queue relies on", () => {
    const floor = findRecipe("nemar-floor");
    expect(floor?.executors).toEqual(["tapis", "runner"]);
    expect(floor?.inputs).toEqual(["bids", "zarr"]);
  });
});

// --- Review round 1 ---------------------------------------------------------------------------------------------

type D1Statement = {
  bind(...p: unknown[]): unknown;
  run(): Promise<unknown>;
  first(): Promise<unknown>;
  all(): Promise<unknown>;
  __execForBatch(): unknown;
};

/**
 * A database that lets ONE other writer in before the first statement whose text holds `match` runs: the
 * interleaving a real database has between two requests, made exact. Nothing is replaced: every statement
 * still runs on the real database, in the real order, and `fn` is what the other request did meanwhile.
 */
function hookD1(d1: D1Database, match: string, fn: () => Promise<void>): D1Database {
  let fired = false;
  const fire = async (sqlText: string) => {
    if (fired || !sqlText.includes(match)) return;
    fired = true;
    await fn();
  };
  return {
    prepare(sqlText: string) {
      const inner = d1.prepare(sqlText) as unknown as D1Statement;
      const api = {
        __sql: sqlText,
        bind(...p: unknown[]) {
          inner.bind(...p);
          return api;
        },
        async run() {
          await fire(sqlText);
          return inner.run();
        },
        async first() {
          await fire(sqlText);
          return inner.first();
        },
        async all() {
          await fire(sqlText);
          return inner.all();
        },
        __execForBatch() {
          return inner.__execForBatch();
        },
      };
      return api;
    },
    async batch(stmts: Array<{ __sql?: string }>) {
      for (const st of stmts) await fire(st.__sql ?? "");
      return (d1 as unknown as { batch(s: unknown[]): Promise<unknown> }).batch(stmts);
    },
  } as unknown as D1Database;
}

/** The other request: the job's lease expires, the sweep releases it, and `thief` claims it under a NEW lease. */
async function stealLease(jobId: string, thief: Runner): Promise<Claimed> {
  await age(jobId, "lease_expires_at", "-1 minute");
  await sweepRunnerLeases(env);
  const taken = await claimRunnerJobs(env, thief.principal, 1);
  expect(taken.jobs.map((j) => j.id)).toEqual([jobId]);
  return taken.jobs[0] as unknown as Claimed;
}

const completeBody = (jobId: string, leaseId: string, over: Record<string, unknown> = {}) => ({
  job_id: jobId,
  lease_id: leaseId,
  exit_number: 13,
  launcher_failure_code: null,
  launcher_detail: null,
  usage: { wall_seconds: 77, cpu_seconds: 88, max_rss_mb: 99 },
  usage_partial: false,
  scratch_discarded: true,
  ...over,
});

describe("at most once acceptance, under a race", () => {
  const MARK = "failure_detail = COALESCE(?5";

  test("a completion that lost its lease between the check and the write (the claim released and taken again) ends nothing, records no usage and is lease_lost (MUTATION: drop the lease from RUNNER_TERMINAL_TRANSITION_SQL, or from RECORD_USAGE_SQL)", async () => {
    const { r, jobId, entry } = await claimed();
    expect(RUNNER_TERMINAL_TRANSITION_SQL).toContain("AND lease_id IS ?17");
    const hooked = { ...env, DB: hookD1(env.DB, MARK, () => stealLease(jobId, r)) };
    const res = await completeRunnerJob(
      hooked,
      r.principal,
      completeBody(jobId, entry.lease_id) as never,
    );
    expect(res).toEqual({ ok: false, refusal: "lease_lost" });
    const job = await row(jobId);
    expect(job).toMatchObject({
      state: "created",
      failure_code: null,
      runner_wall_seconds: null,
      runner_id: r.id,
      claim_attempts: 2,
    });
    expect(job.lease_id).not.toBe(entry.lease_id);
    expect(job.settled_provisional_at).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM compute_ledger WHERE job_id = ?1", jobId)).toBe(
      0,
    );
  });

  test("so does one whose runner another runner replaced", async () => {
    const { r, jobId, entry } = await claimed();
    const b = await runner();
    const hooked = { ...env, DB: hookD1(env.DB, MARK, () => stealLease(jobId, b)) };
    const res = await completeRunnerJob(
      hooked,
      r.principal,
      completeBody(jobId, entry.lease_id) as never,
    );
    expect(res).toEqual({ ok: false, refusal: "lease_lost" });
    expect(await row(jobId)).toMatchObject({
      state: "created",
      runner_id: b.id,
      failure_code: null,
    });
  });

  test("and a completion that passed the check before a revoke cleared the lease cannot decide the end after it", async () => {
    const { r, jobId, entry } = await claimed();
    const hooked = {
      ...env,
      DB: hookD1(env.DB, MARK, async () => {
        expect((await revokeRunner(r.id)).status).toBe(200);
      }),
    };
    const res = await completeRunnerJob(
      hooked,
      r.principal,
      completeBody(jobId, entry.lease_id) as never,
    );
    expect(res).toEqual({ ok: false, refusal: "lease_lost" });
    expect(await row(jobId)).toMatchObject({
      state: "created",
      lease_id: null,
      failure_code: null,
      runner_wall_seconds: null,
    });
  });

  test("outputs-complete under a lease a revoke cleared between the route's check and the write changes nothing (MUTATION: drop the lease term of COMPLETE_OUTPUTS_SQL)", async () => {
    const { r, jobId, entry } = await claimed();
    const saved = env;
    env = {
      ...saved,
      DB: hookD1(saved.DB, "SET outputs_completed_at", async () => {
        env = saved;
        expect((await revokeRunner(r.id)).status).toBe(200);
      }),
    };
    try {
      const up = await uploadAs(entry);
      expect(up.outputs).toBe(200);
      expect(up.complete).toBe(409);
    } finally {
      env = saved;
    }
    const job = await row(jobId);
    expect(job.outputs_completed_at).toBeNull();
    expect(job.lease_id).toBeNull();
  });

  test("the claim of the declared bytes under a replaced lease changes nothing (MUTATION: drop the lease term of CLAIM_RESULTS_BYTES_SQL)", async () => {
    const { r, jobId, entry } = await claimed();
    const saved = env;
    let renewed: Claimed | null = null;
    env = {
      ...saved,
      DB: hookD1(saved.DB, "SET results_bytes", async () => {
        env = saved;
        renewed = await stealLease(jobId, r);
      }),
    };
    try {
      const up = await uploadAs(entry);
      expect(up.outputs).not.toBe(200);
    } finally {
      env = saved;
    }
    const job = await row(jobId);
    expect(job.results_bytes).toBeNull();
    expect(job.lease_id).not.toBe(entry.lease_id);
    // The stale request recorded NOTHING on the new holder's job (a refusal written under its lease would
    // fail its own outputs call and end the job result_upload_failed): MUTATION: record under the row's lease.
    expect(job.failure_detail).toBeNull();
    const holder = renewed as unknown as Claimed;
    expect((await uploadAs(holder)).outputs).toBe(200);
    expect((await row(jobId)).state).toBe("created");
  });

  test("a launch digest written under a lease that was replaced is refused, and that claim is not answered (MUTATION: drop the lease term of LAUNCH_DIGEST_UNDER_LEASE_SQL)", async () => {
    const r = await runner();
    const jobId = await dispatch();
    const hooked = {
      ...env,
      DB: hookD1(env.DB, "SET launch_spec_digest", () => stealLease(jobId, r)),
    };
    const first = await claimRunnerJobs(hooked, r.principal, 1);
    expect(first.jobs).toEqual([]);
    const job = await row(jobId);
    // The second claim (the thief's, the same runner under another lease) is the one that stands.
    expect(job).toMatchObject({ runner_id: r.id, claim_attempts: 2 });
    expect(job.launch_spec_digest).not.toBeNull();
  });
});

describe("a claim never burns a job's claims for a fault of NEMAR's", () => {
  test("a Worker with no API base address claims nothing, however often the runner polls (MUTATION: drop the configuration check)", async () => {
    const r = await runner();
    const jobId = await dispatch();
    const saved = env;
    env = { ...saved, API_BASE_URL: undefined } as unknown as Bindings;
    try {
      for (let i = 0; i < 5; i++) {
        const res = await claim(r, 1);
        expect(res.status).toBe(200);
        expect(res.body.jobs).toEqual([]);
      }
    } finally {
      env = saved;
    }
    await sweepRunnerLeases(env);
    expect(await row(jobId)).toMatchObject({
      state: "created",
      runner_id: null,
      claim_attempts: 0,
    });
    // Nothing was even tried: no claim statement ran (a claim given back is a write that should not happen).
    let tried = false;
    const watching = {
      ...env,
      API_BASE_URL: undefined,
      DB: hookD1(env.DB, "claim_attempts + 1", async () => {
        tried = true;
      }),
    } as unknown as Bindings;
    expect((await claimRunnerJobs(watching, r.principal, 3)).jobs).toEqual([]);
    expect(tried).toBe(false);
    // Nor with no runtime image: a poll that claimed one job only to give it back would still be a write.
    let triedNoImage = false;
    const noImage = {
      ...env,
      COMPUTE_RUNTIME_IMAGE: undefined,
      DB: hookD1(env.DB, "claim_attempts + 1", async () => {
        triedNoImage = true;
      }),
    } as unknown as Bindings;
    expect((await claimRunnerJobs(noImage, r.principal, 3)).jobs).toEqual([]);
    expect(triedNoImage).toBe(false);
    // The same holds for the secret and the records bucket, through the service.
    for (const gap of [
      { PRESCREEN_CALLBACK_SECRET: undefined },
      { COMPUTE_RECORDS: undefined },
      { COMPUTE_RUNTIME_IMAGE: undefined },
    ]) {
      expect((await claimRunnerJobs({ ...env, ...gap } as Bindings, r.principal, 3)).jobs).toEqual(
        [],
      );
    }
    expect((await row(jobId)).claim_attempts).toBe(0);
    expect((await claimOne(r)).id).toBe(jobId);
  });

  test("a records bucket that throws for one job COUNTS its claim, goes on to the next job, and ends the poisoned row claims_exhausted after three (MUTATION: uncount the give-back, or stop at the first throw)", async () => {
    const r = await runner();
    const [one, two, three] = [await dispatch(), await dispatch(), await dispatch()] as [
      string,
      string,
      string,
    ];
    for (const [i, id] of [one, two, three].entries()) {
      await age(id, "created_at", `-${3 - i} minutes`);
    }
    const real = fx.harness.records;
    const down = {
      put: (k: string, v: unknown, o?: unknown) =>
        real.put(k, v as ArrayBuffer, o as Parameters<R2Bucket["put"]>[2]),
      get: async (key: string) => {
        if (key === recordKey(two, "spec.json")) throw new Error("the store is down for this one");
        return real.get(key);
      },
      head: (k: string) => real.head(k),
      delete: (k: string) => real.delete(k),
      list: (o?: Parameters<R2Bucket["list"]>[0]) => real.list(o),
    } as unknown as R2Bucket;
    const broken = { ...env, COMPUTE_RECORDS: down };
    // Call 1: the first job is answered; the poisoned one is claimed twice more (counted) and given back each time.
    const first = await claimRunnerJobs(broken, r.principal, 3);
    expect(first.jobs.map((j) => j.id)).toEqual([one]);
    expect(await row(two)).toMatchObject({ state: "created", runner_id: null, claim_attempts: 2 });
    // Call 2: its third claim is counted too, and then the NEXT job is claimed (the pool is not stalled).
    const second = await claimRunnerJobs(broken, r.principal, 3);
    expect(second.jobs.map((j) => j.id)).toEqual([three]);
    expect(await row(two)).toMatchObject({ claim_attempts: 3, runner_id: null });
    // And the sweep ends it: three counted claims.
    await sweepRunnerLeases(env);
    expect(await row(two)).toMatchObject({
      state: "failed",
      failure_code: "runner_lost",
      failure_detail: "claims_exhausted",
    });
  });

  test("a database that fails the second claim statement still answers the job already built, and does not throw (MUTATION: drop the try around the claim statement)", async () => {
    const r = await runner();
    const [one, two] = [await dispatch(), await dispatch()] as [string, string];
    await age(one, "created_at", "-2 minutes");
    await age(two, "created_at", "-1 minutes");
    let n = 0;
    const real = env.DB;
    const flaky = {
      prepare(text: string) {
        const st = real.prepare(text) as unknown as D1Statement;
        const api = {
          bind(...p: unknown[]) {
            st.bind(...p);
            return api;
          },
          async run() {
            if (text.includes("claim_attempts + 1") && ++n === 2)
              throw new Error("the database failed");
            return st.run();
          },
          first: () => st.first(),
          all: () => st.all(),
          __execForBatch: () => st.__execForBatch(),
        };
        return api;
      },
      batch: (stmts: unknown[]) =>
        (real as unknown as { batch(s: unknown[]): unknown }).batch(stmts),
    } as unknown as D1Database;
    const answered = await claimRunnerJobs({ ...env, DB: flaky }, r.principal, 3);
    expect(answered.jobs.map((j) => j.id)).toEqual([one]);
    expect((await row(two)).runner_id).toBeNull();
  });

  test("a specification that can never be built ends the job failed launch_failed (invalid_spec), settled with charge 0, and the next job is still answered", async () => {
    const r = await runner();
    const bad = await dispatch();
    const good = await dispatch();
    await age(bad, "created_at", "-2 minutes");
    await age(good, "created_at", "-1 minutes");
    await fx.harness.records.delete(recordKey(bad, "spec.json"));
    const answered = await claimRunnerJobs(env, r.principal, 2);
    expect(answered.jobs.map((j) => j.id)).toEqual([good]);
    const job = await row(bad);
    expect(job).toMatchObject({
      state: "failed",
      failure_code: "launch_failed",
      failure_detail: "invalid_spec",
      charged_milli: 0,
      platform_failure: 1,
    });
    expect(job.settled_final_at).not.toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM compute_ledger WHERE job_id = ?1", bad)).toBe(0);
  });
});

describe("the sweep cannot be starved", () => {
  /** Waiting rows whose records never landed and whose specification can no longer be rebuilt. */
  async function unreplayable(n: number): Promise<string[]> {
    const bad = { ...env, COMPUTE_RECORDS: failing(1_000_000) };
    const made: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = await dataset();
      const r = await dispatchPipelineJob(bad, {
        recipe: "nemar-floor",
        datasetId: id,
        actor: { kind: "admin", userId: ids.admin },
        executor: "runner",
      });
      if (!r.ok) throw new Error(`could not dispatch: ${r.code}`);
      await age(r.jobId, "created_at", "-6 minutes");
      github.tag(id, "v1.0.0", "f".repeat(40));
      made.push(r.jobId);
    }
    return made;
  }

  test("ten or more rows the replay can never rebuild do not stop the other steps, and rotate (MUTATION: one shared budget; or drop the examined_at order)", async () => {
    // A claimed job with a recorded cancel and an expired lease: step 2 must still end it.
    const { jobId } = await claimed();
    const stuck = await unreplayable(11);
    await admin("POST", `/compute/jobs/${jobId}/cancel`);
    await age(jobId, "lease_expires_at", "-1 minute");

    const first = await sweepRunnerLeases(env);
    expect(first.cancelled).toBe(1);
    expect((await row(jobId)).state).toBe("cancelled");
    expect(first.saturated).toBeGreaterThanOrEqual(1);
    const examined = async () =>
      await count(
        `SELECT COUNT(*) AS n FROM compute_jobs WHERE id IN (${stuck.map(() => "?").join(",")}) AND examined_at IS NOT NULL`,
        ...stuck,
      );
    expect(await examined()).toBe(10);
    // Rotation: the one the first call did not reach is the first of the second.
    await sweepRunnerLeases(env);
    expect(await examined()).toBe(11);
    expect((await row(stuck[0] as string)).state).toBe("created");
  });

  test("a row whose records never landed and could not be replayed for an hour ends failed records_unavailable, which frees its slot (MUTATION: drop the give-up step)", async () => {
    const stuck = await unreplayable(11);
    for (const id of stuck) await age(id, "created_at", "-61 minutes");
    const first = await sweepRunnerLeases(env);
    expect(first.records_lost).toBe(10);
    const second = await sweepRunnerLeases(env);
    expect(second.records_lost).toBe(1);
    for (const id of stuck) {
      const job = await row(id);
      expect(job).toMatchObject({
        state: "failed",
        failure_code: "records_unavailable",
        failure_detail: "records_unreadable",
        charged_milli: 0,
      });
      expect(job.settled_final_at).not.toBeNull();
    }
  });

  test("a row left unwritten well past the window is an attention word (runner_records_unwritten)", async () => {
    const [id] = await unreplayable(1);
    await age(id as string, "created_at", "-130 minutes");
    const res = await admin("GET", "/compute/status");
    expect(res.body.attention).toMatchObject({ runner_records_unwritten: 1 });
    expect(ComputeStatusResponseSchema.safeParse(res.body).success).toBe(true);
  });
});

describe("outputs that completed are never run again", () => {
  test("an uploading heartbeat starts a created job, so its deadline runs", async () => {
    const { r, jobId, entry } = await claimed();
    expect((await heartbeat(r, jobId, entry.lease_id, "uploading")).status).toBe(200);
    const job = await row(jobId);
    expect(job.state).toBe("archiving");
    expect(job.started_at).not.toBeNull();
  });

  test("a claim whose outputs completed but never sent started is verified, not released and run again (MUTATION: drop the outputs term of the release)", async () => {
    const { jobId, entry } = await claimed();
    expect((await uploadAs(entry)).complete).toBe(200);
    await age(jobId, "lease_expires_at", "-1 minute");
    const swept = await sweepRunnerLeases(env);
    expect(swept.released).toBe(0);
    const job = await row(jobId);
    expect(job).toMatchObject({ state: "finished", claim_attempts: 1, charged_milli: 0 });
    expect(job.results_verified_at).not.toBeNull();
  });
});

describe("outputs that completed are verified even when no claims are left", () => {
  test("a claim on its last attempt whose outputs completed is verified, not failed claims_exhausted (MUTATION: drop the outputs term of the exhausted rows)", async () => {
    const { jobId, entry } = await claimed();
    expect((await uploadAs(entry)).complete).toBe(200);
    await sql("UPDATE compute_jobs SET claim_attempts = 3 WHERE id = ?1", jobId);
    await age(jobId, "lease_expires_at", "-1 minute");
    const swept = await sweepRunnerLeases(env);
    expect(swept.exhausted).toBe(0);
    expect(await row(jobId)).toMatchObject({ state: "finished", failure_code: null });
  });
});

describe("a runner that ignores a cancel", () => {
  test("keeps renewing its lease and is ended cancelled at the deadline (MUTATION: exclude cancel-requested rows from the deadline)", async () => {
    const { r, jobId, entry } = await claimed();
    await heartbeat(r, jobId, entry.lease_id, "started");
    await admin("POST", `/compute/jobs/${jobId}/cancel`);
    await age(jobId, "started_at", `-${FLOOR_MINUTES + 16} minutes`);
    expect((await heartbeat(r, jobId, entry.lease_id, "uploading")).body.cancel).toBe(true);
    await sweepRunnerLeases(env);
    expect(await row(jobId)).toMatchObject({
      state: "cancelled",
      cancel_reason: "admin",
      failure_code: null,
    });
  });
});

describe("a claim is bounded by what the runner registered", () => {
  test("two jobs fit eight cores and 40 GB, the third waits for room, however many slots are asked for (MUTATION: drop the held terms)", async () => {
    const r = await runner(env, { cores: 8, memory_mb: 40_000 });
    const wanted = [await dispatch(), await dispatch(), await dispatch()];
    for (const [i, id] of wanted.entries()) await age(id, "created_at", `-${3 - i} minutes`);
    const jobs = RunnerClaimResponseSchema.parse((await claim(r, 32)).body)
      .jobs as unknown as Claimed[];
    expect(jobs.map((j) => j.id)).toEqual([wanted[0], wanted[1]]);
    expect((await row(wanted[2] as string)).runner_id).toBeNull();
    // A job that ends gives its room back.
    const first = jobs[0] as Claimed;
    expect((await complete(r, first.id, first.lease_id, { exit_number: 13 })).body.state).toBe(
      "failed",
    );
    expect((await claimOne(r)).id).toBe(wanted[2]);
  });
});

describe("a poll does not wait on the slow steps", () => {
  test("a claim answers while a verification waits on the results bucket, and the verification finishes afterwards (MUTATION: run the slow steps inline)", async () => {
    const { r: a, jobId: slowJob, entry } = await claimed();
    await heartbeat(a, slowJob, entry.lease_id, "started");
    expect((await uploadAs(entry)).complete).toBe(200);
    await age(slowJob, "lease_expires_at", "-1 minute");
    const waiting = await dispatch();
    const b = await runner();

    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const real = fx.harness.results;
    const gated = {
      put: (k: string, v: unknown, o?: unknown) =>
        real.put(k, v as ArrayBuffer, o as Parameters<R2Bucket["put"]>[2]),
      get: (k: string) => real.get(k),
      head: (k: string) => real.head(k),
      delete: (k: string) => real.delete(k),
      list: async (o?: Parameters<R2Bucket["list"]>[0]) => {
        await gate;
        return real.list(o);
      },
    } as unknown as R2Bucket;
    const saved = env;
    env = { ...saved, COMPUTE_RESULTS: gated };
    let answered: Reply;
    try {
      answered = await claim(b, 1);
    } finally {
      env = saved;
    }
    // Answered with the waiting job, while the verification still waits.
    expect((answered.body.jobs as Array<{ id: string }>).map((j) => j.id)).toEqual([waiting]);
    expect((await row(slowJob)).state).toBe("unreported");
    open();
    await flush();
    expect(await row(slowJob)).toMatchObject({ state: "finished", charged_milli: 0 });
  });
});

describe("the runner sweep ignores what is not a runner's", () => {
  test("a Tapis row that is terminal and uncopied is not copied by the runner sweep (MUTATION: drop executor = 'runner' from RUNNER_UNCOPIED_SQL)", async () => {
    await sql(
      `INSERT INTO compute_jobs
         (id, source, kind, state, app_id, app_version, spec_digest, partition, pool, nodes,
          cores_per_node, minutes, ended_at, settled_provisional_at)
       VALUES ('job_${"7".repeat(24)}', 'pipeline', 'batch', 'finished', 'a', '1', ?1, 'shared', 'cpu',
               1, 1, 1, datetime('now'), datetime('now'))`,
      "a".repeat(64),
    );
    // The Tapis list still holds it (the runner sweep must not be the one that takes it).
    const tapisList = (await env.DB.prepare(UNCOPIED_TERMINAL_SQL).bind(10).all()).results;
    expect(tapisList).toHaveLength(1);
    const swept = await sweepRunnerLeases(env);
    expect(swept.copied).toBe(0);
    expect((await row(`job_${"7".repeat(24)}`)).result_records_at).toBeNull();
  });

  test("a claim with no claims left is failed, not released (MUTATION: drop claim_attempts < from the release)", async () => {
    const { jobId } = await claimed();
    await sql("UPDATE compute_jobs SET claim_attempts = 3 WHERE id = ?1", jobId);
    await age(jobId, "lease_expires_at", "-1 minute");
    const swept = await sweepRunnerLeases(env);
    expect(swept.released).toBe(0);
    expect(swept.exhausted).toBe(1);
    expect(await row(jobId)).toMatchObject({ state: "failed", failure_detail: "claims_exhausted" });
  });
});

// --- Review round 2 ---------------------------------------------------------------------------------------------

describe("the replay of records is throttled, bounded and last", () => {
  /** Waiting rows whose records never landed (the store was down), old enough to replay. */
  async function unwritten(n: number, minutes = 6): Promise<Array<{ jobId: string; id: string }>> {
    const bad = { ...env, COMPUTE_RECORDS: failing(1_000_000) };
    const made: Array<{ jobId: string; id: string }> = [];
    for (let i = 0; i < n; i++) {
      const id = await dataset();
      const r = await dispatchPipelineJob(bad, {
        recipe: "nemar-floor",
        datasetId: id,
        actor: { kind: "admin", userId: ids.admin },
        executor: "runner",
      });
      if (!r.ok) throw new Error(`could not dispatch: ${r.code}`);
      await age(r.jobId, "created_at", `-${minutes} minutes`);
      made.push({ jobId: r.jobId, id });
    }
    return made;
  }

  test("with ten unwritten rows and the store down, a second poll within five minutes asks GitHub for nothing; five minutes later it asks again (MUTATION: drop the examined_at throttle)", async () => {
    const rows = await unwritten(10);
    const down = { ...env, COMPUTE_RECORDS: failing(1_000_000) };
    github.log.length = 0;
    const first = await sweepRunnerLeases(down);
    const asked = github.log.length;
    expect(asked).toBeGreaterThan(0);
    expect(first.replayed).toBe(0);
    await sweepRunnerLeases(down);
    await sweepRunnerLeases(down);
    expect(github.log.length).toBe(asked);
    for (const { jobId } of rows) await age(jobId, "examined_at", "-6 minutes");
    await sweepRunnerLeases(down);
    expect(github.log.length).toBeGreaterThan(asked);
  });

  test("verifications and copies run before the replays, so a slow GitHub keeps neither from running (MUTATION: run the replays first)", async () => {
    const { r, jobId, entry } = await claimed();
    await heartbeat(r, jobId, entry.lease_id, "started");
    expect((await uploadAs(entry)).complete).toBe(200);
    await age(jobId, "lease_expires_at", "-1 minute");
    await unwritten(1);
    github.stall(2500, "github");
    let settled = false;
    let deferred: Promise<unknown> = Promise.resolve();
    await sweepRunnerLeases(env, env.DB, {
      defer: (p) => {
        deferred = p.then(() => {
          settled = true;
        });
      },
      replayBoundMs: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    // The replay still waits on GitHub; the verification and the copy are done.
    expect(settled).toBe(false);
    const job = await row(jobId);
    expect(job.state).toBe("finished");
    expect(job.result_records_at).not.toBeNull();
    await deferred;
  });

  test("one replay is bounded: a GitHub that stalls for seconds holds the slow phase for the bound only (MUTATION: drop the bound)", async () => {
    await unwritten(1);
    github.stall(2500, "github");
    let deferred: Promise<unknown> = Promise.resolve();
    await sweepRunnerLeases(env, env.DB, {
      defer: (p) => {
        deferred = p;
      },
      replayBoundMs: 200,
    });
    const started = Date.now();
    await deferred;
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test("no replay starts after the phase's allowance (MUTATION: drop the allowance)", async () => {
    await unwritten(3);
    github.stall(400, "github");
    let deferred: Promise<unknown> = Promise.resolve();
    github.log.length = 0;
    await sweepRunnerLeases(env, env.DB, {
      defer: (p) => {
        deferred = p;
      },
      replayBoundMs: 5000,
      replayPhaseMs: 100,
    });
    await deferred;
    // The first replay runs (the allowance is checked before each one after the first has started the clock), the rest do not.
    const rows = github.log.filter((l) => l.path.includes("/commits/")).length;
    expect(rows).toBeLessThanOrEqual(1);
  });

  test("a row aged past the window whose replay now succeeds is replayed, not given up on, and no records are written onto a failed row (MUTATION: give up before the replay)", async () => {
    const [stuck] = await unwritten(1, 61);
    const swept = await sweepRunnerLeases(env);
    expect(swept.replayed).toBe(1);
    expect(swept.records_lost).toBe(0);
    const job = await row(stuck?.jobId as string);
    expect(job.state).toBe("created");
    expect(job.records_written_at).not.toBeNull();
  });

  test("a row aged past the window whose source cannot be reached is not given up on: an unreachable source is not a mismatch (MUTATION: treat unreachable as a mismatch)", async () => {
    const [stuck] = await unwritten(1, 61);
    github.tag(stuck?.id as string, "v1.0.0", { http: 500 });
    const swept = await sweepRunnerLeases(env);
    expect(swept.records_lost).toBe(0);
    expect(swept.replayed).toBe(0);
    expect((await row(stuck?.jobId as string)).state).toBe("created");
  });

  test("a row aged past the window whose source no longer says what was recorded is given up on, in the same call as its replay", async () => {
    const [stuck] = await unwritten(1, 61);
    github.tag(stuck?.id as string, "v1.0.0", "f".repeat(40));
    const swept = await sweepRunnerLeases(env);
    expect(swept.records_lost).toBe(1);
    expect(swept.replayed).toBe(0);
    expect(await row(stuck?.jobId as string)).toMatchObject({
      state: "failed",
      failure_code: "records_unavailable",
    });
  });
});

describe("a claim whose outputs were declared is never released", () => {
  test("declared but not completed: not released, unreported keeping its lease, and given up on after the wait (MUTATION: drop results_bytes IS NULL from the release)", async () => {
    const { jobId, entry } = await claimed();
    expect((await uploadAs(entry, { skipComplete: true })).outputs).toBe(200);
    await age(jobId, "lease_expires_at", "-1 minute");
    const swept = await sweepRunnerLeases(env);
    expect(swept.released).toBe(0);
    expect(await row(jobId)).toMatchObject({
      state: "unreported",
      lease_id: entry.lease_id,
      claim_attempts: 1,
    });
    await age(jobId, "lease_expires_at", "-61 minutes");
    await sweepRunnerLeases(env);
    expect(await row(jobId)).toMatchObject({ state: "failed", failure_detail: "lease_expired" });
  });

  test("declared on the last claim: unreported too, not failed claims_exhausted (MUTATION: drop the results_bytes term of the exhausted rows)", async () => {
    const { jobId, entry } = await claimed();
    expect((await uploadAs(entry, { skipComplete: true })).outputs).toBe(200);
    await sql("UPDATE compute_jobs SET claim_attempts = 3 WHERE id = ?1", jobId);
    await age(jobId, "lease_expires_at", "-1 minute");
    const swept = await sweepRunnerLeases(env);
    expect(swept.exhausted).toBe(0);
    expect((await row(jobId)).state).toBe("unreported");
  });
});

describe("a completion that lost its commit to a heartbeat", () => {
  test("is committed again from the row read anew, and answers the end state (MUTATION: no second commit)", async () => {
    const { r, jobId, entry } = await claimed();
    await heartbeat(r, jobId, entry.lease_id, "started");
    expect((await row(jobId)).state).toBe("running");
    const hooked = {
      ...env,
      DB: hookD1(env.DB, "failure_detail = COALESCE(?5", async () => {
        expect((await heartbeat(r, jobId, entry.lease_id, "uploading")).status).toBe(200);
      }),
    };
    const res = await completeRunnerJob(
      hooked,
      r.principal,
      completeBody(jobId, entry.lease_id) as never,
    );
    expect(res).toMatchObject({ ok: true, state: "failed" });
    const job = await row(jobId);
    expect(job).toMatchObject({
      state: "failed",
      failure_code: "runtime_error",
      runner_wall_seconds: 77,
    });
    expect(job.settled_final_at).not.toBeNull();
  });
});

describe("the lease statement is chosen fail-closed (a source search)", () => {
  test("commitTerminal carries the lease for anything that is not a Tapis row (MUTATION: === runner)", () => {
    const src = readFileSync(join(import.meta.dir, "../src/services/compute-lifecycle.ts"), "utf8");
    expect(src).toContain('const runnerRow = job.executor !== "tapis";');
  });
});

describe("a waiting job that can never be claimed does not hold a slot", () => {
  const live = () =>
    count("SELECT COUNT(*) AS n FROM compute_jobs WHERE executor = 'runner' AND state = 'created'");

  test("a dataset made private (or withdrawn) is ended dataset_ineligible, its slot freed; an eligible job is untouched", async () => {
    await setPolicy(env.DB, ids.owner, { runners: { maxLiveJobs: { cpu: 2, gpu: 8 } } });
    const gone = await dataset();
    const withdrawn = await dataset();
    const kept = await dispatch();
    const goneJob = await dispatch(env, gone);
    expect(await live()).toBe(2);
    await sql("UPDATE datasets SET visibility = 'private' WHERE dataset_id = ?1", gone);
    await age(goneJob, "created_at", "-11 minutes");
    await age(kept, "created_at", "-11 minutes");
    const swept = await sweepRunnerLeases(env);
    expect(swept.ineligible).toBe(1);
    expect(await row(goneJob)).toMatchObject({
      state: "failed",
      failure_code: "runner_lost",
      failure_detail: "dataset_ineligible",
      charged_milli: 0,
    });
    expect((await row(kept)).state).toBe("created");
    // The slot is free again: a job over the (eligible) dataset fits.
    const fits = await dispatchPipelineJob(env, {
      recipe: "nemar-floor",
      datasetId: withdrawn,
      actor: { kind: "admin", userId: ids.admin },
      executor: "runner",
    });
    expect(fits.ok).toBe(true);
    // A withdrawn dataset is ended too.
    if (fits.ok) {
      await sql(
        "UPDATE datasets SET withdrawn_at = datetime('now') WHERE dataset_id = ?1",
        withdrawn,
      );
      await age(fits.jobId, "created_at", "-11 minutes");
      expect((await sweepRunnerLeases(env)).ineligible).toBe(1);
      expect((await row(fits.jobId)).failure_detail).toBe("dataset_ineligible");
    }
  });

  test("a deleted dataset ends its waiting job on the next sweep", async () => {
    const id = await dataset();
    const jobId = await dispatch(env, id);
    await sql("PRAGMA foreign_keys = OFF");
    await sql("DELETE FROM datasets WHERE dataset_id = ?1", id);
    await age(jobId, "created_at", "-11 minutes");
    const swept = await sweepRunnerLeases(env);
    expect(swept.ineligible).toBe(1);
    expect(await row(jobId)).toMatchObject({
      state: "failed",
      failure_detail: "dataset_ineligible",
    });
  });

  test("a job seconds old with no stamp linked yet is being dispatched, not an orphan (MUTATION: drop the age guard)", async () => {
    const jobId = await dispatch();
    // The window between the job insert and LINK_STAMP_SQL: the job exists, no stamp names it yet.
    await sql("UPDATE compute_pipeline_stamps SET job_id = NULL WHERE job_id = ?1", jobId);
    expect((await sweepRunnerLeases(env)).ineligible).toBe(0);
    expect((await row(jobId)).state).toBe("created");
    // Once it is old enough to have been linked, an unlinked job is an orphan.
    await age(jobId, "created_at", "-11 minutes");
    expect((await sweepRunnerLeases(env)).ineligible).toBe(1);
  });

  test("a job waiting over a day is the runner_waiting_stale attention word; a fresh one is not", async () => {
    const stale = await dispatch();
    await dispatch();
    await age(stale, "created_at", "-25 hours");
    const res = await admin("GET", "/compute/status");
    expect(res.body.attention).toMatchObject({ runner_waiting_stale: 1 });
    expect(ComputeStatusResponseSchema.safeParse(res.body).success).toBe(true);
  });
});
