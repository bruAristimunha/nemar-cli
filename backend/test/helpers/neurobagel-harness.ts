/**
 * A real environment for the Neurobagel writer's tests (epic #1586, phase 4).
 *
 * Nothing here replaces business logic:
 *  - the database is bun:sqlite carrying EVERY production migration (`freshDb`);
 *  - the bucket is Miniflare's R2, the implementation `wrangler dev` runs;
 *  - the S3 manifest objects and the GitHub raw host are one real local HTTP server
 *    (`startS3ManifestStandin`), reached through `S3_ENDPOINT_URL` and
 *    `GITHUB_RAW_BASE`, the origin overrides the data-plane suites already use;
 *  - the data plane is the real `dataRoutes` app, called by the code under test.
 *
 * Only the two network boundaries are substituted (S3 and GitHub), and the server
 * logs every request so a test asserts on what was actually sent.
 *
 * `seedFromFixture` builds a dataset out of REAL documents: nm000132's published
 * manifest and the participants files captured from data.nemar.org in phase 1,
 * whose git blob SHAs equal the manifest's, so the data plane's broker accepts them.
 * The D1 row is seeded so that the route's `metadata.json` carries what the
 * fixture's did, and the writer's output must then equal the phase 1 golden BYTES.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { resetManifestAnswerMemo } from "../../src/services/manifest-source";
import type { Bindings } from "../../src/types/bindings";
import { DrainingCache, keyFor } from "./cache";
import { freshDb, realD1 } from "./d1";
import { applyMigrations, migrationFiles } from "./miniflare-d1";
import { type S3ManifestStandin, startS3ManifestStandin } from "./s3-manifest-standin";

const REPO_ROOT = join(import.meta.dir, "../../..");
export const FIXTURE_DIR = join(REPO_ROOT, "test/neurobagel/fixtures");
export const GOLDEN_DIR = join(REPO_ROOT, "test/neurobagel/golden");
const MANIFEST_FIXTURE = join(import.meta.dir, "../fixtures/manifest-nm000132-v1.1.1.json");

export function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export interface DatasetSeed {
  name?: string;
  license?: string | null;
  subjectCount?: number | null;
  conceptDoi?: string | null;
  enrichmentJson?: string | null;
  versions?: [version: string, createdAt: string][];
  status?: string;
  visibility?: string;
  anonymous?: number;
  firstPublishedAt?: string | null;
  withdrawnAt?: string | null;
  /** `datasets.ezid_status`: the concept DOI's EZID status (`unavailable` is a tombstone). */
  ezidStatus?: string | null;
  isSandbox?: number;
  isExemplar?: number;
}

export function seedDatasetRow(db: Database, id: string, seed: DatasetSeed = {}): void {
  db.query(
    `INSERT INTO datasets
       (dataset_id, name, owner_user_id, status, visibility, is_sandbox, is_exemplar, anonymous,
        first_published_at, withdrawn_at, license, subject_count, concept_doi, enrichment_json,
        ezid_status)
     VALUES (?, ?, -1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    seed.name ?? `Dataset ${id}`,
    seed.status ?? "active",
    seed.visibility ?? "public",
    seed.isSandbox ?? 0,
    seed.isExemplar ?? 0,
    seed.anonymous ?? 0,
    seed.firstPublishedAt === undefined ? "2026-01-02 03:04:05" : seed.firstPublishedAt,
    seed.withdrawnAt ?? null,
    seed.license === undefined ? "CC0-1.0" : seed.license,
    seed.subjectCount === undefined ? 3 : seed.subjectCount,
    seed.conceptDoi === undefined ? `10.82901/nemar.${id}` : seed.conceptDoi,
    seed.enrichmentJson === undefined ? null : seed.enrichmentJson,
    seed.ezidStatus ?? null,
  );
  for (const [version, createdAt] of seed.versions ?? [["1.0.0", "2026-01-02 03:04:05"]]) {
    db.query(
      `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at)
       VALUES (?, ?, ?, 'ezid', ?)`,
    ).run(id, version, `10.82901/nemar.${id}.v${version}`, createdAt);
  }
}

export interface RouteWorkerOptions {
  /** The bundled worker module the Miniflare instance runs (see `bundleRouteWorker`). */
  script: string;
  /** The Worker secret the read route compares the bearer against. */
  token: string;
  /** Extra bindings, such as `ENVIRONMENT`. */
  bindings?: Record<string, string>;
}

export interface Harness {
  db: Database;
  standin: S3ManifestStandin;
  mf: Miniflare;
  bucket: R2Bucket;
  /** Bindings for the writer: production-shaped unless overridden. */
  env(over?: Partial<Bindings>): Bindings;
  /**
   * Only with `routeWorker`: the Miniflare D1 the worker reads, migrated like production's,
   * and a function that copies the bun:sqlite catalog into it (the writer runs against
   * `db`, the route runs in workerd against this one, and both must hold the same rows).
   */
  workerD1?: D1Database;
  mirrorCatalog?(): Promise<void>;
  /** Only with `routeWorker`: a request to the route worker, inside workerd. */
  dispatch?(path: string, init?: RequestInit): Promise<Response>;
  /** Reset D1, the bucket and the stand-in between tests. */
  reset(): Promise<void>;
  dispose(): Promise<void>;
}

/** `DrainingCache` plus the one Workers Cache API method the writer needs, `delete`. */
class HarnessCache extends DrainingCache {
  async delete(request: RequestInfo | URL): Promise<boolean> {
    return this.store.delete(keyFor(request));
  }
}

/**
 * A stand-in server that ANSWERS. Under bun, a Miniflare instance disposed just before this
 * one can still be closing its own HTTP servers (bun implements node:http over its own
 * server), and in one process, after several instances, a stand-in created at that moment
 * has been found not listening a few milliseconds later. The cause is outside this code, so
 * the harness checks that the server answers and starts another if it does not.
 */
async function startReachableStandin(): Promise<S3ManifestStandin> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = startS3ManifestStandin();
    try {
      await fetch(`${candidate.url}/__alive`, { method: "HEAD" });
      return candidate;
    } catch {
      candidate.stop();
      await Bun.sleep(25);
    }
  }
  throw new Error("could not start a stand-in server that answers");
}

/**
 * Is this the TEST INFRASTRUCTURE failing to answer (a stand-in server, Miniflare's platform
 * proxy that bun talks to its workerd through), and not an assertion or a bug in the code
 * under test? Under bun, in one process after several Miniflare instances, a server created
 * a moment ago has been found not listening. Those are the errors worth starting over for.
 */
export function isInfrastructureError(err: unknown): boolean {
  const text =
    err instanceof Error
      ? `${err.name} ${err.message} ${String((err as { code?: unknown }).code ?? "")}`
      : String(err);
  return /ConnectionRefused|ECONNREFUSED|ECONNRESET|Unable to connect|platform[- ]proxy|socket hang up|fetch failed/i.test(
    text,
  );
}

/**
 * Start something again when the infrastructure did not come up, and only then: an
 * assertion failure or a bug in the code under test is thrown at once, never retried.
 */
export async function retryInfrastructure<T>(
  what: string,
  start: () => Promise<T>,
  attempts = 6,
): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await start();
    } catch (err) {
      if (!isInfrastructureError(err)) throw err;
      last = err;
      await Bun.sleep(40 * attempt);
    }
  }
  throw new Error(
    `${what}: the test infrastructure did not come up after ${attempts} attempts: ${
      last instanceof Error ? last.message : String(last)
    }`,
  );
}

/**
 * Miniflare, started and PROVEN reachable: a bucket call goes through its platform proxy
 * before anything else relies on it, and an instance whose proxy refuses is disposed and
 * started again.
 */
async function startMiniflare(
  rw?: RouteWorkerOptions,
): Promise<{ mf: Miniflare; bucket: R2Bucket; workerD1?: D1Database }> {
  return retryInfrastructure("miniflare", async () => {
    const mf = new Miniflare({
      modules: true,
      script: rw?.script ?? "export default { fetch() { return new Response('ok') } }",
      compatibilityDate: "2024-12-01",
      r2Buckets: ["NEUROBAGEL"],
      ...(rw
        ? {
            d1Databases: ["DB"],
            bindings: { NEUROBAGEL_READ_TOKEN: rw.token, ENVIRONMENT: "test", ...rw.bindings },
          }
        : {}),
    });
    try {
      const bucket = (await mf.getR2Bucket("NEUROBAGEL")) as unknown as R2Bucket;
      await bucket.list({ limit: 1 });
      let workerD1: D1Database | undefined;
      if (rw) {
        workerD1 = (await mf.getD1Database("DB")) as unknown as D1Database;
        await applyMigrations(workerD1, migrationFiles());
      }
      return { mf, bucket, workerD1 };
    } catch (err) {
      await mf.dispose().catch(() => {});
      throw err;
    }
  });
}

function installEdgeCache(): void {
  // The Workers Cache API the data plane's manifest and git-file caches and the rate
  // limiter use. A `DrainingCache`, which READS the body it is handed as the real API
  // does (the manifest edge copy is written into it as the scan reads); an in-memory
  // double that only clones would never pull it. A fresh one per test: a manifest copy trusted for 60 seconds must not
  // outlive the test that stored it.
  (globalThis as { caches?: unknown }).caches = { default: new HarnessCache() };
  resetManifestAnswerMemo();
}

/**
 * The read route as one ES module workerd can run, mounted where the api app mounts it.
 * Under bun, reading `.body` of an object Miniflare's Node-side proxy returns throws
 * `DataCloneError`, so the route's 200 branch can only run inside workerd (the same
 * reason the news media suite does this).
 */
export async function bundleRouteWorker(): Promise<string> {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "neurobagel-routes-worker.ts")],
    target: "browser",
    format: "esm",
  });
  const [output] = build.outputs;
  if (!build.success || !output) {
    throw new Error(`bundling the neurobagel routes failed: ${build.logs.join("\n")}`);
  }
  return output.text();
}

export async function startHarness(
  opts: { routeWorker?: RouteWorkerOptions } = {},
): Promise<Harness> {
  installEdgeCache();
  const standin = await startReachableStandin();
  const rw = opts.routeWorker;
  const infra = await startMiniflare(rw);
  const harness: Harness = {
    db: freshDb(),
    standin,
    mf: infra.mf,
    bucket: infra.bucket,
    env(over = {}) {
      return {
        DB: realD1(harness.db),
        ENVIRONMENT: "test",
        DATA_BASE_URL: "https://data.nemar.org",
        GITHUB_RAW_BASE: harness.standin.url,
        S3_ENDPOINT_URL: harness.standin.url,
        S3_BUCKET: "nemar",
        AWS_REGION: "us-east-2",
        AWS_ACCESS_KEY_ID: "AKIATEST",
        AWS_SECRET_ACCESS_KEY: "secret",
        GITHUB_ADMIN_PAT: "test-pat",
        NEUROBAGEL: harness.bucket,
        NEUROBAGEL_WRITER_ENABLED: "1",
        ...over,
      } as Bindings;
    },
    workerD1: infra.workerD1,
    async mirrorCatalog() {
      const workerD1 = harness.workerD1;
      if (!workerD1) throw new Error("no route worker");
      // Whole-table copy of the two tables eligibility reads. The anonymity triggers see
      // each row as it was in the source, which already satisfied them.
      await workerD1.prepare("DELETE FROM dataset_versions").run();
      await workerD1.prepare("DELETE FROM datasets").run();
      const copy = async (table: string) => {
        for (const row of harness.db.query(`SELECT * FROM ${table}`).all() as Record<
          string,
          unknown
        >[]) {
          const cols = Object.keys(row);
          await workerD1
            .prepare(
              `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
            )
            .bind(...cols.map((c) => row[c]))
            .run();
        }
      };
      await copy("datasets");
      await copy("dataset_versions");
    },
    dispatch: rw
      ? async (path, init) =>
          (await harness.mf.dispatchFetch(
            `https://api.nemar.org${path}`,
            init as never,
          )) as unknown as Response
      : undefined,
    async reset() {
      // The platform proxy answers, or Miniflare is started again (see startMiniflare).
      try {
        await harness.bucket.list({ limit: 1 });
      } catch (err) {
        if (!isInfrastructureError(err)) throw err;
        await harness.mf.dispose().catch(() => {});
        Object.assign(harness, await startMiniflare(rw));
      }
      installEdgeCache();
      harness.db.close();
      harness.db = freshDb();
      // A stand-in that stopped answering is replaced (see startReachableStandin); one
      // that answers is emptied. Its objects are the test's own, so nothing is lost.
      try {
        await fetch(`${harness.standin.url}/__alive`, { method: "HEAD" });
      } catch {
        harness.standin = await startReachableStandin();
      }
      harness.standin.objects.clear();
      harness.standin.log.length = 0;
      let cursor: string | undefined;
      do {
        const listed = await harness.bucket.list({ cursor });
        for (const o of listed.objects) await harness.bucket.delete(o.key);
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    },
    async dispose() {
      (globalThis as { caches?: unknown }).caches = undefined;
      await harness.mf.dispose();
      harness.standin.stop();
    },
  };
  return harness;
}

// ----------------------------------------------------------------------------
// Datasets
// ----------------------------------------------------------------------------

function manifestEntry(bytes: Uint8Array, git: boolean): Record<string, unknown> {
  if (git) {
    const sha = gitBlobSha(bytes);
    return { key: `git:${sha}`, size: bytes.length, checksum: `git:${sha}` };
  }
  const md5 = createHash("md5").update(bytes).digest("hex");
  return {
    key: `MD5E-s${bytes.length}--${md5}.edf`,
    size: bytes.length,
    checksum: `md5:${md5}`,
  };
}

export interface SyntheticOptions extends DatasetSeed {
  /** `participants.tsv` text, or null for a dataset with no table. */
  tsv?: string | null;
  participantsJson?: string | null;
  subjects?: string[];
  /** Serve participants.tsv as an ANNEXED file (the data plane answers 302). */
  annexTsv?: boolean;
  version?: string;
}

/** A small BIDS dataset: an EEG recording per subject and a participants table. */
export function seedSynthetic(h: Harness, id: string, o: SyntheticOptions = {}): void {
  const version = o.version ?? "1.0.0";
  const subjects = o.subjects ?? ["sub-01", "sub-02", "sub-03"];
  const tsv =
    o.tsv === undefined
      ? `participant_id\tage\tsex\n${subjects.map((s, i) => `${s}\t${20 + i}\t${i % 2 ? "F" : "M"}`).join("\n")}\n`
      : o.tsv;
  const pjson =
    o.participantsJson === undefined
      ? JSON.stringify({ age: { Units: "years" }, sex: { Levels: { M: "male", F: "female" } } })
      : o.participantsJson;
  const files: Record<string, unknown> = {};
  const raw = (path: string, text: string): void => {
    const bytes = new TextEncoder().encode(text);
    files[path] = manifestEntry(bytes, true);
    h.standin.put(`/nemarDatasets/${id}/v${version}/${path}`, bytes);
  };
  raw("dataset_description.json", JSON.stringify({ Name: `Dataset ${id}`, BIDSVersion: "1.9.0" }));
  if (tsv !== null) {
    if (o.annexTsv) {
      const bytes = new TextEncoder().encode(tsv);
      const entry = manifestEntry(bytes, false);
      files["participants.tsv"] = entry;
      // Annex files are reached through the data plane's object URL. Seed the
      // plain representation so its HEAD can prove the manifest size before
      // the test follows the redirect.
      h.standin.put(`/${id}/objects/${String(entry.key)}`, bytes);
    } else raw("participants.tsv", tsv);
  }
  if (pjson !== null) raw("participants.json", pjson);
  for (const s of subjects) {
    files[`${s}/eeg/${s}_task-rest_eeg.edf`] = manifestEntry(new TextEncoder().encode(s), false);
  }
  h.standin.put(
    `/${id}/version/v${version}.json`,
    JSON.stringify({
      dataset_id: id,
      version,
      doi: `10.82901/nemar.${id}.v${version}`,
      concept_doi: `10.82901/nemar.${id}`,
      created: "2026-01-02T03:04:05.000Z",
      // Keys in strictly ascending order, as the pipeline writes them: the data plane's
      // totals are only proven for such a manifest (ADR 0072).
      files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))),
    }),
  );
  seedDatasetRow(h.db, id, {
    subjectCount: subjects.length,
    versions: [[version, "2026-01-02 03:04:05"]],
    enrichmentJson: JSON.stringify({
      version: "1.0",
      authors: { "Ada Lovelace": { affiliation: "Analytical Engines" } },
    }),
    ...o,
  });
}

/** nm000132 from its real manifest and the participants files captured in phase 1. */
export function seedFromFixture(h: Harness, id = "nm000132"): { annexKey?: string } {
  const manifestText = readFileSync(MANIFEST_FIXTURE, "utf8");
  h.standin.put(`/${id}/version/v1.1.1.json`, manifestText);
  for (const name of ["participants.tsv", "participants.json"]) {
    h.standin.put(`/nemarDatasets/${id}/v1.1.1/${name}`, readFileSync(join(FIXTURE_DIR, id, name)));
  }
  const metadata = JSON.parse(readFileSync(join(FIXTURE_DIR, id, "metadata.json"), "utf8")) as {
    name: string;
    license: string;
    authors: { name: string; orcid?: string }[];
    keywords: { term: string }[];
    demographics: { subjects_count: number };
    external_links: { dataset_doi: string };
  };
  // v2.0 enrichment, the shape that carries structured keywords: the same authors in
  // the same order, and the same keyword terms.
  const enrichment = {
    version: "2.0",
    license: metadata.license,
    authors: Object.fromEntries(
      metadata.authors.map((a) => [a.name, a.orcid ? { orcid: a.orcid } : {}]),
    ),
    keywords: metadata.keywords,
  };
  seedDatasetRow(h.db, id, {
    name: metadata.name,
    license: metadata.license,
    subjectCount: metadata.demographics.subjects_count,
    conceptDoi: metadata.external_links.dataset_doi,
    enrichmentJson: JSON.stringify(enrichment),
    versions: [
      ["1.0.0", "2026-03-14 12:20:43"],
      ["1.1.0", "2026-04-02 20:15:30"],
      ["1.1.1", "2026-04-04 06:05:15"],
    ],
  });
  return {};
}

export function golden(id: string, name: string): string {
  return readFileSync(join(GOLDEN_DIR, id, name), "utf8");
}

/** Every object key in the bucket, sorted. */
export async function storeKeys(bucket: R2Bucket): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ cursor });
    keys.push(...listed.objects.map((o) => o.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return keys.sort();
}

/**
 * Counts the writes a run makes to the bucket, by wrapping the REAL binding: every call
 * still reaches Miniflare's R2, and the wrapper only records it. Used to prove "a
 * second run writes nothing" and the ordering of writes against deletes.
 */
export function recordWrites(bucket: R2Bucket): {
  bucket: R2Bucket;
  log: { op: "put" | "delete"; key: string }[];
} {
  const log: { op: "put" | "delete"; key: string }[] = [];
  const wrapped = new Proxy(bucket, {
    get(target, prop, receiver) {
      if (prop === "put") {
        return (key: string, ...rest: unknown[]) => {
          log.push({ op: "put", key });
          return (target.put as (...a: unknown[]) => unknown)(key, ...rest);
        };
      }
      if (prop === "delete") {
        return (keys: string | string[]) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) log.push({ op: "delete", key: k });
          return target.delete(keys);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { bucket: wrapped as R2Bucket, log };
}

/**
 * A transparent wrapper around the real bucket that records EVERY call in order
 * (`get:<key>`, `head:<key>`, `list`, `put:<key>`, `delete:<key>`) and runs an optional
 * async `after` hook once the call has returned, so a test can land another writer at an
 * exact point in a run. Every call still reaches Miniflare's R2.
 */
export function recordOps(
  bucket: R2Bucket,
  after?: (op: string, count: number) => void | Promise<void>,
): { bucket: R2Bucket; log: string[] } {
  const log: string[] = [];
  const counts = new Map<string, number>();
  const wrapped = new Proxy(bucket, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (
        typeof value === "function" &&
        (prop === "get" ||
          prop === "head" ||
          prop === "list" ||
          prop === "put" ||
          prop === "delete")
      ) {
        return async (...args: unknown[]) => {
          const first = args[0];
          const keys =
            prop === "list" ? [""] : Array.isArray(first) ? (first as string[]) : [first as string];
          const names = keys.map((k) => (prop === "list" ? "list" : `${String(prop)}:${k}`));
          log.push(...names);
          const result = await (value as (...a: unknown[]) => unknown).apply(target, args);
          for (const name of names) {
            counts.set(name, (counts.get(name) ?? 0) + 1);
            await after?.(name, counts.get(name) as number);
          }
          return result;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { bucket: wrapped as R2Bucket, log };
}
