/**
 * What a save does when git itself fails, the repository is not where the caller
 * stands, or the process is interrupted.
 *
 * The skip of annexed content (see upload-save-skip.unit.test.ts) leaves an
 * assume-unchanged bit on files while it works, and a bit that survives hides every
 * later edit to that file. So each way the bookkeeping around that bit can fail has
 * to end in a failed save that says how to recover, never in `{success: true}` with
 * the user's change left out. The failures are induced through real repository state:
 * damaged index files, actual index locks and Git hooks. Git and git-annex produce
 * every result asserted here.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  clearStaleAssumeUnchanged,
  saveDataset,
  setAssumeUnchanged,
} from "../src/lib/git-annex/clone-push";
import {
  commitCount,
  makeScratch,
  trackedRepo as makeTrackedRepo,
  prependPostCommit,
  prependPreCommit,
  recorded,
  run,
  tags,
  writeFile,
} from "./helpers/annex-repo";

setDefaultTimeout(60_000);

const scratch = makeScratch("nemar-save-failures");
const canBlockAccess = process.getuid?.() !== 0;

beforeAll(async () => {
  const probe = await run(["git", "annex", "version"]);
  if (probe.exitCode !== 0) throw new Error("git-annex is required for this test file");
});
afterAll(() => scratch.cleanup());

const trackedRepo = (name: string, files: Record<string, number>) =>
  makeTrackedRepo(scratch.root, name, files);

/** A committed repo whose `edit.edf` has since been changed: a save has something to say. */
async function dirtyRepo(name: string) {
  const dir = await trackedRepo(name, { "keep.edf": 3_000, "edit.edf": 3_000 });
  expect((await saveDataset(dir, "first")).success).toBe(true);
  writeFileSync(join(dir, "edit.edf"), "edited".repeat(600));
  return dir;
}

/** Paths changed by the newest commit. */
async function lastCommitPaths(dir: string): Promise<string[]> {
  const out = await run(["git", "show", "--name-only", "--format=", "HEAD"], dir);
  return out.stdout.split("\n").filter(Boolean);
}

describe("a save that cannot look for stale flags fails instead of saying it saved", () => {
  test("a corrupt index prevents the save from checking stale flags", async () => {
    const dir = await dirtyRepo("list-fails");
    const before = await commitCount(dir);
    const indexPath = join(dir, ".git", "index");
    const index = readFileSync(indexPath);
    writeFileSync(indexPath, "not a git index\n");
    let res: Awaited<ReturnType<typeof saveDataset>>;
    try {
      res = await saveDataset(dir, "second");
    } finally {
      writeFileSync(indexPath, index);
    }

    expect(res.success).toBe(false);
    expect(res.error).toContain("Could not check this repository for assume-unchanged flags");
    expect(res.error).toContain("index");
    expect(res.error).toContain("nothing was saved");
    expect(await commitCount(dir)).toBe(before);
  });

  test("when a flag is known to exist and cannot be cleared, the save fails and the next one heals", async () => {
    // The worst case: the flag hides the edit, so a "successful" save would commit
    // nothing and `git status` would be clean. The edit must NOT be lost silently.
    const dir = await dirtyRepo("clear-fails");
    expect((await setAssumeUnchanged(dir, ["edit.edf"], true)).success).toBe(true);
    // The flag really does hide the edit from git: this is why the failure matters.
    expect((await run(["git", "status", "--porcelain"], dir)).stdout.trim()).toBe("");
    const before = await commitCount(dir);

    const lock = join(dir, ".git", "index.lock");
    writeFileSync(lock, "", { flag: "wx" });
    let res: Awaited<ReturnType<typeof saveDataset>>;
    try {
      res = await saveDataset(dir, "second");
    } finally {
      rmSync(lock, { force: true });
    }

    expect(res.success).toBe(false);
    expect(res.error).toContain(
      "Found 1 assume-unchanged flag(s) on annexed files but could not clear them",
    );
    expect(res.error).toContain("index.lock");
    expect(res.error).toContain("every save clears them first");
    expect(await commitCount(dir)).toBe(before);

    // The advertised recovery: just save again.
    const healed = await saveDataset(dir, "third");
    expect(healed.success).toBe(true);
    expect(await lastCommitPaths(dir)).toEqual(["edit.edf"]);
    expect(await tags(dir, "edit.edf")).toEqual({ "edit.edf": "H" });
  });
});

describe("a save that finds stale flags does not skip anything", () => {
  test("an edit the flag hid is committed even though the plan's record already matches it", async () => {
    // Guards dropping the skip when flags were cleared on entry. The record in `entries`
    // was taken AFTER the edit the flag had been hiding, so its size and mtime match the
    // file and the stat guard alone would re-mark the path and `git add -A` would skip the
    // edit a second time. Reading every file on a save that found stale flags is the cure.
    const dir = await trackedRepo("stale-then-skip", { "a.edf": 3_000, "b.edf": 3_000 });
    expect((await saveDataset(dir, "first")).success).toBe(true);
    expect((await setAssumeUnchanged(dir, ["a.edf", "b.edf"], true)).success).toBe(true);
    writeFileSync(join(dir, "a.edf"), "edited".repeat(500));
    const entries = recorded(dir, ["a.edf", "b.edf"]);

    const res = await saveDataset(dir, "second", undefined, { skipContentCheck: entries });

    expect(res.success).toBe(true);
    expect(await lastCommitPaths(dir)).toEqual(["a.edf"]);
    expect(Object.values(await tags(dir))).toEqual(["H", "H"]);
  });
});

describe("stale flags on file names git would read as patterns", () => {
  test("names with brackets, stars, question marks, spaces and accents are cleared literally", async () => {
    // Guards `--literal-pathspecs` on the classification step. Under git's own matching
    // `star*.edf` also selects `starfish.edf`, and `[1] \u00e9.edf` is a character class that
    // matches a different name than itself, so the clear would miss some flagged files
    // and touch others.
    const names = ["[1] \u00e9.edf", "star*.edf", "q?.edf", "sp ace.edf"];
    const files: Record<string, number> = { "starfish.edf": 3_000 };
    for (const n of names) files[n] = 3_000;
    const dir = await trackedRepo("pattern-names", files);
    expect((await saveDataset(dir, "first")).success).toBe(true);
    expect((await setAssumeUnchanged(dir, names, true)).success).toBe(true);
    expect(Object.values(await tags(dir, ...names)).every((t) => t === "h")).toBe(true);

    const result = await clearStaleAssumeUnchanged(dir);

    expect(result).toEqual({ cleared: 4, found: 4 });
    expect(Object.values(await tags(dir)).every((t) => t === "H")).toBe(true);
  });
});

describe("flags a finished save could not take back", () => {
  async function skipSaveRepo(name: string) {
    // Names with spaces: the recovery has to work on paths a shell would split.
    const dir = await trackedRepo(name, {
      "sub 01/my file.edf": 3_000,
      "sub 01/other file.edf": 3_000,
    });
    const entries = recorded(dir, ["sub 01/my file.edf", "sub 01/other file.edf"]);
    return { dir, entries };
  }

  test("a real post-commit index lock leaves flags for the next save to clear", async () => {
    // Guards the failure return after the unmark. Warning and returning success would
    // leave `h` bits that hide every later edit to those files.
    const { dir, entries } = await skipSaveRepo("unmark-fails");
    const before = await commitCount(dir);
    const lock = join(dir, ".git", "index.lock");
    const restoreHook = prependPostCommit(dir, `touch "${lock}"`);
    let res: Awaited<ReturnType<typeof saveDataset>>;
    try {
      res = await saveDataset(dir, "upload", undefined, { skipContentCheck: entries });
    } finally {
      restoreHook();
      rmSync(lock, { force: true });
    }

    expect(res.success).toBe(false);
    expect(res.error).toContain("The save was committed, but 2 assume-unchanged flag(s)");
    expect(res.error).toContain("could not be cleared");
    expect(res.error).toContain("index.lock");
    expect(res.error).toContain("nemar dataset commit");
    expect(Object.values(await tags(dir)).sort()).toEqual(["h", "h"]);
    expect(await commitCount(dir)).toBe(before + 1);

    // The commit exists; only the flags are stuck. Edit a file, then run the save the
    // message names (the same function `nemar dataset commit` calls).
    writeFileSync(join(dir, "sub 01/my file.edf"), "later".repeat(700));
    const recovery = await saveDataset(dir, "recover");
    expect(recovery.success).toBe(true);
    expect(Object.values(await tags(dir))).toEqual(["H", "H"]);
    expect(await lastCommitPaths(dir)).toEqual(["sub 01/my file.edf"]);
  });
});

describe("a marked file that disappears or becomes unreadable during the save", () => {
  test("a file deleted while the save runs fails it", async () => {
    // Guards the post-commit check treating a vanished marked file as changed. A path
    // that no longer stats is not "unchanged": the commit carries a pointer to a file
    // the tree no longer has.
    const dir = await trackedRepo("vanish", { "a.edf": 3_000, "b.edf": 3_000 });
    const entries = recorded(dir, ["a.edf", "b.edf"]);
    prependPreCommit(dir, 'rm -f "$(git rev-parse --show-toplevel)/a.edf"');

    const res = await saveDataset(dir, "upload", undefined, { skipContentCheck: entries });

    expect(res.success).toBe(false);
    expect(res.error).toContain("disappeared");
    expect(res.error).toContain("a.edf");
    expect(await tags(dir, "b.edf")).toEqual({ "b.edf": "H" });
  });

  test.skipIf(!canBlockAccess)(
    "a file that becomes unreadable while the save runs fails it",
    async () => {
      const dir = await trackedRepo("unreadable", { "sub-01/a.edf": 3_000 });
      const entries = recorded(dir, ["sub-01/a.edf"]);
      prependPreCommit(dir, 'chmod 000 "$(git rev-parse --show-toplevel)/sub-01"');

      const res = await saveDataset(dir, "upload", undefined, { skipContentCheck: entries });

      expect(res.success).toBe(false);
      expect(res.error).toContain("became unreadable");
      expect(res.error).toContain("sub-01/a.edf");
    },
  );
});

describe("a save started from a subdirectory", () => {
  test("clears a stale flag outside its own subtree, so the edit there is saved", async () => {
    // Guards running the stale check at the repository's top level. `git ls-files -v`
    // lists only the subtree under the directory it runs in, so a flag in sub-02/ was
    // never seen by a save run from sub-01/, which reported success and left the edit out.
    const dir = await trackedRepo("subdir", { "sub-01/a.edf": 3_000, "sub-02/b.edf": 3_000 });
    expect((await saveDataset(dir, "first")).success).toBe(true);
    expect((await setAssumeUnchanged(dir, ["sub-02/b.edf"], true)).success).toBe(true);
    writeFileSync(join(dir, "sub-02/b.edf"), "edited".repeat(600));
    expect((await run(["git", "status", "--porcelain"], dir)).stdout.trim()).toBe("");

    const res = await saveDataset(join(dir, "sub-01"), "second");

    expect(res.success).toBe(true);
    expect(await tags(dir, "sub-02/b.edf")).toEqual({ "sub-02/b.edf": "H" });
    expect(await lastCommitPaths(dir)).toEqual(["sub-02/b.edf"]);
  });

  test("skip entries are relative to the directory it was called with", async () => {
    const dir = await trackedRepo("subdir-skip", { "sub-01/a.edf": 3_000, "sub-01/b.edf": 3_000 });
    const sub = join(dir, "sub-01");
    const entries = recorded(sub, ["a.edf", "b.edf"]);
    prependPreCommit(
      dir,
      'git ls-files -v -z > "$(git rev-parse --show-toplevel)/../flags-during"',
    );

    const res = await saveDataset(sub, "upload", undefined, { skipContentCheck: entries });

    expect(res).toEqual({ success: true });
    const during = readFileSync(join(dir, "..", "flags-during"), "utf-8").split("\0");
    expect(during.filter((e) => e.startsWith("h ")).sort()).toEqual([
      "h sub-01/a.edf",
      "h sub-01/b.edf",
    ]);
    expect(Object.values(await tags(dir)).every((t) => t === "H")).toBe(true);
  });

  test("a directory that is no repository at all is a failure with git's words", async () => {
    const res = await saveDataset(join(scratch.root, "nowhere"), "x");
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
  });
});

describe("an interrupted save takes its flags back", () => {
  test("SIGINT between mark and unmark clears them before the process dies", async () => {
    // Guards armUnmarkOnInterrupt. The save runs in its own process, held inside the
    // window by a pre-commit hook that records its pid and sleeps; the signal lands
    // while the paths are marked, and nothing but the handler can unmark them.
    const dir = await trackedRepo("sigint", { "a.edf": 3_000, "b.edf": 3_000 });
    const entries = recorded(dir, ["a.edf", "b.edf"]);
    const pidFile = join(dir, "..", `hook-${Math.random().toString(36).slice(2)}.pid`);
    prependPreCommit(dir, `echo $$ > "${pidFile}"; exec sleep 30`);

    const child = Bun.spawn(
      [
        "bun",
        "run",
        join(import.meta.dir, "helpers", "save-runner.ts"),
        dir,
        JSON.stringify(entries),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      // Wait until the hook is running, i.e. the paths are marked.
      for (let i = 0; i < 200 && !existsSync(pidFile); i++) await Bun.sleep(50);
      expect(existsSync(pidFile)).toBe(true);
      expect(Object.values(await tags(dir)).sort()).toEqual(["h", "h"]);

      child.kill("SIGINT");
      await child.exited;

      expect(Object.values(await tags(dir))).toEqual(["H", "H"]);
    } finally {
      // Let the orphaned commit die with its hook.
      try {
        process.kill(Number(readFileSync(pidFile, "utf-8").trim()));
      } catch {}
      child.kill("SIGKILL");
    }
  });
});
