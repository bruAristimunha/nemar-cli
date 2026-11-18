/**
 * NEMAR's pipelines obey their own caps on EVERY path (issue #2121, phase P1; ADR 0118, amendment of
 * 2026-11-10): `pipelines.maxLiveJobs` (per pool, every live state) is a guard inside the hold's own
 * statement, so an administrator's run, a named dataset and the daily cron cannot exceed it however they
 * interleave; `pipelines.dailyJobCap` and a per-invocation bound clamp an `--eligible` run for every actor.
 *
 * The admin routes are the REAL admin router with its real authentication, over a real migrated database
 * with the real ledger and policy, Miniflare's R2 and the Tapis stand-in (the services are the production
 * ones). The race cases put a round trip on both sides of every statement (`roundTripD1`), so two
 * requests that each READ a count before either WRITES both see the old count, which is what a
 * read-then-dispatch cap cannot survive.
 *
 * What is pinned:
 *  (a) a run of 100 over 20 eligible datasets with room for 3 makes exactly 3 live jobs and 3 holds, and
 *      stops with `over_concurrency`, having tried 3 (the clamp, not the hold's refusal, ended it);
 *  (b) an administrator's run and the cron racing for ONE free slot make exactly one job, whether they
 *      reach for the same dataset or for different ones (different ones is what only the guard stops);
 *  (c) the daily cap stops a run at what is left of it, with `daily_cap_reached`;
 *  (d) one named dataset is refused with `over_concurrency` (409) when its pool is full: the stamp is
 *      `refused` and no ledger row is written;
 *  (e) a dry run reports the room and trims `would_dispatch` to it, as a live run would;
 *  (f) one invocation dispatches at most 10, whatever the limit and the room.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_COMPUTE_POLICY } from "../../shared/contract/compute";
import { ComputePipelineRunResponseSchema } from "../../shared/contract/compute-admin";
import { PIPELINE_JOBS_TODAY_SQL } from "../src/services/compute-pipeline";
import { runComputePipelineDispatchCron } from "../src/services/compute-pipeline-dispatch";
import type { Bindings } from "../src/types/bindings";
import {
  COMPUTE_KEYS,
  type ComputeWho,
  makeComputeApp,
  seedComputeUsers,
} from "./helpers/compute-app";
import { type LifecycleFixture, startLifecycleFixture } from "./helpers/compute-lifecycle-fixture";
import {
  fundPipelines,
  seedEegDataset,
  seedPipelinesAccount,
} from "./helpers/compute-pipeline-fixture";
import { roundTripD1, setPolicy } from "./helpers/compute-seed";

let fx: LifecycleFixture;
const handle = makeComputeApp();

beforeAll(async () => {
  fx = await startLifecycleFixture();
}, 120_000);

beforeEach(async () => {
  await fx.reset();
  await seedComputeUsers(fx.harness.db);
});

afterAll(async () => {
  await fx?.dispose();
}, 30_000);

const ids = (n: number, from = 104) =>
  Array.from({ length: n }, (_, i) => `nm${String(from + i).padStart(6, "0")}`);

/** The pipelines' policy with the caps a case names, everything else the default. */
async function caps(over: { cpu?: number; daily?: number; liftTenant?: boolean }) {
  await setPolicy(fx.env().DB, fx.ownerId, {
    // The default tenant ceiling leaves the pipelines 12 (issue #2121); a case that wants more lifts it.
    ...(over.liftTenant
      ? { tenant: { maxLiveJobs: 1000, reserved: { people: 0, pipelines: 0, partner: 0 } } }
      : {}),
    pipelines: {
      ...DEFAULT_COMPUTE_POLICY.pipelines,
      dailyJobCap: over.daily ?? DEFAULT_COMPUTE_POLICY.pipelines.dailyJobCap,
      maxLiveJobs: {
        ...DEFAULT_COMPUTE_POLICY.pipelines.maxLiveJobs,
        cpu: over.cpu ?? DEFAULT_COMPUTE_POLICY.pipelines.maxLiveJobs.cpu,
      },
    },
  });
}

async function world(datasets: string[], over: Partial<Bindings> = {}) {
  const env = fx.env({ COMPUTE_PIPELINES_DISPATCH_ENABLED: "1", ...over });
  await seedPipelinesAccount(env);
  await fundPipelines(env);
  for (const id of datasets) await seedEegDataset(env, id);
  return env;
}

interface Reply {
  status: number;
  body: Record<string, any>;
}

async function run(who: ComputeWho, body: unknown, env: Bindings): Promise<Reply> {
  const res = await handle(
    new Request("http://api.test/admin/compute/pipeline/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${COMPUTE_KEYS[who]}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
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

const count = async (env: Bindings, sql: string) =>
  (await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0;

const LIVE_PIPELINE_JOBS = `SELECT COUNT(*) AS n FROM compute_jobs
  WHERE source = 'pipeline' AND state IN ('created', 'uploading', 'submitted', 'queued', 'running',
                                          'archiving', 'unreported')`;
const HOLDS = "SELECT COUNT(*) AS n FROM compute_ledger WHERE kind = 'hold'";
const STAMPS = "SELECT COUNT(*) AS n FROM compute_pipeline_stamps";
const REFUSED_STAMPS = "SELECT COUNT(*) AS n FROM compute_pipeline_stamps WHERE state = 'refused'";

describe("a run over the eligible datasets obeys the live cap", () => {
  test("(a) a limit of 100 over 20 datasets with room for 3 makes 3 live jobs and 3 holds", async () => {
    await caps({ cpu: 3 });
    const env = await world(ids(20));
    const res = await run("admin", { recipe: "nemar-floor", eligible: true, limit: 100 }, env);
    expect(ComputePipelineRunResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      dispatched: 3,
      stopped_by: "over_concurrency",
      room: { daily_left: 50, live_left: 3, limited_by: "live_cap" },
    });
    // The clamp ended the run: three tried, none refused, so no stamp was claimed for a fourth.
    expect(res.body.results).toHaveLength(3);
    expect(await count(env, LIVE_PIPELINE_JOBS)).toBe(3);
    expect(await count(env, HOLDS)).toBe(3);
    expect(await count(env, STAMPS)).toBe(3);
    expect(await count(env, REFUSED_STAMPS)).toBe(0);
  });

  test("a full pool dispatches nothing, and says why in the same words", async () => {
    await caps({ cpu: 2 });
    const env = await world(ids(6));
    await run("admin", { recipe: "nemar-floor", eligible: true, limit: 10 }, env);
    const holds = await count(env, HOLDS);
    const again = await run("admin", { recipe: "nemar-floor", eligible: true, limit: 10 }, env);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      dispatched: 0,
      stopped_by: "over_concurrency",
      room: { live_left: 0, limited_by: "live_cap" },
    });
    expect(again.body.results).toEqual([]);
    expect(await count(env, HOLDS)).toBe(holds);
    expect(await count(env, LIVE_PIPELINE_JOBS)).toBe(2);
  });
});

describe("(b) an administrator's run and the cron race for one free slot", () => {
  test("the same dataset: one job", async () => {
    await caps({ cpu: 1 });
    const env = await world(ids(5));
    const racing: Bindings = { ...env, DB: roundTripD1(env.DB) };
    const [admin, cron] = await Promise.all([
      run("admin", { recipe: "nemar-floor", eligible: true, limit: 5 }, racing),
      runComputePipelineDispatchCron(racing),
    ]);
    expect(admin.status).toBeLessThan(500);
    expect(cron?.outcome).toBe("ran");
    expect(await count(env, LIVE_PIPELINE_JOBS)).toBe(1);
    expect(await count(env, HOLDS)).toBe(1);
  });

  test("different datasets: one job, because the hold's own statement decides", async () => {
    await caps({ cpu: 1 });
    // The cron takes the first candidate (nm000104); the administrator names another one.
    const env = await world(ids(5));
    const racing: Bindings = { ...env, DB: roundTripD1(env.DB) };
    const [admin, cron] = await Promise.all([
      run("admin", { recipe: "nemar-floor", dataset: "nm000108" }, racing),
      runComputePipelineDispatchCron(racing),
    ]);
    expect(cron?.outcome).toBe("ran");
    expect(await count(env, LIVE_PIPELINE_JOBS)).toBe(1);
    expect(await count(env, HOLDS)).toBe(1);
    // Whoever lost was refused in the pool's own word, never a 500.
    const lost = admin.status === 409 ? admin.body.code : (cron?.recipes[0]?.stopped_by ?? null);
    expect(lost).toBe("over_concurrency");
  });

  test("a crowd of named datasets for three free slots: three jobs", async () => {
    await caps({ cpu: 3 });
    const env = await world(ids(10));
    const racing: Bindings = { ...env, DB: roundTripD1(env.DB) };
    const replies = await Promise.all(
      ids(10).map((dataset) => run("admin", { recipe: "nemar-floor", dataset }, racing)),
    );
    expect(replies.filter((r) => r.status === 201)).toHaveLength(3);
    expect(replies.filter((r) => r.status === 409).map((r) => r.body.code)).toEqual(
      Array(7).fill("over_concurrency"),
    );
    expect(await count(env, LIVE_PIPELINE_JOBS)).toBe(3);
    expect(await count(env, HOLDS)).toBe(3);
  });
});

describe("(c) the daily cap", () => {
  test("a cap of 2 with one job already today: one more, then daily_cap_reached", async () => {
    await caps({ daily: 2 });
    const env = await world(ids(5));
    const first = await run("admin", { recipe: "nemar-floor", dataset: "nm000104" }, env);
    expect(first.status).toBe(201);
    const res = await run("admin", { recipe: "nemar-floor", eligible: true, limit: 10 }, env);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      dispatched: 1,
      stopped_by: "daily_cap_reached",
      room: { daily_left: 1, limited_by: "daily_cap" },
    });
    expect(res.body.results).toHaveLength(1);
    expect(await count(env, LIVE_PIPELINE_JOBS)).toBe(2);
    // And with the cap used up, a further run dispatches nothing and says so.
    const none = await run("admin", { recipe: "nemar-floor", eligible: true, limit: 10 }, env);
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({
      dispatched: 0,
      stopped_by: "daily_cap_reached",
      room: { daily_left: 0 },
    });
    expect(await count(env, LIVE_PIPELINE_JOBS)).toBe(2);
  });

  test("a single named dataset counts toward the daily cap and is not refused by it", async () => {
    await caps({ daily: 1 });
    const env = await world(ids(3));
    expect((await run("admin", { recipe: "nemar-floor", dataset: "nm000104" }, env)).status).toBe(
      201,
    );
    const over = await run("admin", { recipe: "nemar-floor", dataset: "nm000105" }, env);
    expect(over.status).toBe(201);
    expect(await count(env, LIVE_PIPELINE_JOBS)).toBe(2);
    // Both are counted: the queue now has no daily room left.
    const queue = await run("admin", { recipe: "nemar-floor", eligible: true }, env);
    expect(queue.body).toMatchObject({ dispatched: 0, stopped_by: "daily_cap_reached" });
  });
});

describe("(d) one named dataset and a full pool", () => {
  test("409 over_concurrency, the stamp is refused, and no ledger row is written", async () => {
    await caps({ cpu: 1 });
    const env = await world(ids(3));
    expect((await run("admin", { recipe: "nemar-floor", dataset: "nm000104" }, env)).status).toBe(
      201,
    );
    const ledger = await count(env, "SELECT COUNT(*) AS n FROM compute_ledger");
    const jobs = await count(env, "SELECT COUNT(*) AS n FROM compute_jobs");
    const res = await run("admin", { recipe: "nemar-floor", dataset: "nm000105" }, env);
    expect([res.status, res.body.code]).toEqual([409, "over_concurrency"]);
    expect(res.body.error).toBe(
      "NEMAR's pipelines already have as many live jobs as the owner allows.",
    );
    const stamp = await env.DB.prepare(
      "SELECT state, refusal_code, job_id FROM compute_pipeline_stamps WHERE dataset_id = 'nm000105'",
    ).first<{ state: string; refusal_code: string | null; job_id: string | null }>();
    expect(stamp).toEqual({ state: "refused", refusal_code: "over_concurrency", job_id: null });
    expect(await count(env, "SELECT COUNT(*) AS n FROM compute_ledger")).toBe(ledger);
    expect(await count(env, "SELECT COUNT(*) AS n FROM compute_jobs")).toBe(jobs);
  });
});

describe("(e) a dry run says what a live run would do", () => {
  test("it reports the room and trims would_dispatch to it", async () => {
    await caps({ cpu: 3 });
    const env = await world(ids(20));
    const res = await run(
      "admin",
      { recipe: "nemar-floor", eligible: true, limit: 100, dry_run: true },
      env,
    );
    expect(res.status).toBe(200);
    expect(ComputePipelineRunResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body).toMatchObject({
      dry_run: true,
      room: { daily_left: 50, live_left: 3, limited_by: "live_cap" },
      estimate_milli_total: 3 * 48000,
    });
    expect(res.body.would_dispatch.map((d: any) => d.dataset_id)).toEqual(ids(3));
    expect(await count(env, STAMPS)).toBe(0);
  });

  test("a limit below the room is the limit, and a full pool previews nothing", async () => {
    await caps({ cpu: 3 });
    const env = await world(ids(20));
    const few = await run(
      "admin",
      { recipe: "nemar-floor", eligible: true, limit: 2, dry_run: true },
      env,
    );
    expect(few.body.would_dispatch).toHaveLength(2);
    expect(few.body.room).toEqual({
      daily_left: 50,
      live_left: 3,
      tenant_left: 12,
      limited_by: "limit",
    });
    await run("admin", { recipe: "nemar-floor", eligible: true, limit: 3 }, env);
    const full = await run(
      "admin",
      { recipe: "nemar-floor", eligible: true, limit: 5, dry_run: true },
      env,
    );
    expect(full.body.would_dispatch).toEqual([]);
    expect(full.body.room).toMatchObject({ live_left: 0, limited_by: "live_cap" });
    const named = await run(
      "admin",
      { recipe: "nemar-floor", dataset: "nm000110", dry_run: true },
      env,
    );
    expect(named.body.would_dispatch).toEqual([]);
    expect(named.body.blocked).toMatchObject({ code: "over_concurrency" });
    expect(named.body.room).toMatchObject({ live_left: 0 });
  });
});

describe("the day's count is a full table scan, so it is read once per run", () => {
  test("an administrator's run and its dry run each scan it once", async () => {
    await caps({ cpu: 100, daily: 100 });
    const env = await world(ids(4));
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
    const counted: Bindings = { ...env, DB: db };
    const dry = await run(
      "admin",
      { recipe: "nemar-floor", eligible: true, limit: 4, dry_run: true },
      counted,
    );
    expect(dry.status).toBe(200);
    expect(scans).toBe(1);
    const live = await run("admin", { recipe: "nemar-floor", eligible: true, limit: 4 }, counted);
    expect(live.body.dispatched).toBe(4);
    expect(scans).toBe(2);
  });
});

describe("(f) the per-invocation bound", () => {
  test("25 eligible datasets and room for all: one run dispatches 10", async () => {
    await caps({ cpu: 100, daily: 100, liftTenant: true });
    const env = await world(ids(25));
    const res = await run("admin", { recipe: "nemar-floor", eligible: true, limit: 100 }, env);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      dispatched: 10,
      stopped_by: null,
      room: { daily_left: 100, live_left: 100, limited_by: "per_invocation" },
    });
    expect(res.body.results).toHaveLength(10);
    expect(await count(env, LIVE_PIPELINE_JOBS)).toBe(10);
    const dry = await run(
      "admin",
      { recipe: "nemar-floor", eligible: true, limit: 100, dry_run: true },
      env,
    );
    expect(dry.body.would_dispatch).toHaveLength(10);
    expect(dry.body.room.limited_by).toBe("per_invocation");
  });

  test("the cron obeys the same live cap it always did", async () => {
    await caps({ cpu: 3 });
    const env = await world(ids(10));
    const result = await runComputePipelineDispatchCron(env);
    expect(result).toMatchObject({ outcome: "ran", dispatched: 3 });
    expect(await count(env, LIVE_PIPELINE_JOBS)).toBe(3);
  });
});
