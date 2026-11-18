#!/usr/bin/env bun
/**
 * The local control-plane stack (portable compute, card DM-08; plan section 3).
 *
 * NEMAR's REAL compute, runner, webhook and admin routers on loopback, over a persistent SQLite database
 * carrying every migration and a persistent Miniflare R2 behind the S3 stand-in. It is the test harness
 * (`backend/test/helpers/compute-*.ts`) made long-running. IT IS NOT A DEPLOYMENT: it says so on start,
 * it has no Tapis configuration, no cron, no mail and no GitHub, and nothing in it reaches NEMAR's
 * production database or buckets.
 *
 *   bun backend/scripts/compute-local-stack.ts serve --state <dir> --image <ref@sha256:hex>
 *        [--port 8787] [--s3-port 8788] [--seed-fixture] [--seed-from-catalog <id>]...
 *   bun backend/scripts/compute-local-stack.ts outputs --state <dir> --job <id> --to <dir> [--port 8787] [--s3-port 8788]
 *
 * WHO CAN REACH IT. A runner on another machine reaches the two loopback ports through `ssh -R`, which
 * makes them reachable by every local user of that machine. So: both servers bind 127.0.0.1 and refuse any
 * other host; the S3 stand-in's access key and secret are 32 random bytes each, generated on first start
 * (never the public defaults of the test stand-in); every secret is in a mode-0600 file under a mode-0700
 * directory, and the process runs with umask 077 so nothing it or the Miniflare process creates is wider.
 * The keys are never printed.
 *
 * STATE (`<dir>`, mode 0700): `stack.sqlite` (the database; each migration is recorded when applied, and a
 * missing one is applied at the next start, never a reset), `r2/` (the two buckets), `s3.json` (the S3
 * stand-in's credentials), `secret` (`PRESCREEN_CALLBACK_SECRET`), `keys.json` (API keys of the seeded
 * `owner`, `admin` and `pipelines` accounts). A restart keeps all of it.
 *
 * SEEDS, through the real services, on first start and repaired if a start was interrupted: an owner, an
 * administrator, the `nemar-pipelines` service account, the default compute policy as a stored version,
 * and a grant to the `pipelines` and `people` platform pools. The owner can then register a runner.
 *
 * DATASETS. `--seed-fixture` inserts the pipeline fixture's dataset (no network). `--seed-from-catalog <id>`
 * reads the PUBLIC record at api.nemar.org and inserts only the values the pipeline eligibility predicate and
 * the run's version choice read; it refuses the live datasets nm000103 to nm000107 and the reserved fixture
 * band. The public API does not serve a dataset's version list (that route is authenticated), so the one
 * version row is built from the record's `latest_version*` fields, and the record's `zarr_source_commit`
 * (the commit the serving copy was built from) is kept as the version's commit.
 *
 * THE ZARR SOURCE CHECK (card DM-06b). A Zarr recipe is dispatched only when the serving copy's own commit S is
 * the tag's commit T or a metadata-only step after it, read from the serving index and from GitHub. So:
 *  - `--seed-from-catalog` points the check's index read at the public serving host (`NEMAR_ZARR_INDEX_BASE`)
 *    and leaves GitHub at its public API, unauthenticated (the stack has no GitHub App); a dataset whose public
 *    index is there is recorded as `ready` with the index's store count, so the Zarr recipe can be dispatched.
 *  - `--seed-fixture` starts a stand-in for the two (a real loopback server, nothing of GitHub's or the host's)
 *    that names the fixture version's commit as both the tag's and the index's: the verdict is `exact`.
 * The seams follow what the STATE DATABASE holds, not the flags of this start: a plain restart over a state
 * that holds the fixture starts the stand-in again, and one over a state that holds a catalog dataset points
 * the index read at the public serving host. A state (or a start) that would hold both is refused before
 * anything is started: the check reads one GitHub API and one index base for the whole stack, and the fixture's
 * id lies in the live allocation range, which must never be read from the real GitHub or serving host.
 */

import type { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Hono } from "hono";
import { Miniflare } from "miniflare";
import { DEFAULT_COMPUTE_POLICY, PIPELINES_TAPIS_OWNER } from "../../shared/contract/compute";
import { adminRoutes } from "../src/routes/admin";
import { computeRoutes } from "../src/routes/compute";
import { computeRunnerRoutes } from "../src/routes/compute-runners";
import webhooks from "../src/routes/webhooks";
import { grantPool, platformPool } from "../src/services/compute-ledger";
import { loadPipelineRow } from "../src/services/compute-pipeline-eligibility";
import { getPolicy, putPolicy } from "../src/services/compute-policy";
import { imageFacts } from "../src/services/compute-runtime-image";
import { isReservedFixtureId } from "../src/services/datasetId";
import { generateApiKey, hashApiKey } from "../src/services/token";
import { readZarrIndexOverHttp } from "../src/services/zarr-source-check";
import type { Bindings, Variables } from "../src/types/bindings";
import { seedEegDataset, seedPipelinesAccount } from "../test/helpers/compute-pipeline-fixture";
import {
  type ComputeS3Standin,
  HOST_REFUSAL_BODY,
  HOST_REFUSAL_STATUS,
  loopbackHostAllowed,
  startComputeS3Standin,
} from "../test/helpers/compute-s3-standin";
import { seedUser } from "../test/helpers/compute-seed";
import { openMigratedDb, realD1 } from "../test/helpers/d1";
import {
  type GithubCompareStandin,
  startGithubCompareStandin,
} from "../test/helpers/github-compare-standin";
import { retryInfrastructure } from "../test/helpers/neurobagel-harness";

export const LOOPBACK = "127.0.0.1";
export const DEFAULT_PORT = 8787;
export const DEFAULT_S3_PORT = 8788;
export const PUBLIC_API = "https://api.nemar.org";
export const CATALOG_USER_AGENT = "nemar-local-stack/0";
/** The public serving host's origin: where `--seed-from-catalog` reads each dataset's serving index. */
export const PUBLIC_ZARR_BASE = "https://zarr.nemar.org";
/**
 * The fixture dataset `--seed-fixture` inserts: a real-shaped `nm` id below the reserved band, one version.
 * The id lies in the live allocation range, so `--seed-from-catalog` refuses it (a real dataset may one day
 * hold it); a standing fixture in the reserved band needs the owner (ADR 0068) and is not taken here.
 */
export const FIXTURE_DATASET_ID = "nm000900";
/** The commit the fixture's version names; a fixture value, not a real commit. */
export const FIXTURE_SOURCE_COMMIT = "f".repeat(40);
/** The data-plane tag of the fixture's one version (`1.0.0`, as `seedEegDataset` writes it). */
export const FIXTURE_VERSION_TAG = "v1.0.0";
/** The live datasets (public, DOIs minted): never read into this stack either. */
const LIVE_DATASETS = new Set(["nm000103", "nm000104", "nm000105", "nm000106", "nm000107"]);
const BUCKETS = { records: "nemar-compute-records", results: "nemar-compute-results" } as const;
const KEY_NAMES = ["owner", "admin", "pipelines"] as const;
type KeyName = (typeof KEY_NAMES)[number];

const FIXTURE_OWNER = { username: "local-owner", email: "local-owner@example.test" } as const;
const FIXTURE_ADMIN = { username: "local-admin", email: "local-admin@example.test" } as const;

export interface StackOptions {
  state: string;
  /** 0 picks an ephemeral port (tests); the default is {@link DEFAULT_PORT}. */
  port?: number;
  s3Port?: number;
  /** Only `127.0.0.1` is accepted. */
  host?: string;
  /** A digest-pinned reference: `COMPUTE_RUNTIME_IMAGE`. */
  image: string;
  seedFixture?: boolean;
  seedFromCatalog?: string[];
  /** Where the public record is read from (a test points it at a local stand-in). */
  catalogBase?: string;
  /** Where the serving copy's index is read from by the Zarr source check; the public serving host by default. */
  zarrIndexBase?: string;
  /** Called with each line the stack would print. */
  log?: (line: string) => void;
}

export interface LocalStack {
  url: string;
  s3Url: string;
  port: number;
  s3Port: number;
  state: string;
  env: Bindings;
  db: Database;
  keys: Record<KeyName, string>;
  standin: ComputeS3Standin;
  /** The names of the dataset columns copied by `--seed-from-catalog`, per id. */
  copied: Record<string, string[]>;
  stop(): Promise<void>;
  /**
   * The synchronous part of a stop, for a signal handler that must exit in the same tick (Miniflare's
   * own handler exits synchronously after ours): close both servers, close the database, and make the
   * state private. Miniflare is disposed by the process's `exit` event.
   */
  stopNow(): void;
}

// --- Files -------------------------------------------------------------------------------------------

/** Create `dir` mode 0700 (and make an existing one so). */
function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Write a secret file, mode 0600 whatever the umask was. */
function privateFile(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Every file under `dir` is 0600 and every directory 0700: a pass for what an earlier version or a tool left. */
export function hardenTree(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      chmodSync(path, 0o700);
      hardenTree(path);
    } else if (entry.isFile()) {
      chmodSync(path, 0o600);
    }
  }
}

/** The mode of every file and directory under `dir` (and `dir` itself), as `[path, octal]`. */
export function treeModes(dir: string): Array<[string, string]> {
  const out: Array<[string, string]> = [[dir, (statSync(dir).mode & 0o777).toString(8)]];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...treeModes(path));
    else out.push([path, (statSync(path).mode & 0o777).toString(8)]);
  }
  return out;
}

const randomHex = () => randomBytes(32).toString("hex");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

/** The public defaults of the test S3 stand-in: never a credential of this stack. */
const PUBLIC_STANDIN_VALUES = new Set(["STANDINKEYID", "standin-secret-access-key"]);

/**
 * Whether a stored secret is one this stack could have made: a string of at least 32 characters that is
 * not a public default and is not a repeated or near-constant value (an all-zero or `abab...` file).
 */
export function usableSecret(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 32 &&
    !PUBLIC_STANDIN_VALUES.has(value) &&
    new Set(value).size >= 8
  );
}

/** The S3 credentials of this state: 32 random bytes each, made once and reused. */
function s3Credentials(state: string): { accessKeyId: string; secretAccessKey: string } {
  const path = join(state, "s3.json");
  if (existsSync(path)) {
    const found = readJson<{ accessKeyId?: unknown; secretAccessKey?: unknown }>(path);
    if (
      usableSecret(found.accessKeyId) &&
      usableSecret(found.secretAccessKey) &&
      found.accessKeyId !== found.secretAccessKey
    ) {
      return { accessKeyId: found.accessKeyId, secretAccessKey: found.secretAccessKey };
    }
    throw new Error(
      "s3.json in the state directory is not usable; remove the directory to start over",
    );
  }
  const made = { accessKeyId: randomHex(), secretAccessKey: randomHex() };
  privateFile(path, `${JSON.stringify(made)}\n`);
  return made;
}

function callbackSecret(state: string): string {
  const path = join(state, "secret");
  if (existsSync(path)) {
    const found = readFileSync(path, "utf-8").trim();
    if (usableSecret(found)) return found;
    throw new Error(
      "secret in the state directory is not usable; remove the directory to start over",
    );
  }
  const made = randomHex();
  privateFile(path, `${made}\n`);
  return made;
}

/** `keys.json`, made on first start before any account is written, so an interrupted seed can be repaired. */
function apiKeys(state: string): Record<KeyName, { apiKey: string; apiKeyPrefix: string }> {
  const path = join(state, "keys.json");
  if (existsSync(path)) {
    const found = readJson<Record<string, unknown>>(path);
    const out = {} as Record<KeyName, { apiKey: string; apiKeyPrefix: string }>;
    for (const name of KEY_NAMES) {
      const key = found[name];
      if (!usableSecret(key)) {
        throw new Error(
          "keys.json in the state directory is not usable; remove the directory to start over",
        );
      }
      out[name] = { apiKey: key, apiKeyPrefix: `${key.substring(0, 11)}...` };
    }
    return out;
  }
  const made = {} as Record<KeyName, { apiKey: string; apiKeyPrefix: string }>;
  for (const name of KEY_NAMES) made[name] = generateApiKey();
  privateFile(
    path,
    `${JSON.stringify(Object.fromEntries(KEY_NAMES.map((n) => [n, made[n].apiKey])), null, 2)}\n`,
  );
  return made;
}

// --- Seeds -------------------------------------------------------------------------------------------

async function userIdOf(db: D1Database, username: string): Promise<number | null> {
  const row = await db
    .prepare("SELECT id FROM users WHERE username = ?1")
    .bind(username)
    .first<{ id: number }>();
  return row ? row.id : null;
}

async function ensureKey(
  db: D1Database,
  userId: number,
  key: { apiKey: string; apiKeyPrefix: string },
): Promise<void> {
  const hash = await hashApiKey(key.apiKey);
  const there = await db
    .prepare("SELECT 1 AS present FROM tokens WHERE api_key_hash = ?1")
    .bind(hash)
    .first();
  if (there) return;
  await db
    .prepare("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?1, ?2, ?3)")
    .bind(userId, hash, key.apiKeyPrefix)
    .run();
}

async function ensurePerson(
  db: D1Database,
  who: { username: string; email: string },
  role: "owner" | "admin",
): Promise<number> {
  return (await userIdOf(db, who.username)) ?? (await seedUser(db, { ...who, role }));
}

/** Everything the owner needs to register a runner; safe to run at every start. */
async function seed(
  env: Bindings,
  keys: Record<KeyName, { apiKey: string; apiKeyPrefix: string }>,
): Promise<void> {
  const db = env.DB;
  const ownerId = await ensurePerson(db, FIXTURE_OWNER, "owner");
  const adminId = await ensurePerson(db, FIXTURE_ADMIN, "admin");
  const pipelinesId = await seedPipelinesAccount(env, { reuse: true });
  await ensureKey(db, ownerId, keys.owner);
  await ensureKey(db, adminId, keys.admin);
  await ensureKey(db, pipelinesId, keys.pipelines);
  // The default policy as a stored version, once; an owner's later versions are never touched.
  if ((await getPolicy(db)).version === null) {
    const put = await putPolicy(db, ownerId, { ...DEFAULT_COMPUTE_POLICY }, "local stack seed");
    if (!put.ok)
      throw new Error(`could not store the default compute policy: ${JSON.stringify(put)}`);
  }
  // Fixed idempotency keys: a restart replays the grant, it does not make a second one.
  for (const [key, milli] of [
    ["pipelines", 10_000_000],
    ["people", 1_000_000_000],
  ] as const) {
    const pool = await platformPool(db, key, "cpu");
    if (!pool) throw new Error(`no platform pool ${key}/cpu: the migrations did not seed it`);
    const granted = await grantPool(db, {
      poolId: pool.id,
      amountMilli: milli,
      actorUserId: ownerId,
      idempotencyKey: `local-stack-seed-${key}`,
    });
    if (!granted.ok) throw new Error(`could not grant the ${key} pool: ${JSON.stringify(granted)}`);
  }
}

// --- Datasets ----------------------------------------------------------------------------------------

/** The refusal for an id the catalog seed may not read, or null. */
export function catalogRefusal(id: string): string | null {
  if (!/^(nm|on)\d{6}$/.test(id)) return `${id}: not a dataset id (nm or on, six digits)`;
  if (LIVE_DATASETS.has(id))
    return `${id}: a live dataset (public, DOIs minted) is never read or copied here`;
  if (isReservedFixtureId(id)) return `${id}: in the reserved fixture band`;
  if (id === FIXTURE_DATASET_ID) {
    return `${id}: the id of the local fixture dataset (--seed-fixture), not read from the catalog`;
  }
  return null;
}

/** The public dataset-record fields copied into `datasets`: the eligibility predicate's inputs and the name. */
const CATALOG_DATASET_FIELDS = [
  "dataset_id",
  "name",
  "status",
  "visibility",
  "anonymous",
  "first_published_at",
  "withdrawn_at",
  "ezid_status",
  "is_sandbox",
  "is_exemplar",
  "modalities",
  "zarr_source_commit",
] as const;
/** The public record's version fields, and the `dataset_versions` columns they become. */
const CATALOG_VERSION_FIELDS = [
  "latest_version",
  "latest_version_at",
  "latest_version_doi",
  "total_files",
] as const;

async function seedFromCatalog(
  env: Bindings,
  id: string,
  ownerId: number,
  base: string,
  zarrIndexBase: string,
): Promise<string[]> {
  const refusal = catalogRefusal(id);
  if (refusal) throw new Error(refusal);
  const res = await fetch(`${base}/datasets/${id}`, {
    headers: { "User-Agent": CATALOG_USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${id}: the public API answered ${res.status}`);
  const record = ((await res.json()) as { dataset?: Record<string, unknown> }).dataset;
  if (!record || record.dataset_id !== id)
    throw new Error(`${id}: the public record is not for this dataset`);
  const missing = [...CATALOG_DATASET_FIELDS, ...CATALOG_VERSION_FIELDS].filter(
    (f) => !(f in record),
  );
  // zarr_source_commit and total_files may legitimately be null; a field the API does not serve at all
  // is the stop condition: the predicate would be reading a default.
  if (missing.length > 0)
    throw new Error(`${id}: the public record does not serve ${missing.join(", ")}`);
  const version = record.latest_version;
  if (typeof version !== "string" || version === "") {
    throw new Error(`${id}: the public record names no version`);
  }
  await env.DB.prepare(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, anonymous,
                           first_published_at, withdrawn_at, ezid_status, is_sandbox, is_exemplar,
                           modalities, zarr_source_commit)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
  )
    .bind(
      id,
      String(record.name ?? id),
      ownerId,
      record.status ?? null,
      record.visibility ?? null,
      record.anonymous ?? null,
      record.first_published_at ?? null,
      record.withdrawn_at ?? null,
      record.ezid_status ?? null,
      record.is_sandbox ?? 0,
      record.is_exemplar ?? 0,
      record.modalities ?? null,
      record.zarr_source_commit ?? null,
    )
    .run();
  await env.DB.prepare(
    `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at, total_files)
     VALUES (?1, ?2, ?3, 'ezid', ?4, ?5)`,
  )
    .bind(
      id,
      version,
      String(record.latest_version_doi ?? ""),
      String(record.latest_version_at ?? "1970-01-01 00:00:00"),
      typeof record.total_files === "number" ? record.total_files : null,
    )
    .run();
  const seeded: string[] = [...CATALOG_DATASET_FIELDS, ...CATALOG_VERSION_FIELDS];
  // A dataset with a serving copy is recorded `ready` only when its public index says so, with the index's own
  // store count: the Zarr recipe is dispatched only while the copy is ready with a store (DM-06), and the
  // public record does not carry either value.
  if (typeof record.zarr_source_commit === "string") {
    const index = await readZarrIndexOverHttp(zarrIndexBase, id, CATALOG_USER_AGENT);
    if (index.ok && index.storeCount !== null && index.storeCount > 0) {
      await env.DB.prepare(
        "UPDATE datasets SET zarr_status = 'ready', zarr_store_count = ?1 WHERE dataset_id = ?2",
      )
        .bind(index.storeCount, id)
        .run();
      seeded.push("zarr_status", "zarr_store_count");
    }
  }
  return seeded;
}

async function datasetThere(db: D1Database, id: string): Promise<boolean> {
  return (
    (await db
      .prepare("SELECT 1 AS present FROM datasets WHERE dataset_id = ?1")
      .bind(id)
      .first()) !== null
  );
}

// --- The stack ---------------------------------------------------------------------------------------

/** The four routers as `backend/src/index.ts` mounts them, at the paths the CLI and the runner use. */
function makeApp(
  port: () => number,
): (req: Request, env: Bindings) => Response | Promise<Response> {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  // DNS rebinding: ENVIRONMENT is `development` here (no rate limit, dev-only sign-in branches), so a
  // browser tricked into resolving a name to this address must not reach a single route. Only the two
  // loopback spellings of the stack's own port are served; a missing Host, another name, another IP
  // literal and another port get the same fixed refusal.
  app.use("*", async (c, next) => {
    if (!loopbackHostAllowed(c.req.header("host") ?? null, port())) {
      return c.body(HOST_REFUSAL_BODY, HOST_REFUSAL_STATUS, { "Content-Type": "application/json" });
    }
    await next();
  });
  app.get("/health", (c) =>
    c.json({ status: "ok", timestamp: new Date().toISOString(), stack: "local" }),
  );
  // The CLI asks for notices on start; a local stack has none.
  app.get("/notices", (c) => c.json({ notices: [] }));
  app.route("/admin", adminRoutes);
  app.route("/compute", computeRoutes);
  app.route("/compute/runners", computeRunnerRoutes);
  app.route("/webhooks", webhooks);
  return (req, env) =>
    app.fetch(req, env, {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext);
}

export async function startLocalStack(opts: StackOptions): Promise<LocalStack> {
  const host = opts.host ?? LOOPBACK;
  if (host !== LOOPBACK) {
    throw new Error(`refusing host ${host}: the stack binds ${LOOPBACK} only`);
  }
  const facts = imageFacts(opts.image);
  if (facts === null)
    throw new Error("--image must be a digest-pinned reference (<ref>@sha256:<64 hex>)");
  for (const id of opts.seedFromCatalog ?? []) {
    const refusal = catalogRefusal(id);
    if (refusal) throw new Error(refusal);
  }
  if (opts.seedFixture && (opts.seedFromCatalog ?? []).length > 0) {
    throw new Error(
      "--seed-fixture and --seed-from-catalog are not combined: the Zarr source check reads one GitHub API and one index base",
    );
  }
  const log = opts.log ?? ((line: string) => console.log(line));
  const state = resolve(opts.state);
  const previousUmask = process.umask(0o077);
  privateDir(state);
  privateDir(join(state, "r2"));
  hardenTree(state);

  const creds = s3Credentials(state);
  const secret = callbackSecret(state);
  const keys = apiKeys(state);
  const { db, applied } = openMigratedDb(join(state, "stack.sqlite"));
  if (applied.length > 0) log(`applied ${applied.length} migration(s) to the state database`);

  // What the state already holds decides the Zarr source check's seams, together with this start's seeds.
  const held = (
    db.query("SELECT dataset_id FROM datasets").all() as Array<{ dataset_id: string }>
  ).map((r) => r.dataset_id);
  const holdsFixture = opts.seedFixture === true || held.includes(FIXTURE_DATASET_ID);
  const catalogIds = [
    ...held.filter((id) => id !== FIXTURE_DATASET_ID),
    ...(opts.seedFromCatalog ?? []),
  ];
  const refuseState = (message: string): never => {
    db.close();
    process.umask(previousUmask);
    throw new Error(message);
  };
  for (const id of held) {
    // A dataset in the live or reserved range, other than the local fixture, is never read from the network.
    const refusal = id === FIXTURE_DATASET_ID ? null : catalogRefusal(id);
    if (refusal) refuseState(`the state holds ${refusal}`);
  }
  if (holdsFixture && catalogIds.length > 0) {
    refuseState(
      "the state holds (or this start seeds) both the fixture and a catalog dataset: the Zarr source check reads one GitHub API and one index base, so use separate states",
    );
  }

  const infra = await retryInfrastructure("miniflare", async () => {
    const mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      compatibilityDate: "2024-12-01",
      r2Buckets: ["COMPUTE_RECORDS", "COMPUTE_RESULTS"],
      r2Persist: join(state, "r2"),
    });
    try {
      const records = (await mf.getR2Bucket("COMPUTE_RECORDS")) as unknown as R2Bucket;
      const results = (await mf.getR2Bucket("COMPUTE_RESULTS")) as unknown as R2Bucket;
      await records.list({ limit: 1 });
      await results.list({ limit: 1 });
      return { mf, records, results };
    } catch (err) {
      await mf.dispose().catch(() => {});
      throw err;
    }
  });

  const standin = startComputeS3Standin({
    buckets: { [BUCKETS.records]: infra.records, [BUCKETS.results]: infra.results },
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    port: opts.s3Port ?? DEFAULT_S3_PORT,
    hostGuard: true,
  });
  const g = globalThis as { NEMAR_COMPUTE_S3_URL?: string };
  const previousS3Url = g.NEMAR_COMPUTE_S3_URL;
  g.NEMAR_COMPUTE_S3_URL = standin.url;
  const s3Port = Number(new URL(standin.url).port);

  const env = {
    DB: realD1(db),
    ENVIRONMENT: "development",
    COMPUTE_ENABLED: "1",
    COMPUTE_RUNNERS_ENABLED: "1",
    COMPUTE_RUNTIME_IMAGE: facts.ref,
    API_BASE_URL: `http://${LOOPBACK}:0`,
    PRESCREEN_CALLBACK_SECRET: secret,
    COMPUTE_RECORDS: infra.records,
    COMPUTE_RESULTS: infra.results,
    COMPUTE_RECORDS_BUCKET_NAME: BUCKETS.records,
    COMPUTE_RESULTS_BUCKET_NAME: BUCKETS.results,
    COMPUTE_R2_ACCESS_KEY_ID: creds.accessKeyId,
    COMPUTE_R2_SECRET_ACCESS_KEY: creds.secretAccessKey,
    // Nothing listens here: the global override above is what the signer addresses.
    COMPUTE_R2_S3_ENDPOINT: "http://127.0.0.1:1",
  } as unknown as Bindings;

  // The Zarr source check's two external services (see the header). Read at call time, restored at teardown.
  const zarrSeams = globalThis as { NEMAR_GITHUB_API_URL?: string; NEMAR_ZARR_INDEX_BASE?: string };
  const previousGithub = zarrSeams.NEMAR_GITHUB_API_URL;
  const previousIndexBase = zarrSeams.NEMAR_ZARR_INDEX_BASE;
  let zarrStandin: GithubCompareStandin | undefined;
  if (holdsFixture) {
    zarrStandin = startGithubCompareStandin();
    zarrSeams.NEMAR_GITHUB_API_URL = zarrStandin.url;
    zarrSeams.NEMAR_ZARR_INDEX_BASE = zarrStandin.indexBase;
  } else if (catalogIds.length > 0) {
    zarrSeams.NEMAR_ZARR_INDEX_BASE = opts.zarrIndexBase ?? PUBLIC_ZARR_BASE;
  }
  const restoreZarrSeams = () => {
    zarrStandin?.stop();
    zarrSeams.NEMAR_GITHUB_API_URL = previousGithub;
    zarrSeams.NEMAR_ZARR_INDEX_BASE = previousIndexBase;
  };

  let server: ReturnType<typeof Bun.serve> | undefined;
  const closeNow = () => {
    server?.stop(true);
    restoreZarrSeams();
    standin.stop();
    db.close();
    hardenTree(state);
  };
  const teardown = async () => {
    server?.stop(true);
    restoreZarrSeams();
    standin.stop();
    g.NEMAR_COMPUTE_S3_URL = previousS3Url;
    await infra.mf.dispose().catch(() => {});
    db.close();
    hardenTree(state);
    process.umask(previousUmask);
  };
  try {
    const handle = makeApp(() => server?.port as number);
    server = Bun.serve({
      port: opts.port ?? DEFAULT_PORT,
      hostname: LOOPBACK,
      fetch: (req) => handle(req, env),
    });
    const port = server.port as number;
    (env as { API_BASE_URL: string }).API_BASE_URL = `http://${LOOPBACK}:${port}`;

    await seed(env, keys);
    const ownerId = (await userIdOf(env.DB, FIXTURE_OWNER.username)) as number;
    if (holdsFixture) {
      if (!(await datasetThere(env.DB, FIXTURE_DATASET_ID))) {
        await seedEegDataset(env, FIXTURE_DATASET_ID, { owner: ownerId });
      }
      // A ready serving copy built from the fixture version's commit, which the stand-in names as the tag's
      // commit too: the Zarr source check's verdict is `exact`. Every start, so a state made before the check
      // existed is brought up to date; the stand-in's answers live only as long as this process.
      await env.DB.prepare(
        "UPDATE datasets SET zarr_source_commit = ?1, zarr_status = 'ready', zarr_store_count = 1 WHERE dataset_id = ?2",
      )
        .bind(FIXTURE_SOURCE_COMMIT, FIXTURE_DATASET_ID)
        .run();
    }
    if (zarrStandin) {
      zarrStandin.tag(FIXTURE_DATASET_ID, FIXTURE_VERSION_TAG, FIXTURE_SOURCE_COMMIT);
      zarrStandin.index(FIXTURE_DATASET_ID, {
        source_commit: FIXTURE_SOURCE_COMMIT,
        store_count: 1,
      });
    }
    const copied: Record<string, string[]> = {};
    for (const id of opts.seedFromCatalog ?? []) {
      if (await datasetThere(env.DB, id)) {
        log(`${id}: already in the state database, left as it is`);
        continue;
      }
      copied[id] = await seedFromCatalog(
        env,
        id,
        ownerId,
        opts.catalogBase ?? PUBLIC_API,
        opts.zarrIndexBase ?? PUBLIC_ZARR_BASE,
      );
      const checked = await loadPipelineRow(env.DB, id, env);
      log(`${id}: copied ${copied[id].join(", ")}`);
      log(
        checked.eligible
          ? `${id}: eligible for a pipeline run`
          : `${id}: NOT eligible for a pipeline run (blocked by ${checked.blockedBy.join(", ")})`,
      );
    }
    hardenTree(state);
    return {
      url: `http://${LOOPBACK}:${port}`,
      s3Url: standin.url,
      port,
      s3Port,
      state,
      env,
      db,
      keys: {
        owner: keys.owner.apiKey,
        admin: keys.admin.apiKey,
        pipelines: keys.pipelines.apiKey,
      },
      standin,
      copied,
      stop: teardown,
      stopNow: closeNow,
    };
  } catch (err) {
    await teardown();
    throw err;
  }
}

// --- outputs -----------------------------------------------------------------------------------------

/** One download: the path as the job declared it and its size. */
export interface Downloaded {
  path: string;
  size: number;
}

/**
 * Download every result of a finished job through the REAL links route, as the `pipelines` service
 * account that owns pipeline jobs: no body for the first page, then `{ after }` until the route has no
 * `next_after`. Returns the files, never an address.
 */
export async function downloadOutputs(opts: {
  state: string;
  job: string;
  to: string;
  port?: number;
  /** The port of the stack's S3 stand-in: every download must come from this loopback origin. */
  s3Port?: number;
}): Promise<Downloaded[]> {
  const keysPath = join(resolve(opts.state), "keys.json");
  const pipelines = readJson<Record<string, string>>(keysPath).pipelines;
  if (typeof pipelines !== "string") throw new Error("keys.json holds no pipelines key");
  const base = `http://${LOOPBACK}:${opts.port ?? DEFAULT_PORT}`;
  const s3Origin = `http://${LOOPBACK}:${opts.s3Port ?? DEFAULT_S3_PORT}`;
  const to = resolve(opts.to);
  mkdirSync(to, { recursive: true, mode: 0o700 });
  const root = realpathSync(to);
  const out: Downloaded[] = [];
  let after: string | null = null;
  do {
    const res: Response = await fetch(`${base}/compute/jobs/${opts.job}/links`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pipelines}`,
        ...(after === null ? {} : { "Content-Type": "application/json" }),
      },
      ...(after === null ? {} : { body: JSON.stringify({ after }) }),
    });
    const page = (await res.json().catch(() => ({}))) as {
      links?: Array<{ path: string; size: number; url: string }>;
      next_after?: string | null;
      code?: string;
    };
    if (!res.ok || !Array.isArray(page.links)) {
      throw new Error(
        `the links route answered ${res.status}${page.code ? ` (${page.code})` : ""}`,
      );
    }
    for (const link of page.links) {
      const target = resolve(root, link.path);
      if (!isInside(root, target) || !isInside(root, deepestRealAncestor(target))) {
        throw new Error(`refusing a path outside --to: ${link.path}`);
      }
      // The address is the route's, but the stack's own S3 stand-in is the only place it may point:
      // nothing else is fetched, and no redirect is followed to anywhere.
      let origin: string;
      try {
        origin = new URL(link.url).origin;
      } catch {
        throw new Error(`${link.path}: the link is not an address`);
      }
      if (origin !== s3Origin)
        throw new Error(`${link.path}: the link is not on the stack's S3 origin`);
      const got = await fetch(link.url, { redirect: "manual" });
      if (got.status >= 300 && got.status < 400) {
        throw new Error(`${link.path}: the download answered a redirect, which is not followed`);
      }
      if (!got.ok) throw new Error(`${link.path}: the download answered ${got.status}`);
      const bytes = new Uint8Array(await got.arrayBuffer());
      if (bytes.length !== link.size) {
        throw new Error(`${link.path}: ${bytes.length} bytes arrived, ${link.size} were declared`);
      }
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      // The directory now exists: what it really is must still be inside, and the file must not be a
      // symbolic link that a write would follow out.
      if (!isInside(root, realpathSync(dirname(target)))) {
        throw new Error(`refusing a path outside --to: ${link.path}`);
      }
      if (isSymbolicLink(target)) {
        throw new Error(`refusing to write through a symbolic link: ${link.path}`);
      }
      writeFileSync(target, bytes, { mode: 0o600 });
      out.push({ path: link.path, size: bytes.length });
    }
    after = page.next_after ?? null;
  } while (after !== null);
  return out;
}

/** Whether `path` is `root` or below it, by relative path: never throws, and `/` as the root is fine. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Whether `path` is itself a symbolic link, dangling or not (`existsSync` follows links, `lstat` does not). */
function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The real path of the deepest ancestor of `path` that exists (the path itself if it does). */
function deepestRealAncestor(path: string): string {
  let at = path;
  while (!existsSync(at)) {
    const up = dirname(at);
    if (up === at) break;
    at = up;
  }
  return realpathSync(at);
}

// --- Command line ------------------------------------------------------------------------------------

interface Parsed {
  command: string;
  flags: Map<string, string[]>;
  bare: Set<string>;
}

const VALUE_FLAGS = new Set([
  "--state",
  "--port",
  "--s3-port",
  "--host",
  "--image",
  "--seed-from-catalog",
  "--job",
  "--to",
]);
const BARE_FLAGS = new Set(["--seed-fixture"]);

export function parseArgs(argv: string[]): Parsed {
  const [command = "", ...rest] = argv;
  const flags = new Map<string, string[]>();
  const bare = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (BARE_FLAGS.has(arg)) {
      bare.add(arg);
    } else if (VALUE_FLAGS.has(arg)) {
      const value = rest[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      flags.set(arg, [...(flags.get(arg) ?? []), value]);
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return { command, flags, bare };
}

function one(p: Parsed, flag: string, required = true): string | undefined {
  const values = p.flags.get(flag);
  if (values === undefined) {
    if (required) throw new Error(`${flag} is required`);
    return undefined;
  }
  if (values.length > 1) throw new Error(`${flag} is given once`);
  return values[0];
}

function portOf(p: Parsed, flag: string, fallback: number): number {
  const raw = one(p, flag, false);
  if (raw === undefined) return fallback;
  if (!/^\d{1,5}$/.test(raw) || Number(raw) > 65535) throw new Error(`${flag} is a port number`);
  return Number(raw);
}

function gitFacts(): string {
  const run = (args: string[]) =>
    execFileSync("git", args, {
      cwd: import.meta.dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    return `${run(["rev-parse", "--abbrev-ref", "HEAD"])}@${run(["rev-parse", "--short", "HEAD"])}`;
  } catch {
    return "unknown@unknown";
  }
}

const USAGE = `usage:
  compute-local-stack.ts serve --state <dir> --image <ref@sha256:hex> [--port 8787] [--s3-port 8788]
                               [--seed-fixture] [--seed-from-catalog <id>]...
  compute-local-stack.ts outputs --state <dir> --job <id> --to <dir> [--port 8787] [--s3-port 8788]
exit codes: 0 done, 1 refused or failed, 2 usage`;

export async function main(argv: string[]): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
    if (parsed.command !== "serve" && parsed.command !== "outputs") throw new Error("a command");
  } catch (err) {
    console.error(
      err instanceof Error && err.message !== "a command" ? `${err.message}\n${USAGE}` : USAGE,
    );
    return 2;
  }
  try {
    if (parsed.command === "outputs") {
      const files = await downloadOutputs({
        state: one(parsed, "--state") as string,
        job: one(parsed, "--job") as string,
        to: one(parsed, "--to") as string,
        port: portOf(parsed, "--port", DEFAULT_PORT),
        s3Port: portOf(parsed, "--s3-port", DEFAULT_S3_PORT),
      });
      for (const f of files) console.log(`${f.path}\t${f.size}`);
      return 0;
    }
    // Registered BEFORE Miniflare starts: Miniflare's own signal handler calls `process.exit(128 + n)`
    // synchronously, so a handler added after it never runs and a stop by signal would report 143 (and a
    // dropped ssh session, SIGHUP, 129). Ours closes both servers and the database in the same tick, then
    // exits 0; the state is durable at every request (SQLite commits, R2 writes finish before they
    // answer), and the `exit` event disposes the Miniflare process.
    const running: { stack?: LocalStack } = {};
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(signal, () => {
        running.stack?.stopNow();
        process.exit(0);
      });
    }
    const stack = await startLocalStack({
      state: one(parsed, "--state") as string,
      image: one(parsed, "--image") as string,
      port: portOf(parsed, "--port", DEFAULT_PORT),
      s3Port: portOf(parsed, "--s3-port", DEFAULT_S3_PORT),
      host: one(parsed, "--host", false),
      seedFixture: parsed.bare.has("--seed-fixture"),
      seedFromCatalog: parsed.flags.get("--seed-from-catalog") ?? [],
    });
    running.stack = stack;
    console.log(`NEMAR local compute stack (not a deployment) at ${stack.url}, ${gitFacts()}`);
    console.log(
      `S3 stand-in on ${stack.s3Url}; state in ${stack.state}; keys are in keys.json and never printed`,
    );
    // Serve until a signal ends the process.
    await new Promise<never>(() => {});
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
