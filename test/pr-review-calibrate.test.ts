/**
 * The pull-request review's offline calibration (`scripts/ci/pr-review-calibrate.ts`, ADR 0107).
 *
 * The calibration runs the review job's own stage flow, so these tests run it for real: a real git
 * repository built in a temporary directory stands in for the dataset GitHub would serve (the one
 * part that needs the network), and the real Anthropic SDK talks to a local server that answers the
 * way the Messages API does, streamed (`helpers/anthropic-sse.ts`). What is checked is what the
 * table says, what it never says (a pull request's text, a model's words), and that nothing is
 * posted anywhere.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CalibrationReadError,
  type CalibrationRow,
  type CalibrationTarget,
  type FetchedPullRequest,
  calibrateMain,
  calibrateOne,
  exitCodeOf,
  fetchPullRequest,
  parseTarget,
  renderTable,
} from "../scripts/ci/pr-review-calibrate";
import { childEnv, gatherListing } from "../scripts/ci/pr-review-evidence";
import { type StandInMessage, replyFor, standInMessage } from "./helpers/anthropic-sse";
import { installGitShim, readEnvLog } from "./helpers/git-shim";

let root: string;
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.org",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.org",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV }).trim();
}

function write(dir: string, rel: string, content: string) {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const SECRET = "SMITH-SECRET-NAME";

/** A dataset at 1.0.0 on main, and a branch that bumps it to 1.1.0 with a CHANGES entry. */
function localPullRequest(
  name: string,
  pr: Record<string, unknown> = {},
  opts: { merge?: boolean } = {},
): (t: CalibrationTarget) => FetchedPullRequest {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  write(dir, "dataset_description.json", JSON.stringify({ Name: "Resting EEG", Version: "1.0.0" }));
  write(dir, "CHANGES", "1.0.0 2026-01-01\n - Initial release\n");
  write(dir, "sub-01/eeg/sub-01_task-rest_eeg.json", JSON.stringify({ SamplingFrequency: 256 }));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  const base = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", "contrib");
  write(dir, "dataset_description.json", JSON.stringify({ Name: "Resting EEG", Version: "1.1.0" }));
  write(dir, "CHANGES", "1.1.0 2026-10-16\n - Fixed units\n1.0.0 2026-01-01\n - Initial release\n");
  write(dir, "sub-01/eeg/sub-01_task-rest_eeg.json", JSON.stringify({ SamplingFrequency: 512 }));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fix units");
  const head = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "main");
  // Merged: main now holds the head, so only the base the pull request recorded still shows it.
  if (opts.merge) git(dir, "merge", "-q", "--ff-only", "contrib");
  return () => ({
    dir,
    base,
    head,
    pr: {
      title: "Correct the sampling rate in the EEG sidecar",
      body: `The sidecar said 256 Hz; the recording is 512 Hz. ${SECRET}`,
      author_association: "NONE",
      base: { repo: { full_name: "nemarDatasets/nm000460" } },
      head: { repo: { full_name: "nemarDatasets/nm000460" } },
      ...pr,
    },
  });
}

const PROCEED = JSON.stringify({ decision: "proceed", note: `Looks like a fix. ${SECRET}` });
const REVIEW = JSON.stringify({
  criteria: { no_degradation: "pass", advances_revision: "pass", material_improvement: "pass" },
  title_ok: true,
  body_ok: true,
  steering: false,
  misleading_body: false,
  findings: [],
  summary: `Fixes the sampling rate. ${SECRET}`,
});

let screenReply: () => StandInMessage | Response = () => standInMessage(PROCEED);
let reviewReply: () => StandInMessage | Response = () =>
  standInMessage(REVIEW, {
    model: "claude-sonnet-5-5",
    usage: { input_tokens: 20000, output_tokens: 8000 },
  });
const requests: Array<{ path: string; model: unknown }> = [];
let server: ReturnType<typeof Bun.serve>;
const SAVED: Record<string, string | undefined> = {};
const SDK_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_IDENTITY_TOKEN",
  "PR_REVIEW_CALLBACK_TOKEN",
];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pr-review-calibrate-"));
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      requests.push({ path: new URL(req.url).pathname, model: body.model });
      return replyFor(body, body.model === "claude-sonnet-5-5" ? reviewReply() : screenReply());
    },
  });
  for (const k of SDK_ENV) {
    SAVED[k] = process.env[k];
    Reflect.deleteProperty(process.env, k);
  }
  process.env.ANTHROPIC_API_KEY = "sk-ant-calibration-stand-in";
});

afterAll(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
  for (const k of SDK_ENV) {
    if (SAVED[k] === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = SAVED[k];
  }
});

beforeEach(() => {
  requests.length = 0;
  screenReply = () => standInMessage(PROCEED);
  reviewReply = () =>
    standInMessage(REVIEW, {
      model: "claude-sonnet-5-5",
      usage: { input_tokens: 20000, output_tokens: 8000 },
    });
});

/**
 * Run with the SDK pointed at the stand-in for the length of `fn`. The calibration itself refuses to
 * run with ANTHROPIC_BASE_URL set, so the variable is set only around the one-pull-request call.
 */
async function withStandIn<T>(fn: () => Promise<T>): Promise<T> {
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`;
  try {
    return await fn();
  } finally {
    Reflect.deleteProperty(process.env, "ANTHROPIC_BASE_URL");
  }
}

const target = (expected: CalibrationTarget["expected"] = null): CalibrationTarget => ({
  dataset: "nm000460",
  number: 2,
  expected,
});

describe("which pull requests it reads", () => {
  test("a pull request is a dataset and a number, with an optional expected outcome", () => {
    expect(parseTarget("nm000153#2")).toEqual({ dataset: "nm000153", number: 2, expected: null });
    expect(parseTarget("nemarDatasets/nm000456#1 fail")).toEqual({
      dataset: "nm000456",
      number: 1,
      expected: "fail",
    });
    for (const bad of ["nm000153", "nm153#2", "nm000153#2 maybe", "a/b#1", "nm000153#2 pass x"]) {
      expect(parseTarget(bad), bad).toBeNull();
    }
  });
});

describe("it posts nothing, and the key reaches only the API", () => {
  async function refused(argv: string[], env: Record<string, string> = {}) {
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    const lines: string[] = [];
    const quiet = console.error;
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      return { code: await calibrateMain(argv, () => {}), said: lines.join("\n") };
    } finally {
      console.error = quiet;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
      }
    }
  }

  test("a review's own arguments are refused, by name", async () => {
    for (const flag of ["--environment", "--review-id", "--callback-url", "--repo-dir", "--head"]) {
      const r = await refused(["--pr", "nm000153#2", flag, "x"]);
      expect(r.code, flag).toBe(2);
      expect(r.said).toContain("calibrate posts nothing");
    }
  });

  test("it will not run where a review's callback token is set", async () => {
    const r = await refused(["--pr", "nm000153#2"], { PR_REVIEW_CALLBACK_TOKEN: "t" });
    expect(r.code).toBe(2);
    expect(r.said).toContain("callback token is set");
  });

  test("it will not run while the SDK could be pointed elsewhere, and names the variable, not its value", async () => {
    const r = await refused(["--pr", "nm000153#2"], {
      ANTHROPIC_BASE_URL: "https://gateway.example/secret-path",
    });
    expect(r.code).toBe(2);
    expect(r.said).toContain("ANTHROPIC_BASE_URL is set");
    expect(r.said).not.toContain("gateway.example");
  });

  test("ANTHROPIC_AUTH_TOKEN alone is refused too, by name and not by value", async () => {
    const r = await refused(["--pr", "nm000153#2"], {
      ANTHROPIC_AUTH_TOKEN: "oauth-SECRET-VALUE",
    });
    expect(r.code).toBe(2);
    expect(r.said).toContain("ANTHROPIC_AUTH_TOKEN is set");
    expect(r.said).not.toContain("ANTHROPIC_BASE_URL");
    expect(r.said).not.toContain("SECRET-VALUE");
  });

  test("both are named when both are set, and neither value is printed", async () => {
    const r = await refused(["--pr", "nm000153#2"], {
      ANTHROPIC_BASE_URL: "https://gateway.example/secret-path",
      ANTHROPIC_AUTH_TOKEN: "oauth-SECRET-VALUE",
    });
    expect(r.code).toBe(2);
    expect(r.said).toContain("ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN are set");
    expect(r.said).not.toContain("gateway.example");
    expect(r.said).not.toContain("SECRET-VALUE");
  });

  const KEY = "sk-ant-SECRET-VALUE";

  test("a flag given as --name=value is refused by its name, and the value is never printed", async () => {
    for (const flag of ["callback-token", "environment", "token", "callback-url", "review-id"]) {
      const r = await refused([`--${flag}=${KEY}`, "--pr", "nm000153#2"]);
      expect(r.code, flag).toBe(2);
      expect(r.said, flag).toContain(`--${flag} is refused`);
      expect(r.said, flag).not.toContain(KEY);
    }
  });

  test("no message repeats the value of an argument, whichever argument it is", async () => {
    const lines = join(root, "secret-prs.txt");
    writeFileSync(lines, `nm000153#2\n${KEY}\n`);
    for (const argv of [
      ["--bogus", KEY],
      [`--bogus=${KEY}`],
      [`--pr=${KEY}`],
      [`--json=${KEY}`],
      ["--pr", KEY],
      ["--pr", "nm000153#2", KEY],
      ["--prs", join(root, KEY)],
      ["--prs", lines],
      [KEY],
    ]) {
      const r = await refused(argv);
      expect(r.code, JSON.stringify(argv)).toBe(2);
      expect(r.said, JSON.stringify(argv)).not.toContain(KEY);
    }
  });

  test("an unknown flag is never named, so a key pasted after two dashes is not printed", async () => {
    // What a key looks like when it lands where a flag goes. Each form used to be said back: as
    // `--NAME needs a value` when nothing followed it, and as `unknown argument --NAME` otherwise.
    const pasted = `--${KEY}`;
    for (const argv of [
      [pasted],
      [pasted, "x"],
      ["--pr", "nm000153#2", pasted],
      ["--pr", "nm000153#2", pasted, "--json"],
      [`${pasted}=value`],
      ["--json", pasted, "nm000153#2"],
    ]) {
      const r = await refused(argv);
      expect(r.code, JSON.stringify(argv)).toBe(2);
      expect(r.said, JSON.stringify(argv)).toContain("unknown flag");
      expect(r.said, JSON.stringify(argv)).not.toContain(KEY);
    }
    // The flags the script knows are still named, so a message stays useful.
    for (const known of ["--pr", "--prs"]) {
      const r = await refused([known]);
      expect(r.code, known).toBe(2);
      expect(r.said, known).toContain(`${known} needs a value`);
    }
  });

  test("a line of the file that is not a pull request is named by its number, not its text", async () => {
    const file = join(root, "numbered-prs.txt");
    writeFileSync(file, `nm000153#2\n\n# a comment\n${KEY}\n`);
    const r = await refused(["--prs", file]);
    expect(r.code).toBe(2);
    expect(r.said).toContain("line 4 of the pull request file");
    expect(r.said).not.toContain(KEY);
  });

  test("no pull request named is a usage error", async () => {
    expect((await refused([])).code).toBe(2);
    expect((await refused(["--pr", "not-a-pr"])).code).toBe(2);
  });

  test("a child is started without any ANTHROPIC_ variable or the callback token, and keeps what gh signs in with", () => {
    const env = childEnv({
      ANTHROPIC_API_KEY: "sk-ant-key",
      ANTHROPIC_AUTH_TOKEN: "oauth",
      ANTHROPIC_BASE_URL: "https://gateway.example",
      ANTHROPIC_FEDERATION_RULE_ID: "rule",
      anthropic_api_key: "lower",
      PR_REVIEW_CALLBACK_TOKEN: "callback",
      pr_review_callback_token: "lower-callback",
      GH_TOKEN: "ghp_token",
      GITHUB_TOKEN: "github_token",
      HOME: "/home/operator",
      PATH: "/usr/bin",
    });
    expect(
      Object.keys(env).filter((name) => /^(?:anthropic_|pr_review_callback_token$)/i.test(name)),
    ).toEqual([]);
    expect(env).toMatchObject({
      GH_TOKEN: "ghp_token",
      GITHUB_TOKEN: "github_token",
      HOME: "/home/operator",
      PATH: "/usr/bin",
      // And git's system configuration stays out, with no prompt.
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
    });
  });

  test("a child is not handed the request for an identity token, in any case, and keeps the rest", () => {
    const env = childEnv({
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.example/idtoken?api-version=2.0",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-SECRET",
      actions_id_token_request_token: "lower-request-SECRET",
      ACTIONS_ID_TOKEN_REQUEST_FUTURE: "another",
      GH_TOKEN: "ghp_token",
      GITHUB_TOKEN: "github_token",
      HOME: "/home/operator",
      PATH: "/usr/bin",
    });
    expect(Object.keys(env).filter((name) => /^actions_id_token_request_/i.test(name))).toEqual([]);
    expect(Object.values(env).join("\n")).not.toContain("request-SECRET");
    expect(env).toMatchObject({
      GH_TOKEN: "ghp_token",
      GITHUB_TOKEN: "github_token",
      HOME: "/home/operator",
      PATH: "/usr/bin",
    });
  });
});

describe("one pull request, through the job's own stage flow", () => {
  test("a clean pull request passes: both stages, their tokens and seconds, and the cost", async () => {
    const row = await withStandIn(() =>
      calibrateOne(target("pass"), root, localPullRequest("clean")),
    );
    expect(row).toMatchObject({
      pr: "nm000460#2",
      files: 3,
      facts: [],
      stage: "full",
      screen: "proceed",
      verdict: "pass",
      check: "success",
      error: null,
      reviewTokens: { input_tokens: 20000, output_tokens: 8000 },
    });
    expect(row.screenTokens).toEqual({ input_tokens: 1200, output_tokens: 300 });
    expect(row.screenSeconds).not.toBeNull();
    expect(row.reviewSeconds).not.toBeNull();
    // 1,200 x 0.10 + 300 x 0.50 + 20,000 x 2 + 8,000 x 10, per million: $0.12.
    expect(row.costUsd).toBe(0.12);
    expect(requests.map((r) => r.model)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
    expect(requests.every((r) => r.path === "/v1/messages")).toBe(true);
  });

  test("a merged pull request is judged on what it changed: the base is the one it recorded", async () => {
    // The pull request is closed and its head is reachable from main: a run of the job's own
    // dispatch checks would call it stale. The calibration reviews it all the same.
    const read = localPullRequest("merged", { state: "closed", merged: true }, { merge: true });
    const row = await withStandIn(() => calibrateOne(target(), root, read));
    expect(row.verdict).toBe("pass");
    expect(row.files).toBe(3);
  });

  test("the facts come first: an author-and-year title fails, whatever the models said", async () => {
    const read = localPullRequest("title", { title: "Lee2019 EEG update" });
    const row = await withStandIn(() => calibrateOne(target("pass"), root, read));
    expect(row.facts).toEqual(["title_author_year"]);
    expect(row.verdict).toBe("fail");
  });

  test("a key in the middle of a title is a fact too, and a year after a space is not", async () => {
    const middle = localPullRequest("title-middle", { title: "Add the Lee2019 recordings" });
    const row = await withStandIn(() => calibrateOne(target("fail"), root, middle));
    expect(row.facts).toEqual(["title_author_year"]);
    expect(row.stage).toBe("facts");
    expect(row.verdict).toBe("fail");
    expect(renderTable([row]).join("\n")).toMatch(/nm000460#2 +3 +title_author_year +not_run +/);
    // The control: the same year after a space is no key, so both models are asked.
    const spaced = localPullRequest("title-space", { title: "Add the 2019 recordings" });
    const control = await withStandIn(() => calibrateOne(target("pass"), root, spaced));
    expect(control.facts).toEqual([]);
    expect(control.stage).toBe("full");
  });

  test("a DOI in a title is its own fact in the table, and a number with a dot is none", async () => {
    const doi = localPullRequest("title-doi", {
      title: "Add the recordings described in 10.1038/s41597-020-0532-5",
    });
    const row = await withStandIn(() => calibrateOne(target("fail"), root, doi));
    expect(row.facts).toEqual(["title_doi"]);
    expect(row.stage).toBe("facts");
    expect(row.verdict).toBe("fail");
    expect(renderTable([row]).join("\n")).toMatch(/nm000460#2 +3 +title_doi +not_run +/);
    const hz = localPullRequest("title-hz", { title: "Correct the rate to 10.5 Hz" });
    const control = await withStandIn(() => calibrateOne(target("pass"), root, hz));
    expect(control.facts).toEqual([]);
    expect(control.stage).toBe("full");
  });

  test("a naming fact ends it at the facts: no model is asked, the screen did not run, and nothing was spent", async () => {
    const read = localPullRequest("facts", { title: "Lee2019 EEG update" });
    const row = await withStandIn(() => calibrateOne(target("fail"), root, read));
    expect(requests).toHaveLength(0);
    expect(row).toMatchObject({
      stage: "facts",
      screen: "not_run",
      facts: ["title_author_year"],
      verdict: "fail",
      check: "failure",
      error: null,
      screenTokens: null,
      reviewTokens: null,
      // A measurement, not a missing one: no model was asked, so nothing was spent.
      costUsd: 0,
      // Nothing was asked of a model, so nothing was flagged: a report's own answer, not a gap.
      steering: false,
    });
    const table = renderTable([row]).join("\n");
    expect(table).toMatch(/nm000460#2 +3 +title_author_year +not_run +/);
    expect(table).toContain("$0.00");
  });

  test("a changed name nobody can read ends it at the facts too, and is a pull request a person must look at", async () => {
    const dir = join(root, "unreadable-name");
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    write(
      dir,
      "dataset_description.json",
      JSON.stringify({ Name: "Resting EEG", Version: "1.0.0" }),
    );
    write(dir, "CHANGES", "1.0.0 2026-01-01\n - Initial release\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "initial");
    const base = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "-b", "contrib");
    write(dir, "dataset_description.json", JSON.stringify({ Name: 7, Version: "1.1.0" }));
    write(dir, "CHANGES", "1.1.0 2026-10-16\n - Renamed\n1.0.0 2026-01-01\n - Initial release\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "rename");
    const head = git(dir, "rev-parse", "HEAD");
    const pr = { title: "Rename the dataset", body: "The name field was a label." };
    const row = await withStandIn(() =>
      calibrateOne(target("uncertain"), root, () => ({ dir, base, head, pr })),
    );
    expect(requests).toHaveLength(0);
    expect(row).toMatchObject({
      stage: "facts",
      facts: ["name_unchecked"],
      verdict: "uncertain",
      check: "action_required",
      error: null,
    });
  });

  test("a stop by the screen is one call and a fail", async () => {
    screenReply = () => standInMessage(JSON.stringify({ decision: "reject", note: "Advert." }));
    const row = await withStandIn(() => calibrateOne(target(), root, localPullRequest("spam")));
    expect(row).toMatchObject({ stage: "screen", screen: "reject", verdict: "fail" });
    expect(row.reviewTokens).toBeNull();
    expect(requests).toHaveLength(1);
  });

  test("a refusal at the review is no verdict, and the screen's tokens are still counted", async () => {
    reviewReply = () => standInMessage(REVIEW, { stop_reason: "refusal" });
    const row = await withStandIn(() => calibrateOne(target(), root, localPullRequest("refused")));
    expect(row).toMatchObject({ verdict: null, error: "model_refused", screen: "proceed" });
    expect(row.screenTokens).not.toBeNull();
    expect(row.costUsd).not.toBeNull();
  });

  test("a pull request that cannot be read is a row that says so, not a crash", async () => {
    const row = await calibrateOne(target(), root, () => {
      throw new Error(`gh failed ${SECRET}`);
    });
    expect(row).toMatchObject({ error: "not_readable", verdict: null });
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });

  test("a read that failed at a known step says which, in its closed word", async () => {
    for (const code of ["gh_failed", "no_commit", "fetch_failed"] as const) {
      const row = await calibrateOne(target(), root, () => {
        throw new CalibrationReadError(code);
      });
      expect(row).toMatchObject({ error: code, verdict: null, costUsd: null });
    }
    expect(requests).toHaveLength(0);
  });
});

describe("reading a pull request from GitHub, as the workflow does", () => {
  /**
   * A bare repository standing in for github.com/nemarDatasets/nm000460, with the pull request's
   * head at refs/pull/2/head and blob-less fetches allowed, and a `gh` on PATH that answers the one
   * API read with `answer`. Git is sent to the bare repository by a url rewrite in the environment.
   */
  function standInGitHub(name: string, answer: string) {
    const read = localPullRequest(`${name}-source`);
    const { dir, base, head } = read(target());
    const origin = join(root, `${name}-origin.git`);
    execFileSync("git", ["clone", "-q", "--bare", dir, origin], { env: GIT_ENV });
    git(origin, "update-ref", "refs/pull/2/head", head);
    git(origin, "config", "uploadpack.allowFilter", "true");
    git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
    const bin = join(root, `${name}-bin`);
    mkdirSync(bin, { recursive: true });
    const reply = join(bin, "reply.json");
    writeFileSync(reply, answer.replaceAll("BASE", base).replaceAll("HEAD", head));
    // What the real `gh` would be handed: its environment is written out before it answers.
    const ghEnv = join(bin, "gh-env.txt");
    writeFileSync(join(bin, "gh"), `#!/bin/sh\nenv > '${ghEnv}'\ncat '${reply}'\n`);
    chmodSync(join(bin, "gh"), 0o755);
    const saved = {
      PATH: process.env.PATH,
      GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
      GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
      GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
    };
    process.env.PATH = `${bin}:${saved.PATH ?? ""}`;
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = `url.file://${origin}.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = "https://github.com/nemarDatasets/nm000460.git";
    const restore = () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
      }
    };
    return { base, head, ghEnv, restore };
  }

  test("it reads the pull request with gh and fetches its base and head blob-less", () => {
    const gh = standInGitHub("fetch-ok", '{"base":{"sha":"BASE"},"head":{"sha":"HEAD"}}');
    const into = mkdtempSync(join(root, "into-"));
    try {
      const fetched = fetchPullRequest(target(), into);
      expect(fetched.base).toBe(gh.base);
      expect(fetched.head).toBe(gh.head);
      expect(fetched.pr).toMatchObject({ base: { sha: gh.base } });
      // A partial clone of the stand-in, as the workflow's: no checkout, blobs fetched on demand.
      expect(git(fetched.dir, "config", "extensions.partialClone")).toBe("origin");
      expect(git(fetched.dir, "rev-parse", "refs/remotes/pr/head")).toBe(gh.head);
      // And the review's listing can read it, fetching dataset_description.json when it asks.
      const listing = gatherListing(fetched.dir, fetched.base, fetched.head);
      expect(listing.changes).toHaveLength(3);
      expect(listing.versionAfter).toBe("1.1.0");
    } finally {
      gh.restore();
    }
  });

  test("the gh that reads the pull request never sees the operator's key, and keeps its own sign-in", () => {
    // The process has the key (the beforeAll above) and a GitHub token, as an operator's shell does.
    const key = process.env.ANTHROPIC_API_KEY;
    expect(key).toBeDefined();
    const before = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp-operator-token";
    const gh = standInGitHub("fetch-env", '{"base":{"sha":"BASE"},"head":{"sha":"HEAD"}}');
    const into = mkdtempSync(join(root, "into-"));
    try {
      fetchPullRequest(target(), into);
      const seen = readFileSync(gh.ghEnv, "utf8");
      expect(seen).not.toMatch(/^ANTHROPIC_/im);
      expect(seen).not.toContain(key as string);
      expect(seen).toContain("GH_TOKEN=ghp-operator-token");
      expect(seen).toMatch(/^PATH=/m);
    } finally {
      gh.restore();
      if (before === undefined) Reflect.deleteProperty(process.env, "GH_TOKEN");
      else process.env.GH_TOKEN = before;
    }
  });

  test("every git calibrateOne starts, its fetch and the review's reads, is handed childEnv and no key", async () => {
    // The process holds the operator's key (the beforeAll above); a callback token, a federation
    // rule and the request for an identity token are the other names no child may be handed.
    // calibrateMain refuses a token, calibrateOne does not, so setting one here proves the filter
    // and not the refusal.
    const extra = {
      PR_REVIEW_CALLBACK_TOKEN: "callback-SECRET-TOKEN",
      ANTHROPIC_FEDERATION_RULE_ID: "rule-SECRET-ID",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.example/idtoken-SECRET-URL",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-SECRET-TOKEN",
    };
    const saved = Object.fromEntries(Object.keys(extra).map((k) => [k, process.env[k]]));
    const key = process.env.ANTHROPIC_API_KEY;
    expect(key).toBeDefined();
    const gh = standInGitHub(
      "fetch-git-env",
      JSON.stringify({
        base: { sha: "BASE" },
        head: { sha: "HEAD" },
        title: "Correct the sampling rate in the EEG sidecar",
        body: "The sidecar said 256 Hz; the recording is 512 Hz.",
      }),
    );
    const log = join(root, "git-env-calls.log");
    const into = mkdtempSync(join(root, "into-"));
    Object.assign(process.env, extra);
    const restoreGit = installGitShim(root, [{ match: " ", envLog: log }]);
    let seen: ReturnType<typeof readEnvLog>;
    let expected: NodeJS.ProcessEnv;
    let row: CalibrationRow;
    try {
      expected = childEnv();
      row = await withStandIn(() => calibrateOne(target(), into, fetchPullRequest));
      seen = readEnvLog(log);
    } finally {
      restoreGit();
      gh.restore();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
      }
    }
    // Both passes of the review ran, so the fetch, the listing and the content were all read by git.
    expect(row).toMatchObject({ stage: "full", error: null });
    // The calls this code starts: the calibration's own (`git init`, then `git -C <dir> config`,
    // `remote` and `fetch`) and the evidence reader's (every one carries the protocol fence).
    const own = seen.filter((c) => /^ (?:init -q |-C \S+ (?:config|remote|fetch) )/.test(c.args));
    const reads = seen.filter((c) => c.args.includes("protocol.ext.allow=never"));
    expect(own.length).toBeGreaterThanOrEqual(5);
    expect(own.some((c) => c.args.includes(" fetch "))).toBe(true);
    expect(reads.some((c) => c.args.includes(" merge-base "))).toBe(true);
    expect(reads.some((c) => c.args.includes(" --numstat "))).toBe(true);
    // The shell the shim runs in rewrites these four, and git puts its own directory first on PATH
    // for what it starts; every other variable is exactly what childEnv() gave.
    const rewritten = new Set(["_", "PWD", "OLDPWD", "SHLVL", "PATH"]);
    for (const call of [...own, ...reads]) {
      expect(call.env.PATH, call.args).toBeDefined();
      for (const [name, value] of Object.entries(expected)) {
        // The log is `env` output: a name that is not a plain identifier (an exported shell function)
        // and a value that spans lines are not told apart from the lines around them.
        if (rewritten.has(name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
        if (value?.includes("\n")) continue;
        expect(call.env[name], `${name} in ${call.args}`).toBe(value);
      }
    }
    // The calibration's own git also keeps the operator's configuration out of the clone.
    for (const call of own) expect(call.env.GIT_CONFIG_GLOBAL, call.args).toBe("/dev/null");
    // No git, nested or not, was handed a key, a token or a rule, by name or under another one.
    for (const call of seen) {
      const names = Object.keys(call.env);
      const keys = names.filter((n) => /^(?:anthropic_|actions_id_token_request_)/i.test(n));
      expect(keys, call.args).toEqual([]);
      expect(names, call.args).not.toContain("PR_REVIEW_CALLBACK_TOKEN");
    }
    const everything = readFileSync(log, "utf8");
    for (const secret of [key as string, ...Object.values(extra), `127.0.0.1:${server.port}`]) {
      expect(everything).not.toContain(secret);
    }
  });

  test("an answer that names no commit is no_commit, and a gh that is not JSON is gh_failed", () => {
    const into = mkdtempSync(join(root, "into-"));
    const noCommit = standInGitHub("fetch-no-commit", '{"base":{"sha":"BASE"},"head":{}}');
    try {
      expect(() => fetchPullRequest(target(), into)).toThrow(new CalibrationReadError("no_commit"));
    } finally {
      noCommit.restore();
    }
    const garbage = standInGitHub("fetch-garbage", "<html>rate limited</html>");
    try {
      expect(() => fetchPullRequest(target(), into)).toThrow(new CalibrationReadError("gh_failed"));
    } finally {
      garbage.restore();
    }
  });

  test("a base commit the repository does not have is fetch_failed", () => {
    const into = mkdtempSync(join(root, "into-"));
    const gh = standInGitHub(
      "fetch-missing",
      `{"base":{"sha":"${"e".repeat(40)}"},"head":{"sha":"HEAD"}}`,
    );
    try {
      expect(() => fetchPullRequest(target(), into)).toThrow(
        new CalibrationReadError("fetch_failed"),
      );
    } finally {
      gh.restore();
    }
  });
});

describe("the run: its arguments, its output, and its exit code", () => {
  test("every pull request with a verdict is exit 0; any without one is exit 1", () => {
    const row = (verdict: CalibrationRow["verdict"]): CalibrationRow =>
      ({ verdict }) as CalibrationRow;
    expect(exitCodeOf([row("pass"), row("fail"), row("uncertain")])).toBe(0);
    expect(exitCodeOf([row("pass"), row(null)])).toBe(1);
    expect(exitCodeOf([row(null)])).toBe(1);
  });

  test("--prs reads a file of pull requests, skipping blanks and comments; --json prints the rows", async () => {
    const file = join(root, "prs.txt");
    writeFileSync(file, "# the gate's first two\nnm000153#2 pass\n\nnemarDatasets/nm000456#1\n");
    const out: string[] = [];
    const code = await calibrateMain(
      ["--prs", file, "--json"],
      (l) => out.push(l),
      () => {
        throw new CalibrationReadError("gh_failed");
      },
    );
    // Neither could be read, so neither has a verdict: exit 1, and the rows say why.
    expect(code).toBe(1);
    const rows = JSON.parse(out.join("\n")) as CalibrationRow[];
    expect(rows.map((r) => [r.pr, r.expected, r.error])).toEqual([
      ["nm000153#2", "pass", "gh_failed"],
      ["nm000456#1", null, "gh_failed"],
    ]);
    expect(requests).toHaveLength(0);
  });

  test("a pull request named twice is read and calibrated once, with the first expected outcome", async () => {
    // Read twice into the same directory, the second `git remote add` fails and the second row says
    // fetch_failed for no fault of the pull request's.
    const file = join(root, "twice-prs.txt");
    writeFileSync(
      file,
      "nm000153#2 pass\nnemarDatasets/nm000456#1\nnemarDatasets/nm000153#2 fail\nnm000153#2\n",
    );
    const read: string[] = [];
    const out: string[] = [];
    const said: string[] = [];
    const quiet = console.error;
    console.error = (...a: unknown[]) => void said.push(a.map(String).join(" "));
    let code: number;
    try {
      code = await calibrateMain(
        ["--prs", file, "--pr", "nm000456#1", "--json"],
        (l) => out.push(l),
        (t) => {
          read.push(`${t.dataset}#${t.number}`);
          throw new CalibrationReadError("gh_failed");
        },
      );
    } finally {
      console.error = quiet;
    }
    expect(code).toBe(1);
    expect(read).toEqual(["nm000153#2", "nm000456#1"]);
    const rows = JSON.parse(out.join("\n")) as CalibrationRow[];
    expect(rows.map((r) => [r.pr, r.expected])).toEqual([
      ["nm000153#2", "pass"],
      ["nm000456#1", null],
    ]);
    expect(said.join("\n")).toContain("3 mentions of a pull request already named");
  });

  test("the table's last lines count the rows without a verdict and do not price what was not counted", async () => {
    const out: string[] = [];
    const code = await calibrateMain(
      ["--pr", "nm000153#2"],
      (l) => out.push(l),
      () => {
        throw new CalibrationReadError("fetch_failed");
      },
    );
    expect(code).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("no verdict (fetch_failed)");
    expect(text).toContain("1 pull request, 1 without a verdict");
    expect(text).toContain("no tokens reported, so no cost estimate");
    expect(text).not.toContain("$0.00");
  });

  test("a line of the file that is not a pull request is a usage error, and nothing is read", async () => {
    const file = join(root, "bad-prs.txt");
    writeFileSync(file, "nm000153#2\nnot a pull request\n");
    const quiet = console.error;
    console.error = () => {};
    let read = 0;
    try {
      const code = await calibrateMain(
        ["--prs", file],
        () => {},
        () => {
          read++;
          throw new CalibrationReadError("gh_failed");
        },
      );
      expect(code).toBe(2);
    } finally {
      console.error = quiet;
    }
    expect(read).toBe(0);
  });
});

describe("the table", () => {
  test("is closed words and numbers: never a pull request's text or a model's words", async () => {
    const rows: CalibrationRow[] = [];
    rows.push(await withStandIn(() => calibrateOne(target("pass"), root, localPullRequest("t1"))));
    reviewReply = () => standInMessage(REVIEW, { stop_reason: "max_tokens" });
    rows.push(await withStandIn(() => calibrateOne(target("fail"), root, localPullRequest("t2"))));
    const table = renderTable(rows).join("\n");
    expect(table).not.toContain(SECRET);
    expect(table).not.toContain("sampling rate");
    expect(table).toContain("PR");
    expect(table).toContain("EXPECTED");
    expect(table).toContain("no verdict (model_truncated)");
    expect(table).toMatch(
      /nm000460#2 +3 +none +proceed +pass pass pass pass pass +no +pass +success +pass +yes/,
    );
    expect(table).toContain("claude-haiku-5-5");
    expect(table).toContain("claude-sonnet-5-5");
  });

  test("a steering flag is a column and a count, because the gate allows none on a legitimate pull request", async () => {
    // The review answers pass to every question and says the description tried to instruct it.
    reviewReply = () =>
      standInMessage(JSON.stringify({ ...JSON.parse(REVIEW), steering: true }), {
        model: "claude-sonnet-5-5",
        usage: { input_tokens: 20000, output_tokens: 8000 },
      });
    const flagged = await withStandIn(() =>
      calibrateOne(target("pass"), root, localPullRequest("steered")),
    );
    reviewReply = () =>
      standInMessage(REVIEW, {
        model: "claude-sonnet-5-5",
        usage: { input_tokens: 20000, output_tokens: 8000 },
      });
    const clean = await withStandIn(() =>
      calibrateOne(target("pass"), root, localPullRequest("unsteered")),
    );
    const unread = await calibrateOne(target(), root, () => {
      throw new CalibrationReadError("gh_failed");
    });
    expect(flagged).toMatchObject({ steering: true, verdict: "fail", check: "failure" });
    expect(clean).toMatchObject({ steering: false, verdict: "pass" });
    // No report, no answer: not "no flag".
    expect(unread.steering).toBeNull();
    // It travels in the rows a person pastes as JSON, too.
    expect(
      JSON.parse(JSON.stringify([flagged, clean, unread])).map((r: CalibrationRow) => r.steering),
    ).toEqual([true, false, null]);

    const lines = renderTable([flagged, clean, unread]);
    const table = lines.join("\n");
    expect(lines[0]).toContain("STEERING");
    expect(table).toMatch(/pass pass pass pass pass +YES +fail +failure/);
    expect(table).toMatch(/pass pass pass pass pass +no +pass +success/);
    expect(table).toMatch(/ +- +no verdict \(gh_failed\)/);
    expect(table).toContain("3 pull requests, 1 without a verdict, 1 with a steering flag;");
    // And the note under the table says what the word means.
    expect(table).toContain(
      "STEERING is YES when the review said text in the pull request tried to instruct it",
    );
  });
});
