/**
 * Targeted git-annex add (#884): argv chunking of path lists and the real
 * gitAnnexAdd behavior against a real git-annex repo (no mocks).
 *
 * Multi-TB uploads must add only the files that still need tracking, not the
 * whole tree; chunking keeps a thousands-of-files list under the OS argv
 * limit while letting each completed chunk persist its annexed state.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "bun";
import {
  ADD_CHUNK_MAX_BYTES,
  ADD_CHUNK_MAX_PATHS,
  chunkAddTargets,
  configureLargefiles,
  gitAnnexAdd,
  initDataset,
} from "../src/lib/git-annex/init";
import { copyToAnnexRemote } from "../src/lib/git-annex/transfer";
import {
  computeAddTargets,
  copyAnnexedToRemote,
  listAnnexedPaths,
  listAnnexedPathsNotAt,
  listTrackedPaths,
} from "../src/lib/upload/transfer";

// Each test builds a repository and runs git-annex a few times; CI machines are slower
// than the 5 s default allows.
setDefaultTimeout(60_000);

describe("chunkAddTargets", () => {
  test("empty list produces no chunks", () => {
    expect(chunkAddTargets([])).toEqual([]);
  });

  test("small list stays in one chunk, order preserved", () => {
    const paths = ["sub-01/eeg/a.edf", "sub-01/eeg/b.edf", "sub-02/eeg/c.edf"];
    expect(chunkAddTargets(paths)).toEqual([paths]);
  });

  test("splits by path count", () => {
    const paths = Array.from({ length: 1201 }, (_, i) => `sub-${i}/eeg/run-${i}.edf`);
    const chunks = chunkAddTargets(paths, 500);
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 201]);
    expect(chunks.flat()).toEqual(paths);
  });

  test("splits by byte budget before the count limit", () => {
    // 4 paths of ~60 bytes with a 130-byte budget: two per chunk.
    const paths = Array.from(
      { length: 4 },
      (_, i) => `sub-0${i}/ses-01/ieeg/${"x".repeat(40)}.eeg`,
    );
    const chunks = chunkAddTargets(paths, 500, 130);
    expect(chunks.map((c) => c.length)).toEqual([2, 2]);
    expect(chunks.flat()).toEqual(paths);
  });

  test("a single path longer than the byte budget still forms its own chunk", () => {
    const long = `sub-01/${"d".repeat(200)}.edf`;
    const chunks = chunkAddTargets(["a.edf", long, "b.edf"], 500, 64);
    expect(chunks).toEqual([["a.edf"], [long], ["b.edf"]]);
  });

  test("byte accounting uses utf8 length (multibyte paths do not overflow)", () => {
    // 3-byte chars: each path is ~90 bytes utf8 though only ~34 chars.
    const paths = Array.from({ length: 3 }, (_, i) => `sub-0${i}/${"世".repeat(28)}.edf`);
    const chunks = chunkAddTargets(paths, 500, 100);
    expect(chunks.map((c) => c.length)).toEqual([1, 1, 1]);
  });

  test("defaults: a realistic multi-TB manifest stays under both limits", () => {
    const paths = Array.from(
      { length: 3000 },
      (_, i) => `sub-${String(i).padStart(3, "0")}/ses-01/ieeg/sub-${i}_task-rest_run-1_ieeg.eeg`,
    );
    const chunks = chunkAddTargets(paths);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(ADD_CHUNK_MAX_PATHS);
      const bytes = chunk.reduce((sum, p) => sum + Buffer.byteLength(p, "utf8") + 1, 0);
      expect(bytes).toBeLessThanOrEqual(ADD_CHUNK_MAX_BYTES);
    }
    expect(chunks.flat()).toEqual(paths);
  });
});

const TMP_DIR = join(import.meta.dir, ".test-annex-add");

async function runCmd(
  cmd: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

// git-annex marks object files read-only; rm needs write+execute on dirs.
function chmodTreeWritable(dir: string): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      try {
        chmodSync(full, 0o755);
      } catch {}
      chmodTreeWritable(full);
    } else {
      try {
        chmodSync(full, 0o644);
      } catch {}
    }
  }
}

/**
 * Pin a synthetic identity in the repo's local config (same pattern as
 * git-annex-remote.test.ts). CI runners have no global git identity, and
 * every commit-producing step needs one -- including git-annex branch
 * writes from `git annex config`/`add`/`initremote`/`copy`, which run
 * WITHOUT the author env that initDataset sets for its own commands.
 */
async function setRepoIdentity(dir: string): Promise<void> {
  await runCmd(["git", "config", "user.email", "test@test.com"], dir);
  await runCmd(["git", "config", "user.name", "Test"], dir);
}

/** Real dataset repo through the production init path (unlocked adjusted branch). */
async function newDatasetRepo(name: string): Promise<string> {
  const dir = join(TMP_DIR, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const init = await initDataset(dir, { author: { name: "Test", email: "test@test.com" } });
  if (!init.success) {
    throw new Error(`initDataset failed: ${init.error}`);
  }
  await setRepoIdentity(dir);
  const largefiles = await configureLargefiles(dir);
  if (!largefiles.success) {
    throw new Error(`configureLargefiles failed: ${largefiles.error}`);
  }
  return dir;
}

function writeDataFile(dir: string, relPath: string, content: string): void {
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

async function annexedFiles(dir: string): Promise<string[]> {
  // --include='*' lists all annexed files in the tree, present or not.
  // No pathspec: "." fails with exit 1 while nothing is tracked yet.
  const { stdout, exitCode } = await runCmd(["git", "annex", "find", "--include", "*"], dir);
  expect(exitCode).toBe(0);
  return stdout.split("\n").filter(Boolean).sort();
}

beforeAll(async () => {
  const probe = await runCmd(["git", "annex", "version"]);
  if (probe.exitCode !== 0) {
    throw new Error("git-annex is required for this test file");
  }
});

afterAll(() => {
  if (existsSync(TMP_DIR)) {
    chmodTreeWritable(TMP_DIR);
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

describe("gitAnnexAdd with a target list (real git-annex)", () => {
  test("adds only the listed files; unlisted data files stay untracked", async () => {
    const dir = await newDatasetRepo("targeted");
    writeDataFile(dir, "sub-01/eeg/a.edf", "a".repeat(4096));
    writeDataFile(dir, "sub-01/eeg/b.edf", "b".repeat(4096));
    writeDataFile(dir, "sub-02/eeg/c.edf", "c".repeat(4096));

    const result = await gitAnnexAdd(dir, ["sub-01/eeg/a.edf", "sub-02/eeg/c.edf"]);
    expect(result.success).toBe(true);
    expect(await annexedFiles(dir)).toEqual(["sub-01/eeg/a.edf", "sub-02/eeg/c.edf"]);
  });

  test("empty target list is a successful no-op (no whole-tree add)", async () => {
    const dir = await newDatasetRepo("noop");
    writeDataFile(dir, "sub-01/eeg/a.edf", "a".repeat(4096));

    const result = await gitAnnexAdd(dir, []);
    expect(result.success).toBe(true);
    expect(await annexedFiles(dir)).toEqual([]);
  });

  test("re-adding an already-added unchanged file succeeds (resume path)", async () => {
    const dir = await newDatasetRepo("resume");
    writeDataFile(dir, "sub-01/eeg/a.edf", "a".repeat(4096));

    expect((await gitAnnexAdd(dir, ["sub-01/eeg/a.edf"])).success).toBe(true);
    expect((await gitAnnexAdd(dir, ["sub-01/eeg/a.edf"])).success).toBe(true);
    expect(await annexedFiles(dir)).toEqual(["sub-01/eeg/a.edf"]);
  });

  test("multi-chunk single call: the internal loop adds every file", async () => {
    const dir = await newDatasetRepo("chunked");
    const paths: string[] = [];
    for (let i = 0; i < 7; i++) {
      const p = `sub-0${i}/eeg/run-${i}.edf`;
      writeDataFile(dir, p, `${i}`.repeat(2048));
      paths.push(p);
    }
    // Drive the production entry point itself into multiple subprocess
    // invocations (7 paths / 3 per chunk = 3 chunks), rather than
    // pre-splitting with chunkAddTargets outside it.
    expect(chunkAddTargets(paths, 3).length).toBe(3);
    const result = await gitAnnexAdd(dir, paths, { maxPaths: 3 });
    expect(result.success).toBe(true);
    expect(await annexedFiles(dir)).toEqual([...paths].sort());
  });

  test("mid-chunk failure: earlier chunks persist, later chunks never run, remainder resumes", async () => {
    const dir = await newDatasetRepo("chunk-fail");
    const paths: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = `sub-0${i}/eeg/run-${i}.edf`;
      writeDataFile(dir, p, `${i}`.repeat(2048));
      paths.push(p);
    }
    // Chunks of 2 with a missing path in the SECOND chunk:
    //   [p0, p1] ok, [p2, MISSING] fails, [p3, p4] must never run.
    const withMissing = [paths[0], paths[1], paths[2], "sub-99/eeg/nope.edf", paths[3], paths[4]];
    const result = await gitAnnexAdd(dir, withMissing, { maxPaths: 2 });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();

    const annexed = await annexedFiles(dir);
    // The first chunk's adds persisted (index + inode cache checkpointed)...
    expect(annexed).toContain(paths[0]);
    expect(annexed).toContain(paths[1]);
    // ...and chunks after the failing one were never attempted, so the
    // caller (the tracking step) correctly stays incomplete.
    expect(annexed).not.toContain(paths[3]);
    expect(annexed).not.toContain(paths[4]);

    // A subsequent full-list call completes the remainder: already-added
    // files are cheap no-ops, missing ones get added.
    const resume = await gitAnnexAdd(dir, paths, { maxPaths: 2 });
    expect(resume.success).toBe(true);
    expect(await annexedFiles(dir)).toEqual([...paths].sort());
  });

  test("default '.' target still adds the whole tree (sandbox/e2e path)", async () => {
    const dir = await newDatasetRepo("whole-tree");
    writeDataFile(dir, "sub-01/eeg/a.edf", "a".repeat(4096));
    writeDataFile(dir, "sub-02/eeg/b.edf", "b".repeat(4096));

    const result = await gitAnnexAdd(dir);
    expect(result.success).toBe(true);
    expect(await annexedFiles(dir)).toEqual(["sub-01/eeg/a.edf", "sub-02/eeg/b.edf"]);
  });

  test("a missing target path fails loudly instead of succeeding silently", async () => {
    const dir = await newDatasetRepo("missing");
    const result = await gitAnnexAdd(dir, ["sub-99/eeg/nope.edf"]);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

/** Register a directory special remote and return its name. */
async function initDirectoryRemote(dir: string, name: string): Promise<string> {
  const remoteDir = join(
    TMP_DIR,
    `${name}-store-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(remoteDir, { recursive: true });
  const init = await runCmd(
    [
      "git",
      "annex",
      "initremote",
      name,
      "type=directory",
      `directory=${remoteDir}`,
      "encryption=none",
    ],
    dir,
  );
  expect(init.exitCode).toBe(0);
  return name;
}

describe("computeAddTargets (#884 review: reconcile against actual git state)", () => {
  const f = (path: string) => ({ path, size: 4096 });

  test("unions filesToUpload with untracked data files, deduped, order preserved", () => {
    const dataFiles = [f("sub-01/eeg/a.edf"), f("sub-01/eeg/b.edf"), f("sub-02/eeg/c.edf")];
    const filesToUpload = [f("sub-01/eeg/b.edf")];
    // a.edf tracked, b.edf tracked (but pending upload), c.edf missing from git
    const tracked = new Set(["sub-01/eeg/a.edf", "sub-01/eeg/b.edf", "dataset_description.json"]);
    const targets = computeAddTargets(filesToUpload, dataFiles, tracked);
    expect(targets.map((t) => t.path)).toEqual(["sub-01/eeg/b.edf", "sub-02/eeg/c.edf"]);
  });

  test("everything tracked and nothing to upload: empty add set (legitimate skip)", () => {
    const dataFiles = [f("sub-01/eeg/a.edf")];
    expect(computeAddTargets([], dataFiles, new Set(["sub-01/eeg/a.edf"]))).toEqual([]);
  });

  test("a file both untracked and pending upload appears once", () => {
    const dataFiles = [f("sub-01/eeg/a.edf")];
    const targets = computeAddTargets([f("sub-01/eeg/a.edf")], dataFiles, new Set());
    expect(targets.map((t) => t.path)).toEqual(["sub-01/eeg/a.edf"]);
  });
});

describe("progress file outliving .git (#884 review blocker, real repos)", () => {
  test("lost .git: uploaded-marked files are re-added and re-recorded at the remote", async () => {
    const dir = await newDatasetRepo("lost-git");
    const dataFiles = [
      { path: "sub-01/eeg/a.edf", size: 4096 },
      { path: "sub-01/eeg/b.edf", size: 4096 },
    ];
    for (const file of dataFiles) {
      writeDataFile(dir, file.path, file.path.repeat(200));
    }

    // First run: targeted add + copy to a directory special remote; the
    // location log records both files at the remote.
    expect(
      (
        await gitAnnexAdd(
          dir,
          dataFiles.map((f) => f.path),
        )
      ).success,
    ).toBe(true);
    await initDirectoryRemote(dir, "test-dir");
    expect((await copyToAnnexRemote(dir, "test-dir", 1)).success).toBe(true);
    expect(await listAnnexedPaths(dir, "test-dir")).toEqual(new Set(dataFiles.map((f) => f.path)));

    // Healthy resume: everything tracked, nothing to upload -> empty add set.
    expect(computeAddTargets([], dataFiles, await listTrackedPaths(dir))).toEqual([]);

    // Reviewer's reproduction: the progress file survives but .git does not
    // (rm -rf .git; same shape as a partial rsync to a compute node).
    chmodTreeWritable(join(dir, ".git"));
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    expect(
      (await initDataset(dir, { author: { name: "Test", email: "test@test.com" } })).success,
    ).toBe(true);
    // The local identity config died with .git; re-pin it for the re-init.
    await setRepoIdentity(dir);
    expect((await configureLargefiles(dir)).success).toBe(true);

    // filesToUpload is empty (progress says everything uploaded), but the
    // index reconcile puts both files back into the add set.
    const addTargets = computeAddTargets([], dataFiles, await listTrackedPaths(dir));
    expect(addTargets.map((f) => f.path)).toEqual(dataFiles.map((f) => f.path));

    // Re-add + re-copy re-establishes the location log. The step under test is the
    // production one (copy what the log lacks, then require every annexed file to be
    // recorded at the remote), not a predicate retyped here: a copy of the check
    // would keep passing after the check itself changed.
    expect(
      (
        await gitAnnexAdd(
          dir,
          addTargets.map((f) => f.path),
        )
      ).success,
    ).toBe(true);
    await initDirectoryRemote(dir, "test-dir");
    const outcome = await copyAnnexedToRemote({
      absolutePath: dir,
      remote: "test-dir",
      addTargets,
      dataFiles,
      jobs: 1,
    });
    expect(outcome).toMatchObject({ status: "ok", total: 2, attempted: 2 });
    expect(await listAnnexedPaths(dir)).toEqual(new Set(dataFiles.map((f) => f.path)));
    expect(await listAnnexedPaths(dir, "test-dir")).toEqual(new Set(dataFiles.map((f) => f.path)));
  });

  test("annexed file never copied is flagged by the location-log verification", async () => {
    const dir = await newDatasetRepo("partial-copy");
    const dataFiles = [
      { path: "sub-01/eeg/a.edf", size: 4096 },
      { path: "sub-02/eeg/c.edf", size: 4096 },
    ];
    for (const file of dataFiles) {
      writeDataFile(dir, file.path, file.path.repeat(200));
    }
    expect(
      (
        await gitAnnexAdd(
          dir,
          dataFiles.map((f) => f.path),
        )
      ).success,
    ).toBe(true);
    await initDirectoryRemote(dir, "test-dir");

    // Copy only a.edf; c.edf's content never reaches the remote.
    const copyOne = await runCmd(
      ["git", "annex", "copy", "--to", "test-dir", "sub-01/eeg/a.edf"],
      dir,
    );
    expect(copyOne.exitCode).toBe(0);

    // The production check names exactly the annexed file the remote does not hold...
    expect([...(await listAnnexedPathsNotAt(dir, "test-dir"))]).toEqual(["sub-02/eeg/c.edf"]);

    // ...and the step that uses it copies that file rather than trusting the earlier run.
    const outcome = await copyAnnexedToRemote({
      absolutePath: dir,
      remote: "test-dir",
      addTargets: dataFiles,
      dataFiles,
      jobs: 1,
    });
    expect(outcome).toMatchObject({ status: "ok", total: 2, attempted: 1 });
    expect(await listAnnexedPathsNotAt(dir, "test-dir")).toEqual(new Set());
  });

  test("listTrackedPaths surfaces git failure instead of returning an empty set", async () => {
    // Must live outside ANY repo: git ls-files walks up from its cwd, so a
    // scratch dir inside this project would silently use the project index.
    const notARepo = mkdtempSync(join(tmpdir(), "nemar-not-a-repo-"));
    try {
      await expect(listTrackedPaths(notARepo)).rejects.toThrow();
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});
