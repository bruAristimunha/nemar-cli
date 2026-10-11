/**
 * The tracking step hands data files to git-annex, and the CLI's reading of the
 * policy is authoritative where git-annex cannot read it (ADR 0031, amendment of
 * 2026-10-07).
 *
 * `shouldAnnex` folds case, so the upload plan calls `UPPER.EDF` and
 * `X_MOTION.tsv` data. git-annex's `include=` and `exclude=` globs are
 * case-sensitive, so left alone it keeps a small `UPPER.EDF` in git and keeps
 * `X_MOTION.tsv` in git at any size (`exclude=*.tsv` matches it, `include=*_motion.tsv`
 * does not). Every "what did git-annex do?" answer below is git-annex itself, run on
 * a real repository through the production init path.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { saveDataset } from "../src/lib/git-annex/clone-push";
import { gitAnnexAdd } from "../src/lib/git-annex/init";
import { isCaseVariantData, shouldAnnex } from "../src/lib/git-annex/policy";
import { findDataFilesNotAnnexed, trackDataFiles } from "../src/lib/upload/transfer";
import { annexedSet, makeScratch, newDatasetRepo, run, writeFile } from "./helpers/annex-repo";

// Each test builds a repository and runs git-annex a few times; CI machines are slower
// than the 5 s default allows.
setDefaultTimeout(60_000);

const scratch = makeScratch("nemar-track-data");

beforeAll(async () => {
  const probe = await run(["git", "annex", "version"]);
  if (probe.exitCode !== 0) throw new Error("git-annex is required for this test file");
});
afterAll(() => scratch.cleanup());

/**
 * Case variants of the data names, plus the motion case that is a refusal rather than a
 * report: `X_MOTION.tsv` is excluded by name at any size.
 */
const FIXTURES: Array<{ path: string; size: number; why: string }> = [
  { path: "sub-01/eeg/normal.edf", size: 5_000, why: "ordinary recording" },
  { path: "sub-01/eeg/lower.edf", size: 200_000, why: "ordinary large recording" },
  { path: "sub-01/eeg/UPPER.EDF", size: 200_000, why: "uppercase extension, over the threshold" },
  { path: "sub-01/eeg/Mixed.Edf", size: 150_000, why: "mixed-case extension, over the threshold" },
  {
    path: "sub-01/eeg/small_UPPER.EDF",
    size: 5_000,
    why: "uppercase extension, under the threshold",
  },
  { path: "sub-02/eeg/UPPER.SET", size: 300_000, why: "uppercase .SET, over the threshold" },
  {
    path: "sub-03/motion/sub-03_task-walk_tracksys-imu_MOTION.tsv",
    size: 200_000,
    why: "motion recording with an uppercase suffix, large: excluded by name",
  },
  {
    path: "sub-03/motion/sub-03_task-rest_tracksys-imu_MOTION.tsv",
    size: 800,
    why: "motion recording with an uppercase suffix, small",
  },
];

function toTargets(): Array<{ path: string; size: number; type: "data" }> {
  return FIXTURES.map((f) => ({ path: f.path, size: f.size, type: "data" }));
}

async function repoWithFixtures(name: string): Promise<string> {
  const dir = await newDatasetRepo(scratch.root, name);
  for (const f of FIXTURES) writeFile(dir, f.path, f.size);
  return dir;
}

describe("what git-annex does with case variants on its own", () => {
  test("the CLI calls every fixture data", () => {
    for (const f of FIXTURES) expect(shouldAnnex(f.path, f.size), f.path).toBe(true);
  });

  test("plain git-annex leaves some of them in git, and every such file is a flagged case variant", async () => {
    const dir = await repoWithFixtures("oracle");
    expect(
      (
        await gitAnnexAdd(
          dir,
          FIXTURES.map((f) => f.path),
        )
      ).success,
    ).toBe(true);
    const annexed = await annexedSet(dir);

    // Version-coupled premise, measured rather than assumed: git-annex matches these names
    // as written. If it ever matched them case-insensitively on its own (today only a
    // bracket class does, and the expression has none) these stop holding and the force
    // step is dead weight.
    expect(annexed.has("sub-01/eeg/normal.edf")).toBe(true);
    expect(annexed.has("sub-01/eeg/small_UPPER.EDF")).toBe(false);
    expect(annexed.has("sub-03/motion/sub-03_task-rest_tracksys-imu_MOTION.tsv")).toBe(false);
    expect(annexed.has("sub-03/motion/sub-03_task-walk_tracksys-imu_MOTION.tsv")).toBe(false);
    // Over the threshold, an uppercase extension annexes by size and needs no help.
    expect(annexed.has("sub-01/eeg/UPPER.EDF")).toBe(true);
    expect(annexed.has("sub-01/eeg/Mixed.Edf")).toBe(true);
    expect(annexed.has("sub-02/eeg/UPPER.SET")).toBe(true);

    // No disagreement between the plan and git-annex may be unexplained.
    for (const f of FIXTURES) {
      if (shouldAnnex(f.path, f.size) && !annexed.has(f.path)) {
        expect(isCaseVariantData(f.path), `${f.path} disagrees and is not flagged`).toBe(true);
      }
    }
    // And the ordinary files are not flagged, so a policy override stays visible.
    expect(isCaseVariantData("sub-01/eeg/normal.edf")).toBe(false);
    expect(isCaseVariantData("sub-01/eeg/lower.edf")).toBe(false);
    expect(isCaseVariantData("sub-03/motion/sub-03_task-walk_tracksys-imu_motion.tsv")).toBe(false);
  });

  test("without the force step the not-annexed check would refuse the large motion recording", async () => {
    const dir = await repoWithFixtures("oracle-check");
    expect(
      (
        await gitAnnexAdd(
          dir,
          FIXTURES.map((f) => f.path),
        )
      ).success,
    ).toBe(true);
    const { blocking } = findDataFilesNotAnnexed(toTargets(), await annexedSet(dir));
    // Without the force step: a large file the CLI calls data that git-annex kept in git.
    // It is the MOTION file, not the uppercase .EDF, that is in this set.
    expect(blocking.map((f) => f.path)).toEqual([
      "sub-03/motion/sub-03_task-walk_tracksys-imu_MOTION.tsv",
    ]);
  });
});

describe("isCaseVariantData", () => {
  test("flags a file only when the name makes it data for the CLI and not for git-annex", () => {
    const expected: Array<[string, boolean]> = [
      ["sub-01/eeg/normal.edf", false],
      ["sub-01/eeg/UPPER.EDF", true],
      ["sub-01/eeg/Mixed.Edf", true],
      ["sub-01/eeg/UPPER.SET", true],
      ["sub-01/motion/a_motion.tsv", false],
      ["sub-01/motion/a_MOTION.tsv", true],
      ["sub-01/motion/a_motion.TSV", true],
      // Not data by name for either reader: size decides, and nothing to force.
      ["sub-01/eeg/events.tsv", false],
      ["sub-01/eeg/EVENTS.TSV", false],
      ["derivatives/blob.DAT", false],
      // The metadata veto outranks a data extension for both readers.
      ["README.EDF", false],
    ];
    for (const [path, variant] of expected) {
      expect(isCaseVariantData(path), path).toBe(variant);
    }
  });
});

describe("trackDataFiles", () => {
  test("uses the bounded local worker default and allows an explicit override", async () => {
    const paths = ["sub-01/eeg/normal.edf", "sub-01/eeg/small_UPPER.EDF"];

    for (const [name, annexJobs] of [
      ["default-workers", undefined],
      ["override-workers", 8],
    ] as const) {
      const dir = await repoWithFixtures(name);
      const trace = join(scratch.root, `trace-${name}.log`);
      const saved = process.env.GIT_TRACE;
      process.env.GIT_TRACE = trace;
      try {
        const result = await trackDataFiles(dir, paths, { annexJobs });
        expect(result).toEqual({ success: true });
      } finally {
        // biome-ignore lint/performance/noDelete: assigning undefined would leave the string "undefined"
        if (saved === undefined) delete process.env.GIT_TRACE;
        else process.env.GIT_TRACE = saved;
      }

      const adds = readFileSync(trace, "utf8")
        .split("\n")
        .filter((line) => /run_command: git-annex add/.test(line));
      expect(adds).toHaveLength(2);
      const expectedJobs = annexJobs ?? 4;
      for (const line of adds) {
        expect(line).toContain(`-J${expectedJobs}`);
        expect(line).toContain("--batch");
      }
      expect([...(await annexedSet(dir))].sort()).toEqual([...paths].sort());
    }
  });

  test("annexes every file the CLI called data, so nothing is left to refuse or report", async () => {
    const dir = await repoWithFixtures("track");
    const result = await trackDataFiles(
      dir,
      FIXTURES.map((f) => f.path),
    );
    expect(result).toEqual({ success: true });

    const annexed = await annexedSet(dir);
    for (const f of FIXTURES) expect(annexed.has(f.path), f.path).toBe(true);
    expect(findDataFilesNotAnnexed(toTargets(), annexed)).toEqual({ blocking: [], small: [] });
  });

  test("the forced files are still pointers after the save, not converted back to git blobs", async () => {
    // The save's `git add -A` runs git-annex's clean filter, which re-reads
    // `annex.largefiles`; a forced file that the expression would not annex must keep the
    // key it was given. Measured here rather than assumed, because the other way round
    // would commit the recording to git after the plan promised S3.
    const dir = await repoWithFixtures("track-save");
    expect(
      (
        await trackDataFiles(
          dir,
          FIXTURES.map((f) => f.path),
        )
      ).success,
    ).toBe(true);
    expect((await saveDataset(dir, "upload")).success).toBe(true);

    for (const f of FIXTURES) {
      const blob = await run(["git", "cat-file", "-p", `HEAD:${f.path}`], dir);
      expect(blob.stdout.startsWith("/annex/objects/"), f.path).toBe(true);
    }
    expect(await annexedSet(dir)).toEqual(new Set(FIXTURES.map((f) => f.path)));
  });

  test("tracking leaves the size, mtime and inode the upload plan recorded exactly as they were", async () => {
    // The premise of the stat guard in saveDataset. The plan records each file's stat
    // BEFORE a possibly multi-hour `git annex add`, and the guard compares that record
    // with the file after the copy; if add moved the mtime, every file would look edited.
    // Checked here on the filesystem the tests run on, for ordinary and forced adds alike.
    const dir = await repoWithFixtures("track-stat");
    const paths = FIXTURES.map((f) => f.path);
    const before = paths.map((p) => {
      const st = statSync(join(dir, p));
      return { p, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino };
    });

    expect((await trackDataFiles(dir, paths)).success).toBe(true);

    for (const b of before) {
      const st = statSync(join(dir, b.p));
      expect({ size: st.size, mtimeMs: st.mtimeMs, ino: st.ino }, b.p).toEqual({
        size: b.size,
        mtimeMs: b.mtimeMs,
        ino: b.ino,
      });
    }
  });

  test("a re-run is idempotent: same annexed set, no change to the tree", async () => {
    const dir = await repoWithFixtures("track-twice");
    const paths = FIXTURES.map((f) => f.path);
    expect((await trackDataFiles(dir, paths)).success).toBe(true);
    const first = await annexedSet(dir);
    const statusAfterFirst = (await run(["git", "status", "--porcelain"], dir)).stdout;

    expect((await trackDataFiles(dir, paths)).success).toBe(true);
    expect(await annexedSet(dir)).toEqual(first);
    expect((await run(["git", "status", "--porcelain"], dir)).stdout).toBe(statusAfterFirst);
  });

  test("an override of the policy is not papered over for ordinary names", async () => {
    // An inherited `.gitattributes` outranks `annex.largefiles` (ADR 0060). The force
    // step must not hide that: the not-annexed check exists to catch it.
    const dir = await newDatasetRepo(scratch.root, "override");
    writeFile(dir, ".gitattributes", "*.edf annex.largefiles=nothing\n");
    writeFile(dir, "sub-01/eeg/big.edf", 200_000);
    expect((await trackDataFiles(dir, ["sub-01/eeg/big.edf"])).success).toBe(true);
    expect((await annexedSet(dir)).has("sub-01/eeg/big.edf")).toBe(false);
    expect(
      findDataFilesNotAnnexed(
        [{ path: "sub-01/eeg/big.edf", size: 200_000, type: "data" }],
        await annexedSet(dir),
      ).blocking,
    ).toHaveLength(1);
  });

  test("an empty list is a successful no-op", async () => {
    const dir = await newDatasetRepo(scratch.root, "empty");
    expect(await trackDataFiles(dir, [])).toEqual({ success: true });
  });
});
