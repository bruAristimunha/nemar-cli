/**
 * Pins the runtime export surface of services/github across the #902/#906
 * regroup (github.ts becomes a barrel of explicit named re-exports over
 * services/github/* concern modules).
 *
 * Why runtime keys: neither test/ nor backend/test/ is typechecked, and
 * backend/src is not typechecked in PR CI at all, so a re-export dropped from
 * the barrel would otherwise only surface as a downstream import failure.
 * This test fails loudly and names the missing/extra symbol instead.
 *
 * Type-only exports (GitHubRepo, TreeEntry, TreeFile, ...) do not appear as
 * runtime keys; those are covered by `cd backend && bun run typecheck` locally.
 *
 * The pinned list was captured from the github.ts monolith as of #906
 * commit 1, BEFORE any code moved. Symbols that gain `export` at the
 * sub-module level purely for cross-module wiring (GITHUB_API,
 * VALIDATOR_VERSION, errText, ghHeaders) are deliberately NOT re-exported by
 * the barrel and must never appear here. If this test fails after an
 * intentional API change, update the list in the same commit and say so in
 * the commit message.
 */

import { describe, expect, test } from "bun:test";

const EXPECTED_EXPORTS = [
  "BRANCH_RULESET_NAME",
  "CENTRAL_WORKFLOW_REPO",
  "EnrichmentCommitError",
  "IDENTIFIER_SCREEN_TOKEN_DOMAIN",
  "IDENTIFIER_SWEEP_TOKEN_DOMAIN",
  "IdentifierScreenDispatchRejected",
  "NEMAR_APP_ID",
  "ORG_NAME",
  "VERSION_COMPARE_SNIPPET",
  "__resetRateLimitStateForTests",
  "__seedRateLimitStateForTests",
  "addCollaborator",
  "addCollaboratorToAllRepos",
  "addIssueComment",
  "applyTagProtection",
  "buildBidsValidationDispatch",
  "buildBranchRulesetPayload",
  "checkRunGreenOnDefaultHead",
  "checkWorkflowExists",
  "closeIssue",
  "commitEnrichmentWithBidsignore",
  "commitFilesAsTree",
  "computeCollaboratorActions",
  "createIssue",
  "createOrUpdateFile",
  "createRelease",
  "createRepository",
  "createTag",
  "deleteRepoFile",
  "deleteRepository",
  "deployWorkflows",
  "deriveContexts",
  "downloadReleaseArchive",
  "enableAutoMerge",
  "ensureBranchRuleset",
  "ensureMainBranch",
  "ensureRepoToSpec",
  "ensureWorkflowsDeployed",
  "getBidsTreeStats",
  "getBlobContent",
  "getBranchRulesetInfo",
  "getFileContent",
  "getMainBranchSha",
  "getRepoDefaultBranch",
  "getTreeAtRef",
  "getWorkflowRuns",
  "getWorkflowTemplates",
  "githubFetchWithRetry",
  "isContentsApiShaConflict",
  "isRequiredCheckGreen",
  "issueLabelNames",
  "listDirectCollaborators",
  "listOpenIssuesByLabel",
  "listOrgAdmins",
  "listOrgRepos",
  "listRepoWorkflows",
  "modalitiesFromSubjectSubtree",
  "reconcileCollaborators",
  "removeBranchRuleset",
  "removeCollaborator",
  "removeCollaboratorFromAllRepos",
  "sampleEvenly",
  "sanitizeRepoDescription",
  "setIssueLabels",
  "setRepoDescription",
  "setRepoVisibility",
  "signApprovalDispatchToken",
  "signIdentifierScreenCallbackToken",
  "signIdentifierSweepCallbackToken",
  "signManifestCallbackToken",
  "signPrescreenCallbackToken",
  "syncWorkflowTemplates",
  "tasksFromSubjectSubtree",
  "triggerArchiveGeneration",
  "triggerBidsValidation",
  "triggerEnrichmentRun",
  "triggerIdentifierScreenRun",
  "triggerManifestGeneration",
  "triggerOpenNeuroOnboard",
  "triggerPrescreenRun",
  "triggerVersionDoiRun",
  "updateIssue",
  "validateDeployedWorkflows",
  "validateGitHubUsername",
  "verifyApprovalDispatchToken",
  "verifyIdentifierScreenCallbackToken",
  "verifyIdentifierSweepCallbackToken",
  "verifyManifestCallbackToken",
  "verifyPrescreenCallbackToken",
];

describe("services/github export surface", () => {
  test("runtime exports match the pre-regroup pin exactly", async () => {
    const github = await import("../backend/src/services/github");
    expect(Object.keys(github).sort()).toEqual(EXPECTED_EXPORTS);
  });
});
