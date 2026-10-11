/**
 * Admin router (#903, epic #902).
 *
 * The former monolithic routes/admin.ts, split by domain. Each domain file
 * registers its handlers on this single shared router, so routing semantics
 * (middleware order, path matching) are identical to the pre-split monolith.
 * The route inventory is pinned by test/admin-route-inventory.unit.test.ts.
 */

import { Hono } from "hono";
import { adminMiddleware, authMiddleware } from "../../middleware/auth";
import { registerDatasetLifecycleRoutes } from "./datasets-lifecycle";
import { registerDoiRoutes } from "./doi";
import { registerExemplarRoutes } from "./exemplar";
import { registerFleetRoutes } from "./fleet";
import { registerIdentifierSweepAdminRoutes } from "./identifier-sweep";
import { registerImportCoverageRoutes } from "./import-coverage";
import { registerImportIssueTriageRoutes } from "./import-issue-triage";
import { registerImportWeeklyRoutes } from "./import-weekly";
import { registerImportRoutes } from "./imports";
import { registerNeurobagelRoutes } from "./neurobagel";
import { registerNewsRoutes } from "./news";
import { registerNoticeRoutes } from "./notices";
import { registerPrReviewRoutes } from "./pr-reviews";
import { registerPublishRoutes } from "./publish";
import type { AdminRouter } from "./shared";
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

// All admin routes require authentication and admin role
adminRoutes.use("*", authMiddleware);
adminRoutes.use("*", adminMiddleware);

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
registerDatasetLifecycleRoutes(adminRoutes);
registerImportRoutes(adminRoutes);
registerImportIssueTriageRoutes(adminRoutes);
registerImportCoverageRoutes(adminRoutes);
registerImportWeeklyRoutes(adminRoutes);
registerExemplarRoutes(adminRoutes);
registerNoticeRoutes(adminRoutes);
registerNewsRoutes(adminRoutes);
registerWithdrawRoutes(adminRoutes);
registerZarrCatalogRoutes(adminRoutes);
registerZarrFidelitySweepRoutes(adminRoutes);
registerNeurobagelRoutes(adminRoutes);
registerIdentifierSweepAdminRoutes(adminRoutes);
registerPrReviewRoutes(adminRoutes);
