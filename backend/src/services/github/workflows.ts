/**
 * CI workflow management on dataset repos: the canonical workflow templates,
 * deploy/validate/sync of deployed workflows, and workflow run/presence
 * checks.
 *
 * Moved verbatim from services/github.ts (#906, epic #902); the only
 * intentional changes are import paths.
 */

import { HttpError } from "../retry";
import { type TreeFile, commitFilesAsTree, getFileContent } from "./contents";
import { GITHUB_API, ORG_NAME, VALIDATOR_VERSION } from "./shared";
import { githubFetchWithRetry } from "./transport";

interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  html_url: string;
}

/**
 * Check if a workflow file exists in a repository.
 * Returns true if file exists, false if 404, throws on other errors.
 */
export async function checkWorkflowExists(
  repo: string,
  workflowPath: string,
  pat: string,
): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}/contents/${workflowPath}`, {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
      },
    });
  } catch (fetchError) {
    const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
    throw new Error(`Network error checking workflow: ${msg}`);
  }

  if (response.ok) return true;
  if (response.status === 404) return false;
  throw new Error(`GitHub API error (${response.status}) checking workflow: ${workflowPath}`);
}

/**
 * Get the latest workflow runs for a specific workflow file.
 * Throws on API errors; returns empty array only when no runs exist.
 */
export async function getWorkflowRuns(
  repo: string,
  workflowFile: string,
  pat: string,
): Promise<WorkflowRun[]> {
  let response: Response;
  try {
    response = await fetch(
      `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/actions/workflows/${workflowFile}/runs?per_page=5`,
      {
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "NEMAR-API",
        },
      },
    );
  } catch (fetchError) {
    const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
    throw new Error(`Network error fetching workflow runs: ${msg}`);
  }

  if (!response.ok) {
    throw new Error(`GitHub API error (${response.status}) fetching runs for ${workflowFile}`);
  }

  const data = await response.json<{ workflow_runs: WorkflowRun[] }>();
  return data.workflow_runs ?? [];
}

/**
 * Bash for the `version-check` workflow's core assertion (epic #713, phase #718):
 * the PR's `Version` must be valid semver `X.Y.Z` AND a strict increment over
 * `main`'s version. Reads `$PR_VERSION` and `$MAIN_VERSION` from the env (the
 * workflow extracts them with jq); exits 1 with a `::error::` on a bad/equal/
 * downgraded version. A non-semver `$MAIN_VERSION` (e.g. a first version, where
 * main has no `Version` field) is treated as `0.0.0`. Exported so the exact
 * script is run in tests (`backend/test/version-check.test.ts`).
 *
 * Pure field comparison (no `sort -V`) so it is portable across the GitHub
 * ubuntu runner and local test shells.
 */
export const VERSION_COMPARE_SNIPPET = `if ! [[ "$PR_VERSION" =~ ^[0-9]{1,9}\\.[0-9]{1,9}\\.[0-9]{1,9}$ ]]; then
  echo "::error::Version '$PR_VERSION' in dataset_description.json is not valid semver (expected X.Y.Z). Use 'nemar dataset release' to set it."
  exit 1
fi
MAIN_SEMVER="$MAIN_VERSION"
[[ "$MAIN_SEMVER" =~ ^[0-9]{1,9}\\.[0-9]{1,9}\\.[0-9]{1,9}$ ]] || MAIN_SEMVER="0.0.0"
IFS=. read -r PMAJ PMIN PPAT <<< "$PR_VERSION"
IFS=. read -r MMAJ MMIN MPAT <<< "$MAIN_SEMVER"
GT=0
if [ "$PMAJ" -gt "$MMAJ" ]; then GT=1
elif [ "$PMAJ" -eq "$MMAJ" ] && [ "$PMIN" -gt "$MMIN" ]; then GT=1
elif [ "$PMAJ" -eq "$MMAJ" ] && [ "$PMIN" -eq "$MMIN" ] && [ "$PPAT" -gt "$MPAT" ]; then GT=1
fi
if [ "$GT" -ne 1 ]; then
  echo "::error::Version must be a strict increment over the main version $MAIN_SEMVER (got '$PR_VERSION'). Use 'nemar dataset release' to bump."
  exit 1
fi
echo "Version check passed: $MAIN_SEMVER -> $PR_VERSION"`;

/**
 * Deploy GitHub Actions workflow files to a dataset repository
 */
export function getWorkflowTemplates(): Array<{ path: string; content: string }> {
  // BIDS Validation workflow
  // BIDS Validation shim — Phase 4 of epic #601 (sub-issue #610).
  //
  // GitHub's `pull_request` events fire only on the repo where the PR lives,
  // so we can't relocate the validator workflow directly like Phases 1-3.
  // This shim fires `repository_dispatch[run-bids-validation]` at
  // `nemarDatasets/.github`, where `run-bids-validation.yml` runs the actual
  // deno validator and posts the result back as a `check-run` on this
  // dataset repo's PR. The shim itself does ~5 seconds of work (mint token
  // + dispatch) and shows up as a quick green check on the PR alongside the
  // central workflow's check-run.
  const bidsValidation = `name: BIDS Validation

# pull_request_target, not pull_request: GitHub gives a pull_request run from a fork no
# secrets, so the token step failed ("Input required and not supplied: app-id") on every
# fork pull request and the central check was never asked for. pull_request_target runs
# this file as it is on main, with the secrets. That is safe only because this job runs
# nothing from the pull request: no checkout, and the event fields reach the shell through
# env (never \${{ }} inside run:) and are checked before use.
on:
  push:
    branches: [main]
  pull_request_target:
    branches: [main]
  workflow_dispatch:

jobs:
  dispatch:
    name: Dispatch central BIDS validation
    runs-on: ubuntu-latest
    timeout-minutes: 2
    permissions: {}
    steps:
      - name: Mint App token scoped to .github
        id: app-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: \${{ secrets.NEMAR_APP_ID }}
          private-key: \${{ secrets.NEMAR_APP_PRIVATE_KEY }}
          owner: nemarDatasets
          # The dispatch target is the .github repo; the token needs
          # actions:write on .github. The central workflow mints a
          # separate per-dataset token internally for the checkout step.
          repositories: .github

      - name: Dispatch run-bids-validation
        env:
          GH_TOKEN: \${{ steps.app-token.outputs.token }}
          DATASET_ID: \${{ github.event.repository.name }}
          # On pull_request_target events the head is the PR's head; on push
          # events it's the pushed commit. Fall back so both shapes work.
          HEAD_SHA: \${{ github.event.pull_request.head.sha || github.sha }}
          REF: \${{ github.event.pull_request.head.ref || github.ref_name }}
          PR_NUMBER: \${{ github.event.pull_request.number || '' }}
        run: |
          set -euo pipefail
          if ! [[ "$DATASET_ID" =~ ^(nm|on|xx)[0-9]{6}$ ]]; then
            echo "::error::Not a dataset repository name"; exit 1
          fi
          if ! [[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]; then
            echo "::error::The head is not a commit id"; exit 1
          fi
          if ! [[ "$PR_NUMBER" =~ ^[0-9]*$ ]]; then
            echo "::error::The pull request number is not a number"; exit 1
          fi
          # REF is the PR author's branch name: passed on as data, never echoed.
          echo "Dispatching run-bids-validation for $DATASET_ID @ $HEAD_SHA (PR=$PR_NUMBER)"
          gh api "repos/nemarDatasets/.github/dispatches" \\
            -f event_type=run-bids-validation \\
            -f "client_payload[dataset_id]=$DATASET_ID" \\
            -f "client_payload[ref]=$REF" \\
            -f "client_payload[head_sha]=$HEAD_SHA" \\
            -f "client_payload[pr_number]=$PR_NUMBER" \\
            -f "client_payload[validator_version]=${VALIDATOR_VERSION}"
`;

  // Version Check shim — completes Phase 4 of epic #601 (sub-issue #610).
  //
  // Previously this shipped the whole version-comparison job to every dataset
  // repo. `version-check` is a REQUIRED status check in the NEMAR branch
  // protection ruleset, so on any repo where per-repo Actions do not run the
  // check can never be produced and every PR stays BLOCKED forever — even when
  // `Run BIDS Validation` already passes centrally.
  //
  // Same shape as the BIDS Validation shim above: fire
  // `repository_dispatch[run-version-check]` at `nemarDatasets/.github`, where
  // `run-version-check.yml` does the comparison and posts the `version-check`
  // check-run back onto this repo's PR head SHA. The check NAME must stay
  // `version-check` for the ruleset to accept it.
  const versionCheck = `name: Version Check

# pull_request_target, not pull_request: GitHub gives a pull_request run from a fork no
# secrets, so the token step failed ("Input required and not supplied: app-id") on every
# fork pull request and the central check was never asked for. pull_request_target runs
# this file as it is on main, with the secrets. That is safe only because this job runs
# nothing from the pull request: no checkout, and the event fields reach the shell through
# env (never \${{ }} inside run:) and are checked before use.
on:
  pull_request_target:
    branches: [main]
  workflow_dispatch:

jobs:
  dispatch:
    name: Dispatch central version check
    runs-on: ubuntu-latest
    timeout-minutes: 2
    permissions: {}
    steps:
      - name: Mint App token scoped to .github
        id: app-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: \${{ secrets.NEMAR_APP_ID }}
          private-key: \${{ secrets.NEMAR_APP_PRIVATE_KEY }}
          owner: nemarDatasets
          # The dispatch target is the .github repo; the token needs
          # actions:write on .github. The central workflow mints a
          # separate per-dataset token internally for the checkout step.
          repositories: .github

      - name: Dispatch run-version-check
        env:
          GH_TOKEN: \${{ steps.app-token.outputs.token }}
          DATASET_ID: \${{ github.event.repository.name }}
          # On pull_request_target events the head is the PR's head; on push
          # events it's the pushed commit. Fall back so both shapes work.
          HEAD_SHA: \${{ github.event.pull_request.head.sha || github.sha }}
          REF: \${{ github.event.pull_request.head.ref || github.ref_name }}
          PR_NUMBER: \${{ github.event.pull_request.number || '' }}
        run: |
          set -euo pipefail
          if ! [[ "$DATASET_ID" =~ ^(nm|on|xx)[0-9]{6}$ ]]; then
            echo "::error::Not a dataset repository name"; exit 1
          fi
          if ! [[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]; then
            echo "::error::The head is not a commit id"; exit 1
          fi
          if ! [[ "$PR_NUMBER" =~ ^[0-9]*$ ]]; then
            echo "::error::The pull request number is not a number"; exit 1
          fi
          # REF is the PR author's branch name: passed on as data, never echoed.
          echo "Dispatching run-version-check for $DATASET_ID @ $HEAD_SHA (PR=$PR_NUMBER)"
          gh api "repos/nemarDatasets/.github/dispatches" \\
            -f event_type=run-version-check \\
            -f "client_payload[dataset_id]=$DATASET_ID" \\
            -f "client_payload[ref]=$REF" \\
            -f "client_payload[head_sha]=$HEAD_SHA" \\
            -f "client_payload[pr_number]=$PR_NUMBER"
`;

  // PR Merge Handler workflow
  // PR Merge shim — Phase 4 of epic #601 (sub-issue #610).
  //
  // `pull_request_target: closed` events fire only on the dataset repo
  // where the PR lives. The `create-release` half of the legacy
  // pr-merge.yml is now a thin dispatch to `nemarDatasets/.github` which
  // does the tag + release cutting via `run-pr-merge.yml`. The
  // `cleanup-staging` job stays inline here because it's AWS-only and
  // centralizing it would just add a network hop without consolidating
  // logic.
  const prMerge = `name: PR Merge Handler

on:
  pull_request_target:
    types: [closed]
    branches: [main]

jobs:
  dispatch-release:
    name: Dispatch central release creation
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    timeout-minutes: 2
    permissions: {}
    steps:
      - name: Mint App token scoped to .github
        id: app-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: \${{ secrets.NEMAR_APP_ID }}
          private-key: \${{ secrets.NEMAR_APP_PRIVATE_KEY }}
          owner: nemarDatasets
          repositories: .github

      - name: Dispatch run-pr-merge
        env:
          GH_TOKEN: \${{ steps.app-token.outputs.token }}
        run: |
          set -euo pipefail
          DATASET_ID="\${{ github.event.repository.name }}"
          PR_NUMBER="\${{ github.event.pull_request.number }}"
          echo "Dispatching run-pr-merge for $DATASET_ID (PR #$PR_NUMBER)"
          gh api "repos/nemarDatasets/.github/dispatches" \\
            -f event_type=run-pr-merge \\
            -f "client_payload[dataset_id]=$DATASET_ID" \\
            -f "client_payload[pr_number]=$PR_NUMBER"

  cleanup-staging:
    name: Cleanup Staging (runs on merge or close)
    if: always()
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions: {}
    steps:
      - name: Remove staging data for this PR/branch
        env:
          AWS_ACCESS_KEY_ID: \${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          DATASET_ID: \${{ github.event.repository.name }}
          BRANCH: \${{ github.event.pull_request.head.ref }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
        run: |
          # Clean up branch-based staging
          aws s3 rm --recursive "s3://nemar/staging/\${DATASET_ID}/\${BRANCH}/" 2>/dev/null || true
          # Clean up legacy PR-number-based staging
          aws s3 rm --recursive "s3://nemar/staging/pr-\${PR_NUMBER}/" 2>/dev/null || true
`;

  // generate-archive.yml relocated to nemarDatasets/.github/.github/workflows/run-generate-archive.yml
  // and triggered via repository_dispatch from the Worker (`triggerArchiveGeneration` in
  // services/github/dispatch.ts now targets `nemarDatasets/.github` rather than the
  // dataset repo). Phase 3 of epic #601 / sub-issue #608. Existing dataset repos are
  // cleaned via scripts/strip-per-repo-workflow.ts --workflow generate-archive.yml.

  // llm-enrichment.yml relocated to nemarDatasets/.github/.github/workflows/run-enrichment.yml
  // and triggered via repository_dispatch from POST /webhooks/github. Phase 1 of
  // epic #601 / sub-issue #602. Existing dataset repos are cleaned by
  // scripts/strip-per-repo-llm-enrichment.ts.
  // version-doi.yml relocated to nemarDatasets/.github/.github/workflows/run-version-doi.yml
  // and triggered via repository_dispatch from POST /webhooks/github on tag pushes.
  // Phase 2 of epic #601 / sub-issue #606. Existing dataset repos are cleaned via
  // scripts/strip-per-repo-workflow.ts --workflow .github/workflows/version-doi.yml.

  return [
    { path: ".github/workflows/bids-validation.yml", content: bidsValidation },
    { path: ".github/workflows/version-check.yml", content: versionCheck },
    { path: ".github/workflows/pr-merge.yml", content: prMerge },
  ];
}

/**
 * Validate that workflow files we just deployed are actually parseable by
 * GitHub Actions. Calls `GET /repos/{org}/{repo}/actions/workflows`; GitHub
 * only lists workflow YAML files it could parse, so any file we deployed
 * that's missing from the list is silently broken.
 *
 * Best-effort: returns `{ valid: [], missing: [...], errors: [...] }` and
 * never throws. Pagination is not implemented — `per_page=100` covers the 6
 * NEMAR workflows comfortably; extend here if `getWorkflowTemplates()` grows
 * past 100 files.
 *
 * `expectedFilenames` are basenames (e.g. `bids-validation.yml`).
 */
async function validateWorkflowsParseable(
  repo: string,
  expectedFilenames: string[],
  pat: string,
): Promise<{ valid: string[]; missing: string[]; errors: string[] }> {
  try {
    // per_page=100 covers page 1 only (no pagination). NEMAR currently
    // deploys 6 workflow templates; page 1 is always sufficient. Add
    // pagination here if getWorkflowTemplates() ever grows past 100 files.
    const response = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/actions/workflows?per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "NEMAR-API",
        },
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // Note: a 429 here is handled by githubFetchWithRetry for up to 3
      // retries. If all retries are exhausted, !response.ok is true and the
      // status (429) lands in the error message below. The deploy itself has
      // already succeeded at this point, so we surface this as a warning.
      return {
        valid: [],
        missing: [],
        errors: [
          `Workflow validation: GitHub API ${response.status} listing workflows: ${body.slice(0, 200)}`,
        ],
      };
    }
    const data = (await response.json()) as {
      workflows?: Array<{ path?: string; name?: string }>;
    };
    const listed = new Set<string>();
    for (const w of data.workflows ?? []) {
      if (typeof w.path === "string") {
        const parts = w.path.split("/");
        const basename = parts[parts.length - 1];
        if (basename) listed.add(basename);
      }
    }
    // A workflow with state: "disabled_manually" is still listed here.
    // Presence means GitHub Actions can parse the file; disabled state is
    // irrelevant to parseability and is intentionally not checked.
    const valid: string[] = [];
    const missing: string[] = [];
    for (const name of expectedFilenames) {
      if (listed.has(name)) valid.push(name);
      else missing.push(name);
    }
    return { valid, missing, errors: [] };
  } catch (err) {
    return {
      valid: [],
      missing: [],
      errors: [`Workflow validation: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

/**
 * Deploy every CI workflow template to a dataset repo in a single
 * tree-batched commit. All-or-nothing: on failure, `deployed` is empty
 * (no partial deployment, unlike the prior per-file loop that could
 * half-succeed). Callers MUST check `success` — this function never throws.
 *
 * Post-deploy parseability validation lives in `validateDeployedWorkflows()`
 * and is driven by the CLI after this call returns (issue #472). Keeping the
 * sleep + listing retry out of the Worker preserves the request wall-clock
 * budget; the CLI polls on the user's machine instead.
 */
export async function deployWorkflows(
  repo: string,
  pat: string,
): Promise<{
  success: boolean;
  errors: string[];
  deployed: string[];
}> {
  const workflows = getWorkflowTemplates();
  const files: TreeFile[] = workflows.map((w) => ({ path: w.path, content: w.content }));
  const deployedNames = workflows.map((w) => {
    const parts = w.path.split("/");
    return parts[parts.length - 1] ?? w.path;
  });

  try {
    await commitFilesAsTree(repo, "main", files, "Add CI workflows", pat);
  } catch (err) {
    return {
      success: false,
      errors: [err instanceof Error ? err.message : String(err)],
      deployed: [],
    };
  }

  return { success: true, errors: [], deployed: deployedNames };
}

/**
 * One-shot parseability probe for the workflows `deployWorkflows()` writes.
 * Returns the listing diff against `getWorkflowTemplates()` so callers can
 * surface which (if any) deployed files GitHub Actions failed to parse.
 *
 * No outer sleeps or backoff retries — the CLI orchestrates wait timing and
 * the missing-workflow retry on the user's machine (the whole point of
 * issue #472 was getting that out of the Worker). Transport-level retries
 * for 5xx responses are still handled internally by `githubFetchWithRetry`
 * (up to 3 attempts), so a sustained 500 here surfaces in `errors` after
 * the internal retries have been exhausted.
 *
 * Best-effort: never throws; transport / API errors land in `errors`.
 */
export async function validateDeployedWorkflows(
  repo: string,
  pat: string,
): Promise<{ valid: string[]; missing: string[]; errors: string[] }> {
  const expectedNames = getWorkflowTemplates().map((w) => {
    const parts = w.path.split("/");
    return parts[parts.length - 1] ?? w.path;
  });
  return validateWorkflowsParseable(repo, expectedNames, pat);
}

/**
 * List the file paths currently present under `.github/workflows` on the repo's
 * given branch. Returns paths relative to the repo root (e.g.
 * `.github/workflows/bids-validation.yml`). A 404 on the directory itself
 * (workflows folder not yet created) is treated as "empty", not an error.
 *
 * ONLY regular files count as "present". Symlinks are deliberately treated
 * as MISSING: in older DataLad-style repos a workflow YAML may be annexed,
 * which GitHub returns as `type: "symlink"`. GitHub Actions cannot read /
 * execute symlinked workflows, so a symlinked file looks deployed in the
 * Contents API but is actually broken. We want
 * `ensureWorkflowsDeployed` / `syncWorkflowTemplates` to overwrite it with
 * a real file blob instead of skipping it.
 */
async function listDeployedWorkflowPaths(
  repo: string,
  branch: string,
  pat: string,
): Promise<Set<string>> {
  const response = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/contents/.github/workflows?ref=${encodeURIComponent(branch)}`,
    {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
      },
    },
  );

  if (response.status === 404) return new Set();
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new HttpError(
      `Failed to list workflows for ${repo}@${branch}: HTTP ${response.status}: ${body.slice(0, 300)}`,
      response.status,
      body.slice(0, 300),
    );
  }
  const entries = (await response.json()) as Array<{ path: string; type: string }>;
  return new Set(entries.filter((e) => e.type === "file").map((e) => e.path));
}

export interface EnsureWorkflowsResult {
  alreadyPresent: string[];
  deployed: string[];
  errors: string[];
  /** True iff we could not list the workflows directory; callers should
      not interpret `alreadyPresent: []` as "no workflows deployed" in
      that case. */
  listFailed: boolean;
}

/**
 * Idempotent presence check: list the workflow directory once, deploy only the
 * templates that are missing in a single tree commit. Never throws; failures
 * are aggregated in `errors`. Steady-state cost when everything is already
 * present is one REST call (the directory listing).
 */
export async function ensureWorkflowsDeployed(
  repo: string,
  branch: string,
  pat: string,
): Promise<EnsureWorkflowsResult> {
  const workflows = getWorkflowTemplates();
  const nameOf = (path: string): string => {
    const parts = path.split("/");
    return parts[parts.length - 1] ?? path;
  };

  let present: Set<string>;
  try {
    present = await listDeployedWorkflowPaths(repo, branch, pat);
  } catch (err) {
    return {
      alreadyPresent: [],
      deployed: [],
      errors: [err instanceof Error ? err.message : String(err)],
      listFailed: true,
    };
  }

  const missing = workflows.filter((w) => !present.has(w.path));
  if (missing.length === 0) {
    return {
      alreadyPresent: workflows.map((w) => nameOf(w.path)),
      deployed: [],
      errors: [],
      listFailed: false,
    };
  }

  try {
    await commitFilesAsTree(
      repo,
      branch,
      missing.map((w) => ({ path: w.path, content: w.content })),
      missing.length === workflows.length ? "Add CI workflows" : "Add missing CI workflows",
      pat,
    );
    return {
      alreadyPresent: workflows.filter((w) => present.has(w.path)).map((w) => nameOf(w.path)),
      deployed: missing.map((w) => nameOf(w.path)),
      errors: [],
      listFailed: false,
    };
  } catch (err) {
    return {
      alreadyPresent: workflows.filter((w) => present.has(w.path)).map((w) => nameOf(w.path)),
      deployed: [],
      errors: [err instanceof Error ? err.message : String(err)],
      listFailed: false,
    };
  }
}

/**
 * Normalize text before comparing template content vs. deployed content.
 * GitHub's Contents API returns the file's exact bytes; if a workflow
 * was ever round-tripped through tooling that adds a UTF-8 BOM,
 * normalizes CRLF, or drops the trailing newline, a naive byte compare
 * would loop forever rewriting the same file. We strip:
 *
 *   - UTF-8 BOM (﻿)
 *   - CR before LF and bare CR
 *   - trailing whitespace (so a missing final newline doesn't drift)
 */
function normalizeForCompare(s: string): string {
  return s.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
}

export interface SyncWorkflowsResult {
  checked: string[];
  /** Templates whose deployed content drifted from the source. */
  changed: string[];
  /** Templates that were missing from the deployed workflows directory. */
  added: string[];
  errors: string[];
  /** True iff a tree commit was made. Distinguishes "nothing to do" from
      "we tried to commit but it failed" (both leave `errors` populated
      via different paths). */
  committed: boolean;
  /** True iff the workflow directory listing failed. */
  listFailed: boolean;
}

/**
 * Compare every workflow template against what is currently deployed and
 * commit, in one tree, only the files whose content drifted. Files that
 * are missing entirely are written as part of the same commit. Never
 * throws; per-file read errors land in `errors` and the file is treated
 * as unchanged so we don't risk clobbering a hand-edited workflow on a
 * read failure.
 *
 * On commit failure the intended `changed` and `added` lists are preserved
 * (so callers can see what *would* have synced) and `committed` is false.
 */
export async function syncWorkflowTemplates(
  repo: string,
  branch: string,
  pat: string,
): Promise<SyncWorkflowsResult> {
  const workflows = getWorkflowTemplates();
  const nameOf = (path: string): string => {
    const parts = path.split("/");
    return parts[parts.length - 1] ?? path;
  };
  const checked = workflows.map((w) => nameOf(w.path));

  let present: Set<string>;
  try {
    present = await listDeployedWorkflowPaths(repo, branch, pat);
  } catch (err) {
    return {
      checked,
      changed: [],
      added: [],
      errors: [err instanceof Error ? err.message : String(err)],
      committed: false,
      listFailed: true,
    };
  }

  const errors: string[] = [];
  const filesToWrite: TreeFile[] = [];
  const changed: string[] = [];
  const added: string[] = [];

  for (const template of workflows) {
    if (!present.has(template.path)) {
      filesToWrite.push({ path: template.path, content: template.content });
      added.push(nameOf(template.path));
      continue;
    }
    let deployedContent: string | null;
    try {
      deployedContent = await getFileContent(repo, template.path, pat, branch);
    } catch (err) {
      errors.push(
        `${template.path}: read failed (${err instanceof Error ? err.message : String(err)})`,
      );
      continue;
    }
    if (deployedContent === null) {
      // Listing said file exists but content fetch returned null — race or
      // permissions. Skip rather than risk a clobbering write.
      errors.push(`${template.path}: present in listing but content unavailable`);
      continue;
    }
    if (normalizeForCompare(deployedContent) !== normalizeForCompare(template.content)) {
      filesToWrite.push({ path: template.path, content: template.content });
      changed.push(nameOf(template.path));
    }
  }

  if (filesToWrite.length === 0) {
    return { checked, changed, added, errors, committed: false, listFailed: false };
  }

  try {
    await commitFilesAsTree(
      repo,
      branch,
      filesToWrite,
      added.length > 0 && changed.length > 0
        ? "Sync CI workflows (add missing, update drifted)"
        : added.length > 0
          ? "Add missing CI workflows"
          : "Update CI workflows to current templates",
      pat,
    );
    return { checked, changed, added, errors, committed: true, listFailed: false };
  } catch (err) {
    errors.push(`commit failed: ${err instanceof Error ? err.message : String(err)}`);
    return { checked, changed, added, errors, committed: false, listFailed: false };
  }
}
