/**
 * Upload S3 step: copy accounting, the not-annexed guard, and the save step that
 * must not re-read annexed content.
 *
 * `git annex add` stages unlocked files with zero stat data, so the save's
 * `git add -A` streams every annexed file through git-annex filter-process to learn
 * that it is unchanged. The tee-metered test below counts those bytes.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { saveDataset, setAssumeUnchanged } from "../src/lib/git-annex/clone-push";
import { gitAnnexAdd } from "../src/lib/git-annex/init";
import { copyPathsToAnnexRemote, copyToAnnexRemote } from "../src/lib/git-annex/transfer";
import {
  findDataFilesNotAnnexed,
  formatUploadSummary,
  listAnnexedPaths,
} from "../src/lib/upload/transfer";
import {
  initDirectoryRemote,
  newDatasetRepo as makeRepo,
  makeScratch,
  meterFilterProcess,
  recorded,
  run,
  writeFile,
} from "./helpers/annex-repo";

// parseCopyJson and extractCopyJsonError are exercised against captured, real git-annex
// output in test/copy-json-real.unit.test.ts: hand-written error JSON hid a bug here.

describe("formatUploadSummary", () => {
  test("a resume where git-annex checked everything says so instead of 'Uploaded 0'", () => {
    expect(formatUploadSummary(165, 0, 0)).toBe(
      "All 165 data files are already at the S3 remote (git-annex checked each one; nothing to copy)",
    );
  });

  test("states sent, already-present and recorded totals", () => {
    expect(formatUploadSummary(10, 4, 4)).toBe(
      "Uploaded 4 data files to S3; 6 were already at the remote; all recorded at the remote",
    );
    expect(formatUploadSummary(4, 4, 0)).toBe(
      "4 data files not yet recorded at the S3 remote were copied (git-annex confirmed 0 of 4; the rest are recorded in the location log); all recorded at the remote",
    );
  });
});

describe("findDataFilesNotAnnexed", () => {
  test("a large data file left out of the annex blocks; a small one is only reported", () => {
    const targets = [
      { path: "a.edf", size: 5_000_000 },
      { path: "b.edf", size: 5_000_000 },
      { path: "tiny.EDF", size: 2_000 },
      { path: "meta.json", size: 9_000_000, type: "metadata" },
    ];
    const out = findDataFilesNotAnnexed(targets, new Set(["a.edf"]));
    expect(out.blocking.map((f) => f.path)).toEqual(["b.edf"]);
    expect(out.small.map((f) => f.path)).toEqual(["tiny.EDF"]);
  });

  test("the boundary is the annex size threshold: 100,000 bytes is small, 100,001 blocks", () => {
    // Literals, not the constant: git-annex annexes more than 100,000 bytes and nothing
    // less (test/annex-policy.test.ts runs it), so a file the annex left out at exactly
    // these sizes is small at the first and blocking at the second.
    const targets = [
      { path: "at.edf", size: 100_000 },
      { path: "over.edf", size: 100_001 },
    ];
    const out = findDataFilesNotAnnexed(targets, new Set());
    expect(out.small.map((f) => f.path)).toEqual(["at.edf"]);
    expect(out.blocking.map((f) => f.path)).toEqual(["over.edf"]);
  });
});

// ---------------------------------------------------------------------------
// Real git-annex
// ---------------------------------------------------------------------------

// Each test builds a repository and runs git-annex a few times; CI machines are slower
// than the 5 s default allows.
setDefaultTimeout(60_000);

const scratch = makeScratch("nemar-upload-copy-verify");
const newDatasetRepo = (name: string) => makeRepo(scratch.root, name);

beforeAll(async () => {
  const probe = await run(["git", "annex", "version"]);
  if (probe.exitCode !== 0) throw new Error("git-annex is required for this test file");
});

afterAll(() => scratch.cleanup());

describe("copy accounting against a real special remote", () => {
  test("filesCopied counts every file the remote now has, including a re-run", async () => {
    const dir = await newDatasetRepo("count");
    const files = ["sub-01/eeg/a.edf", "sub-01/eeg/b.edf", "sub-02/eeg/c.edf"];
    for (const f of files) writeFile(dir, f, f.repeat(500));
    expect((await gitAnnexAdd(dir, files)).success).toBe(true);
    await initDirectoryRemote(scratch.root, dir, "store");

    const first = await copyPathsToAnnexRemote(dir, "store", files, 2);
    expect(first).toMatchObject({ success: true, filesCopied: 3, filesSent: 3 });
    const again = await copyToAnnexRemote(dir, "store", 2);
    // Found already at the store: reported as copied, but nothing was sent.
    expect(again).toMatchObject({ success: true, filesCopied: 3, filesSent: 0 });
    expect(await listAnnexedPaths(dir, "store")).toEqual(new Set(files));
  });
});

describe("saveDataset with skipContentCheck", () => {
  test("commits the staged pointers without streaming annexed content to the filter", async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 7);
    const runOnce = async (skip: boolean): Promise<{ bytes: number; dir: string }> => {
      const dir = await newDatasetRepo(skip ? "save-skip" : "save-plain");
      writeFile(dir, "sub-01/eeg/a.edf", big);
      writeFile(dir, "sub-01/eeg/b.edf", Buffer.alloc(2 * 1024 * 1024, 9));
      writeFile(dir, "dataset_description.json", '{"Name":"x"}');
      expect((await gitAnnexAdd(dir, ["sub-01/eeg/a.edf", "sub-01/eeg/b.edf"])).success).toBe(true);
      const log = await meterFilterProcess(dir);
      const annexed = [...(await listAnnexedPaths(dir))];
      expect(annexed.sort()).toEqual(["sub-01/eeg/a.edf", "sub-01/eeg/b.edf"]);
      const res = await saveDataset(
        dir,
        "upload",
        undefined,
        skip ? { skipContentCheck: recorded(dir, annexed) } : {},
      );
      expect(res).toEqual({ success: true });
      return { bytes: readFileSync(log).length, dir };
    };

    const plain = await runOnce(false);
    const skipped = await runOnce(true);
    // Control: the plain add re-reads both 2 MiB files through the filter. The margin over
    // exactly 4 MiB is only the protocol's framing, so the bound is "at least".
    expect(plain.bytes).toBeGreaterThanOrEqual(4 * 1024 * 1024);
    // With the skip, only the small metadata file goes through it.
    expect(skipped.bytes).toBeLessThan(64 * 1024);

    // Same commit either way: two annex pointers plus the metadata file in git.
    for (const { dir } of [plain, skipped]) {
      const tree = await run(["git", "ls-tree", "-r", "--name-only", "HEAD"], dir);
      const paths = tree.stdout.split("\n").filter(Boolean);
      for (const p of ["dataset_description.json", "sub-01/eeg/a.edf", "sub-01/eeg/b.edf"]) {
        expect(paths).toContain(p);
      }
      const blob = await run(["git", "cat-file", "-p", "HEAD:sub-01/eeg/a.edf"], dir);
      expect(blob.stdout.startsWith("/annex/objects/")).toBe(true);
    }

    // The assume-unchanged bits are cleared afterwards (lowercase tag = set).
    const tags = await run(["git", "ls-files", "-v", "sub-01/eeg"], skipped.dir);
    expect(
      tags.stdout
        .split("\n")
        .filter(Boolean)
        .every((l) => l.startsWith("H ")),
    ).toBe(true);
  });

  test("a deleted annexed path is not masked, so its removal is committed", async () => {
    const dir = await newDatasetRepo("save-delete");
    writeFile(dir, "sub-01/eeg/a.edf", "a".repeat(200_000));
    writeFile(dir, "sub-01/eeg/b.edf", "b".repeat(200_000));
    expect((await gitAnnexAdd(dir, ["sub-01/eeg/a.edf", "sub-01/eeg/b.edf"])).success).toBe(true);
    expect((await saveDataset(dir, "first")).success).toBe(true);
    const entries = recorded(dir, ["sub-01/eeg/a.edf", "sub-01/eeg/b.edf"]);
    rmSync(join(dir, "sub-01/eeg/b.edf"), { force: true });
    const res = await saveDataset(dir, "second", undefined, { skipContentCheck: entries });
    expect(res.success).toBe(true);
    const tree = await run(["git", "ls-tree", "-r", "--name-only", "HEAD"], dir);
    expect(tree.stdout).toContain("sub-01/eeg/a.edf");
    expect(tree.stdout).not.toContain("sub-01/eeg/b.edf");
  });

  test("setAssumeUnchanged round-trips", async () => {
    const dir = await newDatasetRepo("assume");
    writeFile(dir, "x.edf", "x".repeat(200_000));
    expect((await gitAnnexAdd(dir, ["x.edf"])).success).toBe(true);
    expect((await setAssumeUnchanged(dir, ["x.edf"], true)).success).toBe(true);
    expect((await run(["git", "ls-files", "-v", "x.edf"], dir)).stdout.startsWith("h ")).toBe(true);
    expect((await setAssumeUnchanged(dir, ["x.edf"], false)).success).toBe(true);
    expect((await run(["git", "ls-files", "-v", "x.edf"], dir)).stdout.startsWith("H ")).toBe(true);
  });
});
