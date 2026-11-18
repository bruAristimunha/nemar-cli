/**
 * The derivative store (portable compute, card V1b; ADR 0123 as amended 2026-11-16; plan D14), against NEMAR's
 * REAL routes and services: the admin router behind its real authentication, over a real migrated database
 * (bun:sqlite behind `realD1`), Miniflare's R2 through the Worker's own bindings for the records, results and
 * derivatives buckets, the one real S3-interface stand-in over those three buckets (the endpoint the signer
 * addresses, which no test can reach on R2), and one real loopback server for the two EXTERNAL services the Zarr
 * source check reads (GitHub, and the serving copy's index). Nothing of NEMAR is stood in for. What is played is
 * a container's end: a runner job is dispatched through the real `dispatchPipelineJob`, then its product and the
 * launcher's manifest are written to the results bucket where the launcher would have uploaded them and its state
 * is set with SQL the table accepts (the runner's own path to `finished` is `compute-runner-queue.test.ts`'s),
 * and the real stamp sync reads the record. The one misbehavior played at the EXTERNAL boundary is a derivatives
 * bucket that stores half of what a copy sends (`lossyBucket`), which is what a copy that ended short is.
 *
 * Every case that names a MUTATION is held by that line: remove it and the case fails.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { findRecipe, recipeRequiredOutputs } from "../../shared/compute-recipes";
import { resultsLauncherKey, resultsOutputKey } from "../../shared/contract/compute-launch";
import {
  CANARY_DAYS,
  SERVING_PROFILE_SENTENCE,
  derivativeKey,
  derivativeKeyText,
  inputDigest,
  inputDigestV2,
} from "../../shared/contract/derivatives";
import { AUDIT_IF_PREVIOUS_CHANGED_SQL } from "../src/db/audit-log";
import {
  ADVANCE_COPIED_SQL,
  INSERT_DERIVATIVE_SQL,
  PROMOTE_CATALOG_SQL,
  SKIP_STAMP_SQL,
  STORE_ROW_SQL,
  SUPERSEDE_CATALOG_SQL,
  UNKEYABLE_WORDS,
  derivativesLogLine,
  promoteDerivative,
  runComputeDerivativesCron,
  syncDerivatives,
} from "../src/services/compute-derivatives";
import { dispatchPipelineJob, syncPipelineStamps } from "../src/services/compute-pipeline";
import { recordKey, sha256Hex } from "../src/services/compute-records";
import {
  ComputeS3Error,
  computeS3,
  copyObject,
  presignGet,
  presignPut,
} from "../src/services/compute-s3";
import { deleteDatasetCascade } from "../src/services/deletion";
import type { Bindings } from "../src/types/bindings";
import {
  COMPUTE_KEYS,
  type ComputeWho,
  makeComputeApp,
  seedComputeUsers,
} from "./helpers/compute-app";
import { HARNESS_BUCKETS } from "./helpers/compute-harness";
import { type LifecycleFixture, startLifecycleFixture } from "./helpers/compute-lifecycle-fixture";
import {
  fundPipelines,
  recipeRecord,
  seedEegDataset,
  seedPipelinesAccount,
} from "./helpers/compute-pipeline-fixture";
import { type ComputeS3Standin, startComputeS3Standin } from "./helpers/compute-s3-standin";
import { seedUser } from "./helpers/compute-seed";
import {
  type GithubCompareStandin,
  startGithubCompareStandin,
} from "./helpers/github-compare-standin";
import { logged } from "./helpers/logs";
import { retryInfrastructure } from "./helpers/neurobagel-harness";

// --- The world -------------------------------------------------------------------------------------------------

const DERIVATIVES_BUCKET = "nemar-compute-derivatives";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SOURCE = "fedcba9876543210fedcba9876543210fedcba98";
const READER = "eegprep-lean@0.3.1+89abcdef0123456789abcdef0123456789abcdef";
const STORES = ["sub-01/eeg/sub-01_task-rest_eeg.edf", "sub-02/eeg/sub-02_task-rest_eeg.edf"];
const CONTENT = "ab".repeat(32);
const LOCATIONS = "cd".repeat(32);
const ADMIN = { kind: "admin", userId: 1 } as const;

let fx: LifecycleFixture;
let derivatives: R2Bucket;
let derivativesHost: Miniflare;
let standin: ComputeS3Standin;
let github: GithubCompareStandin;
const handle = makeComputeApp();
/**
 * What the played derivatives bucket does to a copy, by key: store half of it (`truncate`), store the same
 * number of bytes with one flipped (`corrupt`), or let something happen first (`beforePut`, which stands for
 * the rest of the world moving while a copy is in flight).
 */
const lossy = {
  truncate: (_key: string): boolean => false,
  corrupt: (_key: string): boolean => false,
  beforePut: async (_key: string): Promise<void> => {},
};
const resetLossy = () => {
  lossy.truncate = () => false;
  lossy.corrupt = () => false;
  lossy.beforePut = async () => {};
};
/** A second bucket the S3 interface serves, for a binding and a bucket name that do not agree. */
const ELSEWHERE_BUCKET = "nemar-compute-elsewhere";
let elsewhere: R2Bucket;
const seams = globalThis as {
  NEMAR_GITHUB_API_URL?: string;
  NEMAR_ZARR_INDEX_BASE?: string;
  NEMAR_COMPUTE_S3_URL?: string;
};
const previous = {
  github: seams.NEMAR_GITHUB_API_URL,
  index: seams.NEMAR_ZARR_INDEX_BASE,
  s3: seams.NEMAR_COMPUTE_S3_URL,
};

/** A derivatives bucket whose copies go wrong as `lossy` says, by key. */
function lossyBucket(real: R2Bucket): R2Bucket {
  return {
    get: (k: string) => real.get(k),
    head: (k: string) => real.head(k),
    list: (o?: Parameters<R2Bucket["list"]>[0]) => real.list(o),
    delete: (k: string | string[]) => real.delete(k),
    put: async (k: string, v: Uint8Array | string, o?: Parameters<R2Bucket["put"]>[2]) => {
      await lossy.beforePut(k);
      let body = v;
      if (typeof v !== "string" && lossy.truncate(k)) {
        body = v.slice(0, Math.max(1, Math.floor(v.length / 2)));
      } else if (typeof v !== "string" && lossy.corrupt(k)) {
        body = Uint8Array.from(v);
        body[0] = (body[0] as number) ^ 1;
      }
      return real.put(k, body, o);
    },
  } as unknown as R2Bucket;
}

async function emptyBucket(bucket: R2Bucket): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ cursor });
    const keys = listed.objects.map((o) => o.key);
    if (keys.length > 0) await bucket.delete(keys);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

const emptyDerivatives = async (): Promise<void> => {
  await emptyBucket(derivatives);
  await emptyBucket(elsewhere);
};

beforeAll(async () => {
  fx = await startLifecycleFixture();
  github = startGithubCompareStandin();
  seams.NEMAR_GITHUB_API_URL = github.url;
  seams.NEMAR_ZARR_INDEX_BASE = github.indexBase;
  const infra = await retryInfrastructure("miniflare", async () => {
    const mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      compatibilityDate: "2024-12-01",
      r2Buckets: ["COMPUTE_DERIVATIVES", "COMPUTE_ELSEWHERE"],
    });
    try {
      const bucket = (await mf.getR2Bucket("COMPUTE_DERIVATIVES")) as unknown as R2Bucket;
      const other = (await mf.getR2Bucket("COMPUTE_ELSEWHERE")) as unknown as R2Bucket;
      await bucket.list({ limit: 1 });
      await other.list({ limit: 1 });
      return { mf, bucket, other };
    } catch (err) {
      await mf.dispose().catch(() => {});
      throw err;
    }
  });
  derivativesHost = infra.mf;
  derivatives = infra.bucket;
  elsewhere = infra.other;
  // The S3 interface over the three buckets: a server-side copy goes from the results bucket to this one.
  standin = startComputeS3Standin({
    accessKeyId: fx.harness.standin.accessKeyId,
    secretAccessKey: fx.harness.standin.secretAccessKey,
    buckets: {
      [HARNESS_BUCKETS.records]: fx.harness.records,
      [HARNESS_BUCKETS.results]: fx.harness.results,
      [DERIVATIVES_BUCKET]: lossyBucket(derivatives),
      [ELSEWHERE_BUCKET]: elsewhere,
    },
  });
  seams.NEMAR_COMPUTE_S3_URL = standin.url;
}, 120_000);

beforeEach(async () => {
  github.reset();
  await fx.reset();
  await emptyDerivatives();
  standin.log.length = 0;
  standin.clearFailures();
  resetLossy();
  await seedComputeUsers(fx.harness.db);
});

afterAll(async () => {
  github?.stop();
  seams.NEMAR_GITHUB_API_URL = previous.github;
  seams.NEMAR_ZARR_INDEX_BASE = previous.index;
  seams.NEMAR_COMPUTE_S3_URL = previous.s3;
  standin?.stop();
  await derivativesHost?.dispose();
  await fx?.dispose();
}, 30_000);

/** Development: compute runs there; the store is bound unless a case says it is not. */
const envOf = (over: Partial<Bindings> = {}): Bindings =>
  fx.env({
    ENVIRONMENT: "development",
    COMPUTE_RUNNERS_ENABLED: "1",
    COMPUTE_DERIVATIVES: derivatives,
    COMPUTE_DERIVATIVES_BUCKET_NAME: DERIVATIVES_BUCKET,
    ...over,
  });

let seq = 0;
const freshId = () => `nm${String(30_000 + ++seq).padStart(6, "0")}`;

/** A public EEG dataset whose Zarr copy is ready and whose tag and index name `COMMIT`. */
async function dataset(id = freshId()): Promise<string> {
  const env = envOf();
  // A real owner: the cascade refuses a dataset the catalog sentinel owns.
  await seedEegDataset(env, id, { owner: await seedUser(env.DB, {}) });
  github.tag(id, "v1.0.0", COMMIT);
  github.index(id, { source_commit: COMMIT, store_count: 3 });
  await env.DB.prepare(
    "UPDATE datasets SET zarr_source_commit = ?1, zarr_status = 'ready', zarr_store_count = 3 WHERE dataset_id = ?2",
  )
    .bind(COMMIT, id)
    .run();
  return id;
}

/** A newer version of a dataset, taggable and readable by the same Zarr copy. */
async function newerVersion(id: string, version: string): Promise<void> {
  await envOf()
    .DB.prepare(
      `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at)
       VALUES (?1, ?2, ?3, 'ezid', '2026-06-01 00:00:00')`,
    )
    .bind(id, version, `10.82901/nemar.${id}.v${version}`)
    .run();
  github.tag(id, `v${version}`, COMMIT);
}

const dispatch = (
  env: Bindings,
  id: string,
  over: Partial<Parameters<typeof dispatchPipelineJob>[1]> = {},
) => dispatchPipelineJob(env, { recipe: "nemar-floor", datasetId: id, actor: ADMIN, ...over });

const enc = (text: string) => new TextEncoder().encode(text);

interface Row {
  path: unknown;
  group: unknown;
  content_sha256: unknown;
  locations?: unknown;
}

const rowsOf = (paths: string[]): Row[] =>
  paths.map((path) => ({ path, group: "eeg", content_sha256: CONTENT, locations: LOCATIONS }));

const TABLE_HEADER = "path\tdatatype\tstatus\tcode\tstep\tdetail";
const tableOf = (codes: string[] = []): string =>
  `${[
    TABLE_HEADER,
    ...STORES.map((p) => `${p}\teeg\tsucceeded\tn/a\tn/a\tn/a`),
    ...codes.map((c, i) => `sub-0${i + 3}/eeg/x.edf\teeg\tfailed\t${c}\tload\tn/a`),
  ].join("\n")}\n`;

interface ZarrJobOptions {
  id?: string;
  /** Rows of `stores_content`; default two stores read with locations. */
  rows?: unknown;
  stores?: unknown;
  unread?: unknown;
  /** The digest the record states (and the stamp stores); default `inputDigestV2` of the rows. */
  digest?: string;
  /** Set the stamp's digest to this after the sync (a stamp the card's Q0b check would not have stored). */
  stampDigest?: string | null;
  codes?: string[];
  /** Extra product files besides the record and the table; default 3, five files in all. */
  extra?: number;
  /** Add `--recording <path>` to the recorded specification. */
  recording?: boolean;
  /** More product files, by relative path (a manifest that lists `derivative.json`, say). */
  names?: string[];
  process?: unknown;
}

interface Made {
  id: string;
  jobId: string;
  stampId: number;
  version: string;
  /** The product's relative paths and bytes, as the launcher uploaded them. */
  files: Map<string, string>;
}

/** The product, its manifest and the finished state of a job the real dispatch made. */
async function finishJob(
  env: Bindings,
  jobId: string,
  id: string,
  recordText: string,
  table: string,
  extra: number,
  names: string[] = [],
): Promise<Map<string, string>> {
  const floor = findRecipe("nemar-floor") as NonNullable<ReturnType<typeof findRecipe>>;
  const wanted = recipeRequiredOutputs(floor);
  const files = new Map<string, string>([
    [wanted.record, recordText],
    [wanted.table, table],
  ]);
  for (let n = 1; n <= extra; n++)
    files.set(`product/sub-0${n}_qc.json`, JSON.stringify({ n, id }));
  for (const name of names) files.set(`product/${name}`, JSON.stringify({ name, id }));
  const manifest: Array<{ path: string; size: number; sha256: string }> = [];
  for (const [path, text] of files) {
    const bytes = enc(text);
    await fx.harness.results.put(resultsOutputKey(jobId, path), bytes);
    manifest.push({ path, size: bytes.length, sha256: await sha256Hex(bytes) });
  }
  await fx.harness.results.put(
    resultsLauncherKey(jobId, "manifest.json"),
    enc(JSON.stringify({ job_id: jobId, files: manifest })),
  );
  await env.DB.prepare(
    "UPDATE compute_jobs SET state = 'finished', ended_at = datetime('now') WHERE id = ?1",
  )
    .bind(jobId)
    .run();
  return new Map([...files].map(([path, text]) => [path.slice("product/".length), text]));
}

/** A Zarr run of `nemar-floor`, dispatched for real and finished, its stamp synced by the real sync. */
async function zarrJob(o: ZarrJobOptions = {}): Promise<Made> {
  const env = envOf();
  // NEMAR's own jobs are made for the service account, whatever executor runs them.
  await seedPipelinesAccount(env, { reuse: true });
  await fundPipelines(env);
  const id = o.id ?? (await dataset());
  const r = await dispatch(env, id, { executor: "runner" });
  if (!r.ok) throw new Error(`not dispatched: ${r.code}`);
  const version = r.version;
  const rows = o.rows ?? rowsOf(STORES);
  let digest = o.digest;
  if (digest === undefined) {
    try {
      digest = await inputDigestV2(rows as never);
    } catch {
      digest = `sha256:${"0123456789abcdef".repeat(4)}`;
    }
  }
  const record = recipeRecord({
    dataset: { id, version, source_commit: COMMIT },
    reader: READER,
    process:
      o.process === undefined ? { build: "nemar-process-test", image_tag: "test" } : o.process,
    input: {
      kind: "zarr",
      zarr_engine_version: "0.4.2",
      input_digest: digest,
      stores: o.stores ?? STORES,
      stores_content: rows,
      stores_unread: o.unread ?? [],
    },
  });
  const files = await finishJob(
    env,
    r.jobId,
    id,
    record,
    tableOf(o.codes),
    o.extra ?? 3,
    o.names ?? [],
  );
  if (o.recording) {
    const key = recordKey(r.jobId, "spec.json");
    const spec = JSON.parse((await (await fx.harness.records.get(key))?.text()) as string);
    spec.args = [...spec.args, "--recording", STORES[0]];
    const bytes = enc(JSON.stringify(spec));
    await fx.harness.records.put(key, bytes);
    await env.DB.prepare("UPDATE compute_jobs SET spec_digest = ?1 WHERE id = ?2")
      .bind(await sha256Hex(bytes), r.jobId)
      .run();
  }
  const sync = await syncPipelineStamps(env);
  if (sync.succeeded !== 1) throw new Error(`the stamp did not succeed: ${JSON.stringify(sync)}`);
  // The stamp's own coverage check (card Q0b) stores a Zarr digest only when the record shows it whole, and
  // the derivative store repeats every check itself. A case that fails one of them alone needs a stamp that
  // holds the record's digest anyway, so it is set here, in the shape of its column, unless the case says
  // what the stamp holds (a digest, or none).
  const held =
    o.stampDigest === undefined
      ? (
          await env.DB.prepare("SELECT input_digest FROM compute_pipeline_stamps WHERE id = ?1")
            .bind(r.stampId)
            .first<{ input_digest: string | null }>()
        )?.input_digest === null
        ? digest
        : undefined
      : o.stampDigest;
  if (held !== undefined) {
    await env.DB.prepare("UPDATE compute_pipeline_stamps SET input_digest = ?1 WHERE id = ?2")
      .bind(held, r.stampId)
      .run();
  }
  return { id, jobId: r.jobId, stampId: r.stampId, version, files };
}

/** A BIDS run (Tapis) of `nemar-floor`, finished the same way. */
async function bidsJob(over: { sourceCommit?: string; stampDigest?: string } = {}): Promise<Made> {
  const env = envOf();
  await seedPipelinesAccount(env, { reuse: true });
  await fundPipelines(env);
  const id = await dataset();
  const r = await dispatch(env, id);
  if (!r.ok) throw new Error(`not dispatched: ${r.code}`);
  const record = recipeRecord({
    dataset: { id, version: r.version, source_commit: over.sourceCommit ?? SOURCE },
  });
  const files = await finishJob(env, r.jobId, id, record, tableOf(), 1);
  const sync = await syncPipelineStamps(env);
  if (sync.succeeded !== 1) throw new Error("the stamp did not succeed");
  if (over.stampDigest !== undefined) {
    await env.DB.prepare("UPDATE compute_pipeline_stamps SET input_digest = ?1 WHERE id = ?2")
      .bind(over.stampDigest, r.stampId)
      .run();
  }
  return { id, jobId: r.jobId, stampId: r.stampId, version: r.version, files };
}

// --- Reads -----------------------------------------------------------------------------------------------------

interface Der {
  key: string;
  dataset_id: string;
  version: string;
  state: string;
  retention: string;
  failure: string | null;
  copied: number;
  object_count: number;
  bytes: number;
  attempts: number;
  last_attempt_at: string | null;
  ended_at: string | null;
  stored_at: string | null;
  superseded_at: string | null;
  expires_at: string | null;
  doi: string | null;
  stamp_id: number;
  job_id: string;
  image_digest: string;
  input_digest: string;
}

const all = async (env: Bindings, where = "1 = 1"): Promise<Der[]> =>
  (
    await env.DB.prepare(
      `SELECT * FROM compute_derivatives WHERE ${where} ORDER BY created_at, key`,
    ).all<Der>()
  ).results;

const one = async (env: Bindings, where = "1 = 1"): Promise<Der> => {
  const rows = await all(env, where);
  expect(rows).toHaveLength(1);
  return rows[0] as Der;
};

const keysUnder = async (key: string): Promise<string[]> => {
  const listed = await derivatives.list({ prefix: `d/${key}/` });
  return listed.objects.map((o) => o.key).sort();
};

const copiesMade = () =>
  standin.log.filter((r) => r.op === "CopyObject" && r.bucket === DERIVATIVES_BUCKET).length;

const sql = async (env: Bindings, text: string, ...binds: unknown[]) =>
  env.DB.prepare(text)
    .bind(...binds)
    .run();

const syncAll = async (env: Bindings, over: { maxObjects?: number; maxDeletes?: number } = {}) => {
  const r = await syncDerivatives(env, over);
  if (!r.available) throw new Error("the store is dark");
  return r;
};

/** A day passes over a row that ended: what a later sync, a day on, finds. */
const settle = (env: Bindings, key: string) =>
  sql(
    env,
    "UPDATE compute_derivatives SET ended_at = datetime('now', '-2 days') WHERE key = ?1",
    key,
  );

const keyOfStamp = async (env: Bindings, stampId: number): Promise<string> => {
  const s = await env.DB.prepare(
    "SELECT dataset_id, version, recipe, recipe_version, engine, input, input_digest FROM compute_pipeline_stamps WHERE id = ?1",
  )
    .bind(stampId)
    .first<Record<string, string>>();
  const x = s as Record<string, string>;
  return derivativeKey({
    dataset: x.dataset_id as string,
    version: x.version as string,
    recipe: x.recipe as string,
    recipe_version: x.recipe_version as string,
    engine: x.engine as string,
    input: x.input as string,
    profile: x.input === "zarr" ? "serving" : "archive",
    input_digest: x.input_digest as string,
  });
};

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  method: "GET" | "POST",
  path: string,
  who: ComputeWho,
  body?: unknown,
  env: Bindings = envOf(),
): Promise<Reply> {
  const res = await handle(
    new Request(`http://api.test/admin${path}`, {
      method,
      headers: { Authorization: `Bearer ${COMPUTE_KEYS[who]}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
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

const retention = (key: string, who: ComputeWho, klass: unknown, env?: Bindings) =>
  call("POST", `/compute/derivatives/${key}/retention`, who, { class: klass }, env);

// --- A first derivative -------------------------------------------------------------------------------------------

describe("a finished Zarr job becomes a stored derivative", () => {
  test("its key is derivativeKey of its stamp, its objects match the manifest, and it says what it is", async () => {
    const env = envOf();
    const made = await zarrJob();
    const result = await syncAll(env);
    expect(result).toMatchObject({
      examined: 1,
      created: 1,
      copied: 5,
      stored: 1,
      failed: 0,
      errored: 0,
      duplicate: 0,
    });
    const row = await one(env);
    expect(row.key).toBe(await keyOfStamp(env, made.stampId));
    expect(row).toMatchObject({
      dataset_id: made.id,
      version: "v1.0.0",
      state: "stored",
      retention: "canary",
      failure: null,
      copied: 5,
      object_count: 5,
      doi: null,
      superseded_at: null,
      job_id: made.jobId,
      stamp_id: made.stampId,
    });
    expect(row.image_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(row.input_digest).toBe(await inputDigestV2(rowsOf(STORES) as never));
    // The canary's date is its stored time plus 30 days, on SQLite's one clock.
    const span = await env.DB.prepare(
      "SELECT julianday(expires_at) - julianday(stored_at) AS days FROM compute_derivatives WHERE key = ?1",
    )
      .bind(row.key)
      .first<{ days: number }>();
    expect(Math.round((span as { days: number }).days)).toBe(CANARY_DAYS);

    // The objects: the manifest's product files, byte for byte, and the description.
    expect(await keysUnder(row.key)).toEqual(
      [
        ...[...made.files.keys()].map((p) => `d/${row.key}/${p}`),
        `d/${row.key}/derivative.json`,
      ].sort(),
    );
    for (const [path, text] of made.files) {
      const object = await derivatives.get(`d/${row.key}/${path}`);
      expect(await object?.text()).toBe(text);
    }
    const description = JSON.parse(
      (await (await derivatives.get(`d/${row.key}/derivative.json`))?.text()) as string,
    );
    expect(description.key).toBe(row.key);
    expect(description.key_text).toBe(
      derivativeKeyText({
        dataset: made.id,
        version: "v1.0.0",
        recipe: "nemar-floor",
        recipe_version: "1.0.0",
        engine: "eegprep@0.5.0",
        input: "zarr",
        profile: "serving",
        input_digest: row.input_digest,
      }),
    );
    expect(description.GeneratedBy).toMatchObject({
      recipe: "nemar-floor",
      recipe_version: "1.0.0",
      image_digest: row.image_digest,
      job_id: made.jobId,
      process: { build: "nemar-process-test", image_tag: "test" },
    });
    expect(description.SourceDatasets).toEqual([
      { id: made.id, version: "v1.0.0", doi: `10.82901/nemar.${made.id}.v1.0.0` },
    ]);
    expect(description.Profile).toBe("serving");
    expect(description.Description).toBe(SERVING_PROFILE_SENTENCE);
    expect(description.Citation).toBe(
      `Derived from ${made.id} version v1.0.0 (DOI 10.82901/nemar.${made.id}.v1.0.0) by NEMAR's nemar-floor 1.0.0.`,
    );
    expect(description.files).toHaveLength(5);
    // It never states an archived recording's rate.
    expect(JSON.stringify(description)).not.toMatch(/srate|sampling_rate|"rate"/i);
    // The store makes no DOI and the bucket is reached by a server-side copy only: five copies, no presigned address.
    expect(copiesMade()).toBe(5);
    expect(standin.log.some((r) => r.presigned)).toBe(false);
  });

  test("a run with maxObjects 2 over five files needs three syncs, each object copied once", async () => {
    const env = envOf();
    const made = await zarrJob();
    const first = await syncAll(env, { maxObjects: 2 });
    expect(first).toMatchObject({ created: 1, copied: 2, stored: 0 });
    expect(await one(env)).toMatchObject({
      state: "copying",
      copied: 2,
      stored_at: null,
      expires_at: null,
    });
    const second = await syncAll(env, { maxObjects: 2 });
    expect(second).toMatchObject({ created: 0, copied: 2, stored: 0 });
    expect((await one(env)).copied).toBe(4);
    const third = await syncAll(env, { maxObjects: 2 });
    expect(third).toMatchObject({ copied: 1, stored: 1 });
    const row = await one(env);
    expect(row).toMatchObject({ state: "stored", copied: 5 });
    expect(row.stored_at).not.toBeNull();
    expect(copiesMade()).toBe(5);
    expect(await keysUnder(row.key)).toHaveLength(6);
    // Nothing is left to do: a fourth sync copies nothing.
    expect(await syncAll(env)).toMatchObject({ examined: 0, copied: 0, created: 0 });
    expect(copiesMade()).toBe(5);
    void made;
  });

  test("a second job with the same key adds no row and copies nothing, and the stamp is not read again (MUTATION: remove the conflict clause on key)", async () => {
    const env = envOf();
    const first = await zarrJob();
    await syncAll(env);
    const row = await one(env);
    const copies = copiesMade();
    // The first run's stamp ends (an owner's repair, say) and the same dataset version is run again, reading
    // the same stores: a second stamp, a second job, the same key.
    await sql(
      env,
      "UPDATE compute_pipeline_stamps SET state = 'failed', refusal_code = 'job_failed' WHERE id = ?1",
      first.stampId,
    );
    const second = await zarrJob({ id: first.id });
    expect(second.stampId).not.toBe(first.stampId);
    expect(await keyOfStamp(env, second.stampId)).toBe(row.key);

    const result = await syncAll(env);
    expect(result).toMatchObject({
      examined: 1,
      created: 0,
      duplicate: 1,
      copied: 0,
      errored: 0,
      stored: 0,
    });
    expect(await all(env)).toHaveLength(1);
    expect((await one(env)).stamp_id).toBe(first.stampId);
    expect(copiesMade()).toBe(copies);
    // The decision is remembered, so the second stamp is not examined again.
    const skip = await env.DB.prepare(
      "SELECT word FROM compute_derivative_skips WHERE stamp_id = ?1",
    )
      .bind(second.stampId)
      .first<{ word: string }>();
    expect(skip?.word).toBe("duplicate_key");
    expect(await syncAll(env)).toMatchObject({ examined: 0, duplicate: 0 });
  });

  test("a copy the bucket stored short ends the row failed with copy_mismatch and nothing is left under the key", async () => {
    const env = envOf();
    await zarrJob();
    // The second file in path order is the one stored short; the first was copied whole before it.
    lossy.truncate = (k) => k.endsWith("sub-01_qc.json");
    const result = await syncAll(env);
    expect(result).toMatchObject({ created: 1, failed: 1, stored: 0, errored: 0 });
    expect(result.copied).toBeGreaterThanOrEqual(1);
    const row = await one(env);
    expect(row).toMatchObject({
      state: "failed",
      failure: "copy_mismatch",
      stored_at: null,
      expires_at: null,
    });
    expect(await keysUnder(row.key)).toEqual([]);
    expect(result.deleted).toBeGreaterThanOrEqual(2);
    // A row that has just ended keeps its count for a day (a copy in flight could still land): it is listed
    // again, found empty, and only then set to 0.
    expect(row.copied).toBeGreaterThan(0);
    expect(row.ended_at).not.toBeNull();
    await settle(env, row.key);
    await syncAll(env);
    expect((await one(env)).copied).toBe(0);
    // A failed row is final for its key: it is never copied again.
    lossy.truncate = () => false;
    expect(await syncAll(env)).toMatchObject({ copied: 0, created: 0, failed: 0 });
    expect(await keysUnder(row.key)).toEqual([]);
  });

  test("a copy the S3 interface refuses leaves the row copying and the next sync finishes it", async () => {
    const env = envOf();
    await zarrJob();
    standin.failWith({ op: "CopyObject", bucket: DERIVATIVES_BUCKET, status: 500, times: 1 });
    const first = await syncAll(env);
    expect(first).toMatchObject({ created: 1, copied: 0, later: 1, failed: 0, stored: 0 });
    expect(await one(env)).toMatchObject({ state: "copying", copied: 0 });
    const second = await syncAll(env);
    expect(second).toMatchObject({ copied: 5, stored: 1 });
    expect((await one(env)).state).toBe("stored");
  });

  test("a source object that is gone ends the row failed with source_missing and cleans up", async () => {
    const env = envOf();
    const made = await zarrJob();
    await syncAll(env, { maxObjects: 2 });
    const row = await one(env);
    expect(row.copied).toBe(2);
    // The results bucket expires its objects: the third file in path order is no longer there.
    const files = [...made.files.keys()].sort();
    await fx.harness.results.delete(resultsOutputKey(made.jobId, `product/${files[2]}`));
    const result = await syncAll(env);
    expect(result).toMatchObject({ failed: 1, stored: 0 });
    expect(await one(env)).toMatchObject({ state: "failed", failure: "source_missing" });
    expect(await keysUnder(row.key)).toEqual([]);
  });
});

// --- Retention ----------------------------------------------------------------------------------------------------------

describe("retention", () => {
  async function stored(over: ZarrJobOptions = {}): Promise<{ made: Made; row: Der }> {
    const env = envOf();
    const made = await zarrJob(over);
    await syncAll(env);
    const row = await one(env, `stamp_id = ${made.stampId}`);
    expect(row.state).toBe("stored");
    return { made, row };
  }

  test("a canary row past 30 days is expired, its objects deleted and its row kept", async () => {
    const env = envOf();
    const { row } = await stored();
    // Not yet due: nothing happens.
    expect(await syncAll(env)).toMatchObject({ expired: 0, deleted: 0 });
    await sql(
      env,
      "UPDATE compute_derivatives SET stored_at = datetime('now', '-31 days'), expires_at = datetime('now', '-1 days') WHERE key = ?1",
      row.key,
    );
    const result = await syncAll(env);
    expect(result).toMatchObject({ expired: 1, deleted: 6 });
    const after = await one(env);
    expect(after).toMatchObject({ key: row.key, state: "expired", retention: "canary" });
    expect(after.object_count).toBe(5);
    expect(await keysUnder(row.key)).toEqual([]);
    // Expired once, never again, and the row stays. Its count is dropped to 0 once a day has passed.
    expect(await syncAll(env)).toMatchObject({ expired: 0, deleted: 0 });
    expect((await one(env)).copied).toBeGreaterThan(0);
    await settle(env, row.key);
    await syncAll(env);
    expect((await one(env)).copied).toBe(0);
    expect(await all(env)).toHaveLength(1);
  });

  test("deleting is bounded by maxDeletes, a row expiring over several syncs", async () => {
    const env = envOf();
    const { row } = await stored();
    await sql(
      env,
      "UPDATE compute_derivatives SET expires_at = datetime('now', '-1 days') WHERE key = ?1",
      row.key,
    );
    const first = await syncAll(env, { maxDeletes: 4 });
    expect(first).toMatchObject({ expired: 1, deleted: 4 });
    expect(await one(env)).toMatchObject({ state: "expired" });
    expect(await keysUnder(row.key)).toHaveLength(2);
    expect((await one(env)).copied).toBeGreaterThan(0);
    const second = await syncAll(env, { maxDeletes: 4 });
    expect(second.deleted).toBe(2);
    expect(await keysUnder(row.key)).toEqual([]);
    await settle(env, row.key);
    await syncAll(env);
    expect((await one(env)).copied).toBe(0);
  });

  test("a large expiry does not take the copies' turn: deleting has a budget of its own (MUTATION: charge deletes to the copy budget)", async () => {
    const env = envOf();
    const a = await stored();
    await sql(
      env,
      "UPDATE compute_derivatives SET expires_at = datetime('now', '-1 days') WHERE key = ?1",
      a.row.key,
    );
    const b = await zarrJob();
    // Six objects are due to go and only three deletes are allowed; the copy budget is untouched by them.
    const result = await syncAll(env, { maxObjects: 5, maxDeletes: 3 });
    expect(result).toMatchObject({ deleted: 3, copied: 5, stored: 1, expired: 1 });
    expect(await keysUnder(a.row.key)).toHaveLength(3);
    expect((await one(env, `stamp_id = ${b.stampId}`)).state).toBe("stored");
  });

  test("promoting B to catalog supersedes A, and a class is raised one step at a time", async () => {
    const env = envOf();
    const a = await stored();
    await newerVersion(a.made.id, "1.1.0");
    const b = await zarrJob({ id: a.made.id });
    await syncAll(env);
    const rowB = await one(env, `stamp_id = ${b.stampId}`);
    expect(rowB.version).toBe("v1.1.0");
    expect(rowB.state).toBe("stored");

    const promotedA = await retention(a.row.key, "admin", "catalog");
    expect(promotedA.status).toBe(200);
    expect(await one(env, `key = '${a.row.key}'`)).toMatchObject({
      retention: "catalog",
      expires_at: null,
      superseded_at: null,
    });
    // A canary is not published: one step at a time, even for the owner.
    const skipped = await retention(rowB.key, "owner", "published");
    expect(skipped).toMatchObject({ status: 409, body: { code: "not_promotable" } });

    const promotedB = await retention(rowB.key, "admin2", "catalog");
    expect(promotedB.status).toBe(200);
    const nowA = await one(env, `key = '${a.row.key}'`);
    expect(nowA.retention).toBe("catalog");
    expect(nowA.superseded_at).not.toBeNull();
    const grace = await env.DB.prepare(
      "SELECT julianday(expires_at) - julianday(superseded_at) AS days FROM compute_derivatives WHERE key = ?1",
    )
      .bind(a.row.key)
      .first<{ days: number }>();
    expect(Math.round((grace as { days: number }).days)).toBe(30);
    expect(await one(env, `key = '${rowB.key}'`)).toMatchObject({
      retention: "catalog",
      expires_at: null,
      superseded_at: null,
    });
    // The audit rows say what was raised, shape only.
    const audit = await env.DB.prepare(
      "SELECT action, resource_id, details FROM audit_log WHERE action = 'compute.derivative.promoted' ORDER BY id",
    ).all<{ action: string; resource_id: string; details: string }>();
    expect(audit.results.map((r) => r.resource_id)).toEqual([a.row.key, rowB.key]);
    expect(JSON.parse(audit.results[0]?.details as string)).toEqual({
      from: "canary",
      to: "catalog",
    });

    // A promoted row cannot be promoted to the same class again, and a copying row cannot be promoted.
    expect((await retention(rowB.key, "admin", "catalog")).status).toBe(409);
    // Superseded A expires 30 days after, and then only its objects go.
    await sql(
      env,
      "UPDATE compute_derivatives SET expires_at = datetime('now', '-1 days') WHERE key = ?1",
      a.row.key,
    );
    expect(await syncAll(env)).toMatchObject({ expired: 1 });
    expect(await keysUnder(a.row.key)).toEqual([]);
    expect((await one(env, `key = '${rowB.key}'`)).state).toBe("stored");
  });

  test("a promotion that changes no row supersedes nothing (MUTATION: drop the changes() guard of the supersede statement)", async () => {
    const env = envOf();
    const a = await stored();
    await newerVersion(a.made.id, "1.1.0");
    const b = await zarrJob({ id: a.made.id });
    await syncAll(env);
    const rowB = await one(env, `stamp_id = ${b.stampId}`);
    expect((await retention(a.row.key, "admin", "catalog")).status).toBe(200);
    expect((await retention(rowB.key, "admin", "catalog")).status).toBe(200);
    // A is now superseded and B is the catalog row. Replay A's promotion at the statement level, as a racing
    // second request would after it passed the route's read: A is already catalog, so nothing changes, and
    // B, which a later promotion made the current one, is NOT superseded by it.
    const audit = env.DB.prepare(AUDIT_IF_PREVIOUS_CHANGED_SQL).bind(1, "replay", null, null, null);
    await env.DB.batch([
      env.DB.prepare(PROMOTE_CATALOG_SQL).bind(a.row.key),
      audit,
      env.DB.prepare(SUPERSEDE_CATALOG_SQL).bind(
        a.made.id,
        "nemar-floor",
        "zarr",
        "serving",
        a.row.key,
      ),
    ]);
    expect((await one(env, `key = '${rowB.key}'`)).superseded_at).toBeNull();
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'replay'").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
  });

  test("an administrator's published request is refused and the owner's is accepted (MUTATION: remove the owner-only check)", async () => {
    const env = envOf();
    const { row } = await stored();
    expect((await retention(row.key, "admin", "catalog")).status).toBe(200);

    const refused = await retention(row.key, "admin", "published");
    expect(refused).toMatchObject({ status: 403, body: { code: "owner_only" } });
    expect(await one(env, `key = '${row.key}'`)).toMatchObject({ retention: "catalog" });

    const accepted = await retention(row.key, "owner", "published");
    expect(accepted.status).toBe(200);
    expect(await one(env, `key = '${row.key}'`)).toMatchObject({
      retention: "published",
      expires_at: null,
      doi: null,
    });
    // No route lowers a class: the only classes a body may name are the two higher ones.
    for (const klass of ["canary", "catalog", "", 3, null]) {
      expect((await retention(row.key, "owner", klass)).status).toBe(
        klass === "catalog" ? 409 : 400,
      );
    }
    expect(await one(env, `key = '${row.key}'`)).toMatchObject({ retention: "published" });
    // A member is not an administrator at all.
    expect((await retention(row.key, "member", "catalog")).status).toBe(403);
  });

  test("a published row past any date is untouched by every sync (MUTATION: remove the published guard from the expiry)", async () => {
    const env = envOf();
    const { row } = await stored();
    await retention(row.key, "admin", "catalog");
    await retention(row.key, "owner", "published");
    // The code never gives a published row a date, but a database can: the guard is what holds.
    await sql(
      env,
      "UPDATE compute_derivatives SET expires_at = datetime('now', '-10 years'), stored_at = datetime('now', '-11 years') WHERE key = ?1",
      row.key,
    );
    const before = await keysUnder(row.key);
    const result = await syncAll(env);
    expect(result).toMatchObject({ expired: 0, deleted: 0 });
    expect(await one(env)).toMatchObject({ state: "stored", retention: "published" });
    expect(await keysUnder(row.key)).toEqual(before);
    expect(before).toHaveLength(6);
  });

  test("deleting the dataset expires its canary and catalog rows and reports the published one it holds", async () => {
    const env = envOf();
    const a = await stored();
    await newerVersion(a.made.id, "1.1.0");
    const b = await zarrJob({ id: a.made.id });
    await newerVersion(a.made.id, "1.2.0");
    const c = await zarrJob({ id: a.made.id });
    await syncAll(env);
    const rowB = await one(env, `stamp_id = ${b.stampId}`);
    const rowC = await one(env, `stamp_id = ${c.stampId}`);
    // A stays canary, B is catalog, C is published.
    await retention(rowB.key, "admin", "catalog");
    await retention(rowC.key, "admin", "catalog");
    await retention(rowC.key, "owner", "published");
    // The earlier catalog row B was superseded by C's promotion; it is catalog still.
    const result = await deleteDatasetCascade(
      env.DB,
      { ...env, ENVIRONMENT: "production" },
      a.made.id,
      { skipS3: true },
    );
    expect(result.steps.d1.success).toBe(true);
    expect(result.published_derivatives_held).toBe(1);
    const rows = await all(env);
    expect(rows).toHaveLength(3);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect((byKey.get(rowC.key) as Der).retention).toBe("published");
    expect((byKey.get(rowC.key) as Der).expires_at).toBeNull();
    for (const key of [a.row.key, rowB.key]) {
      const r = byKey.get(key) as Der;
      expect(r.expires_at).not.toBeNull();
      expect(
        (
          await env.DB.prepare(
            "SELECT expires_at <= datetime('now') AS due FROM compute_derivatives WHERE key = ?1",
          )
            .bind(key)
            .first<{ due: number }>()
        )?.due,
      ).toBe(1);
    }
    // The stamps went with the dataset; the next sync expires what is due and keeps the published one.
    const sync = await syncAll(env);
    expect(sync).toMatchObject({ expired: 2 });
    expect(await keysUnder(a.row.key)).toEqual([]);
    expect(await keysUnder(rowB.key)).toEqual([]);
    expect(await keysUnder(rowC.key)).toHaveLength(6);
    expect((await one(env, `key = '${rowC.key}'`)).state).toBe("stored");
  });

  test("a row still copying when its dataset is deleted stops copying and expires", async () => {
    const env = envOf();
    const made = await zarrJob();
    await syncAll(env, { maxObjects: 2 });
    expect(await one(env)).toMatchObject({ state: "copying", copied: 2 });
    await deleteDatasetCascade(env.DB, { ...env, ENVIRONMENT: "production" }, made.id, {
      skipS3: true,
    });
    const result = await syncAll(env);
    expect(result).toMatchObject({ copied: 0, expired: 1 });
    expect(await one(env)).toMatchObject({ state: "expired" });
    expect(await keysUnder((await one(env)).key)).toEqual([]);
  });

  test("a sync that lost the count of a copy does not advance it twice", async () => {
    const env = envOf();
    await zarrJob();
    await syncAll(env, { maxObjects: 1 });
    const row = await one(env);
    expect(row.copied).toBe(1);
    // A second holder of an old count changes nothing.
    const stale = await sql(env, ADVANCE_COPIED_SQL, row.key, 0);
    expect(stale.meta.changes).toBe(0);
    expect((await sql(env, ADVANCE_COPIED_SQL, row.key, 1)).meta.changes).toBe(1);
    expect((await one(env)).copied).toBe(2);
  });
});

// --- Dark until bound ---------------------------------------------------------------------------------------------

describe("dark until bound", () => {
  const unbound: Array<[string, Partial<Bindings>]> = [
    ["no binding", { COMPUTE_DERIVATIVES: undefined }],
    ["no bucket name", { COMPUTE_DERIVATIVES_BUCKET_NAME: undefined }],
    ["a blank bucket name", { COMPUTE_DERIVATIVES_BUCKET_NAME: "  " }],
    // Those two are presignable, and the results bucket expires its objects after 30 days.
    ["the results bucket's own name", { COMPUTE_DERIVATIVES_BUCKET_NAME: HARNESS_BUCKETS.results }],
    ["the records bucket's own name", { COMPUTE_DERIVATIVES_BUCKET_NAME: HARNESS_BUCKETS.records }],
  ];

  for (const [name, over] of unbound) {
    test(`with ${name} the sync answers unavailable and writes nothing, and so does every route`, async () => {
      const full = envOf();
      const made = await zarrJob();
      const env = envOf(over);
      expect(await syncDerivatives(env)).toEqual({ available: false });
      expect(await runComputeDerivativesCron({ ...env, ENVIRONMENT: "production" })).toBeNull();
      expect(await all(full)).toHaveLength(0);
      expect(
        (
          await full.DB.prepare("SELECT COUNT(*) AS n FROM compute_derivative_skips").first<{
            n: number;
          }>()
        )?.n,
      ).toBe(0);
      expect(copiesMade()).toBe(0);
      expect(await keysUnder("x".repeat(64))).toEqual([]);

      const key = "a".repeat(64);
      const replies = [
        await call("GET", "/compute/derivatives", "admin", undefined, env),
        await call("GET", `/compute/derivatives?dataset=${made.id}`, "admin", undefined, env),
        await call("GET", `/compute/derivatives/${key}`, "admin", undefined, env),
        await call("POST", "/compute/derivatives/sync", "admin", {}, env),
        await call(
          "POST",
          `/compute/derivatives/${key}/retention`,
          "owner",
          { class: "catalog" },
          env,
        ),
        await call(
          "POST",
          `/compute/derivatives/${key}/retention`,
          "owner",
          { class: "published" },
          env,
        ),
      ];
      for (const r of replies) {
        expect(r).toMatchObject({ status: 503, body: { code: "derivatives_unavailable" } });
      }
      expect(await all(full)).toHaveLength(0);
      // Once it is bound the same stamp is keyed: nothing was lost by being dark.
      expect(await syncAll(full)).toMatchObject({ created: 1, stored: 1 });
    });
  }

  test("without the results or records binding, or the signer, the store is dark too", async () => {
    await zarrJob();
    for (const over of [
      { COMPUTE_RESULTS: undefined },
      { COMPUTE_RECORDS: undefined },
      { COMPUTE_R2_ACCESS_KEY_ID: undefined },
    ] as Array<Partial<Bindings>>) {
      expect(await syncDerivatives(envOf(over))).toEqual({ available: false });
    }
    expect(await all(envOf())).toHaveLength(0);
  });

  test("the derivatives bucket is reached by a copy only: no address can be signed for it", async () => {
    const env = envOf();
    const s3 = computeS3(env);
    expect(s3).not.toBeNull();
    const signer = s3 as NonNullable<typeof s3>;
    expect(signer.derivatives).toBe(DERIVATIVES_BUCKET);
    for (const sign of [
      () => presignPut(signer, "derivatives" as never, "d/x", { expiresIn: 60 }),
      () => presignGet(signer, "derivatives" as never, "d/x", { expiresIn: 60 }),
    ]) {
      await expect(sign()).rejects.toMatchObject({ code: "bucket_not_presignable" });
    }
    // Without a name the third bucket is not addressable at all.
    const unnamed = computeS3({
      ...env,
      COMPUTE_DERIVATIVES_BUCKET_NAME: undefined,
    }) as NonNullable<typeof s3>;
    expect(unnamed.derivatives).toBeNull();
    // A name that is the results or the records bucket's own is no name either (MUTATION: drop the check).
    for (const name of [HARNESS_BUCKETS.results, HARNESS_BUCKETS.records]) {
      const same = computeS3({ ...env, COMPUTE_DERIVATIVES_BUCKET_NAME: name });
      expect(same).not.toBeNull();
      expect(same?.derivatives).toBeNull();
    }
    await expect(
      copyObject(
        unnamed,
        { bucket: "results", key: "jobs/x" },
        { bucket: "derivatives", key: "d/x" },
      ),
    ).rejects.toBeInstanceOf(ComputeS3Error);
    // The records and results buckets are signed as before, with or without the third.
    expect(await presignGet(unnamed, "results", "jobs/x", { expiresIn: 60 })).toMatchObject({
      url: expect.stringContaining(HARNESS_BUCKETS.results),
    });
  });

  test("the cron refuses anywhere but exact production, and runs there", async () => {
    await zarrJob();
    expect(await runComputeDerivativesCron(envOf({ ENVIRONMENT: "development" }))).toBeNull();
    expect(await runComputeDerivativesCron(envOf({ ENVIRONMENT: "staging" }))).toBeNull();
    expect(await all(envOf())).toHaveLength(0);
    const ran = await runComputeDerivativesCron(envOf({ ENVIRONMENT: "production" }));
    expect(ran).toMatchObject({ available: true, created: 1, stored: 1 });
    const line = derivativesLogLine(ran as NonNullable<typeof ran>);
    expect(line?.line).toContain("created=1");
    expect(line?.line).not.toMatch(/[0-9a-f]{40}|nm[0-9]{6}|jobs\//);
    const idle = await runComputeDerivativesCron(envOf({ ENVIRONMENT: "production" }));
    expect(derivativesLogLine(idle as NonNullable<typeof idle>)).toBeNull();
  });
});

// --- The keying checks ------------------------------------------------------------------------------------------------

describe("every keying check of the ADR, each failed alone", () => {
  async function expectUnkeyable(
    make: () => Promise<Made>,
    word: string,
    field?: string,
  ): Promise<void> {
    const env = envOf();
    await make();
    let result: Awaited<ReturnType<typeof syncAll>> | undefined;
    const lines = await logged(async () => {
      result = await syncAll(env);
    });
    const r = result as NonNullable<typeof result>;
    expect(await all(env)).toHaveLength(0);
    expect(r).toMatchObject({ examined: 1, created: 0, errored: 0, copied: 0 });
    expect(r.derivative_unkeyable).toEqual({ [word]: 1 });
    const line = lines.find((l) => l.includes("derivative_unkeyable")) as string;
    expect(line).toContain(`word=${word}`);
    // The field is logged BESIDE the word, never in it, and never a value.
    if (field !== undefined) expect(line).toContain(`word=${word} field=${field}`);
    else expect(line).not.toContain("field=");
    expect(copiesMade()).toBe(0);
    const skip = await env.DB.prepare("SELECT word FROM compute_derivative_skips").first<{
      word: string;
    }>();
    expect(skip?.word).toBe(word);
    // A decision is final: the stamp is not read again.
    expect(await syncAll(env)).toMatchObject({ examined: 0 });
  }

  test("a spec with --recording is a subset run (recording_subset)", () =>
    expectUnkeyable(() => zarrJob({ recording: true }), "recording_subset"));

  test("a recording that ended out_of_memory is transient, and so are internal_error, disk_error and time_budget (transient_failure)", async () => {
    for (const code of ["out_of_memory", "internal_error", "disk_error", "time_budget"]) {
      await fx.reset();
      await emptyDerivatives();
      standin.log.length = 0;
      await seedComputeUsers(fx.harness.db);
      await expectUnkeyable(() => zarrJob({ codes: [code] }), "transient_failure");
    }
  });

  test("a recording that ended load_failed is deterministic and is keyed", async () => {
    const env = envOf();
    await zarrJob({ codes: ["load_failed", "ica_degenerate"] });
    expect(await syncAll(env)).toMatchObject({ created: 1, stored: 1 });
    expect((await one(env)).state).toBe("stored");
  });

  test("a table with no code column cannot be judged (table_unreadable)", async () => {
    const env = envOf();
    const made = await zarrJob();
    await fx.harness.results.put(
      resultsOutputKey(made.jobId, "product/desc-nemarfloor_recordings.tsv"),
      enc("path\tstatus\nsub-01/x.edf\tfailed\n"),
    );
    // The same table with no code column is unreadable, never keyed by guess.
    const r = await syncAll(env);
    expect(r.derivative_unkeyable).toEqual({ table_unreadable: 1 });
    expect(await all(env)).toHaveLength(0);
  });

  test("a non-empty stores_unread is stores_unread", () =>
    expectUnkeyable(
      () => zarrJob({ unread: ["sub-03/eeg/sub-03_task-rest_eeg.edf"] }),
      "stores_unread",
    ));

  test("an unread list that is not a list is stores_unread, never a count", () =>
    expectUnkeyable(() => zarrJob({ unread: 0 }), "stores_unread"));

  test("an empty stores_content is no_stores_content", () =>
    expectUnkeyable(
      () => zarrJob({ rows: [], digest: `sha256:${"1".repeat(64)}` }),
      "no_stores_content",
    ));

  test("a row whose path is not in stores is stores_differ", () =>
    expectUnkeyable(
      () => zarrJob({ rows: rowsOf([STORES[0] as string, "sub-09/eeg/other.edf"]) }),
      "stores_differ",
    ));

  test("a row that is not an object, or has no text path, is stores_differ", async () => {
    await expectUnkeyable(
      () =>
        zarrJob({
          rows: [...rowsOf(STORES), "sub-03/eeg/x.edf"],
          digest: `sha256:${"2".repeat(64)}`,
        }),
      "stores_differ",
    );
  });

  test("a store read twice is stores_differ (each once)", () =>
    expectUnkeyable(
      () =>
        zarrJob({
          rows: [...rowsOf(STORES), ...rowsOf([STORES[0] as string])],
          stores: [...STORES, STORES[0]],
        }),
      "stores_differ",
    ));

  test("a stated digest one hexadecimal digit off is digest_mismatch (MUTATION: remove the recomputation of the input digest)", async () => {
    const good = await inputDigestV2(rowsOf(STORES) as never);
    const off = `${good.slice(0, -1)}${good.endsWith("0") ? "1" : "0"}`;
    await expectUnkeyable(() => zarrJob({ digest: off }), "digest_mismatch");
  });

  test("a record that agrees but a stamp that does not is digest_mismatch", async () => {
    await expectUnkeyable(
      () => zarrJob({ stampDigest: `sha256:${"3".repeat(64)}` }),
      "digest_mismatch",
    );
  });

  test("a stamp with no digest is no_input_digest", () =>
    expectUnkeyable(() => zarrJob({ stampDigest: null }), "no_input_digest"));

  test("a bids stamp whose input digest is a sha256: one is key_invalid, field input_digest", () =>
    expectUnkeyable(
      () => bidsJob({ stampDigest: `sha256:${"4".repeat(64)}` }),
      "key_invalid",
      "input_digest",
    ));

  test("a bids stamp is keyed as before: its git: digest is not recomputed and it never carries the serving sentence", async () => {
    const env = envOf();
    const made = await bidsJob();
    const result = await syncAll(env);
    expect(result).toMatchObject({ created: 1, stored: 1, errored: 0 });
    const row = await one(env);
    expect(row.input_digest).toBe(`git:${SOURCE}`);
    expect(row.key).toBe(await keyOfStamp(env, made.stampId));
    const description = JSON.parse(
      (await (await derivatives.get(`d/${row.key}/derivative.json`))?.text()) as string,
    );
    expect(description.Profile).toBe("archive");
    expect(description.Description).toBeUndefined();
    expect(JSON.stringify(description)).not.toContain(SERVING_PROFILE_SENTENCE);
    expect(description.Citation).toContain("by NEMAR's nemar-floor 1.0.0.");
  });

  test("a row whose content_sha256 has 63 digits is undigestable, not stores_differ or digest_mismatch, and a keyable stamp after it is still stored (MUTATION: remove the catch that turns an inputDigestV2 throw into undigestable)", async () => {
    const env = envOf();
    const bad = rowsOf(STORES);
    (bad[0] as Row).content_sha256 = "a".repeat(63);
    await zarrJob({ rows: bad });
    const good = await zarrJob();
    let result: Awaited<ReturnType<typeof syncAll>> | undefined;
    const lines = await logged(async () => {
      result = await syncAll(env);
    });
    const r = result as NonNullable<typeof result>;
    expect(r).toMatchObject({ examined: 2, created: 1, stored: 1, errored: 0 });
    expect(r.derivative_unkeyable).toEqual({ undigestable: 1 });
    const line = lines.find((l) => l.includes("derivative_unkeyable")) as string;
    expect(line).toContain("word=undigestable field=content_sha256");
    const rows = await all(env);
    expect(rows).toHaveLength(1);
    expect((rows[0] as Der).stamp_id).toBe(good.stampId);
  });

  test("a Zarr record whose rows carry locations and whose stated digest is their nemar.input-digest.v2 is stored (MUTATION: recompute with the version 1 inputDigest)", async () => {
    const env = envOf();
    await zarrJob();
    expect(await syncAll(env)).toMatchObject({ created: 1, stored: 1, derivative_unkeyable: {} });
    expect((await one(env)).input_digest).toBe(await inputDigestV2(rowsOf(STORES) as never));
  });

  test("the same record with its rows' locations removed and a stated version 1 digest is undigestable, field locations", async () => {
    const legacy = rowsOf(STORES).map(({ path, group, content_sha256 }) => ({
      path,
      group,
      content_sha256,
    }));
    const v1 = await inputDigest(legacy as never);
    await expectUnkeyable(() => zarrJob({ rows: legacy, digest: v1 }), "undigestable", "locations");
  });

  test("a spec.json that is gone is spec_unreadable (MUTATION: key from a spec that was not read)", () =>
    expectUnkeyable(async () => {
      const made = await zarrJob();
      await fx.harness.records.delete(recordKey(made.jobId, "spec.json"));
      return made;
    }, "spec_unreadable"));

  test("a record that is not JSON is record_unreadable", () =>
    expectUnkeyable(async () => {
      const made = await zarrJob();
      await fx.harness.results.put(
        resultsOutputKey(made.jobId, "product/desc-nemarfloor_signalJourney.json"),
        enc("{not json"),
      );
      return made;
    }, "record_unreadable"));

  test("a manifest that is not a manifest is manifest_unreadable", () =>
    expectUnkeyable(async () => {
      const made = await zarrJob();
      await fx.harness.results.put(
        resultsLauncherKey(made.jobId, "manifest.json"),
        enc(JSON.stringify({ job_id: made.jobId })),
      );
      return made;
    }, "manifest_unreadable"));

  test("a manifest that lists derivative.json is derivative_name_taken: the description's name is the store's", () =>
    expectUnkeyable(() => zarrJob({ names: ["derivative.json"] }), "derivative_name_taken"));

  test("a stamp of a recipe the registry no longer has is recipe_unknown", () =>
    expectUnkeyable(async () => {
      const made = await zarrJob();
      await sql(
        envOf(),
        "UPDATE compute_pipeline_stamps SET recipe = 'nemar-floor-zarr' WHERE id = ?1",
        made.stampId,
      );
      return made;
    }, "recipe_unknown"));

  test("a stamp whose dataset is gone is never a candidate: no derivative, no skip, nothing read (MUTATION: drop the eligibility term of the scan)", async () => {
    const made = await zarrJob();
    const env = envOf();
    await sql(env, "DELETE FROM dataset_versions WHERE dataset_id = ?1", made.id);
    await sql(env, "DELETE FROM datasets WHERE dataset_id = ?1", made.id);
    expect(await syncAll(env)).toMatchObject({ examined: 0, created: 0, errored: 0 });
    expect(await all(env)).toHaveLength(0);
    expect(copiesMade()).toBe(0);
  });

  test("a bucket that throws leaves the stamp undecided and counted later, and the next sync keys it (MUTATION: decide a stamp from a read that failed)", async () => {
    const env = envOf();
    await zarrJob();
    const results = fx.harness.results;
    const flaky = {
      head: (k: string) => results.head(k),
      get: (k: string) =>
        k.endsWith("signalJourney.json")
          ? Promise.reject(new Error("the store is down"))
          : results.get(k),
      list: (o?: Parameters<R2Bucket["list"]>[0]) => results.list(o),
      put: results.put.bind(results),
      delete: (k: string | string[]) => results.delete(k),
    } as unknown as R2Bucket;
    let result: Awaited<ReturnType<typeof syncAll>> | undefined;
    const lines = await logged(async () => {
      result = await syncAll(envOf({ COMPUTE_RESULTS: flaky }));
    });
    expect(result).toMatchObject({ examined: 1, created: 0, later: 1, errored: 0 });
    expect(result?.derivative_unkeyable).toEqual({});
    expect(lines.some((l) => l.includes("key_read_failed"))).toBe(true);
    expect(await all(env)).toHaveLength(0);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM compute_derivative_skips").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
    expect(await syncAll(env)).toMatchObject({ examined: 1, created: 1, stored: 1 });
  });

  test("a call examines at most 20 stamps, and the rest wait for the next (MUTATION: change DERIVATIVE_STAMPS_PER_CALL)", async () => {
    const env = envOf();
    for (let i = 0; i < 25; i++) await zarrJob({ stampDigest: null });
    const first = await syncAll(env);
    expect(first).toMatchObject({ examined: 20 });
    expect(first.derivative_unkeyable).toEqual({ no_input_digest: 20 });
    const second = await syncAll(env);
    expect(second).toMatchObject({ examined: 5 });
    expect(second.derivative_unkeyable).toEqual({ no_input_digest: 5 });
    expect(await syncAll(env)).toMatchObject({ examined: 0 });
  }, 120_000);

  test("the sync returns only its declared counts, and the words it skips under are the declared ones", async () => {
    expect(new Set(UNKEYABLE_WORDS).size).toBe(UNKEYABLE_WORDS.length);
    for (const w of UNKEYABLE_WORDS) expect(w).toMatch(/^[a-z0-9_]{1,64}$/);
    const env = envOf();
    await zarrJob({ recording: true });
    await zarrJob({ unread: ["sub-09/eeg/x.edf"] });
    await zarrJob();
    const r = await syncAll(env);
    expect(Object.keys(r).sort()).toEqual(
      [
        "available",
        "copied",
        "created",
        "derivative_unkeyable",
        "deleted",
        "duplicate",
        "errored",
        "examined",
        "expired",
        "failed",
        "later",
        "stored",
      ].sort(),
    );
    expect(Object.keys(r.derivative_unkeyable).sort()).toEqual([
      "recording_subset",
      "stores_unread",
    ]);
    for (const word of Object.keys(r.derivative_unkeyable)) {
      expect(UNKEYABLE_WORDS as readonly string[]).toContain(word);
    }
    expect(r).toMatchObject({ examined: 3, created: 1, stored: 1 });
  });
});

// --- Reading ------------------------------------------------------------------------------------------------------------

describe("what an administrator reads", () => {
  test("the list and the show routes answer rows and the description, and never an object's bytes", async () => {
    const env = envOf();
    const made = await zarrJob();
    await syncAll(env, { maxObjects: 2 });
    const copying = await one(env);
    const early = await call("GET", `/compute/derivatives/${copying.key}`, "admin");
    expect(early.status).toBe(200);
    expect(early.body).toMatchObject({
      derivative: { key: copying.key, state: "copying" },
      description: null,
    });
    await syncAll(env);

    const list = await call("GET", `/compute/derivatives?dataset=${made.id}`, "admin");
    expect(list.status).toBe(200);
    expect((list.body.derivatives as Der[]).map((d) => d.key)).toEqual([copying.key]);
    expect(
      (await call("GET", "/compute/derivatives?dataset=nm099998", "admin")).body
        .derivatives as Der[],
    ).toEqual([]);
    expect((await call("GET", "/compute/derivatives?dataset=notadataset", "admin")).status).toBe(
      400,
    );
    expect((await call("GET", "/compute/derivatives?limit=0", "admin")).status).toBe(400);
    expect((await call("GET", "/compute/derivatives", "owner")).status).toBe(200);

    const shown = await call("GET", `/compute/derivatives/${copying.key}`, "admin");
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({
      derivative: { key: copying.key, state: "stored", retention: "canary", doi: null },
      description: { format: "nemar.derivative.v1", key: copying.key, Profile: "serving" },
    });
    expect(JSON.stringify(shown.body)).not.toContain("jobs/");
    expect((await call("GET", `/compute/derivatives/${"f".repeat(64)}`, "admin")).status).toBe(404);
    expect((await call("GET", "/compute/derivatives/not-a-key", "admin")).status).toBe(404);
    // A member reads nothing.
    expect((await call("GET", "/compute/derivatives", "member")).status).toBe(403);
    expect((await call("GET", `/compute/derivatives/${copying.key}`, "member")).status).toBe(403);
  });

  test("the sync route runs one bounded pass and answers its counts, audited as counts", async () => {
    const env = envOf();
    await zarrJob();
    const bad = await call("POST", "/compute/derivatives/sync", "admin", { max_objects: 0 });
    expect(bad.status).toBe(400);
    // A copy is four subrequests and a Worker invocation makes 1,000: 150 is the most, and 151 is refused.
    expect(
      (await call("POST", "/compute/derivatives/sync", "admin", { max_objects: 151 })).status,
    ).toBe(400);
    expect((await call("POST", "/compute/derivatives/sync", "admin", { other: 1 })).status).toBe(
      400,
    );
    expect((await call("POST", "/compute/derivatives/sync", "member", {})).status).toBe(403);
    expect(copiesMade()).toBe(0);

    const first = await call("POST", "/compute/derivatives/sync", "admin", { max_objects: 3 });
    expect(first).toMatchObject({
      status: 200,
      body: { ok: true, created: 1, copied: 3, stored: 0 },
    });
    const second = await call("POST", "/compute/derivatives/sync", "owner");
    expect(second).toMatchObject({ status: 200, body: { ok: true, copied: 2, stored: 1 } });
    const audit = await env.DB.prepare(
      "SELECT details FROM audit_log WHERE action = 'compute.derivatives.sync' ORDER BY id",
    ).all<{ details: string }>();
    expect(audit.results).toHaveLength(2);
    expect(JSON.parse(audit.results[0]?.details as string)).toMatchObject({
      created: 1,
      copied: 3,
    });
    expect(audit.results[0]?.details).not.toMatch(/jobs\/|nm[0-9]{6}|[0-9a-f]{64}/);
  });

  test("a body that is not a retention change is invalid and writes nothing", async () => {
    const env = envOf();
    await zarrJob();
    await syncAll(env);
    const row = await one(env);
    for (const body of [{}, { class: "catalog", extra: 1 }, { klass: "catalog" }]) {
      const r = await call("POST", `/compute/derivatives/${row.key}/retention`, "admin", body);
      expect(r).toMatchObject({ status: 400, body: { code: "invalid_body" } });
    }
    expect((await retention("f".repeat(64), "admin", "catalog")).status).toBe(404);
    expect((await retention("nope", "admin", "catalog")).status).toBe(404);
    expect(await one(env)).toMatchObject({ retention: "canary" });
    // A promotion of a derivative that is not stored is refused by the service as well.
    const copyingEnv = envOf();
    await sql(
      copyingEnv,
      "UPDATE compute_derivatives SET state = 'expired', copied = 0 WHERE key = ?1",
      row.key,
    );
    expect(
      await promoteDerivative(copyingEnv, {
        key: row.key,
        to: "catalog",
        userId: 1,
        role: "admin",
      }),
    ).toEqual({
      ok: false,
      code: "not_promotable",
    });
  });
});

// --- The table and the code ---------------------------------------------------------------------------------------------

describe("the table and its guards", () => {
  test("the CHECKs refuse what the rules forbid", async () => {
    const env = envOf();
    await zarrJob();
    await syncAll(env);
    const row = await one(env);
    const refuses = async (statement: string, ...binds: unknown[]) => {
      let message = "";
      try {
        await sql(env, statement, ...binds);
      } catch (err) {
        message = String(err);
      }
      return message;
    };
    // A DOI only on a published row; nothing in the code writes one.
    expect(
      await refuses("UPDATE compute_derivatives SET doi = '10.1234/x' WHERE key = ?1", row.key),
    ).toContain("compute_derivatives_doi_published");
    expect(
      await refuses("UPDATE compute_derivatives SET stored_at = NULL WHERE key = ?1", row.key),
    ).toContain("compute_derivatives_stored_has_time");
    expect(
      await refuses("UPDATE compute_derivatives SET copied = 99 WHERE key = ?1", row.key),
    ).toContain("compute_derivatives_stored_is_whole");
    expect(
      await refuses(
        "UPDATE compute_derivatives SET state = 'copying', copied = 99 WHERE key = ?1",
        row.key,
      ),
    ).toContain("compute_derivatives_copied_within");
    expect(
      await refuses("UPDATE compute_derivatives SET retention = 'forever' WHERE key = ?1", row.key),
    ).toContain("compute_derivatives_retention");
    expect(
      await refuses("UPDATE compute_derivatives SET state = 'failed' WHERE key = ?1", row.key),
    ).toContain("compute_derivatives_failure_iff");
    expect(
      await refuses("UPDATE compute_derivatives SET input = 'bids' WHERE key = ?1", row.key),
    ).toContain("compute_derivatives_input_pairing");
    expect(
      await refuses("UPDATE compute_derivatives SET key = 'ABC' WHERE key = ?1", row.key),
    ).toContain("compute_derivatives_key");
    expect(await one(env)).toMatchObject({ retention: "canary", doi: null, state: "stored" });
  });

  /** Code with its comments removed: what it does, not what it says. */
  const stripComments = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  /**
   * What a source file does to the derivatives table that no code may: any statement naming the table that
   * deletes, replaces, assigns a DOI anywhere in a SET list or names `doi` among the inserted columns.
   */
  function derivativeTableProblems(source: string): string[] {
    const problems: string[] = [];
    const literals =
      stripComments(source).match(/`[^`]*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g) ?? [];
    for (const statement of literals) {
      if (!/\bcompute_derivatives\b/i.test(statement)) continue;
      if (/\bDELETE\s+FROM\s+compute_derivatives\b/i.test(statement)) problems.push("delete");
      if (/\bREPLACE\s+INTO\s+compute_derivatives\b/i.test(statement)) problems.push("replace");
      if (/\bSET\b[^;]*?\bdoi\s*=/i.test(statement)) problems.push("set doi");
      if (/\bINSERT\b[^;]*?\bINTO\s+compute_derivatives\s*\([^)]*\bdoi\b/i.test(statement)) {
        problems.push("insert doi");
      }
    }
    return problems;
  }

  test("the scan knows the ways to write a DOI or delete a row, so a clean result means something (MUTATION: narrow a pattern)", () => {
    const bad: Array<[string, string]> = [
      ["UPDATE compute_derivatives SET doi = ?1 WHERE key = ?2", "set doi"],
      ["UPDATE compute_derivatives SET retention = 'x', doi = '10.1/x' WHERE key = ?1", "set doi"],
      ["UPDATE compute_derivatives SET copied = 1,\n   doi = ?2 WHERE key = ?1", "set doi"],
      ["INSERT OR REPLACE INTO compute_derivatives (key) VALUES (?1)", "replace"],
      ["REPLACE INTO compute_derivatives (key) VALUES (?1)", "replace"],
      ["DELETE FROM compute_derivatives WHERE key = ?1", "delete"],
      ["INSERT INTO compute_derivatives (key, doi) VALUES (?1, ?2)", "insert doi"],
    ];
    for (const [statement, problem] of bad) {
      expect(derivativeTableProblems(`const s = \`${statement}\`;`)).toContain(problem);
    }
    // A comment that says what no code does is not code, and a statement about another table is not this one's.
    expect(
      derivativeTableProblems("// UPDATE compute_derivatives SET doi = 1\nconst a = 1;"),
    ).toEqual([]);
    expect(derivativeTableProblems("const s = 'UPDATE other SET doi = 1';")).toEqual([]);
  });

  test("no code writes a DOI, deletes or replaces a derivative row, signs an address for the bucket or reads a compute switch", () => {
    const root = join(import.meta.dir, "..", "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts")) files.push(path);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(100);
    for (const file of files) {
      expect(derivativeTableProblems(readFileSync(file, "utf8")), file).toEqual([]);
    }
    for (const name of ["services/compute-derivatives.ts", "routes/admin/compute-derivatives.ts"]) {
      const code = stripComments(readFileSync(join(root, name), "utf8"));
      expect(code).not.toMatch(
        /ezid|datacite|presign|COMPUTE_ENABLED|COMPUTE_PIPELINES_DISPATCH_ENABLED|AUTO_REPULL/i,
      );
    }
  });
});

// --- Review round 1 --------------------------------------------------------------------------------------------------

describe("a derivative that is going is never kept by a promotion", () => {
  async function storedOne(): Promise<{ made: Made; row: Der }> {
    const env = envOf();
    const made = await zarrJob();
    await syncAll(env);
    return { made, row: await one(env, `stamp_id = ${made.stampId}`) };
  }

  test("a deleted dataset's derivative cannot be promoted to catalog or published (MUTATION: drop the dataset and date conditions of the promotions)", async () => {
    const env = envOf();
    const a = await storedOne();
    const b = await storedOne();
    // B is a catalog row, A a canary; the dataset of A is deleted, which dates A to now.
    expect((await retention(b.row.key, "admin", "catalog")).status).toBe(200);
    await deleteDatasetCascade(env.DB, { ...env, ENVIRONMENT: "production" }, a.made.id, {
      skipS3: true,
    });
    const refused = await retention(a.row.key, "admin", "catalog");
    expect(refused).toMatchObject({ status: 409, body: { code: "not_promotable" } });
    expect(await one(env, `key = '${a.row.key}'`)).toMatchObject({ retention: "canary" });
    // B's dataset is deleted too: its catalog row is dated to now, and the owner cannot publish it either.
    await deleteDatasetCascade(env.DB, { ...env, ENVIRONMENT: "production" }, b.made.id, {
      skipS3: true,
    });
    const publish = await retention(b.row.key, "owner", "published");
    expect(publish).toMatchObject({ status: 409, body: { code: "not_promotable" } });
    expect(await one(env, `key = '${b.row.key}'`)).toMatchObject({ retention: "catalog" });
    // The next sync expires both and deletes their objects: nothing was kept.
    expect(await syncAll(env)).toMatchObject({ expired: 2 });
    expect(await keysUnder(a.row.key)).toEqual([]);
    expect(await keysUnder(b.row.key)).toEqual([]);
  });

  test("a dataset row that is gone alone is enough to refuse a promotion", async () => {
    const env = envOf();
    const a = await storedOne();
    await sql(env, "DELETE FROM dataset_versions WHERE dataset_id = ?1", a.made.id);
    await sql(env, "DELETE FROM datasets WHERE dataset_id = ?1", a.made.id);
    expect((await retention(a.row.key, "admin", "catalog")).status).toBe(409);
    expect(await one(env)).toMatchObject({ retention: "canary" });
  });

  test("a canary past its 30 days that the sync has not swept cannot be promoted (MUTATION: drop the date condition of the catalog promotion)", async () => {
    const env = envOf();
    const a = await storedOne();
    await sql(
      env,
      "UPDATE compute_derivatives SET expires_at = datetime('now', '-1 days') WHERE key = ?1",
      a.row.key,
    );
    const refused = await retention(a.row.key, "admin", "catalog");
    expect(refused).toMatchObject({ status: 409, body: { code: "not_promotable" } });
    expect(await one(env)).toMatchObject({ retention: "canary", state: "stored" });
    expect(await syncAll(env)).toMatchObject({ expired: 1 });
  });

  test("a catalog row past its date that is not swept yet cannot be published, one still inside it can (MUTATION: drop the date condition of the published promotion)", async () => {
    const env = envOf();
    const a = await storedOne();
    await newerVersion(a.made.id, "1.1.0");
    const b = await zarrJob({ id: a.made.id });
    await syncAll(env);
    const rowB = await one(env, `stamp_id = ${b.stampId}`);
    await retention(a.row.key, "admin", "catalog");
    await retention(rowB.key, "admin", "catalog");
    // A is superseded by B and has 30 days left: the owner may still publish it.
    expect((await one(env, `key = '${a.row.key}'`)).expires_at).not.toBeNull();
    await sql(
      env,
      "UPDATE compute_derivatives SET expires_at = datetime('now', '-1 days') WHERE key = ?1",
      a.row.key,
    );
    expect((await retention(a.row.key, "owner", "published")).status).toBe(409);
    await sql(
      env,
      "UPDATE compute_derivatives SET expires_at = datetime('now', '+5 days') WHERE key = ?1",
      a.row.key,
    );
    expect((await retention(a.row.key, "owner", "published")).status).toBe(200);
    expect(await one(env, `key = '${a.row.key}'`)).toMatchObject({
      retention: "published",
      expires_at: null,
    });
  });
});

describe("a copy that cannot be trusted, and a copy that cannot be made", () => {
  test("a copy of the same length with one byte changed ends the row failed with copy_mismatch (MUTATION: compare sizes only)", async () => {
    const env = envOf();
    await zarrJob();
    lossy.corrupt = (k) => k.endsWith("sub-01_qc.json");
    const result = await syncAll(env);
    expect(result).toMatchObject({ created: 1, failed: 1, stored: 0, errored: 0 });
    const row = await one(env);
    expect(row).toMatchObject({ state: "failed", failure: "copy_mismatch" });
    expect(await keysUnder(row.key)).toEqual([]);
  });

  test("a copy the binding cannot see is not a bad copy: the row waits and the next sync, with the right bucket, finishes it (MUTATION: end the row copy_mismatch when the target is missing)", async () => {
    const env = envOf();
    await zarrJob();
    // The binding is one bucket and the name the signer copies into is another.
    const wrong = envOf({ COMPUTE_DERIVATIVES_BUCKET_NAME: ELSEWHERE_BUCKET });
    let result: Awaited<ReturnType<typeof syncAll>> | undefined;
    const lines = await logged(async () => {
      result = await syncAll(wrong);
    });
    expect(result).toMatchObject({ created: 1, copied: 0, later: 1, failed: 0, stored: 0 });
    expect(lines.some((l) => l.includes("target_missing"))).toBe(true);
    expect(await one(env)).toMatchObject({
      state: "copying",
      copied: 0,
      failure: null,
      attempts: 1,
    });
    // Pointed at the right bucket, the row is copied whole.
    expect(await syncAll(env)).toMatchObject({ copied: 5, stored: 1 });
    expect(await one(env)).toMatchObject({ state: "stored", attempts: 0 });
  });

  test("a row that makes no progress five turns in a row ends failed with copy_failed, and the refusal's status is logged (MUTATION: change the count of tries)", async () => {
    const env = envOf();
    await zarrJob();
    standin.failWith({ op: "CopyObject", bucket: DERIVATIVES_BUCKET, status: 503, times: 50 });
    const lines: string[] = [];
    for (let turn = 1; turn <= 4; turn++) {
      lines.push(...(await logged(async () => void (await syncAll(env)))));
      expect(await one(env)).toMatchObject({ state: "copying", attempts: turn });
    }
    lines.push(...(await logged(async () => void (await syncAll(env)))));
    expect(await one(env)).toMatchObject({ state: "failed", failure: "copy_failed" });
    expect(lines.some((l) => l.includes("copy_failed") && l.includes("status=503"))).toBe(true);
    expect(lines.join("\n")).not.toMatch(/d\/[0-9a-f]{64}|jobs\//);
    // A failed row is final for its key and is cleaned like any other.
    expect(await keysUnder((await one(env)).key)).toEqual([]);
  });

  test("a copy that goes through sets the failed turns back to 0 (MUTATION: leave attempts alone when a file is copied)", async () => {
    const env = envOf();
    await zarrJob();
    standin.failWith({ op: "CopyObject", bucket: DERIVATIVES_BUCKET, status: 500, times: 2 });
    await syncAll(env);
    await syncAll(env);
    expect(await one(env)).toMatchObject({ state: "copying", attempts: 2 });
    const third = await syncAll(env, { maxObjects: 1 });
    expect(third).toMatchObject({ copied: 1 });
    expect(await one(env)).toMatchObject({ copied: 1, attempts: 0 });
  });

  test("rows take turns: ten that cannot be copied do not starve an eleventh (MUTATION: order the copying rows by creation)", async () => {
    const env = envOf();
    for (let i = 0; i < 11; i++) await zarrJob();
    // Every copy is refused once, and a sync works on ten rows: ten fail, one is never tried.
    standin.failWith({ op: "CopyObject", bucket: DERIVATIVES_BUCKET, status: 500, times: 10 });
    const first = await syncAll(env);
    expect(first).toMatchObject({ created: 11, later: 10, stored: 0 });
    const untried = await all(env, "last_attempt_at IS NULL");
    expect(untried).toHaveLength(1);
    // From now on the ten others are refused for good; the one that was never tried goes first and is stored.
    for (const row of await all(env, "last_attempt_at IS NOT NULL")) {
      standin.failWith({
        op: "CopyObject",
        bucket: DERIVATIVES_BUCKET,
        keyIncludes: row.key,
        status: 500,
        times: 30,
      });
    }
    const second = await syncAll(env);
    expect(second.stored).toBe(1);
    expect((await one(env, `key = '${(untried[0] as Der).key}'`)).state).toBe("stored");
  }, 120_000);
});

describe("what the world does while a copy is in flight", () => {
  /** The Worker's own binding to the derivatives bucket, with something happening just before a put. */
  const bindingWithPutHook = (hook: (key: string) => Promise<void>): R2Bucket =>
    ({
      get: (k: string) => derivatives.get(k),
      head: (k: string) => derivatives.head(k),
      list: (o?: Parameters<R2Bucket["list"]>[0]) => derivatives.list(o),
      delete: (k: string | string[]) => derivatives.delete(k),
      put: async (k: string, v: string, o?: Parameters<R2Bucket["put"]>[2]) => {
        await hook(k);
        return derivatives.put(k, v, o);
      },
    }) as unknown as R2Bucket;

  test("a deletion that dates the row while its description is written is not overwritten by a fresh 30 days (MUTATION: drop the date guard of the store statement)", async () => {
    const env = envOf();
    await zarrJob();
    // The description is written through the binding: this one lets the deletion happen as it is written.
    const during = envOf({
      COMPUTE_DERIVATIVES: bindingWithPutHook(async (k) => {
        if (k.endsWith("/derivative.json")) {
          await sql(env, "UPDATE compute_derivatives SET expires_at = datetime('now')");
        }
      }),
    });
    const result = await syncAll(during);
    expect(result).toMatchObject({ copied: 5, stored: 0 });
    const row = await one(env);
    expect(row.state).toBe("copying");
    const due = await env.DB.prepare(
      "SELECT expires_at <= datetime('now') AS due FROM compute_derivatives WHERE key = ?1",
    )
      .bind(row.key)
      .first<{ due: number }>();
    expect(due?.due).toBe(1);
    // The next sync expires it and deletes everything under it, the description included.
    expect(await syncAll(env)).toMatchObject({ expired: 1, deleted: 6 });
    expect(await keysUnder(row.key)).toEqual([]);
  });

  test("the statements that count a copy and store a row change nothing once the row is dated (MUTATION: drop the date guard of either)", async () => {
    const env = envOf();
    await zarrJob();
    await syncAll(env, { maxObjects: 1 });
    const row = await one(env);
    expect(row).toMatchObject({ state: "copying", copied: 1 });
    await sql(
      env,
      "UPDATE compute_derivatives SET expires_at = datetime('now') WHERE key = ?1",
      row.key,
    );
    expect((await sql(env, ADVANCE_COPIED_SQL, row.key, 1)).meta.changes).toBe(0);
    await sql(env, "UPDATE compute_derivatives SET copied = object_count WHERE key = ?1", row.key);
    expect((await sql(env, STORE_ROW_SQL, row.key)).meta.changes).toBe(0);
    expect(await one(env)).toMatchObject({ state: "copying", stored_at: null });
    // Undated, the same statements work: the guards are what they are for.
    await sql(env, "UPDATE compute_derivatives SET expires_at = NULL WHERE key = ?1", row.key);
    expect((await sql(env, STORE_ROW_SQL, row.key)).meta.changes).toBe(1);
    expect(await one(env)).toMatchObject({ state: "stored" });
  });

  /** What a second sync does to a row that has ended while this one still copies it: it ends, and cleans. */
  const endMeanwhile = async (env: Bindings): Promise<void> => {
    await sql(
      env,
      `UPDATE compute_derivatives SET state = 'expired', copied = object_count, ended_at = datetime('now'),
         expires_at = datetime('now', '-1 days')`,
    );
    await emptyBucket(derivatives);
    await sql(env, "UPDATE compute_derivatives SET copied = 0");
  };

  test("a file that lands after its row has ended and been cleaned is deleted, not forgotten (MUTATION: leave the late object)", async () => {
    const env = envOf();
    await zarrJob();
    let once = true;
    lossy.beforePut = async (k) => {
      if (once && k.endsWith("sub-01_qc.json")) {
        once = false;
        await endMeanwhile(env);
      }
    };
    const result = await syncAll(env);
    expect(result).toMatchObject({ stored: 0, errored: 0 });
    const row = await one(env);
    expect(row.state).toBe("expired");
    expect(await keysUnder(row.key)).toEqual([]);
  });

  test("a description that lands after its row has ended and been cleaned is deleted too (MUTATION: leave the late description)", async () => {
    const env = envOf();
    await zarrJob();
    let once = true;
    const during = envOf({
      COMPUTE_DERIVATIVES: bindingWithPutHook(async (k) => {
        if (once && k.endsWith("/derivative.json")) {
          once = false;
          await endMeanwhile(env);
        }
      }),
    });
    const result = await syncAll(during);
    expect(result).toMatchObject({ stored: 0, errored: 0 });
    const row = await one(env);
    expect(row.state).toBe("expired");
    expect(await keysUnder(row.key)).toEqual([]);
  });

  test("a stamp read decided by a second call is not remembered as a duplicate (MUTATION: drop the guard of the skip statement)", async () => {
    const env = envOf();
    const made = await zarrJob();
    await syncAll(env);
    expect((await sql(env, SKIP_STAMP_SQL, made.stampId, "duplicate_key")).meta.changes).toBe(0);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM compute_derivative_skips").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
    // A stamp with no row of its own is remembered.
    expect((await sql(env, SKIP_STAMP_SQL, made.stampId + 1000, "key_invalid")).meta.changes).toBe(
      1,
    );
  });
});

describe("the database holds what the code cannot undo", () => {
  test("a published row is never deleted and never changes its class, state or DOI, whatever runs (MUTATION: remove a trigger)", async () => {
    const env = envOf();
    await zarrJob();
    await syncAll(env);
    const row = await one(env);
    await retention(row.key, "admin", "catalog");
    await retention(row.key, "owner", "published");
    const message = async (statement: string): Promise<string> => {
      try {
        await sql(env, statement, row.key);
      } catch (err) {
        return String(err);
      }
      return "";
    };
    expect(await message("DELETE FROM compute_derivatives WHERE key = ?1")).toContain(
      "a published derivative is never deleted",
    );
    for (const set of [
      "retention = 'catalog'",
      "retention = 'canary'",
      "state = 'expired'",
      "state = 'failed', failure = 'copy_failed'",
      "doi = '10.1234/x'",
    ]) {
      expect(await message(`UPDATE compute_derivatives SET ${set} WHERE key = ?1`), set).toContain(
        "a published derivative keeps its class, its state and its doi",
      );
    }
    // What does not change those three is allowed: the dates, for one.
    expect(
      await message(
        "UPDATE compute_derivatives SET expires_at = datetime('now', '+1 days') WHERE key = ?1",
      ),
    ).toBe("");
    expect(await one(env)).toMatchObject({ retention: "published", state: "stored", doi: null });
    expect(await keysUnder(row.key)).toHaveLength(6);
  });

  test("a row that is not published can still be deleted by an owner's SQL (the guard is for what cannot be undone)", async () => {
    const env = envOf();
    await zarrJob();
    await syncAll(env);
    const row = await one(env);
    await sql(env, "DELETE FROM compute_derivatives WHERE key = ?1", row.key);
    expect(await all(env)).toHaveLength(0);
  });
});

describe("what an administrator reads and sends", () => {
  test("a description that cannot be read is null, and the error's name is logged (MUTATION: swallow the error)", async () => {
    const env = envOf();
    await zarrJob();
    await syncAll(env);
    const row = await one(env);
    const broken = {
      get: () => Promise.reject(new Error("the bucket is down")),
      head: () => Promise.reject(new Error("the bucket is down")),
    } as unknown as R2Bucket;
    let reply: Reply | undefined;
    const lines = await logged(async () => {
      reply = await call(
        "GET",
        `/compute/derivatives/${row.key}`,
        "admin",
        undefined,
        envOf({ COMPUTE_DERIVATIVES: broken }),
      );
    });
    expect(reply).toMatchObject({ status: 200, body: { description: null } });
    expect(
      lines.some((l) => l.includes("description_unreadable") && l.includes("error=Error")),
    ).toBe(true);
    expect(lines.join("\n")).not.toContain("the bucket is down");
  });

  test("a sync body that is not JSON is refused, an empty one is a sync (MUTATION: read a bad body as an empty one)", async () => {
    const env = envOf();
    const send = (body: string) =>
      handle(
        new Request("http://api.test/admin/compute/derivatives/sync", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${COMPUTE_KEYS.admin}`,
            "Content-Type": "application/json",
          },
          body,
        }),
        env,
      );
    const bad = await send("{not json");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "invalid_body" });
    const empty = await send("");
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ ok: true });
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'compute.derivatives.sync'",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });
});

describe("an anonymous dataset has no derivative", () => {
  test("an anonymous dataset is never keyed, so no description can carry a version identifier that does not resolve (MUTATION: drop the eligibility term of the scan)", async () => {
    const env = envOf();
    const made = await zarrJob();
    await sql(
      env,
      "UPDATE datasets SET first_published_at = NULL, anonymous = 1 WHERE dataset_id = ?1",
      made.id,
    );
    expect(await syncAll(env)).toMatchObject({ examined: 0, created: 0, stored: 0 });
    expect(await all(env)).toHaveLength(0);
  });
});

// --- A dataset that stopped being eligible ----------------------------------------------------------------------------

describe("a dataset that is no longer eligible after its job finished", () => {
  const unpublish = (id: string) =>
    sql(envOf(), "UPDATE datasets SET visibility = 'private' WHERE dataset_id = ?1", id);
  const publish = (id: string) =>
    sql(envOf(), "UPDATE datasets SET visibility = 'public' WHERE dataset_id = ?1", id);

  test("the scan neither keys nor copies it, and keys it once it is public again (MUTATION: drop the eligibility term of the scan)", async () => {
    const env = envOf();
    const made = await zarrJob();
    await unpublish(made.id);
    const first = await syncAll(env);
    expect(first).toMatchObject({ examined: 0, created: 0 });
    expect(await all(env)).toHaveLength(0);
    await publish(made.id);
    expect(await syncAll(env)).toMatchObject({ created: 1 });
  });

  test("the insert adds nothing for it (MUTATION: drop the eligibility term of the insert)", async () => {
    const env = envOf();
    const first = await zarrJob();
    await syncAll(env);
    const row = await one(env);
    const second = await zarrJob();
    await unpublish(second.id);
    const insert = (key: string) =>
      env.DB.prepare(INSERT_DERIVATIVE_SQL)
        .bind(
          key,
          second.id,
          second.version,
          row.recipe,
          row.recipe_version,
          row.engine,
          row.input,
          row.profile,
          row.input_digest,
          row.image_digest,
          second.jobId,
          second.stampId,
          1,
          1,
        )
        .run();
    expect((await insert("a".repeat(64))).meta.changes).toBe(0);
    await publish(second.id);
    expect((await insert("b".repeat(64))).meta.changes).toBe(1);
    void first;
  });

  test("neither promotion takes it (MUTATION: drop the eligibility term of the live condition)", async () => {
    const env = envOf();
    const made = await zarrJob();
    await syncAll(env);
    const row = await one(env);
    await unpublish(made.id);
    expect((await retention(row.key, "admin", "catalog")).status).toBe(409);
    expect(await one(env)).toMatchObject({ retention: "canary" });
    await publish(made.id);
    expect((await retention(row.key, "admin", "catalog")).status).toBe(200);
    await unpublish(made.id);
    expect((await retention(row.key, "owner", "published")).status).toBe(409);
    expect(await one(env)).toMatchObject({ retention: "catalog" });
    await publish(made.id);
    expect((await retention(row.key, "owner", "published")).status).toBe(200);
  });

  test("unpublished between the scan and the insert, its stamp stays undecided and is keyed once public again (MUTATION: skip it as dataset_gone)", async () => {
    const env = envOf();
    const made = await zarrJob();
    // The scan has read the stamp as eligible; keying it reads the job's records next, and the dataset goes
    // private during that read, so the insert that follows adds nothing.
    const records = env.COMPUTE_RECORDS;
    let fired = false;
    const during = envOf({
      COMPUTE_RECORDS: new Proxy(records, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop !== "get" || typeof value !== "function") {
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async (...a: unknown[]) => {
            if (!fired) {
              fired = true;
              await unpublish(made.id);
            }
            return value.apply(target, a);
          };
        },
      }),
    });
    expect(await syncAll(during)).toMatchObject({ examined: 1, created: 0, errored: 0 });
    expect(fired).toBe(true);
    expect(await all(env)).toHaveLength(0);
    const skips = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM compute_derivative_skips WHERE stamp_id = ?1",
    )
      .bind(made.stampId)
      .first<{ n: number }>();
    expect(skips?.n).toBe(0);
    await publish(made.id);
    expect(await syncAll(env)).toMatchObject({ created: 1 });
  });
});
