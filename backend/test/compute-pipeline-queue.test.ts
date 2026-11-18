/**
 * The queue and the dry run of NEMAR's own pipeline dispatch (epic #2005 phase A6, #2011; ADR 0118):
 * which datasets a recipe has not been run over, what a dry run says and writes (nothing), and a run over
 * the next datasets with a limit. Real migrations, the real ledger, Miniflare's R2, the Tapis stand-in;
 * the services are the production ones.
 *
 *  - the candidates are the eligible datasets whose newest version holds no live or succeeded stamp for
 *    the recipe's tuple, in dataset order, and a version without a data-plane tag is skipped;
 *  - a dry run writes NOTHING (no stamp, no job, no hold, no audit row, no request to Tapis), works in a
 *    non-production environment with compute off, says why a named dataset would be refused, and counts
 *    what blocks each term over the catalog;
 *  - a run over the queue with `limit` 2 dispatches two, stops at a hold the pool refused, and does not
 *    stop at a refusal that is about one dataset.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { findRecipe } from "../../shared/compute-recipes";
import { runComputeAdvanceCron } from "../src/services/compute-advance";
import {
  MAX_FAILED_ATTEMPTS,
  RETRY_COOLDOWN_DAYS,
  dispatchEligible,
  dispatchPipelineJob,
  pipelineCandidates,
  pipelineDryRun,
  recipeEstimateMilli,
  syncPipelineStamps,
} from "../src/services/compute-pipeline";
import type { Bindings } from "../src/types/bindings";
import { type LifecycleFixture, startLifecycleFixture } from "./helpers/compute-lifecycle-fixture";
import {
  finishAtTapis,
  floorOutputs,
  fundPipelines,
  seedEegDataset,
  seedPipelinesAccount,
} from "./helpers/compute-pipeline-fixture";

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

const floor = findRecipe("nemar-floor");
if (!floor) throw new Error("no nemar-floor");
const ADMIN = { kind: "admin", userId: 1 } as const;

async function world(ids: string[] = ["nm000104", "nm000105", "nm000106"]) {
  const env = fx.env();
  await seedPipelinesAccount(env);
  await fundPipelines(env);
  for (const id of ids) await seedEegDataset(env, id);
  return env;
}

const counts = async (env: Bindings) => {
  const n = async (table: string) =>
    (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;
  return {
    stamps: await n("compute_pipeline_stamps"),
    jobs: await n("compute_jobs"),
    ledger: await n("compute_ledger"),
    audit: await n("audit_log"),
    tapis: fx.tapis.log.length,
  };
};

describe("the candidates", () => {
  test("are the eligible datasets in order, and a dataset with a live stamp for the tuple is not one", async () => {
    const env = await world();
    expect((await pipelineCandidates(env, floor, 10)).map((c) => c.dataset_id)).toEqual([
      "nm000104",
      "nm000105",
      "nm000106",
    ]);
    await dispatchPipelineJob(env, { recipe: "nemar-floor", datasetId: "nm000105", actor: ADMIN });
    expect((await pipelineCandidates(env, floor, 10)).map((c) => c.dataset_id)).toEqual([
      "nm000104",
      "nm000106",
    ]);
    expect(await pipelineCandidates(env, floor, 1)).toEqual([
      { dataset_id: "nm000104", version: "1.0.0", tag: "v1.0.0" },
    ]);
  });

  test("a failed or refused stamp does not hide a dataset; a succeeded one does", async () => {
    const env = await world(["nm000104"]);
    const first = await dispatchPipelineJob(env, {
      recipe: "nemar-floor",
      datasetId: "nm000104",
      actor: ADMIN,
    });
    if (!first.ok) throw new Error("not dispatched");
    expect(await pipelineCandidates(env, floor, 10)).toHaveLength(0);
    await finishAtTapis(fx, env, first.jobId, { outputs: floorOutputs() });
    await syncPipelineStamps(env);
    // Succeeded, with the registry's own version and engine: the dataset is current.
    expect(await pipelineCandidates(env, floor, 10)).toHaveLength(0);
    // A failed stamp frees the tuple.
    await env.DB.prepare(
      "UPDATE compute_pipeline_stamps SET state = 'failed', refusal_code = 'job_failed', updated_at = datetime('now', '-30 days')",
    ).run();
    expect(await pipelineCandidates(env, floor, 10)).toHaveLength(1);
  });

  test("only the newest version is considered: a stamp for an older one does not make the newest current", async () => {
    const env = fx.env();
    await seedEegDataset(env, "nm000104", {
      versions: [
        ["1.0.0", "2026-01-01 00:00:00"],
        ["1.1.0", "2026-02-01 00:00:00"],
      ],
    });
    await env.DB.prepare(
      `INSERT INTO compute_pipeline_stamps (dataset_id, version, recipe, recipe_version, engine, attempt, state, job_id)
       VALUES ('nm000104', 'v1.0.0', 'nemar-floor', ?1, ?2, 1, 'succeeded', 'job_000000000000000000000001')`,
    )
      .bind(floor.version, floor.engine)
      .run();
    expect(await pipelineCandidates(env, floor, 10)).toEqual([
      { dataset_id: "nm000104", version: "1.1.0", tag: "v1.1.0" },
    ]);
  });

  test("a stamp for another recipe version or engine does not make the dataset current for this one", async () => {
    const env = fx.env();
    await seedEegDataset(env, "nm000104");
    for (const [rv, engine] of [
      ["0.9.0", floor.engine],
      [floor.version, "eegprep@0.4.0"],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO compute_pipeline_stamps (dataset_id, version, recipe, recipe_version, engine, attempt, state, job_id)
         VALUES ('nm000104', 'v1.0.0', 'nemar-floor', ?1, ?2, 1, 'succeeded', 'job_000000000000000000000001')`,
      )
        .bind(rv, engine)
        .run();
    }
    expect(await pipelineCandidates(env, floor, 10)).toHaveLength(1);
  });

  test("a version with no data-plane tag is skipped, and the next dataset is still found", async () => {
    const env = fx.env();
    await seedEegDataset(env, "nm000104", { versions: [["1.0", "2026-01-01 00:00:00"]] });
    await seedEegDataset(env, "nm000105");
    expect((await pipelineCandidates(env, floor, 1)).map((c) => c.dataset_id)).toEqual([
      "nm000105",
    ]);
  });

  test("an ineligible dataset is not a candidate: private, withdrawn, non-EEG, a fixture", async () => {
    const env = fx.env();
    await seedEegDataset(env, "nm000104", { visibility: "private" });
    await seedEegDataset(env, "nm000105", { withdrawnAt: "2026-02-01 00:00:00" });
    await seedEegDataset(env, "nm000106", { modalities: "meg" });
    await seedEegDataset(env, "nm099950");
    await seedEegDataset(env, "nm000107");
    expect((await pipelineCandidates(env, floor, 10)).map((c) => c.dataset_id)).toEqual([
      "nm000107",
    ]);
  });

  test("a page full of skipped rows does not hide a candidate behind it", async () => {
    const env = fx.env();
    for (let i = 0; i < 30; i++) {
      await seedEegDataset(env, `nm0002${String(i).padStart(2, "0")}`, {
        versions: [["1.0", "2026-01-01 00:00:00"]],
      });
    }
    await seedEegDataset(env, "nm000900");
    expect((await pipelineCandidates(env, floor, 1)).map((c) => c.dataset_id)).toEqual([
      "nm000900",
    ]);
  });
});

describe("a dataset that keeps failing", () => {
  const failed = async (
    env: Bindings,
    dataset: string,
    attempts: number,
    updated = "-30 days",
    code = "job_failed",
  ) => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await env.DB.prepare(
        `INSERT INTO compute_pipeline_stamps (dataset_id, version, recipe, recipe_version, engine, attempt, state, refusal_code, updated_at)
         VALUES (?1, 'v1.0.0', 'nemar-floor', ?2, ?3, ?4, 'failed', ?6, datetime('now', ?5))`,
      )
        .bind(dataset, floor.version, floor.engine, attempt, updated, code)
        .run();
    }
  };

  test("a head of datasets that failed lately does not block a dispatchable one behind it", async () => {
    const env = await world(["nm000104", "nm000105", "nm000106", "nm000107"]);
    for (const id of ["nm000104", "nm000105", "nm000106"]) await failed(env, id, 1, "-1 hours");
    expect((await pipelineCandidates(env, floor, 1)).map((c) => c.dataset_id)).toEqual([
      "nm000107",
    ]);
  });

  test("the cooldown holds: a failure inside it is not a candidate, one outside it is", async () => {
    const env = await world(["nm000104", "nm000105"]);
    await failed(env, "nm000104", 1, `-${RETRY_COOLDOWN_DAYS - 1} days`);
    await failed(env, "nm000105", 1, `-${RETRY_COOLDOWN_DAYS + 1} days`);
    expect((await pipelineCandidates(env, floor, 10)).map((c) => c.dataset_id)).toEqual([
      "nm000105",
    ]);
  });

  test("the cap holds: at the failed-attempt cap a tuple is never a candidate again, however old", async () => {
    const env = await world(["nm000104", "nm000105"]);
    await failed(env, "nm000104", MAX_FAILED_ATTEMPTS);
    await failed(env, "nm000105", MAX_FAILED_ATTEMPTS - 1);
    expect((await pipelineCandidates(env, floor, 10)).map((c) => c.dataset_id)).toEqual([
      "nm000105",
    ]);
  });

  test("failures that are the platform's or the registry's and consumed nothing never count: three on three days block nothing", async () => {
    const env = await world(["nm000104"]);
    for (const [i, code] of [
      "create_failed",
      "no_job",
      "tapis_error",
      "job_cancelled",
      "tuple_mismatch",
    ].entries()) {
      await env.DB.prepare(
        `INSERT INTO compute_pipeline_stamps (dataset_id, version, recipe, recipe_version, engine, attempt, state, refusal_code, updated_at)
         VALUES ('nm000104', 'v1.0.0', 'nemar-floor', ?1, ?2, ?3, 'failed', ?4, datetime('now', ?5))`,
      )
        .bind(floor.version, floor.engine, i + 1, code, `-${i + 1} days`)
        .run();
    }
    // Five platform-coded failures, the freshest a day old: inside the cooldown and over the cap, if counted.
    expect(await pipelineCandidates(env, floor, 10)).toHaveLength(1);
  });

  /**
   * One real dispatch, then the job ends the way a launcher run can end (a word, a charge) and the real
   * sync fails the stamp. `ageDays` backdates the stamp so a cooldown can be stepped past.
   */
  async function failedRun(
    env: ReturnType<typeof fx.env>,
    word: string,
    chargedMilli: number,
    ageDays = 0,
  ): Promise<void> {
    const dispatched = await dispatchPipelineJob(env, {
      recipe: "nemar-floor",
      datasetId: "nm000104",
      actor: ADMIN,
    });
    if (!dispatched.ok) throw new Error(`not dispatched: ${JSON.stringify(dispatched)}`);
    await env.DB.prepare(
      "UPDATE compute_jobs SET state = 'failed', failure_code = ?2, charged_milli = ?3 WHERE id = ?1",
    )
      .bind(dispatched.jobId, word, chargedMilli)
      .run();
    await syncPipelineStamps(env);
    await env.DB.prepare(
      "UPDATE compute_pipeline_stamps SET updated_at = datetime('now', ?2) WHERE id = ?1",
    )
      .bind(dispatched.stampId, `-${ageDays} days`)
      .run();
  }

  test("a run that failed AFTER consuming units is not dispatched again the next day", async () => {
    const env = await world(["nm000104"]);
    await failedRun(env, "result_upload_failed", 4000);
    expect(await pipelineCandidates(env, floor, 10)).toHaveLength(0);
    // Past the cooldown it is a candidate again (the cap is 3, one failure so far).
    await env.DB.prepare(
      "UPDATE compute_pipeline_stamps SET updated_at = datetime('now', '-8 days')",
    ).run();
    expect(await pipelineCandidates(env, floor, 10)).toHaveLength(1);
  });

  test("a verification failure and any charged failed job also count; an uncharged platform failure does not", async () => {
    const env = await world(["nm000104"]);
    await failedRun(env, "result_verification_failed", 0);
    expect(await pipelineCandidates(env, floor, 10)).toHaveLength(0);
    await env.DB.prepare("DELETE FROM compute_pipeline_stamps").run();
    await failedRun(env, "launch_failed", 2500);
    expect(await pipelineCandidates(env, floor, 10)).toHaveLength(0);
    await env.DB.prepare("DELETE FROM compute_pipeline_stamps").run();
    // Nothing charged and an early word: an immediate candidate, as before.
    await failedRun(env, "tapis_submit_failed", 0);
    expect(await pipelineCandidates(env, floor, 10)).toHaveLength(1);
    await env.DB.prepare("DELETE FROM compute_pipeline_stamps").run();
    await failedRun(env, "staging_failed", 0);
    expect(await pipelineCandidates(env, floor, 10)).toHaveLength(1);
  });

  test("a pipeline job whose Tapis record is lost fails its stamp `tapis_record_lost`: the tuple is not blocked, and the dataset waits the cooldown (it may have run)", async () => {
    const env = await world(["nm000104"]);
    const dispatched = await dispatchPipelineJob(env, {
      recipe: "nemar-floor",
      datasetId: "nm000104",
      actor: ADMIN,
    });
    if (!dispatched.ok) throw new Error("not dispatched");
    await env.DB.prepare(
      "UPDATE compute_jobs SET tapis_synced_at = datetime('now', '-8 days') WHERE id = ?1",
    )
      .bind(dispatched.jobId)
      .run();
    // The record is gone for good (404).
    fx.tapis.fail("GET /v3/jobs/:uuid", 404, 50);
    await runComputeAdvanceCron(env);
    expect(
      await env.DB.prepare("SELECT state, failure_code FROM compute_jobs WHERE id = ?1")
        .bind(dispatched.jobId)
        .first(),
    ).toEqual({ state: "failed", failure_code: "tapis_record_lost" });
    await syncPipelineStamps(env);
    expect(
      await env.DB.prepare("SELECT state, refusal_code FROM compute_pipeline_stamps").first(),
    ).toEqual({ state: "failed", refusal_code: "tapis_record_lost" });
    // It may have run for real, so it waits out the cooldown rather than being sent again at once.
    expect(await pipelineCandidates(env, floor, 10)).toHaveLength(0);
    await env.DB.prepare(
      "UPDATE compute_pipeline_stamps SET updated_at = datetime('now', '-8 days')",
    ).run();
    expect(await pipelineCandidates(env, floor, 10)).toHaveLength(1);
  });

  test("the third consumed failure stops the dataset for good", async () => {
    const env = await world(["nm000104"]);
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await failedRun(env, "result_upload_failed", 4000, RETRY_COOLDOWN_DAYS + 5 + i);
    }
    // Every stamp is outside the cooldown; only the cap holds.
    expect(await pipelineCandidates(env, floor, 10)).toHaveLength(0);
  });

  test("failures a dataset causes do count: three on three days block it", async () => {
    const env = await world(["nm000104"]);
    for (const [i, code] of ["runtime_error", "time_limit", "out_of_memory"].entries()) {
      await env.DB.prepare(
        `INSERT INTO compute_pipeline_stamps (dataset_id, version, recipe, recipe_version, engine, attempt, state, refusal_code, updated_at)
         VALUES ('nm000104', 'v1.0.0', 'nemar-floor', ?1, ?2, ?3, 'failed', ?4, datetime('now', ?5))`,
      )
        .bind(floor.version, floor.engine, i + 1, code, `-${i + 10} days`)
        .run();
    }
    // Outside the cooldown, but at the cap.
    expect(await pipelineCandidates(env, floor, 10)).toHaveLength(0);
  });

  test("a refused stamp is not a failure: the pool's refusal does not cool a dataset down", async () => {
    const env = await world(["nm000104"]);
    await env.DB.prepare(
      `INSERT INTO compute_pipeline_stamps (dataset_id, version, recipe, recipe_version, engine, attempt, state, refusal_code)
       VALUES ('nm000104', 'v1.0.0', 'nemar-floor', ?1, ?2, 1, 'refused', 'insufficient_balance')`,
    )
      .bind(floor.version, floor.engine)
      .run();
    expect(await pipelineCandidates(env, floor, 10)).toHaveLength(1);
  });

  test("a failure of another tuple (another version or engine) does not cool this one down", async () => {
    const env = await world(["nm000104"]);
    await env.DB.prepare(
      `INSERT INTO compute_pipeline_stamps (dataset_id, version, recipe, recipe_version, engine, attempt, state, refusal_code)
       VALUES ('nm000104', 'v1.0.0', 'nemar-floor', '0.9.0', ?1, 1, 'failed', 'job_failed'),
              ('nm000104', 'v0.9.0', 'nemar-floor', ?2, ?1, 1, 'failed', 'job_failed')`,
    )
      .bind(floor.engine, floor.version)
      .run();
    expect(await pipelineCandidates(env, floor, 10)).toHaveLength(1);
  });
});

describe("the dry run", () => {
  test("lists the next datasets, the estimate per job and in total, and the config a real run needs", async () => {
    const env = await world();
    const dry = await pipelineDryRun(env, { recipe: "nemar-floor", limit: 2 });
    if (!dry.ok) throw new Error("not ok");
    expect(dry.would_dispatch.map((d) => d.dataset_id)).toEqual(["nm000104", "nm000105"]);
    expect(dry.estimate_milli_per_job).toBe(recipeEstimateMilli(floor));
    expect(dry.estimate_milli_total).toBe(2 * recipeEstimateMilli(floor));
    // 16 GB is 8 core-units over 6 hours: 48 SU.
    expect(dry.estimate_milli_per_job).toBe(48_000);
    // S3c: a Tapis dry run also says whether Tapis is configured; the fixture environment configures it.
    expect(dry.config).toEqual({
      compute_enabled: true,
      runtime_image: true,
      pipelines_account: true,
      tapis_configured: true,
    });
  });

  test("writes nothing: no stamp, no job, no hold, no audit row, no request to Tapis", async () => {
    const env = await world();
    const before = await counts(env);
    await pipelineDryRun(env, { recipe: "nemar-floor", limit: 5 });
    await pipelineDryRun(env, { recipe: "nemar-floor", datasetId: "nm000104" });
    await pipelineDryRun(env, { recipe: "nemar-floor", datasetId: "nm000999" });
    expect(await counts(env)).toEqual(before);
  });

  test("works in a non-production environment with compute off, and says what a real run would lack", async () => {
    const env = await world();
    const quiet = fx.env({
      ENVIRONMENT: "development",
      COMPUTE_ENABLED: undefined,
      COMPUTE_RUNTIME_IMAGE: undefined,
    });
    const before = await counts(env);
    const dry = await pipelineDryRun(quiet, { recipe: "nemar-floor", limit: 1 });
    if (!dry.ok) throw new Error("not ok");
    expect(dry.would_dispatch).toHaveLength(1);
    // The quiet environment turns off the compute switch and the image only; it keeps the fixture's Tapis
    // configuration, so Tapis is still configured here.
    expect(dry.config).toEqual({
      compute_enabled: false,
      runtime_image: false,
      pipelines_account: true,
      tapis_configured: true,
    });
    expect(await counts(env)).toEqual(before);
  });

  test("for a named dataset gives the verdict a run would, with the terms that block it", async () => {
    const env = await world(["nm000104"]);
    await seedEegDataset(env, "nm000105", { visibility: "private", modalities: "meg" });
    const ok = await pipelineDryRun(env, { recipe: "nemar-floor", datasetId: "nm000104" });
    expect(ok).toMatchObject({
      ok: true,
      would_dispatch: [{ dataset_id: "nm000104", version: "v1.0.0" }],
      estimate_milli_total: 48_000,
    });
    const blocked = await pipelineDryRun(env, { recipe: "nemar-floor", datasetId: "nm000105" });
    if (!blocked.ok) throw new Error("not ok");
    expect(blocked.would_dispatch).toEqual([]);
    expect(blocked.estimate_milli_total).toBe(0);
    expect(blocked.blocked).toMatchObject({ code: "dataset_not_eligible" });
    expect(blocked.blocked?.blocked_by).toEqual(["public", "eeg"]);
    // The same dataset a real run refuses with the same words.
    expect(
      await dispatchPipelineJob(env, {
        recipe: "nemar-floor",
        datasetId: "nm000105",
        actor: ADMIN,
      }),
    ).toMatchObject({ ok: false, code: "dataset_not_eligible", blockedBy: ["public", "eeg"] });
  });

  test("a named dataset with a live stamp, a missing version and an unknown recipe", async () => {
    const env = await world(["nm000104"]);
    await dispatchPipelineJob(env, { recipe: "nemar-floor", datasetId: "nm000104", actor: ADMIN });
    expect(
      await pipelineDryRun(env, { recipe: "nemar-floor", datasetId: "nm000104" }),
    ).toMatchObject({ ok: true, blocked: { code: "live_attempt_exists" }, would_dispatch: [] });
    expect(
      await pipelineDryRun(env, { recipe: "nemar-floor", datasetId: "nm000104", version: "9.9.9" }),
    ).toMatchObject({ ok: true, blocked: { code: "version_not_found" } });
    expect(await pipelineDryRun(env, { recipe: "nemar-nope" })).toEqual({
      ok: false,
      code: "recipe_unknown",
    });
  });

  test("for the queue counts what blocks each term over the catalog", async () => {
    const env = await world(["nm000104"]);
    await seedEegDataset(env, "nm000105", { visibility: "private" });
    await seedEegDataset(env, "nm000106", { modalities: "meg" });
    await seedEegDataset(env, "nm000107", { modalities: "ieeg", visibility: "private" });
    const dry = await pipelineDryRun(env, { recipe: "nemar-floor", limit: 10 });
    if (!dry.ok) throw new Error("not ok");
    expect(dry.blocked_by_term).toMatchObject({ public: 2, eeg: 2, active: 0, not_anonymous: 0 });
  });
});

describe("a run over the queue", () => {
  test("--limit 2 dispatches two of three, in order, and the third stays a candidate", async () => {
    const env = await world();
    const run = await dispatchEligible(env, { recipe: "nemar-floor", limit: 2, actor: ADMIN });
    expect(run.dispatched).toBe(2);
    expect(run.stoppedBy).toBeNull();
    expect(run.results.map((r) => (r.ok ? r.datasetId : r.code))).toEqual(["nm000104", "nm000105"]);
    expect((await pipelineCandidates(env, floor, 10)).map((c) => c.dataset_id)).toEqual([
      "nm000106",
    ]);
    // Run it again: the third, and nothing more.
    const again = await dispatchEligible(env, { recipe: "nemar-floor", limit: 2, actor: ADMIN });
    expect(again.dispatched).toBe(1);
  });

  test("a hold the pool refused stops the run, with one refused stamp and no more attempts", async () => {
    const env = fx.env();
    await seedPipelinesAccount(env);
    for (const id of ["nm000104", "nm000105", "nm000106"]) await seedEegDataset(env, id);
    // Unfunded: the first hold is refused and the run does not go on to ask for the next two.
    const run = await dispatchEligible(env, { recipe: "nemar-floor", limit: 3, actor: ADMIN });
    expect(run.dispatched).toBe(0);
    expect(run.stoppedBy).toBe("insufficient_balance");
    expect(run.results).toHaveLength(1);
    expect((await counts(env)).stamps).toBe(1);
  });

  test("a refusal about one dataset does not stop the run", async () => {
    const env = await world(["nm000104", "nm000105"]);
    // A race: the first candidate is made private between the queue being read and the dispatch.
    let done = false;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop !== "prepare") {
          const value = Reflect.get(target, prop) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (done || !sql.includes("AS newest_version")) return statement;
          return {
            bind: (...binds: unknown[]) => {
              const bound = statement.bind(...binds);
              return {
                all: async () => {
                  const rows = await bound.all();
                  done = true;
                  await target
                    .prepare(
                      "UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000104'",
                    )
                    .run();
                  return rows;
                },
              };
            },
          };
        };
      },
    }) as D1Database;
    const run = await dispatchEligible(
      { ...env, DB: db },
      { recipe: "nemar-floor", limit: 2, actor: ADMIN },
    );
    expect(run.stoppedBy).toBeNull();
    expect(run.dispatched).toBe(1);
    expect(run.results.map((r) => (r.ok ? r.datasetId : r.code))).toEqual([
      "dataset_not_eligible",
      "nm000105",
    ]);
  });

  test("a version over the manifest bound is never a candidate, so it cannot hold a place in the queue", async () => {
    const env = fx.env();
    await seedEegDataset(env, "nm000104", {
      versions: [["1.0.0", "2026-01-01 00:00:00", 38_001]],
    });
    await seedEegDataset(env, "nm000105");
    expect((await pipelineCandidates(env, floor, 1)).map((c) => c.dataset_id)).toEqual([
      "nm000105",
    ]);
  });

  test("an unknown recipe stops at once", async () => {
    const env = await world();
    const run = await dispatchEligible(env, { recipe: "nemar-nope", limit: 2, actor: ADMIN });
    expect(run).toMatchObject({ dispatched: 0, stoppedBy: "recipe_unknown" });
    expect((await counts(env)).stamps).toBe(0);
  });

  test("the stamps are synced first: a finished job's dataset is current and is not run again", async () => {
    const env = await world(["nm000104"]);
    const first = await dispatchEligible(env, { recipe: "nemar-floor", limit: 1, actor: ADMIN });
    const done = first.results[0];
    if (!done?.ok) throw new Error("not dispatched");
    await finishAtTapis(fx, env, done.jobId, { outputs: floorOutputs() });
    const again = await dispatchEligible(env, { recipe: "nemar-floor", limit: 1, actor: ADMIN });
    expect(again.dispatched).toBe(0);
    expect(
      (await env.DB.prepare("SELECT state FROM compute_pipeline_stamps").first<{ state: string }>())
        ?.state,
    ).toBe("succeeded");
  });
});
