/**
 * #1399: `git annex init` with no description records `user@host:/path` in the
 * git-annex branch's uuid.log, which is public once the dataset is; from a
 * cluster node that is e.g. `alice@node-1-20:/scratch/lab/alice/.../bids`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { cloneDataset } from "../src/lib/git-annex/clone-push";
import {
  ANNEX_CLONE_DESCRIPTION,
  ANNEX_DEPOSIT_DESCRIPTION,
  ensureGitAnnexInitialized,
  initDataset,
  isDefaultAnnexDescription,
  replaceDefaultAnnexDescription,
} from "../src/lib/git-annex/init";
import { initializeAnnexDataset } from "../src/lib/upload/transfer";

const TMP_DIR = join(import.meta.dir, ".test-annex-init-description");

async function run(cmd: string[], cwd?: string) {
  const proc = spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  return { stdout, exitCode: await proc.exited };
}

function freshDir(name: string): string {
  const dir = join(TMP_DIR, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function uuidLog(dir: string): Promise<string> {
  return (await run(["git", "show", "git-annex:uuid.log"], dir)).stdout;
}

function assertNoIdentity(log: string, dir: string): void {
  expect(log).not.toContain(`${userInfo().username}@`);
  expect(log).not.toContain(hostname());
  expect(log).not.toContain(dir);
}

afterAll(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("isDefaultAnnexDescription", () => {
  test("matches git-annex's default form only", () => {
    expect(isDefaultAnnexDescription("alice@node-1-20:/scratch/lab/x/bids")).toBe(true);
    expect(isDefaultAnnexDescription("me@laptop.lan:/private/tmp/ds [here]")).toBe(true);
    expect(isDefaultAnnexDescription("me@laptop.lan:~/data/ds [here]")).toBe(true);
    expect(isDefaultAnnexDescription("nemar-deposit")).toBe(false);
    expect(isDefaultAnnexDescription("my lab's copy")).toBe(false);
    expect(isDefaultAnnexDescription("")).toBe(false);
  });
});

describe("annex repository description (real git-annex)", () => {
  test("initDataset records the fixed description, not user@host:/path", async () => {
    const dir = freshDir("init");
    const res = await initDataset(dir, { author: { name: "T", email: "t@t" } });
    expect(res.success).toBe(true);
    const log = await uuidLog(dir);
    expect(log).toContain(ANNEX_DEPOSIT_DESCRIPTION);
    assertNoIdentity(log, dir);
  });

  test("ensureGitAnnexInitialized on a plain git repo does the same", async () => {
    const dir = freshDir("ensure");
    expect((await run(["git", "init", "-q", dir])).exitCode).toBe(0);
    expect((await ensureGitAnnexInitialized(dir)).success).toBe(true);
    const log = await uuidLog(dir);
    expect(log).toContain(ANNEX_DEPOSIT_DESCRIPTION);
    assertNoIdentity(log, dir);
  });

  test("a repository with the default description is re-described; a chosen one is kept", async () => {
    const dir = freshDir("legacy");
    await run(["git", "init", "-q", dir]);
    await run(["git", "annex", "init", "-q"], dir); // old behaviour: default description
    expect(await uuidLog(dir)).toContain(`${userInfo().username}@`);

    expect(await replaceDefaultAnnexDescription(dir)).toEqual({ success: true, changed: true });
    const info = await run(["git", "annex", "info", "here", "--json", "--fast"], dir);
    expect(JSON.parse(info.stdout).description).toContain(ANNEX_DEPOSIT_DESCRIPTION);
    // Idempotent: nothing left to replace.
    expect(await replaceDefaultAnnexDescription(dir)).toEqual({ success: true, changed: false });

    const chosen = freshDir("chosen");
    await run(["git", "init", "-q", chosen]);
    await run(["git", "annex", "init", "-q", "lab archive"], chosen);
    expect(await replaceDefaultAnnexDescription(chosen)).toEqual({ success: true, changed: false });
  });

  test("reports when git-annex cannot provide a description", async () => {
    const dir = freshDir("not-annex");
    expect((await run(["git", "init", "-q"], dir)).exitCode).toBe(0);

    const result = await replaceDefaultAnnexDescription(dir);

    expect(result.success).toBe(false);
    expect(result.error).toContain("git annex info here failed");
  });
});

describe("#1399 entry points", () => {
  test("initializeAnnexDataset replaces an existing default before later pushes", async () => {
    const dir = freshDir("legacy-entry");
    expect((await run(["git", "init", "-q", "-b", "main"], dir)).exitCode).toBe(0);
    expect((await run(["git", "config", "user.name", "Test User"], dir)).exitCode).toBe(0);
    expect((await run(["git", "config", "user.email", "test@example.invalid"], dir)).exitCode).toBe(
      0,
    );
    expect((await run(["git", "annex", "init", "-q"], dir)).exitCode).toBe(0);
    expect(await uuidLog(dir)).toContain(`${userInfo().username}@`);

    const result = await initializeAnnexDataset(dir, undefined);

    expect(result.status).toBe("ok");
    const log = await uuidLog(dir);
    expect(log).toContain(ANNEX_DEPOSIT_DESCRIPTION);
    assertNoIdentity(log, dir);
  });

  test("initializeAnnexDataset stops and reports a failed git-annex describe", async () => {
    const dir = freshDir("describe-fails");
    expect((await run(["git", "init", "-q", "-b", "main"], dir)).exitCode).toBe(0);
    expect((await run(["git", "config", "user.name", "Test User"], dir)).exitCode).toBe(0);
    expect((await run(["git", "config", "user.email", "test@example.invalid"], dir)).exitCode).toBe(
      0,
    );
    expect((await run(["git", "annex", "init", "-q"], dir)).exitCode).toBe(0);
    const before = await uuidLog(dir);
    expect(before).toContain(`${userInfo().username}@`);
    const refHook = join(dir, ".git", "hooks", "reference-transaction");
    writeFileSync(
      refHook,
      '#!/bin/sh\nwhile read old new ref; do\n  [ "$ref" = refs/heads/git-annex ] || continue\n  git show "$new:uuid.log" | grep -q "nemar-deposit" && exit 1\ndone\nexit 0\n',
    );
    chmodSync(refHook, 0o755);

    const result = await initializeAnnexDataset(dir, undefined);
    expect(result.status).toBe("fail");
    const after = await uuidLog(dir);
    expect(after).toContain(`${userInfo().username}@`);
    expect(after).not.toContain(ANNEX_DEPOSIT_DESCRIPTION);
  });

  test("cloneDataset initializes its annex repository with a fixed description", async () => {
    const source = freshDir("clone-source");
    expect((await run(["git", "init", "-q", "-b", "main"], source)).exitCode).toBe(0);
    expect((await run(["git", "config", "user.name", "Test User"], source)).exitCode).toBe(0);
    expect(
      (await run(["git", "config", "user.email", "test@example.invalid"], source)).exitCode,
    ).toBe(0);
    writeFileSync(join(source, "README.md"), "clone fixture\n");
    expect((await run(["git", "add", "README.md"], source)).exitCode).toBe(0);
    expect((await run(["git", "commit", "-qm", "fixture"], source)).exitCode).toBe(0);

    const bare = freshDir("clone-origin");
    expect((await run(["git", "init", "-q", "--bare", "-b", "main"], bare)).exitCode).toBe(0);
    expect((await run(["git", "remote", "add", "origin", bare], source)).exitCode).toBe(0);
    expect((await run(["git", "push", "-q", "origin", "main"], source)).exitCode).toBe(0);

    const clone = freshDir("clone-target");
    const result = await cloneDataset(bare, clone, {
      identity: { name: "Test User", email: "test@example.invalid" },
    });

    expect(result.success).toBe(true);
    const log = await uuidLog(clone);
    expect(log).toContain(ANNEX_CLONE_DESCRIPTION);
    assertNoIdentity(log, clone);
  });
});
