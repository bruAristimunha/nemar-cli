/**
 * The local control-plane stack runs a runner job end to end, in process (portable compute, card DM-17; plan
 * D4, D6 and gate G2): `backend/scripts/compute-local-stack.ts` started for real over a temporary state
 * directory, and ONE `nemar-floor` job on its Zarr input driven from its dispatch to a settled `finished` through NEMAR's
 * real routes, before any workstation is involved.
 *
 * NOTHING OF NEMAR IS STOOD IN FOR. The stack carries the real admin, compute and runner routers, a real
 * migrated SQLite file and Miniflare's R2 behind the S3 interface the presigned addresses reach; the Zarr
 * source check's two external services (GitHub, the serving copy's index) are the stack's own `--seed-fixture`
 * stand-in. The job is created by the admin route (`POST /admin/compute/pipeline/run`, as `nemar admin
 * compute pipeline run` calls it), the runner is registered by the stored owner key and exchanges its secret
 * for a token, and every step after that is a request to the stack's loopback port with the `127.0.0.1:<port>`
 * Host its guard requires. The only thing played is what a CONTAINER would write: the launcher's four files,
 * built from the launch specification the Worker answered (decoded strictly, as the launcher does) and never
 * from a number the Worker stored, uploaded through the outputs route and the presigned PUTs under the lease.
 * The stack has no cron, so nothing here advances a job except the runner's own calls.
 *
 * Pinned (the mutation that kills each is named in its test):
 *  (a) the whole run: `finished`, `executor` `runner`, `accounting` `none`, the launch digest equal to the
 *      SHA-256 of the decoded specification text, settled with charge 0 and no ledger row, and the stack's
 *      `outputs` command downloads every declared file with its size;
 *  (b) an operator-style reference `localhost/nemar-python@sha256:<64 hex>` as the stack's `--image` is
 *      accepted end to end (plan, unverified item 15);
 *  (c) the lease: an outputs request with no lease or another's is refused, and one that passed the route's
 *      check and then lost the lease (the sweep released the claim, another runner took it) writes nothing.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { LAUNCHER_FILES } from "../../shared/contract/compute";
import {
  type LaunchSpec,
  LaunchSpecSchema,
  decodeLaunchSpecEnv,
} from "../../shared/contract/compute-launch";
import {
  RUNNER_LEASE_HEADER,
  RUNNER_PROTOCOL,
  RunnerClaimResponseSchema,
  RunnerCompleteResponseSchema,
  RunnerHeartbeatResponseSchema,
  RunnerRegisterResponseSchema,
  RunnerTokenResponseSchema,
} from "../../shared/contract/compute-runner";
import {
  FIXTURE_DATASET_ID,
  type LocalStack,
  startLocalStack,
} from "../scripts/compute-local-stack";
import { sweepRunnerLeases } from "../src/services/compute-runner-queue";
import { sha256Hex } from "./helpers/compute-seed";

const SCRIPT = join(import.meta.dir, "..", "scripts", "compute-local-stack.ts");
const REPO_ROOT = join(import.meta.dir, "..", "..");
const REGISTRY_IMAGE = `ghcr.io/example/nemar-python@sha256:${"a".repeat(64)}`;
const OPERATOR_IMAGE = `localhost/nemar-python@sha256:${"c".repeat(64)}`;
const encoder = new TextEncoder();

// biome-ignore lint/suspicious/noExplicitAny: bodies are read field by field
type Loose = Record<string, any>;

const scratch: string[] = [];
const fresh = (label: string) => {
  const dir = mkdtempSync(join(tmpdir(), `nemar-stack-runner-${label}-`));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/**
 * A stack over its own state directory, ephemeral ports, the fixture dataset, and the given image, for the
 * enclosing `describe`: started before its cases and stopped after them. The stack's process-wide seams (the S3
 * address, the source check's services) belong to ONE running stack, so a stack is never started while another
 * is running: each `describe` that needs one calls this, and they run one after the other.
 */
function useStack(image: string): () => LocalStack {
  let stack: LocalStack | undefined;
  beforeAll(async () => {
    stack = await startLocalStack({
      state: join(fresh("state"), "state"),
      image,
      port: 0,
      s3Port: 0,
      seedFixture: true,
      log: () => {},
    });
  }, 120_000);
  afterAll(async () => {
    // The stack hands the records copy of an ended job to `waitUntil` and nothing awaits it. A stop that comes
    // while that copy is still in flight (a case that failed early, with its job `failed`) never returns:
    // `mf.dispose` blocks the process. So the copy is waited for (at most 10 s) before the stop, and the stop
    // itself is raced against a timeout, so a regression fails its case instead of hanging the run.
    const open = () =>
      (
        stack?.db
          .query(
            "SELECT COUNT(*) AS n FROM compute_jobs WHERE ended_at IS NOT NULL AND result_records_at IS NULL",
          )
          .get() as { n: number } | undefined
      )?.n ?? 0;
    for (let waited = 0; open() > 0 && waited < 10_000; waited += 100) await Bun.sleep(100);
    const stopped = await Promise.race([
      stack?.stop().then(() => "stopped"),
      new Promise<string>((resolve) => setTimeout(() => resolve("stack_stop_timeout"), 10_000)),
    ]);
    if (stopped === "stack_stop_timeout") console.error("stack_stop_timeout");
  }, 30_000);
  return () => stack as LocalStack;
}

// --- The client: real requests to the stack's loopback address -------------------------------------------

interface Reply {
  status: number;
  body: Loose;
}

async function call(
  stack: LocalStack,
  method: "GET" | "POST",
  path: string,
  bearer: string,
  body?: unknown,
): Promise<Reply> {
  // The dialed address is the stack's own, so the Host header is the `127.0.0.1:<port>` its guard accepts.
  const res = await fetch(`${stack.url}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
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

const REGISTRATION = {
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
};

interface Runner {
  id: string;
  token: string;
}

/** The owner registers a runner (the stored owner key), and the runner exchanges its secret: as `nemar-runner` does. */
async function registerRunner(stack: LocalStack, name: string): Promise<Runner> {
  const registered = await call(stack, "POST", "/admin/compute/runners", stack.keys.owner, {
    ...REGISTRATION,
    name,
  });
  expect(registered.status).toBe(201);
  const { runner_id, secret } = RunnerRegisterResponseSchema.parse(registered.body);
  const exchanged = await call(stack, "POST", "/compute/runners/token", secret, {
    protocol: RUNNER_PROTOCOL,
    runner_version: "0.1.0",
  });
  expect(exchanged.status).toBe(200);
  return { id: runner_id, token: RunnerTokenResponseSchema.parse(exchanged.body).access_token };
}

/** `nemar admin compute pipeline run nemar-floor --dataset <fixture> --executor runner`, as an administrator. */
async function dispatch(stack: LocalStack): Promise<string> {
  const res = await call(stack, "POST", "/admin/compute/pipeline/run", stack.keys.admin, {
    recipe: "nemar-floor",
    dataset: FIXTURE_DATASET_ID,
    executor: "runner",
  });
  expect(res.status).toBeLessThan(300);
  expect(res.body).toMatchObject({ ok: true, dispatched: 1, executor: "runner" });
  const result = (res.body.results as Array<Loose>)[0] as Loose;
  expect(result).toMatchObject({ ok: true, dataset_id: FIXTURE_DATASET_ID, records_written: true });
  const jobId = result.job_id;
  if (typeof jobId !== "string") throw new Error("the run named no job");
  return jobId;
}

interface Claimed {
  id: string;
  lease_id: string;
  launch_spec_env: string;
}

async function claimOne(stack: LocalStack, runner: Runner): Promise<Claimed> {
  const res = await call(stack, "POST", "/compute/runners/claim", runner.token, {
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

const heartbeat = (stack: LocalStack, r: Runner, entry: Claimed, phase: "started" | "uploading") =>
  call(stack, "POST", "/compute/runners/heartbeat", r.token, {
    job_id: entry.id,
    lease_id: entry.lease_id,
    phase,
  });

const finish = (stack: LocalStack, r: Runner, entry: Claimed) =>
  call(stack, "POST", "/compute/runners/complete", r.token, {
    job_id: entry.id,
    lease_id: entry.lease_id,
    exit_number: 0,
    launcher_failure_code: null,
    launcher_detail: null,
    usage: { wall_seconds: 120, cpu_seconds: 400, max_rss_mb: 2048 },
    usage_partial: false,
    scratch_discarded: true,
  });

/** What the recipe's container writes (the demo's QC tables): the outputs a job declares. */
const OUTPUT_FILES = [
  { path: "qc/channels.tsv", content: "name\ttype\nCz\tEEG\nPz\tEEG\n" },
  { path: "qc/summary.json", content: '{"n_channels":2,"profile":"serving"}\n' },
  { path: "report.txt", content: "the QC report\n" },
];

/** The launch specification the Worker answered, decoded as the launcher decodes it. */
function decodeSpec(entry: Claimed): { spec: LaunchSpec; text: string } {
  const decoded = decodeLaunchSpecEnv(entry.launch_spec_env);
  if (!decoded.ok)
    throw new Error(`the launcher would refuse the specification: ${decoded.reason}`);
  return { spec: LaunchSpecSchema.parse(JSON.parse(decoded.text)), text: decoded.text };
}

const sha = (text: string) => sha256Hex(encoder.encode(text));

interface Upload {
  /** The outputs route's status, the status of each presigned PUT, and the outputs-complete status. */
  outputs: number;
  puts: number[];
  complete: number;
}

/**
 * The container's side: declare the outputs and the launcher's four files (outputs route), PUT every byte to
 * the presigned address, mark the upload complete. `lease` is the `X-Compute-Lease` value sent (null: none).
 * The launcher's provenance carries the digest of the decoded text and the image digest of the specification.
 * Never asserts: a refusal is a status the case reads.
 */
async function uploadAs(
  entry: Claimed,
  o: { lease?: string | null; files?: typeof OUTPUT_FILES; skipComplete?: boolean } = {},
): Promise<Upload> {
  const { spec, text } = decodeSpec(entry);
  const files = o.files ?? OUTPUT_FILES;
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
      launch_spec_digest: await sha(text),
      bundle_digest: null,
      image: { uri: spec.image.uri, digest: spec.image.digest },
      runtime_version: "stack-runner-test 1.0",
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
          size: encoder.encode(f.content).length,
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
          size: encoder.encode(f.content).length,
          sha256: await sha(f.content),
        })),
      ),
      launcher: Object.values(LAUNCHER_FILES).map((name) => ({
        name,
        size: encoder.encode(launcherText[name] as string).length,
      })),
    }),
  });
  const result: Upload = { outputs: outputsRes.status, puts: [], complete: 0 };
  if (outputsRes.status === 200) {
    const { uploads } = (await outputsRes.json()) as {
      uploads: Array<{ path: string; url: string }>;
    };
    for (const u of uploads) {
      const content = u.path.startsWith("outputs/")
        ? (files.find((f) => `outputs/${f.path}` === u.path)?.content as string)
        : (launcherText[u.path.replace("launcher/", "")] as string);
      const put = await fetch(u.url, { method: "PUT", body: encoder.encode(content) });
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

const dbRow = (stack: LocalStack, id: string) =>
  stack.db.query("SELECT * FROM compute_jobs WHERE id = ?").get(id) as Loose;
const ledgerRows = (stack: LocalStack, id: string) =>
  (
    stack.db.query("SELECT COUNT(*) AS n FROM compute_ledger WHERE job_id = ?").get(id) as {
      n: number;
    }
  ).n;

/** The stack's `outputs` command, run as the operator runs it: names and sizes on stdout. */
async function runOutputsCommand(stack: LocalStack, jobId: string, to: string) {
  const ran = spawn({
    cmd: [
      "bun",
      SCRIPT,
      "outputs",
      "--state",
      stack.state,
      "--job",
      jobId,
      "--to",
      to,
      "--port",
      String(stack.port),
      "--s3-port",
      String(stack.s3Port),
    ],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(ran.stdout).text();
  const err = await new Response(ran.stderr).text();
  return { code: await ran.exited, out, err };
}

/** Every file below `dir`, as `relative path -> bytes`. */
function treeOf(dir: string, at = ""): Record<string, string> {
  const found: Record<string, string> = {};
  for (const entry of readdirSync(join(dir, at), { withFileTypes: true })) {
    const rel = at === "" ? entry.name : `${at}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(found, treeOf(dir, rel));
    else if (statSync(join(dir, rel)).isFile()) found[rel] = readFileSync(join(dir, rel), "utf-8");
  }
  return found;
}

/**
 * One whole run: dispatch, claim, started, the container's outputs under the lease, uploading, complete.
 * Asserts the run's own route answers; the callers assert the record.
 */
async function runWholeJob(stack: LocalStack) {
  const runner = await registerRunner(stack, "lab_a_cpu");
  const jobId = await dispatch(stack);
  const waiting = dbRow(stack, jobId);
  expect(waiting).toMatchObject({
    state: "created",
    executor: "runner",
    accounting: "none",
    runner_claimed_at: null,
  });

  const entry = await claimOne(stack, runner);
  expect(entry.id).toBe(jobId);
  const started = await heartbeat(stack, runner, entry, "started");
  expect(started.status).toBe(200);
  expect(RunnerHeartbeatResponseSchema.parse(started.body).cancel).toBe(false);
  expect(dbRow(stack, jobId).state).toBe("running");

  const up = await uploadAs(entry);
  expect(up.outputs).toBe(200);
  expect(up.puts).toEqual(Array(OUTPUT_FILES.length + 4).fill(200));
  expect(up.complete).toBe(200);

  expect((await heartbeat(stack, runner, entry, "uploading")).status).toBe(200);
  expect(dbRow(stack, jobId).state).toBe("archiving");

  const done = await finish(stack, runner, entry);
  expect(done.status).toBe(200);
  expect(RunnerCompleteResponseSchema.parse(done.body).state).toBe("finished");
  return { runner, jobId, entry };
}

// --- (a) and (b): the whole run ----------------------------------------------------------------------------

describe.each([
  ["a registry image", REGISTRY_IMAGE],
  ["an operator-style image reference", OPERATOR_IMAGE],
])(
  "one runner job, dispatch to settled finished, with %s as the stack's image",
  (_label, image) => {
    const running = useStack(image);
    // The first case's job, for the outputs case below (so a name filter cannot break the second).
    let finishedJob: string | null = null;

    test("finished, runner, accounting none, digest of the decoded text, settled with charge 0 and no ledger row (MUTATION: drop settled_final_at from NONE_SETTLED_STAMP_SQL, or write another launch digest)", async () => {
      const stack = running();
      const { jobId, entry } = await runWholeJob(stack);
      finishedJob = jobId;

      // The GET routes: the administrator's record summary of the job.
      const record = await call(stack, "GET", `/admin/compute/records/${jobId}`, stack.keys.admin);
      expect(record.status).toBe(200);
      expect(record.body.job).toMatchObject({
        id: jobId,
        state: "finished",
        failure_code: null,
        executor: "runner",
        accounting: "none",
        runner_backend: "local",
        settled: true,
        charged_milli: 0,
        held_milli: 0,
        outputs_completed: true,
        results_verified: true,
        runner_wall_seconds: 120,
        runner_cpu_seconds: 400,
        runner_max_rss_mb: 2048,
      });
      expect(record.body.ledger).toEqual([]);

      // The decoded text's SHA-256, computed here from what the stack answered, equals the stored digest.
      const { spec, text } = decodeSpec(entry);
      expect(record.body.identifiers.launch_spec_digest).toBe(await sha(text));
      expect(record.body.identifiers.image_digest).toBe(spec.image.digest);
      expect(spec.image.uri).toBe(image);
      // A Zarr runner job stages no bundle, so the launcher has none to ask the bundle route for.
      expect(spec.bundle).toBeUndefined();
      expect(spec.image.digest).toBe(image.slice(image.indexOf("@") + 1));

      // The job record: settled final, charge 0, nothing in the ledger.
      const job = dbRow(stack, jobId);
      expect(job).toMatchObject({
        state: "finished",
        executor: "runner",
        accounting: "none",
        charged_milli: 0,
        held_milli: 0,
        lease_id: entry.lease_id,
      });
      expect(job.settled_provisional_at).not.toBeNull();
      expect(job.settled_final_at).not.toBeNull();
      expect(job.ended_at).not.toBeNull();
      expect(ledgerRows(stack, jobId)).toBe(0);

      // The jobs list shows it too.
      const listed = await call(
        stack,
        "GET",
        "/admin/compute/jobs?state=finished",
        stack.keys.admin,
      );
      expect(listed.status).toBe(200);
      expect(listed.body.jobs.map((j: Loose) => j.id)).toContain(jobId);
    }, 60_000);

    test("the stack's outputs command downloads every declared file with its size (MUTATION: list no file, or write no file, in downloadOutputs)", async () => {
      const stack = running();
      const jobId = finishedJob;
      if (jobId === null) throw new Error("the whole-run case did not leave a finished job");
      const to = fresh("outputs");
      const ran = await runOutputsCommand(stack, jobId, to);
      expect(ran.err).toBe("");
      expect(ran.code).toBe(0);
      const expected = [...OUTPUT_FILES]
        .sort((a, b) => (a.path < b.path ? -1 : 1))
        .map((f) => `${f.path}\t${encoder.encode(f.content).length}\n`)
        .join("");
      expect(ran.out).toBe(expected);
      expect(ran.out).not.toContain("http");
      expect(treeOf(to)).toEqual(Object.fromEntries(OUTPUT_FILES.map((f) => [f.path, f.content])));
    }, 60_000);
  },
);

// --- (c) the lease -----------------------------------------------------------------------------------------

describe("the lease of a runner job's outputs", () => {
  const running = useStack(REGISTRY_IMAGE);

  test("no lease, another job's lease and a malformed one are refused, the right one is accepted (MUTATION: drop the lease compare of the callbacks' authorize)", async () => {
    const stack = running();
    const runner = await registerRunner(stack, "lab_a_cpu");
    const jobId = await dispatch(stack);
    const entry = await claimOne(stack, runner);
    expect(entry.id).toBe(jobId);
    expect((await heartbeat(stack, runner, entry, "started")).status).toBe(200);

    const otherLease = `${entry.lease_id.slice(0, -1)}${entry.lease_id.endsWith("0") ? "1" : "0"}`;
    for (const lease of [null, otherLease, "not-a-lease"]) {
      const refused = await uploadAs(entry, { lease, skipComplete: true });
      expect(refused.outputs).toBe(404);
      expect(refused.puts).toEqual([]);
    }
    expect(dbRow(stack, jobId)).toMatchObject({ results_bytes: null, failure_detail: null });

    const accepted = await uploadAs(entry);
    expect([accepted.outputs, accepted.complete]).toEqual([200, 200]);
    expect(dbRow(stack, jobId).outputs_completed_at).not.toBeNull();
  }, 60_000);
});

describe("a request that lost the lease after the route's check", () => {
  const running = useStack(REGISTRY_IMAGE);

  test("a request that passed the route's check and then lost the lease writes nothing, and the new holder's own outputs are accepted (MUTATION: drop the lease term of CLAIM_RESULTS_BYTES_SQL, or make leaseBinds [0, null])", async () => {
    const own = running();
    const a = await registerRunner(own, "lab_a_cpu");
    const b = await registerRunner(own, "lab_b_cpu");
    const jobId = await dispatch(own);
    const entryA = await claimOne(own, a);
    expect(entryA.id).toBe(jobId);

    // The hand-written lease expiry and the direct `sweepRunnerLeases` call are the only non-route steps in this
    // file: expiry is clock-driven, and the sweep is the cron step the stack lacks.
    // The other request, made exact: between the route's lease check and the declared-bytes claim, the
    // lease expires, the sweep (the cron's step, which the stack lacks) releases the claim, and runner B
    // claims the job under a new lease through the real claim route.
    const realDb = own.env.DB;
    let stolen: Claimed | null = null;
    own.env.DB = hookD1(realDb, "UPDATE compute_jobs SET results_bytes = ?2", async () => {
      own.env.DB = realDb;
      own.db.run(
        "UPDATE compute_jobs SET lease_expires_at = datetime('now', '-1 minute') WHERE id = ?",
        [jobId],
      );
      await sweepRunnerLeases({ ...own.env, DB: realDb });
      stolen = await claimOne(own, b);
    });
    let stale: Upload;
    try {
      stale = await uploadAs(entryA, { skipComplete: true });
    } finally {
      own.env.DB = realDb;
    }
    const entryB = stolen as Claimed | null;
    if (entryB === null) throw new Error("the interleaving did not happen");
    expect(entryB.id).toBe(jobId);
    expect(entryB.lease_id).not.toBe(entryA.lease_id);

    // The stale request is refused (a conflict) and presigned nothing; it declared and recorded nothing.
    expect(stale.outputs).toBe(409);
    expect(stale.puts).toEqual([]);
    expect(dbRow(own, jobId)).toMatchObject({
      results_bytes: null,
      failure_detail: null,
      outputs_completed_at: null,
      runner_id: b.id,
      lease_id: entryB.lease_id,
    });

    // The new holder's own request works, under its own lease.
    expect((await heartbeat(own, b, entryB, "started")).status).toBe(200);
    const fresh2 = await uploadAs(entryB);
    expect([fresh2.outputs, fresh2.complete]).toEqual([200, 200]);
    expect(dbRow(own, jobId).outputs_completed_at).not.toBeNull();
  }, 120_000);
});

// --- A database that lets one other writer in ------------------------------------------------------------------

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
