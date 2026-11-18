/**
 * Runner jobs: creation, accounting class, Tapis selections, the recipe entry, dispatch and the view
 * (portable compute card DM-06; ADR 0121 decisions 1 and 6; plan D1, D2, D6 and section 2.7).
 *
 * A runner job is a job with NO HOLD and NO LEDGER ENTRY (`executor = 'runner'`, `accounting = 'none'`) that
 * a registered runner pulls. What is pinned, each group with a one-line mutation named in its tests:
 *
 *  (a) the registry: `nemar-floor` reads BIDS on Tapis and the Zarr serving copy on a runner (one entry,
 *      two inputs, one table of which input runs where), is sized with `shared` as a label inside its
 *      ceilings and the queue's memory; `nemar-ica` is BIDS on Tapis only; the Zarr argument vector is exact
 *      and a commit is 40 lowercase hex digits or an error;
 *  (b) the policy: `runners.maxLiveJobs` defaults to 64 and 8 when the key is absent and is validated
 *      strictly when stored;
 *  (c) what did NOT change: the text of `JOB_INSERT_SQL`, `GATEWAY_USER_INSERT_SQL` and the hold statement,
 *      and every Tapis dispatch (a hold, a ledger entry, `su`, a submit);
 *  (d) the whole path through the REAL admin route over a real migrated database and Miniflare's R2: a
 *      runner job is `created`, its records are written, `executor` is `runner`, `accounting` is `none`, the
 *      partition is the label `shared`, no ledger row or pool is touched, and its recorded specification
 *      stages no dataset and carries the exact argument vector;
 *  (e) the runners' live cap, on BOTH engines (bun:sqlite and Miniflare's D1): a refusal is
 *      `over_concurrency` and writes nothing, two requests racing for the last slot make one job, a pool's
 *      cap does not count another pool's jobs or ended jobs, and twenty live runner jobs leave the tenant
 *      room, the pipelines' live room and the daily room exactly as they were;
 *  (f) the refusals: an input the executor does not run, a runner run over the queue, the switch off
 *      (nothing written), a dataset with no serving copy, and a non-pipeline runner job, which is an
 *      argument error;
 *  (g) NO TAPIS PATH TOUCHES A RUNNER ROW: the 30-minute tick, the cancel sweep, the admin advance, the
 *      webhook-hint advance, the submit and its atomic claim, the tenant sweep's follow list, the uncopied
 *      and abandoned-copy statements and the observer's settlement list select `tapis` or `su` rows, and the
 *      Tapis stand-in sees no request;
 *  (h) the view: `jobView` shows the executor fields of a runner job and `tapis` and `su` for a Tapis job.
 *
 * Mutations (each proved by hand against the line it guards; the list is in the pull request).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  COMPUTE_RECIPES,
  RECIPE_INPUTS,
  RECIPE_ZARR_BASE,
  findRecipe,
  recipeArguments,
  recipeZarrArguments,
} from "../../shared/compute-recipes";
import { COMPUTE_EXECUTORS } from "../../shared/compute-state";
import {
  ComputePolicySchema,
  DEFAULT_COMPUTE_POLICY,
  JobSpecSchema,
  PARTITIONS,
  RUNNERS_POLICY_DEFAULT,
  TENANT_POLICY_DEFAULT,
  runnersPolicyOf,
} from "../../shared/contract/compute";
import { ComputePipelineRunResponseSchema } from "../../shared/contract/compute-admin";
import { launchSpecFits } from "../../shared/contract/compute-launch";
import { ACCESS_REPORT_PENDING_SQL } from "../src/services/access-attributes";
import {
  ADVANCE_ROWS_PER_TICK,
  CANCEL_ROWS_SQL,
  CREATED_ROWS_SQL,
  runComputeAdvanceCron,
  sweepComputeCancellations,
} from "../src/services/compute-advance";
import {
  type ComputeJobRow,
  GATEWAY_USER_INSERT_SQL,
  JOB_INSERT_SQL,
  PIPELINE_LIVE_JOBS_GUARD_SQL,
  PIPELINE_LIVE_JOBS_SQL,
  RUNNER_JOB_INSERT_SQL,
  RUNNER_LIVE_JOBS_GUARD_SQL,
  RUNNER_LIVE_JOBS_SQL,
  createJob,
  getJob,
} from "../src/services/compute-jobs";
import { HOLD_INSERT_SQL, holdStatements } from "../src/services/compute-ledger";
import {
  CANCEL_PENDING_FAILED_SQL,
  CLAIM_SUBMIT_SQL,
  COPY_ABANDONED_COUNT_SQL,
  COPY_ABANDONED_RECENT_SQL,
  MARK_COPY_ABANDONED_SQL,
  UNCOPIED_TERMINAL_SQL,
  advanceComputeJob,
  countCancelPendingFailed,
  jobView,
  submitComputeJob,
} from "../src/services/compute-lifecycle";
import { CANDIDATE_ROWS_SQL, MATCH_ROWS_SQL } from "../src/services/compute-observer";
import {
  PIPELINE_JOBS_TODAY_SQL,
  dispatchPipelineJob,
  pipelineJobsToday,
  pipelineRoom,
  recipeJobSpec,
  runnerRoom,
} from "../src/services/compute-pipeline";
import { getPolicy } from "../src/services/compute-policy";
import { QUEUE_MAX_MEMORY_MB } from "../src/services/compute-queues";
import { recordKey, sha256Hex } from "../src/services/compute-records";
import {
  COMPUTE_RELEASE_CANCEL_SQL,
  computeReleaseStatements,
} from "../src/services/compute-release";
import { accessReport } from "../src/services/compute-reporting";
import { readRuntimeImage } from "../src/services/compute-runtime-image";
import {
  TENANT_COUNTS_SQL,
  tenantFacts,
  tenantGuard,
  tenantRoom,
} from "../src/services/compute-tenant";
import { FOLLOW_ROWS_SQL } from "../src/services/compute-tenant-sweep";
import type { Bindings } from "../src/types/bindings";
import {
  COMPUTE_KEYS,
  type ComputeWho,
  makeComputeApp,
  seedComputeUsers,
} from "./helpers/compute-app";
import { endedJob } from "./helpers/compute-ended";
import {
  type LifecycleFixture,
  RUNTIME_IMAGE_DIGEST,
  makeJob,
  reread,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import {
  fundPipelines,
  seedEegDataset,
  seedPipelinesAccount,
} from "./helpers/compute-pipeline-fixture";
import { fundPlatform, roundTripD1, seedUser, setPolicy } from "./helpers/compute-seed";
import {
  type GithubCompareStandin,
  startGithubCompareStandin,
} from "./helpers/github-compare-standin";

// --- The fixture and the two engines ---------------------------------------------------------------

let fx: LifecycleFixture;
const handle = makeComputeApp();

/**
 * The two external services the Zarr source check reads (GitHub, and the serving copy's index), as one real
 * loopback server; `zarrDataset` makes the happy world (the tag and the index name the same commit), and
 * `zarr-source-check.test.ts` owns the cases about the verdict itself.
 */
let github: GithubCompareStandin;
const seams = globalThis as { NEMAR_GITHUB_API_URL?: string; NEMAR_ZARR_INDEX_BASE?: string };
const previousSeams = { github: seams.NEMAR_GITHUB_API_URL, index: seams.NEMAR_ZARR_INDEX_BASE };

beforeAll(async () => {
  fx = await startLifecycleFixture({ withD1: true });
  github = startGithubCompareStandin();
  seams.NEMAR_GITHUB_API_URL = github.url;
  seams.NEMAR_ZARR_INDEX_BASE = github.indexBase;
}, 120_000);

beforeEach(async () => {
  github?.reset();
  await fx.reset();
  await seedComputeUsers(fx.harness.db);
  // Miniflare's D1 is never reset; this file empties the jobs table so every case reads absolute numbers.
  await (fx.harness.d1 as D1Database).prepare("DELETE FROM compute_jobs").run();
});

afterAll(async () => {
  github?.stop();
  seams.NEMAR_GITHUB_API_URL = previousSeams.github;
  seams.NEMAR_ZARR_INDEX_BASE = previousSeams.index;
  await fx?.dispose();
}, 30_000);

/** A Worker environment with the runners switch on (production-shaped, compute on). */
const runnerEnv = (over: Partial<Bindings> = {}): Bindings =>
  fx.env({ COMPUTE_RUNNERS_ENABLED: "1", ...over });

interface World {
  name: string;
  d1: D1Database;
  env(over?: Partial<Bindings>): Bindings;
}
const worlds = (): World[] => [
  {
    name: "bun:sqlite",
    d1: fx.env().DB,
    env: (over) => runnerEnv(over),
  },
  {
    name: "Miniflare D1",
    d1: fx.harness.d1 as D1Database,
    env: (over) => runnerEnv({ DB: fx.harness.d1, ...over }),
  },
];

function onBoth(name: string, body: (w: World) => Promise<void>) {
  for (const which of [0, 1]) {
    test(`${name} [${which === 0 ? "bun:sqlite" : "Miniflare D1"}]`, async () => {
      await body(worlds()[which] as World);
    });
  }
}

/** Requests that overlap: bun:sqlite answers at once, so each statement takes a round trip, as D1's does. */
const racing = (w: World): Bindings =>
  w.name === "bun:sqlite" ? w.env({ DB: roundTripD1(w.d1) }) : w.env();

// --- Seeds and calls -----------------------------------------------------------------------------------

/** A commit of the dataset repository: the tag's, and the one the serving index was built from. */
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** The attestation of the happy world: the tag and the index name the same commit. */
const EXACT = {
  sourceCommit: COMMIT,
  tagCommit: COMMIT,
  equivalence: "exact",
  deltaPaths: [],
} as const;

async function zarrDataset(
  env: Bindings,
  id: string,
  commit: string | null = COMMIT,
  copy: { status?: string | null; stores?: number | null } = {},
  versions?: Parameters<typeof seedEegDataset>[2],
) {
  await seedEegDataset(env, id, versions);
  // The happy world of the source check: every version's tag and the copy's own index name COMMIT.
  for (const [version] of versions?.versions ?? [["1.0.0"]]) {
    github.tag(id, `v${version}`, COMMIT);
  }
  github.index(id, { source_commit: COMMIT, store_count: 3 });
  await env.DB.prepare(
    "UPDATE datasets SET zarr_source_commit = ?1, zarr_status = ?2, zarr_store_count = ?3 WHERE dataset_id = ?4",
  )
    .bind(
      commit,
      copy.status === undefined ? "ready" : copy.status,
      copy.stores === undefined ? 3 : copy.stores,
      id,
    )
    .run();
}

interface Reply {
  status: number;
  body: Record<string, any>;
}

async function call(
  method: "GET" | "POST",
  path: string,
  who: ComputeWho,
  body?: unknown,
  env: Bindings = runnerEnv(),
): Promise<Reply> {
  const headers: Record<string, string> = { Authorization: `Bearer ${COMPUTE_KEYS[who]}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await handle(
    new Request(`http://api.test/admin${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
  const text = await res.text();
  let parsed: Record<string, any> = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: parsed };
}

/**
 * A Zarr dispatch runs in `development`: compute runs only there and in production, and the source check
 * honors its index seam and reads GitHub without the App only outside production
 * (`zarr-source-check.test.ts` runs the production cases).
 */
const zarrEnv = (env: Bindings = runnerEnv()): Bindings => ({ ...env, ENVIRONMENT: "development" });

const runRunner = (id: string, env?: Bindings, extra: Record<string, unknown> = {}) =>
  call(
    "POST",
    "/compute/pipeline/run",
    "admin",
    { recipe: "nemar-floor", dataset: id, executor: "runner", ...extra },
    zarrEnv(env),
  );

const n = async (env: Bindings, table: string, where = "1 = 1") =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>())
    ?.n ?? 0;

const row = async (env: Bindings, id: string) =>
  (await env.DB.prepare("SELECT * FROM compute_jobs WHERE id = ?1")
    .bind(id)
    .first<Record<string, unknown>>()) as Record<string, unknown>;

/** The specification of a runner job, the way a recipe builds it, for a direct `createJob`. */
function zarrSpec(env: Bindings, datasetId = "nm000104") {
  const image = readRuntimeImage(env);
  if (image.state !== "ok") throw new Error("no runtime image");
  const recipe = findRecipe("nemar-floor");
  if (recipe === null) throw new Error("no nemar-floor");
  return recipeJobSpec(recipe, {
    datasetId,
    tag: "v1.0.0",
    input: "zarr",
    image: { ref: image.ref, digest: image.digest },
    zarrSource: EXACT,
    env,
  });
}

/** A runner job made directly (a pipeline job, no account, no hold). */
const runnerJob = (env: Bindings) =>
  createJob(env, {
    source: "pipeline",
    accountId: null,
    appId: "nemar-launch",
    appVersion: "1.0.0",
    spec: zarrSpec(env),
    executor: "runner",
  });

/** A runner job row written by SQL the table accepts, in any pool and state, for the cases about counting. */
let seeded = 0;
async function seedRunnerRow(
  d1: D1Database,
  over: { pool?: "cpu" | "gpu"; state?: string; executor?: string; accounting?: string } = {},
): Promise<string> {
  const id = `job_${(++seeded).toString(16).padStart(24, "0")}`;
  const pool = over.pool ?? "cpu";
  const state = over.state ?? "created";
  await d1
    .prepare(
      `INSERT INTO compute_jobs
         (id, source, kind, state, app_id, app_version, spec_digest, partition, pool, nodes,
          cores_per_node, gpus, minutes, executor, accounting, ended_at)
       VALUES (?1, 'pipeline', 'batch', ?2, 'nemar-launch', '1.0.0', ?3, ?4, ?5, 1, 4, ?6, 60, ?7, ?8,
               CASE WHEN ?2 IN ('finished', 'cancelled') THEN datetime('now') END)`,
    )
    .bind(
      id,
      state,
      "a".repeat(64),
      pool === "cpu" ? "shared" : "gpu-shared",
      pool,
      pool === "cpu" ? 0 : 1,
      over.executor ?? "runner",
      over.accounting ?? "none",
    )
    .run();
  return id;
}

async function ownerPolicy(d1: D1Database, over: Record<string, unknown>) {
  const owner = await seedUser(d1, { role: "owner" });
  await setPolicy(d1, owner, over);
}

const capOf = (cpu: number, gpu = 8) => ({ runners: { maxLiveJobs: { cpu, gpu } } });

// --- (a) The registry -----------------------------------------------------------------------------------

describe("the recipe registry", () => {
  test("nemar-floor reads BIDS and Zarr, runs on Tapis and on a runner, and is the shared label sized inside its ceilings (MUTATION: executors [tapis])", () => {
    const r = findRecipe("nemar-floor");
    expect(r).toMatchObject({
      name: "nemar-floor",
      version: "1.0.0",
      engine: "eegprep@0.5.0",
      partition: "shared",
      nodes: 1,
      cores: 4,
      memoryMb: 16384,
      gpus: 0,
      minutes: 360,
      autoDispatch: true,
      eligibility: "eeg",
    });
    expect([...(r?.inputs ?? [])]).toEqual(["bids", "zarr"]);
    expect([...(r?.executors ?? [])]).toEqual(["tapis", "runner"]);
    expect(Object.isFrozen(r?.executors)).toBe(true);
    expect(Object.isFrozen(r?.inputs)).toBe(true);
    // The transition name is gone: one recipe, two inputs.
    expect(findRecipe("nemar-floor-zarr")).toBeNull();
    expect(PARTITIONS.shared.pool).toBe("cpu");
    const ceiling = PARTITIONS.shared.ceiling;
    expect(ceiling).toMatchObject({ maxCoresPerNode: 64, maxMinutes: 2880 });
    expect(r?.cores).toBeLessThanOrEqual(ceiling?.maxCoresPerNode as number);
    expect(r?.minutes).toBeLessThanOrEqual(ceiling?.maxMinutes as number);
    expect(r?.memoryMb).toBeLessThanOrEqual(QUEUE_MAX_MEMORY_MB.shared);
  });

  test("nemar-ica reads BIDS and lists Tapis only (MUTATION: nemar-ica lists runner)", () => {
    const r = findRecipe("nemar-ica");
    expect([...(r?.inputs ?? [])]).toEqual(["bids"]);
    expect([...(r?.executors ?? [])]).toEqual(["tapis"]);
  });

  test("every executor a recipe lists is a word of the contract, and every recipe lists one", () => {
    for (const r of COMPUTE_RECIPES) {
      expect(r.executors.length).toBeGreaterThan(0);
      for (const e of r.executors) expect(COMPUTE_EXECUTORS as readonly string[]).toContain(e);
      expect(r.inputs.length).toBeGreaterThan(0);
      for (const i of r.inputs) expect(RECIPE_INPUTS as readonly string[]).toContain(i);
    }
  });

  test("the Zarr argument vector is exact, ordered, and stages no dataset (MUTATION: swap two flags)", () => {
    const digest = `sha256:${"b".repeat(64)}`;
    expect(
      recipeZarrArguments({
        datasetId: "nm000104",
        tag: "v1.0.0",
        attestation: EXACT,
        imageDigest: digest,
        zarrBase: RECIPE_ZARR_BASE,
      }),
    ).toEqual([
      "--out",
      "/work/outputs/product",
      "--dataset-id",
      "nm000104",
      "--dataset-version",
      "v1.0.0",
      "--source-commit",
      COMMIT,
      "--tag-commit",
      COMMIT,
      "--commit-equivalence",
      "exact",
      "--image-digest",
      digest,
      "--zarr-base",
      "https://zarr.nemar.org",
    ]);
    expect(RECIPE_ZARR_BASE).toBe("https://zarr.nemar.org");
  });

  test("a commit that is not 40 lowercase hex digits is an error, never an argument (MUTATION: drop the check)", () => {
    const base = {
      datasetId: "nm000104",
      tag: "v1.0.0",
      imageDigest: `sha256:${"b".repeat(64)}`,
      zarrBase: RECIPE_ZARR_BASE,
    };
    for (const bad of [
      "",
      "abc",
      COMMIT.slice(1),
      `${COMMIT}0`,
      COMMIT.toUpperCase(),
      `${COMMIT.slice(1)}g`,
    ]) {
      expect(() =>
        recipeZarrArguments({ ...base, attestation: { ...EXACT, sourceCommit: bad } }),
      ).toThrow(RangeError);
      expect(() =>
        recipeZarrArguments({ ...base, attestation: { ...EXACT, tagCommit: bad } }),
      ).toThrow(RangeError);
    }
  });

  test("a Zarr input's job has no dataset and the vector; a BIDS input's job is what it was (MUTATION: stage the dataset anyway)", () => {
    const image = {
      ref: `ghcr.io/example/nemar-python@sha256:${"b".repeat(64)}`,
      digest: `sha256:${"b".repeat(64)}`,
    };
    const production = { ENVIRONMENT: "production" as const };
    const zarr = recipeJobSpec(findRecipe("nemar-floor") as never, {
      datasetId: "nm000104",
      tag: "v1.0.0",
      input: "zarr",
      image,
      zarrSource: EXACT,
      env: production,
    });
    expect(zarr.datasets).toEqual([]);
    expect(zarr.args).toEqual(
      recipeZarrArguments({
        datasetId: "nm000104",
        tag: "v1.0.0",
        attestation: EXACT,
        imageDigest: image.digest,
        zarrBase: RECIPE_ZARR_BASE,
      }),
    );
    expect(zarr.command).toEqual(["nemar-recipe", "run", "nemar-floor", "--input", "zarr"]);
    expect(launchSpecFits(zarr)).toBe(true);
    // A Zarr input with no verified attestation is a programming error.
    expect(() =>
      recipeJobSpec(findRecipe("nemar-floor") as never, {
        datasetId: "nm000104",
        tag: "v1.0.0",
        input: "zarr",
        image,
        env: production,
      }),
    ).toThrow();
    // So is an input the recipe does not list.
    expect(() =>
      recipeJobSpec(findRecipe("nemar-ica") as never, {
        datasetId: "nm000104",
        tag: "v1.0.0",
        input: "zarr",
        image,
        zarrSource: EXACT,
        env: production,
      }),
    ).toThrow(RangeError);
    const bids = recipeJobSpec(findRecipe("nemar-floor") as never, {
      datasetId: "nm000104",
      tag: "v1.0.0",
      input: "bids",
      image,
      // Never read for a BIDS input.
      zarrSource: EXACT,
      env: production,
    });
    expect(bids.datasets).toEqual([{ id: "nm000104", version: "v1.0.0" }]);
    expect(bids.args).toEqual(
      recipeArguments({ datasetId: "nm000104", tag: "v1.0.0", imageDigest: image.digest }),
    );
    expect(bids.args).not.toContain("--source-commit");
    // The BIDS input is the recipe's default: its command is what it was before a recipe had two inputs.
    expect(bids.command).toEqual(["nemar-recipe", "run", "nemar-floor"]);
  });
});

// --- (b) The policy ------------------------------------------------------------------------------------------

describe("the runners policy", () => {
  test("an absent key reads 64 for cpu and 8 for gpu, never unlimited (MUTATION: default 0)", () => {
    expect(RUNNERS_POLICY_DEFAULT).toEqual({ maxLiveJobs: { cpu: 64, gpu: 8 } });
    expect(Object.isFrozen(RUNNERS_POLICY_DEFAULT)).toBe(true);
    expect(DEFAULT_COMPUTE_POLICY.runners).toBeUndefined();
    expect(runnersPolicyOf(DEFAULT_COMPUTE_POLICY)).toBe(RUNNERS_POLICY_DEFAULT);
    expect(runnersPolicyOf({ ...DEFAULT_COMPUTE_POLICY, ...capOf(3, 1) }).maxLiveJobs).toEqual({
      cpu: 3,
      gpu: 1,
    });
  });

  test("the stored key is strict: unknown keys, negative, fractional and over-large caps are refused (MUTATION: drop .strict())", () => {
    const parse = (runners: unknown) =>
      ComputePolicySchema.safeParse({ ...DEFAULT_COMPUTE_POLICY, runners }).success;
    expect(parse({ maxLiveJobs: { cpu: 1, gpu: 0 } })).toBe(true);
    expect(parse({ maxLiveJobs: { cpu: 1 } })).toBe(false);
    expect(parse({ maxLiveJobs: { cpu: 1, gpu: 0, tpu: 1 } })).toBe(false);
    expect(parse({ maxLiveJobs: { cpu: -1, gpu: 0 } })).toBe(false);
    expect(parse({ maxLiveJobs: { cpu: 1.5, gpu: 0 } })).toBe(false);
    expect(parse({ maxLiveJobs: { cpu: 1001, gpu: 0 } })).toBe(false);
    expect(parse({ maxLiveJobs: { cpu: 1, gpu: 0 }, extra: 1 })).toBe(false);
  });

  test("a stored policy with the key is read back through getPolicy, and one without still parses", async () => {
    const env = fx.env();
    await ownerPolicy(env.DB, capOf(5, 2));
    expect(runnersPolicyOf((await getPolicy(env.DB)).policy).maxLiveJobs).toEqual({
      cpu: 5,
      gpu: 2,
    });
    await ownerPolicy(env.DB, { runners: undefined });
    expect(runnersPolicyOf((await getPolicy(env.DB)).policy)).toBe(RUNNERS_POLICY_DEFAULT);
  });
});

// --- (c) What did not change ---------------------------------------------------------------------------------

const sha = async (text: string) => sha256Hex(new TextEncoder().encode(text));

describe("what did not change", () => {
  test("JOB_INSERT_SQL, GATEWAY_USER_INSERT_SQL and the hold statement are byte for byte what they were", async () => {
    expect(await sha(JOB_INSERT_SQL)).toBe(
      "60ae2c9f394758de682d4e76c7a4bff67bbe19400af452487637fbc11cbddcf5",
    );
    expect(await sha(GATEWAY_USER_INSERT_SQL)).toBe(
      "61ce8d69135699c950e2addea40409ff61ac1f3b2202153c1a12e5550f2b8d73",
    );
    expect(await sha(HOLD_INSERT_SQL)).toBe(
      "2fe525855e0ecdd1e734eebf1b277185b0ed46c026664e0ad0368a0bdffd6fa4",
    );
  });

  /** The one predicate each Tapis statement gained, removed: what is left is what the statement was. */
  const stripped = (sql: string) =>
    sql
      .replace(/\n {4}AND executor = 'tapis'(?=\n)/g, "")
      .replace(/ AND executor = 'tapis'/g, "")
      .replace(/ accounting = 'su' AND/g, "")
      .replace(/ AND j\.accounting = 'su'/g, "")
      .replace(/ AND accounting = 'su'/g, "");

  test("each Tapis statement the change touched is its old text plus the one predicate (hashes of the base text, MUTATION: edit any other word of one)", async () => {
    // The hashes are of the text at the epic base before this card (bc0ba1cf), taken by importing it.
    const base: Array<[string, string, string]> = [
      [
        "PIPELINE_LIVE_JOBS_SQL",
        PIPELINE_LIVE_JOBS_SQL,
        "4ca7e3639dfb87a216eca2bedaa47f250e9cdf44e887fae0b177d95a345ba283",
      ],
      [
        "PIPELINE_LIVE_JOBS_GUARD_SQL",
        PIPELINE_LIVE_JOBS_GUARD_SQL,
        "e0f4acd29c1fca146660396525309e076120bc781af820d0a8c938300078cfc5",
      ],
      [
        "PIPELINE_JOBS_TODAY_SQL",
        PIPELINE_JOBS_TODAY_SQL,
        "a93a257a82c6e1335eff365f13427e69bd6b48a09b8fcf84fb341c86f8c78afa",
      ],
      [
        "TENANT_COUNTS_SQL",
        TENANT_COUNTS_SQL,
        "8a4e709814ea642a8f39ab0d6a53c8d5590256e8021d4232596c92554d2b0d4e",
      ],
      [
        "CANDIDATE_ROWS_SQL",
        CANDIDATE_ROWS_SQL,
        "d58a2e31a5d3b33c1715763da1709b8504562c80a110e33e97eeea89dda1db25",
      ],
      [
        "CREATED_ROWS_SQL",
        CREATED_ROWS_SQL,
        "6e23001935fab6191005933005f3a6f089184b39787fa3037804f6911f07f807",
      ],
      [
        "CANCEL_ROWS_SQL",
        CANCEL_ROWS_SQL,
        "82282a66449c8d262096c75b08584c90e8b97bb2195208368138ed00ea8b0743",
      ],
      [
        "CLAIM_SUBMIT_SQL",
        CLAIM_SUBMIT_SQL,
        "a6536ca5fd33152882ded6ed04a04a1fcf7263ef9f00765883a098aaee5765be",
      ],
      [
        "UNCOPIED_TERMINAL_SQL",
        UNCOPIED_TERMINAL_SQL,
        "0e11f44a84e811e25bd6e1840490b1b40e988ef1c49e846d152f4104f1f4a38e",
      ],
      [
        "CANCEL_PENDING_FAILED_SQL",
        CANCEL_PENDING_FAILED_SQL,
        "f61155a920c3d64c99df5454c5232485d921509a4ff5710f66eb1060ecf7fac3",
      ],
      [
        "MARK_COPY_ABANDONED_SQL",
        MARK_COPY_ABANDONED_SQL,
        "e8b4a4e172cb9373f0517e929706309c8c4ca49ba43f4e258935112abf6ba67e",
      ],
      [
        "COPY_ABANDONED_RECENT_SQL",
        COPY_ABANDONED_RECENT_SQL,
        "ca864c424b3a8e141d7c586a154e580824f91544a905959e326230cb2b42258d",
      ],
      [
        "COPY_ABANDONED_COUNT_SQL",
        COPY_ABANDONED_COUNT_SQL,
        "9158784e42fe0695794161072109d7cda58327e5584b26a582dd006a970acb2b",
      ],
      [
        "FOLLOW_ROWS_SQL",
        FOLLOW_ROWS_SQL,
        "9ede95c5a7a42040aaa6984af26e3ba64b8a7c3fcf322640980cdd090a7abbff",
      ],
      [
        "ACCESS_REPORT_PENDING_SQL",
        ACCESS_REPORT_PENDING_SQL,
        "8aafb3a4626fff59e237eb209ed77b3fa1f30752d4414b019be1968eb13b1a7d",
      ],
      [
        "COMPUTE_RELEASE_CANCEL_SQL",
        COMPUTE_RELEASE_CANCEL_SQL,
        "0abd0e125ccb90b5564cae38a4e8c5420b00aa9c53b86b27d68fb92aeac1e87f",
      ],
    ];
    for (const [name, sql, hash] of base) {
      expect([name, await sha(stripped(sql))]).toEqual([name, hash]);
      // And the predicate is really there: the statement is not its base text.
      expect([name, stripped(sql) === sql]).toEqual([name, false]);
    }
  });

  test("the composed pipeline hold (the hold, the pipelines' live cap, the tenant guard) is its base text plus the two predicates (MUTATION: touch the hold)", async () => {
    const seen: string[] = [];
    const real = fx.env().DB;
    const spy = {
      prepare: (sql: string) => {
        seen.push(sql);
        return real.prepare(sql);
      },
    } as unknown as D1Database;
    holdStatements(spy, {
      poolId: 1,
      budgetPoolId: null,
      amountMilli: 1000,
      jobId: `job_${"0".repeat(24)}`,
      extraGuards: [
        { sql: PIPELINE_LIVE_JOBS_GUARD_SQL, binds: ["cpu", 8] },
        tenantGuard("pipelines", TENANT_POLICY_DEFAULT),
      ],
    });
    expect(seen).toHaveLength(1);
    const composed = seen[0] as string;
    expect(composed).toContain("accounting = 'su'");
    expect(await sha(stripped(composed))).toBe(
      "b6e4ad4156a0088d512f9ed086038328ed84839b13ad691e6181e1455d4bd514",
    );
  });

  test("the runner statement is its own: literals for the class, a guard of its own, no hold", () => {
    expect(RUNNER_JOB_INSERT_SQL).toContain("'runner', 'none'");
    expect(RUNNER_JOB_INSERT_SQL).toContain(RUNNER_LIVE_JOBS_GUARD_SQL);
    expect(RUNNER_JOB_INSERT_SQL).not.toContain("compute_ledger");
    expect(RUNNER_JOB_INSERT_SQL).not.toContain("hold_ledger_id");
    for (const sql of [RUNNER_LIVE_JOBS_SQL, RUNNER_LIVE_JOBS_GUARD_SQL]) {
      expect(sql).toContain("executor = 'runner' AND accounting = 'none'");
    }
  });

  test("money and tenancy select accounting = 'su', written literally", () => {
    for (const [name, sql] of [
      ["PIPELINE_LIVE_JOBS_SQL", PIPELINE_LIVE_JOBS_SQL],
      ["PIPELINE_JOBS_TODAY_SQL", PIPELINE_JOBS_TODAY_SQL],
      ["TENANT_COUNTS_SQL", TENANT_COUNTS_SQL],
      ["CANDIDATE_ROWS_SQL", CANDIDATE_ROWS_SQL],
      ["ACCESS_REPORT_PENDING_SQL", ACCESS_REPORT_PENDING_SQL],
    ] as const) {
      expect([name, /accounting = 'su'/.test(sql)]).toEqual([name, true]);
    }
  });

  test("mechanics select executor = 'tapis', written literally", () => {
    for (const [name, sql] of [
      ["CREATED_ROWS_SQL", CREATED_ROWS_SQL],
      ["CANCEL_ROWS_SQL", CANCEL_ROWS_SQL],
      ["CLAIM_SUBMIT_SQL", CLAIM_SUBMIT_SQL],
      ["UNCOPIED_TERMINAL_SQL", UNCOPIED_TERMINAL_SQL],
      ["CANCEL_PENDING_FAILED_SQL", CANCEL_PENDING_FAILED_SQL],
      ["MARK_COPY_ABANDONED_SQL", MARK_COPY_ABANDONED_SQL],
      ["COPY_ABANDONED_RECENT_SQL", COPY_ABANDONED_RECENT_SQL],
      ["COPY_ABANDONED_COUNT_SQL", COPY_ABANDONED_COUNT_SQL],
      ["FOLLOW_ROWS_SQL", FOLLOW_ROWS_SQL],
      ["COMPUTE_RELEASE_CANCEL_SQL", COMPUTE_RELEASE_CANCEL_SQL],
    ] as const) {
      expect([name, /executor = 'tapis'/.test(sql)]).toEqual([name, true]);
    }
  });

  test("a Tapis pipeline job is as it was: a hold, a ledger entry, su, tapis, submitted (MUTATION: write none for every job)", async () => {
    const env = runnerEnv();
    await seedPipelinesAccount(env);
    await fundPipelines(env);
    await seedEegDataset(env, "nm000104");
    const before = await n(env, "compute_ledger");
    const r = await call("POST", "/compute/pipeline/run", "admin", {
      recipe: "nemar-floor",
      dataset: "nm000104",
    });
    expect(r.status).toBe(201);
    expect(r.body.executor).toBe("tapis");
    expect(r.body.results[0].submit).toBe("submitted");
    const job = await reread(env, r.body.results[0].job_id);
    expect(job).toMatchObject({
      executor: "tapis",
      accounting: "su",
      runner_id: null,
      state: "submitted",
    });
    expect(job.hold_ledger_id).not.toBeNull();
    expect(job.held_milli).toBeGreaterThan(0);
    expect(await n(env, "compute_ledger")).toBe(before + 1);
    expect(await n(env, "compute_ledger", "kind = 'hold'")).toBe(1);
  });
});

// --- (d) The whole path through the real route --------------------------------------------------------------------

describe("a runner job through the admin route", () => {
  test("is created with its records, accounting none, no ledger entry, no pool and no hold (MUTATION: take the hold; write su)", async () => {
    const env = runnerEnv();
    await seedPipelinesAccount(env);
    // No pipelines pool is granted: a hold would need one, a runner job takes none.
    await zarrDataset(env, "nm000104");
    const ledger = await n(env, "compute_ledger");
    const pools = await n(env, "compute_pools");
    const r = await runRunner("nm000104", env);
    expect(r.status).toBe(201);
    expect(ComputePipelineRunResponseSchema.safeParse(r.body).success).toBe(true);
    expect(r.body).toMatchObject({
      ok: true,
      dry_run: false,
      recipe: "nemar-floor",
      executor: "runner",
      input: "zarr",
      dispatched: 1,
    });
    const result = r.body.results[0];
    expect(result).toMatchObject({
      dataset_id: "nm000104",
      ok: true,
      version: "v1.0.0",
      attempt: 1,
      submit: "waiting_for_runner",
    });

    const job = await reread(env, result.job_id);
    expect(job).toMatchObject({
      state: "created",
      source: "pipeline",
      executor: "runner",
      accounting: "none",
      partition: "shared",
      pool: "cpu",
      nodes: 1,
      cores_per_node: 4,
      memory_mb: 16384,
      gpus: 0,
      minutes: 360,
      hold_ledger_id: null,
      held_milli: 0,
      charged_milli: 0,
      settled_provisional_at: null,
      runner_id: null,
      runner_claimed_at: null,
      lease_id: null,
      claim_attempts: 0,
      tapis_uuid: null,
      submitted_at: null,
      image_digest: RUNTIME_IMAGE_DIGEST,
    });
    expect(job.records_written_at).not.toBeNull();
    expect(job.webhook_nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(await n(env, "compute_ledger")).toBe(ledger);
    expect(await n(env, "compute_pools")).toBe(pools);
    // The stamp is linked to the job, and the Tapis stand-in has seen nothing.
    const stamp = await env.DB.prepare(
      "SELECT state, job_id, recipe, engine, input FROM compute_pipeline_stamps",
    ).first<Record<string, string>>();
    expect(stamp).toEqual({
      state: "dispatched",
      job_id: job.id,
      recipe: "nemar-floor",
      engine: "eegprep@0.5.0",
      input: "zarr",
    });
    expect(fx.tapis.log).toEqual([]);
  });

  test("needs no Tapis: with no Tapis credential the run is 201 waiting_for_runner, with a runner job row and no ledger row (S3c: the Tapis check is the Tapis executor's only)", async () => {
    const env = runnerEnv({
      TAPIS_USERNAME: undefined,
      TAPIS_PASSWORD: undefined,
      TAPIS_SERVICE_TOKEN: undefined,
    });
    await seedPipelinesAccount(env);
    await zarrDataset(env, "nm000201");
    const ledger = await n(env, "compute_ledger");
    const r = await runRunner("nm000201", env);
    expect(r.status).toBe(201);
    expect(r.body.results[0]).toMatchObject({
      dataset_id: "nm000201",
      ok: true,
      submit: "waiting_for_runner",
    });
    expect(await n(env, "compute_jobs", "executor = 'runner' AND state = 'created'")).toBe(1);
    expect(await n(env, "compute_ledger")).toBe(ledger);
    expect(fx.tapis.log).toEqual([]);
  });

  test("records the specification: no dataset staged, the exact argument vector, the digest the row holds (MUTATION: stage the dataset)", async () => {
    const env = runnerEnv();
    await seedPipelinesAccount(env);
    await zarrDataset(env, "nm000104");
    const r = await runRunner("nm000104", env);
    const job = await reread(env, r.body.results[0].job_id);
    const stored = await fx.harness.records.get(recordKey(job.id, "spec.json"));
    const text = await (stored as R2ObjectBody).text();
    expect(await sha(text)).toBe(job.spec_digest);
    const spec = JobSpecSchema.parse(JSON.parse(text));
    expect(spec.datasets).toEqual([]);
    expect(spec.runtime).toBe("image");
    expect(spec.command).toEqual(["nemar-recipe", "run", "nemar-floor", "--input", "zarr"]);
    expect(spec.args).toEqual([
      "--out",
      "/work/outputs/product",
      "--dataset-id",
      "nm000104",
      "--dataset-version",
      "v1.0.0",
      "--source-commit",
      COMMIT,
      "--tag-commit",
      COMMIT,
      "--commit-equivalence",
      "exact",
      "--image-digest",
      RUNTIME_IMAGE_DIGEST,
      "--zarr-base",
      "https://zarr.nemar.org",
    ]);
    expect(launchSpecFits(spec)).toBe(true);
    expect(spec.partition).toBe("shared");
    // The request never supplied identity: the commits came from the serving index and the tag.
    expect(text).toContain(COMMIT);
  });

  test("the commits are the index's and the tag's, whatever the request says (a key the Worker supplies is refused)", async () => {
    const env = runnerEnv();
    await seedPipelinesAccount(env);
    await zarrDataset(env, "nm000104");
    const sneaky = await runRunner("nm000104", env, { source_commit: "f".repeat(40) });
    expect(sneaky.status).toBe(400);
    expect(sneaky.body.code).toBe("invalid_body");
    expect(await n(env, "compute_jobs")).toBe(0);
  });

  test("a retry of the same dataset version is refused as live, not made twice (the stamp's claim)", async () => {
    const env = runnerEnv();
    await seedPipelinesAccount(env);
    await zarrDataset(env, "nm000104");
    expect((await runRunner("nm000104", env)).status).toBe(201);
    const again = await runRunner("nm000104", env);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("live_attempt_exists");
    expect(await n(env, "compute_jobs")).toBe(1);
  });

  test("the view shows the executor fields: runner, none, no runner yet, no usage (MUTATION: drop a field from jobView)", async () => {
    const env = runnerEnv();
    await seedPipelinesAccount(env);
    await zarrDataset(env, "nm000104");
    const made = await runRunner("nm000104", env);
    const id = made.body.results[0].job_id as string;
    const list = await call("GET", "/compute/jobs", "admin", undefined, env);
    expect(list.status).toBe(200);
    const view = list.body.jobs.find((j: { id: string }) => j.id === id);
    expect(view).toMatchObject({
      id,
      source: "pipeline",
      state: "created",
      executor: "runner",
      accounting: "none",
      runner_backend: null,
      runner_id: null,
      runner_claimed_at: null,
      runner_wall_seconds: null,
      runner_cpu_seconds: null,
      runner_max_rss_mb: null,
      held_milli: 0,
      charged_milli: 0,
    });
    // After a claim and a run the same view carries what the runner recorded (written here as the claim
    // and the completion will write it; the statements are the runner protocol's).
    await env.DB.prepare(
      `UPDATE compute_jobs SET runner_backend = 'local', runner_id = ?2, runner_claimed_at = datetime('now'),
         runner_wall_seconds = 61, runner_cpu_seconds = 240, runner_max_rss_mb = 4096 WHERE id = ?1`,
    )
      .bind(id, `rnr_${"c".repeat(24)}`)
      .run();
    const shown = jobView((await getJob(env.DB, id)) as ComputeJobRow);
    expect(shown).toMatchObject({
      executor: "runner",
      accounting: "none",
      runner_backend: "local",
      runner_id: `rnr_${"c".repeat(24)}`,
      runner_wall_seconds: 61,
      runner_cpu_seconds: 240,
      runner_max_rss_mb: 4096,
    });
    expect(typeof shown.runner_claimed_at).toBe("string");
  });

  test("a Tapis job's view says tapis and su with no runner fields set", async () => {
    const { job } = await makeJob(fx);
    const view = jobView(await reread(fx.env(), job.id));
    expect(view).toMatchObject({
      executor: "tapis",
      accounting: "su",
      runner_backend: null,
      runner_id: null,
      runner_claimed_at: null,
      runner_wall_seconds: null,
      runner_cpu_seconds: null,
      runner_max_rss_mb: null,
    });
  });

  test("the dry run reports the executor, no estimate and the runner room, and writes nothing (MUTATION: price the job)", async () => {
    const env = runnerEnv();
    await seedPipelinesAccount(env);
    await zarrDataset(env, "nm000104");
    await ownerPolicy(env.DB, capOf(3));
    await seedRunnerRow(env.DB);
    const before = {
      jobs: await n(env, "compute_jobs"),
      stamps: await n(env, "compute_pipeline_stamps"),
      ledger: await n(env, "compute_ledger"),
    };
    const r = await runRunner("nm000104", env, { dry_run: true });
    expect(r.status).toBe(200);
    expect(ComputePipelineRunResponseSchema.safeParse(r.body).success).toBe(true);
    expect(r.body).toMatchObject({
      ok: true,
      dry_run: true,
      executor: "runner",
      estimate_milli_per_job: 0,
      estimate_milli_total: 0,
      runner_room: { live_left: 2, live_cap: 3 },
      would_dispatch: [{ dataset_id: "nm000104", version: "v1.0.0" }],
    });
    expect(r.body.room).toBeUndefined();
    expect(r.body.config).toMatchObject({ compute_enabled: true, runners_enabled: true });
    expect({
      jobs: await n(env, "compute_jobs"),
      stamps: await n(env, "compute_pipeline_stamps"),
      ledger: await n(env, "compute_ledger"),
    }).toEqual(before);
  });

  test("a dry run says a full runners pool blocks, and a switch that is off is reported, not refused", async () => {
    const env = runnerEnv();
    await seedPipelinesAccount(env);
    await zarrDataset(env, "nm000104");
    await ownerPolicy(env.DB, capOf(1));
    await seedRunnerRow(env.DB);
    const full = await runRunner("nm000104", env, { dry_run: true });
    expect(full.body.blocked).toMatchObject({ code: "over_concurrency", version: "v1.0.0" });
    expect(full.body.would_dispatch).toEqual([]);
    expect(full.body.runner_room).toMatchObject({ live_left: 0, live_cap: 1 });

    const off = await runRunner("nm000104", fx.env(), { dry_run: true });
    expect(off.status).toBe(200);
    expect(off.body.config).toMatchObject({ runners_enabled: false });
  });

  test("a Tapis dry run answers as before: the SU estimate, the daily and tenant room, no runner room (MUTATION: report a runner room for every run)", async () => {
    const env = runnerEnv();
    await seedPipelinesAccount(env);
    await seedEegDataset(env, "nm000104");
    const r = await call("POST", "/compute/pipeline/run", "admin", {
      recipe: "nemar-floor",
      dataset: "nm000104",
      dry_run: true,
    });
    expect(r.body.executor).toBe("tapis");
    expect(r.body.estimate_milli_per_job).toBeGreaterThan(0);
    expect(r.body.runner_room).toBeUndefined();
    expect(r.body.room).toMatchObject({
      daily_left: expect.any(Number),
      live_left: expect.any(Number),
      tenant_left: expect.any(Number),
    });
    // S3c: the one key a Tapis dry run gained, and a runner's dry run has none of it.
    expect(Object.keys(r.body.config).sort()).toEqual([
      "compute_enabled",
      "pipelines_account",
      "runtime_image",
      "tapis_configured",
    ]);
  });
});

// --- (e) The runners' live cap ---------------------------------------------------------------------------------

describe("the runners' live cap", () => {
  onBoth(
    "the first job is made and the second is over_concurrency, writing nothing (MUTATION: `<` becomes `<=`)",
    async (w) => {
      await ownerPolicy(w.d1, capOf(1));
      const env = w.env();
      const first = await runnerJob(env);
      expect(first.ok).toBe(true);
      const ledger = await n(env, "compute_ledger");
      const jobs = await n(env, "compute_jobs");
      const second = await runnerJob(env);
      expect(second).toEqual({ ok: false, code: "over_concurrency" });
      expect(await n(env, "compute_jobs")).toBe(jobs);
      expect(await n(env, "compute_ledger")).toBe(ledger);
      // A cap of 0 admits nothing.
      await ownerPolicy(w.d1, capOf(0));
      expect(await runnerJob(env)).toEqual({ ok: false, code: "over_concurrency" });
    },
  );

  onBoth(
    "two requests racing for the last slot make one job; six for two make two (MUTATION: count outside the INSERT)",
    async (w) => {
      await ownerPolicy(w.d1, capOf(1));
      const two = await Promise.all([runnerJob(racing(w)), runnerJob(racing(w))]);
      expect(two.filter((r) => r.ok)).toHaveLength(1);
      expect(two.filter((r) => !r.ok)).toEqual([{ ok: false, code: "over_concurrency" }]);
      expect(await n(w.env(), "compute_jobs", "executor = 'runner'")).toBe(1);

      await w.d1.prepare("DELETE FROM compute_jobs").run();
      await ownerPolicy(w.d1, capOf(2));
      const six = await Promise.all(Array.from({ length: 6 }, () => runnerJob(racing(w))));
      expect(six.filter((r) => r.ok)).toHaveLength(2);
      expect(await n(w.env(), "compute_jobs", "executor = 'runner'")).toBe(2);
    },
  );

  onBoth(
    "the cap is of the pool and of live runner jobs: another pool's, an ended job's and a Tapis job's do not count (MUTATION: drop the pool; drop the state; drop the class)",
    async (w) => {
      await ownerPolicy(w.d1, capOf(1, 3));
      const env = w.env();
      // Three live gpu runner jobs, an ended cpu runner job, and a live Tapis job in the same pool.
      for (let i = 0; i < 3; i++) await seedRunnerRow(w.d1, { pool: "gpu" });
      await seedRunnerRow(w.d1, { pool: "cpu", state: "finished" });
      await seedRunnerRow(w.d1, { pool: "cpu", executor: "tapis", accounting: "su" });
      expect(await runnerJob(env)).toMatchObject({ ok: true });
      // Now the cpu pool holds its one live runner job.
      expect(await runnerJob(env)).toEqual({ ok: false, code: "over_concurrency" });
      // The room that is shown is the room that is enforced.
      const policy = (await getPolicy(w.d1)).policy;
      expect(await runnerRoom(w.d1, policy, "cpu")).toEqual({ live_left: 0, live_cap: 1 });
      expect(await runnerRoom(w.d1, policy, "gpu")).toEqual({ live_left: 0, live_cap: 3 });
    },
  );

  onBoth(
    "twenty live runner jobs leave the tenant room, the pipelines' live room and the daily room as they were (MUTATION: drop accounting from a count)",
    async (w) => {
      await ownerPolicy(w.d1, capOf(64));
      const env = w.env();
      const policy = (await getPolicy(w.d1)).policy;
      const before = {
        tenant: await tenantFacts(w.d1, policy),
        room: await pipelineRoom(w.d1, policy, "cpu"),
        today: await pipelineJobsToday(w.d1),
      };
      for (let i = 0; i < 20; i++) expect(await runnerJob(env)).toMatchObject({ ok: true });
      expect(await n(env, "compute_jobs", "executor = 'runner' AND state = 'created'")).toBe(20);
      const after = {
        tenant: await tenantFacts(w.d1, policy),
        room: await pipelineRoom(w.d1, policy, "cpu"),
        today: await pipelineJobsToday(w.d1),
      };
      expect(after).toEqual(before);
      expect(tenantRoom(after.tenant, "pipelines")).toBe(tenantRoom(before.tenant, "pipelines"));
      expect(after.tenant.occupied).toBe(0);
      // A Tapis job is still admitted into a ceiling the runner jobs would have filled (20 is the default ceiling).
      await fundPlatform(w.d1, "pipelines", 1_000_000_000, "cpu");
      const tapis = await createJob(env, {
        source: "pipeline",
        accountId: null,
        appId: "nemar-launch",
        appVersion: "1.0.0",
        spec: JobSpecSchema.parse({
          name: "a tapis job",
          runtime: "image",
          image: `ghcr.io/example/nemar-python@${RUNTIME_IMAGE_DIGEST}`,
          recipe: "nemar-floor",
          command: ["nemar-recipe", "run", "nemar-floor"],
          partition: "shared",
          cores: 4,
          minutes: 60,
        }),
      });
      expect(tapis).toMatchObject({ ok: true });
    },
  );

  onBoth(
    "two requests with one key racing make one job and both answer it, whether the cap is full or not (MUTATION: word the lost race as the cap)",
    async (w) => {
      const account = await seedPipelinesAccount(w.env());
      for (const cap of [1, 5]) {
        await w.d1.prepare("DELETE FROM compute_jobs").run();
        await ownerPolicy(w.d1, capOf(cap));
        const make = () =>
          createJob(racing(w), {
            source: "pipeline",
            accountId: account,
            idempotencyKey: `pl:${"ab".repeat(20)}`,
            appId: "nemar-launch",
            appVersion: "1.0.0",
            spec: zarrSpec(w.env()),
            executor: "runner",
          });
        const both = await Promise.all([make(), make()]);
        expect([cap, both.map((r) => r.ok)]).toEqual([cap, [true, true]]);
        const ids = both.map((r) => (r as { job: ComputeJobRow }).job.id);
        expect(ids[0]).toBe(ids[1] as string);
        expect(await n(w.env(), "compute_jobs", "executor = 'runner'")).toBe(1);
      }
    },
  );

  test("a runner job that is not a pipeline job is an argument error, and a cost is never estimated for it (MUTATION: allow any source)", async () => {
    const env = runnerEnv();
    for (const source of ["cli", "web"] as const) {
      await expect(
        createJob(env, {
          source,
          accountId: 1,
          appId: "nemar-launch",
          appVersion: "1.0.0",
          spec: zarrSpec(env),
          executor: "runner",
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
    }
    await expect(
      createJob(env, {
        source: "pipeline",
        accountId: null,
        appId: "nemar-launch",
        appVersion: "1.0.0",
        spec: zarrSpec(env),
        executor: "gpu" as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect(await n(env, "compute_jobs")).toBe(0);
  });

  test("the fixed ceiling of the label applies: over 64 cores or 48 hours is over_job_limit, and nothing is written (MUTATION: skip the ceiling)", async () => {
    const env = runnerEnv();
    const base = zarrSpec(env);
    for (const over of [{ cores: 65 }, { minutes: 2881 }, { nodes: 2 }]) {
      const r = await createJob(env, {
        source: "pipeline",
        accountId: null,
        appId: "nemar-launch",
        appVersion: "1.0.0",
        spec: { ...base, ...over },
        executor: "runner",
      });
      expect([over, r]).toEqual([over, { ok: false, code: "over_job_limit" }]);
    }
    expect(await n(env, "compute_jobs")).toBe(0);
  });

  test("a retry with the same key finds its job, and a different request under the key is a conflict (idempotency kept)", async () => {
    const env = runnerEnv();
    const account = await seedPipelinesAccount(env);
    const make = (spec = zarrSpec(env)) =>
      createJob(env, {
        source: "pipeline",
        accountId: account,
        idempotencyKey: "pl:0123456789abcdef0123456789abcdef01234567",
        appId: "nemar-launch",
        appVersion: "1.0.0",
        spec,
        executor: "runner",
      });
    const first = await make();
    const again = await make();
    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect((again as { job: ComputeJobRow }).job.id).toBe((first as { job: ComputeJobRow }).job.id);
    expect(await n(env, "compute_jobs")).toBe(1);
    await expect(make(zarrSpec(env, "nm000105"))).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    // A replay is answered before the cap is read, however full the cap has become.
    await ownerPolicy(env.DB, capOf(1));
    expect(await make()).toMatchObject({ ok: true, replayed: true });
  });
});

// --- (f) The refusals --------------------------------------------------------------------------------------------

describe("refusals through the route", () => {
  test("the Zarr input on tapis is invalid_spec naming input, and nothing is written (MUTATION: skip the input and executor pair check)", async () => {
    const env = runnerEnv();
    await seedPipelinesAccount(env);
    await fundPipelines(env);
    await zarrDataset(env, "nm000104");
    // Funding the pool wrote its grant entries; what must not change is the count from here.
    const ledger = await n(env, "compute_ledger");
    for (const body of [
      { recipe: "nemar-floor", dataset: "nm000104", executor: "tapis", input: "zarr" },
      { recipe: "nemar-floor", dataset: "nm000104", input: "zarr" },
      {
        recipe: "nemar-floor",
        dataset: "nm000104",
        executor: "tapis",
        input: "zarr",
        dry_run: true,
      },
    ]) {
      const r = await call("POST", "/compute/pipeline/run", "admin", body, env);
      expect([body, r.status, r.body.code, r.body.field]).toEqual([
        body,
        400,
        "invalid_spec",
        "input",
      ]);
    }
    expect(await n(env, "compute_jobs")).toBe(0);
    expect(await n(env, "compute_pipeline_stamps")).toBe(0);
    expect(await n(env, "compute_ledger")).toBe(ledger);
  });

  test("the BIDS input on a runner is invalid_spec naming input (MUTATION: allow bids on a runner)", async () => {
    const env = runnerEnv();
    await seedPipelinesAccount(env);
    await seedEegDataset(env, "nm000104");
    const r = await call(
      "POST",
      "/compute/pipeline/run",
      "admin",
      {
        recipe: "nemar-floor",
        dataset: "nm000104",
        executor: "runner",
        input: "bids",
      },
      env,
    );
    expect([r.status, r.body.code, r.body.field]).toEqual([400, "invalid_spec", "input"]);
    expect(await n(env, "compute_jobs")).toBe(0);
  });

  test("a runner run over the queue is invalid_body naming executor (MUTATION: allow --eligible for a runner)", async () => {
    const env = runnerEnv();
    await seedPipelinesAccount(env);
    await zarrDataset(env, "nm000104");
    const r = await call(
      "POST",
      "/compute/pipeline/run",
      "admin",
      {
        recipe: "nemar-floor",
        eligible: true,
        executor: "runner",
      },
      env,
    );
    expect([r.status, r.body.code]).toEqual([400, "invalid_body"]);
    expect(r.body.error).toContain("executor");
    expect(await n(env, "compute_jobs")).toBe(0);
  });

  test("an executor that is not a word is invalid_body", async () => {
    const env = runnerEnv();
    const r = await call(
      "POST",
      "/compute/pipeline/run",
      "admin",
      {
        recipe: "nemar-floor",
        dataset: "nm000104",
        executor: "ssh",
      },
      env,
    );
    expect([r.status, r.body.code]).toEqual([400, "invalid_body"]);
  });

  test("with the runners switch off a live runner run is runners_disabled (503) and writes nothing (MUTATION: skip the switch)", async () => {
    const env = fx.env();
    await seedPipelinesAccount(env);
    await zarrDataset(env, "nm000104");
    const r = await runRunner("nm000104", env);
    expect([r.status, r.body.code]).toEqual([503, "runners_disabled"]);
    expect(await n(env, "compute_jobs")).toBe(0);
    expect(await n(env, "compute_pipeline_stamps")).toBe(0);
    // Exactly "1" turns it on: nothing else does.
    for (const value of ["0", "true", "yes", "1 "]) {
      const off = await runRunner("nm000104", fx.env({ COMPUTE_RUNNERS_ENABLED: value }));
      expect([value, off.body.code]).toEqual([value, "runners_disabled"]);
    }
    expect(await n(env, "compute_jobs")).toBe(0);
  });

  test("with compute off a runner run is compute_disabled, the switch of the Worker before the runners'", async () => {
    const env = runnerEnv({ COMPUTE_ENABLED: "0" });
    await seedPipelinesAccount(env);
    await zarrDataset(env, "nm000104");
    const r = await runRunner("nm000104", env);
    expect([r.status, r.body.code]).toEqual([503, "compute_disabled"]);
    expect(await n(env, "compute_jobs")).toBe(0);
  });

  test("the commit recorded on the dataset row is never read: a null, a malformed or another commit changes nothing (MUTATION: read the row)", async () => {
    const env = runnerEnv();
    await seedPipelinesAccount(env);
    await zarrDataset(env, "nm000104", null);
    await zarrDataset(env, "nm000105", "NOT-A-COMMIT");
    await zarrDataset(env, "nm000106", "f".repeat(40));
    for (const id of ["nm000104", "nm000105", "nm000106"]) {
      const r = await runRunner(id, env);
      expect([id, r.status]).toEqual([id, 201]);
      const stored = await fx.harness.records.get(recordKey(r.body.results[0].job_id, "spec.json"));
      const args = JSON.parse(await (stored as R2ObjectBody).text()).args as string[];
      // The vector carries the commit the INDEX and the tag name, not the row's.
      expect(args[args.indexOf("--source-commit") + 1]).toBe(COMMIT);
      expect(args[args.indexOf("--tag-commit") + 1]).toBe(COMMIT);
    }
  });

  test("an ineligible dataset is refused for a runner as for Tapis (eligibility is the dataset row's)", async () => {
    const env = runnerEnv();
    await seedPipelinesAccount(env);
    await zarrDataset(env, "nm000104");
    await env.DB.prepare(
      "UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000104'",
    ).run();
    const r = await runRunner("nm000104", env);
    expect(r.body.code).toBe("dataset_not_eligible");
    expect(r.body.blocked_by).toContain("public");
    expect(await n(env, "compute_jobs")).toBe(0);
  });

  test("a refused cap ends the stamp refused with the word, and leaves no job (the pipeline's own refusal path)", async () => {
    const env = runnerEnv();
    await seedPipelinesAccount(env);
    await zarrDataset(env, "nm000104");
    await ownerPolicy(env.DB, capOf(0));
    const r = await runRunner("nm000104", env);
    expect([r.status, r.body.code]).toEqual([409, "over_concurrency"]);
    expect(await n(env, "compute_jobs")).toBe(0);
    const stamp = await env.DB.prepare(
      "SELECT state, refusal_code FROM compute_pipeline_stamps",
    ).first<Record<string, string>>();
    expect(stamp).toEqual({ state: "refused", refusal_code: "over_concurrency" });
  });

  test("the service holds the same boundary when called directly: the input the executor does not run, the switch, and the cron", async () => {
    const env = runnerEnv();
    await seedPipelinesAccount(env);
    await zarrDataset(env, "nm000104");
    const actor = { kind: "admin", userId: 1 } as const;
    expect(
      await dispatchPipelineJob(env, {
        recipe: "nemar-floor",
        datasetId: "nm000104",
        actor,
        input: "zarr",
      }),
    ).toMatchObject({
      ok: false,
      code: "invalid_spec",
      field: "input",
    });
    expect(
      await dispatchPipelineJob(env, {
        recipe: "nemar-floor",
        datasetId: "nm000104",
        actor,
        executor: "runner",
        input: "bids",
      }),
    ).toMatchObject({
      ok: false,
      code: "invalid_spec",
      field: "input",
    });
    expect(
      await dispatchPipelineJob(fx.env(), {
        recipe: "nemar-floor",
        datasetId: "nm000104",
        actor,
        executor: "runner",
      }),
    ).toMatchObject({
      ok: false,
      code: "runners_disabled",
    });
    // The cron may not dispatch a runner run: automatic means automatic on Tapis.
    expect(
      await dispatchPipelineJob(env, {
        recipe: "nemar-floor",
        datasetId: "nm000104",
        actor: { kind: "cron" },
        executor: "runner",
      }),
    ).toMatchObject({
      ok: false,
      code: "recipe_not_automatic",
    });
    expect(await n(env, "compute_jobs")).toBe(0);
    expect(await n(env, "compute_pipeline_stamps")).toBe(0);
  });
});

// --- (g) No Tapis path touches a runner row ---------------------------------------------------------------------------

describe("no Tapis path touches a runner row", () => {
  /** A runner job made through the route, and the whole of its row, read back. */
  async function made(env: Bindings) {
    await seedPipelinesAccount(env);
    await zarrDataset(env, "nm000104");
    const r = await runRunner("nm000104", env);
    const id = r.body.results[0].job_id as string;
    return { id, snapshot: JSON.stringify(await row(env, id)) };
  }
  const unchanged = async (env: Bindings, id: string, snapshot: string) =>
    expect(JSON.stringify(await row(env, id))).toBe(snapshot);

  test("the 30-minute tick selects no runner row, examines none, and asks Tapis nothing (MUTATION: drop executor from CREATED_ROWS_SQL)", async () => {
    const env = runnerEnv();
    const { id, snapshot } = await made(env);
    const tick = await runComputeAdvanceCron(env);
    expect(tick).toMatchObject({ examined: 0, submitted: 0, advanced: 0, waiting: 0, errors: [] });
    await unchanged(env, id, snapshot);
    expect(fx.tapis.log).toEqual([]);
    // The control: a Tapis row in the same state IS selected by the same statement.
    await fundPipelines(env);
    const { job } = await makeJob(fx, { source: "pipeline" });
    const selected = (
      await env.DB.prepare(CREATED_ROWS_SQL).bind(ADVANCE_ROWS_PER_TICK).all<{ id: string }>()
    ).results.map((r) => r.id);
    expect(selected).toContain(job.id);
    expect(selected).not.toContain(id);
  });

  test("the cancel sweep selects no runner row, even one with a cancel recorded and old (MUTATION: drop executor from CANCEL_ROWS_SQL)", async () => {
    const env = runnerEnv();
    const { id } = await made(env);
    // A CLAIMED runner job (DM-07: a waiting one now ends in SQL, so only a claimed one keeps the intent).
    await env.DB.prepare(
      `UPDATE compute_jobs SET runner_id = ?2, runner_claimed_at = datetime('now') WHERE id = ?1`,
    )
      .bind(id, `rnr_${"d".repeat(24)}`)
      .run();
    const cancelled = await call("POST", `/compute/jobs/${id}/cancel`, "admin", undefined, env);
    expect(cancelled.status).toBe(200);
    // The intent is recorded (the runner's heartbeat carries it back); the job is NOT ended here.
    const recorded = await row(env, id);
    expect(recorded.cancel_requested_at).not.toBeNull();
    expect(recorded.state).toBe("created");
    expect(recorded.hold_ledger_id).toBeNull();
    await env.DB.prepare(
      "UPDATE compute_jobs SET cancel_requested_at = datetime('now', '-3 hours') WHERE id = ?1",
    )
      .bind(id)
      .run();
    const snapshot = JSON.stringify(await row(env, id));
    const swept = await sweepComputeCancellations(env);
    expect(swept).toMatchObject({
      examined: 0,
      cancel_failed: 0,
      cancel_pending_failed: 0,
      errors: [],
    });
    await unchanged(env, id, snapshot);
    expect(await countCancelPendingFailed(env.DB)).toBe(0);
    expect(fx.tapis.log).toEqual([]);
  });

  test("the cancel path never ends a runner row: cancel intent is recorded and driveCancel skips it (MUTATION: drop the driveCancel guard)", async () => {
    const env = runnerEnv();
    const { id } = await made(env);
    // A claimed runner job (a claim leaves the state `created`, ADR 0121 decision 2): ending it from here
    // would end work a runner is doing, and a Tapis job that never reached Tapis is ended by this very path.
    await env.DB.prepare(
      `UPDATE compute_jobs SET runner_id = ?2, runner_claimed_at = datetime('now') WHERE id = ?1`,
    )
      .bind(id, `rnr_${"d".repeat(24)}`)
      .run();
    const cancelled = await call("POST", `/compute/jobs/${id}/cancel`, "admin", undefined, env);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.outcome).toBe("cancel_requested");
    const after = await row(env, id);
    expect(after).toMatchObject({ state: "created", runner_id: `rnr_${"d".repeat(24)}` });
    expect(after.cancel_requested_at).not.toBeNull();
    expect(after.ended_at).toBeNull();
    expect(fx.tapis.log).toEqual([]);
  });

  test("the admin advance refuses a runner job as invalid_body naming executor, and changes nothing (MUTATION: drop the route's check and the service's)", async () => {
    const env = runnerEnv();
    const { id, snapshot } = await made(env);
    const r = await call("POST", `/compute/jobs/${id}/advance`, "admin", undefined, env);
    expect([r.status, r.body.code]).toEqual([400, "invalid_body"]);
    expect(r.body.error).toContain("executor");
    await unchanged(env, id, snapshot);
    expect(fx.tapis.log).toEqual([]);
  });

  test("the lifecycle's own entry points do nothing to a runner row: advance, submit, and the atomic claim (MUTATION: drop executor from CLAIM_SUBMIT_SQL)", async () => {
    const env = runnerEnv();
    const { id, snapshot } = await made(env);
    expect(await advanceComputeJob(env, id)).toMatchObject({ outcome: "nothing_to_do" });
    expect(await submitComputeJob(env, id)).toMatchObject({ ok: false, outcome: "bad_state" });
    await unchanged(env, id, snapshot);
    // The claim statement itself, alone: the last line of defense if a path forgot to look first.
    const claimed = await env.DB.prepare(CLAIM_SUBMIT_SQL)
      .bind(id, "2026-11-13 00:00:00.000")
      .run();
    expect(claimed.meta?.changes).toBe(0);
    await unchanged(env, id, snapshot);
    // The control: the same statement claims a Tapis row.
    await fundPipelines(env);
    const { job } = await makeJob(fx, { source: "pipeline" });
    const tapisClaim = await env.DB.prepare(CLAIM_SUBMIT_SQL)
      .bind(job.id, "2026-11-13 00:00:00.000")
      .run();
    expect(tapisClaim.meta?.changes).toBe(1);
    expect(fx.tapis.log).toEqual([]);
  });

  test("the webhook-hint advance is the same function: a runner row is never read back", async () => {
    const env = runnerEnv();
    const { id, snapshot } = await made(env);
    // The tapis route calls advanceComputeJob after verifying a token; the function is what is proven.
    for (let i = 0; i < 3; i++)
      await advanceComputeJob(env, id, { read: { maxAttempts: 1, timeoutMs: 100 } });
    await unchanged(env, id, snapshot);
    expect(fx.tapis.log).toEqual([]);
  });

  test("the terminal repair lists skip a runner row: uncopied, abandoned and the follow list (MUTATION: drop executor from UNCOPIED_TERMINAL_SQL)", async () => {
    const env = runnerEnv();
    // A runner row and a Tapis row, each terminal, settled and never copied, ended four days ago.
    const runnerId = await seedRunnerRow(env.DB, { state: "finished" });
    const tapis = await seedRunnerRow(env.DB, {
      state: "finished",
      executor: "tapis",
      accounting: "su",
    });
    for (const id of [runnerId, tapis]) {
      await env.DB.prepare(
        `UPDATE compute_jobs SET ended_at = datetime('now', '-4 days'), settled_provisional_at = datetime('now', '-4 days'),
           settled_final_at = datetime('now', '-4 days') WHERE id = ?1`,
      )
        .bind(id)
        .run();
    }
    const listed = (
      await env.DB.prepare(UNCOPIED_TERMINAL_SQL).bind(10).all<{ id: string }>()
    ).results.map((r) => r.id);
    // Four days is past the retry window, so neither is listed; the abandoned statements are the ones that see them.
    expect(listed).toEqual([]);
    expect(await n(env, "compute_jobs", "flag_mismatch = 1")).toBe(0);
    await env.DB.prepare(MARK_COPY_ABANDONED_SQL).run();
    expect((await row(env, runnerId)).flag_mismatch).toBe(0);
    expect((await row(env, tapis)).flag_mismatch).toBe(1);
    const count = (await env.DB.prepare(COPY_ABANDONED_COUNT_SQL).first<{ n: number }>())?.n;
    expect(count).toBe(1);
    // Within the window, the uncopied list names the Tapis row and not the runner row.
    await env.DB.prepare(
      "UPDATE compute_jobs SET ended_at = datetime('now', '-1 hours'), flag_mismatch = 0",
    ).run();
    const within = (
      await env.DB.prepare(UNCOPIED_TERMINAL_SQL).bind(10).all<{ id: string }>()
    ).results.map((r) => r.id);
    expect(within).toEqual([tapis]);
  });

  test("the tenant sweep's follow list skips a runner row (MUTATION: drop executor from FOLLOW_ROWS_SQL)", async () => {
    const env = runnerEnv();
    const runnerId = await seedRunnerRow(env.DB);
    const tapis = await seedRunnerRow(env.DB, { executor: "tapis", accounting: "su" });
    for (const id of [runnerId, tapis]) {
      await env.DB.prepare(
        "UPDATE compute_jobs SET flag_unreserved = 1, tapis_uuid = ?2 WHERE id = ?1",
      )
        .bind(id, `uuid-${id.slice(-6)}`)
        .run();
    }
    const listed = (
      await env.DB.prepare(FOLLOW_ROWS_SQL).bind(10).all<{ id: string }>()
    ).results.map((r) => r.id);
    expect(listed).toEqual([tapis]);
  });

  test("the observer's settlement list skips an accounting-none row (MUTATION: drop accounting from CANDIDATE_ROWS_SQL)", async () => {
    await fundPipelines(fx.env());
    const ended = await endedJob(fx, 30, { source: "pipeline" });
    const slurm = "4242424";
    const env = ended.env;
    await env.DB.prepare("UPDATE compute_jobs SET slurm_job_id = ?1 WHERE id = ?2")
      .bind(slurm, ended.job.id)
      .run();
    await env.DB.prepare(
      `INSERT INTO compute_sacct_rows (slurm_job_id, run_id, partition, state, elapsed_seconds, alloc_nodes,
         alloc_cpus, alloc_gpus, alloc_mem_mb, charged_milli)
       VALUES (?1, ?2, 'shared', 'COMPLETED', 1800, 1, 4, 0, 8000, 2000)`,
    )
      .bind(slurm, crypto.randomUUID())
      .run();
    await env.DB.prepare(MATCH_ROWS_SQL).run();
    const candidates = async () =>
      (await env.DB.prepare(CANDIDATE_ROWS_SQL).bind(10).all<{ job_id: string }>()).results.map(
        (r) => r.job_id,
      );
    expect(await candidates()).toEqual([ended.job.id]);
    // The same row as a runner job with no accounting is not settled by Slurm's figure.
    await env.DB.prepare(
      "UPDATE compute_jobs SET executor = 'runner', accounting = 'none' WHERE id = ?1",
    )
      .bind(ended.job.id)
      .run();
    expect(await candidates()).toEqual([]);
  });
});

// --- The Zarr copy a runner run reads ------------------------------------------------------------------------------

describe("a Zarr recipe reads only the newest version of a ready copy", () => {
  const TWO_VERSIONS = {
    versions: [
      ["1.0.0", "2026-01-01 00:00:00", null],
      ["1.1.0", "2026-02-01 00:00:00", null],
    ] as Array<[string, string, number | null]>,
  };

  test("an older version is zarr_version_not_newest (422), the newest and the unnamed version are made (MUTATION: drop the newest check)", async () => {
    const env = runnerEnv();
    await seedPipelinesAccount(env);
    await zarrDataset(env, "nm000104", COMMIT, {}, TWO_VERSIONS);
    const older = await runRunner("nm000104", env, { version: "1.0.0" });
    expect([older.status, older.body.code]).toEqual([422, "zarr_version_not_newest"]);
    expect(await n(env, "compute_jobs")).toBe(0);
    expect(await n(env, "compute_pipeline_stamps")).toBe(0);
    const dry = await runRunner("nm000104", env, { version: "1.0.0", dry_run: true });
    expect(dry.body.blocked).toMatchObject({ code: "zarr_version_not_newest", version: "v1.0.0" });
    expect(dry.body.would_dispatch).toEqual([]);
    const named = await runRunner("nm000104", env, { version: "1.1.0" });
    expect([named.status, named.body.results[0].version]).toEqual([201, "v1.1.0"]);
    expect((await row(env, named.body.results[0].job_id)).state).toBe("created");
    const unnamed = await runRunner("nm000104", runnerEnv(), { version: "latest" });
    expect(unnamed.body.code).toBe("live_attempt_exists");
  });

  for (const [name, copy] of [
    ["pending", { status: "pending" }],
    ["failed", { status: "failed" }],
    ["never converted", { status: null }],
    ["ready with no store", { status: "ready", stores: 0 }],
    ["ready with no count", { status: "ready", stores: null }],
  ] as const) {
    test(`a copy that is ${name} is zarr_copy_not_ready (409), though the row still holds a commit (MUTATION: drop the status check)`, async () => {
      const env = runnerEnv();
      await seedPipelinesAccount(env);
      await zarrDataset(env, "nm000104", COMMIT, copy);
      const r = await runRunner("nm000104", env);
      expect([r.status, r.body.code]).toEqual([409, "zarr_copy_not_ready"]);
      const dry = await runRunner("nm000104", env, { dry_run: true });
      expect(dry.body.blocked).toMatchObject({ code: "zarr_copy_not_ready" });
      expect(await n(env, "compute_jobs")).toBe(0);
      expect(await n(env, "compute_pipeline_stamps")).toBe(0);
    });
  }

  test("the manifest bound is a BIDS staging limit: a Zarr run over a huge manifest is made, a BIDS run is refused (MUTATION: apply the bound to Zarr)", async () => {
    const env = runnerEnv();
    await seedPipelinesAccount(env);
    await fundPipelines(env);
    const huge = {
      versions: [["1.0.0", "2026-01-01 00:00:00", 5_000_000]] as Array<
        [string, string, number | null]
      >,
    };
    await zarrDataset(env, "nm000104", COMMIT, {}, huge);
    await seedEegDataset(env, "nm000105", huge);
    expect((await runRunner("nm000104", env)).status).toBe(201);
    const bids = await call(
      "POST",
      "/compute/pipeline/run",
      "admin",
      { recipe: "nemar-floor", dataset: "nm000105" },
      env,
    );
    expect([bids.status, bids.body.code]).toEqual([422, "too_many_files"]);
  });

  test("the run is audited with its executor (MUTATION: drop executor from the audit row)", async () => {
    const env = runnerEnv();
    await seedPipelinesAccount(env);
    await zarrDataset(env, "nm000104");
    await runRunner("nm000104", env);
    const rows = (
      await env.DB.prepare(
        "SELECT details FROM audit_log WHERE action = 'compute.pipeline.run'",
      ).all<{ details: string }>()
    ).results;
    expect(JSON.parse(rows[0]?.details as string)).toEqual({
      mode: "dataset",
      executor: "runner",
      dispatched: 1,
      refused: 0,
      stopped_by: null,
    });
  });
});

// --- A records write that failed -----------------------------------------------------------------------------------

describe("a runner job whose records did not land", () => {
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

  test("is answered as records_not_written, not as waiting; the job exists with no records stamp (MUTATION: always say waiting_for_runner)", async () => {
    const env = runnerEnv({ COMPUTE_RECORDS: failing(2) });
    await seedPipelinesAccount(env);
    await zarrDataset(env, "nm000104");
    const r = await runRunner("nm000104", env);
    expect(r.status).toBe(201);
    expect(r.body.results[0]).toMatchObject({
      ok: true,
      submit: "records_not_written",
      records_written: false,
    });
    expect(ComputePipelineRunResponseSchema.safeParse(r.body).success).toBe(true);
    const job = await reread(env, r.body.results[0].job_id);
    expect(job).toMatchObject({ state: "created", executor: "runner", records_written_at: null });
    // The tick does not drive it (a runner row is not the Tapis path's), so nothing here repairs it.
    await runComputeAdvanceCron(env);
    expect((await reread(env, job.id)).records_written_at).toBeNull();
  });

  test("one failed write that the second try mends is answered as waiting", async () => {
    const env = runnerEnv({ COMPUTE_RECORDS: failing(1) });
    await seedPipelinesAccount(env);
    await zarrDataset(env, "nm000104");
    const r = await runRunner("nm000104", env);
    expect(r.body.results[0]).toMatchObject({
      submit: "waiting_for_runner",
      records_written: true,
    });
    expect((await reread(env, r.body.results[0].job_id)).records_written_at).not.toBeNull();
  });
});

// --- Idempotency across executors -------------------------------------------------------------------------------------

describe("a key is one executor's", () => {
  const KEY = `pl:${"cd".repeat(20)}`;
  const make = (env: Bindings, account: number, executor: "tapis" | "runner") =>
    createJob(env, {
      source: "pipeline",
      accountId: account,
      idempotencyKey: KEY,
      appId: "nemar-launch",
      appVersion: "1.0.0",
      spec: zarrSpec(env),
      ...(executor === "runner" ? { executor } : {}),
    });

  test("the same key and the same specification for the other executor is idempotency_conflict, both ways round (MUTATION: compare the digest only)", async () => {
    const env = runnerEnv();
    const account = await seedPipelinesAccount(env);
    await fundPipelines(env);
    expect(await make(env, account, "runner")).toMatchObject({ ok: true, replayed: false });
    await expect(make(env, account, "tapis")).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    expect(await n(env, "compute_jobs")).toBe(1);
    await env.DB.prepare("DELETE FROM compute_jobs").run();
    expect(await make(env, account, "tapis")).toMatchObject({ ok: true, replayed: false });
    await expect(make(env, account, "runner")).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    expect(await n(env, "compute_jobs")).toBe(1);
    // A replay of the same executor is still an answer.
    expect(await make(env, account, "tapis")).toMatchObject({ ok: true, replayed: true });
  });
});

// --- ACCESS and the abandoned-copy count -----------------------------------------------------------------------------------

describe("a runner row owes no ACCESS report and is no ACCESS job", () => {
  test("a Slurm id on a runner row makes no pending report; on a Tapis row it does (MUTATION: drop accounting from the statement)", async () => {
    const env = runnerEnv();
    const runnerId = await seedRunnerRow(env.DB);
    const tapis = await seedRunnerRow(env.DB, { executor: "tapis", accounting: "su" });
    for (const id of [runnerId, tapis]) {
      await env.DB.prepare("UPDATE compute_jobs SET slurm_job_id = ?2 WHERE id = ?1")
        .bind(id, `77${id.slice(-4)}`)
        .run();
      await env.DB.prepare(ACCESS_REPORT_PENDING_SQL).bind(id).run();
    }
    const reports = (
      await env.DB.prepare("SELECT job_id FROM compute_access_reports").all<{ job_id: string }>()
    ).results.map((r) => r.job_id);
    expect(reports).toEqual([tapis]);
  });

  test("the quarter's ACCESS report counts a Tapis job and never a runner job (MUTATION: drop accounting from accessReport)", async () => {
    const env = runnerEnv();
    const runnerId = await seedRunnerRow(env.DB);
    const tapis = await seedRunnerRow(env.DB, { executor: "tapis", accounting: "su" });
    for (const id of [runnerId, tapis]) {
      await env.DB.prepare(
        `UPDATE compute_jobs SET slurm_job_id = ?2, remote_submitted_at = '2026-11-05 10:00:00',
           gateway_user = ?3 WHERE id = ?1`,
      )
        .bind(id, `88${id.slice(-4)}`, id === tapis ? "gw_aaaaaaaaaaaaaaaaaaaa" : "nemar-pipelines")
        .run();
    }
    const report = await accessReport(env.DB, "2026Q4");
    expect(report?.totals).toEqual({ distinct_users: 1, jobs: 1 });
  });

  test("the abandoned-copy count within the window skips a runner row (MUTATION: drop executor from COPY_ABANDONED_RECENT_SQL)", async () => {
    const env = runnerEnv();
    for (const [executor, accounting] of [
      ["runner", "none"],
      ["tapis", "su"],
    ] as const) {
      const id = await seedRunnerRow(env.DB, { state: "finished", executor, accounting });
      await env.DB.prepare(
        `UPDATE compute_jobs SET ended_at = datetime('now', '-4 days'), settled_provisional_at = datetime('now', '-4 days') WHERE id = ?1`,
      )
        .bind(id)
        .run();
    }
    expect((await env.DB.prepare(COPY_ABANDONED_RECENT_SQL).first<{ n: number }>())?.n).toBe(1);
  });
});

// --- Releasing the pipelines account -------------------------------------------------------------------------------------

describe("ending the pipelines service account", () => {
  test("never ends an unclaimed runner row, and ends a Tapis row that never reached Tapis as before (MUTATION: drop executor from NEVER_REACHED_TAPIS)", async () => {
    const env = runnerEnv();
    const account = await seedPipelinesAccount(env);
    await zarrDataset(env, "nm000104");
    const made = await runRunner("nm000104", env);
    const runnerId = made.body.results[0].job_id as string;
    await fundPipelines(env);
    const { job } = await makeJob(fx, {
      source: "pipeline",
      account: { username: "nemar-pipelines-b" },
    });
    // A Tapis job of the same account that never reached Tapis (re-owned to the account under release).
    await env.DB.prepare("UPDATE compute_jobs SET account_id = ?2 WHERE id = ?1")
      .bind(job.id, account)
      .run();
    await env.DB.batch(
      computeReleaseStatements(account).map((s) => env.DB.prepare(s.sql).bind(...s.binds)),
    );
    const runnerRow = await row(env, runnerId);
    expect(runnerRow).toMatchObject({
      state: "created",
      executor: "runner",
      settled_provisional_at: null,
    });
    expect(runnerRow.cancel_requested_at).not.toBeNull();
    expect(runnerRow.ended_at).toBeNull();
    const tapisRow = await row(env, job.id);
    expect(tapisRow).toMatchObject({ state: "cancelled" });
    expect(tapisRow.settled_provisional_at).not.toBeNull();
  });
});
