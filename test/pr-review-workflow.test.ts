/**
 * The central pull-request review workflow (ADR 0092): the properties its security rests on,
 * pinned so a later "simplification" cannot remove one without a test saying which.
 *
 * The workflow is authored in this repository and deployed by copying it whole into
 * `nemarDatasets/.github` (the same arrangement and the same drift risk as the onboarding
 * workflow, see `test/dataset-workflow-parity.test.ts`). The parity check at the bottom compares
 * the two byte for byte. The `unit-pure` job checks out the deployed copy and sets
 * NEMAR_PR_REVIEW_WORKFLOW_LIVE to it, which turns a missing copy into a failure. Without the
 * variable (a developer machine) it looks for a sibling checkout of `nemarDatasets/.github` and
 * SKIPS VISIBLY when there is none, so the check is enforced in CI and optional locally.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parse } from "yaml";
import { PR_REVIEW_DEADLINE_MINUTES } from "../backend/src/services/pr-review";
import {
  CALLBACK_ATTEMPTS,
  CALLBACK_ORIGINS,
  CALLBACK_TIMEOUT_MS,
  DEADLINE_GRACE_MS,
  REVIEW_MAX_TOKENS,
  STAGE_BUDGETS,
  callbackBackoffMs,
} from "../scripts/ci/pr-review";
import { EVIDENCE_BUDGET_MS } from "../scripts/ci/pr-review-evidence";
import { isRunError, parseCallbackOutcome } from "../shared/pr-review";

const REPO_ROOT = join(import.meta.dir, "..");
const LOCAL = join(REPO_ROOT, ".github", "dataset-workflows", "run-pr-review.yml");
const SRC = readFileSync(LOCAL, "utf8");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  id?: string;
  "working-directory"?: string;
}
interface Workflow {
  name: string;
  on: { repository_dispatch?: { types: string[] }; [k: string]: unknown };
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: {
    review: {
      permissions: Record<string, string>;
      env: Record<string, string>;
      "timeout-minutes": number;
      steps: Step[];
    };
  };
}

const wf = parse(SRC) as Workflow;
const job = wf.jobs.review;
const step = (name: string): Step => {
  const s = job.steps.find((x) => x.name === name);
  if (!s) throw new Error(`no step named "${name}"`);
  return s;
};

/**
 * Whether a step is handed the dataset token, which is the output of the mint step. Any mention of
 * the mint step's id counts, so `steps['app-token'].outputs.token` is caught as well as the dotted
 * form; the mint step itself produces the token and does not hold it.
 */
const holdsDatasetToken = (s: Step): boolean =>
  s.id !== "app-token" && JSON.stringify(s).includes("app-token");

/** The reporter script the validate step writes, as it will exist on the runner. */
const REPORTER = (() => {
  const run = (job.steps.find((x) => x.name === "Validate the dispatch")?.run ?? "").split("\n");
  const from = run.findIndex((l) => l.includes("<<'REPORTER'"));
  const to = run.findIndex((l, i) => i > from && l.trim() === "REPORTER");
  if (from < 0 || to < 0) throw new Error("the validate step does not write the reporter");
  return run.slice(from + 1, to).join("\n");
})();

describe("what triggers it", () => {
  test("only a repository_dispatch of run-pr-review, never a pull request or a manual run", () => {
    expect(Object.keys(wf.on)).toEqual(["repository_dispatch"]);
    expect(wf.on.repository_dispatch?.types).toEqual(["run-pr-review"]);
  });

  test("the event type matches what the Worker dispatches", () => {
    const dispatch = readFileSync(
      join(REPO_ROOT, "backend", "src", "services", "github", "dispatch.ts"),
      "utf8",
    );
    expect(dispatch).toContain('event_type: "run-pr-review"');
  });

  test("each workflow execution has its own concurrency group", () => {
    // GitHub replaces the pending run in a group. Never group on the untrusted repository_dispatch
    // payload, or a forged event can replace a legitimate pending review.
    expect(wf.concurrency.group).toContain("github.run_id");
    expect(wf.concurrency.group).toContain("github.run_attempt");
    expect(wf.concurrency.group).not.toContain("client_payload");
    expect(wf.concurrency["cancel-in-progress"]).toBe(false);
  });

  test("the callback routes it calls exist on the Worker", () => {
    const routes = readFileSync(
      join(REPO_ROOT, "backend", "src", "routes", "callbacks", "pr-review.ts"),
      "utf8",
    );
    expect(routes).toContain('webhooks.post("/pr-review-claim"');
    expect(routes).toContain('webhooks.post("/pr-review-result"');
    expect(step("Claim the review").run).toContain("$ORIGIN/webhooks/pr-review-claim");
    expect(REPORTER).toContain("$ORIGIN/webhooks/pr-review-result");
  });
});

describe("the callback token is a secret in a public log", () => {
  test("it is not at workflow or job level, where Actions prints it in every step header", () => {
    expect(JSON.stringify(wf.permissions)).not.toContain("callback_token");
    expect(JSON.stringify(job.env)).not.toContain("callback_token");
    expect(JSON.stringify(job.env)).not.toContain("PR_REVIEW_CALLBACK_TOKEN");
    expect(JSON.stringify(wf.concurrency)).not.toContain("callback_token");
  });

  test("the first step registers it as a secret, with no env of its own", () => {
    const first = job.steps[0];
    expect(first.name).toBe("Mask the callback token");
    expect(first.uses).toMatch(/^actions\/github-script@/);
    expect(first.env).toBeUndefined();
    expect(first.with?.script).toContain("core.setSecret(token)");
    expect(first.with?.script).toContain("client_payload.callback_token");
  });

  test("it is read from the payload by exactly the steps that use it", () => {
    const holders = job.steps
      .filter((s) => JSON.stringify(s).includes("callback_token"))
      .map((s) => s.name)
      .sort();
    expect(holders).toEqual(
      [
        "Mask the callback token",
        "Validate the dispatch",
        "Claim the review",
        "Check the federation configuration",
        "Review",
        "Report that the job failed",
      ].sort(),
    );
    for (const s of job.steps) {
      if (s.name === "Mask the callback token") continue;
      if (!JSON.stringify(s).includes("callback_token")) continue;
      expect(s.env?.PR_REVIEW_CALLBACK_TOKEN).toBe(
        "${{ github.event.client_payload.callback_token }}",
      );
    }
  });
});

describe("the claim comes first", () => {
  const names = job.steps.map((s) => s.name);
  const at = (n: string) => names.indexOf(n);

  test("mask, then validate, then claim, before anything is installed, minted or sent", () => {
    expect(names.slice(0, 3)).toEqual([
      "Mask the callback token",
      "Validate the dispatch",
      "Claim the review",
    ]);
    for (const n of [
      "Check out the review script",
      "Set up Bun",
      "Install the review script's dependencies",
      "Check the federation configuration",
      "Mint a read-only token for the dataset repository",
      "Fetch the pull request as git data",
      "Read the pull request from the API",
      "Fetch the GitHub OIDC token for Anthropic",
      "Review",
    ]) {
      expect(at(n), n).toBeGreaterThan(at("Claim the review"));
    }
  });

  test("the review counts as claimed only on HTTP 200 from the Worker", () => {
    const run = step("Claim the review").run ?? "";
    expect(step("Claim the review").id).toBe("claim");
    expect(run).toContain("X-Webhook-Token");
    expect(run).toMatch(/\n\s*200\)[\s\S]*?claimed=true/);
    expect(run).toContain("claimed=true");
    expect(run).toContain("claimed=false");
    // A 401 (forged or replayed) and any 409 (already claimed, superseded, no longer reviewable,
    // or unsettled) stop before the model. Anything else could not be decided, and a green run
    // would hide a review that is waiting.
    expect(run).toMatch(/401\|409\)[\s\S]*claimed=false/);
    expect(run).toMatch(/\*\)[\s\S]*::error::[\s\S]*exit 1/);
    expect(run).toContain("for attempt in 1 2 3");
  });

  test("every later step runs only when the review was claimed", () => {
    const gate = "steps.claim.outputs.claimed == 'true'";
    for (const s of job.steps.slice(at("Claim the review") + 1)) {
      expect(s.if, s.name).toContain(gate);
    }
  });

  test("the failure report runs for a claimed job that failed or was cancelled, and for no other", () => {
    const last = job.steps[job.steps.length - 1];
    expect(last.name).toBe("Report that the job failed");
    expect(last.if).toContain("failure()");
    expect(last.if).toContain("cancelled()");
    expect(last.if).toContain("steps.claim.outputs.claimed == 'true'");
    // Without the parentheses, `a || b && c` would run the report for an unclaimed job too.
    expect(last.if).toMatch(/^\(\s*failure\(\)\s*\|\|\s*cancelled\(\)\s*\)\s*&&/);
  });
});

describe("what it is allowed to hold", () => {
  test("no permissions by default; the job has contents read and the OIDC token, and nothing that writes", () => {
    expect(wf.permissions).toEqual({});
    expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
  });

  test("the GitHub App token is read-only and for one repository", () => {
    const mint = step("Mint a read-only token for the dataset repository");
    expect(mint.uses).toMatch(/^actions\/create-github-app-token@/);
    expect(mint.with?.["permission-contents"]).toBe("read");
    expect(mint.with?.["permission-pull-requests"]).toBe("read");
    const permissionKeys = Object.keys(mint.with ?? {}).filter((k) => k.startsWith("permission-"));
    expect(permissionKeys.sort()).toEqual(["permission-contents", "permission-pull-requests"]);
    expect(mint.with?.repositories).toBe("${{ env.DATASET_ID }}");
    expect(mint.with?.owner).toBe("nemarDatasets");
  });

  test("both secrets are registered as such by a statement that always runs", () => {
    // `toContain` would pass for `if (false) core.setSecret(token)`.
    expect(job.steps[0].with?.script).toMatch(
      /^\s*if \(typeof token === 'string' && token\.length > 0\) core\.setSecret\(token\);$/m,
    );
    expect(step("Fetch the GitHub OIDC token for Anthropic").with?.script).toMatch(
      /^\s*core\.setSecret\(token\);$/m,
    );
  });

  test("the OIDC token is requested for Anthropic's audience", () => {
    const oidc = step("Fetch the GitHub OIDC token for Anthropic");
    expect(oidc.with?.script).toContain("getIDToken('https://api.anthropic.com')");
    expect(oidc.with?.script).toContain("core.setSecret(token)");
  });

  test("the GitHub token reaches only the steps that read the repository, never the model step", () => {
    const withToken = job.steps.filter(holdsDatasetToken).map((s) => s.name);
    expect(withToken.sort()).toEqual(
      ["Fetch the pull request as git data", "Read the pull request from the API"].sort(),
    );
    const model = step("Review");
    expect(JSON.stringify(model.env)).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|app-token/);
  });

  test("the model step has the federation identity and the callback token", () => {
    const env = step("Review").env ?? {};
    for (const k of [
      "ANTHROPIC_FEDERATION_RULE_ID",
      "ANTHROPIC_ORGANIZATION_ID",
      "ANTHROPIC_SERVICE_ACCOUNT_ID",
      "ANTHROPIC_WORKSPACE_ID",
    ]) {
      expect(env[k]).toBe(`\${{ vars.${k} }}`);
    }
    expect(env.ANTHROPIC_IDENTITY_TOKEN_FILE).toContain("anthropic-oidc.jwt");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env.PR_REVIEW_CALLBACK_TOKEN).toBe("${{ github.event.client_payload.callback_token }}");
  });

  test("no API key is configured anywhere in the file", () => {
    expect(SRC).not.toMatch(/ANTHROPIC_API_KEY|secrets\.ANTHROPIC/);
  });

  test("the App's private key is used by the mint step and by no other", () => {
    const users = job.steps
      .filter((s) => JSON.stringify(s).includes("secrets."))
      .map((s) => s.name);
    expect(users).toEqual(["Mint a read-only token for the dataset repository"]);
  });
});

describe("what runs after the mint is not install-time code", () => {
  // `create-github-app-token` is the one step given the GitHub App's private key, and the runner
  // passes the same inputs to the action's post step at the end of the job. The order and the flag
  // below are what the workflow's header says closes three things: code planted before the mint,
  // install-time scripts, and a token in a configuration file that the install could read. The
  // checkout, Bun and the install run after the mint and before the fetch step writes the dataset
  // token to the clone's configuration, and the install runs no lifecycle script.
  const MINT = "Mint a read-only token for the dataset repository";
  const FETCH = "Fetch the pull request as git data";
  const READ = "Read the pull request from the API";
  const OIDC = "Fetch the GitHub OIDC token for Anthropic";
  const CHECKOUT = "Check out the review script";
  const INSTALL = "Install the review script's dependencies";
  const names = job.steps.map((s) => s.name);
  const at = (n: string) => names.indexOf(n);

  test("the steps are in the order that puts the tool checkout after the mint and the install before the fetch", () => {
    expect(names).toEqual([
      "Mask the callback token",
      "Validate the dispatch",
      "Claim the review",
      "Check the federation configuration",
      MINT,
      CHECKOUT,
      "Set up Bun",
      INSTALL,
      FETCH,
      READ,
      OIDC,
      "Review",
      "Report that the job failed",
    ]);
  });

  test("before the mint, only the masking action and plain shell run, and nothing from the tool checkout", () => {
    for (const s of job.steps.slice(0, at(MINT))) {
      if (s.name === "Mask the callback token") {
        expect(s.uses, s.name).toMatch(/^actions\/github-script@/);
        continue;
      }
      expect(s.uses, s.name).toBeUndefined();
      expect(s.run ?? "", s.name).not.toMatch(/\b(bun|node|npm|npx|yarn|pnpm)\b/);
      expect(s["working-directory"], s.name).toBeUndefined();
    }
    // A default at workflow or job level could put a step inside the tool directory without a
    // `working-directory` of its own, so the file declares none.
    expect(JSON.stringify(wf)).not.toContain('"defaults"');
  });

  test("the mint comes before the checkout, Bun and the install, and the install comes before the fetch", () => {
    for (const later of [CHECKOUT, "Set up Bun", INSTALL, FETCH, READ, OIDC, "Review"]) {
      expect(at(later), later).toBeGreaterThan(at(MINT));
    }
    // The fetch step is the one that writes the dataset token to the clone's configuration, so the
    // install is over before the token is on disk, and no step that is handed the token comes
    // before the install.
    const writers = job.steps.filter((s) => /\bgit config\b[^\n]*extraheader/.test(s.run ?? ""));
    expect(writers.map((s) => s.name)).toEqual([FETCH]);
    expect(at(INSTALL)).toBeLessThan(at(FETCH));
    for (const s of job.steps.filter(holdsDatasetToken)) {
      expect(at(s.name ?? ""), s.name).toBeGreaterThan(at(INSTALL));
    }
    // And no step before the mint holds anything of the repository's: no tool directory, no Bun,
    // no checkout.
    const before = JSON.stringify(job.steps.slice(0, at(MINT)));
    expect(before).not.toMatch(
      /oven-sh|setup-bun|working-directory|\btool\b|bun (install|run)|actions\/checkout/,
    );
  });

  test("the install runs after the checkout and the setup that provides Bun, and the script runs after the install", () => {
    expect(at(CHECKOUT)).toBeLessThan(at(INSTALL));
    expect(at("Set up Bun")).toBeLessThan(at(INSTALL));
    expect(at(INSTALL)).toBeLessThan(at("Review"));
  });

  test("the install runs no lifecycle script: not the repository's, and not a dependency's, trusted or not", () => {
    const install = step(INSTALL);
    expect(install.run?.trim()).toBe("bun install --frozen-lockfile --ignore-scripts");
    expect(install["working-directory"]).toBe("tool");
    // Every install in the file carries the flag, so a second one cannot reintroduce the scripts.
    for (const s of job.steps) {
      for (const line of (s.run ?? "").split("\n")) {
        if (/\bbun (install|add|i)\b/.test(line)) {
          expect(line, s.name).toContain("--ignore-scripts");
        }
      }
    }
    // Not `--production`: the review script imports the Anthropic SDK, which this repository lists
    // as a development dependency, so a production install could not run it.
    expect(SRC).not.toMatch(/bun install[^\n]*--production/);
  });
});

describe("the dispatch payload is untrusted", () => {
  test("payload fields reach the shell only through env, never inline in a run block", () => {
    for (const s of job.steps) {
      if (s.run) expect(s.run).not.toContain("client_payload");
      if (s.run) expect(s.run).not.toMatch(/\$\{\{\s*github\.event/);
    }
    for (const field of ["dataset_id", "pr_number", "head_sha", "review_id", "environment"]) {
      expect(Object.values(job.env).some((v) => v.includes(`client_payload.${field}`))).toBe(true);
    }
  });

  test("every field is validated before anything uses it", () => {
    const validate = step("Validate the dispatch");
    expect(job.steps[1].name).toBe("Validate the dispatch");
    for (const re of [
      "(nm|xx|on)[0-9]{6}",
      "[0-9a-f]{40}",
      "[0-9]{1,12}",
      "production",
      "dev",
      "no callback token",
    ]) {
      expect(validate.run).toContain(re);
    }
  });

  test("the origin is chosen from a fixed table, and it is the table the script holds", () => {
    const run = step("Validate the dispatch").run ?? "";
    const table = [...run.matchAll(/^\s*(production|dev)\)\s*origin="([^"]+)"/gm)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(Object.fromEntries(table)).toEqual(CALLBACK_ORIGINS);
    // Nothing from the payload is concatenated into a URL.
    expect(run).not.toMatch(/origin="[^"]*\$/);
  });

  test("the script gets the fetched commits and the dispatch's coordinates, each from the right place", () => {
    const review = step("Review");
    expect(review.env?.BASE_SHA).toBe("${{ steps.fetch.outputs.base }}");
    expect(review.env?.FETCHED_SHA).toBe("${{ steps.fetch.outputs.fetched }}");
    for (const arg of [
      '--repo-dir "$RUNNER_TEMP/repo"',
      '--base "$BASE_SHA"',
      '--head "$HEAD_SHA"',
      '--fetched-head "$FETCHED_SHA"',
      '--pr-json "$RUNNER_TEMP/pr.json"',
      '--review-id "$REVIEW_ID"',
      '--dataset "$DATASET_ID"',
      '--environment "$ENVIRONMENT"',
    ]) {
      expect(review.run, arg).toContain(arg);
    }
    // And nothing else is passed.
    expect([...(review.run ?? "").matchAll(/--[a-z-]+ /g)]).toHaveLength(8);
    expect(review.run).toContain('--repo-dir "$RUNNER_TEMP/repo"');
    expect(review.run).toContain('--pr-json "$RUNNER_TEMP/pr.json"');
  });

  test("the pull request is re-read from the API and handed to the script, not taken from the payload", () => {
    expect(step("Read the pull request from the API").run).toContain(
      'gh api "repos/nemarDatasets/${DATASET_ID}/pulls/${PR_NUMBER}"',
    );
    expect(step("Review").run).toContain('--pr-json "$RUNNER_TEMP/pr.json"');
    expect(step("Review").run).toContain('--fetched-head "$FETCHED_SHA"');
  });
});

describe("nothing from the pull request runs", () => {
  test("the repository is fetched with init and fetch, and never checked out", () => {
    const fetch = step("Fetch the pull request as git data").run ?? "";
    expect(fetch).toContain("git init");
    expect(fetch).toContain("git fetch");
    expect(fetch).toContain("--filter=blob:none");
    expect(fetch).toContain("core.hooksPath /dev/null");
    expect(fetch).not.toMatch(/git (checkout|clone|worktree|reset|merge|pull|switch)\b/);
    expect(SRC).not.toMatch(
      /uses: actions\/checkout@v\d+\s*\n\s*with:\s*\n\s*repository: nemarDatasets/,
    );
  });

  test("the fetch credential is masked before it is written anywhere", () => {
    const fetch = step("Fetch the pull request as git data").run ?? "";
    const mask = fetch.indexOf('echo "::add-mask::$auth"');
    expect(mask).toBeGreaterThan(-1);
    expect(mask).toBeLessThan(fetch.indexOf("extraheader"));
  });

  test("a fork is read through the pull ref on the base repository", () => {
    expect(step("Fetch the pull request as git data").run).toContain(
      '"+refs/pull/${PR_NUMBER}/head:refs/remotes/pr/head"',
    );
  });

  test("the only code that runs is the script checked out from nemar-cli main", () => {
    const checkout = step("Check out the review script");
    expect(checkout.with?.repository).toBe("nemarOrg/nemar-cli");
    expect(checkout.with?.ref).toBe("main");
    expect(checkout.with?.["persist-credentials"]).toBe(false as never);
    for (const s of job.steps) {
      if (s.run?.includes("bun run")) {
        expect(s["working-directory"]).toBe("tool");
        expect(s.run).toMatch(/bun run scripts\/ci\/pr-review\.ts review/);
      }
    }
    expect(SRC).not.toMatch(/\$RUNNER_TEMP\/repo\/(?!\.git)[^\s"']*\.(sh|ts|js|py)/);
  });

  test("a dev dispatch and a production dispatch both check out main", () => {
    // The script is the only thing the job checks out, and its inputs are plain text: nothing the
    // dispatch carries, its environment included, can reach them, so no dispatch (the dev
    // Worker's too) chooses which branch of nemar-cli the script comes from, and a change to it
    // reaches a review only through a release to main. run-publication-review.yml holds to the
    // same rule. Both environments pass the validate step, so both reach this checkout; the two
    // forms in which a step could read the environment are substituted for each, and the inputs
    // must come out the same, with the ref main.
    const checkouts = job.steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkouts.map((s) => s.name)).toEqual(["Check out the review script"]);
    const inputsFor = (environment: string) =>
      JSON.parse(
        JSON.stringify(checkouts[0].with)
          .replaceAll("${{ github.event.client_payload.environment }}", environment)
          .replaceAll("${{ env.ENVIRONMENT }}", environment),
      ) as Record<string, unknown>;
    for (const environment of ["dev", "production"]) {
      const inputs = inputsFor(environment);
      expect(inputs.repository, environment).toBe("nemarOrg/nemar-cli");
      expect(inputs.ref, environment).toBe("main");
      expect(JSON.stringify(inputs), environment).not.toContain("${{");
    }
    expect(inputsFor("dev")).toEqual(inputsFor("production"));
    // No `ref` input anywhere in the job is anything but main, and no step names a dev branch in
    // another form (a refspec, an `origin/dev`, an `@dev` on an action). The only `dev` left in the
    // job is the environment value the validate step accepts, the origin table keyed by it, and
    // /dev/null.
    const refInputs = job.steps.flatMap((s) =>
      s.with && "ref" in s.with ? [String(s.with.ref)] : [],
    );
    expect(refInputs).toEqual(["main"]);
    expect(JSON.stringify(job)).not.toMatch(
      /refs\/heads\/dev\b|\borigin\/dev\b|@dev\b|\bref["']?\s*[:=]\s*["']?dev\b/,
    );
    // A shell step could name the branch on a git command line (`git checkout dev`, `git fetch
    // origin dev`), which the patterns above do not see. A continued command is read as one line,
    // and a `dev` inside a path, as in /dev/null, is not a branch name.
    for (const s of job.steps) {
      for (const line of (s.run ?? "").replace(/\\\n\s*/g, " ").split("\n")) {
        if (/\bgit\b/.test(line)) {
          expect(line, s.name).not.toMatch(/(?<![\w/.-])dev(?![\w/.-])/);
        }
      }
    }
  });
});

describe("failure and logging", () => {
  test("the failure reporter needs nothing the job may have failed to install", () => {
    // Written by the validate step, which has already run when any later step fails.
    expect(step("Validate the dispatch").run).toContain('chmod +x "$RUNNER_TEMP/report-error.sh"');
    expect(REPORTER).toContain("curl ");
    expect(REPORTER).not.toMatch(/\b(bun|node|npm|npx|python|gh)\b/);
    expect(REPORTER).toContain('"outcome\\":\\"error\\"');
    expect(REPORTER).toContain('-H "X-Webhook-Token: $PR_REVIEW_CALLBACK_TOKEN"');
    expect(REPORTER).toContain("%{http_code}");
    const last = job.steps[job.steps.length - 1];
    expect(last.run).toContain('"$RUNNER_TEMP/report-error.sh" workflow_failed');
  });

  test("the words the workflow reports are words the Worker accepts", () => {
    for (const s of job.steps) {
      for (const m of (s.run ?? "").matchAll(/report-error\.sh"\s+([a-z_]+)/g)) {
        expect(isRunError(m[1]), `${s.name}: ${m[1]}`).toBe(true);
      }
    }
  });

  test("a missing federation variable is reported as a sign-in failure, with a clear message", () => {
    const check = step("Check the federation configuration");
    expect(check.run).toContain('report-error.sh" auth_failed');
    expect(check.run).toContain("::error::");
  });

  test("nothing in the file echoes the payload or a token into the public log", () => {
    for (const s of job.steps) {
      const run = s.run ?? "";
      for (const line of run.split("\n")) {
        if (/^\s*echo\b/.test(line) && !line.includes("::add-mask::")) {
          expect(line, `${s.name}: ${line}`).not.toMatch(
            /callback_token|PR_REVIEW_CALLBACK_TOKEN|GH_TOKEN|\$auth|\$\{auth\}/,
          );
        }
      }
      expect(run).not.toMatch(/\bset -x\b/);
      expect(run).not.toMatch(/cat\s+[^\n]*(pr\.json|anthropic-oidc)/);
    }
  });

  test("a job cannot run for ever, and ends before the Worker gives up on it", () => {
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(50);
    expect(job["timeout-minutes"]).toBeLessThan(PR_REVIEW_DEADLINE_MINUTES);
  });

  test("the review's worst case fits the job's timeout, which fits the Worker's deadline", () => {
    const minutes = (ms: number) => ms / 60_000;
    // The steps before the review script, at their worst: the claim's three tries of 30 seconds
    // each, one and two seconds apart (93 s), then the mint, the checkout, Bun, the install, the
    // blob-less fetch, the pull request read and the identity token, which take about two minutes
    // on a large dataset.
    // These steps are GitHub's (the checkout, Bun, the install, the fetch), bounded by the job's own
    // timeout and not by the script, so this one is an allowance and not a budget the script keeps.
    const SETUP_MINUTES = 4;
    // Both evidence passes over a partial clone, each cut at its budget: the change list, the trees
    // and commits, then one batched blob fetch for the diffs. A large change is about a minute.
    const EVIDENCE_MINUTES = minutes(EVIDENCE_BUDGET_MS.listing + EVIDENCE_BUDGET_MS.content);
    // Each stage is cut at its deadline, every attempt and the stream together (an abort signal),
    // and at worst by the backstop a grace period later, for the sign-in that takes no signal.
    const stages =
      minutes(STAGE_BUDGETS.screen.deadlineMs + DEADLINE_GRACE_MS) +
      minutes(STAGE_BUDGETS.review.deadlineMs + DEADLINE_GRACE_MS);
    // The callback's attempts at their timeout, and the pauses between them.
    let callbackMs = CALLBACK_ATTEMPTS * CALLBACK_TIMEOUT_MS;
    for (let attempt = 1; attempt < CALLBACK_ATTEMPTS; attempt++) {
      callbackMs += callbackBackoffMs(attempt);
    }
    const worst = SETUP_MINUTES + EVIDENCE_MINUTES + stages + minutes(callbackMs);
    expect(job["timeout-minutes"]).toBe(50);
    expect(PR_REVIEW_DEADLINE_MINUTES).toBe(60);
    expect(worst).toBeLessThanOrEqual(job["timeout-minutes"]);
    expect(job["timeout-minutes"]).toBeLessThan(PR_REVIEW_DEADLINE_MINUTES);
    // The review's deadline lets the model decode slowly and still reach its ceiling: the rate seen
    // on 2026-10-20 was about 100 tokens a second (32,000 in about five minutes), and a stage that
    // runs out of time first ends `model_unavailable`, which advises no split.
    const breakEven = REVIEW_MAX_TOKENS / (STAGE_BUDGETS.review.deadlineMs / 1000);
    expect(breakEven).toBeLessThan(75);
    // Each stage's first-byte timeout fits inside its own deadline, so a retry can still happen.
    for (const stage of [STAGE_BUDGETS.screen, STAGE_BUDGETS.review]) {
      expect(stage.timeoutMs * 2).toBeLessThanOrEqual(stage.deadlineMs);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The shell steps, run for real
// ---------------------------------------------------------------------------------------------

/**
 * The structure tests above prove what the file says; these prove what it does. The validate, claim
 * and reporter steps are plain bash and curl, so they run here exactly as Actions would run them
 * (`bash -e`), against a real HTTP server standing in for the Worker. The heredoc that writes the
 * reporter lives inside a YAML block scalar, which is the kind of thing that parses and then does
 * not run.
 */
describe("the shell steps, run for real", () => {
  interface Seen {
    method: string;
    path: string;
    token: string | null;
    body: string;
  }
  const seen: Seen[] = [];
  let answer = 200;
  /** When set, decides the status of each request in turn instead of {@link answer}. */
  let answerFor: (() => number) | null = null;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      seen.push({
        method: req.method,
        path: new URL(req.url).pathname,
        token: req.headers.get("X-Webhook-Token"),
        body: await req.text(),
      });
      return new Response("{}", { status: answerFor ? answerFor() : answer });
    },
  });
  const LOCAL_ORIGIN = `http://127.0.0.1:${server.port}`;
  afterAll(() => server.stop(true));
  beforeEach(() => {
    seen.length = 0;
    answer = 200;
  });

  const GOOD = {
    DATASET_ID: "nm000108",
    PR_NUMBER: "12",
    HEAD_SHA: "a".repeat(40),
    REVIEW_ID: "77",
    ENVIRONMENT: "production",
    PR_REVIEW_CALLBACK_TOKEN: "token-for-the-test",
  };

  async function runStepScript(name: string, env: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "pr-review-step-"));
    const out = join(dir, "output");
    const genv = join(dir, "env");
    writeFileSync(out, "");
    writeFileSync(genv, "");
    const file = join(dir, "step.sh");
    writeFileSync(file, step(name).run ?? "");
    // Async on purpose: a synchronous spawn blocks the event loop the stand-in server runs on.
    const proc = Bun.spawn(["bash", "-e", file], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        RUNNER_TEMP: dir,
        HOME: dir,
        GITHUB_OUTPUT: out,
        GITHUB_ENV: genv,
        ...env,
      },
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      dir,
      status,
      stdout,
      stderr,
      output: readFileSync(out, "utf8"),
      envFile: readFileSync(genv, "utf8"),
    };
  }

  test("validate: a good dispatch picks the origin from the table and writes an executable reporter", async () => {
    const r = await runStepScript("Validate the dispatch", GOOD);
    expect(r.status).toBe(0);
    expect(r.envFile).toBe(`ORIGIN=${CALLBACK_ORIGINS.production}\n`);
    const reporter = join(r.dir, "report-error.sh");
    expect(statSync(reporter).mode & 0o111).not.toBe(0);
    expect(readFileSync(reporter, "utf8")).toBe(`${REPORTER}\n`);
    const dev = await runStepScript("Validate the dispatch", { ...GOOD, ENVIRONMENT: "dev" });
    expect(dev.envFile).toBe(`ORIGIN=${CALLBACK_ORIGINS.dev}\n`);
  });

  test.each([
    ["DATASET_ID", "nm000108/../../x"],
    ["DATASET_ID", 'nm000108"; touch pwned; "'],
    ["DATASET_ID", "nm00010"],
    ["PR_NUMBER", "1; id"],
    ["PR_NUMBER", ""],
    ["HEAD_SHA", "A".repeat(40)],
    ["HEAD_SHA", `${"a".repeat(39)}\n`],
    ["REVIEW_ID", "7 7"],
    ["ENVIRONMENT", "staging"],
    ["ENVIRONMENT", "production\ndev"],
    ["PR_REVIEW_CALLBACK_TOKEN", ""],
  ])("validate: %s=%j is refused and chooses no origin", async (key, value) => {
    const r = await runStepScript("Validate the dispatch", { ...GOOD, [key]: value });
    expect(r.status).not.toBe(0);
    expect(r.envFile).toBe("");
    expect(existsSync(join(r.dir, "pwned"))).toBe(false);
  });

  test("validate: exactly production and dev get past it", async () => {
    // The guard is an exact allowlist of the two names the origin table is keyed by. The probes are
    // the near misses a looser comparison would let through (case, padding, a trailing newline)
    // and plain wrong values.
    const probes = [
      "production",
      "dev",
      "DEV",
      "Production",
      "production ",
      "production\n",
      "dev ",
      " dev",
      "dev\n",
      "staging",
      "main",
      "",
    ];
    const accepted: string[] = [];
    for (const environment of probes) {
      const r = await runStepScript("Validate the dispatch", { ...GOOD, ENVIRONMENT: environment });
      if (r.status === 0) {
        accepted.push(environment);
      } else {
        // Refused by the guard that names the environment, not by a later line that happens to
        // fail: a script that stops on an unbound variable would also exit non-zero. The guard
        // says why on stdout and stops there, so a refusal that reached the unbound variable
        // would also leave a message on stderr.
        expect(r.stdout, JSON.stringify(environment)).toContain("::error::malformed environment");
        expect(r.stderr, JSON.stringify(environment)).toBe("");
      }
    }
    expect(accepted).toEqual(["production", "dev"]);
  });

  /** Validate, then hand the claim step the stand-in's origin as the real job would see it. */
  async function claim(token = GOOD.PR_REVIEW_CALLBACK_TOKEN) {
    return runStepScript("Claim the review", {
      ...GOOD,
      PR_REVIEW_CALLBACK_TOKEN: token,
      ORIGIN: LOCAL_ORIGIN,
    });
  }

  test("claim: HTTP 200 is claimed, and the Worker is sent exactly what its door reads", async () => {
    const r = await claim();
    expect(r.status).toBe(0);
    expect(r.output).toBe("claimed=true\n");
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].path).toBe("/webhooks/pr-review-claim");
    expect(seen[0].token).toBe(GOOD.PR_REVIEW_CALLBACK_TOKEN);
    expect(JSON.parse(seen[0].body)).toEqual({ review_id: 77, dataset_id: "nm000108" });
  });

  test.each([401, 409])(
    "claim: HTTP %d is a dispatch that is not this review's to run, and the job ends green",
    async (code) => {
      answer = code;
      const r = await claim();
      expect(r.status).toBe(0);
      expect(r.output).toBe("claimed=false\n");
      expect(r.stdout).toContain("nothing was spent");
      // A refusal is final: it is not retried.
      expect(seen).toHaveLength(1);
    },
  );

  test.each([500, 503, 400, 302])(
    "claim: HTTP %d could not be decided, so the job fails loudly instead of hiding a waiting review",
    async (code) => {
      answer = code;
      const r = await claim();
      expect(r.status).not.toBe(0);
      expect(r.output).toBe("claimed=false\n");
      // A server error is tried three times; any other answer is final.
      expect(seen).toHaveLength(code >= 500 ? 3 : 1);
      expect(r.stdout).toContain(
        `::error::the claim for review 77 could not be decided (HTTP ${code})`,
      );
    },
    20_000,
  );

  test("claim: a transient error is retried, and a later 200 claims the review", async () => {
    let calls = 0;
    answerFor = () => (++calls < 3 ? 503 : 200);
    try {
      const r = await claim();
      expect(r.status).toBe(0);
      expect(r.output).toBe("claimed=true\n");
      expect(seen).toHaveLength(3);
    } finally {
      answerFor = null;
    }
  }, 20_000);

  test("claim: an unreachable Worker fails the job, with the status word 000", async () => {
    const dead = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = dead.port;
    dead.stop(true);
    const r = await runStepScript("Claim the review", {
      ...GOOD,
      ORIGIN: `http://127.0.0.1:${port}`,
    });
    expect(r.status).not.toBe(0);
    expect(r.output).toBe("claimed=false\n");
    expect(r.stdout).toContain("(HTTP 000)");
  }, 20_000);

  test("claim: the token reaches the Worker and not the log", async () => {
    const r = await claim("a-token-that-must-not-print");
    expect(seen[0].token).toBe("a-token-that-must-not-print");
    expect(r.stdout + r.stderr).not.toContain("a-token-that-must-not-print");
  });

  /** A dataset repository as GitHub would serve it: `main`, and a pull request's head under refs/pull. */
  function servedDataset(prNumber: number) {
    const dir = mkdtempSync(join(tmpdir(), "pr-review-remote-"));
    const run = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: dir,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      }).trim();
    run("init", "-q", "-b", "main");
    run("config", "uploadpack.allowFilter", "true");
    run("config", "uploadpack.allowAnySHA1InWant", "true");
    writeFileSync(join(dir, "dataset_description.json"), '{"Name":"d","Version":"1.0.0"}');
    run("add", ".");
    run("commit", "-q", "-m", "base");
    const base = run("rev-parse", "HEAD");
    run("checkout", "-q", "-b", "contribution");
    writeFileSync(join(dir, "dataset_description.json"), '{"Name":"d","Version":"1.1.0"}');
    run("commit", "-q", "-am", "bump");
    const head = run("rev-parse", "HEAD");
    run("update-ref", `refs/pull/${prNumber}/head`, head);
    // main moves on after the branch was cut, so base and head cannot be confused for each other.
    run("checkout", "-q", "main");
    writeFileSync(join(dir, "README.md"), "# later\n");
    run("add", ".");
    run("commit", "-q", "-m", "main moved");
    const mainTip = run("rev-parse", "HEAD");
    return { dir, base, head, mainTip };
  }

  test("fetch: main's tip and the pull ref are fetched as git data, with no working tree", async () => {
    const remote = servedDataset(12);
    const r = await runStepScript("Fetch the pull request as git data", {
      ...GOOD,
      GH_TOKEN: "ghs_read_only_for_the_test",
      // Stand in for github.com: the step's URL is rewritten to the local repository.
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.file://${remote.dir}.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/nemarDatasets/nm000108.git",
    });
    expect(r.status, r.stderr).toBe(0);
    const out = Object.fromEntries(
      r.output
        .trim()
        .split("\n")
        .map((l) => l.split("=")),
    );
    // `base` is main's current tip, and `fetched` is the pull request's head: different commits.
    expect(out.base).toBe(remote.mainTip);
    expect(out.fetched).toBe(remote.head);
    expect(out.base).not.toBe(out.fetched);
    const repo = join(r.dir, "repo");
    // Nothing was checked out: the only entry is .git, so no hook, filter or script can run.
    expect(readdirSync(repo)).toEqual([".git"]);
    // The clone is blob-less and keeps the read-only token for lazy blob reads (see the header).
    const cfg = readFileSync(join(repo, ".git", "config"), "utf8");
    expect(cfg).toContain("partialClone = origin");
    expect(cfg).toContain("hooksPath = /dev/null");
    // The token does not appear in the log.
    expect(r.stdout + r.stderr).not.toContain("ghs_read_only_for_the_test");
  });

  test("fetch: a pull request number with no pull ref fails the step instead of reviewing main", async () => {
    const remote = servedDataset(12);
    const r = await runStepScript("Fetch the pull request as git data", {
      ...GOOD,
      PR_NUMBER: "13",
      GH_TOKEN: "ghs_read_only_for_the_test",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.file://${remote.dir}.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/nemarDatasets/nm000108.git",
    });
    expect(r.status).not.toBe(0);
    expect(r.output).not.toContain("fetched=");
  });

  async function report(word: string, origin = LOCAL_ORIGIN) {
    const validated = await runStepScript("Validate the dispatch", GOOD);
    const proc = Bun.spawn([join(validated.dir, "report-error.sh"), word], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        ORIGIN: origin,
        REVIEW_ID: GOOD.REVIEW_ID,
        DATASET_ID: GOOD.DATASET_ID,
        PR_REVIEW_CALLBACK_TOKEN: GOOD.PR_REVIEW_CALLBACK_TOKEN,
      },
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { exitCode, stdout };
  }

  test("reporter: posts the closed-vocabulary error the Worker's parser accepts", async () => {
    const r = await report("workflow_failed");
    expect(r.exitCode).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe("/webhooks/pr-review-result");
    expect(seen[0].token).toBe(GOOD.PR_REVIEW_CALLBACK_TOKEN);
    const body = JSON.parse(seen[0].body);
    expect(body).toEqual({
      review_id: 77,
      dataset_id: "nm000108",
      outcome: "error",
      error: "workflow_failed",
    });
    expect(parseCallbackOutcome(body)).toEqual({ kind: "error", error: "workflow_failed" });
    // And says what the Worker answered, with no token in it.
    expect(r.stdout).toBe("review 77: reported workflow_failed (HTTP 200)\n");
  });

  test("reporter: a report the Worker refuses is visible in the log, and does not fail the step", async () => {
    answer = 401;
    const r = await report("workflow_failed");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("(HTTP 401)");
    expect(r.stdout).not.toContain(GOOD.PR_REVIEW_CALLBACK_TOKEN);
  });

  test("reporter: auth_failed is also accepted, and a dead Worker does not fail the step", async () => {
    await report("auth_failed");
    expect(parseCallbackOutcome(JSON.parse(seen[0].body))).toEqual({
      kind: "error",
      error: "auth_failed",
    });
    const dead = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = dead.port;
    dead.stop(true);
    const gone = await report("workflow_failed", `http://127.0.0.1:${port}`);
    expect(gone.exitCode).toBe(0);
    expect(gone.stdout).toContain("(HTTP 000)");
  }, 20_000);
});

// ---------------------------------------------------------------------------------------------
// Drift against the deployed copy
// ---------------------------------------------------------------------------------------------

const LIVE_ENV_VAR = "NEMAR_PR_REVIEW_WORKFLOW_LIVE";
const declaredRaw = process.env[LIVE_ENV_VAR];
const DECLARED =
  declaredRaw && declaredRaw.trim() !== ""
    ? isAbsolute(declaredRaw)
      ? declaredRaw
      : join(REPO_ROOT, declaredRaw)
    : null;
const SIBLINGS = [
  join(REPO_ROOT, "..", ".github", ".github", "workflows", "run-pr-review.yml"),
  join(REPO_ROOT, "..", "dot-github", ".github", "workflows", "run-pr-review.yml"),
  join(REPO_ROOT, "..", "..", ".github", ".github", "workflows", "run-pr-review.yml"),
];
const found = DECLARED ?? SIBLINGS.find((p) => existsSync(p)) ?? null;

describe("the deployed copy", () => {
  test("the authoring copy says where it is deployed", () => {
    expect(SRC).toContain("Deploy to: nemarDatasets/.github/.github/workflows/run-pr-review.yml");
  });

  test.skipIf(DECLARED === null)(`${LIVE_ENV_VAR} names a file that is present`, () => {
    expect(
      existsSync(DECLARED ?? ""),
      `${LIVE_ENV_VAR}=${declaredRaw} but that file does not exist; the checkout step did not produce it`,
    ).toBe(true);
  });

  describe.skipIf(found === null)("is byte-identical to the authoring copy", () => {
    test("the two files match exactly", () => {
      const live = readFileSync(found ?? "", "utf8");
      if (SRC !== live) {
        const a = SRC.split("\n");
        const b = live.split("\n");
        const i = a.findIndex((line, idx) => line !== b[idx]);
        throw new Error(
          `run-pr-review.yml has drifted from nemarDatasets/.github (first difference at line ${
            i + 1
          }). The deploy is a whole-file copy, so any difference is a difference in what runs.`,
        );
      }
      expect(SRC).toBe(live);
    });
  });
});
