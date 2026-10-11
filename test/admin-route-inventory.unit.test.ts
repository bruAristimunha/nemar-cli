/**
 * Pins the admin router's route table across the #902/#903 admin.ts split.
 *
 * Hono's `.routes` lists one entry per handler in each registration chain, so
 * a route registered with extra middleware (zValidator, ownerMiddleware, ...)
 * appears once per handler. Pinning the per-route ENTRY COUNT therefore also
 * catches a validator or middleware silently dropped while code moves between
 * files — not just a lost route.
 *
 * Counts are compared as an unordered map: the split regroups registrations
 * by domain file, and no admin path/method pair is ambiguous with another
 * (static segments outrank params in Hono's RegExpRouter), so registration
 * order is not load-bearing.
 *
 * Expected values were captured from admin.ts as of #903 commit 1, BEFORE any
 * code moved. If this test fails after an intentional route change, update
 * the map in the same commit and say so in the commit message.
 */

import { describe, expect, test } from "bun:test";
import { adminMiddleware, authMiddleware } from "../backend/src/middleware/auth";
import { adminRoutes } from "../backend/src/routes/admin";

const EXPECTED_ENTRIES: Record<string, number> = {
  // Router-level middleware (authMiddleware + adminMiddleware).
  "ALL /*": 2,

  // Users / accounts
  "GET /users": 1,
  "GET /users/:username": 1,
  "POST /users/:username/role": 3,
  // #1284, epic #1272 phase 4 (ADR 0048): account kinds.
  "POST /users/:username/kind": 3,
  "GET /users/:username/keys": 2,
  "POST /users/:username/keys": 3,
  "DELETE /users/:username/keys/:id": 2,
  "POST /approve/:username": 1,
  // #1012: id-keyed approve for web/ORCID accounts (username = NULL).
  "POST /approve/by-id/:id": 1,
  "POST /revoke/:username": 1,
  // #1274: id-keyed revoke, the mirror of approve/by-id for accounts with no
  // username (ADR 0040 -- revoke is the eraser of what approval wrote).
  "POST /revoke/by-id/:id": 1,
  "DELETE /users/by-id/:id": 2,
  "POST /regenerate-iam/:username": 1,
  "GET /stats": 1,
  "GET /audit": 1,
  "GET /email-preferences": 1,
  "PUT /email-preferences": 2,
  "POST /notify": 2,
  "POST /test-fixtures/seed-web-user": 2,
  // #1255, epic #1250: ORCID name backfill (zValidator + handler).
  "POST /users/backfill-names": 2,
  // #1253, epic #1250 (ADR 0042): username backfill (zValidator + handler).
  "POST /users/backfill-usernames": 2,
  // #1254, epic #1250 (ADR 0043): the duplicate-account report and the
  // identity-conflict flag it reports on. `/users/duplicates` is reachable
  // ONLY because registerUserDuplicateRoutes runs before registerUsersRoutes
  // -- `GET /users/:username` matches it too, and the fallback router takes
  // the first matching handler in registration order (pinned below).
  "GET /users/duplicates": 1,
  "POST /users/:id/clear-identity-conflict": 1,
  // ADR 0096: one account's details and an admin edit of it, keyed by id because
  // a web/ORCID account has no username. The PATCH is a single handler on
  // purpose: owner-only applies to three of its eight fields, so the
  // permission check lives in parseAdminUserEdit and not in a middleware.
  "GET /users/by-id/:id": 1,
  "PATCH /users/by-id/:id": 1,

  // DOI / enrichment
  "POST /datasets/:id/doi/concept": 2,
  "POST /datasets/:id/doi/publish": 2,
  "GET /datasets/:id/doi": 1,
  "POST /datasets/:id/doi/update": 2,
  "POST /datasets/:id/enrichment": 2,
  "GET /datasets/:id/files": 1,
  "DELETE /zenodo/deposition/:id": 1,

  // Fleet governance / visibility / CI
  "PATCH /datasets/:id/visibility": 2,
  "GET /fleet/drift": 1,
  "POST /datasets/:id/enforce": 2,
  "POST /datasets/:id/revalidate": 1,
  "POST /datasets/enforce/bulk": 2,
  "GET /datasets/:id/ci": 1,
  "POST /datasets/:id/ci": 1,
  "POST /datasets/:id/ci/validate": 1,
  "POST /datasets/:id/ci/sync": 1,

  // Publication workflow
  "GET /publish/requests": 1,
  "POST /publish/:id/deny": 2,
  "POST /publish/:id/approve": 2,
  // ADR 0080: launch an approval from the web by dispatching it to an executor.
  "POST /publish/:id/approve-dispatch": 1,
  // Epic #1610 phase 4: re-run the identifier screen of an active request.
  "POST /publish/:id/identifier-screen": 1,
  "POST /datasets/:id/s3-lock": 1,

  // Dataset lifecycle (sweeps, doctor, deletion, reindex, manifests)
  "POST /datasets/archive-sweep": 1,
  "POST /datasets/zarr-sweep": 1,
  "POST /datasets/channel-montage-sweep": 1,
  "POST /datasets/recording-stats-sweep": 1,
  "POST /datasets/signal-defaults-sweep": 1,
  "POST /datasets/hed-sweep": 1,
  "POST /datasets/availability-report-sweep": 1,
  "POST /datasets/data-integrity-sweep": 1,
  "POST /doctor/scan": 1,
  "POST /doctor/fix": 1,
  "POST /datasets/:id/reset": 1,
  "DELETE /datasets/:id": 1,
  "POST /datasets/bulk-delete": 2,
  "POST /datasets/:id/reindex": 1,
  "POST /datasets/reindex/bulk": 1,
  "POST /vectorize/reindex-all": 1,
  "POST /datasets/:id/manifest/:version": 1,
  "POST /datasets/:id/availability-report": 1,
  "POST /manifest/dispatch": 2,
  "GET /summary/coverage": 1,

  // OpenNeuro imports
  "POST /datasets/import": 4,
  "GET /imports": 1,
  "POST /imports/:id/rollback": 1,
  "POST /imports/:id/retry": 1,
  "POST /imports/:id/verify": 1,
  "POST /imports/dispatch-cooldown": 2,
  "POST /imports/issue-triage": 1,

  // Staging exemplars (epic #923, Phase 5)
  "POST /datasets/exemplar": 2,
  "POST /datasets/:id/exemplar/remint-dois": 1,

  // Notices
  "GET /notices": 1,
  "POST /notices": 2,
  "DELETE /notices/:id": 1,

  // News posts and their images (#1551). zValidator + handler on the two
  // writes that take a NewsInput body; the image upload reads a raw body.
  "GET /news": 1,
  "GET /news/:id": 1,
  "POST /news": 2,
  "PUT /news/:id": 2,
  "DELETE /news/:id": 1,
  "POST /news/media": 1,

  // Withdrawal / restore (epic #967 phase 4, #971)
  "POST /datasets/:id/withdraw": 2,
  "POST /datasets/:id/restore": 2,

  // Zarr catalog (issue #1062, epic #1181 phase 2)
  "POST /zarr-catalog/publish": 1,

  // Zarr fidelity verification sweep (issue #1068, epic #1181 phase 8)
  "POST /datasets/zarr-fidelity-sweep": 1,
  "POST /datasets/anonymity-sweep": 1,

  // Import coverage sweep (issue #1311, epic #1306 phase 3)
  "POST /imports/coverage-sweep": 1,

  // Weekly import summary (issue #1312, epic #1306 phase 4)
  "POST /imports/weekly-summary": 1,

  // Neurobagel artifact store (epic #1586 phase 4, ADR 0084): the status read, and
  // the dry-run-by-default regeneration (zValidator + handler on the strict body).
  "GET /neurobagel/status": 1,
  "POST /neurobagel/regenerate": 2,
  // Epic #1586 phase 6: the verification sweep on demand. No body, so no validator.
  "POST /neurobagel/verify": 1,
  // Scheduled identifier sweep (epic #1610 phase 5, ADR 0088): the weekly report on
  // demand (read-only) and a rescreen request (a D1 write the production tick answers).
  "GET /identifier-sweep": 1,
  "POST /identifier-sweep/:id/rescreen": 1,

  // Dataset pull-request review queue (ADR 0093, following ADR 0092): the open pull requests
  // joined with their reviews, one pull request, and the controls over who is reviewed. The
  // contributor routes sit under their own prefix because `pr-reviews/:dataset/:pr` has the same
  // shape as `pr-reviews/authors/:login`. The PUT is zValidator + handler (a strict body).
  "GET /pr-reviews": 1,
  "GET /pr-reviews/:dataset/:pr": 1,
  "POST /pr-reviews/:dataset/:pr/start": 1,
  "GET /pr-review-authors/:login": 1,
  "PUT /pr-review-authors/:login": 2,
  "DELETE /pr-review-authors/:login": 1,
};

describe("admin route inventory", () => {
  test("route table matches the pre-split pin exactly", () => {
    const actual: Record<string, number> = {};
    for (const r of adminRoutes.routes) {
      const key = `${r.method} ${r.path}`;
      actual[key] = (actual[key] ?? 0) + 1;
    }
    expect(actual).toEqual(EXPECTED_ENTRIES);
  });

  test("GET /users/duplicates is registered BEFORE GET /users/:username", () => {
    // Both patterns match `/users/duplicates`, and this router's path set makes
    // Hono's RegExpRouter throw UnsupportedPathError, so the app falls back to
    // a router that runs every matching handler in REGISTRATION order and
    // takes the first response. Registered second, the duplicate report is
    // unreachable -- the username lookup 404s first, which is what happened
    // before the order in admin/index.ts was fixed.
    //
    // Pinned here rather than left to a comment because nothing else fails:
    // every other test in the suite passes with the order reversed, and the
    // route just quietly stops existing.
    const paths = adminRoutes.routes.map((r) => `${r.method} ${r.path}`);
    const dup = paths.indexOf("GET /users/duplicates");
    const byUsername = paths.indexOf("GET /users/:username");
    expect(dup).toBeGreaterThanOrEqual(0);
    expect(byUsername).toBeGreaterThanOrEqual(0);
    expect(dup).toBeLessThan(byUsername);
  });

  test("entry total is pinned", () => {
    expect(adminRoutes.routes.length).toBe(142);
  });

  // The count pin above can't see a SWAP of the two router-level middleware
  // entries. Order is load-bearing: authMiddleware resolves the user that
  // adminMiddleware's role check reads.
  test("router-level middleware order is pinned (auth before admin)", () => {
    const star = adminRoutes.routes.filter((r) => r.method === "ALL" && r.path === "/*");
    expect(star.map((r) => r.handler)).toEqual([authMiddleware, adminMiddleware]);
  });
});
