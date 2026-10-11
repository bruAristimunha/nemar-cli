/**
 * Issue #1070: uploadDataToS3's git-state reconcile (listTrackedPaths /
 * computeAddTargets, plus the "untracked despite recorded progress"
 * repair) used to live ENTIRELY inside `if (!isStepCompleted(progress,
 * "s3_upload"))`. Once a prior run stamped "s3_upload" complete, that
 * whole block -- including the reconcile itself -- was skipped on every
 * later invocation, so a data file added to the dataset after that point
 * was silently never uploaded: the function took the "already completed
 * (skipping)" branch and returned immediately without even looking at git
 * state.
 *
 * Drives the real production entry point (uploadDataToS3, src/lib/upload/
 * transfer.ts) in-process against a real git-annex repo on disk -- no
 * mocks. A hand-built UploadProgress fixture simulates a prior run that
 * finished with one file uploaded and "s3_upload" stamped complete
 * (exactly the shape `.nemar/upload-progress.json` has after a real
 * successful upload); a second data file is then added to the working
 * tree without going through any upload, matching a user re-running
 * `nemar dataset upload` after adding files to an already-published
 * dataset.
 *
 * The credentials endpoint is a real local server that always errors,
 * so `requestUploadCredentials` fails fast and deterministically without
 * ever reaching production or requiring live AWS credentials -- this test
 * proves the RECONCILE runs and reopens the gate (git-annex tracking is a
 * fully offline, git-verifiable side effect that happens strictly BEFORE
 * the credential request in uploadDataToS3), not that a full S3
 * round-trip succeeds (that needs live AWS credentials and belongs to the
 * e2e/sandbox suite, test/e2e-upload.test.ts).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "bun";
import { configureLargefiles, gitAnnexAdd, initDataset } from "../src/lib/git-annex/init";
import {
  type UploadProgress,
  clearUploadProgress,
  initUploadProgress,
  isStepCompleted,
  markFileUploaded,
  markStepCompleted,
  readUploadProgress,
} from "../src/lib/upload-progress";
import { saveDatasetStep } from "../src/lib/upload/finalize";
import { type UploadFileEntry, uploadDataToS3 } from "../src/lib/upload/transfer";
import type { DatasetInfo } from "../src/lib/upload/types";

const TMP_DIR = join(import.meta.dir, ".test-upload-s3-resume");

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

async function setRepoIdentity(dir: string): Promise<void> {
  await runCmd(["git", "config", "user.email", "test@test.com"], dir);
  await runCmd(["git", "config", "user.name", "Test"], dir);
}

/** Real dataset repo through the production init path (mirrors
 *  test/annex-add-targets.unit.test.ts's helper of the same shape). */
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
  const { stdout, exitCode } = await runCmd(["git", "annex", "find", "--include", "*"], dir);
  expect(exitCode).toBe(0);
  return stdout.split("\n").filter(Boolean).sort();
}

function fakeDatasetInfo(id: string): DatasetInfo {
  return {
    dataset_id: id,
    ssh_url: `git@github.com:nemarDatasets/${id}.git`,
    s3_prefix: `${id}/objects`,
    github_url: `https://github.com/nemarDatasets/${id}`,
    upload_urls: {},
    s3_config: { bucket: "nemar-test", region: "us-east-2", public_url: "https://example.invalid" },
  };
}

/** Real local server standing in for the backend's upload-credentials
 *  endpoint: always errors, so requestUploadCredentials fails fast without
 *  ever reaching production or needing live AWS credentials. */
function startFailingCredentialsServer(): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(JSON.stringify({ error: "no credentials in this test" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

let previousTestApiUrl: string | undefined;

beforeAll(async () => {
  const probe = await runCmd(["git", "annex", "version"]);
  if (probe.exitCode !== 0) {
    throw new Error("git-annex is required for this test file");
  }
  previousTestApiUrl = process.env.TEST_API_URL;
});

afterAll(() => {
  // Guarded restore (#1175): never assign `undefined` directly.
  if (previousTestApiUrl === undefined) delete process.env.TEST_API_URL;
  else process.env.TEST_API_URL = previousTestApiUrl;

  if (existsSync(TMP_DIR)) {
    chmodTreeWritable(TMP_DIR);
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

describe("uploadDataToS3 resume when s3_upload is already stamped complete (#1070)", () => {
  test("a data file added after a completed run is git-annex tracked and reopens s3_upload, instead of being silently skipped", async () => {
    const dir = await newDatasetRepo("resume-s3");
    const oldFile: UploadFileEntry = { path: "sub-01/eeg/a.edf", size: 4096, type: "data" };
    const newFile: UploadFileEntry = { path: "sub-02/eeg/b.edf", size: 4096, type: "data" };
    writeDataFile(dir, oldFile.path, "a".repeat(oldFile.size));

    // --- Simulate a PRIOR successful run: oldFile tracked + uploaded, both
    // "tracking" and "s3_upload" stamped complete -- the exact on-disk shape
    // a real finished upload leaves in .nemar/upload-progress.json.
    expect((await gitAnnexAdd(dir, [oldFile.path])).success).toBe(true);
    const progress: UploadProgress = initUploadProgress(dir, "nm000900", [oldFile]);
    markStepCompleted(progress, "tracking");
    markFileUploaded(progress, oldFile.path, { size: oldFile.size });
    markStepCompleted(progress, "s3_upload");
    expect(isStepCompleted(progress, "s3_upload")).toBe(true);

    // --- Now a second data file lands in the working tree without ever
    // being uploaded -- e.g. the user added it and re-ran `nemar dataset
    // upload`. Confirm the starting state: genuinely untracked by git.
    writeDataFile(dir, newFile.path, "b".repeat(newFile.size));
    expect(await annexedFiles(dir)).toEqual([oldFile.path]);

    const dataFiles = [oldFile, newFile];
    // filesToUpload mirrors what the real CLI computes: oldFile is
    // unchanged+uploaded (excluded), newFile has no progress record (included).
    const filesToUpload = [newFile];

    const credServer = startFailingCredentialsServer();
    process.env.TEST_API_URL = credServer.url;
    let result: Awaited<ReturnType<typeof uploadDataToS3>>;
    try {
      result = await uploadDataToS3(
        dir,
        { jobs: "3" },
        dataFiles,
        filesToUpload,
        progress,
        fakeDatasetInfo("nm000900"),
      );
    } finally {
      credServer.stop();
    }

    // The credentials endpoint always errors, so the upload itself cannot
    // finish -- this test is not asserting a full S3 round-trip.
    expect(result.status).toBe("fail");

    // But the fix's actual claim: the RECONCILE ran despite s3_upload having
    // been stamped complete, and picked the new file up for tracking. Under
    // the pre-#1070 code this whole block, including gitAnnexAdd, never ran
    // at all -- the function returned "ok" immediately after printing
    // "S3 upload already completed (skipping)", and newFile stayed untracked.
    expect(await annexedFiles(dir)).toEqual([newFile.path, oldFile.path].sort());

    // The stale "s3_upload" completion stamp must have been cleared -- both
    // on the in-memory object the caller holds and on disk -- so a later
    // successful run (once credentials work) does not need a second manual
    // nudge to re-enter the upload path.
    expect(isStepCompleted(progress, "s3_upload")).toBe(false);
    expect(isStepCompleted(progress, "tracking")).toBe(true);
    const onDisk = readUploadProgress(dir);
    expect(onDisk).not.toBeNull();
    expect(isStepCompleted(onDisk as UploadProgress, "s3_upload")).toBe(false);

    clearUploadProgress(dir);
  });

  test("dataset_save and github_push are also reopened, so the new file's pointer actually gets committed (review finding, critical)", async () => {
    const dir = await newDatasetRepo("resume-s3-finalize");
    const oldFile: UploadFileEntry = { path: "sub-01/eeg/a.edf", size: 4096, type: "data" };
    const newFile: UploadFileEntry = { path: "sub-02/eeg/b.edf", size: 4096, type: "data" };
    writeDataFile(dir, oldFile.path, "a".repeat(oldFile.size));
    const author = { name: "Test", email: "test@test.com" };

    // --- Simulate a run that got all the way through pushMetadata (dataset.ts
    // Step 12) but was interrupted before printUploadSuccess ever cleared
    // progress (e.g. mid deployCiStep's network call, Step 12b): tracking,
    // s3_upload, dataset_save AND github_push all stamped complete, and
    // oldFile's pointer genuinely committed via the real saveDatasetStep.
    expect((await gitAnnexAdd(dir, [oldFile.path])).success).toBe(true);
    const progress: UploadProgress = initUploadProgress(dir, "nm000902", [oldFile]);
    markStepCompleted(progress, "tracking");
    markFileUploaded(progress, oldFile.path, { size: oldFile.size });
    markStepCompleted(progress, "s3_upload");
    expect((await saveDatasetStep(dir, author, progress)).status).toBe("ok");
    expect(isStepCompleted(progress, "dataset_save")).toBe(true);
    // No real GitHub remote in this harness; stamp github_push directly to
    // reach the exact "both finalize steps already complete" prior state.
    markStepCompleted(progress, "github_push");
    const commitsBefore = (await runCmd(["git", "log", "--oneline"], dir)).stdout
      .trim()
      .split("\n").length;

    // --- A second data file lands in the working tree after that point --
    // e.g. the user added it and re-ran `nemar dataset upload`.
    writeDataFile(dir, newFile.path, "b".repeat(newFile.size));
    const dataFiles = [oldFile, newFile];
    const filesToUpload = [newFile];

    const credServer = startFailingCredentialsServer();
    process.env.TEST_API_URL = credServer.url;
    let result: Awaited<ReturnType<typeof uploadDataToS3>>;
    try {
      result = await uploadDataToS3(
        dir,
        { jobs: "3" },
        dataFiles,
        filesToUpload,
        progress,
        fakeDatasetInfo("nm000902"),
      );
    } finally {
      credServer.stop();
    }
    // Credentials still fail deterministically; this is not asserting a
    // full S3 round-trip (see the file-level comment).
    expect(result.status).toBe("fail");

    // THE FIX: dataset_save and github_push must be reopened alongside
    // s3_upload/tracking. Before it, a resumed upload that picked up new
    // content would eventually re-complete s3_upload but dataset.ts's Step
    // 11/12 (saveDatasetStep/pushMetadata) would see dataset_save/
    // github_push still stamped true from the PRIOR run and skip entirely
    // -- the new file's git-annex pointer would reach S3 but never be
    // committed or pushed, and printUploadSuccess would still clear
    // progress and report "Upload complete!".
    expect(isStepCompleted(progress, "dataset_save")).toBe(false);
    expect(isStepCompleted(progress, "github_push")).toBe(false);
    const onDisk = readUploadProgress(dir);
    expect(onDisk).not.toBeNull();
    expect(isStepCompleted(onDisk as UploadProgress, "dataset_save")).toBe(false);
    expect(isStepCompleted(onDisk as UploadProgress, "github_push")).toBe(false);

    // --- Drive the REAL saveDatasetStep (dataset.ts Step 11) now that
    // dataset_save is reopened, proving the new file's pointer actually
    // gets committed rather than silently skipped.
    expect((await saveDatasetStep(dir, author, progress)).status).toBe("ok");
    expect(isStepCompleted(progress, "dataset_save")).toBe(true);
    const committed = await runCmd(["git", "show", "--stat", "HEAD"], dir);
    expect(committed.stdout).toContain(newFile.path);
    const commitsAfter = (await runCmd(["git", "log", "--oneline"], dir)).stdout
      .trim()
      .split("\n").length;
    expect(commitsAfter).toBeGreaterThan(commitsBefore);

    clearUploadProgress(dir);
  });

  test("nothing new to upload: s3_upload stays complete and no git-annex add runs (fast path preserved)", async () => {
    const dir = await newDatasetRepo("resume-s3-noop");
    const oldFile: UploadFileEntry = { path: "sub-01/eeg/a.edf", size: 4096, type: "data" };
    writeDataFile(dir, oldFile.path, "a".repeat(oldFile.size));
    expect((await gitAnnexAdd(dir, [oldFile.path])).success).toBe(true);
    // A genuinely finished upload has its files recorded at the S3 remote. (Annexed files
    // with no remote at all are NOT a finished upload, and step 9 now reopens on them;
    // test/upload-data-steps.unit.test.ts covers that.) A directory remote stands in.
    const store = join(TMP_DIR, `store-${Date.now()}`);
    mkdirSync(store, { recursive: true });
    const remote = await runCmd(
      [
        "git",
        "annex",
        "initremote",
        "nemar-s3",
        "type=directory",
        `directory=${store}`,
        "encryption=none",
      ],
      dir,
    );
    expect(remote.exitCode).toBe(0);
    const copied = await runCmd(
      ["git", "annex", "copy", "--to", "nemar-s3", "--", oldFile.path],
      dir,
    );
    expect(copied.exitCode).toBe(0);

    const progress: UploadProgress = initUploadProgress(dir, "nm000901", [oldFile]);
    markStepCompleted(progress, "tracking");
    markFileUploaded(progress, oldFile.path, { size: oldFile.size });
    markStepCompleted(progress, "s3_upload");

    // No new files, nothing changed: filesToUpload is empty, exactly like a
    // genuinely finished dataset being re-run with no local changes.
    const dataFiles = [oldFile];
    const filesToUpload: UploadFileEntry[] = [];

    const result = await uploadDataToS3(
      dir,
      { jobs: "3" },
      dataFiles,
      filesToUpload,
      progress,
      fakeDatasetInfo("nm000901"),
    );

    // The reconcile still runs (cheap, always-on per #1070), finds nothing
    // to add, and the expensive path -- including any network call -- is
    // never entered, so this succeeds with no credentials server at all.
    expect(result.status).toBe("ok");
    expect(isStepCompleted(progress, "s3_upload")).toBe(true);

    clearUploadProgress(dir);
  });
});
