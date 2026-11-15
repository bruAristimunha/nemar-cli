/**
 * One `nemar-floor` with two inputs, and what a pipeline stamp records of the input it read (portable compute
 * card Q0b; ADR 0121; plan D12 and D14), against NEMAR's REAL routes and services: the admin router behind its
 * real authentication, over a real migrated database (bun:sqlite behind `realD1`, and Miniflare's D1 for the
 * races), Miniflare's R2 through the Worker's own bindings, the Tapis stand-in for the BIDS input, and one real
 * loopback server for the two EXTERNAL services the Zarr source check reads (GitHub, and the serving copy's
 * index). Nothing of NEMAR is stood in for. What is played is a container's end: a runner job's state is set
 * with SQL the table accepts and the recipe's record is written to the results bucket where the launcher would
 * have put it, because the cases here are about what the stamp sync does with that record (the runner's own
 * path to `finished` is `compute-runner-queue.test.ts`'s).
 *
 * What is pinned, each group with the mutation that kills it named in its tests:
 *  (a) the claim: a runner dispatch of `nemar-floor` claims input `zarr`, a Tapis dispatch `bids`; a BIDS and
 *      a Zarr stamp of one dataset version coexist and each blocks only its own input; two or three requests
 *      racing for one tuple and input make one stamp and one job, on both engines, and a BIDS and a Zarr
 *      request racing for one dataset version make two;
 *  (b) the refusals: an input the executor does not run is `invalid_spec` naming `input`, through the route,
 *      the service and the dry run, and writes nothing; a word that is not an input is `invalid_body`;
 *  (c) the queue and the dry run read the input: a dataset a Zarr run has stamped is still a BIDS candidate
 *      and the other way round, and a dry run is blocked only by a live stamp of its own input;
 *  (d) success: a finished Zarr job's stamp holds the reader, the Zarr engine and the input digest the record
 *      names, a finished BIDS job's holds `git:` and its source commit; a value that does not fit its column is
 *      left empty and logged by field name, never stored; the job's own key keeps a BIDS stamp's old text;
 *  (e) drift: a record whose input kind disagrees with the stamp's input holds that input's tuple (and leaves
 *      the other input's free), writing nothing of what it read.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { RECIPE_INPUTS, findRecipe, recipeRequiredOutputs } from "../../shared/compute-recipes";
import { resultsOutputKey } from "../../shared/contract/compute-launch";
import {
  PIPELINE_CANDIDATES_SQL,
  type StampRow,
  dispatchEligible,
  dispatchPipelineJob,
  pipelineCandidates,
  pipelineDryRun,
  pipelineKey,
  syncPipelineStamps,
  tupleHeld,
} from "../src/services/compute-pipeline";
import { sha256Hex } from "../src/services/compute-records";
import type { Bindings } from "../src/types/bindings";
import {
  COMPUTE_KEYS,
  type ComputeWho,
  makeComputeApp,
  seedComputeUsers,
} from "./helpers/compute-app";
import { type LifecycleFixture, startLifecycleFixture } from "./helpers/compute-lifecycle-fixture";
import {
  floorOutputs,
  fundPipelines,
  recipeRecord,
  seedEegDataset,
  seedPipelinesAccount,
} from "./helpers/compute-pipeline-fixture";
import { roundTripD1, seedUser } from "./helpers/compute-seed";
import {
  type GithubCompareStandin,
  startGithubCompareStandin,
} from "./helpers/github-compare-standin";
import { logged } from "./helpers/logs";

let fx: LifecycleFixture;
const handle = makeComputeApp();
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
});

afterAll(async () => {
  github?.stop();
  seams.NEMAR_GITHUB_API_URL = previousSeams.github;
  seams.NEMAR_ZARR_INDEX_BASE = previousSeams.index;
  await fx?.dispose();
}, 30_000);

// --- Worlds ------------------------------------------------------------------------------------------------

/** A commit of the dataset repository: the tag's, and the one the serving index was built from. */
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ADMIN = { kind: "admin", userId: 1 } as const;

/** Development: compute runs there, and the source check honors its seams only outside production. */
const worldEnv = (over: Partial<Bindings> = {}): Bindings =>
  fx.env({ ENVIRONMENT: "development", COMPUTE_RUNNERS_ENABLED: "1", ...over });

interface World {
  name: string;
  d1: D1Database;
  env(over?: Partial<Bindings>): Bindings;
  /** An environment whose overlapping statements interleave, as D1's round trips do. */
  racing(): Bindings;
}

const worlds = (): World[] => [
  {
    name: "bun:sqlite",
    d1: fx.env().DB,
    env: (over) => worldEnv(over),
    racing: () => worldEnv({ DB: roundTripD1(fx.env().DB) }),
  },
  {
    name: "Miniflare D1",
    d1: fx.harness.d1 as D1Database,
    env: (over) => worldEnv({ DB: fx.harness.d1, ...over }),
    racing: () => worldEnv({ DB: fx.harness.d1 }),
  },
];

function onBoth(name: string, body: (w: World) => Promise<void>) {
  for (const which of [0, 1]) {
    test(`${name} [${which === 0 ? "bun:sqlite" : "Miniflare D1"}]`, async () => {
      await body(worlds()[which] as World);
    });
  }
}

let seq = 0;
/** A dataset id of its own: Miniflare's D1 is never reset, so no case reuses one. */
const freshId = () =>
  `nm${String(20_000 + Math.floor(Math.random() * 60_000) + ++seq).padStart(6, "0")}`;

/**
 * A public EEG dataset whose Zarr copy is ready and whose tag and index name `COMMIT` (the happy world of the
 * source check, whose verdict `zarr-source-check.test.ts` owns). `owner` is a real user for Miniflare's D1,
 * which enforces the foreign key.
 */
async function dataset(w: World, id = freshId()): Promise<string> {
  const env = w.env();
  const owner = w.name === "bun:sqlite" ? undefined : await seedUser(w.d1, {});
  await seedEegDataset(env, id, owner === undefined ? {} : { owner });
  github.tag(id, "v1.0.0", COMMIT);
  github.index(id, { source_commit: COMMIT, store_count: 3 });
  await w.d1
    .prepare(
      "UPDATE datasets SET zarr_source_commit = ?1, zarr_status = 'ready', zarr_store_count = 3 WHERE dataset_id = ?2",
    )
    .bind(COMMIT, id)
    .run();
  return id;
}

/** The service account and the funded pipelines pool a Tapis (BIDS) dispatch needs; a runner job needs neither. */
async function ready(w: World): Promise<void> {
  await seedPipelinesAccount(w.env(), { reuse: true });
  await fundPipelines(w.env());
}

const asRunner = { executor: "runner" } as const;

const dispatch = (
  env: Bindings,
  id: string,
  over: Partial<Parameters<typeof dispatchPipelineJob>[1]> = {},
) => dispatchPipelineJob(env, { recipe: "nemar-floor", datasetId: id, actor: ADMIN, ...over });

async function stampsOf(d1: D1Database, id: string): Promise<StampRow[]> {
  return (
    await d1
      .prepare("SELECT * FROM compute_pipeline_stamps WHERE dataset_id = ?1 ORDER BY id")
      .bind(id)
      .all<StampRow>()
  ).results;
}

const count = async (d1: D1Database, table: string, where = "1 = 1") =>
  (await d1.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>())
    ?.n ?? 0;

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  method: "GET" | "POST",
  path: string,
  who: ComputeWho,
  body: unknown,
  env: Bindings,
): Promise<Reply> {
  const res = await handle(
    new Request(`http://api.test/admin${path}`, {
      method,
      headers: { Authorization: `Bearer ${COMPUTE_KEYS[who]}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: parsed };
}

const route = (env: Bindings, body: Record<string, unknown>) =>
  call("POST", "/compute/pipeline/run", "admin", { recipe: "nemar-floor", ...body }, env);

// --- (a) The claim -------------------------------------------------------------------------------------------

describe("the claim names the input", () => {
  test("a runner dispatch of nemar-floor claims input zarr, and a Tapis dispatch claims bids", async () => {
    const [w] = worlds() as [World];
    await ready(w);
    const env = w.env();
    const zarrId = await dataset(w);
    const bidsId = await dataset(w);

    const zarr = await dispatch(env, zarrId, asRunner);
    expect(zarr).toMatchObject({ ok: true, recipe: "nemar-floor", attempt: 1 });
    const bids = await dispatch(env, bidsId);
    expect(bids).toMatchObject({ ok: true, recipe: "nemar-floor", attempt: 1 });

    expect((await stampsOf(w.d1, zarrId)).map((s) => [s.recipe, s.input, s.state])).toEqual([
      ["nemar-floor", "zarr", "dispatched"],
    ]);
    expect((await stampsOf(w.d1, bidsId)).map((s) => [s.recipe, s.input, s.state])).toEqual([
      ["nemar-floor", "bids", "dispatched"],
    ]);
    // The job each made is the input's: a runner job with no dataset staged and the input in its command,
    // a Tapis job with the dataset staged and the command nemar-floor always had.
    const jobOf = async (id: string) => (await stampsOf(w.d1, id))[0]?.job_id as string;
    const executors = async (id: string) =>
      (await w.d1
        .prepare("SELECT executor, accounting FROM compute_jobs WHERE id = ?1")
        .bind(await jobOf(id))
        .first<Record<string, string>>()) ?? {};
    expect(await executors(zarrId)).toEqual({ executor: "runner", accounting: "none" });
    expect(await executors(bidsId)).toEqual({ executor: "tapis", accounting: "su" });
  });

  test("a named input is the same as the default's own word, and a stamp's key keeps the BIDS text it had", async () => {
    const [w] = worlds() as [World];
    await ready(w);
    const env = w.env();
    const a = await dataset(w);
    const b = await dataset(w);
    expect(await dispatch(env, a, { input: "zarr", ...asRunner })).toMatchObject({ ok: true });
    expect(await dispatch(env, b, { input: "bids", executor: "tapis" })).toMatchObject({
      ok: true,
    });
    expect((await stampsOf(w.d1, a))[0]?.input).toBe("zarr");
    expect((await stampsOf(w.d1, b))[0]?.input).toBe("bids");

    // A BIDS stamp's key is the text it was before a stamp had an input, so a stamp claimed before the change
    // still finds its job; the Zarr stamp of the same tuple and attempt gets a key of its own.
    const tuple = {
      dataset_id: "nm000104",
      version: "v1.0.0",
      recipe: "nemar-floor",
      recipe_version: "1.0.0",
      engine: "eegprep@0.5.0",
      attempt: 1,
    };
    const legacy = `pl:${(
      await sha256Hex(new TextEncoder().encode("nm000104|v1.0.0|nemar-floor|1.0.0|eegprep@0.5.0|1"))
    ).slice(0, 40)}`;
    expect(await pipelineKey({ ...tuple, input: "bids" })).toBe(legacy);
    expect(await pipelineKey({ ...tuple, input: "zarr" })).not.toBe(legacy);
    expect(await pipelineKey({ ...tuple, input: "zarr" })).toMatch(/^pl:[0-9a-f]{40}$/);
  });

  test("a BIDS stamp and a Zarr stamp of one dataset version coexist, and each blocks only its own input (MUTATION: leave input out of the live index, or of the claim)", async () => {
    const [w] = worlds() as [World];
    await ready(w);
    const env = w.env();
    const id = await dataset(w);

    const first = await dispatch(env, id);
    const second = await dispatch(env, id, asRunner);
    expect(first).toMatchObject({ ok: true, attempt: 1, version: "v1.0.0" });
    expect(second).toMatchObject({ ok: true, attempt: 1, version: "v1.0.0" });
    const stamps = await stampsOf(w.d1, id);
    expect(stamps.map((s) => [s.input, s.attempt, s.state])).toEqual([
      ["bids", 1, "dispatched"],
      ["zarr", 1, "dispatched"],
    ]);
    expect(new Set(stamps.map((s) => s.job_id)).size).toBe(2);
    expect(await count(w.d1, "compute_jobs", "source = 'pipeline'")).toBe(2);

    // Each input is held by its own stamp and by no other.
    expect(await dispatch(env, id)).toMatchObject({ ok: false, code: "live_attempt_exists" });
    expect(await dispatch(env, id, asRunner)).toMatchObject({
      ok: false,
      code: "live_attempt_exists",
    });
    expect(await count(w.d1, "compute_pipeline_stamps", `dataset_id = '${id}'`)).toBe(2);
  });

  test("a failed attempt of one input frees that input, and every input counts its own attempts (MUTATION: count attempts over every input)", async () => {
    const [w] = worlds() as [World];
    await ready(w);
    const env = w.env();
    const id = await dataset(w);
    const fail = (stampId: number) =>
      w.d1
        .prepare(
          "UPDATE compute_pipeline_stamps SET state = 'failed', refusal_code = 'job_cancelled' WHERE id = ?1",
        )
        .bind(stampId)
        .run();
    // The BIDS input reaches attempt 2 first; the Zarr input then starts at 1, not at 3.
    const bids = await dispatch(env, id);
    if (!bids.ok) throw new Error("not dispatched");
    await fail(bids.stampId);
    expect(await dispatch(env, id)).toMatchObject({ ok: true, attempt: 2 });
    const zarr = await dispatch(env, id, asRunner);
    expect(zarr).toMatchObject({ ok: true, attempt: 1 });
    if (!zarr.ok) throw new Error("not dispatched");
    await fail(zarr.stampId);
    // The retry takes the NEXT attempt number of its own input, and the BIDS stamps are untouched.
    expect(await dispatch(env, id, asRunner)).toMatchObject({ ok: true, attempt: 2 });
    expect((await stampsOf(w.d1, id)).map((s) => [s.input, s.attempt, s.state])).toEqual([
      ["bids", 1, "failed"],
      ["bids", 2, "dispatched"],
      ["zarr", 1, "failed"],
      ["zarr", 2, "dispatched"],
    ]);
  });

  onBoth("three requests racing for one tuple and input make one stamp and one job", async (w) => {
    await ready(w);
    const id = await dataset(w);
    const env = w.racing();
    const before = await count(w.d1, "compute_jobs", "source = 'pipeline'");
    const results = await Promise.all([
      dispatch(env, id, asRunner),
      dispatch(env, id, asRunner),
      dispatch(env, id, asRunner),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => (r as { code: string }).code)).toEqual([
      "live_attempt_exists",
      "live_attempt_exists",
    ]);
    const stamps = await stampsOf(w.d1, id);
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toMatchObject({ input: "zarr", attempt: 1, state: "dispatched" });
    expect(await count(w.d1, "compute_jobs", "source = 'pipeline'")).toBe(before + 1);
    const winner = results.find((r) => r.ok);
    expect(stamps[0]?.job_id).toBe(winner?.ok ? winner.jobId : null);
  });

  onBoth(
    "a BIDS and a Zarr request racing for one dataset version make two stamps and two jobs",
    async (w) => {
      await ready(w);
      const id = await dataset(w);
      const env = w.racing();
      const before = await count(w.d1, "compute_jobs", "source = 'pipeline'");
      const results = await Promise.all([
        dispatch(env, id),
        dispatch(env, id, asRunner),
        dispatch(env, id),
        dispatch(env, id, asRunner),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(2);
      expect(results.filter((r) => !r.ok).map((r) => (r as { code: string }).code)).toEqual([
        "live_attempt_exists",
        "live_attempt_exists",
      ]);
      expect((await stampsOf(w.d1, id)).map((s) => s.input).sort()).toEqual(["bids", "zarr"]);
      expect(await count(w.d1, "compute_jobs", "source = 'pipeline'")).toBe(before + 2);
    },
  );
});

// --- (b) The refusals ----------------------------------------------------------------------------------------

describe("an input the executor does not run is refused before anything is written", () => {
  /** What a refused dispatch must not have changed. */
  async function snapshot(d1: D1Database) {
    return {
      stamps: await count(d1, "compute_pipeline_stamps"),
      jobs: await count(d1, "compute_jobs"),
      ledger: await count(d1, "compute_ledger"),
      holds: await count(d1, "compute_ledger", "kind = 'hold'"),
    };
  }

  test("through the route, bids on a runner is invalid_spec naming input, live and dry (MUTATION: allow bids on a runner)", async () => {
    const [w] = worlds() as [World];
    await ready(w);
    const env = w.env();
    const id = await dataset(w);
    const before = await snapshot(w.d1);
    for (const extra of [{}, { dry_run: true }]) {
      const r = await route(env, { dataset: id, executor: "runner", input: "bids", ...extra });
      expect([extra, r.status, r.body.code, r.body.field]).toEqual([
        extra,
        400,
        "invalid_spec",
        "input",
      ]);
      // The answer names the field and nothing a caller sent.
      expect(JSON.stringify(r.body)).not.toContain(id);
    }
    expect(await snapshot(w.d1)).toEqual(before);
  });

  test("through the route, zarr on tapis is invalid_spec naming input, with the executor given or defaulted (MUTATION: allow zarr on tapis)", async () => {
    const [w] = worlds() as [World];
    await ready(w);
    const env = w.env();
    const id = await dataset(w);
    const before = await snapshot(w.d1);
    for (const extra of [{ executor: "tapis" }, {}, { dry_run: true }]) {
      const r = await route(env, { dataset: id, input: "zarr", ...extra });
      expect([extra, r.status, r.body.code, r.body.field]).toEqual([
        extra,
        400,
        "invalid_spec",
        "input",
      ]);
    }
    // Over the queue too: the eligible datasets are the Tapis queue's, which reads bids only.
    const queue = await route(env, { eligible: true, input: "zarr" });
    expect([queue.status, queue.body.code, queue.body.field]).toEqual([
      400,
      "invalid_spec",
      "input",
    ]);
    expect(await snapshot(w.d1)).toEqual(before);
  });

  test("an executor the recipe does not list is refused before anything else, through the route, the service and the dry run (MUTATION: if (false) at each call site of recipeRunsOn)", async () => {
    const [w] = worlds() as [World];
    await ready(w);
    const env = w.env();
    const id = await dataset(w);
    const before = await snapshot(w.d1);
    // `nemar-ica` lists Tapis only. It is a placeholder, and asking where it may run comes first, so the real
    // registry shows the answer for an unlisted executor (nemar-floor lists both).
    for (const extra of [{}, { dry_run: true }]) {
      const r = await call(
        "POST",
        "/compute/pipeline/run",
        "admin",
        { recipe: "nemar-ica", dataset: id, executor: "runner", ...extra },
        env,
      );
      expect([extra, r.status, r.body.code]).toEqual([extra, 400, "invalid_body"]);
      expect(String(r.body.error)).toContain("executor");
    }
    expect(await dispatch(env, id, { recipe: "nemar-ica", executor: "runner" })).toMatchObject({
      ok: false,
      code: "invalid_spec",
      field: "executor",
    });
    expect(
      await pipelineDryRun(env, { recipe: "nemar-ica", datasetId: id, executor: "runner" }),
    ).toEqual({ ok: false, code: "invalid_spec", field: "executor" });
    // Where it does run, the placeholder is still refused as one, through every door.
    expect(await dispatch(env, id, { recipe: "nemar-ica" })).toMatchObject({
      ok: false,
      code: "recipe_placeholder",
    });
    expect(await pipelineDryRun(env, { recipe: "nemar-ica", datasetId: id })).toEqual({
      ok: false,
      code: "recipe_placeholder",
    });
    const placeholder = await call(
      "POST",
      "/compute/pipeline/run",
      "admin",
      { recipe: "nemar-ica", dataset: id },
      env,
    );
    expect([placeholder.status, placeholder.body.code]).toEqual([422, "recipe_placeholder"]);
    expect(await snapshot(w.d1)).toEqual(before);
  });

  test("a word that is not an input is invalid_body, not a refusal of the registry", async () => {
    const [w] = worlds() as [World];
    const env = w.env();
    const id = await dataset(w);
    for (const input of ["parquet", "", "BIDS", 1, null, ["bids"]]) {
      const r = await route(env, { dataset: id, input });
      expect([input, r.status, r.body.code]).toEqual([input, 400, "invalid_body"]);
      expect(String(r.body.error)).toContain("input");
    }
    expect(await count(w.d1, "compute_pipeline_stamps")).toBe(0);
  });

  test("the service holds the same boundary when called directly, before the switch, the read and the claim", async () => {
    const [w] = worlds() as [World];
    await ready(w);
    const id = await dataset(w);
    const before = await snapshot(w.d1);
    // The runners switch is off here: the input is refused first, so the word is the input's, not the switch's.
    const off = w.env({ COMPUTE_RUNNERS_ENABLED: undefined });
    expect(await dispatch(off, id, { executor: "runner", input: "bids" })).toMatchObject({
      ok: false,
      code: "invalid_spec",
      field: "input",
    });
    expect(await dispatch(w.env(), id, { executor: "tapis", input: "zarr" })).toMatchObject({
      ok: false,
      code: "invalid_spec",
      field: "input",
    });
    expect(await dispatch(w.env(), id, { input: "zarr" })).toMatchObject({
      ok: false,
      code: "invalid_spec",
      field: "input",
    });
    expect(github.log).toEqual([]);
    expect(await snapshot(w.d1)).toEqual(before);
  });

  test("the dry run says so as a service, and names the input it would run otherwise", async () => {
    const [w] = worlds() as [World];
    await ready(w);
    const env = w.env();
    const id = await dataset(w);
    expect(
      await pipelineDryRun(env, { recipe: "nemar-floor", datasetId: id, input: "zarr" }),
    ).toEqual({ ok: false, code: "invalid_spec", field: "input" });
    expect(
      await pipelineDryRun(env, {
        recipe: "nemar-floor",
        datasetId: id,
        executor: "runner",
        input: "bids",
      }),
    ).toEqual({ ok: false, code: "invalid_spec", field: "input" });
    expect(await pipelineDryRun(env, { recipe: "nemar-floor", datasetId: id })).toMatchObject({
      ok: true,
      executor: "tapis",
      input: "bids",
      would_dispatch: [{ dataset_id: id, version: "v1.0.0" }],
    });
    expect(
      await pipelineDryRun(env, { recipe: "nemar-floor", datasetId: id, executor: "runner" }),
    ).toMatchObject({ ok: true, executor: "runner", input: "zarr" });
  });

  test("a run says which input it ran, live and dry, through the route", async () => {
    const [w] = worlds() as [World];
    await ready(w);
    const env = w.env();
    const id = await dataset(w);
    const dry = await route(env, { dataset: id, executor: "runner", dry_run: true });
    expect(dry.body).toMatchObject({ ok: true, dry_run: true, executor: "runner", input: "zarr" });
    const live = await route(env, { dataset: id, executor: "runner", input: "zarr" });
    expect(live.status).toBe(201);
    expect(live.body).toMatchObject({ executor: "runner", input: "zarr", dispatched: 1 });
    const status = await call(
      "GET",
      `/compute/pipeline/status?dataset=${id}`,
      "admin",
      undefined,
      env,
    );
    expect(status.body.stamps).toMatchObject([
      {
        recipe: "nemar-floor",
        input: "zarr",
        reader: null,
        input_engine: null,
        input_digest: null,
      },
    ]);
  });
});

// --- (c) The queue and the dry run -----------------------------------------------------------------------------

describe("the queue and the dry run read the input", () => {
  const candidates = async (env: Bindings, input?: "bids" | "zarr") =>
    (await pipelineCandidates(env, findRecipe("nemar-floor") as never, 50, "", input)).map(
      (c) => c.dataset_id,
    );

  test("a dataset a Zarr run has stamped is still a BIDS candidate, and the other way round (MUTATION: drop input from the candidate statement)", async () => {
    const [w] = worlds() as [World];
    await ready(w);
    const env = w.env();
    const a = await dataset(w);
    const b = await dataset(w);
    for (const id of [a, b]) {
      expect(await candidates(env)).toContain(id);
      expect(await candidates(env, "zarr")).toContain(id);
    }
    expect(await dispatch(env, a, asRunner)).toMatchObject({ ok: true });
    expect(await dispatch(env, b)).toMatchObject({ ok: true });
    // The default is the Tapis queue's input: bids.
    expect(await candidates(env)).toContain(a);
    expect(await candidates(env)).not.toContain(b);
    expect(await candidates(env, "bids")).toContain(a);
    expect(await candidates(env, "zarr")).toContain(b);
    expect(await candidates(env, "zarr")).not.toContain(a);
    // The statement binds the input after the page size, the cooldown and the cap.
    expect(PIPELINE_CANDIDATES_SQL).toContain("?8");
  });

  test("a failure of one input does not cool the other down or count toward its cap", async () => {
    const [w] = worlds() as [World];
    await ready(w);
    const env = w.env();
    const id = await dataset(w);
    const zarr = await dispatch(env, id, asRunner);
    if (!zarr.ok) throw new Error("not dispatched");
    await w.d1
      .prepare(
        "UPDATE compute_pipeline_stamps SET state = 'failed', refusal_code = 'outputs_missing' WHERE id = ?1",
      )
      .bind(zarr.stampId)
      .run();
    // Cooling down for zarr; free for bids.
    expect(await candidates(env, "zarr")).not.toContain(id);
    expect(await candidates(env, "bids")).toContain(id);
  });

  test("three counted Zarr failures older than the cooldown leave the dataset a BIDS candidate and no longer a Zarr one (MUTATION: c.input = ?8 becomes (c.input = ?8 OR 1))", async () => {
    const [w] = worlds() as [World];
    await ready(w);
    const env = w.env();
    const id = await dataset(w);
    // Three failures the dataset's own word names (`outputs_missing` counts toward the cap), each far older
    // than the seven-day cooldown, so only the cap can keep a dataset out.
    for (const attempt of [1, 2, 3]) {
      await w.d1
        .prepare(
          `INSERT INTO compute_pipeline_stamps
             (dataset_id, version, recipe, recipe_version, engine, input, attempt, state, refusal_code, updated_at)
           VALUES (?1, 'v1.0.0', 'nemar-floor', '1.0.0', 'eegprep@0.5.0', 'zarr', ?2, 'failed',
                   'outputs_missing', datetime('now', '-30 days'))`,
        )
        .bind(id, attempt)
        .run();
    }
    expect(await candidates(env, "zarr")).not.toContain(id);
    expect(await candidates(env, "bids")).toContain(id);
    expect(await candidates(env)).toContain(id);
  });

  test("the Tapis queue dispatches over the BIDS tuple only: a Zarr stamp does not make a dataset current for it", async () => {
    const [w] = worlds() as [World];
    await ready(w);
    const env = w.env();
    const id = await dataset(w);
    // Only this dataset is eligible and stamped; the queue run is bounded to it by `limit`.
    expect(await dispatch(env, id, asRunner)).toMatchObject({ ok: true });
    const run = await dispatchEligible(env, { recipe: "nemar-floor", limit: 50, actor: ADMIN });
    expect(run.results.filter((r) => r.ok && r.datasetId === id)).toHaveLength(1);
    expect((await stampsOf(w.d1, id)).map((s) => s.input).sort()).toEqual(["bids", "zarr"]);
  });

  test("a dry run is blocked only by a live stamp of its own input (MUTATION: drop input from the live-stamp read)", async () => {
    const [w] = worlds() as [World];
    await ready(w);
    const env = w.env();
    const id = await dataset(w);
    expect(await dispatch(env, id, asRunner)).toMatchObject({ ok: true });
    const bids = await pipelineDryRun(env, { recipe: "nemar-floor", datasetId: id });
    expect(bids).toMatchObject({ ok: true, would_dispatch: [{ dataset_id: id }] });
    expect((bids as { blocked?: unknown }).blocked).toBeUndefined();
    const zarr = await pipelineDryRun(env, {
      recipe: "nemar-floor",
      datasetId: id,
      executor: "runner",
    });
    expect(zarr).toMatchObject({
      ok: true,
      would_dispatch: [],
      blocked: { code: "live_attempt_exists" },
    });
  });
});

// --- (d) Success -----------------------------------------------------------------------------------------------

const READER = "eegprep-lean@0.3.1+89abcdef0123456789abcdef0123456789abcdef";
const DIGEST = `sha256:${"0123456789abcdef".repeat(4)}`;
const SOURCE = "fedcba9876543210fedcba9876543210fedcba98";

/** The two stores a Zarr run of the test dataset was given, and the rows of what it read of them. */
const STORES = ["sub-01/eeg/sub-01_task-rest_eeg.edf", "sub-02/eeg/sub-02_task-rest_eeg.edf"];
const rowsOf = (paths: string[]) =>
  paths.map((path) => ({ path, group: "eeg", content_sha256: "ab".repeat(32) }));

/**
 * A Zarr-input record: the floor's own, with the input block and the reader the recipe writes, and, by default,
 * the coverage of a run that read every store it was given in full (`stores_content` has a row for each store
 * of `stores`, `stores_unread` is an empty list). `over` changes one thing at a time.
 */
const zarrRecord = (
  over: {
    reader?: unknown;
    engine?: unknown;
    digest?: unknown;
    kind?: unknown;
    stores?: unknown;
    content?: unknown;
    unread?: unknown;
  } = {},
) =>
  recipeRecord({
    dataset: { id: "nm000104", version: "v1.0.0", source_commit: COMMIT },
    reader: "reader" in over ? over.reader : READER,
    input: {
      kind: "kind" in over ? over.kind : "zarr",
      zarr_engine_version: "engine" in over ? over.engine : "0.4.2",
      input_digest: "digest" in over ? over.digest : DIGEST,
      stores: "stores" in over ? over.stores : STORES,
      stores_content: "content" in over ? over.content : rowsOf(STORES),
      stores_unread: "unread" in over ? over.unread : [],
    },
  });

/** A BIDS-input record: no input block, the commit the files were read at in the dataset block. */
const bidsRecord = (sourceCommit: unknown = SOURCE) =>
  recipeRecord({ dataset: { id: "nm000104", version: "v1.0.0", source_commit: sourceCommit } });

/**
 * Take a runner job to `finished` and write the recipe's product where the launcher would have uploaded it:
 * the job's state is set with SQL the table accepts (its path there is `compute-runner-queue.test.ts`'s), and
 * what the sync reads is the record in the results bucket.
 */
async function finishRunnerJob(w: World, jobId: string, record: string): Promise<void> {
  const floor = findRecipe("nemar-floor") as NonNullable<ReturnType<typeof findRecipe>>;
  for (const o of floorOutputs(record)) {
    await fx.harness.results.put(
      resultsOutputKey(jobId, o.path),
      new TextEncoder().encode(o.content),
    );
  }
  expect(recipeRequiredOutputs(floor).record).toBe(floorOutputs(record)[0]?.path as string);
  await w.d1
    .prepare("UPDATE compute_jobs SET state = 'finished', ended_at = datetime('now') WHERE id = ?1")
    .bind(jobId)
    .run();
}

describe("a succeeded stamp records what the run read", () => {
  async function zarrRun(w: World) {
    await ready(w);
    const id = await dataset(w);
    const r = await dispatch(w.env(), id, asRunner);
    if (!r.ok) throw new Error(`not dispatched: ${r.code}`);
    return { id, jobId: r.jobId, stampId: r.stampId };
  }

  test("a finished Zarr job's stamp holds the reader, the Zarr engine and the input digest the record names (MUTATION: leave the three out of the succeed statement)", async () => {
    const [w] = worlds() as [World];
    const { id, jobId } = await zarrRun(w);
    await finishRunnerJob(w, jobId, zarrRecord());
    const sync = await syncPipelineStamps(w.env());
    expect(sync).toMatchObject({ examined: 1, succeeded: 1, failed: 0 });
    expect((await stampsOf(w.d1, id))[0]).toMatchObject({
      state: "succeeded",
      input: "zarr",
      recipe_version: "1.0.0",
      engine: "eegprep@0.5.0",
      reader: READER,
      input_engine: "0.4.2",
      input_digest: DIGEST,
      job_id: jobId,
      refusal_code: null,
    });
    // The record named the tuple that was claimed and the input that was claimed: nothing is held.
    const floor = findRecipe("nemar-floor") as NonNullable<ReturnType<typeof findRecipe>>;
    for (const input of RECIPE_INPUTS) expect(await tupleHeld(w.d1, floor, input)).toBe(false);
  });

  test("a finished BIDS job's stamp holds git: and the commit the files were read at, and no reader (MUTATION: take the Zarr fields for a BIDS stamp)", async () => {
    const [w] = worlds() as [World];
    await ready(w);
    const id = await dataset(w);
    const r = await dispatch(w.env(), id);
    if (!r.ok) throw new Error("not dispatched");
    // A Tapis job finishes through the launcher; the stamp sync reads only its state and its record.
    await finishRunnerJob(w, r.jobId, bidsRecord());
    expect(await syncPipelineStamps(w.env())).toMatchObject({ succeeded: 1, failed: 0 });
    expect((await stampsOf(w.d1, id))[0]).toMatchObject({
      state: "succeeded",
      input: "bids",
      reader: null,
      input_engine: null,
      input_digest: `git:${SOURCE}`,
    });
  });

  test("a value that does not fit its column is left empty and logged by field name, never stored (MUTATION: store the value as it came)", async () => {
    const [w] = worlds() as [World];
    const { id, jobId } = await zarrRun(w);
    const hostile = {
      reader: "eegprep lean; DROP TABLE compute_pipeline_stamps",
      engine: "x".repeat(200),
      digest: DIGEST.toUpperCase(),
    };
    await finishRunnerJob(w, jobId, zarrRecord(hostile));
    const lines = await logged(async () => {
      expect(await syncPipelineStamps(w.env())).toMatchObject({ succeeded: 1, failed: 0 });
    });
    // The run is still a success: what could not be stored is simply not there.
    expect((await stampsOf(w.d1, id))[0]).toMatchObject({
      state: "succeeded",
      reader: null,
      input_engine: null,
      input_digest: null,
    });
    for (const field of ["reader", "input_engine", "input_digest"]) {
      expect(lines.some((l) => l.includes(`stamp_field_refused field=${field}`))).toBe(true);
    }
    // The log names a field, an id and a word: never what the record said.
    const text = lines.join("\n");
    for (const leaked of ["DROP TABLE", "xxxxxxxx", DIGEST.toUpperCase()]) {
      expect(text).not.toContain(leaked);
    }
  });

  test("a field the record does not state is empty and logged as absent, and one bad field does not take the others with it", async () => {
    const [w] = worlds() as [World];
    const { id, jobId } = await zarrRun(w);
    await finishRunnerJob(w, jobId, zarrRecord({ reader: undefined, digest: "sha256:short" }));
    const lines = await logged(async () => {
      await syncPipelineStamps(w.env());
    });
    expect((await stampsOf(w.d1, id))[0]).toMatchObject({
      state: "succeeded",
      reader: null,
      input_engine: "0.4.2",
      input_digest: null,
    });
    expect(lines.some((l) => l.includes("stamp_field_absent field=reader"))).toBe(true);
    expect(lines.some((l) => l.includes("stamp_field_refused field=input_digest"))).toBe(true);
    expect(lines.some((l) => l.includes("field=input_engine"))).toBe(false);
  });

  test("the product of a Zarr run is read under the one floor label: desc-nemarfloor_*, and a product under the old Zarr label is not read", async () => {
    const [w] = worlds() as [World];
    const { id, jobId } = await zarrRun(w);
    const floor = findRecipe("nemar-floor") as NonNullable<ReturnType<typeof findRecipe>>;
    expect(recipeRequiredOutputs(floor)).toEqual({
      record: "product/desc-nemarfloor_signalJourney.json",
      table: "product/desc-nemarfloor_recordings.tsv",
    });
    // A run that wrote its product under the transition name's label is a run whose files are not there.
    for (const [path, content] of [
      ["product/desc-nemarfloorzarr_signalJourney.json", zarrRecord()],
      ["product/desc-nemarfloorzarr_recordings.tsv", "path\tstatus\n"],
    ] as const) {
      await fx.harness.results.put(
        resultsOutputKey(jobId, path),
        new TextEncoder().encode(content),
      );
    }
    await w.d1
      .prepare(
        "UPDATE compute_jobs SET state = 'finished', ended_at = datetime('now') WHERE id = ?1",
      )
      .bind(jobId)
      .run();
    expect(await syncPipelineStamps(w.env())).toMatchObject({ succeeded: 0, failed: 1 });
    expect((await stampsOf(w.d1, id))[0]).toMatchObject({
      state: "failed",
      refusal_code: "outputs_missing",
    });
    // Under the label the registry names the same record is read.
    const again = await dataset(w);
    const r = await dispatch(w.env(), again, asRunner);
    if (!r.ok) throw new Error("not dispatched");
    await finishRunnerJob(w, r.jobId, zarrRecord());
    expect(
      await fx.harness.results.head(
        resultsOutputKey(r.jobId, "product/desc-nemarfloor_signalJourney.json"),
      ),
    ).not.toBeNull();
    expect(await syncPipelineStamps(w.env())).toMatchObject({ succeeded: 1 });
  });

  test("a Worker-dispatched BIDS record names no source commit: its digest is empty and that is not logged, absent or refused (the BIDS stamp carries no digest)", async () => {
    const [w] = worlds() as [World];
    await ready(w);
    const id = await dataset(w);
    const r = await dispatch(w.env(), id);
    if (!r.ok) throw new Error("not dispatched");
    for (const record of [bidsRecord(null), recipeRecord()]) {
      await finishRunnerJob(w, r.jobId, record);
      await w.d1
        .prepare(
          "UPDATE compute_pipeline_stamps SET state = 'dispatched', recipe_version = '1.0.0', input_digest = NULL WHERE id = ?1",
        )
        .bind(r.stampId)
        .run();
      const lines = await logged(async () => {
        expect(await syncPipelineStamps(w.env())).toMatchObject({ succeeded: 1, failed: 0 });
      });
      expect((await stampsOf(w.d1, id))[0]).toMatchObject({
        state: "succeeded",
        input_digest: null,
        reader: null,
        input_engine: null,
      });
      expect(lines.filter((l) => l.includes("stamp_field_"))).toEqual([]);
    }
  });

  test("a Zarr input digest is stored only when the record shows it covers every store: unread stores, no content, or other paths leave it empty with the reason (MUTATION: store it whenever it is well formed)", async () => {
    const [w] = worlds() as [World];
    const cases: Array<[string, Parameters<typeof zarrRecord>[0], string | null]> = [
      // The whole run read: stored.
      ["everything read", {}, null],
      // A stand-in record of a run that left two stores unread, with a digest that looks valid.
      ["two stores unread", { unread: ["HUGE", "MISSING"] }, "stores_unread"],
      ["one store unread", { unread: [STORES[1]] }, "stores_unread"],
      ["unread is a count, not a list", { unread: 2 }, "stores_unread"],
      ["unread is not stated", { unread: undefined }, "stores_unread"],
      ["no rows of content", { content: [] }, "no_stores_content"],
      ["no stores and no rows", { stores: [], content: [] }, "no_stores_content"],
      ["content is not a list", { content: "all" }, "no_stores_content"],
      ["content is not stated", { content: undefined }, "no_stores_content"],
      [
        "a row without a path",
        { content: [{ group: "eeg" }, ...rowsOf(STORES)] },
        "no_stores_content",
      ],
      ["one store has no row", { content: rowsOf(STORES.slice(0, 1)) }, "stores_differ"],
      [
        "a row for a store not named",
        { content: rowsOf([...STORES, "sub-03/x.edf"]) },
        "stores_differ",
      ],
      ["other paths", { content: rowsOf(["a.edf", "b.edf"]) }, "stores_differ"],
      [
        "a path twice",
        { content: rowsOf([STORES[0] as string, STORES[0] as string]) },
        "stores_differ",
      ],
      [
        "a store and its row twice",
        {
          stores: [STORES[0], STORES[0]],
          content: rowsOf([STORES[0] as string, STORES[0] as string]),
        },
        "stores_differ",
      ],
      ["stores is not stated", { stores: undefined }, "stores_differ"],
      ["stores is not a list of paths", { stores: [1, 2] }, "stores_differ"],
    ];
    for (const [name, over, reason] of cases) {
      await ready(w);
      const id = await dataset(w);
      const r = await dispatch(w.env(), id, asRunner);
      if (!r.ok) throw new Error("not dispatched");
      await finishRunnerJob(w, r.jobId, zarrRecord(over));
      const lines = await logged(async () => {
        expect(await syncPipelineStamps(w.env())).toMatchObject({ succeeded: 1, failed: 0 });
      });
      const stamp = (await stampsOf(w.d1, id))[0];
      // The run is a success whatever the digest; the digest is what the record shows is whole, or nothing.
      expect([name, stamp?.state, stamp?.input_digest]).toEqual([
        name,
        "succeeded",
        reason === null ? DIGEST : null,
      ]);
      // The other fields are stored as before.
      expect([name, stamp?.reader, stamp?.input_engine]).toEqual([name, READER, "0.4.2"]);
      const refusals = lines.filter((l) => l.includes("stamp_field_refused"));
      expect([name, refusals.length]).toEqual([name, reason === null ? 0 : 1]);
      if (reason !== null) {
        expect(refusals[0]).toContain(`field=input_digest reason=${reason}`);
        // A field name and a reason word, never what the record said.
        expect(refusals[0]).not.toContain("HUGE");
      }
    }
  });

  test("a BIDS record whose source commit is not a full commit leaves the digest empty and says so", async () => {
    const [w] = worlds() as [World];
    await ready(w);
    const id = await dataset(w);
    const r = await dispatch(w.env(), id);
    if (!r.ok) throw new Error("not dispatched");
    await finishRunnerJob(w, r.jobId, bidsRecord(SOURCE.toUpperCase()));
    const lines = await logged(async () => {
      await syncPipelineStamps(w.env());
    });
    expect((await stampsOf(w.d1, id))[0]).toMatchObject({ state: "succeeded", input_digest: null });
    expect(lines.some((l) => l.includes("stamp_field_refused field=input_digest"))).toBe(true);
  });
});

// --- (e) Drift -------------------------------------------------------------------------------------------------

describe("a record whose input kind disagrees ends the stamp failed and holds the tuple of the input that was claimed", () => {
  const floor = findRecipe("nemar-floor") as NonNullable<ReturnType<typeof findRecipe>>;

  test("a Zarr stamp whose record says bids ends failed tuple_mismatch, which holds the Zarr tuple, stores nothing it read and leaves BIDS free (MUTATION: remove the input-kind comparison)", async () => {
    const [w] = worlds() as [World];
    await ready(w);
    const id = await dataset(w);
    const other = await dataset(w);
    const r = await dispatch(w.env(), id, asRunner);
    if (!r.ok) throw new Error("not dispatched");
    // The record is the floor's own on every other count, and says it read the dataset's files.
    await finishRunnerJob(w, r.jobId, zarrRecord({ kind: "bids" }));
    const lines = await logged(async () => {
      expect(await syncPipelineStamps(w.env())).toMatchObject({
        examined: 1,
        succeeded: 0,
        failed: 1,
      });
    });
    expect(lines.some((l) => l.includes("tuple_mismatch"))).toBe(true);
    const stamps = await stampsOf(w.d1, id);
    // ONE stamp, and it never says "succeeded": it ended failed with the word, still linked to the job that
    // showed it, with nothing of what the record said it read. That stamp is the hold of its own input.
    expect(stamps.map((s) => [s.input, s.state, s.refusal_code, s.job_id])).toEqual([
      ["zarr", "failed", "tuple_mismatch", r.jobId],
    ]);
    expect([stamps[0]?.reader, stamps[0]?.input_engine, stamps[0]?.input_digest]).toEqual([
      null,
      null,
      null,
    ]);
    expect(await tupleHeld(w.d1, floor, "zarr")).toBe(true);
    expect(await tupleHeld(w.d1, floor, "bids")).toBe(false);
    // It holds no live slot and counts toward no cooldown or cap: the word is the registry's, not the
    // dataset's, so the dataset is still a candidate of its input (the hold, not the dataset, refuses it).
    expect(
      await count(w.d1, "compute_pipeline_stamps", "state IN ('dispatched', 'succeeded')"),
    ).toBe(0);
    for (const input of RECIPE_INPUTS) {
      const listed = await pipelineCandidates(w.env(), floor, 50, "", input);
      expect([input, listed.map((c) => c.dataset_id).includes(id)]).toEqual([input, true]);
    }
    // A second sync meets nothing of it.
    expect(await syncPipelineStamps(w.env())).toMatchObject({ examined: 0 });
    // On every path the Zarr input is refused and the BIDS input still runs.
    expect(await dispatch(w.env(), other, asRunner)).toMatchObject({
      ok: false,
      code: "registry_drift",
    });
    expect(
      await pipelineDryRun(w.env(), {
        recipe: "nemar-floor",
        datasetId: other,
        executor: "runner",
      }),
    ).toMatchObject({ ok: true, blocked: { code: "registry_drift" }, would_dispatch: [] });
    const viaRoute = await route(w.env(), { dataset: other, executor: "runner" });
    expect([viaRoute.status, viaRoute.body.code]).toEqual([409, "registry_drift"]);
    expect(await dispatch(w.env(), other)).toMatchObject({ ok: true });
  });

  test("a BIDS stamp whose record says zarr ends failed tuple_mismatch and holds the BIDS tuple, leaving the Zarr input free", async () => {
    const [w] = worlds() as [World];
    await ready(w);
    const id = await dataset(w);
    const other = await dataset(w);
    const r = await dispatch(w.env(), id);
    if (!r.ok) throw new Error("not dispatched");
    await finishRunnerJob(w, r.jobId, zarrRecord({ kind: "zarr" }));
    await syncPipelineStamps(w.env());
    expect(await tupleHeld(w.d1, floor, "bids")).toBe(true);
    expect(await tupleHeld(w.d1, floor, "zarr")).toBe(false);
    expect((await stampsOf(w.d1, id)).map((s) => [s.input, s.state, s.refusal_code])).toEqual([
      ["bids", "failed", "tuple_mismatch"],
    ]);
    expect(await dispatch(w.env(), other)).toMatchObject({ ok: false, code: "registry_drift" });
    expect(await dispatch(w.env(), other, asRunner)).toMatchObject({ ok: true });
  });

  test("a record that names no input is a BIDS record: it agrees with a BIDS stamp and disagrees with a Zarr one", async () => {
    const [w] = worlds() as [World];
    await ready(w);
    const id = await dataset(w);
    const zarr = await dispatch(w.env(), id, asRunner);
    if (!zarr.ok) throw new Error("not dispatched");
    await finishRunnerJob(w, zarr.jobId, bidsRecord());
    await syncPipelineStamps(w.env());
    expect(await tupleHeld(w.d1, floor, "zarr")).toBe(true);
  });

  test("an input kind that is no word makes the record unreadable: the stamp fails with that word and holds nothing", async () => {
    const [w] = worlds() as [World];
    await ready(w);
    const id = await dataset(w);
    const r = await dispatch(w.env(), id, asRunner);
    if (!r.ok) throw new Error("not dispatched");
    // Not a word at all: the record is unreadable and the stamp fails with that word, holding nothing.
    await finishRunnerJob(w, r.jobId, zarrRecord({ kind: "zarr store" }));
    await syncPipelineStamps(w.env());
    expect((await stampsOf(w.d1, id)).map((s) => [s.state, s.refusal_code])).toEqual([
      ["failed", "record_unreadable"],
    ]);
    expect(await tupleHeld(w.d1, floor, "zarr")).toBe(false);
  });
});

// --- (f) The retired name fails closed -----------------------------------------------------------------------

describe("a stamp of the retired recipe name fails closed", () => {
  const floor = findRecipe("nemar-floor") as NonNullable<ReturnType<typeof findRecipe>>;

  test("a dispatched old-name stamp whose job finished ends failed recipe_unknown, holds nothing and leaves nemar-floor free for the dataset (MUTATION: look the recipe up with a fallback)", async () => {
    const [w] = worlds() as [World];
    await ready(w);
    const id = await dataset(w);
    const made = await dispatch(w.env(), id, asRunner);
    if (!made.ok) throw new Error("not dispatched");
    // What migration 0141 leaves of a stamp that was open when it landed: the old name, input zarr.
    await w.d1
      .prepare("UPDATE compute_pipeline_stamps SET recipe = 'nemar-floor-zarr' WHERE id = ?1")
      .bind(made.stampId)
      .run();
    expect(findRecipe("nemar-floor-zarr")).toBeNull();
    // Its job finishes, and the record names the recipe the registry now knows.
    await finishRunnerJob(w, made.jobId, zarrRecord());
    expect(await syncPipelineStamps(w.env())).toMatchObject({
      examined: 1,
      succeeded: 0,
      failed: 1,
    });
    expect(
      (await stampsOf(w.d1, id)).map((s) => [s.recipe, s.input, s.state, s.refusal_code]),
    ).toEqual([["nemar-floor-zarr", "zarr", "failed", "recipe_unknown"]]);
    // The old rows fail closed and leave the new name alone: no hold on either input, no live slot, and a
    // nemar-floor Zarr run of the same dataset version is claimed.
    for (const input of RECIPE_INPUTS) expect(await tupleHeld(w.d1, floor, input)).toBe(false);
    const again = await dispatch(w.env(), id, asRunner);
    expect(again).toMatchObject({ ok: true, attempt: 1 });
    expect((await stampsOf(w.d1, id)).map((s) => [s.recipe, s.input, s.state])).toEqual([
      ["nemar-floor-zarr", "zarr", "failed"],
      ["nemar-floor", "zarr", "dispatched"],
    ]);
  });

  test("the registry cannot be asked to run it: the name is not a recipe, through the route and the service", async () => {
    const [w] = worlds() as [World];
    const id = await dataset(w);
    expect(await dispatch(w.env(), id, { recipe: "nemar-floor-zarr", ...asRunner })).toMatchObject({
      ok: false,
      code: "recipe_unknown",
    });
    const r = await call(
      "POST",
      "/compute/pipeline/run",
      "admin",
      { recipe: "nemar-floor-zarr", dataset: id, executor: "runner" },
      w.env(),
    );
    expect([r.status, r.body.code]).toEqual([422, "recipe_unknown"]);
    expect(await count(w.d1, "compute_pipeline_stamps")).toBe(0);
  });
});
