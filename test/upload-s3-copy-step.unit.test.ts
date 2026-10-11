/**
 * Upload step 9, driven through its decisions against real git-annex and a real
 * `directory` special remote named `nemar-s3`.
 *
 * `copyAnnexedToRemote` decides what step 9 does: what to copy comes from the location
 * log, a large data file git-annex refused fails before any byte moves, git-annex
 * itself checks the files the log already records, and EVERY annexed file has to end up
 * recorded at the remote. Where a test guards one particular line, its first comment
 * says which.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { saveDataset } from "../src/lib/git-annex/clone-push";
import { gitAnnexAdd, unstageTrackedPaths } from "../src/lib/git-annex/init";
import {
  type UploadProgress,
  initUploadProgress,
  isStepCompleted,
  markStepCompleted,
} from "../src/lib/upload-progress";
import {
  type BlockedRecovery,
  type SmallNotAnnexed,
  copyAnnexedToRemote,
  describeBlockedTracking,
  formatUploadSummary,
  listAnnexedPaths,
  listAnnexedPathsNotAt,
  listPendingAtRemote,
  recoverBlockedTracking,
  trackDataFiles,
} from "../src/lib/upload/transfer";
import {
  annexedSet,
  chmodTreeWritable,
  initDirectoryRemote,
  makeScratch,
  newDatasetRepo,
  run,
  writeFile,
} from "./helpers/annex-repo";

// Each test builds a repository and runs git-annex a few times; CI machines are slower
// than the 5 s default allows.
setDefaultTimeout(60_000);

const REMOTE = "nemar-s3";
const scratch = makeScratch("nemar-s3-step");

beforeAll(async () => {
  const probe = await run(["git", "annex", "version"]);
  if (probe.exitCode !== 0) throw new Error("git-annex is required for this test file");
});
afterAll(() => scratch.cleanup());

interface Target {
  path: string;
  size: number;
  type: "data";
}

/** A dataset with the named files written, and a directory remote called nemar-s3. */
async function dataset(name: string, files: Record<string, number>) {
  const dir = await newDatasetRepo(scratch.root, name);
  const targets: Target[] = [];
  for (const [path, size] of Object.entries(files)) {
    writeFile(dir, path, `${path}:`.padEnd(size, "x"));
    targets.push({ path, size, type: "data" });
  }
  const store = await initDirectoryRemote(scratch.root, dir, REMOTE);
  return { dir, store, targets };
}

const step = (
  dir: string,
  addTargets: Target[],
  onPlan?: Parameters<typeof copyAnnexedToRemote>[0]["onPlan"],
  dataFiles = addTargets,
) =>
  copyAnnexedToRemote({
    absolutePath: dir,
    remote: REMOTE,
    addTargets,
    dataFiles,
    jobs: 2,
    onPlan,
  });

describe("copyAnnexedToRemote: what is copied", () => {
  test("a fresh upload copies every annexed file and records each at the remote", async () => {
    const { dir, targets } = await dataset("fresh", {
      "sub-01/eeg/a.edf": 3_000,
      "sub-01/eeg/b.edf": 3_000,
      "sub-02/eeg/c.edf": 3_000,
    });
    expect(
      (
        await trackDataFiles(
          dir,
          targets.map((t) => t.path),
        )
      ).success,
    ).toBe(true);

    const plans: Array<{ total: number; pending: number }> = [];
    const outcome = await step(dir, targets, (p) => {
      plans.push({ total: p.total, pending: p.pending });
    });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome).toMatchObject({ total: 3, attempted: 3, confirmed: 3 });
    expect(outcome.annexedPaths).toEqual(new Set(targets.map((t) => t.path)));
    expect(plans).toEqual([{ total: 3, pending: 3 }]);
    expect(await listAnnexedPaths(dir, REMOTE)).toEqual(new Set(targets.map((t) => t.path)));
  });

  test("a file name with a newline in it is one path, copied and recorded", async () => {
    // Guards NUL-separated listing. Split on newlines, "new\nline.edf" becomes two paths
    // that exist nowhere, and `git annex copy` fails on them as pathspecs.
    const { dir, targets } = await dataset("newline-name", {
      "a.edf": 3_000,
      "new\nline.edf": 3_000,
    });
    expect(
      (
        await trackDataFiles(
          dir,
          targets.map((t) => t.path),
        )
      ).success,
    ).toBe(true);

    const outcome = await step(dir, targets);

    expect(outcome).toMatchObject({ status: "ok", total: 2, attempted: 2 });
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.annexedPaths).toEqual(new Set(["a.edf", "new\nline.edf"]));
    expect(await listAnnexedPaths(dir, REMOTE)).toEqual(new Set(["a.edf", "new\nline.edf"]));
    expect(await listAnnexedPathsNotAt(dir, REMOTE)).toEqual(new Set());
  });

  test("the plan is announced once, after the checks and before anything is copied", async () => {
    // Guards where `onPlan` runs. The progress line it feeds ("Uploading N files...")
    // must not be printed after the work it announces, and the late-annex test below only
    // means what it says if the callback fires between the plan and the copy.
    const { dir, targets } = await dataset("plan-position", { "a.edf": 3_000, "b.edf": 3_000 });
    expect(
      (
        await trackDataFiles(
          dir,
          targets.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    let calls = 0;
    let atRemoteDuringPlan: Set<string> | null = null;

    const outcome = await step(dir, targets, async () => {
      calls += 1;
      atRemoteDuringPlan = await listAnnexedPaths(dir, REMOTE);
    });

    expect(outcome.status).toBe("ok");
    expect(calls).toBe(1);
    expect(atRemoteDuringPlan).toEqual(new Set());
  });

  test("a resume copies exactly the remainder, and a second run copies nothing", async () => {
    const { dir, targets } = await dataset("resume", {
      "a.edf": 3_000,
      "b.edf": 3_000,
      "c.edf": 3_000,
    });
    expect(
      (
        await trackDataFiles(
          dir,
          targets.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    // An earlier run got a and b to the remote before it died.
    expect(
      (await run(["git", "annex", "copy", "--to", REMOTE, "--", "a.edf", "b.edf"], dir)).exitCode,
    ).toBe(0);

    const first = await step(dir, targets);
    expect(first).toMatchObject({ status: "ok", total: 3, attempted: 1, confirmed: 1 });

    const second = await step(dir, targets);
    expect(second).toMatchObject({ status: "ok", total: 3, attempted: 0, confirmed: 0, resent: 0 });
  });

  test("an annexed file from an earlier run that never reached the remote is copied too", async () => {
    // Guards `pending` being the location log's remainder, not this run's add targets.
    // Reverting it to the targets leaves `old.edf` behind, and the verify-all check then
    // reports the step incomplete instead of ok.
    const { dir, targets } = await dataset("left-behind", { "old.edf": 3_000, "new.edf": 3_000 });
    expect((await trackDataFiles(dir, ["old.edf"])).success).toBe(true);
    // The earlier run died after tracking `old.edf` and before copying it. This run only
    // adds `new.edf`.
    expect((await trackDataFiles(dir, ["new.edf"])).success).toBe(true);
    const thisRunsTargets: Target[] = [{ path: "new.edf", size: 3_000, type: "data" }];

    const outcome = await step(dir, thisRunsTargets, undefined, targets);
    expect(outcome).toMatchObject({ status: "ok", total: 2, attempted: 2 });
    expect(await listAnnexedPaths(dir, REMOTE)).toEqual(new Set(["old.edf", "new.edf"]));
    // The set handed on to the save step is every annexed path, not this run's targets.
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.annexedPaths).toEqual(new Set(["old.edf", "new.edf"]));
  });
});

describe("copyAnnexedToRemote: the remote is asked, not only the log", () => {
  /** Empty a directory remote behind git-annex's back: a reset bucket, expired objects. */
  function emptyStore(store: string): void {
    chmodTreeWritable(store);
    for (const entry of readdirSync(store))
      rmSync(join(store, entry), { recursive: true, force: true });
  }

  test("a store that lost every object is sent them again, and the result says so", async () => {
    // Guards the non-fast check of the paths the log already records. `pending` comes
    // from the log, so a log that still says "present" for content the store no longer
    // holds would otherwise end in "nothing to copy" with an empty bucket.
    const { dir, store, targets } = await dataset("store-lost", {
      "a.edf": 3_000,
      "b.edf": 3_000,
      "c.edf": 3_000,
    });
    expect(
      (
        await trackDataFiles(
          dir,
          targets.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    expect(await step(dir, targets)).toMatchObject({ status: "ok", attempted: 3, resent: 0 });
    const objects = (): number => readdirSync(store, { recursive: true }).length;
    expect(objects()).toBeGreaterThan(0);

    emptyStore(store);
    expect(readdirSync(store)).toEqual([]);
    // The log has not noticed.
    expect(await listAnnexedPathsNotAt(dir, REMOTE)).toEqual(new Set());

    const outcome = await step(dir, targets);

    expect(outcome).toMatchObject({ status: "ok", total: 3, attempted: 0, resent: 3 });
    expect(objects()).toBeGreaterThan(0);
    expect(await listAnnexedPaths(dir, REMOTE)).toEqual(new Set(targets.map((t) => t.path)));
    if (outcome.status !== "ok") throw new Error("unreachable");
    const summary = formatUploadSummary(outcome.total, outcome.attempted, outcome.confirmed, {
      resent: outcome.resent,
    });
    expect(summary).toContain("3 were recorded but missing at the remote and were sent again");
    expect(summary).not.toContain("nothing to copy");
  });

  test("a store that lost only some objects is sent only those", async () => {
    const { dir, store, targets } = await dataset("store-partly-lost", {
      "a.edf": 3_000,
      "b.edf": 3_000,
      "c.edf": 3_000,
    });
    expect(
      (
        await trackDataFiles(
          dir,
          targets.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    expect((await step(dir, targets)).status).toBe("ok");
    // Remove exactly one key's object from the store.
    const key = (await run(["git", "annex", "lookupkey", "b.edf"], dir)).stdout.trim();
    chmodTreeWritable(store);
    const victims = (readdirSync(store, { recursive: true }) as string[]).filter(
      (e) => e.endsWith(`/${key}`) || e.endsWith(`/${key}/${key}`),
    );
    expect(victims.length).toBeGreaterThan(0);
    for (const v of victims) rmSync(join(store, v), { recursive: true, force: true });

    expect(await step(dir, targets)).toMatchObject({ status: "ok", attempted: 0, resent: 1 });
  });

  test("when the lost objects cannot be sent again the step fails and claims nothing", async () => {
    const { dir, store, targets } = await dataset("store-lost-readonly", { "a.edf": 3_000 });
    expect(
      (
        await trackDataFiles(
          dir,
          targets.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    expect((await step(dir, targets)).status).toBe("ok");
    emptyStore(store);
    chmodSync(store, 0o555);
    try {
      const outcome = await step(dir, targets);
      // Not "ok" with a log that still says present: git-annex tried and failed.
      expect(outcome.status).toBe("copy_failed");
    } finally {
      chmodSync(store, 0o755);
    }
  });

  test("the plan counts what will be copied and what will only be checked", async () => {
    const { dir, targets } = await dataset("plan-counts", { "a.edf": 3_000, "b.edf": 3_000 });
    expect(
      (
        await trackDataFiles(
          dir,
          targets.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    expect((await run(["git", "annex", "copy", "--to", REMOTE, "--", "a.edf"], dir)).exitCode).toBe(
      0,
    );
    const plans: Array<{ total: number; pending: number; recorded: number }> = [];
    await step(dir, targets, (p) => {
      plans.push({ total: p.total, pending: p.pending, recorded: p.recorded });
    });
    expect(plans).toEqual([{ total: 2, pending: 1, recorded: 1 }]);
  });
});

describe("copyAnnexedToRemote: every annexed file must be recorded at the remote", () => {
  test("a file annexed after the plan was made is not copied, and the step says so", async () => {
    // Guards the post-copy check being "every annexed file", not "this run's targets".
    // A file annexed between the plan and the copy is not in `pending`, so the copy
    // leaves it; only the dataset-wide check can see that. `onPlan` is the production
    // callback the progress line hangs off, used here to land a real `git annex add`
    // at exactly that moment.
    const { dir, targets } = await dataset("late", { "a.edf": 3_000, "b.edf": 3_000 });
    expect(
      (
        await trackDataFiles(
          dir,
          targets.map((t) => t.path),
        )
      ).success,
    ).toBe(true);

    const outcome = await step(dir, targets, async () => {
      writeFile(dir, "late.edf", 3_000);
      expect((await gitAnnexAdd(dir, ["late.edf"])).success).toBe(true);
    });

    expect(outcome).toEqual({
      status: "incomplete",
      missing: ["late.edf"],
      total: 3,
      notLocal: [],
      notLocalKnown: true,
      lostAtRemote: [],
    });
    // The two planned files did arrive; only the late one is missing.
    expect(await listAnnexedPaths(dir, REMOTE)).toEqual(new Set(["a.edf", "b.edf"]));
  });

  test("a file whose content is not in this repository is called what it is, not retried forever", async () => {
    // Guards `notLocal`. `git annex copy` skips, silently and with exit 0, a path whose
    // content was dropped or never fetched, so the step ends "incomplete" and the old
    // advice, "re-run to resume", loops. The cure is `git annex get`, and the report must say so.
    const { dir, targets } = await dataset("not-local", { "a.edf": 3_000, "b.edf": 3_000 });
    expect(
      (
        await trackDataFiles(
          dir,
          targets.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    expect((await run(["git", "annex", "drop", "--force", "--", "b.edf"], dir)).exitCode).toBe(0);

    const outcome = await step(dir, targets);

    expect(outcome).toEqual({
      status: "incomplete",
      missing: ["b.edf"],
      total: 2,
      notLocal: ["b.edf"],
      notLocalKnown: true,
      lostAtRemote: [],
    });
    // a.edf did go.
    expect(await listAnnexedPaths(dir, REMOTE)).toEqual(new Set(["a.edf"]));
  });

  test("a copy that fails reports git-annex's reason and leaves the log honest", async () => {
    const { dir, store, targets } = await dataset("copy-fails", { "a.edf": 3_000, "b.edf": 3_000 });
    expect(
      (
        await trackDataFiles(
          dir,
          targets.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    renameSync(store, `${store}.gone`);

    const outcome = await step(dir, targets);
    expect(outcome.status).toBe("copy_failed");
    if (outcome.status !== "copy_failed") throw new Error("unreachable");
    expect(outcome.error).toContain("is not accessible");
    expect(await listAnnexedPaths(dir, REMOTE)).toEqual(new Set());
  });

  test("a damaged index prevents a completed upload from being reported as success", async () => {
    // The real-state failure path: the index is damaged after the plan and the subsequent
    // git-annex operation fails. The step must preserve that failure instead of claiming
    // that every annexed file reached the remote.
    const { dir, targets } = await dataset("verify-index", { "a.edf": 3_000 });
    expect(
      (
        await trackDataFiles(
          dir,
          targets.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    expect((await step(dir, targets)).status).toBe("ok");
    const outcome = await step(dir, targets, () => {
      writeFileSync(join(dir, ".git", "index"), "x");
    });
    expect(outcome.status).not.toBe("ok");
  });

  test("a repository git cannot list is reported, not read as an empty dataset", async () => {
    const notARepo = join(scratch.root, "not-a-repo");
    writeFile(notARepo, "x.edf", 100);
    const outcome = await step(notARepo, []);
    expect(outcome.status).toBe("unreadable");
  });

  test("a dataset with no annexed files is ok with nothing to say", async () => {
    const { dir } = await dataset("empty", {});
    const outcome = await step(dir, []);
    expect(outcome).toMatchObject({ status: "ok", total: 0, attempted: 0 });
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(
      formatUploadSummary(outcome.total, outcome.attempted, outcome.confirmed, {
        resent: outcome.resent,
      }),
    ).toBe("No annexed data files, so nothing was copied to S3");
  });
});

describe("the walks refuse to answer when git-annex cannot", () => {
  test("a remote that does not exist is an error, never an empty set", async () => {
    const { dir } = await dataset("no-remote", { "a.edf": 3_000 });
    await expect(listAnnexedPathsNotAt(dir, "no-such-remote")).rejects.toThrow();
  });

  test("a directory that is not a repository is an error too", async () => {
    await expect(listAnnexedPaths(join(scratch.root, "not-a-repo-either"))).rejects.toThrow();
    await expect(
      listAnnexedPathsNotAt(join(scratch.root, "not-a-repo-either"), REMOTE),
    ).rejects.toThrow();
  });
});

describe("listPendingAtRemote", () => {
  test("with no remote configured every annexed file is pending; with one, only the remainder", async () => {
    // Guards the configured-remote test. Without it a repository that never had the
    // remote would throw "not a valid remote" and a first run could not start.
    const dir = await newDatasetRepo(scratch.root, "pending-no-remote");
    writeFile(dir, "a.edf", "a".repeat(3_000));
    writeFile(dir, "b.edf", "b".repeat(3_000));
    expect((await trackDataFiles(dir, ["a.edf", "b.edf"])).success).toBe(true);
    expect(await listPendingAtRemote(dir, REMOTE)).toEqual(["a.edf", "b.edf"]);

    await initDirectoryRemote(scratch.root, dir, REMOTE);
    expect(await listPendingAtRemote(dir, REMOTE)).toEqual(["a.edf", "b.edf"]);
    expect((await run(["git", "annex", "copy", "--to", REMOTE, "--", "a.edf"], dir)).exitCode).toBe(
      0,
    );
    expect(await listPendingAtRemote(dir, REMOTE)).toEqual(["b.edf"]);
  });

  test("a repository with nothing annexed has nothing pending, remote or not", async () => {
    const dir = await newDatasetRepo(scratch.root, "pending-nothing");
    expect(await listPendingAtRemote(dir, REMOTE)).toEqual([]);
  });
});

describe("listAnnexedPathsNotAt", () => {
  test("a path-scoped location-log read is literal and does not walk unrelated annexed files", async () => {
    const dir = await newDatasetRepo(scratch.root, "not-at-scoped");
    const paths = ["sub-01/eeg/a*.edf", "sub-01/eeg/abc.edf"];
    writeFile(
      dir,
      paths[0] as string,
      readFileSync(join(import.meta.dir, "fixtures/identifier-scan/clean.edf")),
    );
    writeFile(
      dir,
      paths[1] as string,
      readFileSync(join(import.meta.dir, "fixtures/identifier-scan/flagged.edf")),
    );
    expect((await gitAnnexAdd(dir, paths, {}, { forceLarge: true })).success).toBe(true);
    await initDirectoryRemote(scratch.root, dir, REMOTE);

    expect(await listAnnexedPathsNotAt(dir, REMOTE, [paths[0] as string])).toEqual(
      new Set([paths[0]]),
    );
    expect(await listAnnexedPathsNotAt(dir, REMOTE, paths)).toEqual(new Set(paths));
  });

  test("names annexed files the remote lacks, including ones whose content is not local, and never a git file", async () => {
    // The step relies on one `git annex find --not --in` walk both to plan and to
    // verify. It must not depend on the content being present here (a file dropped
    // locally and never copied is just as missing), and a plain git file is not annexed.
    const { dir, targets } = await dataset("not-at", {
      "a.edf": 3_000,
      "b.edf": 3_000,
      "c.edf": 3_000,
    });
    writeFile(dir, "notes.json", 100);
    expect(
      (
        await trackDataFiles(
          dir,
          targets.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    expect((await run(["git", "annex", "copy", "--to", REMOTE, "--", "a.edf"], dir)).exitCode).toBe(
      0,
    );
    expect((await run(["git", "annex", "drop", "--force", "--", "c.edf"], dir)).exitCode).toBe(0);

    expect(await listAnnexedPathsNotAt(dir, REMOTE)).toEqual(new Set(["b.edf", "c.edf"]));
    // Agrees with the two-list difference it replaces.
    const annexed = await listAnnexedPaths(dir);
    const atRemote = await listAnnexedPaths(dir, REMOTE);
    expect(await listAnnexedPathsNotAt(dir, REMOTE)).toEqual(
      new Set([...annexed].filter((p) => !atRemote.has(p))),
    );
  });
});

describe("copyAnnexedToRemote: a data file git-annex refused", () => {
  /** big.edf is over the threshold, but an inherited `annex.largefiles=nothing` keeps it in git. */
  async function overridden(name: string) {
    const ds = await dataset(name, { "sub-01/eeg/ok.edf": 3_000 });
    writeFile(ds.dir, ".gitattributes", "big*.edf annex.largefiles=nothing\n");
    writeFile(ds.dir, "sub-01/eeg/big.edf", 200_000);
    const big: Target = { path: "sub-01/eeg/big.edf", size: 200_000, type: "data" };
    const targets = [...ds.targets, big];
    expect(
      (
        await trackDataFiles(
          ds.dir,
          targets.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    return { ...ds, big, targets };
  }

  test("fails before copying anything, and names the file", async () => {
    // Guards the not-annexed check. Remove it and `big.edf` sails through: it is not
    // annexed, so the verify-all check never looks at it, and it is committed to git.
    const { dir, targets } = await overridden("blocked");
    expect((await annexedSet(dir)).has("sub-01/eeg/big.edf")).toBe(false);

    let planned = false;
    const outcome = await step(dir, targets, () => {
      planned = true;
    });

    expect(outcome).toEqual({
      status: "blocked",
      blocking: [{ path: "sub-01/eeg/big.edf", size: 200_000 }],
    });
    expect(planned).toBe(false);
    // Nothing was sent: the small file that WAS annexed is not at the remote either.
    expect(await listAnnexedPaths(dir, REMOTE)).toEqual(new Set());
  });

  test("a small file git-annex kept in git is reported and does not block", async () => {
    const { dir, targets } = await dataset("small", {
      "ok.edf": 3_000,
      "UPPER-small.edf": 3_000,
    });
    writeFile(dir, ".gitattributes", "UPPER-*.edf annex.largefiles=nothing\n");
    expect(
      (
        await trackDataFiles(
          dir,
          targets.map((t) => t.path),
        )
      ).success,
    ).toBe(true);

    const outcome = await step(dir, targets);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.smallNotAnnexed).toEqual({ inGit: ["UPPER-small.edf"], leftOut: [] });
    expect(outcome.annexedPaths).toEqual(new Set(["ok.edf"]));
  });

  test("a small data file a .gitignore hides is named as left out, not as stored in git", async () => {
    // Guards the split by `listTrackedPaths`. git-annex skips an ignored file without a
    // word, so such a file is in no commit and not at the remote, while the plan (which
    // walks the directory) still lists it. Calling it "stored in git" was false.
    const { dir, targets } = await dataset("ignored-small", {
      "ok.edf": 3_000,
      "ignored.edf": 3_000,
      "Ignored_MOTION.tsv": 3_000,
    });
    writeFile(dir, ".gitignore", "ignored.edf\nIgnored_MOTION.tsv\n");
    expect(
      (
        await trackDataFiles(
          dir,
          targets.map((t) => t.path),
        )
      ).success,
    ).toBe(true);

    const plans: SmallNotAnnexed[] = [];
    const outcome = await step(dir, targets, (p) => {
      plans.push(p.smallNotAnnexed);
    });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.smallNotAnnexed).toEqual({
      inGit: [],
      leftOut: ["Ignored_MOTION.tsv", "ignored.edf"].sort(),
    });
    expect(plans).toEqual([outcome.smallNotAnnexed]);
    // The claim behind the name: after the save neither file is in the commit.
    expect((await saveDataset(dir, "upload")).success).toBe(true);
    const tree = (await run(["git", "ls-tree", "-r", "--name-only", "HEAD"], dir)).stdout;
    expect(tree).toContain("ok.edf");
    expect(tree).not.toContain("ignored.edf");
    expect(tree).not.toContain("Ignored_MOTION.tsv");
  });

  test("a metadata file in the targets is never held to the annexed standard", async () => {
    const { dir, targets } = await dataset("metadata", { "ok.edf": 3_000 });
    writeFile(dir, "participants.tsv", 400_000);
    expect((await trackDataFiles(dir, ["ok.edf"])).success).toBe(true);
    const withMeta = [
      ...targets,
      { path: "participants.tsv", size: 400_000, type: "metadata" as unknown as "data" },
    ];
    expect((await step(dir, withMeta)).status).toBe("ok");
  });
});

describe("recoverBlockedTracking: a blocked upload can be re-run", () => {
  async function blockedByAttributes(name: string) {
    const { dir, targets } = await dataset(name, { "ok.edf": 3_000 });
    writeFile(dir, ".gitattributes", "big*.edf annex.largefiles=nothing\n");
    writeFile(dir, "big.edf", 200_000);
    const all: Target[] = [...targets, { path: "big.edf", size: 200_000, type: "data" }];
    expect(
      (
        await trackDataFiles(
          dir,
          all.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    const progress: UploadProgress = initUploadProgress(dir, "nm000999", all);
    markStepCompleted(progress, "tracking");
    const outcome = await step(dir, all);
    expect(outcome.status).toBe("blocked");
    return { dir, all, progress };
  }

  test("control: fixing the cause alone does not help, because the blob is still staged", async () => {
    // The premise of the recovery (ADR 0060): `git annex add` is a no-op on a staged,
    // unmodified file. If git-annex ever changes that, this fails and the recovery is
    // dead weight.
    const { dir, all } = await blockedByAttributes("control");
    rmSync(join(dir, ".gitattributes"));
    expect(
      (
        await trackDataFiles(
          dir,
          all.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    expect((await annexedSet(dir)).has("big.edf")).toBe(false);
    expect((await step(dir, all)).status).toBe("blocked");
  });

  test("after recovery and a fix, the re-run annexes the file and the step passes", async () => {
    const { dir, all, progress } = await blockedByAttributes("recover");
    const before = readFileSync(join(dir, "big.edf"));

    expect(await recoverBlockedTracking(dir, progress, ["big.edf"])).toEqual({
      unstaged: 1,
      staged: ["big.edf"],
    });

    // The blob is out of the index, the stamp is cleared, and the file is untouched.
    const tracked = (await run(["git", "ls-files", "--", "big.edf"], dir)).stdout;
    expect(tracked).toBe("");
    expect(isStepCompleted(progress, "tracking")).toBe(false);
    expect(readFileSync(join(dir, "big.edf")).equals(before)).toBe(true);

    rmSync(join(dir, ".gitattributes"));
    expect(
      (
        await trackDataFiles(
          dir,
          all.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    expect((await annexedSet(dir)).has("big.edf")).toBe(true);
    expect(await step(dir, all)).toMatchObject({ status: "ok", total: 2 });
  });

  test("a file .gitignore hides is never staged, and the re-run works once the pattern is fixed", async () => {
    const { dir, targets } = await dataset("ignored", { "ok.edf": 3_000 });
    writeFile(dir, ".gitignore", "big.edf\n");
    writeFile(dir, "big.edf", 200_000);
    const all: Target[] = [...targets, { path: "big.edf", size: 200_000, type: "data" }];
    expect(
      (
        await trackDataFiles(
          dir,
          all.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    const progress = initUploadProgress(dir, "nm000998", all);
    markStepCompleted(progress, "tracking");

    // git-annex skipped it without a word, so the step is blocked on a file that was
    // never staged: nothing to unstage, but the stamp still has to be cleared.
    expect((await step(dir, all)).status).toBe("blocked");
    expect(await recoverBlockedTracking(dir, progress, ["big.edf"])).toEqual({
      unstaged: 0,
      staged: [],
    });
    expect(isStepCompleted(progress, "tracking")).toBe(false);

    rmSync(join(dir, ".gitignore"));
    expect(
      (
        await trackDataFiles(
          dir,
          all.map((t) => t.path),
        )
      ).success,
    ).toBe(true);
    expect(await step(dir, all)).toMatchObject({ status: "ok", total: 2 });
  });
});

describe("what a blocked step says", () => {
  const ok: BlockedRecovery = { unstaged: 7, staged: [] };

  test("the blocked message names both causes, the threshold, and what was done", () => {
    const lines = describeBlockedTracking(
      Array.from({ length: 7 }, (_, i) => ({ path: `sub-0${i}/eeg/big.edf`, size: 200_000 })),
      ok,
    );
    const text = lines.join("\n");
    expect(text).toContain("7 data files over 100,000 bytes were not added to git-annex");
    expect(text).toContain(".gitattributes");
    expect(text).toContain("annex.largefiles");
    expect(text).toContain(".gitignore");
    expect(text).toContain("7 of them were unstaged");
    expect(text).toContain("... and 2 more");
    expect(text).toContain("re-run `nemar dataset upload`");
  });

  test("when nothing was staged it says so", () => {
    const text = describeBlockedTracking([{ path: "big.edf", size: 200_000 }], {
      unstaged: 0,
      staged: [],
    }).join("\n");
    expect(text).toContain("None of them was staged");
  });

  test("when unstaging failed it never claims it was done, and says why", () => {
    const text = describeBlockedTracking([{ path: "big.edf", size: 200_000 }], {
      unstaged: null,
      staged: ["big.edf"],
      error: "fatal: Unable to create index.lock",
    }).join("\n");
    expect(text).toContain("1 data file over 100,000 bytes was not added");
    expect(text).toContain("fatal: Unable to create index.lock");
    expect(text).not.toContain("were unstaged");
  });

  test("an unsaved progress file is reported, and no command is offered for work already done", () => {
    // Guards the split on `unstaged`. Unstaging worked here and only the progress file
    // could not be written, so the files are NOT staged any more: printing the unstage
    // command would send the person to undo something that is already undone.
    const text = describeBlockedTracking([{ path: "big.edf", size: 200_000 }], {
      unstaged: 1,
      staged: ["big.edf"],
      error: "the upload progress could not be saved",
    }).join("\n");
    expect(text).toContain("1 of them was unstaged");
    expect(text).toContain("the upload progress could not be saved");
    expect(text).not.toContain("git --literal-pathspecs rm");
    expect(text).not.toContain("Could not finish making the next run able to annex them");
  });

  test("past fifty paths it does not print a command, it says the re-run unstages them", () => {
    const staged = Array.from({ length: 51 }, (_, i) => `f${i}.edf`);
    const text = describeBlockedTracking(
      staged.map((path) => ({ path, size: 200_000 })),
      { unstaged: null, staged, error: "boom" },
    ).join("\n");
    expect(text).not.toContain("git --literal-pathspecs rm");
    expect(text).toContain("51 paths are involved; the next run tries again, unstaging them");
  });
});

describe("recovery that does not complete", () => {
  /** n blocked files with spaces, quotes and glob characters in their names. */
  async function blockedMany(name: string, names: string[]) {
    const { dir } = await dataset(name, {});
    writeFile(dir, ".gitattributes", "*.edf annex.largefiles=nothing\n");
    const all: Target[] = [];
    for (const rel of names) {
      writeFile(dir, rel, 200_000);
      all.push({ path: rel, size: 200_000, type: "data" });
    }
    expect((await trackDataFiles(dir, names)).success).toBe(true);
    const progress = initUploadProgress(dir, "nm000997", all);
    markStepCompleted(progress, "tracking");
    const outcome = await step(dir, all);
    expect(outcome.status).toBe("blocked");
    return { dir, all, progress };
  }

  test("the printed command runs in a shell on names with spaces, quotes and stars", async () => {
    // Guards the quoting by EXECUTING what is printed: a command with bare paths, cut at
    // five, or followed by a parenthetical is not one a shell runs.
    const names = [
      "sub-0/eeg/my file 0.edf",
      "sub-1/eeg/it's 1.edf",
      "sub-2/eeg/star*2.edf",
      "sub-3/eeg/x [3].edf",
      "sub-4/eeg/plain4.edf",
    ];
    const { dir, progress } = await blockedMany("printed-command", names);
    let recovery: BlockedRecovery;
    const lock = join(dir, ".git", "index.lock");
    writeFileSync(lock, "", { flag: "wx" });
    try {
      recovery = await recoverBlockedTracking(dir, progress, names);
    } finally {
      rmSync(lock, { force: true });
    }
    expect(recovery.unstaged).toBeNull();
    expect(recovery.error).toContain("index.lock");
    // The stamp is gone although unstaging failed.
    expect(isStepCompleted(progress, "tracking")).toBe(false);

    const lines = describeBlockedTracking(
      names.map((path) => ({ path, size: 200_000 })),
      recovery,
    );
    const command = lines.find((l) => l.includes("git --literal-pathspecs rm --cached"));
    expect(command).toBeDefined();
    // Every path is in the command, not the first five.
    for (const n of names) expect(command).toContain(n.includes("'") ? "it'\\''s 1.edf" : n);

    const before = (await run(["git", "ls-files"], dir)).stdout.split("\n").filter(Boolean);
    expect(before).toContain("sub-0/eeg/my file 0.edf");
    const ran = await run(["sh", "-c", (command as string).trim()], dir);
    expect(ran.exitCode).toBe(0);
    const after = (await run(["git", "ls-files"], dir)).stdout.split("\n").filter(Boolean);
    expect(after.filter((p) => p.endsWith(".edf"))).toEqual([]);
    // The files themselves are untouched.
    for (const n of names) expect(existsSync(join(dir, n))).toBe(true);
  });

  test("an unwritable progress file is reported, and the stamp is cleared in memory regardless", async () => {
    const { dir, progress } = await blockedMany("unsaved-progress", ["big.edf"]);
    // A file where the progress directory should be makes every write fail.
    rmSync(join(dir, ".nemar"), { recursive: true, force: true });
    writeFileSync(join(dir, ".nemar"), "in the way");
    const recovery = await recoverBlockedTracking(dir, progress, ["big.edf"]);
    expect(isStepCompleted(progress, "tracking")).toBe(false);
    expect(recovery.unstaged).toBe(1);
    expect(recovery.error).toContain("the upload progress could not be saved");
    expect(recovery.error).toContain("--restart");
  });
});

describe("unstageTrackedPaths takes names literally", () => {
  test("a name with a star unstages that file and no other", async () => {
    // Guards `--literal-pathspecs`. Under git's own matching, `star*.txt` also removes
    // starfish.txt and starlight.txt from the index, and the upload now hands this
    // function arbitrary user file names.
    const { dir } = await dataset("literal", {});
    for (const f of ["star*.txt", "starfish.txt", "starlight.txt"]) writeFile(dir, f, f);
    expect((await run(["git", "add", "-A"], dir)).exitCode).toBe(0);
    await unstageTrackedPaths(dir, ["star*.txt"]);
    const tracked = (await run(["git", "ls-files"], dir)).stdout.split("\n").filter(Boolean);
    expect(tracked).toContain("starfish.txt");
    expect(tracked).toContain("starlight.txt");
    expect(tracked).not.toContain("star*.txt");
  });
});

describe("what the step says", () => {
  test("the summary covers every relation between sent, confirmed, present and re-sent", () => {
    expect(formatUploadSummary(0, 0, 0)).toBe("No annexed data files, so nothing was copied to S3");
    expect(formatUploadSummary(1, 0, 0)).toBe(
      "The 1 data file is already at the S3 remote (git-annex checked it; nothing to copy)",
    );
    expect(formatUploadSummary(165, 0, 0)).toBe(
      "All 165 data files are already at the S3 remote (git-annex checked each one; nothing to copy)",
    );
    // confirmed == sent == attempted: git-annex moved every file it was given.
    expect(formatUploadSummary(10, 4, 4)).toBe(
      "Uploaded 4 data files to S3; 6 were already at the remote; all recorded at the remote",
    );
    expect(formatUploadSummary(1, 1, 1)).toBe(
      "Uploaded 1 data file to S3; all recorded at the remote",
    );
    expect(formatUploadSummary(2, 1, 1)).toBe(
      "Uploaded 1 data file to S3; 1 was already at the remote; all recorded at the remote",
    );
    // confirmed < attempted: git-annex confirmed fewer than the log shows. Not "Uploaded".
    expect(formatUploadSummary(4, 4, 0)).toBe(
      "4 data files not yet recorded at the S3 remote were copied (git-annex confirmed 0 of 4; the rest are recorded in the location log); all recorded at the remote",
    );
    // confirmed > attempted: never claim more than was sent.
    expect(formatUploadSummary(3, 2, 3)).toBe(
      "2 data files not yet recorded at the S3 remote were copied (git-annex reported 3 successful copies for 2 files); 1 was already at the remote; all recorded at the remote",
    );
    // Confirmed, but git-annex transferred fewer than it was given: the others were
    // recorded in the log only, so "Uploaded" would be false for them.
    expect(formatUploadSummary(3, 3, 3, { sent: 1 })).toBe(
      "3 data files not yet recorded at the S3 remote were copied (git-annex reported transferring 1); all recorded at the remote",
    );
    // Files the log recorded but the remote had lost are said separately, and are never
    // folded into "nothing to copy".
    expect(formatUploadSummary(3, 0, 0, { resent: 3 })).toBe(
      "Sent no new files to S3; 3 were recorded but missing at the remote and were sent again; all recorded at the remote",
    );
    expect(formatUploadSummary(1, 0, 0, { resent: 1 })).toBe(
      "Sent no new files to S3; 1 was recorded but missing at the remote and was sent again; all recorded at the remote",
    );
    expect(formatUploadSummary(10, 4, 4, { resent: 2 })).toBe(
      "Uploaded 4 data files to S3; 4 were already at the remote; 2 were recorded but missing at the remote and were sent again; all recorded at the remote",
    );
    // The word "verified" claims a bucket listing that the summary does not make.
    for (const [t, a, c] of [
      [10, 4, 4],
      [4, 4, 0],
      [3, 2, 3],
      [165, 0, 0],
    ] as const) {
      expect(formatUploadSummary(t, a, c)).not.toContain("verified");
    }
  });

  test("output git-annex printed that was not understood is never rounded to the good case", () => {
    // Guards the order of checks: the state of the output is looked at BEFORE the early
    // return for "nothing to copy", or an exit-0 run that printed plain text still says
    // "git-annex checked each one".
    const checkedNothing = formatUploadSummary(2, 0, 0, { recordedOutput: "unrecognized" });
    expect(checkedNothing).toBe(
      "All 2 data files are recorded at the S3 remote (git-annex's output was not recognized, so what its check found is unknown)",
    );
    expect(checkedNothing).not.toContain("checked each one");
    expect(checkedNothing).not.toContain("already at the S3 remote");

    expect(formatUploadSummary(3, 3, 0, { output: "unrecognized" })).toBe(
      "3 data files not yet recorded at the S3 remote were copied (git-annex's output was not recognized, so how many it transferred is unknown; the location log is what shows them recorded); all recorded at the remote",
    );
    expect(formatUploadSummary(5, 2, 2, { recordedOutput: "unrecognized" })).toBe(
      "Uploaded 2 data files to S3; 3 were already recorded at the remote (git-annex's output was not recognized, so what its check found is unknown); all recorded at the remote",
    );
  });

  test("output that was readable but incomplete says git-annex gave no result, not that it was unrecognized", () => {
    // Guards the third state. Fewer records than paths on a clean exit is not a format the
    // CLI failed to read; git-annex gave no answer for some files, and the wording says so.
    const checked = formatUploadSummary(2, 0, 0, { recordedOutput: "partial" });
    expect(checked).toBe(
      "All 2 data files are recorded at the S3 remote (git-annex gave no result for some of them, so what its check found is unknown)",
    );
    expect(checked).not.toContain("not recognized");
    expect(checked).not.toContain("checked each one");

    const copied = formatUploadSummary(3, 3, 1, { output: "partial" });
    expect(copied).toContain("git-annex gave no result for some of them");
    expect(copied).not.toContain("not recognized");
    expect(copied).not.toContain("Uploaded");
    expect(formatUploadSummary(5, 2, 2, { recordedOutput: "partial" })).toBe(
      "Uploaded 2 data files to S3; 3 were already recorded at the remote (git-annex gave no result for some of them, so what its check found is unknown); all recorded at the remote",
    );
  });

  test("files with no local content are said to be checked with fsck, never with copy", () => {
    expect(formatUploadSummary(3, 0, 0, { recordedNoLocal: 3 })).toBe(
      "All 3 data files are already at the S3 remote (none has local content, so git-annex fsck checked them; nothing to copy)",
    );
    expect(formatUploadSummary(1, 0, 0, { recordedNoLocal: 1 })).toBe(
      "The 1 data file is already at the S3 remote (it has no local content, so it was checked with git-annex fsck; nothing to copy)",
    );
    expect(formatUploadSummary(5, 0, 0, { recordedNoLocal: 2 })).toBe(
      "All 5 data files are already at the S3 remote (3 checked by git-annex copy, 2 without local content checked with git-annex fsck; nothing to copy)",
    );
    expect(formatUploadSummary(5, 1, 1, { recordedNoLocal: 2 })).toBe(
      "Uploaded 1 data file to S3; 2 were already at the remote; 2 recorded files with no local content were checked with git-annex fsck; all recorded at the remote",
    );
  });

  test("a check skipped because a recent one covered them says what that check was", () => {
    // The claim is only what was checked: a check of this many recorded files, recently.
    // It does not say the remote "confirmed them", which a merged location log could make false.
    expect(formatUploadSummary(8, 0, 0, { recordedCheckSkipped: true })).toBe(
      "All 8 data files are recorded at the S3 remote; not checked again, because these files and their annex keys passed a check at this destination within the last 6 hours",
    );
    const mixed = formatUploadSummary(8, 2, 2, { recordedCheckSkipped: true });
    expect(mixed).toBe(
      "Uploaded 2 data files to S3; 6 already recorded at the remote were not checked again, because these files and their annex keys passed a check at this destination within the last 6 hours; all recorded at the remote",
    );
    expect(mixed).not.toContain("already at the remote");
    expect(mixed).not.toContain("confirmed");
  });
});
