/**
 * Candidate sanitization at the `nemar __complete` wire boundary
 * (src/lib/completion/run.ts -- #1173 review).
 *
 * The completion protocol every shell script here parses (see
 * src/lib/completion/scripts.ts) is one candidate per line, terminated by a
 * final `:<directive>` line. `facetVocabularyEntrySchema.value`
 * (shared/contract/dataset.ts) is an unconstrained `z.string()` sourced from
 * live dataset metadata and cached verbatim (src/lib/completion/cache.ts),
 * so a value containing "\n" reaches `run.ts`'s `${candidate}\n` write and
 * splits into an extra line -- which every consumer (bash's `read` loop,
 * zsh's `${(@f)...}` split, fish's newline-split `$lines`) reads as its own,
 * unrelated candidate. A value shaped like `"rest\n:4"` is worse: the
 * injected line is byte-identical to the real trailing directive, so a
 * consumer cannot even tell the protocol was corrupted.
 *
 * Driven through the real `nemar __complete` subprocess (matching
 * test/completion-cache-degradation.unit.test.ts's pattern) rather than a
 * direct call into run.ts, since the guarantee under test -- "stdout is a
 * well-formed candidate/directive stream" -- is a property of the whole
 * process's output, not of any one function's return value.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

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
  return mkdtempSync(join(tmpdir(), "nemar-completion-sanitize-"));
}

/** Writes a completion cache whose `task` vocabulary is exactly the given
 *  values, fresh (well within the one-hour TTL). `task` is used throughout
 *  because it has no static fallback (shared/facets.ts) -- every candidate
 *  in the output can only have come from the cache values below, with no
 *  static-enum noise to filter out first. */
function writeTaskCache(dir: string, values: string[]): void {
  writeFileSync(
    cacheFile(dir),
    JSON.stringify({
      cachedAt: Date.now(),
      data: {
        task: {
          values: values.map((value) => ({ value, count: 1 })),
          distinct_total: values.length,
          truncated: false,
        },
      },
    }),
  );
}

let dir: string;

beforeEach(() => {
  dir = freshDir();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("regression: a candidate containing a control character corrupts the protocol (#1173)", () => {
  test("an embedded newline is dropped outright, not split into a spurious extra candidate", async () => {
    writeTaskCache(dir, ["sleep", "rest\nintrusion"]);
    const result = await runComplete(dir, ["dataset", "list", "--task", ""]);
    expect(result.exitCode).toBe(0);
    // "sleep" survives; the newline-carrying value is gone ENTIRELY -- not
    // present as itself, and not present split into "rest"/"intrusion"
    // either (dropping, not mangling).
    expect(result.candidates).toEqual(["sleep"]);
    expect(result.directiveLine).toBe(":4");
  });

  test("an embedded :4 sentinel after a newline does not forge a second directive line", async () => {
    // The exact shape from the bug report: a cached value of "rest\n:4"
    // would otherwise emit a line indistinguishable from the real trailing
    // directive, so all three shells would read a spurious "4" (or, parsed
    // as a directive, silently misapply it) instead of stopping at the one
    // true directive line.
    writeTaskCache(dir, ["sleep", "rest\n:4"]);
    const result = await runComplete(dir, ["dataset", "list", "--task", ""]);
    expect(result.exitCode).toBe(0);
    expect(result.candidates).toEqual(["sleep"]);
    // Exactly one directive line in the whole output, not two.
    const directiveOccurrences = result.candidates.filter((c) => c === ":4").length;
    expect(directiveOccurrences).toBe(0);
    expect(result.directiveLine).toBe(":4");
  });

  test("an embedded carriage return is dropped the same way", async () => {
    writeTaskCache(dir, ["sleep", "weird\rvalue"]);
    const result = await runComplete(dir, ["dataset", "list", "--task", ""]);
    expect(result.exitCode).toBe(0);
    expect(result.candidates).toEqual(["sleep"]);
    expect(result.directiveLine).toBe(":4");
  });

  test("a clean cache with no control characters is unaffected (no false-positive dropping)", async () => {
    writeTaskCache(dir, ["sleep", "rest", "motor-imagery"]);
    const result = await runComplete(dir, ["dataset", "list", "--task", ""]);
    expect(result.exitCode).toBe(0);
    expect(result.candidates.sort()).toEqual(["motor-imagery", "rest", "sleep"]);
    expect(result.directiveLine).toBe(":4");
  });
});
