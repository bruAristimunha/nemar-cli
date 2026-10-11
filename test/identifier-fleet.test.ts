/**
 * Fleet identifier screening (`scripts/identifier-fleet-lib.ts` and its CLI).
 *
 * Every test drives the library or the CLI against a real `Bun.serve` stand-in that speaks
 * the three surfaces the scanner reads: the catalog, the data plane (`manifest.json` and
 * git-tracked files) and public S3 (annexed files), with real `Range` semantics (206, and
 * 416 for an empty object). EDF headers are built to the EDF layout byte for byte from
 * INVENTED values.
 *
 * Each flagged case has a clean twin differing in one thing, because a scanner that
 * flags (or passes) everything also passes a one-sided test. The privacy tests read the
 * written files back and grep them for the injected strings, so "never writes a value" is
 * checked on what hit the disk, not on what a function returned.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ContextOptions,
  type DatasetRecord,
  type FleetContext,
  ReadFailure,
  RunAborted,
  UsageError,
  buildSummary,
  classifyDataset,
  createContext,
  createLimiter,
  isFinalRecord,
  parseCliArgs,
  parseRetryAfter,
  pool,
  readHead,
  readVersionManifestViaAws,
  runFleet,
  sampleEvenly,
  scanDataset,
  scanDatasetFromManifest,
  withRetry,
} from "../scripts/identifier-fleet-lib";
import { shapeOf } from "../shared/identifier-scan";
import { toolOrFail } from "./scrub/helpers/require-tools";

// ---------------------------------------------------------------------------------------
// EDF headers
// ---------------------------------------------------------------------------------------

function put(out: Uint8Array, text: string | Uint8Array, start: number, width: number): void {
  out.fill(0x20, start, start + width);
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  out.set(bytes.subarray(0, width), start);
}

interface HeaderFields {
  patient?: string | Uint8Array;
  recording?: string;
  startdate?: string;
}

/** A 256-byte EDF header: version, patient, recording, start date and time, counts. */
function edfHeader(f: HeaderFields = {}): Uint8Array {
  const out = new Uint8Array(256).fill(0x20);
  put(out, "0", 0, 8);
  put(out, f.patient ?? "P01 F X X", 8, 80);
  put(out, f.recording ?? "Startdate X X X X", 88, 80);
  put(out, f.startdate ?? "01.01.85", 168, 8);
  put(out, "00.00.00", 176, 8);
  put(out, "256", 184, 8);
  put(out, "-1", 236, 8);
  put(out, "1", 244, 8);
  put(out, "0", 252, 4);
  return out;
}

const CLEAN = edfHeader();
const NAMED = edfHeader({ patient: "P01 F X Quillfeather" });
const enc = (text: string) => new TextEncoder().encode(text);
const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
const edfPath = (n: number, prefix = "") =>
  `${prefix}sub-${String(n).padStart(2, "0")}/eeg/sub-${String(n).padStart(2, "0")}_task-rest_eeg.edf`;

// ---------------------------------------------------------------------------------------
// The stand-in
// ---------------------------------------------------------------------------------------

interface FileSpec {
  bytes?: Uint8Array;
  /** Answer with this status and no body. */
  status?: number;
  /** Ignore `Range` and send the whole file with 200. */
  ignoreRange?: boolean;
  /** Answer the first `n` requests with `status`, then serve normally. */
  failFirst?: { n: number; status: number };
  /** Headers on the `status` and `failFirst` answers (for example Retry-After). */
  headers?: Record<string, string>;
  delayMs?: number;
  /** A 200 body of `chunks` 64 KB chunks that starts with `head`; records whether it was cut off. */
  stream?: { head: Uint8Array; chunks: number; state: { sent: number; cancelled: boolean } };
}

type FileDef = Uint8Array | string | (FileSpec & { via?: "s3" | "worker"; size?: number | null });

interface DatasetOptions {
  version?: string;
  visibility?: string;
  manifestStatus?: number;
  manifestHeaders?: Record<string, string>;
  /** How the S3 stand-in answers the raw version manifest: a status, or `hang`. */
  awsStatus?: number | "hang";
  /** Replaces the generated manifest.json body. */
  manifestBody?: unknown;
  manifestRaw?: string;
  versionManifest?: unknown;
  tree?: unknown;
  treeStatus?: number;
}

interface Dataset extends DatasetOptions {
  version: string;
  visibility: string;
  files: Map<string, { spec: FileSpec; via: "s3" | "worker"; size: number | null }>;
}

class StandIn {
  readonly base: string;
  readonly maxInflight = { data: 0, s3: 0 };
  /** Hung `aws` requests whose connection the client closed. */
  hungClosed = 0;
  /** When set, the catalog answers this status instead of the list. */
  catalogStatus: number | null = null;
  readonly requests: { path: string; authorization: string | null }[] = [];
  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly routes = new Map<string, FileSpec>();
  private readonly datasets = new Map<string, Dataset>();
  private readonly counts = new Map<string, number>();
  private readonly inflight = { data: 0, s3: 0 };

  constructor() {
    this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => this.handle(req) });
    this.base = `http://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    this.server.stop(true);
  }

  ctx(options: ContextOptions = {}): FleetContext {
    return createContext({
      api: `${this.base}/api`,
      data: `${this.base}/data`,
      s3Base: `${this.base}/s3`,
      githubApi: `${this.base}/gh`,
      retryBaseMs: 0,
      timeoutMs: 5000,
      manifestTimeoutMs: 5000,
      githubToken: async () => null,
      // Stands in for `aws s3 cp`: the same object, read over HTTP.
      readVersionManifest: async (id, version) => {
        const res = await fetch(`${this.base}/s3/${id}/version/${version}.json`);
        if (!res.ok) throw new Error("version manifest unavailable");
        return res.text();
      },
      ...options,
    });
  }

  versionOf(id: string): string {
    return (this.datasets.get(id) as Dataset).version;
  }

  /** Where a dataset file is served: the data plane for `worker`, public S3 for `s3`. */
  pathOf(id: string, path: string, via: "s3" | "worker" = "s3"): string {
    return via === "worker"
      ? `/data/${id}/${this.versionOf(id)}/${encodePath(path)}`
      : `/s3/${id}/${encodePath(path)}`;
  }

  manifestPath(id: string): string {
    return `/data/${id}/${this.versionOf(id)}/manifest.json`;
  }

  hits(pathname: string): number {
    return this.counts.get(pathname) ?? 0;
  }

  add(id: string, files: Record<string, FileDef>, options: DatasetOptions = {}): void {
    this.datasets.set(id, {
      version: "v1.0.0",
      visibility: "public",
      ...options,
      files: new Map(),
    });
    for (const [path, def] of Object.entries(files)) this.set(id, path, def);
  }

  patch(id: string, options: Partial<DatasetOptions>): void {
    Object.assign(this.datasets.get(id) as Dataset, options);
  }

  set(id: string, path: string, def: FileDef): void {
    const ds = this.datasets.get(id) as Dataset;
    const given =
      def instanceof Uint8Array || typeof def === "string"
        ? { bytes: typeof def === "string" ? enc(def) : def }
        : def;
    const { via, size, ...spec } = given as FileSpec & {
      via?: "s3" | "worker";
      size?: number | null;
    };
    const where = via ?? "s3";
    ds.files.set(path, {
      spec,
      via: where,
      size: size === undefined ? (spec.bytes?.length ?? 0) : size,
    });
    this.routes.set(this.pathOf(id, path, where), spec);
  }

  /** Serve `spec` at an arbitrary pathname. */
  raw(pathname: string, spec: FileSpec): void {
    this.routes.set(pathname, spec);
  }

  private manifestFor(id: string, ds: Dataset): unknown {
    return [...ds.files].map(([path, f]) => ({
      path,
      ...(f.size === null ? {} : { size: f.size }),
      url: `${this.base}${this.pathOf(id, path, f.via)}`,
    }));
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const n = (this.counts.get(path) ?? 0) + 1;
    this.counts.set(path, n);
    this.requests.push({ path, authorization: req.headers.get("authorization") });
    const bucket = path.startsWith("/data/") ? "data" : path.startsWith("/s3/") ? "s3" : null;
    if (bucket) {
      this.inflight[bucket]++;
      this.maxInflight[bucket] = Math.max(this.maxInflight[bucket], this.inflight[bucket]);
    }
    try {
      return await this.route(req, path, url, n);
    } finally {
      if (bucket) this.inflight[bucket]--;
    }
  }

  private async route(req: Request, path: string, url: URL, n: number): Promise<Response> {
    if (path === "/api/datasets") {
      if (this.catalogStatus !== null) return new Response("", { status: this.catalogStatus });
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const all = [...this.datasets].sort(([a], [b]) => (a < b ? -1 : 1));
      return Response.json({
        datasets: all.slice(offset, offset + limit).map(([id, ds]) => ({
          dataset_id: id,
          latest_version: ds.version === "none" ? null : ds.version,
          visibility: ds.visibility,
        })),
        total_count: all.length,
      });
    }
    const manifest = /^\/data\/([^/]+)\/[^/]+\/manifest\.json$/.exec(path);
    if (manifest) {
      const ds = this.datasets.get(manifest[1] as string);
      if (!ds) return new Response("", { status: 404 });
      if (ds.manifestStatus) {
        return new Response("", { status: ds.manifestStatus, headers: ds.manifestHeaders });
      }
      if (ds.manifestRaw !== undefined) return new Response(ds.manifestRaw);
      return Response.json(
        ds.manifestBody !== undefined
          ? ds.manifestBody
          : this.manifestFor(manifest[1] as string, ds),
      );
    }
    const awsObject = /^\/nemar\/([^/]+)\/version\/[^/]+\.json$/.exec(path);
    if (awsObject) return this.awsObject(req, this.datasets.get(awsObject[1] as string));
    const versionManifest = /^\/s3\/([^/]+)\/version\/[^/]+\.json$/.exec(path);
    if (versionManifest) {
      const ds = this.datasets.get(versionManifest[1] as string);
      if (!ds?.versionManifest) return new Response("", { status: 404 });
      return Response.json(ds.versionManifest);
    }
    const tree = /^\/gh\/repos\/nemarDatasets\/([^/]+)\/git\/trees\/[^/]+$/.exec(path);
    if (tree) {
      const ds = this.datasets.get(tree[1] as string);
      if (!ds?.tree || ds.treeStatus) return new Response("", { status: ds?.treeStatus ?? 404 });
      return Response.json(ds.tree);
    }
    const spec = this.routes.get(path);
    if (!spec) return new Response("", { status: 404 });
    return this.serve(req, spec, n);
  }

  /** Path-style S3 object GET and HEAD, as the real `aws s3 cp` makes them. */
  private async awsObject(req: Request, ds: Dataset | undefined): Promise<Response> {
    if (ds?.awsStatus === "hang") {
      await new Promise<void>((resolve) => {
        req.signal.addEventListener("abort", () => {
          this.hungClosed++;
          resolve();
        });
      });
      return new Response("", { status: 499 });
    }
    const status =
      typeof ds?.awsStatus === "number" ? ds.awsStatus : ds?.versionManifest ? 200 : 404;
    if (status !== 200) {
      if (req.method === "HEAD") return new Response(null, { status });
      const code = status === 404 ? "NoSuchKey" : "AccessDenied";
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>no</Message></Error>`,
        { status, headers: { "Content-Type": "application/xml" } },
      );
    }
    const body = JSON.stringify(ds?.versionManifest);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": String(body.length),
      ETag: '"abc"',
      "Last-Modified": "Wed, 21 Oct 2015 07:28:00 GMT",
    };
    return req.method === "HEAD"
      ? new Response(null, { headers })
      : new Response(body, { headers });
  }

  private async serve(req: Request, spec: FileSpec, n: number): Promise<Response> {
    if (spec.delayMs) await Bun.sleep(spec.delayMs);
    if (spec.failFirst && n <= spec.failFirst.n) {
      return new Response("", { status: spec.failFirst.status, headers: spec.headers });
    }
    if (spec.status) return new Response("", { status: spec.status, headers: spec.headers });
    if (spec.stream) {
      const { head, chunks, state } = spec.stream;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (state.sent >= chunks) return controller.close();
            await Bun.sleep(1);
            const chunk = new Uint8Array(65_536);
            if (state.sent === 0) chunk.set(head);
            state.sent++;
            controller.enqueue(chunk);
          },
          cancel() {
            state.cancelled = true;
          },
        }),
        { status: 200 },
      );
    }
    const bytes = spec.bytes ?? new Uint8Array(0);
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get("range") ?? "");
    if (!range || spec.ignoreRange) return new Response(bytes, { status: 200 });
    const start = Number(range[1]);
    if (bytes.length === 0 || start >= bytes.length) {
      return new Response("", {
        status: 416,
        headers: { "Content-Range": `bytes */${bytes.length}` },
      });
    }
    const end = Math.min(Number(range[2]), bytes.length - 1);
    return new Response(bytes.slice(start, end + 1), {
      status: 206,
      headers: { "Content-Range": `bytes ${start}-${end}/${bytes.length}` },
    });
  }
}

const worlds: StandIn[] = [];
const droppers: { stop: (force?: boolean) => void }[] = [];
const dirs: string[] = [];
afterAll(() => {
  for (const w of worlds) w.stop();
  for (const d of droppers) d.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function newWorld(): StandIn {
  const w = new StandIn();
  worlds.push(w);
  return w;
}
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "identifier-fleet-"));
  dirs.push(d);
  return d;
}

/**
 * A raw TCP server that answers every request with a 200 that promises 1000 bytes, sends
 * ten and closes the socket: a connection dropped mid-body, which `Bun.serve` cannot produce.
 */
function dropServer(): { url: string; requests: () => number } {
  let requests = 0;
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        requests++;
        socket.write(`HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n${"x".repeat(10)}`);
        socket.end();
      },
    },
  });
  droppers.push(server);
  return { url: `http://127.0.0.1:${server.port}/dropped.edf`, requests: () => requests };
}

const ID = "nm000001";

/** One dataset on a fresh stand-in, scanned through the real entry point. */
async function scanFiles(
  files: Record<string, FileDef>,
  ctxOptions: ContextOptions = {},
  dataset: DatasetOptions = {},
): Promise<{ w: StandIn; record: DatasetRecord }> {
  const w = newWorld();
  w.add(ID, files, dataset);
  const record = await scanDataset(w.ctx(ctxOptions), ID, w.versionOf(ID));
  return { w, record };
}

const EDF = edfPath(1);

// ---------------------------------------------------------------------------------------
// Arguments, pool, limiter, retry
// ---------------------------------------------------------------------------------------

describe("numeric arguments", () => {
  const bad = ["0", "-3", "abc", "1.5", "", "2x", "1e2", " 4"];
  for (const value of bad) {
    test(`--concurrency "${value}" is rejected`, () => {
      expect(() => parseCliArgs(["--out", "x", "--concurrency", value])).toThrow(UsageError);
    });
  }
  test("--datasets and --worker-concurrency are validated the same way", () => {
    expect(() => parseCliArgs(["--out", "x", "--datasets", "0"])).toThrow(UsageError);
    expect(() => parseCliArgs(["--out", "x", "--datasets", "abc"])).toThrow(UsageError);
    expect(() => parseCliArgs(["--out", "x", "--worker-concurrency", "0"])).toThrow(UsageError);
    expect(() => parseCliArgs(["--out", "x", "--abort-streak", "0"])).toThrow(UsageError);
    expect(() => parseCliArgs(["--out", "x", "--aws-timeout", "abc"])).toThrow(UsageError);
  });
  test("a flag with no value, an unknown flag and a missing --out are errors", () => {
    expect(() => parseCliArgs(["--out", "x", "--concurrency"])).toThrow(UsageError);
    expect(() => parseCliArgs(["--out", "x", "--concurrency", "--force"])).toThrow(UsageError);
    expect(() => parseCliArgs(["--out", "x", "--concurency", "4"])).toThrow(UsageError);
    expect(() => parseCliArgs([])).toThrow(UsageError);
    expect(() => parseCliArgs(["--out", "x", "--only", ",,"])).toThrow(UsageError);
  });
  test("valid values parse, with the defaults", () => {
    expect(parseCliArgs(["--out", "x"])).toEqual({
      out: "x",
      only: undefined,
      fileConcurrency: 24,
      workerConcurrency: 6,
      datasetConcurrency: 4,
      abortStreak: 25,
      awsTimeoutSeconds: 600,
      force: false,
    });
    expect(
      parseCliArgs([
        "--out",
        "x",
        "--only",
        "nm1,nm2,nm1",
        "--concurrency",
        "8",
        "--worker-concurrency",
        "2",
        "--datasets",
        "1",
        "--abort-streak",
        "7",
        "--aws-timeout",
        "30",
        "--force",
      ]),
    ).toEqual({
      out: "x",
      only: ["nm1", "nm2"],
      fileConcurrency: 8,
      workerConcurrency: 2,
      datasetConcurrency: 1,
      abortStreak: 7,
      awsTimeoutSeconds: 30,
      force: true,
    });
  });
});

describe("pool", () => {
  test("a size that would start no worker throws instead of doing nothing", async () => {
    for (const size of [0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      let ran = 0;
      await expect(
        pool([1, 2, 3], size, async () => {
          ran++;
        }),
      ).rejects.toThrow(RangeError);
      expect(ran).toBe(0);
    }
  });
  test("a valid size runs every item, never more than `size` at once", async () => {
    let active = 0;
    let max = 0;
    let ran = 0;
    await pool(
      Array.from({ length: 25 }, (_, i) => i),
      4,
      async () => {
        active++;
        max = Math.max(max, active);
        await Bun.sleep(3);
        active--;
        ran++;
      },
    );
    expect(ran).toBe(25);
    expect(max).toBe(4);
  });
  test("no items is fine, and a failing item is rethrown after the others finish", async () => {
    await pool([], 3, async () => {});
    let finished = 0;
    await expect(
      pool([1, 2, 3, 4, 5, 6], 2, async (n) => {
        if (n === 1) throw new Error("boom");
        await Bun.sleep(3);
        finished++;
      }),
    ).rejects.toThrow("boom");
    // Nothing is left running behind the rejection.
    const settled = finished;
    await Bun.sleep(30);
    expect(finished).toBe(settled);
  });
});

describe("createLimiter", () => {
  test("bounds in-flight calls across all callers", async () => {
    const limit = createLimiter(3);
    let active = 0;
    let max = 0;
    const task = async () => {
      active++;
      max = Math.max(max, active);
      await Bun.sleep(2);
      active--;
    };
    await Promise.all(Array.from({ length: 60 }, () => limit(task)));
    expect(max).toBe(3);
  });
  test("rejects a bound that admits nothing", () => {
    expect(() => createLimiter(0)).toThrow(RangeError);
  });
});

describe("withRetry", () => {
  const sleeps = () => {
    const calls: number[] = [];
    return { calls, sleep: async (ms: number) => void calls.push(ms) };
  };
  test("retries a network failure and sleeps between attempts only, never after the last", async () => {
    const { calls, sleep } = sleeps();
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new ReadFailure("network", { retryable: true });
        },
        { tries: 3, baseMs: 10, sleep },
      ),
    ).rejects.toThrow("network");
    expect(attempts).toBe(3);
    expect(calls).toEqual([10, 20]);
  });
  test("a non-retryable failure is thrown at once, with no sleep", async () => {
    const { calls, sleep } = sleeps();
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new ReadFailure("http-404", { status: 404 });
        },
        { tries: 3, sleep },
      ),
    ).rejects.toThrow("http-404");
    expect(attempts).toBe(1);
    expect(calls).toEqual([]);
  });
  test("an error that is not a classed read failure is never retried", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new TypeError("bug");
        },
        { tries: 3, sleep: async () => {} },
      ),
    ).rejects.toThrow("bug");
    expect(attempts).toBe(1);
  });
  test("one try never sleeps; a success returns its value", async () => {
    const { calls, sleep } = sleeps();
    await expect(
      withRetry(
        async () => {
          throw new ReadFailure("timeout", { retryable: true });
        },
        { tries: 1, sleep },
      ),
    ).rejects.toThrow("timeout");
    expect(calls).toEqual([]);
    expect(await withRetry(async () => 7, { sleep })).toBe(7);
  });
});

// ---------------------------------------------------------------------------------------
// readHead
// ---------------------------------------------------------------------------------------

describe("readHead", () => {
  test("a server that ignores Range and sends 200 is capped at 256 bytes and cancelled", async () => {
    const w = newWorld();
    const state = { sent: 0, cancelled: false };
    const chunks = 1024; // 64 MB, paced at 1 ms a chunk: reading it all takes over a second
    w.raw("/s3/big.edf", { stream: { head: CLEAN, chunks, state } });
    const head = await readHead(`${w.base}/s3/big.edf`, 256, { minBytes: 256 });
    expect(head.length).toBe(256);
    expect(Array.from(head)).toEqual(Array.from(CLEAN));
    // Cancelled promptly by readHead itself, not eventually by garbage collection.
    for (let i = 0; i < 15 && !state.cancelled; i++) await Bun.sleep(10);
    expect(state.cancelled).toBe(true);
    expect(state.sent).toBeLessThan(chunks / 2);
  });

  test("a 206 for exactly the range, and a file longer than 256 bytes, read the same 256", async () => {
    const w = newWorld();
    const longer = new Uint8Array(1000).fill(0x41);
    longer.set(CLEAN);
    w.raw("/s3/exact.edf", { bytes: CLEAN });
    w.raw("/s3/longer.edf", { bytes: longer });
    w.raw("/s3/ignored.edf", { bytes: longer, ignoreRange: true });
    for (const name of ["exact", "longer", "ignored"]) {
      const head = await readHead(`${w.base}/s3/${name}.edf`, 256, { minBytes: 256 });
      expect(head.length).toBe(256);
      expect(Array.from(head)).toEqual(Array.from(CLEAN));
    }
  });

  test("404, 416 on an empty file and a short body are failed reads, each classed", async () => {
    const w = newWorld();
    w.raw("/s3/empty.edf", { bytes: new Uint8Array(0) });
    w.raw("/s3/short.edf", { bytes: CLEAN.subarray(0, 100) });
    w.raw("/s3/exact.edf", { bytes: CLEAN });
    const cls = async (name: string) => {
      try {
        await readHead(`${w.base}/s3/${name}.edf`, 256, { minBytes: 256 });
        return "read";
      } catch (error) {
        expect(error).toBeInstanceOf(ReadFailure);
        return (error as ReadFailure).cls;
      }
    };
    expect(await cls("missing")).toBe("http-404");
    expect(await cls("empty")).toBe("http-416");
    expect(await cls("short")).toBe("short-body");
    expect(await cls("exact")).toBe("read");
  });

  test("a short body is fine for a text file that has no minimum", async () => {
    const w = newWorld();
    w.raw("/s3/small.txt", { bytes: enc("hello") });
    const head = await readHead(`${w.base}/s3/small.txt`, 65_536);
    expect(new TextDecoder().decode(head)).toBe("hello");
  });

  test("a connection that breaks mid-body is a network failure, not a short read", async () => {
    const dropped = dropServer();
    const error = await readHead(dropped.url, 256, { minBytes: 256 }).catch((e) => e);
    expect(error).toBeInstanceOf(ReadFailure);
    expect((error as ReadFailure).cls).toBe("network");
    expect((error as ReadFailure).retryable).toBe(true);
  });

  test("a closed port is a retryable network failure", async () => {
    const w = newWorld();
    const url = `${w.base}/s3/x.edf`;
    w.stop();
    const error = await readHead(url, 256).catch((e) => e);
    expect(error).toBeInstanceOf(ReadFailure);
    expect((error as ReadFailure).retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// Retry policy through the scan
// ---------------------------------------------------------------------------------------

describe("retry policy at the HTTP stand-in", () => {
  const cases: [number, number][] = [
    [403, 1],
    [404, 1],
    [413, 1],
    [416, 1],
    [500, 3],
    [503, 3],
    [429, 3],
  ];
  for (const [status, requests] of cases) {
    test(`an EDF answering ${status} is asked ${requests} time(s) and counted as a failed read`, async () => {
      const { w, record } = await scanFiles({ [EDF]: { bytes: CLEAN, status } });
      expect(w.hits(w.pathOf(ID, EDF))).toBe(requests);
      expect(record.read_failures).toEqual({ [`edf/http-${status}`]: 1 });
      expect(record.status).toBe("unchecked");
    });
  }

  test("a 503 that clears on the third try is read (twin of the always-503 case)", async () => {
    const { w, record } = await scanFiles({
      [EDF]: { bytes: CLEAN, failFirst: { n: 2, status: 503 } },
    });
    expect(w.hits(w.pathOf(ID, EDF))).toBe(3);
    expect(record.status).toBe("clean");
    expect(record.read_failures).toEqual({});
  });

  test("a dropped connection is retried like a 5xx", async () => {
    const dropped = dropServer();
    const w = newWorld();
    w.add(ID, {}, { manifestBody: [{ path: EDF, size: 256, url: dropped.url }] });
    const record = await scanDataset(w.ctx(), ID, w.versionOf(ID));
    expect(dropped.requests()).toBe(3);
    expect(record.read_failures).toEqual({ "edf/network": 1 });
    expect(record.status).toBe("unchecked");
  });

  test("the manifest is retried on 5xx (twice) but not on 404", async () => {
    const w = newWorld();
    w.add("nm000010", { [EDF]: CLEAN }, { manifestStatus: 500 });
    w.add("nm000011", { [EDF]: CLEAN }, { manifestStatus: 404 });
    const ctx = w.ctx();
    const five = await scanDataset(ctx, "nm000010", "v1.0.0");
    const four = await scanDataset(ctx, "nm000011", "v1.0.0");
    expect(w.hits(w.manifestPath("nm000010"))).toBe(2);
    expect(w.hits(w.manifestPath("nm000011"))).toBe(1);
    expect(five.incomplete_reasons).toEqual(["manifest:http-500"]);
    expect(four.incomplete_reasons).toEqual(["manifest:http-404"]);
  });
});

// ---------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------

describe("status from EDF/BDF headers", () => {
  test("clean headers, all read: clean and complete; a name in one header: direct-identifiers", async () => {
    const clean = await scanFiles({ [EDF]: CLEAN, [edfPath(2)]: CLEAN });
    expect(clean.record.status).toBe("clean");
    expect(clean.record.incomplete).toBe(false);
    expect(clean.record.incomplete_reasons).toEqual([]);

    const named = await scanFiles({ [EDF]: CLEAN, [edfPath(2)]: NAMED });
    expect(named.record.status).toBe("direct-identifiers");
    expect(named.record.edf_bdf_files_flagged).toBe(1);
    expect(named.record.findings_by_kind?.["edf-patient-name"]).toBe(1);
    // A finding does not make the scan incomplete: everything was read.
    expect(named.record.incomplete).toBe(false);
  });

  test("a finer-than-year start date alone is dates-only; 1 January is clean", async () => {
    const dated = await scanFiles({ [EDF]: edfHeader({ startdate: "14.03.93" }) });
    expect(dated.record.status).toBe("dates-only");
    const clipped = await scanFiles({ [EDF]: edfHeader({ startdate: "01.01.93" }) });
    expect(clipped.record.status).toBe("clean");
  });

  test("a date with an unparsed recording format beside it follows the unscreened rule, not dates-only", async () => {
    const mixed = await scanFiles({
      [EDF]: edfHeader({ startdate: "14.03.93" }),
      "sub-01/eeg/b.set": "x",
    });
    expect(mixed.record.status).toBe("clean-edf-only-others-unscreened");
  });

  test("a date never hides an incomplete scan: an unreadable header beside it is unchecked", async () => {
    const files = await scanFiles({
      [EDF]: edfHeader({ startdate: "14.03.93" }),
      "sub-02/eeg/c.edf": { status: 404 },
    });
    expect(files.record.status).toBe("unchecked");
    expect(files.record.incomplete).toBe(true);
  });

  test("a date beside a review finding is review: the other finding is not hidden", async () => {
    const files = await scanFiles({
      [EDF]: edfHeader({ startdate: "14.03.93" }),
      "sourcedata/note.png": "x",
    });
    expect(files.record.status).toBe("review");
  });

  test("a name beside a date is direct-identifiers: the name wins over dates-only", async () => {
    const both = await scanFiles({
      [EDF]: edfHeader({ patient: "P01 F X Quillfeather", startdate: "14.03.93" }),
    });
    expect(both.record.status).toBe("direct-identifiers");
  });

  test("non-ASCII bytes in the patient field are direct-identifiers", async () => {
    const utf8 = await scanFiles({ [EDF]: edfHeader({ patient: enc("P01 F X Br\u00e9montzy") }) });
    expect(utf8.record.status).toBe("direct-identifiers");
    const ascii = await scanFiles({ [EDF]: edfHeader({ patient: "P01 F X Bremontzy" }) });
    expect(ascii.record.status).toBe("direct-identifiers");
    const code = await scanFiles({ [EDF]: edfHeader({ patient: "P01 F X X" }) });
    expect(code.record.status).toBe("clean");
  });

  test("a header that is not an EDF is a review finding, read successfully (not a failed read)", async () => {
    const { record } = await scanFiles({ [EDF]: new Uint8Array(256) });
    expect(record.status).toBe("review");
    expect(record.findings_by_kind?.["edf-unreadable"]).toBe(1);
    expect(record.files?.header_read).toBe(1);
    expect(record.incomplete).toBe(false);
  });

  test("a start date that is not a date is review, not dates-only and not clean", async () => {
    const garbage = await scanFiles({ [EDF]: edfHeader({ startdate: "xx.xx.xx" }) });
    expect(garbage.record.status).toBe("review");
    expect(garbage.record.findings_by_kind?.["edf-startdate-unparsed"]).toBe(1);
    const parsed = await scanFiles({ [EDF]: edfHeader({ startdate: "14.03.93" }) });
    expect(parsed.record.status).toBe("dates-only");
    const clipped = await scanFiles({ [EDF]: edfHeader({ startdate: "01.01.85" }) });
    expect(clipped.record.status).toBe("clean");
  });

  test("a record number in the patient field is review; a study code is clean", async () => {
    const number = await scanFiles({ [EDF]: edfHeader({ patient: "12345678 F X X" }) });
    expect(number.record.status).toBe("review");
    expect(number.record.findings_by_kind?.["edf-patient-recordnumber"]).toBe(1);
    const code = await scanFiles({ [EDF]: edfHeader({ patient: "P01 F X X" }) });
    expect(code.record.status).toBe("clean");
  });

  test("free text in the recording id decides by severity: identifier is direct, review is review", async () => {
    const named = await scanFiles({ [EDF]: edfHeader({ recording: "Quillfeather Annabelle" }) });
    expect(named.record.findings_by_kind?.["edf-recording-freetext"]).toBe(1);
    expect(named.record.status).toBe("direct-identifiers");
    // The same kind at review severity (a name in the technician slot) stays review.
    const technician = await scanFiles({
      [EDF]: edfHeader({ recording: "Startdate X Quillfeather X" }),
    });
    expect(technician.record.findings_by_kind?.["edf-recording-freetext"]).toBe(1);
    expect(technician.record.status).toBe("review");
    const placeholder = await scanFiles({ [EDF]: edfHeader() });
    expect(placeholder.record.status).toBe("clean");
  });

  test("an image or document is review; the same dataset without it is clean", async () => {
    const withPdf = await scanFiles({ [EDF]: CLEAN, "sourcedata/consent.pdf": "x" });
    expect(withPdf.record.status).toBe("review");
    const without = await scanFiles({ [EDF]: CLEAN });
    expect(without.record.status).toBe("clean");
  });

  test("an unreadable header adds no value to the distinct counts", async () => {
    const { record } = await scanFiles({
      [edfPath(1)]: edfHeader({ patient: "P01 F X X" }),
      [edfPath(2)]: new Uint8Array(256),
    });
    expect(record.distinct_patient_field_values).toBe(1);
    expect(record.findings_by_kind?.["edf-unreadable"]).toBe(1);
  });

  test("distinct patient values and subjects are counted from the shared offsets", async () => {
    const { record } = await scanFiles({
      [edfPath(1)]: edfHeader({ patient: "P01 F X X" }),
      [edfPath(2)]: edfHeader({ patient: "P01 F X X" }),
      [edfPath(3)]: edfHeader({ patient: "P02 M X X" }),
    });
    expect(record.distinct_patient_field_values).toBe(2);
    expect(record.distinct_patient_code_subfield).toBe(2);
    expect(record.distinct_patient_name_subfield).toBe(1);
    expect(record.distinct_subjects_with_edf_bdf).toBe(3);
  });
});

describe("status from JSON keys: severity decides, not kind", () => {
  const json = (body: unknown) => ({
    [EDF]: CLEAN,
    "sourcedata/export.json": JSON.stringify(body),
  });
  test("a review-severity key (Contact) is review, not direct-identifiers", async () => {
    const { record } = await scanFiles(json({ Contact: "someone@example.invalid" }));
    expect(record.status).toBe("review");
    expect(record.findings_by_kind?.["json-identifier-key"]).toBe(1);
  });
  test("an identifier-severity key (PatientName) is direct-identifiers", async () => {
    const { record } = await scanFiles(json({ PatientName: "Ottoline" }));
    expect(record.status).toBe("direct-identifiers");
  });
  test("an unrelated key is clean", async () => {
    const { record } = await scanFiles(json({ Title: "A study" }));
    expect(record.status).toBe("clean");
  });
});

describe("status from recording formats", () => {
  const SET = "sub-01/eeg/sub-01_task-rest_eeg.set";
  test("recordings only in a format the scanner cannot parse: not-screened, and never fetched", async () => {
    const { w, record } = await scanFiles({ [SET]: "x", "dataset_description.json": "{}" });
    expect(record.status).toBe("not-screened");
    expect(record.unscreened_formats).toEqual({ ".set": 1 });
    expect(w.hits(w.pathOf(ID, SET))).toBe(0);
  });
  test("clean EDF beside an unparsed format: clean-edf-only-others-unscreened", async () => {
    const { record } = await scanFiles({ [EDF]: CLEAN, [SET]: "x" });
    expect(record.status).toBe("clean-edf-only-others-unscreened");
    expect(record.incomplete).toBe(false);
  });
  test("the same clean EDF with no other format is plain clean", async () => {
    const { record } = await scanFiles({ [EDF]: CLEAN });
    expect(record.status).toBe("clean");
  });
  test("no recording of any kind: no-recordings", async () => {
    const { record } = await scanFiles({ "dataset_description.json": "{}", "README.md": "hi" });
    expect(record.status).toBe("no-recordings");
    expect(record.incomplete).toBe(false);
  });
  test("a finding is never hidden by an unscreened format", async () => {
    const { record } = await scanFiles({
      [SET]: "x",
      "sourcedata/export.json": JSON.stringify({ PatientName: "Ottoline" }),
    });
    expect(record.status).toBe("direct-identifiers");
  });
});

describe("recording data this scanner cannot parse is counted by what the file is", () => {
  const bids = (name: string, ext: string) => `sub-01/${name}/sub-01_task-a_${name}.${ext}`;
  const never = (w: StandIn, ...paths: string[]) => {
    for (const path of paths) expect(w.hits(w.pathOf(ID, path))).toBe(0);
  };

  test("a MEG directory beside a clean EDF is not clean; two files in it count once", async () => {
    const files = {
      [EDF]: CLEAN,
      "sub-01/meg/sub-01_task-a_meg.ds/a.meg4": "x",
      "sub-01/meg/sub-01_task-a_meg.ds/a.res4": "y",
    };
    const { w, record } = await scanFiles(files);
    expect(record.status).toBe("clean-edf-only-others-unscreened");
    expect(record.unscreened_formats).toEqual({ ".ds/": 1 });
    expect(record.incomplete).toBe(false);
    never(w, "sub-01/meg/sub-01_task-a_meg.ds/a.meg4", "sub-01/meg/sub-01_task-a_meg.ds/a.res4");
    // Twin: a second .ds directory is a second recording.
    const two = await scanFiles({ ...files, "sub-02/meg/sub-02_task-a_meg.ds/a.meg4": "z" });
    expect(two.record.unscreened_formats).toEqual({ ".ds/": 2 });
    // Twin: without the directory the dataset is plain clean.
    const alone = await scanFiles({ [EDF]: CLEAN });
    expect(alone.record.status).toBe("clean");
  });

  test(".hdf5 only is not-screened, not no-recordings; a dataset with no data file is no-recordings", async () => {
    const file = bids("eeg", "hdf5");
    const { w, record } = await scanFiles({ [file]: "x", "dataset_description.json": "{}" });
    expect(record.status).toBe("not-screened");
    expect(record.unscreened_formats).toEqual({ ".hdf5": 1 });
    never(w, file);
    const none = await scanFiles({ "dataset_description.json": "{}" });
    expect(none.record.status).toBe("no-recordings");
  });

  test(".edf.gz only is not-screened and is never read as an EDF header", async () => {
    const file = bids("eeg", "edf.gz");
    const { w, record } = await scanFiles({ [file]: CLEAN });
    expect(record.status).toBe("not-screened");
    expect(record.unscreened_formats).toEqual({ ".edf.gz": 1 });
    expect(record.files?.edf_bdf).toBe(0);
    never(w, file);
    // Twin: the same bytes named .edf are read, and are clean.
    const plain = await scanFiles({ [bids("eeg", "edf")]: CLEAN });
    expect(plain.record.status).toBe("clean");
    expect(plain.record.files?.header_read).toBe(1);
  });

  test("a BIDS data file in a format nobody listed is still counted; its JSON and TSV companions are not", async () => {
    const odd = await scanFiles({ [bids("eeg", "xyz")]: "x" });
    expect(odd.record.status).toBe("not-screened");
    expect(odd.record.unscreened_formats).toEqual({ ".xyz": 1 });
    const companions = await scanFiles({
      [bids("eeg", "json")]: "{}",
      [bids("eeg", "tsv")]: "a\tb\n",
    });
    expect(companions.record.status).toBe("no-recordings");
  });

  test("other signal files count wherever they sit: .mat, .h5, .bdf.gz", async () => {
    const { record } = await scanFiles({
      "sourcedata/export.mat": "x",
      "sourcedata/run1.h5": "y",
      [bids("emg", "bdf.gz")]: "z",
    });
    expect(record.status).toBe("not-screened");
    expect(record.unscreened_formats).toEqual({ ".mat": 1, ".h5": 1, ".bdf.gz": 1 });
  });

  test("the other directory formats count once per directory: .mff/, .mefd/, .zarr/", async () => {
    const { record } = await scanFiles({
      "sub-01/eeg/sub-01_task-a_eeg.mff/signal1.bin": "x",
      "sub-01/eeg/sub-01_task-a_eeg.mff/info.xml": "x",
      "sub-01/ieeg/sub-01_task-a_ieeg.mefd/a.timd/b.segd/c.tdat": "x",
      "sub-01/emg/sub-01_task-a_emg.zarr/.zarray": "x",
      "sub-01/emg/sub-01_task-a_emg.zarr/0.0": "x",
    });
    expect(record.status).toBe("not-screened");
    expect(record.unscreened_formats).toEqual({ ".mff/": 1, ".mefd/": 1, ".zarr/": 1 });
  });
});

describe("classifyDataset", () => {
  const base = {
    findings: [],
    edfCount: 0,
    headerRead: 0,
    unscreenedCount: 0,
    incompleteReasons: [],
  };
  test("each status is reachable, and incompleteness only matters when nothing was found", () => {
    expect(classifyDataset(base)).toBe("no-recordings");
    expect(classifyDataset({ ...base, unscreenedCount: 2 })).toBe("not-screened");
    expect(classifyDataset({ ...base, edfCount: 2, headerRead: 2 })).toBe("clean");
    expect(classifyDataset({ ...base, edfCount: 2, headerRead: 2, unscreenedCount: 1 })).toBe(
      "clean-edf-only-others-unscreened",
    );
    // headers not all read, even with no reason recorded
    expect(classifyDataset({ ...base, edfCount: 2, headerRead: 1 })).toBe("unchecked");
    expect(classifyDataset({ ...base, incompleteReasons: ["json-sampled"] })).toBe("unchecked");
  });

  test("a review finding is never hidden by incompleteness (twin: no finding is unchecked)", () => {
    const review = {
      kind: "image-or-document-file" as const,
      severity: "review" as const,
      field: "path",
      shape: shapeOf("consent.pdf"),
    };
    const incomplete = {
      ...base,
      edfCount: 2,
      headerRead: 1,
      unscreenedCount: 1,
      incompleteReasons: ["json-sampled"],
    };
    expect(classifyDataset({ ...incomplete, findings: [review] })).toBe("review");
    expect(classifyDataset({ ...incomplete, findings: [] })).toBe("unchecked");
  });
});

// ---------------------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------------------

describe("complete means every header was read", () => {
  const three = (second: FileDef): Record<string, FileDef> => ({
    [edfPath(1)]: CLEAN,
    [edfPath(2)]: second,
    [edfPath(3)]: CLEAN,
  });

  test("all three read: clean, complete, headers read equals the EDF count", async () => {
    const { record } = await scanFiles(three(CLEAN));
    expect(record.status).toBe("clean");
    expect(record.incomplete).toBe(false);
    expect(record.files).toEqual({ total: 3, edf_bdf: 3, header_read: 3, header_read_failed: 0 });
  });

  test("one read killed: not clean, incomplete, counted by class, and no edf-unreadable finding", async () => {
    const { record } = await scanFiles(three({ bytes: CLEAN, status: 404 }));
    expect(record.status).toBe("unchecked");
    expect(record.incomplete).toBe(true);
    expect(record.incomplete_reasons).toEqual(["edf-headers-unread"]);
    expect(record.files).toEqual({ total: 3, edf_bdf: 3, header_read: 2, header_read_failed: 1 });
    expect(record.read_failures).toEqual({ "edf/http-404": 1 });
    expect(record.findings_by_kind?.["edf-unreadable"]).toBeUndefined();
  });

  test("an empty EDF (416) and a short EDF are unread, not unreadable-header findings", async () => {
    const empty = await scanFiles(three(new Uint8Array(0)));
    expect(empty.record.status).toBe("unchecked");
    expect(empty.record.read_failures).toEqual({ "edf/http-416": 1 });
    expect(empty.record.findings_by_kind?.["edf-unreadable"]).toBeUndefined();
    const short = await scanFiles(three(CLEAN.subarray(0, 100)));
    expect(short.record.status).toBe("unchecked");
    expect(short.record.read_failures).toEqual({ "edf/short-body": 1 });
  });

  test("a server that ignores Range still reads the header, and the dataset stays complete", async () => {
    const longer = new Uint8Array(5000);
    longer.set(CLEAN);
    const { record } = await scanFiles(three({ bytes: longer, ignoreRange: true }));
    expect(record.status).toBe("clean");
    expect(record.incomplete).toBe(false);
  });

  test("a finding made is kept when a read fails: direct-identifiers, still marked incomplete", async () => {
    const { record } = await scanFiles({
      [edfPath(1)]: NAMED,
      [edfPath(2)]: { bytes: CLEAN, status: 404 },
    });
    expect(record.status).toBe("direct-identifiers");
    expect(record.incomplete).toBe(true);
    expect(record.incomplete_reasons).toEqual(["edf-headers-unread"]);
  });

  test("a review finding stays review when a read fails; the same failure without it is unchecked", async () => {
    const failing = { [edfPath(2)]: { bytes: CLEAN, status: 404 } };
    const withReview = await scanFiles({
      [edfPath(1)]: CLEAN,
      ...failing,
      "sourcedata/note.pdf": "x",
    });
    expect(withReview.record.status).toBe("review");
    expect(withReview.record.incomplete).toBe(true);
    expect(withReview.record.incomplete_reasons).toEqual(["edf-headers-unread"]);
    const without = await scanFiles({ [edfPath(1)]: CLEAN, ...failing });
    expect(without.record.status).toBe("unchecked");
  });

  test("a scans table that cannot be read blocks clean (scans-unread); the readable twin is clean", async () => {
    const table = "filename\tacq_time\nsub-01/eeg/a.edf\tn/a\n";
    const broken = await scanFiles({
      [EDF]: CLEAN,
      "sub-01/sub-01_scans.tsv": { bytes: enc(table), status: 500 },
    });
    expect(broken.record.status).toBe("unchecked");
    expect(broken.record.incomplete).toBe(true);
    expect(broken.record.incomplete_reasons).toEqual(["scans-unread"]);
    expect(broken.record.read_failures).toEqual({ "scans/http-500": 1 });
    // So a resumed run does not keep the verdict.
    expect(isFinalRecord(broken.record, "v1.0.0")).toBe(false);
    const fine = await scanFiles({ [EDF]: CLEAN, "sub-01/sub-01_scans.tsv": table });
    expect(fine.record.status).toBe("clean");
    expect(isFinalRecord(fine.record, "v1.0.0")).toBe(true);
  });

  test("participants.tsv that cannot be read blocks clean; the readable twin is clean", async () => {
    const broken = await scanFiles({
      [EDF]: CLEAN,
      "participants.tsv": { bytes: enc("participant_id\n"), status: 404 },
    });
    expect(broken.record.status).toBe("unchecked");
    expect(broken.record.incomplete_reasons).toEqual(["participants-unread"]);
    expect(broken.record.read_failures).toEqual({ "participants/http-404": 1 });
    const fine = await scanFiles({
      [EDF]: CLEAN,
      "participants.tsv": "participant_id\tage\nsub-01\t30\n",
    });
    expect(fine.record.status).toBe("clean");
  });

  test("an unreadable or unparseable JSON, and an unreadable text file, block clean", async () => {
    const missing = await scanFiles({
      [EDF]: CLEAN,
      "sourcedata/a.json": { bytes: enc("{}"), status: 404 },
    });
    expect(missing.record.incomplete_reasons).toEqual(["json-unread"]);
    const bad = await scanFiles({ [EDF]: CLEAN, "sourcedata/a.json": "{not json" });
    expect(bad.record.status).toBe("unchecked");
    expect(bad.record.read_failures).toEqual({ "json/json-parse": 1 });
    const text = await scanFiles({
      [EDF]: CLEAN,
      "code/run.py": { bytes: enc("x = 1"), status: 403 },
    });
    expect(text.record.incomplete_reasons).toEqual(["text-unread"]);
    const ok = await scanFiles({ [EDF]: CLEAN, "sourcedata/a.json": "{}", "code/run.py": "x = 1" });
    expect(ok.record.status).toBe("clean");
  });
});

// ---------------------------------------------------------------------------------------
// Sampling caps
// ---------------------------------------------------------------------------------------

describe("sampling caps are counted and make the dataset incomplete", () => {
  const jsonFiles = (n: number): Record<string, FileDef> => {
    const out: Record<string, FileDef> = { [EDF]: CLEAN };
    for (let i = 0; i < n; i++) out[`sourcedata/export-${i}.json`] = "{}";
    return out;
  };

  test("more JSON files than the cap: json-sampled, with candidates and selected counts", async () => {
    const { record } = await scanFiles(jsonFiles(3), { limits: { jsonFiles: 2 } });
    expect(record.status).toBe("unchecked");
    expect(record.incomplete_reasons).toEqual(["json-sampled"]);
    expect(record.sampling?.json_files).toEqual({
      candidates: 3,
      oversize: 0,
      selected: 2,
      scanned: 2,
    });
  });
  test("exactly the cap is complete (twin)", async () => {
    const { record } = await scanFiles(jsonFiles(2), { limits: { jsonFiles: 2 } });
    expect(record.status).toBe("clean");
    expect(record.sampling?.json_files).toEqual({
      candidates: 2,
      oversize: 0,
      selected: 2,
      scanned: 2,
    });
  });

  test("a JSON above the size filter is not read and is counted: json-oversize", async () => {
    const big = await scanFiles({
      [EDF]: CLEAN,
      "sourcedata/big.json": { bytes: enc("{}"), size: 70_000 },
    });
    expect(big.record.incomplete_reasons).toEqual(["json-oversize"]);
    expect(big.record.sampling?.json_files.oversize).toBe(1);
    expect(big.w.hits(big.w.pathOf(ID, "sourcedata/big.json"))).toBe(0);
    const small = await scanFiles({
      [EDF]: CLEAN,
      "sourcedata/big.json": { bytes: enc("{}"), size: 100 },
    });
    expect(small.record.status).toBe("clean");
    expect(small.w.hits(small.w.pathOf(ID, "sourcedata/big.json"))).toBe(1);
  });

  test("text files: over the count cap is text-sampled, above the size filter is text-oversize", async () => {
    const files: Record<string, FileDef> = { [EDF]: CLEAN, "code/a.py": "x", "code/b.py": "y" };
    const sampled = await scanFiles(files, { limits: { textFiles: 1 } });
    expect(sampled.record.incomplete_reasons).toEqual(["text-sampled"]);
    const oversize = await scanFiles({
      [EDF]: CLEAN,
      "code/a.py": { bytes: enc("x"), size: 70_000 },
    });
    expect(oversize.record.incomplete_reasons).toEqual(["text-oversize"]);
    const fine = await scanFiles(files);
    expect(fine.record.status).toBe("clean");
  });

  test("a second scans table beyond the one read is recorded but does not make the dataset incomplete", async () => {
    const table = "filename\tacq_time\nsub-01/eeg/a.edf\tn/a\n";
    const two = await scanFiles({
      [EDF]: CLEAN,
      "sub-01/sub-01_scans.tsv": table,
      "sub-02/sub-02_scans.tsv": table,
    });
    expect(two.record.incomplete_reasons).toEqual([]);
    expect(two.record.status).toBe("clean");
    expect(two.record.sampling?.scans_tables).toEqual({
      candidates: 2,
      oversize: 0,
      selected: 1,
      scanned: 1,
    });
    const one = await scanFiles({ [EDF]: CLEAN, "sub-01/sub-01_scans.tsv": table });
    expect(one.record.status).toBe("clean");
  });

  test("a scans table longer than the read does not make the dataset incomplete; a dated row is dates-only", async () => {
    const rows = Array.from({ length: 4000 }, (_, i) => `sub-01/eeg/f${i}.edf\tn/a`).join("\n");
    const long = `filename\tacq_time\n${rows}\n`;
    const truncated = await scanFiles({ [EDF]: CLEAN, "sub-01/sub-01_scans.tsv": long });
    expect(long.length).toBeGreaterThan(65_536);
    expect(truncated.record.incomplete_reasons).toEqual([]);
    expect(truncated.record.status).toBe("clean");
    const dated = await scanFiles({
      [EDF]: CLEAN,
      "sub-01/sub-01_scans.tsv": "filename\tacq_time\nsub-01/eeg/a.edf\t2020-03-14T10:00:00\n",
    });
    expect(dated.record.status).toBe("dates-only");
    expect(dated.record.findings_by_kind?.["acq-time-dated"]).toBe(1);
    const clipped = await scanFiles({
      [EDF]: CLEAN,
      "sub-01/sub-01_scans.tsv": "filename\tacq_time\nsub-01/eeg/a.edf\t2020-01-01T10:00:00\n",
    });
    expect(clipped.record.status).toBe("clean");
    // A table that starts with a byte order mark is still read from its first column.
    const bom = await scanFiles({
      [EDF]: CLEAN,
      "sub-01/sub-01_scans.tsv":
        "\uFEFFacq_time\tfilename\n2020-03-14T10:00:00\tsub-01/eeg/a.edf\n",
    });
    expect(bom.record.status).toBe("dates-only");
    expect(bom.record.findings_by_kind?.["acq-time-dated"]).toBe(1);
  });

  test("a dated scans row follows the same rules as a dated header: others unscreened, an unread header, a review finding", async () => {
    const table = "filename\tacq_time\nsub-01/eeg/a.edf\t2020-03-14T10:00:00\n";
    const scans = { "sub-01/sub-01_scans.tsv": table };
    const withSet = await scanFiles({ [EDF]: CLEAN, ...scans, "sub-01/eeg/b.set": "x" });
    expect(withSet.record.status).toBe("clean-edf-only-others-unscreened");
    const unread = await scanFiles({
      [EDF]: CLEAN,
      ...scans,
      [edfPath(2)]: { bytes: CLEAN, status: 404 },
    });
    expect(unread.record.status).toBe("unchecked");
    const review = await scanFiles({ [EDF]: CLEAN, ...scans, "sourcedata/note.pdf": "x" });
    expect(review.record.status).toBe("review");
  });

  test("participants.tsv longer than its read is participants-truncated; a larger read is complete", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => `sub-${String(i).padStart(2, "0")}\t30`);
    const table = `participant_id\tage\n${rows.join("\n")}\n`;
    const cut = await scanFiles(
      { [EDF]: CLEAN, "participants.tsv": table },
      { limits: { participantsBytes: 64 } },
    );
    expect(cut.record.incomplete_reasons).toEqual(["participants-truncated"]);
    const whole = await scanFiles({ [EDF]: CLEAN, "participants.tsv": table });
    expect(whole.record.status).toBe("clean");
  });

  test("participants.tsv with an identifier column is direct; a name-like participant label is review", async () => {
    const column = await scanFiles({
      [EDF]: CLEAN,
      "participants.tsv": "participant_id\tname\nsub-01\tx\n",
    });
    expect(column.record.status).toBe("direct-identifiers");
    const label = await scanFiles({
      [EDF]: CLEAN,
      "participants.tsv": "participant_id\tage\nsub-Quillfeather\t30\n",
    });
    expect(label.record.status).toBe("review");
    const coded = await scanFiles({
      [EDF]: CLEAN,
      "participants.tsv": "participant_id\tage\nsub-01\t30\n",
    });
    expect(coded.record.status).toBe("clean");
  });

  test("a participants table with more name-like labels than a call can spread is read in full", async () => {
    // 1.1 million rows is past the point where Bun throws on `push(...findings)` (between 500,000
    // and 1,000,000 arguments); a throw would make the table unreadable and the record unchecked.
    const rows = 1_100_000;
    const table = `participant_id\n${"sub-abcd\n".repeat(rows)}`;
    const { record } = await scanFiles(
      { [EDF]: CLEAN, "participants.tsv": table },
      { limits: { participantsBytes: 16 * 1024 * 1024 } },
    );
    expect(record.incomplete_reasons).toEqual([]);
    expect(record.read_failures).toEqual({});
    expect(record.status).toBe("review");
    expect(record.findings_by_kind?.["path-subject-label"]).toBe(rows);
  }, 60_000);

  test("an empty side file has nothing to read: not requested, not a cap, not a failure", async () => {
    const { w, record } = await scanFiles({
      [EDF]: CLEAN,
      "sourcedata/empty.json": new Uint8Array(0),
      "code/empty.py": new Uint8Array(0),
    });
    expect(record.status).toBe("clean");
    expect(w.hits(w.pathOf(ID, "sourcedata/empty.json"))).toBe(0);
    expect(w.hits(w.pathOf(ID, "code/empty.py"))).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------
// Sampling helper
// ---------------------------------------------------------------------------------------

describe("sampleEvenly", () => {
  const items = (subjects: number, perSubject: number) =>
    Array.from({ length: subjects * perSubject }, (_, i) => ({
      subject: `s${String(Math.floor(i / perSubject)).padStart(3, "0")}`,
      n: i % perSubject,
    }));
  const bySubject = (picked: { subject: string }[]) => {
    const counts = new Map<string, number>();
    for (const p of picked) counts.set(p.subject, (counts.get(p.subject) ?? 0) + 1);
    return counts;
  };
  const key = (x: { subject: string }) => x.subject;

  test("returns everything when it fits", () => {
    expect(sampleEvenly(items(3, 4), 12, key)).toHaveLength(12);
    expect(sampleEvenly(items(3, 4), 50, key)).toHaveLength(12);
  });
  test("spreads evenly across subjects when it must cut", () => {
    const picked = sampleEvenly(items(10, 100), 300, key);
    expect(picked).toHaveLength(300);
    expect([...bySubject(picked).values()]).toEqual(Array(10).fill(30));
    expect(new Set(picked.map((p) => `${p.subject}/${p.n}`)).size).toBe(300);
  });
  test("with more subjects than the cap, picks evenly spaced subjects, one each", () => {
    const picked = sampleEvenly(items(400, 1), 300, key);
    expect(picked).toHaveLength(300);
    expect(bySubject(picked).size).toBe(300);
  });
  test("small subjects give all they have; large ones share the rest", () => {
    const small = items(2, 3);
    const large = items(2, 50).map((x) => ({ ...x, subject: `L${x.subject}` }));
    const picked = sampleEvenly([...small, ...large], 20, key);
    expect(picked).toHaveLength(20);
    const counts = bySubject(picked);
    expect(counts.get("s000")).toBe(3);
    expect(counts.get("s001")).toBe(3);
    expect(counts.get("Ls000")).toBe(7);
    expect(counts.get("Ls001")).toBe(7);
  });
  test("is deterministic and a zero cap picks nothing", () => {
    expect(sampleEvenly(items(5, 9), 7, key)).toEqual(sampleEvenly(items(5, 9), 7, key));
    expect(sampleEvenly(items(5, 9), 0, key)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------------------

describe("a manifest that is not a list of entries is unchecked with a reason", () => {
  const cases: [string, DatasetOptions][] = [
    ["an object", { manifestBody: { error: "nope" } }],
    ["null", { manifestBody: null }],
    ["a string", { manifestBody: "manifest" }],
    ["an entry that is not an object", { manifestBody: ["sub-01/a.edf"] }],
    ["an entry without a url", { manifestBody: [{ path: "a.edf", size: 256 }] }],
    ["an entry with an empty url", { manifestBody: [{ path: "a.edf", size: 256, url: "" }] }],
    ["an entry without a path", { manifestBody: [{ size: 256, url: "http://x/a" }] }],
  ];
  for (const [name, options] of cases) {
    test(name, async () => {
      const { record } = await scanFiles({ [EDF]: CLEAN }, {}, options);
      expect(record.status).toBe("unchecked");
      expect(record.incomplete).toBe(true);
      expect(record.incomplete_reasons).toEqual(["manifest:manifest-shape"]);
    });
  }
  test("an unparseable body is a classed failure too", async () => {
    const { record } = await scanFiles({ [EDF]: CLEAN }, {}, { manifestRaw: "<html>" });
    expect(record.incomplete_reasons).toEqual(["manifest:json-parse"]);
  });
  test("an empty list is a valid manifest (twin): no-recordings, complete", async () => {
    const { record } = await scanFiles({}, {}, { manifestBody: [] });
    expect(record.status).toBe("no-recordings");
    expect(record.incomplete).toBe(false);
  });
  test("no latest version is unchecked, without any request", async () => {
    const w = newWorld();
    const record = await scanDataset(w.ctx(), ID, null);
    expect(record.status).toBe("unchecked");
    expect(record.incomplete_reasons).toEqual(["no-latest-version"]);
    expect(w.requests).toHaveLength(0);
  });
});

describe("a manifest too large for the data plane (413) falls back, never retried", () => {
  const B = "sub-01/eeg/sub 01#a_eeg.edf";
  test("raw version manifest: a git key with no bytes_url, an empty one and a given one", async () => {
    const w = newWorld();
    w.add(ID, {}, { manifestStatus: 413 });
    const versionManifest = {
      files: {
        [B]: { key: "git:aaa", size: 256 },
        [edfPath(2)]: { key: "git:bbb", size: 256, bytes_url: "" },
        [edfPath(3)]: { key: "git:ccc", size: 256, bytes_url: `${w.base}/s3/custom/given.edf` },
        [edfPath(4)]: { key: "MD5E-s256--aa11.edf", size: 256 },
      },
    };
    w.patch(ID, { versionManifest });
    const v = w.versionOf(ID);
    w.raw(`/data/${ID}/${v}/${encodePath(B)}`, { bytes: CLEAN });
    w.raw(`/data/${ID}/${v}/${encodePath(edfPath(2))}`, { bytes: CLEAN });
    w.raw(`/data/${ID}/${v}/${encodePath(edfPath(3))}`, { bytes: CLEAN });
    w.raw(`/data/${ID}/${v}/${encodePath(edfPath(4))}`, { bytes: CLEAN });
    const record = await scanDataset(w.ctx(), ID, v);
    expect(record.manifest_source).toBe("s3-version-manifest");
    expect(record.status).toBe("clean");
    expect(record.files).toEqual({ total: 4, edf_bdf: 4, header_read: 4, header_read_failed: 0 });
    // Built per segment like the tree fallback: the space and `#` are encoded, the slashes are not.
    expect(w.hits(`/data/${ID}/${v}/sub-01/eeg/sub%2001%23a_eeg.edf`)).toBe(1);
    expect(w.hits(`/data/${ID}/${v}/${encodePath(edfPath(2))}`)).toBe(1);
    // A legacy bytes_url is ignored: the stable data-plane route is always used.
    expect(w.hits("/s3/custom/given.edf")).toBe(0);
    expect(w.hits(`/data/${ID}/${v}/${encodePath(edfPath(3))}`)).toBe(1);
    expect(w.hits(`/data/${ID}/${v}/${encodePath(edfPath(4))}`)).toBe(1);
    expect(w.hits(w.manifestPath(ID))).toBe(1);
  });

  test("a version manifest without `files` is a classed failure, then the tree is tried", async () => {
    const w = newWorld();
    w.add(ID, {}, { manifestStatus: 413, versionManifest: { nothing: true }, treeStatus: 404 });
    const record = await scanDataset(w.ctx(), ID, w.versionOf(ID));
    expect(record.incomplete_reasons).toEqual([
      "manifest:too-large(s3:manifest-shape,tree:http-404)",
    ]);
  });

  test("git tree: 300 headers at most, evenly across subjects, and the dataset is incomplete", async () => {
    const w = newWorld();
    const blobs: { path: string; type: string; size: number }[] = [];
    w.add(ID, {}, { manifestStatus: 413 });
    const v = w.versionOf(ID);
    for (let s = 1; s <= 20; s++) {
      for (let k = 1; k <= 20; k++) {
        const path = `sub-${String(s).padStart(2, "0")}/ses-${k}/eeg/sub-${String(s).padStart(2, "0")}_ses-${k}_eeg.edf`;
        blobs.push({ path, type: "blob", size: 256 });
        w.raw(`/data/${ID}/${v}/${encodePath(path)}`, { bytes: CLEAN });
      }
    }
    w.patch(ID, { tree: { truncated: false, tree: [{ path: "sub-01", type: "tree" }, ...blobs] } });
    const record = await scanDataset(w.ctx(), ID, v);
    expect(record.manifest_source).toBe("git-tree");
    expect(record.status).toBe("unchecked");
    expect(record.incomplete_reasons).toEqual(["edf-headers-sampled"]);
    expect(record.sampling?.edf_headers).toEqual({
      candidates: 400,
      oversize: 0,
      selected: 300,
      scanned: 300,
    });
    const reads = w.requests.filter((r) => r.path.endsWith("_eeg.edf"));
    expect(reads).toHaveLength(300);
    const perSubject = new Map<string, number>();
    for (const r of reads) {
      const label = /\/(sub-\d+)\//.exec(r.path)?.[1] as string;
      perSubject.set(label, (perSubject.get(label) ?? 0) + 1);
    }
    expect([...perSubject.values()]).toEqual(Array(20).fill(15));
  });

  test("git tree with few enough headers reads all of them and is complete (twin)", async () => {
    const w = newWorld();
    w.add(ID, {}, { manifestStatus: 413 });
    const v = w.versionOf(ID);
    const blobs = Array.from({ length: 40 }, (_, i) => ({
      path: edfPath(i + 1),
      type: "blob",
      size: 256,
    }));
    for (const b of blobs) w.raw(`/data/${ID}/${v}/${encodePath(b.path)}`, { bytes: CLEAN });
    w.patch(ID, { tree: { truncated: false, tree: blobs } });
    const record = await scanDataset(w.ctx(), ID, v);
    expect(record.manifest_source).toBe("git-tree");
    expect(record.status).toBe("clean");
    expect(record.files?.header_read).toBe(40);
  });

  test("a truncated tree is not used", async () => {
    const w = newWorld();
    w.add(ID, {}, { manifestStatus: 413, tree: { truncated: true, tree: [] } });
    const record = await scanDataset(w.ctx(), ID, w.versionOf(ID));
    expect(record.incomplete_reasons).toEqual([
      "manifest:too-large(s3:error-Error,tree:tree-truncated)",
    ]);
  });

  test("the GitHub token goes only to the GitHub API", async () => {
    const w = newWorld();
    const blobs = [{ path: EDF, type: "blob", size: 256 }];
    w.add(ID, {}, { manifestStatus: 413, tree: { truncated: false, tree: blobs } });
    const v = w.versionOf(ID);
    w.raw(`/data/${ID}/${v}/${encodePath(EDF)}`, { bytes: CLEAN });
    await scanDataset(w.ctx({ githubToken: async () => "tok-123" }), ID, v);
    const gh = w.requests.filter((r) => r.path.startsWith("/gh/"));
    expect(gh).toHaveLength(1);
    expect(gh[0]?.authorization).toBe("Bearer tok-123");
    expect(w.requests.filter((r) => !r.path.startsWith("/gh/") && r.authorization)).toEqual([]);
  });

  test("the git-tree source is sampled; the same entries from manifest.json are all read", async () => {
    const w = newWorld();
    w.add(ID, {});
    const entries = Array.from({ length: 12 }, (_, i) => {
      const path = edfPath(i + 1);
      w.raw(w.pathOf(ID, path), { bytes: CLEAN });
      return { path, size: 256, url: `${w.base}/s3/${ID}/${encodePath(path)}` };
    });
    const ctx = w.ctx({ limits: { treeHeaderSample: 5 } });
    const tree = await scanDatasetFromManifest(ctx, ID, "v1.0.0", entries, "git-tree");
    expect(tree.sampling?.edf_headers.selected).toBe(5);
    expect(tree.incomplete).toBe(true);
    const listed = await scanDatasetFromManifest(ctx, ID, "v1.0.0", entries, "manifest.json");
    expect(listed.sampling?.edf_headers.selected).toBe(12);
    expect(listed.status).toBe("clean");
  });
});

// ---------------------------------------------------------------------------------------
// Politeness
// ---------------------------------------------------------------------------------------

describe("Worker reads are bounded separately from direct S3 reads", () => {
  const edfs = (via: "s3" | "worker", n = 40): Record<string, FileDef> =>
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => [edfPath(i + 1), { bytes: CLEAN, via, delayMs: 25 }]),
    );

  test("git-tracked EDFs through the Worker never exceed the Worker bound", async () => {
    const { w, record } = await scanFiles(edfs("worker"));
    expect(record.status).toBe("clean");
    expect(w.maxInflight.data).toBeLessThanOrEqual(6);
    expect(w.maxInflight.data).toBeGreaterThan(1);
  });
  test("the same files straight from S3 run well past that bound (twin)", async () => {
    const { w, record } = await scanFiles(edfs("s3"));
    expect(record.status).toBe("clean");
    expect(w.maxInflight.s3).toBeGreaterThan(6);
  });
  test("a larger Worker bound is honored, so the cap is the setting and not a constant (twin)", async () => {
    const { w } = await scanFiles(edfs("worker"), { workerConcurrency: 30 });
    expect(w.maxInflight.data).toBeGreaterThan(6);
  });
  test("the bound is shared by datasets scanned at the same time", async () => {
    const w = newWorld();
    w.add("nm000020", edfs("worker", 20));
    w.add("nm000021", edfs("worker", 20));
    const ctx = w.ctx({ workerConcurrency: 4 });
    await Promise.all([
      scanDataset(ctx, "nm000020", "v1.0.0"),
      scanDataset(ctx, "nm000021", "v1.0.0"),
    ]);
    expect(w.maxInflight.data).toBeLessThanOrEqual(4);
    expect(w.maxInflight.data).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------------------
// The run: catalog, resume, summary
// ---------------------------------------------------------------------------------------

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

describe("buildSummary", () => {
  test("counts per status, an incomplete id list, and reasons; a missing flag is incomplete", () => {
    const summary = buildSummary([
      { id: "b", status: "clean", incomplete: false },
      { id: "a", status: "clean", incomplete: false },
      { id: "c", status: "unchecked", incomplete: true, incomplete_reasons: ["manifest:http-500"] },
      {
        id: "d",
        status: "direct-identifiers",
        incomplete: true,
        incomplete_reasons: ["json-sampled", "edf-headers-unread"],
      },
      { id: "e", status: "review" },
    ]);
    expect(summary).toEqual({
      datasets: 5,
      by_status: {
        clean: { count: 2, ids: ["a", "b"] },
        "direct-identifiers": { count: 1, ids: ["d"] },
        review: { count: 1, ids: ["e"] },
        unchecked: { count: 1, ids: ["c"] },
      },
      incomplete: { count: 3, ids: ["c", "d", "e"] },
      incomplete_reasons: { "edf-headers-unread": 1, "json-sampled": 1, "manifest:http-500": 1 },
    });
  });
});

describe("runFleet", () => {
  test("lists only public datasets and pages the catalog", async () => {
    const w = newWorld();
    for (let i = 0; i < 130; i++)
      w.add(`nm${String(i + 1000).padStart(6, "0")}`, {}, { manifestBody: [] });
    w.add("nm000999", { [EDF]: CLEAN }, { visibility: "private" });
    const out = tempDir();
    const summary = await runFleet(w.ctx(), { outDir: out, force: false, datasetConcurrency: 8 });
    expect(summary.datasets).toBe(130);
    expect(summary.by_status["no-recordings"]?.count).toBe(130);
    expect(existsSync(join(out, "nm000999.json"))).toBe(false);
    expect(w.hits(w.manifestPath("nm000999"))).toBe(0);
  });

  test("an existing file is kept only when final; unchecked and incomplete ones are retried", async () => {
    const w = newWorld();
    w.add("nm000001", { [EDF]: CLEAN });
    w.add("nm000002", { [EDF]: CLEAN }, { manifestStatus: 500 });
    w.add("nm000003", { [EDF]: { bytes: NAMED, status: 404 } });
    const out = tempDir();
    const ctx = w.ctx();
    const options = { outDir: out, force: false, datasetConcurrency: 2 };

    const first = await runFleet(ctx, options);
    expect(first.by_status.clean?.ids).toEqual(["nm000001"]);
    expect(first.by_status.unchecked?.ids).toEqual(["nm000002", "nm000003"]);
    expect(first.incomplete.ids).toEqual(["nm000002", "nm000003"]);
    expect(first.incomplete_reasons).toEqual({
      "edf-headers-unread": 1,
      "manifest:http-500": 1,
    });
    const hits = (id: string) => w.hits(w.manifestPath(id));
    expect([hits("nm000001"), hits("nm000002"), hits("nm000003")]).toEqual([1, 2, 1]);

    // Repair the two failures, as a rerun after a transient outage would find them.
    w.patch("nm000002", { manifestStatus: undefined });
    w.set("nm000003", EDF, NAMED);
    const second = await runFleet(ctx, options);
    expect(hits("nm000001")).toBe(1); // final: kept
    expect(hits("nm000002")).toBe(3); // unchecked: retried
    expect(hits("nm000003")).toBe(2); // incomplete: retried
    expect(second.by_status.clean?.ids).toEqual(["nm000001", "nm000002"]);
    expect(second.by_status["direct-identifiers"]?.ids).toEqual(["nm000003"]);
    expect(second.incomplete.count).toBe(0);

    const third = await runFleet(ctx, options);
    expect([hits("nm000001"), hits("nm000002"), hits("nm000003")]).toEqual([1, 3, 2]);
    expect(third).toEqual(second);

    await runFleet(ctx, { ...options, force: true });
    expect([hits("nm000001"), hits("nm000002"), hits("nm000003")]).toEqual([2, 4, 3]);
  });

  test("a final record is kept only for the version it was scanned at", async () => {
    const w = newWorld();
    w.add("nm000001", { [EDF]: CLEAN });
    const out = tempDir();
    const ctx = w.ctx();
    const options = { outDir: out, force: false, datasetConcurrency: 1 };
    const first = await runFleet(ctx, options);
    expect(first.by_status.clean?.ids).toEqual(["nm000001"]);
    expect(readJson(join(out, "nm000001.json")).version).toBe("v1.0.0");

    // Same version again: the final verdict is kept, nothing is fetched.
    await runFleet(ctx, options);
    expect(w.hits(w.manifestPath("nm000001"))).toBe(1);

    // The dataset is published again, now carrying a name in a header.
    w.patch("nm000001", { version: "v1.1.0" });
    w.set("nm000001", EDF, NAMED);
    const second = await runFleet(ctx, options);
    expect(w.hits(w.manifestPath("nm000001"))).toBe(1); // the new version's manifest, once
    expect(readJson(join(out, "nm000001.json")).version).toBe("v1.1.0");
    expect(second.by_status["direct-identifiers"]?.ids).toEqual(["nm000001"]);
    expect(second.by_status.clean).toBeUndefined();

    // And now that version is final.
    await runFleet(ctx, options);
    expect(w.hits(w.manifestPath("nm000001"))).toBe(1);
  });

  test("a damaged or old-format file is rescanned, and no temp file is left behind", async () => {
    const w = newWorld();
    w.add("nm000001", { [EDF]: CLEAN });
    w.add("nm000002", { [EDF]: CLEAN });
    const out = tempDir();
    await Bun.write(join(out, "nm000001.json"), "{ not json");
    // An earlier run's file with a verdict but no `incomplete` field is not trusted as final.
    await Bun.write(
      join(out, "nm000002.json"),
      JSON.stringify({ id: "nm000002", status: "clean" }),
    );
    const summary = await runFleet(w.ctx(), { outDir: out, force: false, datasetConcurrency: 2 });
    expect(summary.by_status.clean?.count).toBe(2);
    expect(w.hits(w.manifestPath("nm000001"))).toBe(1);
    expect(w.hits(w.manifestPath("nm000002"))).toBe(1);
    expect(readdirSync(out).sort()).toEqual(["_summary.json", "nm000001.json", "nm000002.json"]);
  });

  test("an --only id missing from the public catalog is an error naming it, and nothing is scanned", async () => {
    const w = newWorld();
    w.add("nm000001", { [EDF]: CLEAN });
    w.add("nm000002", { [EDF]: CLEAN }, { visibility: "private" });
    const out = tempDir();
    const error = await runFleet(w.ctx(), {
      outDir: out,
      only: ["nm000001", "nm000002", "nm999999"],
      force: false,
      datasetConcurrency: 1,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain("nm000002, nm999999");
    expect((error as Error).message).not.toContain("nm000001,");
    expect(w.hits(w.manifestPath("nm000001"))).toBe(0);
    // The twin: every id known, and only those are scanned.
    const ok = await runFleet(w.ctx(), {
      outDir: out,
      only: ["nm000001"],
      force: false,
      datasetConcurrency: 1,
    });
    expect(ok.datasets).toBe(1);
  });

  test("an unexpected exception inside one dataset is recorded as unchecked, and the run carries on", async () => {
    const w = newWorld();
    w.add("nm000001", { [EDF]: CLEAN });
    w.add("nm000002", { [EDF]: CLEAN });
    const out = tempDir();
    // A pool size of zero throws a RangeError inside the scan itself, outside every classed path.
    const broken = { ...w.ctx(), fileConcurrency: 0 };
    const summary = await runFleet(broken, { outDir: out, force: false, datasetConcurrency: 1 });
    expect(summary.by_status.unchecked?.ids).toEqual(["nm000001", "nm000002"]);
    expect(readJson(join(out, "nm000001.json")).incomplete_reasons).toEqual([
      "internal:error-RangeError",
    ]);
    // The same datasets under a working context are clean (twin).
    const fixed = await runFleet(w.ctx(), { outDir: out, force: false, datasetConcurrency: 1 });
    expect(fixed.by_status.clean?.ids).toEqual(["nm000001", "nm000002"]);
  });
});

// ---------------------------------------------------------------------------------------
// The CLI and what reaches the disk
// ---------------------------------------------------------------------------------------

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "identifier-fleet-scan.ts");

async function runCli(
  args: string[],
  w?: StandIn,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn([process.execPath, "run", SCRIPT, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...(w ? { NEMAR_API_BASE: `${w.base}/api`, NEMAR_DATA_BASE: `${w.base}/data` } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("the CLI", () => {
  test("a non-positive or non-numeric count exits 2 with a message, before touching the disk", async () => {
    const w = newWorld();
    for (const args of [
      ["--concurrency", "0"],
      ["--concurrency", "abc"],
      ["--datasets", "0"],
    ]) {
      const out = join(tempDir(), "out");
      const result = await runCli(["--out", out, ...args], w);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("must be a positive integer");
      expect(existsSync(out)).toBe(false);
    }
    expect(w.requests).toHaveLength(0);
  }, 30_000);

  test("valid counts run, write one file per dataset and a summary, and exit 0 (twin)", async () => {
    const w = newWorld();
    w.add("nm000001", { [EDF]: CLEAN });
    const out = join(tempDir(), "out");
    const result = await runCli(["--out", out, "--concurrency", "2", "--datasets", "1"], w);
    expect(result.code).toBe(0);
    expect(readdirSync(out).sort()).toEqual(["_summary.json", "nm000001.json"]);
    expect(readJson(join(out, "nm000001.json")).status).toBe("clean");
    expect(result.stderr).toContain("clean=1");
  }, 30_000);

  test("an unknown --only id exits 2 and lists it on stderr; nothing is written", async () => {
    const w = newWorld();
    w.add("nm000001", { [EDF]: CLEAN });
    const out = join(tempDir(), "out");
    const result = await runCli(["--out", out, "--only", "nm000001,nm424242"], w);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("nm424242");
    expect(existsSync(join(out, "nm000001.json"))).toBe(false);
  }, 30_000);

  /**
   * The privacy contract on what reached the disk. The flagged dataset carries invented
   * identifying values in every place the scanner reads: an EDF patient field (ASCII name
   * and non-ASCII bytes), a name-keyed JSON, participants labels and columns, a file path
   * and a local-user path in code. The findings must still be made (so the grep is not
   * vacuous), and none of the injected text may appear in any written file or in the
   * CLI's own output.
   */
  const SECRETS = [
    "Quillfeather",
    "montzy",
    "Wexlerton",
    "Ottoline",
    "Hollowbrook",
    "Annabelle",
    "Thornfield",
    "Zo\u00eb",
    "Hartwick",
    "pembridge",
  ];

  function privacyDataset(flagged: boolean): Record<string, FileDef> {
    return {
      [edfPath(1)]: edfHeader({ patient: flagged ? "P01 F X Quillfeather" : "P01 F X X" }),
      [edfPath(2)]: edfHeader({
        patient: flagged ? enc("P02 F X Br\u00e9montzy") : "P02 F X X",
      }),
      [flagged ? "sub-Hollowbrook/eeg/sub-Hollowbrook_task-rest_eeg.edf" : edfPath(3)]: CLEAN,
      "sourcedata/export.json": JSON.stringify(
        flagged
          ? {
              "Wexlerton Qua": { PatientName: "Ottoline Pembridge" },
              "Zo\u00eb Hartwick": { MRN: "A123" },
            }
          : { "Wexlerton Qua": { Other: "x" }, "Zo\u00eb Hartwick": { Other: "y" } },
      ),
      "participants.tsv": flagged
        ? "participant_id\tname\nsub-Quillfeather\tAnnabelle Thornfield\n"
        : "participant_id\tage\nsub-01\t30\n",
      "code/run.py": flagged ? 'path = "/Users/pembridge/data"\n' : 'path = "data"\n',
    };
  }

  function everythingWritten(out: string): string {
    return readdirSync(out)
      .map((f) => readFileSync(join(out, f), "utf8"))
      .join("\n");
  }

  test("flagged: findings are made, and no injected value is written anywhere", async () => {
    const w = newWorld();
    w.add("nm000001", privacyDataset(true));
    const out = join(tempDir(), "out");
    const result = await runCli(["--out", out], w);
    expect(result.code).toBe(0);
    const record = readJson(join(out, "nm000001.json")) as unknown as DatasetRecord;
    expect(record.status).toBe("direct-identifiers");
    expect(record.incomplete).toBe(false);
    // The detectors fired, so the absence below is a property of the output, not of silence.
    expect(record.findings_by_kind?.["edf-patient-name"]).toBeGreaterThanOrEqual(1);
    expect(record.findings_by_kind?.["edf-patient-nonascii"]).toBe(1);
    expect(record.findings_by_kind?.["json-identifier-key"]).toBe(2);
    expect(record.findings_by_kind?.["participants-identifier-column"]).toBe(1);
    expect(record.findings_by_kind?.["path-subject-label"]).toBeGreaterThanOrEqual(1);
    expect(record.findings_by_kind?.["local-user-path"]).toBe(1);
    // Only matched keys are named, never an ancestor key.
    expect(record.finding_fields).toContain("json-identifier-key:patientname");
    expect(record.finding_fields).toContain("json-identifier-key:mrn");

    const written = everythingWritten(out);
    expect(readdirSync(out).sort()).toEqual(["_summary.json", "nm000001.json"]);
    for (const secret of SECRETS) {
      expect(written.toLowerCase()).not.toContain(secret.toLowerCase());
      expect(result.stderr.toLowerCase()).not.toContain(secret.toLowerCase());
      expect(result.stdout.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    // The raw bytes and the latin-1 reading of the UTF-8 name are absent too.
    expect(written).not.toContain("\u00c3\u00a9");
    expect(written).not.toContain("\u00e9");
  }, 30_000);

  test("the clean twin (same files, placeholders for the values) is clean and writes nothing flagged", async () => {
    const w = newWorld();
    w.add("nm000001", privacyDataset(false));
    const out = join(tempDir(), "out");
    const result = await runCli(["--out", out], w);
    expect(result.code).toBe(0);
    const record = readJson(join(out, "nm000001.json")) as unknown as DatasetRecord;
    expect(record.findings_by_kind).toEqual({});
    expect(record.status).toBe("clean");
    expect(record.finding_fields).toEqual([]);
  }, 30_000);

  test("a failure class is the only thing written about a failed read: no URL, path or message", async () => {
    const w = newWorld();
    w.add("nm000001", {
      "sub-Hollowbrook/eeg/sub-Hollowbrook_task-rest_eeg.edf": { bytes: CLEAN, status: 403 },
    });
    const out = join(tempDir(), "out");
    const result = await runCli(["--out", out], w);
    expect(result.code).toBe(0);
    const written = everythingWritten(out);
    expect(written).toContain("edf/http-403");
    expect(written.toLowerCase()).not.toContain("hollowbrook");
    expect(written).not.toContain("127.0.0.1");
    expect(result.stderr.toLowerCase()).not.toContain("hollowbrook");
  }, 30_000);
});

// ---------------------------------------------------------------------------------------
// Retry-After and the failure streak
// ---------------------------------------------------------------------------------------

/** Records every sleep and advances a virtual clock by it, as a real sleep advances a real one. */
const sleepRecorder = () => {
  const calls: number[] = [];
  let clock = Date.now();
  return {
    calls,
    now: () => clock,
    sleep: async (ms: number) => {
      calls.push(ms);
      clock += ms;
    },
  };
};

describe("parseRetryAfter", () => {
  test("delta-seconds, an HTTP date, and nothing usable", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter(" 12 ")).toBe(12_000);
    expect(parseRetryAfter("0")).toBe(0);
    const now = 1_700_000_000_000;
    expect(parseRetryAfter(new Date(now + 7000).toUTCString(), now)).toBe(7000);
    expect(parseRetryAfter(new Date(now - 7000).toUTCString(), now)).toBe(0);
    for (const bad of [null, undefined, "", "soon"]) expect(parseRetryAfter(bad)).toBeUndefined();
  });
});

describe("withRetry and Retry-After", () => {
  const throwing = (retryAfterMs: number) => async () => {
    throw new ReadFailure("http-429", { status: 429, retryable: true, retryAfterMs });
  };
  test("waits the longer of the backoff and the Retry-After", async () => {
    const short = sleepRecorder();
    await withRetry(throwing(5000), { tries: 2, baseMs: 10, sleep: short.sleep }).catch(() => {});
    expect(short.calls).toEqual([5000]);
    const long = sleepRecorder();
    await withRetry(throwing(5000), { tries: 2, baseMs: 10_000, sleep: long.sleep }).catch(
      () => {},
    );
    expect(long.calls).toEqual([10_000]);
  });
  test("a Retry-After at the cap is waited out; above it the request is not retried", async () => {
    const at = sleepRecorder();
    await withRetry(throwing(30_000), { tries: 2, sleep: at.sleep }).catch(() => {});
    expect(at.calls).toEqual([30_000]);
    const over = sleepRecorder();
    let attempts = 0;
    await withRetry(
      async () => {
        attempts++;
        return throwing(30_001)();
      },
      { tries: 3, sleep: over.sleep },
    ).catch(() => {});
    expect(attempts).toBe(1);
    expect(over.calls).toEqual([]);
  });
});

describe("Retry-After at the HTTP stand-in", () => {
  const throttled = (retryAfter?: string) => ({
    bytes: CLEAN,
    failFirst: { n: 1, status: 429 },
    ...(retryAfter ? { headers: { "Retry-After": retryAfter } } : {}),
  });

  test("a 429 with Retry-After 5 waits 5 s, then the read succeeds; without the header it backs off", async () => {
    const asked = sleepRecorder();
    const a = await scanFiles(
      { [EDF]: throttled("5") },
      { sleep: asked.sleep, now: asked.now, retryBaseMs: 100 },
    );
    expect(a.record.status).toBe("clean");
    expect(asked.calls).toEqual([5000]);
    const plain = sleepRecorder();
    const b = await scanFiles(
      { [EDF]: throttled() },
      { sleep: plain.sleep, now: plain.now, retryBaseMs: 100 },
    );
    expect(b.record.status).toBe("clean");
    expect(plain.calls).toEqual([100]);
  });

  test("30 s is waited out; 31 s stops the run after one request, with no wait", async () => {
    const at = sleepRecorder();
    const waited = await scanFiles({ [EDF]: throttled("30") }, { sleep: at.sleep, now: at.now });
    expect(waited.record.status).toBe("clean");
    expect(at.calls).toEqual([30_000]);

    const over = sleepRecorder();
    const w = newWorld();
    w.add(ID, { [EDF]: throttled("31") });
    const error = await scanDataset(w.ctx({ sleep: over.sleep }), ID, w.versionOf(ID)).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(RunAborted);
    expect((error as Error).message).toContain("asked to wait 31 s");
    expect(w.hits(w.pathOf(ID, EDF))).toBe(1);
    expect(over.calls).toEqual([]);
  });

  test("maintenance mode (503 with Retry-After 3600) on the manifest stops the run at once", async () => {
    const w = newWorld();
    w.add(
      ID,
      { [EDF]: CLEAN },
      { manifestStatus: 503, manifestHeaders: { "Retry-After": "3600" } },
    );
    const { calls, sleep } = sleepRecorder();
    const error = await scanDataset(w.ctx({ sleep }), ID, w.versionOf(ID)).catch((e) => e);
    expect(error).toBeInstanceOf(RunAborted);
    expect((error as Error).message).toContain("3600 s");
    expect(w.hits(w.manifestPath(ID))).toBe(1);
    expect(calls).toEqual([]);
  });

  test("a Retry-After on a 404 is not a wait: only 429 and 5xx carry one", async () => {
    const { record } = await scanFiles({
      [EDF]: { bytes: CLEAN, status: 404, headers: { "Retry-After": "3600" } },
    });
    expect(record.status).toBe("unchecked");
    expect(record.read_failures).toEqual({ "edf/http-404": 1 });
  });

  test("once one request class has stopped, the other stops too", async () => {
    const w = newWorld();
    w.add(ID, { [EDF]: throttled("3600") });
    const ctx = w.ctx();
    await scanDataset(ctx, ID, w.versionOf(ID)).catch(() => {});
    expect(() => ctx.breakers.direct.check()).toThrow(RunAborted);
    expect(() => ctx.breakers.worker.check()).toThrow(RunAborted);
  });
});

describe("a streak of failures stops the run", () => {
  const many = (n: number, file: (i: number) => FileDef): Record<string, FileDef> =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [edfPath(i + 1), file(i + 1)]));
  const edfRequests = (w: StandIn) => w.requests.filter((r) => r.path.endsWith("_eeg.edf")).length;

  const cases: [number, "worker" | "s3", string][] = [
    [503, "worker", "the Worker"],
    [429, "s3", "direct reads"],
  ];
  for (const [status, via, who] of cases) {
    test(`25 consecutive ${status} from ${who} stop the run after exactly 25 requests`, async () => {
      const w = newWorld();
      w.add(
        ID,
        many(40, () => ({ bytes: CLEAN, status, via })),
      );
      const error = await scanDataset(w.ctx({ fileConcurrency: 1 }), ID, w.versionOf(ID)).catch(
        (e) => e,
      );
      expect(error).toBeInstanceOf(RunAborted);
      expect((error as Error).message).toContain("25 consecutive");
      expect((error as Error).message).toContain(who);
      expect(edfRequests(w)).toBe(25);
    });
  }

  test("a success every eighth file keeps the streak under 25: the run completes (twin)", async () => {
    const { record } = await scanFiles(
      many(40, (i) => (i % 8 === 0 ? CLEAN : { bytes: CLEAN, status: 503 })),
      { fileConcurrency: 1 },
    );
    expect(record.status).toBe("unchecked");
    expect(record.read_failures).toEqual({ "edf/http-503": 35 });
  });

  test("an answer between failures ends the streak: 42 failing attempts around one 404 complete (twin)", async () => {
    // Seven files of three attempts each, a 404, seven more: 21 + 21, never 25 in a row.
    const { record } = await scanFiles(
      many(15, (i) => ({ bytes: CLEAN, status: i === 8 ? 404 : 503 })),
      { fileConcurrency: 1 },
    );
    expect(record.read_failures).toEqual({ "edf/http-503": 14, "edf/http-404": 1 });
  });

  test("a stopped run refuses every later request, of either class, without sending it", async () => {
    const w = newWorld();
    w.add("nm000001", {
      [EDF]: { bytes: CLEAN, failFirst: { n: 1, status: 503 }, headers: { "Retry-After": "3600" } },
    });
    w.add("nm000002", { [EDF]: CLEAN });
    const ctx = w.ctx();
    const first = await scanDataset(ctx, "nm000001", "v1.0.0").catch((e) => e);
    expect(first).toBeInstanceOf(RunAborted);
    // A healthy dataset is not even asked for its manifest.
    const second = await scanDataset(ctx, "nm000002", "v1.0.0").catch((e) => e);
    expect(second).toBeInstanceOf(RunAborted);
    expect(w.hits(w.manifestPath("nm000002"))).toBe(0);
    // Twin: a fresh context, same healthy dataset, scans normally.
    const fresh = await scanDataset(w.ctx(), "nm000002", "v1.0.0");
    expect(fresh.status).toBe("clean");
  });

  test("answers that are not 429 or 5xx never build a streak: sixty 404s complete (twin)", async () => {
    const { record } = await scanFiles(
      many(60, () => ({ bytes: CLEAN, status: 404 })),
      {
        fileConcurrency: 1,
      },
    );
    expect(record.read_failures).toEqual({ "edf/http-404": 60 });
  });

  test("dropped connections count too", async () => {
    const dropped = dropServer();
    const w = newWorld();
    w.add(
      ID,
      {},
      {
        manifestBody: Array.from({ length: 30 }, (_, i) => ({
          path: edfPath(i + 1),
          size: 256,
          url: dropped.url,
        })),
      },
    );
    const error = await scanDataset(w.ctx({ fileConcurrency: 1 }), ID, w.versionOf(ID)).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(RunAborted);
    expect((error as Error).message).toContain("network");
    expect(dropped.requests()).toBe(25);
  });

  test("runFleet: finished datasets keep their files, no later dataset starts, no summary is written", async () => {
    const w = newWorld();
    for (let i = 1; i <= 6; i++) w.add(`nm00000${i}`, { [EDF]: CLEAN }, { manifestStatus: 503 });
    const out = tempDir();
    const options = { outDir: out, force: false, datasetConcurrency: 1 };
    const error = await runFleet(w.ctx({ abortStreak: 5 }), options).catch((e) => e);
    expect(error).toBeInstanceOf(RunAborted);
    // Datasets 1 and 2 used four attempts; the fifth, in dataset 3, tripped the run.
    expect(readdirSync(out).sort()).toEqual(["nm000001.json", "nm000002.json"]);
    expect(readJson(join(out, "nm000001.json")).incomplete_reasons).toEqual(["manifest:http-503"]);
    expect(w.hits(w.manifestPath("nm000003"))).toBe(1);
    for (const id of ["nm000004", "nm000005", "nm000006"]) {
      expect(w.hits(w.manifestPath(id))).toBe(0);
    }
    // Twin: the same failures under a higher bound are results, and a summary is written.
    const quiet = tempDir();
    const summary = await runFleet(w.ctx({ abortStreak: 100 }), { ...options, outDir: quiet });
    expect(summary.by_status.unchecked?.count).toBe(6);
    expect(existsSync(join(quiet, "_summary.json"))).toBe(true);
  });

  test("the CLI exits 3 with a message, keeps finished files and writes no summary", async () => {
    const w = newWorld();
    w.add("nm000001", { [EDF]: CLEAN }, { manifestStatus: 503 });
    w.add("nm000002", { [EDF]: CLEAN }, { manifestStatus: 503 });
    const out = join(tempDir(), "out");
    const stopped = await runCli(["--out", out, "--datasets", "1", "--abort-streak", "3"], w);
    expect(stopped.code).toBe(3);
    expect(stopped.stderr).toContain("aborting:");
    expect(stopped.stderr).toContain("3 consecutive");
    expect(readdirSync(out)).toEqual(["nm000001.json"]);
    // Twin: a streak bound of 5 is not reached, so the same failures are plain results.
    const calm = join(tempDir(), "out");
    const done = await runCli(["--out", calm, "--datasets", "1", "--abort-streak", "5"], w);
    expect(done.code).toBe(0);
    expect(done.stderr).toContain("unchecked=2");
    expect(existsSync(join(calm, "_summary.json"))).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------
// The aws fallback, with the real CLI
// ---------------------------------------------------------------------------------------

describe("the aws fallback runs the real aws CLI against an S3 stand-in", () => {
  // `aws` is not installed everywhere; where it is missing these skip rather than pass, and
  // under NEMAR_REQUIRE_SCRUB_TOOLS=1 (the scrub-tools CI job) a missing `aws` is a failure.
  const awsTest = toolOrFail("aws", Bun.which("aws") !== null) ? test : test.skip;
  const doc = { files: { [EDF]: { key: "MD5E-s256--aa11.edf", size: 256 } } };

  /** Bun's spawn `env` REPLACES the environment: PATH and a private HOME are passed on purpose. */
  function awsEnv(w: StandIn): Record<string, string> {
    return {
      PATH: process.env.PATH ?? "",
      HOME: tempDir(),
      AWS_ACCESS_KEY_ID: "ASIAIOSFODNN7EXAMPLE",
      AWS_SECRET_ACCESS_KEY: "dummy-secret-key",
      AWS_SESSION_TOKEN: "dummy-session-token",
      AWS_DEFAULT_REGION: "us-east-2",
      AWS_ENDPOINT_URL_S3: w.base,
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_PAGER: "",
    };
  }
  const fail = async (w: StandIn, timeoutMs?: number) =>
    (await readVersionManifestViaAws(ID, "v1.0.0", { env: awsEnv(w), timeoutMs }).catch(
      (e) => e,
    )) as ReadFailure;

  awsTest(
    "an object that exists is read whole",
    async () => {
      const w = newWorld();
      w.add(ID, {}, { versionManifest: doc });
      const text = await readVersionManifestViaAws(ID, "v1.0.0", { env: awsEnv(w) });
      expect(JSON.parse(text)).toEqual(doc);
      expect(w.hits(`/nemar/${ID}/version/v1.0.0.json`)).toBeGreaterThanOrEqual(1);
    },
    30_000,
  );

  awsTest(
    "404 and 403 are failed reads classed by status, with nothing else in the class",
    async () => {
      const w = newWorld();
      w.add("nm000001", {}, { versionManifest: doc, awsStatus: 404 });
      w.add("nm000002", {}, { versionManifest: doc, awsStatus: 403 });
      const env = awsEnv(w);
      const missing = await readVersionManifestViaAws("nm000001", "v1.0.0", { env }).catch(
        (e) => e,
      );
      const denied = await readVersionManifestViaAws("nm000002", "v1.0.0", { env }).catch((e) => e);
      expect(missing).toBeInstanceOf(ReadFailure);
      expect((missing as ReadFailure).cls).toBe("aws/http-404");
      expect((denied as ReadFailure).cls).toBe("aws/http-403");
      for (const error of [missing, denied]) {
        expect((error as Error).message).not.toContain("nm00000");
        expect((error as Error).message).not.toContain("v1.0.0");
        expect((error as Error).message).not.toContain("nemar");
      }
    },
    30_000,
  );

  awsTest(
    "a server that never answers is killed at the timeout and the connection closes",
    async () => {
      const w = newWorld();
      w.add(ID, {}, { versionManifest: doc, awsStatus: "hang" });
      const t0 = performance.now();
      const error = await fail(w, 1500);
      const elapsed = performance.now() - t0;
      expect(error).toBeInstanceOf(ReadFailure);
      expect(error.cls).toBe("aws/timeout");
      expect(elapsed).toBeGreaterThanOrEqual(1400);
      expect(elapsed).toBeLessThan(10_000);
      // The subprocess is gone, not left holding the socket.
      for (let i = 0; i < 40 && w.hungClosed === 0; i++) await Bun.sleep(50);
      expect(w.hungClosed).toBe(1);
    },
    30_000,
  );

  awsTest(
    "through scanDataset: a 413 manifest is read from the version manifest by the real CLI",
    async () => {
      const w = newWorld();
      w.add(ID, {}, { manifestStatus: 413, versionManifest: doc });
      w.raw(`/data/${ID}/v1.0.0/${encodePath(EDF)}`, { bytes: CLEAN });
      const ctx = w.ctx({ readVersionManifest: undefined, awsEnv: awsEnv(w) });
      const record = await scanDataset(ctx, ID, w.versionOf(ID));
      expect(record.manifest_source).toBe("s3-version-manifest");
      expect(record.status).toBe("clean");
      expect(record.files?.header_read).toBe(1);
    },
    30_000,
  );

  awsTest(
    "through scanDataset: a failing or hung aws is a classed reason, never text or a value",
    async () => {
      const w = newWorld();
      w.add("nm000001", {}, { manifestStatus: 413, versionManifest: doc, awsStatus: 403 });
      w.add("nm000002", {}, { manifestStatus: 413, versionManifest: doc, awsStatus: "hang" });
      const ctx = w.ctx({ readVersionManifest: undefined, awsEnv: awsEnv(w), awsTimeoutMs: 1500 });
      const denied = await scanDataset(ctx, "nm000001", "v1.0.0");
      expect(denied.incomplete_reasons).toEqual([
        "manifest:too-large(s3:aws/http-403,tree:http-404)",
      ]);
      const hung = await scanDataset(ctx, "nm000002", "v1.0.0");
      expect(hung.incomplete_reasons).toEqual(["manifest:too-large(s3:aws/timeout,tree:http-404)"]);
      expect(denied.status).toBe("unchecked");
    },
    30_000,
  );

  test("no aws binary on PATH is aws/unavailable (needs no aws)", async () => {
    const w = newWorld();
    const error = await readVersionManifestViaAws(ID, "v1.0.0", { env: { PATH: "" } }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(ReadFailure);
    expect((error as ReadFailure).cls).toBe("aws/unavailable");
    expect(w.requests).toHaveLength(0);
  });
});

describe("a Retry-After pauses the request class, and a stale summary never survives", () => {
  test("after one 429 with Retry-After, the NEXT request of the same class also waits it out", async () => {
    const asked: number[] = [];
    const sleep = async (ms: number) => void asked.push(ms);
    const files: Record<string, FileDef> = {
      [edfPath(1)]: {
        bytes: CLEAN,
        failFirst: { n: 1, status: 429 },
        headers: { "Retry-After": "2" },
        via: "worker",
      },
      [edfPath(2)]: { bytes: CLEAN, via: "worker" },
      [edfPath(3)]: { bytes: CLEAN, via: "worker" },
    };
    const { record } = await scanFiles(files, { sleep, fileConcurrency: 1, retryBaseMs: 10 });
    expect(record.read_failures ?? {}).toEqual({});
    // The retry of file 1 waits its own 2000 ms; files 2 and 3 each wait what is left of the pause.
    const long = asked.filter((ms) => ms > 1000);
    expect(long.length).toBeGreaterThanOrEqual(3);
  });

  test("with no Retry-After nothing but the retry backoff sleeps (twin)", async () => {
    const asked: number[] = [];
    const sleep = async (ms: number) => void asked.push(ms);
    const files: Record<string, FileDef> = {
      [edfPath(1)]: { bytes: CLEAN, failFirst: { n: 1, status: 429 }, via: "worker" },
      [edfPath(2)]: { bytes: CLEAN, via: "worker" },
    };
    await scanFiles(files, { sleep, fileConcurrency: 1, retryBaseMs: 10 });
    expect(asked.filter((ms) => ms > 1000)).toEqual([]);
  });

  test("an aborted run removes the earlier run's summary, so it can never read as current", async () => {
    const w = newWorld();
    w.add("nm000001", {
      [EDF]: { bytes: CLEAN, failFirst: { n: 1, status: 503 }, headers: { "Retry-After": "3600" } },
    });
    const out = tempDir();
    writeFileSync(join(out, "_summary.json"), JSON.stringify({ stale: true }));
    await expect(
      runFleet(w.ctx(), { outDir: out, force: false, datasetConcurrency: 1 }),
    ).rejects.toBeInstanceOf(RunAborted);
    expect(existsSync(join(out, "_summary.json"))).toBe(false);
  });
});

describe("the summary and the pause, edge cases", () => {
  test("a mistyped --only leaves a good earlier summary alone; a run that starts removes it", async () => {
    const w = newWorld();
    w.add("nm000001", { [EDF]: CLEAN });
    const out = tempDir();
    writeFileSync(join(out, "_summary.json"), JSON.stringify({ earlier: true }));
    await expect(
      runFleet(w.ctx(), { outDir: out, force: false, datasetConcurrency: 1, only: ["nm999999"] }),
    ).rejects.toThrow("not in the public catalog");
    expect(JSON.parse(readFileSync(join(out, "_summary.json"), "utf8"))).toEqual({ earlier: true });
    await runFleet(w.ctx(), {
      outDir: out,
      force: false,
      datasetConcurrency: 1,
      only: ["nm000001"],
    });
    expect(JSON.parse(readFileSync(join(out, "_summary.json"), "utf8")).datasets).toBe(1);
  });

  test("a breaker that trips during a pause stops the request before it is sent", async () => {
    const w = newWorld();
    w.add(ID, {
      [edfPath(1)]: {
        bytes: CLEAN,
        failFirst: { n: 1, status: 429 },
        headers: { "Retry-After": "2" },
        via: "worker",
      },
      [edfPath(2)]: { bytes: CLEAN, via: "worker" },
    });
    let ctxRef: ReturnType<typeof w.ctx> | null = null;
    let first = true;
    const sleep = async () => {
      // While the second request is paused, something else trips the run.
      if (!first) {
        try {
          ctxRef?.breakers.worker.observe(
            new ReadFailure("http-503", { status: 503, retryable: true, retryAfterMs: 3_600_000 }),
          );
        } catch {
          // The trip is recorded in the breaker; the request after the pause must see it.
        }
      }
      first = false;
    };
    ctxRef = w.ctx({ sleep, fileConcurrency: 1, retryBaseMs: 1 });
    const error = await scanDataset(ctxRef, ID, w.versionOf(ID)).catch((e) => e);
    expect(error).toBeInstanceOf(RunAborted);
    // The first request was told to wait and the run tripped during the wait: its retry never goes out.
    const sent = w.requests.filter((r) => r.path.endsWith("_eeg.edf")).length;
    expect(sent).toBe(1);
  });

  test("a catalog that cannot be read removes the earlier summary", async () => {
    const w = newWorld();
    w.add("nm000001", { [EDF]: CLEAN });
    const out = tempDir();
    writeFileSync(join(out, "_summary.json"), JSON.stringify({ earlier: true }));
    w.catalogStatus = 500;
    await expect(
      runFleet(w.ctx({ retryBaseMs: 0 }), { outDir: out, force: false, datasetConcurrency: 1 }),
    ).rejects.toThrow();
    expect(existsSync(join(out, "_summary.json"))).toBe(false);
  });
});

/**
 * The publication screen reads a metadata-only clone through `readEntryHead`: git blobs and
 * presigned S3 objects, never a URL. The URLs below point at nothing, so a read that bypassed the
 * hook would fail and the test would say so.
 */
describe("reading through a caller-supplied reader, and a clone source", () => {
  const header = CLEAN;
  const ctxWith = (read: NonNullable<FleetContext["readEntryHead"]>): FleetContext =>
    createContext({ readEntryHead: read, retryBaseMs: 0, fileConcurrency: 4 });
  // A URL nothing listens on: if the hook is bypassed, the read fails and the test says so.
  const never = (path: string, extra: Record<string, unknown> = {}) => ({
    path,
    size: 300,
    url: "http://127.0.0.1:9/never",
    ...extra,
  });

  test("an entry is read through the hook, not through its URL", async () => {
    const calls: string[] = [];
    const ctx = ctxWith(async (entry) => {
      calls.push(entry.path);
      return header;
    });
    const record = await scanDatasetFromManifest(
      ctx,
      ID,
      null,
      [never("sub-01/eeg/sub-01_task-rest_eeg.edf")],
      "clone",
    );
    expect(calls).toEqual(["sub-01/eeg/sub-01_task-rest_eeg.edf"]);
    expect(record.files?.header_read).toBe(1);
    expect(record.status).toBe("clean");
  });

  test("a hook failure is a counted, unread file and never a clean one", async () => {
    const ctx = ctxWith(async () => {
      throw new ReadFailure("blob-missing");
    });
    const record = await scanDatasetFromManifest(
      ctx,
      ID,
      null,
      [never("a.edf"), never("b.edf")],
      "clone",
    );
    expect(record.status).toBe("unchecked");
    expect(record.read_failures).toEqual({ "edf/blob-missing": 2 });
    expect(record.incomplete_reasons).toContain("edf-headers-unread");
  });

  test("a clone reads every candidate; a manifest source samples the same list", async () => {
    const entries = Array.from({ length: 350 }, (_, i) =>
      never(`sourcedata/s${String(i).padStart(3, "0")}.json`, { size: 2 }),
    );
    const ctx = ctxWith(async () => new TextEncoder().encode("{}"));
    const cloned = await scanDatasetFromManifest(ctx, ID, null, entries, "clone");
    expect(cloned.sampling?.json_files).toEqual({
      candidates: 350,
      oversize: 0,
      selected: 350,
      scanned: 350,
    });
    expect(cloned.incomplete_reasons).not.toContain("json-sampled");
    const sampled = await scanDatasetFromManifest(ctx, ID, null, entries, "manifest.json");
    expect(sampled.sampling?.json_files.scanned).toBe(300);
    expect(sampled.incomplete_reasons).toContain("json-sampled");
  });

  test("scans tables are all read in a clone, one in a manifest source", async () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      never(`sub-0${i}/sub-0${i}_scans.tsv`, { size: 20 }),
    );
    const ctx = ctxWith(async () => new TextEncoder().encode("filename\tacq_time\n"));
    expect(
      (await scanDatasetFromManifest(ctx, ID, null, entries, "clone")).sampling?.scans_tables
        .scanned,
    ).toBe(5);
    expect(
      (await scanDatasetFromManifest(ctx, ID, null, entries, "manifest.json")).sampling
        ?.scans_tables.scanned,
    ).toBe(1);
  });

  test("an entry flagged edf is an EDF whatever its path", async () => {
    const ctx = ctxWith(async () => NAMED);
    const record = await scanDatasetFromManifest(
      ctx,
      ID,
      null,
      [never("data/recording.dat", { edf: true }), never("data/other.dat")],
      "clone",
    );
    expect(record.files?.edf_bdf).toBe(1);
    expect(record.edf_bdf_files_flagged).toBe(1);
  });

  test("a superseded recording that is gone (404) is counted apart; any other failure is unread", async () => {
    const ctx = ctxWith(async (entry) => {
      if (entry.path.startsWith("gone")) throw new ReadFailure("http-404", { status: 404 });
      if (entry.path.startsWith("denied")) throw new ReadFailure("http-403", { status: 403 });
      return header;
    });
    const current = [never("sub-01/eeg/sub-01_task-rest_eeg.edf")];
    const gone = { ...never("gone/old.edf"), edf: true };
    const denied = { ...never("denied/old.edf"), edf: true };

    const absent = await scanDatasetFromManifest(ctx, ID, null, current, "clone", {
      supersededEdf: [gone],
    });
    expect(absent.status).toBe("clean");
    expect(absent.incomplete).toBe(false);
    expect(absent.files).toMatchObject({ edf_bdf: 1, header_read: 1, header_read_failed: 0 });
    expect(absent.read_failures).toEqual({ "edf/superseded-absent": 1 });

    const refused = await scanDatasetFromManifest(ctx, ID, null, current, "clone", {
      supersededEdf: [denied],
    });
    expect(refused.status).toBe("unchecked");
    expect(refused.files).toMatchObject({ edf_bdf: 2, header_read: 1, header_read_failed: 1 });
    expect(refused.read_failures).toEqual({ "edf/http-403": 1 });

    // The same 404 on a CURRENT recording is data that should be there and is not.
    const missing = await scanDatasetFromManifest(
      ctx,
      ID,
      null,
      [never("gone/current.edf")],
      "clone",
      {},
    );
    expect(missing.status).toBe("unchecked");
    expect(missing.read_failures).toEqual({ "edf/http-404": 1 });
  });

  test("extra paths get the path rules only; extra reasons make the scan incomplete", async () => {
    const ctx = ctxWith(async () => header);
    const entries = [never("sub-01/eeg/sub-01_task-rest_eeg.edf")];
    const plain = await scanDatasetFromManifest(ctx, ID, null, entries, "clone");
    expect(plain.status).toBe("clean");
    const withHistory = await scanDatasetFromManifest(ctx, ID, null, entries, "clone", {
      extraPaths: ["old/photo.jpg"],
    });
    expect(withHistory.findings_by_kind?.["image-or-document-file"]).toBe(1);
    expect(withHistory.files?.total).toBe(1);
    const unread = await scanDatasetFromManifest(ctx, ID, null, entries, "clone", {
      extraIncompleteReasons: ["history-unread"],
    });
    expect(unread.status).toBe("unchecked");
    expect(unread.incomplete_reasons).toEqual(["history-unread"]);
  });
});
