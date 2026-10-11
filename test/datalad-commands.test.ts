/**
 * DataLad-like Commands Tests
 *
 * Tests for: clone, get, save, push, drop
 * Uses real git-annex operations in temporary directories.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";
import { LIVE_TARGET_BLOCKED, sleep } from "./setup";

/**
 * `test.skipIf(LIVE_TARGET_BLOCKED)` marks a case that cannot pass without a live
 * backend. Blocked means `TEST_API_URL` is unset or names production, so the
 * harness has pointed the run at a dead address (test/live-target.ts).
 *
 * These are skips rather than failures because "you have no dev backend
 * configured" is not a defect in the code under test, and a suite that always
 * fails locally teaches people to ignore failures. CI sets TEST_API_URL, so they
 * all still run there.
 *
 * Several of them USED TO PASS by querying production directly -- an invalid key
 * getting a real 401, a non-existent dataset getting a real 404. That is what this
 * annotation is really recording.
 */
const TMP_DIR = join(import.meta.dir, ".test-datalad");

function createTestContext() {
  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const configDir = join(import.meta.dir, ".test-configs", uniqueId);
  mkdirSync(configDir, { recursive: true });
  const configFile = join(configDir, "config.json");
  return { configDir, configFile };
}

async function runCli(
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; configDir?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd: ["bun", "run", join(import.meta.dir, "..", "src", "index.ts"), ...args],
    cwd: options.cwd || join(import.meta.dir, ".."),
    env: {
      ...process.env,
      ...(options.configDir ? { NEMAR_CONFIG_DIR: options.configDir } : {}),
      ...options.env,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

async function runCmd(
  cmd: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd,
    cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

async function createTempAnnexRepo(): Promise<string> {
  const dir = join(TMP_DIR, `repo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });

  await runCmd(["git", "init"], dir);
  await runCmd(["git", "config", "user.email", "test@test.com"], dir);
  await runCmd(["git", "config", "user.name", "Test User"], dir);
  await runCmd(["git", "annex", "init", "test-repo"], dir);

  return dir;
}

beforeEach(async () => {
  await sleep(100);
});

// git-annex marks an object file, and the key-named directory holding it,
// read-only (no owner write) -- both the local `.git/annex/objects/...` tree
// and a directory special remote's own object tree get this treatment. That
// makes plain `rmSync(..., { force: true })` throw ENOTEMPTY partway through
// instead of skipping the entry: `force` ignores a missing path, not a denied
// one. Restoring write permission bottom-up first is what the other
// git-annex-fixture suites do (test/git-annex-remote.test.ts,
// test/no-verify-annex.unit.test.ts); this file needed the same fix once its
// "get --no-verify" tests started adding a directory remote of their own.
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

afterAll(() => {
  if (existsSync(TMP_DIR)) {
    chmodTreeWritable(TMP_DIR);
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

// ============================================================================
// Help output and command existence
// ============================================================================

describe("datalad commands - help output", () => {
  test("dataset --help lists clone, get, save, push, drop", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clone");
    expect(stdout).toContain("get");
    expect(stdout).toContain("save");
    expect(stdout).toContain("push");
    expect(stdout).toContain("drop");
  });

  test("dataset clone --help shows usage", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "clone", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("dataset-id");
    expect(stdout).toContain("Clone a dataset from NEMAR");
  });

  test("dataset get --help shows usage", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "get", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Download annexed data files");
    expect(stdout).toContain("--jobs");
  });

  test("dataset save --help shows usage", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "save", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Stage and commit");
    expect(stdout).toContain("--message");
  });

  test("dataset push --help shows usage", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "push", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Push commits and data");
    expect(stdout).toContain("--no-s3");
  });

  test("dataset drop --help shows usage", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "drop", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Free local copies");
  });
});

// ============================================================================
// Error handling - not in a dataset directory
// ============================================================================

describe("datalad commands - non-dataset directory errors", () => {
  test("get fails outside dataset directory", async () => {
    const tmpDir = join(TMP_DIR, "empty-dir");
    mkdirSync(tmpDir, { recursive: true });

    const { stdout, exitCode } = await runCli(["dataset", "get"], { cwd: tmpDir });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Not inside a git-annex dataset");
  });

  test("save fails outside dataset directory", async () => {
    const tmpDir = join(TMP_DIR, "empty-dir-2");
    mkdirSync(tmpDir, { recursive: true });

    const { stdout, exitCode } = await runCli(["dataset", "save"], { cwd: tmpDir });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Not inside a git-annex dataset");
  });

  test("push fails outside dataset directory", async () => {
    const tmpDir = join(TMP_DIR, "empty-dir-3");
    mkdirSync(tmpDir, { recursive: true });

    const { stdout, exitCode } = await runCli(["dataset", "push"], { cwd: tmpDir });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Not inside a git-annex dataset");
  });

  test("drop fails outside dataset directory", async () => {
    const tmpDir = join(TMP_DIR, "empty-dir-4");
    mkdirSync(tmpDir, { recursive: true });

    const { stdout, exitCode } = await runCli(["dataset", "drop"], { cwd: tmpDir });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Not inside a git-annex dataset");
  });
});

// ============================================================================
// Clone - error cases
// ============================================================================

describe("datalad commands - clone errors", () => {
  test.skipIf(LIVE_TARGET_BLOCKED)("clone fails for non-existent dataset", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "clone", "nm999999"]);
    expect(exitCode).toBe(1);
    // Error message appears via console.log fallback after spinner
    expect(stdout.includes("not found") || stdout.includes("404")).toBe(true);
  });

  test("clone fails if output path exists", async () => {
    const existingDir = join(TMP_DIR, "existing-dir");
    mkdirSync(existingDir, { recursive: true });

    // Use a dataset that resolves but path exists
    // This test just verifies the path-exists check works
    const { stdout, exitCode } = await runCli(["dataset", "clone", "nm000104", "-o", existingDir]);
    // It might fail at path check (exit 1) or at dataset resolution (exit 1)
    expect(exitCode).toBe(1);
  });
});

// ============================================================================
// Save - real git-annex operations
// ============================================================================

describe("datalad commands - save in real repo", () => {
  test("save with no changes succeeds (exit 0)", async () => {
    const repoDir = await createTempAnnexRepo();

    // Create initial file and commit it
    writeFileSync(join(repoDir, "README.md"), "# Test Dataset\n");
    await runCmd(["git", "add", "README.md"], repoDir);
    await runCmd(["git", "commit", "-m", "Initial commit"], repoDir);

    // Run save with no new changes
    const { exitCode } = await runCli(["dataset", "save", "-m", "No changes"], {
      cwd: repoDir,
    });
    expect(exitCode).toBe(0);
  });

  test("save commits new files", async () => {
    const repoDir = await createTempAnnexRepo();

    // Create initial commit
    writeFileSync(join(repoDir, "README.md"), "# Test\n");
    await runCmd(["git", "add", "README.md"], repoDir);
    await runCmd(["git", "commit", "-m", "init"], repoDir);

    // Add a new file
    writeFileSync(join(repoDir, "data.txt"), "some data content\n");

    // Run save
    const { exitCode } = await runCli(["dataset", "save", "-m", "Add data file"], { cwd: repoDir });
    expect(exitCode).toBe(0);

    // Verify commit exists in git log
    const { stdout: logOut } = await runCmd(["git", "log", "--oneline", "-1"], repoDir);
    expect(logOut).toContain("Add data file");
  });

  test("save uses default message when -m not provided", async () => {
    const repoDir = await createTempAnnexRepo();

    writeFileSync(join(repoDir, "file1.txt"), "content\n");
    await runCmd(["git", "add", "."], repoDir);
    await runCmd(["git", "commit", "-m", "init"], repoDir);

    writeFileSync(join(repoDir, "file2.txt"), "new file\n");

    const { exitCode } = await runCli(["dataset", "save"], { cwd: repoDir });
    expect(exitCode).toBe(0);

    // Verify default commit message
    const { stdout: logOut } = await runCmd(["git", "log", "--oneline", "-1"], repoDir);
    expect(logOut).toContain("Save changes");
  });
});

// ============================================================================
// Drop - real git-annex operations
// ============================================================================

describe("datalad commands - drop in real repo", () => {
  test("drop with no annexed files is handled gracefully", async () => {
    const repoDir = await createTempAnnexRepo();

    // Create a regular git file (not annexed)
    writeFileSync(join(repoDir, "README.md"), "# Test\n");
    await runCmd(["git", "add", "README.md"], repoDir);
    await runCmd(["git", "commit", "-m", "init"], repoDir);

    const { stdout, exitCode } = await runCli(["dataset", "drop"], { cwd: repoDir });
    // drop with no annexed files: either succeeds with 0 dropped or fails gracefully
    expect(exitCode === 0 || stdout.includes("Dropped 0")).toBe(true);
  });

  test("drop refuses without remote copies (safety check)", async () => {
    const repoDir = await createTempAnnexRepo();

    // Configure largefiles to annex all files
    await runCmd(["git", "annex", "config", "--set", "annex.largefiles", "anything"], repoDir);

    // Add a file via git-annex
    writeFileSync(join(repoDir, "data.bin"), "binary data content here");
    await runCmd(["git", "annex", "add", "data.bin"], repoDir);
    await runCmd(["git", "commit", "-m", "Add binary data"], repoDir);

    // Try to drop without any remote - should fail (unsafe)
    const { stdout, exitCode } = await runCli(["dataset", "drop", "data.bin"], { cwd: repoDir });
    // git-annex should refuse to drop since there's no remote copy
    expect(exitCode === 1 || stdout.includes("kept")).toBe(true);
  });
});

// ============================================================================
// Push - error cases (no remote configured)
// ============================================================================

describe("datalad commands - push errors", () => {
  test("push fails when no remote is configured", async () => {
    const repoDir = await createTempAnnexRepo();

    writeFileSync(join(repoDir, "README.md"), "# Test\n");
    await runCmd(["git", "add", "README.md"], repoDir);
    await runCmd(["git", "commit", "-m", "init"], repoDir);

    const { stdout, exitCode } = await runCli(["dataset", "push", "--no-s3"], { cwd: repoDir });
    expect(exitCode).toBe(1);
    // The privacy preflight now refuses the push before Git can attempt a
    // main-branch update when there is no verifiable fetch/push destination.
    expect(stdout).toContain("Push stopped before the main branch was updated");
    expect(stdout).toContain("remote fetch and push URLs could not be verified");
  });
});

// ============================================================================
// Get - error case (no remote data)
// ============================================================================

describe("datalad commands - get errors", () => {
  test("get with no remotes configured fails gracefully", async () => {
    const repoDir = await createTempAnnexRepo();

    // Add an annexed file with no remote
    await runCmd(["git", "annex", "config", "--set", "annex.largefiles", "anything"], repoDir);
    writeFileSync(join(repoDir, "data.bin"), "test data");
    await runCmd(["git", "annex", "add", "data.bin"], repoDir);
    await runCmd(["git", "commit", "-m", "Add data"], repoDir);

    // Drop the content (force, since no remote)
    await runCmd(["git", "annex", "drop", "--force", "data.bin"], repoDir);

    // Try to get - should fail since no remote has it
    const { stdout, exitCode } = await runCli(["dataset", "get", "data.bin"], { cwd: repoDir });
    expect(exitCode).toBe(1);
    // git-annex error message is printed via console.log
    expect(stdout.includes("failed") || stdout.includes("Failed")).toBe(true);
  });
});

// ============================================================================
// Get --no-verify (#1523): real end-to-end wiring through the CLI entry
// point, not just the library function. A directory special remote stands in
// for S3 so the fixture needs no credentials or network; corrupting its
// object on disk reproduces a bad transfer the way test/no-verify-annex.unit
// .test.ts does at the getDatasetData layer -- this file instead proves
// Commander's `--no-verify` actually reaches that layer end to end.
// ============================================================================

describe("datalad commands - get --no-verify (#1523)", () => {
  /** A repo with one annexed file copied to a directory remote and dropped
   *  locally, so `nemar dataset get` must fetch it from that remote. */
  async function repoWithCorruptibleRemote(
    name: string,
    content: string,
  ): Promise<{ repoDir: string; objectPath: string; declaredSize: number }> {
    const repoDir = await createTempAnnexRepo();
    await runCmd(["git", "annex", "config", "--set", "annex.largefiles", "anything"], repoDir);
    writeFileSync(join(repoDir, "data.bin"), content);
    await runCmd(["git", "annex", "add", "data.bin"], repoDir);
    await runCmd(["git", "commit", "-m", "Add data"], repoDir);

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
        "store",
        "type=directory",
        `directory=${remoteDir}`,
        "encryption=none",
      ],
      repoDir,
    );
    expect(init.exitCode).toBe(0);
    const copy = await runCmd(["git", "annex", "copy", "--to", "store", "data.bin"], repoDir);
    expect(copy.exitCode).toBe(0);
    const drop = await runCmd(["git", "annex", "drop", "--force", "data.bin"], repoDir);
    expect(drop.exitCode).toBe(0);

    const keyResult = await runCmd(["git", "annex", "lookupkey", "data.bin"], repoDir);
    const key = keyResult.stdout.trim();
    const sizeMatch = key.match(/-s(\d+)--/);
    if (!sizeMatch) throw new Error(`key ${key} does not embed a size`);
    const declaredSize = Number.parseInt(sizeMatch[1], 10);

    const find = await runCmd(["find", remoteDir, "-name", key, "-type", "f"], repoDir);
    const objectPath = find.stdout.trim().split("\n")[0];
    if (!objectPath) throw new Error("could not locate the remote object on disk");

    return { repoDir, objectPath, declaredSize };
  }

  async function makeWritable(objectPath: string): Promise<void> {
    await runCmd(["chmod", "u+w", join(objectPath, "..")], "/");
    await runCmd(["chmod", "u+w", objectPath], "/");
  }

  test("a same-size corrupted object is accepted only when --no-verify is passed", async () => {
    const { repoDir, objectPath, declaredSize } = await repoWithCorruptibleRemote(
      "cli-swap",
      "A".repeat(2000),
    );
    await makeWritable(objectPath);
    writeFileSync(objectPath, "Z".repeat(declaredSize));

    const plain = await runCli(["dataset", "get", "data.bin"], { cwd: repoDir });
    expect(plain.exitCode).toBe(1);
    expect(plain.stdout).toMatch(/failed|Failed/);

    const noVerify = await runCli(["dataset", "get", "data.bin", "--no-verify"], {
      cwd: repoDir,
    });
    expect(noVerify.exitCode).toBe(0);
    expect(noVerify.stdout).toContain("Downloaded 1 file");
    // The caveat is required output, and on stderr so a script parsing stdout
    // for file counts is not polluted by it (#1523).
    expect(noVerify.stderr).toContain("--no-verify");
    expect(noVerify.stdout).not.toContain("--no-verify");

    expect(readFileSync(join(repoDir, "data.bin"), "utf8")).toBe("Z".repeat(declaredSize));
  }, 60_000);

  test("a truncated object is rejected even with --no-verify", async () => {
    const { repoDir, objectPath } = await repoWithCorruptibleRemote(
      "cli-truncate",
      "C".repeat(2000),
    );
    await makeWritable(objectPath);
    writeFileSync(objectPath, "C".repeat(1000));

    const { stdout, stderr, exitCode } = await runCli(
      ["dataset", "get", "data.bin", "--no-verify"],
      { cwd: repoDir },
    );
    expect(exitCode).toBe(1);
    // Pins that the CLI's OWN size check caught it, not some unrelated failure.
    expect(stdout).toContain("--no-verify accepted");
    // Review round 3: the failure branch calls printNoVerifyMismatches
    // BEFORE process.exit(1), so the mismatch's reason and recovery command
    // reach stderr too, not only the capped error text on stdout -- the same
    // guarantee docs#48 makes for every outcome, this one included.
    expect(stderr).toContain("--no-verify accepted");
    expect(stderr).toContain("Recover with: rm --");
  }, 60_000);

  test("--no-verify never writes annex.verify to the repo's git config", async () => {
    const { repoDir } = await repoWithCorruptibleRemote("cli-config", "D".repeat(2000));

    const { exitCode } = await runCli(["dataset", "get", "data.bin", "--no-verify"], {
      cwd: repoDir,
    });
    expect(exitCode).toBe(0);

    const configRead = await runCmd(["git", "config", "--get", "annex.verify"], repoDir);
    expect(configRead.exitCode).not.toBe(0);
    expect(configRead.stdout.trim()).toBe("");
  }, 60_000);
});
