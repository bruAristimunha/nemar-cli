/**
 * The pull-request review's offline calibration (`scripts/ci/pr-review-calibrate.ts`, ADR 0107).
 *
 * The calibration runs the review job's own stage flow, so these tests run it for real: a real git
 * repository built in a temporary directory stands in for the dataset GitHub would serve (the one
 * part that needs the network), and the real Anthropic SDK talks to a local server that answers the
 * way the Messages API does, streamed (`helpers/anthropic-sse.ts`). What is checked is what the
 * table says, what it never says (a pull request's text, a model's words), and that nothing is
 * posted anywhere.
 *
 * Beyond the normal mode, the tests cover:
 *  - pinned commits, fetched by id, and `--clones` (frozen clones read in place: what makes a clone,
 *    the commits it must hold, that checking them never fetches, and a git older than 2.45, which
 *    would, refused);
 *  - `--offline` (nothing is fetched, and the run's git environment is put back as it was);
 *  - `--evidence-only` and `--without-summary` (no model and no key, the evidence table and its
 *    totals, the refused files that delete a line and HIDDEN as exit 1, no path or value printed);
 *  - the frozen set A: its manifest, its stored baseline and the label template for the model
 *    calibration, and, when the archive of its clones is on this machine, a run over it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  CalibrationReadError,
  type CalibrationRow,
  type CalibrationTarget,
  type EvidenceRow,
  type FetchedPullRequest,
  calibrateMain,
  calibrateOne,
  evidenceExitCode,
  evidenceRowOf,
  exitCodeOf,
  fetchPinned,
  fetchPullRequest,
  honorsNoLazyFetch,
  parseGitVersion,
  parseTarget,
  refusedDeletions,
  renderEvidenceTable,
  renderTable,
  scopeRunEnvironment,
} from "../scripts/ci/pr-review-calibrate";
import { childEnv, gatherContent, gatherListing } from "../scripts/ci/pr-review-evidence";
import { CLASS_KINDS, SUMMARY_REFUSALS } from "../scripts/ci/pr-review-summary";
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

  test("a pull request may carry its pinned base and head; one commit alone is refused", () => {
    const base = "a".repeat(40);
    const head = "b".repeat(40);
    expect(parseTarget(`on004551#1 ${base} ${head}`)).toEqual({
      dataset: "on004551",
      number: 1,
      expected: null,
      pin: { base, head },
    });
    expect(parseTarget(`nemarDatasets/on004551#1 fail ${base}  ${head}`)).toEqual({
      dataset: "on004551",
      number: 1,
      expected: "fail",
      pin: { base, head },
    });
    // No pin is no key at all, so a target without one reads as it always did.
    expect(Object.keys(parseTarget("on004551#1 pass") ?? {})).toEqual([
      "dataset",
      "number",
      "expected",
    ]);
    for (const bad of [
      `on004551#1 ${base}`,
      `on004551#1 pass ${base}`,
      `on004551#1 ${base} ${head} ${head}`,
      `on004551#1 ${base} ${head} pass`,
      `on004551#1 ${base.slice(1)} ${head}`,
      `on004551#1 ${base} ${head.toUpperCase()}`,
      `on004551#1 ? ${base} ${head}`,
      `on004551#1 ${base} HEAD`,
    ]) {
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
      ["--pr", "nm000153#2", "--clones", join(root, KEY)],
      ["--pr", "nm000153#2", "--clones", KEY],
      [`--clones=${KEY}`, "--pr", "nm000153#2"],
      [`--offline=${KEY}`, "--pr", "nm000153#2"],
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

  test("pinned commits are fetched by id, blob-less, and gh is never asked", () => {
    const gh = standInGitHub("fetch-pinned", "{}");
    const into = mkdtempSync(join(root, "into-"));
    try {
      const fetched = fetchPinned({ ...target(), pin: { base: gh.base, head: gh.head } }, into);
      expect([fetched.base, fetched.head]).toEqual([gh.base, gh.head]);
      // No text was read: there is no gh call that could have read it.
      expect(fetched.pr).toEqual({});
      expect(existsSync(gh.ghEnv)).toBe(false);
      expect(git(fetched.dir, "config", "extensions.partialClone")).toBe("origin");
      expect(git(fetched.dir, "rev-parse", "refs/remotes/pr/head")).toBe(gh.head);
      expect(git(fetched.dir, "cat-file", "-t", gh.base)).toBe("commit");
      const listing = gatherListing(fetched.dir, fetched.base, fetched.head);
      expect(listing.changes).toHaveLength(3);
      // A head GitHub no longer has (force-pushed away) cannot be fetched.
      const gone = mkdtempSync(join(root, "into-"));
      expect(() =>
        fetchPinned({ ...target(), pin: { base: gh.base, head: "e".repeat(40) } }, gone),
      ).toThrow(new CalibrationReadError("fetch_failed"));
      expect(existsSync(gh.ghEnv)).toBe(false);
    } finally {
      gh.restore();
    }
  });

  test("--evidence-only reads pinned commits by id without --clones, and gh is never asked", async () => {
    const gh = standInGitHub("evidence-pinned", "{}");
    const file = join(root, "evidence-pinned-prs.txt");
    writeFileSync(file, `nm000460#2 ${gh.base} ${gh.head}\n`);
    const out: string[] = [];
    let code: number;
    try {
      code = await calibrateMain(["--prs", file, "--evidence-only", "--json"], (l) => out.push(l));
    } finally {
      gh.restore();
    }
    expect(code).toBe(0);
    expect(existsSync(gh.ghEnv)).toBe(false);
    const rows = JSON.parse(out.join("\n")) as EvidenceRow[];
    expect(rows[0]).toMatchObject({ pr: "nm000460#2", error: null });
    expect(rows[0]?.evidence?.files).toBe(3);
    expect(requests).toHaveLength(0);
  });
});

/** A `gh` first on PATH that records that it ran; returns where, and how to take it away. */
function watchedGh(name: string) {
  const bin = join(root, `${name}-gh-bin`);
  mkdirSync(bin, { recursive: true });
  const ran = join(bin, "ran.txt");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho ran >> '${ran}'\nexit 1\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved ?? ""}`;
  return {
    ran,
    restore: () => {
      process.env.PATH = saved;
    },
  };
}

/** Run calibrateMain with its output and its messages kept. */
async function calibrate(argv: string[]) {
  const out: string[] = [];
  const said: string[] = [];
  const quiet = console.error;
  console.error = (...a: unknown[]) => void said.push(a.map(String).join(" "));
  try {
    const code = await calibrateMain(argv, (l) => out.push(l));
    return { code, out: out.join("\n"), said: said.join("\n") };
  } finally {
    console.error = quiet;
  }
}

/**
 * A directory of frozen clones: `nm000460-2` and `nm000460-3`, full clones of one pull request,
 * with `.shas` and `.pr.json` beside them. The title fails the naming rule, so a run in the normal
 * mode ends at the facts and asks no model.
 */
function frozenClones(name: string, shas: (base: string, head: string) => string) {
  const { dir, base, head } = localPullRequest(`${name}-source`)(target());
  const clones = join(root, `${name}-clones`);
  mkdirSync(clones, { recursive: true });
  for (const n of [2, 3]) {
    execFileSync("git", ["clone", "-q", "--no-checkout", dir, join(clones, `nm000460-${n}`)], {
      env: GIT_ENV,
    });
    writeFileSync(join(clones, `nm000460-${n}.shas`), shas(base, head));
    writeFileSync(
      join(clones, `nm000460-${n}.pr.json`),
      JSON.stringify({ title: "Lee2019 EEG update", body: SECRET }),
    );
  }
  return { clones, base, head };
}

describe("frozen clones: --clones and --offline", () => {
  test("--clones reads pinned commits and never runs gh", async () => {
    // The .shas files name the head twice: no change at all. The pin on the first line names the
    // pull request's own base and head, three files.
    const { clones, base, head } = frozenClones("clones-read", (_, h) => `${h} ${h}\n`);
    const file = join(root, "clones-read-prs.txt");
    writeFileSync(file, `nm000460#2 fail ${base} ${head}\nnm000460#3\n`);
    const gh = watchedGh("clones-read");
    let r: Awaited<ReturnType<typeof calibrate>>;
    try {
      r = await calibrate(["--prs", file, "--clones", clones, "--json"]);
    } finally {
      gh.restore();
    }
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.out) as CalibrationRow[];
    expect(rows.map((x) => [x.pr, x.files, x.stage, x.facts, x.verdict, x.error])).toEqual([
      ["nm000460#2", 3, "facts", ["title_author_year"], "fail", null],
      ["nm000460#3", 0, "facts", ["title_author_year"], "fail", null],
    ]);
    expect(existsSync(gh.ran)).toBe(false);
    expect(requests).toHaveLength(0);
    expect(r.out).not.toContain(SECRET);
    expect(r.out).not.toContain(clones);
  });

  test("a clone that is not there, a pull request with no commits, and a commit the clone lacks each say so", async () => {
    const { clones, base } = frozenClones("clones-missing", (b, h) => `${b} ${h}\n`);
    rmSync(join(clones, "nm000460-3.shas"));
    const file = join(root, "clones-missing-prs.txt");
    writeFileSync(
      file,
      `nm000460#4\nnm000460#3\nnm000460#2 ${base} ${"e".repeat(40)}\nnemarDatasets/nm000460#2\n`,
    );
    const r = await calibrate(["--prs", file, "--clones", clones, "--json"]);
    expect(r.code).toBe(1);
    const rows = JSON.parse(r.out) as CalibrationRow[];
    expect(rows.map((x) => [x.pr, x.error])).toEqual([
      ["nm000460#4", "clone_missing"],
      ["nm000460#3", "no_commit"],
      ["nm000460#2", "objects_missing"],
    ]);
    // A directory beside the clones that is not a repository is missing too, even when a
    // repository encloses it: the repository git finds must have the clone's own directory as its
    // top level, and the one above does not.
    git(clones, "init", "-q");
    mkdirSync(join(clones, "nm000460-5"));
    writeFileSync(join(clones, "nm000460-5.shas"), `${base} ${base}\n`);
    const five = await calibrate(["--pr", "nm000460#5", "--clones", clones, "--json"]);
    expect((JSON.parse(five.out) as CalibrationRow[])[0]?.error).toBe("clone_missing");
  });

  test("an empty .git is no clone, even inside a repository that holds the commits", async () => {
    const { clones, base, head } = frozenClones("clones-ceiling", (b, h) => `${b} ${h}\n`);
    // The clones directory is itself a repository holding the pull request's commits, so a search
    // for a repository that left a clone's own directory would find them there and read it.
    git(clones, "init", "-q");
    git(clones, "fetch", "-q", join(clones, "nm000460-2"), "+refs/*:refs/enclosing/*");
    expect(git(clones, "cat-file", "-t", head)).toBe("commit");
    mkdirSync(join(clones, "nm000460-6", ".git"), { recursive: true });
    writeFileSync(join(clones, "nm000460-6.shas"), `${base} ${head}\n`);
    const r = await calibrate([
      "--pr",
      "nm000460#6",
      "--pr",
      "nm000460#2",
      "--clones",
      clones,
      "--evidence-only",
      "--json",
    ]);
    // The empty .git is clone_missing; a real clone in the same directory still reads.
    const rows = JSON.parse(r.out) as EvidenceRow[];
    expect(rows.map((x) => [x.pr, x.error])).toEqual([
      ["nm000460#6", "clone_missing"],
      ["nm000460#2", null],
    ]);
    expect(rows[1]?.evidence?.files).toBe(3);
  });

  /**
   * A full clone of the pull request's source at `dir`, made with git so it holds both commits: a
   * repository that encloses whatever is put inside it, and that a clone must never borrow.
   */
  function enclosingRepository(source: string, dir: string, bare = false): void {
    execFileSync("git", ["clone", "-q", ...(bare ? ["--bare"] : ["--no-checkout"]), source, dir], {
      env: GIT_ENV,
    });
  }

  /** Evidence rows of one run over `prs` in `clones`, by pull request and error. */
  async function errorsOf(clones: string, prs: string[]): Promise<[string, string | null][]> {
    const r = await calibrate([
      ...prs.flatMap((p) => ["--pr", p]),
      "--clones",
      clones,
      "--evidence-only",
      "--json",
    ]);
    return (JSON.parse(r.out) as EvidenceRow[]).map((x) => [x.pr, x.error]);
  }

  /**
   * Frozen clones beside a full clone of their source, `enclosing`, which holds both commits: what a
   * clone that is not its own repository could borrow.
   */
  function borrowable(name: string) {
    const { clones, base, head } = frozenClones(name, (b, h) => `${b} ${h}\n`);
    const source = join(root, `${name}-source`);
    const enclosing = join(root, `${name}-enclosing`);
    enclosingRepository(source, enclosing);
    expect(git(enclosing, "cat-file", "-t", head)).toBe("commit");
    return { clones, source, enclosing, shas: `${base} ${head}\n` };
  }

  test("a link into another repository is no clone, nor is a directory inside a bare one", async () => {
    const { clones, source, enclosing, shas } = borrowable("clones-linked");
    // A clone that is a link to an empty directory inside a repository that holds the commits.
    mkdirSync(join(enclosing, "empty"));
    symlinkSync(join(enclosing, "empty"), join(clones, "nm000460-7"));
    writeFileSync(join(clones, "nm000460-7.shas"), shas);
    // A clone that is a link to a directory inside a bare repository that holds the commits.
    const bare = join(root, "clones-linked-enclosing.git");
    enclosingRepository(source, bare, true);
    mkdirSync(join(bare, "inside"));
    symlinkSync(join(bare, "inside"), join(clones, "nm000460-13"));
    writeFileSync(join(clones, "nm000460-13.shas"), shas);
    expect(await errorsOf(clones, ["nm000460#7", "nm000460#13", "nm000460#2"])).toEqual([
      ["nm000460#7", "clone_missing"],
      ["nm000460#13", "clone_missing"],
      ["nm000460#2", null],
    ]);
  });

  test("a ':' in the clones path lets no clone borrow the repository above it", async () => {
    // A clones directory whose path holds a ':' (a list separator to git's variables), inside a
    // repository that holds the commits, with an empty `.git` for a clone.
    const { enclosing, shas } = borrowable("clones-colon");
    const colon = join(enclosing, "set:a-clones");
    mkdirSync(join(colon, "nm000460-6", ".git"), { recursive: true });
    writeFileSync(join(colon, "nm000460-6.shas"), shas);
    expect(await errorsOf(colon, ["nm000460#6"])).toEqual([["nm000460#6", "clone_missing"]]);
  });

  test("GIT_DIR lends no clone a repository: the run takes it away", async () => {
    // GIT_DIR naming the repository that holds the commits, and a clone that is an empty directory.
    const { clones, enclosing, shas } = borrowable("clones-git-dir");
    mkdirSync(join(clones, "nm000460-8"));
    writeFileSync(join(clones, "nm000460-8.shas"), shas);
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(enclosing, ".git");
    let rows: [string, string | null][];
    let after: string | undefined;
    try {
      rows = await errorsOf(clones, ["nm000460#8", "nm000460#2"]);
      after = process.env.GIT_DIR;
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "GIT_DIR");
      else process.env.GIT_DIR = saved;
    }
    expect(rows).toEqual([
      ["nm000460#8", "clone_missing"],
      ["nm000460#2", null],
    ]);
    expect(after).toBe(join(enclosing, ".git"));
  });

  test("a real clone reads however it is reached: relative, linked, a slash, a worktree, bare", async () => {
    const { clones, base, head } = frozenClones("clones-spelled", (b, h) => `${b} ${h}\n`);
    const source = join(root, "clones-spelled-source");
    const shas = `${base} ${head}\n`;
    // A linked worktree, whose `.git` is a file.
    git(
      join(clones, "nm000460-2"),
      "worktree",
      "add",
      "-q",
      "--detach",
      "--no-checkout",
      join(clones, "nm000460-9"),
      head,
    );
    expect(readFileSync(join(clones, "nm000460-9", ".git"), "utf8")).toStartWith("gitdir: ");
    writeFileSync(join(clones, "nm000460-9.shas"), shas);
    // A link to a real clone.
    symlinkSync(join(clones, "nm000460-2"), join(clones, "nm000460-10"));
    writeFileSync(join(clones, "nm000460-10.shas"), shas);
    // A bare clone.
    enclosingRepository(source, join(clones, "nm000460-11"), true);
    writeFileSync(join(clones, "nm000460-11.shas"), shas);
    // The ones that are not: an empty `.git` directory and a `.git` file that names nothing.
    mkdirSync(join(clones, "nm000460-12", ".git"), { recursive: true });
    writeFileSync(join(clones, "nm000460-12.shas"), shas);
    mkdirSync(join(clones, "nm000460-14"));
    writeFileSync(join(clones, "nm000460-14", ".git"), `gitdir: ${join(root, "no-such-gitdir")}\n`);
    writeFileSync(join(clones, "nm000460-14.shas"), shas);
    const prs = ["2", "9", "10", "11", "12", "14"].map((n) => `nm000460#${n}`);
    const expected: [string, string | null][] = [
      ["nm000460#2", null],
      ["nm000460#9", null],
      ["nm000460#10", null],
      ["nm000460#11", null],
      ["nm000460#12", "clone_missing"],
      ["nm000460#14", "clone_missing"],
    ];
    // The clones directory as it was made, relative to the working directory, through a link
    // (the temporary directory is itself behind one on macOS, `/var` and `/tmp` both), and with
    // a trailing slash.
    const linked = join(root, "clones-spelled-link");
    symlinkSync(root, linked);
    const spellings = [
      clones,
      relative(process.cwd(), clones),
      join(linked, "clones-spelled-clones"),
      `${clones}/`,
    ];
    expect(new Set(spellings).size).toBe(4);
    expect(realpathSync(spellings[2] as string)).toBe(realpathSync(clones));
    for (const spelled of spellings) {
      expect(await errorsOf(spelled, prs), spelled).toEqual(expected);
    }
  });

  test("pins need --clones, --offline needs --clones, and --pr names no commits", async () => {
    const pinned = join(root, "pinned-prs.txt");
    writeFileSync(pinned, `nm000460#2 ${"a".repeat(40)} ${"b".repeat(40)}\n`);
    const clones = mkdtempSync(join(root, "empty-clones-"));
    for (const [argv, words] of [
      [["--prs", pinned], "pinned commits is read from --clones"],
      [["--pr", "nm000460#2", "--offline"], "--offline reads only --clones"],
      [
        ["--pr", `nm000460#2 ${"a".repeat(40)} ${"b".repeat(40)}`, "--clones", clones],
        "--pr names no commits",
      ],
      [
        ["--pr", "nm000460#2", "--clones", join(root, "no-such-dir")],
        "--clones is not a directory",
      ],
    ] as const) {
      const r = await calibrate([...argv]);
      expect(r.code, words).toBe(2);
      expect(r.said, words).toContain(words);
      expect(r.said).not.toContain(root);
    }
  });

  /**
   * A blob-less clone of a pull request that changes only the sidecar, made the way the review job
   * makes one, from a bare origin over `file://`: the listing still reads `dataset_description.json`
   * at both ends, a blob the pull request does not change. With `headToo` false only the base is
   * fetched, so the head commit is in the origin and not in the clone.
   */
  function blobLessFrozen(name: string, headToo = true) {
    const src = join(root, `${name}-src`);
    mkdirSync(src, { recursive: true });
    git(src, "init", "-q", "-b", "main");
    write(
      src,
      "dataset_description.json",
      JSON.stringify({ Name: "Resting EEG", Version: "1.0.0" }),
    );
    write(src, "CHANGES", "1.0.0 2026-01-01\n - Initial release\n");
    write(src, "sub-01/eeg/sub-01_task-rest_eeg.json", JSON.stringify({ SamplingFrequency: 256 }));
    git(src, "add", "-A");
    git(src, "commit", "-q", "-m", "initial");
    const base = git(src, "rev-parse", "HEAD");
    git(src, "checkout", "-q", "-b", "contrib");
    write(src, "sub-01/eeg/sub-01_task-rest_eeg.json", JSON.stringify({ SamplingFrequency: 512 }));
    git(src, "commit", "-q", "-am", "fix");
    const head = git(src, "rev-parse", "HEAD");
    const bare = join(root, `${name}-origin.git`);
    execFileSync("git", ["clone", "-q", "--bare", src, bare], { env: GIT_ENV });
    git(bare, "config", "uploadpack.allowFilter", "true");
    git(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
    const clones = join(root, `${name}-clones`);
    const clone = join(clones, "nm000460-2");
    mkdirSync(clone, { recursive: true });
    git(clone, "init", "-q", "-b", "main");
    git(clone, "config", "extensions.partialClone", "origin");
    git(clone, "remote", "add", "origin", `file://${bare}`);
    git(
      clone,
      "fetch",
      "-q",
      "--no-tags",
      "--filter=blob:none",
      "origin",
      base,
      ...(headToo ? [head] : []),
    );
    writeFileSync(join(clones, "nm000460-2.shas"), `${base} ${head}\n`);
    writeFileSync(
      join(clones, "nm000460-2.pr.json"),
      JSON.stringify({ title: "Lee2019 EEG update", body: "b" }),
    );
    const blob = (rev: string, path: string) => git(src, "rev-parse", `${rev}:${path}`);
    return { clones, clone, bare, base, head, blob };
  }

  /** Whether the clone holds the object, asked so that asking cannot fetch it. */
  function holds(clone: string, oid: string): boolean {
    try {
      execFileSync("git", ["-C", clone, "cat-file", "-e", oid], {
        env: { ...GIT_ENV, GIT_NO_LAZY_FETCH: "1" },
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  }

  test("--offline never fetches: a clone missing a blob is objects_missing", async () => {
    // The variable as the shell running the tests has it, most often unset: every run must leave it
    // exactly so, and the test puts it back so whatever happens.
    const previous = process.env.GIT_NO_LAZY_FETCH;
    const putBack = () => {
      if (previous === undefined) Reflect.deleteProperty(process.env, "GIT_NO_LAZY_FETCH");
      else process.env.GIT_NO_LAZY_FETCH = previous;
    };
    const f = blobLessFrozen("offline");
    const sidecar = "sub-01/eeg/sub-01_task-rest_eeg.json";
    expect(holds(f.clone, f.blob(f.head, sidecar))).toBe(false);
    // Missing the blobs the content pass would fetch: refused before any pass, and nothing fetched.
    const first = await calibrate([
      "--pr",
      "nm000460#2",
      "--clones",
      f.clones,
      "--offline",
      "--json",
    ]);
    expect((JSON.parse(first.out) as CalibrationRow[])[0]?.error).toBe("objects_missing");
    expect(process.env.GIT_NO_LAZY_FETCH === previous).toBe(true);
    expect(holds(f.clone, f.blob(f.head, sidecar))).toBe(false);
    expect(holds(f.clone, f.blob(f.base, sidecar))).toBe(false);

    // Fetch what the prefetch would: the two sides of the sidecar, fetched lazily, which is allowed
    // here whatever the shell running the tests says. dataset_description.json, which the pull
    // request does not change, is still not in the clone, and the listing reads it.
    execFileSync("git", ["-C", f.clone, "diff", "--numstat", f.base, f.head], {
      env: { ...GIT_ENV, GIT_NO_LAZY_FETCH: "0" },
    });
    expect(holds(f.clone, f.blob(f.head, sidecar))).toBe(true);
    const description = f.blob(f.head, "dataset_description.json");
    expect(holds(f.clone, description)).toBe(false);
    let second: Awaited<ReturnType<typeof calibrate>>;
    let third: Awaited<ReturnType<typeof calibrate>>;
    let online: Awaited<ReturnType<typeof calibrate>>;
    try {
      // A value of the variable from before the run other than the run's own, which it must put back.
      process.env.GIT_NO_LAZY_FETCH = "0";
      second = await calibrate(["--pr", "nm000460#2", "--clones", f.clones, "--offline", "--json"]);
      expect(process.env.GIT_NO_LAZY_FETCH).toBe("0");
      putBack();
      third = await calibrate(["--pr", "nm000460#2", "--clones", f.clones, "--offline"]);
      expect(process.env.GIT_NO_LAZY_FETCH === previous).toBe(true);
      // Neither offline run fetched the description.
      expect(holds(f.clone, description)).toBe(false);
      // The control runs with fetching allowed, so a shell that turns it off does not decide it.
      process.env.GIT_NO_LAZY_FETCH = "0";
      online = await calibrate(["--pr", "nm000460#2", "--clones", f.clones, "--json"]);
    } finally {
      putBack();
    }
    // The evidence reader's own git could not fetch the description either: no read, no fetch.
    expect((JSON.parse(second.out) as CalibrationRow[])[0]?.error).toBe("evidence_unavailable");
    expect(third.code).toBe(1);

    // The control: without --offline the same clone fetches the description when the listing asks,
    // and the review goes on to the facts.
    expect((JSON.parse(online.out) as CalibrationRow[])[0]).toMatchObject({
      stage: "facts",
      error: null,
    });
    expect(holds(f.clone, description)).toBe(true);
    expect(requests).toHaveLength(0);
  });

  test("--clones without --offline never fetches a commit to check it: one the clone lacks is objects_missing", async () => {
    // The origin holds the head; the clone holds only the base, and would fetch the head lazily if
    // asked for it with fetching allowed. The variable is set to allow it, so only the check's own
    // environment can keep the fetch from happening.
    const f = blobLessFrozen("clones-no-fetch", false);
    git(f.bare, "cat-file", "-e", `${f.head}^{commit}`);
    expect(holds(f.clone, f.base)).toBe(true);
    expect(holds(f.clone, f.head)).toBe(false);
    const previous = process.env.GIT_NO_LAZY_FETCH;
    process.env.GIT_NO_LAZY_FETCH = "0";
    let r: Awaited<ReturnType<typeof calibrate>>;
    try {
      r = await calibrate([
        "--pr",
        "nm000460#2",
        "--clones",
        f.clones,
        "--evidence-only",
        "--json",
      ]);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "GIT_NO_LAZY_FETCH");
      else process.env.GIT_NO_LAZY_FETCH = previous;
    }
    expect((JSON.parse(r.out) as EvidenceRow[])[0]?.error).toBe("objects_missing");
    expect(holds(f.clone, f.head)).toBe(false);
  });

  test("--offline leaves GIT_NO_LAZY_FETCH as it found it when the temporary directory cannot be made", async () => {
    const clones = mkdtempSync(join(root, "no-tmpdir-clones-"));
    const saved = { lazy: process.env.GIT_NO_LAZY_FETCH, tmp: process.env.TMPDIR };
    // A value of the variable from before the run, other than the run's own `1`: git reads it as a
    // boolean, and refuses to start at all on a value that is not one.
    process.env.GIT_NO_LAZY_FETCH = "false";
    process.env.TMPDIR = join(root, "no-such-tmpdir");
    let outcome: string;
    let after: string | undefined;
    try {
      try {
        const r = await calibrate([
          "--pr",
          "nm000460#2",
          "--clones",
          clones,
          "--offline",
          "--evidence-only",
        ]);
        outcome = `exit ${r.code}`;
      } catch {
        outcome = "threw";
      }
      after = process.env.GIT_NO_LAZY_FETCH;
    } finally {
      if (saved.tmp === undefined) Reflect.deleteProperty(process.env, "TMPDIR");
      else process.env.TMPDIR = saved.tmp;
      if (saved.lazy === undefined) Reflect.deleteProperty(process.env, "GIT_NO_LAZY_FETCH");
      else process.env.GIT_NO_LAZY_FETCH = saved.lazy;
    }
    expect(outcome).toBe("threw");
    expect(after).toBe("false");
    expect(tmpdir()).not.toContain("no-such-tmpdir");
  });

  test("--clones needs git 2.45 or later, and refuses an older one without printing its version", async () => {
    expect(parseGitVersion("git version 2.39.5 (Apple Git-154)")).toEqual({
      major: 2,
      minor: 39,
      patch: 5,
    });
    expect(parseGitVersion("git version 2.45.0\n")).toEqual({ major: 2, minor: 45, patch: 0 });
    expect(parseGitVersion("git version 2.45.1.windows.1")).toEqual({
      major: 2,
      minor: 45,
      patch: 1,
    });
    expect(parseGitVersion("git version 2.46.0.rc1")).toEqual({ major: 2, minor: 46, patch: 0 });
    expect(parseGitVersion("git version 2.47.0-rc0")).toEqual({ major: 2, minor: 47, patch: 0 });
    expect(parseGitVersion("git version 2.48.1.dirty")).toEqual({ major: 2, minor: 48, patch: 1 });
    expect(parseGitVersion("git version 3.0")).toEqual({ major: 3, minor: 0, patch: 0 });
    for (const bad of ["", "git version", "version 2.45.0", "git version 2.45x", "hub 2.45.0"]) {
      expect(parseGitVersion(bad), bad).toBeNull();
    }
    const honors = (line: string) => {
      const v = parseGitVersion(line);
      return v !== null && honorsNoLazyFetch(v);
    };
    // 2.45.0 is the first release whose notes name the variable; the maintenance releases of
    // 2.44 are refused, on purpose.
    expect(honors("git version 2.39.5 (Apple Git-154)")).toBe(false);
    expect(honors("git version 2.43.7")).toBe(false);
    expect(honors("git version 2.44.0")).toBe(false);
    expect(honors("git version 2.44.1")).toBe(false);
    expect(honors("git version 2.45.0")).toBe(true);
    expect(honors("git version 2.50.1 (Apple Git-155)")).toBe(true);
    expect(honors("git version 2.46.0.rc1")).toBe(true);
    expect(honors("git version 2.48.1.dirty")).toBe(true);
    expect(honors("git version 2.56.0")).toBe(true);
    expect(honors("git version 3.0.0")).toBe(true);
    expect(honors("git version 1.99.0")).toBe(false);

    // A stand-in git first on PATH for each run: it says 2.44.1 when asked its version, and hands
    // every other call to the real git. --clones alone is refused, and with --offline too.
    const real = Bun.which("git");
    expect(real).not.toBeNull();
    const bin = join(root, "old-git-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'git version 2.44.1'; exit 0; fi\nexec '${real}' "$@"\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    const clones = mkdtempSync(join(root, "old-git-clones-"));
    for (const extra of [[], ["--evidence-only"], ["--offline", "--evidence-only"]]) {
      const saved = process.env.PATH;
      process.env.PATH = `${bin}:${saved ?? ""}`;
      let r: Awaited<ReturnType<typeof calibrate>>;
      try {
        r = await calibrate(["--pr", "nm000460#2", "--clones", clones, ...extra]);
      } finally {
        process.env.PATH = saved;
      }
      expect(r.code, extra.join(" ")).toBe(2);
      expect(r.said).toContain("--clones needs git 2.45 or later");
      expect(r.said).not.toContain("2.44");
      expect(r.said).not.toContain(root);
      expect(r.out).toBe("");
    }
  });
});

/**
 * A pull request made of `base` and one change of it, as a reader that hands it over: the commits
 * a frozen set would pin, and no text.
 */
function localChange(
  name: string,
  base: Record<string, string>,
  edit: (dir: string) => void,
): { dir: string; base: string; head: string; read: () => FetchedPullRequest } {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  write(dir, "dataset_description.json", JSON.stringify({ Name: "Resting EEG", Version: "1.0.0" }));
  write(dir, "CHANGES", "1.0.0 2026-01-01\n - Initial release\n");
  for (const [rel, text] of Object.entries(base)) write(dir, rel, text);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  const b = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", "contrib");
  write(dir, "dataset_description.json", JSON.stringify({ Name: "Resting EEG", Version: "1.1.0" }));
  write(dir, "CHANGES", "1.1.0 2026-10-16\n - Fixed\n1.0.0 2026-01-01\n - Initial release\n");
  edit(dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "change");
  const h = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "main");
  return { dir, base: b, head: h, read: () => ({ dir, base: b, head: h, pr: {} }) };
}

/** The channel table of subject `s`. */
const channels = (s: string) => `${s}/eeg/${s}_task-rest_channels.tsv`;

/** Run calibrateMain in evidence mode on one reader, with its JSON rows parsed. */
async function evidenceRows(
  read: () => FetchedPullRequest,
  extra: string[] = [],
): Promise<{ code: number; rows: EvidenceRow[] }> {
  const out: string[] = [];
  const code = await calibrateMain(
    ["--pr", "nm000460#2", "--evidence-only", "--json", ...extra],
    (l) => out.push(l),
    read,
  );
  return { code, rows: JSON.parse(out.join("\n")) as EvidenceRow[] };
}

describe("--evidence-only: the review's evidence passes, and no model", () => {
  const KEY = "sk-ant-SECRET-VALUE";

  /** Run `fn` with the SDK pointed at the stand-in, a gateway token set, and no key at all. */
  async function withRedirectsAndNoKey<T>(fn: () => Promise<T>): Promise<T> {
    const names = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"] as const;
    const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
    Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`;
    process.env.ANTHROPIC_AUTH_TOKEN = "oauth-SECRET-VALUE";
    try {
      return await fn();
    } finally {
      for (const k of names) {
        if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = saved[k];
      }
    }
  }

  test("--evidence-only needs no key, reads a local repository and prints closed words and numbers", async () => {
    const { clones } = frozenClones("eo-local", (b, h) => `${b} ${h}\n`);
    // An evidence run reads no text: the pull request's own file is not needed.
    rmSync(join(clones, "nm000460-2.pr.json"));
    const r = await withRedirectsAndNoKey(() =>
      calibrate(["--pr", "nm000460#2", "--clones", clones, "--evidence-only"]),
    );
    expect(r.code).toBe(0);
    expect(r.said).toBe("");
    expect(requests).toHaveLength(0);
    const lines = r.out.split("\n");
    expect(lines[0]).toMatch(
      /^PR +FILES +WANTED +COSMETIC +SUMMARIZED +REFUSED +ACCOUNTED +CLASSES +CUT +CHARS +PATCHES +READ +UNREAD +TRUNCATED +LOSS r\/c\/k +FINDINGS +REFUSED-DELETED s\/i\/h +SECONDS listing\|content$/,
    );
    // Three files changed and read: the description and the sidecar accounted for by the summary
    // in two classes, CHANGES shown, and both accounted files shown as illustrations too.
    expect(lines[1]).toMatch(
      /^nm000460#2 +3 +3 +0 +2 +0 +2 +2 +0 +\d+ +3 +3 +0 +no +0\/0\/0 +0 +0\/0\/0 +\d+\.\d\|\d+\.\d$/,
    );
    expect(r.out).toContain("1 pull request, 0 without evidence.");
    expect(r.out).toContain("0 truncated (0 list cut, 0 content not read in full)");
    expect(r.out).not.toContain(SECRET);
    expect(r.out).not.toContain(clones);
    expect(r.out).not.toContain("SECRET-VALUE");
  });

  test("the normal mode still refuses the redirect variables; --evidence-only refuses neither", async () => {
    const pr = localChange("eo-redirect", {}, () => {});
    const normal = await withRedirectsAndNoKey(async () => {
      const said: string[] = [];
      const quiet = console.error;
      console.error = (...a: unknown[]) => void said.push(a.map(String).join(" "));
      try {
        return { code: await calibrateMain(["--pr", "nm000460#2"], () => {}, pr.read), said };
      } finally {
        console.error = quiet;
      }
    });
    expect(normal.code).toBe(2);
    expect(normal.said.join("\n")).toContain("ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN are set");
    const evidence = await withRedirectsAndNoKey(() => evidenceRows(pr.read));
    expect(evidence.code).toBe(0);
    expect(evidence.rows[0]?.evidence?.files).toBe(2);
    expect(requests).toHaveLength(0);
  });

  test("in --evidence-only a pasted key, a flag value or a --clones path is never printed", async () => {
    const lines = join(root, "eo-secret-prs.txt");
    writeFileSync(lines, `nm000153#2\n${KEY}\n`);
    for (const argv of [
      ["--evidence-only", "--bogus", KEY],
      ["--evidence-only", `--${KEY}`],
      [`--evidence-only=${KEY}`, "--pr", "nm000153#2"],
      [`--without-summary=${KEY}`, "--evidence-only", "--pr", "nm000153#2"],
      ["--evidence-only", "--pr", KEY],
      ["--evidence-only", "--pr", "nm000153#2", "--clones", join(root, KEY)],
      ["--evidence-only", "--clones", KEY, "--pr", "nm000153#2"],
      ["--evidence-only", "--prs", lines],
      ["--evidence-only", "--prs", join(root, KEY)],
      ["--without-summary", "--pr", "nm000153#2", KEY],
    ]) {
      const r = await calibrate(argv);
      expect(r.code, JSON.stringify(argv)).toBe(2);
      expect(r.said + r.out, JSON.stringify(argv)).not.toContain(KEY);
    }
    // A run that succeeds from a directory named like a key does not print the name either.
    const { clones } = frozenClones(KEY, (b, h) => `${b} ${h}\n`);
    expect(clones).toContain(KEY);
    for (const extra of [[], ["--json"]]) {
      const r = await calibrate([
        "--pr",
        "nm000460#2",
        "--clones",
        clones,
        "--evidence-only",
        ...extra,
      ]);
      expect(r.code).toBe(0);
      expect(r.said + r.out).not.toContain(KEY);
    }
  });

  test("a callback token still refuses --evidence-only, before anything is read", async () => {
    let read = 0;
    process.env.PR_REVIEW_CALLBACK_TOKEN = "callback-SECRET-TOKEN";
    const said: string[] = [];
    const quiet = console.error;
    console.error = (...a: unknown[]) => void said.push(a.map(String).join(" "));
    let code: number;
    try {
      code = await calibrateMain(
        ["--pr", "nm000153#2", "--evidence-only"],
        () => {},
        () => {
          read++;
          throw new CalibrationReadError("gh_failed");
        },
      );
    } finally {
      console.error = quiet;
      Reflect.deleteProperty(process.env, "PR_REVIEW_CALLBACK_TOKEN");
    }
    expect(code).toBe(2);
    expect(said.join("\n")).toContain("callback token is set");
    expect(said.join("\n")).not.toContain("SECRET-TOKEN");
    expect(read).toBe(0);
  });

  test("--without-summary needs --evidence-only", async () => {
    const r = await calibrate(["--pr", "nm000153#2", "--without-summary"]);
    expect(r.code).toBe(2);
    expect(r.said).toContain("--without-summary is for --evidence-only");
  });

  test("a refused file with deleted lines is shown or incomplete; HIDDEN is exit 1", async () => {
    // Shown: a ragged row refuses the table, and its small diff, with the removed Cz row, is shown
    // in full. A refused table that deletes no line is not counted.
    const shown = localChange(
      "eo-refused-shown",
      {
        [channels("sub-01")]: "name\ttype\nCz\tEEG\nPz\tEEG\n",
        [channels("sub-02")]: "name\ttype\nCz\tEEG\n",
      },
      (dir) => {
        write(dir, channels("sub-01"), "name\ttype\nPz\tEEG\textra\n");
        write(dir, channels("sub-02"), "name\ttype\nCz\tEEG\nPz\tEEG\textra\n");
      },
    );
    const a = await evidenceRows(shown.read);
    expect(a.code).toBe(0);
    expect(a.rows[0]?.refusedBy).toEqual({ ragged_row: 2 });
    expect(a.rows[0]?.refusedDeleted).toEqual({ shown: 1, incomplete: 0, hidden: 0 });
    expect(a.rows[0]?.evidence?.readIncomplete).toBe(false);

    // Incomplete: a table with a NUL byte (git writes it as binary, with no line counts) and a
    // ragged table whose diff is cut at the per-file limit; neither is read, and the pull request
    // says its content was not read in full.
    const rows = Array.from({ length: 700 }, (_, i) => `E${i}\tEEG\textra`).join("\n");
    const incomplete = localChange(
      "eo-refused-incomplete",
      {
        [channels("sub-01")]: "name\ttype\nCz\tEEG\nPz\tE\0EG\n",
        [channels("sub-02")]: `name\ttype\nCz\tEEG\n${rows.replaceAll("\textra", "")}\n`,
      },
      (dir) => {
        write(dir, channels("sub-01"), "name\ttype\nPz\tE\0EG\n");
        write(dir, channels("sub-02"), `name\ttype\n${rows}\n`);
      },
    );
    const b = await evidenceRows(incomplete.read);
    expect(b.code).toBe(0);
    expect(b.rows[0]?.refusedBy).toEqual({ nul_byte: 1, ragged_row: 1 });
    expect(b.rows[0]?.refusedDeleted).toEqual({ shown: 0, incomplete: 2, hidden: 0 });
    expect(b.rows[0]?.evidence?.readIncomplete).toBe(true);
    expect(b.rows[0]?.evidence?.unread).toBe(2);

    // HIDDEN cannot be built from a real pass (that is the point); a pass's facts doctored to show
    // no diff and to claim everything read are what it would look like.
    const listing = gatherListing(shown.dir, shown.base, shown.head);
    const facts = { ...listing, ...gatherContent(shown.dir, listing) };
    expect(refusedDeletions(shown.dir, facts)).toEqual({ shown: 1, incomplete: 0, hidden: 0 });
    expect(
      refusedDeletions(shown.dir, { ...facts, patches: [], readIncomplete: false, unreadFiles: 0 }),
    ).toEqual({ shown: 0, incomplete: 0, hidden: 1 });
    const hidden: EvidenceRow = {
      ...(a.rows[0] as EvidenceRow),
      refusedDeleted: { shown: 0, incomplete: 0, hidden: 1 },
    };
    expect(evidenceExitCode([a.rows[0] as EvidenceRow])).toBe(0);
    expect(evidenceExitCode([a.rows[0] as EvidenceRow, hidden])).toBe(1);
    const table = renderEvidenceTable([hidden]).join("\n");
    expect(table).toContain("0/0/1 HIDDEN");
    expect(table).toContain("files shown 0, incomplete 0, HIDDEN 1");
  });

  test("a refused file is shown only when a diff not cut holds every line it deletes", () => {
    // Three refused tables (a ragged row each). The first two delete the same two rows and add the
    // same one, so the second's diff is folded onto the first's; the third deletes a row whose
    // first cell is `--`, which its diff prints as `---`.
    const pr = localChange(
      "rd-content",
      {
        [channels("sub-01")]: "name\ttype\nCz\tEEG\nPz\tEEG\n",
        [channels("sub-02")]: "name\ttype\nCz\tEEG\nPz\tEEG\n",
        [channels("sub-03")]: "name\ttype\n--\tEEG\nCz\tEEG\n",
      },
      (dir) => {
        write(dir, channels("sub-01"), "name\ttype\nPz\tEEG\textra\n");
        write(dir, channels("sub-02"), "name\ttype\nPz\tEEG\textra\n");
        write(dir, channels("sub-03"), "name\ttype\nCz\tEEG\textra\n");
      },
    );
    const listing = gatherListing(pr.dir, pr.base, pr.head);
    const facts = { ...listing, ...gatherContent(pr.dir, listing) };
    expect(facts.summary.files.filter((o) => o.refusal !== null).map((o) => o.path)).toEqual([
      channels("sub-01"),
      channels("sub-02"),
      channels("sub-03"),
    ]);
    expect(facts.patches.find((p) => p.path === channels("sub-01"))?.same).toEqual([
      channels("sub-02"),
    ]);
    expect(facts.patches.find((p) => p.path === channels("sub-03"))?.text).toContain(
      "\n---\tEEG\n",
    );
    expect(facts.readIncomplete).toBe(false);
    // The real pass: every deleted line is in a diff not cut, its own or the one it is folded onto.
    expect(refusedDeletions(pr.dir, facts)).toEqual({ shown: 3, incomplete: 0, hidden: 0 });

    // The same facts, with one diff's text replaced. A diff that is only git's line for a binary
    // file shows no deleted line, so its file is not shown although its patch is not cut: HIDDEN
    // when the content is called complete (exit 1), incomplete when it is not.
    const third = channels("sub-03");
    const withText = (path: string, text: string) =>
      facts.patches.map((p) => (p.path === path ? { ...p, text } : p));
    const binary = withText(
      third,
      `diff --git a/${third} b/${third}\nBinary files a/${third} and b/${third} differ\n`,
    );
    const hidden = refusedDeletions(pr.dir, { ...facts, patches: binary });
    expect(hidden).toEqual({ shown: 2, incomplete: 0, hidden: 1 });
    const row: EvidenceRow = {
      pr: "nm000460#2",
      error: null,
      evidence: null,
      refusedBy: null,
      classes: null,
      refusedDeleted: hidden,
      timings: null,
    };
    expect(evidenceExitCode([row])).toBe(1);
    expect(
      refusedDeletions(pr.dir, { ...facts, patches: binary, readIncomplete: true, unreadFiles: 1 }),
    ).toEqual({ shown: 2, incomplete: 1, hidden: 0 });

    // A diff that holds one deleted line fewer than git counts: the file it stands for, and the one
    // folded onto it, are not shown.
    const first = facts.patches.find((p) => p.path === channels("sub-01"));
    const lines = (first?.text ?? "").split("\n");
    const cz = lines.indexOf("-Cz\tEEG");
    expect(cz).toBeGreaterThan(lines.findIndex((l) => l.startsWith("@@")));
    const short = withText(channels("sub-01"), lines.filter((_, i) => i !== cz).join("\n"));
    expect(refusedDeletions(pr.dir, { ...facts, patches: short })).toEqual({
      shown: 1,
      incomplete: 0,
      hidden: 2,
    });

    // A binary file (git counts its deleted lines as `-`) is never shown, whatever text a diff that
    // claims to stand for it holds: git prints no line of it.
    const nul = localChange(
      "rd-binary",
      { [channels("sub-01")]: "name\ttype\nCz\tEEG\nPz\tE\0EG\n" },
      (dir) => write(dir, channels("sub-01"), "name\ttype\nPz\tE\0EG\n"),
    );
    const nulListing = gatherListing(nul.dir, nul.base, nul.head);
    const nulFacts = { ...nulListing, ...gatherContent(nul.dir, nulListing) };
    expect(refusedDeletions(nul.dir, nulFacts)).toEqual({ shown: 0, incomplete: 1, hidden: 0 });
    const table = channels("sub-01");
    const claimed = {
      path: table,
      text: `diff --git a/${table} b/${table}\n--- a/${table}\n+++ b/${table}\n@@ -1,3 +1,2 @@\n name\ttype\n-Cz\tEEG\n Pz\tE\0EG\n`,
      truncated: false,
      same: [],
    };
    expect(
      refusedDeletions(nul.dir, {
        ...nulFacts,
        patches: [...nulFacts.patches, claimed],
        readIncomplete: false,
        unreadFiles: 0,
      }),
    ).toEqual({ shown: 0, incomplete: 0, hidden: 1 });
  });

  test("the refused paths are counted in chunks, and every chunk counts", () => {
    // Six refused tables, each deleting rows of its own: six diffs, each shown in full.
    const tables = Array.from({ length: 6 }, (_, i) => channels(`sub-0${i + 1}`));
    const pr = localChange(
      "rd-chunks",
      Object.fromEntries(tables.map((t, i) => [t, `name\ttype\nC${i}\tEEG\nP${i}\tEEG\n`])),
      (dir) => {
        for (const [i, t] of tables.entries()) write(dir, t, `name\ttype\nP${i}\tEEG\textra\n`);
      },
    );
    const listing = gatherListing(pr.dir, pr.base, pr.head);
    const facts = { ...listing, ...gatherContent(pr.dir, listing) };
    expect(facts.summary.files.filter((o) => o.refusal !== null)).toHaveLength(6);
    // Each path is 40 bytes and a separator: two to a chunk of 100 bytes, so three calls.
    expect(tables.every((t) => t.length === 40)).toBe(true);
    const log = join(root, "rd-chunks-numstat.log");
    const restore = installGitShim(root, [{ match: " --numstat -z ", log }]);
    let chunked: ReturnType<typeof refusedDeletions>;
    let whole: ReturnType<typeof refusedDeletions>;
    let calls: string[];
    try {
      chunked = refusedDeletions(pr.dir, facts, 100);
      calls = readFileSync(log, "utf8").trim().split("\n");
      whole = refusedDeletions(pr.dir, facts);
    } finally {
      restore();
    }
    expect(chunked).toEqual({ shown: 6, incomplete: 0, hidden: 0 });
    expect(whole).toEqual(chunked);
    expect(calls).toHaveLength(3);
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(4);
  });

  /**
   * A seeded table of `rows` short rows over `kinds` values, and a head that deletes, replaces or
   * inserts after each row (a third each) and ends with a ragged row, so the summary refuses it.
   * Deterministic: the same seed is the same bytes.
   */
  function seededEdit(seed: number, rows: number, kinds: number): { base: string; head: string } {
    let state = seed >>> 0;
    const next = (n: number): number => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return (state >>> 8) % n;
    };
    const base = ["n\tt"];
    for (let i = 0; i < rows; i++) base.push(`${next(kinds)}\tx`);
    const head = ["n\tt"];
    for (const line of base.slice(1)) {
      const r = next(3);
      if (r === 0) continue;
      if (r === 1) {
        head.push(`${next(kinds)}\tx`);
        continue;
      }
      head.push(line, `${next(kinds)}\tx`);
    }
    head.push("X\tx\textra");
    return { base: `${base.join("\n")}\n`, head: `${head.join("\n")}\n` };
  }

  /** How many lines a diff's text deletes: its `-` lines after its first `@@` line. */
  const deletedIn = (text: string): number => {
    const lines = text.split("\n");
    return lines
      .slice(lines.findIndex((l) => l.startsWith("@@")) + 1)
      .filter((l) => l.startsWith("-")).length;
  };

  test("every git of a run reads one configuration: an operator's diff.algorithm hides nothing", async () => {
    const table = channels("sub-01");
    const { base, head } = seededEdit(2, 800, 4);
    const pr = localChange("rd-histogram", { [table]: base }, (dir) => write(dir, table, head));
    const histogram = join(root, "histogram.gitconfig");
    writeFileSync(histogram, "[diff]\n\talgorithm = histogram\n");
    // Not vacuous: git's default algorithm counts more deleted lines than the reader's own diff
    // holds when the reader reads the operator's histogram configuration, and that diff is shown
    // in full; counted apart from the run, with the reader called directly.
    const numstat = git(pr.dir, "diff", "--numstat", pr.base, pr.head, "--", table).split("\t");
    const counted = Number(numstat[1]);
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = histogram;
    let readerPatch: { text: string; truncated: boolean } | undefined;
    let refusal: string | null | undefined;
    try {
      const listing = gatherListing(pr.dir, pr.base, pr.head);
      const facts = { ...listing, ...gatherContent(pr.dir, listing) };
      readerPatch = facts.patches.find((p) => p.path === table);
      refusal = facts.summary.files.find((o) => o.path === table)?.refusal;
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "GIT_CONFIG_GLOBAL");
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
    expect(refusal).toBe("ragged_row");
    expect(readerPatch?.truncated).toBe(false);
    expect(deletedIn(readerPatch?.text ?? "")).toBeLessThan(counted);

    // The run, with the operator's configuration set: every git it starts reads the same one, so
    // the table's diff holds every line git counts deleted, and it is shown.
    const before = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = histogram;
    let r: Awaited<ReturnType<typeof evidenceRows>>;
    let after: string | undefined;
    try {
      r = await evidenceRows(pr.read);
      after = process.env.GIT_CONFIG_GLOBAL;
    } finally {
      if (before === undefined) Reflect.deleteProperty(process.env, "GIT_CONFIG_GLOBAL");
      else process.env.GIT_CONFIG_GLOBAL = before;
    }
    expect(r.rows[0]?.refusedBy).toEqual({ ragged_row: 1 });
    expect(r.rows[0]?.refusedDeleted).toEqual({ shown: 1, incomplete: 0, hidden: 0 });
    expect(r.code).toBe(0);
    expect(after).toBe(histogram);
  });

  test("a run's git environment is put back exactly, set or unset, even when the run throws", async () => {
    const names = [
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_NO_LAZY_FETCH",
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_COMMON_DIR",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ] as const;
    // Values git accepts, none of them what a run sets: a boolean that is false, a path that is not
    // /dev/null, and repository paths no git of the run may read.
    const set: Record<(typeof names)[number], string> = {
      GIT_CONFIG_GLOBAL: join(root, "operator.gitconfig"),
      GIT_CONFIG_NOSYSTEM: "0",
      GIT_NO_LAZY_FETCH: "false",
      GIT_DIR: join(root, "elsewhere.git"),
      GIT_WORK_TREE: join(root, "elsewhere"),
      GIT_COMMON_DIR: join(root, "elsewhere.git"),
      GIT_OBJECT_DIRECTORY: join(root, "elsewhere.git", "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(root, "other.git", "objects"),
    };
    const outer = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    const snapshot = () => Object.fromEntries(names.map((n) => [n, process.env[n]]));
    const during = {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_LAZY_FETCH: "1",
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_COMMON_DIR: undefined,
      GIT_OBJECT_DIRECTORY: undefined,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    };
    const { clones } = frozenClones("env-restore", (b, h) => `${b} ${h}\n`);
    try {
      // Every variable set before, then every variable unset before.
      for (const state of ["set", "unset"] as const) {
        for (const n of names) {
          if (state === "set") process.env[n] = set[n];
          else Reflect.deleteProperty(process.env, n);
        }
        const expected = snapshot();
        // The helper alone.
        const restore = scopeRunEnvironment(true);
        expect(snapshot()).toEqual(during);
        restore();
        expect(snapshot()).toEqual(expected);
        const online = scopeRunEnvironment(false);
        expect(snapshot()).toEqual({ ...during, GIT_NO_LAZY_FETCH: expected.GIT_NO_LAZY_FETCH });
        online();
        expect(snapshot()).toEqual(expected);
        // A run that throws once it has read the pull request: what it printed is handed to an
        // output that throws, and the run's environment is the scoped one until then.
        const seen: Record<string, string | undefined>[] = [];
        const run = calibrateMain(
          ["--pr", "nm000460#2", "--clones", clones, "--offline", "--evidence-only", "--json"],
          () => {
            seen.push(snapshot());
            throw new Error("output refused");
          },
        );
        await expect(run).rejects.toThrow("output refused");
        expect(seen).toEqual([during]);
        expect(snapshot()).toEqual(expected);
      }
    } finally {
      for (const n of names) {
        if (outer[n] === undefined) Reflect.deleteProperty(process.env, n);
        else process.env[n] = outer[n];
      }
    }
  });

  test("no path or value reaches the table or the JSON", async () => {
    const SUB = "sub-SECRETSUBJECT";
    const table = `${SUB}/eeg/${SUB}_task-SECRETTASK_channels.tsv`;
    const sidecar = `${SUB}/eeg/${SUB}_task-SECRETTASK_eeg.json`;
    const pr = localChange(
      "eo-no-text",
      {
        [table]: "name\ttype\nSECRETROW\tSECRETTYPE\nPz\tEEG\n",
        [sidecar]: JSON.stringify({ SECRETKEY: "SECRETVALUE", TaskName: "SECRETTASK" }),
        [channels("sub-02")]: "name\ttype\nSECRETRAGGED\tEEG\n",
      },
      (dir) => {
        write(dir, table, "name\ttype\nPOL SECRETROW\tSECRETTYPE\nPz\tSECRETNEW\n");
        write(dir, sidecar, JSON.stringify({ TaskName: "SECRETTASK2" }));
        write(dir, channels("sub-02"), "name\ttype\nSECRETRAGGED\tEEG\textra\n");
      },
    );
    const out: string[] = [];
    for (const extra of [[], ["--json"]]) {
      await calibrateMain(
        ["--pr", "nm000460#2", "--evidence-only", ...extra],
        (l) => out.push(l),
        pr.read,
      );
    }
    const text = out.join("\n");
    expect(text).not.toContain("SECRET");
    // And every string in the rows is the pull request's name, a closed word, or a key.
    const { rows } = await evidenceRows(pr.read);
    const allowed = new Set<string>(["nm000460#2", ...CLASS_KINDS, ...SUMMARY_REFUSALS]);
    const strings: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(rows);
    expect(strings.filter((s) => !allowed.has(s))).toEqual([]);
    expect(Object.keys(rows[0]?.refusedBy ?? {})).toEqual(["ragged_row"]);
    expect(rows[0]?.classes?.length).toBeGreaterThan(0);
    expect(rows[0]?.evidence?.rowsRemoved).toBe(0);
    expect(rows[0]?.evidence?.keysRemoved).toBe(1);
  });

  test("--without-summary reads as the raw path alone", async () => {
    // 45 tables whose names gain a prefix, each with its own names, so no two diffs are alike: the
    // summary accounts for all of them, while the raw path shows at most 40 diffs.
    const base: Record<string, string> = {};
    const edits: Record<string, string> = {};
    for (let s = 1; s <= 45; s++) {
      const id = `sub-${String(s).padStart(2, "0")}`;
      const names = ["Fp1", "Fp2", "Cz"].map((n) => `${n}${id}`);
      base[channels(id)] = `name\ttype\n${names.map((n) => `${n}\tEEG`).join("\n")}\n`;
      edits[channels(id)] = `name\ttype\n${names.map((n) => `POL ${n}\tEEG`).join("\n")}\n`;
    }
    const pr = localChange("eo-without-summary", base, (dir) => {
      for (const [rel, text] of Object.entries(edits)) write(dir, rel, text);
    });
    const without = (await evidenceRows(pr.read, ["--without-summary"])).rows[0] as EvidenceRow;
    expect(without.evidence).toMatchObject({
      files: 47,
      summaryAbandoned: true,
      summarized: 0,
      accounted: 0,
      classes: 0,
      patches: 40,
      // The description, CHANGES and 38 tables are shown; seven tables are not.
      unread: 7,
      readIncomplete: true,
      truncated: true,
    });
    expect(without.classes).toEqual([]);
    // The same as the content pass gives with a clock that has run out, the raw path alone.
    const listing = gatherListing(pr.dir, pr.base, pr.head);
    const raw = gatherContent(pr.dir, listing, { now: () => Number.POSITIVE_INFINITY });
    expect(raw.summary.abandoned).toBe(true);
    expect([without.evidence?.unread, without.evidence?.patches]).toEqual([
      raw.unreadFiles,
      raw.patches.length,
    ]);
    // The control: with the summary every table is accounted for and nothing is unread.
    const withSummary = (await evidenceRows(pr.read)).rows[0] as EvidenceRow;
    expect(withSummary.evidence).toMatchObject({
      summaryAbandoned: false,
      summarized: 46,
      accounted: 46,
      unread: 0,
      readIncomplete: false,
    });
    expect(
      withSummary.classes?.map((c) => `${c.kind} ${c.items}/${c.files} ${c.complete}`).sort(),
    ).toEqual(["json_value_changed 1/1 true", "key_relabeled 135/45 true"]);
  });

  test("the normal mode prints the evidence columns in a second table", async () => {
    const row = await withStandIn(() =>
      calibrateOne(target("pass"), root, localPullRequest("eo-normal")),
    );
    expect(row.verdict).toBe("pass");
    expect(row.evidence).toMatchObject({ files: 3, wanted: 3, summarized: 2, accounted: 2 });
    const evidence = renderEvidenceTable([evidenceRowOf(row)]);
    expect(evidence[1]).toMatch(
      /^nm000460#2 +3 +3 +0 +2 +0 +2 +2 +0 +\d+ +3 +3 +0 +no +0\/0\/0 +0 +- +\d+\.\d\|\d+\.\d$/,
    );
    expect(evidence.join("\n")).toContain("Removals in refused files: not counted in this mode.");
    // The review's own table is unchanged, and the evidence table follows it.
    const out: string[] = [];
    const code = await calibrateMain(
      ["--pr", "nm000153#2"],
      (l) => out.push(l),
      () => {
        throw new CalibrationReadError("gh_failed");
      },
    );
    expect(code).toBe(1);
    expect(out[0]).toMatch(
      /^PR +FILES +FACTS +SCREEN +REVIEW \(lost rev better text honest\) +STEERING +VERDICT +CHECK +TOKENS/,
    );
    expect(out[1]).toMatch(/^nm000153#2 +- +none +- +- +- +no verdict \(gh_failed\)/);
    const evidenceHeader = out.findIndex((l) => l.startsWith("PR") && l.includes("SUMMARIZED"));
    const reviewNote = out.findIndex((l) => l.startsWith("Review columns, after the facts:"));
    expect(reviewNote).toBeGreaterThan(0);
    expect(evidenceHeader).toBe(reviewNote + 2);
    expect(out[evidenceHeader + 1]).toMatch(/^nm000153#2 +no evidence \(gh_failed\)$/);
  });
});

describe("the frozen set A and the label template", () => {
  const fixture = (name: string) =>
    readFileSync(join(import.meta.dir, "fixtures", "pr-review-canary", name), "utf8");
  const entriesOf = (text: string) =>
    text.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));

  test("the canary manifest is 86 distinct pinned pull requests", async () => {
    const manifest = fixture("set-a.txt");
    const entries = entriesOf(manifest);
    expect(entries).toHaveLength(86);
    // A dataset id, a number and two commit ids, and nothing else: no title, no login, no address.
    for (const line of entries) {
      expect(line).toMatch(/^(?:nm|on)\d{6}#\d+ [0-9a-f]{40} [0-9a-f]{40}$/);
      const t = parseTarget(line);
      expect(t?.pin).toBeDefined();
      expect(t?.expected).toBeNull();
    }
    expect(manifest).not.toContain("@");
    expect(new Set(entries.map((l) => l.split(" ")[0])).size).toBe(86);
    // One dataset has three open pull requests, told apart by their numbers.
    expect(entries.filter((l) => l.startsWith("nm000501#"))).toHaveLength(3);
    // calibrate reads it whole: from an empty directory of clones, each line is clone_missing.
    const clones = mkdtempSync(join(root, "no-clones-"));
    const r = await calibrate([
      "--prs",
      join(import.meta.dir, "fixtures", "pr-review-canary", "set-a.txt"),
      "--clones",
      clones,
      "--offline",
      "--evidence-only",
      "--json",
    ]);
    expect(r.code).toBe(1);
    const rows = JSON.parse(r.out) as EvidenceRow[];
    expect(rows).toHaveLength(86);
    expect(new Set(rows.map((x) => x.error))).toEqual(new Set(["clone_missing"]));
  });

  test("the label template parses only once every ? is replaced", async () => {
    const full = fixture("model-labels.template.txt");
    // Its entries: 40 distinct pull requests of set A, each unlabeled and at the commits set A pins.
    const templateEntries = entriesOf(full);
    expect(templateEntries).toHaveLength(40);
    const setA = new Map(
      entriesOf(fixture("set-a.txt")).map((l) => {
        const [ref, base, head] = l.split(" ");
        return [ref, `${base} ${head}`];
      }),
    );
    for (const l of templateEntries) {
      const [ref, mark, ...commits] = l.split(" ");
      expect(mark).toBe("?");
      expect(setA.get(ref)).toBe(commits.join(" "));
    }
    expect(new Set(templateEntries.map((l) => l.split(" ")[0])).size).toBe(40);
    expect(full).not.toContain("@");
    // The header is everything before its first entry; the cases below put their own entries after it.
    const template = full.slice(0, full.indexOf(templateEntries[0] as string));
    const pinned = entriesOf(fixture("set-a.txt")).slice(0, 3);
    const unlabeled = pinned.map((l) => {
      const [ref, base, head] = l.split(" ");
      return `${ref} ? ${base} ${head}`;
    });
    const clones = mkdtempSync(join(root, "label-clones-"));
    const file = join(root, "labels.txt");
    const runWith = async (entries: string[]) => {
      writeFileSync(file, `${template}\n# a group\n${entries.join("\n")}\n`);
      return calibrate(["--prs", file, "--clones", clones, "--offline", "--json"]);
    };
    const headerLines = template.split("\n").length;
    // Nothing labeled: refused at the first entry, by its line number, and nothing is read.
    const none = await runWith(unlabeled);
    expect(none.code).toBe(2);
    expect(none.said).toContain(
      `line ${headerLines + 2} of the pull request file is not labeled yet`,
    );
    expect(none.out).toBe("");
    for (const l of pinned) expect(none.said).not.toContain(l.split(" ")[1] as string);
    // One labeled, two not: still refused, at the first one that is not.
    const labeled = unlabeled.map((l) => l.replace(" ? ", " pass "));
    const some = await runWith([labeled[0] as string, ...unlabeled.slice(1)]);
    expect(some.code).toBe(2);
    expect(some.said).toContain(
      `line ${headerLines + 3} of the pull request file is not labeled yet`,
    );
    // Every one labeled: the file parses, and each pull request is read (here, from no clone).
    const all = await runWith([
      labeled[0] as string,
      unlabeled[1]?.replace(" ? ", " fail ") as string,
      unlabeled[2]?.replace(" ? ", " uncertain ") as string,
    ]);
    expect(all.code).toBe(1);
    const rows = JSON.parse(all.out) as CalibrationRow[];
    expect(rows.map((x) => [x.expected, x.error])).toEqual([
      ["pass", "clone_missing"],
      ["fail", "clone_missing"],
      ["uncertain", "clone_missing"],
    ]);
    // The template itself, as committed, is refused at its first entry; with every ? replaced it is
    // 40 pull requests, each read from its clone (here, none).
    const asCommitted = join(root, "template-as-committed.txt");
    writeFileSync(asCommitted, full);
    const refused = await calibrate(["--prs", asCommitted, "--clones", clones, "--offline"]);
    expect(refused.code).toBe(2);
    expect(refused.said).toContain(
      `line ${headerLines} of the pull request file is not labeled yet`,
    );
    const labeledAll = join(root, "template-labeled.txt");
    writeFileSync(labeledAll, full.replaceAll(" ? ", " pass "));
    const everyOne = await calibrate([
      "--prs",
      labeledAll,
      "--clones",
      clones,
      "--offline",
      "--json",
    ]);
    expect(everyOne.code).toBe(1);
    expect(JSON.parse(everyOne.out) as CalibrationRow[]).toHaveLength(40);
    expect(requests).toHaveLength(0);
  });

  test("the label template's blocking group is exactly the set A pull requests with a platform finding", () => {
    // A group is a block of the template between blank lines that holds entries; its heading is the
    // block's first comment line.
    const groups = fixture("model-labels.template.txt")
      .split(/\n[ \t]*\n/)
      .map((block) => ({
        heading: block.trimStart().split("\n")[0] as string,
        prs: entriesOf(block).map((l) => l.split(" ")[0] as string),
      }))
      .filter((g) => g.prs.length > 0);
    expect(groups.map((g) => g.prs.length)).toEqual([10, 18, 10, 2]);
    const blocking = groups[1];
    expect(blocking?.heading.startsWith("# A blocking loss")).toBe(true);
    const rows = JSON.parse(fixture("set-a-evidence.json")) as EvidenceRow[];
    const withFinding = rows
      .filter((r) => (r.evidence?.platformFindings ?? 0) > 0)
      .map((r) => r.pr)
      .sort();
    expect([...(blocking?.prs ?? [])].sort()).toEqual(withFinding);
  });

  test("the set A baseline holds only pull request names, closed words, numbers and booleans", () => {
    const text = fixture("set-a-evidence.json");
    expect(text).not.toContain("@");
    const rows = JSON.parse(text) as EvidenceRow[];
    // The same 86 pull requests as the manifest, in its order, without the passes' times.
    expect(rows.map((r) => r.pr)).toEqual(
      entriesOf(fixture("set-a.txt")).map((l) => l.split(" ")[0]),
    );
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual([
        "classes",
        "error",
        "evidence",
        "pr",
        "refusedBy",
        "refusedDeleted",
      ]);
      expect(r.error).toBeNull();
      for (const v of Object.values(r.evidence ?? {})) {
        expect(["number", "boolean"]).toContain(typeof v);
      }
      for (const word of Object.keys(r.refusedBy ?? {})) {
        expect(SUMMARY_REFUSALS as readonly string[]).toContain(word);
      }
      for (const c of r.classes ?? []) {
        expect(Object.keys(c).sort()).toEqual(["complete", "files", "items", "kind"]);
        expect(CLASS_KINDS as readonly string[]).toContain(c.kind);
      }
      expect(Object.keys(r.refusedDeleted ?? {}).sort()).toEqual(["hidden", "incomplete", "shown"]);
    }
  });

  test("the set A baseline adds up to the numbers design section 12.4 records", () => {
    const rows = JSON.parse(fixture("set-a-evidence.json")) as EvidenceRow[];
    const e = rows.map((r) => r.evidence as NonNullable<EvidenceRow["evidence"]>);
    const total = (f: (x: (typeof e)[number]) => number) => e.reduce((n, x) => n + f(x), 0);
    const count = (f: (x: (typeof e)[number]) => boolean) => e.filter(f).length;
    expect(total((x) => x.files)).toBe(9208);
    expect(total((x) => x.wanted)).toBe(7356);
    expect(total((x) => x.summarized)).toBe(5514);
    expect(total((x) => x.refused)).toBe(393);
    expect(total((x) => x.accounted)).toBe(5482);
    expect(count((x) => x.truncated)).toBe(15);
    expect(count((x) => x.listCut)).toBe(7);
    expect(count((x) => x.readIncomplete)).toBe(9);
    expect(count((x) => x.summaryAbandoned)).toBe(0);
    expect(count((x) => x.platformFindings > 0)).toBe(18);
    expect(count((x) => x.cut > 0)).toBe(0);
    const refusedBy: Record<string, number> = {};
    for (const r of rows) {
      for (const [word, n] of Object.entries(r.refusedBy ?? {})) {
        refusedBy[word] = (refusedBy[word] ?? 0) + (n ?? 0);
      }
    }
    expect(refusedBy).toEqual({ invalid_utf8: 391, ragged_row: 1, empty_column_name: 1 });
    const deleted = rows.map((r) => r.refusedDeleted as NonNullable<EvidenceRow["refusedDeleted"]>);
    expect(deleted.reduce((n, d) => n + d.shown, 0)).toBe(45);
    expect(deleted.reduce((n, d) => n + d.incomplete, 0)).toBe(348);
    expect(deleted.reduce((n, d) => n + d.hidden, 0)).toBe(0);
  });

  // The frozen clones are not in the repository (a git pack holds committer addresses); a machine
  // that made them has them, by default under ~/.local/share/nemar-canary/set-a, and then the real
  // code is run on them and must give the baseline back, numbers and closed words alike. Any change
  // to a rule that moves one of the 86 pull requests turns this red, and is then a decision to
  // re-record the baseline, not a drift.
  const clonesOfSetA =
    process.env.PR_REVIEW_SET_A_CLONES ??
    join(homedir(), ".local", "share", "nemar-canary", "set-a");
  test.skipIf(!existsSync(join(clonesOfSetA, "targets.txt")))(
    "the real code on the frozen clones gives the baseline back, timings aside",
    async () => {
      const r = await calibrate([
        "--evidence-only",
        "--offline",
        "--clones",
        clonesOfSetA,
        "--prs",
        join(import.meta.dir, "fixtures", "pr-review-canary", "set-a.txt"),
        "--json",
      ]);
      expect(r.code).toBe(0);
      const rows = (JSON.parse(r.out) as EvidenceRow[]).map(
        ({ timings: _timings, ...rest }) => rest,
      );
      expect(rows).toEqual(JSON.parse(fixture("set-a-evidence.json")));
    },
    300_000,
  );
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
