/**
 * Completion cache degradation (epic #1144 phase 5b, issue #1149 -- plan
 * verification case 5, D3): "missing file, unreadable file, malformed JSON,
 * a JSON value of the wrong shape, an expired entry" must all degrade to
 * static candidates and exit 0 -- never a thrown error surfaced at the
 * shell prompt.
 *
 * Driven through the real `nemar __complete` subprocess for the entry-point
 * guarantee (exit code included -- readCompletionCache() returning null is
 * necessary but not sufficient; something upstream has to still print the
 * static fallback and exit cleanly). A second describe block below calls
 * readCompletionCache() directly as a SUPPLEMENT: run.ts wraps the whole
 * candidate lookup in its own try/catch (D1's "never throws" guarantee for
 * __complete as a whole), which means a regression that deletes cache.ts's
 * own try/catch is invisible at the subprocess/exit-code level -- run.ts's
 * outer net silently catches it too. Only a direct call can tell the two
 * layers apart.
 *
 * `--source` is used as the "has a static fallback" flag (declared in
 * shared/facets.ts) and `--task` as the "dynamic-only, no static fallback"
 * flag, so degradation is checked on both shapes: falls back to something,
 * and falls back to nothing, but never falls back to a crash.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { datasetSourceSchema } from "../shared/contract/dataset";
import { readCompletionCache } from "../src/lib/completion/cache";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const STATIC_SOURCE_VALUES = [...datasetSourceSchema.options].sort();

async function runComplete(
  configDir: string,
  words: string[],
): Promise<{ candidates: string[]; directiveLine: string; exitCode: number }> {
  const env = { ...process.env, NEMAR_CONFIG_DIR: configDir, NO_COLOR: "1" };
  env.FORCE_COLOR = undefined;
  env.CLICOLOR_FORCE = undefined;
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, "__complete", "--", ...words],
    cwd: REPO_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  const lines = stdout.split("\n").filter((_, i, arr) => i < arr.length - 1 || arr[i] !== "");
  const directiveLine = lines[lines.length - 1] ?? "";
  const candidates = lines.slice(0, -1);
  return { candidates, directiveLine, exitCode };
}

function cacheFile(dir: string): string {
  return join(dir, "completion-cache.json");
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "nemar-completion-cache-"));
}

describe("verification case 5: cache degradation", () => {
  test("absent: no cache file at all", async () => {
    const dir = freshDir();
    try {
      const source = await runComplete(dir, ["dataset", "list", "--source", ""]);
      expect(source.exitCode).toBe(0);
      expect(source.candidates.sort()).toEqual(STATIC_SOURCE_VALUES);

      const task = await runComplete(dir, ["dataset", "list", "--task", ""]);
      expect(task.exitCode).toBe(0);
      expect(task.candidates).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unreadable: the cache path is a directory, not a file", async () => {
    const dir = freshDir();
    try {
      mkdirSync(cacheFile(dir));
      const source = await runComplete(dir, ["dataset", "list", "--source", ""]);
      expect(source.exitCode).toBe(0);
      expect(source.candidates.sort()).toEqual(STATIC_SOURCE_VALUES);

      const task = await runComplete(dir, ["dataset", "list", "--task", ""]);
      expect(task.exitCode).toBe(0);
      expect(task.candidates).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed JSON", async () => {
    const dir = freshDir();
    try {
      writeFileSync(cacheFile(dir), "{not valid json at all");
      const source = await runComplete(dir, ["dataset", "list", "--source", ""]);
      expect(source.exitCode).toBe(0);
      expect(source.candidates.sort()).toEqual(STATIC_SOURCE_VALUES);

      const task = await runComplete(dir, ["dataset", "list", "--task", ""]);
      expect(task.exitCode).toBe(0);
      expect(task.candidates).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("right JSON, wrong shape: task carries an array instead of {values,...}", async () => {
    const dir = freshDir();
    try {
      writeFileSync(
        cacheFile(dir),
        JSON.stringify({ cachedAt: Date.now(), data: { task: ["not", "an", "object"] } }),
      );
      const source = await runComplete(dir, ["dataset", "list", "--source", ""]);
      expect(source.exitCode).toBe(0);
      expect(source.candidates.sort()).toEqual(STATIC_SOURCE_VALUES);

      const task = await runComplete(dir, ["dataset", "list", "--task", ""]);
      expect(task.exitCode).toBe(0);
      expect(task.candidates).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A second, independently-discriminating wrong-shape case.
  //
  // Be precise about the layering, because the first version of this comment
  // was not (#1173 review). In NORMAL operation the task/array case is caught
  // by the zod schema alone: datasetFacetsEnvelopeSchema.safeParse rejects it
  // with invalid_type at path ["task"], so readCompletionCache returns null
  // and run.ts's catch never sees anything. Both layers are not acting.
  //
  // What that case cannot do is PROVE the schema is load-bearing, because
  // REMOVING the schema does not change the observable outcome: the bad shape
  // then reaches `.value` on a bare string, throws, and run.ts's outer catch
  // produces the same static-candidate fallback. The mutation is masked even
  // though the layering is not redundant.
  //
  // This case closes that: a numeric `value` silently stringifies rather than
  // throwing, so nothing downstream rejects it and only the schema check can.
  test("right JSON, wrong shape: a vocabulary entry's value is a number, not a string", async () => {
    const dir = freshDir();
    try {
      writeFileSync(
        cacheFile(dir),
        JSON.stringify({
          cachedAt: Date.now(),
          data: { modality: [{ value: 123, count: 5 }] },
        }),
      );
      const modality = await runComplete(dir, ["dataset", "list", "--modality", ""]);
      expect(modality.exitCode).toBe(0);
      expect(modality.candidates).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("expired: well-formed and otherwise valid, but past the one-hour TTL", async () => {
    const dir = freshDir();
    try {
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      writeFileSync(
        cacheFile(dir),
        JSON.stringify({
          cachedAt: twoHoursAgo,
          data: {
            task: { values: [{ value: "rest", count: 5 }], distinct_total: 1, truncated: false },
          },
        }),
      );
      const task = await runComplete(dir, ["dataset", "list", "--task", ""]);
      expect(task.exitCode).toBe(0);
      // The whole point of this case: an otherwise-valid "rest" entry must
      // NOT surface once its cachedAt is past the TTL.
      expect(task.candidates).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("positive control: a fresh, well-formed cache IS used", async () => {
    const dir = freshDir();
    try {
      writeFileSync(
        cacheFile(dir),
        JSON.stringify({
          cachedAt: Date.now(),
          data: {
            task: { values: [{ value: "rest", count: 5 }], distinct_total: 1, truncated: false },
          },
        }),
      );
      const task = await runComplete(dir, ["dataset", "list", "--task", ""]);
      expect(task.exitCode).toBe(0);
      expect(task.candidates).toEqual(["rest"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readCompletionCache() directly (supplements the subprocess tests above)", () => {
  let directDir: string;
  // `bun test` runs every file in one process: put the variable back as found, gone if unset.
  const previousConfigDir = process.env.NEMAR_CONFIG_DIR;

  beforeAll(() => {
    directDir = freshDir();
    process.env.NEMAR_CONFIG_DIR = directDir;
  });

  afterEach(() => {
    // Each test that writes a cache file (or a directory standing in for
    // one) cleans up so the next one starts from "absent" again, without
    // tearing down the whole config dir. force:true covers "absent" too.
    rmSync(cacheFile(directDir), { recursive: true, force: true });
  });

  afterAll(() => {
    // Never `= undefined`: Bun would store the literal string "undefined".
    if (previousConfigDir === undefined) Reflect.deleteProperty(process.env, "NEMAR_CONFIG_DIR");
    else process.env.NEMAR_CONFIG_DIR = previousConfigDir;
    rmSync(directDir, { recursive: true, force: true });
  });

  test("absent: returns null, does not throw", () => {
    expect(readCompletionCache()).toBeNull();
  });

  test("unreadable (a directory at the cache path): returns null, does not throw", () => {
    mkdirSync(cacheFile(directDir));
    expect(readCompletionCache()).toBeNull();
  });

  test("malformed JSON: returns null, does not throw", () => {
    writeFileSync(cacheFile(directDir), "{not valid json at all");
    expect(readCompletionCache()).toBeNull();
  });
});

// #1173 comment review: --electrode-system is the ONLY flag with both a
// static enumValues declaration and a cache-backed vocabulary, and nothing
// exercised that duality. The help text now makes a user-facing claim about
// it ("always completes from its declared six values, but once a cache
// exists it completes from the catalog instead"), so the claim needs a test.
describe("--electrode-system: the one flag with both a static enum and a cache", () => {
  test("with no cache it completes the declared static values", async () => {
    const dir = freshDir();
    try {
      const res = await runComplete(dir, ["dataset", "list", "--electrode-system", ""]);
      expect(res.exitCode).toBe(0);
      // The six declared in shared/facets.ts, and nothing invented.
      expect(res.candidates.sort()).toEqual(
        ["10-05", "10-10", "10-20", "biosemi", "egi-geodesic", "other"].sort(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with a fresh cache it completes the catalog superset instead", async () => {
    const dir = freshDir();
    try {
      writeFileSync(
        cacheFile(dir),
        JSON.stringify({
          cachedAt: Date.now(),
          data: {
            "electrode-system": [
              { value: "10-10", count: 341 },
              // A value that is NOT in the static six. If the static list
              // were preferred, or merged, this would not appear alone.
              { value: "10-10-extended", count: 3 },
            ],
          },
        }),
      );
      const res = await runComplete(dir, ["dataset", "list", "--electrode-system", ""]);
      expect(res.exitCode).toBe(0);
      expect(res.candidates.sort()).toEqual(["10-10", "10-10-extended"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an EXPIRED cache falls back to the static six, not to nothing", async () => {
    // The dual-source flag must degrade to its static half, unlike --task,
    // which has no static half and correctly degrades to no candidates.
    const dir = freshDir();
    try {
      writeFileSync(
        cacheFile(dir),
        JSON.stringify({
          cachedAt: Date.now() - 2 * 60 * 60 * 1000,
          data: { "electrode-system": [{ value: "10-10-extended", count: 3 }] },
        }),
      );
      const res = await runComplete(dir, ["dataset", "list", "--electrode-system", ""]);
      expect(res.exitCode).toBe(0);
      expect(res.candidates).toContain("biosemi");
      expect(res.candidates).not.toContain("10-10-extended");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Test-review follow-up on #1173: `--hed-version` was missing from
// candidates.ts's DYNAMIC_FACET_KEY_BY_FLAG even though it is
// `--bids-version`'s exact structural twin (shared/facets.ts: both
// `valueKind: "version"`, no `enumValues`) and a first-class member of the
// facets contract (`datasetFacetsEnvelopeSchema`) and of
// `GROUPED_VOCAB_KEYS` (backend/src/services/dataset-facet-vocabulary.ts).
// Measured against the real catalog (755 public rows, review follow-up),
// `hed_version` is populated for 271 of them and genuinely has candidates to
// offer once wired up -- this is not a defensive no-op fix. Still seeded
// here rather than checked against a live facets response, for determinism:
// a test that depends on whatever production happens to hold right now is
// not a test.
//
// The seeded values below are deliberately NOT all core-HED `8.x`: the real
// column is dominated by `8.x` but also carries library-schema versions
// (`score_2.0.0`, `score_1.1.0` -- a different HED namespace) and one
// pre-8.0 legacy value (`3.0.0`). getCandidates() must pass all of them
// through unfiltered -- there is no "hed versions look like 8.x" rule to
// encode, and writing one into either the code or this comment would be
// false for three of 755 rows.
describe("regression: --hed-version was never wired to the dynamic cache (#1173 follow-up)", () => {
  test("a seeded hed-version cache completes, exactly like its twin --bids-version", async () => {
    const dir = freshDir();
    try {
      writeFileSync(
        cacheFile(dir),
        JSON.stringify({
          cachedAt: Date.now(),
          data: {
            "hed-version": [
              { value: "8.4.0", count: 150 },
              { value: "8.1.0", count: 80 },
              { value: "8.0.0", count: 15 },
              { value: "score_2.0.0", count: 1 },
              { value: "score_1.1.0", count: 1 },
              { value: "3.0.0", count: 1 },
            ],
          },
        }),
      );
      const res = await runComplete(dir, ["dataset", "list", "--hed-version", ""]);
      expect(res.exitCode).toBe(0);
      // No filtering, normalizing, or "8.x" assumption: the library-schema
      // and legacy values pass through exactly like the core ones.
      expect(res.candidates.sort()).toEqual(
        ["3.0.0", "8.0.0", "8.1.0", "8.4.0", "score_1.1.0", "score_2.0.0"].sort(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with no cache it offers nothing, not an error (no static fallback exists)", async () => {
    const dir = freshDir();
    try {
      const res = await runComplete(dir, ["dataset", "list", "--hed-version", ""]);
      expect(res.exitCode).toBe(0);
      expect(res.candidates).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
