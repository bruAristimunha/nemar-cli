/**
 * The reference-dataset comparison that the monthly bump runs before it opens its pull request.
 *
 * compare-gating.sh runs two validator releases over each dataset with the gate the central
 * workflow applies. These tests run the real script with the real validator, on the bids-minimal
 * fixture and on three generated layouts: a key-shaped annex link and an annex pointer (both the
 * layouts real datasets have, which no release changes), and a bare broken link (the detector for a
 * change in how a release reads a link to nothing). Published JSR releases never change, so the
 * known difference between 2.4.1 and 3.0.2 on the detector is a stable expectation. The tests need
 * the network (JSR and GitHub), so they belong to the integration tier. No mocks.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts/validator/compare-gating.sh");
const FIXTURE = join(ROOT, "test/fixtures/bids-minimal");
const ESCAPE = "\u001b";

/** Every directory a test creates, removed when the file's tests finish. */
const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** Run the script with exactly these arguments, and these environment variables on top of ours. */
function run(
  args: string[],
  env: Record<string, string> = {},
): { exitCode: number; stderr: string } {
  const proc = Bun.spawnSync(["bash", SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stderr: proc.stderr.toString() };
}

/** Run the script with an output directory of its own; returns that directory too. */
function compare(
  args: string[],
  env: Record<string, string> = {},
): { out: string; exitCode: number; stderr: string } {
  const out = freshDir("compare-gating-");
  return { out, ...run([...args, "--out", out], env) };
}

/** The rows of results.tsv, keyed by dataset: dataset, status, gating old, gating new, changed, note. */
function rows(out: string): Record<string, string[]> {
  const lines = readFileSync(join(out, "results.tsv"), "utf-8").trim().split("\n").slice(1);
  return Object.fromEntries(lines.map((line) => [line.split("\t")[0], line.split("\t")]));
}

function readOut(out: string, name: string): string {
  return readFileSync(join(out, name), "utf-8");
}

/** The script's own default reference ids, so a test checks the real list and not a copy of it. */
function defaultReferenceIds(): string[] {
  const line = readFileSync(SCRIPT, "utf-8").match(/^REFERENCE_IDS="([^"]+)"$/m);
  return line ? line[1].trim().split(/\s+/) : [];
}

describe("compare-gating.sh", () => {
  test("every default reference dataset is reachable without credentials, as in the bump job", async () => {
    const ids = defaultReferenceIds();
    expect(ids.length).toBeGreaterThan(0);
    // The bump job has no credentials, so this has none either: no global or system git
    // configuration (where a credential helper lives), no prompt, no askpass program, and a
    // working directory that is not a checkout (whose own configuration may hold a token).
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !["GIT_ASKPASS", "SSH_ASKPASS"].includes(name),
        ),
      ),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    };
    const cwd = freshDir("compare-ls-remote-");
    // Asynchronous, with a kill timer: a stalled connection must fail this test, not hang the run.
    const exitCodes = await Promise.all(
      ids.map(
        (id) =>
          Bun.spawn(
            [
              "git",
              "ls-remote",
              "--exit-code",
              `https://github.com/nemarDatasets/${id}.git`,
              "HEAD",
            ],
            { cwd, env, stdout: "ignore", stderr: "ignore", timeout: 60_000 },
          ).exited,
      ),
    );
    expect(ids.filter((_, index) => exitCodes[index] !== 0)).toEqual([]);
  }, 120_000);

  test("a release compared with itself changes nothing, on the fixture and all three layouts", () => {
    // The script makes its working copies in a directory under TMPDIR, so a directory of our own
    // shows what the script leaves behind.
    const scratch = freshDir("compare-scratch-");
    const run1 = compare(
      ["--old", "3.0.2", "--new", "3.0.2", "--ids", "", "--local", FIXTURE, "--canary"],
      { TMPDIR: scratch },
    );
    expect(run1.exitCode).toBe(0);
    expect(rows(run1.out)["bids-minimal"]?.slice(1, 5)).toEqual(["compared", "0", "0", "no"]);
    // A key-shaped annex link: the central gate filters it, and no release changes it.
    expect(rows(run1.out)["canary-annex-link"]?.slice(1, 5)).toEqual(["compared", "0", "0", "no"]);
    expect(rows(run1.out)["canary-annex-pointer"]?.slice(1, 5)).toEqual([
      "compared",
      "0",
      "0",
      "no",
    ]);
    // A bare broken link: under 3.0.2 the detector's sidecar error survives the filter.
    expect(rows(run1.out)["detector-bare-link"]?.slice(1, 5)).toEqual(["compared", "1", "1", "no"]);
    expect(readOut(run1.out, "summary.md")).toContain("Compared 4 of 4 datasets; 0 changed.");
    // The clones and the generated layouts are working copies, not evidence. They are made outside
    // the output directory, which the bump job uploads whole, and removed when the script exits.
    expect(existsSync(join(run1.out, "data"))).toBe(false);
    expect(readdirSync(scratch)).toEqual([]);
  }, 120_000);

  test("only the bare-link detector's gating verdict changes between 2.4.1 and 3.0.2", () => {
    const run2 = compare(["--old", "2.4.1", "--new", "3.0.2", "--ids", "", "--canary"]);
    expect(run2.exitCode).toBe(0);
    expect(rows(run2.out)["detector-bare-link"]?.slice(1, 5)).toEqual([
      "compared",
      "0",
      "1",
      "yes",
    ]);
    expect(rows(run2.out)["canary-annex-link"]?.slice(1, 5)).toEqual(["compared", "0", "0", "no"]);
    expect(rows(run2.out)["canary-annex-pointer"]?.slice(1, 5)).toEqual([
      "compared",
      "0",
      "0",
      "no",
    ]);
    expect(readOut(run2.out, "diff-detector-bare-link.txt")).toContain("SIDECAR_WITHOUT_DATAFILE");
    const summary = readOut(run2.out, "summary.md");
    expect(summary).toContain("### detector-bare-link");
    expect(summary).not.toContain("### canary-annex-link");
  }, 120_000);

  test("a reused output directory does not keep the diff of an earlier run", () => {
    const out = freshDir("compare-reuse-");
    expect(
      run(["--old", "2.4.1", "--new", "3.0.2", "--ids", "", "--canary", "--out", out]).exitCode,
    ).toBe(0);
    expect(readOut(out, "summary.md")).toContain("### detector-bare-link");
    expect(
      run(["--old", "3.0.2", "--new", "3.0.2", "--ids", "", "--canary", "--out", out]).exitCode,
    ).toBe(0);
    expect(readOut(out, "summary.md")).not.toContain("### detector-bare-link");
    expect(existsSync(join(out, "diff-detector-bare-link.txt"))).toBe(false);
  }, 120_000);

  test("a reference dataset is cloned and compared, and only the comparison is kept", () => {
    // The one test of a successful clone: a real clone of the public exemplar xx099900, one of the
    // script's default reference ids. What the dataset's own error counts are may change, so this
    // checks that it was cloned and compared (the same release on both sides never changes), and
    // that the clone is gone when the script exits.
    const scratch = freshDir("compare-clone-scratch-");
    const cloned = compare(["--old", "3.0.2", "--new", "3.0.2", "--ids", "xx099900"], {
      TMPDIR: scratch,
    });
    expect(cloned.exitCode).toBe(0);
    const row = rows(cloned.out).xx099900;
    expect(row?.[1]).toBe("compared");
    expect(row?.[4]).toBe("no");
    expect(existsSync(join(cloned.out, "data"))).toBe(false);
    expect(readdirSync(scratch)).toEqual([]);
  }, 120_000);

  test("a dataset that cannot be cloned fails the run, unless partial results are accepted", () => {
    const strict = compare(["--old", "3.0.2", "--new", "3.0.2", "--ids", "nm999999"]);
    expect(strict.exitCode).toBe(1);
    // The job log names the dataset and why, without opening the artifact.
    expect(strict.stderr).toContain("compare-gating.sh: nm999999 not compared: clone failed");
    expect(rows(strict.out).nm999999?.slice(1, 5)).toEqual(["not_compared", "-", "-", "-"]);
    expect(readOut(strict.out, "summary.md")).toContain(
      "Not compared, so not counted as unchanged: nm999999",
    );

    const partial = compare([
      "--old",
      "3.0.2",
      "--new",
      "3.0.2",
      "--ids",
      "nm999999",
      "--allow-partial",
    ]);
    expect(partial.exitCode).toBe(0);
    expect(readOut(partial.out, "summary.md")).toContain("Compared 0 of 1 datasets; 0 changed.");
  }, 120_000);

  test("a validator release that does not exist is a failed comparison, with plain messages", () => {
    const failed = compare(["--old", "99.0.0", "--new", "3.0.2", "--ids", "", "--canary"]);
    expect(failed.exitCode).toBe(1);
    const layout = rows(failed.out)["canary-annex-link"];
    expect(layout?.[1]).toBe("not_compared");
    expect(layout?.[5]).toContain("validator 99.0.0 exited");
    expect(layout?.[5]).toMatch(/exited 1: error: Could not find version/);
    expect(readOut(failed.out, "results.tsv")).not.toContain(ESCAPE);
    expect(readOut(failed.out, "summary.md")).toContain(
      "Not compared, so not counted as unchanged",
    );
  }, 120_000);

  // An unreadable subdirectory makes the real validator crash: an `error:` line, a source excerpt
  // and stack frames, so the run ends on a frame. Root reads any directory, so it cannot crash there.
  test.skipIf(process.getuid?.() === 0)(
    "a validator crash is named by its error line, not by the stack frame it ends with",
    () => {
      const dataset = freshDir("compare-crash-");
      cpSync(FIXTURE, dataset, { recursive: true });
      const locked = join(dataset, "sub-01");
      chmodSync(locked, 0o000);
      try {
        // FORCE_COLOR makes Deno colour the crash even though the script asks for NO_COLOR.
        const crashed = compare(
          ["--old", "3.0.2", "--new", "3.0.2", "--ids", "", "--local", dataset],
          { FORCE_COLOR: "1" },
        );
        expect(crashed.exitCode).toBe(1);
        const row = rows(crashed.out)[basename(dataset)];
        expect(row?.[1]).toBe("not_compared");
        expect(row?.[5]).toMatch(
          /^validator 3\.0\.2 exited 1: error: Uncaught \(in promise\) PermissionDenied/,
        );
        expect(row?.[5]).not.toContain(ESCAPE);
        expect(crashed.stderr).toContain(
          `compare-gating.sh: ${basename(dataset)} not compared: validator 3.0.2 exited 1: error:`,
        );
      } finally {
        chmodSync(locked, 0o755);
      }
    },
    120_000,
  );

  test("nothing to compare is a failure, not an empty pass", () => {
    expect(compare(["--old", "3.0.2", "--new", "3.0.2", "--ids", ""]).exitCode).toBe(1);
  });

  test("refuses to run without each required argument", () => {
    const out = freshDir("compare-args-");
    expect(run(["--new", "3.0.2", "--out", out]).exitCode).toBe(2);
    expect(run(["--old", "3.0.2", "--out", out]).exitCode).toBe(2);
    expect(run(["--old", "3.0.2", "--new", "3.0.2"]).exitCode).toBe(2);
    expect(run(["--old", "3.0.2", "--new", "3.0.2", "--out"]).exitCode).toBe(2);
  });

  test("refuses an output directory that cannot be created", () => {
    const blocker = join(freshDir("compare-blocker-"), "a-file");
    writeFileSync(blocker, "not a directory");
    expect(
      run([
        "--old",
        "3.0.2",
        "--new",
        "3.0.2",
        "--ids",
        "",
        "--canary",
        "--out",
        join(blocker, "sub"),
      ]).exitCode,
    ).toBe(1);
  });
});
