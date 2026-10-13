/**
 * Tests for scripts/ci/classify-push.sh, the push classifier that lets Tests, Auto Bump Dev
 * and the production deploy recognize the release bot's version-only commits.
 *
 * Drives the REAL script as a subprocess, the way the workflows run it: from a depth-1
 * checkout of the pushed commit, with the push event's JSON in GITHUB_EVENT_PATH, against a
 * real git "origin" (a bare repository on disk) that it fetches the previous head from. No
 * part of the script is replaced; what varies between cases is only the history pushed.
 *
 * The property that matters most is the direction of every doubt: a push the script cannot
 * vouch for must come out ordinary (run everything, deploy as before), so the failure cases
 * below are as important as the bump itself.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = new URL("../scripts/ci/classify-push.sh", import.meta.url).pathname;
const BOT = "nemar-bot@users.noreply.github.com";
const HUMAN = "someone@example.org";
const NULL_SHA = "0".repeat(40);

/** git with no user or system configuration, so local hooks, signing or aliases cannot leak in. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const r = spawnSync("git", args, { cwd, env: { ...GIT_ENV, ...env }, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  }
  return r.stdout.trim();
}

let root: string;
let origin: string;
let originUrl: string;
let work: string;
let checkouts = 0;

const packageJson = (version: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ name: "nemar-cli", version, dependencies: { zod: "^3.25.0" }, ...extra }, null, 2)}\n`;
const backendPackageJson = (version: string) =>
  `${JSON.stringify({ name: "nemar-backend", version, private: true }, null, 2)}\n`;

/** Write the files, commit them as `email` with `message`, push dev, return the new head. */
function commit(files: Record<string, string>, email: string, message: string): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), content);
  }
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "--no-verify", "-m", message], {
    GIT_AUTHOR_NAME: "author",
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: "author",
    GIT_COMMITTER_EMAIL: email,
  });
  git(work, ["push", "-q", "origin", "HEAD:dev"]);
  return git(work, ["rev-parse", "HEAD"]);
}

interface Classification {
  version_bump: string;
  auto_bump: string;
  deploy_paths: string;
}

/**
 * Run the script as a workflow step does: in a fresh depth-1 checkout of `after`, with the
 * event payload GitHub would have written for a push of `before..after`.
 */
function classify(
  before: string,
  after: string,
  email: string,
  message: string,
  eventName = "push",
): Classification {
  const ci = join(root, `checkout-${++checkouts}`);
  mkdirSync(ci);
  git(ci, ["init", "-q"]);
  git(ci, ["remote", "add", "origin", originUrl]);
  git(ci, ["fetch", "-q", "--depth=1", "origin", after]);
  git(ci, ["checkout", "-q", "--detach", "FETCH_HEAD"]);
  const eventPath = join(root, `event-${checkouts}.json`);
  writeFileSync(
    eventPath,
    JSON.stringify({ before, after, head_commit: { id: after, message, author: { email } } }),
  );
  const r = spawnSync("bash", [SCRIPT], {
    cwd: ci,
    env: {
      ...GIT_ENV,
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_SHA: after,
    },
    encoding: "utf8",
  });
  expect(r.status).toBe(0);
  const out = Object.fromEntries(
    r.stdout
      .trim()
      .split("\n")
      .map((line) => line.split("=") as [string, string]),
  );
  return {
    version_bump: out.version_bump,
    auto_bump: out.auto_bump,
    deploy_paths: out.deploy_paths,
  };
}

const ORDINARY_BUMP = { version_bump: "false", auto_bump: "false" };

describe("scripts/ci/classify-push.sh", () => {
  let base: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "nemar-classify-push-"));
    origin = join(root, "origin.git");
    originUrl = `file://${origin}`;
    git(root, ["init", "-q", "--bare", origin]);
    // GitHub serves any commit by id; a local bare repository needs telling.
    git(origin, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
    work = join(root, "work");
    git(root, ["clone", "-q", originUrl, work]);
    git(work, ["checkout", "-q", "-b", "dev"]);
    base = commit(
      {
        "package.json": packageJson("0.10.18-dev1"),
        "backend/package.json": backendPackageJson("0.10.18-dev1"),
        "README.md": "# nemar-cli\n",
        "src/index.ts": "export const x = 1;\n",
        "validator-version.json": '{ "version": "2.0.1" }\n',
      },
      HUMAN,
      "feat: the starting tree",
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("the bot's single version bump is a version bump, auto-bump shaped, and touches the backend", () => {
    const bump = commit(
      {
        "package.json": packageJson("0.10.18-dev2"),
        "backend/package.json": backendPackageJson("0.10.18-dev2"),
      },
      BOT,
      "chore: bump version to 0.10.18-dev2",
    );
    expect(classify(base, bump, BOT, "chore: bump version to 0.10.18-dev2")).toEqual({
      version_bump: "true",
      auto_bump: "true",
      deploy_paths: "true",
    });
    base = bump;
  });

  test("a docs-only push is ordinary and touches no deploy path", () => {
    const docs = commit({ "README.md": "# nemar-cli\n\nMore words.\n" }, HUMAN, "docs: say more");
    expect(classify(base, docs, HUMAN, "docs: say more")).toEqual({
      ...ORDINARY_BUMP,
      deploy_paths: "false",
    });
    base = docs;
  });

  test("a backend code push is ordinary and touches a deploy path", () => {
    const code = commit({ "backend/src/app.ts": "export {};\n" }, HUMAN, "fix: the backend");
    expect(classify(base, code, HUMAN, "fix: the backend")).toEqual({
      ...ORDINARY_BUMP,
      deploy_paths: "true",
    });
    base = code;
  });

  test("a version-only change by anyone but the bot is ordinary", () => {
    const manual = commit(
      { "package.json": packageJson("0.10.18-dev3") },
      HUMAN,
      "chore: bump version to 0.10.18-dev3",
    );
    expect(classify(base, manual, HUMAN, "chore: bump version to 0.10.18-dev3")).toEqual({
      ...ORDINARY_BUMP,
      deploy_paths: "false",
    });
    base = manual;
  });

  test("a bot 'bump' that also changes another file is ordinary", () => {
    const sneaky = commit(
      { "package.json": packageJson("0.10.18-dev4"), "src/index.ts": "export const x = 2;\n" },
      BOT,
      "chore: bump version to 0.10.18-dev4",
    );
    expect(classify(base, sneaky, BOT, "chore: bump version to 0.10.18-dev4")).toEqual({
      ...ORDINARY_BUMP,
      deploy_paths: "false",
    });
    base = sneaky;
  });

  test("a bot 'bump' that also changes another JSON file's version is ordinary", () => {
    // Only package.json and backend/package.json may change: the field check alone would
    // pass this file, whose content outside `version` is unchanged.
    const pin = commit(
      {
        "package.json": packageJson("0.10.18-dev5"),
        "validator-version.json": '{ "version": "2.0.2" }\n',
      },
      BOT,
      "chore: bump version to 0.10.18-dev5",
    );
    expect(classify(base, pin, BOT, "chore: bump version to 0.10.18-dev5")).toEqual({
      ...ORDINARY_BUMP,
      deploy_paths: "false",
    });
    base = pin;
  });

  test("a bot 'bump' that changes package.json beyond the version is ordinary", () => {
    const deps = commit(
      { "package.json": packageJson("0.10.18-dev5", { dependencies: { zod: "^4.0.0" } }) },
      BOT,
      "chore: bump version to 0.10.18-dev5",
    );
    expect(classify(base, deps, BOT, "chore: bump version to 0.10.18-dev5")).toEqual({
      ...ORDINARY_BUMP,
      deploy_paths: "false",
    });
    base = deps;
  });

  test("a bot commit whose subject is not a bump is ordinary", () => {
    const other = commit(
      { "package.json": packageJson("0.10.18-dev6", { dependencies: { zod: "^4.0.0" } }) },
      BOT,
      "chore: sync dev with main after v0.10.17",
    );
    expect(classify(base, other, BOT, "chore: sync dev with main after v0.10.17")).toEqual({
      ...ORDINARY_BUMP,
      deploy_paths: "false",
    });
    base = other;
  });

  test("a multi-commit version-only bot push is a version bump but not auto-bump shaped", () => {
    // The shape of sync-dev.yml's push: more than one commit, ending in the bot's bump.
    commit(
      { "package.json": packageJson("0.10.19-dev0", { dependencies: { zod: "^4.0.0" } }) },
      BOT,
      "chore: bump version to 0.10.19-dev0",
    );
    const head = commit(
      {
        "package.json": packageJson("0.10.19-dev1", { dependencies: { zod: "^4.0.0" } }),
        "backend/package.json": backendPackageJson("0.10.19-dev1"),
      },
      BOT,
      "chore: bump version to 0.10.19-dev1",
    );
    expect(classify(base, head, BOT, "chore: bump version to 0.10.19-dev1")).toEqual({
      version_bump: "true",
      auto_bump: "false",
      deploy_paths: "true",
    });
    base = head;
  });

  test("anything it cannot establish is ordinary, with deploy paths assumed touched", () => {
    const msg = "chore: bump version to 0.10.19-dev1";
    const failOpen = { ...ORDINARY_BUMP, deploy_paths: "true" };
    // Not a push (a pull request event).
    expect(classify(base, base, BOT, msg, "pull_request")).toEqual(failOpen);
    // No previous commit (a new branch).
    expect(classify(NULL_SHA, base, BOT, msg)).toEqual(failOpen);
    // A previous commit the remote does not have.
    expect(classify("1".repeat(40), base, BOT, msg)).toEqual(failOpen);
  });
});
