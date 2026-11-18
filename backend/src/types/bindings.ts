import type { RunnerPrincipal } from "../services/compute-runners";
import type { CloudflareSendEmail } from "../services/email";
import type { ClaimAccount } from "../services/oidc-claims";
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
  // "1" narrows vector queries by their `visibility`/`dataset_id` metadata AND
  // makes the embed drain / reindex-all embed non-public datasets. Turn it on
  // ONLY after (1) the `visibility` and `dataset_id` Vectorize metadata indexes
  // exist and (2) reindex-all has relabeled the public vectors: a filter on an
  // unindexed property matches nothing (search then retries unfiltered, with a
  // warning), and unlabeled vectors would drop out of every filtered query.
  // Unset: queries are unfiltered, only public datasets are embedded, and the
  // live D1 check alone decides.
  VECTORIZE_VISIBILITY_FILTER?: string;

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

  // Compute gateway storage (epic #2005 phase A3, ADR 0118 decision 7): two PRIVATE R2 buckets,
  // reached by the Worker through these bindings and, for the few things a binding cannot do (a
  // presigned PUT for one file of one job, a presigned GET, a server-side copy), through R2's S3
  // interface (services/compute-s3.ts). `nemar-compute-records` and `nemar-compute-results` in
  // production, `...-dev` in [env.dev]. The records bucket is locked by prefix and the results bucket
  // expires its objects: both are bucket configuration, never code. Optional: with no binding a job
  // cannot be made (`compute_disabled`).
  COMPUTE_RECORDS?: R2Bucket;
  COMPUTE_RESULTS?: R2Bucket;
  /** The two buckets' names, which a binding hides and the S3 interface needs. Plain variables, set in
   *  [vars] and in [env.dev.vars] both (variables do not inherit). */
  COMPUTE_RECORDS_BUCKET_NAME?: string;
  COMPUTE_RESULTS_BUCKET_NAME?: string;
  /** The derivative store's PRIVATE R2 bucket (portable compute, card V1b; ADR 0123 decision 1), reached
   *  only by this binding and by a server-side copy, never by an address anyone is given. Bound in both
   *  tables of `wrangler-sccn.toml` (`nemar-compute-derivatives` in production,
   *  `nemar-compute-derivatives-dev` in `[env.dev]`) and still optional: with either this binding or its
   *  name absent every entry point of the store answers `derivatives_unavailable` and writes nothing. */
  COMPUTE_DERIVATIVES?: R2Bucket;
  COMPUTE_DERIVATIVES_BUCKET_NAME?: string;
  /** Worker SECRETS, set by the owner: one R2 API token per environment (Object Read & Write on its
   *  buckets) and the account endpoint, which is never written in this repository. */
  COMPUTE_R2_ACCESS_KEY_ID?: string;
  COMPUTE_R2_SECRET_ACCESS_KEY?: string;
  COMPUTE_R2_S3_ENDPOINT?: string;

  // The compute gateway's two dark switches (epic #2005 phase A4, ADR 0118 decision 8;
  // services/compute-switches.ts). Each reads as on only when it is exactly "1", and compute only in
  // exactly `production` or `development` (the dev Worker runs against its own Tapis tenant with its
  // own credentials; every compute schedule stays production-only). Deliberately absent from every
  // table of wrangler-sccn.toml, and compute-switches-flag.test.ts pins that: the owner turns them
  // on in a reviewed change that edits that test. A Worker secret of the same name takes effect too,
  // so `GET /admin/compute/status` is what says what the Worker reads.
  COMPUTE_ENABLED?: string; // "1" lets compute run (production or development only)
  COMPUTE_PIPELINES_DISPATCH_ENABLED?: string; // "1" lets NEMAR's own pipelines dispatch (needs COMPUTE_ENABLED)
  // The portable-compute switch (card DM-05, D7): "1" lets a registered runner exchange its secret and
  // use its access token. Needs COMPUTE_ENABLED too, is absent from wrangler-sccn.toml like the other
  // two, and is pinned by the same test.
  COMPUTE_RUNNERS_ENABLED?: string;

  // The Tapis tenant the compute gateway submits to (epic #2005 phase A4, services/tapis/config.ts).
  // Worker secrets or owner-set variables, NEVER in wrangler-sccn.toml: a tenant name is not public.
  // Dev and production use SEPARATE tenants' credentials, because dev D1 shares real users and the
  // GitHub org. TAPIS_AUTH_STRATEGY picks how the Worker authenticates, with no code change:
  //   "password": the account TAPIS_USERNAME / TAPIS_PASSWORD signs in with the password grant;
  //   "service": TAPIS_SERVICE_TOKEN (a Tokens API service credential) mints a user token per
  //              username, and TAPIS_USERNAME is then optional (the user `status` probes with).
  TAPIS_BASE_URL?: string; // the tenant's base address, https, no path needed
  TAPIS_TENANT_ID?: string;
  TAPIS_AUTH_STRATEGY?: string; // "password" | "service"; anything else is unconfigured
  TAPIS_USERNAME?: string;
  TAPIS_PASSWORD?: string;
  TAPIS_SERVICE_TOKEN?: string;
  /** The key of the ACCESS gateway-attributes API (reporting every tenant job under a pseudonym).
   *  Owner-set Worker secret, absent from wrangler-sccn.toml (compute-switches-flag.test.ts pins that).
   *  `runAccessReportCron` (services/access-attributes.ts) sends it in a header and never logs or stores
   *  it; `GET /admin/compute/status` reports only whether it is set. Unset, reports wait `unconfigured`. */
  ACCESS_GATEWAY_ATTRIBUTES_KEY?: string;
  /** The name ACCESS knows the cluster by in the gateway-attributes interface (the design's question 14),
   *  an owner-set Worker secret like the key and pinned absent from wrangler-sccn.toml the same way. */
  ACCESS_RESOURCE_NAME?: string;
  /** NEMAR's own runtime image for a `python` job (epic #2005 phase A5, services/compute-lifecycle.ts):
   *  a digest-pinned reference, `[docker://]registry/path@sha256:<64 hex>`. Owner-set, like the Tapis
   *  names, and absent from wrangler-sccn.toml (compute-switches-flag.test.ts pins that). Unset, a
   *  `python` job stays `created` and is submitted once it is set; an `image` job brings its own. */
  COMPUTE_RUNTIME_IMAGE?: string;

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
  /** Sender for outbound emails, e.g. "NEMAR Archive <noreply@nemar.org>".
   *  Falls back to DEFAULT_FROM_EMAIL in email.ts if unset/empty.
   *  The domain must be verified with the provider the worker sends through
   *  (the Resend account tied to RESEND_API_KEY, or the Cloudflare Email
   *  Service for EMAIL_PROVIDER=cloudflare), otherwise the send is rejected
   *  (caught and logged per-site). */
  FROM_EMAIL?: string;
  /** Days a support ticket's raw record is kept before the retention purge (epic #1893 phase 6a,
   *  ADR 0112): 730 in production, 30 on staging. A whole number from 1 to 36500; unset, empty or
   *  anything else means the purge deletes nothing (services/ticket-retention.ts). */
  MAIL_RETENTION_DAYS?: string;
  /** Inbound messages one sender address may send per hour before further ones are filed quietly
   *  as `rate_limited` (ADR 0113). A whole number from 1 to 100000; unset or invalid means 20. */
  MAIL_SENDER_HOURLY_CAP?: string;
  /** Which provider sends mail (epic #1893, ADR 0110): "cloudflare"
   *  (case-insensitive) sends through the EMAIL binding; unset, empty or
   *  "resend" is Resend. Set only in [env.dev] while staging proves the move.
   *  Any other value, and "cloudflare" with no EMAIL binding, is a
   *  configuration error, never a silent fallback to Resend
   *  (services/email.ts resolveEmailProvider). */
  EMAIL_PROVIDER?: string;
  /** "resend" lets a send that Cloudflare refused for a quota or account
   *  reason (services/email.ts RESEND_FALLBACK_CODES) go out once through
   *  Resend. Unset or anything else: no fallback. Never set in [env.dev], so
   *  staging cannot reach Resend. Also needs a non-blank RESEND_API_KEY. */
  EMAIL_FALLBACK?: string;
  /** Cloudflare Email Service `send_email` binding. In [env.dev] it is
   *  restricted to the staging sender addresses, so the dev worker cannot
   *  send as nemar.org. Optional: absent on every other worker. */
  EMAIL?: CloudflareSendEmail;
  /** Inbound mail bucket (epic #1893 phase 1): raw messages from Email Routing,
   *  stored at `inbound/raw/YYYY/MM/DD/<uuid>.eml` by services/inbound-mail.ts.
   *  `nemar-mail-dev` in [env.dev] and `nemar-mail` in production (inert until
   *  a routing rule targets the Worker, phase 6); a Worker with no bucket rejects
   *  the message. */
  MAIL_INBOUND?: R2Bucket;
  /** Announcement outbox queue (epic #1893 phase 2): `nemar-email-outbox` in production,
   *  `nemar-email-outbox-dev` in [env.dev]. Optional: with no binding `nemar admin notify`
   *  sends inline as before. Consumed by `queue()` in index.ts. */
  EMAIL_OUTBOX?: Queue;
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
  /** Domain attribute for the legacy web-dashboard session cookie (#569) and for the ORCID state
   *  and pending cookies.
   *  Set to "app.nemar.org" in production and left empty in dev so
   *  the cookie is host-only for *.workers.dev. The dashboard moves
   *  to app.nemar.org per nemarOrg/website#46; flip this env var at
   *  cutover without redeploying code.
   *
   *  Once `HOST_PREFIXED_SESSION_COOKIE` is on this no longer scopes the SESSION cookie: a
   *  `__Host-` cookie carries no `Domain`, and a browser refuses one that does. It still scopes
   *  the ORCID state and pending cookies and the clears of the legacy session cookie. */
  WEB_SESSION_COOKIE_DOMAIN?: string;
  /** "1" issues the app session cookie as `__Host-nemar_session` (host-only, no Domain) and
   *  clears the legacy `nemar_session`; anything else, or unset, keeps today's header byte for
   *  byte (ADR 0119 decision 10). READING accepts both names whatever this says. Set in
   *  `[env.dev.vars]` only: production turns it on after the website's reader and the API have
   *  both released, which is the owner's act, and a test pins that no other table names it.
   *
   *  Release notes. The flag is REVERSIBLE. Turned off again, a request that carries no
   *  `__Host-nemar_session` gets exactly today's headers, byte for byte; a request that carries one
   *  gets the same headers plus a clear of it, so the cookie issued while the flag was on is
   *  removed at the next sign-in, sign-out or slide. The clear matters because the reader prefers
   *  a `__Host-` cookie: without it, a person who signs out and in again after the flag is turned
   *  off would stay signed out until that cookie expires.
   *
   *  The OpenID Connect authorization routes (`/auth/oidc/*`) also answer 404 until this is "1"
   *  and `OIDC_SECRET` is set: set both. Only a `__Host-` session may approve a grant. */
  HOST_PREFIXED_SESSION_COOKIE?: string;
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
  /** Worker SECRET (never a var): the key the OpenID Connect provider's private signing keys are
   *  encrypted under at rest (epic #2014 phase #2016; ADR 0119). Must be `nmsso-` and a random
   *  body, 32 characters or more in all (`isOidcSecret`, `shared/oidc.ts`), or the provider is off: discovery, the key set and the owner routes then answer 404, as if they did
   *  not exist (`services/oidc-config.ts`, `oidcSecret` is the one reader). The owner sets it; an agent never does.
   *  Changing it makes every stored key unreadable, and there is no re-encryption path yet.
   *  The authorization routes (`/auth/oidc/*`) and the `/oauth` token, userinfo, revocation and
   *  introspection endpoints also answer 404 until `HOST_PREFIXED_SESSION_COOKIE` is "1": set both. */
  OIDC_SECRET?: string;
  /** A VAR, optional, and read only outside production (epic #2014 phase #2019; ADR 0119 rule 15):
   *  the comma-separated hostnames, exact and case-insensitive, that a dev or staging Worker may send
   *  a back-channel logout to besides a loopback address (`localhost`, `127.0.0.1`, `[::1]`). The dev
   *  Worker shares real accounts and a partner's registered address may be a real host, so by default
   *  a delivery to anything else is recorded `fenced` and never sent. The production Worker ignores it
   *  and sends to the https hosts the registry validated; it is absent from `wrangler-sccn.toml`, and
   *  setting it on a dev Worker is the owner's act, for a deliberate test against a partner's staging
   *  host. */
  OIDC_LOGOUT_DEV_HOSTS?: string;
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
  /** OpenNeuro GraphQL endpoint for the upstream staleness report. Unset in
   *  production; tests point it at a local server. Production ignores any value
   *  that is not a loopback `http` address (`snapshotGraphqlUrl`). */
  OPENNEURO_GRAPHQL_URL?: string;
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
  // unchanged so a deploy does not silently enable screening. With the publication review on
  // (PUBLICATION_REVIEW_ENABLED, below) it is not dispatched for a request the review covers.
  PRESCREEN_ENABLED?: string; // "true" enables the dispatch on publish request
  PRESCREEN_CALLBACK_SECRET?: string; // Workers secret; the ONE HMAC key for every callback token:
  // prescreen and pull-request review callbacks, and the compute gateway's job token (inside each
  // running job's launch spec), Tapis webhook address and observer token. Rotating it kills all of
  // them: drain running compute jobs first (compute-tokens.ts, ADR 0118 A5 amendment item 5).

  // Dataset pull-request review (ADR 0092). When PR_REVIEW_ENABLED is "1", a pull request opened
  // or updated against `main` of a dataset repository is reviewed by a model and the result is
  // published as a check-run and a pull-request comment. Default (unset) keeps the webhook
  // ignoring pull_request events, so a deploy never starts spending money or posting on
  // pull requests by itself. The callback token reuses PRESCREEN_CALLBACK_SECRET under its own
  // domain tag. Set on the PRODUCTION Worker only unless a staging test is deliberate: the dev
  // Worker answers only for repositories it owns (see the ownership fence in the webhook).
  //
  // Not a casual switch: once any repository carries the review ruleset (ADR 0107), an unset or 0
  // value leaves every pull request on that repository waiting for a check that nothing posts, so
  // the merges stop. The rulesets come off before the review does, in this order, and a removal is
  // allowed whatever the switches say: (a) while PR_REVIEW_AUTO_REQUIRE is still on, run
  // `nemar admin fleet require-review --all --remove --apply` and repeat it with `--after` set to
  // the last id of each page (it does ONE page, 25 datasets by default and 50 at most, and prints
  // `Next page:` instead of looping) until the output has no `Next page:` line; (b) dry run the
  // same pages and expect no row that would remove; (c) turn PR_REVIEW_AUTO_REQUIRE off through a
  // release, because the next deploy drops what was changed only in the dashboard; (d) repeat (a)
  // and (b) once more, for the datasets that changed in between. Only then switch the review off.
  PR_REVIEW_ENABLED?: string; // "1" enables the review

  // Automatic requirement of the pull-request review (ADR 0107). Only when this is exactly "1" (and
  // PR_REVIEW_ENABLED is too) do publishing, a visibility change and the enforce routes put the
  // review ruleset ON a repository; unset, they leave a reviewed dataset's ruleset as it is. It
  // gates the addition only: a dataset that is not reviewed has its ruleset taken off whatever
  // this says. The explicit tools (the review-ruleset routes and `nemar admin fleet
  // require-review`) do not read it. The owner turns it on when the fleet step of the rollout
  // starts, after the canary and the calibration gate; it is never on before. It is set in the
  // configuration file, but a Worker secret of the same name would also turn it on, survives a
  // deploy and does not show in the file, so the review-ruleset routes report what the Worker
  // reads as `auto_require`.
  PR_REVIEW_AUTO_REQUIRE?: string; // "1" lets the automatic paths put the review ruleset on

  // Publication review (ADR 0102). When PUBLICATION_REVIEW_ENABLED is exactly "1", a stored
  // identifier-screen result whose gate is clear or acknowledge starts a model review of the
  // screened commit, the claim route accepts new claims, the request's admin mail waits for the
  // review and gains its section, and the pre-screen of ADR 0014 is not dispatched for a request
  // the review covers. Any other value (unset included) starts nothing, refuses new claims and
  // leaves the mail and the pre-screen as they were; a result whose run was already claimed is
  // still stored, and the production watchdog still closes rows. The mechanical refusals do not
  // depend on it. The callback token reuses PRESCREEN_CALLBACK_SECRET under its own domain tag.
  // Set in [env.dev.vars] only; production turns it on by adding it to [vars] in a reviewed
  // change, once ADR 0102's "Before it is switched on" is done.
  PUBLICATION_REVIEW_ENABLED?: string; // "1" enables the review

  // Upstream re-pull merges a day (ADR 0111, decision 6). Every merge a NEMAR tool makes of a
  // re-pull pull request claims one unit first, N.0.0's and N.0.1's alike, in a fixed UTC day, and
  // a refused claim merges nothing, because every merge mints a DOI that cannot be withdrawn.
  // Absent: 5. "0" to "20": that many ("0" stops every merge). Anything else is unreadable and
  // reads 0, so a typo stops merging instead of falling back to the default.
  REPULL_DAILY_MERGE_CAP?: string;

  // The automatic upstream re-pull (ADR 0111; services/repull-switches.ts). Each switch reads as on
  // only when it is exactly "1" AND ENVIRONMENT is exactly "production"; unset, "true" and anything
  // else are off. AUTO_REPULL_MERGE_ENABLED acts only while AUTO_REPULL_ENABLED is also on.
  // Deliberately absent from every vars block in wrangler-sccn.toml: the owner turns them on in a
  // reviewed change, never in the dashboard or as a Worker secret. The Worker reads them from its
  // environment, so a secret of the same name would turn them on too, survive a deploy and not show
  // in the file; a dashboard-only variable is dropped by the next deploy.
  AUTO_REPULL_ENABLED?: string; // "1" lets the Worker open and advance re-pulls (production only)
  AUTO_REPULL_MERGE_ENABLED?: string; // "1" lets the Worker merge them (needs AUTO_REPULL_ENABLED)
  // Re-pull dispatches claimed to open a re-pull in a UTC day. Absent: 2. "0" to "20": that many.
  // Anything else is unreadable and reads 0 (the same rule as REPULL_DAILY_MERGE_CAP).
  REPULL_DAILY_OPEN_CAP?: string;

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
  /** Set by `runnerAccess` (routes/compute-runners.ts): the runner whose access token the request carried. */
  runner?: RunnerPrincipal;
  // Set by optionalAuthMiddleware when an Authorization: Bearer header was
  // provided but did not resolve to a valid, approved user. Lets routes that
  // require auth on a flag (e.g., /datasets?mine=true) emit a token-specific
  // 401 instead of the generic "Authentication required" reply, so CLIs can
  // tell "no header sent" from "header sent but token invalid/expired".
  // Optional: routes that don't use optionalAuthMiddleware never set this.
  authAttempted?: true;
  /** Set by `authMiddleware`: which credential resolved `user`.
   *  "token" = Authorization: Bearer (CLI path), "cookie" = the session
   *  cookie, `__Host-nemar_session` or the legacy `nemar_session` (web
   *  dashboard path). `cliVersionGuard` uses this
   *  to exempt browser clients, which fetch current site code on every
   *  page load and so cannot be version-stale the way an installed CLI
   *  binary can. */
  authMethod?: "token" | "cookie";
  /** Set by `webSessionMiddleware` (#569) when a valid session cookie
   *  (`__Host-nemar_session` or the legacy `nemar_session`) resolves to an
   *  active row. Distinct from `user` (bearer
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
  /** The name that value was read under (`__Host-nemar_session` or the legacy `nemar_session`).
   *  The expiry slide re-issues the cookie only from a value read under the `__Host-` name: that
   *  cookie is minted by a sign-in and never from a legacy value (ADR 0119 decision 10). */
  webSessionCookieName?: string;
  /** Set by `oidcBearer` (epic #2014 phase #2018, ADR 0119): the OpenID Connect access token that
   *  authenticated the request, read live. Only the OIDC resource routes carry `oidcBearer`; every
   *  other route refuses such a token (`resolveApiKeyUser`'s `oidc_token`). */
  oidcToken?: OidcTokenContext;
}

/**
 * What `oidcBearer` knows of a live access token: the client it was issued to, the account it names
 * (null for a client credentials token) with the account's claim columns as they were read in the
 * same statement that found the token active, its scopes and its audience.
 */
export interface OidcTokenContext {
  tokenId: number;
  client: { id: number; clientId: string };
  user: (ClaimAccount & { id: number }) | null;
  scopes: string[];
  audience: string;
}
