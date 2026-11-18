/**
 * An administrator's pipeline commands, `POST /admin/compute/pipeline/run` and `GET .../status` (epic
 * #2005 phase A6, #2011; ADR 0118), through the REAL admin router with its real authentication, admin
 * and cookie-origin middleware, over real migrated SQLite with real API keys, Miniflare's R2 and the
 * Tapis stand-in (no response of which was recorded from a real tenant).
 *
 * What is pinned: a member and a stranger are refused; the body is strict (a key the Worker supplies
 * itself is refused, not dropped); a dry run answers in a non-production environment with compute off
 * and WRITES NOTHING; a live run refuses `compute_disabled` unless compute is on; one dataset is
 * dispatched (201) or refused with its word and status; `eligible` with a `limit` dispatches that many
 * and stops at a pool that refuses; a live run is audited with counts and fixed words; the status
 * route syncs the stamps before it reads and pages newest first; and no answer carries an identity, a
 * path, a token or a specification.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  ComputePipelineRunResponseSchema,
  ComputePipelineStatusResponseSchema,
} from "../../shared/contract/compute-admin";
import type { Bindings } from "../src/types/bindings";
import {
  COMPUTE_KEYS,
  type ComputeWho,
  makeComputeApp,
  seedComputeUsers,
} from "./helpers/compute-app";
import { type LifecycleFixture, startLifecycleFixture } from "./helpers/compute-lifecycle-fixture";
import {
  finishAtTapis,
  floorOutputs,
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

interface Reply {
  status: number;
  text: string;
  body: Record<string, any>;
}

async function call(
  method: "GET" | "POST",
  path: string,
  who: ComputeWho | null,
  body?: unknown,
  env: Bindings = fx.env(),
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (who) headers.Authorization = `Bearer ${COMPUTE_KEYS[who]}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await handle(
    new Request(`http://api.test/admin${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
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
  return { status: res.status, text, body: parsed };
}

const run = (who: ComputeWho | null, body: unknown, env?: Bindings) =>
  call("POST", "/compute/pipeline/run", who, body, env);
const status = (who: ComputeWho | null, query = "", env?: Bindings) =>
  call("GET", `/compute/pipeline/status${query}`, who, undefined, env);

async function world(ids = ["nm000104", "nm000105", "nm000106"]) {
  const env = fx.env();
  await seedPipelinesAccount(env);
  await fundPipelines(env);
  for (const id of ids) await seedEegDataset(env, id);
  return env;
}

const n = async (env: Bindings, table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;

const audits = async (env: Bindings) =>
  (
    await env.DB.prepare(
      "SELECT user_id, resource_type, resource_id, details FROM audit_log WHERE action = 'compute.pipeline.run'",
    ).all<{ user_id: number; resource_type: string; resource_id: string; details: string }>()
  ).results;

describe("who may", () => {
  test("an administrator and an owner may, a member and a stranger may not", async () => {
    const env = await world(["nm000104"]);
    const body = { recipe: "nemar-floor", dataset: "nm000104", dry_run: true };
    expect((await run("member", body, env)).status).toBe(403);
    expect((await run(null, body, env)).status).toBe(401);
    expect((await run("admin", body, env)).status).toBe(200);
    expect((await run("owner", body, env)).status).toBe(200);
    expect((await status("member", "", env)).status).toBe(403);
    expect((await status(null, "", env)).status).toBe(401);
    expect((await status("admin", "", env)).status).toBe(200);
  });
});

describe("the body is strict", () => {
  const bad: Array<[string, unknown]> = [
    [
      "a key the Worker supplies itself",
      { recipe: "nemar-floor", dataset: "nm000104", anonymous: false },
    ],
    ["a key for the pool", { recipe: "nemar-floor", dataset: "nm000104", pool: "gpu" }],
    ["a key for the account", { recipe: "nemar-floor", eligible: true, account_id: 4 }],
    ["neither a dataset nor eligible", { recipe: "nemar-floor" }],
    ["both a dataset and eligible", { recipe: "nemar-floor", dataset: "nm000104", eligible: true }],
    ["eligible false and no dataset", { recipe: "nemar-floor", eligible: false }],
    ["a version without a dataset", { recipe: "nemar-floor", eligible: true, version: "1.0.0" }],
    ["a limit with a dataset", { recipe: "nemar-floor", dataset: "nm000104", limit: 2 }],
    ["a limit of 0", { recipe: "nemar-floor", eligible: true, limit: 0 }],
    ["a limit over the maximum", { recipe: "nemar-floor", eligible: true, limit: 101 }],
    ["a fractional limit", { recipe: "nemar-floor", eligible: true, limit: 1.5 }],
    ["a malformed dataset id", { recipe: "nemar-floor", dataset: "../etc" }],
    ["a malformed version", { recipe: "nemar-floor", dataset: "nm000104", version: "1 0" }],
    ["a malformed recipe", { recipe: "Nemar Floor", dataset: "nm000104" }],
    ["no recipe", { dataset: "nm000104" }],
    ["a body that is not JSON", "nope{"],
    ["an empty body", ""],
    [
      "a dry_run that is not a boolean",
      { recipe: "nemar-floor", dataset: "nm000104", dry_run: "yes" },
    ],
  ];
  for (const [name, body] of bad) {
    test(`${name} is invalid_body, and nothing is written`, async () => {
      const env = await world(["nm000104"]);
      const before = [await n(env, "compute_pipeline_stamps"), await n(env, "audit_log")];
      const res = await run("admin", body, env);
      expect([name, res.status, res.body.code]).toEqual([name, 400, "invalid_body"]);
      expect(res.text).not.toContain("etc");
      expect([await n(env, "compute_pipeline_stamps"), await n(env, "audit_log")]).toEqual(before);
    });
  }
});

describe("a dry run", () => {
  test("answers in a non-production environment with compute off, and writes nothing", async () => {
    const env = await world();
    const quiet = fx.env({
      ENVIRONMENT: "development",
      COMPUTE_ENABLED: undefined,
      COMPUTE_RUNTIME_IMAGE: undefined,
    });
    const before = {
      stamps: await n(env, "compute_pipeline_stamps"),
      jobs: await n(env, "compute_jobs"),
      ledger: await n(env, "compute_ledger"),
      audit: await n(env, "audit_log"),
      tapis: fx.tapis.log.length,
    };
    const eligible = await run(
      "admin",
      { recipe: "nemar-floor", eligible: true, limit: 2, dry_run: true },
      quiet,
    );
    expect(eligible.status).toBe(200);
    expect(ComputePipelineRunResponseSchema.safeParse(eligible.body).success).toBe(true);
    expect(eligible.body).toMatchObject({
      ok: true,
      dry_run: true,
      recipe: "nemar-floor",
      estimate_milli_per_job: 48000,
      estimate_milli_total: 96000,
      config: { compute_enabled: false, runtime_image: false, pipelines_account: true },
    });
    expect(eligible.body.would_dispatch.map((d: any) => d.dataset_id)).toEqual([
      "nm000104",
      "nm000105",
    ]);
    const one = await run(
      "admin",
      { recipe: "nemar-floor", dataset: "nm000104", dry_run: true },
      quiet,
    );
    expect(one.body.would_dispatch).toEqual([{ dataset_id: "nm000104", version: "v1.0.0" }]);
    const none = await run(
      "admin",
      { recipe: "nemar-floor", dataset: "nm000999", dry_run: true },
      quiet,
    );
    expect(none.status).toBe(200);
    expect(none.body.blocked).toMatchObject({ code: "dataset_not_eligible" });
    expect({
      stamps: await n(env, "compute_pipeline_stamps"),
      jobs: await n(env, "compute_jobs"),
      ledger: await n(env, "compute_ledger"),
      audit: await n(env, "audit_log"),
      tapis: fx.tapis.log.length,
    }).toEqual(before);
  });

  test("a placeholder recipe is recipe_placeholder (422) on a live run of one dataset or the queue", async () => {
    const env = await world(["nm000104"]);
    for (const body of [
      { recipe: "nemar-ica", dataset: "nm000104" },
      { recipe: "nemar-ica", eligible: true },
    ]) {
      const res = await run("admin", body, env);
      expect([res.status, res.body.code ?? res.body.stopped_by]).toEqual([
        422,
        "recipe_placeholder",
      ]);
    }
    expect(await n(env, "compute_pipeline_stamps")).toBe(0);
  });

  test("an unknown recipe is recipe_unknown, with or without dry_run", async () => {
    const env = await world(["nm000104"]);
    for (const dry_run of [true, false]) {
      const res = await run("admin", { recipe: "nemar-nope", dataset: "nm000104", dry_run }, env);
      expect([res.status, res.body.code]).toEqual([422, "recipe_unknown"]);
    }
  });
});

describe("a live run", () => {
  test("refuses compute_disabled unless compute is on, and writes nothing", async () => {
    const env = await world(["nm000104"]);
    const off = fx.env({ COMPUTE_ENABLED: undefined });
    for (const body of [
      { recipe: "nemar-floor", dataset: "nm000104" },
      { recipe: "nemar-floor", eligible: true },
    ]) {
      const res = await run("admin", body, off);
      expect([res.status, res.body.code]).toEqual([503, "compute_disabled"]);
    }
    expect(await n(env, "compute_pipeline_stamps")).toBe(0);
    expect(await n(env, "audit_log")).toBe(0);
  });

  test("one dataset: 201 with the job and the stamp, audited with counts and fixed words", async () => {
    const env = await world(["nm000104"]);
    const res = await run("admin", { recipe: "nemar-floor", dataset: "nm000104" }, env);
    expect(res.status).toBe(201);
    expect(ComputePipelineRunResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body).toMatchObject({
      ok: true,
      dry_run: false,
      dispatched: 1,
      stopped_by: null,
      results: [
        { dataset_id: "nm000104", ok: true, version: "v1.0.0", attempt: 1, submit: "submitted" },
      ],
    });
    expect(res.body.results[0].job_id).toMatch(/^job_[0-9a-f]{24}$/);
    const stamps = (await status("admin", "", env)).body.stamps;
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toMatchObject({
      dataset_id: "nm000104",
      state: "dispatched",
      job_id: res.body.results[0].job_id,
    });

    const rows = await audits(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      resource_type: "compute_pipeline",
      resource_id: "nemar-floor",
    });
    expect(JSON.parse(rows[0]?.details as string)).toEqual({
      mode: "dataset",
      executor: "tapis",
      dispatched: 1,
      refused: 0,
      stopped_by: null,
    });
  });

  test("one dataset, refused: its word and status, and a refusal is audited too", async () => {
    const env = await world(["nm000104"]);
    await seedEegDataset(env, "nm000105", { visibility: "private" });
    expect((await run("admin", { recipe: "nemar-floor", dataset: "nm000104" }, env)).status).toBe(
      201,
    );
    const again = await run("admin", { recipe: "nemar-floor", dataset: "nm000104" }, env);
    expect([again.status, again.body.code]).toEqual([409, "live_attempt_exists"]);
    const hidden = await run("admin", { recipe: "nemar-floor", dataset: "nm000105" }, env);
    expect([hidden.status, hidden.body.code]).toEqual([422, "dataset_not_eligible"]);
    expect(hidden.body.blocked_by).toEqual(["public"]);
    const missing = await run(
      "admin",
      { recipe: "nemar-floor", dataset: "nm000104", version: "9.9.9" },
      env,
    );
    expect([missing.status, missing.body.code]).toEqual([404, "version_not_found"]);
    const details = (await audits(env)).map((a) => JSON.parse(a.details));
    expect(details.map((d) => [d.dispatched, d.refused, d.stopped_by])).toEqual([
      [1, 0, null],
      [0, 1, "live_attempt_exists"],
      [0, 1, "dataset_not_eligible"],
      [0, 1, "version_not_found"],
    ]);
  });

  test("a version named is the version run", async () => {
    const env = fx.env();
    await seedPipelinesAccount(env);
    await fundPipelines(env);
    await seedEegDataset(env, "nm000104", {
      versions: [
        ["1.0.0", "2026-01-01 00:00:00"],
        ["1.1.0", "2026-02-01 00:00:00"],
      ],
    });
    const res = await run(
      "admin",
      { recipe: "nemar-floor", dataset: "nm000104", version: "1.0.0" },
      env,
    );
    expect(res.body.results[0]).toMatchObject({ ok: true, version: "v1.0.0" });
  });

  test("eligible with a limit of 2 dispatches two of three, and an owner may as well", async () => {
    const env = await world();
    const res = await run("owner", { recipe: "nemar-floor", eligible: true, limit: 2 }, env);
    expect(res.status).toBe(201);
    expect(res.body.dispatched).toBe(2);
    expect(res.body.results.map((r: any) => r.dataset_id)).toEqual(["nm000104", "nm000105"]);
    expect(res.body.stopped_by).toBeNull();
    const details = JSON.parse((await audits(env))[0]?.details as string);
    expect(details).toEqual({
      mode: "eligible",
      executor: "tapis",
      dispatched: 2,
      refused: 0,
      stopped_by: null,
    });
    expect(await n(env, "compute_pipeline_stamps")).toBe(2);
  });

  test("eligible with a pool that refuses answers 200 with the word that stopped it", async () => {
    const env = fx.env();
    await seedPipelinesAccount(env);
    for (const id of ["nm000104", "nm000105"]) await seedEegDataset(env, id);
    const res = await run("admin", { recipe: "nemar-floor", eligible: true, limit: 5 }, env);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dispatched: 0, stopped_by: "insufficient_balance" });
    expect(res.body.results).toHaveLength(1);
  });

  test("an answer carries no identity, path, token or specification", async () => {
    const env = await world(["nm000104"]);
    const res = await run("admin", { recipe: "nemar-floor", dataset: "nm000104" }, env);
    const st = await status("admin", "", env);
    for (const text of [res.text, st.text]) {
      expect(text).not.toMatch(
        /@example\.org|nemar-pipelines|job_token|NEMAR_LAUNCH_SPEC|\/data\/|ghcr\.io|sha256:/,
      );
    }
  });
});

describe("an audit write that fails after the dispatch", () => {
  /** The environment with a database that refuses the audit row and nothing else. */
  function auditBroken(env: Bindings): Bindings {
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("INSERT INTO audit_log"))
              throw new Error("injected: audit unavailable");
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { ...env, DB: db };
  }

  test("one dataset: the job id comes back with audit_pending, not a 500", async () => {
    const env = await world(["nm000104"]);
    const res = await run(
      "admin",
      { recipe: "nemar-floor", dataset: "nm000104" },
      auditBroken(env),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, audit_pending: true, dispatched: 1 });
    expect(res.body.results[0].job_id).toMatch(/^job_[0-9a-f]{24}$/);
    expect(await n(env, "compute_jobs")).toBe(1);
    expect(await n(env, "audit_log")).toBe(0);
  });

  test("eligible: the same, and a clean audit carries no audit_pending", async () => {
    const env = await world(["nm000104", "nm000105"]);
    const res = await run(
      "admin",
      { recipe: "nemar-floor", eligible: true, limit: 1 },
      auditBroken(env),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ audit_pending: true, dispatched: 1 });
    const clean = await run("admin", { recipe: "nemar-floor", eligible: true, limit: 1 }, env);
    expect(clean.body.audit_pending).toBeUndefined();
  });

  test("a refusal is still answered with its word when its audit write fails", async () => {
    const env = await world(["nm000104"]);
    await run("admin", { recipe: "nemar-floor", dataset: "nm000104" }, env);
    const again = await run(
      "admin",
      { recipe: "nemar-floor", dataset: "nm000104" },
      auditBroken(env),
    );
    expect([again.status, again.body.code, again.body.audit_pending]).toEqual([
      409,
      "live_attempt_exists",
      true,
    ]);
  });
});

describe("the status", () => {
  async function stamped() {
    const env = await world();
    for (const id of ["nm000104", "nm000105", "nm000106"]) {
      await run("admin", { recipe: "nemar-floor", dataset: id }, env);
    }
    return env;
  }

  test("pages newest first, and the cursor continues", async () => {
    const env = await stamped();
    const first = await status("admin", "?limit=2", env);
    expect(ComputePipelineStatusResponseSchema.safeParse(first.body).success).toBe(true);
    expect(first.body.stamps.map((s: any) => s.dataset_id)).toEqual(["nm000106", "nm000105"]);
    expect(first.body.next_before).toBe(first.body.stamps[1].id);
    const second = await status("admin", `?limit=2&before=${first.body.next_before}`, env);
    expect(second.body.stamps.map((s: any) => s.dataset_id)).toEqual(["nm000104"]);
    expect(second.body.next_before).toBeNull();
  });

  test("filters by recipe, dataset and state", async () => {
    const env = await stamped();
    expect((await status("admin", "?dataset=nm000105", env)).body.stamps).toHaveLength(1);
    expect((await status("admin", "?recipe=nemar-ica", env)).body.stamps).toEqual([]);
    expect((await status("admin", "?state=dispatched", env)).body.stamps).toHaveLength(3);
    expect((await status("admin", "?state=succeeded", env)).body.stamps).toEqual([]);
    expect(
      (await status("admin", "?recipe=nemar-floor&dataset=nm000104&state=dispatched", env)).body
        .stamps,
    ).toHaveLength(1);
  });

  test("a bad query is invalid_query", async () => {
    for (const q of [
      "?state=done",
      "?limit=0",
      "?limit=201",
      "?dataset=nope",
      "?before=x",
      "?recipe=A B",
    ]) {
      const res = await status("admin", q);
      expect([q, res.status, res.body.code]).toEqual([q, 400, "invalid_query"]);
    }
  });

  test("syncs the stamps before it reads: a finished job's stamp is succeeded in the same answer", async () => {
    const env = await world(["nm000104"]);
    const made = await run("admin", { recipe: "nemar-floor", dataset: "nm000104" }, env);
    const jobId = made.body.results[0].job_id as string;
    await finishAtTapis(fx, env, jobId, { outputs: floorOutputs() });
    const read = await status("admin", "", env);
    expect(read.body.stamps[0]).toMatchObject({ state: "succeeded", job_id: jobId });
  });
});
