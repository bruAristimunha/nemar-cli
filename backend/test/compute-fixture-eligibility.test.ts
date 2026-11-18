/**
 * The compute fixture `nm099996` is eligible outside production only, and reads its own environment's Zarr
 * copy (portable compute, card S1; plan step S1, decisions D4 and D12; ADR 0068).
 *
 * The pipeline eligibility predicate refuses every id of the reserved fixture band, so a standing fixture
 * could never be dispatched, claimed or listed. Outside production ONE id of that band is let through,
 * and nothing else: the real-dataset term is widened to name the fixture, every other term (active, public,
 * not anonymous, first published, not withdrawn, not tombstoned, a version, EEG) still applies to it, and an
 * exemplar is refused whatever its id. Production keeps the predicate byte for byte.
 *
 * What is pinned, each case with the mutation that kills it named in its title:
 *  (a) the declaration: the id list is the reserved band, never the absent id, never the never-dev-owned one;
 *  (b) the predicate under every environment, against the real migrated schema: eligible under
 *      `development`, `staging` and `test`; refused under `production`, the empty string, an unset binding and
 *      every misspelling; an exemplar, a neighbor in the band and a sandbox that is not the fixture refused
 *      everywhere; every other term still holds for the fixture;
 *  (c) the SQL form and the TypeScript form agree, in both environments, over generated rows;
 *  (d) the statements: production's three texts are the base commit's texts, character for character; the
 *      non-production texts differ only by the widened term; and each call picks its text by the environment
 *      it was handed;
 *  (e) the real statements, through a real dispatch, the real candidate listing and a real claim of a runner
 *      job over real tables: the claim re-checks the predicate (a job dispatched in a non-production
 *      environment wins nothing in production);
 *  (f) the Zarr base: the recipe's `--zarr-base` is the environment's own host outside production, and the
 *      production host for production, an unset binding and a value that is not a bare lower-case host name.
 *
 * The predicate and the statements are imported, never retyped (.rules/testing.md). Only the texts of
 * section (d) are literals, copied from the base commit so a change to production's text cannot pass.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  RECIPE_ZARR_BASE,
  RECIPE_ZARR_HOSTNAME_RE,
  findRecipe,
  recipeZarrArguments,
  recipeZarrBase,
} from "../../shared/compute-recipes";
import { LaunchSpecSchema, decodeLaunchSpecEnv } from "../../shared/contract/compute-launch";
import {
  PIPELINE_CANDIDATES_SQL,
  PIPELINE_CANDIDATES_SQL_NONPROD,
  dispatchPipelineJob,
  pipelineCandidates,
  pipelineCandidatesSql,
  pipelineZarrBase,
  recipeJobSpec,
} from "../src/services/compute-pipeline";
import {
  COMPUTE_FIXTURE_IDS,
  PIPELINE_ELIGIBLE_SQL,
  PIPELINE_ELIGIBLE_SQL_NONPROD,
  PIPELINE_ROW_COLUMNS,
  PIPELINE_TERMS,
  PIPELINE_TERMS_NONPROD,
  type PipelineRow,
  type PipelineTermId,
  failedPipelineTerms,
  isPipelineEligible,
  loadPipelineRow,
  pipelineEligibleSql,
  pipelineTermsFor,
} from "../src/services/compute-pipeline-eligibility";
import {
  CLAIM_RUNNER_JOB_SQL,
  CLAIM_RUNNER_JOB_SQL_NONPROD,
  claimRunnerJobSql,
  claimRunnerJobs,
  sweepRunnerLeases,
} from "../src/services/compute-runner-queue";
import {
  type RunnerPrincipal,
  exchangeRunnerSecret,
  registerRunner,
  resolveRunnerAccess,
} from "../src/services/compute-runners";
import {
  ABSENT_DATASET_ID,
  NEVER_DEV_OWNED_IDS,
  isReservedFixtureId,
} from "../src/services/datasetId";
import type { Bindings } from "../src/types/bindings";
import { seedComputeUsers } from "./helpers/compute-app";
import {
  type LifecycleFixture,
  RUNTIME_IMAGE_DIGEST,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { seedEegDataset, seedPipelinesAccount } from "./helpers/compute-pipeline-fixture";
import { freshDb, realD1 } from "./helpers/d1";
import {
  type GithubCompareStandin,
  startGithubCompareStandin,
} from "./helpers/github-compare-standin";
import { seedDatasetRow } from "./helpers/neurobagel-harness";

// --- The environments ----------------------------------------------------------------------------------

type EnvName = Bindings["ENVIRONMENT"];

/** The environments the widened predicate is for: exactly these three words. */
const NON_PRODUCTION: Array<string | undefined> = ["development", "staging", "test"];

/**
 * Everything that is production: the word itself, an empty value, an unset binding and the ways a value
 * can go wrong (a trailing space, another case, an abbreviation, a typo). An unrecognized value is
 * production.
 */
const PRODUCTION_LIKE: Array<string | undefined> = [
  "production",
  "",
  undefined,
  "Production ",
  "PRODUCTION",
  "prod",
  "dev",
  "devlopment",
  "stagin",
  "tes t",
  "unknown",
];

const envOf = (ENVIRONMENT: string | undefined) =>
  ({ ENVIRONMENT: ENVIRONMENT as EnvName }) as Pick<Bindings, "ENVIRONMENT">;

const label = (v: string | undefined) => (v === undefined ? "<unset>" : JSON.stringify(v));

// --- (a) The declaration -------------------------------------------------------------------------------

describe("the declaration", () => {
  test("the compute fixture is nm099996, a reserved id that is neither the absent id nor never dev-owned (MUTATION: add nm099900 or nm099999)", () => {
    expect([...COMPUTE_FIXTURE_IDS]).toEqual(["nm099996"]);
    for (const id of COMPUTE_FIXTURE_IDS) {
      expect(id).toMatch(/^nm0999\d{2}$/);
      expect(isReservedFixtureId(id)).toBe(true);
      expect(id).not.toBe(ABSENT_DATASET_ID);
      expect(NEVER_DEV_OWNED_IDS.has(id)).toBe(false);
    }
  });

  test("the widened term names the fixture list and keeps the real-dataset text whole", () => {
    const real = PIPELINE_TERMS.find((t) => t.id === "real_dataset");
    const widened = PIPELINE_TERMS_NONPROD.find((t) => t.id === "real_dataset");
    expect(real).toBeDefined();
    expect(widened?.sql).toBe(
      `(${real?.sql} OR (d.dataset_id IN ('nm099996') AND COALESCE(d.is_exemplar, 0) = 0))`,
    );
    // Every other term is the production term itself.
    expect(PIPELINE_TERMS_NONPROD.map((t) => t.id)).toEqual(PIPELINE_TERMS.map((t) => t.id));
    for (const [i, t] of PIPELINE_TERMS.entries()) {
      if (t.id !== "real_dataset") expect(PIPELINE_TERMS_NONPROD[i]).toBe(t);
    }
    expect(PIPELINE_ELIGIBLE_SQL_NONPROD.match(/\?/g)).toBeNull();
  });

  test("the production predicate names no fixture: its text has none of the band's ids (MUTATION: put the fixture in the production term)", () => {
    expect(PIPELINE_ELIGIBLE_SQL).not.toContain("nm099996");
    expect(PIPELINE_ELIGIBLE_SQL).not.toContain(" IN (");
    for (const t of PIPELINE_TERMS) expect(t.sql).not.toContain("nm099996");
  });

  test("every function that decides takes the environment: no default argument (a caller that forgets fails to compile)", () => {
    expect(isPipelineEligible.length).toBe(2);
    expect(failedPipelineTerms.length).toBe(2);
    expect(loadPipelineRow.length).toBe(3);
    expect(pipelineEligibleSql.length).toBe(1);
    expect(pipelineTermsFor.length).toBe(1);
    expect(claimRunnerJobSql.length).toBe(1);
    expect(pipelineCandidatesSql.length).toBe(1);
    expect(pipelineCandidates.length).toBe(3);
  });
});

// --- (b) The predicate under each environment ---------------------------------------------------------

let db: Database;
beforeEach(() => {
  db = freshDb();
});

type Seed = Parameters<typeof seedDatasetRow>[2];

/** A dataset row with a modality list (the shared seed has none). */
function seed(id: string, over: Seed = {}, modalities: string | null = "eeg"): void {
  seedDatasetRow(db, id, over);
  db.run("UPDATE datasets SET modalities = ? WHERE dataset_id = ?", [modalities, id]);
}

/** The ids the environment's predicate selects, through the real database. */
async function selectedBy(ENVIRONMENT: string | undefined): Promise<string[]> {
  const sql = `SELECT d.dataset_id FROM datasets d WHERE ${pipelineEligibleSql(envOf(ENVIRONMENT))} ORDER BY d.dataset_id`;
  const result = await realD1(db).prepare(sql).all<{ dataset_id: string }>();
  return result.results.map((r) => r.dataset_id);
}

describe("the fixture under each environment", () => {
  test("a public, named, first-published EEG sandbox row is eligible outside production, by both forms (MUTATION: replace isNonProductionEnv(env) with true in pipelineEligibleSql)", async () => {
    seed("nm099996", { isSandbox: 1 });
    for (const environment of [...NON_PRODUCTION, ...PRODUCTION_LIKE]) {
      const wanted = NON_PRODUCTION.includes(environment);
      const env = envOf(environment);
      const loaded = await loadPipelineRow(realD1(db), "nm099996", env);
      expect([
        label(environment),
        "sql",
        (await selectedBy(environment)).includes("nm099996"),
      ]).toEqual([label(environment), "sql", wanted]);
      expect([label(environment), "ts", loaded.eligible]).toEqual([
        label(environment),
        "ts",
        wanted,
      ]);
      expect([label(environment), loaded.blockedBy]).toEqual([
        label(environment),
        wanted ? [] : ["real_dataset"],
      ]);
      expect(isPipelineEligible(loaded.row, env)).toBe(wanted);
      expect(failedPipelineTerms(loaded.row, env)).toEqual(wanted ? [] : ["real_dataset"]);
    }
  });

  test("the sandbox flag is not tested for the fixture: the same row without it is eligible outside production too", async () => {
    seed("nm099996", { isSandbox: 0 });
    for (const environment of NON_PRODUCTION) {
      expect(await selectedBy(environment)).toEqual(["nm099996"]);
    }
    for (const environment of PRODUCTION_LIKE) {
      expect(await selectedBy(environment)).toEqual([]);
    }
  });

  test("an exemplar is refused everywhere, whatever its id and its sandbox flag (MUTATION: drop the is_exemplar clause)", async () => {
    seed("nm099996", { isExemplar: 1, isSandbox: 1 });
    for (const environment of [...NON_PRODUCTION, ...PRODUCTION_LIKE]) {
      const loaded = await loadPipelineRow(realD1(db), "nm099996", envOf(environment));
      expect([label(environment), loaded.eligible]).toEqual([label(environment), false]);
      expect([label(environment), loaded.blockedBy]).toEqual([
        label(environment),
        ["real_dataset"],
      ]);
      expect([label(environment), await selectedBy(environment)]).toEqual([label(environment), []]);
    }
  });

  test("a neighbor in the band, another prefix and a sandbox that is not the fixture are refused everywhere", async () => {
    for (const id of [
      "nm099900", // the absent id, the floor of the band
      "nm099995",
      "nm099997",
      "nm099998", // the standing anonymous deposit
      "nm099999", // the end-to-end dataset
      "xx099996", // the same number under the sandbox prefix
      "xx099900",
    ]) {
      seed(id, { isSandbox: 1 });
    }
    seed("nm000500", { isSandbox: 1 }); // a real id that is a sandbox row
    for (const environment of [...NON_PRODUCTION, ...PRODUCTION_LIKE]) {
      expect([label(environment), await selectedBy(environment)]).toEqual([label(environment), []]);
    }
  });

  test("nothing changes for a real dataset and a mirror, in every environment", async () => {
    seed("nm000500");
    seed("on000100");
    seed("nm000501", { isSandbox: 1 });
    for (const environment of [...NON_PRODUCTION, ...PRODUCTION_LIKE]) {
      expect([label(environment), await selectedBy(environment)]).toEqual([
        label(environment),
        ["nm000500", "on000100"],
      ]);
    }
  });

  const BREAKS: Array<[PipelineTermId[], Seed, string | null, boolean]> = [
    [["active"], { status: "archived" }, "eeg", false],
    [["active"], { status: "deleted" }, "eeg", false],
    [["public"], { visibility: "private" }, "eeg", false],
    // The schema's triggers make `anonymous = 1` imply no first publication: both terms fail.
    [["not_anonymous", "first_published"], { anonymous: 1, firstPublishedAt: null }, "eeg", false],
    [["first_published"], { firstPublishedAt: null }, "eeg", false],
    [["not_withdrawn"], { withdrawnAt: "2026-02-01 00:00:00" }, "eeg", false],
    [["not_tombstoned"], { ezidStatus: "unavailable" }, "eeg", false],
    [["has_version"], { versions: [] }, "eeg", false],
    [["eeg"], {}, "meg", false],
    [["eeg"], {}, "ieeg", false],
    [["eeg"], {}, null, false],
  ];

  test("every other term still applies to the fixture outside production (MUTATION: drop any one term from the widened predicate)", async () => {
    for (const [terms, over, modalities] of BREAKS) {
      const world = freshDb();
      db = world;
      seed("nm099996", { isSandbox: 1, ...over }, modalities);
      for (const environment of NON_PRODUCTION) {
        const loaded = await loadPipelineRow(realD1(db), "nm099996", envOf(environment));
        expect([label(environment), JSON.stringify(over), loaded.blockedBy]).toEqual([
          label(environment),
          JSON.stringify(over),
          terms,
        ]);
        expect(loaded.eligible).toBe(false);
        expect(await selectedBy(environment)).toEqual([]);
      }
      // In production the same row fails the real-dataset term as well.
      const prod = await loadPipelineRow(realD1(db), "nm099996", envOf("production"));
      expect(prod.blockedBy).toEqual([...terms, "real_dataset"]);
    }
  });
});

// --- (c) SQL and TypeScript agree ----------------------------------------------------------------------

describe("SQL and TypeScript agree, in both environments", () => {
  const published = "2026-01-02 03:04:05";
  const VECTORS: Array<[Seed, string | null]> = [
    [{}, "eeg"],
    [{ isSandbox: 1 }, "eeg"],
    [{ isExemplar: 1 }, "eeg"],
    [{ isSandbox: 1, isExemplar: 1 }, "eeg"],
    [{ status: "archived", isSandbox: 1 }, "eeg"],
    [{ visibility: "private", isSandbox: 1 }, "eeg"],
    [{ anonymous: 1, firstPublishedAt: null, isSandbox: 1 }, "eeg"],
    [{ firstPublishedAt: null, isSandbox: 1 }, "eeg"],
    [{ withdrawnAt: "2026-02-01 00:00:00", isSandbox: 1 }, "eeg"],
    [{ ezidStatus: "unavailable", isSandbox: 1 }, "eeg"],
    [{ ezidStatus: "public", isSandbox: 1 }, "eeg"],
    [{ versions: [], isSandbox: 1 }, "eeg"],
    [{ isSandbox: 1 }, "meg"],
    [{ isSandbox: 1 }, "ieeg"],
    [{ isSandbox: 1 }, "meg,eeg"],
    [{ isSandbox: 1 }, null],
    [{ visibility: "private", withdrawnAt: published }, "eeg"],
  ];
  const IDS = [
    "nm099996",
    "nm099995",
    "nm099900",
    "nm099999",
    "nm000108",
    "on000100",
    "xx099996",
    "xx000100",
    "ds000001",
  ];

  test("every id crossed with every fact vector is judged the same by both, for every environment (MUTATION: widen only one form)", async () => {
    let fixtureAcceptedOutside = 0;
    let fixtureAcceptedInProduction = 0;
    let seeded = 0;
    for (const [vector, modalities] of VECTORS) {
      db = freshDb();
      for (const id of IDS) {
        seed(id, vector, modalities);
        seeded++;
      }
      const rows = (
        await realD1(db)
          .prepare(`SELECT ${PIPELINE_ROW_COLUMNS} FROM datasets d ORDER BY d.dataset_id`)
          .all<PipelineRow>()
      ).results;
      expect(rows).toHaveLength(IDS.length);
      for (const environment of [...NON_PRODUCTION, ...PRODUCTION_LIKE]) {
        const env = envOf(environment);
        const bySql = new Set(await selectedBy(environment));
        for (const row of rows) {
          const byTs = isPipelineEligible(row, env);
          expect(`${label(environment)} ${row.dataset_id}:${byTs}`).toBe(
            `${label(environment)} ${row.dataset_id}:${bySql.has(row.dataset_id)}`,
          );
          expect(failedPipelineTerms(row, env).length === 0).toBe(byTs);
          if (row.dataset_id === "nm099996" && byTs) {
            if (NON_PRODUCTION.includes(environment)) fixtureAcceptedOutside++;
            else fixtureAcceptedInProduction++;
          }
        }
      }
    }
    expect(seeded).toBe(VECTORS.length * IDS.length);
    // The comparison is not vacuous: the fixture is accepted for some vectors outside production, and
    // for none in production.
    expect(fixtureAcceptedOutside).toBeGreaterThan(NON_PRODUCTION.length);
    expect(fixtureAcceptedInProduction).toBe(0);
  });
});

// --- (d) The statements --------------------------------------------------------------------------------

describe("the statements", () => {
  test("production's predicate text is the base commit's, character for character (MUTATION: touch any term)", () => {
    expect(PIPELINE_ELIGIBLE_SQL).toBe(BASE_ELIGIBLE_SQL);
  });

  test("production's claim statement is the base commit's, character for character (MUTATION: touch the claim)", () => {
    expect(CLAIM_RUNNER_JOB_SQL).toBe(BASE_CLAIM_SQL);
  });

  test("production's candidate statement is the base commit's, character for character (MUTATION: touch the candidates)", () => {
    expect(PIPELINE_CANDIDATES_SQL).toBe(BASE_CANDIDATES_SQL);
  });

  test("the non-production texts are the production texts with the predicate swapped, and nothing else", () => {
    expect(PIPELINE_ELIGIBLE_SQL_NONPROD).not.toBe(PIPELINE_ELIGIBLE_SQL);
    expect(BASE_CLAIM_SQL.split(BASE_ELIGIBLE_SQL)).toHaveLength(3); // once over the picked row, once over the written row
    expect(BASE_CANDIDATES_SQL.split(BASE_ELIGIBLE_SQL)).toHaveLength(2);
    expect(CLAIM_RUNNER_JOB_SQL_NONPROD).toBe(
      BASE_CLAIM_SQL.split(BASE_ELIGIBLE_SQL).join(PIPELINE_ELIGIBLE_SQL_NONPROD),
    );
    expect(PIPELINE_CANDIDATES_SQL_NONPROD).toBe(
      BASE_CANDIDATES_SQL.split(BASE_ELIGIBLE_SQL).join(PIPELINE_ELIGIBLE_SQL_NONPROD),
    );
    // The fixture appears only in the non-production texts.
    for (const production of [
      PIPELINE_ELIGIBLE_SQL,
      CLAIM_RUNNER_JOB_SQL,
      PIPELINE_CANDIDATES_SQL,
    ]) {
      expect(production).not.toContain("nm099996");
    }
    for (const widened of [
      PIPELINE_ELIGIBLE_SQL_NONPROD,
      CLAIM_RUNNER_JOB_SQL_NONPROD,
      PIPELINE_CANDIDATES_SQL_NONPROD,
    ]) {
      expect(widened).toContain("d.dataset_id IN ('nm099996')");
    }
  });

  test("each call picks its text by the environment it is handed: production for anything unrecognized (MUTATION: always the widened text)", () => {
    for (const environment of PRODUCTION_LIKE) {
      const env = envOf(environment);
      expect([label(environment), pipelineEligibleSql(env)]).toEqual([
        label(environment),
        PIPELINE_ELIGIBLE_SQL,
      ]);
      expect([label(environment), claimRunnerJobSql(env)]).toEqual([
        label(environment),
        CLAIM_RUNNER_JOB_SQL,
      ]);
      expect([label(environment), pipelineCandidatesSql(env)]).toEqual([
        label(environment),
        PIPELINE_CANDIDATES_SQL,
      ]);
      expect(pipelineTermsFor(env)).toBe(PIPELINE_TERMS);
    }
    for (const environment of NON_PRODUCTION) {
      const env = envOf(environment);
      expect(pipelineEligibleSql(env)).toBe(PIPELINE_ELIGIBLE_SQL_NONPROD);
      expect(claimRunnerJobSql(env)).toBe(CLAIM_RUNNER_JOB_SQL_NONPROD);
      expect(pipelineCandidatesSql(env)).toBe(PIPELINE_CANDIDATES_SQL_NONPROD);
      expect(pipelineTermsFor(env)).toBe(PIPELINE_TERMS_NONPROD);
    }
  });
});

// --- (e) The real statements ---------------------------------------------------------------------------

describe("a real dispatch, listing and claim", () => {
  let fx: LifecycleFixture;
  let ids: Awaited<ReturnType<typeof seedComputeUsers>>;
  let env: Bindings;
  let github: GithubCompareStandin;
  const seams = globalThis as { NEMAR_GITHUB_API_URL?: string; NEMAR_ZARR_INDEX_BASE?: string };
  const previousSeams = { github: seams.NEMAR_GITHUB_API_URL, index: seams.NEMAR_ZARR_INDEX_BASE };
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";
  const FIXTURE = "nm099996";
  let seq = 0;

  beforeAll(async () => {
    fx = await startLifecycleFixture();
    github = startGithubCompareStandin();
    seams.NEMAR_GITHUB_API_URL = github.url;
    seams.NEMAR_ZARR_INDEX_BASE = github.indexBase;
  }, 120_000);

  beforeEach(async () => {
    github.reset();
    await fx.reset();
    ids = await seedComputeUsers(fx.harness.db);
    env = fx.env({ ENVIRONMENT: "development", COMPUTE_RUNNERS_ENABLED: "1" });
    await seedPipelinesAccount(env);
  });

  afterAll(async () => {
    github?.stop();
    seams.NEMAR_GITHUB_API_URL = previousSeams.github;
    seams.NEMAR_ZARR_INDEX_BASE = previousSeams.index;
    await fx?.dispose();
  }, 30_000);

  /** A public EEG dataset with a ready serving copy; the fixture when no id is given. */
  async function dataset(id: string, over: { sandbox?: boolean; exemplar?: boolean } = {}) {
    await seedEegDataset(env, id);
    github.tag(id, "v1.0.0", COMMIT);
    github.index(id, { source_commit: COMMIT, store_count: 3 });
    await env.DB.prepare(
      `UPDATE datasets SET zarr_source_commit = ?1, zarr_status = 'ready', zarr_store_count = 3,
              is_sandbox = ?3, is_exemplar = ?4 WHERE dataset_id = ?2`,
    )
      .bind(COMMIT, id, over.sandbox ? 1 : 0, over.exemplar ? 1 : 0)
      .run();
  }

  const dispatch = (e: Bindings, id: string) =>
    dispatchPipelineJob(e, {
      recipe: "nemar-floor",
      datasetId: id,
      actor: { kind: "admin", userId: ids.admin },
      executor: "runner",
    });

  async function runner(e: Bindings = env): Promise<RunnerPrincipal> {
    const { runnerId } = await registerRunner(e.DB, ids.owner, {
      name: `runner_${++seq}`,
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
    } as Parameters<typeof registerRunner>[2]);
    const issued = await exchangeRunnerSecret(e.DB, runnerId, "0.1.0");
    if (!issued) throw new Error("no token");
    const access = await resolveRunnerAccess(e.DB, issued.accessToken);
    if (access.kind !== "ok") throw new Error("no access");
    return access.runner;
  }

  const row = async (jobId: string) =>
    (await env.DB.prepare("SELECT * FROM compute_jobs WHERE id = ?1")
      .bind(jobId)
      .first()) as Record<string, unknown>;

  test("a dispatch of the fixture is refused in production and made in development (MUTATION: widen the dispatch re-check only, or not at all)", async () => {
    await dataset(FIXTURE, { sandbox: true });
    const production = { ...env, ENVIRONMENT: "production" as const };
    const refused = await dispatch(production, FIXTURE);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("dataset_not_eligible");
      expect(refused.blockedBy).toEqual(["real_dataset"]);
    }
    // Nothing was written by the refusal: no stamp, no job.
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM compute_pipeline_stamps").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM compute_jobs").first<{ n: number }>())?.n,
    ).toBe(0);

    const made = await dispatch(env, FIXTURE);
    expect(made.ok).toBe(true);
  });

  test("an exemplar of the same id is refused in development too", async () => {
    await dataset(FIXTURE, { sandbox: true, exemplar: true });
    const refused = await dispatch(env, FIXTURE);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("dataset_not_eligible");
      expect(refused.blockedBy).toEqual(["real_dataset"]);
    }
  });

  test("the candidate listing offers the fixture outside production and never in production (MUTATION: use the widened text for every environment)", async () => {
    await dataset(FIXTURE, { sandbox: true });
    await dataset("nm000501");
    const recipe = findRecipe("nemar-floor");
    if (recipe === null) throw new Error("no recipe");
    expect((await pipelineCandidates(env, recipe, 10)).map((c) => c.dataset_id)).toEqual([
      "nm000501",
      FIXTURE,
    ]);
    for (const environment of PRODUCTION_LIKE) {
      const e = { ...env, ENVIRONMENT: environment as EnvName };
      expect([
        label(environment),
        (await pipelineCandidates(e, recipe, 10)).map((c) => c.dataset_id),
      ]).toEqual([label(environment), ["nm000501"]]);
    }
  });

  test("a job dispatched outside production is not claimed by a production-classified worker, and is claimed outside it (MUTATION: use the widened claim text for every environment)", async () => {
    await dataset(FIXTURE, { sandbox: true });
    const principal = await runner();
    const made = await dispatch(env, FIXTURE);
    if (!made.ok) throw new Error(`could not dispatch: ${made.code}`);
    for (const environment of PRODUCTION_LIKE) {
      const e = { ...env, ENVIRONMENT: environment as EnvName };
      const claimed = await claimRunnerJobs(e, principal, 1);
      expect([label(environment), claimed.jobs.length]).toEqual([label(environment), 0]);
      expect([label(environment), (await row(made.jobId)).runner_claimed_at]).toEqual([
        label(environment),
        null,
      ]);
    }
    const claimed = await claimRunnerJobs(env, principal, 1);
    expect(claimed.jobs.map((j) => j.id)).toEqual([made.jobId]);
    expect((await row(made.jobId)).runner_id).toBe(principal.id);
  });

  test("a fixture made an exemplar after dispatch is not claimed in development either", async () => {
    await dataset(FIXTURE, { sandbox: true });
    const principal = await runner();
    const made = await dispatch(env, FIXTURE);
    if (!made.ok) throw new Error(`could not dispatch: ${made.code}`);
    await env.DB.prepare("UPDATE datasets SET is_exemplar = 1 WHERE dataset_id = ?1")
      .bind(FIXTURE)
      .run();
    expect((await claimRunnerJobs(env, principal, 1)).jobs).toHaveLength(0);
    await env.DB.prepare("UPDATE datasets SET is_exemplar = 0 WHERE dataset_id = ?1")
      .bind(FIXTURE)
      .run();
    expect((await claimRunnerJobs(env, principal, 1)).jobs).toHaveLength(1);
  });

  test("a job's recipe arguments name the environment's Zarr host, and the claim answers them (MUTATION: read the constant)", async () => {
    const e = { ...env, ZARR_HOSTNAME: "zarr.staging.example" };
    await dataset(FIXTURE, { sandbox: true });
    const principal = await runner();
    const made = await dispatch(e, FIXTURE);
    if (!made.ok) throw new Error(`could not dispatch: ${made.code}`);
    const claimed = await claimRunnerJobs(e, principal, 1);
    expect(claimed.jobs).toHaveLength(1);
    const decoded = decodeLaunchSpecEnv(
      (claimed.jobs[0] as { launch_spec_env: string }).launch_spec_env,
    );
    if (!decoded.ok) throw new Error("the launcher would refuse the launch specification");
    const spec = LaunchSpecSchema.parse(JSON.parse(decoded.text));
    expect(spec.args.slice(-2)).toEqual(["--zarr-base", "https://zarr.staging.example"]);
    expect(spec.image.digest).toBe(RUNTIME_IMAGE_DIGEST);
  });

  test("a replay of the records rebuilds the same specification under the same environment, and another one under another (MUTATION: read the base from anywhere but the environment)", async () => {
    const e = { ...env, ZARR_HOSTNAME: "zarr.staging.example" };
    await dataset(FIXTURE, { sandbox: true });
    // A store that is down for the dispatch's two writes: the job has a digest and no records.
    const real = fx.harness.records;
    let left = 2;
    const down = {
      put: async (key: string, value: unknown, options?: unknown) => {
        if (left-- > 0) throw new Error("the store is down");
        return real.put(key, value as ArrayBuffer, options as Parameters<R2Bucket["put"]>[2]);
      },
      get: (key: string) => real.get(key),
      head: (key: string) => real.head(key),
      delete: (key: string) => real.delete(key),
      list: (o?: Parameters<R2Bucket["list"]>[0]) => real.list(o),
    } as unknown as R2Bucket;
    const made = await dispatch({ ...e, COMPUTE_RECORDS: down }, FIXTURE);
    if (!made.ok) throw new Error(`could not dispatch: ${made.code}`);
    expect((await row(made.jobId)).records_written_at).toBeNull();
    await env.DB.prepare(
      "UPDATE compute_jobs SET created_at = datetime('now', '-6 minutes') WHERE id = ?1",
    )
      .bind(made.jobId)
      .run();
    // The host the dispatch hashed is not the one this environment names: the replay refuses to write.
    expect((await sweepRunnerLeases(env)).replayed).toBe(0);
    expect((await row(made.jobId)).records_written_at).toBeNull();
    // A row is not examined twice within the throttle: age the examination too.
    await env.DB.prepare(
      "UPDATE compute_jobs SET examined_at = datetime('now', '-6 minutes') WHERE id = ?1",
    )
      .bind(made.jobId)
      .run();
    // The same environment rebuilds the same text.
    expect((await sweepRunnerLeases(e)).replayed).toBe(1);
    expect((await row(made.jobId)).records_written_at).not.toBeNull();
  });
});

// --- (f) The Zarr base ---------------------------------------------------------------------------------

describe("the Zarr base of a recipe job", () => {
  const SPEC_INPUT = {
    datasetId: "nm099996",
    tag: "v1.0.0",
    input: "zarr" as const,
    image: {
      ref: `ghcr.io/example/nemar-python@${RUNTIME_IMAGE_DIGEST}`,
      digest: RUNTIME_IMAGE_DIGEST,
    },
    zarrSource: {
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      tagCommit: "0123456789abcdef0123456789abcdef01234567",
      equivalence: "exact" as const,
      deltaPaths: [],
    },
  };

  test("production, and a name that is not a bare lower-case host name, give the production host (MUTATION: return ZARR_HOSTNAME without the check)", () => {
    expect(RECIPE_ZARR_BASE).toBe("https://zarr.nemar.org");
    for (const hostile of [
      "evil.example/x",
      "a b",
      "evil.example:8443",
      "https://evil.example",
      "http://evil.example",
      "user@evil.example",
      "evil.example?x=1",
      "evil.example#x",
      "evil.example\n",
      "evil.example\\x",
      "zarr.staging.example".replace("z", "Z"), // upper case is not a bare lower-case host name
      "ZARR.STAGING.EXAMPLE",
      "-evil.example",
      "evil.example-",
      ".evil.example",
      "evil.example.",
      "",
      " ",
      "é.example",
    ]) {
      expect([hostile, recipeZarrBase({ nonProduction: true, zarrHostname: hostile })]).toEqual([
        hostile,
        RECIPE_ZARR_BASE,
      ]);
    }
    expect(recipeZarrBase({ nonProduction: true, zarrHostname: undefined })).toBe(RECIPE_ZARR_BASE);
    expect(recipeZarrBase({ nonProduction: true, zarrHostname: null })).toBe(RECIPE_ZARR_BASE);
    // Production reads no ZARR_HOSTNAME at all.
    for (const name of ["zarr.staging.example", "zarr.nemar.org", "evil.example", undefined]) {
      expect(recipeZarrBase({ nonProduction: false, zarrHostname: name })).toBe(RECIPE_ZARR_BASE);
    }
  });

  test("outside production a bare lower-case host name gives https:// and the name", () => {
    for (const name of ["zarr.staging.example", "zarr.nemar.org", "localhost", "a", "a1-b.c2"]) {
      expect(RECIPE_ZARR_HOSTNAME_RE.test(name)).toBe(true);
      expect(recipeZarrBase({ nonProduction: true, zarrHostname: name })).toBe(`https://${name}`);
    }
  });

  test("the Worker's base is decided from ENVIRONMENT by the same classifier as the predicate: unset and misspelled are production", () => {
    const zarrHostname = "zarr.staging.example";
    for (const environment of PRODUCTION_LIKE) {
      expect([
        label(environment),
        pipelineZarrBase({ ENVIRONMENT: environment as EnvName, ZARR_HOSTNAME: zarrHostname }),
      ]).toEqual([label(environment), RECIPE_ZARR_BASE]);
    }
    for (const environment of NON_PRODUCTION) {
      expect(
        pipelineZarrBase({ ENVIRONMENT: environment as EnvName, ZARR_HOSTNAME: zarrHostname }),
      ).toBe("https://zarr.staging.example");
      // No host configured: the production host.
      expect(pipelineZarrBase({ ENVIRONMENT: environment as EnvName })).toBe(RECIPE_ZARR_BASE);
      expect(pipelineZarrBase({ ENVIRONMENT: environment as EnvName, ZARR_HOSTNAME: "" })).toBe(
        RECIPE_ZARR_BASE,
      );
    }
  });

  test("the recipe job's vector carries the base the environment names, last (MUTATION: read RECIPE_ZARR_BASE in recipeJobSpec)", () => {
    const recipe = findRecipe("nemar-floor");
    if (recipe === null) throw new Error("no recipe");
    const zarrHostname = "zarr.staging.example";
    const staging = recipeJobSpec(recipe, {
      ...SPEC_INPUT,
      env: { ENVIRONMENT: "staging", ZARR_HOSTNAME: zarrHostname },
    });
    expect(staging.args.slice(-2)).toEqual(["--zarr-base", "https://zarr.staging.example"]);
    for (const environment of PRODUCTION_LIKE) {
      const spec = recipeJobSpec(recipe, {
        ...SPEC_INPUT,
        env: { ENVIRONMENT: environment as EnvName, ZARR_HOSTNAME: zarrHostname },
      });
      expect([label(environment), spec.args.slice(-2)]).toEqual([
        label(environment),
        ["--zarr-base", RECIPE_ZARR_BASE],
      ]);
    }
    // The only difference between the two vectors is the base.
    const production = recipeJobSpec(recipe, { ...SPEC_INPUT, env: { ENVIRONMENT: "production" } });
    expect(staging.args.slice(0, -1)).toEqual(production.args.slice(0, -1));
  });

  test("the vector builder refuses a base that is not the production host or https and a bare lower-case host (MUTATION: drop the check)", () => {
    const base = {
      datasetId: "nm099996",
      tag: "v1.0.0",
      imageDigest: RUNTIME_IMAGE_DIGEST,
      attestation: SPEC_INPUT.zarrSource,
    };
    for (const ok of [RECIPE_ZARR_BASE, "https://zarr.staging.example"]) {
      expect(recipeZarrArguments({ ...base, zarrBase: ok }).slice(-2)).toEqual(["--zarr-base", ok]);
    }
    for (const bad of [
      "",
      "zarr.nemar.org",
      "http://zarr.nemar.org",
      "https://zarr.nemar.org/",
      "https://zarr.nemar.org/x",
      "https://evil.example:8443",
      "https://a b",
      "https://",
      "ftp://zarr.nemar.org",
    ]) {
      expect(() => recipeZarrArguments({ ...base, zarrBase: bad })).toThrow(RangeError);
    }
  });
});

// --- The base commit's texts, recorded -----------------------------------------------------------------
//
// Recorded from the statements at `02113b16` (the epic branch before this card), by calling the base
// commit's `pipelineCandidates` against a database that kept the text it was asked to prepare, and by
// reading `CLAIM_RUNNER_JOB_SQL` and `PIPELINE_ELIGIBLE_SQL`. They are literals on purpose: a test that
// rebuilt them from the code under test could not notice a change to production's text. The candidate
// statement's three stamp subselects each gained one term, `input = ?8` (portable compute card Q0b: the input
// is part of a stamp's tuple); nothing of the eligibility predicate or the claim changed.

const BASE_ELIGIBLE_SQL = `d.status = 'active'
    AND d.visibility = 'public'
    AND d.anonymous = 0
    AND d.first_published_at IS NOT NULL
    AND d.withdrawn_at IS NULL
    AND COALESCE(d.ezid_status, '') <> 'unavailable'
    AND EXISTS (SELECT 1 FROM dataset_versions dv WHERE dv.dataset_id = d.dataset_id)
    AND EXISTS (WITH RECURSIVE modality_tokens(tok, rest) AS (
    SELECT NULL, LOWER(d.modalities) || ','
    UNION ALL
    SELECT TRIM(SUBSTR(rest, 1, INSTR(rest, ',') - 1), ' ' || CHAR(9) || CHAR(10) || CHAR(13)),
           SUBSTR(rest, INSTR(rest, ',') + 1)
    FROM modality_tokens WHERE INSTR(rest, ',') > 0
  ) SELECT 1 FROM modality_tokens WHERE tok = 'eeg')
    AND (
        ((d.dataset_id GLOB 'nm[0-9][0-9][0-9][0-9][0-9][0-9]' AND d.dataset_id < 'nm099900')
          OR d.dataset_id GLOB 'on[0-9][0-9][0-9][0-9][0-9][0-9]')
        AND COALESCE(d.is_sandbox, 0) = 0 AND COALESCE(d.is_exemplar, 0) = 0
      )`;

const BASE_CLAIM_SQL = `UPDATE compute_jobs SET
    runner_claimed_at = datetime('now'),
    runner_id = ?1,
    runner_backend = ?2,
    lease_id = ?3,
    lease_expires_at = datetime('now', '+600 seconds'),
    claim_attempts = claim_attempts + 1,
    webhook_nonce = COALESCE(webhook_nonce, ?4)
  WHERE id = (SELECT j.id FROM compute_jobs j
               WHERE j.executor = 'runner' AND j.accounting = 'none'
      AND j.state = 'created' AND j.runner_claimed_at IS NULL
      AND j.records_written_at IS NOT NULL AND j.cancel_requested_at IS NULL
      AND j.claim_attempts < ?5
      AND j.pool = ?6
      AND (SELECT COALESCE(SUM(l.cores_per_node), 0) FROM compute_jobs l
     WHERE l.runner_id = ?1 AND l.executor = 'runner' AND l.state IN ('created', 'uploading', 'submitted', 'queued', 'running', 'archiving', 'unreported')) + j.cores_per_node <= ?7
      AND (SELECT COALESCE(SUM(COALESCE(l.memory_mb, 0)), 0) FROM compute_jobs l
     WHERE l.runner_id = ?1 AND l.executor = 'runner' AND l.state IN ('created', 'uploading', 'submitted', 'queued', 'running', 'archiving', 'unreported')) + COALESCE(j.memory_mb, 0) <= ?8
      AND (SELECT COALESCE(SUM(l.gpus), 0) FROM compute_jobs l
     WHERE l.runner_id = ?1 AND l.executor = 'runner' AND l.state IN ('created', 'uploading', 'submitted', 'queued', 'running', 'archiving', 'unreported')) + j.gpus <= ?9
      AND EXISTS (SELECT 1 FROM compute_pipeline_stamps s JOIN datasets d ON d.dataset_id = s.dataset_id
                   WHERE s.job_id = j.id AND d.status = 'active'
    AND d.visibility = 'public'
    AND d.anonymous = 0
    AND d.first_published_at IS NOT NULL
    AND d.withdrawn_at IS NULL
    AND COALESCE(d.ezid_status, '') <> 'unavailable'
    AND EXISTS (SELECT 1 FROM dataset_versions dv WHERE dv.dataset_id = d.dataset_id)
    AND EXISTS (WITH RECURSIVE modality_tokens(tok, rest) AS (
    SELECT NULL, LOWER(d.modalities) || ','
    UNION ALL
    SELECT TRIM(SUBSTR(rest, 1, INSTR(rest, ',') - 1), ' ' || CHAR(9) || CHAR(10) || CHAR(13)),
           SUBSTR(rest, INSTR(rest, ',') + 1)
    FROM modality_tokens WHERE INSTR(rest, ',') > 0
  ) SELECT 1 FROM modality_tokens WHERE tok = 'eeg')
    AND (
        ((d.dataset_id GLOB 'nm[0-9][0-9][0-9][0-9][0-9][0-9]' AND d.dataset_id < 'nm099900')
          OR d.dataset_id GLOB 'on[0-9][0-9][0-9][0-9][0-9][0-9]')
        AND COALESCE(d.is_sandbox, 0) = 0 AND COALESCE(d.is_exemplar, 0) = 0
      ))
               ORDER BY j.created_at ASC, j.id ASC LIMIT 1)
    AND compute_jobs.executor = 'runner' AND compute_jobs.accounting = 'none'
      AND compute_jobs.state = 'created' AND compute_jobs.runner_claimed_at IS NULL
      AND compute_jobs.records_written_at IS NOT NULL AND compute_jobs.cancel_requested_at IS NULL
      AND compute_jobs.claim_attempts < ?5
      AND compute_jobs.pool = ?6
      AND (SELECT COALESCE(SUM(l.cores_per_node), 0) FROM compute_jobs l
     WHERE l.runner_id = ?1 AND l.executor = 'runner' AND l.state IN ('created', 'uploading', 'submitted', 'queued', 'running', 'archiving', 'unreported')) + compute_jobs.cores_per_node <= ?7
      AND (SELECT COALESCE(SUM(COALESCE(l.memory_mb, 0)), 0) FROM compute_jobs l
     WHERE l.runner_id = ?1 AND l.executor = 'runner' AND l.state IN ('created', 'uploading', 'submitted', 'queued', 'running', 'archiving', 'unreported')) + COALESCE(compute_jobs.memory_mb, 0) <= ?8
      AND (SELECT COALESCE(SUM(l.gpus), 0) FROM compute_jobs l
     WHERE l.runner_id = ?1 AND l.executor = 'runner' AND l.state IN ('created', 'uploading', 'submitted', 'queued', 'running', 'archiving', 'unreported')) + compute_jobs.gpus <= ?9
      AND EXISTS (SELECT 1 FROM compute_pipeline_stamps s JOIN datasets d ON d.dataset_id = s.dataset_id
                   WHERE s.job_id = compute_jobs.id AND d.status = 'active'
    AND d.visibility = 'public'
    AND d.anonymous = 0
    AND d.first_published_at IS NOT NULL
    AND d.withdrawn_at IS NULL
    AND COALESCE(d.ezid_status, '') <> 'unavailable'
    AND EXISTS (SELECT 1 FROM dataset_versions dv WHERE dv.dataset_id = d.dataset_id)
    AND EXISTS (WITH RECURSIVE modality_tokens(tok, rest) AS (
    SELECT NULL, LOWER(d.modalities) || ','
    UNION ALL
    SELECT TRIM(SUBSTR(rest, 1, INSTR(rest, ',') - 1), ' ' || CHAR(9) || CHAR(10) || CHAR(13)),
           SUBSTR(rest, INSTR(rest, ',') + 1)
    FROM modality_tokens WHERE INSTR(rest, ',') > 0
  ) SELECT 1 FROM modality_tokens WHERE tok = 'eeg')
    AND (
        ((d.dataset_id GLOB 'nm[0-9][0-9][0-9][0-9][0-9][0-9]' AND d.dataset_id < 'nm099900')
          OR d.dataset_id GLOB 'on[0-9][0-9][0-9][0-9][0-9][0-9]')
        AND COALESCE(d.is_sandbox, 0) = 0 AND COALESCE(d.is_exemplar, 0) = 0
      ))
    AND EXISTS (SELECT 1 FROM compute_runners r JOIN users u ON u.id = r.registered_by
                 WHERE r.id = ?1 AND r.revoked_at IS NULL AND u.role = 'owner' AND u.status = 'approved' AND u.deleted_at IS NULL)`;

const BASE_CANDIDATES_SQL = `SELECT d.dataset_id, d.status, d.visibility, d.anonymous,
    d.first_published_at, d.withdrawn_at, d.ezid_status, d.is_sandbox, d.is_exemplar, d.modalities,
    EXISTS (SELECT 1 FROM dataset_versions dv WHERE dv.dataset_id = d.dataset_id) AS has_version,
                  (SELECT dv.version FROM dataset_versions dv WHERE dv.dataset_id = d.dataset_id
     ORDER BY dv.created_at DESC, dv.id DESC LIMIT 1) AS newest_version,
                  (SELECT dv.total_files FROM dataset_versions dv WHERE dv.dataset_id = d.dataset_id
     ORDER BY dv.created_at DESC, dv.id DESC LIMIT 1) AS newest_total_files
             FROM datasets d
            WHERE d.dataset_id > ?1
              AND d.status = 'active'
    AND d.visibility = 'public'
    AND d.anonymous = 0
    AND d.first_published_at IS NOT NULL
    AND d.withdrawn_at IS NULL
    AND COALESCE(d.ezid_status, '') <> 'unavailable'
    AND EXISTS (SELECT 1 FROM dataset_versions dv WHERE dv.dataset_id = d.dataset_id)
    AND EXISTS (WITH RECURSIVE modality_tokens(tok, rest) AS (
    SELECT NULL, LOWER(d.modalities) || ','
    UNION ALL
    SELECT TRIM(SUBSTR(rest, 1, INSTR(rest, ',') - 1), ' ' || CHAR(9) || CHAR(10) || CHAR(13)),
           SUBSTR(rest, INSTR(rest, ',') + 1)
    FROM modality_tokens WHERE INSTR(rest, ',') > 0
  ) SELECT 1 FROM modality_tokens WHERE tok = 'eeg')
    AND (
        ((d.dataset_id GLOB 'nm[0-9][0-9][0-9][0-9][0-9][0-9]' AND d.dataset_id < 'nm099900')
          OR d.dataset_id GLOB 'on[0-9][0-9][0-9][0-9][0-9][0-9]')
        AND COALESCE(d.is_sandbox, 0) = 0 AND COALESCE(d.is_exemplar, 0) = 0
      )
              AND NOT EXISTS (
                SELECT 1 FROM compute_pipeline_stamps s
                 WHERE s.dataset_id = d.dataset_id AND s.recipe = ?2 AND s.recipe_version = ?3
                   AND s.engine = ?4 AND s.input = ?8 AND s.state IN ('dispatched', 'succeeded')
                   AND s.version = (CASE WHEN substr((SELECT dv.version FROM dataset_versions dv WHERE dv.dataset_id = s.dataset_id
     ORDER BY dv.created_at DESC, dv.id DESC LIMIT 1), 1, 1) BETWEEN '0' AND '9' THEN 'v' || (SELECT dv.version FROM dataset_versions dv WHERE dv.dataset_id = s.dataset_id
     ORDER BY dv.created_at DESC, dv.id DESC LIMIT 1) ELSE (SELECT dv.version FROM dataset_versions dv WHERE dv.dataset_id = s.dataset_id
     ORDER BY dv.created_at DESC, dv.id DESC LIMIT 1) END))
              AND NOT EXISTS (
                SELECT 1 FROM compute_pipeline_stamps f
                 WHERE f.dataset_id = d.dataset_id AND f.recipe = ?2 AND f.recipe_version = ?3
                   AND f.engine = ?4 AND f.input = ?8 AND f.state = 'failed'
                   AND (f.refusal_code NOT IN ('code_fetch_failed', 'dataset_fetch_failed', 'tapis_submit_failed', 'submit_timeout', 'staging_failed', 'launch_failed', 'archive_failed', 'tapis_error', 'records_unavailable', 'runner_lost', 'job_cancelled', 'no_job', 'job_missing', 'create_failed', 'recipe_unknown', 'tuple_mismatch', 'tuple_already_stamped', 'tuple_attempt_taken', 'zarr_source_unverifiable')
    OR EXISTS (SELECT 1 FROM compute_jobs cj
                WHERE cj.id = f.job_id AND cj.state = 'failed' AND cj.charged_milli > 0))
                   AND f.updated_at >= datetime('now', ?6)
                   AND f.version = (CASE WHEN substr((SELECT dv.version FROM dataset_versions dv WHERE dv.dataset_id = f.dataset_id
     ORDER BY dv.created_at DESC, dv.id DESC LIMIT 1), 1, 1) BETWEEN '0' AND '9' THEN 'v' || (SELECT dv.version FROM dataset_versions dv WHERE dv.dataset_id = f.dataset_id
     ORDER BY dv.created_at DESC, dv.id DESC LIMIT 1) ELSE (SELECT dv.version FROM dataset_versions dv WHERE dv.dataset_id = f.dataset_id
     ORDER BY dv.created_at DESC, dv.id DESC LIMIT 1) END))
              AND (
                SELECT COUNT(*) FROM compute_pipeline_stamps c
                 WHERE c.dataset_id = d.dataset_id AND c.recipe = ?2 AND c.recipe_version = ?3
                   AND c.engine = ?4 AND c.input = ?8 AND c.state = 'failed'
                   AND (c.refusal_code NOT IN ('code_fetch_failed', 'dataset_fetch_failed', 'tapis_submit_failed', 'submit_timeout', 'staging_failed', 'launch_failed', 'archive_failed', 'tapis_error', 'records_unavailable', 'runner_lost', 'job_cancelled', 'no_job', 'job_missing', 'create_failed', 'recipe_unknown', 'tuple_mismatch', 'tuple_already_stamped', 'tuple_attempt_taken', 'zarr_source_unverifiable')
    OR EXISTS (SELECT 1 FROM compute_jobs cj
                WHERE cj.id = c.job_id AND cj.state = 'failed' AND cj.charged_milli > 0))
                   AND c.version = (CASE WHEN substr((SELECT dv.version FROM dataset_versions dv WHERE dv.dataset_id = c.dataset_id
     ORDER BY dv.created_at DESC, dv.id DESC LIMIT 1), 1, 1) BETWEEN '0' AND '9' THEN 'v' || (SELECT dv.version FROM dataset_versions dv WHERE dv.dataset_id = c.dataset_id
     ORDER BY dv.created_at DESC, dv.id DESC LIMIT 1) ELSE (SELECT dv.version FROM dataset_versions dv WHERE dv.dataset_id = c.dataset_id
     ORDER BY dv.created_at DESC, dv.id DESC LIMIT 1) END)) < ?7
            ORDER BY d.dataset_id LIMIT ?5`;
