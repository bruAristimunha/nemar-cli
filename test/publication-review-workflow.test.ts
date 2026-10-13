/**
 * The central publication-review workflow (ADR 0102): the properties its security rests on, pinned
 * so a later "simplification" cannot remove one without a test saying which.
 *
 * The workflow is authored in this repository and deployed by copying it whole into
 * `nemarDatasets/.github` (the same arrangement and the same drift risk as the pull-request review
 * workflow, see `test/pr-review-workflow.test.ts`). The check at the bottom compares the two byte
 * for byte, and SKIPS VISIBLY when there is no deployed copy: the deployed copy does not exist until
 * the release that ships the script has happened (ADR 0102, "Before it is switched on"), so unlike
 * the pull-request review's, this check is not wired into CI's required job yet.
 *
 * Two checks read the Worker's own files: the event type it dispatches and the callback routes it
 * registers (under "what triggers it"), the pair `test/pr-review-workflow.test.ts` makes for the
 * pull-request review.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { parse } from "yaml";
import { CALLBACK_ORIGINS, main } from "../scripts/ci/publication-review";
import {
  DATA_SIDECAR,
  NOT_RAW,
  SIDECAR_SAMPLE,
  bidsState,
  blobsToRead,
  readRootDocuments,
  readTree,
  structuralSummary,
  tagState,
} from "../scripts/ci/publication-review-evidence";
import {
  CHANGES_CANDIDATES,
  LICENSE_CANDIDATES,
  PARTICIPANTS_JSON,
  PUBLICATION_REVIEW_DEADLINE_MINUTES,
  WORKER_ONLY_RUN_ERRORS,
  isPublicationRunError,
  parsePublicationCallbackOutcome,
} from "../shared/publication-review";
import { README_CANDIDATES } from "../shared/readme-candidates";

const REPO_ROOT = join(import.meta.dir, "..");
const LOCAL = join(REPO_ROOT, ".github", "dataset-workflows", "run-publication-review.yml");
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

const FETCH = "Fetch the dataset as git data";
const BIDS = "Read the BIDS validation runs at the commit";
const MINT = "Mint a read-only token for the dataset repository";
const OIDC = "Fetch the GitHub OIDC token for Anthropic";

/** The reporter script the validate step writes, as it will exist on the runner. */
const REPORTER = (() => {
  const run = (job.steps.find((x) => x.name === "Validate the dispatch")?.run ?? "").split("\n");
  const from = run.findIndex((l) => l.includes("<<'REPORTER'"));
  const to = run.findIndex((l, i) => i > from && l.trim() === "REPORTER");
  if (from < 0 || to < 0) throw new Error("the validate step does not write the reporter");
  return run.slice(from + 1, to).join("\n");
})();

describe("what triggers it", () => {
  test("only a repository_dispatch of run-publication-review, never a pull request or a manual run", () => {
    expect(Object.keys(wf.on)).toEqual(["repository_dispatch"]);
    expect(wf.on.repository_dispatch?.types).toEqual(["run-publication-review"]);
  });

  test("the event type matches what the Worker dispatches", () => {
    const dispatch = readFileSync(
      join(REPO_ROOT, "backend", "src", "services", "github", "dispatch.ts"),
      "utf8",
    );
    expect(dispatch).toContain('event_type: "run-publication-review"');
    // The workflow listens for that very word, and for no other event.
    expect(wf.on.repository_dispatch?.types).toEqual(["run-publication-review"]);
  });

  test("the callback routes the workflow and the script post to are the ones the Worker registers", () => {
    const routes = readFileSync(
      join(REPO_ROOT, "backend", "src", "routes", "callbacks", "publication-review.ts"),
      "utf8",
    );
    expect(routes).toContain('webhooks.post("/publication-review-claim"');
    expect(routes).toContain('webhooks.post("/publication-review-result"');
    // The claim is the workflow's own step, the result is the reporter's and the script's.
    expect(step("Claim the review").run).toContain("$ORIGIN/webhooks/publication-review-claim");
    expect(REPORTER).toContain("$ORIGIN/webhooks/publication-review-result");
    const script = readFileSync(join(REPO_ROOT, "scripts", "ci", "publication-review.ts"), "utf8");
    expect(script).toContain("/webhooks/publication-review-result");
    // Every webhook path any of the three names is registered by the Worker: a route renamed on
    // one side only would otherwise surface on a runner.
    const named = new Set(
      [step("Claim the review").run ?? "", REPORTER, script]
        .flatMap((t) => [...t.matchAll(/\/webhooks\/(publication-review-[a-z]+)/g)])
        .map((m) => m[1]),
    );
    expect([...named].sort()).toEqual(["publication-review-claim", "publication-review-result"]);
    for (const name of named) expect(routes).toContain(`webhooks.post("/${name}"`);
  });

  test("each workflow execution has its own concurrency group", () => {
    // GitHub replaces the pending run in a group. Never group on the untrusted repository_dispatch
    // payload, or a forged event can replace a legitimate pending review.
    expect(wf.concurrency.group).toContain("github.run_id");
    expect(wf.concurrency.group).toContain("github.run_attempt");
    expect(wf.concurrency.group).not.toContain("client_payload");
    expect(wf.concurrency["cancel-in-progress"]).toBe(false);
  });

  test("the callback routes it calls are the publication review's own", () => {
    expect(step("Claim the review").run).toContain("$ORIGIN/webhooks/publication-review-claim");
    expect(REPORTER).toContain("$ORIGIN/webhooks/publication-review-result");
    expect(SRC).not.toContain("pr-review-");
    expect(SRC).not.toContain("prescreen");
  });
});

describe("the callback token is a secret in a public log", () => {
  test("it is not at workflow or job level, where Actions prints it in every step header", () => {
    expect(JSON.stringify(wf.permissions)).not.toContain("callback_token");
    expect(JSON.stringify(job.env)).not.toContain("callback_token");
    expect(JSON.stringify(job.env)).not.toContain("CALLBACK_TOKEN");
    expect(JSON.stringify(wf.concurrency)).not.toContain("callback_token");
  });

  test("the first step registers it as a secret, with no env of its own", () => {
    const first = job.steps[0];
    expect(first?.name).toBe("Mask the callback token");
    expect(first?.uses).toMatch(/^actions\/github-script@/);
    expect(first?.env).toBeUndefined();
    expect(first?.with?.script).toContain("core.setSecret(token)");
    expect(first?.with?.script).toContain("client_payload.callback_token");
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
      expect(s.env?.PUBLICATION_REVIEW_CALLBACK_TOKEN).toBe(
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
      MINT,
      FETCH,
      BIDS,
      OIDC,
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
    // turned off, or unsettled) stop before the model. Anything else could not be decided, and a
    // green run would hide a review that is waiting.
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
    expect(last?.name).toBe("Report that the job failed");
    expect(last?.if).toContain("failure()");
    expect(last?.if).toContain("cancelled()");
    expect(last?.if).toContain("steps.claim.outputs.claimed == 'true'");
    // Without the parentheses, `a || b && c` would run the report for an unclaimed job too.
    expect(last?.if).toMatch(/^\(\s*failure\(\)\s*\|\|\s*cancelled\(\)\s*\)\s*&&/);
  });
});

describe("what runs after the mint is not install-time code (#1728)", () => {
  // `create-github-app-token` is the one step given the GitHub App's private key, and the runner
  // passes the same inputs to the action's post step at the end of the job. The order and the
  // flags below close what they close, which is hooks planted before the mint and install-time
  // code; the workflow's header says what they do not.
  const names = job.steps.map((s) => s.name);
  const at = (n: string) => names.indexOf(n);
  const INSTALL = "Install the review script's dependencies";

  test("the steps are in the order that keeps hooks planted by installed code away from the mint", () => {
    expect(names).toEqual([
      "Mask the callback token",
      "Validate the dispatch",
      "Claim the review",
      "Check the federation configuration",
      MINT,
      FETCH,
      BIDS,
      "Check out the review script",
      "Set up Bun",
      INSTALL,
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
  });

  test("the mint and the fetch come before the checkout, Bun, the install and any `bun run`", () => {
    for (const later of ["Check out the review script", "Set up Bun", INSTALL, OIDC, "Review"]) {
      expect(at(later), later).toBeGreaterThan(at(FETCH));
      expect(at(later), later).toBeGreaterThan(at(BIDS));
      expect(at(later), later).toBeGreaterThan(at(MINT));
    }
    // And no step before the mint holds anything of the repository's: no tool directory, no Bun.
    const before = JSON.stringify(job.steps.slice(0, at(MINT)));
    expect(before).not.toMatch(/oven-sh|setup-bun|working-directory|\btool\b|bun (install|run)/);
  });

  test("the install runs after the setup that provides Bun, and the script runs after the install", () => {
    expect(at("Set up Bun")).toBeLessThan(at(INSTALL));
    expect(at(INSTALL)).toBeLessThan(at("Review"));
    expect(at("Check out the review script")).toBeLessThan(at(INSTALL));
  });

  test("the install runs no lifecycle script: not the repository's, and not a dependency's, trusted or not", () => {
    const install = step(INSTALL);
    expect(install.run?.trim()).toBe("bun install --frozen-lockfile --ignore-scripts");
    expect(install["working-directory"]).toBe("tool");
    // Every `bun install` in the file carries the flag.
    for (const s of job.steps) {
      for (const line of (s.run ?? "").split("\n")) {
        if (/\bbun (install|add|i)\b/.test(line))
          expect(line, s.name).toContain("--ignore-scripts");
      }
    }
    // Not `--production`: the review script imports the Anthropic SDK, which this repository lists as a
    // development dependency, so a production install could not run it (checked in a scratch copy).
    expect(SRC).not.toMatch(/bun install[^\n]*--production/);
  });
});

describe("every action is pinned to a full commit, with its version in a comment (#1728)", () => {
  const USES = [...SRC.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)(?:[ \t]+#[ \t]*(\S+))?[ \t]*$/gm)].map(
    (m) => ({ ref: m[1] as string, comment: m[2] }),
  );

  test("there are uses lines to check, and they are the workflow's steps' own", () => {
    expect(USES).toHaveLength(job.steps.filter((s) => s.uses !== undefined).length);
    expect(USES.length).toBeGreaterThanOrEqual(5);
  });

  test("each is owner/name@<40 hex characters>, never a tag or a branch", () => {
    for (const { ref } of USES)
      expect(ref, ref).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/);
  });

  test("each carries the tag it was resolved from, as a trailing comment", () => {
    for (const { ref, comment } of USES) expect(comment, ref).toMatch(/^v\d+(\.\d+){0,2}$/);
  });

  test("the actions are exactly the four this job has reviewed", () => {
    expect(
      USES.map((u) => u.ref.split("@")[0])
        .sort()
        .filter((n, i, all) => all.indexOf(n) === i),
    ).toEqual(
      [
        "actions/checkout",
        "actions/create-github-app-token",
        "actions/github-script",
        "oven-sh/setup-bun",
      ].sort(),
    );
  });

  test("the parsed workflow agrees with the raw lines", () => {
    expect(job.steps.flatMap((s) => (s.uses === undefined ? [] : [s.uses]))).toEqual(
      USES.map((u) => u.ref),
    );
  });
});

describe("what it is allowed to hold", () => {
  test("no permissions by default; the job has contents read and the OIDC token, and nothing that writes", () => {
    expect(wf.permissions).toEqual({});
    expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
  });

  test("the GitHub App token is read-only, for one repository, with contents and actions only", () => {
    const mint = step(MINT);
    expect(mint.uses).toMatch(/^actions\/create-github-app-token@/);
    expect(mint.with?.["permission-contents"]).toBe("read");
    expect(mint.with?.["permission-actions"]).toBe("read");
    const permissionKeys = Object.keys(mint.with ?? {}).filter((k) => k.startsWith("permission-"));
    expect(permissionKeys.sort()).toEqual(["permission-actions", "permission-contents"]);
    expect(mint.with?.repositories).toBe("${{ env.DATASET_ID }}");
    expect(mint.with?.owner).toBe("nemarDatasets");
  });

  test("both secrets are registered as such by a statement that always runs", () => {
    // `toContain` would pass for `if (false) core.setSecret(token)`.
    expect(job.steps[0]?.with?.script).toMatch(
      /^\s*if \(typeof token === 'string' && token\.length > 0\) core\.setSecret\(token\);$/m,
    );
    expect(step(OIDC).with?.script).toMatch(/^\s*core\.setSecret\(token\);$/m);
  });

  test("the OIDC token is requested for Anthropic's audience, and last before the model step", () => {
    const oidc = step(OIDC);
    expect(oidc.with?.script).toContain("getIDToken('https://api.anthropic.com')");
    const names = job.steps.map((s) => s.name);
    expect(names.indexOf(OIDC)).toBe(names.indexOf("Review") - 1);
  });

  test("the GitHub token reaches only the two steps that read the repository, never the model step", () => {
    const withToken = job.steps
      .filter((s) => JSON.stringify(s).includes("steps.app-token.outputs.token"))
      .map((s) => s.name);
    expect(withToken.sort()).toEqual([FETCH, BIDS].sort());
    const model = step("Review");
    expect(JSON.stringify(model.env)).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|app-token/);
    expect(JSON.stringify(model)).not.toMatch(/secrets\./);
  });

  test("the model step has the review's own federation identity and the callback token", () => {
    const env = step("Review").env ?? {};
    expect(env.ANTHROPIC_FEDERATION_RULE_ID).toBe(
      "${{ vars.ANTHROPIC_PUBLICATION_REVIEW_FEDERATION_RULE_ID }}",
    );
    expect(env.ANTHROPIC_SERVICE_ACCOUNT_ID).toBe(
      "${{ vars.ANTHROPIC_PUBLICATION_REVIEW_SERVICE_ACCOUNT_ID }}",
    );
    // The organization and the workspace are shared with the other reviews.
    expect(env.ANTHROPIC_ORGANIZATION_ID).toBe("${{ vars.ANTHROPIC_ORGANIZATION_ID }}");
    expect(env.ANTHROPIC_WORKSPACE_ID).toBe("${{ vars.ANTHROPIC_WORKSPACE_ID }}");
    expect(env.ANTHROPIC_IDENTITY_TOKEN_FILE).toContain("anthropic-oidc.jwt");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env.PUBLICATION_REVIEW_CALLBACK_TOKEN).toBe(
      "${{ github.event.client_payload.callback_token }}",
    );
  });

  test("the federation check names the same variables the model step uses", () => {
    const env = step("Check the federation configuration").env ?? {};
    expect(env.RULE).toBe("${{ vars.ANTHROPIC_PUBLICATION_REVIEW_FEDERATION_RULE_ID }}");
    expect(env.ACCOUNT).toBe("${{ vars.ANTHROPIC_PUBLICATION_REVIEW_SERVICE_ACCOUNT_ID }}");
    expect(env.ORG).toBe("${{ vars.ANTHROPIC_ORGANIZATION_ID }}");
    expect(env.WORKSPACE).toBe("${{ vars.ANTHROPIC_WORKSPACE_ID }}");
    // Another review's identity is never the one this job signs in with.
    expect(SRC).not.toMatch(/vars\.ANTHROPIC_(FEDERATION_RULE_ID|SERVICE_ACCOUNT_ID)\b/);
  });

  test("no API key is configured anywhere in the file", () => {
    expect(SRC).not.toMatch(/ANTHROPIC_API_KEY|secrets\.ANTHROPIC/);
  });

  test("the App's private key is used by the mint step and by no other", () => {
    const users = job.steps
      .filter((s) => JSON.stringify(s).includes("secrets."))
      .map((s) => s.name);
    expect(users).toEqual([MINT]);
  });

  test("nothing in the file writes to GitHub", () => {
    for (const s of job.steps) {
      const run = s.run ?? "";
      expect(run, s.name).not.toMatch(/git (push|tag\b|commit)|gh (issue|pr|release|label|repo)\b/);
      expect(run, s.name).not.toMatch(/gh api[^\n]*(-X|--method)\s*(POST|PUT|PATCH|DELETE)/i);
      expect(run, s.name).not.toMatch(/gh api[^\n]*(-f|-F|--field|--raw-field|--input)\b/);
    }
    expect(job.permissions).not.toHaveProperty("contents", "write");
    expect(SRC).not.toMatch(/permission-[a-z-]+:\s*write/);
  });
});

describe("the dispatch payload is untrusted", () => {
  test("payload fields reach the shell only through env, never inline in a run block", () => {
    for (const s of job.steps) {
      if (s.run) expect(s.run).not.toContain("client_payload");
      if (s.run) expect(s.run).not.toMatch(/\$\{\{\s*github\.event/);
    }
    for (const field of [
      "dataset_id",
      "request_id",
      "review_id",
      "head_sha",
      "anonymous",
      "environment",
    ]) {
      expect(Object.values(job.env).some((v) => v.includes(`client_payload.${field}`))).toBe(true);
    }
    expect(Object.keys(job.env).sort()).toEqual(
      ["ANONYMOUS", "DATASET_ID", "ENVIRONMENT", "HEAD_SHA", "REQUEST_ID", "REVIEW_ID"].sort(),
    );
  });

  test("every field is validated before anything uses it", () => {
    const validate = step("Validate the dispatch");
    expect(job.steps[1]?.name).toBe("Validate the dispatch");
    for (const re of [
      "(nm|xx|on)[0-9]{6}",
      "[0-9a-f]{40}",
      "[0-9]{1,12}",
      '"$ANONYMOUS" == "true" || "$ANONYMOUS" == "false"',
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

  test("the script gets the fetched commit and the dispatch's coordinates, each from the right place", () => {
    const review = step("Review");
    expect(review.env?.FETCHED_SHA).toBe("${{ steps.fetch.outputs.fetched }}");
    expect(step(FETCH).id).toBe("fetch");
    for (const arg of [
      '--repo-dir "$RUNNER_TEMP/repo"',
      '--head "$HEAD_SHA"',
      '--fetched-head "$FETCHED_SHA"',
      '--tags-file "$RUNNER_TEMP/tags.txt"',
      '--bids-runs-file "$RUNNER_TEMP/bids-runs.json"',
      '--review-id "$REVIEW_ID"',
      '--request-id "$REQUEST_ID"',
      '--dataset "$DATASET_ID"',
      '--anonymous "$ANONYMOUS"',
      '--environment "$ENVIRONMENT"',
    ]) {
      expect(review.run, arg).toContain(arg);
    }
    // And nothing else is passed.
    expect([...(review.run ?? "").matchAll(/--[a-z-]+ /g)]).toHaveLength(10);
  });

  test("the validation runs are read from the API at the dispatched commit, and a failure is not a failed job", () => {
    const run = step(BIDS).run ?? "";
    expect(run).toContain(
      'gh api "repos/nemarDatasets/${DATASET_ID}/actions/workflows/bids-validation.yml/runs?head_sha=${HEAD_SHA}&per_page=10"',
    );
    expect(run).toContain('> "$RUNNER_TEMP/bids-runs.json"');
    expect(run).toContain('echo \'{"unavailable":true}\' > "$RUNNER_TEMP/bids-runs.json"');
    expect(run).not.toMatch(/\bset -e/);
  });
});

describe("nothing from the dataset runs", () => {
  test("the repository is fetched with init and fetch, one commit deep and blob-less, and never checked out", () => {
    const fetch = step(FETCH).run ?? "";
    expect(fetch).toContain("git init");
    expect(fetch).toContain("gitauth fetch");
    expect(fetch).toContain("--no-tags --depth=1 --filter=blob:none");
    expect(fetch).toContain('"+refs/heads/main:refs/remotes/origin/main"');
    expect(fetch).toContain("core.hooksPath /dev/null");
    expect(fetch).not.toMatch(/git (checkout|clone|worktree|reset|merge|pull|switch)\b/);
    expect(SRC).not.toMatch(
      /uses: actions\/checkout@\S+(?: +#[^\n]*)?\s*\n\s*with:\s*\n\s*repository: nemarDatasets/,
    );
  });

  test("the tags come from ls-remote, because a fetch with --no-tags does not carry them", () => {
    const fetch = step(FETCH).run ?? "";
    expect(fetch).toContain('gitauth ls-remote --tags origin > "$RUNNER_TEMP/tags.txt"');
    expect(fetch).toContain('echo "fetched=$(git rev-parse refs/remotes/origin/main)"');
  });

  test("the fetch step reads GH_TOKEN once, into the header, and unsets it before any other command", () => {
    const fetch = step(FETCH).run ?? "";
    const header = fetch.indexOf("auth=");
    const unset = fetch.indexOf("unset GH_TOKEN");
    expect(header).toBeGreaterThan(-1);
    expect(unset).toBeGreaterThan(header);
    // The header is encoded without the token in the encoder's environment, and every command that
    // follows (git init, config, remote, ls-tree, perl) comes after the unset.
    expect(fetch.slice(header, unset)).toContain("env -u GH_TOKEN base64");
    expect(fetch.indexOf("git init")).toBeGreaterThan(unset);
    expect(fetch.indexOf("perl ")).toBeGreaterThan(unset);
    // Nothing in the step puts it back.
    expect(fetch.indexOf("GH_TOKEN", unset + "unset GH_TOKEN".length)).toBe(-1);
  });

  test("the fetch credential is masked before it is written anywhere", () => {
    const fetch = step(FETCH).run ?? "";
    const mask = fetch.indexOf('echo "::add-mask::$auth"');
    expect(mask).toBeGreaterThan(-1);
    expect(mask).toBeLessThan(fetch.indexOf("extraheader"));
  });

  test("the only code that runs is the script checked out from nemar-cli main", () => {
    const checkout = step("Check out the review script");
    expect(checkout.with?.repository).toBe("nemarOrg/nemar-cli");
    expect(checkout.with?.ref).toBe("main");
    expect(checkout.with?.["persist-credentials"]).toBe(false as never);
    // A ref is never taken from the payload.
    expect(JSON.stringify(checkout)).not.toContain("client_payload");
    for (const s of job.steps) {
      if (s.run?.includes("bun run")) {
        expect(s["working-directory"]).toBe("tool");
        expect(s.run).toMatch(/bun run scripts\/ci\/publication-review\.ts review/);
      }
    }
    expect(SRC).not.toMatch(/\$RUNNER_TEMP\/repo\/(?!\.git)[^\s"']*\.(sh|ts|js|py)/);
  });
});

describe("failure and logging", () => {
  test("the failure reporter needs nothing the job may have failed to install", () => {
    // Written by the validate step, which has already run when any later step fails.
    expect(step("Validate the dispatch").run).toContain('chmod +x "$RUNNER_TEMP/report-error.sh"');
    expect(REPORTER).toContain("curl ");
    expect(REPORTER).not.toMatch(/\b(bun|node|npm|npx|python|gh)\b/);
    expect(REPORTER).toContain('"outcome\\":\\"error\\"');
    expect(REPORTER).toContain('-H "X-Webhook-Token: $PUBLICATION_REVIEW_CALLBACK_TOKEN"');
    expect(REPORTER).toContain("%{http_code}");
    const last = job.steps[job.steps.length - 1];
    expect(last?.run).toContain('"$RUNNER_TEMP/report-error.sh" workflow_failed');
  });

  test("the words the workflow reports are words a job may post, and arrive as themselves", () => {
    let seen = 0;
    for (const s of job.steps) {
      for (const m of (s.run ?? "").matchAll(/report-error\.sh"\s+([a-z_]+)/g)) {
        const word = m[1] as string;
        seen++;
        expect(isPublicationRunError(word), `${s.name}: ${word}`).toBe(true);
        expect((WORKER_ONLY_RUN_ERRORS as readonly string[]).includes(word), word).toBe(false);
        expect(
          parsePublicationCallbackOutcome({ outcome: "error", report: undefined, error: word }),
        ).toEqual({ kind: "error", error: word as never });
      }
    }
    expect(seen).toBe(2);
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
            /callback_token|CALLBACK_TOKEN|GH_TOKEN|\$auth|\$\{auth\}/,
          );
        }
      }
      expect(run).not.toMatch(/\bset -x\b/);
      expect(run).not.toMatch(/cat\s+[^\n]*(bids-runs|tags\.txt|anthropic-oidc)/);
    }
  });

  test("a job cannot run for ever, and ends before the Worker gives up on it", () => {
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(30);
    expect(job["timeout-minutes"]).toBeLessThan(PUBLICATION_REVIEW_DEADLINE_MINUTES);
  });
});

// ---------------------------------------------------------------------------------------------
// The shell steps, run for real
// ---------------------------------------------------------------------------------------------

/**
 * The structure tests above prove what the file says; these prove what it does. The validate,
 * claim, fetch, validation-run and reporter steps are plain bash, curl and git, so they run here
 * exactly as Actions would run them (`bash -e`), against a real HTTP server standing in for the
 * Worker, a real git repository standing in for the dataset's remote, and a `gh` stand-in on the PATH
 * (the GitHub boundary). The heredoc that writes the reporter lives inside a YAML block scalar,
 * which is the kind of thing that parses and then does not run.
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
  beforeEach(() => {
    seen.length = 0;
    answer = 200;
  });

  const GOOD = {
    DATASET_ID: "nm000108",
    REQUEST_ID: "12",
    HEAD_SHA: "a".repeat(40),
    REVIEW_ID: "77",
    ANONYMOUS: "false",
    ENVIRONMENT: "production",
    PUBLICATION_REVIEW_CALLBACK_TOKEN: "token-for-the-test",
  };

  async function runStepScript(name: string, env: Record<string, string>, into?: string) {
    const dir = into ?? mkdtempSync(join(tmpdir(), "publication-review-step-"));
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
    for (const anonymous of ["true", "false"]) {
      const r2 = await runStepScript("Validate the dispatch", { ...GOOD, ANONYMOUS: anonymous });
      expect(r2.status, anonymous).toBe(0);
    }
  });

  test.each([
    ["DATASET_ID", "nm000108/../../x"],
    ["DATASET_ID", 'nm000108"; touch pwned; "'],
    ["DATASET_ID", "nm00010"],
    ["REQUEST_ID", "1; id"],
    ["REQUEST_ID", ""],
    ["REQUEST_ID", "1234567890123"],
    ["REVIEW_ID", "7 7"],
    ["REVIEW_ID", ""],
    ["HEAD_SHA", "A".repeat(40)],
    ["HEAD_SHA", `${"a".repeat(39)}\n`],
    ["HEAD_SHA", "a".repeat(39)],
    ["ANONYMOUS", "yes"],
    ["ANONYMOUS", "True"],
    ["ANONYMOUS", ""],
    ["ANONYMOUS", "false; id"],
    ["ENVIRONMENT", "staging"],
    ["ENVIRONMENT", "production\ndev"],
    ["PUBLICATION_REVIEW_CALLBACK_TOKEN", ""],
  ])("validate: %s=%j is refused and chooses no origin", async (key, value) => {
    const r = await runStepScript("Validate the dispatch", { ...GOOD, [key]: value });
    expect(r.status).not.toBe(0);
    expect(r.envFile).toBe("");
    expect(existsSync(join(r.dir, "pwned"))).toBe(false);
  });

  /** Hand the claim step the stand-in's origin as the real job would see it. */
  async function claim(token = GOOD.PUBLICATION_REVIEW_CALLBACK_TOKEN) {
    return runStepScript("Claim the review", {
      ...GOOD,
      PUBLICATION_REVIEW_CALLBACK_TOKEN: token,
      ORIGIN: LOCAL_ORIGIN,
    });
  }

  test("claim: HTTP 200 is claimed, and the Worker is sent exactly what its door reads", async () => {
    const r = await claim();
    expect(r.status).toBe(0);
    expect(r.output).toBe("claimed=true\n");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.path).toBe("/webhooks/publication-review-claim");
    expect(seen[0]?.token).toBe(GOOD.PUBLICATION_REVIEW_CALLBACK_TOKEN);
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({ review_id: 77, dataset_id: "nm000108" });
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
    expect(seen[0]?.token).toBe("a-token-that-must-not-print");
    expect(r.stdout + r.stderr).not.toContain("a-token-that-must-not-print");
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
        PUBLICATION_REVIEW_CALLBACK_TOKEN: GOOD.PUBLICATION_REVIEW_CALLBACK_TOKEN,
      },
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { exitCode, stdout };
  }

  test("reporter: posts the closed-vocabulary error the Worker's parser accepts", async () => {
    const r = await report("workflow_failed");
    expect(r.exitCode).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe("/webhooks/publication-review-result");
    expect(seen[0]?.token).toBe(GOOD.PUBLICATION_REVIEW_CALLBACK_TOKEN);
    const body = JSON.parse(seen[0]?.body ?? "");
    expect(body).toEqual({
      review_id: 77,
      dataset_id: "nm000108",
      outcome: "error",
      error: "workflow_failed",
    });
    expect(parsePublicationCallbackOutcome(body)).toEqual({
      kind: "error",
      error: "workflow_failed",
    });
    // And says what the Worker answered, with no token in it.
    expect(r.stdout).toBe("review 77: reported workflow_failed (HTTP 200)\n");
  });

  test("reporter: a report the Worker refuses is visible in the log, and does not fail the step", async () => {
    answer = 401;
    const r = await report("workflow_failed");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("(HTTP 401)");
    expect(r.stdout).not.toContain(GOOD.PUBLICATION_REVIEW_CALLBACK_TOKEN);
  });

  test("reporter: auth_failed is also accepted, and a dead Worker does not fail the step", async () => {
    await report("auth_failed");
    expect(parsePublicationCallbackOutcome(JSON.parse(seen[0]?.body ?? ""))).toEqual({
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

  // -------------------------------------------------------------------------------------------
  // The fetch, the validation runs, and the script's arguments: the chain the job really runs
  // -------------------------------------------------------------------------------------------

  /**
   * An empty repository standing in for a dataset's remote: `main`, with the filter capability the
   * hosting service has. `put` writes a file (creating its directories), `run` is the real git.
   */
  function servedRepo(prefix: string) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    };
    const run = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8", env }).trim();
    run("init", "-q", "-b", "main");
    run("config", "uploadpack.allowFilter", "true");
    run("config", "uploadpack.allowAnySHA1InWant", "true");
    const put = (rel: string, text: string) => {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    };
    put(
      "dataset_description.json",
      JSON.stringify({
        Name: "Resting EEG of healthy volunteers, eyes open and closed",
        BIDSVersion: "1.9.0",
        Version: "1.0.0",
        License: "CC0",
        Authors: ["Ada Lovelace"],
        EthicsApprovals: ["IRB 2024-0001, University X"],
      }),
    );
    return { dir, run, put };
  }

  /** A dataset repository as GitHub would serve it: `main`, with an annotated tag and a later commit. */
  function servedDataset() {
    const { dir, run, put } = servedRepo("publication-review-remote-");
    put("README.md", "# Resting EEG\nTwelve volunteers at rest.\n");
    put("sub-01/eeg/sub-01_task-rest_eeg.edf", "recording");
    put(
      "sub-01/eeg/sub-01_task-rest_eeg.json",
      JSON.stringify({ SamplingFrequency: 250, EEGChannelCount: 8 }),
    );
    run("add", ".");
    run("commit", "-q", "-m", "first");
    const first = run("rev-parse", "HEAD");
    run("tag", "-a", "v1.0.0", "-m", "release one");
    put("CHANGES", "1.0.1 later\n");
    run("add", ".");
    run("commit", "-q", "-m", "main moved on");
    return { dir, first, mainTip: run("rev-parse", "HEAD") };
  }

  function fetchEnv(remote: { dir: string }, over: Record<string, string> = {}) {
    return {
      ...GOOD,
      GH_TOKEN: "ghs_read_only_for_the_test",
      // Stand in for github.com: the step's URL is rewritten to the local repository.
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.file://${remote.dir}.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/nemarDatasets/nm000108.git",
      ...over,
    };
  }

  test("fetch: main's tip is fetched shallow and blob-less, as git data, with no working tree", async () => {
    const remote = servedDataset();
    const r = await runStepScript(FETCH, fetchEnv(remote));
    expect(r.status, r.stderr).toBe(0);
    const out = Object.fromEntries(
      r.output
        .trim()
        .split("\n")
        .map((l) => l.split("=")),
    );
    expect(Object.keys(out)).toEqual(["fetched"]);
    // `fetched` is main's CURRENT tip, which is not the commit the tag names.
    expect(out.fetched).toBe(remote.mainTip);
    expect(out.fetched).not.toBe(remote.first);
    const repo = join(r.dir, "repo");
    // Nothing was checked out: the only entry is .git, so no hook, filter or script can run.
    expect(readdirSync(repo)).toEqual([".git"]);
    expect(existsSync(join(repo, ".git", "shallow"))).toBe(true);
    // The clone is blob-less (apart from the blobs the review reads, fetched below) and holds NO
    // credential: the read-only token is given to each git command that needs it and written nowhere.
    const cfg = readFileSync(join(repo, ".git", "config"), "utf8");
    expect(cfg).toContain("partialClone = origin");
    expect(cfg).toContain("hooksPath = /dev/null");
    expect(cfg).not.toMatch(/extraheader|AUTHORIZATION|ghs_read_only/i);
    // The token does not appear in the log.
    expect(r.stdout + r.stderr).not.toContain("ghs_read_only_for_the_test");
  });

  test("fetch: the tags file is real ls-remote output, and its annotated tag reads as a tag at the first commit", async () => {
    const remote = servedDataset();
    const r = await runStepScript(FETCH, fetchEnv(remote));
    expect(r.status, r.stderr).toBe(0);
    const tags = readFileSync(join(r.dir, "tags.txt"), "utf8");
    expect(tags).toContain("refs/tags/v1.0.0\n");
    expect(tags).toContain("refs/tags/v1.0.0^{}\n");
    expect(tagState(tags, "1.0.0", remote.first)).toBe("at_head");
    expect(tagState(tags, "1.0.0", remote.mainTip)).toBe("elsewhere");
  });

  test("fetch: a repository with no main fails the step instead of reviewing something else", async () => {
    const remote = servedDataset();
    execFileSync("git", ["-C", remote.dir, "branch", "-m", "main", "trunk"]);
    const r = await runStepScript(FETCH, fetchEnv(remote));
    expect(r.status).not.toBe(0);
    expect(r.output).not.toContain("fetched=");
  });

  /**
   * `git`, `perl`, `sort` and `base64` on the PATH that record, for each call, the command, whether
   * `GH_TOKEN` was in its environment, and (for git, whose arguments are one line) its arguments and
   * the `GIT_CONFIG_*` environment it was started with; each then runs the real command. The
   * credential travels as `GIT_CONFIG_*` variables of one git command, so this is what shows which
   * commands were given it and which of the step's commands could have read the environment variable.
   */
  function commandSpy() {
    const dir = mkdtempSync(join(tmpdir(), "publication-review-spy-"));
    const log = join(dir, "calls.txt");
    const where = (name: string) =>
      execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
    // The recorder sorts too, and must not call its own spy.
    const realSort = where("sort");
    for (const name of ["git", "perl", "sort", "base64"]) {
      const real = where(name);
      const args = name === "git" ? '"$*"' : '""';
      writeFileSync(
        join(dir, name),
        [
          "#!/usr/bin/env bash",
          // One write of one line: the commands of a pipeline start together, and a record built
          // by several writes would be torn by its neighbour's.
          `line="$({ printf '%s\\t%s\\t' "${name}" ${args}; env | grep '^GIT_CONFIG_' | ${realSort} | tr '\\n' ' '; printf '\\t'; if [ -n "\${GH_TOKEN+x}" ]; then printf 'GH_TOKEN'; fi; })"`,
          `printf '%s\\n' "$line" >> "${log}"`,
          `exec "${real}" "$@"`,
          "",
        ].join("\n"),
      );
      chmodSync(join(dir, name), 0o755);
    }
    const calls = () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((l) => {
          const [tool, args, env, token] = l.split("\t") as [string, string, string, string];
          return { tool, args, env, hasToken: token === "GH_TOKEN" };
        });
    return { dir, calls };
  }
  const TOKEN = "ghs_read_only_for_the_test";
  const AUTH = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");

  test("fetch: the credential is given to the three git commands that need it, through their own environment, and to no other", async () => {
    const remote = servedDataset();
    const spy = commandSpy();
    const r = await runStepScript(
      FETCH,
      fetchEnv(remote, { PATH: `${spy.dir}:${process.env.PATH ?? ""}` }),
    );
    expect(r.status, r.stderr).toBe(0);
    const calls = spy.calls();
    const gitCalls = calls.filter((c) => c.tool === "git");
    const withCredential = gitCalls.filter((c) => c.env.includes(`AUTHORIZATION: basic ${AUTH}`));
    // The tree fetch, the tag listing and the one fetch of the blobs the review reads.
    expect(
      withCredential.map((c) => c.args.split(" ").find((a) => ["fetch", "ls-remote"].includes(a))),
    ).toEqual(["fetch", "ls-remote", "fetch"]);
    for (const c of withCredential) {
      expect(c.env).toContain("GIT_CONFIG_KEY_1=http.https://github.com/.extraheader");
      // The caller's own GIT_CONFIG_* entry (here the URL rewrite standing in for github.com) is kept.
      expect(c.env).toContain("GIT_CONFIG_COUNT=2");
      expect(c.env).toContain("GIT_CONFIG_KEY_0=url.file://");
    }
    // Every other call (init, config, remote, rev-parse, ls-tree) had none of it.
    for (const c of gitCalls.filter((x) => !withCredential.includes(x))) {
      expect(c.env, c.args).not.toMatch(/extraheader|AUTHORIZATION/);
      expect(c.args, c.args).not.toMatch(/extraheader|AUTHORIZATION|ghs_/);
    }
    // And never on a command line, where any process can read it.
    for (const c of calls) expect(c.args).not.toMatch(/AUTHORIZATION|ghs_|x-access-token/);

    // `GH_TOKEN` is the step's own input, read once to make the header: after that no command the
    // step starts has it in its environment, the credentialed git commands included (they get the
    // header, not the token), and neither do the commands that select the blobs or encode the header.
    expect(new Set(calls.map((c) => c.tool))).toEqual(new Set(["git", "perl", "sort", "base64"]));
    expect(calls.filter((c) => c.hasToken)).toEqual([]);
  });

  test("fetch: nothing of the credential is written anywhere in the repository, or left in what the step wrote", async () => {
    const remote = servedDataset();
    const r = await runStepScript(FETCH, fetchEnv(remote));
    expect(r.status, r.stderr).toBe(0);
    const needles = [TOKEN, AUTH, "AUTHORIZATION", "extraheader", "x-access-token"];
    const seenFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else {
          seenFiles.push(path);
          const text = readFileSync(path).toString("latin1");
          for (const needle of needles)
            expect(text.includes(needle), `${path} holds ${needle}`).toBe(false);
        }
      }
    };
    walk(join(r.dir, "repo"));
    // The scan is not vacuous: it read the configuration and the object store.
    expect(seenFiles.some((f) => f.endsWith(join(".git", "config")))).toBe(true);
    expect(seenFiles.length).toBeGreaterThan(10);
    for (const name of ["tags.txt", "output", "env"]) {
      const text = readFileSync(join(r.dir, name), "utf8");
      for (const needle of needles)
        expect(text.includes(needle), `${name} holds ${needle}`).toBe(false);
    }
  });

  test("fetch: the names, patterns and sample size it selects by are the review script's own", () => {
    // The behavior is held by the tests that run the step over a repository and compare what it
    // fetched with `blobsToRead`; these pin the words and numbers the shell spells for itself.
    const run = step(FETCH).run ?? "";
    expect(run).toContain("git ls-tree -r -z --full-tree");
    const perl = run.slice(run.indexOf("perl -0ne"));
    const lists = [...perl.matchAll(/qw\(([^)]*)\)/g)].map((m) =>
      (m[1] as string).trim().split(/\s+/),
    );
    // The README forms in the order the reader chooses the first present, then the other documents.
    expect(lists).toHaveLength(2);
    expect(lists[0]).toEqual([...README_CANDIDATES]);
    expect([...(lists[1] ?? [])].sort()).toEqual(
      [
        ...CHANGES_CANDIDATES,
        ...LICENSE_CANDIDATES,
        "dataset_description.json",
        PARTICIPANTS_JSON,
      ].sort(),
    );
    // The raw-tree and sidecar patterns, as the reader spells them (`$` is `\z` in perl, which does
    // not stop before a final newline as `$` does), and the sample size.
    expect(perl).toContain(`m{${NOT_RAW.source.replaceAll("\\/", "/")}}`);
    expect(perl).toContain(`m{${DATA_SIDECAR.source.replace(/\$$/, "\\z")}}`);
    expect(perl).toContain(`$n <= ${SIDECAR_SAMPLE}`);
    expect(perl).toContain(`$_ * $n / ${SIDECAR_SAMPLE}`);
    expect(perl).toContain(`0 .. ${SIDECAR_SAMPLE - 1}`);
  });

  /** A dataset with many data sidecars, some in places the review never reads. */
  function servedBigDataset(count: number) {
    const { dir, run, put } = servedRepo("publication-review-big-remote-");
    put("README.md", "# Resting EEG\nVolunteers at rest.\n");
    put("CHANGES", "1.0.0 first\n");
    put("LICENSE", "CC0\n");
    put("participants.json", JSON.stringify({ age: { Description: "Age", Units: "years" } }));
    put("participants.tsv", "participant_id\tage\nsub-0001\t30\n");
    for (let i = 0; i < count; i++) {
      const sub = `sub-${String(i).padStart(4, "0")}`;
      put(
        `${sub}/eeg/${sub}_task-rest_eeg.json`,
        JSON.stringify({ SamplingFrequency: 250, EEGChannelCount: 8, Index: i }),
      );
    }
    // Sidecars the review never reads: outside the raw tree, and by other names.
    for (const where of ["derivatives/pipe", "sourcedata", "code"]) {
      put(`${where}/sub-0001/eeg/sub-0001_task-rest_eeg.json`, JSON.stringify({ Where: where }));
    }
    put("sub-0001/eeg/sub-0001_task-rest_channels.json", JSON.stringify({ Other: "channels" }));
    put("task-rest_eeg.json", JSON.stringify({ TopLevel: "inherited" }));
    // An annexed sidecar is a symlink: the review never reads it, so it is never fetched.
    mkdirSync(join(dir, "sub-0000", "eeg"), { recursive: true });
    symlinkSync(
      "../../.git/annex/objects/Xz/pQ/SHA256E-s9--0123456789abcdef.json/SHA256E-s9--0123456789abcdef.json",
      join(dir, "sub-0000", "eeg", "sub-0000_task-rest_ieeg.json"),
    );
    run("add", ".");
    run("commit", "-q", "-m", "first");
    return { dir, head: run("rev-parse", "HEAD") };
  }

  /** Every blob the clone holds, by object id, asked without any lazy fetch. */
  function localBlobs(repo: string): string[] {
    return execFileSync(
      "git",
      ["-C", repo, "cat-file", "--batch-all-objects", "--batch-check=%(objecttype) %(objectname)"],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "", GIT_NO_LAZY_FETCH: "1" } },
    )
      .split("\n")
      .filter((l) => l.startsWith("blob "))
      .map((l) => l.slice("blob ".length))
      .sort();
  }

  test("fetch: the blobs the review reads are fetched, exactly those, so that nothing later needs the credential", async () => {
    const count = 150;
    const remote = servedBigDataset(count);
    const r = await runStepScript(FETCH, fetchEnv(remote));
    expect(r.status, r.stderr).toBe(0);
    const repo = join(r.dir, "repo");
    const tree = await readTree(repo, remote.head);
    // The reader's own selection, which the readers below then find already in the clone.
    const wanted = blobsToRead(tree);
    // Five root documents (README.md, dataset_description.json, CHANGES, LICENSE, participants.json)
    // and the 64 sidecars the review samples: not the 150, and none of the other sidecars or files.
    expect(wanted).toHaveLength(5 + 64);
    expect(localBlobs(repo)).toEqual(wanted);

    // Now cut the clone off from every remote and run the review's own readers over it: whatever
    // they ask for must already be there.
    execFileSync("git", ["-C", repo, "config", "remote.origin.url", "file:///nonexistent/remote"]);
    const docs = readRootDocuments(repo, tree);
    for (const name of [
      "readme",
      "dataset_description",
      "changes",
      "license",
      "participants_json",
    ] as const) {
      expect(docs[name].state, name).toBe("present");
    }
    const summary = structuralSummary(repo, tree);
    // The top-level inherited sidecar matches the review's pattern too, so there is one more.
    expect(summary.sidecars_total).toBe(count + 1);
    expect(summary.sidecars_read).toBe(64);
  }, 20_000);

  /**
   * File names git would print quoted and escaped without `-z`: a non-ASCII letter, a double
   * quote, a tab, a backslash and a newline. Each is a data sidecar of the raw tree, with content of
   * its own (identical content would be one blob, and the comparison below would prove nothing).
   */
  const AWKWARD_SIDECARS = [
    "sub-01/eeg/sub-01_task-caf\u00e9_eeg.json",
    'sub-02/eeg/sub-02_task-"q"_eeg.json',
    "sub-03/eeg/sub-03_task-a\tb_eeg.json",
    "sub-04/eeg/sub-04_task-a\\b_eeg.json",
    "sub-05/eeg/sub-05_task-a\nb_eeg.json",
  ];

  function servedAwkwardDataset(ordinary: number) {
    const { dir, run, put } = servedRepo("publication-review-awkward-remote-");
    put("README.md", "# Resting EEG\nVolunteers at rest.\n");
    for (const rel of AWKWARD_SIDECARS)
      put(rel, JSON.stringify({ Which: rel, SamplingFrequency: 250 }));
    // Not a sidecar: the name ends in a newline after `.json`. `$` in a perl pattern would match
    // before it, and the reader's pattern does not, which is why the step ends the pattern with `\z`.
    put("sub-06/eeg/sub-06_task-x_eeg.json\n", JSON.stringify({ Which: "trailing newline" }));
    for (let i = 0; i < ordinary; i++) {
      const sub = `sub-9${String(i).padStart(3, "0")}`;
      put(`${sub}/eeg/${sub}_task-rest_eeg.json`, JSON.stringify({ Index: i }));
    }
    run("add", ".");
    run("commit", "-q", "-m", "first");
    return { dir, head: run("rev-parse", "HEAD") };
  }

  test("fetch: a path git would quote is selected as the reader selects it, whole and in the same place of the sample", async () => {
    // 70 ordinary sidecars and the five awkward ones: more than the sample takes, so a sidecar the
    // step does not see also moves every position after it.
    for (const ordinary of [70, 0]) {
      const remote = servedAwkwardDataset(ordinary);
      const r = await runStepScript(FETCH, fetchEnv(remote));
      expect(r.status, r.stderr).toBe(0);
      const repo = join(r.dir, "repo");
      const tree = await readTree(repo, remote.head);
      expect(tree.entries.map((e) => e.path)).toEqual(expect.arrayContaining(AWKWARD_SIDECARS));
      expect(structuralSummary(repo, tree).sidecars_total).toBe(ordinary + AWKWARD_SIDECARS.length);
      expect(localBlobs(repo), `${ordinary} ordinary sidecars`).toEqual(blobsToRead(tree));
      // The description, the README and every sidecar: all of them, when there are fewer than 64.
      if (ordinary === 0) expect(localBlobs(repo)).toHaveLength(2 + AWKWARD_SIDECARS.length);
    }
  }, 20_000);

  test("fetch: of several README forms only the one the reader opens is fetched, and a symlinked one is never opened", async () => {
    const both = servedRepo("publication-review-readmes-remote-");
    both.put("README.md", "# the one the reader opens\n");
    both.put("README.txt", "# a second form, never opened\n");
    both.run("add", ".");
    both.run("commit", "-q", "-m", "first");
    const linked = servedRepo("publication-review-readmes-linked-remote-");
    symlinkSync(
      "../.git/annex/objects/Xz/pQ/SHA256E-s9--0123456789abcdef.md/SHA256E-s9--0123456789abcdef.md",
      join(linked.dir, "README.md"),
    );
    linked.put("README.txt", "# the reader opens README.md first, finds it annexed, and stops\n");
    linked.run("add", ".");
    linked.run("commit", "-q", "-m", "first");
    // The description and the one README the reader opens; then the description alone, because the
    // reader finds README.md annexed and never looks at README.txt.
    for (const [remote, expected] of [
      [both, 2],
      [linked, 1],
    ] as const) {
      const r = await runStepScript(FETCH, fetchEnv(remote));
      expect(r.status, r.stderr).toBe(0);
      const repo = join(r.dir, "repo");
      const tree = await readTree(repo, remote.run("rev-parse", "HEAD"));
      expect(blobsToRead(tree)).toHaveLength(expected);
      expect(localBlobs(repo)).toEqual(blobsToRead(tree));
    }
  }, 20_000);

  test("fetch: a dataset with fewer than 64 sidecars has every one of them, and one with few still fetches its documents", async () => {
    const small = servedBigDataset(7);
    const r = await runStepScript(FETCH, fetchEnv(small));
    expect(r.status, r.stderr).toBe(0);
    const repo = join(r.dir, "repo");
    execFileSync("git", ["-C", repo, "config", "remote.origin.url", "file:///nonexistent/remote"]);
    const tree = await readTree(repo, small.head);
    expect(structuralSummary(repo, tree).sidecars_read).toBe(8);

    const none = servedBigDataset(0);
    const r2 = await runStepScript(FETCH, fetchEnv(none));
    expect(r2.status, r2.stderr).toBe(0);
    const repo2 = join(r2.dir, "repo");
    execFileSync("git", ["-C", repo2, "config", "remote.origin.url", "file:///nonexistent/remote"]);
    const docs = readRootDocuments(repo2, await readTree(repo2, none.head));
    expect(docs.readme.state).toBe("present");
  });

  /** A `gh` on the PATH that stands in for the GitHub boundary: it records its arguments. */
  function ghShim(behaviour: "ok" | "fail", body = "{}") {
    const dir = mkdtempSync(join(tmpdir(), "publication-review-gh-"));
    const log = join(dir, "calls.txt");
    const script =
      behaviour === "ok"
        ? `#!/usr/bin/env bash\necho "$@" >> "${log}"\ncat <<'JSON'\n${body}\nJSON\n`
        : `#!/usr/bin/env bash\necho "$@" >> "${log}"\necho "HTTP 502" >&2\nexit 1\n`;
    const path = join(dir, "gh");
    writeFileSync(path, script);
    chmodSync(path, 0o755);
    return { dir, log };
  }

  test("validation runs: the stand-in's answer is kept, and the query names the dataset and the commit", async () => {
    const runs = JSON.stringify({
      workflow_runs: [
        {
          id: 9,
          status: "completed",
          conclusion: "success",
          head_sha: GOOD.HEAD_SHA,
          created_at: "2026-10-01T00:00:00Z",
        },
      ],
    });
    const shim = ghShim("ok", runs);
    const r = await runStepScript(BIDS, {
      ...GOOD,
      GH_TOKEN: "ghs_read_only_for_the_test",
      PATH: `${shim.dir}:${process.env.PATH ?? ""}`,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(shim.log, "utf8").trim()).toBe(
      `api repos/nemarDatasets/nm000108/actions/workflows/bids-validation.yml/runs?head_sha=${GOOD.HEAD_SHA}&per_page=10`,
    );
    const kept = readFileSync(join(r.dir, "bids-runs.json"), "utf8");
    expect(bidsState(kept, GOOD.HEAD_SHA)).toBe("pass");
    expect(r.stdout + r.stderr).not.toContain("ghs_read_only_for_the_test");
  });

  test("validation runs: a lookup that fails, or no gh at all, leaves an unreadable-runs file and does not fail the step", async () => {
    const shim = ghShim("fail");
    const failed = await runStepScript(BIDS, {
      ...GOOD,
      GH_TOKEN: "x",
      PATH: `${shim.dir}:${process.env.PATH ?? ""}`,
    });
    expect(failed.status).toBe(0);
    const kept = readFileSync(join(failed.dir, "bids-runs.json"), "utf8");
    expect(JSON.parse(kept)).toEqual({ unavailable: true });
    expect(bidsState(kept, GOOD.HEAD_SHA)).toBe("unknown");

    // With no gh on the PATH the shell cannot even start it, which is the same answer.
    const bareDir = mkdtempSync(join(tmpdir(), "publication-review-bare-"));
    for (const tool of ["bash", "echo", "cat"]) {
      const found = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
      if (found.startsWith("/")) execFileSync("ln", ["-s", found, join(bareDir, tool)]);
    }
    const missing = await runStepScript(BIDS, { ...GOOD, GH_TOKEN: "x", PATH: bareDir });
    expect(missing.status).toBe(0);
    expect(JSON.parse(readFileSync(join(missing.dir, "bids-runs.json"), "utf8"))).toEqual({
      unavailable: true,
    });
  });

  // The anthropic stand-in for the chain test below. The real SDK speaks to it.
  let modelServer: ReturnType<typeof Bun.serve>;
  const modelRequests: string[] = [];
  const SDK_KEYS = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_PROFILE",
    "ANTHROPIC_FEDERATION_RULE_ID",
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
  ];
  const savedSdk: Record<string, string | undefined> = {};
  beforeAll(() => {
    modelServer = Bun.serve({
      port: 0,
      async fetch(req) {
        modelRequests.push(await req.text());
        return Response.json({
          id: "msg_stand_in",
          type: "message",
          role: "assistant",
          model: "claude-haiku-5-5",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                questions: {
                  complete_and_honest: "pass",
                  meets_standards: "pass",
                  authors_and_license: "pass",
                  name_adequate: "pass",
                },
                findings: [],
                summary: "A dataset.",
                steering: false,
              }),
            },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 },
        });
      },
    });
    for (const k of SDK_KEYS) {
      savedSdk[k] = process.env[k];
      delete process.env[k];
    }
    process.env.ANTHROPIC_API_KEY = "sk-ant-stand-in";
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${modelServer.port}`;
  });
  afterAll(() => {
    server.stop(true);
    modelServer.stop(true);
    for (const k of SDK_KEYS) {
      if (savedSdk[k] === undefined) delete process.env[k];
      else process.env[k] = savedSdk[k];
    }
  });

  test("the chain: the fetch step's output, the validation-runs step's output and the Review step's own arguments run the script end to end", async () => {
    const remote = servedDataset();
    // One runner temp directory for the whole chain, as on a runner.
    const temp = mkdtempSync(join(tmpdir(), "publication-review-chain-"));
    const fetched = await runStepScript(FETCH, fetchEnv(remote), temp);
    expect(fetched.status, fetched.stderr).toBe(0);
    // The review needs no remote: what it reads was fetched by the fetch step, so the clone is cut off
    // from every remote here, and a blob that was not fetched would be a failed read.
    execFileSync("git", [
      "-C",
      join(temp, "repo"),
      "config",
      "remote.origin.url",
      "file:///nonexistent/remote",
    ]);
    const shim = ghShim("ok", JSON.stringify({ workflow_runs: [] }));
    await runStepScript(
      BIDS,
      { ...GOOD, GH_TOKEN: "x", PATH: `${shim.dir}:${process.env.PATH ?? ""}` },
      temp,
    );

    // The arguments are read out of the workflow's own Review step, so a flag renamed on either
    // side (the file or the script) fails here rather than on a runner.
    const fetchedSha = Object.fromEntries(
      fetched.output
        .trim()
        .split("\n")
        .map((l) => l.split("=")),
    ).fetched as string;
    const values: Record<string, string> = {
      RUNNER_TEMP: temp,
      HEAD_SHA: remote.mainTip,
      FETCHED_SHA: fetchedSha,
      REVIEW_ID: "77",
      REQUEST_ID: "12",
      DATASET_ID: "nm000108",
      ANONYMOUS: "false",
      ENVIRONMENT: "dev",
    };
    const argv = ["review"];
    for (const m of (step("Review").run ?? "").matchAll(/--([a-z-]+) "\$(\w+)(\/[\w.-]+)?"/g)) {
      const value = values[m[2] as string];
      expect(value, `${m[1]}: ${m[2]}`).toBeDefined();
      argv.push(`--${m[1]}`, `${value}${m[3] ?? ""}`);
    }
    expect(argv.filter((a) => a.startsWith("--"))).toHaveLength(10);

    process.env.PUBLICATION_REVIEW_CALLBACK_TOKEN = "chain-token";
    const lines: string[] = [];
    const original = { log: console.log, error: console.error };
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    let code: number;
    try {
      code = await main(argv, { production: LOCAL_ORIGIN, dev: LOCAL_ORIGIN });
    } finally {
      Object.assign(console, original);
      Reflect.deleteProperty(process.env, "PUBLICATION_REVIEW_CALLBACK_TOKEN");
    }
    expect(code, lines.join("\n")).toBe(0);
    expect(lines).toEqual(["review 77 (request 12): reported; callback delivered"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe("/webhooks/publication-review-result");
    expect(seen[0]?.token).toBe("chain-token");
    const body = JSON.parse(seen[0]?.body ?? "");
    expect(body).toMatchObject({ review_id: 77, dataset_id: "nm000108", outcome: "reported" });
    // What the job read from the blob-less clone is what the report says and the model was shown.
    expect(body.report.evidence).toMatchObject({
      head: remote.mainTip,
      version: "1.0.0",
      // The tag v1.0.0 names the FIRST commit and main has moved on, so the version is taken.
      tag: "elsewhere",
      bids: "unconcluded",
      summary: { subjects: 1, recordings: 1, sampling_rates_hz: [250], channel_counts: [8] },
    });
    expect(modelRequests).toHaveLength(1);
    expect(modelRequests[0]).toContain("Twelve volunteers at rest");
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// Drift against the deployed copy
// ---------------------------------------------------------------------------------------------

const LIVE_ENV_VAR = "NEMAR_PUBLICATION_REVIEW_WORKFLOW_LIVE";
const declaredRaw = process.env[LIVE_ENV_VAR];
const DECLARED =
  declaredRaw && declaredRaw.trim() !== ""
    ? isAbsolute(declaredRaw)
      ? declaredRaw
      : join(REPO_ROOT, declaredRaw)
    : null;
const SIBLINGS = [
  join(REPO_ROOT, "..", ".github", ".github", "workflows", "run-publication-review.yml"),
  join(REPO_ROOT, "..", "dot-github", ".github", "workflows", "run-publication-review.yml"),
  join(REPO_ROOT, "..", "..", ".github", ".github", "workflows", "run-publication-review.yml"),
];
const found = DECLARED ?? SIBLINGS.find((p) => existsSync(p)) ?? null;

describe("the deployed copy", () => {
  test("the authoring copy says where it is deployed, and that its script runs from main", () => {
    expect(SRC).toContain(
      "Deploy to: nemarDatasets/.github/.github/workflows/run-publication-review.yml",
    );
    expect(SRC).toContain("THE SCRIPT RUNS FROM MAIN, AND MUST BE RELEASED FIRST");
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
          `run-publication-review.yml has drifted from nemarDatasets/.github (first difference at line ${
            i + 1
          }). The deploy is a whole-file copy, so any difference is a difference in what runs.`,
        );
      }
      expect(SRC).toBe(live);
    });
  });
});
