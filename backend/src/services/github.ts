/**
 * GitHub API service — barrel over the services/github/* concern modules.
 *
 * Regrouped by concern in #906 (epic #902): transport (githubFetchWithRetry +
 * isolate-scoped rate-limit state), repos, collaborators, contents, workflows,
 * dispatch, callback-tokens, bids-tree, branch-protection. GitHub App/PAT
 * auth lives separately in services/github-auth.ts.
 *
 * The explicit named re-exports below PIN the module's public surface
 * (asserted by test/github-export-surface.unit.test.ts). Symbols exported by
 * the sub-modules purely for cross-module wiring (GITHUB_API,
 * VALIDATOR_VERSION, errText, ghHeaders in github/shared.ts) are deliberately
 * not re-exported here.
 *
 * Keep external consumers importing from THIS module, not from the
 * sub-modules: backend/test/manifest-small-root-files.test.ts replaces this
 * module via mock.module() and relies on consumers (services/manifest.ts)
 * resolving getTreeAtRef/getBlobContent through it.
 */

export {
  applyTagProtection,
  BRANCH_RULESET_NAME,
  buildBranchRulesetPayload,
  checkRunGreenOnDefaultHead,
  deriveContexts,
  ensureBranchRuleset,
  ensureRepoToSpec,
  getBranchRulesetInfo,
  isRequiredCheckGreen,
  listRepoWorkflows,
  NEMAR_APP_ID,
  removeBranchRuleset,
} from "./github/branch-protection";
export type {
  BranchRulesetPayload,
  RepoSpecResult,
  RequiredCheck,
} from "./github/branch-protection";
export {
  getBidsTreeStats,
  modalitiesFromSubjectSubtree,
  sampleEvenly,
  tasksFromSubjectSubtree,
} from "./github/bids-tree";
export type { BidsTreeStats } from "./github/bids-tree";
export {
  IDENTIFIER_SCREEN_TOKEN_DOMAIN,
  IDENTIFIER_SWEEP_TOKEN_DOMAIN,
  signApprovalDispatchToken,
  signIdentifierScreenCallbackToken,
  signIdentifierSweepCallbackToken,
  signManifestCallbackToken,
  signPrescreenCallbackToken,
  verifyApprovalDispatchToken,
  verifyIdentifierScreenCallbackToken,
  verifyIdentifierSweepCallbackToken,
  verifyManifestCallbackToken,
  verifyPrescreenCallbackToken,
} from "./github/callback-tokens";
export type {
  ApprovalDispatchTokenPayload,
  IdentifierScreenCallbackPayload,
  IdentifierSweepCallbackPayload,
  ManifestCallbackPayload,
  PrescreenCallbackPayload,
} from "./github/callback-tokens";
export {
  addCollaborator,
  addCollaboratorToAllRepos,
  computeCollaboratorActions,
  listDirectCollaborators,
  listOrgAdmins,
  reconcileCollaborators,
  removeCollaborator,
  removeCollaboratorFromAllRepos,
} from "./github/collaborators";
export type {
  CollaboratorActions,
  CollaboratorReconcileResult,
  DirectCollaborator,
} from "./github/collaborators";
export {
  commitEnrichmentWithBidsignore,
  commitFilesAsTree,
  createOrUpdateFile,
  createRelease,
  createTag,
  deleteRepoFile,
  downloadReleaseArchive,
  EnrichmentCommitError,
  getBlobContent,
  getFileContent,
  getMainBranchSha,
  getTreeAtRef,
  isContentsApiShaConflict,
} from "./github/contents";
export type {
  EnrichmentCommitResult,
  TreeEntry,
  TreeFile,
} from "./github/contents";
export {
  addIssueComment,
  closeIssue,
  createIssue,
  issueLabelNames,
  listOpenIssuesByLabel,
  setIssueLabels,
  updateIssue,
} from "./github/issues";
export type { GitHubIssue } from "./github/issues";
export {
  buildBidsValidationDispatch,
  CENTRAL_WORKFLOW_REPO,
  IdentifierScreenDispatchRejected,
  triggerArchiveGeneration,
  triggerBidsValidation,
  triggerEnrichmentRun,
  triggerIdentifierScreenRun,
  triggerManifestGeneration,
  triggerOpenNeuroOnboard,
  triggerPrescreenRun,
  triggerVersionDoiRun,
} from "./github/dispatch";
export {
  createRepository,
  deleteRepository,
  enableAutoMerge,
  ensureMainBranch,
  getRepoDefaultBranch,
  listOrgRepos,
  sanitizeRepoDescription,
  setRepoDescription,
  setRepoVisibility,
  validateGitHubUsername,
} from "./github/repos";
export type { GitHubRepo, GitHubUser, GitHubUserLookup } from "./github/repos";
export { ORG_NAME } from "./github/shared";
export {
  __resetRateLimitStateForTests,
  __seedRateLimitStateForTests,
  githubFetchWithRetry,
} from "./github/transport";
export {
  checkWorkflowExists,
  deployWorkflows,
  ensureWorkflowsDeployed,
  getWorkflowRuns,
  getWorkflowTemplates,
  syncWorkflowTemplates,
  validateDeployedWorkflows,
  VERSION_COMPARE_SNIPPET,
} from "./github/workflows";
export type {
  EnsureWorkflowsResult,
  SyncWorkflowsResult,
} from "./github/workflows";
