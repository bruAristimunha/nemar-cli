/**
 * NEMAR API - Cloudflare Workers Backend
 *
 * Handles user authentication, dataset management, and admin workflows.
 *
 * Production route: api.nemar.org (SCCN account)
 * Dev route: nemar-api-dev.sccn-org.workers.dev (SCCN account)
 * Legacy route: api.osc.earth/nemar (personal account, read-only buffer)
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";

// Single source of truth for the version. The worker reads the repo-root
// package.json (the npm-published CLI's manifest). backend/package.json is
// private and exists only for wrangler tooling; scripts/bump-version.sh
// keeps both in lockstep and asserts equality post-bump, so drift between
// the two manifests fails the bump rather than silently shipping.
import pkg from "../../package.json" with { type: "json" };
import { notFoundResponse } from "./lib/not-found";
import { optionalAuthMiddleware } from "./middleware/auth";
import { maintenanceMode } from "./middleware/maintenance";
import { rateLimiter } from "./middleware/rateLimit";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { authDeviceRoutes } from "./routes/auth-device";
import { authDocsRoutes } from "./routes/auth-docs";
import { authKeysRoutes } from "./routes/auth-keys";
import { authOrcidRoutes } from "./routes/auth-orcid";
import { authPrivateRoutes } from "./routes/auth-private";
import { authWebRoutes } from "./routes/auth-web";
import { catalogIndexResponse, dataRoutes } from "./routes/data";
import { datasetRoutes } from "./routes/datasets";
import { mcpRoutes } from "./routes/mcp";
import { neurobagelRoutes } from "./routes/neurobagel";
import { newsRoutes } from "./routes/news";
import { openApiRoutes } from "./routes/openapi";
import { sandboxRoutes } from "./routes/sandbox";
import { schemaRoutes } from "./routes/schemas";
import { userRoutes } from "./routes/users";
import webhooks from "./routes/webhooks";
import { zarrDataRoutes } from "./routes/zarr-data";
import { runAnonymitySweepCron } from "./services/anonymity-sweep";
import { archiveRetrySweep } from "./services/archive-retry";
import { AUTO_IMPORT_CRON, autoImportTick } from "./services/auto-import";
import { runAvailabilityReportSweepCron } from "./services/availability-report";
import { fetchAndSyncCitationCounts } from "./services/citation-counts-sync";
import { isNemarWebOrigin, isOscOrigin } from "./services/cors-origins";
import { sweepLogLines } from "./services/cron-sweep-log";
import { fetchAndSyncDataPapers } from "./services/data-papers-sync";
import { drainEmbeddingDirty } from "./services/dataset-search";
import { DEV_EPHEMERAL_BAND_END, DEV_EPHEMERAL_BAND_START } from "./services/datasetId";
import { deleteDatasetCascade } from "./services/deletion";
import { reconcileReservedVersionDois } from "./services/doi-reconcile";
import {
  getAdminEmailsForCategory,
  resolveEmailConfig,
  sendExemplarInvariantAlertEmail,
  sendStalenessAdminReviewEmail,
  sendStalenessWarningEmail,
} from "./services/email";
import { isNonProductionEnv } from "./services/environment";
import { resolveHostRoute } from "./services/host-routing";
import { sweepIdentifierScreens } from "./services/identifier-screen";
import {
  runIdentifierSweepTick,
  sendIdentifierSweepWeeklyReport,
} from "./services/identifier-sweep";
import {
  importCoverageSweepSummary,
  runImportCoverageSweepCron,
} from "./services/import-coverage-sweep";
import { isGenericImportError, lastErrorAssignmentSql } from "./services/import-error";
import { importIssueSweepLogLines, runImportIssueSweepCron } from "./services/import-issue-sweep";
import { runImportRecovery } from "./services/import-recovery";
import { sweepImportRetries } from "./services/import-retry";
import { shouldRunWeeklySummary, weeklyHeadline } from "./services/import-weekly-summary";
import {
  runWeeklyImportSummaryCron,
  weeklySummaryCronLine,
} from "./services/import-weekly-summary-sweep";
import { manifestIntegritySweep } from "./services/manifest-sweep";
import { runNeurobagelReconcileCron } from "./services/neurobagel-hooks";
import {
  runNeurobagelVerificationSweepCron,
  verificationLogLine,
} from "./services/neurobagel-verify";
import { getActiveNotices } from "./services/notices";
import { sweepStalePrReviews } from "./services/pr-review";
import { sweepBlockedBidsValidationRequests } from "./services/publication-sweep";
import { runRecordingStatsSweepCron } from "./services/recording-stats-sweep";
import { runSignalDefaultsSweepCron } from "./services/signal-defaults-sweep";
import {
  FIRST_WARNING_DAYS,
  STALENESS_LIMIT_DAYS,
  daysUntilDeletion,
  deletionDate,
  warningStageForDaysLeft,
} from "./services/staleness";
import { publishZarrCatalog } from "./services/zarr-catalog";
import { runZarrFidelitySweep } from "./services/zarr-fidelity-sweep";
import type { Bindings, Variables } from "./types/bindings";

// Create the API app with all routes
const api = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Global middleware
api.use("*", logger());
api.use("*", secureHeaders());
api.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return null;
      try {
        const { hostname } = new URL(origin);
        // The NEMAR web surfaces: nemar.org hosts, the website's Pages preview
        // URLs (#1346), and loopback for development. Shared with the zarr
        // fork's `allowedOrigin` so the two cannot disagree about which of our
        // own surfaces count.
        if (isNemarWebOrigin(hostname)) return origin;
        // The OSC surfaces, including the browser compute widget. Shared with
        // the zarr fork since #1465 so the two cannot disagree.
        if (isOscOrigin(hostname)) return origin;
      } catch (err) {
        console.warn(`CORS: rejected unparseable origin: ${origin}`, err);
      }
      return null;
    },
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-CLI-Version"],
    exposeHeaders: ["X-Request-Id"],
    credentials: true,
    maxAge: 86400,
  }),
);
api.use("*", rateLimiter);
api.use("*", maintenanceMode);

// Health check endpoint
api.get("/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: pkg.version,
  });
});

// API info endpoint
api.get("/", (c) => {
  return c.json({
    name: "NEMAR API",
    version: pkg.version,
    description: "Backend API for NEMAR CLI",
    base_url: c.env.API_BASE_URL,
    endpoints: {
      auth: "/auth/*",
      users: "/users/*",
      admin: "/admin/*",
      datasets: "/datasets/*",
      sandbox: "/sandbox/*",
      webhooks: "/webhooks/*",
      schemas: "/schemas/*",
      openapi: "/openapi.json",
    },
  });
});

// Public notices endpoint (uses optional auth to filter by role)
api.get("/notices", optionalAuthMiddleware, async (c) => {
  try {
    const user = c.get("user");
    const notices = await getActiveNotices(c.env.DB, user?.role);
    return c.json({ notices });
  } catch (err) {
    console.error("[notices] Failed to fetch active notices:", err);
    return c.json({ notices: [] });
  }
});

// Public news posts (#1551): the published list, one post by slug, and the
// posts' images from the NEWS_MEDIA bucket. Admin writes are in
// routes/admin/news.ts.
api.route("/news", newsRoutes);

// The Neurobagel artifact store, read side (epic #1586 phase 4, ADR 0084): the index
// and artifacts the node's loader pulls, behind one shared bearer secret, each answer
// re-checked against D1. Off (404) until NEUROBAGEL_READ_TOKEN and the bucket exist.
api.route("/neurobagel", neurobagelRoutes);

// Mount route handlers
api.route("/auth", authRoutes);
// Web-dashboard auth (#569). Mounted at the same /auth prefix as the
// API-key routes; no path overlap with authRoutes (/login, /verify, etc.
// vs new /code/request, /code/verify, /logout, /me).
api.route("/auth", authWebRoutes);
// ORCID SSO (#832). Same /auth prefix; new paths under /auth/orcid/*.
api.route("/auth", authOrcidRoutes);
// Device authorization grant (RFC 8628; epic #1272 phase 1, #1281; ADR
// 0047). Same /auth prefix; new paths under /auth/device/*.
api.route("/auth", authDeviceRoutes);
// Named API key routes (#1281, ADR 0047): list/mint/revoke, plus the
// device flow's paste-key fallback. Same /auth prefix; new paths under
// /auth/keys*.
api.route("/auth", authKeysRoutes);
// Docs admin gate (epic #1336 phase 0, issue #1338). Same /auth prefix; new
// paths under /auth/docs/*. The docs host cannot read the app's session cookie
// (it is scoped to app.nemar.org on purpose), so these three routes are the
// handoff that gives docs.nemar.org a credential of its own.
api.route("/auth", authDocsRoutes);
// The private site's session handoff (ADR 0079). Same /auth prefix; one path,
// /auth/private/grant. The exchange, the per-request check and sign-out are
// service-binding methods (ADR 0078), not routes.
api.route("/auth", authPrivateRoutes);
api.route("/users", userRoutes);
api.route("/admin", adminRoutes);
api.route("/datasets", datasetRoutes);
api.route("/sandbox", sandboxRoutes);
api.route("/webhooks", webhooks);
// Public JSON Schema documents (issue #1059). Static, D1-free, cached: the
// bytes are the repo's own shared/*.schema.json, the same files the Zarr
// converter validates against before upload, so the served contract cannot
// drift from the one the producer enforces.
api.route("/schemas", schemaRoutes);
// Public OpenAPI 3.1 document (issue #937 item 2, phase 5 of epic
// nemarOrg/website#284). Same static/D1-free precedent as /schemas above:
// the bytes are shared/openapi.json, generated at build time from the Zod
// schemas in shared/contract/ by scripts/generate-openapi.ts -- see
// routes/openapi.ts for the drift-guard test that keeps it from silently
// going stale. Mounted at the exact "/openapi.json" path (not a directory
// of documents), matching the sub-app trailing-slash behavior noted below
// for /data: openApiRoutes.get("/") mounted at this prefix matches only
// "/openapi.json", which is exactly the single fixed URL this document
// lives at.
api.route("/openapi.json", openApiRoutes);
// Path-based mount of the data sub-app so it's reachable on every hostname
// (api.nemar.org, *.workers.dev dev fallback, etc.). The Worker also serves
// the same handlers at the root path when the request hits data.nemar.org;
// see the hostname fork in `app` below.
api.route("/data", dataRoutes);

// Hono v4 sub-app quirk: `dataRoutes.get("/")` mounted at `/data` only
// matches `/data` (no trailing slash). The trailing-slash form `/data/`
// is the natural directory-style URL machine clients append, so register
// the catalog handler directly here for that path. (The data.nemar.org
// dispatcher above normalizes its own root case before forwarding, so
// requests via the custom domain hit the sub-app form.)
api.get("/data/", (c) => catalogIndexResponse(c.env, c.req.raw));

// 404 handler. Registered on `app` as well, further down: this one alone only
// ever fires for the data.nemar.org fork, which re-enters `api.fetch`
// directly. See lib/not-found.ts.
api.notFound(notFoundResponse);

// Global error handler
api.onError((err, c) => {
  console.error("Unhandled error:", err);

  // Check if it's a validation error from zValidator
  if (err.message.includes("Malformed") || err.message.includes("JSON")) {
    return c.json(
      {
        error: "Bad Request",
        message: "Invalid JSON in request body",
      },
      400,
    );
  }

  // Don't expose internal error details in production. Key off ENVIRONMENT
  // rather than sniffing API_BASE_URL for "dev"/"localhost": staging's
  // api-test.nemar.org (epic #923) contains neither. Allow-list (fail-CLOSED):
  // an unset/unexpected ENVIRONMENT hides details, matching prod. No-op for prod.
  const isDev = isNonProductionEnv(c.env);

  return c.json(
    {
      error: "Internal Server Error",
      message: isDev ? err.message : "An unexpected error occurred",
    },
    500,
  );
});

// Mount the API at both / and /nemar so the same worker answers
// api.nemar.org/* (and *.workers.dev/*) at root and the legacy
// api.osc.earth/nemar/* prefix.
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// data.nemar.org dispatches to the data sub-app at root, so the public
// contract is `data.nemar.org/<id>/<version>/...` without a /data/ prefix.
// We rewrite the URL to /data/<rest> and re-enter `api.fetch` so the
// request inherits the full middleware stack (logger, secureHeaders, cors,
// rateLimiter, maintenanceMode) and the global `api.onError` sanitizer.
// Reading the hostname from c.req.url -- not the Host header -- prevents
// a forged Host: from steering an api.nemar.org request into this branch.
app.use("*", async (c, next) => {
  // Data/zarr hostnames are env-driven (default to the prod literals) so the
  // staging worker can answer on data-test.nemar.org / zarr-test.nemar.org
  // without a code change (epic #923). resolveHostRoute reads the hostname from
  // c.req.url (not the Host header) upstream, so a forged Host: can't steer an
  // api-host request into these forks.
  const route = resolveHostRoute(new URL(c.req.url).hostname, c.env);
  if (route === "data") {
    const url = new URL(c.req.url);
    // Mounted-root quirk: Hono v4 sub-apps treat `/data` (no trailing
    // slash) and `/data/` (trailing) as distinct match targets for
    // `dataRoutes.get("/")`. Only the no-trailing form matches the
    // mounted root, so naive `${"/data"}${"/"}` would 404 the most
    // common public URL on this host (`data.nemar.org/`). Normalize
    // the root path before prepending.
    url.pathname = url.pathname === "/" ? "/data" : `/data${url.pathname}`;
    return api.fetch(new Request(url, c.req.raw), c.env, c.executionCtx);
  }
  // zarr.nemar.org (or zarr-test.nemar.org in staging) is the authoritative
  // browser gateway for the Zarr serving copies. It dispatches to a
  // self-contained sub-app (its own restricted-origin CORS, Range pass-through,
  // and edge caching) rather than the api middleware stack -- the global cors()
  // allows *.nemar.org broadly, but the zarr host must scope CORS tightly and
  // expose Range/ETag headers zarrita needs.
  if (route === "zarr") {
    return zarrDataRoutes.fetch(c.req.raw, c.env, c.executionCtx);
  }
  // mcp.nemar.org (or mcp-test.nemar.org in staging): the NEMAR MCP server
  // (epic #1065 phase 2). Same reasoning as the zarr fork above -- its own
  // self-contained sub-app (origin gate + rate-limit bridge scoped to the
  // Streamable HTTP transport's own headers) rather than the api middleware
  // stack.
  if (route === "mcp") {
    return mcpRoutes.fetch(c.req.raw, c.env, c.executionCtx);
  }
  return next();
});

// Dev / workers.dev access to the zarr proxy (prod uses the zarr.nemar.org host
// fork above). Must precede the catch-all api mount.
app.route("/zarrproxy", zarrDataRoutes);
// Dev / workers.dev access to the MCP server (prod uses the mcp.nemar.org host
// fork above). A single-path forward (not a `.route()` sub-tree mount, unlike
// /zarrproxy above): mcpRoutes' own routing then sees the request at exactly
// `/mcp`, so only the Streamable HTTP transport endpoint is reachable this
// way -- the descriptor at `/` is host-fork only. Must precede the catch-all
// api mount.
app.all("/mcp", (c) => mcpRoutes.fetch(c.req.raw, c.env, c.executionCtx));
app.route("/nemar", api);
app.route("/", api);

// `app` needs its own 404, and this is not a duplicate of the one on `api`.
// Hono's `route()` copies a sub-app's ROUTES and not its notFound handler, and
// `app` is the worker's entry point, so before this line every unrouted request
// to api.nemar.org got Hono's plain-text default while the data.nemar.org fork
// (which calls `api.fetch` directly) got the JSON one. One shared handler, both
// apps: `POST /auth/docs/grant` answers 404 for a signed-in non-admin, and a
// 404 that does not look like the others is a 404 that identifies itself.
app.notFound(notFoundResponse);

/**
 * Scheduled cleanup handler (Cloudflare Workers cron trigger).
 * Runs daily at 3 AM UTC (production only, see wrangler-sccn.toml [triggers]).
 *
 * - Sandbox (xx) datasets: delete after 14 days (disposable, auto-deleted).
 * - Stale nm datasets: private, no DOI, no active pub requests, inactive 90 days.
 *   These are NEVER auto-deleted (#662). The cron emails the owner an escalating
 *   warning runway (30/14/7/2/1 days) and, at the deadline, asks admins to
 *   delete manually via `nemar admin delete-dataset`. Real archive data is only
 *   ever removed by a deliberate human action.
 */
/**
 * Sandbox-cleanup candidate queries, exported so the tests assert against the
 * REAL SQL instead of a hand-copied duplicate that can silently drift (the
 * pattern ARCHIVE_RETRY_SWEEP_QUERY already uses).
 *
 * The non-production form pins the candidate set to the dev ephemeral band via
 * bound parameters; the production form keeps the original whole-xx sweep.
 */
export const NON_PROD_SANDBOX_CLEANUP_QUERY = `SELECT dataset_id FROM datasets
   WHERE dataset_id >= ? AND dataset_id < ?
     AND is_exemplar = 0 AND created_at < datetime('now', '-14 days')
     AND status = 'active' LIMIT ?`;

export const PROD_SANDBOX_CLEANUP_QUERY =
  "SELECT dataset_id FROM datasets WHERE dataset_id LIKE 'xx%' AND is_exemplar = 0 AND created_at < datetime('now', '-14 days') AND status = 'active' LIMIT ?";

/**
 * Daily-cron jobs INTENTIONALLY driven from OUTSIDE the `if (prodOnlyJobs)`
 * block below, i.e. also on the dev/staging worker's tick, not just
 * production's (PR #1201 review, item 6). This exists so that decision is a
 * greppable, named declaration -- not only inferable from where a call site
 * happens to sit in the file -- mirroring AGENTS.md's "a new daily job is
 * production-only BY DEFAULT" default: a name only belongs in this list
 * after confirming it cannot email a real user, dispatch GitHub work
 * against the shared `nemarDatasets` org, or mutate a real DOI or the PROD
 * bucket -- `publishZarrCatalog` (services/zarr-catalog.ts) qualifies
 * because it only ever reads/writes the CALLING env's own D1 and S3 bucket.
 * `runZarrFidelitySweep` (services/zarr-fidelity-sweep.ts, issue #1068,
 * epic #1181 phase 8) qualifies for the same reason PLUS one more: its
 * dataset-repo reads go through the public, credential-free
 * `raw.githubusercontent.com` content host, never the GitHub API/App/PAT --
 * see that module's doc comment for why that is a materially different,
 * dev-safe exposure from `signal-defaults-sweep.ts`'s GitHub-API-based
 * `getBidsTreeStats` (which IS prod-only, in the guarded block below).
 * `fetchAndSyncDataPapers` (services/data-papers-sync.ts, ADR 0077) qualifies
 * because it only GETs a public manifest from the citations dashboard and
 * UPDATEs the CALLING env's own D1: no email, no GitHub, no DOI, no bucket.
 * (`fetchAndSyncCitationCounts`, which it mirrors, is also driven outside the
 * guarded block but was never named here; it is not in this list.)
 * `backend/test/cron-sweep-wiring.test.ts` pins that every name here is
 * both actually called and called outside the guarded block.
 */
export const DEV_CRON_ALLOWLIST = [
  "publishZarrCatalog",
  "runZarrFidelitySweep",
  "fetchAndSyncDataPapers",
] as const;

async function scheduledCleanup(env: Bindings): Promise<void> {
  const db = env.DB;
  const now = new Date();
  const results: Array<{
    dataset_id: string;
    success: boolean;
    error?: string;
    warnings?: string[];
  }> = [];
  const MAX_DELETIONS_PER_RUN = 10;

  // Prod-invariant guard (epic #923): the Phase 4 visibility SQL carve-outs admit
  // is_exemplar=1 rows with NO runtime env check, relying on the invariant that
  // production D1 never has such a row (the creation endpoint 403s in prod). If
  // one ever appears here, a bug bypassed that gate and the row is silently
  // public across catalog/search/data-index — surface it loudly rather than
  // letting it hide.
  //
  // Uses !isNonProductionEnv rather than ENVIRONMENT === "production" so it
  // FAILS CLOSED: this is the ONLY environment-aware backstop behind the
  // env-blind visibility carve-outs, so an unset/typo'd ENVIRONMENT on the prod
  // worker must still run the check. A literal string comparison would silently
  // stop alarming on exactly the config drift the alarm exists to catch.
  if (!isNonProductionEnv(env)) {
    try {
      const exemplarLeak = await db
        .prepare("SELECT COUNT(*) as n FROM datasets WHERE is_exemplar = 1")
        .first<{ n: number }>();
      const leakCount = exemplarLeak?.n ?? 0;
      if (leakCount > 0) {
        console.error(
          `[cleanup] INVARIANT VIOLATION: ${leakCount} is_exemplar=1 row(s) exist in PRODUCTION. These are staging-only and are now silently public via the exemplar visibility carve-outs. Investigate the exemplar creation gate immediately.`,
        );
        // Active escalation: a silent public data exposure must page a human, not
        // sit in Worker Logs until someone happens to read them.
        if (env.RESEND_API_KEY) {
          try {
            const emailCfg = resolveEmailConfig(env);
            const adminEmails = await getAdminEmailsForCategory(db, "publication_request", env);
            if (adminEmails.length > 0) {
              await sendExemplarInvariantAlertEmail(
                adminEmails,
                leakCount,
                env.RESEND_API_KEY,
                emailCfg.fromEmail,
                emailCfg.replyTo,
                emailCfg.isDev,
                env,
              );
            }
          } catch (emailErr) {
            console.error("[cleanup] failed to send exemplar-invariant alert email:", emailErr);
          }
        }
      }
    } catch (err) {
      console.error("[cleanup] exemplar-invariant check failed:", err);
    }
  }

  /** Delete each dataset in `rows`, pushing outcomes into `results`. */
  async function deleteRows(rows: Array<{ dataset_id: string }>): Promise<void> {
    for (const row of rows) {
      try {
        const result = await deleteDatasetCascade(db, env, row.dataset_id, {});
        results.push({
          dataset_id: row.dataset_id,
          success: result.deleted,
          warnings: result.warnings.length > 0 ? result.warnings : undefined,
        });
      } catch (err) {
        results.push({
          dataset_id: row.dataset_id,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // 1. Sandbox datasets older than 14 days (exemplars are curated, never auto-deleted; epic #923)
  //
  // Outside production the candidate set is additionally pinned to the dev
  // ephemeral band (xx090001-xx099899). Two reasons: the dev D1 is a partial
  // prod mirror, and deleteDatasetCascade's GitHub half is NOT environment
  // scoped (it always deletes nemarDatasets/<id>), so an unexpected match here
  // destroys a real repository. The band keeps the dev cron off the curated
  // exemplar fleet (xx099900+), off prod's sandbox band (<= xx089999), and off
  // any legacy row. Production behavior is unchanged.
  try {
    const sandboxRows = await (isNonProductionEnv(env)
      ? db
          .prepare(NON_PROD_SANDBOX_CLEANUP_QUERY)
          .bind(DEV_EPHEMERAL_BAND_START, DEV_EPHEMERAL_BAND_END, MAX_DELETIONS_PER_RUN)
      : db.prepare(PROD_SANDBOX_CLEANUP_QUERY).bind(MAX_DELETIONS_PER_RUN)
    ).all<{ dataset_id: string }>();

    await deleteRows(sandboxRows.results);
  } catch (err) {
    console.error("Scheduled cleanup: sandbox query failed:", err);
  }

  // 2. Stale nm datasets: warn the owner on an escalating runway, then hand
  //    off to admins for a manual delete. The cron NEVER auto-deletes nm
  //    datasets (#662) — removing real archive data always needs a human.
  //    Folded legacy catalog rows (#646) are excluded by the LIKE 'nm%'
  //    filter below (sentinel rows are ds*/on*); the visibility clause no
  //    longer does that work on its own, because #1407 widened it to
  //    (visibility = 'private' OR anonymous = 1).
  const staleness = { warned: 0, adminNotified: 0, reset: 0 };
  // Datasets become warning candidates once within FIRST_WARNING_DAYS of the
  // 90-day deadline, i.e. inactive for at least (90 - 30) days.
  const warnWindow = `-${STALENESS_LIMIT_DAYS - FIRST_WARNING_DAYS} days`;
  // PRODUCTION ONLY (epic #923 Phase 7). The candidate query matches nm* rows
  // directly and the dev/staging D1 is a partial prod mirror carrying real
  // datasets and real owner addresses, while the dev worker holds a live
  // RESEND_API_KEY. applyDevWrap only prefixes "[DEV]" on the subject; it does
  // not suppress or redirect delivery, so running this outside production mails
  // real researchers a "your dataset will be deleted in N days" notice.
  if (isNonProductionEnv(env)) {
    console.log("[cleanup] staleness warnings skipped (non-production)");
  } else {
    try {
      // Reset tracking for anything no longer stale (fresh activity, a DOI, a
      // pending pub request, or made public) so a later cycle re-warns cleanly.
      const resetRes = await db
        .prepare(
          `UPDATE datasets
            SET staleness_warn_stage = NULL, staleness_admin_notified_at = NULL
          WHERE (staleness_warn_stage IS NOT NULL OR staleness_admin_notified_at IS NOT NULL)
            AND NOT (
              dataset_id LIKE 'nm%' AND status = 'active' AND concept_doi IS NULL
              AND (visibility = 'private' OR anonymous = 1)
              AND COALESCE(last_activity_at, created_at) < datetime('now', ?)
              AND dataset_id NOT IN (
                SELECT dataset_id FROM publication_requests WHERE status NOT IN ('published','denied')
              )
            )`,
        )
        .bind(warnWindow)
        .run();
      staleness.reset = resetRes.meta.changes ?? 0;

      // Candidates inside the warning window, oldest (most urgent) first.
      // Already-handled past-deadline rows (admins already notified) are excluded
      // so a growing awaiting-deletion backlog can't fill the LIMIT and starve a
      // newly-past-deadline dataset out of ever reaching an admin.
      const MAX_STALE_EMAILS_PER_RUN = 30;
      const staleLimit = `-${STALENESS_LIMIT_DAYS} days`;
      const candidates = await db
        .prepare(
          `SELECT d.dataset_id, d.name,
                COALESCE(d.last_activity_at, d.created_at) AS effective_activity,
                d.staleness_warn_stage AS warn_stage,
                d.staleness_admin_notified_at AS admin_notified_at,
                u.email AS owner_email
           FROM datasets d
           LEFT JOIN users u ON u.id = d.owner_user_id
          WHERE d.dataset_id LIKE 'nm%' AND d.status = 'active' AND d.concept_doi IS NULL
            -- visibility = 'private' was this query's stand-in for "not yet
            -- published". An anonymous deposit (#1407) breaks that: it
            -- is listed publicly while its repo stays private, so it would
            -- fall out of this set and an abandoned one would never get the
            -- warnings every other unpublished dataset gets.
            AND (d.visibility = 'private' OR d.anonymous = 1)
            AND COALESCE(d.last_activity_at, d.created_at) < datetime('now', ?)
            AND d.dataset_id NOT IN (
              SELECT dataset_id FROM publication_requests WHERE status NOT IN ('published','denied')
            )
            AND NOT (
              COALESCE(d.last_activity_at, d.created_at) < datetime('now', ?)
              AND d.staleness_admin_notified_at IS NOT NULL
            )
          ORDER BY effective_activity ASC
          LIMIT ?`,
        )
        .bind(warnWindow, staleLimit, MAX_STALE_EMAILS_PER_RUN)
        .all<{
          dataset_id: string;
          name: string;
          effective_activity: string;
          warn_stage: number | null;
          admin_notified_at: string | null;
          owner_email: string | null;
        }>();

      if (candidates.results.length > 0) {
        const emailCfg = resolveEmailConfig(env);
        const canEmail = Boolean(env.RESEND_API_KEY);
        if (!canEmail) {
          console.error(
            "Scheduled cleanup: RESEND_API_KEY is not set — staleness notifications are skipped and will retry next run.",
          );
        }
        // Fetch admin emails in its own boundary: a D1 hiccup here must not abort
        // the per-dataset owner warnings below.
        let adminEmails: string[] = [];
        if (canEmail) {
          try {
            adminEmails = await getAdminEmailsForCategory(db, "publication_request", env);
          } catch (err) {
            console.error("Scheduled cleanup: failed to fetch admin emails:", err);
          }
        }

        for (const row of candidates.results) {
          // Per-row boundary: a single failing row must not abandon the rest.
          try {
            const daysLeft = daysUntilDeletion(row.effective_activity, now);

            if (daysLeft <= 0) {
              // Past the deadline: notify admins once, then leave it for a manual
              // `nemar admin delete-dataset`. Advance the flag ONLY when an admin
              // was actually reached, so a transient send failure or a missing
              // RESEND key retries next run instead of silently burying the
              // dataset (the failure mode that lost nm000111/116/117 one step up).
              if (!row.admin_notified_at) {
                let handled = false;
                if (!canEmail) {
                  // Infra missing — leave unflagged so the next run retries.
                } else if (adminEmails.length === 0) {
                  // No admins exist to notify; advance so we don't loop forever.
                  handled = true;
                } else {
                  const delivered = await sendStalenessAdminReviewEmail(
                    adminEmails,
                    row.dataset_id,
                    row.name,
                    row.owner_email,
                    row.warn_stage,
                    env.RESEND_API_KEY,
                    emailCfg.fromEmail,
                    emailCfg.replyTo,
                    emailCfg.isDev,
                    env,
                  );
                  handled = delivered > 0;
                }
                if (handled) {
                  await db
                    .prepare(
                      "UPDATE datasets SET staleness_admin_notified_at = datetime('now') WHERE dataset_id = ?",
                    )
                    .bind(row.dataset_id)
                    .run();
                  staleness.adminNotified++;
                }
              }
              continue;
            }

            // Inside the window: email the owner once per threshold crossed.
            // Advance the stage ONLY when the warning was actually delivered (or
            // there is no owner address to reach), so a Resend outage retries.
            const stage = warningStageForDaysLeft(daysLeft);
            if (stage !== null && stage !== row.warn_stage) {
              let handled = false;
              if (!canEmail) {
                // Infra missing — leave the stage so the next run retries.
              } else if (!row.owner_email) {
                // No address to warn; advance so we move on (admins still get the
                // day-0 notice). Nothing to retry.
                handled = true;
              } else {
                try {
                  await sendStalenessWarningEmail(
                    row.owner_email,
                    row.dataset_id,
                    row.name,
                    daysLeft,
                    deletionDate(row.effective_activity),
                    env.RESEND_API_KEY,
                    emailCfg.fromEmail,
                    emailCfg.replyTo,
                    emailCfg.isDev,
                    env,
                  );
                  handled = true;
                } catch (err) {
                  console.error(
                    `Scheduled cleanup: warning email failed for ${row.dataset_id}:`,
                    err,
                  );
                }
              }
              if (handled) {
                await db
                  .prepare("UPDATE datasets SET staleness_warn_stage = ? WHERE dataset_id = ?")
                  .bind(stage, row.dataset_id)
                  .run();
                staleness.warned++;
              }
            }
          } catch (err) {
            console.error(`Scheduled cleanup: failed processing ${row.dataset_id}:`, err);
          }
        }
      }
    } catch (err) {
      console.error("Scheduled cleanup: stale dataset warning failed:", err);
    }
  }

  // 3. Stuck manifest_jobs detection (#557). The central workflow is
  //    expected to call back within minutes; a row stuck in 'dispatched'
  //    for more than an hour means the workflow timed out, was
  //    cancelled, or the callback never landed. Operators page off
  //    these log lines -- no D1 mutation here, just visibility.
  try {
    const stuck = await db
      .prepare(
        `SELECT dataset_id, version, created_at FROM manifest_jobs
         WHERE status = 'dispatched' AND created_at < datetime('now', '-1 hour')`,
      )
      .all<{ dataset_id: string; version: string; created_at: string }>();

    if (stuck.results && stuck.results.length > 0) {
      console.error(
        `[manifest-cleanup] ${stuck.results.length} stuck manifest_jobs rows:`,
        stuck.results.map((r) => `${r.dataset_id}@${r.version} (${r.created_at})`).join(", "),
      );
    }
  } catch (err) {
    console.error("Scheduled cleanup: stuck manifest_jobs query failed:", err);
  }

  // 4. Stuck import_jobs (#754). An import row in an in-flight state that
  //    hasn't advanced in 6h means the workflow hit the 6h runner cap, crashed,
  //    or the report job / callback was lost (the on004395 orphan signature).
  //    Mark it failed, then run the SAME rollback-or-quarantine decision as the
  //    webhook so the orphan is surfaced (and, behind the flag, cleaned) instead
  //    of left silent. This is the durable backstop for the cases the report
  //    job can't cover: a whole-run operator-cancel (GitHub doesn't start a
  //    queued `if: always()` job), every callback failing, or the webhook's
  //    waitUntil recovery being dropped on Worker eviction.
  //
  //    PRODUCTION ONLY (epic #923 Phase 7). Admin import already 403s outside
  //    production (Phase 1), so a dev/staging worker has no imports of its own
  //    to recover; on the prod-mirror dev D1 the only thing this could do is
  //    email admins a quarantine alert about a real import.
  let importsSwept = 0;
  if (isNonProductionEnv(env)) {
    console.log("[import-sweep] skipped (non-production)");
  } else {
    try {
      const stuckImports = await db
        .prepare(
          `SELECT dataset_id FROM import_jobs
         WHERE status IN ('preparing', 'copying', 'finalizing')
           AND updated_at < datetime('now', '-6 hours')
         LIMIT ?`,
        )
        .bind(MAX_DELETIONS_PER_RUN)
        .all<{ dataset_id: string }>();
      // The sweep's own bookkeeping message. Declared once so the string and its
      // ADR 0051 classification cannot drift apart: passing a hand-written `true`
      // would keep claiming "generic" even if this wording later became a real
      // diagnosis. No quote escaping needed, and asserted by the const's own text.
      const STUCK_IMPORT_MESSAGE = "stuck > 6h (scheduled sweep)";
      for (const row of stuckImports.results ?? []) {
        try {
          const upd = await db
            .prepare(
              // A specific error is never overwritten by a generic one (ADR 0051).
              // "stuck > 6h" says only that this sweep fired; a row can be in-flight
              // here yet already carry a real diagnosis (a racing finalize POST moved
              // it off `failed` before the webhook's dropped waitUntil recovery ran --
              // the very eviction case this sweep backstops). Overwriting it would make
              // runImportRecovery below misclassify a known failure as a generic stuck
              // import, and for the OpenNeuro marker specifically would also drop the
              // string the retry engine needs to re-select the row.
              `UPDATE import_jobs
               SET status = 'failed',
                   last_error = ${lastErrorAssignmentSql(
                     isGenericImportError(STUCK_IMPORT_MESSAGE),
                     "last_error",
                     `'${STUCK_IMPORT_MESSAGE}'`,
                   )},
                   completed_at = datetime('now'), updated_at = datetime('now')
             WHERE dataset_id = ? AND status IN ('preparing', 'copying', 'finalizing')`,
            )
            .bind(row.dataset_id)
            .run();
          if (upd.meta.changes > 0) {
            await runImportRecovery(db, env, row.dataset_id);
            importsSwept++;
          }
        } catch (err) {
          console.error(`[import-sweep] recovery for ${row.dataset_id} failed:`, err);
        }
      }
    } catch (err) {
      console.error("Scheduled cleanup: stuck import_jobs query failed:", err);
    }
  }

  // 5. Re-evaluate publication requests blocked on BIDS validation (#428). A
  //    request blocked while CI was pending/running never re-checked itself when
  //    CI later went green, so requests sat in 'blocked' indefinitely. Re-read
  //    the latest run for each and transition: green -> 'requested', failing ->
  //    'bids_validation_failed'. Defense-in-depth; never throws.
  //
  //    Outside production this self-narrows to the dev range (xx09NNNN) inside
  //    the service, because its unrestricted candidate query would otherwise
  //    match REAL datasets' publication requests on the prod-mirror dev D1,
  //    read their real repos through the shared nemarDatasets App installation,
  //    and rewrite their status. Narrowed rather than skipped: staging needs
  //    this sweep, since an exemplar published while BIDS validation is still
  //    running lands in 'blocked' and would otherwise stay stuck.
  let blockedSweep = {
    scanned: 0,
    unblocked: 0,
    reblocked: 0,
    errors: 0,
    deferred: 0,
    skipped: 0,
    gateReads: 0,
  };
  try {
    blockedSweep = await sweepBlockedBidsValidationRequests(env);
  } catch (err) {
    console.error("Scheduled cleanup: blocked publication-request sweep failed:", err);
    // The tally below is written to the audit log. Left at its zeros it would read as a sweep
    // that ran and found nothing to do (ADR 0054), which is the opposite of what happened.
    blockedSweep = { ...blockedSweep, errors: 1 };
  }

  // Log summary to audit_log. `deleted`/`failed` cover only sandbox (xx)
  // datasets now; nm datasets are warned, not deleted, by this job.
  const deleted = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  try {
    await db
      .prepare("INSERT INTO audit_log (action, details) VALUES (?, ?)")
      .bind(
        "scheduled_cleanup",
        JSON.stringify({
          deleted,
          failed,
          datasets: results,
          staleness,
          importsSwept,
          blockedSweep,
        }),
      )
      .run();
  } catch (err) {
    console.error("Scheduled cleanup: failed to write audit log:", err);
  }
  console.log(
    `Scheduled cleanup: ${deleted} deleted, ${failed} failed; staleness warned=${staleness.warned} adminNotified=${staleness.adminNotified} reset=${staleness.reset}; importsSwept=${importsSwept}; blockedSweep unblocked=${blockedSweep.unblocked} reblocked=${blockedSweep.reblocked} errors=${blockedSweep.errors} deferred=${blockedSweep.deferred} skipped=${blockedSweep.skipped}`,
  );
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    // Two cron schedules share this handler; branch on which one fired so the
    // daily jobs don't run on the frequent auto-import tick (#775). The
    // frequent tick self-gates to ~90 min, so it's cheap on the off-ticks.
    if (event.cron === AUTO_IMPORT_CRON) {
      ctx.waitUntil(
        autoImportTick(env).catch((err) =>
          // Log the stack on an unattended tick so the failing call is locatable
          // in Workers logs, not just the message (#784 review).
          console.error(
            "[auto-import] tick failed:",
            err instanceof Error ? (err.stack ?? err.message) : err,
          ),
        ),
      );
      // Epic #1610 phase 4: the identifier-screen watchdog. It rides this tick
      // rather than the daily one because its deadline is 50 minutes: a screen
      // that never reports must reach the admins within about an hour, not the next
      // day. PRODUCTION-ONLY, by AGENTS.md's default for a new cron job and for
      // that rule's reason: it mails admins, and the dev worker shares the
      // `users` table with production. It is therefore not in
      // DEV_CRON_ALLOWLIST; the sweep also refuses outside production on its
      // own, and staging recovers a stuck screen with the admin re-run route.
      // D1 and the admin mail only: no GitHub call, so no infrastructure verdict.
      if (!isNonProductionEnv(env)) {
        ctx.waitUntil(
          sweepIdentifierScreens(env)
            .then((r) => {
              if (r.timedOut + r.emailed + r.undelivered + r.errors > 0) {
                console.log(
                  `[identifier-screen-sweep] timedOut=${r.timedOut} emailed=${r.emailed} undelivered=${r.undelivered} errors=${r.errors}`,
                );
              }
            })
            .catch((err) =>
              console.error(
                "[identifier-screen-sweep] sweep failed:",
                err instanceof Error ? (err.stack ?? err.message) : err,
              ),
            ),
        );
        // ADR 0092: the pull-request review watchdog. A review handed to GitHub that never
        // reports is marked unreported and its check turned to "needs a person", because a
        // dispatch is answered 204 whether or not a workflow listens and the check would
        // otherwise stay "in progress" for good. It also republishes a stored result whose
        // check never reached GitHub. PRODUCTION-ONLY, by AGENTS.md's default for a new cron
        // job: it writes check-runs and comments to the shared nemarDatasets org, which the dev
        // worker would also reach. It does NOT read PR_REVIEW_ENABLED: switching the review off must not
        // strand the checks of reviews already in flight.
        ctx.waitUntil(
          sweepStalePrReviews(env)
            .then((r) => {
              if (r.timedOut + r.republished + r.abandoned + r.errors > 0) {
                console.log(
                  `[pr-review-sweep] timedOut=${r.timedOut} republished=${r.republished} abandoned=${r.abandoned} errors=${r.errors}`,
                );
              }
            })
            .catch((err) =>
              console.error(
                "[pr-review-sweep] sweep failed:",
                err instanceof Error ? (err.stack ?? err.message) : err,
              ),
            ),
        );
        // Epic #1610 phase 5 (ADR 0088): the scheduled identifier sweep. Each tick
        // marks an overdue screen unreported and dispatches at most three published
        // datasets to the same screen workflow, so the fleet is covered over its
        // 28-day cycle a few datasets at a time. PRODUCTION-ONLY and absent from
        // DEV_CRON_ALLOWLIST: it dispatches against the shared nemarDatasets org. It
        // also refuses outside production on its own. It writes only sweep_stamps.
        ctx.waitUntil(
          runIdentifierSweepTick(env)
            .then((r) => {
              const line = `[identifier-sweep] timedOut=${r.timedOut ?? "?"} inFlight=${r.inFlight ?? "?"} candidates=${r.candidates} dispatched=${r.dispatched} unconfirmed=${r.unconfirmed.length} failed=${r.failed.length} unclaimed=${r.unclaimed} blocked=${r.blocked ?? "no"} errors=${r.errors.length}`;
              // Anything but a clean dispatch or an idle tick is logged where it is
              // seen: a screen that did not report, a dispatch that could not be
              // made or confirmed, a claim that matched nothing, a statement error.
              const trouble =
                r.failed.length + r.errors.length + r.unconfirmed.length + r.unclaimed > 0 ||
                (r.timedOut ?? 1) > 0 ||
                r.inFlight === null ||
                r.blocked !== null;
              if (trouble) {
                console.error(line);
                for (const f of r.failed)
                  console.error(`[identifier-sweep] ${f.dataset_id}: ${f.error}`);
                for (const e of r.errors) console.error(`[identifier-sweep] ${e}`);
              } else if (r.dispatched > 0) {
                console.log(line);
              }
            })
            .catch((err) =>
              console.error(
                "[identifier-sweep] tick failed:",
                err instanceof Error ? (err.stack ?? err.message) : err,
              ),
            ),
        );
        // ADR 0088: the sweep's weekly admin report, for the ISO week before this one.
        // It arrives whether or not anything is wrong (ADR 0054). Evaluated on every
        // tick and sent once, by an atomic claim in audit_log that fails closed; a
        // send that reached nobody is retried on a later tick, up to a cap. Mail
        // goes through getAdminEmailsForCategory's production fence as well.
        ctx.waitUntil(
          sendIdentifierSweepWeeklyReport(env)
            .then((r) => {
              if (!r) return;
              if (!r.claimed) {
                // Sent, or a claim is live: routine. Out of claims with nothing
                // sent means this week's report will not arrive.
                if (r.exhausted) {
                  console.error(
                    `[identifier-sweep] weekly ${r.week}: every claim is spent and nothing was delivered; this week's report will not arrive`,
                  );
                }
                return;
              }
              const line = `[identifier-sweep] weekly ${r.week}: delivered=${r.delivered} of ${r.attempted} attention=${r.attention}`;
              if (r.delivered < r.attempted || r.delivered === 0 || r.attention)
                console.error(line);
              else console.log(line);
            })
            .catch((err) =>
              console.error(
                "[identifier-sweep] weekly report failed:",
                err instanceof Error ? (err.stack ?? err.message) : err,
              ),
            ),
        );
      }
      return;
    }
    // Daily (prod "0 3 * * *", dev/staging "0 4 * * *"):
    // Catalog sync runs via GitHub Action, not Worker cron.
    //
    // ALLOWLIST, epic #923 Phase 7. The dev/staging D1's dataset catalog is no
    // longer a production mirror -- it was purged to the curated fixtures (the
    // `xx0999NN` exemplars plus the private E2E dataset) and must stay that way.
    // The reason for this allowlist survives that purge: the `users` table was
    // NOT purged (it still holds ~609 real email addresses), the dev worker
    // holds a real RESEND_API_KEY, and the nemarDatasets GitHub org is SHARED
    // between prod and dev because the org name is hardcoded rather than
    // environment-scoped. So a daily job that selects rows by generic predicates
    // can still email real people or destroy a real repo. Only jobs proven safe
    // against that run outside production. See AGENTS.md, "Dev D1 shares
    // production users and the GitHub org".
    //
    // A NEW DAILY JOB IS PRODUCTION-ONLY BY DEFAULT. Before adding one to the
    // non-prod set below, confirm it cannot (a) email a real user, (b) dispatch
    // GitHub work against the shared nemarDatasets org, or (c) mutate a real
    // DOI / prod-bucket object. When in doubt, leave it in the prod-only block.
    const prodOnlyJobs = !isNonProductionEnv(env);

    // Safe outside prod: scheduledCleanup self-narrows to the dev sandbox band
    // and, outside production, runs ONLY its sandbox-delete, stuck-manifest
    // logging and audit-log sections, plus the blocked-publication sweep narrowed to the dev
    // range and the fixtures dev owns. Its staleness-email and import-recovery sections are
    // production-only (guards inside).
    ctx.waitUntil(scheduledCleanup(env));
    // #646 Phase 4: drain stale vectors (embedding_dirty=1) — the backstop for
    // changes that don't go through the inline enrich/reindex re-embed.
    // Safe outside prod: writes only to the env-bound (dev) Vectorize index.
    ctx.waitUntil(drainEmbeddingDirty(env.DB, env.AI, env.VECTORIZE));

    if (prodOnlyJobs) {
      // #736 Phase 3: backstop re-dispatch of still-failed archive generations
      // whose webhook retry chain broke (e.g. a lost archive-ready callback).
      // PROD-ONLY: the candidate query has no dataset-id prefix filter, so
      // outside production it would repository_dispatch real Actions runs
      // against the SHARED nemarDatasets org for whatever rows the dev D1 holds
      // -- the fixtures there (nm099999, the exemplars) are real repos in it.
      ctx.waitUntil(archiveRetrySweep(env));
      // #1130: heal published versions whose S3 manifest never landed (the
      // version-DOI callback swallows manifest failures by design, so without
      // this sweep a rate-limit burst leaves "Version not published" pages
      // behind indefinitely — the nm000225 incident). Bounded to a recency
      // window; full-catalog detection lives in nemar-observability.
      // PROD-ONLY: the fix reads real nemarDatasets repos via the shared App
      // and uploads to the prod bucket; the guard is also repeated inside.
      ctx.waitUntil(
        manifestIntegritySweep(env).catch((err) =>
          console.error(
            "[manifest-sweep] sweep failed:",
            err instanceof Error ? (err.stack ?? err.message) : err,
          ),
        ),
      );
      // #900: backstop for a version-DOI mint that crashed after createIdentifier
      // (reserved) but before makePublic, leaving a permanent non-resolving DOI.
      // PROD-ONLY: sandbox-vs-prod EZID auth is chosen from the DOI string, not
      // from ENVIRONMENT, so a real 10.82901 DOI on a mirror row resolves to
      // production EZID credentials regardless of which worker is running.
      ctx.waitUntil(reconcileReservedVersionDois(env));
      // #969 (epic #967 Phase 2): reclassify falsely-complete imports, retry
      // incomplete/failed/quarantined ones, and blocklist + report ones whose
      // OpenNeuro source stays inaccessible. PROD-ONLY: dispatches GitHub work
      // against the shared nemarDatasets org and can email an external
      // OpenNeuro maintainer; sweepImportRetries also self-guards internally.
      ctx.waitUntil(
        sweepImportRetries(env).catch((err) =>
          console.error(
            "[import-retry] sweep failed:",
            err instanceof Error ? (err.stack ?? err.message) : err,
          ),
        ),
      );
      // #1310 (epic #1306): drain the import-failure tracking issues. Closes the
      // ones whose dataset now verifies complete against S3, and retires stale
      // cause labels. Before this the tracker only accumulated -- a backlog of
      // open issues, none ever closed (ADR 0052 has the count and the date it was
      // measured) -- so it could not distinguish a live problem from one that
      // healed weeks ago.
      //
      // PROD-ONLY, and deliberately NOT in DEV_CRON_ALLOWLIST: it closes and
      // relabels real issues on the shared nemarDatasets org, which a dev worker
      // must never do.
      ctx.waitUntil(
        runImportIssueSweepCron(env)
          .then((r) => {
            // null means the wrapper's own guard skipped this run (non-prod);
            // it already logged why, so there is nothing to summarise.
            if (!r) return;
            console.log(
              `[import-issue-sweep] open=${r.openIssues} mode=${r.mode} examined=${r.examined} ` +
                `attempted=${r.attempted} closed=${r.closed} relabelled=${r.relabelled} ` +
                `kept=${r.kept} errors=${r.errors.length} remaining=${r.remaining}`,
            );
            // The aggregate line cannot say WHICH issues moved, which is what an
            // operator reads this log for. Bounded by the sweep's own limit.
            for (const line of importIssueSweepLogLines(r)) {
              console.log(`[import-issue-sweep] ${line}`);
            }
            for (const e of r.errors) {
              console.error(
                `[import-issue-sweep] #${e.issue} (${e.dataset_id}) ${e.stage}: ${e.error}`,
              );
            }
          })
          .catch((err) =>
            console.error(
              "[import-issue-sweep] sweep failed:",
              err instanceof Error ? (err.stack ?? err.message) : err,
            ),
          ),
      );
      // #1311 (epic #1306): report the pipeline's own silence. Diffs OpenNeuro
      // against D1 and alarms when in-scope datasets are accruing while the
      // importer has stopped dispatching -- or is switched off and forgotten,
      // which is what happened for seven weeks from 2026-07-20 with nothing in
      // the system able to say so. Every other sweep here reports on work that
      // was attempted; this one notices work that never started.
      //
      // PROD-ONLY, and deliberately NOT in DEV_CRON_ALLOWLIST: it files and
      // closes a real issue on the shared nemarDatasets org, the same reason
      // runImportIssueSweepCron is excluded.
      ctx.waitUntil(
        runImportCoverageSweepCron(env)
          .then((r) => {
            // null means the wrapper's own guard skipped this run (non-prod).
            if (!r) return;
            // Logged at error level for anything that is not healthy -- an alarm
            // or an unreadable verdict. This is the one sweep whose whole purpose
            // is to be noticed, and console.log would sit at the same level as
            // every routine summary.
            const line = `[import-coverage] ${importCoverageSweepSummary(r)}`;
            if (r.status === "healthy") console.log(line);
            else console.error(`${line} reason="${r.reason}"`);
            for (const e of r.errors) {
              console.error(`[import-coverage] ${e.stage}: ${e.error}`);
            }
          })
          .catch((err) =>
            console.error(
              "[import-coverage] sweep failed:",
              err instanceof Error ? (err.stack ?? err.message) : err,
            ),
          ),
      );
      // #1312 (epic #1306): the weekly summary. Rides the DAILY tick behind a
      // day-of-week guard rather than a new cron trigger. `event.cron` is compared
      // against AUTO_IMPORT_CRON by exact string equality above and the daily work is
      // the implicit else, so a third trigger would not disturb that comparison -- it
      // would fall straight through it and re-run EVERY daily job on the new schedule. Monday UTC, matching the repo's two
      // existing weekly Actions.
      //
      // The guard is a pure exported function on purpose: nothing in this repo
      // invokes `scheduled()`, so a condition written inline here would be
      // untestable by construction (the reason services/cron-sweep-log.ts exists).
      //
      // Unconditional by design -- it posts whether or not anything is wrong,
      // because a report that only appears on breakage cannot tell a healthy week
      // from a broken reporter. The once-per-week gate lives in the service.
      //
      // PROD-ONLY, and deliberately NOT in DEV_CRON_ALLOWLIST: it files and closes
      // real issues on the shared nemarDatasets org.
      if (shouldRunWeeklySummary(new Date())) {
        ctx.waitUntil(
          runWeeklyImportSummaryCron(env)
            .then((r) => {
              // null means the wrapper's own guard skipped this run (non-prod).
              if (!r) return;
              const line = weeklySummaryCronLine(r);
              // At error level when the week needs attention, so it does not sit at
              // the same level as every routine summary. `posted === false` is a
              // gate refusal, which is routine.
              // `facts` is null when the gate refused, i.e. nothing was gathered.
              // Escalate on attention OR on a post that failed after the gate let it
              // through -- an earlier version gated the escalation on `r.posted`, so
              // a failed post logged at info level.
              const attention = r.facts !== null && weeklyHeadline(r.facts).attention;
              if (attention || (r.facts !== null && !r.posted)) console.error(line);
              else console.log(line);
              for (const e of r.facts?.errors ?? []) {
                console.error(`[import-weekly] ${e.stage}: ${e.error}`);
              }
            })
            .catch((err) =>
              console.error(
                "[import-weekly] summary failed:",
                err instanceof Error ? (err.stack ?? err.message) : err,
              ),
            ),
        );
      }
      // #1041 (epic #1044): drain datasets whose per-file availability report is
      // stale. The archive-ready callback clears availability_report_at on every
      // 'ready' build, which is the enqueue; without a drain those rows would
      // stay stale forever, since nothing else stamps that column.
      //
      // PROD-ONLY: each candidate commits `.nemar/availability-report.json` to a
      // real repo in the shared nemarDatasets org via createOrUpdateFile, so on
      // a mirror D1 this would write to production dataset repos. It also has no
      // dataset-id prefix filter, exactly like archiveRetrySweep above.
      //
      // Called via the Cron wrapper (#1166): the exported sweep itself is left
      // unguarded because the admin backfill route calls it directly and needs
      // it to keep working on staging, so the fence lives in
      // runAvailabilityReportSweepCron instead. Kept inside this block too,
      // belt and braces, exactly like archiveRetrySweep's own internal guard.
      //
      // Self-limiting rather than exhaustive: capped at
      // AVAILABILITY_REPORT_SWEEP_MAX (30) GitHub commits per run because a
      // burst of writes trips GitHub's secondary rate limit on the shared PAT.
      // It drains up to 30/day and stamps only on success, so failures are
      // retried on the next pass (see AVAILABILITY_REPORT_SWEEP_BASE_WHERE for
      // rows the write refuses). A large backlog is meant to be cleared with
      // `nemar admin availability-report --all`, not by waiting on this.
      ctx.waitUntil(
        runAvailabilityReportSweepCron(env)
          .then((r) => {
            // A null result means the wrapper's guard skipped the run and
            // already logged it; sweepLogLines owns that decision so it can be
            // tested without invoking scheduled(). See #1167 review.
            const lines = sweepLogLines(
              "availability-report-sweep",
              r,
              (r) =>
                `[availability-report-sweep] processed=${r.processed} written=${r.written} errors=${r.errors.length} remaining=${r.remaining ?? "?"}`,
            );
            if (lines.info) console.log(lines.info);
            for (const e of lines.errors) console.error(e);
          })
          .catch((err) =>
            console.error(
              "[availability-report-sweep] sweep failed:",
              err instanceof Error ? (err.stack ?? err.message) : err,
            ),
          ),
      );
      // Epic #1144 Phase 2 (#1146): backfill dataset-level recording
      // duration/count/channel-range stats from each dataset's zarr index.
      // PROD-ONLY BY DEFAULT per AGENTS.md, though this job's own writes are
      // narrower than most of the block above: it only reads the prod S3
      // bucket and writes D1 columns, with no email, no GitHub dispatch, and
      // no DOI/bucket mutation. Kept in the prod-only block anyway --
      // AGENTS.md's default stands absent a specific reason to carve out an
      // exception, and there is none here.
      //
      // Called via the Cron wrapper (#1166): the exported sweep itself is left
      // unguarded because the admin backfill route calls it directly and needs
      // it to keep working on staging, so the fence lives in
      // runRecordingStatsSweepCron instead. Kept inside this block too, belt
      // and braces, exactly like archiveRetrySweep's own internal guard.
      ctx.waitUntil(
        runRecordingStatsSweepCron(env)
          .then((r) => {
            // A null result means the wrapper's guard skipped the run and
            // already logged it; sweepLogLines owns that decision so it can be
            // tested without invoking scheduled(). See #1167 review.
            const lines = sweepLogLines(
              "recording-stats-sweep",
              r,
              (r) =>
                `[recording-stats-sweep] processed=${r.processed} measured=${r.measured} unmeasured=${r.unmeasured} errors=${r.errors.length} remaining=${r.remaining ?? "?"}`,
            );
            if (lines.info) console.log(lines.info);
            for (const e of lines.errors) console.error(e);
          })
          .catch((err) =>
            console.error(
              "[recording-stats-sweep] sweep failed:",
              err instanceof Error ? (err.stack ?? err.message) : err,
            ),
          ),
      );
      // Epic #1144 Phase 2b (#1153): backfill the BIDS signal defaults
      // (sampling/power-line frequency, reference, placement scheme) that
      // getBidsTreeStats reads from a dataset's ROOT-level *_eeg.json, falling
      // back to a subject-level exemplar only when no root sidecar exists --
      // the subject file is an inheritance override, not the dataset default,
      // and getting that direction right is what Phase 2b was built around.
      //
      // Added in #1164, and the gap it closes is narrower than "nothing
      // populated these columns". Phase 2b also threaded them through
      // refreshDatasetMetadata (dataset-reindex.ts), which runs automatically
      // on every version-DOI mint and manifest-ready callback, so the VALUES
      // already had a producer. What had none was signal_defaults_at: the
      // reindex path deliberately leaves that stamp alone so a live reindex
      // does not make a row look already-swept, which means the sweep's own
      // candidate set never converged and any dataset that never publishes a
      // version was never probed at all. This block is what drains it.
      //
      // PROD-ONLY. The AGENTS.md default would be reason enough, but there is
      // a specific one: getBidsTreeStats calls ORG_NAME (github/shared.ts),
      // hardcoded to "nemarDatasets" and NOT environment-scoped, so a dev-side
      // run reads production dataset repos. That holds whichever credential
      // getDatasetsToken resolves -- do not restate it as "the shared GitHub
      // App", which the code treats as conditional (App when configured,
      // GITHUB_ADMIN_PAT otherwise) and wrangler-sccn.toml still lists as in
      // soak. The shared org is the load-bearing fact; the credential is not.
      //
      // The recording-stats block above has no equivalent exposure: it touches
      // only S3 and D1, both environment-scoped.
      //
      // Bounded tighter than that sibling (15 per run, hard max 30, against
      // its 200) because each candidate costs a root tree, up to 25 subject
      // subtrees and a few blob fetches rather than one signed S3 GET.
      //
      // Called via the Cron wrapper (#1166): the exported sweep itself is left
      // unguarded because the admin backfill route calls it directly and needs
      // it to keep working on staging, so the fence lives in
      // runSignalDefaultsSweepCron instead. Kept inside this block too, belt
      // and braces, exactly like archiveRetrySweep's own internal guard.
      ctx.waitUntil(
        runSignalDefaultsSweepCron(env)
          .then((r) => {
            // A null result means the wrapper's guard skipped the run and
            // already logged it; sweepLogLines owns that decision so it can be
            // tested without invoking scheduled(). See #1167 review.
            const lines = sweepLogLines(
              "signal-defaults-sweep",
              r,
              (r) =>
                `[signal-defaults-sweep] processed=${r.processed} populated=${r.populated} noData=${r.noData} errors=${r.errors.length} remaining=${r.remaining ?? "?"}`,
            );
            if (lines.info) console.log(lines.info);
            for (const e of lines.errors) console.error(e);
          })
          .catch((err) =>
            console.error(
              "[signal-defaults-sweep] sweep failed:",
              err instanceof Error ? (err.stack ?? err.message) : err,
            ),
          ),
      );

      // #1409 (epic #1406): re-check every anonymous deposit against the leak
      // inventory. PRODUCTION-ONLY, and the reason is the rule stated at the
      // top of this block rather than a judgment call: it mints a GitHub App
      // token to read PRIVATE dataset repositories in the shared
      // `nemarDatasets` org, and it emails a real depositor when it finds
      // something. Either one on its own disqualifies it from
      // DEV_CRON_ALLOWLIST. The sweep function itself is unguarded so the
      // admin route still works on staging; runAnonymitySweepCron carries the
      // fence, same split as runSignalDefaultsSweepCron above.
      ctx.waitUntil(
        runAnonymitySweepCron(env)
          .then((r) => {
            const lines = sweepLogLines(
              "anonymity-sweep",
              r,
              (r) =>
                `[anonymity-sweep] processed=${r.processed} verified=${r.verified} findings=${r.with_findings} unverifiable=${r.unverifiable} errors=${r.errors.length} remaining=${r.remaining ?? "?"}`,
            );
            // Findings are logged at error level even though the sweep
            // succeeded: the run is fine and the dataset is not, and a line
            // that reads as routine is one nobody looks at.
            if (lines.info) console.log(lines.info);
            for (const e of lines.errors) console.error(e);
            for (const d of r?.results ?? []) {
              if (d.status === "findings") {
                console.error(
                  `[anonymity-sweep] ${d.dataset_id}: ${d.findings.length} finding(s) -- ${d.findings.map((f) => f.check).join(", ")}`,
                );
              }
            }
          })
          .catch((err) =>
            console.error(
              "[anonymity-sweep] sweep failed:",
              err instanceof Error ? (err.stack ?? err.message) : err,
            ),
          ),
      );

      // Epic #1586 phase 4 (ADR 0084): the Neurobagel artifact reconcile, the safety net
      // behind the publication and import hooks. PRODUCTION-ONLY, and deliberately NOT
      // in DEV_CRON_ALLOWLIST: a new daily job is production-only by default, and this
      // one reads dataset repositories through the shared nemarDatasets org. It does
      // nothing at all unless NEUROBAGEL_WRITER_ENABLED is "1", examines at most
      // NEUROBAGEL_RECONCILE_MAX datasets per tick (default 10) in a deterministic
      // order, and shares this tick's subrequest budget with every job around it
      // (ADR 0054), which is why the bound is small. The cron wrapper carries the fence
      // so the admin route, which calls the writer directly, still works on staging.
      ctx.waitUntil(
        runNeurobagelReconcileCron(env, (work) => ctx.waitUntil(work))
          .then((r) => {
            if (!r) return;
            const wrote = r.results.filter((d) => d.outcome === "written").length;
            const refused = r.results.filter((d) => d.outcome === "refused").length;
            const errors = r.results.filter((d) => d.outcome === "error").length;
            const line =
              `[neurobagel] reconcile status=${r.status} eligible=${r.eligible ?? "?"} ` +
              `examined=${r.examined} written=${wrote} refused=${refused} errors=${errors} ` +
              `removed=${r.removed.length} unexamined=${r.unexamined} ` +
              `index_written=${r.index.written} needs_review=${r.needs_review.length}`;
            // `disabled` is the default and is routine. A misconfiguration, a failed run,
            // an error on any dataset, or an anonymity-class finding is not: those are
            // logged where someone reading the logs will see them.
            const routine =
              (r.status === "ok" || r.status === "disabled") &&
              errors === 0 &&
              r.anonymity_findings === 0 &&
              !r.index.contended;
            if (routine) console.log(line);
            else
              console.error(
                `${line} anonymity_findings=${r.anonymity_findings} error=${r.error ?? ""}`,
              );
          })
          .catch((err) =>
            console.error(
              "[neurobagel] reconcile failed:",
              err instanceof Error ? (err.stack ?? err.message) : err,
            ),
          ),
      );

      // Epic #1586 phase 6 (ADR 0067's amendment): the Neurobagel verification sweep. It
      // REPORTS and never repairs: the store against the predicate, the node, registration
      // with the public federation, and upstream drift. PRODUCTION-ONLY, and deliberately NOT
      // in DEV_CRON_ALLOWLIST: a new daily job is production-only by default. It sends no
      // mail and dispatches nothing (a source scan holds it to that), so the fence is the
      // default and not a necessity; the cron wrapper carries it so the admin route, which
      // calls the sweep directly, still works on staging. It writes its heartbeat on every
      // run, even one that throws, and costs about ten outbound requests plus the store's
      // listing pages, which is why it shares this tick (ADR 0054) rather than adding one.
      ctx.waitUntil(
        runNeurobagelVerificationSweepCron(env)
          .then((r) => {
            if (!r) return;
            const line = verificationLogLine(r);
            // Healthy, or nothing here to check, is routine; an alarm, an unknown or a sweep that
            // failed is logged where someone reading the logs will see it.
            if (r.overall === "healthy" || r.overall === "unchecked") console.log(line);
            else console.error(line);
          })
          .catch((err) =>
            console.error(
              "[neurobagel] verification failed:",
              err instanceof Error ? (err.stack ?? err.message) : err,
            ),
          ),
      );
    }
    // #804: refresh per-dataset citation counts from the citations dashboard
    // manifest so GET /datasets?sort=citations and the listing pills reflect the
    // latest pipeline run. Best-effort; a dashboard outage just skips this tick.
    ctx.waitUntil(
      fetchAndSyncCitationCounts(env.DB)
        .then((r) =>
          console.log(
            `[citation-sync] fetched ${r.fetched}, updated ${r.updated}, skipped ${r.skipped}`,
          ),
        )
        .catch((err) =>
          console.error(
            "[citation-sync] failed:",
            err instanceof Error ? (err.stack ?? err.message) : err,
          ),
        ),
    );
    // ADR 0077: refresh each dataset's judge-confirmed data papers from the
    // citations dashboard's second manifest, so metadata.json serves
    // `data_papers`. A separate waitUntil with its own .catch: a failure here
    // must never block the counts sync above or the jobs below, and the reverse.
    // ALLOWED ON THE NON-PROD CRON (see DEV_CRON_ALLOWLIST): it reads a public
    // manifest and writes only this env's own D1.
    ctx.waitUntil(
      fetchAndSyncDataPapers(env)
        .then((r) =>
          console.log(
            `[data-papers-sync] fetched ${r.fetched}, rejected ${r.rejected}, cleared ${r.cleared}, updated ${r.updated}, unchanged ${r.unchanged}, unknown ${r.unknown}, failed chunks ${r.failedChunks}`,
          ),
        )
        .catch((err) =>
          console.error(
            "[data-papers-sync] failed:",
            err instanceof Error ? (err.stack ?? err.message) : err,
          ),
        ),
    );
    // #1062 (epic #1181 phase 2): republish the top-level Zarr discovery
    // catalog (zarr-catalog.json), after the sweeps above. ALLOWED ON THE
    // NON-PROD CRON -- listed in DEV_CRON_ALLOWLIST above: it only reads
    // this env's own D1 and writes this env's own S3 bucket (env.S3_BUCKET)
    // -- no email, no GitHub dispatch against the shared nemarDatasets org,
    // no DOI mutation -- so a dev-worker run can never touch the production
    // catalog object or a real user/repo.
    ctx.waitUntil(
      publishZarrCatalog(env)
        .then((r) => console.log(`[zarr-catalog] published count=${r.count} bytes=${r.bytes}`))
        .catch((err) =>
          console.error(
            "[zarr-catalog] publish failed:",
            err instanceof Error ? (err.stack ?? err.message) : err,
          ),
        ),
    );
    // Issue #1068 (epic #1181 phase 8): the standing Zarr fidelity
    // verification sweep. ALLOWED ON THE NON-PROD CRON -- listed in
    // DEV_CRON_ALLOWLIST above: it only reads this env's own S3 bucket plus
    // the public, credential-free raw.githubusercontent.com content host,
    // and writes only this env's own D1 -- no email, no GitHub App/PAT
    // dispatch against the shared nemarDatasets org, no DOI mutation.
    ctx.waitUntil(
      runZarrFidelitySweep(env)
        .then((r) => {
          const failedIds = r.results
            .filter((d) => d.verdict === "failed")
            .map((d) => d.dataset_id);
          console.log(
            `[zarr-fidelity-sweep] processed=${r.processed} verified=${r.verified} failed=${r.failed} unverifiable=${r.unverifiable} errors=${r.errors.length} remaining=${r.remaining ?? "?"}${failedIds.length > 0 ? ` failedDatasets=${failedIds.join(",")}` : ""}`,
          );
          for (const e of r.errors) {
            console.error(`[zarr-fidelity-sweep] ${e.dataset_id}: ${e.error}`);
          }
        })
        .catch((err) =>
          console.error(
            "[zarr-fidelity-sweep] sweep failed:",
            err instanceof Error ? (err.stack ?? err.message) : err,
          ),
        ),
    );
  },
};
