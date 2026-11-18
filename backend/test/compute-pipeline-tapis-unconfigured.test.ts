/**
 * A Tapis pipeline run fails closed while Tapis is unconfigured (portable compute card S3c; ADR 0118
 * decision 10; S3a's inventory, G1, G2 and G4).
 *
 * The defect: with compute on, a funded `pipelines` pool and no Tapis credential, a run whose executor is
 * `tapis` claimed a stamp, took a hold and made a job that no submit could ever send, because the submitter
 * answers `unconfigured` before it looks at how long the job has waited. Only an administrator's cancel
 * released the hold. The fix refuses the run, `tapis_unconfigured` (503), before the first write.
 *
 * Every case runs over the REAL admin router (its real authentication and middleware), real migrated SQLite,
 * Miniflare's R2 and the Tapis stand-in; nothing of NEMAR's is replaced. Every refusal case takes the same
 * snapshot before and after (the row counts of the ledger, the jobs and the stamps; the pipeline run audit
 * rows; every pool's totals; the records bucket's listing; and the number of requests the Tapis stand-in saw)
 * and says "nothing changed" only when all of it is equal.
 *
 *  (a) P1: one dataset through the route, the pool funded and Tapis unset: 503, nothing changed;
 *  (b) P2: the queue (`eligible`) through the route: 503, nothing changed;
 *  (c) the service for a caller that is not the route: `dispatchPipelineJob` and `dispatchEligible`;
 *  (d) G4: the daily dispatcher ends its run with the word;
 *  (e) the order of the refusals and the dry run's `tapis_configured`;
 *  (f) the predicate, case by case;
 *  (g) with Tapis configured the same funded run is 201 and is submitted.
 *
 * Mutations (each proved by hand against the line it guards; the list is in the pull request).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  COMPUTE_PIPELINE_REFUSAL_STATUS,
  ComputePipelineRunResponseSchema,
} from "../../shared/contract/compute-admin";
import { tapisSubmitConfigured } from "../src/services/compute-lifecycle";
import {
  type PipelineActor,
  dispatchEligible,
  dispatchPipelineJob,
} from "../src/services/compute-pipeline";
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

/** The credential of every strategy, unset: Tapis cannot be used, whichever strategy is chosen. */
const NO_TAPIS = {
  TAPIS_USERNAME: undefined,
  TAPIS_PASSWORD: undefined,
  TAPIS_SERVICE_TOKEN: undefined,
} satisfies Partial<Bindings>;

const SENTENCE =
  "Tapis is not configured on this Worker, so a Tapis job cannot be submitted; nothing was written.";

/** Two datasets that are not the live ones (`nm000103` to `nm000107`). */
const FIRST = "nm000201";
const SECOND = "nm000202";

interface Reply {
  status: number;
  body: Record<string, any>;
}

async function run(body: unknown, env: Bindings, who: ComputeWho = "admin"): Promise<Reply> {
  const res = await handle(
    new Request("http://api.test/admin/compute/pipeline/run", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${COMPUTE_KEYS[who]}`,
        "Content-Type": "application/json",
      },
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

/** A funded `pipelines` pool, the service account and the named public datasets, on a given environment. */
async function world(env: Bindings, datasets: string[] = [FIRST]): Promise<void> {
  await seedPipelinesAccount(env);
  await fundPipelines(env);
  for (const id of datasets) await seedEegDataset(env, id);
}

const count = async (env: Bindings, sql: string): Promise<number> =>
  (await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0;

/** Every key of the records bucket, paged. */
async function recordKeys(): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await fx.harness.records.list({ cursor, limit: 1000 });
    for (const object of page.objects) keys.push(object.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return keys.sort();
}

interface PoolRow {
  id: number;
  holder_kind: string;
  holder_ref: string;
  pool: string;
  granted_milli: number;
  held_milli: number;
  charged_milli: number;
  frozen: number;
}

/** What a refusal must leave exactly as it found it. */
async function snapshot(env: Bindings) {
  return {
    ledger: await count(env, "SELECT COUNT(*) AS n FROM compute_ledger"),
    jobs: await count(env, "SELECT COUNT(*) AS n FROM compute_jobs"),
    stamps: await count(env, "SELECT COUNT(*) AS n FROM compute_pipeline_stamps"),
    audits: await count(
      env,
      "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'compute.pipeline.run'",
    ),
    pools: (
      await env.DB.prepare(
        `SELECT id, holder_kind, holder_ref, pool, granted_milli, held_milli, charged_milli, frozen
           FROM compute_pools ORDER BY id`,
      ).all<PoolRow>()
    ).results,
    records: await recordKeys(),
    tapisRequests: fx.tapis.log.length,
  };
}

describe("(a) P1: one dataset, the pool funded, Tapis unset", () => {
  test("is 503 tapis_unconfigured with the declared sentence, and nothing changed (MUTATION: delete the route check; return true from the predicate)", async () => {
    const env = fx.env(NO_TAPIS);
    await world(env);
    const before = await snapshot(env);
    // The funded pool is what made the defect: a hold could be taken.
    expect(before.pools.some((p) => p.holder_ref === "pipelines" && p.granted_milli > 0)).toBe(
      true,
    );

    const res = await run({ recipe: "nemar-floor", dataset: FIRST }, env);

    expect([res.status, res.body.code]).toEqual([503, "tapis_unconfigured"]);
    // Nothing changed, an audit row included: the route's own refusal is not audited.
    expect(await snapshot(env)).toEqual(before);
    expect(res.body).toEqual({ error: SENTENCE, code: "tapis_unconfigured" });
  });

  test("an owner is refused the same way (the route is admin and owner)", async () => {
    const env = fx.env(NO_TAPIS);
    await world(env);
    const before = await snapshot(env);
    const res = await run({ recipe: "nemar-floor", dataset: FIRST }, env, "owner");
    expect([res.status, res.body.code]).toEqual([503, "tapis_unconfigured"]);
    expect(await snapshot(env)).toEqual(before);
  });

  test("the word's status is the contract's (503), declared once", () => {
    expect(COMPUTE_PIPELINE_REFUSAL_STATUS.tapis_unconfigured).toBe(503);
  });

  test("a retry after the fix is refused again and still writes nothing (no stamp blocks the tuple)", async () => {
    const env = fx.env(NO_TAPIS);
    await world(env);
    const before = await snapshot(env);
    for (let i = 0; i < 2; i++) {
      const res = await run({ recipe: "nemar-floor", dataset: FIRST }, env);
      expect([res.status, res.body.code]).toEqual([503, "tapis_unconfigured"]);
    }
    expect(await snapshot(env)).toEqual(before);
  });
});

describe("(b) P2: the queue, the pool funded, Tapis unset", () => {
  test("is 503 tapis_unconfigured, and nothing changed (MUTATION: delete the route check)", async () => {
    const env = fx.env(NO_TAPIS);
    await world(env, [FIRST, SECOND]);
    const before = await snapshot(env);

    const res = await run({ recipe: "nemar-floor", eligible: true, limit: 2 }, env);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: SENTENCE, code: "tapis_unconfigured" });
    expect(await snapshot(env)).toEqual(before);
  });
});

describe("(c) the service, for a caller that is not the route", () => {
  const cron = { kind: "cron" } as const;

  test("dispatchPipelineJob answers tapis_unconfigured and writes nothing (MUTATION: delete the service check)", async () => {
    const env = fx.env(NO_TAPIS);
    await world(env, [FIRST, SECOND]);
    const before = await snapshot(env);

    const byCron = await dispatchPipelineJob(env, {
      recipe: "nemar-floor",
      datasetId: FIRST,
      actor: cron,
    });
    expect(byCron).toMatchObject({ ok: false, code: "tapis_unconfigured", datasetId: FIRST });

    const byAdmin = await dispatchPipelineJob(env, {
      recipe: "nemar-floor",
      datasetId: SECOND,
      actor: { kind: "admin", userId: 1 },
    });
    expect(byAdmin).toMatchObject({ ok: false, code: "tapis_unconfigured", datasetId: SECOND });

    expect(await snapshot(env)).toEqual(before);
  });

  test("dispatchEligible stops at the first candidate: one result, stoppedBy the word (MUTATION: drop it from STOPS_A_RUN)", async () => {
    const env = fx.env(NO_TAPIS);
    await world(env, [FIRST, SECOND]);
    const before = await snapshot(env);

    const result = await dispatchEligible(env, { recipe: "nemar-floor", limit: 2, actor: cron });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ ok: false, code: "tapis_unconfigured" });
    expect(result.dispatched).toBe(0);
    expect(result.stoppedBy).toBe("tapis_unconfigured");
    expect(await snapshot(env)).toEqual(before);
  });
});

describe("(d) G4: the daily dispatcher", () => {
  test("with both switches on and Tapis unset ends its run with tapis_unconfigured, and nothing changed (MUTATION: delete the service check)", async () => {
    const env = fx.env({ ...NO_TAPIS, COMPUTE_PIPELINES_DISPATCH_ENABLED: "1" });
    await world(env, [FIRST, SECOND]);
    const before = await snapshot(env);

    const result = await runComputePipelineDispatchCron(env);

    expect(result).toMatchObject({ outcome: "ran", dispatched: 0, errors: [] });
    expect(result?.recipes).toEqual([
      { recipe: "nemar-floor", dispatched: 0, skipped: null, stopped_by: "tapis_unconfigured" },
    ]);
    expect(await snapshot(env)).toEqual(before);
  });

  test("a second tick does the same: no job is made, so none waits forever", async () => {
    const env = fx.env({ ...NO_TAPIS, COMPUTE_PIPELINES_DISPATCH_ENABLED: "1" });
    await world(env, [FIRST]);
    const before = await snapshot(env);
    for (let i = 0; i < 2; i++) {
      const result = await runComputePipelineDispatchCron(env);
      expect(result?.recipes[0]?.stopped_by).toBe("tapis_unconfigured");
    }
    expect(await snapshot(env)).toEqual(before);
  });
});

describe("(e) the order of the refusals and the dry run", () => {
  test("compute off with Tapis unset is still compute_disabled (503), and nothing changed", async () => {
    const env = fx.env({ ...NO_TAPIS, COMPUTE_ENABLED: undefined });
    await world(env);
    const before = await snapshot(env);
    for (const body of [
      { recipe: "nemar-floor", dataset: FIRST },
      { recipe: "nemar-floor", eligible: true },
    ]) {
      const res = await run(body, env);
      expect([res.status, res.body.code]).toEqual([503, "compute_disabled"]);
    }
    expect(await snapshot(env)).toEqual(before);
  });

  test("the service keeps its own order: every refusal before the new one keeps its word", async () => {
    const env = fx.env(NO_TAPIS);
    await world(env);
    const admin = { kind: "admin", userId: 1 } as const;
    const cron = { kind: "cron" } as const;
    const asked = (
      on: Bindings,
      recipe: string,
      actor: PipelineActor,
      executor?: "tapis" | "runner",
      input?: "bids" | "zarr",
    ) => dispatchPipelineJob(on, { recipe, datasetId: FIRST, actor, executor, input });
    const off = fx.env({ ...NO_TAPIS, COMPUTE_ENABLED: undefined });

    expect(await asked(off, "nemar-floor", admin)).toMatchObject({ code: "compute_disabled" });
    expect(await asked(env, "nemar-nope", admin)).toMatchObject({ code: "recipe_unknown" });
    // The cron is the Tapis queue's: a runner run is an administrator's.
    expect(await asked(env, "nemar-floor", cron, "runner")).toMatchObject({
      code: "recipe_not_automatic",
    });
    expect(await asked(env, "nemar-ica", admin)).toMatchObject({ code: "recipe_placeholder" });
    // The input the executor does not run, then the runners switch: a runner run never reaches the Tapis check.
    expect(await asked(env, "nemar-floor", admin, "runner", "bids")).toMatchObject({
      code: "invalid_spec",
      field: "input",
    });
    expect(await asked(env, "nemar-floor", admin, "tapis", "zarr")).toMatchObject({
      code: "invalid_spec",
      field: "input",
    });
    expect(await asked(env, "nemar-floor", admin, "runner")).toMatchObject({
      code: "runners_disabled",
    });
    // And the Tapis executor, the default, is the one that is refused for Tapis.
    expect(await asked(env, "nemar-floor", admin)).toMatchObject({ code: "tapis_unconfigured" });
    expect(await asked(env, "nemar-floor", admin, "tapis")).toMatchObject({
      code: "tapis_unconfigured",
    });
  });

  test("a dry run with Tapis unset is 200, says tapis_configured: false, and writes nothing", async () => {
    const env = fx.env(NO_TAPIS);
    await world(env, [FIRST, SECOND]);
    const before = await snapshot(env);
    for (const body of [
      { recipe: "nemar-floor", dataset: FIRST, dry_run: true },
      { recipe: "nemar-floor", eligible: true, limit: 2, dry_run: true },
    ]) {
      const res = await run(body, env);
      expect(res.status).toBe(200);
      expect(ComputePipelineRunResponseSchema.safeParse(res.body).success).toBe(true);
      expect(res.body.config).toEqual({
        compute_enabled: true,
        runtime_image: true,
        pipelines_account: true,
        tapis_configured: false,
      });
    }
    expect(await snapshot(env)).toEqual(before);
  });

  test("a dry run with Tapis configured says tapis_configured: true", async () => {
    const env = fx.env();
    await world(env, [FIRST]);
    const res = await run({ recipe: "nemar-floor", dataset: FIRST, dry_run: true }, env);
    expect(res.status).toBe(200);
    expect(ComputePipelineRunResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.config).toEqual({
      compute_enabled: true,
      runtime_image: true,
      pipelines_account: true,
      tapis_configured: true,
    });
  });

  test("a runner dry run has no tapis_configured key, with Tapis unset or configured", async () => {
    for (const over of [NO_TAPIS, {}]) {
      const env = fx.env({ ...over, COMPUTE_RUNNERS_ENABLED: "1" });
      await seedPipelinesAccount(env, { reuse: true });
      if (
        (await count(env, `SELECT COUNT(*) AS n FROM datasets WHERE dataset_id = '${FIRST}'`)) === 0
      ) {
        await seedEegDataset(env, FIRST);
      }
      const res = await run(
        { recipe: "nemar-floor", dataset: FIRST, executor: "runner", dry_run: true },
        env,
      );
      expect(res.status).toBe(200);
      expect(res.body.executor).toBe("runner");
      expect(Object.keys(res.body.config).sort()).toEqual([
        "compute_enabled",
        "pipelines_account",
        "runners_enabled",
        "runtime_image",
      ]);
    }
  });
});

describe("(f) the predicate", () => {
  const cases: Array<[string, Partial<Bindings>, boolean]> = [
    ["the configuration of every other suite", {}, true],
    ["the password strategy without TAPIS_USERNAME", { TAPIS_USERNAME: undefined }, false],
    ["the password strategy without TAPIS_PASSWORD", { TAPIS_PASSWORD: undefined }, false],
    ["no credential at all", NO_TAPIS, false],
    ["no strategy", { TAPIS_AUTH_STRATEGY: undefined }, false],
    ["a strategy it does not know", { TAPIS_AUTH_STRATEGY: "oauth" }, false],
    ["no tenant", { TAPIS_TENANT_ID: undefined }, false],
    [
      "the service strategy without TAPIS_SERVICE_TOKEN",
      { TAPIS_AUTH_STRATEGY: "service", TAPIS_SERVICE_TOKEN: undefined },
      false,
    ],
    [
      "the service strategy with a token and an owner",
      { TAPIS_AUTH_STRATEGY: "service", TAPIS_SERVICE_TOKEN: "a-service-token" },
      true,
    ],
    [
      "the service strategy with a token and no owner to mint for",
      {
        TAPIS_AUTH_STRATEGY: "service",
        TAPIS_SERVICE_TOKEN: "a-service-token",
        TAPIS_USERNAME: undefined,
      },
      false,
    ],
    ["an owner TAPIS_OWNER_RE refuses (a space)", { TAPIS_USERNAME: "not an owner" }, false],
    ["an owner TAPIS_OWNER_RE refuses (a leading dash)", { TAPIS_USERNAME: "-owner" }, false],
  ];
  for (const [name, over, expected] of cases) {
    test(`${name}: ${expected}`, () => {
      expect(tapisSubmitConfigured(fx.env(over))).toBe(expected);
    });
  }

  test("it reads configuration and makes no request (MUTATION: return true)", () => {
    const before = fx.tapis.log.length;
    expect(tapisSubmitConfigured(fx.env())).toBe(true);
    expect(tapisSubmitConfigured(fx.env(NO_TAPIS))).toBe(false);
    expect(fx.tapis.log.length).toBe(before);
  });
});

describe("(g) with Tapis configured nothing changes", () => {
  test("the same funded run is 201 and the job is submitted to the stand-in", async () => {
    const env = fx.env();
    await world(env);
    const before = await snapshot(env);

    const res = await run({ recipe: "nemar-floor", dataset: FIRST }, env);

    expect(res.status).toBe(201);
    expect(ComputePipelineRunResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body).toMatchObject({
      ok: true,
      dry_run: false,
      dispatched: 1,
      stopped_by: null,
      results: [{ dataset_id: FIRST, ok: true, submit: "submitted" }],
    });
    const after = await snapshot(env);
    expect(after.jobs).toBe(before.jobs + 1);
    expect(after.stamps).toBe(before.stamps + 1);
    expect(after.audits).toBe(before.audits + 1);
    expect(after.ledger).toBeGreaterThan(before.ledger);
    expect(after.tapisRequests).toBeGreaterThan(before.tapisRequests);
  });

  test("the queue with Tapis configured dispatches as it did", async () => {
    const env = fx.env();
    await world(env, [FIRST, SECOND]);
    const res = await run({ recipe: "nemar-floor", eligible: true, limit: 2 }, env);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ dispatched: 2, stopped_by: null });
  });
});
