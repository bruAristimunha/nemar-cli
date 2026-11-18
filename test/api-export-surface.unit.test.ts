/**
 * Pins the runtime export surface of lib/api/* across the #902/#908 split
 * (api.ts was decomposed into lib/api/* endpoint-group modules and deleted;
 * importers point directly at the group modules -- no barrel).
 *
 * Why runtime keys: test/ is not typechecked, so an export dropped during a
 * move would otherwise only surface as a distant import failure. This test
 * fails loudly and names the missing/extra symbol instead.
 *
 * Two layers of pinning:
 * - Per-module maps pin PLACEMENT (a symbol silently migrating between
 *   modules breaks importers at runtime even when the union is intact).
 * - The union of all modules minus INTERNAL_WIRING must equal the pre-split
 *   monolith surface (MONOLITH_EXPORTS below, captured at #908 commit 1
 *   before any code moved) so nothing is dropped or invented.
 *
 * INTERNAL_WIRING lists symbols exported ONLY so sibling api/* modules can
 * import them (declared in #908): they are not part of the CLI-facing
 * surface and must never leak into MONOLITH_EXPORTS.
 *
 * Type-only exports (Dataset, VersionManifest, NemarMetadataPayload, ...) do
 * not appear as runtime keys; those are covered by `bun run typecheck`.
 *
 * If this test fails after an intentional API change, update the lists in
 * the same commit and say so in the commit message.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const MODULE_EXPORTS: Record<string, string[]> = {
  errors: ["ApiError", "MaintenanceError", "errorDetail", "isRouteNotFound"],
  client: ["IS_DEV_BUILD", "checkHealth", "getApiUrl", "request"],
  auth: [
    "checkGitHubUsername",
    "checkOrcidName",
    "checkSSHKeyStatus",
    "checkUsername",
    "completeSandbox",
    "createApiKey",
    "getCurrentUser",
    "getSandboxStatus",
    "listApiKeys",
    "login",
    "mintDocsSession",
    "pollDeviceToken",
    "registerSSHKey",
    "requestEmailChange",
    "requestKeyRegeneration",
    "requestUploadAccess",
    "resendVerification",
    "resetSandbox",
    "revokeApiKey",
    "revokeApiKeyWithBearer",
    "startDeviceAuth",
    "startOrcidCliLink",
    "suggestUsername",
    "unlinkOrcid",
    "updateProfile",
    "verifyEmailChange",
  ],
  datasets: [
    "ORCID_REGEX",
    "approveAccessRequest",
    "createDataset",
    "denyAccessRequest",
    "finalizeDataset",
    "getDataset",
    "getFacets",
    "getManifest",
    "getUserCiStatus",
    "getVersionHistory",
    "hasReleasedVersion",
    "inviteCollaborator",
    "listAccessRequests",
    "listCollaborators",
    "listDatasets",
    "listManifestVersions",
    "recordDepositAttestation",
    "requestDatasetAccess",
    "resolveSourceId",
    "searchDatasets",
    "submitEnrichment",
    "validateDataset",
  ],
  publish: [
    "PUBLICATION_STEPS",
    "approvePublication",
    "commentOnPublication",
    "denyPublication",
    "getPublicationReview",
    "getPublishStatus",
    "isRetryablePublishError",
    "listPublishRequests",
    "requestPublication",
    "rerunIdentifierScreen",
    "resendPublishNotification",
    "reviewErrorCode",
    "startPublicationReview",
    "stepIndexFor",
    "withdrawPublishRequest",
  ],
  data: [
    "OBJECTS_PER_EXPLICIT_LOCK",
    "applyS3Lock",
    "getDatasetFiles",
    "lockS3Objects",
    "requestDownloadCredentials",
    "requestUploadCredentials",
    "requestUploadUrls",
  ],
  admin: [
    "addCi",
    "addMailBlock",
    "addMailNote",
    "anonymitySweep",
    "anonymitySweepReset",
    "approveUser",
    "approveUserById",
    "assignMailTicket",
    "availabilityReport",
    "availabilityReportSweep",
    "availabilityReportSweepReset",
    "backfillUserNames",
    "backfillUsernames",
    "bulkDeleteDatasets",
    "changeUserRole",
    "clearIdentityConflict",
    "clearPrReviewAuthor",
    "createConceptDoi",
    "createExemplar",
    "createKeyFor",
    "dataIntegritySweep",
    "dataIntegritySweepReset",
    "deleteDataset",
    "dispatchCooldown",
    "dispatchManifest",
    "doctorFix",
    "doctorScan",
    "editAdminUser",
    "enforceBulk",
    "enforceDataset",
    "escalateMailTicket",
    "getAdminUserById",
    "getAdminUserByUsername",
    "getBroadcastStatus",
    "getCiStatus",
    "getDoiInfo",
    "getEmailPreferences",
    "getFleetDrift",
    "getImportStatus",
    "getMailAvailability",
    "getMailTicket",
    "getNeurobagelStatus",
    "getPrReview",
    "getPrReviewAuthor",
    "getSummaryCoverage",
    "getUserDuplicates",
    "getUsernameById",
    "hedSweep",
    "hedSweepReset",
    "importCoverageSweep",
    "importDataset",
    "importIssueTriage",
    "importWeeklySummary",
    "listKeysFor",
    "listMailBlocklist",
    "listMailQueues",
    "listMailTickets",
    "listPrReviews",
    "listUsers",
    "markMailTicketSpam",
    "neurobagelRegenerate",
    "neurobagelVerify",
    "publishDataset",
    "publishVersionDoi",
    "publishZarrCatalog",
    "putMailAvailability",
    "putMailQueue",
    "recordingStatsSweep",
    "recordingStatsSweepReset",
    "reindexBulk",
    "reindexDataset",
    "remintExemplarDois",
    "removeMailBlock",
    "replyToMailTicket",
    "reprocessMail",
    "resetTestDataset",
    "restoreDataset",
    "retryImport",
    "revalidateDataset",
    "reviewRuleset",
    "reviewRulesetBulk",
    "revokeKeyFor",
    "revokeUser",
    "revokeUserById",
    "rollbackImport",
    "sendBroadcast",
    "setAccountKind",
    "setMailTicketStatus",
    "setMailTicketSummary",
    "setPrReviewAuthor",
    "signalDefaultsSweep",
    "signalDefaultsSweepReset",
    "startPrReview",
    "syncCi",
    "unpublishDataset",
    "updateDoi",
    "updateEmailPreferences",
    "uploadTierOf",
    "upstreamBackfill",
    "upstreamStatus",
    "validateCi",
    "verifyImport",
    "verifyUserById",
    "waivePrReviewNaming",
    "withdrawDataset",
    "zarrFidelitySweep",
  ],
  notices: ["NOTICE_LEVELS", "createNotice", "deleteNotice", "getNotices", "listAdminNotices"],
  oidc: [
    "createOidcClient",
    "disableOidcClient",
    "endOidcAccount",
    "getOidcClient",
    "listOidcClients",
    "listOidcKeys",
    "listOidcLogoutDeliveries",
    "oidcErrorCode",
    "oidcSecretWord",
    "revokeOidcKey",
    "rotateOidcClientSecret",
    "rotateOidcKeys",
  ],
  repull: [
    "acceptRepullMergeTrailers",
    "acknowledgeRepullScreen",
    "checkRepullMergeClaim",
    "createRepull",
    "dispatchRepullScreen",
    "getRepull",
    "getRepullSwitches",
    "listRepullDispatches",
    "listRepullScreens",
    "listRepulls",
    "recordRepullMerged",
    "recordRepullReleased",
    "releaseRepullMergeClaim",
    "repullErrorCode",
    "transitionRepull",
  ],
  compute: [
    "adjustAccountComputePool",
    "adjustPlatformComputePool",
    "advanceComputeJobAsAdmin",
    "cancelComputeJobAsAdmin",
    "computeRefusalCode",
    "getAccountComputePools",
    "getComputeAccessReport",
    "getComputeAccountReport",
    "getComputePipelineStatus",
    "getComputePolicy",
    "getComputeRecord",
    "getComputeStatus",
    "grantAccountComputePool",
    "grantPlatformComputePool",
    "listComputeAccessReports",
    "listComputeHolds",
    "listComputeJobs",
    "listComputePools",
    "listUnmatchedComputeRows",
    "mintComputeObserverRun",
    "placeComputeHold",
    "putComputePolicy",
    "readComputeRecord",
    "releaseComputeHold",
    "requeueComputeAccessReport",
    "runComputePipeline",
  ],
  // Portable compute, card DM-05: the owner's runner registry (`nemar admin compute runners`), and card S6's
  // usage report (`nemar admin compute runners usage`).
  "compute-runners": [
    "RunnerListResponseSchema",
    "RunnerRevokeResponseSchema",
    "RunnerViewSchema",
    "getComputeRunnersUsage",
    "listComputeRunners",
    "registerComputeRunner",
    "revokeComputeRunner",
  ],
};

/** Exported only for sibling api/* modules; never part of the CLI surface. */
const INTERNAL_WIRING = ["request"];

/**
 * CLI-facing symbols added to lib/api/* AFTER the #908 split.
 *
 * Subtracted from the union like INTERNAL_WIRING, but for the opposite
 * reason: these ARE part of the CLI surface, they simply post-date the
 * monolith. Keeping them in their own list means MONOLITH_EXPORTS stays a
 * faithful capture of what api.ts exported at #908 commit 1, rather than
 * being retro-edited to claim it exported names that never existed there —
 * which would quietly destroy the "nothing invented" guarantee for every
 * future reviewer.
 *
 * Per-module placement is still pinned above, so these get the same
 * protection every other symbol has.
 */
const POST_SPLIT_ADDITIONS = [
  "recordDepositAttestation", // epic #1610 phase 3, ADR 0087: PUT /datasets/:id/attestation
  "getApiUrl", // #1401: the data plane is this origin + /data (lib/http-download.ts)
  "mintDocsSession", // #1341, epic #1336 phase 3: POST /auth/docs/cli-session
  "NOTICE_LEVELS", // #1025, notice level vocabulary
  "approveUserById", // #1012, id-keyed approve for web/ORCID accounts
  "revokeUserById", // #1274, ADR 0040: id-keyed revoke, the approve twin's eraser
  "verifyUserById", // ADR 0103: owner force verify, POST /admin/users/by-id/:id/verify
  "backfillUserNames", // #1255, epic #1250: POST /admin/users/backfill-names
  "backfillUsernames", // #1253, epic #1250: POST /admin/users/backfill-usernames
  "checkOrcidName", // #1255, epic #1250: GET /auth/orcid-name pre-signup lookup
  "clearIdentityConflict", // #1254, ADR 0043: POST /admin/users/:id/clear-identity-conflict
  "createApiKey", // #1283, epic #1272 phase 3, ADR 0047: POST /auth/keys
  "createKeyFor", // #1284, epic #1272 phase 4, ADR 0048: owner-mint POST /admin/users/:username/keys
  "importCoverageSweep", // #1311, epic #1306 phase 3: POST /admin/imports/coverage-sweep
  "importIssueTriage", // #1310, epic #1306: POST /admin/imports/issue-triage
  "importWeeklySummary", // #1312, epic #1306 phase 4: POST /admin/imports/weekly-summary
  "doctorFix", // #1130, CLI wrapper for POST /admin/doctor/fix
  "doctorScan", // #1130, CLI wrapper for POST /admin/doctor/scan
  "editAdminUser", // ADR 0096: PATCH /admin/users/by-id/:id, `nemar admin users edit`
  "getAdminUserById", // ADR 0096: GET /admin/users/by-id/:id, `nemar admin users show` and `edit`
  "getAdminUserByUsername", // #1284 review, epic #1272 phase 4, ADR 0048: GET /admin/users/:username, read by `nemar admin doctor kinds`
  "getBroadcastStatus", // epic #1893 phase 2: GET /admin/notify/:id, `nemar admin notify --status`
  "getFacets", // #1149, epic #1144 phase 5b: GET /datasets/facets for shell completion
  "getUserDuplicates", // #1254, ADR 0043: GET /admin/users/duplicates
  "listApiKeys", // #1283, epic #1272 phase 3, ADR 0047: GET /auth/keys
  "listKeysFor", // #1284, epic #1272 phase 4, ADR 0048: GET /admin/users/:username/keys
  "pollDeviceToken", // #1283, epic #1272 phase 3, ADR 0047: POST /auth/device/token
  "publishZarrCatalog", // #1062, epic #1181 phase 2: POST /admin/zarr-catalog/publish
  "requestEmailChange", // #1266, ADR 0044: POST /auth/email/change/request
  "revokeApiKey", // #1283, epic #1272 phase 3, ADR 0047: DELETE /auth/keys/:id|current
  "revokeApiKeyWithBearer", // #1289 review: DELETE /auth/keys/:id with an explicit bearer, for revoking a just-minted key whose write to disk failed
  "revokeKeyFor", // #1284, epic #1272 phase 4, ADR 0048: DELETE /admin/users/:username/keys/:id
  "setAccountKind", // #1284, epic #1272 phase 4, ADR 0048: POST /admin/users/:username/kind
  "startDeviceAuth", // #1283, epic #1272 phase 3, ADR 0047: POST /auth/device/start
  "startOrcidCliLink", // #1266, ADR 0044: POST /auth/orcid/cli-start
  "suggestUsername", // #1283, epic #1272 phase 3, ADR 0042/0047: GET /auth/profile/username-suggestion
  "unlinkOrcid", // #1266, ADR 0044: POST /auth/orcid/unlink
  "updateProfile", // #1266, ADR 0044: PATCH /auth/profile
  "verifyEmailChange", // #1266, ADR 0044: POST /auth/email/change/verify
  "requestUploadAccess", // #1253, epic #1250: POST /users/me/upload-access/request
  "recordingStatsSweep", // #1194, CLI wrapper for POST /admin/datasets/recording-stats-sweep
  "recordingStatsSweepReset", // #1194, CLI wrapper for the recording-stats sweep reset
  "signalDefaultsSweep", // #1194, CLI wrapper for POST /admin/datasets/signal-defaults-sweep
  "signalDefaultsSweepReset", // #1194, CLI wrapper for the signal-defaults sweep reset
  "uploadTierOf", // #1251, ADR 0040: upload / browse / unknown from a listed row
  "zarrFidelitySweep", // #1068, epic #1181 phase 8: POST /admin/datasets/zarr-fidelity-sweep
  "upstreamBackfill", // #1908, epic #1046 phase 2, ADR 0111: POST /admin/datasets/upstream-backfill
  "upstreamStatus", // #1910, epic #1046 phase 4, ADR 0111: GET /admin/upstream-status
  "anonymitySweep", // #1409, epic #1406: POST /admin/datasets/anonymity-sweep
  "anonymitySweepReset", // the same route with ?reset=1
  "getNeurobagelStatus", // epic #1586 phase 4, ADR 0084: GET /admin/neurobagel/status
  "neurobagelRegenerate", // epic #1586 phase 4, ADR 0084: POST /admin/neurobagel/regenerate (dry run by default)
  "neurobagelVerify", // epic #1586 phase 6, ADR 0067 amendment: POST /admin/neurobagel/verify (reports only)
  "listPrReviews", // ADR 0093: GET /admin/pr-reviews
  "getPrReview", // ADR 0093: GET /admin/pr-reviews/:dataset/:pr
  "getPrReviewAuthor", // ADR 0093: GET /admin/pr-review-authors/:login
  "setPrReviewAuthor", // ADR 0093: PUT /admin/pr-review-authors/:login (allow or block)
  "clearPrReviewAuthor", // ADR 0093: DELETE /admin/pr-review-authors/:login
  "startPrReview", // ADR 0092: POST /admin/pr-reviews/:dataset/:pr/start (review an open pull request)
  "reviewRuleset", // ADR 0107: POST /admin/datasets/:id/review-ruleset (dry run by default)
  "reviewRulesetBulk", // ADR 0107: POST /admin/datasets/review-ruleset/bulk (owner-only, a page of 50 at most)
  "waivePrReviewNaming", // ADR 0107: POST /admin/pr-reviews/:dataset/:pr/allow (the naming rule's one override)
  "getPublicationReview", // ADR 0102: GET /admin/publish/:id/review
  "startPublicationReview", // ADR 0102: POST /admin/publish/:id/review/start
  "commentOnPublication", // ADR 0102: POST /admin/publish/:id/comment (mails the depositor an administrator's words)
  "reviewErrorCode", // ADR 0102: the closed word of a review route's refusal (rawBody.code, not ApiError.code)
  "isRouteNotFound", // a backend that predates a route answers its not-found body: say so, do not call it a bug
  "hasReleasedVersion", // ADR 0111 decision 10: the import's upstream-moved guard asks GET /datasets/:id/versions
  "addMailNote", // epic #1893 phase 4: `nemar admin mail`, routes in shared/contract/mail-admin.ts
  "assignMailTicket", // epic #1893 phase 4: `nemar admin mail`, routes in shared/contract/mail-admin.ts
  "escalateMailTicket", // epic #1893 phase 4: `nemar admin mail`, routes in shared/contract/mail-admin.ts
  "getMailAvailability", // epic #1893 phase 4: `nemar admin mail`, routes in shared/contract/mail-admin.ts
  "getMailTicket", // epic #1893 phase 4: `nemar admin mail`, routes in shared/contract/mail-admin.ts
  "getUsernameById", // epic #1893 phase 4: `nemar admin mail`, routes in shared/contract/mail-admin.ts
  "listMailQueues", // epic #1893 phase 4: `nemar admin mail`, routes in shared/contract/mail-admin.ts
  "listMailTickets", // epic #1893 phase 4: `nemar admin mail`, routes in shared/contract/mail-admin.ts
  "putMailAvailability", // epic #1893 phase 4: `nemar admin mail`, routes in shared/contract/mail-admin.ts
  "putMailQueue", // epic #1893 phase 4: `nemar admin mail`, routes in shared/contract/mail-admin.ts
  "reprocessMail", // epic #1893 phase 4: `nemar admin mail`, routes in shared/contract/mail-admin.ts
  "setMailTicketSummary", // epic #1893 phase 6a: `nemar admin mail summarize`, PUT /admin/mail/tickets/:id/summary
  "replyToMailTicket", // epic #1893 phase 4: `nemar admin mail`, routes in shared/contract/mail-admin.ts
  "setMailTicketStatus", // epic #1893 phase 4: `nemar admin mail`, routes in shared/contract/mail-admin.ts
  "markMailTicketSpam", // ADR 0113: `nemar admin mail spam`, POST /admin/mail/tickets/:id/spam
  "listMailBlocklist", // ADR 0113: `nemar admin mail blocklist`, GET /admin/mail/blocklist
  "addMailBlock", // ADR 0113: `nemar admin mail blocklist add`, POST /admin/mail/blocklist
  "removeMailBlock", // ADR 0113: `nemar admin mail blocklist remove`, DELETE /admin/mail/blocklist/:id
  "createRepull", // #1912, epic #1046 phase 6, ADR 0111 decision 3: POST /admin/repulls
  "getRepull", // #1912: GET /admin/repulls/:id
  "listRepulls", // #1912: GET /admin/repulls
  "transitionRepull", // #1912: POST /admin/repulls/:id/transition
  "repullErrorCode", // #1912: the closed word of a /admin/repulls refusal (rawBody.code)
  "listRepullScreens", // #1912 phase 6f: GET /admin/repulls/:id/screens
  "dispatchRepullScreen", // #1912 phase 6f: POST /admin/repulls/:id/screen
  "acknowledgeRepullScreen", // #1912 phase 6f: POST /admin/repulls/:id/screen/acknowledge
  "releaseRepullMergeClaim", // #1912 phase 6f: POST /admin/repulls/:id/merge-claim/release
  "recordRepullMerged", // #1912 phase 6f: POST /admin/repulls/:id/merged
  "recordRepullReleased", // #1912 phase 6f: POST /admin/repulls/:id/released
  "checkRepullMergeClaim", // #1912 phase 6f: POST /admin/repulls/:id/merge-claim/check
  "acceptRepullMergeTrailers", // #1996, ADR 0111 2026-10-29: POST /admin/repulls/:id/merge-trailers/accept
  "getRepullSwitches", // #1913 phase 7h: GET /admin/repulls/switches
  "listRepullDispatches", // #1913 phase 7h: GET /admin/repulls/dispatches
  "getComputePolicy", // epic #2005 phase A2: GET /admin/compute/policy
  "putComputePolicy", // epic #2005 phase A2: PUT /admin/compute/policy
  "getComputeStatus", // epic #2005 phase A4: GET /admin/compute/status
  "cancelComputeJobAsAdmin", // epic #2005 phase A5: POST /admin/compute/jobs/:id/cancel
  "advanceComputeJobAsAdmin", // epic #2005 phase A5: POST /admin/compute/jobs/:id/advance
  "runComputePipeline", // epic #2005 phase A6: POST /admin/compute/pipeline/run
  "getComputePipelineStatus", // epic #2005 phase A6: GET /admin/compute/pipeline/status
  "computeRefusalCode", // epic #2005 phase A6: reads a compute refusal's word (no request)
  "registerComputeRunner", // portable compute, DM-05: POST /admin/compute/runners
  "listComputeRunners", // portable compute, DM-05: GET /admin/compute/runners
  "revokeComputeRunner", // portable compute, DM-05: POST /admin/compute/runners/:id/revoke
  "getComputeRunnersUsage", // portable compute, S6: GET /admin/compute/reports/runners
  "RunnerViewSchema", // portable compute, DM-05: the open schema of one registration (the listing's row)
  "RunnerListResponseSchema", // portable compute, DM-05: the open schema of the listing
  "RunnerRevokeResponseSchema", // portable compute, DM-05: the open schema of a revoke's answer
  "listComputePools", // epic #2005 phase A2: GET /admin/compute/pools
  "getAccountComputePools", // epic #2005 phase A2: GET /admin/compute/pools/by-id/:accountId
  "grantAccountComputePool", // epic #2005 phase A2: POST /admin/compute/pools/by-id/:accountId/grant
  "adjustAccountComputePool", // epic #2005 phase A2: POST /admin/compute/pools/by-id/:accountId/adjust
  "grantPlatformComputePool", // epic #2005 phase A2: POST /admin/compute/pools/platform/:key/grant
  "adjustPlatformComputePool", // epic #2005 phase A2: POST /admin/compute/pools/platform/:key/adjust
  "listComputeJobs", // epic #2005 phase A7: reporting, holds, ACCESS reports and the observer (admin/compute)
  "listUnmatchedComputeRows", // epic #2005 phase A7: reporting, holds, ACCESS reports and the observer (admin/compute)
  "getComputeRecord", // epic #2005 phase A7: reporting, holds, ACCESS reports and the observer (admin/compute)
  "readComputeRecord", // epic #2005 phase A7: reporting, holds, ACCESS reports and the observer (admin/compute)
  "getComputeAccountReport", // epic #2005 phase A7: reporting, holds, ACCESS reports and the observer (admin/compute)
  "getComputeAccessReport", // epic #2005 phase A7: reporting, holds, ACCESS reports and the observer (admin/compute)
  "listComputeHolds", // epic #2005 phase A7: reporting, holds, ACCESS reports and the observer (admin/compute)
  "placeComputeHold", // epic #2005 phase A7: reporting, holds, ACCESS reports and the observer (admin/compute)
  "releaseComputeHold", // epic #2005 phase A7: reporting, holds, ACCESS reports and the observer (admin/compute)
  "listComputeAccessReports", // epic #2005 phase A7: reporting, holds, ACCESS reports and the observer (admin/compute)
  "requeueComputeAccessReport", // epic #2005 phase A7: reporting, holds, ACCESS reports and the observer (admin/compute)
  "mintComputeObserverRun", // epic #2005 phase A7: reporting, holds, ACCESS reports and the observer (admin/compute)
  "createOidcClient", // epic #2014 phase #2016: POST /admin/oidc/clients (shared/contract/oidc-admin.ts)
  "listOidcClients", // epic #2014 phase #2016: GET /admin/oidc/clients
  "getOidcClient", // epic #2014 phase #2016: GET /admin/oidc/clients/:client_id
  "rotateOidcClientSecret", // epic #2014 phase #2016: POST /admin/oidc/clients/:client_id/rotate-secret
  "disableOidcClient", // epic #2014 phase #2016: POST /admin/oidc/clients/:client_id/disable
  "listOidcKeys", // epic #2014 phase #2016: GET /admin/oidc/keys
  "rotateOidcKeys", // epic #2014 phase #2016: POST /admin/oidc/keys/rotate
  "revokeOidcKey", // epic #2014 phase #2016: POST /admin/oidc/keys/:kid/revoke
  "oidcErrorCode", // epic #2014 phase #2016: the closed word of an /admin/oidc refusal (rawBody.code)
  "oidcSecretWord", // ADR 0119 addendum 2026-11-07: `unset` or `malformed`, the owner 404's word for OIDC_SECRET (rawBody.oidc_secret)
  "endOidcAccount", // epic #2014 phase #2019: POST /admin/oidc/accounts/:id/end (shared/contract/oidc-admin.ts)
  "listOidcLogoutDeliveries", // epic #2014 phase #2019: GET /admin/oidc/logout-deliveries
  "lockS3Objects", // #1912 phase 6f: POST /admin/datasets/:id/s3-lock with an explicit list
  "OBJECTS_PER_EXPLICIT_LOCK", // #1912 phase 6f: the explicit lock's batch size
];

/** The api.ts monolith's runtime surface, captured at #908 commit 1. */
const MONOLITH_EXPORTS = [
  "ApiError",
  "IS_DEV_BUILD",
  "MaintenanceError",
  "ORCID_REGEX",
  "PUBLICATION_STEPS",
  "addCi",
  "applyS3Lock",
  "approveAccessRequest",
  "approvePublication",
  "approveUser",
  "availabilityReport",
  "availabilityReportSweep",
  "availabilityReportSweepReset",
  "bulkDeleteDatasets",
  "changeUserRole",
  "checkGitHubUsername",
  "checkHealth",
  "checkSSHKeyStatus",
  "checkUsername",
  "completeSandbox",
  "createConceptDoi",
  "createDataset",
  "createExemplar",
  "createNotice",
  "dataIntegritySweep",
  "dataIntegritySweepReset",
  "deleteDataset",
  "deleteNotice",
  "denyAccessRequest",
  "denyPublication",
  "dispatchCooldown",
  "dispatchManifest",
  "enforceBulk",
  "enforceDataset",
  "errorDetail",
  "finalizeDataset",
  "getCiStatus",
  "getCurrentUser",
  "getDataset",
  "getDatasetFiles",
  "getDoiInfo",
  "getEmailPreferences",
  "getFleetDrift",
  "getImportStatus",
  "getManifest",
  "getNotices",
  "getPublishStatus",
  "getSandboxStatus",
  "getSummaryCoverage",
  "getUserCiStatus",
  "getVersionHistory",
  "hedSweep",
  "hedSweepReset",
  "importDataset",
  "inviteCollaborator",
  "isRetryablePublishError",
  "listAccessRequests",
  "listAdminNotices",
  "listCollaborators",
  "listDatasets",
  "listManifestVersions",
  "listPublishRequests",
  "listUsers",
  "login",
  "publishDataset",
  "publishVersionDoi",
  "registerSSHKey",
  "reindexBulk",
  "reindexDataset",
  "remintExemplarDois",
  "requestDatasetAccess",
  "requestDownloadCredentials",
  "requestKeyRegeneration",
  "requestPublication",
  "requestUploadCredentials",
  "requestUploadUrls",
  "rerunIdentifierScreen", // epic #1610 phase 4: POST /admin/publish/:id/identifier-screen
  "resendPublishNotification",
  "resendVerification",
  "resetSandbox",
  "resetTestDataset",
  "resolveSourceId",
  "restoreDataset",
  "retryImport",
  "revalidateDataset",
  "revokeUser",
  "rollbackImport",
  "searchDatasets",
  "sendBroadcast",
  "stepIndexFor",
  "submitEnrichment",
  "syncCi",
  "unpublishDataset",
  "updateDoi",
  "updateEmailPreferences",
  "validateCi",
  "validateDataset",
  "verifyImport",
  "withdrawDataset",
  "withdrawPublishRequest",
];

describe("lib/api export surface", () => {
  for (const [mod, expected] of Object.entries(MODULE_EXPORTS)) {
    test(`api/${mod} runtime exports match the pin exactly`, async () => {
      const m = await import(`../src/lib/api/${mod}.ts`);
      expect(Object.keys(m).sort()).toEqual(expected);
    });
  }

  test("union of module exports equals the monolith surface", () => {
    const union = new Set(Object.values(MODULE_EXPORTS).flat());
    for (const w of INTERNAL_WIRING) union.delete(w);
    for (const a of POST_SPLIT_ADDITIONS) union.delete(a);
    expect([...union].sort()).toEqual(MONOLITH_EXPORTS);
  });

  test("every file in lib/api/ has a pin entry (no orphan modules)", () => {
    const files = readdirSync(join(import.meta.dir, "../src/lib/api"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.replace(/\.ts$/, ""))
      .sort();
    expect(files).toEqual(Object.keys(MODULE_EXPORTS).sort());
  });
});
