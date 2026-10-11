/**
 * The sandbox command's save-and-push step, against a real repository.
 *
 * `saveDataset` and `pushToGitHub` report failure in their result rather than by
 * throwing, so the command must read both results: a save that failed closed, or a push
 * that was refused or only half worked, may not end as a plain "Pushed to GitHub", and
 * the step that failed is named.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveAndPush } from "../src/commands/sandbox";
import { makeScratch, newDatasetRepo, run, writeFile } from "./helpers/annex-repo";

setDefaultTimeout(60_000);

const scratch = makeScratch("nemar-sandbox-save-push");

beforeAll(async () => {
  const probe = await run(["git", "annex", "version"]);
  if (probe.exitCode !== 0) throw new Error("git-annex is required for this test file");
});
afterAll(() => scratch.cleanup());

/** A dataset with one tracked-by-git file and a real bare repository as `origin`. */
async function withOrigin(name: string) {
  const dir = await newDatasetRepo(scratch.root, name);
  writeFile(dir, "dataset_description.json", '{"Name":"sandbox"}');
  const origin = join(scratch.root, `${name}-origin.git`);
  expect((await run(["git", "init", "-q", "--bare", origin])).exitCode).toBe(0);
  expect((await run(["git", "remote", "add", "origin", origin], dir)).exitCode).toBe(0);
  return { dir, origin };
}

describe("saveAndPush", () => {
  test("control: a dataset with an origin is saved and pushed, with nothing to warn about", async () => {
    const { dir, origin } = await withOrigin("control");
    const result = await saveAndPush(dir, "Initial sandbox training upload");
    expect(result).toEqual({ ok: true });
    const pushed = await run(["git", "ls-tree", "-r", "--name-only", "main"], origin);
    expect(pushed.stdout).toContain("dataset_description.json");
  });

  test("a push that is refused is reported as the push step, not printed as pushed", async () => {
    // Guards the check of pushToGitHub's result. No origin exists, so the push fails and
    // returns `{ success: false }`; awaiting it and moving on printed "Pushed to GitHub".
    const dir = await newDatasetRepo(scratch.root, "no-origin");
    writeFile(dir, "dataset_description.json", '{"Name":"sandbox"}');
    const result = await saveAndPush(dir, "Initial sandbox training upload");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.step).toBe("push");
    expect(result.error.length).toBeGreaterThan(0);
  });

  test("a save that fails closed is reported as the save step, and nothing is pushed after it", async () => {
    // Guards the check of saveDataset's result. A directory that is not a repository makes
    // the save fail; if the failure were ignored the push would run against whatever is there.
    const notARepo = join(scratch.root, "not-a-repo");
    writeFile(notARepo, "x.json", "{}");
    const result = await saveAndPush(notARepo, "Initial sandbox training upload");
    expect(result).toMatchObject({ ok: false, step: "save" });
  });

  test("a push where the main branch landed and the git-annex branch did not carries the warning", async () => {
    // Guards `warning`. pushToGitHub answers `{ success: true, warning }` when the main
    // branch was pushed and the git-annex branch was not ("Clone operations may have
    // issues"); dropping it printed a plain success. The bare origin here refuses the
    // git-annex branch the way a protected branch would.
    const { dir, origin } = await withOrigin("annex-branch-refused");
    const hook = join(origin, "hooks", "pre-receive");
    writeFileSync(
      hook,
      '#!/bin/sh\nwhile read old new ref; do [ "$ref" = "refs/heads/git-annex" ] && { echo "git-annex branch refused" >&2; exit 1; }; done\nexit 0\n',
    );
    chmodSync(hook, 0o755);

    const result = await saveAndPush(dir, "Initial sandbox training upload");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.warning).toContain("Main branch pushed, but git-annex branch failed");
    expect(result.warning).toContain("git-annex branch refused");
    const pushed = await run(["git", "ls-tree", "-r", "--name-only", "main"], origin);
    expect(pushed.stdout).toContain("dataset_description.json");
  });
});
