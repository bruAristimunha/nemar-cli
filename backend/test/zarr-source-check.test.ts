/**
 * Does the Zarr serving copy describe the tagged data? (portable compute card DM-06b; plan D12)
 *
 * For a run whose input is `zarr`, `resolveRun` resolves the tag commit T and the serving index's commit S and
 * decides `exact` (S is T) or `metadata_only` (GitHub's compare of `T...S` is `ahead`, `behind_by` 0, fewer than
 * 300 files, every changed path under `.nemar/` or `.github/`), refuses everything else with a fixed word, and
 * hands the recipe S, T, the verdict and the delta paths as flags. Everything here goes through the REAL admin
 * pipeline route over a real migrated database and Miniflare's R2, with a real loopback server standing in for
 * the two EXTERNAL services (GitHub, and the serving copy's index), and says:
 *
 *  (a) the verdict: `exact`, `metadata_only` (flags, order, the compare asked for, at most three GitHub
 *      requests), the `v`-less tag retry;
 *  (b) the refusals: a definite mismatch is `zarr_source_mismatch` (409) and one that cannot be read is
 *      `zarr_source_unverifiable` (503), and neither writes a job, a hold, a ledger entry or a stamp;
 *  (c) the bounds: no retry inside a request, the timeout, the size of each body, the delta-path cap;
 *  (d) where the check does NOT run (a BIDS recipe, an older version, a copy that is not ready): the stand-in's
 *      request log is empty;
 *  (e) production fails closed (no App, no request; the index seam is ignored), and the App token is used when
 *      it is configured;
 *  (f) the dry run says what the run says; the row's own commit is never read.
 *
 * Mutations (each proved by hand against the line it guards; the list is in the pull request).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  RECIPE_COMMIT_DELTA_PATH_FLAG,
  findRecipe,
  recipeArguments,
  recipeZarrArguments,
} from "../../shared/compute-recipes";
import { JobSpecSchema } from "../../shared/contract/compute";
import { COMPUTE_PIPELINE_REFUSAL_STATUS } from "../../shared/contract/compute-admin";
import { launchSpecFits } from "../../shared/contract/compute-launch";
import { NON_DATASET_FAILURE_WORDS } from "../src/services/compute-pipeline";
import { recordKey } from "../src/services/compute-records";
import {
  __resetInstallationTokenCacheForTests,
  __seedInstallationTokenCacheForTests,
} from "../src/services/github-auth";
import {
  ZARR_SOURCE_COMMIT_MAX_BYTES,
  ZARR_SOURCE_COMPARE_FILES_LIMIT,
  ZARR_SOURCE_COMPARE_MAX_BYTES,
  ZARR_SOURCE_COMPARE_PAGE,
  ZARR_SOURCE_GITHUB_TIMEOUT_MS,
  ZARR_SOURCE_INDEX_MAX_BYTES,
  ZARR_SOURCE_INDEX_TIMEOUT_MS,
  ZARR_SOURCE_MAX_DELTA_PATHS,
  ZARR_SOURCE_MAX_GITHUB_REQUESTS,
  ZARR_SOURCE_REASONS,
  checkZarrSource,
} from "../src/services/zarr-source-check";
import type { Bindings } from "../src/types/bindings";
import { COMPUTE_KEYS, makeComputeApp, seedComputeUsers } from "./helpers/compute-app";
import { type LifecycleFixture, startLifecycleFixture } from "./helpers/compute-lifecycle-fixture";
import {
  fundPipelines,
  seedEegDataset,
  seedPipelinesAccount,
} from "./helpers/compute-pipeline-fixture";
import {
  type GithubCompareStandin,
  startGithubCompareStandin,
} from "./helpers/github-compare-standin";

// --- The fixture -------------------------------------------------------------------------------------

let fx: LifecycleFixture;
let github: GithubCompareStandin;
const handle = makeComputeApp();
const seams = globalThis as { NEMAR_GITHUB_API_URL?: string; NEMAR_ZARR_INDEX_BASE?: string };

const previousSeams = { github: seams.NEMAR_GITHUB_API_URL, index: seams.NEMAR_ZARR_INDEX_BASE };

beforeAll(async () => {
  fx = await startLifecycleFixture();
  github = startGithubCompareStandin();
  seams.NEMAR_GITHUB_API_URL = github.url;
  seams.NEMAR_ZARR_INDEX_BASE = github.indexBase;
}, 120_000);

beforeEach(async () => {
  github.reset();
  __resetInstallationTokenCacheForTests();
  await fx.reset();
  await seedComputeUsers(fx.harness.db);
});

afterAll(async () => {
  github?.stop();
  seams.NEMAR_GITHUB_API_URL = previousSeams.github;
  seams.NEMAR_ZARR_INDEX_BASE = previousSeams.index;
  await fx?.dispose();
}, 30_000);

/**
 * `development`: compute runs only there and in production, and the check honors its index seam and reads
 * GitHub without the App only outside production.
 */
const devEnv = (over: Partial<Bindings> = {}): Bindings =>
  fx.env({ COMPUTE_RUNNERS_ENABLED: "1", ENVIRONMENT: "development", ...over });

/** The Worker as it runs in production. */
const prodEnv = (over: Partial<Bindings> = {}): Bindings =>
  fx.env({ COMPUTE_RUNNERS_ENABLED: "1", ...over });

// --- Seeds and calls -----------------------------------------------------------------------------------

const T = "0123456789abcdef0123456789abcdef01234567";
const S = "89abcdef0123456789abcdef0123456789abcdef";
const ID = "nm000104";

/** A dataset with a ready serving copy; the tag `v1.0.0` is T and the index is built from `index`. */
async function dataset(
  env: Bindings,
  over: {
    id?: string;
    index?: string | Record<string, unknown> | { http: number };
    tag?: string | { http: number } | null;
    copy?: { status?: string | null; stores?: number | null };
    versions?: Array<[string, string, number | null]>;
  } = {},
): Promise<string> {
  const id = over.id ?? ID;
  await seedEegDataset(env, id, over.versions ? { versions: over.versions } : {});
  await env.DB.prepare(
    "UPDATE datasets SET zarr_status = ?1, zarr_store_count = ?2 WHERE dataset_id = ?3",
  )
    .bind(
      over.copy?.status === undefined ? "ready" : over.copy.status,
      over.copy?.stores === undefined ? 3 : over.copy.stores,
      id,
    )
    .run();
  if (over.tag !== null) github.tag(id, "v1.0.0", over.tag ?? T);
  github.index(id, over.index ?? { source_commit: T, store_count: 3 });
  return id;
}

/** A compare that answers `ahead` with these changed paths. */
const ahead = (...paths: string[]) => ({
  status: "ahead",
  behind_by: 0,
  ahead_by: 1,
  files: paths.map((filename) => ({ filename, status: "modified" })),
});

// biome-ignore lint/suspicious/noExplicitAny: bodies are read field by field
type Loose = Record<string, any>;

interface Reply {
  status: number;
  body: Loose;
}

async function call(
  path: string,
  body: unknown,
  env: Bindings,
  method: "GET" | "POST" = "POST",
): Promise<Reply> {
  const res = await handle(
    new Request(`http://api.test/admin${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${COMPUTE_KEYS.admin}`,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      body: method === "POST" ? JSON.stringify(body) : undefined,
    }),
    env,
  );
  const text = await res.text();
  let parsed: Loose = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: parsed };
}

const run = (env: Bindings, extra: Record<string, unknown> = {}, id = ID) =>
  call(
    "/compute/pipeline/run",
    { recipe: "nemar-floor", dataset: id, executor: "runner", ...extra },
    env,
  );

const n = async (env: Bindings, table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;

/** What a refused dispatch must not have written (the route's own audit row of a refused run is counted apart). */
async function writes(env: Bindings) {
  return {
    jobs: await n(env, "compute_jobs"),
    stamps: await n(env, "compute_pipeline_stamps"),
    ledger: await n(env, "compute_ledger"),
    pools: await n(env, "compute_pools"),
  };
}

/** The specification the dispatch recorded for a job. */
const audits = (env: Bindings) => n(env, "audit_log");

async function specOf(jobId: string) {
  const stored = await fx.harness.records.get(recordKey(jobId, "spec.json"));
  return JobSpecSchema.parse(JSON.parse(await (stored as R2ObjectBody).text()));
}

/** The argument vector the dispatch recorded for a job. */
const argsOf = async (jobId: string): Promise<string[]> => [...(await specOf(jobId)).args];

/** The requests to GitHub (the API paths), and to the index. */
const githubRequests = () => github.log.filter((r) => r.path.startsWith("/repos/"));
const indexRequests = () => github.log.filter((r) => r.path.startsWith("/zarr-index/"));

// --- (a) The verdict -----------------------------------------------------------------------------------------

describe("the verdict", () => {
  test("exact: S is T, the flags say so, no compare is asked, one commit request and one index read (MUTATION: always compare)", async () => {
    const env = devEnv();
    await seedPipelinesAccount(env);
    await dataset(env);
    const r = await run(env);
    expect(r.status).toBe(201);
    const args = await argsOf(r.body.results[0].job_id);
    expect(args).toEqual([
      "--out",
      "/work/outputs/product",
      "--dataset-id",
      ID,
      "--dataset-version",
      "v1.0.0",
      "--source-commit",
      T,
      "--tag-commit",
      T,
      "--commit-equivalence",
      "exact",
      "--image-digest",
      expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      "--zarr-base",
      "https://zarr.nemar.org",
    ]);
    expect(githubRequests().map((q) => q.path)).toEqual([
      `/repos/nemarDatasets/${ID}/commits/refs/tags/v1.0.0`,
    ]);
    expect(indexRequests()).toHaveLength(1);
  });

  test("metadata_only: S is ahead of T by metadata, one --commit-delta-path per path in the compare's order (MUTATION: reverse the order; drop a path)", async () => {
    const env = devEnv();
    await seedPipelinesAccount(env);
    await dataset(env, { index: { source_commit: S } });
    github.compare(
      ID,
      T,
      S,
      ahead(".nemar/manifest.json", ".github/workflows/ci.yml", ".nemar/zarr/index.json"),
    );
    const r = await run(env);
    expect(r.status).toBe(201);
    const args = await argsOf(r.body.results[0].job_id);
    const flags = args.slice(args.indexOf("--source-commit"), args.indexOf("--image-digest"));
    expect(flags).toEqual([
      "--source-commit",
      S,
      "--tag-commit",
      T,
      "--commit-equivalence",
      "metadata_only",
      "--commit-delta-path",
      ".nemar/manifest.json",
      "--commit-delta-path",
      ".github/workflows/ci.yml",
      "--commit-delta-path",
      ".nemar/zarr/index.json",
    ]);
    // The compare is T...S (the tag commit first), one page of at most a hundred files.
    expect(githubRequests().map((q) => [q.path, q.query])).toEqual([
      [`/repos/nemarDatasets/${ID}/commits/refs/tags/v1.0.0`, ""],
      [`/repos/nemarDatasets/${ID}/compare/${T}...${S}`, `per_page=${ZARR_SOURCE_COMPARE_PAGE}`],
    ]);
    // The recorded specification is a valid job that fits the launcher.
    expect(launchSpecFits(await specOf(r.body.results[0].job_id))).toBe(true);
  });

  test("a renamed file lists both of its paths; a rename out of a data path is a mismatch (MUTATION: ignore previous_filename)", async () => {
    const env = devEnv();
    await seedPipelinesAccount(env);
    await dataset(env, { index: { source_commit: S } });
    github.compare(ID, T, S, {
      status: "ahead",
      behind_by: 0,
      files: [{ filename: ".nemar/b.json", status: "renamed", previous_filename: ".nemar/a.json" }],
    });
    const ok = await run(env);
    expect(ok.status).toBe(201);
    const args = await argsOf(ok.body.results[0].job_id);
    expect(args.filter((a) => a.startsWith(".nemar/"))).toEqual([".nemar/b.json", ".nemar/a.json"]);

    await dataset(env, { id: "nm000105", index: { source_commit: S } });
    github.tag("nm000105", "v1.0.0", T);
    github.compare("nm000105", T, S, {
      status: "ahead",
      behind_by: 0,
      files: [
        {
          filename: ".nemar/moved.tsv",
          status: "renamed",
          previous_filename: "sub-01/eeg/sub-01_eeg.edf",
        },
      ],
    });
    const before = await writes(env);
    const bad = await run(env, {}, "nm000105");
    expect([bad.status, bad.body.code]).toEqual([409, "zarr_source_mismatch"]);
    expect(await writes(env)).toEqual(before);
  });

  test("a tag the repository carries without its v is found by the second request, and no more than three requests are ever made (MUTATION: no retry)", async () => {
    const env = devEnv();
    await seedPipelinesAccount(env);
    await dataset(env, { tag: null, index: { source_commit: S } });
    github.tag(ID, "1.0.0", T);
    github.compare(ID, T, S, ahead(".nemar/a.json"));
    const r = await run(env);
    expect(r.status).toBe(201);
    expect(githubRequests().map((q) => q.path)).toEqual([
      `/repos/nemarDatasets/${ID}/commits/refs/tags/v1.0.0`,
      `/repos/nemarDatasets/${ID}/commits/refs/tags/1.0.0`,
      `/repos/nemarDatasets/${ID}/compare/${T}...${S}`,
    ]);
    expect(githubRequests().length).toBeLessThanOrEqual(ZARR_SOURCE_MAX_GITHUB_REQUESTS);
  });

  test("a 422 for the first name is the same answer as a 404 (MUTATION: retry on 404 only)", async () => {
    const env = devEnv();
    await seedPipelinesAccount(env);
    await dataset(env, { tag: { http: 422 } });
    github.tag(ID, "1.0.0", T);
    expect((await run(env)).status).toBe(201);
    expect(githubRequests()).toHaveLength(2);
  });

  test("a tag with no v is not asked for twice", async () => {
    const env = devEnv();
    await dataset(env, { tag: null });
    const checked = await checkZarrSource(env, ID, "latest");
    expect(checked).toMatchObject({ ok: false, code: "zarr_source_mismatch" });
    expect(githubRequests()).toHaveLength(1);
  });
});

// --- (b) The refusals --------------------------------------------------------------------------------------------

describe("a definite mismatch is zarr_source_mismatch and writes nothing", () => {
  const dup = (path: string, count: number) =>
    Array.from({ length: count }, () => ({ filename: path }));
  const many = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ filename: `.nemar/f${i}.json` }));
  // [what happened, the compare GitHub answers, the reason the refusal carries]
  const cases: Array<[string, unknown, string]> = [
    ["the copy is behind the tag", { status: "behind", behind_by: 2, files: [] }, "compare_behind"],
    ["the histories diverged", { status: "diverged", behind_by: 1, files: [] }, "compare_diverged"],
    [
      "the compare says identical for two different commits",
      { status: "identical", behind_by: 0, files: [] },
      "compare_identical",
    ],
    [
      "ahead, but the tag has commits the copy lacks",
      { ...ahead(".nemar/a.json"), behind_by: 1 },
      "compare_behind",
    ],
    [
      "a data path changed",
      ahead(".nemar/a.json", "sub-01/eeg/sub-01_task-x_eeg.edf"),
      "data_path",
    ],
    ["a path under a look-alike root changed", ahead(".nemarx/a.json"), "data_path"],
    ["a root with no slash is a file, not the directory", ahead(".nemar"), "data_path"],
    ["the other root with no slash", ahead(".github"), "data_path"],
    ["a root in capitals is another path", ahead(".NEMAR/x"), "data_path"],
    ["a root in mixed case is another path", ahead(".Github/x"), "data_path"],
    ["a path climbs out of its root", ahead(".nemar/../sub-01/a.edf"), "data_path"],
    ["a path has an empty segment", ahead(".nemar//a.json"), "data_path"],
    ["a path holds a control character", ahead(".nemar/a\nb.json"), "data_path"],
    ["a path is over 512 characters", ahead(`.nemar/${"a".repeat(510)}`), "data_path"],
    [
      "a path holds a lone surrogate (a JSON \\ud800 escape), which no process argument can carry",
      ahead(".nemar/\ud800.json"),
      "delta_path_unsupported",
    ],
    [
      "paths whose launch bytes exceed the bound (11 paths of 500 non-ASCII characters, six bytes each)",
      ahead(...Array.from({ length: 11 }, (_, i) => `.nemar/${i}${"\u00e9".repeat(500)}`)),
      "delta_path_unsupported",
    ],
    [
      "300 files changed (one path repeated, so only the count refuses it)",
      {
        status: "ahead",
        behind_by: 0,
        files: dup(".nemar/a.json", ZARR_SOURCE_COMPARE_FILES_LIMIT),
      },
      "too_many_files",
    ],
    [
      "1000 files changed, of which GitHub lists 300",
      { status: "ahead", behind_by: 0, files: many(1000) },
      "too_many_files",
    ],
    ["33 delta paths", { status: "ahead", behind_by: 0, files: many(33) }, "too_many_delta_paths"],
    [
      `${ZARR_SOURCE_MAX_DELTA_PATHS + 1} delta paths, the most a job's argument vector carries plus one`,
      { status: "ahead", behind_by: 0, files: many(ZARR_SOURCE_MAX_DELTA_PATHS + 1) },
      "too_many_delta_paths",
    ],
    [
      "the commits differ and no file does (the recipe cannot take metadata_only with no path)",
      ahead(),
      "no_delta_path",
    ],
  ];
  for (const [name, compare, reason] of cases) {
    test(`${name} (reason ${reason})`, async () => {
      const env = devEnv();
      await seedPipelinesAccount(env);
      await fundPipelines(env);
      await dataset(env, { index: { source_commit: S } });
      github.compare(ID, T, S, compare as never);
      const before = await writes(env);
      const auditsBefore = await audits(env);
      const r = await run(env);
      expect([r.status, r.body.code, r.body.reason]).toEqual([409, "zarr_source_mismatch", reason]);
      expect(r.body.results?.[0]?.ok ?? false).toBe(false);
      // The route's one audit row of a refused run, as for version_untagged and zarr_copy_not_ready.
      expect(await audits(env)).toBe(auditsBefore + 1);
      // Nothing a dispatch writes: no job, no stamp, no hold, no ledger row, no audit row.
      expect(await writes(env)).toEqual(before);
      // And the same verdict from the dry run, with nothing written either.
      const dry = await run(env, { dry_run: true });
      expect(dry.body.blocked).toMatchObject({
        code: "zarr_source_mismatch",
        version: "v1.0.0",
        reason,
      });
      expect(dry.body.would_dispatch).toEqual([]);
      expect(await writes(env)).toEqual(before);
    });
  }

  test("the boundary the cases above pin from outside: 24 paths dispatch, with all the flags, and a job that fits the launcher (MUTATION: cap at 23)", async () => {
    const env = devEnv();
    await seedPipelinesAccount(env);
    await dataset(env, { index: { source_commit: S } });
    github.compare(ID, T, S, {
      status: "ahead",
      behind_by: 0,
      files: many(ZARR_SOURCE_MAX_DELTA_PATHS),
    });
    const r = await run(env);
    expect(r.status).toBe(201);
    const args = await argsOf(r.body.results[0].job_id);
    expect(args.filter((a) => a === RECIPE_COMMIT_DELTA_PATH_FLAG)).toHaveLength(
      ZARR_SOURCE_MAX_DELTA_PATHS,
    );
    expect(args.length).toBeLessThanOrEqual(64);
    expect(launchSpecFits(await specOf(r.body.results[0].job_id))).toBe(true);
  });

  test("a tag GitHub does not have, under either name, is a mismatch after exactly two requests and no compare (MUTATION: unverifiable)", async () => {
    const env = devEnv();
    await seedPipelinesAccount(env);
    await dataset(env, { tag: null });
    const before = await writes(env);
    const r = await run(env);
    expect([r.status, r.body.code]).toEqual([409, "zarr_source_mismatch"]);
    expect(githubRequests().map((q) => q.path)).toEqual([
      `/repos/nemarDatasets/${ID}/commits/refs/tags/v1.0.0`,
      `/repos/nemarDatasets/${ID}/commits/refs/tags/1.0.0`,
    ]);
    expect(await writes(env)).toEqual(before);
  });

  test("a compare GitHub answers 404 or 422 to (the copy's commit is not in the repository) is a mismatch", async () => {
    const env = devEnv();
    await dataset(env, { index: { source_commit: S } });
    for (const http of [404, 422]) {
      github.compare(ID, T, S, { http });
      expect(await checkZarrSource(env, ID, "v1.0.0")).toMatchObject({
        ok: false,
        code: "zarr_source_mismatch",
      });
    }
  });
});

describe("what cannot be read is zarr_source_unverifiable and writes nothing", () => {
  const cases: Array<[string, (env: Bindings) => Promise<void> | void]> = [
    [
      "the tag lookup answers 502",
      async (env) => void (await dataset(env, { tag: { http: 502 } })),
    ],
    [
      "the tag lookup answers 503",
      async (env) => void (await dataset(env, { tag: { http: 503 } })),
    ],
    [
      "the tag lookup is refused (403)",
      async (env) => void (await dataset(env, { tag: { http: 403 } })),
    ],
    [
      "the tag lookup is throttled (429)",
      async (env) => void (await dataset(env, { tag: { http: 429 } })),
    ],
    [
      "the tag lookup is unauthorized (401)",
      async (env) => void (await dataset(env, { tag: { http: 401 } })),
    ],
    [
      "the tag lookup is a redirect (301)",
      async (env) => void (await dataset(env, { tag: { http: 301 } })),
    ],
    [
      "the tag's commit is not a commit id",
      async (env) => void (await dataset(env, { tag: "main" })),
    ],
    [
      "there is no index",
      async (env) => {
        await dataset(env);
        github.index(ID, { http: 404 });
      },
    ],
    ["the index answers 502", async (env) => void (await dataset(env, { index: { http: 502 } }))],
    ["the index is not JSON", async (env) => void (await dataset(env, { index: "{not json" }))],
    [
      "the index has no source_commit",
      async (env) => void (await dataset(env, { index: { store_count: 3 } })),
    ],
    [
      "the index's source_commit is not a commit id",
      async (env) => void (await dataset(env, { index: { source_commit: T.toUpperCase() } })),
    ],
    ["the index is an array", async (env) => void (await dataset(env, { index: "[1]" }))],
    [
      "the compare answers 502",
      async (env) => {
        await dataset(env, { index: { source_commit: S } });
        github.compare(ID, T, S, { http: 502 });
      },
    ],
    [
      "the compare is refused (403)",
      async (env) => {
        await dataset(env, { index: { source_commit: S } });
        github.compare(ID, T, S, { http: 403 });
      },
    ],
    [
      "the compare has a status no rule names",
      async (env) => {
        await dataset(env, { index: { source_commit: S } });
        github.compare(ID, T, S, { status: "sideways", behind_by: 0, files: [] });
      },
    ],
    [
      "the compare has no behind_by",
      async (env) => {
        await dataset(env, { index: { source_commit: S } });
        github.compare(ID, T, S, { status: "ahead", files: [] } as never);
      },
    ],
    [
      "the compare has no files list",
      async (env) => {
        await dataset(env, { index: { source_commit: S } });
        github.compare(ID, T, S, { status: "ahead", behind_by: 0 });
      },
    ],
    [
      "a compare file has no name",
      async (env) => {
        await dataset(env, { index: { source_commit: S } });
        github.compare(ID, T, S, { status: "ahead", behind_by: 0, files: [{ status: "added" }] });
      },
    ],
    [
      "a compare file's previous name is not a string",
      async (env) => {
        await dataset(env, { index: { source_commit: S } });
        github.compare(ID, T, S, {
          status: "ahead",
          behind_by: 0,
          files: [{ filename: ".nemar/a", previous_filename: 7 }],
        });
      },
    ],
  ];
  // The fixed word each refusal carries with its code.
  const reasons: Record<string, string> = {
    "the tag lookup answers 502": "github_unreadable",
    "the tag lookup answers 503": "github_unreadable",
    "the tag lookup is refused (403)": "github_unreadable",
    "the tag lookup is throttled (429)": "github_unreadable",
    "the tag lookup is unauthorized (401)": "github_unreadable",
    "the tag lookup is a redirect (301)": "github_unreadable",
    "the tag's commit is not a commit id": "github_unreadable",
    "there is no index": "no_index",
    "the index answers 502": "index_unreadable",
    "the index is not JSON": "index_unreadable",
    "the index has no source_commit": "index_commit_unusable",
    "the index's source_commit is not a commit id": "index_commit_unusable",
    "the index is an array": "index_unreadable",
    "the compare answers 502": "github_unreadable",
    "the compare is refused (403)": "github_unreadable",
    "the compare has a status no rule names": "compare_unreadable",
    "the compare has no behind_by": "compare_unreadable",
    "the compare has no files list": "compare_unreadable",
    "a compare file has no name": "compare_unreadable",
    "a compare file's previous name is not a string": "compare_unreadable",
  };
  test("every case names its reason", () => {
    expect(cases.map(([name]) => name).sort()).toEqual(Object.keys(reasons).sort());
  });
  for (const [name, arrange] of cases) {
    test(`${name} (reason ${reasons[name]})`, async () => {
      const env = devEnv();
      await seedPipelinesAccount(env);
      await fundPipelines(env);
      await arrange(env);
      const before = await writes(env);
      const auditsBefore = await audits(env);
      const r = await run(env);
      expect([r.status, r.body.code, r.body.reason]).toEqual([
        503,
        "zarr_source_unverifiable",
        reasons[name],
      ]);
      expect(await audits(env)).toBe(auditsBefore + 1);
      expect(await writes(env)).toEqual(before);
      const dry = await run(env, { dry_run: true });
      expect(dry.body.blocked).toMatchObject({
        code: "zarr_source_unverifiable",
        reason: reasons[name],
      });
      expect(await writes(env)).toEqual(before);
      // Never more than three requests to GitHub, however it went.
      expect(githubRequests().length).toBeLessThanOrEqual(2 * ZARR_SOURCE_MAX_GITHUB_REQUESTS);
    });
  }

  test("a 5xx is asked once: no retry inside the request (MUTATION: maxAttempts 3)", async () => {
    const env = devEnv();
    await dataset(env, { tag: { http: 503 } });
    expect(await checkZarrSource(env, ID, "v1.0.0")).toMatchObject({
      ok: false,
      code: "zarr_source_unverifiable",
    });
    expect(githubRequests()).toHaveLength(1);
    github.reset();
    await dataset(env, { id: "nm000105", index: { source_commit: S } });
    github.compare("nm000105", T, S, { http: 502 });
    expect(await checkZarrSource(env, "nm000105", "v1.0.0")).toMatchObject({
      ok: false,
      code: "zarr_source_unverifiable",
    });
    expect(githubRequests().filter((q) => q.path.includes("/compare/"))).toHaveLength(1);
  });

  test("a mismatch that GitHub proves outranks an index that cannot be read, and a missing tag is never unverifiable", async () => {
    const env = devEnv();
    await dataset(env, { tag: null, index: { http: 502 } });
    expect(await checkZarrSource(env, ID, "v1.0.0")).toMatchObject({
      ok: false,
      code: "zarr_source_mismatch",
    });
  });
});

// --- (c) The bounds ----------------------------------------------------------------------------------------------------

describe("the bounds are literal", () => {
  test("the numbers (MUTATION: any one of them)", () => {
    expect(ZARR_SOURCE_GITHUB_TIMEOUT_MS).toBe(5_000);
    expect(ZARR_SOURCE_INDEX_TIMEOUT_MS).toBe(10_000);
    expect(ZARR_SOURCE_MAX_GITHUB_REQUESTS).toBe(3);
    expect(ZARR_SOURCE_COMMIT_MAX_BYTES).toBe(1024 * 1024);
    expect(ZARR_SOURCE_COMPARE_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(ZARR_SOURCE_INDEX_MAX_BYTES).toBe(64 * 1024 * 1024);
    expect(ZARR_SOURCE_COMPARE_FILES_LIMIT).toBe(300);
    expect(ZARR_SOURCE_COMPARE_PAGE).toBe(100);
    expect(ZARR_SOURCE_MAX_DELTA_PATHS).toBe(24);
    // Sixteen fixed strings and two per path are the most a job's 64 arguments carry.
    expect(16 + 2 * ZARR_SOURCE_MAX_DELTA_PATHS).toBeLessThanOrEqual(64);
    expect(16 + 2 * (ZARR_SOURCE_MAX_DELTA_PATHS + 1)).toBeGreaterThan(64);
  });

  test("a GitHub that stalls is abandoned at the GitHub timeout: unverifiable, in about five seconds (MUTATION: no signal)", async () => {
    const env = devEnv();
    await dataset(env);
    github.stall(ZARR_SOURCE_GITHUB_TIMEOUT_MS + 2_500, "github");
    const started = Date.now();
    const checked = await checkZarrSource(env, ID, "v1.0.0");
    const took = Date.now() - started;
    expect(checked).toMatchObject({ ok: false, code: "zarr_source_unverifiable" });
    expect(took).toBeGreaterThanOrEqual(ZARR_SOURCE_GITHUB_TIMEOUT_MS - 200);
    expect(took).toBeLessThan(ZARR_SOURCE_GITHUB_TIMEOUT_MS + 1_500);
    // One request was made and not repeated: a timeout is not retried.
    expect(githubRequests()).toHaveLength(1);
  }, 20_000);

  test("an index that stalls is abandoned at the index timeout (MUTATION: no signal)", async () => {
    const env = devEnv();
    await dataset(env);
    github.stall(ZARR_SOURCE_INDEX_TIMEOUT_MS + 2_500, "index");
    const started = Date.now();
    const checked = await checkZarrSource(env, ID, "v1.0.0");
    const took = Date.now() - started;
    expect(checked).toMatchObject({ ok: false, code: "zarr_source_unverifiable" });
    expect(took).toBeGreaterThanOrEqual(ZARR_SOURCE_INDEX_TIMEOUT_MS - 200);
    expect(took).toBeLessThan(ZARR_SOURCE_INDEX_TIMEOUT_MS + 1_500);
    expect(indexRequests()).toHaveLength(1);
  }, 30_000);

  test("a commit body over 1 MiB, a compare body over 8 MiB and an index body over 64 MiB are unreadable, not parsed (MUTATION: drop the bound)", async () => {
    const env = devEnv();
    const pad = (bytes: number) => "x".repeat(bytes);
    // Just inside each bound is read; just over is not.
    await dataset(env, { index: { source_commit: S } });
    github.compare(ID, T, S, {
      ...ahead(".nemar/a.json"),
      pad: pad(ZARR_SOURCE_COMPARE_MAX_BYTES - 1024),
    });
    expect(await checkZarrSource(env, ID, "v1.0.0")).toMatchObject({ ok: true });
    github.compare(ID, T, S, {
      ...ahead(".nemar/a.json"),
      pad: pad(ZARR_SOURCE_COMPARE_MAX_BYTES + 1024),
    });
    expect(await checkZarrSource(env, ID, "v1.0.0")).toMatchObject({
      ok: false,
      code: "zarr_source_unverifiable",
    });

    github.compare(ID, T, S, ahead(".nemar/a.json"));
    github.index(ID, { source_commit: T, pad: pad(ZARR_SOURCE_INDEX_MAX_BYTES + 1024) });
    expect(await checkZarrSource(env, ID, "v1.0.0")).toMatchObject({
      ok: false,
      code: "zarr_source_unverifiable",
    });
    github.index(ID, { source_commit: T, pad: pad(2 * 1024 * 1024) });
    expect(await checkZarrSource(env, ID, "v1.0.0")).toMatchObject({ ok: true });
    // The same with no declared length (chunked): the reader's own count stops it.
    const doc = (bytes: number) => JSON.stringify({ source_commit: T, pad: pad(bytes) });
    github.index(ID, { stream: doc(ZARR_SOURCE_INDEX_MAX_BYTES + 1024) });
    expect(await checkZarrSource(env, ID, "v1.0.0")).toMatchObject({
      ok: false,
      code: "zarr_source_unverifiable",
    });
    github.index(ID, { stream: doc(2 * 1024 * 1024) });
    expect(await checkZarrSource(env, ID, "v1.0.0")).toMatchObject({ ok: true });

    // The commit endpoint's body: a 1 MiB bound.
    github.tag(ID, "v1.0.0", { body: { sha: T, pad: pad(ZARR_SOURCE_COMMIT_MAX_BYTES + 1024) } });
    expect(await checkZarrSource(env, ID, "v1.0.0")).toMatchObject({
      ok: false,
      code: "zarr_source_unverifiable",
    });
  }, 60_000);
});

// --- (d) Where the check does not run ------------------------------------------------------------------------------------

describe("the check runs for a Zarr recipe on the newest version of a ready copy and nowhere else", () => {
  test("a BIDS recipe makes no GitHub call and no index read, and its argument vector is the one it was (MUTATION: check every recipe)", async () => {
    const env = devEnv();
    await seedPipelinesAccount(env);
    await fundPipelines(env);
    await seedEegDataset(env, ID);
    const dry = await call(
      "/compute/pipeline/run",
      { recipe: "nemar-floor", dataset: ID, dry_run: true },
      env,
    );
    expect(dry.status).toBe(200);
    expect(dry.body.would_dispatch).toHaveLength(1);
    const live = await call("/compute/pipeline/run", { recipe: "nemar-floor", dataset: ID }, env);
    expect(live.status).toBe(201);
    expect(github.log).toEqual([]);
    const recipe = findRecipe("nemar-floor") as NonNullable<ReturnType<typeof findRecipe>>;
    const args = await argsOf(live.body.results[0].job_id);
    expect(args).toEqual(
      recipeArguments({
        datasetId: ID,
        tag: "v1.0.0",
        imageDigest: args[args.indexOf("--image-digest") + 1] as string,
      }),
    );
    for (const flag of ["--source-commit", "--tag-commit", "--commit-equivalence"]) {
      expect(args).not.toContain(flag);
    }
    expect(recipe.inputs).toContain("bids");
  });

  const TWO = [
    ["1.0.0", "2026-01-01 00:00:00", null],
    ["1.1.0", "2026-02-01 00:00:00", null],
  ] as Array<[string, string, number | null]>;

  test("an older version is zarr_version_not_newest and nothing is read (MUTATION: check before the newest rule)", async () => {
    const env = devEnv();
    await seedPipelinesAccount(env);
    await dataset(env, { versions: TWO });
    const r = await run(env, { version: "1.0.0" });
    expect([r.status, r.body.code]).toEqual([422, "zarr_version_not_newest"]);
    const dry = await run(env, { version: "1.0.0", dry_run: true });
    expect(dry.body.blocked).toMatchObject({ code: "zarr_version_not_newest" });
    expect(github.log).toEqual([]);
  });

  for (const [name, copy] of [
    ["pending", { status: "pending" }],
    ["failed", { status: "failed" }],
    ["never converted", { status: null }],
    ["ready with no store", { status: "ready", stores: 0 }],
    ["ready with no count", { status: "ready", stores: null }],
  ] as const) {
    test(`a copy that is ${name} is zarr_copy_not_ready and nothing is read (MUTATION: check before the ready rule)`, async () => {
      const env = devEnv();
      await seedPipelinesAccount(env);
      await dataset(env, { copy });
      const auditsBefore = await audits(env);
      const r = await run(env);
      expect([r.status, r.body.code]).toEqual([409, "zarr_copy_not_ready"]);
      expect(await audits(env)).toBe(auditsBefore + 1);
      const dry = await run(env, { dry_run: true });
      expect(dry.body.blocked).toMatchObject({ code: "zarr_copy_not_ready" });
      expect(github.log).toEqual([]);
      expect(await n(env, "compute_jobs")).toBe(0);
    });
  }

  test("a dataset that is not eligible is refused before anything is read", async () => {
    const env = devEnv();
    await seedPipelinesAccount(env);
    await dataset(env);
    await env.DB.prepare("UPDATE datasets SET visibility = 'private' WHERE dataset_id = ?1")
      .bind(ID)
      .run();
    const r = await run(env);
    expect(r.body.code).toBe("dataset_not_eligible");
    expect(github.log).toEqual([]);
  });
});

// --- (e) Production ---------------------------------------------------------------------------------------------------------

describe("production fails closed", () => {
  test("with no GitHub App nothing is requested and the answer is unverifiable (MUTATION: fall back to unauthenticated)", async () => {
    const env = prodEnv();
    await seedPipelinesAccount(env);
    await dataset(env);
    const before = await writes(env);
    const r = await run(env);
    expect([r.status, r.body.code]).toEqual([503, "zarr_source_unverifiable"]);
    expect(github.log).toEqual([]);
    expect(await writes(env)).toEqual(before);
  });

  test("an environment that is not named is production too (MUTATION: treat an unknown environment as development)", async () => {
    const env = devEnv({ ENVIRONMENT: "prod-ish" as never });
    await dataset(env);
    const checked = await checkZarrSource(env, ID, "v1.0.0");
    expect(checked).toMatchObject({ ok: false, code: "zarr_source_unverifiable" });
    expect(github.log).toEqual([]);
  });

  test("the index seam is ignored in production: the App is used for GitHub, the index is never read from the stand-in (MUTATION: honor the seam everywhere)", async () => {
    // A seeded installation token stands in for the minted one (the mint itself is GitHub's and is not
    // exercised); the Worker has no S3 configuration, so the index cannot be read the production way.
    __seedInstallationTokenCacheForTests(
      4242,
      "installation-token-for-the-test",
      Date.now() + 3_600_000,
    );
    const env = prodEnv({
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "unused-key-the-cache-answers-first",
      GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: "4242",
    });
    await dataset(env);
    const checked = await checkZarrSource(env, ID, "v1.0.0");
    expect(checked).toMatchObject({ ok: false, code: "zarr_source_unverifiable" });
    expect(indexRequests()).toEqual([]);
    expect(githubRequests().length).toBeGreaterThan(0);
    expect(githubRequests().every((q) => q.authorization === "Bearer")).toBe(true);
  });

  test("outside production the App's token is used when it is configured, and requests are unauthenticated when it is not (MUTATION: never send the token)", async () => {
    __seedInstallationTokenCacheForTests(
      4242,
      "installation-token-for-the-test",
      Date.now() + 3_600_000,
    );
    const withApp = devEnv({
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "unused-key-the-cache-answers-first",
      GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: "4242",
    });
    await dataset(withApp);
    expect(await checkZarrSource(withApp, ID, "v1.0.0")).toMatchObject({ ok: true });
    expect(githubRequests().map((q) => q.authorization)).toEqual(["Bearer"]);
    github.log.length = 0;
    expect(await checkZarrSource(devEnv(), ID, "v1.0.0")).toMatchObject({ ok: true });
    expect(githubRequests().map((q) => q.authorization)).toEqual([null]);
  });

  test("an App that is configured but cannot give a token is unverifiable, never an unauthenticated read (MUTATION: fall back on a failed mint)", async () => {
    // No cached token, and no key that can sign: the mint throws before any request leaves.
    const env = devEnv({
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "not-a-key",
      GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: "4242",
    });
    await dataset(env);
    expect(await checkZarrSource(env, ID, "v1.0.0")).toMatchObject({
      ok: false,
      code: "zarr_source_unverifiable",
    });
    expect(github.log).toEqual([]);
  });
});

// --- (f) The words, and what the row says ---------------------------------------------------------------------------------------

describe("the words", () => {
  test("the statuses, and only the unverifiable word is not the dataset's (MUTATION: list the mismatch; drop the unverifiable)", () => {
    expect(COMPUTE_PIPELINE_REFUSAL_STATUS.zarr_source_mismatch).toBe(409);
    expect(COMPUTE_PIPELINE_REFUSAL_STATUS.zarr_source_unverifiable).toBe(503);
    expect(NON_DATASET_FAILURE_WORDS).toContain("zarr_source_unverifiable");
    expect(NON_DATASET_FAILURE_WORDS).not.toContain("zarr_source_mismatch");
  });

  test("resolveRun no longer reads the dataset row's commit for a Zarr recipe (MUTATION: read zarr_source_commit again)", () => {
    const source = readFileSync(
      new URL("../src/services/compute-pipeline.ts", import.meta.url),
      "utf-8",
    );
    const start = source.indexOf("async function resolveRun(");
    const end = source.indexOf("// --- A result that is not the tuple that was claimed");
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, end);
    expect(body).not.toMatch(/zarr_source_commit|isSourceCommit|ZARR_SOURCE_COMMIT_SQL/);
    expect(source).not.toMatch(/ZARR_SOURCE_COMMIT_SQL/);
    expect(source).not.toMatch(/SELECT[^`]*zarr_source_commit/);
    expect(body).toContain("checkZarrSource(");
  });

  test("the recipe's own rule for an attestation is held by the vector builder (MUTATION: drop a rule)", () => {
    const base = {
      datasetId: ID,
      tag: "v1.0.0",
      imageDigest: `sha256:${"b".repeat(64)}`,
      zarrBase: "https://zarr.nemar.org",
    };
    const ok = { sourceCommit: T, tagCommit: T, equivalence: "exact" as const, deltaPaths: [] };
    expect(() => recipeZarrArguments({ ...base, attestation: ok })).not.toThrow();
    for (const bad of [
      { ...ok, tagCommit: S },
      { ...ok, deltaPaths: [".nemar/a.json"] },
      { ...ok, equivalence: "metadata_only" as const },
      { ...ok, equivalence: "metadata_only" as const, tagCommit: S },
      { ...ok, equivalence: "approximately" as never },
    ]) {
      expect(() => recipeZarrArguments({ ...base, attestation: bad })).toThrow(RangeError);
    }
  });
});

// --- (g) The tag is a tag ----------------------------------------------------------------------------------------------------

describe("the commit is read from the TAG, never from another ref", () => {
  test("a branch named like the tag does not resolve: tag_absent, after the two tag requests and no compare (MUTATION: read commits/<name>)", async () => {
    const env = devEnv();
    await seedPipelinesAccount(env);
    // No tag at all; a branch with each of the two names the lookup tries, pointing at the index's commit.
    await dataset(env, { tag: null, index: { source_commit: T } });
    github.branch(ID, "v1.0.0", T);
    github.branch(ID, "1.0.0", T);
    const before = await writes(env);
    const r = await run(env);
    expect([r.status, r.body.code, r.body.reason]).toEqual([
      409,
      "zarr_source_mismatch",
      "tag_absent",
    ]);
    expect(githubRequests().map((q) => q.path)).toEqual([
      `/repos/nemarDatasets/${ID}/commits/refs/tags/v1.0.0`,
      `/repos/nemarDatasets/${ID}/commits/refs/tags/1.0.0`,
    ]);
    expect(await writes(env)).toEqual(before);
  });

  test("a lightweight tag moved to the copy's parent on the v-less name is still a tag, and a branch cannot take its place (MUTATION: bare name)", async () => {
    const env = devEnv();
    await seedPipelinesAccount(env);
    // The real tag is T; a branch of the same name points at S. The tag decides: T is S's parent here, and the
    // index is built from S, so the verdict is metadata_only over T, never exact over S.
    await dataset(env, { tag: T, index: { source_commit: S } });
    github.branch(ID, "v1.0.0", S);
    github.compare(ID, T, S, ahead(".nemar/a.json"));
    const r = await run(env);
    expect(r.status).toBe(201);
    const args = await argsOf(r.body.results[0].job_id);
    expect(
      args.slice(args.indexOf("--source-commit"), args.indexOf("--commit-delta-path")),
    ).toEqual(["--source-commit", S, "--tag-commit", T, "--commit-equivalence", "metadata_only"]);
  });

  test("a lightweight tag and an annotated tag both resolve to the commit (the endpoint peels the tag object)", async () => {
    const env = devEnv();
    await seedPipelinesAccount(env);
    await dataset(env, { id: "nm000104" });
    await dataset(env, { id: "nm000105" });
    for (const id of ["nm000104", "nm000105"]) {
      const checked = await checkZarrSource(env, id, "v1.0.0");
      expect(checked).toMatchObject({ ok: true, tagCommit: T, equivalence: "exact" });
    }
  });
});

// --- (h) What a job can carry ----------------------------------------------------------------------------------------------

describe("the delta paths always make a job that builds", () => {
  test("24 paths of 512 ASCII characters dispatch and the job fits the launcher (MUTATION: lower the byte cap)", async () => {
    const env = devEnv();
    await seedPipelinesAccount(env);
    await dataset(env, { index: { source_commit: S } });
    const files = Array.from({ length: ZARR_SOURCE_MAX_DELTA_PATHS }, (_, i) => ({
      filename: `.nemar/${String(i).padStart(2, "0")}${"a".repeat(512 - 9)}`,
    }));
    github.compare(ID, T, S, { status: "ahead", behind_by: 0, files });
    const r = await run(env);
    expect(r.status).toBe(201);
    const spec = await specOf(r.body.results[0].job_id);
    expect(launchSpecFits(spec)).toBe(true);
    expect(spec.args.filter((a) => a === RECIPE_COMMIT_DELTA_PATH_FLAG)).toHaveLength(24);
  });

  test("10 paths of 500 non-ASCII characters (six launch bytes each) are just inside the cap and the job builds; 11 are refused (MUTATION: drop the byte cap)", async () => {
    const env = devEnv();
    await seedPipelinesAccount(env);
    await dataset(env, { index: { source_commit: S } });
    const path = (i: number) => `.nemar/${i}${"é".repeat(500)}`;
    github.compare(ID, T, S, ahead(...Array.from({ length: 10 }, (_, i) => path(i))));
    const ok = await run(env);
    expect(ok.status).toBe(201);
    expect(launchSpecFits(await specOf(ok.body.results[0].job_id))).toBe(true);
    // The 24-path case of the same paths would be `invalid_spec` if the cap were not here.
    await dataset(env, { id: "nm000105", index: { source_commit: S } });
    github.compare("nm000105", T, S, ahead(...Array.from({ length: 24 }, (_, i) => path(i))));
    const refused = await run(env, {}, "nm000105");
    expect([refused.status, refused.body.code, refused.body.reason]).toEqual([
      409,
      "zarr_source_mismatch",
      "delta_path_unsupported",
    ]);
  });
});

// --- (i) Credentials, reasons and the user agent -------------------------------------------------------------------------------

describe("credentials, reasons and the user agent", () => {
  const APP = {
    GITHUB_APP_ID: "1",
    GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: "4242",
  } as const;

  test("a token GitHub answers 401 to is dropped from the cache, this dispatch is unverifiable and not re-sent, the next one mints (MUTATION: keep the token)", async () => {
    __seedInstallationTokenCacheForTests(4242, "stale-token-for-the-test", Date.now() + 3_600_000);
    const env = devEnv({ ...APP, GITHUB_APP_PRIVATE_KEY: "not-a-key" });
    await dataset(env, { tag: { http: 401 } });
    expect(await checkZarrSource(env, ID, "v1.0.0")).toMatchObject({
      ok: false,
      code: "zarr_source_unverifiable",
      reason: "github_unreadable",
    });
    // One request, the 401: it was not sent again.
    expect(githubRequests()).toHaveLength(1);
    // The next call has no cached token, so it mints, and this key cannot: a different reason.
    github.log.length = 0;
    expect(await checkZarrSource(env, ID, "v1.0.0")).toMatchObject({
      ok: false,
      code: "zarr_source_unverifiable",
      reason: "token_mint_failed",
    });
    expect(github.log).toEqual([]);
  });

  test("no App in production and an App that cannot mint are told apart (MUTATION: one word for both)", async () => {
    const none = prodEnv();
    await dataset(none);
    expect(await checkZarrSource(none, ID, "v1.0.0")).toMatchObject({
      reason: "no_github_credentials",
    });
    const broken = prodEnv({ ...APP, GITHUB_APP_PRIVATE_KEY: "not-a-key" });
    expect(await checkZarrSource(broken, ID, "v1.0.0")).toMatchObject({
      reason: "token_mint_failed",
    });
    expect(github.log).toEqual([]);
  });

  test("outside production a request says it is the local stack; in production it says it is the Worker (MUTATION: one agent for both)", async () => {
    await dataset(devEnv());
    expect(await checkZarrSource(devEnv(), ID, "v1.0.0")).toMatchObject({ ok: true });
    expect(github.log.map((q) => q.userAgent)).toEqual([
      "nemar-local-stack/0",
      "nemar-local-stack/0",
    ]);
    github.log.length = 0;
    __seedInstallationTokenCacheForTests(
      4242,
      "installation-token-for-the-test",
      Date.now() + 3_600_000,
    );
    const prod = prodEnv({ ...APP, GITHUB_APP_PRIVATE_KEY: "unused-key-the-cache-answers-first" });
    await checkZarrSource(prod, ID, "v1.0.0");
    expect(githubRequests().map((q) => q.userAgent)).toEqual(["NEMAR-API"]);
  });

  test("every reason is a fixed word of this file", () => {
    for (const word of ZARR_SOURCE_REASONS) expect(word).toMatch(/^[a-z_]+$/);
    expect(new Set(ZARR_SOURCE_REASONS).size).toBe(ZARR_SOURCE_REASONS.length);
  });
});
