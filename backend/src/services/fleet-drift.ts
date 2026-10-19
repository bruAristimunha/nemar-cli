/**
 * Fleet drift classification (epic #713, phase #719).
 *
 * Pure logic that maps a dataset repo's observed GitHub state to the set of
 * drift buckets it violates, so `GET /admin/fleet/drift` can report which repos
 * are off-spec before a bulk `enforce`. The state-gathering (GitHub calls) lives
 * in the route; this module is pure and unit-tested.
 *
 * Target spec (see epic #713): published/public repo = main locked by the NEMAR
 * branch ruleset whose required check is green, workflows deployed, no stray
 * direct read grants, default branch `main`; private repo = open push (no
 * ruleset) but workflows + no stray read. On top of that (ADR 0107), a dataset
 * the Worker reviews has the "NEMAR PR review required" ruleset in force, and one
 * it does not review has none.
 */

import {
  type ReviewIntent,
  checkRunGreenOnDefaultHead,
  deriveContexts,
  getBranchRulesetInfo,
  getRepoDefaultBranch,
  getReviewRulesetInfo,
  listDirectCollaborators,
  listRepoWorkflows,
} from "./github";

const REQUIRED_WORKFLOWS = ["bids-validation.yml", "version-check.yml"];
const DEPRECATED_WORKFLOWS = new Set([
  "version-doi.yml",
  "generate-archive.yml",
  "llm-enrichment.yml",
]);

export const DRIFT_BUCKETS = [
  "PUBLIC_UNPROTECTED",
  "PRIVATE_WITH_STRAY_READ",
  "DEFAULT_BRANCH_OUTLIER",
  "MISSING_REQUIRED_WORKFLOW",
  "CONTEXT_NAME_MISMATCH",
  "RED_REQUIRED_CHECK",
  "DEPRECATED_WORKFLOW_PRESENT",
  "REVIEW_RULESET_MISSING",
  "REVIEW_RULESET_STRAY",
  "COMPLIANT",
] as const;

export type DriftBucket = (typeof DRIFT_BUCKETS)[number];

export interface RepoDriftState {
  visibility: "public" | "private";
  /** Repo default branch (e.g. "main", "master", "git-annex"). */
  defaultBranch: string;
  /** Is the NEMAR branch ruleset present on this repo? */
  hasBranchRuleset: boolean;
  /** Required status-check contexts the active ruleset enforces. */
  rulesetContexts: string[];
  /** Required status-check contexts this repo SHOULD enforce (deriveContexts). */
  expectedContexts: string[];
  /** Both bids-validation + version-check workflow files present? */
  hasRequiredWorkflows: boolean;
  /** Count of direct collaborators holding only `pull`/read. */
  directReadGrants: number;
  /**
   * Whether the required BIDS check is green on the default-branch HEAD.
   * null when not determinable / not applicable (e.g. unprotected private).
   */
  requiredCheckGreen: boolean | null;
  /** Any deprecated per-repo workflow present (version-doi / generate-archive / llm-enrichment). */
  hasDeprecatedWorkflow: boolean;
  /**
   * What the dataset's row calls for as to the required review (`reviewIntentOf`): `require` for
   * a dataset the Worker reviews while the requirement is the target (the review is on and the
   * owner has turned the automatic requirement on), `remove` for one it does not review whatever
   * the switches say, and `undefined` where the tooling has no say (the requirement is not the
   * target yet, or a standing fixture).
   */
  reviewIntent: ReviewIntent | undefined;
  /**
   * The review ruleset on the repository, or null when it was not asked about (no intent) or
   * GitHub could not say. An unknown is never an absence: no review bucket is reported for it.
   */
  reviewRuleset: { present: boolean; active: boolean } | null;
}

/** Sorted, deduped contexts for order-independent comparison. */
function normContexts(c: string[]): string {
  return [...new Set(c)].sort().join("|");
}

/**
 * Return every drift bucket a repo violates, or `["COMPLIANT"]` if none. A repo
 * can be in several buckets at once (e.g. PUBLIC_UNPROTECTED + MISSING_REQUIRED_WORKFLOW).
 */
export function classifyDatasetDrift(state: RepoDriftState): DriftBucket[] {
  const buckets: DriftBucket[] = [];
  const isPublic = state.visibility === "public";

  if (state.defaultBranch !== "main") buckets.push("DEFAULT_BRANCH_OUTLIER");
  if (!state.hasRequiredWorkflows) buckets.push("MISSING_REQUIRED_WORKFLOW");
  if (state.hasDeprecatedWorkflow) buckets.push("DEPRECATED_WORKFLOW_PRESENT");

  // Stray direct read grants: meaningful on private (real over-grant); on public
  // they are harmless noise that reconcile strips, so only flag private here.
  if (!isPublic && state.directReadGrants > 0) buckets.push("PRIVATE_WITH_STRAY_READ");

  if (isPublic) {
    if (!state.hasBranchRuleset) {
      buckets.push("PUBLIC_UNPROTECTED");
    } else {
      // Protected: the required contexts must match what the repo emits, and the
      // check must be green (a protected repo with a red required check is a live
      // merge deadlock).
      if (normContexts(state.rulesetContexts) !== normContexts(state.expectedContexts)) {
        buckets.push("CONTEXT_NAME_MISMATCH");
      }
      if (state.requiredCheckGreen === false) buckets.push("RED_REQUIRED_CHECK");
    }
  }

  // The required review. A ruleset that is present and not enforcing (the break-glass rollback
  // switches it off and leaves it) requires nothing, so it counts as missing. On a repository
  // whose default branch is not main the ruleset would not be written (it follows the default
  // branch, the Worker reviews pull requests to main), so that is the outlier's finding and
  // not this one's.
  const review = state.reviewRuleset;
  if (review !== null) {
    if (
      state.reviewIntent === "require" &&
      state.defaultBranch === "main" &&
      !(review.present && review.active)
    ) {
      buckets.push("REVIEW_RULESET_MISSING");
    }
    if (state.reviewIntent === "remove" && review.present) buckets.push("REVIEW_RULESET_STRAY");
  }

  return buckets.length > 0 ? buckets : ["COMPLIANT"];
}

/**
 * Gather a repo's live GitHub state for drift classification. `visibility` comes
 * from the D1 ledger (caller); everything else is read from GitHub. Each read is
 * individually fault-tolerant so one slow/failed call doesn't abort the report.
 */
export async function gatherRepoDriftState(
  repo: string,
  visibility: "public" | "private",
  pat: string,
  reviewIntent?: ReviewIntent,
): Promise<RepoDriftState> {
  const expected = deriveContexts(repo);
  const [defaultBranch, ruleset, workflows, collaborators, reviewRuleset] = await Promise.all([
    getRepoDefaultBranch(repo, pat).catch(() => "main"),
    getBranchRulesetInfo(repo, pat).catch(() => ({ present: false, contexts: [] as string[] })),
    listRepoWorkflows(repo, pat).catch(() => [] as string[]),
    listDirectCollaborators(repo, pat).catch(() => []),
    // Only asked when the dataset calls for something, and unknown (null) when GitHub cannot say.
    reviewIntent === undefined
      ? Promise.resolve(null)
      : getReviewRulesetInfo(repo, pat).catch(() => null),
  ]);

  let requiredCheckGreen: boolean | null = null;
  if (visibility === "public" && ruleset.present) {
    const g = await checkRunGreenOnDefaultHead(repo, defaultBranch, expected[0], pat).catch(() => ({
      green: false,
      reason: "fetch_error" as const,
    }));
    requiredCheckGreen = g.green;
  }

  return {
    visibility,
    defaultBranch,
    hasBranchRuleset: ruleset.present,
    rulesetContexts: ruleset.contexts,
    expectedContexts: expected.map((c) => c.context),
    hasRequiredWorkflows: REQUIRED_WORKFLOWS.every((w) => workflows.includes(w)),
    directReadGrants: collaborators.filter((c) => c.role_name === "read" || c.role_name === "pull")
      .length,
    requiredCheckGreen,
    hasDeprecatedWorkflow: workflows.some((w) => DEPRECATED_WORKFLOWS.has(w)),
    reviewIntent,
    reviewRuleset,
  };
}
