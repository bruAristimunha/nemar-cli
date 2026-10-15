/**
 * The data plane's manifest questions, answered by streaming scans, against
 * the whole-parse functions they replaced (#1502).
 *
 * Every assertion is a PARITY check: the same manifest bytes go through
 * `JSON.parse` and the reference function in `data-router.ts` (`resolveFile`,
 * `Object.hasOwn`, `digestManifest`, `Object.entries`), and through the
 * scanner with the matching query, and the two answers must be identical.
 * Nothing here states an expected answer of its own.
 *
 * The real input is nm000132's published v1.1.1 manifest, every directory
 * and every path in it. It is sorted, ASCII and duplicate-free, so it cannot
 * reach the places where a stream and `Object.entries` disagree (array-index
 * keys, repeated keys, unsorted keys, odd sizes); the small synthetic
 * manifests below exist for exactly those, and each says which rule it pins.
 *
 * The large input is generated in nm000281's measured shape
 * (`helpers/large-manifest.ts`), because the manifest that broke production is
 * 43 MB and not committable. It is served by a real local HTTP server and
 * read through `fetch`, and it is where the memory bound is measured.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { type ResolvedFile, digestManifest, resolveFile } from "../src/services/data-router";
import type { VersionManifest } from "../src/services/manifest";
import {
  ContainsPathQuery,
  type DigestAnswer,
  DigestQuery,
  EntriesQuery,
  EntryCountQuery,
  type ManifestQuery,
  ResolvePathQuery,
  isArrayIndexKey,
} from "../src/services/manifest-queries";
import { scanManifestStream, scanManifestText } from "../src/services/manifest-scan";
import {
  LARGE_MANIFEST_TEST_TIMEOUT_MS,
  type LargeManifestOptions,
  largeManifestEntryCount,
  largeManifestPaths,
  largeManifestStream,
  largeManifestText,
} from "./helpers/large-manifest";
import { type ProbeRequest, measureScan } from "./helpers/manifest-memory-probe";

const FIXTURE_TEXT = readFileSync(
  join(import.meta.dir, "fixtures/manifest-nm000132-v1.1.1.json"),
  "utf8",
);
const FIXTURE: VersionManifest = JSON.parse(FIXTURE_TEXT);

/** Answer `query` from `text` through the scanner, or throw if it did not scan. */
function answerText<T>(text: string, query: ManifestQuery<T>): T {
  const result = scanManifestText(text, query);
  if (result.kind !== "ok") throw new Error(`scan verdict ${result.kind}`);
  return query.finish(result.header);
}

async function answerStream<T>(body: ReadableStream<Uint8Array>, query: ManifestQuery<T>) {
  const result = await scanManifestStream(body, query);
  if (result.kind !== "ok") throw new Error(`scan verdict ${result.kind}`);
  return query.finish(result.header);
}

function bytesStream(bytes: Uint8Array, chunk: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + chunk));
      at += chunk;
    },
  });
}

/** Every directory of a manifest, with and without the slashes a URL carries. */
function directoriesOf(paths: Iterable<string>): string[] {
  const dirs = new Set<string>([""]);
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return [...dirs];
}

const PATHS_THAT_ARE_NOT_THERE = [
  "nope",
  "sub-001/nope",
  "sub-001/eeg/nope.set",
  "../etc/passwd",
  "sub-001/../sub-002",
  "a//b",
  "__proto__",
  "constructor",
  "sub-001/eeg/",
  "/sub-001/",
  "%2E%2E/x",
];

describe("ResolvePathQuery is resolveFile", () => {
  test("every directory of nm000132, with and without slashes", () => {
    const dirs = directoriesOf(Object.keys(FIXTURE.files));
    expect(dirs.length).toBe(91);
    for (const dir of dirs) {
      for (const raw of [dir, `${dir}/`, `/${dir}`, `//${dir}//`]) {
        expect(answerText(FIXTURE_TEXT, new ResolvePathQuery(raw))).toEqual(
          resolveFile(FIXTURE, raw),
        );
      }
    }
  });

  test("every file of nm000132", () => {
    const paths = Object.keys(FIXTURE.files);
    expect(paths).toHaveLength(1462);
    for (const path of paths) {
      const got = answerText(FIXTURE_TEXT, new ResolvePathQuery(path));
      expect(got).toEqual(resolveFile(FIXTURE, path));
      expect(got.kind).toBe("file");
    }
  });

  test("paths that are absent or invalid", () => {
    for (const raw of PATHS_THAT_ARE_NOT_THERE) {
      expect(answerText(FIXTURE_TEXT, new ResolvePathQuery(raw))).toEqual(
        resolveFile(FIXTURE, raw),
      );
    }
  });

  test("through the byte stream in odd chunks", async () => {
    const bytes = new TextEncoder().encode(FIXTURE_TEXT);
    for (const raw of ["", "sub-001", "sub-001/eeg", "participants.tsv", "nope"]) {
      expect(await answerStream(bytesStream(bytes, 4093), new ResolvePathQuery(raw))).toEqual(
        resolveFile(FIXTURE, raw),
      );
    }
  });

  // Synthetic: no real manifest has array-index names at its root, and
  // `Object.entries` lists those FIRST. That order is invisible unless the
  // stable sort meets a tie, and `localeCompare` ties "1" with "1\u200b"
  // (a zero-width space is ignorable to the collator). So the only document
  // that can tell the two orders apart is one like this.
  test("root array-index names keep Object.entries' order through a sort tie", () => {
    const zwsp = String.fromCharCode(0x200b);
    expect("1".localeCompare(`1${zwsp}`)).toBe(0);
    // Written as JSON text, not built from an object literal: a literal would
    // already put "1" and "10" first, and the document has to list them LAST
    // (after the tying name, and "10" after the directory "10/x") for the
    // stream's order and Object.entries' order to differ at all.
    const text = String.raw`{"version":"1","files":{"1\u200b":{"size":1},"b":{"size":2},"10/x":{"size":5},"1":{"size":3},"10":{"size":4}}}`;
    const parsed = JSON.parse(text) as VersionManifest;
    expect(Object.keys(parsed.files)).toEqual(["1", "10", `1${zwsp}`, "b", "10/x"]);
    const expected = resolveFile(parsed, "");
    const got = answerText(text, new ResolvePathQuery(""));
    expect(got).toEqual(expected);
    // Pin the order itself, so this cannot pass by both sides being wrong.
    if (got.kind !== "directory") throw new Error("expected a directory");
    expect(got.children.map((c) => c.name)).toEqual(["1", `1${zwsp}`, "10", "b"]);
    expect(got.children.find((c) => c.name === "10")).toEqual({
      kind: "file",
      name: "10",
      size: 4,
    });
  });

  test("a repeated path keeps its first position and its last value", () => {
    const text =
      '{"files":{"d/a":{"size":1},"d/b":{"size":2},"d/a":{"size":3},"d/b/c":{"size":4},"d/a/x":{}}}';
    const parsed = JSON.parse(text) as VersionManifest;
    for (const raw of ["", "d", "d/a", "d/b"]) {
      expect(answerText(text, new ResolvePathQuery(raw))).toEqual(resolveFile(parsed, raw));
    }
  });

  test("a file and a directory of the same name: the file wins, in either order", () => {
    for (const text of [
      '{"files":{"x":{"size":1},"x/y":{"size":2}}}',
      '{"files":{"x/y":{"size":2},"x":{"size":1}}}',
    ]) {
      const parsed = JSON.parse(text) as VersionManifest;
      for (const raw of ["", "x"]) {
        expect(answerText(text, new ResolvePathQuery(raw))).toEqual(resolveFile(parsed, raw));
      }
    }
  });

  test("a null entry in the listed directory throws, as resolveFile always did", () => {
    const text = '{"files":{"d/a":null,"e/b":{"size":1}}}';
    const parsed = JSON.parse(text) as VersionManifest;
    expect(() => resolveFile(parsed, "d")).toThrow(TypeError);
    expect(() => answerText(text, new ResolvePathQuery("d"))).toThrow(TypeError);
    // ...and does not throw where resolveFile did not read it.
    expect(answerText(text, new ResolvePathQuery("e"))).toEqual(resolveFile(parsed, "e"));
    expect(answerText(text, new ResolvePathQuery("d/a"))).toEqual(resolveFile(parsed, "d/a"));
  });

  test("a null entry overwritten by a later duplicate does not throw", () => {
    const text = '{"files":{"d/a":null,"d/a":{"size":1}}}';
    const parsed = JSON.parse(text) as VersionManifest;
    expect(answerText(text, new ResolvePathQuery("d"))).toEqual(resolveFile(parsed, "d"));
  });

  test("files as an array, and the last of two files members", () => {
    for (const text of [
      '{"files":[{"size":1},{"size":2}]}',
      '{"files":{"old/x":{"size":1}},"files":{"new/y":{"size":2}}}',
    ]) {
      const parsed = JSON.parse(text) as VersionManifest;
      for (const raw of ["", "0", "old", "new"]) {
        expect(answerText(text, new ResolvePathQuery(raw))).toEqual(resolveFile(parsed, raw));
      }
    }
  });
});

describe("ContainsPathQuery is Object.hasOwn", () => {
  test("every nm000132 path, and the absent ones, raw as the tombstone walk passes them", () => {
    const probes = [
      ...Object.keys(FIXTURE.files).filter((_, i) => i % 7 === 0),
      ...PATHS_THAT_ARE_NOT_THERE,
      "sub-001",
      "",
    ];
    for (const path of probes) {
      expect(answerText(FIXTURE_TEXT, new ContainsPathQuery(path))).toBe(
        Object.hasOwn(FIXTURE.files, path),
      );
    }
  });

  test("an own __proto__ entry is found, and only when it is there", () => {
    const text = '{"files":{"__proto__":{"size":1}}}';
    const parsed = JSON.parse(text) as VersionManifest;
    expect(answerText(text, new ContainsPathQuery("__proto__"))).toBe(
      Object.hasOwn(parsed.files, "__proto__"),
    );
    expect(answerText(FIXTURE_TEXT, new ContainsPathQuery("__proto__"))).toBe(false);
  });
});

describe("DigestQuery is digestManifest", () => {
  test("nm000132 streams to exactly the reference digest", () => {
    const got = answerText(FIXTURE_TEXT, new DigestQuery());
    // The exact path must actually apply to a real manifest; a digest that
    // always reported unproven totals would bound memory and lose the totals.
    expect(got).toEqual({ digest: digestManifest(FIXTURE), unproven: null, excludedSizes: 0 });
    expect(got.digest.files).toBe(1462);
  });

  // Synthetic: the real manifests are sorted with integer sizes, so none of
  // them reach these. Each is a way a stream's totals and Object.values'
  // could disagree, and none of them may read the manifest whole to settle it.
  const UNPROVEN: Record<string, string> = {
    "keys out of order": '{"version":"1","files":{"b":{"size":1},"a":{"size":2}}}',
    "a repeated key (counted once, last value)":
      '{"version":"1","files":{"a":{"size":1},"b":{"size":2},"a":{"size":5}}}',
    "sizes past 2^53": '{"version":"1","files":{"a":{"size":9007199254740991},"b":{"size":2}}}',
    "files as an array (indices sort as strings)":
      '{"version":"1","files":[{"size":1},{"size":2},{"size":3},{"size":4},{"size":5},{"size":6},{"size":7},{"size":8},{"size":9},{"size":10},{"size":11}]}',
  };
  for (const [label, text] of Object.entries(UNPROVEN)) {
    test(`totals it cannot prove are null, and the index is still exact: ${label}`, () => {
      const got = answerText(text, new DigestQuery());
      const reference = digestManifest(JSON.parse(text) as VersionManifest);
      expect(got.unproven).not.toBeNull();
      expect(got.digest.bytes).toBeNull();
      expect(got.digest.files).toBeNull();
      expect(got.digest.sessions).toEqual(reference.sessions);
      expect(got.digest.subjects).toEqual(reference.subjects);
    });
  }

  // A size with no meaningful sum: Object.values would concatenate a string
  // or produce NaN. The entry is counted and its size left out, and that is
  // reported rather than hidden.
  const BAD_SIZES: Record<string, string> = {
    "a string size": '{"version":"1","files":{"a":{"size":1},"b":{"size":"2"},"c":{"size":4}}}',
    "a fractional size": '{"version":"1","files":{"a":{"size":0.5},"b":{"size":2}}}',
    "a negative size": '{"version":"1","files":{"a":{"size":-1},"b":{"size":2}}}',
    "an entry that is not an object": '{"version":"1","files":{"a":7,"b":{"size":2},"c":null}}',
  };
  for (const [label, text] of Object.entries(BAD_SIZES)) {
    test(`an unusable size is counted, excluded and reported: ${label}`, () => {
      const parsed = JSON.parse(text) as VersionManifest;
      const values = Object.values(parsed.files) as unknown[];
      const sizeOf = (v: unknown) =>
        v !== null && typeof v === "object" ? (v as { size?: unknown }).size : undefined;
      const usable = values
        .map(sizeOf)
        .filter((n): n is number => Number.isSafeInteger(n) && (n as number) >= 0);
      const got = answerText(text, new DigestQuery());
      expect(got.unproven).toBeNull();
      expect(got.excludedSizes).toBe(values.length - usable.length);
      expect(got.excludedSizes).toBeGreaterThan(0);
      expect(got.digest.files).toBe(values.length);
      expect(got.digest.bytes).toBe(usable.reduce((a, b) => a + b, 0));
    });
  }

  test("a second files member starts the totals over", () => {
    const text = '{"version":"1","files":{"a":{"size":1}},"files":{"b":{"size":2}}}';
    const got = answerText(text, new DigestQuery());
    expect(got).toEqual({
      digest: digestManifest(JSON.parse(text)),
      unproven: null,
      excludedSizes: 0,
    });
  });
});

describe("EntriesQuery is manifest.files, up to a limit", () => {
  test("nm000132 materializes to JSON.parse's object, entry for entry", () => {
    const got = answerText(FIXTURE_TEXT, new EntriesQuery(30_000));
    if (got.kind !== "entries") throw new Error("expected entries");
    expect(Object.entries(got.files)).toEqual(Object.entries(FIXTURE.files));
  });

  test("the limit is inclusive and counts distinct paths", () => {
    expect(answerText(FIXTURE_TEXT, new EntriesQuery(1462)).kind).toBe("entries");
    expect(answerText(FIXTURE_TEXT, new EntriesQuery(1461))).toEqual({
      kind: "over_limit",
      limit: 1461,
    });
    const repeated = '{"files":{"a":{"size":1},"a":{"size":2},"b":{"size":3}}}';
    const got = answerText(repeated, new EntriesQuery(2));
    if (got.kind !== "entries") throw new Error("a repeat must not count twice");
    expect(Object.entries(got.files)).toEqual(Object.entries(JSON.parse(repeated).files));
  });
});

describe("EntryCountQuery is Object.keys(manifest.files).length", () => {
  test("nm000132 counts exactly, keeping nothing", () => {
    expect(answerText(FIXTURE_TEXT, new EntryCountQuery())).toEqual({
      kind: "count",
      count: Object.keys(FIXTURE.files).length,
    });
  });

  // Synthetic: a repeated key is ONE entry to Object.keys, and only ordered
  // keys prove there is none, so an unordered manifest must not be counted.
  test("keys that do not ascend are reported, not miscounted", () => {
    for (const text of [
      '{"files":{"a":{},"b":{},"a":{}}}',
      '{"files":{"b":{},"a":{}}}',
      '{"files":[{},{},{},{},{},{},{},{},{},{},{}]}',
    ]) {
      expect(answerText(text, new EntryCountQuery())).toEqual({ kind: "unordered" });
    }
    const last = '{"files":{"a":{},"b":{}},"files":{"c":{}}}';
    expect(answerText(last, new EntryCountQuery())).toEqual({
      kind: "count",
      count: Object.keys(JSON.parse(last).files).length,
    });
  });
});

test("isArrayIndexKey is the ECMA-262 array index", () => {
  const cases: [string, boolean][] = [
    ["0", true],
    ["7", true],
    ["4294967294", true],
    ["4294967295", false],
    ["01", false],
    ["-1", false],
    ["1.0", false],
    ["", false],
    ["1e3", false],
    [" 1", false],
  ];
  for (const [key, expected] of cases) {
    // The engine is the oracle: an index key enumerates before a named one.
    const probe = JSON.parse(`{"z":0,${JSON.stringify(key)}:1}`) as Record<string, number>;
    expect(Object.keys(probe)[0] === key).toBe(expected);
    expect(isArrayIndexKey(key)).toBe(expected);
  }
});

// ---------------------------------------------------------------------------
// The large manifest: served over HTTP, and where memory is measured.
// ---------------------------------------------------------------------------

/** nm000281 has 102,532 entries; this is about half again as many. */
const LARGE: LargeManifestOptions = { subjects: 374, runsPerSession: 50 };
const LARGE_ENTRIES = largeManifestEntryCount(LARGE);

/** The most live memory any sample held above the scan's start. */
const peakOf = (samples: number[]) => {
  // Math.max of nothing is -Infinity, which is under every bound: no samples is no evidence.
  expect(samples.length).toBeGreaterThan(0);
  return Math.max(...samples);
};

/** Every memory check below must stay under this: one decoded chunk and the answer. */
const FLAT_BOUND = 8 * 1024 * 1024;

/**
 * A scan measured in a process of its own (`helpers/manifest-memory-probe.ts` says why:
 * the heap of this process, after thousands of other tests, is too noisy to read a few
 * hundred kilobytes from).
 */
const scan = (query: ProbeRequest["query"], manifest: LargeManifestOptions = LARGE) =>
  measureScan({ manifest, query, every: 5000 });

describe("a large manifest over HTTP", () => {
  let server: Server;
  let base: string;
  let text: string;
  let parsed: VersionManifest;
  let bytesLength = 0;

  beforeAll(() => {
    text = largeManifestText(LARGE);
    const bytes = new TextEncoder().encode(text);
    bytesLength = bytes.length;
    parsed = JSON.parse(text);
    server = Bun.serve({
      port: 0,
      fetch: () => new Response(bytes, { headers: { "Content-Type": "application/json" } }),
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  const read = async () => {
    const res = await fetch(`${base}/nm000281/version/v1.0.3.json`);
    return res.body as ReadableStream<Uint8Array>;
  };

  test(
    "is the size the issue measured, and sorted",
    () => {
      expect(LARGE_ENTRIES).toBe(149_979);
      expect(Object.keys(parsed.files)).toHaveLength(LARGE_ENTRIES);
      // Tens of megabytes: nm000281's is 42.8 MB for 102,532 entries.
      expect(bytesLength).toBeGreaterThan(55_000_000);
    },
    LARGE_MANIFEST_TEST_TIMEOUT_MS,
  );

  test(
    "every query answers what the whole parse answers",
    async () => {
      const somePaths = [...largeManifestPaths(LARGE)].filter((_, i) => i % 30_011 === 5);
      const dirs = ["", "sub-000", "sub-373/ses-01", "sub-200/ses-01/emg", "sub-999", "nope/x"];
      for (const raw of [...dirs, ...somePaths]) {
        expect(await answerStream(await read(), new ResolvePathQuery(raw))).toEqual(
          resolveFile(parsed, raw) as ResolvedFile,
        );
      }
      for (const path of [...somePaths, "sub-000/nope"]) {
        expect(await answerStream(await read(), new ContainsPathQuery(path))).toBe(
          Object.hasOwn(parsed.files, path),
        );
      }
      const digest = await answerStream(await read(), new DigestQuery());
      expect(digest).toEqual({ digest: digestManifest(parsed), unproven: null, excludedSizes: 0 });
      expect(await answerStream(await read(), new EntriesQuery(30_000))).toEqual({
        kind: "over_limit",
        limit: 30_000,
      });
      expect(await answerStream(await read(), new EntryCountQuery())).toEqual({
        kind: "count",
        count: Object.keys(parsed.files).length,
      });
    },
    LARGE_MANIFEST_TEST_TIMEOUT_MS,
  );

  test(
    "a lookup's peak memory stays flat while the manifest grows tenfold",
    async () => {
      const small: LargeManifestOptions = { subjects: 37, runsPerSession: 50 };
      const target =
        "sub-020/ses-01/emg/sub-020_ses-01_task-emg2pose_run-07_recording-left_emg.json";
      const lookup = { kind: "resolve", path: target } as const;

      const tenth = await scan(lookup, small);
      const full = await scan(lookup);
      expect((tenth.answer as { kind: string }).kind).toBe("file");
      expect(full.answer).toEqual(tenth.answer);
      expect(full.samples).toHaveLength(29);

      // Generous: the scan holds one decoded chunk and the answer. A whole
      // parse holds the document (tens of MB of text alone) at these points.
      expect(peakOf(full.samples)).toBeLessThan(FLAT_BOUND);
      expect(peakOf(tenth.samples)).toBeLessThan(FLAT_BOUND);
      // And the growth is noise, not proportional: 10x the entries, well under
      // 10% of the manifest's size in extra memory.
      expect(peakOf(full.samples) - peakOf(tenth.samples)).toBeLessThan(bytesLength / 10);
    },
    LARGE_MANIFEST_TEST_TIMEOUT_MS,
  );

  test(
    "a directory listing's memory follows the listing, not the manifest",
    async () => {
      const { answer, samples } = await scan({ kind: "resolve", path: "sub-100/ses-01/emg" });
      const listing = answer as { kind: string; children: unknown[] };
      if (listing.kind !== "directory") throw new Error("expected a directory");
      expect(listing.children).toHaveLength(400);
      expect(peakOf(samples)).toBeLessThan(FLAT_BOUND);
    },
    LARGE_MANIFEST_TEST_TIMEOUT_MS,
  );

  test(
    "the metadata digest's memory follows the subjects, not the files",
    async () => {
      const { answer, samples } = await scan({ kind: "digest" });
      expect((answer as DigestAnswer).unproven).toBeNull();
      expect(peakOf(samples)).toBeLessThan(FLAT_BOUND);
    },
    LARGE_MANIFEST_TEST_TIMEOUT_MS,
  );

  // The two ways a digest used to fall back to reading the whole manifest,
  // forced on the large manifest. Neither may cost more than a lookup.
  test(
    "keys in descending order: totals unproven, index exact, memory flat",
    async () => {
      const { answer: raw, samples } = await scan(
        { kind: "digest" },
        { ...LARGE, descending: true },
      );
      const answer = raw as DigestAnswer;
      const reference = digestManifest(parsed);
      expect(answer.unproven).toContain("ascending");
      expect(answer.digest.files).toBeNull();
      expect(answer.digest.subjects).toEqual(reference.subjects);
      expect(answer.digest.sessions).toEqual(reference.sessions);
      expect(samples.length).toBeGreaterThan(25);
      expect(peakOf(samples)).toBeLessThan(FLAT_BOUND);
    },
    LARGE_MANIFEST_TEST_TIMEOUT_MS,
  );

  test(
    "a string size every 1,000 entries: excluded and counted, memory flat",
    async () => {
      const { answer: raw, samples } = await scan(
        { kind: "digest" },
        { ...LARGE, stringSizeEvery: 1000 },
      );
      const answer = raw as DigestAnswer;
      const sizes = Object.values(parsed.files).map((f) => f.size);
      const kept = sizes.filter((_, i) => (i + 1) % 1000 !== 0);
      expect(answer.unproven).toBeNull();
      expect(answer.excludedSizes).toBe(Math.floor(LARGE_ENTRIES / 1000));
      expect(answer.digest.files).toBe(LARGE_ENTRIES);
      expect(answer.digest.bytes).toBe(kept.reduce((a, b) => a + b, 0));
      expect(peakOf(samples)).toBeLessThan(FLAT_BOUND);
    },
    LARGE_MANIFEST_TEST_TIMEOUT_MS,
  );

  test(
    "counting the entries for the manifest.json bound keeps nothing",
    async () => {
      const { answer, samples } = await scan({ kind: "count" });
      expect(answer).toEqual({ kind: "count", count: LARGE_ENTRIES });
      expect(peakOf(samples)).toBeLessThan(FLAT_BOUND);
    },
    LARGE_MANIFEST_TEST_TIMEOUT_MS,
  );

  test(
    "an over-limit manifest.json refusal drops what it had gathered",
    async () => {
      const { answer, samples } = await scan({ kind: "entries", limit: 30_000 });
      expect((answer as { kind: string }).kind).toBe("over_limit");
      // Samples after the limit was crossed must be back near the baseline:
      // the 30,000 materialized entries are released, not carried to the end.
      expect(peakOf(samples.slice(-10))).toBeLessThan(FLAT_BOUND);
    },
    LARGE_MANIFEST_TEST_TIMEOUT_MS,
  );
});
