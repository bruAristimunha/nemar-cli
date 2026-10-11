import type { WebSessionUser } from "../services/web-session";
import type { MaintenanceMode } from "./maintenance";

/**
 * Cloudflare Workers environment bindings
 */
export interface Bindings {
  // D1 Database
  DB: D1Database;

  // Workers AI and Vectorize (for semantic dataset search)
  // Optional: deploy succeeds without index; runtime checks before use
  AI?: Ai;
  VECTORIZE?: VectorizeIndex;

  // Analytics Engine: write-only data-plane access counters (epic #695).
  // One data point per served archive download / zarr read; read by the
  // observability dashboard via the AE SQL API. Optional: recordAccess()
  // no-ops when the binding is absent (dev/test, or before provisioning).
  ANALYTICS?: AnalyticsEngineDataset;

  // LLM enrichment spend metering (nemar_llm_metrics). One data point per
  // enrichment run; the observability dashboard reads it per hour/day via
  // the AE SQL API. Optional: recordLlmUsage() no-ops when absent.
  ANALYTICS_LLM?: AnalyticsEngineDataset;

  // MCP server per-tool-call metrics (nemar_mcp_metrics, epic #1065 phase 2).
  // One data point per tools/call (success or error); a dedicated dataset
  // rather than ANALYTICS so blob positions never collide with
  // buildAccessDataPoint's. Optional: recordMcpToolCall() no-ops when absent.
  ANALYTICS_MCP?: AnalyticsEngineDataset;

  // News post images (#1551): R2 bucket holding `news/<sha256>.<ext>`,
  // written by POST /admin/news/media and read by GET /news/media/:file.
  // `nemar-news-media` in production, `nemar-news-media-dev` in [env.dev].
  NEWS_MEDIA: R2Bucket;

  // Neurobagel artifact store (epic #1586 phase 4, ADR 0084): a PRIVATE R2 bucket
  // holding each eligible dataset's JSON-LD artifacts and one `index.json`, written
  // only by services/neurobagel-writer.ts and read by the node's loader through
  // GET /neurobagel/*. `nemar-neurobagel` in production, `nemar-neurobagel-dev` in
  // [env.dev]. Optional: with no binding the writer is a reported no-op
  // (`store_unconfigured`) and the read route answers 404.
  NEUROBAGEL?: R2Bucket;
  /** The writer's switch. Anything other than exactly "1" (including unset) is OFF. */
  NEUROBAGEL_WRITER_ENABLED?: string;
  /** Datasets one reconcile tick examines. A positive integer; unset or bad means 10, and nothing is
   *  ever above the ceiling of 50 (ADR 0084). */
  NEUROBAGEL_RECONCILE_MAX?: string;
  /** Worker SECRET: the bearer the node's loader sends to GET /neurobagel/*. A deployment
   *  secret, not an account credential (ADR 0084); unset means the read route is off. */
  NEUROBAGEL_READ_TOKEN?: string;
  /** The private node's network address (epic #1586, phase 6). Optional: the verification
   *  sweep's node probe reports `unchecked`, never healthy, while it is unset. */
  NEUROBAGEL_NODE_URL?: string;
  /** The public federation's address (its node directory). Optional: the registration check
   *  reports `unchecked`, never healthy, while it is unset. */
  NEUROBAGEL_FEDERATION_URL?: string;

  // Environment variables
  ENVIRONMENT: "production" | "development" | "staging" | "test";
  API_BASE_URL: string;
  FRONTEND_URL: string;
  /** Authenticated app origin (e.g. https://app.nemar.org), no trailing slash.
   *  Distinct from FRONTEND_URL (the marketing apex): ORCID browser redirects
   *  and the session/pending cookies are scoped to the app host, so the OAuth
   *  redirect_uri and post-login landings must target this origin, not the
   *  apex. Defaults to https://app.nemar.org when unset. */
  APP_BASE_URL?: string;
  /** Base origin for DOI landing URLs (epic #923), no trailing slash, e.g.
   *  https://nemar.org. The DataCite _target resolves to `<base>/dataset/<id>`
   *  (the doi.org/<doi> link the CLI prints redirects here). Defaults to
   *  FRONTEND_URL, then https://nemar.org, so prod is unchanged (FRONTEND_URL is
   *  the apex); staging points landings at the -test website. See
   *  resolveDatasetLandingBase() in services/environment.ts. */
  DATASET_LANDING_BASE_URL?: string;
  AWS_REGION: string;
  S3_BUCKET: string;
  /** Hostname that dispatches to the data sub-app / zarr gateway (epic #923).
   *  Default to the prod literals (data.nemar.org / zarr.nemar.org) when unset,
   *  so prod behavior is unchanged; staging sets data-test / zarr-test.nemar.org
   *  so the one dev worker answers on the -test hosts. See index.ts host fork. */
  DATA_HOSTNAME?: string;
  ZARR_HOSTNAME?: string;
  /** Hostname that dispatches to the MCP server sub-app (epic #1065 phase 2).
   *  Defaults to the prod literal (mcp.nemar.org) when unset, so prod behavior
   *  is unchanged; staging sets mcp-test.nemar.org so the one dev worker
   *  answers on the -test host. See index.ts host fork and routes/mcp.ts. */
  MCP_HOSTNAME?: string;
  /** Base origin for data-plane bytes_url links embedded in served manifests
   *  (epic #923), no trailing slash. Defaults to https://data.nemar.org so prod
   *  output is byte-identical; staging sets https://data-test.nemar.org so
   *  dev-bucket-only datasets embed reachable links. Feeds buildBytesUrl() via
   *  resolveDataBaseOrigin() in services/environment.ts. */
  DATA_BASE_URL?: string;
  /** Undefined is treated as "off". See backend/src/types/maintenance.ts. */
  MAINTENANCE_MODE?: MaintenanceMode;
  /** Sender for outbound Resend emails, e.g. "NEMAR Archive <noreply@nemar.org>".
   *  Falls back to DEFAULT_FROM_EMAIL in email.ts if unset/empty.
   *  The domain must be verified in the Resend account tied to RESEND_API_KEY,
   *  otherwise Resend rejects the send (caught and logged per-site). */
  FROM_EMAIL?: string;
  /** Reply-To address (e.g. "info@nemar.org") when FROM is a no-reply mailbox.
   *  Omitted when unset/empty. */
  REPLY_TO?: string;
  /** Delivery allow-list for non-production workers (issue #957): comma-
   *  separated exact addresses and/or `@domain` suffixes. Dev D1 is not
   *  purged of the `users` table (roughly 609 real emails, see AGENTS.md)
   *  and the dev worker holds a live RESEND_API_KEY, so every send in a
   *  non-production ENVIRONMENT is refused unless the recipient matches an
   *  entry here (services/email.ts's sendEmail / services/broadcast.ts's
   *  sendBroadcast). Unset means nothing is allow-listed -- every
   *  non-production send is refused, fail-closed. Ignored in production. */
  DEV_EMAIL_ALLOWLIST?: string;
  /** Opt-in escape hatch so a non-production worker can generate admin-facing
   *  notification mail (new-user approval, publication requests, import
   *  recovery, cron digests): set to exactly "1" for a deliberate staging
   *  test. Unset/anything else keeps getAdminEmailsForCategory's fence
   *  closed (services/email.ts). Distinct from DEV_EMAIL_ALLOWLIST above:
   *  that fence gates WHO a send can reach, this one gates WHETHER an
   *  admin-notification send is generated at all -- the dev worker's own
   *  admin account is on DEV_EMAIL_ALLOWLIST, so the recipient fence alone
   *  does not stop admin mail from reaching them. */
  DEV_ADMIN_NOTIFICATIONS?: string;
  /** Domain attribute for the web-dashboard session cookie (#569).
   *  Set to "app.nemar.org" in production and left empty in dev so
   *  the cookie is host-only for *.workers.dev. The dashboard moves
   *  to app.nemar.org per nemarOrg/website#46; flip this env var at
   *  cutover without redeploying code. */
  WEB_SESSION_COOKIE_DOMAIN?: string;
  /** Sandbox (xx) dataset-ID allocation partition, decimal strings (epic #923).
   *  Prevents repo-name collisions in the shared nemarDatasets org between
   *  prod- and dev/test-created sandbox datasets. Prod sets CEILING="89999"
   *  (allocates xx000001-xx089999); dev/test sets FLOOR="90001" (allocates
   *  xx090001-xx099899). Both optional and clamped to [start, RESERVED_FIXTURE_FLOOR-1]
   *  = [start, 99899] for xx, so an absent or bad value only widens/narrows
   *  within the valid id range. The ceiling is 99899 rather than 99999 because
   *  the top 100 ids are the reserved fixture band (ADR 0068); see
   *  RESERVED_FIXTURE_FLOOR in services/datasetId.ts. */
  SANDBOX_ID_FLOOR?: string;
  SANDBOX_ID_CEILING?: string;

  // Secrets
  GITHUB_ADMIN_PAT: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  RESEND_API_KEY: string;
  ZENODO_API_KEY: string;
  ZENODO_SANDBOX_API_KEY?: string; // Optional - for sandbox testing
  EZID_USERNAME: string; // EZID DOI service credentials (production)
  EZID_PASSWORD: string;
  EZID_SANDBOX_USERNAME?: string; // EZID test account (for --sandbox)
  EZID_SANDBOX_PASSWORD?: string;
  GITHUB_WEBHOOK_SECRET?: string; // HMAC secret for /webhooks/github signature verification (GitHub App push deliveries)
  NEMAR_WEBHOOK_TOKEN?: string; // Bearer token for /publish-version-doi and /llm-enrich (X-Webhook-Token header from dataset workflows)
  /** Prod-only mirror target for dev-OWNED GitHub deliveries (epic #923;
   *  widened from dev-range to dev-owned by #1440, so it now also carries the
   *  reserved `nm` fixtures). When set on the PRODUCTION worker, a push to a
   *  repo the dev worker owns is re-posted verbatim (raw body + original HMAC
   *  signature/event/delivery headers) to the dev worker's /webhooks/github
   *  here, so the dev worker dispatches enrichment for staging datasets.
   *  Enrichment specifically: zarr is not dispatched from the webhook at all
   *  (#1109) and the version-DOI path has its own anonymity guard (#1408).
   *  Outbound-only and fire-and-forget: unset means no-op; a dev outage never
   *  affects prod. */
  DEV_WEBHOOK_MIRROR_URL?: string;
  TEST_BYPASS_TOKEN?: string; // Optional - for CI/CD rate limit bypass
  ENCRYPTION_KEY?: string; // For encrypting stored credentials
  // LLM enrichment via Claude Platform on AWS (Anthropic-operated, AWS-billed;
  // NOT Bedrock). All three required; requests without the workspace header
  // are rejected by the endpoint.
  ANTHROPIC_API_KEY?: string; // Long-lived key (secret)
  ANTHROPIC_BASE_URL?: string; // https://aws-external-anthropic.<region>.api.aws
  ANTHROPIC_WORKSPACE_ID?: string; // wrkspc_... the key is authorized on

  // ORCID SSO (#832). Confidential OAuth client; login works on the free
  // Public API tier (no Member API needed). All optional: when CLIENT_ID /
  // CLIENT_SECRET are unset the /auth/orcid/* routes degrade to a clear
  // "unavailable" redirect instead of erroring.
  ORCID_CLIENT_ID?: string;
  ORCID_CLIENT_SECRET?: string;
  // Base host for ORCID OAuth, no trailing slash. Defaults to
  // https://orcid.org in production and https://sandbox.orcid.org elsewhere.
  ORCID_API_BASE?: string;
  /** Raw content host for the git-file broker. Unset in production, where
   *  `GITHUB_RAW_ORIGIN` applies; tests point it at a local server. */
  GITHUB_RAW_BASE?: string;
  /** Size below which a brokered git file is buffered so the runtime can
   *  declare its length. Unset everywhere but tests, which lower it to reach
   *  the streaming branch without a multi-megabyte fixture. */
  BROKER_BUFFER_MAX_BYTES?: string;
  /** S3 origin override. Unset in production; tests point reads at a local
   *  server so a route can be driven end to end without mocking `fetch`. */
  S3_ENDPOINT_URL?: string;
  // Base host for the ORCID PUBLIC record API (personal-details reads), no
  // trailing slash. Normally derived from ORCID_API_BASE
  // (pub.orcid.org / pub.sandbox.orcid.org); set explicitly only to point the
  // reads at a mirror, or at a local server in tests (#1255).
  ORCID_PUB_API_BASE?: string;

  // GitHub App credentials. Optional during the migration (#432); the
  // Worker falls back to GITHUB_ADMIN_PAT when any of these are unset.
  // Phase 5 will drop the PAT and make these required.
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string; // PKCS#8 PEM
  GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS?: string;
  GITHUB_APP_INSTALLATION_ID_NEMAR_ORG?: string;

  // Central manifest workflow (#557, relocated to nemarDatasets/.github
  // in #564). When MANIFEST_VIA_CENTRAL_WORKFLOW is "true",
  // publish-version-doi dispatches a repository_dispatch event at
  // nemarDatasets/.github instead of running generateManifest() inline.
  // The workflow uploads manifest.json + summary.json to S3 and POSTs
  // back to /webhooks/manifest-ready with an HMAC-signed callback token.
  // Default ("false" or unset) keeps the existing in-Worker path. Flip
  // per-environment for staged rollout.
  MANIFEST_VIA_CENTRAL_WORKFLOW?: string; // "true" enables central workflow path
  MANIFEST_CALLBACK_SECRET?: string; // Workers secret; HMAC key for callback token

  // Automatic OpenNeuro import (#775). When "true" the cron tick discovers new
  // OpenNeuro datasets and imports+publishes one per gate window; OFF/unset = the
  // tick no-ops. Prod-only (dev has no cron triggers).
  AUTO_IMPORT_ENABLED?: string;
  // Dispatch pacing macro (minutes between auto-imports). Tunable live so the
  // pace can be retuned/throttled without a deploy; unset/invalid -> code default
  // (25 min -> ~30-min cadence on the 30-min cron tick).
  AUTO_IMPORT_MIN_INTERVAL_MIN?: string;

  // Publication pre-screen (issue #666). When PRESCREEN_ENABLED is "true",
  // a publication request that passes BIDS readiness dispatches
  // repository_dispatch[run-prescreen] at nemarDatasets/.github, which runs
  // `claude -p` and POSTs a verdict to /webhooks/prescreen-result with an
  // HMAC-signed token. Default (unset/"false") keeps the request flow
  // unchanged so a deploy does not silently enable screening.
  PRESCREEN_ENABLED?: string; // "true" enables the dispatch on publish request
  PRESCREEN_CALLBACK_SECRET?: string; // Workers secret; HMAC key for prescreen callback

  // Dataset pull-request review (ADR 0092). When PR_REVIEW_ENABLED is "1", a pull request opened
  // or updated against `main` of a dataset repository is reviewed by a model and the result is
  // published as a check-run and a pull-request comment. Default (unset) keeps the webhook
  // ignoring pull_request events, so a deploy never starts spending money or posting on
  // pull requests by itself. The callback token reuses PRESCREEN_CALLBACK_SECRET under its own
  // domain tag. Set on the PRODUCTION Worker only unless a staging test is deliberate: the dev
  // Worker answers only for repositories it owns (see the ownership fence in the webhook).
  PR_REVIEW_ENABLED?: string; // "1" enables the review

  // Import recovery (issue #754). onboard-openneuro.yml POSTs import state to
  // /webhooks/import-state (bearer NEMAR_WEBHOOK_TOKEN). On a terminal failure
  // an unambiguous orphan (private, no DOI, no versions, never completed) is
  // QUARANTINED + admins alerted by default; set IMPORT_AUTO_ROLLBACK="true" to
  // instead auto-delete it via deleteDatasetCascade. Default (unset/"false")
  // keeps deletion a human action, mirroring the #663 stale-cron remediation.
  IMPORT_AUTO_ROLLBACK?: string; // "true" enables auto-rollback of orphaned imports

  // Import retry engine + blocklist (epic #967 Phase 2, issue #969). A
  // prod-only daily sweep re-dispatches onboard-openneuro.yml for
  // incomplete/failed/quarantined imports; a dataset whose OpenNeuro source
  // stays inaccessible past the retry window is parked on a blocklist and,
  // once, reported to an OpenNeuro maintainer. OPENNEURO_SUPPORT_EMAIL is the
  // report recipient. The actual send is gated by
  // OPENNEURO_MAINTAINER_EMAIL_ENABLED="true" (default unset -> dry run:
  // compute + audit-log, no send) so external mail never fires silently on
  // deploy; the operator flips it after reviewing the first batch.
  OPENNEURO_SUPPORT_EMAIL?: string;
  OPENNEURO_MAINTAINER_EMAIL_ENABLED?: string;

  // Zarr serving copy (epic #684). The conversion runs on the SDSC Hallu cron
  // (scripts/zarr/hallu-zarr.sh in this repo) and POSTs back to
  // /webhooks/zarr-ready (authenticated with NEMAR_WEBHOOK_TOKEN). The browser
  // viewer reads the per-recording Zarr stores through a Cloudflare-cached host
  // fronting the public S3 zarr prefix; the callback purges the small shared
  // objects (index.json, a store's zarr.json) on re-conversion. All optional:
  // unset => the trigger/callback still work, the purge degrades to TTL-only.
  ZARR_CACHE_BASE_URL?: string; // e.g. "https://zarr.nemar.org" (cache host, no trailing slash needed)
  CLOUDFLARE_API_TOKEN?: string; // Workers secret; scoped token with Zone.Cache Purge on the SCCN zone
  CLOUDFLARE_ZONE_ID?: string; // SCCN zone id for the cache host
}

/** User roles in hierarchical order: owner > admin > member */
export type UserRole = "owner" | "admin" | "member";

export const ROLE_HIERARCHY: Readonly<Record<UserRole, number>> = Object.freeze({
  owner: 3,
  admin: 2,
  member: 1,
});

/** Check if userRole meets or exceeds the minimum required role */
export function hasRole(userRole: UserRole, minimumRole: UserRole): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[minimumRole];
}

/** Check if changing from oldRole to newRole is a demotion */
export function isDemotion(oldRole: UserRole, newRole: UserRole): boolean {
  return ROLE_HIERARCHY[newRole] < ROLE_HIERARCHY[oldRole];
}

/** Validate that a string is a valid UserRole */
export function isValidRole(value: string): value is UserRole {
  return value === "owner" || value === "admin" || value === "member";
}

/**
 * Validate and coerce a DB role value to UserRole.
 * Logs a warning if null (migration not applied), rejects invalid values.
 */
export function parseRole(value: string | null | undefined, username?: string): UserRole | null {
  if (value === null || value === undefined) {
    console.warn(
      `User ${username ?? "unknown"} has null role -- migration 0009 may not be applied. Defaulting to "member".`,
    );
    return "member";
  }
  if (!isValidRole(value)) {
    console.error(`User ${username ?? "unknown"} has invalid role value: "${value}"`);
    return null;
  }
  return value;
}

/**
 * User object set by auth middleware
 */
export interface AuthUser {
  id: number;
  username: string;
  email: string;
  github_username: string;
  role: UserRole;
  orcid?: string;
}

/**
 * Extended Hono context variables
 */
export interface Variables {
  user: AuthUser;
  // Set by optionalAuthMiddleware when an Authorization: Bearer header was
  // provided but did not resolve to a valid, approved user. Lets routes that
  // require auth on a flag (e.g., /datasets?mine=true) emit a token-specific
  // 401 instead of the generic "Authentication required" reply, so CLIs can
  // tell "no header sent" from "header sent but token invalid/expired".
  // Optional: routes that don't use optionalAuthMiddleware never set this.
  authAttempted?: true;
  /** Set by `authMiddleware`: which credential resolved `user`.
   *  "token" = Authorization: Bearer (CLI path), "cookie" =
   *  `nemar_session` (web dashboard path). `cliVersionGuard` uses this
   *  to exempt browser clients, which fetch current site code on every
   *  page load and so cannot be version-stale the way an installed CLI
   *  binary can. */
  authMethod?: "token" | "cookie";
  /** Set by `webSessionMiddleware` (#569) when a valid `nemar_session`
   *  cookie resolves to an active row. Distinct from `user` (bearer
   *  API token auth) — a single request can carry both in principle,
   *  though in practice the dashboard never sends a bearer header.
   *  `role` is validated against the `UserRole` union at the DB
   *  boundary; `null` means the row's role column held an unknown
   *  value. Carries the nullable profile fields for /auth/me (#910). */
  webUser?: WebSessionUser;
  /** Internal: the matched web_sessions row. Used by `/auth/me` to
   *  decide whether to slide the expiry, and by `/auth/logout` to
   *  revoke the row. */
  webSession?: {
    id: number;
    user_id: number;
    remember: boolean;
    expires_at: string;
    last_used_at: string;
  };
  /** The raw cookie value as it arrived on the wire (the
   *  base64url-encoded 256-bit token, before hashing). Routes that
   *  need to write a fresh Set-Cookie use this when sliding the
   *  expiry — the value itself is unchanged. */
  webSessionCookieId?: string;
}
