/**
 * Batch-fed git-annex add (#1455).
 *
 * The upload's tracking step used to run `git annex add -- <500 paths>` with
 * the complete path list as argv. The list form now feeds paths through
 * `--batch -z` on stdin. Worker selection is left to git-annex configuration
 * until a controlled argv-vs-batch × J1/J4/J8 benchmark chooses a default.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "bun";
import {
  configureLargefiles,
  gitAnnexAdd,
  initDataset,
  parseAddFailures,
  parseAddOutput,
} from "../src/lib/git-annex/init";
import { runCommand } from "../src/lib/git-annex/run-command";

describe("parseAddFailures", () => {
  test("returns only failed records, with their messages", () => {
    const stdout = [
      "",
      '{"command":"add","error-messages":[],"file":"a.edf","key":"K","success":true}',
      '{"command":"add","error-messages":["Permission denied"],"file":"b.edf","success":false}',
      "not json",
    ].join("\n");
    expect(parseAddFailures(stdout)).toEqual([{ file: "b.edf", error: "Permission denied" }]);
  });
});

const TMP_DIR = mkdtempSync(join(tmpdir(), "nemar-annex-add-batch-"));

async function runCmd(cmd: string[], cwd?: string) {
  const proc = spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode: await proc.exited };
}

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

async function newDatasetRepo(name: string): Promise<string> {
  const dir = join(TMP_DIR, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const init = await initDataset(dir, { author: { name: "Test", email: "test@test.com" } });
  if (!init.success) throw new Error(`initDataset failed: ${init.error}`);
  await runCmd(["git", "config", "user.email", "test@test.com"], dir);
  await runCmd(["git", "config", "user.name", "Test"], dir);
  // Preserve this repo setting so the batch path is exercised with git-annex's
  // existing worker configuration; this phase does not choose a local default.
  await runCmd(["git", "config", "annex.jobs", "cpus"], dir);
  if (!(await configureLargefiles(dir)).success) throw new Error("configureLargefiles failed");
  return dir;
}

function writeFile(dir: string, rel: string, content: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

async function annexed(dir: string): Promise<string[]> {
  const { stdout, stderr, exitCode } = await runCmd(
    ["git", "annex", "find", "--include", "*", "--json"],
    dir,
  );
  if (exitCode !== 0) throw new Error(`git annex find failed: ${stderr.trim()}`);
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const record = JSON.parse(line) as { file?: unknown };
      if (typeof record.file !== "string") throw new Error("git annex find returned no file path");
      return record.file;
    })
    .sort();
}

beforeAll(async () => {
  if ((await runCmd(["git", "annex", "version"])).exitCode !== 0) {
    throw new Error("git-annex is required for this test file");
  }
});

afterAll(() => {
  if (existsSync(TMP_DIR)) {
    chmodTreeWritable(TMP_DIR);
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

describe("gitAnnexAdd list form (real git-annex)", () => {
  test("successful JSON responses identify the path they handled", async () => {
    const dir = await newDatasetRepo("response-path");
    const file = "sub-01/eeg/sub-01_task-rest_eeg.edf";
    writeFile(dir, file, "real git-annex response".repeat(100));

    const { stdout, stderr, exitCode } = await runCommand(
      ["git", "annex", "add", "--batch", "-z", "--json", "--json-error-messages"],
      { cwd: dir, stdin: `${file}\0` },
    );

    expect(exitCode, stderr).toBe(0);
    expect(parseAddOutput(stdout)).toEqual({
      responsePaths: new Set([file]),
      failures: [],
    });
  });

  test("runs git-annex add with --batch across path-count chunks", async () => {
    const dir = await newDatasetRepo("batch");
    const files = Array.from({ length: 7 }, (_, i) => `sub-0${i}/eeg/sub-0${i}_eeg.edf`);
    for (const f of files) writeFile(dir, f, f.repeat(100));
    writeFile(dir, "sub-00/eeg/sub-00_channels.tsv", "name\ttype\n");

    const trace = join(dir, "..", `trace-${Date.now()}.log`);
    const saved = process.env.GIT_TRACE;
    process.env.GIT_TRACE = trace;
    try {
      const res = await gitAnnexAdd(dir, [...files, "sub-00/eeg/sub-00_channels.tsv"], {
        maxPaths: 3,
      });
      expect(res).toEqual({ success: true });
    } finally {
      // biome-ignore lint/performance/noDelete: assigning undefined would leave the string "undefined"
      if (saved === undefined) delete process.env.GIT_TRACE;
      else process.env.GIT_TRACE = saved;
    }
    expect(await annexed(dir)).toEqual([...files].sort());
    // Metadata went to git, not the annex.
    const staged = await runCmd(["git", "diff", "--cached", "--name-only"], dir);
    expect(staged.stdout).toContain("sub-00/eeg/sub-00_channels.tsv");

    const adds = readFileSync(trace, "utf8")
      .split("\n")
      .filter((l) => /run_command: git-annex add/.test(l));
    // 8 paths at 3 per chunk: three batch invocations with no argv path list.
    expect(adds).toHaveLength(3);
    for (const line of adds) {
      expect(line).toContain("--batch");
      expect(line).not.toContain("-J");
      expect(line).not.toContain("sub-0");
    }
  });

  test("maxBytes also bounds batch stdin across chunks", async () => {
    const dir = await newDatasetRepo("byte-chunks");
    const files = ["a.edf", "b.edf", "c.edf", "d.edf"];
    for (const file of files) writeFile(dir, file, file.repeat(100));

    const trace = join(dir, "..", `trace-${Date.now()}.log`);
    const saved = process.env.GIT_TRACE;
    process.env.GIT_TRACE = trace;
    try {
      const res = await gitAnnexAdd(dir, files, { maxPaths: 99, maxBytes: 12 });
      expect(res).toEqual({ success: true });
    } finally {
      // biome-ignore lint/performance/noDelete: assigning undefined would leave the string "undefined"
      if (saved === undefined) delete process.env.GIT_TRACE;
      else process.env.GIT_TRACE = saved;
    }

    expect(await annexed(dir)).toEqual(files);
    const adds = readFileSync(trace, "utf8")
      .split("\n")
      .filter((line) => /run_command: git-annex add/.test(line));
    expect(adds).toHaveLength(2);
    expect(adds.every((line) => line.includes("--batch"))).toBe(true);
  });

  test("a path that does not exist fails loudly instead of being skipped", async () => {
    const dir = await newDatasetRepo("missing");
    writeFile(dir, "a.edf", "a".repeat(1000));
    const res = await gitAnnexAdd(dir, ["a.edf", "nope/b.edf"]);
    expect(res.success).toBe(false);
    expect(res.error).toContain("nope/b.edf");
    // Batch mode may finish valid siblings before identifying a missing path;
    // the successful work remains resumable and no caller can treat this add as complete.
    expect(await annexed(dir)).toEqual(["a.edf"]);
  });

  test("a filesystem inspection error is not reported as a missing path", async () => {
    const dir = await newDatasetRepo("inaccessible");
    mkdirSync(join(dir, "blocked"));
    writeFile(dir, "blocked/a.edf", "a".repeat(1000));
    chmodSync(join(dir, "blocked"), 0);

    let res: Awaited<ReturnType<typeof gitAnnexAdd>>;
    try {
      res = await gitAnnexAdd(dir, ["blocked/a.edf"]);
    } finally {
      chmodSync(join(dir, "blocked"), 0o755);
    }

    expect(res.success).toBe(false);
    expect(res.error).not.toContain("not found");
    expect(res.error).toMatch(/EACCES|EPERM/i);
  });

  test("re-adding already annexed, unchanged files is a quiet success (resume)", async () => {
    const dir = await newDatasetRepo("resume");
    writeFile(dir, "a.edf", "a".repeat(1000));
    expect((await gitAnnexAdd(dir, ["a.edf"])).success).toBe(true);
    expect((await gitAnnexAdd(dir, ["a.edf"])).success).toBe(true);
    expect(await annexed(dir)).toEqual(["a.edf"]);
  });

  test("a tracked file modified after staging is still added", async () => {
    const dir = await newDatasetRepo("staged-modified");
    writeFile(dir, "a.edf", "before".repeat(1_000));
    expect((await runCmd(["git", "add", "--", "a.edf"], dir)).exitCode).toBe(0);
    writeFile(dir, "a.edf", "after".repeat(1_000));

    const res = await gitAnnexAdd(dir, ["a.edf"]);

    expect(res).toEqual({ success: true });
    expect(await annexed(dir)).toEqual(["a.edf"]);
  });

  test("NUL-delimited batch input preserves newlines in filenames", async () => {
    const dir = await newDatasetRepo("newline");
    const file = "sub-01/eeg/sub-01\nsession_eeg.edf";
    writeFile(dir, file, "newline payload".repeat(20_000));

    const res = await gitAnnexAdd(dir, [file], {}, { forceLarge: true });

    expect(res).toEqual({ success: true });
    expect(await annexed(dir)).toEqual([file]);
  });

  test("batch mode respects .gitignore by default", async () => {
    const dir = await newDatasetRepo("gitignore");
    writeFile(dir, ".gitignore", "ignored.edf\n");
    writeFile(dir, "ignored.edf", "ignored data");

    const res = await gitAnnexAdd(dir, ["ignored.edf"]);

    expect(res).toEqual({ success: true });
    expect(await annexed(dir)).toEqual([]);
    const staged = await runCmd(["git", "diff", "--cached", "--name-only"], dir);
    expect(staged.stdout).not.toContain("ignored.edf");
  });

  test("reports real per-file read failures and resumes the remaining file", async () => {
    const dir = await newDatasetRepo("file-failure");
    writeFile(dir, "good.edf", "good payload".repeat(100));
    writeFile(dir, "unreadable.edf", "blocked payload".repeat(100));
    chmodSync(join(dir, "unreadable.edf"), 0);

    let res: Awaited<ReturnType<typeof gitAnnexAdd>>;
    try {
      res = await gitAnnexAdd(dir, ["good.edf", "unreadable.edf"], {}, { forceLarge: true });
    } finally {
      chmodSync(join(dir, "unreadable.edf"), 0o644);
    }

    expect(res.success).toBe(false);
    expect(res.error).toContain("unreadable.edf");
    expect(await annexed(dir)).toContain("good.edf");

    const resumed = await gitAnnexAdd(dir, ["unreadable.edf"], {}, { forceLarge: true });
    expect(resumed).toEqual({ success: true });
    expect(await annexed(dir)).toEqual(["good.edf", "unreadable.edf"]);
  });

  test("forceLarge and checkGitignore still apply in batch mode", async () => {
    const dir = await newDatasetRepo("flags");
    writeFile(dir, ".gitignore", "ignored.tsv\n");
    writeFile(dir, "ignored.tsv", "x\ty\n");
    const res = await gitAnnexAdd(
      dir,
      ["ignored.tsv"],
      {},
      {
        forceLarge: true,
        checkGitignore: false,
      },
    );
    expect(res.success).toBe(true);
    expect(await annexed(dir)).toEqual(["ignored.tsv"]);
  });
});
