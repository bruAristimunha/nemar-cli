/**
 * Admin router (#903, epic #902).
 *
 * The former monolithic routes/admin.ts, split by domain. Each domain file
 * registers its handlers on this single shared router, so routing semantics
 * (middleware order, path matching) are identical to the pre-split monolith.
 * The route inventory is pinned by test/admin-route-inventory.unit.test.ts.
 */

import { Hono } from "hono";
import { adminMiddleware, authMiddleware, cookieOriginGuard } from "../../middleware/auth";
import { registerComputeAdminRoutes } from "./compute";
import { registerComputeDerivativeAdminRoutes } from "./compute-derivatives";
import { registerComputeJobAdminRoutes } from "./compute-jobs";
import { registerComputePipelineAdminRoutes } from "./compute-pipeline";
import { registerComputeReportingRoutes } from "./compute-reporting";
import { registerComputeRunnerAdminRoutes } from "./compute-runners";
import { registerDatasetLifecycleRoutes } from "./datasets-lifecycle";
import { registerDoiRoutes } from "./doi";
import { registerExemplarRoutes } from "./exemplar";
import { registerFleetRoutes } from "./fleet";
import { registerIdentifierSweepAdminRoutes } from "./identifier-sweep";
import { registerImportCoverageRoutes } from "./import-coverage";
import { registerImportIssueTriageRoutes } from "./import-issue-triage";
import { registerImportWeeklyRoutes } from "./import-weekly";
import { registerImportRoutes } from "./imports";
import { registerMailRoutes } from "./mail";
import { registerNeurobagelRoutes } from "./neurobagel";
import { registerNewsRoutes } from "./news";
import { registerNoticeRoutes } from "./notices";
import { registerOidcAdminRoutes } from "./oidc";
import { registerPrReviewRoutes } from "./pr-reviews";
import { registerPublicationReviewRoutes } from "./publication-review";
import { registerPublishRoutes } from "./publish";
import { registerPublishCommentRoutes } from "./publish-comment";
import type { AdminRouter } from "./shared";
import { registerUnpublishRoutes } from "./unpublish";
import { registerUpstreamBackfillRoutes } from "./upstream-backfill";
import { registerUpstreamRepullRoutes } from "./upstream-repulls";
import { registerUpstreamStatusRoutes } from "./upstream-status";
import { registerUserDuplicateRoutes } from "./user-duplicates";
import { registerUserEditRoutes } from "./user-edit";
import { registerUserKeyRoutes } from "./user-keys";
import { registerUserNameRoutes } from "./user-names";
import { registerUserUsernameRoutes } from "./user-usernames";
import { registerUsersRoutes } from "./users";
import { registerWithdrawRoutes } from "./withdraw";
import { registerZarrCatalogRoutes } from "./zarr-catalog";
import { registerZarrFidelitySweepRoutes } from "./zarr-fidelity-sweep";

export const adminRoutes: AdminRouter = new Hono();

// All admin routes require authentication and admin role, and a write made with a session cookie
// has to come from a NEMAR page (#1603, #1584; ADR 0105, decision 10). The guard reads what
// authMiddleware set, and runs after the role check so a member is told "Admin access required"
// and not asked about an Origin.
adminRoutes.use("*", authMiddleware);
adminRoutes.use("*", adminMiddleware);
adminRoutes.use("*", cookieOriginGuard);

// BEFORE registerUsersRoutes, and it has to be. Hono runs every handler whose
// pattern matches, in REGISTRATION order, and `GET /users/:username` matches
// `/users/duplicates` too -- registered second, the duplicate report would
// never be reached, because the username lookup 404s first. (`POST
// /users/backfill-names` has no such neighbour, which is why it can sit after.)
// The cost is that an account literally named `duplicates` is unreachable
// through `GET /admin/users/:username`; the same trade backfill-names makes.
registerUserDuplicateRoutes(adminRoutes);
registerUsersRoutes(adminRoutes);
registerUserEditRoutes(adminRoutes);
registerUserKeyRoutes(adminRoutes);
registerUserNameRoutes(adminRoutes);
registerUserUsernameRoutes(adminRoutes);
registerDoiRoutes(adminRoutes);
registerFleetRoutes(adminRoutes);
registerPublishRoutes(adminRoutes);
registerPublicationReviewRoutes(adminRoutes);
registerPublishCommentRoutes(adminRoutes);
registerDatasetLifecycleRoutes(adminRoutes);
registerImportRoutes(adminRoutes);
registerImportIssueTriageRoutes(adminRoutes);
registerImportCoverageRoutes(adminRoutes);
registerImportWeeklyRoutes(adminRoutes);
registerExemplarRoutes(adminRoutes);
registerNoticeRoutes(adminRoutes);
registerNewsRoutes(adminRoutes);
registerWithdrawRoutes(adminRoutes);
registerUnpublishRoutes(adminRoutes);
registerZarrCatalogRoutes(adminRoutes);
registerZarrFidelitySweepRoutes(adminRoutes);
registerNeurobagelRoutes(adminRoutes);
registerIdentifierSweepAdminRoutes(adminRoutes);
registerPrReviewRoutes(adminRoutes);
registerUpstreamBackfillRoutes(adminRoutes);
registerUpstreamStatusRoutes(adminRoutes);
registerUpstreamRepullRoutes(adminRoutes);
// The OpenID Connect provider's client registry and signing keys (epic #2014 phase #2016; ADR 0119):
// owner only, on the issuer's host only, behind one `use` for the whole /oidc prefix.
registerOidcAdminRoutes(adminRoutes);
registerMailRoutes(adminRoutes);
registerComputeAdminRoutes(adminRoutes);
registerComputeJobAdminRoutes(adminRoutes);
registerComputePipelineAdminRoutes(adminRoutes);
registerComputeReportingRoutes(adminRoutes);
// Runner registrations (portable compute, card DM-05): owner only, behind the same router middleware.
registerComputeRunnerAdminRoutes(adminRoutes);
// The derivative store (portable compute, card V1b; ADR 0123): admin, with `published` the owner's alone
// (checked in the service). Dark wherever the derivatives bucket is not bound.
registerComputeDerivativeAdminRoutes(adminRoutes);
