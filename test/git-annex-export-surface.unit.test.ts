/**
 * Pins the runtime export surface of lib/git-annex/* across the #902/#908
 * split (git-annex.ts was decomposed into lib/git-annex/* concern modules
 * and deleted; importers point directly at the concern modules -- no barrel).
 *
 * Why runtime keys: test/ is not typechecked, so an export dropped during a
 * move would otherwise only surface as a distant import failure. This test
 * fails loudly and names the missing/extra symbol instead.
 *
 * Two layers of pinning:
 * - Per-module maps pin PLACEMENT (a symbol silently migrating between
 *   modules breaks importers at runtime even when the union is intact).
 * - The union of all modules minus INTERNAL_WIRING must equal the pre-split
 *   monolith surface (MONOLITH_EXPORTS below, captured at #908 commit 1 and
 *   updated by the declared removals in commits 2-3: the formatBytes
 *   pass-through re-export and the deprecated createDataladDataset/
 *   isDataladDataset aliases), plus the declared addition of
 *   batchSetKeysAbsent in #1396, the counterpart that withdraws a presence
 *   claim the bucket cannot back.
 *
 * INTERNAL_WIRING lists symbols exported ONLY so sibling git-annex/* modules
 * can import them (declared in #908): not part of the CLI-facing surface.
 *
 * Type-only exports (S3RemoteConfig, PrerequisitesResult, LocalDatasetInfo,
 * ...) do not appear as runtime keys; those are covered by `bun run
 * typecheck`.
 *
 * If this test fails after an intentional API change, update the lists in
 * the same commit and say so in the commit message.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const MODULE_EXPORTS: Record<string, string[]> = {
  "run-command": [
    "INACTIVITY_WARNING_AFTER_MS",
    "credentialValues",
    "redactCredentials",
    "runCommand",
  ],
  prereq: [
    "checkAWSCredentials",
    "checkDownloadPrerequisites",
    "checkGitAnnexInstalled",
    "checkGitHubSSH",
    "checkPrerequisites",
    "isVersionCompatible",
  ],
  init: [
    "ADD_CHUNK_MAX_BYTES",
    "ADD_CHUNK_MAX_PATHS",
    "ANNEX_CLONE_DESCRIPTION",
    "ANNEX_DEPOSIT_DESCRIPTION",
    "ANNEX_UPSTREAM_DESCRIPTION",
    "chunkAddTargets",
    "configureLargefiles",
    "ensureGitAnnexInitialized",
    "gitAnnexAdd",
    "initDataset",
    "isDefaultAnnexDescription",
    "isGitAnnexDataset",
    "parseAddFailures",
    "parseAddOutput",
    "replaceDefaultAnnexDescription",
    "unstageTrackedPaths",
  ],
  policy: [
    "ANNEX_DATA_EXTENSIONS",
    "ANNEX_DATA_GLOBS",
    "ANNEX_SIZE_THRESHOLD_BYTES",
    "NEVER_ANNEX_GLOBS",
    "buildLargefilesExpression",
    "describeAnnexSizeThreshold",
    "isCaseVariantData",
    "isCurrentLargefilesExpression",
    "isNeverAnnexedMetadata",
    "shouldAnnex",
  ],
  "s3-remote": [
    "ANNEX_REMOTE_EXISTS_RE",
    "DEFAULT_S3_PARTSIZE",
    "NEMAR_S3_REMOTE_NAME",
    "annexRemoteExists",
    "awsCredentialEnv",
    "buildS3RemoteArgs",
    "clearAnnexCredentials",
    "configureS3Remote",
    "enableS3Remote",
    "getAnnexS3Remotes",
    "initOrEnableSpecialRemote",
    "markInheritedOpenNeuroRemotesIgnored",
    "selectAnnexS3Remote",
    "toS3Credentials",
  ],
  github: [
    "acceptGitHubInvitation",
    "configureGitHubRemote",
    "getGitHubToken",
    "githubTokenCredentialHelper",
    "resolveGitHubCloneAuth",
    "verifyGitHubAuth",
  ],
  "clone-push": [
    "clearStaleAssumeUnchanged",
    "clearStaleFlags",
    "cloneDataset",
    "commitRevert",
    "compareRecordedStat",
    "createRevertBranch",
    "describeChangedSinceTracked",
    "describeStaleFlagFailure",
    "isNonFastForwardPush",
    "pushAnnexBranchToGitHub",
    "pushBranch",
    "pushToGitHub",
    "saveDataset",
    "setAssumeUnchanged",
  ],
  transfer: [
    "MAX_UNAVAILABLE_SAMPLE",
    "batchSetKeysAbsent",
    "batchSetKeysPresent",
    "checkRemoteHolds",
    "classifyGetOutcome",
    "collectFileManifest",
    "copyPathsToAnnexRemote",
    "copyToAnnexRemote",
    "countPendingDownload",
    "dropFiles",
    "dropUnusedAnnexObjects",
    "extractCopyError",
    "extractCopyJsonError",
    "extractWhereisKeyUrl",
    "getAnnexKeysForPaths",
    "getAnnexWhereisAll",
    "getDatasetData",
    "getKeyHashDir",
    "getKeyHashDirs",
    "getRemoteUuid",
    "listAnnexedKeys",
    "parseCopyJson",
    "parseFsckJson",
    "setKeyPresent",
  ],
  "repo-state": [
    "detectImportMarker",
    "ensureLocalMainBranch",
    "getCurrentBranch",
    "getDatasetIdFromRemote",
    "getDatasetStats",
    "getLocalDatasetInfo",
    "getVersionCommit",
    "gitFetchOrigin",
    "gitMergeFastForward",
    "isWorkingTreeDirty",
    "listDatasetVersions",
    "readLocalDatasetVersion",
    "readRemoteHeadDatasetVersion",
    "resolveUpstreamRef",
    "switchBranch",
  ],
};

/**
 * Exported only for sibling git-annex/* modules or for unit testing; never part
 * of the CLI-facing surface, so excluded from the MONOLITH_EXPORTS union check.
 * - getGitHubToken: imported by clone-push.ts.
 * - buildS3RemoteArgs / DEFAULT_S3_PARTSIZE / extractCopyError: exported for
 *   #886 unit tests (partsize + copy-error surfacing); internal otherwise.
 * - classifyGetOutcome / MAX_UNAVAILABLE_SAMPLE: exported for #1038 unit tests
 *   (partial-retrieval classification); internal otherwise.
 * - chunkAddTargets / ADD_CHUNK_MAX_PATHS / ADD_CHUNK_MAX_BYTES: exported for
 *   #884 unit tests (argv chunking of targeted adds); internal otherwise.
 * - isVersionCompatible: exported for epic #1225 phase 6 unit tests (the
 *   git-annex version comparator, since checkGitAnnexInstalled() shells out
 *   to the git-annex binary and can't be driven end-to-end offline);
 *   internal otherwise.
 */
const INTERNAL_WIRING = [
  "getGitHubToken",
  "buildS3RemoteArgs",
  "DEFAULT_S3_PARTSIZE",
  "extractCopyError",
  "classifyGetOutcome",
  "MAX_UNAVAILABLE_SAMPLE",
  "chunkAddTargets",
  "ADD_CHUNK_MAX_PATHS",
  "ADD_CHUNK_MAX_BYTES",
  // Parses per-file errors from the list-form git-annex batch add.
  "parseAddFailures",
  // Parses success paths and per-file failures from the batch-add JSON stream.
  "parseAddOutput",
  "isVersionCompatible",
  // Moved from import-normalize.ts so the upload can share it without importing the
  // import pipeline; consumed by sibling modules only.
  "unstageTrackedPaths",
  // Non-identifying annex repository descriptions (#1399).
  "ANNEX_CLONE_DESCRIPTION",
  "ANNEX_DEPOSIT_DESCRIPTION",
  "ANNEX_UPSTREAM_DESCRIPTION",
  "isDefaultAnnexDescription",
  "replaceDefaultAnnexDescription",
  // Annex-only guarded push used after S3 copy has advanced git-annex.
  "pushAnnexBranchToGitHub",
  // policy.ts postdates the split (#1158). Its surface is consumed by sibling
  // git-annex modules and by import-openneuro, never by the CLI directly, so
  // none of it belongs to the pre-split monolith surface below.
  "ANNEX_DATA_EXTENSIONS",
  "ANNEX_DATA_GLOBS",
  "ANNEX_SIZE_THRESHOLD_BYTES",
  "NEVER_ANNEX_GLOBS",
  "buildLargefilesExpression",
  "describeAnnexSizeThreshold",
  "isCaseVariantData",
  "isCurrentLargefilesExpression",
  "isNeverAnnexedMetadata",
  "shouldAnnex",
  // Also post-split (#1159): the path-scoped copy and the path->key map exist for
  // import-normalize.ts, which moves files upstream left in git into the annex.
  // Consumed there, never by the CLI.
  "copyPathsToAnnexRemote",
  "getAnnexKeysForPaths",
  "listAnnexedKeys",
  // The upload S3 step's JSON copy accounting, its presence check for files with no
  // local content, the credential redaction of what both print, and its save-step
  // helper: unit tested, consumed by sibling modules only.
  "parseCopyJson",
  "extractCopyJsonError",
  "checkRemoteHolds",
  "parseFsckJson",
  "setAssumeUnchanged",
  // The credential redaction of what a subprocess prints, shared by the verbose log and
  // the copy and presence-check errors: unit tested, consumed by sibling modules only.
  "credentialValues",
  "redactCredentials",
  // The focused runCommand test pins the production inactivity threshold.
  "INACTIVITY_WARNING_AFTER_MS",
  // The stat guard, the stale-flag clear and the failure text of saveDataset's skip:
  // unit tested, consumed by saveDataset itself and the tests.
  "clearStaleAssumeUnchanged",
  "clearStaleFlags",
  "compareRecordedStat",
  "describeChangedSinceTracked",
  "describeStaleFlagFailure",
];

/**
 * The git-annex.ts monolith's runtime surface: captured at #908 commit 1,
 * minus the declared removals from commits 2-3 (formatBytes pass-through,
 * createDataladDataset/isDataladDataset aliases).
 */
const MONOLITH_EXPORTS = [
  "ANNEX_REMOTE_EXISTS_RE",
  "NEMAR_S3_REMOTE_NAME",
  "acceptGitHubInvitation",
  "annexRemoteExists",
  "awsCredentialEnv",
  "batchSetKeysAbsent",
  "batchSetKeysPresent",
  "checkAWSCredentials",
  "checkDownloadPrerequisites",
  "checkGitAnnexInstalled",
  "checkGitHubSSH",
  "checkPrerequisites",
  "clearAnnexCredentials",
  "cloneDataset",
  "collectFileManifest",
  "commitRevert",
  "configureGitHubRemote",
  "configureLargefiles",
  "configureS3Remote",
  "copyToAnnexRemote",
  "countPendingDownload",
  "createRevertBranch",
  "detectImportMarker",
  "dropFiles",
  "dropUnusedAnnexObjects",
  "enableS3Remote",
  "ensureGitAnnexInitialized",
  "ensureLocalMainBranch",
  "extractWhereisKeyUrl",
  "getAnnexS3Remotes",
  "getAnnexWhereisAll",
  "getCurrentBranch",
  "getDatasetData",
  "getDatasetIdFromRemote",
  "getDatasetStats",
  "getKeyHashDir",
  "getKeyHashDirs",
  "getLocalDatasetInfo",
  "getRemoteUuid",
  "getVersionCommit",
  "gitAnnexAdd",
  "gitFetchOrigin",
  "gitMergeFastForward",
  "githubTokenCredentialHelper",
  "initDataset",
  "initOrEnableSpecialRemote",
  "isGitAnnexDataset",
  "isNonFastForwardPush",
  "isWorkingTreeDirty",
  "listDatasetVersions",
  "markInheritedOpenNeuroRemotesIgnored",
  "pushBranch",
  "pushToGitHub",
  "readLocalDatasetVersion",
  "readRemoteHeadDatasetVersion",
  "resolveGitHubCloneAuth",
  "resolveUpstreamRef",
  "runCommand",
  "saveDataset",
  "selectAnnexS3Remote",
  "setKeyPresent",
  "switchBranch",
  "toS3Credentials",
  "verifyGitHubAuth",
];

describe("lib/git-annex export surface", () => {
  for (const [mod, expected] of Object.entries(MODULE_EXPORTS)) {
    test(`git-annex/${mod} runtime exports match the pin exactly`, async () => {
      const m = await import(`../src/lib/git-annex/${mod}.ts`);
      expect(Object.keys(m).sort()).toEqual(expected);
    });
  }

  test("union of module exports equals the monolith surface", () => {
    const union = new Set(Object.values(MODULE_EXPORTS).flat());
    for (const w of INTERNAL_WIRING) union.delete(w);
    expect([...union].sort()).toEqual(MONOLITH_EXPORTS);
  });

  test("every file in lib/git-annex/ has a pin entry (no orphan modules)", () => {
    const files = readdirSync(join(import.meta.dir, "../src/lib/git-annex"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.replace(/\.ts$/, ""))
      .sort();
    expect(files).toEqual(Object.keys(MODULE_EXPORTS).sort());
  });
});
