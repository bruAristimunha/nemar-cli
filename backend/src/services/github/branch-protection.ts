/**
 * Branch/tag protection and repo-to-spec enforcement: branch rulesets, tag
 * protection, required-check green gating, and the ensureRepoToSpec
 * orchestrator (epic #713) that drives repos/workflows/collaborators to the
 * governance spec.
 *
 * Moved verbatim from services/github.ts (#906, epic #902); the only
 * intentional changes are import paths.
 */

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
 * The single idempotent enforcement point: bring a dataset repo to its target
 * spec for the given publish state. PUBLIC = locked main (branch + tag ruleset,
 * green-gated) + workflows + collaborator reconcile; PRIVATE = open push (NO
 * branch ruleset) + workflows + reconcile. Each step records a structured
 * status; no cross-step rollback. `dryRun` computes the plan without mutating.
 *
 * D1-free by design: the caller resolves `collaborators.ownerLogin` (from
 * `datasets.owner_user_id`) and `approvedWriters` (from `dataset_collaborators`)
 * and passes them in.
 */
export async function ensureRepoToSpec(
  repo: string,
  pat: string,
  opts: {
    visibility: "public" | "private";
    collaborators?: { ownerLogin: string | null; approvedWriters: string[]; skipLogins?: string[] };
    dryRun?: boolean;
  },
): Promise<RepoSpecResult> {
  const steps: RepoSpecResult["steps"] = {};
  const isPublic = opts.visibility === "public";
  const bidsCheck = deriveContexts(repo)[0];

  // 1. Capture the default branch.
  let defaultBranch = "main";
  try {
    const r = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${repo}`,
      { headers: ghHeaders(pat) },
      { retryOn404: true },
    );
    if (r.ok) {
      const info = (await r.json()) as { default_branch?: string };
      defaultBranch = info.default_branch || "main";
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
    steps.plan = { status: "ok", detail: `${opts.visibility}, default=${defaultBranch}` };
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
    if (r.changed) defaultBranch = "main";
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
