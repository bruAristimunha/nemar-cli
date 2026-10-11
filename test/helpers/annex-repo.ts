/**
 * Real git-annex repositories for the upload tests, built through the production
 * init path (an unlocked adjusted branch with NEMAR's `annex.largefiles`), plus a
 * directory special remote standing in for the S3 one.
 *
 * Nothing here replaces behavior: every repository is a real one, every remote is
 * git-annex's own `directory` remote, and the tests read their answers back from
 * git-annex. The helper only removes the boilerplate that the upload test files would
 * otherwise each retype.
 */

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
import type { SkipContentCheckEntry } from "../../src/lib/git-annex/clone-push";
import { configureLargefiles, gitAnnexAdd, initDataset } from "../../src/lib/git-annex/init";
import { runCommand } from "../../src/lib/git-annex/run-command";

/** Run a command and return its output; a thin alias so tests read like shell. */
export async function run(
  cmd: string[],
  cwd?: string,
  options: { stdin?: string; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { stdout, stderr, exitCode } = await runCommand(cmd, { cwd, ...options });
  return { stdout, stderr, exitCode };
}

/** git-annex marks object files read-only; rm needs write+execute on directories. */
export function chmodTreeWritable(dir: string): void {
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

/** A scratch directory outside any repository, removed (read-only objects and all) by `cleanup`. */
export function makeScratch(prefix: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return {
    root,
    cleanup: () => {
      try {
        chmodTreeWritable(root);
      } catch {}
      rmSync(root, { recursive: true, force: true });
    },
  };
}

let counter = 0;

/** A fresh dataset repository with the identity git needs and NEMAR's policy configured. */
export async function newDatasetRepo(root: string, name: string): Promise<string> {
  counter += 1;
  const dir = join(root, `${name}-${counter}`);
  mkdirSync(dir, { recursive: true });
  const init = await initDataset(dir, { author: { name: "Test", email: "test@test.com" } });
  if (!init.success) throw new Error(`initDataset failed: ${init.error}`);
  // git-annex branch writes (config, add, initremote, copy) run without the author env
  // initDataset sets for its own commands, and CI runners have no global identity.
  await run(["git", "config", "user.email", "test@test.com"], dir);
  await run(["git", "config", "user.name", "Test"], dir);
  const largefiles = await configureLargefiles(dir);
  if (!largefiles.success) throw new Error(`configureLargefiles failed: ${largefiles.error}`);
  return dir;
}

/** Write a file (creating parents) with `content`, or `size` filler bytes. */
export function writeFile(dir: string, relPath: string, content: string | Buffer | number): void {
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, typeof content === "number" ? "x".repeat(content) : content);
}

/**
 * Register a git-annex `directory` special remote called `name` and return the
 * directory that holds its objects. The remote is real: content is copied into it
 * and the location log records that, exactly as for the S3 remote.
 */
export async function initDirectoryRemote(
  root: string,
  repo: string,
  name: string,
): Promise<string> {
  counter += 1;
  const storeDir = join(root, `${name}-store-${counter}`);
  mkdirSync(storeDir, { recursive: true });
  const init = await run(
    [
      "git",
      "annex",
      "initremote",
      name,
      "type=directory",
      `directory=${storeDir}`,
      "encryption=none",
    ],
    repo,
  );
  if (init.exitCode !== 0) throw new Error(`initremote failed: ${init.stderr}`);
  return storeDir;
}

/** Paths git-annex considers annexed in the working tree (present or not). */
export async function annexedSet(dir: string): Promise<Set<string>> {
  const { stdout, exitCode, stderr } = await run(["git", "annex", "find", "--include", "*"], dir);
  if (exitCode !== 0) throw new Error(`git annex find failed: ${stderr}`);
  return new Set(stdout.split("\n").filter(Boolean));
}

/** What the upload plan records for each tracked file: its size and mtime right now. */
export function recorded(dir: string, paths: string[]): SkipContentCheckEntry[] {
  return paths.map((path) => {
    const st = statSync(join(dir, path));
    return { path, size: st.size, mtimeMs: st.mtimeMs };
  });
}

/** `git ls-files -v` tags, one per path: "H" ordinary, lowercase "h" assume-unchanged. */
export async function tags(dir: string, ...paths: string[]): Promise<Record<string, string>> {
  // Literal: the names a test cares about include `*`, `?` and `[...]`.
  const out = await run(
    ["git", "--literal-pathspecs", "ls-files", "-v", "-z", "--", ...paths],
    dir,
  );
  const result: Record<string, string> = {};
  for (const entry of out.stdout.split("\0").filter(Boolean)) result[entry.slice(2)] = entry[0];
  return result;
}

export async function commitCount(dir: string): Promise<number> {
  return Number((await run(["git", "rev-list", "--count", "HEAD"], dir)).stdout.trim());
}

/** A repo with `files` annexed (not yet committed), as the tracking step leaves it. */
export async function trackedRepo(
  root: string,
  name: string,
  files: Record<string, number>,
): Promise<string> {
  const dir = await newDatasetRepo(root, name);
  for (const [path, size] of Object.entries(files)) {
    writeFile(dir, path, `${path}:`.padEnd(size, "x"));
  }
  const added = await gitAnnexAdd(dir, Object.keys(files));
  if (!added.success) throw new Error(`gitAnnexAdd failed: ${added.error}`);
  return dir;
}

/**
 * Make the next commit's pre-commit hook run `script` first, then git-annex's own hook.
 * The hook runs INSIDE the save's window, after the paths are marked and before the
 * commit exists, which makes it the one place a test can act "during the save".
 */
export function prependPreCommit(dir: string, script: string): () => void {
  const hook = join(dir, ".git", "hooks", "pre-commit");
  const original = readFileSync(hook, "utf-8");
  writeFileSync(hook, `#!/bin/sh\n${script}\n${original.replace(/^#!.*\n/, "")}`);
  chmodSync(hook, 0o755);
  return () => {
    writeFileSync(hook, original);
    chmodSync(hook, 0o755);
  };
}

/** Make the next commit's post-commit hook run `script` first, then any existing hook. */
export function prependPostCommit(dir: string, script: string): () => void {
  const hook = join(dir, ".git", "hooks", "post-commit");
  const existed = existsSync(hook);
  const original = existed ? readFileSync(hook, "utf-8") : "#!/bin/sh\n";
  writeFileSync(hook, `#!/bin/sh\n${script}\n${original.replace(/^#!.*\n/, "")}`);
  chmodSync(hook, 0o755);
  return () => {
    if (existed) {
      writeFileSync(hook, original);
      chmodSync(hook, 0o755);
    } else {
      rmSync(hook, { force: true });
    }
  };
}

/** Route this repo's filter-process through `tee` so re-read content is countable. */
export async function meterFilterProcess(dir: string): Promise<string> {
  const log = join(dir, "..", `${Math.random().toString(36).slice(2)}.filterlog`);
  writeFileSync(log, "");
  const set = await run(
    ["git", "config", "filter.annex.process", `sh -c 'tee -a "${log}" | git-annex filter-process'`],
    dir,
  );
  if (set.exitCode !== 0) throw new Error(`git config failed: ${set.stderr}`);
  return log;
}
