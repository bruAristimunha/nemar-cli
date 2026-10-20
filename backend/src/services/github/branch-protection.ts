/**
 * Branch/tag protection and repo-to-spec enforcement: branch rulesets, tag
 * protection, required-check green gating, and the ensureRepoToSpec
 * orchestrator (epic #713) that drives repos/workflows/collaborators to the
 * governance spec.
 *
 * Split out of services/github.ts (#906, epic #902). The section on the required pull-request
 * review (ADR 0107: the "NEMAR PR review required" ruleset, its payload, and the
 * `review_ruleset` step of ensureRepoToSpec) was written for this file afterwards, so the rest of
 * it is the code that moved and that section is not.
 */

import { PR_REVIEW_CHECK_NAME } from "../../../../shared/pr-review.js";
import { HttpError } from "../retry";
import {
  type CollaboratorReconcileResult,
  type DirectCollaborator,
  computeCollaboratorActions,
  listDirectCollaborators,
  listOrgAdmins,
  reconcileCollaborators,
} from "./collaborators";
import { enableAutoMerge, ensureMainBranch } from "./repos";
import { GITHUB_API, ORG_NAME, errText, ghHeaders } from "./shared";
import { githubFetchWithRetry } from "./transport";
import { ensureWorkflowsDeployed } from "./workflows";

// ============================================================================
// Tag Protection
// ============================================================================

/**
 * Apply tag protection rules to prevent deletion of version tags.
 * Protects tags matching the pattern "v*" (semver version tags).
 */
/**
 * Apply tag protection. Throws `HttpError` on terminal failure so the caller's
 * step-level retry can classify the error and operators see status + body in
 * the surfaced message. 422 is treated as success (rule already exists).
 */
export async function applyTagProtection(repo: string, pat: string): Promise<void> {
  // retryOn404: rulesets endpoint can briefly 404 right after a repo
  // visibility flip while GitHub propagates ACLs.
  const response = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/rulesets`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Protect version tags",
        target: "tag",
        enforcement: "active",
        conditions: {
          ref_name: {
            include: ["refs/tags/v*"],
            exclude: [],
          },
        },
        rules: [{ type: "deletion" }, { type: "update" }],
      }),
    },
    { retryOn404: true },
  );

  // 2xx success or 422 (ruleset already exists) both count as applied.
  if (response.ok || response.status === 422) return;

  const body = await response.text().catch(() => "<failed to read body>");
  const snippet = body.slice(0, 300);
  throw new HttpError(
    `Tag protection failed for ${repo}: HTTP ${response.status}: ${snippet}`,
    response.status,
    snippet,
  );
}

/**
 * NEMAR GitHub App id (`nemar-publish-bot`). Required status checks are pinned
 * to this integration so only a check-run posted by the App satisfies them
 * (spoof-resistant), and the App is a ruleset bypass actor so its automation
 * (enrichment commit-to-main, version-DOI / pr-merge `v*` tag pushes) is not
 * blocked by the PR rule that gates humans. Epic #713.
 */
export const NEMAR_APP_ID = 3679074;

/** Ruleset name for dataset-repo branch protection (the idempotent upsert key). */
export const BRANCH_RULESET_NAME = "NEMAR branch protection";

/**
 * Dataset repos created before the centralized-BIDS migration (#601) that still
 * run the OLD inline `bids-validation.yml`, whose check-run is literally named
 * `bids-validation`. Everything else is on the central shim that posts
 * `Run BIDS Validation`.
 */
export const LEGACY_INLINE_BIDS_REPOS = new Set(["nm000103", "nm000105", "nm000106", "nm000107"]);

/**
 * A required status check. `integration_id` pins the check to a specific
 * GitHub App so only that App's check-run satisfies it (spoof-resistant); omit
 * it to accept the check from any source.
 */
export interface RequiredCheck {
  context: string;
  integration_id?: number;
}

/**
 * Required status checks for a dataset repo's branch protection (published model
 * = BIDS green + version bump). Two checks:
 *  - BIDS: central-flow repos require `Run BIDS Validation`, posted cross-repo by
 *    the NEMAR App, so it is pinned to the App. The four legacy-inline repos still
 *    emit `bids-validation` from github-actions (not the App), so it is unpinned.
 *  - `version-check`: emitted by github-actions in the dataset repo; unpinned.
 */
export function deriveContexts(repo: string): RequiredCheck[] {
  const bids: RequiredCheck = LEGACY_INLINE_BIDS_REPOS.has(repo)
    ? { context: "bids-validation" }
    : { context: "Run BIDS Validation", integration_id: NEMAR_APP_ID };
  return [bids, { context: "version-check" }];
}

export interface BranchRulesetPayload {
  name: string;
  target: "branch";
  enforcement: "active";
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  bypass_actors: Array<{ actor_id: number; actor_type: string; bypass_mode: string }>;
  rules: Array<Record<string, unknown>>;
}

/**
 * Build the branch-ruleset payload. Pure (no network) so it is unit-testable.
 *
 * - `~DEFAULT_BRANCH` tracks the repo's default branch (robust to main/master).
 * - PR rule with 0 required reviews: a solo author self-merges once checks are
 *   green (GitHub forbids self-approval, so requiring >=1 review would deadlock
 *   single-author datasets).
 * - Required checks carry per-check `integration_id` pinning (see `deriveContexts`);
 *   `strict` off by default (a detached cross-repo App check-run is never
 *   re-triggered by GitHub's up-to-date logic, so `strict:true` would deadlock);
 *   `do_not_enforce_on_create` so a brand-new repo's first push is not blocked
 *   before any check has reported.
 * - `bypass_actors`: the NEMAR App (commit-to-main + tag pushes) and org admins
 *   (break-glass).
 */
export function buildBranchRulesetPayload(opts: {
  checks: RequiredCheck[];
  strict?: boolean;
}): BranchRulesetPayload {
  return {
    name: BRANCH_RULESET_NAME,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    bypass_actors: [
      { actor_id: NEMAR_APP_ID, actor_type: "Integration", bypass_mode: "always" },
      { actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: "always" },
    ],
    rules: [
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: opts.strict ?? false,
          do_not_enforce_on_create: true,
          required_status_checks: opts.checks.map((c) =>
            c.integration_id === undefined
              ? { context: c.context }
              : { context: c.context, integration_id: c.integration_id },
          ),
        },
      },
      { type: "non_fast_forward" },
      { type: "deletion" },
    ],
  };
}

/**
 * Idempotently apply the NEMAR branch ruleset to a dataset repo's default
 * branch. GET-first so the create-vs-update decision is unambiguous (POST-then-
 * treat-422 would conflate a name collision with a payload validation error):
 * list the repo's own rulesets (`includes_parents=false`, so an org-inherited
 * ruleset of the same name can't be mistaken for this one), PUT to converge if
 * one named `BRANCH_RULESET_NAME` exists, otherwise POST to create. A 422 on
 * either write is therefore a genuine validation error and is surfaced verbatim.
 * `dryRun` returns the payload without any network call.
 *
 * Worst case ~2 sequential calls plus `githubFetchWithRetry` backoff on a fresh
 * visibility flip (the rulesets endpoint can transiently 404 while ACLs
 * propagate, same as `applyTagProtection`).
 *
 * NOTE (Phase 2, #713): this primitive is intentionally not yet wired into any
 * lifecycle hook. Phase 3 (#717) calls it from make-public (green-gated) and
 * removes it at make-private.
 */
export async function ensureBranchRuleset(
  repo: string,
  pat: string,
  opts: { checks: RequiredCheck[]; strict?: boolean; dryRun?: boolean },
): Promise<{ action: "created" | "updated" | "dryRun"; payload: BranchRulesetPayload }> {
  const payload = buildBranchRulesetPayload({ checks: opts.checks, strict: opts.strict });
  if (opts.dryRun) {
    return { action: "dryRun", payload };
  }

  const headers = {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "NEMAR-API",
    "Content-Type": "application/json",
  };
  const rulesetsUrl = `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/rulesets`;

  // List the repo's OWN rulesets only (exclude org/enterprise-inherited ones, so
  // a same-named inherited ruleset is never PUT by mistake).
  const listResp = await githubFetchWithRetry(
    `${rulesetsUrl}?includes_parents=false`,
    { method: "GET", headers },
    { retryOn404: true },
  );
  if (!listResp.ok) {
    const body = await listResp.text().catch(() => "<failed to read body>");
    throw new HttpError(
      `Branch ruleset list failed for ${repo}: HTTP ${listResp.status}: ${body.slice(0, 300)}`,
      listResp.status,
      body.slice(0, 300),
    );
  }
  const rulesets = (await listResp.json()) as Array<{ id: number; name: string }>;
  const existing = rulesets.find((r) => r.name === BRANCH_RULESET_NAME);

  const write = await githubFetchWithRetry(
    existing ? `${rulesetsUrl}/${existing.id}` : rulesetsUrl,
    { method: existing ? "PUT" : "POST", headers, body: JSON.stringify(payload) },
    { retryOn404: true },
  );
  if (write.ok) {
    return { action: existing ? "updated" : "created", payload };
  }

  const body = await write.text().catch(() => "<failed to read body>");
  throw new HttpError(
    `Branch ruleset ${existing ? "update" : "create"} failed for ${repo}: HTTP ${write.status}: ${body.slice(0, 300)}`,
    write.status,
    body.slice(0, 300),
  );
}

/** Delete the NEMAR branch ruleset if present (un-publish). No-op if absent. */
export async function removeBranchRuleset(repo: string, pat: string): Promise<boolean> {
  const headers = ghHeaders(pat);
  const rulesetsUrl = `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/rulesets`;
  const list = await githubFetchWithRetry(
    `${rulesetsUrl}?includes_parents=false`,
    { method: "GET", headers },
    { retryOn404: true },
  );
  if (!list.ok) {
    if (list.status === 404) return false;
    const b = await list.text().catch(() => "<failed to read body>");
    throw new HttpError(
      `Branch ruleset list failed for ${repo}: HTTP ${list.status}: ${b.slice(0, 200)}`,
      list.status,
      b.slice(0, 200),
    );
  }
  const rulesets = (await list.json()) as Array<{ id: number; name: string }>;
  const existing = rulesets.find((r) => r.name === BRANCH_RULESET_NAME);
  if (!existing) return false;
  const del = await githubFetchWithRetry(
    `${rulesetsUrl}/${existing.id}`,
    { method: "DELETE", headers },
    { retryOn404: true },
  );
  if (del.ok || del.status === 404) return true;
  const b = await del.text().catch(() => "<failed to read body>");
  throw new HttpError(
    `Branch ruleset delete failed for ${repo}: HTTP ${del.status}: ${b.slice(0, 200)}`,
    del.status,
    b.slice(0, 200),
  );
}

/**
 * Read the NEMAR branch ruleset on a repo (for drift reporting): whether it is
 * present and which required status-check contexts it enforces. Returns
 * `{ present:false, contexts:[] }` when absent. Read-only.
 */
export async function getBranchRulesetInfo(
  repo: string,
  pat: string,
): Promise<{ present: boolean; contexts: string[] }> {
  const headers = ghHeaders(pat);
  const rulesetsUrl = `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/rulesets`;
  const list = await githubFetchWithRetry(
    `${rulesetsUrl}?includes_parents=false`,
    { method: "GET", headers },
    { retryOn404: true },
  );
  if (!list.ok) return { present: false, contexts: [] };
  const rulesets = (await list.json()) as Array<{ id: number; name: string }>;
  const existing = rulesets.find((r) => r.name === BRANCH_RULESET_NAME);
  if (!existing) return { present: false, contexts: [] };

  // Fetch the full ruleset to read its required_status_checks contexts.
  const detail = await githubFetchWithRetry(
    `${rulesetsUrl}/${existing.id}`,
    { method: "GET", headers },
    { retryOn404: true },
  );
  if (!detail.ok) {
    // Ruleset exists but its detail couldn't be read; throw so the drift
    // gatherer's per-call .catch absorbs it (a transient error must not surface
    // as an empty-contexts CONTEXT_NAME_MISMATCH).
    const b = await detail.text().catch(() => "<failed to read body>");
    throw new HttpError(
      `Branch ruleset detail fetch failed for ${repo}: HTTP ${detail.status}: ${b.slice(0, 200)}`,
      detail.status,
      b.slice(0, 200),
    );
  }
  const d = (await detail.json()) as {
    rules?: Array<{
      type: string;
      parameters?: { required_status_checks?: Array<{ context: string }> };
    }>;
  };
  const rule = (d.rules ?? []).find((r) => r.type === "required_status_checks");
  const contexts = (rule?.parameters?.required_status_checks ?? []).map((c) => c.context);
  return { present: true, contexts };
}

/** List a repo's `.github/workflows` filenames (drift reporting). [] if none. */
export async function listRepoWorkflows(repo: string, pat: string): Promise<string[]> {
  const r = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/contents/.github/workflows`,
    { headers: ghHeaders(pat) },
    { retryOn404: true },
  );
  if (!r.ok) return [];
  const items = (await r.json()) as Array<{ name?: string; type?: string }>;
  return items.filter((i) => i.type === "file" && i.name).map((i) => i.name as string);
}

/**
 * Pure green-gate predicate: is the required check satisfied on a commit, given
 * its check-runs and legacy commit statuses? Green = a matching check-run
 * (by name, and by App `integration_id` when the required check is pinned) with
 * conclusion success/neutral/skipped, or a matching commit status with
 * state=success. Missing or failing => not green.
 */
export function isRequiredCheckGreen(
  required: RequiredCheck,
  checkRuns: Array<{ name: string; conclusion: string | null; app_id?: number | null }>,
  statuses: Array<{ context: string; state: string }>,
): boolean {
  const green = new Set(["success", "neutral", "skipped"]);
  const matched = checkRuns.some(
    (cr) =>
      cr.name === required.context &&
      (required.integration_id === undefined || cr.app_id === required.integration_id) &&
      cr.conclusion !== null &&
      green.has(cr.conclusion),
  );
  if (matched) return true;
  return statuses.some((s) => s.context === required.context && s.state === "success");
}

/**
 * Green-gate: is the required BIDS check green on a repo's default-branch HEAD?
 * Used to skip applying protection to a repo whose latest validation is red or
 * missing (so we never brick PRs). Reads check-runs + the legacy combined
 * status. Returns a tri-state so callers can distinguish a genuinely red/missing
 * check from a transient GitHub fetch failure (both fail-closed, but the latter
 * is logged and surfaced as `fetch_error` so it can be retried, not mistaken for
 * a broken BIDS pipeline).
 */
export async function checkRunGreenOnDefaultHead(
  repo: string,
  branch: string,
  required: RequiredCheck,
  pat: string,
): Promise<{ green: boolean; reason: "green" | "red" | "fetch_error" }> {
  const headers = ghHeaders(pat);
  let checkRuns: Array<{ name: string; conclusion: string | null; app_id?: number | null }> = [];
  try {
    const r = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/commits/${branch}/check-runs?per_page=100`,
      { headers },
      { retryOn404: true },
    );
    if (!r.ok) {
      console.error(
        `[green-gate] check-runs fetch for ${repo}@${branch} returned HTTP ${r.status}; treating as not-green (fetch_error)`,
      );
      return { green: false, reason: "fetch_error" };
    }
    const d = (await r.json()) as {
      check_runs?: Array<{ name: string; conclusion: string | null; app?: { id?: number } }>;
    };
    checkRuns = (d.check_runs ?? []).map((c) => ({
      name: c.name,
      conclusion: c.conclusion,
      app_id: c.app?.id ?? null,
    }));
  } catch (e) {
    console.error(
      `[green-gate] check-runs fetch failed for ${repo}@${branch} (treating as not-green):`,
      e,
    );
    return { green: false, reason: "fetch_error" };
  }
  let statuses: Array<{ context: string; state: string }> = [];
  try {
    const r = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/commits/${branch}/status`,
      { headers },
      { retryOn404: true },
    );
    if (r.ok) {
      const d = (await r.json()) as { statuses?: Array<{ context: string; state: string }> };
      statuses = d.statuses ?? [];
    }
  } catch (e) {
    console.error(
      `[green-gate] combined-status fetch failed for ${repo}@${branch} (continuing on check-runs only):`,
      e,
    );
  }
  const green = isRequiredCheckGreen(required, checkRuns, statuses);
  return { green, reason: green ? "green" : "red" };
}

// ===========================================================================
// The required pull-request review (ADR 0107)
// ===========================================================================

/**
 * Ruleset name for the required pull-request review (the idempotent upsert key).
 *
 * A ruleset of its own, not a third check inside {@link BRANCH_RULESET_NAME}: that one waits on BIDS
 * validation, is missing from most public repositories, and adding the repository Admin role to its
 * bypass list would let that role skip the BIDS and version checks too.
 */
export const REVIEW_RULESET_NAME = "NEMAR PR review required";

/**
 * The only branch the Worker reviews pull requests against (`PR_REVIEW_BASE_BRANCH` in
 * services/pr-review.ts, which a test ties to this). The ruleset follows the default branch, so it
 * is only written where the default branch is this one: anywhere else it would require a check that
 * no pull request is ever given.
 */
export const REVIEW_BASE_BRANCH = "main";

/** What to do about the required review on a repository: put the ruleset in place, or take it out. */
export type ReviewIntent = "require" | "remove";

/** GitHub fixes the actor id of the `OrganizationAdmin` bypass actor at 1. */
const ORGANIZATION_ADMIN_ACTOR_ID = 1;

/**
 * The id of the repository Admin role, as a `RepositoryRole` bypass actor of the review ruleset.
 *
 * NOT VERIFIED. GitHub's ruleset documentation lists no role ids. The 5 for the repository Admin
 * role comes from the Terraform GitHub provider's documentation (admin 5, write 4, maintain 2 for
 * the base roles), and nothing here has read it back from GitHub. A wrong id would hand the bypass
 * to the wrong role (Maintain or Write in place of Admin), so the first apply, on a dev-owned
 * exemplar, has to be followed by this check before any other repository gets the ruleset: read
 * the ruleset back through GraphQL and expect exactly one RepositoryRole actor whose role name is
 * "admin".
 *
 *   gh api graphql -f query='query{repository(owner:"nemarDatasets",name:"xx099900"){
 *     rulesets(first:10){nodes{name bypassActors(first:10){nodes{bypassMode organizationAdmin
 *     repositoryRoleName repositoryRoleDatabaseId actor{__typename ... on App{databaseId name}}}}}}}}'
 *
 * If it names any other role, remove the ruleset
 * (`nemar admin fleet require-review <id> --remove --apply`), correct this constant and stop.
 */
export const REPOSITORY_ADMIN_ROLE_ID = 5;

/** The ruleset body {@link ensureReviewRuleset} sends; the same shape as the branch ruleset's. */
export type ReviewRulesetPayload = BranchRulesetPayload;

/**
 * Build the review-ruleset payload. Pure (no network) so it is unit-testable.
 *
 * - One rule and nothing else: the `NEMAR PR Review` check must pass, and it must come from the
 *   NEMAR GitHub App (`integration_id`), so only the check-run the Worker publishes satisfies it.
 *   There is no pull-request rule; requiring pull requests is the branch ruleset's job.
 * - `~DEFAULT_BRANCH` tracks the default branch, as the branch ruleset does.
 * - `strict` is off for the reason the branch ruleset gives: the check is published for a pull
 *   request's head commit and never re-posted when the base moves, so requiring an up-to-date
 *   branch would leave a pull request waiting for a check that cannot come.
 *   `do_not_enforce_on_create` lets a new repository's first push through.
 * - Bypass, all `always`: the NEMAR App (the enrichment workflow pushes to `main` with its token),
 *   organization administrators, and the repository Admin role, which the `dataset-admin` team
 *   holds on dataset repositories. Maintainers and outside collaborators get none.
 */
export function buildReviewRulesetPayload(): ReviewRulesetPayload {
  return {
    name: REVIEW_RULESET_NAME,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    bypass_actors: [
      { actor_id: NEMAR_APP_ID, actor_type: "Integration", bypass_mode: "always" },
      {
        actor_id: ORGANIZATION_ADMIN_ACTOR_ID,
        actor_type: "OrganizationAdmin",
        bypass_mode: "always",
      },
      { actor_id: REPOSITORY_ADMIN_ROLE_ID, actor_type: "RepositoryRole", bypass_mode: "always" },
    ],
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: false,
          do_not_enforce_on_create: true,
          required_status_checks: [{ context: PR_REVIEW_CHECK_NAME, integration_id: NEMAR_APP_ID }],
        },
      },
    ],
  };
}

interface RulesetSummary {
  id: number;
  name: string;
  enforcement?: string;
}

/**
 * The repository's OWN rulesets (`includes_parents=false`, so an organization ruleset that shares a
 * name is never mistaken for this one, or written to). Throws on any failure.
 */
async function listOwnRulesets(repo: string, pat: string): Promise<RulesetSummary[]> {
  const list = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/rulesets?includes_parents=false`,
    { method: "GET", headers: ghHeaders(pat) },
    { retryOn404: true },
  );
  if (!list.ok) {
    const b = await list.text().catch(() => "<failed to read body>");
    throw new HttpError(
      `Review ruleset list failed for ${repo}: HTTP ${list.status}: ${b.slice(0, 300)}`,
      list.status,
      b.slice(0, 300),
    );
  }
  return (await list.json()) as RulesetSummary[];
}

/**
 * Put the review ruleset in place on a repository, or bring it back to the payload: GET-first, so
 * the choice between creating and updating is never a guess from an error code (see
 * {@link ensureBranchRuleset}). A 422 on the write is a real validation error and is surfaced as it
 * came, with one exception.
 *
 * The exception is a 422 on a create. The transport sends a POST again after a 5xx, so a create
 * that GitHub processed and then answered with a 502 is sent twice, and the second meets the name
 * the first made: a 422, and a repository that is in the state asked for. So after a 422 on a
 * create the list is read once more, and a ruleset that is there now is brought to the payload by
 * an update. A 422 with no such ruleset is a real validation error, and is surfaced as it came.
 *
 * Writes whatever the repository's state is; whether it SHOULD be required here is the caller's
 * decision ({@link reconcileReviewRuleset} is the one that makes it).
 */
export async function ensureReviewRuleset(
  repo: string,
  pat: string,
): Promise<{ action: "created" | "updated"; payload: ReviewRulesetPayload }> {
  const payload = buildReviewRulesetPayload();
  const rulesetsUrl = `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/rulesets`;
  const named = async () =>
    (await listOwnRulesets(repo, pat)).find((r) => r.name === REVIEW_RULESET_NAME);
  const send = (existing: RulesetSummary | undefined) =>
    githubFetchWithRetry(
      existing ? `${rulesetsUrl}/${existing.id}` : rulesetsUrl,
      {
        method: existing ? "PUT" : "POST",
        headers: { ...ghHeaders(pat), "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      { retryOn404: true },
    );

  let existing = await named();
  let write = await send(existing);
  if (write.status === 422 && !existing) {
    let now: RulesetSummary | undefined;
    try {
      now = await named();
    } catch (e) {
      // The 422 is the answer to the create, and the more useful one to report.
      console.error(`[review-ruleset] re-list after a 422 failed for ${repo}: ${errText(e)}`);
    }
    if (now) {
      existing = now;
      write = await send(existing);
    }
  }
  if (write.ok) {
    return { action: existing ? "updated" : "created", payload };
  }

  const body = await write.text().catch(() => "<failed to read body>");
  throw new HttpError(
    `Review ruleset ${existing ? "update" : "create"} failed for ${repo}: HTTP ${write.status}: ${body.slice(0, 300)}`,
    write.status,
    body.slice(0, 300),
  );
}

/**
 * The review ruleset among a repository's own, for taking it off: a repository GitHub cannot find
 * has none, so that is `undefined` and not an error. Any other failure throws.
 */
async function findReviewRulesetToRemove(
  repo: string,
  pat: string,
): Promise<RulesetSummary | undefined> {
  try {
    return (await listOwnRulesets(repo, pat)).find((r) => r.name === REVIEW_RULESET_NAME);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return undefined;
    throw e;
  }
}

/**
 * Delete the review ruleset if present. Only that ruleset: the branch ruleset and the tag ruleset
 * are other rulesets by name and are never listed for deletion here. Returns whether one was
 * deleted; a repository GitHub cannot find has none to delete, so that is `false` and not an error.
 */
export async function removeReviewRuleset(repo: string, pat: string): Promise<boolean> {
  const existing = await findReviewRulesetToRemove(repo, pat);
  if (!existing) return false;
  const del = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/rulesets/${existing.id}`,
    { method: "DELETE", headers: ghHeaders(pat) },
    { retryOn404: true },
  );
  if (del.ok || del.status === 404) return true;
  const b = await del.text().catch(() => "<failed to read body>");
  throw new HttpError(
    `Review ruleset delete failed for ${repo}: HTTP ${del.status}: ${b.slice(0, 200)}`,
    del.status,
    b.slice(0, 200),
  );
}

/**
 * Read the review ruleset on a repository (for drift reporting and for a dry run): whether it is
 * there, and whether it is being enforced. A ruleset that is present and not `active` (the
 * break-glass rollback sets it to `disabled`) requires nothing, so it is present and not active.
 * Read-only. Throws when GitHub cannot say, so a caller never mistakes an outage for an absence.
 */
export async function getReviewRulesetInfo(
  repo: string,
  pat: string,
): Promise<{ present: boolean; active: boolean }> {
  const existing = (await listOwnRulesets(repo, pat)).find((r) => r.name === REVIEW_RULESET_NAME);
  return { present: Boolean(existing), active: existing?.enforcement === "active" };
}

/** The default branch of a repository, strictly: unlike {@link getRepoDefaultBranch} it never guesses. */
async function readDefaultBranch(repo: string, pat: string): Promise<string> {
  const r = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}`,
    { headers: ghHeaders(pat) },
    { retryOn404: true },
  );
  if (!r.ok) {
    const b = await r.text().catch(() => "<failed to read body>");
    throw new HttpError(
      `Repository read failed for ${repo}: HTTP ${r.status}: ${b.slice(0, 200)}`,
      r.status,
      b.slice(0, 200),
    );
  }
  const info = (await r.json()) as { default_branch?: unknown };
  if (typeof info.default_branch !== "string" || info.default_branch === "") {
    throw new HttpError(`Repository read for ${repo} named no default branch`, r.status);
  }
  return info.default_branch;
}

/** What {@link reconcileReviewRuleset} did, or with `dryRun` would do. */
export interface ReviewRulesetStep {
  intent: ReviewIntent;
  /**
   * `create`/`update`: the ruleset is (to be) written. `remove`: it is (to be) deleted. `none`:
   * there was nothing to remove. `skip`: it is required here but was not written, see `reason`.
   */
  action: "create" | "update" | "remove" | "none" | "skip";
  /** Whether a write was made: always false for a dry run, and for `none` and `skip`. */
  applied: boolean;
  /** Why a required ruleset was not written. */
  reason?: "default_branch_not_main";
  /** The default branch that made it `skip`. */
  defaultBranch?: string;
  /** What is (to be) sent, for `create` and `update`. */
  payload?: ReviewRulesetPayload;
}

/**
 * Bring one repository to a review intent: the one place that decides what a request to require or
 * remove the review means for a repository, shared by the admin routes and `ensureRepoToSpec`.
 *
 * `remove` deletes the ruleset wherever it is. `require` writes it, except where the default branch
 * is not `main`: the ruleset follows the default branch and the Worker reviews only pull requests
 * to `main`, so there it would require a check no pull request is given. That is a `skip`, never a
 * silent write. A caller that already read the default branch passes it in.
 *
 * `dryRun` reads and writes nothing: it says what would happen, from what GitHub holds now.
 */
export async function reconcileReviewRuleset(
  repo: string,
  pat: string,
  opts: { intent: ReviewIntent; dryRun?: boolean; defaultBranch?: string },
): Promise<ReviewRulesetStep> {
  if (opts.intent === "remove") {
    if (opts.dryRun) {
      // The same reading as the removal itself, so a dry run and the run it previews agree.
      const present = Boolean(await findReviewRulesetToRemove(repo, pat));
      return { intent: "remove", action: present ? "remove" : "none", applied: false };
    }
    const removed = await removeReviewRuleset(repo, pat);
    return { intent: "remove", action: removed ? "remove" : "none", applied: removed };
  }

  const defaultBranch = opts.defaultBranch ?? (await readDefaultBranch(repo, pat));
  if (defaultBranch !== REVIEW_BASE_BRANCH) {
    return {
      intent: "require",
      action: "skip",
      applied: false,
      reason: "default_branch_not_main",
      defaultBranch,
    };
  }
  if (opts.dryRun) {
    const info = await getReviewRulesetInfo(repo, pat);
    return {
      intent: "require",
      action: info.present ? "update" : "create",
      applied: false,
      payload: buildReviewRulesetPayload(),
    };
  }
  const written = await ensureReviewRuleset(repo, pat);
  return {
    intent: "require",
    action: written.action === "created" ? "create" : "update",
    applied: true,
    payload: written.payload,
  };
}

// ===========================================================================
// Repo-to-spec enforcement (epic #713, phase #717)
// ===========================================================================

type StepStatus = "ok" | "skipped" | "failed";
export interface RepoSpecResult {
  repo: string;
  visibility: "public" | "private";
  defaultBranch: string;
  steps: Record<string, { status: StepStatus; detail?: string }>;
  reconcile?: CollaboratorReconcileResult;
}

/**
 * What a failed review-ruleset request is called in a step's `detail`: GitHub's status code and
 * none of what GitHub said. The step is printed by `nemar admin fleet enforce`, and GitHub's own
 * body is JSON, so it stays in the server log (the caller logs the full error text) and out of a
 * terminal. A 4xx is a refusal. For anything else, and for no answer at all, a write may have been
 * made before the answer was lost, so it is said not to be known (a dry run writes nothing).
 */
export function reviewStepFailure(e: unknown, dryRun: boolean): string {
  if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 429) {
    return `GitHub refused the review ruleset with HTTP ${e.status}`;
  }
  const unknown = dryRun ? "" : "; it is not known whether it was changed";
  if (e instanceof HttpError) {
    return `GitHub could not complete the review ruleset request (HTTP ${e.status})${unknown}`;
  }
  return `the request to GitHub for the review ruleset did not complete${unknown}`;
}

/**
 * What a review step records, in the words the other steps use. Never throws.
 *
 * `defaultBranch` is the default branch as GitHub said it, or `undefined` when the caller could not
 * get it from GitHub. Requiring the review writes a ruleset that follows the default branch, so a
 * guess is never acted on: when none was given, the branch is read here, strictly, and a read that
 * fails leaves the repository's review ruleset as it is and says so.
 */
async function reviewRulesetStepOf(
  repo: string,
  pat: string,
  o: {
    intent: ReviewIntent;
    isPublic: boolean;
    defaultBranch: string | undefined;
    dryRun: boolean;
  },
): Promise<{ status: StepStatus; detail?: string }> {
  // Nothing publishes the review check on a private repository, so it is never required there.
  const intent: ReviewIntent = o.isPublic ? o.intent : "remove";
  const privateNote = intent === o.intent ? "" : " (private)";
  try {
    let defaultBranch = o.defaultBranch;
    if (intent === "require" && defaultBranch === undefined) {
      try {
        defaultBranch = await readDefaultBranch(repo, pat);
      } catch (e) {
        console.error(`[repo-spec] default branch read failed for ${repo}: ${errText(e)}`);
        const status = e instanceof HttpError ? ` (HTTP ${e.status})` : "";
        return {
          status: "failed",
          detail: `not applied: the default branch could not be read from GitHub${status}`,
        };
      }
    }
    // The live run makes main the default branch (the main_branch step of ensureRepoToSpec)
    // before it gets here, so on a repository that is on another branch it does that first and
    // then writes. How it does it depends on whether `main` exists: it moves the default to an
    // existing `main`, and it renames the branch when there is none. A dry run has changed
    // nothing, and would read the unchanged branch and report a skip the live run never makes, so
    // it plans the same two steps, in words that are true of both ways.
    const makesMainDefault =
      o.dryRun &&
      intent === "require" &&
      defaultBranch !== undefined &&
      defaultBranch !== REVIEW_BASE_BRANCH;
    const step = await reconcileReviewRuleset(repo, pat, {
      intent,
      dryRun: o.dryRun,
      defaultBranch: makesMainDefault ? REVIEW_BASE_BRANCH : defaultBranch,
    });
    if (step.action === "skip") {
      return {
        status: "skipped",
        detail: `default branch is ${step.defaultBranch}, not ${REVIEW_BASE_BRANCH}`,
      };
    }
    if (makesMainDefault) {
      return {
        status: "ok",
        detail: `would make ${REVIEW_BASE_BRANCH} the default branch, then ${step.action}`,
      };
    }
    const words = o.dryRun
      ? { create: "would create", update: "would update", remove: "would remove" }
      : { create: "created", update: "updated", remove: "removed" };
    const detail = step.action === "none" ? "nothing to remove" : words[step.action];
    return { status: "ok", detail: `${detail}${privateNote}` };
  } catch (e) {
    // The whole error, with GitHub's words, is for the server log. What is returned is printed.
    console.error(
      `[repo-spec] review ruleset step failed for ${repo}${o.dryRun ? " (dry run)" : ""}: ${errText(e)}`,
    );
    return { status: "failed", detail: reviewStepFailure(e, o.dryRun) };
  }
}

/**
 * The single idempotent enforcement point: bring a dataset repo to its target
 * spec for the given publish state. PUBLIC = locked main (branch + tag ruleset,
 * green-gated) + workflows + collaborator reconcile; PRIVATE = open push (NO
 * branch ruleset) + workflows + reconcile. Each step records a structured
 * status; no cross-step rollback. `dryRun` computes the plan without mutating.
 *
 * The required pull-request review is a step of its own, `review_ruleset`, and
 * only when the caller says what it wants (`opts.review`). It does not wait for
 * the BIDS check to be green or for the workflows: the review is published by
 * the Worker, not by anything in the repository.
 *
 * D1-free by design: the caller resolves `collaborators.ownerLogin` (from
 * `datasets.owner_user_id`) and `approvedWriters` (from `dataset_collaborators`)
 * and passes them in, and decides `review` from the dataset row.
 */
export async function ensureRepoToSpec(
  repo: string,
  pat: string,
  opts: {
    visibility: "public" | "private";
    collaborators?: { ownerLogin: string | null; approvedWriters: string[]; skipLogins?: string[] };
    dryRun?: boolean;
    /**
     * What to do about the required review (ADR 0107). `undefined` leaves the review ruleset
     * exactly as it is. On a private repository `require` is read as `remove`: nothing publishes
     * the check there, so requiring it could only block.
     */
    review?: ReviewIntent;
  },
): Promise<RepoSpecResult> {
  const steps: RepoSpecResult["steps"] = {};
  const isPublic = opts.visibility === "public";
  const bidsCheck = deriveContexts(repo)[0];

  // 1. Capture the default branch. The steps that only need a branch to look at (the BIDS check
  // on its head) fall back to "main" when the read fails. The review step does not: it is given
  // `knownBranch`, which is set only from GitHub's own answer, so a repository whose default
  // branch could not be read is never treated as one that is on main.
  let defaultBranch = "main";
  let knownBranch: string | undefined;
  try {
    const r = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${repo}`,
      { headers: ghHeaders(pat) },
      { retryOn404: true },
    );
    if (r.ok) {
      const info = (await r.json()) as { default_branch?: string };
      defaultBranch = info.default_branch || "main";
      if (info.default_branch) knownBranch = info.default_branch;
    } else {
      console.error(
        `[repo-spec] repo info fetch for ${repo} returned HTTP ${r.status}; defaulting branch to 'main'`,
      );
    }
  } catch (e) {
    console.error(
      `[repo-spec] repo info fetch failed for ${repo}, defaulting branch to 'main':`,
      e,
    );
  }

  if (opts.dryRun) {
    steps.plan = {
      status: "ok",
      detail: `${opts.visibility}, default=${knownBranch ?? "unknown"}`,
    };
    if (isPublic) {
      const g = await checkRunGreenOnDefaultHead(repo, defaultBranch, bidsCheck, pat);
      steps.branch_ruleset = g.green
        ? { status: "ok", detail: "would apply" }
        : {
            status: "skipped",
            detail: g.reason === "fetch_error" ? "FETCH_ERROR" : "RED_REQUIRED_CHECK",
          };
    } else {
      steps.branch_ruleset = { status: "skipped", detail: "private: no ruleset" };
    }
    if (opts.review !== undefined) {
      steps.review_ruleset = await reviewRulesetStepOf(repo, pat, {
        intent: opts.review,
        isPublic,
        defaultBranch: knownBranch,
        dryRun: true,
      });
    }
    if (opts.collaborators) {
      let current: DirectCollaborator[];
      try {
        current = await listDirectCollaborators(repo, pat);
      } catch (e) {
        // Cannot read the ledger -> the plan would be wrong; stop here.
        steps.collaborators = { status: "failed", detail: errText(e) };
        return { repo, visibility: opts.visibility, defaultBranch, steps };
      }
      let orgAdmins: string[] = [];
      try {
        orgAdmins = [...(await listOrgAdmins(pat))];
      } catch (e) {
        console.error(`[repo-spec] listOrgAdmins failed for ${repo} (dry-run): ${errText(e)}`);
      }
      const a = computeCollaboratorActions({
        current,
        visibility: opts.visibility,
        ownerLogin: opts.collaborators.ownerLogin,
        approvedWriters: opts.collaborators.approvedWriters,
        skipLogins: opts.collaborators.skipLogins,
        orgAdmins,
      });
      steps.collaborators = {
        status: "ok",
        detail: `+${a.toAdd.length} ^${a.toPromote.length} -${a.toRemove.length}`,
      };
    }
    return { repo, visibility: opts.visibility, defaultBranch, steps };
  }

  // 2. Default branch must be main.
  try {
    const r = await ensureMainBranch(repo, pat);
    steps.main_branch = {
      status: "ok",
      detail: r.changed ? `${r.action} from ${r.previousBranch}` : "main",
    };
    // ensureMainBranch returns only when the default branch is main, as it was or as it made it.
    defaultBranch = "main";
    knownBranch = "main";
  } catch (e) {
    steps.main_branch = { status: "failed", detail: errText(e) };
  }

  // 3. Workflows must be deployed before protection can require their checks.
  let workflowsOk = true;
  try {
    const wr = await ensureWorkflowsDeployed(repo, "main", pat);
    if (wr.errors.length > 0) {
      workflowsOk = false;
      steps.workflows = { status: "failed", detail: wr.errors.join("; ") };
    } else {
      steps.workflows = {
        status: "ok",
        detail: `deployed ${wr.deployed.length}, present ${wr.alreadyPresent.length}`,
      };
    }
  } catch (e) {
    workflowsOk = false;
    steps.workflows = { status: "failed", detail: errText(e) };
  }

  // 4. Auto-merge (so green PRs land without manual button-press).
  try {
    await enableAutoMerge(repo, pat);
    steps.auto_merge = { status: "ok" };
  } catch (e) {
    steps.auto_merge = { status: "failed", detail: errText(e) };
  }

  // 5. Branch protection — PUBLIC only, green-gated; PRIVATE removes any ruleset.
  if (isPublic) {
    if (!workflowsOk) {
      steps.branch_ruleset = { status: "skipped", detail: "workflows not deployed" };
    } else {
      const g = await checkRunGreenOnDefaultHead(repo, defaultBranch, bidsCheck, pat);
      if (!g.green) {
        steps.branch_ruleset = {
          status: "skipped",
          detail: g.reason === "fetch_error" ? "FETCH_ERROR" : "RED_REQUIRED_CHECK",
        };
      } else {
        try {
          await ensureBranchRuleset(repo, pat, { checks: deriveContexts(repo), strict: false });
          steps.branch_ruleset = { status: "ok" };
        } catch (e) {
          steps.branch_ruleset = { status: "failed", detail: errText(e) };
        }
        try {
          await applyTagProtection(repo, pat);
          steps.tag_ruleset = { status: "ok" };
        } catch (e) {
          steps.tag_ruleset = { status: "failed", detail: errText(e) };
        }
      }
    }
  } else {
    try {
      const removed = await removeBranchRuleset(repo, pat);
      steps.branch_ruleset = {
        status: "ok",
        detail: removed ? "removed (private)" : "none (private)",
      };
    } catch (e) {
      steps.branch_ruleset = { status: "failed", detail: errText(e) };
    }
  }

  // 5b. The required review, when the caller decided it. Independent of step 5: a repository
  // whose BIDS check is red still gets (or loses) the review requirement.
  if (opts.review !== undefined) {
    steps.review_ruleset = await reviewRulesetStepOf(repo, pat, {
      intent: opts.review,
      isPublic,
      defaultBranch: knownBranch,
      dryRun: false,
    });
  }

  // 6. Collaborators (when the caller resolved the ledger).
  let reconcile: CollaboratorReconcileResult | undefined;
  if (opts.collaborators) {
    reconcile = await reconcileCollaborators(
      {
        repo,
        visibility: opts.visibility,
        ownerLogin: opts.collaborators.ownerLogin,
        approvedWriters: opts.collaborators.approvedWriters,
        skipLogins: opts.collaborators.skipLogins,
      },
      pat,
    );
    steps.collaborators = {
      status: reconcile.errors.length ? "failed" : "ok",
      detail: `+${reconcile.added.length} ^${reconcile.promoted.length} -${reconcile.removed.length}${reconcile.errors.length ? ` errors:${reconcile.errors.length}` : ""}`,
    };
  }

  return { repo, visibility: opts.visibility, defaultBranch, steps, reconcile };
}
