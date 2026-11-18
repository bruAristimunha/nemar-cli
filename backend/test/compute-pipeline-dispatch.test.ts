/**
 * The daily dispatcher of NEMAR's own pipelines (epic #2005 phase A6, #2011; ADR 0118): dark by default,
 * production-only by wiring and by its own fence, and inside the owner's caps. Real migrations, the real
 * ledger and policy, Miniflare's R2 and the Tapis stand-in; the services are the production ones.
 *
 *  - it is OFF without both switches (the pipelines switch AND compute, each exactly "1") and touches no
 *    table; outside exact production it returns null and touches no table, whatever the switches say;
 *  - it dispatches the automatic recipes only, honors the daily cap (counting the jobs an administrator
 *    made today too) and the live cap per pool, and never more than one tick's bound;
 *  - a refused hold stops the run, a refusal every recipe would meet ends it, and a registry that
 *    disagrees with a recent success dispatches nothing for that recipe;
 *  - the stamps are synced first.
 * The wiring (the call site in the production-only daily block, absent from the development allowlist)
 * is pinned by `cron-sweep-wiring.test.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { COMPUTE_RECIPES, findRecipe } from "../../shared/compute-recipes";
import { DEFAULT_COMPUTE_POLICY } from "../../shared/contract/compute";
import { COMPUTE_PIPELINE_RUN_PER_INVOCATION } from "../../shared/contract/compute-admin";
import {
  CLAIM_STAMP_SQL,
  OPEN_STAMPS_SQL,
  PIPELINE_JOBS_TODAY_SQL,
  dispatchPipelineJob,
} from "../src/services/compute-pipeline";
import {
  CRON_DISPATCH_PER_TICK,
  type PipelineCronResult,
  pipelineDispatchLogLine,
  runComputePipelineDispatchCron,
} from "../src/services/compute-pipeline-dispatch";
import type { Bindings } from "../src/types/bindings";
import { type LifecycleFixture, startLifecycleFixture } from "./helpers/compute-lifecycle-fixture";
import {
  finishAtTapis,
  floorOutputs,
  fundPipelines,
  seedEegDataset,
  seedPipelinesAccount,
} from "./helpers/compute-pipeline-fixture";
import { setPolicy } from "./helpers/compute-seed";
import { logged } from "./helpers/logs";

let fx: LifecycleFixture;

beforeAll(async () => {
  fx = await startLifecycleFixture();
}, 120_000);

afterAll(async () => {
  await fx?.dispose();
}, 30_000);

beforeEach(async () => {
  await fx.reset();
});

const ON = { COMPUTE_ENABLED: "1", COMPUTE_PIPELINES_DISPATCH_ENABLED: "1" } as const;
const floor = findRecipe("nemar-floor");
if (!floor) throw new Error("no nemar-floor");

const ids = (n: number, from = 104) =>
  Array.from({ length: n }, (_, i) => `nm${String(from + i).padStart(6, "0")}`);

async function world(datasets: string[], over: Partial<Bindings> = {}) {
  const env = fx.env({ ...ON, ...over });
  await seedPipelinesAccount(env);
  await fundPipelines(env);
  for (const id of datasets) await seedEegDataset(env, id);
  return env;
}

/** A database that throws when anything touches it, and says whether anything did. */
function untouched() {
  let touched = false;
  const trap = () => {
    touched = true;
    throw new Error("reached-d1");
  };
  const db = { prepare: trap, batch: trap, exec: trap } as unknown as D1Database;
  return { db, touched: () => touched };
}

const stampCount = async (env: Bindings) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM compute_pipeline_stamps").first<{ n: number }>())
    ?.n ?? 0;

async function policy(over: Record<string, unknown>) {
  await setPolicy(fx.env().DB, fx.ownerId, over);
}

const pipelinesPolicy = (dailyJobCap: number, cpu = 100) => ({
  pipelines: { ...DEFAULT_COMPUTE_POLICY.pipelines, dailyJobCap, maxLiveJobs: { cpu, gpu: 4 } },
});

describe("dark by default", () => {
  const dark: Array<[string, Partial<Bindings>]> = [
    [
      "no switch at all",
      { COMPUTE_ENABLED: undefined, COMPUTE_PIPELINES_DISPATCH_ENABLED: undefined },
    ],
    [
      "compute on, pipelines unset",
      { COMPUTE_ENABLED: "1", COMPUTE_PIPELINES_DISPATCH_ENABLED: undefined },
    ],
    [
      "pipelines on, compute off",
      { COMPUTE_ENABLED: undefined, COMPUTE_PIPELINES_DISPATCH_ENABLED: "1" },
    ],
    ["pipelines on, compute 0", { COMPUTE_ENABLED: "0", COMPUTE_PIPELINES_DISPATCH_ENABLED: "1" }],
    ["compute 'true'", { COMPUTE_ENABLED: "true", COMPUTE_PIPELINES_DISPATCH_ENABLED: "1" }],
    ["pipelines 'true'", { COMPUTE_ENABLED: "1", COMPUTE_PIPELINES_DISPATCH_ENABLED: "true" }],
    ["pipelines ' 1'", { COMPUTE_ENABLED: "1", COMPUTE_PIPELINES_DISPATCH_ENABLED: " 1" }],
    [
      "pipelines the number 1",
      { COMPUTE_ENABLED: "1", COMPUTE_PIPELINES_DISPATCH_ENABLED: 1 as never },
    ],
    ["pipelines 'yes'", { COMPUTE_ENABLED: "1", COMPUTE_PIPELINES_DISPATCH_ENABLED: "yes" }],
  ];
  for (const [name, bindings] of dark) {
    test(`${name}: off, and no table is touched`, async () => {
      const p = untouched();
      const result = await runComputePipelineDispatchCron({
        ENVIRONMENT: "production",
        DB: p.db,
        ...bindings,
      } as unknown as Bindings);
      expect(result).toMatchObject({ outcome: "off", dispatched: 0 });
      expect(p.touched()).toBe(false);
      expect(pipelineDispatchLogLine(result as PipelineCronResult)).toBeNull();
    });
  }

  test("with eligible datasets and everything else ready, off still dispatches nothing", async () => {
    const env = await world(ids(3), { COMPUTE_PIPELINES_DISPATCH_ENABLED: undefined });
    expect(await runComputePipelineDispatchCron(env)).toMatchObject({ outcome: "off" });
    expect(await stampCount(env)).toBe(0);
  });
});

describe("production only, by its own fence", () => {
  for (const environment of [
    "development",
    "staging",
    "test",
    "",
    undefined,
    "prod",
    "Production",
    " production",
  ]) {
    test(`ENVIRONMENT=${JSON.stringify(environment)}: null with D1 untouched, whatever the switches say`, async () => {
      const p = untouched();
      const e = { ENVIRONMENT: environment, DB: p.db, ...ON } as unknown as Bindings;
      expect(await runComputePipelineDispatchCron(e)).toBeNull();
      expect(p.touched()).toBe(false);
    });
  }

  test("in production it reaches D1, so the probe above is not vacuous", async () => {
    const p = untouched();
    await runComputePipelineDispatchCron({
      ENVIRONMENT: "production",
      DB: p.db,
      ...ON,
    } as unknown as Bindings);
    expect(p.touched()).toBe(true);
  });
});

describe("what it dispatches", () => {
  test("the automatic recipes only: nemar-floor is dispatched and nemar-ica never is", async () => {
    const env = await world(ids(2));
    await fundPipelines(env, 10_000_000, true);
    const result = await runComputePipelineDispatchCron(env);
    expect(result).toMatchObject({ outcome: "ran", dispatched: 2, errors: [] });
    expect(result?.recipes.map((r) => r.recipe)).toEqual(
      COMPUTE_RECIPES.filter((r) => r.autoDispatch).map((r) => r.name),
    );
    const recipes = (
      await env.DB.prepare("SELECT DISTINCT recipe FROM compute_pipeline_stamps").all<{
        recipe: string;
      }>()
    ).results.map((r) => r.recipe);
    expect(recipes).toEqual(["nemar-floor"]);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM compute_jobs WHERE pool = 'gpu'").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
  });

  test("a tick syncs the stamps once, however many recipes it dispatches", async () => {
    const env = await world(ids(2));
    let opens = 0;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql === OPEN_STAMPS_SQL) opens++;
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await runComputePipelineDispatchCron({ ...env, DB: db });
    expect(opens).toBe(1);
  });

  test("a tick scans the day's count once (a full table scan), however many it dispatches", async () => {
    const env = await world(ids(3));
    let scans = 0;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql === PIPELINE_JOBS_TODAY_SQL) scans++;
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await runComputePipelineDispatchCron({ ...env, DB: db });
    expect(result).toMatchObject({ dispatched: 3, today: 0 });
    expect(scans).toBe(1);
  });

  test("the tick's bound is the per-invocation bound of dispatchEligible, one number", () => {
    expect(CRON_DISPATCH_PER_TICK).toBe(COMPUTE_PIPELINE_RUN_PER_INVOCATION);
  });

  test("a second run dispatches nothing: every dataset is stamped", async () => {
    const env = await world(ids(2));
    await runComputePipelineDispatchCron(env);
    const again = await runComputePipelineDispatchCron(env);
    expect(again).toMatchObject({ dispatched: 0 });
    expect(await stampCount(env)).toBe(2);
  });

  test("the stamps are synced first: a finished job's dataset is current, and the run says so", async () => {
    const env = await world(ids(1));
    await runComputePipelineDispatchCron(env);
    const job = (await env.DB.prepare("SELECT id FROM compute_jobs").first<{ id: string }>())
      ?.id as string;
    await finishAtTapis(fx, env, job, { outputs: floorOutputs() });
    const next = await runComputePipelineDispatchCron(env);
    expect(next?.synced).toMatchObject({ succeeded: 1 });
    expect(next?.dispatched).toBe(0);
  });
});

describe("the caps", () => {
  test("the daily cap: two of five, and then none for the rest of the day", async () => {
    const env = await world(ids(5));
    await policy(pipelinesPolicy(2));
    const first = await runComputePipelineDispatchCron(env);
    expect(first).toMatchObject({ dispatched: 2, today: 0 });
    const second = await runComputePipelineDispatchCron(env);
    expect(second).toMatchObject({ dispatched: 0, today: 2 });
    expect(second?.recipes[0]).toMatchObject({ recipe: "nemar-floor", skipped: "daily_cap" });
    expect(await stampCount(env)).toBe(2);
  });

  test("the daily cap counts the pipeline jobs an administrator made today as well", async () => {
    const env = await world(ids(5));
    await policy(pipelinesPolicy(2));
    await dispatchPipelineJob(env, {
      recipe: "nemar-floor",
      datasetId: ids(5)[0] as string,
      actor: { kind: "admin", userId: 1 },
    });
    const result = await runComputePipelineDispatchCron(env);
    expect(result).toMatchObject({ today: 1, dispatched: 1 });
  });

  test("a job made yesterday does not count against today's cap", async () => {
    const env = await world(ids(3));
    await policy(pipelinesPolicy(1));
    await runComputePipelineDispatchCron(env);
    await env.DB.prepare("UPDATE compute_jobs SET created_at = datetime('now', '-2 days')").run();
    const result = await runComputePipelineDispatchCron(env);
    expect(result).toMatchObject({ today: 0, dispatched: 1 });
  });

  test("the live cap per pool: one live job fills a cap of one, and the run says why it stopped", async () => {
    const env = await world(ids(4));
    await policy(pipelinesPolicy(50, 1));
    expect(await runComputePipelineDispatchCron(env)).toMatchObject({ dispatched: 1 });
    const again = await runComputePipelineDispatchCron(env);
    expect(again).toMatchObject({ dispatched: 0 });
    expect(again?.recipes[0]?.skipped).toBe("live_cap");
  });

  test("the live cap is room, not a total: with two live of three it dispatches one more", async () => {
    const env = await world(ids(6));
    await policy(pipelinesPolicy(50, 3));
    await dispatchPipelineJob(env, {
      recipe: "nemar-floor",
      datasetId: ids(6)[0] as string,
      actor: { kind: "admin", userId: 1 },
    });
    await dispatchPipelineJob(env, {
      recipe: "nemar-floor",
      datasetId: ids(6)[1] as string,
      actor: { kind: "admin", userId: 1 },
    });
    expect(await runComputePipelineDispatchCron(env)).toMatchObject({ dispatched: 1 });
  });

  test("never more than one tick's bound, whatever the owner's caps allow", async () => {
    const env = await world(ids(CRON_DISPATCH_PER_TICK + 3));
    // 13 live jobs in all: more than the default tenant ceiling leaves the pipelines (12 beside the people's
    // floor, issue #2121, which compute-tenant-ceiling.test.ts proves), so this case lifts the ceiling.
    await policy({
      ...pipelinesPolicy(100, 100),
      tenant: { maxLiveJobs: 1000, reserved: { people: 0, pipelines: 0, partner: 0 } },
    });
    const result = await runComputePipelineDispatchCron(env);
    expect(result?.dispatched).toBe(CRON_DISPATCH_PER_TICK);
    // Said, so a recipe cut by the bound is not read as having nothing eligible.
    expect(result?.recipes[0]).toMatchObject({
      dispatched: CRON_DISPATCH_PER_TICK,
      skipped: "tick_cap",
    });
    expect(pipelineDispatchLogLine(result as PipelineCronResult)?.line).toContain(
      "nemar-floor_skipped=tick_cap",
    );
    expect(await stampCount(env)).toBe(CRON_DISPATCH_PER_TICK);
    // The next day's tick takes the rest.
    expect((await runComputePipelineDispatchCron(env))?.dispatched).toBe(3);
  });

  test("a run that ends below the bound is not reported as cut by it", async () => {
    const env = await world(ids(3));
    await policy(pipelinesPolicy(100, 100));
    const result = await runComputePipelineDispatchCron(env);
    expect(result).toMatchObject({ dispatched: 3 });
    expect(result?.recipes[0]?.skipped).toBeNull();
  });

  test("a daily cap of 0 dispatches nothing", async () => {
    const env = await world(ids(2));
    await policy(pipelinesPolicy(0));
    const result = await runComputePipelineDispatchCron(env);
    expect(result).toMatchObject({ dispatched: 0 });
    expect(result?.recipes[0]?.skipped).toBe("daily_cap");
  });
});

describe("a refusal", () => {
  test("a hold the pool refused stops the run: one refused stamp, not one per dataset", async () => {
    const env = fx.env(ON);
    await seedPipelinesAccount(env);
    for (const id of ids(4)) await seedEegDataset(env, id);
    const result = await runComputePipelineDispatchCron(env);
    expect(result).toMatchObject({ dispatched: 0 });
    expect(result?.recipes[0]).toMatchObject({ stopped_by: "insufficient_balance" });
    expect(await stampCount(env)).toBe(1);
    expect(pipelineDispatchLogLine(result as PipelineCronResult)).toMatchObject({ level: "warn" });
  });

  test("a refusal every recipe would meet ends the run: no runtime image", async () => {
    const env = await world(ids(2), { COMPUTE_RUNTIME_IMAGE: undefined });
    const result = await runComputePipelineDispatchCron(env);
    expect(result?.recipes[0]).toMatchObject({ dispatched: 0, stopped_by: "runtime_unavailable" });
    expect(await stampCount(env)).toBe(0);
  });

  test("a specification that cannot be built stops the run with a word, claims nothing, and does not abort the tick", async () => {
    const long = `ghcr.io/${"a".repeat(600)}/nemar-python@sha256:${"b".repeat(64)}`;
    const env = await world(ids(3), { COMPUTE_RUNTIME_IMAGE: long });
    const result = await runComputePipelineDispatchCron(env);
    expect(result).toMatchObject({ outcome: "ran", dispatched: 0, errors: [] });
    expect(result?.recipes[0]).toMatchObject({ stopped_by: "invalid_spec" });
    expect(await stampCount(env)).toBe(0);
  });

  test("a throw in the middle of a run keeps the count of what was dispatched, ends the run, and says so", async () => {
    const env = await world(ids(3));
    let claims = 0;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql === CLAIM_STAMP_SQL && ++claims === 2)
              throw new Error("injected: claim failed");
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let result: PipelineCronResult | null = null;
    const lines = await logged(async () => {
      result = await runComputePipelineDispatchCron({ ...env, DB: db });
    });
    const got = result as unknown as PipelineCronResult;
    expect(got).toMatchObject({ dispatched: 1, errors: ["run_failed"] });
    expect(got.recipes[0]).toMatchObject({ dispatched: 1, stopped_by: "run_failed" });
    expect(lines.join("\n")).toContain("run_failed recipe=nemar-floor dispatched=1");
    expect(pipelineDispatchLogLine(got)?.level).toBe("error");
    // The claim that threw never wrote, and the third dataset was never asked.
    expect(await stampCount(env)).toBe(1);
  });

  test("a failure outside a run (an unreadable policy) logs the partial count too", async () => {
    const env = await world(ids(1));
    await env.DB.prepare(
      "INSERT INTO compute_policy (policy_json, set_by, note) VALUES ('{\"nope\":1}', ?1, 'bad')",
    )
      .bind(fx.ownerId)
      .run();
    const lines = await logged(async () => {
      await runComputePipelineDispatchCron(env);
    });
    expect(lines.join("\n")).toContain("failed dispatched=0 error=ComputePolicyUnreadable");
  });

  test("no service account ends the run before any stamp is claimed", async () => {
    const env = fx.env(ON);
    await fundPipelines(env);
    for (const id of ids(2)) await seedEegDataset(env, id);
    const result = await runComputePipelineDispatchCron(env);
    expect(result?.recipes[0]?.stopped_by).toBe("pipelines_account_missing");
    expect(await stampCount(env)).toBe(0);
  });

  test("an unreadable policy dispatches nothing and says so in a fixed word", async () => {
    const env = await world(ids(2));
    await env.DB.prepare(
      "INSERT INTO compute_policy (policy_json, set_by, note) VALUES ('{\"nope\":1}', ?1, 'bad')",
    )
      .bind(fx.ownerId)
      .run();
    const result = await runComputePipelineDispatchCron(env);
    expect(result).toMatchObject({ dispatched: 0, errors: ["policy_unreadable"] });
    expect(pipelineDispatchLogLine(result as PipelineCronResult)?.level).toBe("error");
    expect(await stampCount(env)).toBe(0);
  });
});

describe("a result that does not carry the tuple it was dispatched with", () => {
  /** The hold the sync leaves when a finished result's tuple is not the one its stamp claimed. */
  async function held(env: Bindings, recipeVersion: string, engine: string) {
    await env.DB.prepare(
      `INSERT INTO compute_pipeline_stamps (dataset_id, version, recipe, recipe_version, engine, attempt, state, job_id, refusal_code)
       VALUES (?1, 'v1.0.0', 'nemar-floor', ?2, ?3, 1, 'failed', 'job_000000000000000000000001', 'tuple_mismatch')`,
    )
      .bind(ids(3)[0], recipeVersion, engine)
      .run();
  }

  test("a held registry tuple dispatches nothing from the cron, and says so", async () => {
    const env = await world(ids(3));
    await held(env, floor.version, floor.engine);
    const result = await runComputePipelineDispatchCron(env);
    expect(result?.dispatched).toBe(0);
    expect(result?.recipes[0]?.skipped).toBe("registry_drift");
    expect(pipelineDispatchLogLine(result as PipelineCronResult)).toMatchObject({ level: "warn" });
    expect(await stampCount(env)).toBe(1);
  });

  test("so does a held engine, and the hold does not expire with time", async () => {
    const env = await world(ids(3));
    await held(env, floor.version, floor.engine);
    await env.DB.prepare(
      "UPDATE compute_pipeline_stamps SET updated_at = datetime('now', '-400 days')",
    ).run();
    expect((await runComputePipelineDispatchCron(env))?.recipes[0]?.skipped).toBe("registry_drift");
  });

  test("a version bump is never held: the registry declares a tuple the old holds and successes do not name", async () => {
    const env = await world(ids(3));
    // Older successes, and an old mismatch, under the tuple the registry used to declare.
    await held(env, "0.9.0", "eegprep@0.4.0");
    await env.DB.prepare(
      `INSERT INTO compute_pipeline_stamps (dataset_id, version, recipe, recipe_version, engine, attempt, state, job_id)
       VALUES (?1, 'v1.0.0', 'nemar-floor', '0.9.0', 'eegprep@0.4.0', 2, 'succeeded', 'job_000000000000000000000002')`,
    )
      .bind(ids(3)[0])
      .run();
    const result = await runComputePipelineDispatchCron(env);
    expect(result?.dispatched).toBe(3);
    expect(result?.recipes[0]?.skipped).toBeNull();
  });

  test("a success with the registry's own version and engine holds nothing", async () => {
    const env = await world(ids(3));
    await env.DB.prepare(
      `INSERT INTO compute_pipeline_stamps (dataset_id, version, recipe, recipe_version, engine, attempt, state, job_id)
       VALUES (?1, 'v1.0.0', 'nemar-floor', ?2, ?3, 1, 'succeeded', 'job_000000000000000000000001')`,
    )
      .bind(ids(3)[0], floor.version, floor.engine)
      .run();
    expect((await runComputePipelineDispatchCron(env))?.dispatched).toBe(2);
  });
});

describe("the log line", () => {
  const base: PipelineCronResult = {
    outcome: "ran",
    synced: { examined: 0, succeeded: 0, failed: 0, linked: 0, later: 0, errored: 0 },
    today: 0,
    dispatched: 0,
    recipes: [{ recipe: "nemar-floor", dispatched: 0, skipped: null, stopped_by: null }],
    errors: [],
  };

  test("a run that did nothing and met nothing has no line", () => {
    expect(pipelineDispatchLogLine(base)).toBeNull();
  });

  test("a run that dispatched has an info line of counts and fixed words only", () => {
    const line = pipelineDispatchLogLine({ ...base, dispatched: 3, today: 1 });
    expect(line?.level).toBe("info");
    expect(line?.line).toBe(
      "[compute-pipeline-dispatch] dispatched=3 today=1 synced_succeeded=0 synced_failed=0",
    );
    expect(line?.line).not.toMatch(/nm\d{6}|job_|sha256|@/);
  });

  test("a sync that could not decide, or threw, is in the line: a warning for the first, an error for the second (MUTATION: leave either out)", () => {
    const later = pipelineDispatchLogLine({
      ...base,
      synced: { ...(base.synced as NonNullable<typeof base.synced>), later: 2 },
    });
    expect(later?.level).toBe("warn");
    expect(later?.line).toContain("synced_later=2");
    expect(later?.line).not.toContain("synced_errored");
    const errored = pipelineDispatchLogLine({
      ...base,
      synced: { ...(base.synced as NonNullable<typeof base.synced>), errored: 1, later: 1 },
    });
    expect(errored?.level).toBe("error");
    expect(errored?.line).toContain("synced_errored=1");
  });
});
