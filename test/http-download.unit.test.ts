/**
 * The plain-HTTP download path: selection, and the worker pool that fetches it.
 *
 * Offline. The pool is exercised against a local `Bun.serve` origin rather
 * than a stubbed `fetch`, so what is under test is the real request, the real
 * stream-to-disk, and the real resume decision.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { MAX_MANIFEST_JSON_ENTRIES, dataRoutes } from "../backend/src/routes/data";
import type { Bindings } from "../backend/src/types/bindings";
import { freshDb, realD1 } from "../backend/test/helpers/d1";
import { largeManifestEntryCount, largeManifestText } from "../backend/test/helpers/large-manifest";
import {
  type S3ManifestStandin,
  startS3ManifestStandin,
} from "../backend/test/helpers/s3-manifest-standin";
import {
  PUBLISHED_FILE_MISSING_ERROR,
  dataPlaneManifestSchema,
} from "../shared/contract/data-plane";
import { buildBidsFilterArgs, matchesBidsFilter } from "../src/lib/bids-filter";
import {
  type DataPlaneManifestEntry,
  DataPlaneUnavailableError,
  downloadEntries,
  getDocument,
  inspectOutputDir,
  isMetadataEntry,
  selectEntries,
  writeSnapshotStamp,
} from "../src/lib/http-download";

function entry(path: string, over: Partial<DataPlaneManifestEntry> = {}): DataPlaneManifestEntry {
  return {
    path,
    size: 4,
    checksum_algorithm: path.endsWith(".set") ? "SHA256E" : "git",
    bytes_url: `http://example.invalid/${path}`,
    ...over,
  };
}

describe("selectEntries", () => {
  const manifest = [
    entry("dataset_description.json"),
    entry("participants.tsv"),
    entry("sub-01/eeg/sub-01_task-rest_eeg.json"),
    entry("sub-01/eeg/sub-01_task-rest_eeg.set"),
    entry("sub-02/eeg/sub-02_task-rest_eeg.set"),
    entry("sub-02/eeg/sub-02_task-nback_eeg.set"),
    entry("derivatives/prep/sub-01/sub-01_desc-clean_eeg.set"),
    entry("stimuli/tone.wav", { checksum_algorithm: "SHA256E" }),
  ];

  test("a subject filter keeps that subject's data", () => {
    const selected = selectEntries(manifest, buildBidsFilterArgs({ subjects: "sub-01" })).map(
      (e) => e.path,
    );
    expect(selected).toContain("sub-01/eeg/sub-01_task-rest_eeg.set");
    expect(selected).not.toContain("sub-02/eeg/sub-02_task-rest_eeg.set");
  });

  test("metadata survives every filter", () => {
    // A subject-scoped download that dropped dataset_description.json would
    // not be a readable BIDS dataset. The git-annex path gets this for free
    // (those files ride along in the clone); here it is explicit.
    const selected = selectEntries(manifest, buildBidsFilterArgs({ subjects: "sub-01" })).map(
      (e) => e.path,
    );
    expect(selected).toContain("dataset_description.json");
    expect(selected).toContain("participants.tsv");
  });

  test("--no-data keeps metadata only", () => {
    const selected = selectEntries(manifest, buildBidsFilterArgs({}), { metadataOnly: true });
    expect(selected.every(isMetadataEntry)).toBe(true);
    expect(selected.map((e) => e.path)).toContain("dataset_description.json");
    expect(selected.map((e) => e.path)).not.toContain("sub-01/eeg/sub-01_task-rest_eeg.set");
  });

  test("stimuli and derivatives are skipped by default", () => {
    const filter = buildBidsFilterArgs({ excludeStimuli: true, excludeDerivatives: true });
    const selected = selectEntries(manifest, filter).map((e) => e.path);
    expect(selected).not.toContain("stimuli/tone.wav");
    expect(selected).not.toContain("derivatives/prep/sub-01/sub-01_desc-clean_eeg.set");
  });

  test("a task filter narrows within a subject", () => {
    const selected = selectEntries(manifest, buildBidsFilterArgs({ tasks: "nback" })).map(
      (e) => e.path,
    );
    expect(selected).toContain("sub-02/eeg/sub-02_task-nback_eeg.set");
    expect(selected).not.toContain("sub-02/eeg/sub-02_task-rest_eeg.set");
  });
});

describe("matchesBidsFilter tracks the git-annex args", () => {
  // The point of deriving both from one builder is that a user gets the same
  // files whether or not git-annex happened to be installed. These cases pin
  // the correspondence: every glob the builder emits as an --include has to be
  // one the matcher actually understands.
  const cases: { opts: Parameters<typeof buildBidsFilterArgs>[0]; hit: string; miss: string }[] = [
    { opts: { subjects: "01" }, hit: "sub-01/eeg/x.set", miss: "sub-02/eeg/x.set" },
    {
      opts: { sessions: "pre" },
      hit: "sub-01/ses-pre/eeg/x.set",
      miss: "sub-01/ses-post/eeg/x.set",
    },
    {
      opts: { tasks: "rest" },
      hit: "sub-01/eeg/sub-01_task-rest_eeg.set",
      miss: "sub-01/eeg/sub-01_task-odd_eeg.set",
    },
    {
      opts: { runs: "1" },
      hit: "sub-01/eeg/sub-01_run-1_eeg.set",
      miss: "sub-01/eeg/sub-01_run-2_eeg.set",
    },
    { opts: { datatypes: "eeg" }, hit: "sub-01/eeg/x.set", miss: "sub-01/meg/x.fif" },
    { opts: { include: "sub-03/**" }, hit: "sub-03/eeg/x.set", miss: "sub-01/eeg/x.set" },
    { opts: { exclude: "sourcedata/**" }, hit: "sub-01/eeg/x.set", miss: "sourcedata/raw.bin" },
  ];

  for (const { opts, hit, miss } of cases) {
    test(JSON.stringify(opts), () => {
      const filter = buildBidsFilterArgs(opts);
      // The git-annex path is unchanged: the args are still emitted.
      expect(filter.args.length).toBeGreaterThan(0);
      expect(matchesBidsFilter(hit, filter)).toBe(true);
      expect(matchesBidsFilter(miss, filter)).toBe(false);
    });
  }

  test("an empty filter admits everything", () => {
    const filter = buildBidsFilterArgs({});
    expect(filter.args).toEqual([]);
    expect(matchesBidsFilter("sub-01/eeg/x.set", filter)).toBe(true);
  });

  test("a run filter expands bare and zero-padded forms alike", () => {
    const filter = buildBidsFilterArgs({ runs: "1" });
    expect(matchesBidsFilter("sub-01/eeg/sub-01_run-01_eeg.set", filter)).toBe(true);
  });
});

describe("downloadEntries", () => {
  let server: Server;
  let base: string;
  let workDir: string;
  const served: Record<string, string> = {
    "dataset_description.json": '{"Name":"x"}',
    "sub-01/eeg/a.set": "AAAAAAAA",
    "gone.tsv": "",
  };

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = decodeURIComponent(new URL(req.url).pathname.slice(1));
        if (path === "gone.tsv") return new Response("nope", { status: 404 });
        const body = served[path];
        if (body === undefined) return new Response("nope", { status: 404 });
        return new Response(body);
      },
    });
    base = `http://localhost:${server.port}`;
    workDir = mkdtempSync(join(tmpdir(), "nemar-http-dl-"));
  });

  afterAll(() => {
    server.stop(true);
    rmSync(workDir, { recursive: true, force: true });
  });

  function remote(path: string): DataPlaneManifestEntry {
    return {
      path,
      size: served[path]?.length ?? 0,
      checksum_algorithm: "git",
      bytes_url: `${base}/${path}`,
    };
  }

  test("writes the tree and reports bytes", async () => {
    const out = join(workDir, "ok");
    const result = await downloadEntries(
      [remote("dataset_description.json"), remote("sub-01/eeg/a.set")],
      out,
    );
    expect(result.errors).toEqual([]);
    expect(result.filesDownloaded).toBe(2);
    expect(result.bytesDownloaded).toBe(20);
    expect(readFileSync(join(out, "dataset_description.json"), "utf8")).toBe('{"Name":"x"}');
    expect(readFileSync(join(out, "sub-01/eeg/a.set"), "utf8")).toBe("AAAAAAAA");
  });

  test("a file already present at its declared size is skipped, not refetched", async () => {
    const out = join(workDir, "resume");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "dataset_description.json"), '{"Name":"x"}');
    const before = statSync(join(out, "dataset_description.json")).mtimeMs;

    const result = await downloadEntries([remote("dataset_description.json")], out);
    expect(result.filesSkipped).toBe(1);
    expect(result.filesDownloaded).toBe(0);
    expect(statSync(join(out, "dataset_description.json")).mtimeMs).toBe(before);
  });

  test("a file present at the WRONG size is refetched", async () => {
    // The half-written file an interrupted transfer leaves behind. Skipping it
    // would quietly hand back a truncated dataset.
    const out = join(workDir, "truncated");
    mkdirSync(join(out, "sub-01/eeg"), { recursive: true });
    writeFileSync(join(out, "sub-01/eeg/a.set"), "AAA");

    const result = await downloadEntries([remote("sub-01/eeg/a.set")], out);
    expect(result.filesDownloaded).toBe(1);
    expect(readFileSync(join(out, "sub-01/eeg/a.set"), "utf8")).toBe("AAAAAAAA");
  });

  test("one failure does not abandon the rest", async () => {
    const out = join(workDir, "partial");
    const result = await downloadEntries(
      [remote("dataset_description.json"), remote("gone.tsv"), remote("sub-01/eeg/a.set")],
      out,
    );
    expect(result.filesDownloaded).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("gone.tsv");
    expect(result.errors[0]).toContain("404");
  });

  test("a body shorter than the declared size is an error, not a success", async () => {
    // Bun.write returns the real byte count and does not throw on a short body,
    // so without comparing it a captive portal's HTML login page lands as a
    // healthy file and the run reports success in green.
    const short = Bun.serve({ port: 0, fetch: () => new Response("tiny") });
    try {
      const out = join(workDir, "short");
      const result = await downloadEntries(
        [
          {
            path: "sub-01/eeg/a.set",
            size: 9999,
            bytes_url: `http://localhost:${short.port}/a`,
          },
        ],
        out,
        { attempts: 1 },
      );
      expect(result.filesDownloaded).toBe(0);
      expect(result.errors[0]).toContain("expected 9999 bytes, received 4");
      expect(result.hadInfrastructureFailure).toBe(true);
      // And it must not leave the short file behind looking like a real one.
      expect(existsSync(join(out, "sub-01/eeg/a.set"))).toBe(false);
    } finally {
      short.stop(true);
    }
  });

  test("a 429 is retried and can succeed", async () => {
    // Most manifest ENTRIES fetch from a host that throttles by address, so one
    // 429 without a retry turns a healthy link into thousands of failures.
    let hits = 0;
    const flaky = Bun.serve({
      port: 0,
      fetch: () => {
        hits++;
        return hits < 3 ? new Response("slow down", { status: 429 }) : new Response("0123456789");
      },
    });
    try {
      const result = await downloadEntries(
        [{ path: "f.bin", size: 10, bytes_url: `http://localhost:${flaky.port}/f` }],
        join(workDir, "retry"),
        { attempts: 3 },
      );
      expect(result.errors).toEqual([]);
      expect(result.filesDownloaded).toBe(1);
      expect(hits).toBe(3);
    } finally {
      flaky.stop(true);
    }
  });

  test("a 404 is not retried and is not an infrastructure failure", async () => {
    // ADR 0005: content genuinely absent is a reportable state, not a failed
    // run. Only that distinction keeps the exit code meaningful.
    const result = await downloadEntries([remote("gone.tsv")], join(workDir, "absent"), {
      attempts: 3,
    });
    expect(result.errors).toHaveLength(1);
    expect(result.hadInfrastructureFailure).toBe(false);
  });

  test("a file the manifest lists and storage lacks is reported, not a failed run (ADR 0005)", async () => {
    // The data plane answers 502 with a named error for a listed file whose object is gone (a
    // partial dataset served under ADR 0064). Retrying cannot help and exiting 1 would call a
    // reportable gap a transport fault.
    let hits = 0;
    const lost = Bun.serve({
      port: 0,
      fetch: () => {
        hits++;
        return Response.json(
          { error: PUBLISHED_FILE_MISSING_ERROR, dataset_id: "nm000001" },
          { status: 502 },
        );
      },
    });
    try {
      const result = await downloadEntries(
        [{ path: "f.bin", size: 10, bytes_url: `http://localhost:${lost.port}/f` }],
        join(workDir, "listed-missing"),
        { attempts: 3 },
      );
      expect(hits).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("f.bin");
      expect(result.hadInfrastructureFailure).toBe(false);
    } finally {
      lost.stop(true);
    }
  });

  test("a 502 with a different JSON error is still a transport fault", async () => {
    // The data plane's other 502s are JSON too ("Upstream content host unavailable"); only the
    // one named error means the archive does not have the file.
    let hits = 0;
    const other = Bun.serve({
      port: 0,
      fetch: () => {
        hits++;
        return Response.json({ error: "Upstream content host unavailable" }, { status: 502 });
      },
    });
    try {
      const result = await downloadEntries(
        [{ path: "f.bin", size: 10, bytes_url: `http://localhost:${other.port}/f` }],
        join(workDir, "json-502"),
        { attempts: 3 },
      );
      expect(hits).toBe(3);
      expect(result.hadInfrastructureFailure).toBe(true);
    } finally {
      other.stop(true);
    }
  });

  test("the named error without a JSON content type is not trusted", async () => {
    // An intermediary's page is not the data plane's answer, whatever words it contains.
    let hits = 0;
    const page = Bun.serve({
      port: 0,
      fetch: () => {
        hits++;
        return new Response(JSON.stringify({ error: PUBLISHED_FILE_MISSING_ERROR }), {
          status: 502,
          headers: { "Content-Type": "text/html" },
        });
      },
    });
    try {
      const result = await downloadEntries(
        [{ path: "f.bin", size: 10, bytes_url: `http://localhost:${page.port}/f` }],
        join(workDir, "html-502"),
        { attempts: 3 },
      );
      expect(hits).toBe(3);
      expect(result.hadInfrastructureFailure).toBe(true);
    } finally {
      page.stop(true);
    }
  });

  test("any other 502 is still a transport fault: retried, and a failed run", async () => {
    let hits = 0;
    const bad = Bun.serve({
      port: 0,
      fetch: () => {
        hits++;
        return new Response("Bad gateway", { status: 502 });
      },
    });
    try {
      const result = await downloadEntries(
        [{ path: "f.bin", size: 10, bytes_url: `http://localhost:${bad.port}/f` }],
        join(workDir, "bad-gateway"),
        { attempts: 3 },
      );
      expect(hits).toBe(3);
      expect(result.hadInfrastructureFailure).toBe(true);
    } finally {
      bad.stop(true);
    }
  });

  test("every error names the file it belongs to", async () => {
    const dead = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const port = dead.port;
    dead.stop(true);
    const result = await downloadEntries(
      [{ path: "sub-09/eeg/lost.set", size: 4, bytes_url: `http://localhost:${port}/lost` }],
      join(workDir, "labelled"),
      { attempts: 1 },
    );
    expect(result.errors[0]).toContain("sub-09/eeg/lost.set");
  });

  test("a path escaping the output directory is refused", async () => {
    // The manifest is server-supplied; a `..` in it must not write elsewhere.
    const out = join(workDir, "traversal");
    const result = await downloadEntries(
      [{ path: "../escaped.txt", size: 1, bytes_url: `${base}/dataset_description.json` }],
      out,
    );
    expect(result.filesDownloaded).toBe(0);
    expect(result.errors[0]).toContain("outside the output directory");
  });

  test("concurrency is bounded", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = Bun.serve({
      port: 0,
      async fetch() {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Bun.sleep(15);
        inFlight--;
        return new Response("0123456789");
      },
    });
    try {
      const files = Array.from({ length: 20 }, (_, i) => ({
        path: `f${i}.bin`,
        size: 10,
        bytes_url: `http://localhost:${slow.port}/f${i}.bin`,
      }));
      await downloadEntries(files, join(workDir, "bounded"), { concurrency: 4 });
      expect(peak).toBeLessThanOrEqual(4);
      expect(peak).toBeGreaterThan(1);
    } finally {
      slow.stop(true);
    }
  });
});

describe("output directory identity", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "nemar-http-id-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a fresh directory has no conflict", () => {
    expect(inspectOutputDir(join(dir, "nope"), "nm000104", "v1.0.0")).toBeNull();
  });

  test("a git repository is refused", () => {
    const out = join(dir, "clone");
    mkdirSync(join(out, ".git"), { recursive: true });
    expect(inspectOutputDir(out, "nm000104", "v1.0.0")).toEqual({ kind: "git-repo" });
  });

  test("a different dataset is refused", () => {
    const out = join(dir, "other-ds");
    mkdirSync(out, { recursive: true });
    writeSnapshotStamp(out, "nm000104", "v1.0.0");
    expect(inspectOutputDir(out, "nm000105", "v1.0.0")).toEqual({
      kind: "other-dataset",
      datasetId: "nm000104",
    });
  });

  test("a different version of the same dataset is refused", () => {
    // The failure this exists for: dataset_description.json carries
    // DatasetVersion, and "1.0.0" -> "1.0.1" is byte-identical in length, so
    // the resume check would skip it and the tree would misreport its version.
    const out = join(dir, "other-ver");
    mkdirSync(out, { recursive: true });
    writeSnapshotStamp(out, "nm000104", "v1.0.0");
    expect(inspectOutputDir(out, "nm000104", "v1.0.1")).toEqual({
      kind: "other-version",
      version: "v1.0.0",
    });
  });

  test("the same dataset at the same version resumes", () => {
    const out = join(dir, "same");
    mkdirSync(out, { recursive: true });
    writeSnapshotStamp(out, "nm000104", "v1.0.0");
    expect(inspectOutputDir(out, "nm000104", "v1.0.0")).toBeNull();
  });
});

// The real data plane's refusal, read by the real CLI reader: the backend's
// `dataRoutes` over a real D1 and a local S3 stand-in serve a manifest over
// the manifest.json bound (#1502), and `getDocument` has to turn the 413 into
// a sentence that says what to do, not "could not be read (HTTP 413)".
describe("a refusal from the data plane reaches the user with its reason", () => {
  let s3: S3ManifestStandin;
  let plane: Server;
  let plain: Server;
  let base: string;
  let plainBase: string;

  beforeAll(() => {
    s3 = startS3ManifestStandin();
    // #1522 raised MAX_MANIFEST_JSON_ENTRIES 30,000 -> 38,000; 95 subjects
    // (38,100 entries) clears it with margin the way 75 (30,080) cleared the
    // old bound.
    const opts = { subjects: 95, runsPerSession: 50, datasetId: "nm000281" };
    expect(largeManifestEntryCount(opts)).toBeGreaterThan(MAX_MANIFEST_JSON_ENTRIES);
    s3.put("/nm000281/version/v1.0.3.json", largeManifestText(opts));
    const db = freshDb();
    db.prepare(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox)
       VALUES ('nm000281', 'nm000281', 1, 'active', 'public', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at)
       VALUES ('nm000281', '1.0.3', '10.5072/FK2test', 'ezid', '2026-08-31 00:21:32')`,
    ).run();
    const env = {
      DB: realD1(db),
      ENVIRONMENT: "test",
      DATA_BASE_URL: "https://data.nemar.org",
      S3_ENDPOINT_URL: s3.url,
      S3_BUCKET: "nemar",
      AWS_REGION: "us-east-2",
      AWS_ACCESS_KEY_ID: "AKIATEST",
      AWS_SECRET_ACCESS_KEY: "secret",
    } as Bindings;
    // The data sub-app served at the root, the way data.nemar.org serves it.
    plane = Bun.serve({ port: 0, fetch: (req) => dataRoutes.fetch(req, env) });
    base = `http://127.0.0.1:${plane.port}`;
    plain = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/json-error") {
          return Response.json({ error: "Upstream content host unavailable" }, { status: 503 });
        }
        return new Response("<html>Bad Gateway</html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        });
      },
    });
    plainBase = `http://127.0.0.1:${plain.port}`;
  });

  afterAll(() => {
    plane.stop(true);
    plain.stop(true);
    s3.stop();
  });

  const read = (url: string) =>
    getDocument(url, dataPlaneManifestSchema, "Manifest for nm000281 v1.0.3", () => "absent");

  test("a 413 names git-annex and the listing the data plane pointed to", async () => {
    const listing = `${base}/nm000281/v1.0.3/?format=json`;
    const error = await read(`${base}/nm000281/v1.0.3/manifest.json`).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DataPlaneUnavailableError);
    const message = (error as Error).message;
    expect(message).toContain("HTTP 413");
    expect(message).toContain(`more than ${MAX_MANIFEST_JSON_ENTRIES} files`);
    expect(message).toContain("install git-annex");
    expect(message).toContain(listing);
    // And the listing it names is one the data plane really answers.
    expect((await fetch(listing)).status).toBe(200);
  });

  test("another refusal with a JSON reason carries the reason", async () => {
    await expect(read(`${plainBase}/json-error`)).rejects.toThrow(
      "Manifest for nm000281 v1.0.3 could not be read (HTTP 503): Upstream content host unavailable",
    );
  });

  test("a refusal that is not JSON keeps the plain sentence", async () => {
    await expect(read(`${plainBase}/proxy`)).rejects.toThrow(
      "Manifest for nm000281 v1.0.3 could not be read (HTTP 502).",
    );
  });
});
