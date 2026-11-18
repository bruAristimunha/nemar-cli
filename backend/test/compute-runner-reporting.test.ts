/**
 * What an administrator reads about runner jobs (portable compute, card S6; ADR 0121 item 6 and its
 * consequence that a runner-reported core-hour is never added to a service-unit total; risk K14), through
 * NEMAR's REAL routes over a real migrated database (bun:sqlite behind `realD1`), Miniflare's R2, the Tapis
 * stand-in and the real local S3 interface the presigned PUTs reach.
 *
 * THE JOBS ARE REAL. One Tapis pipeline job is dispatched and run to its end; two runner jobs are dispatched
 * and driven by a runner over the real loopback routes (claim, heartbeat, outputs, complete), one finished
 * with full usage and one failed with usage the runner marked PARTIAL; a third is claimed by a second runner
 * and never completed. The only thing played is what a container writes (the launcher's documents), as in
 * `compute-runner-queue.test.ts`, whose pattern this follows. Every figure asserted is a number the test sent
 * to the completion route, never one read back from the Worker.
 *
 * What is pinned, each group with the mutation that kills it named in its tests:
 *  (a) the completion stores the partial mark (1, 0 or NULL) and a repeat completion cannot change it;
 *  (b) the account report: `totals` and `by_pool` are the Tapis job's service units ALONE, `runner_totals`
 *      are the runner jobs alone, each job row names its executor, accounting, runner and usage, and the
 *      partial mark is where the runner put it;
 *  (c) the job list filters by executor, accounting and runner (bound column tests) and refuses a value
 *      that is not one, and marks partial usage in the list and the record;
 *  (d) the runners' usage report: per registration, by state, the sums, the largest memory, the partial
 *      count, a revoked registration listed, the date range's two ends and its length;
 *  (e) no identity, and the role gate.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { LAUNCHER_FILES } from "../../shared/contract/compute";
import {
  COMPUTE_RUNNER_REPORT_DAYS_MAX,
  ComputeAccountReportResponseSchema,
  ComputeJobAdminResponseSchema,
  ComputeJobsListResponseSchema,
  ComputeRecordResponseSchema,
  ComputeRunnersUsageResponseSchema,
} from "../../shared/contract/compute-admin";
import { LaunchSpecSchema, decodeLaunchSpecEnv } from "../../shared/contract/compute-launch";
import {
  RUNNER_LEASE_HEADER,
  RUNNER_PROTOCOL,
  RunnerClaimResponseSchema,
} from "../../shared/contract/compute-runner";
import { adminRoutes } from "../src/routes/admin";
import { computeRoutes } from "../src/routes/compute";
import { computeRunnerRoutes } from "../src/routes/compute-runners";
import { dispatchPipelineJob } from "../src/services/compute-pipeline";
import { sha256Hex } from "../src/services/compute-records";
import { runnerCoreHours, runnersUsageReport } from "../src/services/compute-reporting";
import {
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
import {
  finishAtTapis,
  floorOutputs,
  fundPipelines,
  seedEegDataset,
  seedPipelinesAccount,
} from "./helpers/compute-pipeline-fixture";
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
let github: GithubCompareStandin;
const pending: Promise<unknown>[] = [];
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
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => handle(req, env) });
  base = `http://127.0.0.1:${server.port}`;
}, 120_000);

beforeEach(async () => {
  await flush();
  github?.reset();
  await fx.reset();
  ids = await seedComputeUsers(fx.harness.db);
  env = fx.env({ ENVIRONMENT: "development", COMPUTE_RUNNERS_ENABLED: "1", API_BASE_URL: base });
  await seedPipelinesAccount(env);
  await fundPipelines(env);
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

// --- Seeds, as the runner queue's suite makes them ----------------------------------------------------

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
let seq = 0;

/** A public EEG dataset with a ready Zarr serving copy, and its id (a runner job reads Zarr). */
async function zarrDataset(): Promise<string> {
  const id = `nm${String(1000 + ++seq).padStart(6, "0")}`;
  await seedEegDataset(env, id);
  github.tag(id, "v1.0.0", COMMIT);
  github.index(id, { source_commit: COMMIT, store_count: 3 });
  await env.DB.prepare(
    "UPDATE datasets SET zarr_source_commit = ?1, zarr_status = 'ready', zarr_store_count = 3 WHERE dataset_id = ?2",
  )
    .bind(COMMIT, id)
    .run();
  return id;
}

/** A runner job dispatched the way an administrator dispatches one. Its id. */
async function dispatchRunnerJob(): Promise<string> {
  const r = await dispatchPipelineJob(env, {
    recipe: "nemar-floor",
    datasetId: await zarrDataset(),
    actor: { kind: "admin", userId: ids.admin },
    executor: "runner",
  });
  if (!r.ok) throw new Error(`could not dispatch: ${r.code}`);
  return r.jobId;
}

/** A Tapis pipeline job dispatched and run to `finished`, charged by Tapis' own timings. Its id. */
async function finishedTapisJob(): Promise<string> {
  const datasetId = `nm${String(2000 + ++seq).padStart(6, "0")}`;
  await seedEegDataset(env, datasetId);
  const r = await dispatchPipelineJob(env, {
    recipe: "nemar-floor",
    datasetId,
    actor: { kind: "admin", userId: ids.admin },
  });
  if (!r.ok) throw new Error(`could not dispatch: ${r.code}`);
  await finishAtTapis(fx, env, r.jobId, { outputs: floorOutputs() });
  const job = await row(r.jobId);
  if (job.state !== "finished") throw new Error(`the Tapis job is ${job.state}, not finished`);
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
}

/** A registered runner with an access token: the owner's registration and the runner's exchange. */
async function runner(over: Record<string, unknown> = {}): Promise<Runner> {
  const body = { ...REGISTRATION, name: `runner_${++seq}`, ...over } as Parameters<
    typeof registerRunner
  >[2];
  const { runnerId } = await registerRunner(env.DB, ids.owner, body);
  const issued = await exchangeRunnerSecret(env.DB, runnerId, "0.1.0");
  if (!issued) throw new Error("no token");
  const access = await resolveRunnerAccess(env.DB, issued.accessToken);
  if (access.kind !== "ok") throw new Error("no access");
  return { id: runnerId, token: issued.accessToken };
}

async function post(path: string, token: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
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

type Claimed = { id: string; lease_id: string; launch_spec_env: string };

/** Claim one job and return its entry (and fail the case if the answer is not one entry). */
async function claimOne(r: Runner): Promise<Claimed> {
  const res = await post("/compute/runners/claim", r.token, {
    protocol: RUNNER_PROTOCOL,
    free_slots: 1,
    runtimes: ["docker"],
    arch: "amd64",
    runner_version: "0.1.0",
  });
  expect(res.status).toBe(200);
  const parsed = RunnerClaimResponseSchema.parse(res.body);
  expect(parsed.jobs).toHaveLength(1);
  return parsed.jobs[0] as unknown as Claimed;
}

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

const sha = async (text: string) => sha256Hex(new TextEncoder().encode(text));

/**
 * What the runner's launcher does with the routes, from the launch specification the Worker answered: the
 * outputs call, the presigned PUTs, the outputs-complete call. Returns the statuses; the case reads them.
 */
async function uploadOutputs(entry: Claimed): Promise<number[]> {
  const decoded = decodeLaunchSpecEnv(entry.launch_spec_env);
  if (!decoded.ok) throw new Error("the launcher would refuse the launch specification");
  const spec = LaunchSpecSchema.parse(JSON.parse(decoded.text));
  const enc = new TextEncoder();
  const files = [{ path: "report.txt", content: "the report" }];
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
      launch_spec_digest: await sha(decoded.text),
      bundle_digest: null,
      image: { uri: spec.image.uri, digest: RUNTIME_IMAGE_DIGEST },
      runtime_version: "reporting-test 1.0",
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
    [RUNNER_LEASE_HEADER]: entry.lease_id,
  };
  const statuses: number[] = [];
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
  statuses.push(outputsRes.status);
  const { uploads } = (await outputsRes.json()) as {
    uploads: Array<{ path: string; url: string }>;
  };
  for (const u of uploads) {
    const content = u.path.startsWith("outputs/")
      ? (files.find((f) => `outputs/${f.path}` === u.path)?.content as string)
      : (launcherText[u.path.replace("launcher/", "")] as string);
    statuses.push((await fetch(u.url, { method: "PUT", body: enc.encode(content) })).status);
  }
  const done = await fetch(`${spec.api_base}/compute/jobs/${entry.id}/outputs/complete`, {
    method: "POST",
    headers,
  });
  statuses.push(done.status);
  await done.text();
  return statuses;
}

/** The admin routes, as an owner, an administrator, a member or nobody. */
async function admin(
  path: string,
  who: keyof typeof COMPUTE_KEYS | null = "admin",
  method: "GET" | "POST" = "GET",
) {
  const res = await handle(
    new Request(`http://api.test/admin${path}`, {
      method,
      headers: who === null ? {} : { Authorization: `Bearer ${COMPUTE_KEYS[who]}` },
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
  return { status: res.status, body: parsed, text };
}

const revokeRunner = async (id: string) =>
  (
    await handle(
      new Request(`http://api.test/admin/compute/runners/${id}/revoke`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${COMPUTE_KEYS.owner}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      env,
    )
  ).status;

// --- The scenario ------------------------------------------------------------------------------------------

/** The usage the test sends, so every asserted figure is one it chose. */
const FINISHED_USAGE = { wall_seconds: 120, cpu_seconds: 400, max_rss_mb: 2048 };
const PARTIAL_USAGE = { wall_seconds: 300, cpu_seconds: 7200, max_rss_mb: 4096 };

interface Scenario {
  tapis: string;
  finished: string;
  partial: string;
  waiting: string;
  first: Runner;
  second: Runner;
  /** The account every pipeline job is made for. */
  account: number;
}

/**
 * One account's three kinds of job: a Tapis job run to its end, two jobs the first runner ran (one finished
 * with usage it measured whole, one failed with usage it marked partial) and one the second runner claimed
 * and never completed.
 */
async function scenario(): Promise<Scenario> {
  const tapis = await finishedTapisJob();
  const first = await runner();
  const second = await runner();

  const finished = await dispatchRunnerJob();
  const a = await claimOne(first);
  expect(a.id).toBe(finished);
  expect((await heartbeat(first, finished, a.lease_id, "started")).status).toBe(200);
  expect((await uploadOutputs(a)).every((s) => s === 200)).toBe(true);
  expect((await heartbeat(first, finished, a.lease_id, "uploading")).status).toBe(200);
  const done = await complete(first, finished, a.lease_id, { usage: FINISHED_USAGE });
  expect([done.status, done.body.state]).toEqual([200, "finished"]);

  const partial = await dispatchRunnerJob();
  const b = await claimOne(first);
  expect(b.id).toBe(partial);
  const failed = await complete(first, partial, b.lease_id, {
    exit_number: 13,
    usage: PARTIAL_USAGE,
    usage_partial: true,
  });
  expect([failed.status, failed.body.state]).toEqual([200, "failed"]);

  const waiting = await dispatchRunnerJob();
  const c = await claimOne(second);
  expect(c.id).toBe(waiting);
  await flush();
  const account = (await row(finished)).account_id as number;
  return { tapis, finished, partial, waiting, first, second, account };
}

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const RANGE = () => `from=${day(-1)}&to=${day(1)}`;

// --- (a) The completion stores the mark ------------------------------------------------------------------------

describe("the completion stores whether the usage is partial", () => {
  test("1 for usage the runner marked partial, 0 for usage it did not, NULL until it reports and for a Tapis job (MUTATION: bind 0 instead of the body's usage_partial, or write NULL)", async () => {
    const s = await scenario();
    expect((await row(s.partial)).runner_usage_partial).toBe(1);
    expect((await row(s.finished)).runner_usage_partial).toBe(0);
    expect((await row(s.waiting)).runner_usage_partial).toBeNull();
    expect((await row(s.tapis)).runner_usage_partial).toBeNull();
    // The usage itself is what the runner sent.
    expect(await row(s.partial)).toMatchObject({
      runner_wall_seconds: 300,
      runner_cpu_seconds: 7200,
      runner_max_rss_mb: 4096,
    });
  });

  test("a repeat completion changes neither the figures nor the mark: usage is written once (MUTATION: drop `runner_wall_seconds IS NULL` from RECORD_USAGE_SQL)", async () => {
    const s = await scenario();
    const lease = (await row(s.finished)).lease_id as string;
    const again = await complete(s.first, s.finished, lease, {
      usage: { wall_seconds: 9, cpu_seconds: 9, max_rss_mb: 9 },
      usage_partial: true,
    });
    expect([again.status, again.body.state]).toEqual([200, "finished"]);
    expect(await row(s.finished)).toMatchObject({
      runner_wall_seconds: 120,
      runner_cpu_seconds: 400,
      runner_usage_partial: 0,
    });
  });

  test("the column refuses a mark that is not 0, 1 or NULL (the migration's CHECK)", async () => {
    const s = await scenario();
    let message = "";
    try {
      await sql("UPDATE compute_jobs SET runner_usage_partial = 2 WHERE id = ?1", s.finished);
    } catch (err) {
      message = String(err);
    }
    expect(message).toContain("compute_jobs_runner_usage_partial");
    expect((await row(s.finished)).runner_usage_partial).toBe(0);
  });
});

// --- (b) The account report ----------------------------------------------------------------------------------------

describe("the account report keeps runner usage apart from service units", () => {
  test('SU totals are the Tapis job alone and the runner totals are the three runner jobs alone (MUTATION: drop `r.accounting === "su"` from the SU totals in accountReport)', async () => {
    const s = await scenario();
    const tapisRow = await row(s.tapis);
    expect(tapisRow.charged_milli).toBeGreaterThan(0);

    const res = await admin(`/compute/report?account=${s.account}&${RANGE()}`);
    expect(res.status).toBe(200);
    const report = ComputeAccountReportResponseSchema.parse(res.body);

    // Service units: the Tapis job alone, and nothing a runner used in them.
    expect(report.totals).toEqual({
      jobs: 1,
      charged_milli: tapisRow.charged_milli,
      unsettled: 0,
      open_hold_milli: 0,
    });
    expect(Object.keys(report.by_pool)).toEqual(["cpu"]);
    expect(report.by_pool.cpu).toEqual(report.totals);

    // The runners' own figures, in a total of their own: the three runner jobs, whose usage is the two
    // completions' (400 + 7200 CPU seconds is 2.111 runner-reported core-hours, rounded down).
    expect(report.runner_totals).toEqual({
      jobs: 3,
      wall_seconds: FINISHED_USAGE.wall_seconds + PARTIAL_USAGE.wall_seconds,
      cpu_seconds: FINISHED_USAGE.cpu_seconds + PARTIAL_USAGE.cpu_seconds,
      core_hours: 2.111,
      // Two of the three have reported (the third is claimed and not completed): a sum over fewer jobs than
      // `jobs` is said to be, and both that did report put a mark on it.
      reported_jobs: 2,
      partial_jobs: 1,
      unmarked_jobs: 0,
    });
    expect(report.truncated).toBe(false);
  });

  test("each job row names its executor, accounting, runner and usage, and the partial mark is the runner's", async () => {
    const s = await scenario();
    const res = await admin(`/compute/report?account=${s.account}&${RANGE()}`);
    const jobs = new Map<string, Loose>((res.body.jobs as Loose[]).map((j) => [j.id as string, j]));
    expect(jobs.size).toBe(4);
    expect(jobs.get(s.tapis)).toMatchObject({
      executor: "tapis",
      accounting: "su",
      runner_id: null,
      runner_usage: null,
    });
    expect(jobs.get(s.finished)).toMatchObject({
      executor: "runner",
      accounting: "none",
      runner_id: s.first.id,
      charged_milli: 0,
      runner_usage: { wall_seconds: 120, cpu_seconds: 400, max_rss_mb: 2048, partial: false },
    });
    expect(jobs.get(s.partial)).toMatchObject({
      executor: "runner",
      accounting: "none",
      runner_id: s.first.id,
      runner_usage: { wall_seconds: 300, cpu_seconds: 7200, max_rss_mb: 4096, partial: true },
    });
    // Claimed and never completed: the runner is named and nothing has been reported.
    expect(jobs.get(s.waiting)).toMatchObject({
      executor: "runner",
      runner_id: s.second.id,
      runner_usage: { wall_seconds: null, cpu_seconds: null, max_rss_mb: null, partial: null },
    });
  });

  test("an account with no runner job has zero runner totals, and the SU totals are as they were", async () => {
    await scenario();
    const res = await admin(`/compute/report?account=${ids.owner}&${RANGE()}`);
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({ jobs: 0, charged_milli: 0 });
    expect(res.body.runner_totals).toEqual({
      jobs: 0,
      wall_seconds: 0,
      cpu_seconds: 0,
      core_hours: 0,
      reported_jobs: 0,
      partial_jobs: 0,
      unmarked_jobs: 0,
    });
  });

  test("runner-reported core-hours are CPU seconds over 3600, rounded DOWN to three decimals", () => {
    // A supplement to the route test above, which pins 7600 seconds as 2.111: the boundary cases.
    expect(runnerCoreHours(0)).toBe(0);
    expect(runnerCoreHours(400)).toBe(0.111);
    expect(runnerCoreHours(3599)).toBe(0.999);
    expect(runnerCoreHours(3600)).toBe(1);
    expect(runnerCoreHours(7600)).toBe(2.111);
    expect(runnerCoreHours(36_000_000)).toBe(10_000);
  });
});

// --- (c) The job list --------------------------------------------------------------------------------------------------

describe("the job list filters by executor, accounting and runner", () => {
  const idsOf = (body: Loose) => (body.jobs as Loose[]).map((j) => j.id as string).sort();

  test("executor, accounting and runner are column tests, alone and together (MUTATION: drop the executor, accounting or runner term from listJobRows)", async () => {
    const s = await scenario();
    const runnerJobs = [s.finished, s.partial, s.waiting].sort();

    const byExecutor = await admin("/compute/jobs?executor=runner");
    expect(ComputeJobsListResponseSchema.safeParse(byExecutor.body).success).toBe(true);
    expect(idsOf(byExecutor.body)).toEqual(runnerJobs);
    expect(idsOf((await admin("/compute/jobs?executor=tapis")).body)).toEqual([s.tapis]);

    expect(idsOf((await admin("/compute/jobs?accounting=none")).body)).toEqual(runnerJobs);
    expect(idsOf((await admin("/compute/jobs?accounting=su")).body)).toEqual([s.tapis]);

    expect(idsOf((await admin(`/compute/jobs?runner=${s.first.id}`)).body)).toEqual(
      [s.finished, s.partial].sort(),
    );
    expect(idsOf((await admin(`/compute/jobs?runner=${s.second.id}`)).body)).toEqual([s.waiting]);

    // Together with each other and with the older filters.
    expect(
      idsOf((await admin(`/compute/jobs?executor=runner&runner=${s.first.id}&state=failed`)).body),
    ).toEqual([s.partial]);
    expect(idsOf((await admin(`/compute/jobs?executor=tapis&runner=${s.first.id}`)).body)).toEqual(
      [],
    );
    expect(idsOf((await admin("/compute/jobs?accounting=su&executor=runner")).body)).toEqual([]);
  });

  test("a filtered page keeps its keyset: the filter holds on every page", async () => {
    const s = await scenario();
    const seen: string[] = [];
    let after: number | null = null;
    for (let i = 0; i < 5; i++) {
      const res = await admin(
        `/compute/jobs?executor=runner&limit=1${after === null ? "" : `&after=${after}`}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.jobs).toHaveLength(1);
      seen.push(res.body.jobs[0].id);
      after = res.body.next_after;
      if (after === null) break;
    }
    expect(seen.sort()).toEqual([s.finished, s.partial, s.waiting].sort());
    expect(after).toBeNull();
  });

  test("a value that is not an executor, an accounting class or a runner id is refused, and never echoed", async () => {
    await scenario();
    const bad = [
      "executor=gpu",
      "executor=",
      "accounting=free",
      "accounting=SU",
      "runner=rnr_short",
      `runner=rnr_${"A".repeat(24)}`,
      `runner=rnr_${"0".repeat(24)}x`,
      "runner=%27%20OR%201%3D1",
    ];
    for (const q of bad) {
      const res = await admin(`/compute/jobs?${q}`);
      expect([q, res.status, res.body.code]).toEqual([q, 400, "invalid_query"]);
      const value = q.split("=")[1] ?? "";
      if (value.length > 3) expect(res.text).not.toContain(decodeURIComponent(value));
    }
  });

  test("the list marks partial usage, and says nothing for a job that has not reported (MUTATION: leave runner_usage_partial out of reportedJobView)", async () => {
    const s = await scenario();
    const res = await admin("/compute/jobs?limit=200");
    const byId = new Map<string, Loose>((res.body.jobs as Loose[]).map((j) => [j.id as string, j]));
    expect(byId.get(s.partial)).toMatchObject({
      runner_usage_partial: true,
      runner_wall_seconds: 300,
      runner_cpu_seconds: 7200,
    });
    expect(byId.get(s.finished)).toMatchObject({ runner_usage_partial: false });
    expect(byId.get(s.waiting)).toMatchObject({ runner_usage_partial: null });
    expect(byId.get(s.tapis)).toMatchObject({ runner_usage_partial: null, executor: "tapis" });
  });

  test("the record of one job marks partial usage too (MUTATION: read the mark from the wrong column)", async () => {
    const s = await scenario();
    const partial = await admin(`/compute/records/${s.partial}`);
    expect(partial.status).toBe(200);
    expect(ComputeRecordResponseSchema.parse(partial.body).job).toMatchObject({
      runner_usage_partial: true,
      runner_cpu_seconds: 7200,
    });
    const whole = await admin(`/compute/records/${s.finished}`);
    expect(whole.body.job.runner_usage_partial).toBe(false);
    const tapis = await admin(`/compute/records/${s.tapis}`);
    expect(tapis.body.job.runner_usage_partial).toBeNull();
  });
});

// --- (d) Every runner's usage ------------------------------------------------------------------------------------------

describe("the runners' usage report", () => {
  test("per registration: jobs by state, the sums, the largest memory and the partial count, never service units (MUTATION: count no partial job in runnersUsageReport's SQL)", async () => {
    const s = await scenario();
    const unused = await runner({ site: "lab_b" });
    expect(await revokeRunner(unused.id)).toBe(200);

    const res = await admin(`/compute/reports/runners?${RANGE()}`);
    expect(res.status).toBe(200);
    const report = ComputeRunnersUsageResponseSchema.parse(res.body);
    expect(report).toMatchObject({ from: day(-1), to: day(1) });
    const byId = new Map(report.runners.map((r) => [r.id, r]));
    expect(byId.size).toBe(3);

    expect(byId.get(s.first.id)).toMatchObject({
      site: "lab_a",
      trust: "lab",
      revoked: false,
      jobs: 2,
      by_state: { finished: 1, failed: 1 },
      wall_seconds: 420,
      cpu_seconds: 7600,
      core_hours: 2.111,
      max_rss_mb: 4096,
      reported_jobs: 2,
      partial_jobs: 1,
      unmarked_jobs: 0,
    });
    // Claimed and never completed: counted, with nothing reported.
    expect(byId.get(s.second.id)).toMatchObject({
      revoked: false,
      jobs: 1,
      by_state: { created: 1 },
      wall_seconds: 0,
      cpu_seconds: 0,
      core_hours: 0,
      max_rss_mb: null,
      reported_jobs: 0,
      partial_jobs: 0,
      unmarked_jobs: 0,
    });
    // A revoked registration with no job stays listed, with zeros.
    expect(byId.get(unused.id)).toMatchObject({
      site: "lab_b",
      revoked: true,
      jobs: 0,
      by_state: {},
      wall_seconds: 0,
      max_rss_mb: null,
      reported_jobs: 0,
      partial_jobs: 0,
      unmarked_jobs: 0,
    });
    expect(report.totals).toEqual({
      jobs: 3,
      wall_seconds: 420,
      cpu_seconds: 7600,
      core_hours: 2.111,
      reported_jobs: 2,
      partial_jobs: 1,
      unmarked_jobs: 0,
    });
    // No service unit anywhere in the answer: a runner is never charged.
    expect(res.text).not.toContain("milli");
  });

  test("a revoked registration's jobs are still its own", async () => {
    const s = await scenario();
    expect(await revokeRunner(s.first.id)).toBe(200);
    await flush();
    const res = await admin(`/compute/reports/runners?${RANGE()}`);
    const first = (res.body.runners as Loose[]).find((r) => r.id === s.first.id) as Loose;
    expect(first).toMatchObject({ revoked: true, wall_seconds: 420, cpu_seconds: 7600 });
    expect(first.jobs).toBe(2);
  });

  test("the range is by the job's creation day, both ends whole (MUTATION: `created_at < date(?2, '+1 day')` to `created_at < ?2`, or drop the `created_at >= ?1` term)", async () => {
    const s = await scenario();
    // The finished job was made at the last second of one day, the failed one at the first second of the next.
    await sql(
      "UPDATE compute_jobs SET created_at = '2026-03-10 23:59:59' WHERE id = ?1",
      s.finished,
    );
    await sql(
      "UPDATE compute_jobs SET created_at = '2026-03-11 00:00:00' WHERE id = ?1",
      s.partial,
    );
    const jobsOf = async (from: string, to: string) => {
      const res = await admin(`/compute/reports/runners?from=${from}&to=${to}`);
      expect(res.status).toBe(200);
      return (res.body.runners as Loose[]).find((r) => r.id === s.first.id)?.by_state as Loose;
    };
    expect(await jobsOf("2026-03-10", "2026-03-10")).toEqual({ finished: 1 });
    expect(await jobsOf("2026-03-11", "2026-03-11")).toEqual({ failed: 1 });
    expect(await jobsOf("2026-03-10", "2026-03-11")).toEqual({ finished: 1, failed: 1 });
    expect(await jobsOf("2026-03-09", "2026-03-09")).toEqual({});
    expect(await jobsOf("2026-03-12", "2026-03-12")).toEqual({});
    // The same two ends as the account report reads them.
    const report = await admin(
      `/compute/report?account=${s.account}&from=2026-03-10&to=2026-03-10`,
    );
    expect((report.body.jobs as Loose[]).map((j) => j.id)).toEqual([s.finished]);
  });

  test("a range is at most 366 days, both ends counted, and the two dates are real and in order (MUTATION: `days > COMPUTE_RUNNER_REPORT_DAYS_MAX` to `days > 400` in the route)", async () => {
    await scenario();
    expect(COMPUTE_RUNNER_REPORT_DAYS_MAX).toBe(366);
    const ok = [
      ["2026-01-01", "2027-01-01"], // 366 days
      ["2028-01-01", "2028-12-31"], // a leap year, 366 days
      ["2026-03-10", "2026-03-10"],
    ];
    for (const [from, to] of ok) {
      expect([
        from,
        to,
        (await admin(`/compute/reports/runners?from=${from}&to=${to}`)).status,
      ]).toEqual([from, to, 200]);
    }
    const refused = [
      "from=2026-01-01&to=2027-01-02", // 367 days
      "from=2020-01-01&to=2026-01-01",
      "from=2026-03-11&to=2026-03-10", // from after to
      "from=2026-02-30&to=2026-03-10", // not a day
      "from=2026-03-10&to=2026-13-01",
      "from=2026-03-10",
      "to=2026-03-10",
      "from=yesterday&to=today",
      "from=2026-3-1&to=2026-3-9",
    ];
    for (const q of refused) {
      const res = await admin(`/compute/reports/runners?${q}`);
      expect([q, res.status, res.body.code]).toEqual([q, 400, "invalid_query"]);
    }
  });
});

describe("the service holds its own bound", () => {
  test("a range the route would refuse is refused by the function too (MUTATION: `days > COMPUTE_RUNNER_REPORT_DAYS_MAX` to `days > 400` in runnersUsageReport)", async () => {
    // A supplement to the route test above: the function is exported, so it must not rely on its caller.
    const refused = [
      ["2026-01-01", "2027-01-02"],
      ["2026-03-11", "2026-03-10"],
      ["2026-02-30", "2026-03-10"],
    ] as const;
    for (const [from, to] of refused) {
      await expect(runnersUsageReport(env.DB, { from, to })).rejects.toThrow(RangeError);
    }
    expect(
      (await runnersUsageReport(env.DB, { from: "2026-01-01", to: "2027-01-01" })).runners,
    ).toEqual([]);
  });
});

// --- (f) Review round: the cancel answer, jobs that have not reported, a missing mark, the accounting rule --------------

describe("the cancel answer of a runner job its runner completed after the cancel", () => {
  test("carries the partial mark of the usage the runner reported, in the answer's JSON (MUTATION: build the cancel answer with `jobView(job)` on the bare row)", async () => {
    const r = await runner();
    const cases = [
      { usage: PARTIAL_USAGE, partial: true },
      { usage: FINISHED_USAGE, partial: false },
    ] as const;
    for (const c of cases) {
      const id = await dispatchRunnerJob();
      const entry = await claimOne(r);
      expect(entry.id).toBe(id);
      // The cancel is recorded and the claimed job keeps going until its runner reports.
      const asked = await admin(`/compute/jobs/${id}/cancel`, "admin", "POST");
      expect([asked.status, asked.body.outcome]).toEqual([200, "cancel_requested"]);
      expect(asked.body.job.runner_usage_partial).toBeNull();
      // The runner finishes anyway: the job ends canceled (state `cancelled`), with the usage and mark it reported.
      const done = await complete(r, id, entry.lease_id, {
        usage: c.usage,
        usage_partial: c.partial,
      });
      expect([done.status, done.body.state]).toEqual([200, "cancelled"]);
      // The administrator cancels again: the job is already canceled, and its figures carry their mark.
      const again = await admin(`/compute/jobs/${id}/cancel`, "admin", "POST");
      expect([again.status, again.body.outcome]).toEqual([200, "already_cancelled"]);
      expect(again.body.job).toMatchObject({
        state: "cancelled",
        runner_wall_seconds: c.usage.wall_seconds,
        runner_cpu_seconds: c.usage.cpu_seconds,
        runner_usage_partial: c.partial,
      });
      expect(ComputeJobAdminResponseSchema.safeParse(again.body).success).toBe(true);
    }
  });
});

describe("a sum is never read as whole when it may not be", () => {
  test("usage with no mark (a completion from before the mark was stored) is counted as unmarked, in the account report and the runners report (MUTATION: drop the unmarked count from accountReport, or from the runners report's SQL)", async () => {
    const s = await scenario();
    // The same row as a completion of that time left it: usage written, mark NULL.
    await sql("UPDATE compute_jobs SET runner_usage_partial = NULL WHERE id = ?1", s.finished);

    const account = await admin(`/compute/report?account=${s.account}&${RANGE()}`);
    const rows = new Map<string, Loose>((account.body.jobs as Loose[]).map((j) => [j.id, j]));
    expect(rows.get(s.finished)?.runner_usage).toEqual({
      wall_seconds: 120,
      cpu_seconds: 400,
      max_rss_mb: 2048,
      partial: null,
    });
    expect(account.body.runner_totals).toMatchObject({
      jobs: 3,
      reported_jobs: 2,
      partial_jobs: 1,
      unmarked_jobs: 1,
    });

    const runners = await admin(`/compute/reports/runners?${RANGE()}`);
    const first = (runners.body.runners as Loose[]).find((x) => x.id === s.first.id) as Loose;
    expect(first).toMatchObject({ reported_jobs: 2, partial_jobs: 1, unmarked_jobs: 1 });
    const second = (runners.body.runners as Loose[]).find((x) => x.id === s.second.id) as Loose;
    expect(second).toMatchObject({ jobs: 1, reported_jobs: 0, unmarked_jobs: 0 });
    expect(runners.body.totals).toMatchObject({ reported_jobs: 2, unmarked_jobs: 1 });
  });

  test('a job is counted in service units by its accounting, not its executor (MUTATION: `r.accounting === "su"` to `r.executor === "tapis"` in accountReport)', async () => {
    const s = await scenario();
    const tapisCharged = (await row(s.tapis)).charged_milli as number;
    // A runner job accounted in service units (a later phase's; the table accepts it) has SU, so it is in the
    // SU totals, and it is still a runner job with the runner's figures: the two totals are never added.
    await sql(
      "UPDATE compute_jobs SET accounting = 'su', charged_milli = 2000 WHERE id = ?1",
      s.finished,
    );
    const res = await admin(`/compute/report?account=${s.account}&${RANGE()}`);
    expect(res.body.totals).toMatchObject({ jobs: 2, charged_milli: tapisCharged + 2000 });
    expect(res.body.runner_totals).toMatchObject({ jobs: 3, cpu_seconds: 7600 });
  });
});

// --- (e) Identity and the role gate -----------------------------------------------------------------------------------

describe("who reads it, and what it carries", () => {
  test("an administrator and an owner may; a member and a stranger may not", async () => {
    await scenario();
    const path = `/compute/reports/runners?${RANGE()}`;
    expect((await admin(path, "admin")).status).toBe(200);
    expect((await admin(path, "owner")).status).toBe(200);
    expect((await admin(path, "member")).status).toBe(403);
    expect((await admin(path, null)).status).toBe(401);
  });

  test("no report carries identity: runners are named by registration and jobs by account number", async () => {
    const s = await scenario();
    const reports = [
      await admin(`/compute/reports/runners?${RANGE()}`),
      await admin(`/compute/report?account=${s.account}&${RANGE()}`),
      await admin("/compute/jobs?executor=runner"),
    ];
    for (const r of reports) {
      expect(r.status).toBe(200);
      // The seeded people's addresses and user names, and the owner's account number as a registrar.
      expect(r.text).not.toContain("@");
      expect(r.text).not.toContain("cmp-");
      expect(r.text).not.toContain("registered_by");
    }
  });
});
