/**
 * The save step's skip of annexed content, and what keeps it from hiding anything.
 *
 * Marking a path assume-unchanged hides it from `git add -A`, `git status` and the
 * commit. That is the point (it is what stops 1.6 TB being streamed through
 * git-annex filter-process again), and it is also exactly how an edit, a deletion
 * or a crash could be lost without a word. Each guard below is a way the skip could
 * have done that, exercised against real git-annex on a real repository with the
 * production init path. Where a test guards one particular line, its first comment
 * says which.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type SkipContentCheckEntry,
  clearStaleAssumeUnchanged,
  compareRecordedStat,
  describeChangedSinceTracked,
  saveDataset,
  setAssumeUnchanged,
} from "../src/lib/git-annex/clone-push";
import { gitAnnexAdd } from "../src/lib/git-annex/init";
import { collectFileManifest } from "../src/lib/git-annex/transfer";
import {
  initUploadProgress,
  isStepCompleted,
  readUploadProgress,
  writeUploadProgress,
} from "../src/lib/upload-progress";
import { SAVE_SKIP_MIN_BYTES, planSaveSkip, saveDatasetStep } from "../src/lib/upload/finalize";
import { listAnnexedPaths, trackDataFiles } from "../src/lib/upload/transfer";
import {
  commitCount,
  makeScratch,
  trackedRepo as makeTrackedRepo,
  meterFilterProcess,
  newDatasetRepo,
  prependPreCommit,
  recorded,
  run,
  tags,
  writeFile,
} from "./helpers/annex-repo";

// Each test builds a repository and runs git-annex a few times; CI is slower than 5 s allows.
setDefaultTimeout(60_000);

const scratch = makeScratch("nemar-save-skip");

beforeAll(async () => {
  const probe = await run(["git", "annex", "version"]);
  if (probe.exitCode !== 0) throw new Error("git-annex is required for this test file");
});
afterAll(() => scratch.cleanup());

const MIB = 1024 * 1024;

const trackedRepo = (name: string, files: Record<string, number>) =>
  makeTrackedRepo(scratch.root, name, files);

/** A whole-second instant: exact in seconds, so a file's mtime can be put back bit for bit. */
const PINNED_MTIME_S = 1_700_000_000;

/** Give a file the pinned mtime, so a later rewrite can restore exactly it. */
function pinMtime(dir: string, path: string): void {
  utimesSync(join(dir, path), PINNED_MTIME_S, PINNED_MTIME_S);
}

/** Push a file's mtime a few seconds past the one it was recorded with. */
function touchLater(dir: string, path: string, recordedMtimeMs: number): void {
  const later = (recordedMtimeMs + 5_000) / 1000;
  utimesSync(join(dir, path), later, later);
}

describe("the stat guard: a changed file fails the save", () => {
  test("an edit between tracking and save fails the save, naming the file, and commits nothing", async () => {
    // Guards `check.changed.length > 0` in saveDataset. Without it the file is flagged
    // assume-unchanged, `git add -A` skips it, and the commit carries the pointer that was
    // uploaded while the tree holds different bytes.
    const dir = await trackedRepo("guard-edit", { "a.edf": 3_000, "b.edf": 3_000 });
    const entries = recorded(dir, ["a.edf", "b.edf"]);
    const before = await commitCount(dir);

    // Same size, different content, later mtime: the case size alone cannot see.
    writeFileSync(join(dir, "a.edf"), "y".repeat(3_000));
    touchLater(dir, "a.edf", entries[0].mtimeMs);

    const res = await saveDataset(dir, "upload", undefined, { skipContentCheck: entries });

    expect(res.success).toBe(false);
    expect(res.error).toContain("1 annexed file(s) changed since the upload plan recorded them");
    expect(res.error).toContain("a.edf");
    expect(res.error).not.toContain("b.edf");
    expect(res.error).toContain("Re-run the upload command to re-track them");
    // A file that stopped being data is dropped from the skip before the compare, so the
    // hint for it is not reachable here.
    expect(res.error).not.toContain("--restart");
    expect(await commitCount(dir)).toBe(before);
    // Nothing was marked, so nothing is left behind.
    expect(await tags(dir, "a.edf", "b.edf")).toEqual({ "a.edf": "H", "b.edf": "H" });
  });

  test("a size change fails too, and a long list is cut to the first few", async () => {
    const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}.edf`, 3_000]));
    const dir = await trackedRepo("guard-many", files);
    const paths = Object.keys(files);
    const entries = recorded(dir, paths);
    for (const p of paths) writeFileSync(join(dir, p), "z".repeat(3_100));

    const res = await saveDataset(dir, "upload", undefined, { skipContentCheck: entries });
    expect(res.success).toBe(false);
    expect(res.error).toContain("6 annexed file(s) changed since the upload plan recorded them");
    expect(res.error).toContain("(and 3 more)");
    expect(res.error?.match(/f\d\.edf/g)).toHaveLength(3);
  });

  test("a file that changes while the save runs fails it, and the flags are still cleared", async () => {
    // Guards the check after the commit. A pre-commit hook is a real way for a file to
    // change under a running save: it runs after the add and before the commit exists.
    const dir = await trackedRepo("guard-during", { "a.edf": 3_000, "b.edf": 3_000 });
    const entries = recorded(dir, ["a.edf", "b.edf"]);
    prependPreCommit(
      dir,
      'sleep 0.05; echo changed-during-the-save >> "$(git rev-parse --show-toplevel)/a.edf"',
    );

    const res = await saveDataset(dir, "upload", undefined, { skipContentCheck: entries });

    expect(res.success).toBe(false);
    expect(res.error).toContain("while the save was running");
    expect(res.error).toContain("a.edf");
    expect(await tags(dir, "a.edf", "b.edf")).toEqual({ "a.edf": "H", "b.edf": "H" });
  });

  test("compareRecordedStat sorts unchanged from changed, and leaves a deleted path out of both", async () => {
    const dir = await trackedRepo("compare", {
      "keep.edf": 3_000,
      "edit.edf": 3_000,
      "gone.edf": 3_000,
    });
    const entries = recorded(dir, ["keep.edf", "edit.edf", "gone.edf"]);
    writeFileSync(join(dir, "edit.edf"), "q".repeat(3_001));
    rmSync(join(dir, "gone.edf"));
    const out = compareRecordedStat(dir, entries);
    expect(out.unchanged.map((e) => e.path)).toEqual(["keep.edf"]);
    expect(out.changed).toEqual(["edit.edf"]);
  });

  test("a different size is a change even when the mtime was put back", async () => {
    // Guards the size half of the comparison. rsync -t, cp -p and tar all restore an
    // mtime, so a file can come back with the recorded mtime and different bytes; the
    // earlier test rewrote size AND mtime together and could not tell the halves apart.
    const dir = await trackedRepo("size-only", { "a.edf": 3_000 });
    pinMtime(dir, "a.edf");
    const entries = recorded(dir, ["a.edf"]);
    writeFileSync(join(dir, "a.edf"), "q".repeat(3_001));
    pinMtime(dir, "a.edf");
    expect(statSync(join(dir, "a.edf")).mtimeMs).toBe(entries[0].mtimeMs);
    expect(compareRecordedStat(dir, entries).changed).toEqual(["a.edf"]);
  });

  test("an mtime moved by a second is a change even when the size and bytes match", async () => {
    const dir = await trackedRepo("mtime", { "a.edf": 3_000 });
    const entries = recorded(dir, ["a.edf"]);
    const later = new Date(entries[0].mtimeMs + 1_000);
    utimesSync(join(dir, "a.edf"), later, later);
    expect(compareRecordedStat(dir, entries).changed).toEqual(["a.edf"]);
  });

  test("describeChangedSinceTracked cannot be split or colored by a file name", () => {
    // Guards displayNames: a name is the user's data, and a newline or an ESCAPE in it
    // must not split the message or reach the terminal.
    const text = describeChangedSinceTracked(["a\nb.edf", "c\x1b[2J.edf"], "before");
    expect(text).toContain("a\\nb.edf, c\\x1b[2J.edf");
    expect(text).not.toContain("\n");
    expect(text).not.toContain("\x1b");
  });

  test("describeChangedSinceTracked says what to do", () => {
    expect(describeChangedSinceTracked(["a.edf"], "before")).toBe(
      "1 annexed file(s) changed since the upload plan recorded them, so the commit would not match the tree: a.edf. Re-run the upload command to re-track them.",
    );
    expect(describeChangedSinceTracked(["a.edf", "b.edf"], "during")).toBe(
      "2 annexed file(s) changed, disappeared or became unreadable while the save was running, so the commit does not match the tree: a.edf, b.edf. Re-run the upload command to re-track them.",
    );
  });
});

describe("stale flags: an interrupted save does not hide later edits", () => {
  test("an annexed file left flagged by a killed save has its edit saved by the next one", async () => {
    // Guards clearStaleAssumeUnchanged at the entry of saveDataset. The bit lives in the
    // index, so a Ctrl-C between mark and unmark leaves it there; without the clear,
    // `git add -A` omits this file's edits from every later save, including the plain
    // `nemar dataset update` path that passes no skip at all.
    const dir = await trackedRepo("stale-edit", { "a.edf": 3_000, "b.edf": 3_000 });
    expect((await saveDataset(dir, "first")).success).toBe(true);
    expect((await setAssumeUnchanged(dir, ["a.edf", "b.edf"], true)).success).toBe(true);
    expect(await tags(dir, "a.edf", "b.edf")).toEqual({ "a.edf": "h", "b.edf": "h" });

    writeFileSync(join(dir, "a.edf"), "w".repeat(3_500));
    const res = await saveDataset(dir, "second");

    expect(res.success).toBe(true);
    expect(await tags(dir, "a.edf", "b.edf")).toEqual({ "a.edf": "H", "b.edf": "H" });
    // The edit reached the commit: the pointer for a.edf changed.
    const changed = await run(["git", "show", "--name-only", "--format=", "HEAD"], dir);
    expect(changed.stdout.split("\n").filter(Boolean)).toEqual(["a.edf"]);
  });

  test("a flagged annexed file that was deleted has its deletion saved", async () => {
    const dir = await trackedRepo("stale-delete", { "a.edf": 3_000, "b.edf": 3_000 });
    expect((await saveDataset(dir, "first")).success).toBe(true);
    expect((await setAssumeUnchanged(dir, ["b.edf"], true)).success).toBe(true);
    rmSync(join(dir, "b.edf"));

    expect((await saveDataset(dir, "second")).success).toBe(true);
    const tree = await run(["git", "ls-tree", "-r", "--name-only", "HEAD"], dir);
    expect(tree.stdout).toContain("a.edf");
    expect(tree.stdout).not.toContain("b.edf");
  });

  test("a flag on a file that is not annexed is not ours and is left alone", async () => {
    const dir = await trackedRepo("stale-foreign", { "a.edf": 3_000 });
    writeFile(dir, "notes.txt", "mine");
    expect((await saveDataset(dir, "first")).success).toBe(true);
    expect((await setAssumeUnchanged(dir, ["notes.txt"], true)).success).toBe(true);
    writeFileSync(join(dir, "notes.txt"), "mine, edited, deliberately kept out of commits");

    expect(await clearStaleAssumeUnchanged(dir)).toEqual({ cleared: 0, found: 0 });
    expect((await saveDataset(dir, "second")).success).toBe(true);
    expect(await tags(dir, "notes.txt")).toEqual({ "notes.txt": "h" });
  });

  test("a locked (symlink) annexed file is recognized as annexed too", async () => {
    // The dataset repos here are unlocked, but a clone made elsewhere can hold locked
    // files, and the recognition must not depend on which kind the index holds.
    const dir = join(scratch.root, "locked-repo");
    expect((await run(["git", "init", "-q", "-b", "main", dir])).exitCode).toBe(0);
    await run(["git", "config", "user.email", "test@test.com"], dir);
    await run(["git", "config", "user.name", "Test"], dir);
    expect((await run(["git", "annex", "init"], dir)).exitCode).toBe(0);
    writeFile(dir, "sub-01/eeg/a.edf", 3_000);
    expect(
      (await run(["git", "annex", "add", "--force-large", "sub-01/eeg/a.edf"], dir)).exitCode,
    ).toBe(0);
    expect((await run(["git", "commit", "-q", "-m", "add"], dir)).exitCode).toBe(0);
    const mode = (await run(["git", "ls-files", "-s", "sub-01/eeg/a.edf"], dir)).stdout;
    expect(mode.startsWith("120000")).toBe(true);
    expect((await setAssumeUnchanged(dir, ["sub-01/eeg/a.edf"], true)).success).toBe(true);

    expect(await clearStaleAssumeUnchanged(dir)).toEqual({ cleared: 1, found: 1 });
    expect(await tags(dir, "sub-01/eeg/a.edf")).toEqual({ "sub-01/eeg/a.edf": "H" });
  });

  test("a repository with no flags costs one index read and reports nothing cleared", async () => {
    const dir = await trackedRepo("stale-none", { "a.edf": 3_000 });
    expect(await clearStaleAssumeUnchanged(dir)).toEqual({ cleared: 0, found: 0 });
  });

  test("a directory git cannot list reports the error instead of a clean result", async () => {
    // The scratch root is outside any repository; a directory that does not exist at all
    // makes the spawn itself fail, and neither may escape as a throw out of a save.
    for (const dir of [scratch.root, join(scratch.root, "no-such-directory")]) {
      const out = await clearStaleAssumeUnchanged(dir);
      expect(out.cleared).toBe(0);
      expect(out.error).toBeTruthy();
    }
  });
});

describe("the bits never outlive the save", () => {
  test("a save whose commit fails still clears them", async () => {
    // Guards the unmark in saveDataset's `finally`. A failing pre-commit hook is a real
    // way for the commit to fail after the paths were marked.
    const dir = await trackedRepo("finally-fail", { "a.edf": 3_000, "b.edf": 3_000 });
    const entries = recorded(dir, ["a.edf", "b.edf"]);
    prependPreCommit(dir, "exit 1");

    const res = await saveDataset(dir, "upload", undefined, { skipContentCheck: entries });

    expect(res.success).toBe(false);
    expect(await tags(dir, "a.edf", "b.edf")).toEqual({ "a.edf": "H", "b.edf": "H" });
  });

  test("a successful save clears them too", async () => {
    const dir = await trackedRepo("finally-ok", { "a.edf": 3_000, "b.edf": 3_000 });
    const entries = recorded(dir, ["a.edf", "b.edf"]);
    const res = await saveDataset(dir, "upload", undefined, { skipContentCheck: entries });
    expect(res).toEqual({ success: true });
    expect(await tags(dir, "a.edf", "b.edf")).toEqual({ "a.edf": "H", "b.edf": "H" });
  });
});

describe("a failure to mark degrades to the plain save", () => {
  test("an entry git cannot mark warns, saves everything, and leaves no flags", async () => {
    // Guards the marking branch. `untracked.edf` is on disk with a matching stat but is
    // not in the index, which makes `git update-index --assume-unchanged` fail for the
    // whole list. The save must proceed without the skip rather than refuse.
    const dir = await trackedRepo("mark-fails", { "a.edf": 3_000 });
    writeFile(dir, "untracked.edf", 3_000);
    const entries = recorded(dir, ["a.edf", "untracked.edf"]);
    // The premise, asserted rather than assumed: git really cannot mark this list.
    expect((await setAssumeUnchanged(dir, ["a.edf", "untracked.edf"], true)).success).toBe(false);

    const res = await saveDataset(dir, "upload", undefined, { skipContentCheck: entries });

    expect(res).toEqual({ success: true });
    const tree = await run(["git", "ls-tree", "-r", "--name-only", "HEAD"], dir);
    expect(tree.stdout).toContain("a.edf");
    expect(tree.stdout).toContain("untracked.edf");
    expect(Object.values(await tags(dir))).toEqual(["H", "H"]);
  });
});

describe("planSaveSkip and the size gate", () => {
  test("the default threshold is one gibibyte", () => {
    expect(SAVE_SKIP_MIN_BYTES).toBe(1_073_741_824);
  });

  test("below the threshold there is no plan; at it, every path with a recorded mtime is in it", async () => {
    const dir = await trackedRepo("plan", { "a.edf": 3_000, "b.edf": 5_000 });
    const manifest = await collectFileManifest(dir);
    const progress = initUploadProgress(dir, "nm000990", manifest.files);
    const annexed = await listAnnexedPaths(dir);

    expect(planSaveSkip(progress, annexed)).toBeNull();
    expect(planSaveSkip(progress, annexed, 8_001)).toBeNull();
    const plan = planSaveSkip(progress, annexed, 8_000);
    expect(plan?.map((e) => e.path).sort()).toEqual(["a.edf", "b.edf"]);
    expect(plan?.map((e) => e.size).sort()).toEqual([3_000, 5_000]);

    // A path with no recorded mtime cannot be vouched for, so it is read as before.
    progress.files["a.edf"].mtimeMs = undefined;
    expect(planSaveSkip(progress, annexed, 1)?.map((e) => e.path)).toEqual(["b.edf"]);
    // And a path the progress never saw is not skippable either.
    expect(planSaveSkip(progress, new Set(["stranger.edf"]), 0)).toEqual([]);
  });

  /** Two 2 MiB annexed recordings plus a small JSON, tracked and ready to save. */
  async function bigRepo(name: string) {
    const dir = await newDatasetRepo(scratch.root, name);
    writeFile(dir, "sub-01/eeg/a.edf", Buffer.alloc(2 * MIB, 7));
    writeFile(dir, "sub-01/eeg/b.edf", Buffer.alloc(2 * MIB, 9));
    writeFile(dir, "dataset_description.json", '{"Name":"x"}');
    expect((await gitAnnexAdd(dir, ["sub-01/eeg/a.edf", "sub-01/eeg/b.edf"])).success).toBe(true);
    const manifest = await collectFileManifest(dir);
    const progress = initUploadProgress(
      dir,
      "nm000991",
      manifest.files.filter((f) => f.type === "data"),
    );
    const log = await meterFilterProcess(dir);
    const probe = join(dir, "..", `${Math.random().toString(36).slice(2)}.flags`);
    // The pre-commit hook runs INSIDE the window, after the paths are marked and before
    // they are unmarked, so it sees exactly which paths the save chose to skip.
    prependPreCommit(dir, `git ls-files -v -z > "${probe}"`);
    return { dir, progress, log, probe, annexed: await listAnnexedPaths(dir) };
  }

  /** The paths that carried the assume-unchanged tag while the commit was being made. */
  function skippedDuringSave(probe: string): string[] {
    return readFileSync(probe, "utf-8")
      .split("\0")
      .filter((e) => /^[a-z] /.test(e))
      .map((e) => e.slice(2))
      .sort();
  }

  test("control: below the threshold the save reads the annexed content exactly as before", async () => {
    // Guards the threshold. With the default one gibibyte, a 4 MiB tree takes the plain
    // path: nothing is marked, and both files stream through the filter.
    const { dir, progress, log, probe, annexed } = await bigRepo("gate-below");
    const step = await saveDatasetStep(dir, undefined, progress, { annexedPaths: annexed });
    expect(step.status).toBe("ok");
    expect(isStepCompleted(progress, "dataset_save")).toBe(true);
    expect(skippedDuringSave(probe)).toEqual([]);
    expect(readFileSync(log).length).toBeGreaterThan(4 * MIB);
  });

  test("above the threshold the save skips the re-read and still commits the same tree", async () => {
    const { dir, progress, log, probe, annexed } = await bigRepo("gate-above");
    const step = await saveDatasetStep(dir, undefined, progress, {
      annexedPaths: annexed,
      skipMinBytes: MIB,
    });
    expect(step.status).toBe("ok");
    expect(skippedDuringSave(probe)).toEqual(["sub-01/eeg/a.edf", "sub-01/eeg/b.edf"]);
    expect(readFileSync(log).length).toBeLessThan(64 * 1024);
    const tree = await run(["git", "ls-tree", "-r", "--name-only", "HEAD"], dir);
    for (const p of ["dataset_description.json", "sub-01/eeg/a.edf", "sub-01/eeg/b.edf"]) {
      expect(tree.stdout).toContain(p);
    }
    const blob = await run(["git", "cat-file", "-p", "HEAD:sub-01/eeg/a.edf"], dir);
    expect(blob.stdout.startsWith("/annex/objects/")).toBe(true);
    expect(Object.values(await tags(dir, "sub-01/eeg/a.edf", "sub-01/eeg/b.edf"))).toEqual([
      "H",
      "H",
    ]);
  });

  test("when the S3 step handed on no annexed set, the save lists it itself", async () => {
    const { dir, progress, probe } = await bigRepo("gate-list");
    const step = await saveDatasetStep(dir, undefined, progress, { skipMinBytes: MIB });
    expect(step.status).toBe("ok");
    expect(skippedDuringSave(probe)).toEqual(["sub-01/eeg/a.edf", "sub-01/eeg/b.edf"]);
  });

  test("only the paths the S3 step handed on are skipped", async () => {
    // Guards the set being used as given: a set narrowed to this run's targets would
    // silently re-read every annexed file an earlier run left, which is what a resume has.
    const { dir, progress, probe } = await bigRepo("gate-forwarded");
    await saveDatasetStep(dir, undefined, progress, {
      annexedPaths: new Set(["sub-01/eeg/a.edf"]),
      skipMinBytes: MIB,
    });
    expect(skippedDuringSave(probe)).toEqual(["sub-01/eeg/a.edf"]);
  });

  test("the gate is inclusive: exactly the recorded bytes opens it, one more byte keeps it shut", async () => {
    // Guards `>=` at the step's gate. The fixture holds exactly 4 MiB of annexed data.
    const open = await bigRepo("gate-exact-open");
    await saveDatasetStep(open.dir, undefined, open.progress, {
      annexedPaths: open.annexed,
      skipMinBytes: 4 * MIB,
    });
    expect(skippedDuringSave(open.probe)).toEqual(["sub-01/eeg/a.edf", "sub-01/eeg/b.edf"]);

    const shut = await bigRepo("gate-exact-shut");
    await saveDatasetStep(shut.dir, undefined, shut.progress, {
      annexedPaths: shut.annexed,
      skipMinBytes: 4 * MIB + 1,
    });
    expect(skippedDuringSave(shut.probe)).toEqual([]);
  });

  test("recorded bytes that reach the gate but a handed-on set that does not keep it shut", async () => {
    // Guards the gate inside planSaveSkip, which the step's own pre-check cannot stand in
    // for: the pre-check sums EVERY recorded data file, the plan only the annexed ones it
    // was given. Here the first reaches 4 MiB and the second sees only 2.
    const { dir, progress, probe } = await bigRepo("gate-narrowed");
    await saveDatasetStep(dir, undefined, progress, {
      annexedPaths: new Set(["sub-01/eeg/a.edf"]),
      skipMinBytes: 4 * MIB,
    });
    expect(skippedDuringSave(probe)).toEqual([]);
  });

  test("below the threshold the step does not even list the annexed files", async () => {
    // Guards the cheap pre-check in saveDatasetStep. A plain git repository makes
    // `git annex find` fail, so a listing attempt is visible as the step's own notice;
    // a small tree must never attempt one.
    const notices: string[] = [];
    const original = console.log;
    const plain = join(scratch.root, "plain-git-repo");
    await run(["git", "init", "-q", "-b", "main", plain]);
    await run(["git", "config", "user.email", "test@test.com"], plain);
    await run(["git", "config", "user.name", "Test"], plain);
    writeFile(plain, "small.edf", 1_000);
    const progress = initUploadProgress(plain, "nm000992", [
      { path: "small.edf", size: 1_000, mtimeMs: 1 },
    ]);
    console.log = (...args: unknown[]) => {
      notices.push(args.join(" "));
    };
    try {
      expect((await saveDatasetStep(plain, undefined, progress)).status).toBe("ok");
      expect(notices.join("\n")).not.toContain("Could not list annexed files");

      // Control: over the threshold the same repository DOES attempt it, and says so.
      progress.completed_steps = [];
      writeFile(plain, "more.edf", 1_000);
      expect((await saveDatasetStep(plain, undefined, progress, { skipMinBytes: 1 })).status).toBe(
        "ok",
      );
      expect(notices.join("\n")).toContain("Could not list annexed files");
    } finally {
      console.log = original;
    }
  });

  test("a file that stopped being data since it was tracked is saved normally, not failed", async () => {
    // Guards dropFilesNoLongerData. A 150 KB annexed .bin cut to 50 KB is no longer data,
    // so it leaves the upload's data list; hasFileListChanged then says nothing changed and
    // nothing re-tracks it, and a skip that kept it would fail EVERY save for a file the
    // re-run cannot fix.
    const dir = await newDatasetRepo(scratch.root, "gate-shrunk");
    writeFile(dir, "sub-01/eeg/a.edf", Buffer.alloc(2 * MIB, 7));
    writeFile(dir, "big.bin", Buffer.alloc(150_000, 3));
    expect((await trackDataFiles(dir, ["sub-01/eeg/a.edf", "big.bin"])).success).toBe(true);
    const data = (await collectFileManifest(dir)).files.filter((f) => f.type === "data");
    expect(data.map((f) => f.path).sort()).toEqual(["big.bin", "sub-01/eeg/a.edf"]);
    const progress = initUploadProgress(dir, "nm000994", data);
    const annexed = await listAnnexedPaths(dir);
    const probe = join(dir, "..", `${Math.random().toString(36).slice(2)}.flags`);
    prependPreCommit(dir, `git ls-files -v -z > "${probe}"`);

    writeFileSync(join(dir, "big.bin"), Buffer.alloc(50_000, 4));
    touchLater(dir, "big.bin", progress.files["big.bin"].mtimeMs as number);
    // The premise: the upload's own manifest no longer lists it, so nothing re-tracks it.
    const now = (await collectFileManifest(dir)).files.filter((f) => f.type === "data");
    expect(now.map((f) => f.path)).toEqual(["sub-01/eeg/a.edf"]);

    const step = await saveDatasetStep(dir, undefined, progress, {
      annexedPaths: annexed,
      skipMinBytes: MIB,
    });

    expect(step.status).toBe("ok");
    expect(skippedDuringSave(probe)).toEqual(["sub-01/eeg/a.edf"]);
    // Committed as what it is now: a plain 50 KB file.
    const blob = await run(["git", "cat-file", "-s", "HEAD:big.bin"], dir);
    expect(blob.stdout.trim()).toBe("50000");
  });

  test("a progress file from before mtimes were recorded is read from disk, and its files are saved unskipped", async () => {
    // The on-disk shape an older CLI left: no mtimeMs on any file. It must still load
    // through the validator, and a path with no recorded mtime cannot be vouched for, so
    // it is read as before rather than skipped on a comparison nobody can make.
    const { dir, progress, probe } = await bigRepo("gate-legacy-progress");
    for (const file of Object.values(progress.files)) file.mtimeMs = undefined;
    writeUploadProgress(dir, progress);
    const onDisk = JSON.parse(readFileSync(join(dir, ".nemar", "upload-progress.json"), "utf-8"));
    expect(JSON.stringify(onDisk.files)).not.toContain("mtimeMs");

    const loaded = readUploadProgress(dir);
    expect(loaded).not.toBeNull();
    const step = await saveDatasetStep(dir, undefined, loaded as typeof progress, {
      annexedPaths: await listAnnexedPaths(dir),
      skipMinBytes: MIB,
    });

    expect(step.status).toBe("ok");
    expect(skippedDuringSave(probe)).toEqual([]);
  });

  test("a file edited since tracking fails the step and leaves dataset_save unstamped", async () => {
    const { dir, progress, annexed } = await bigRepo("gate-edit");
    writeFileSync(join(dir, "sub-01/eeg/a.edf"), Buffer.alloc(2 * MIB, 3));
    touchLater(dir, "sub-01/eeg/a.edf", progress.files["sub-01/eeg/a.edf"].mtimeMs as number);

    const step = await saveDatasetStep(dir, undefined, progress, {
      annexedPaths: annexed,
      skipMinBytes: MIB,
    });

    expect(step.status).toBe("fail");
    expect(isStepCompleted(progress, "dataset_save")).toBe(false);
  });
});
