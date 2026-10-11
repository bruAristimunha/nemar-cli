/**
 * Upload steps 9 to 11 driven as the command drives them: `runDataSteps` for the
 * three together, `uploadDataToS3` for the copy on its own, both against real git-annex
 * and a real `directory` special remote called `nemar-s3`.
 *
 * What a test supplies is how the remote is opened (`deps.openRemote`: production asks
 * the backend for STS credentials and configures an S3 remote, which a test cannot do),
 * and, where a test needs it, the save's size gate (`skipMinBytes`, so a small tree takes
 * the large-tree branch) and a wrapper around the save (`saveStep`, to see what it was
 * handed). Everything else, including the outcome switch that marks files uploaded,
 * clears credentials and recovers a blocked upload, is the production code.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { clearStaleFlags, setAssumeUnchanged } from "../src/lib/git-annex/clone-push";
import { annexRemoteExists, configureS3Remote } from "../src/lib/git-annex/s3-remote";
import { collectFileManifest } from "../src/lib/git-annex/transfer";
import {
  type UploadProgress,
  initUploadProgress,
  isStepCompleted,
  markFileUploaded,
  markStepCompleted,
  writeUploadProgress,
} from "../src/lib/upload-progress";
import { runDataSteps } from "../src/lib/upload/data-steps";
import { saveDatasetStep } from "../src/lib/upload/finalize";
import { computeFilesToUpload, prepareUploadProgress } from "../src/lib/upload/plan";
import {
  type OpenRemote,
  S3_REMOTE_NAME,
  ensureGitignoreHasNemar,
  listAnnexedPaths,
  trackDataFiles,
  uploadDataToS3,
} from "../src/lib/upload/transfer";
import { type DatasetInfo, FAIL, ok } from "../src/lib/upload/types";
import {
  annexedSet,
  commitCount,
  initDirectoryRemote,
  makeScratch,
  newDatasetRepo,
  prependPreCommit,
  run,
  tags,
  writeFile,
} from "./helpers/annex-repo";
import { installGitShim } from "./helpers/git-shim";

setDefaultTimeout(60_000);

const scratch = makeScratch("nemar-data-steps");

beforeAll(async () => {
  const probe = await run(["git", "annex", "version"]);
  if (probe.exitCode !== 0) throw new Error("git-annex is required for this test file");
});
afterAll(() => scratch.cleanup());

const MIB = 1024 * 1024;
/** A local port nothing listens on: a connection to it is refused at once. */
const DEAD_PROXY = "http://127.0.0.1:1";

// A leak guard. A proxy variable left set in this process would redirect every later
// `fetch` of the whole test run (Bun retains it), failing unrelated files.
const PROXY_VARIABLES = [
  "https_proxy",
  "HTTPS_PROXY",
  "http_proxy",
  "HTTP_PROXY",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;
const proxyAtLoad = Object.fromEntries(PROXY_VARIABLES.map((name) => [name, process.env[name]]));
afterAll(() => {
  for (const name of PROXY_VARIABLES) {
    if (process.env[name] !== proxyAtLoad[name]) {
      throw new Error(`${name} was changed in-process and not restored`);
    }
  }
});
const info: DatasetInfo = {
  dataset_id: "nm000996",
  ssh_url: "git@github.com:nemarDatasets/nm000996.git",
  s3_prefix: "nm000996/objects",
  github_url: "https://github.com/nemarDatasets/nm000996",
  upload_urls: {},
  s3_config: { bucket: "nemar-test", region: "us-east-2", public_url: "https://example.invalid" },
};

/** A dataset directory ready for an upload: a repo, `.nemar/` ignored, files written. */
async function dataset(name: string, files: Record<string, number | Buffer>): Promise<string> {
  const dir = await newDatasetRepo(scratch.root, name);
  ensureGitignoreHasNemar(dir);
  // Distinct content per file: identical bytes give identical hashes, and on a
  // case-insensitive filesystem a.edf and A.EDF then share one object path in the store.
  for (const [path, content] of Object.entries(files)) {
    writeFile(dir, path, typeof content === "number" ? `${path}:`.padEnd(content, "x") : content);
  }
  return dir;
}

/** An OpenRemote that registers the directory remote once, names it, and counts how often it is asked. */
function directoryRemote(dir: string): OpenRemote & { calls: number } {
  const open = async () => {
    open.calls += 1;
    if (!(await annexRemoteExists(dir, S3_REMOTE_NAME))) {
      await initDirectoryRemote(scratch.root, dir, S3_REMOTE_NAME);
    }
    return ok({ remoteIdentity: `directory:${dir}:${S3_REMOTE_NAME}` });
  };
  open.calls = 0;
  return open;
}

/** What the command does between the manifest and step 9, for one run. */
async function plan(dir: string) {
  const manifest = await collectFileManifest(dir);
  const { dataFiles, uploadProgress } = prepareUploadProgress(dir, manifest, {});
  return {
    dataFiles,
    uploadProgress,
    filesToUpload: computeFilesToUpload(uploadProgress, dataFiles),
  };
}

/** Run steps 9 to 11 once, the way the command does. */
async function runSteps(dir: string, deps: Parameters<typeof runDataSteps>[1]) {
  const p = await plan(dir);
  return runDataSteps(
    {
      absolutePath: dir,
      options: { jobs: "2" },
      ...p,
      datasetInfo: info,
      coAuthorEnrichment: undefined,
      author: undefined,
    },
    deps,
  );
}

function progressOf(dir: string): UploadProgress {
  return JSON.parse(readFileSync(join(dir, ".nemar", "upload-progress.json"), "utf-8"));
}

describe("a whole run of steps 9 to 11", () => {
  test("uploads, tracks case variants, saves, and records every file as uploaded", async () => {
    // Guards trackDataFiles being what step 9 tracks with: the large uppercase-suffix
    // motion file is excluded by git-annex's own globs, so a plain `git annex add` leaves
    // it in git and the run is refused.
    const dir = await dataset("whole", {
      "sub-01/eeg/a.edf": 3_000,
      "sub-01/eeg/small_UPPER.EDF": 3_000,
      "sub-03/motion/sub-03_task-walk_tracksys-imu_MOTION.tsv": 200_000,
      "dataset_description.json": 100,
    });
    const open = directoryRemote(dir);

    const result = await runSteps(dir, { openRemote: open });

    expect(result.status).toBe("ok");
    expect(open.calls).toBe(1);
    const data = [
      "sub-01/eeg/a.edf",
      "sub-01/eeg/small_UPPER.EDF",
      "sub-03/motion/sub-03_task-walk_tracksys-imu_MOTION.tsv",
    ];
    expect(await annexedSet(dir)).toEqual(new Set(data));
    expect(await listAnnexedPaths(dir, S3_REMOTE_NAME)).toEqual(new Set(data));
    const progress = progressOf(dir);
    for (const p of data) expect(progress.files[p].status).toBe("uploaded");
    for (const step of ["tracking", "s3_upload", "dataset_save"] as const) {
      expect(isStepCompleted(progress, step)).toBe(true);
    }
    const pointer = await run(["git", "cat-file", "-p", `HEAD:${data[2]}`], dir);
    expect(pointer.stdout.startsWith("/annex/objects/")).toBe(true);
  });

  test("the final save warns when git add is quiet and still completes", async () => {
    const fixtureEdf = join(
      import.meta.dir,
      "fixtures/bids-minimal/sub-01/eeg/sub-01_task-rest_eeg.edf",
    );
    const dir = await dataset("quiet-save", {
      "sub-01/eeg/sub-01_task-rest_eeg.edf": readFileSync(fixtureEdf),
    });
    const spinnerOutput = new PassThrough();
    let renderedOutput = "";
    spinnerOutput.on("data", (chunk: Buffer) => {
      renderedOutput += chunk.toString();
    });

    const result = await runSteps(dir, {
      openRemote: directoryRemote(dir),
      saveInactivityWarningAfterMs: 1,
      saveSpinnerStream: spinnerOutput,
    });

    expect(result.status).toBe("ok");
    expect(renderedOutput).toContain(
      "Warning: saving dataset changes has produced no stdout or stderr",
    );
    expect(renderedOutput).toContain("git add -A is still running");
    expect(isStepCompleted(progressOf(dir), "dataset_save")).toBe(true);
  });

  test("hands the save the annexed set the copy listed, and the remote to check against", async () => {
    // Guards the handoff between steps 9 and 11. The wrapper only observes: it calls the
    // real save with exactly what it was given.
    const dir = await dataset("handoff", { "a.edf": 3_000, "b.edf": 3_000 });
    const seen: Array<Parameters<typeof saveDatasetStep>[3]> = [];
    const result = await runSteps(dir, {
      openRemote: directoryRemote(dir),
      saveStep: (...args) => {
        seen.push(args[3]);
        return saveDatasetStep(...args);
      },
    });
    expect(result.status).toBe("ok");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.annexedPaths).toEqual(new Set(["a.edf", "b.edf"]));
    expect(seen[0]?.verifyRemote).toBe(S3_REMOTE_NAME);
  });

  test("the re-run a failed save asks for re-tracks the changed file, and the commit gets the NEW key", async () => {
    // The save's failure text promises that re-running re-tracks the file. That promise is
    // made of steps in other modules (the changed-list check, the upload list, the add, the
    // copy, the refreshed record), so drive the whole thing twice, the way the command does.
    // The wrapper edits the file in the window between the copy and the save, the real
    // window the stat guard exists for, and then calls the real save.
    const dir = await dataset("rerun", { "a.edf": 3_000, "b.edf": 3_000 });
    const open = directoryRemote(dir);
    let oldKey = "";
    const result = await runSteps(dir, {
      openRemote: open,
      skipMinBytes: 1,
      saveStep: async (...args) => {
        oldKey = (await run(["git", "annex", "lookupkey", "a.edf"], dir)).stdout.trim();
        writeFileSync(join(dir, "a.edf"), "e".repeat(3_000));
        const later = ((args[2].files["a.edf"].mtimeMs as number) + 5_000) / 1000;
        utimesSync(join(dir, "a.edf"), later, later);
        return saveDatasetStep(...args);
      },
    });
    expect(result.status).toBe("fail");
    expect(isStepCompleted(progressOf(dir), "dataset_save")).toBe(false);

    // The re-run: a fresh manifest sees the edit and the file goes round again.
    const second = await runSteps(dir, { openRemote: open, skipMinBytes: 1 });

    expect(second.status).toBe("ok");
    const newKey = (await run(["git", "annex", "lookupkey", "a.edf"], dir)).stdout.trim();
    expect(newKey).not.toBe(oldKey);
    const pointer = await run(["git", "cat-file", "-p", "HEAD:a.edf"], dir);
    expect(pointer.stdout.trim()).toBe(`/annex/objects/${newKey}`);
    expect(await listAnnexedPaths(dir, S3_REMOTE_NAME)).toEqual(new Set(["a.edf", "b.edf"]));
  });

  test("a dataset with no data files never opens the remote", async () => {
    const dir = await dataset("no-data", { "dataset_description.json": 100, README: 100 });
    const open = directoryRemote(dir);
    const result = await runSteps(dir, { openRemote: open });
    expect(result.status).toBe("ok");
    expect(open.calls).toBe(0);
    expect(isStepCompleted(progressOf(dir), "s3_upload")).toBe(true);
  });
});

describe("what the copy step does with each outcome", () => {
  test("a blocked file is recovered: unstaged, the stamp cleared, and nothing marked uploaded", async () => {
    // Guards the `blocked` branch. A large data file an inherited .gitattributes keeps in
    // git fails the step; the recovery has to leave a state the re-run can use.
    const dir = await dataset("blocked", { "ok.edf": 3_000 });
    writeFile(dir, ".gitattributes", "big*.edf annex.largefiles=nothing\n");
    writeFile(dir, "big.edf", 200_000);
    const open = directoryRemote(dir);

    const p = await plan(dir);
    const result = await uploadDataToS3(
      dir,
      { jobs: "2" },
      p.dataFiles,
      p.filesToUpload,
      p.uploadProgress,
      info,
      { openRemote: open },
    );

    expect(result.status).toBe("fail");
    const progress = progressOf(dir);
    expect(isStepCompleted(progress, "tracking")).toBe(false);
    expect(isStepCompleted(progress, "s3_upload")).toBe(false);
    expect(progress.files["ok.edf"].status).toBe("pending");
    expect(progress.files["big.edf"].status).toBe("pending");
    const tracked = (await run(["git", "ls-files"], dir)).stdout.split("\n");
    expect(tracked).not.toContain("big.edf");
    expect(existsSync(join(dir, "big.edf"))).toBe(true);
  });

  test("a copy that fails marks nothing uploaded and leaves s3_upload open", async () => {
    // Guards markFileUploaded coming after the outcome switch, not before it.
    const dir = await dataset("copy-fails", { "a.edf": 3_000, "b.edf": 3_000 });
    const open: OpenRemote = async () => {
      const store = await initDirectoryRemote(scratch.root, dir, S3_REMOTE_NAME);
      renameSync(store, `${store}.gone`);
      return ok({});
    };

    const p = await plan(dir);
    const result = await uploadDataToS3(
      dir,
      { jobs: "2" },
      p.dataFiles,
      p.filesToUpload,
      p.uploadProgress,
      info,
      { openRemote: open },
    );

    expect(result.status).toBe("fail");
    const progress = progressOf(dir);
    expect(progress.files["a.edf"].status).toBe("pending");
    expect(progress.files["b.edf"].status).toBe("pending");
    expect(isStepCompleted(progress, "s3_upload")).toBe(false);
  });

  test("cached credentials are removed after a copy that fails", async () => {
    const dir = await dataset("creds-copy-fails", { "a.edf": 3_000 });
    const open: OpenRemote = async () => {
      const store = await initDirectoryRemote(scratch.root, dir, S3_REMOTE_NAME);
      renameSync(store, `${store}.gone`);
      // What git-annex caches when it initializes an S3 remote with keys.
      mkdirSync(join(dir, ".git", "annex", "creds"), { recursive: true });
      writeFileSync(join(dir, ".git", "annex", "creds", "cached"), "AKIAFAKE\nsecret\n");
      return ok({});
    };
    const p = await plan(dir);
    const result = await uploadDataToS3(
      dir,
      { jobs: "2" },
      p.dataFiles,
      p.filesToUpload,
      p.uploadProgress,
      info,
      { openRemote: open },
    );
    expect(result.status).toBe("fail");
    expect(readdirSync(join(dir, ".git", "annex", "creds"))).toEqual([]);
  });

  test("cached credentials are removed after an S3 remote that failed to initialize", async () => {
    // Guards the credentials cleanup living in a `finally` around opening the remote too.
    // A failed `initremote` has already written the keys (mode 600) when it fails, so they
    // must be cleared although the step returns early. This runs the real configureS3Remote
    // against a closed local port: no traffic leaves the machine, so the failure is a
    // refused connection, and the keys in the file are made up.
    const dir = await dataset("creds-initremote-fails", { "a.edf": 3_000 });
    await run(["git", "config", "annex.security.allowed-ip-addresses", "all"], dir);
    // The dead proxy goes to git-annex's initremote ONLY, through the shim. Setting it on
    // process.env would also route every later `fetch` of this test run through it:
    // Bun keeps the proxy setting after the variable is restored, and test/openneuro.test.ts
    // then fails with ConnectionRefused when the files run in the same process.
    const restore = installGitShim(scratch.root, [
      {
        match: "annex initremote",
        env: { https_proxy: DEAD_PROXY, HTTPS_PROXY: DEAD_PROXY },
      },
    ]);
    const open: OpenRemote = async () => {
      const configured = await configureS3Remote(
        dir,
        {
          name: S3_REMOTE_NAME,
          bucket: "no-such-bucket",
          prefix: "nm000996/objects",
          region: "us-east-2",
        },
        { accessKeyId: "AKIAFAKE", secretAccessKey: "fake", sessionToken: "fake" },
      );
      expect(configured.success).toBe(false);
      // The premise: the failed initremote really did leave the keys behind.
      expect(readdirSync(join(dir, ".git", "annex", "creds")).length).toBeGreaterThan(0);
      return FAIL;
    };
    try {
      const p = await plan(dir);
      const result = await uploadDataToS3(
        dir,
        { jobs: "2" },
        p.dataFiles,
        p.filesToUpload,
        p.uploadProgress,
        info,
        { openRemote: open },
      );
      expect(result.status).toBe("fail");
    } finally {
      restore();
    }
    expect(readdirSync(join(dir, ".git", "annex", "creds"))).toEqual([]);
  });
});

describe("a run that cannot check for stale flags", () => {
  test("a corrupt index stops before tracking and says the upload must be retried", async () => {
    const dir = await dataset("flags-corrupt-index", { "a.edf": 3_000 });
    const indexPath = join(dir, ".git", "index");
    const index = readFileSync(indexPath);
    writeFileSync(indexPath, "not a git index\n");
    const open = directoryRemote(dir);
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    let result: Awaited<ReturnType<typeof runSteps>>;
    try {
      result = await runSteps(dir, { openRemote: open });
    } finally {
      console.log = log;
      writeFileSync(indexPath, index);
    }
    expect(result.status).toBe("fail");
    expect(open.calls).toBe(0);
    expect(await annexedSet(dir)).toEqual(new Set());
    const text = lines.join("\n");
    expect(text).toContain("Could not check this repository for assume-unchanged flags");
    expect(text).toContain("the upload stopped before tracking anything. Run the upload again");
    expect(text).not.toContain("nothing was saved");
    expect(text).not.toContain("Run the save again");
  });

  test("a real index lock prevents stale flags from being cleared", async () => {
    const dir = await dataset("flags-uncleared", { "a.edf": 3_000 });
    expect((await trackDataFiles(dir, ["a.edf"])).success).toBe(true);
    expect((await setAssumeUnchanged(dir, ["a.edf"], true)).success).toBe(true);
    const open = directoryRemote(dir);
    const lock = join(dir, ".git", "index.lock");
    writeFileSync(lock, "", { flag: "wx" });
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      const result = await runSteps(dir, { openRemote: open });
      expect(result.status).toBe("fail");
      expect(open.calls).toBe(0);
    } finally {
      console.log = log;
      rmSync(lock, { force: true });
    }
    const text = lines.join("\n");
    expect(text).toContain("Could not clear 1 assume-unchanged flag(s) on annexed files");
    expect(text).toContain("index.lock");
    expect(text).toContain("the upload stopped before tracking anything. Run the upload again.");
    expect(text).not.toContain("nothing was saved");
  });

  test("a directory outside any repository is reported with why it matters and what to do", async () => {
    const outside = join(scratch.root, "outside-any-repo");
    mkdirSync(outside, { recursive: true });
    const result = await clearStaleFlags(outside);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Could not find the git repository");
    expect(result.error).toContain("the upload stopped before tracking anything");
    expect(result.error).toContain("Run the upload again from the dataset directory");
  });
});

describe("a run killed inside the save", () => {
  test("an edit made afterwards is tracked, uploaded and committed by the resumed run", async () => {
    // The loss this guards: a run killed while the annexed paths are marked
    // assume-unchanged leaves the bits in the index; the user edits a file (same size,
    // new bytes); the resumed run's `git annex add` on that file exits 0 and changes
    // nothing, the progress record is then stamped with the post-edit size and mtime, the
    // save's stat guard matches, and `git add -A` skips the file again. HEAD keeps the old
    // bytes, the store never gets the edit, and the run says it saved. The resumed run
    // must clear the bits before it asks git to look at anything.
    const dir = await dataset("killed-in-the-save", { "a.edf": 3_000, "b.edf": 3_000 });
    const pidFile = join(dir, "..", `runner-${Math.random().toString(36).slice(2)}.pid`);
    const store = join(dir, "..", `store-${Math.random().toString(36).slice(2)}`);
    mkdirSync(store, { recursive: true });
    const restoreHook = prependPreCommit(dir, `kill -9 "$(cat "${pidFile}")"; exit 1`);

    // Run 1: killed by its own pre-commit hook, with the paths marked and nothing committed.
    const commitsBefore = await commitCount(dir);
    const child = Bun.spawn(
      ["bun", "run", join(import.meta.dir, "helpers", "data-steps-runner.ts"), dir, pidFile, store],
      { stdout: "pipe", stderr: "pipe" },
    );
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
    restoreHook();
    expect(Object.values(await tags(dir, "a.edf", "b.edf"))).toEqual(["h", "h"]);
    expect(await commitCount(dir)).toBe(commitsBefore);

    // The user edits a file: same size, different bytes, so size alone cannot tell.
    writeFileSync(join(dir, "a.edf"), "e".repeat(3_000));
    // The bit hides the edit: git shows the file as staged and NOT modified.
    const hidden = (await run(["git", "status", "--porcelain"], dir)).stdout;
    expect(hidden).toContain("A  a.edf");
    expect(hidden).not.toContain("AM a.edf");

    // Run 2: the resume.
    const open = directoryRemote(dir);
    const result = await runSteps(dir, { openRemote: open, skipMinBytes: 1 });

    expect(result.status).toBe("ok");
    const key = (await run(["git", "annex", "lookupkey", "a.edf"], dir)).stdout.trim();
    const pointer = await run(["git", "cat-file", "-p", "HEAD:a.edf"], dir);
    expect(pointer.stdout.trim()).toBe(`/annex/objects/${key}`);
    expect(readdirSync(store, { recursive: true }).some((e) => String(e).endsWith(`/${key}`))).toBe(
      true,
    );
    expect((await run(["git", "status", "--porcelain"], dir)).stdout.trim()).toBe("");
    expect(Object.values(await tags(dir, "a.edf", "b.edf"))).toEqual(["H", "H"]);
  });
});

describe("a run signaled inside the save", () => {
  /**
   * Start the runner on a dataset and wait until its save is inside the window, with the
   * paths marked assume-unchanged. A real pre-commit hook announces itself with a `ready`
   * file and waits for the test to let it go with a `stop` file.
   */
  async function inTheWindow(name: string) {
    const dir = await dataset(name, { "a.edf": 3_000, "b.edf": 3_000 });
    const tag = Math.random().toString(36).slice(2);
    const pidFile = join(dir, "..", `runner-${tag}.pid`);
    const ready = join(dir, "..", `ready-${tag}`);
    const stop = join(dir, "..", `stop-${tag}`);
    const store = join(dir, "..", `store-${tag}`);
    mkdirSync(store, { recursive: true });
    const restoreHook = prependPreCommit(
      dir,
      `touch "${ready}"; i=0; while [ ! -e "${stop}" ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i + 1)); done; exit 1`,
    );
    const child = Bun.spawn(
      ["bun", "run", join(import.meta.dir, "helpers", "data-steps-runner.ts"), dir, pidFile, store],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
    );
    const deadline = Date.now() + 40_000;
    while (!existsSync(ready)) {
      if (Date.now() > deadline) throw new Error("the runner never reached the window");
      await new Promise((r) => setTimeout(r, 50));
    }
    // The premise: the paths are marked and the save has not committed.
    expect(Object.values(await tags(dir, "a.edf", "b.edf"))).toEqual(["h", "h"]);
    const letHookGo = () => writeFileSync(stop, "");
    const release = () => {
      letHookGo();
      restoreHook();
    };
    return { dir, child, release, letHookGo };
  }

  test("a signal with nothing in the way takes the flags back before the process dies", async () => {
    const { dir, child, release } = await inTheWindow("signal-clean");
    child.kill("SIGTERM");
    await child.exited;
    release();
    expect(child.signalCode).toBe("SIGTERM");
    expect(Object.values(await tags(dir, "a.edf", "b.edf"))).toEqual(["H", "H"]);
  });

  test("an index lock that clears within the retry window does not leave the flags behind", async () => {
    // Guards the retry. With `index.lock` held (the usual state when the signal lands
    // during `git add -A`) a single unmark attempt fails; the handler stops the in-flight
    // git and retries, so a lock released a second later is enough. Without the retry the
    // process would die with every annexed file still flagged.
    const { dir, child, release } = await inTheWindow("signal-lock-clears");
    const lock = join(dir, ".git", "index.lock");
    writeFileSync(lock, "", { flag: "wx" });
    const sent = Date.now();
    child.kill("SIGTERM");
    setTimeout(() => rmSync(lock, { force: true }), 1_000);
    await child.exited;
    const waited = Date.now() - sent;
    release();
    rmSync(lock, { force: true });

    expect(child.signalCode).toBe("SIGTERM");
    // It really waited for the lock instead of giving up at once.
    expect(waited).toBeGreaterThanOrEqual(900);
    expect(Object.values(await tags(dir, "a.edf", "b.edf"))).toEqual(["H", "H"]);
  });

  test("a lock that never clears is reported with the way out, and the next entry clear repairs it", async () => {
    // Guards the message and the bound. After the retry window the handler stops waiting,
    // says what is wrong and what to run, and the process still dies by the signal. The
    // flags it could not clear are left for the next entry clear to repair.
    const { dir, child, release } = await inTheWindow("signal-lock-stays");
    const lock = join(dir, ".git", "index.lock");
    writeFileSync(lock, "", { flag: "wx" });
    const sent = Date.now();
    child.kill("SIGTERM");
    await child.exited;
    const waited = Date.now() - sent;
    const stderr = await new Response(child.stderr).text();
    release();

    expect(child.signalCode).toBe("SIGTERM");
    expect(waited).toBeLessThan(15_000);
    expect(stderr).toContain("2 annexed file(s) were marked assume-unchanged");
    expect(stderr).toContain("nemar dataset commit");
    expect(stderr).toContain("update-index --no-assume-unchanged -- 'a.edf' 'b.edf'");
    expect(Object.values(await tags(dir, "a.edf", "b.edf"))).toEqual(["h", "h"]);

    // The lock goes away (the person fixed it); the entry clear every upload step and
    // save starts with repairs the flags.
    rmSync(lock, { force: true });
    expect((await clearStaleFlags(dir)).cleared).toBe(2);
    expect(Object.values(await tags(dir, "a.edf", "b.edf"))).toEqual(["H", "H"]);
  });

  test("a repository path with an ESCAPE or an override in it is shown escaped, with no command to paste", async () => {
    // Guards displayName and isPrintableInCommand on the repository path in the recovery
    // message. The path is the user's data: printed raw it reaches the terminal, and
    // quoted into a command it would be pasted with the control character in it.
    const { dir, child, release } = await inTheWindow("signal-hostile-path-\u001b[2J-\u202e");
    const lock = join(dir, ".git", "index.lock");
    writeFileSync(lock, "", { flag: "wx" });
    child.kill("SIGTERM");
    await child.exited;
    const output = await new Response(child.stderr).text();
    release();
    rmSync(lock, { force: true });

    expect(child.signalCode).toBe("SIGTERM");
    // What the handler wrote: the child's own progress lines before it carry chalk's
    // colors, which are not file names.
    const stderr = output.slice(output.indexOf("Interrupted while"));
    expect(stderr).toContain("nemar dataset commit");
    expect(stderr).toContain("signal-hostile-path-\\x1b[2J-\\u202e");
    expect(stderr).not.toContain("\u001b");
    expect(stderr).not.toContain("\u202e");
    expect(stderr).not.toContain("To clear them by hand");
  });
});

describe("the location log decides, not the add targets", () => {
  /** A dataset whose progress file says everything is uploaded while one file never was. */
  async function claimedUploaded(name: string) {
    const dir = await dataset(name, { "a.edf": 3_000, "b.edf": 3_000 });
    expect((await trackDataFiles(dir, ["a.edf", "b.edf"])).success).toBe(true);
    const manifest = await collectFileManifest(dir);
    const data = manifest.files.filter((f) => f.type === "data");
    const progress = initUploadProgress(dir, info.dataset_id, data);
    for (const f of data) markFileUploaded(progress, f.path, f);
    for (const step of ["tracking", "s3_upload", "dataset_save", "github_push"] as const) {
      markStepCompleted(progress, step);
    }
    writeUploadProgress(dir, progress);
    // Only a.edf ever reached the remote.
    const open = directoryRemote(dir);
    await open();
    expect(
      (await run(["git", "annex", "copy", "--to", S3_REMOTE_NAME, "--", "a.edf"], dir)).exitCode,
    ).toBe(0);
    open.calls = 0;
    return { dir, open };
  }

  test("a file tracked but never copied is copied on a run with nothing to add", async () => {
    // Guards `listPendingAtRemote` being asked BEFORE the empty-add-targets gate. A gate
    // that skipped it would print "No data files to upload to S3" with no add targets and
    // stamp the step complete, whatever the log said.
    const { dir, open } = await claimedUploaded("never-copied");
    const p = await plan(dir);
    expect(p.filesToUpload).toEqual([]);

    const result = await uploadDataToS3(
      dir,
      { jobs: "2" },
      p.dataFiles,
      p.filesToUpload,
      p.uploadProgress,
      info,
      { openRemote: open },
    );

    expect(result.status).toBe("ok");
    expect(open.calls).toBe(1);
    expect(await listAnnexedPaths(dir, S3_REMOTE_NAME)).toEqual(new Set(["a.edf", "b.edf"]));
    // A completed stamp is reopened, and the finalize steps with it.
    const progress = progressOf(dir);
    expect(isStepCompleted(progress, "s3_upload")).toBe(true);
    expect(isStepCompleted(progress, "dataset_save")).toBe(false);
    expect(isStepCompleted(progress, "github_push")).toBe(false);
  });

  test("when everything is recorded the stamp is honored and the remote is never opened", async () => {
    const { dir, open } = await claimedUploaded("all-recorded");
    expect(
      (await run(["git", "annex", "copy", "--to", S3_REMOTE_NAME, "--", "b.edf"], dir)).exitCode,
    ).toBe(0);
    const p = await plan(dir);
    const result = await uploadDataToS3(
      dir,
      { jobs: "2" },
      p.dataFiles,
      p.filesToUpload,
      p.uploadProgress,
      info,
      { openRemote: open },
    );
    expect(result.status).toBe("ok");
    expect(open.calls).toBe(0);
    expect(isStepCompleted(progressOf(dir), "dataset_save")).toBe(true);
  });

  test("a file the save itself annexed fails the run, and a re-run uploads it", async () => {
    // Characterizes the gap recorded in ADR 0031. The CLI folds case, so it calls an
    // uppercase BIG.JSON metadata and never hands it to `git annex add`; git-annex's
    // case-sensitive `exclude=*.json` misses it, so the save's `git add -A` annexes it by
    // size AFTER the copy. Its content is then only here, so the run must not end in
    // "Upload complete" with that pointer on its way to GitHub.
    const dir = await dataset("big-json", { "ok.edf": 3_000, "BIG.JSON": 200_000 });
    const open = directoryRemote(dir);

    const first = await runSteps(dir, { openRemote: open });

    expect(first.status).toBe("fail");
    // The commit exists, and holds a pointer for BIG.JSON that the remote cannot resolve.
    const pointer = await run(["git", "cat-file", "-p", "HEAD:BIG.JSON"], dir);
    expect(pointer.stdout.startsWith("/annex/objects/")).toBe(true);
    expect(await listAnnexedPaths(dir, S3_REMOTE_NAME)).toEqual(new Set(["ok.edf"]));
    const stuck = progressOf(dir);
    expect(isStepCompleted(stuck, "s3_upload")).toBe(false);
    expect(isStepCompleted(stuck, "dataset_save")).toBe(false);

    // The re-run has no add targets at all; the log is what tells it BIG.JSON is missing.
    const second = await runSteps(dir, { openRemote: open });

    expect(second.status).toBe("ok");
    expect(await listAnnexedPaths(dir, S3_REMOTE_NAME)).toEqual(new Set(["ok.edf", "BIG.JSON"]));
    const done = progressOf(dir);
    expect(isStepCompleted(done, "s3_upload")).toBe(true);
    expect(isStepCompleted(done, "dataset_save")).toBe(true);
  });

  test("the names of files the save stranded are shown escaped", async () => {
    // Guards displayNames in the stranded-files message: the name is the user's data, and a
    // newline in it must not split the message into a line that is not part of it.
    const dir = await dataset("stranded-hostile-name", {
      "ok.edf": 3_000,
      "BIG\nNAME.JSON": 200_000,
    });
    const lines: string[] = [];
    const log = console.log;
    const write = process.stderr.write.bind(process.stderr);
    console.log = (...args: unknown[]) => {
      lines.push(args.join(" "));
    };
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let status: string;
    try {
      status = (await runSteps(dir, { openRemote: directoryRemote(dir) })).status;
    } finally {
      console.log = log;
      process.stderr.write = write;
    }

    expect(status).toBe("fail");
    const text = lines.join("\n");
    expect(text).toContain("not recorded at the remote: BIG\\nNAME.JSON");
    expect(text).not.toContain("BIG\nNAME");
  });
});
