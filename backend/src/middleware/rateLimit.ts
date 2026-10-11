/**
 * Rate limiting middleware using Cloudflare Cache API
 *
 * Uses Cache API instead of KV to avoid daily operation limits.
 * Cache API has no daily limits and is designed for this use case.
 *
 * Bucket policy:
 *   - Unauthenticated requests are keyed by IP and capped at 500/60s
 *     (`MAX_REQUESTS`).
 *   - Authenticated requests are keyed by the SHA-256 hash of the
 *     bearer token and capped at 1000/60s (`TOKEN_MAX_REQUESTS_AUTHED`).
 *     This is the fix for #275: admin orchestration that fans out into
 *     many sequential backend calls (publication approve, CI deploy
 *     loops) used to drown out the per-IP bucket every time several
 *     datasets shipped in quick succession. Per-token bucketing means
 *     one admin's batch can't starve another admin's quota, and the
 *     1000/60s cap still bounds a malformed loop hammering the worker.
 *   - Auth endpoints (the explicit set in `AUTH_PATHS`) keep their
 *     stricter 10/60s cap and stay keyed by IP — those run pre-auth so
 *     a token isn't available, and they need to resist key and code
 *     guessing across IPs without any single bucket being unbounded.
 *   - The device authorization grant (#1281, ADR 0047) is the one
 *     exception INSIDE its own family: `start`/`lookup`/`confirm`/`deny`
 *     and `/auth/keys` sit in the strict bucket, but `/auth/device/token`
 *     does not -- a CLI polling every 5s fits 10 polls in the strict
 *     bucket's 60s window and trips it on the 11th, about 50 seconds in,
 *     so it rides the generic bucket plus its own per-row floor instead.
 *     See the `AUTH_PATHS` comment for the detail.
 */

import type { Context, Next } from "hono";
import { ACTIVE_ACCOUNT_STATUS_SQL_LIST } from "../services/account-tier";
import { hashApiKey } from "../services/token";
import { hashIp } from "../services/web-session";
import type { Bindings, Variables } from "../types/bindings";

// Rate limit configuration
const WINDOW_SIZE = 60; // seconds
// Unauthenticated bucket. The website's SSR fetches GET endpoints from
// inside a Cloudflare Worker (@astrojs/cloudflare); those requests share a
// small pool of CF egress IPs, so a handful of concurrent visitors of
// ww2.nemar.org are bucketed as one client by the per-IP keyer and trip
// the cap. This middleware is the secondary floor against runaway loops;
// if Cloudflare bot management is enabled at the zone level it is the
// primary control against abuse. Bumped 100 → 500 in #639 along with
// adding Cache-Control to the three dataset GET endpoints (which is the
// real architectural fix; this cap raise is defense-in-depth).
const MAX_REQUESTS = 500;
// Authenticated bucket. Originally sized for the heaviest single admin
// orchestration: `nemar admin publish approve` on a 6500-object dataset
// makes ~65 sequential CLI→Worker HTTP calls (one batch per ~100-object
// page) plus the surrounding orchestrator steps — call it ~165 total
// requests counting orchestrator overhead. (Each Worker invocation
// itself fans out internally to ~120 sub-fetches against S3/D1; that's
// a separate budget governed by CF's per-invocation subrequest cap and
// is unrelated to this token-bucket count.) 1000/60s gives ~6× headroom
// over the heaviest single approve and comfortably absorbs back-to-back
// queues across multiple admins / multiple datasets. Bumped 500 → 1000
// in #639. Not exposed as configuration — the appropriate number lives
// in code review, not at runtime.
const TOKEN_MAX_REQUESTS_AUTHED = 1000;

/** See `writeCount`'s no-`waitUntil` fallback, below. */
const RATE_LIMIT_WRITE_STALL_MS = 500;

/** Last time {@link logCacheFaultOnce} actually emitted a log, module-level so
 *  it persists across requests in a warm isolate. */
let lastCacheFaultLoggedAt = 0;

/**
 * Log a Cache API fault (the enforcement path failing open) at most once per
 * rate-limit window, per isolate. During a sustained Cache API outage every
 * request through `rateLimiter` or `checkDataMissBudget` used to hit this
 * same catch block and log unconditionally, which turns an outage into a
 * request-volume-scaled flood of `console.error` lines -- exactly the kind of
 * noise that makes the ONE line worth reading (the fault itself) harder to
 * find, not easier. A module-level timestamp is enough: it does not need to
 * be keyed by bucket or route, because the thing being reported is "the Cache
 * API is unavailable to this isolate right now," which is true for every
 * caller at once.
 */
function logCacheFaultOnce(details: Record<string, unknown>): void {
  const now = Date.now();
  if (now - lastCacheFaultLoggedAt < WINDOW_SIZE * 1000) return;
  lastCacheFaultLoggedAt = now;
  console.error("[rate-limit] cache failure", details);
}

/** Test-only: let a test see the very next fault log again rather than
 *  waiting out a real window. */
export function __resetCacheFaultLogForTests(): void {
  lastCacheFaultLoggedAt = 0;
}

// A legitimate full-dataset download over the data plane (`nemar-py
// --jobs 16`, `rclone sync`) fires thousands of small per-file requests
// against this ONE ip-keyed bucket, and #1516 (the brokered-file edge cache)
// made each of those requests fast enough that the 60s window can fill up on
// download speed alone rather than on abuse.
//
// Measured in-process against the real `dataRoutes` app
// (`scripts/bench-git-file-cache.ts`, no real network involved): 300
// git-tracked files, 16 requests in flight at once, warm edge cache --
// 32.8 ms wall clock, about 0.11 ms per request. That number is a floor, not
// a production estimate: it has no TLS, no real network hop to D1 or the
// Cache API, and no Worker invocation overhead, all of which a deployed
// isolate pays on every request even on a hit. Budgeting 10 ms per
// cache-hit request end to end -- roughly 90x the in-process floor, and
// still far below the multi-second GitHub round trip a hit now skips
// entirely -- sixteen workers place 16 * (60,000 / 10) = 96,000 requests in
// one 60s window at the limit. Real clients also do other things (parse a
// response, write to disk), so actual throughput sits well under that
// ceiling; the cap has to sit above the THEORETICAL rate a fast client can
// sustain, not just the observed one. 100,000 is that ceiling rounded up,
// 10x the previous cap (10,000).
//
// It is comfortably above what #1494's own measurements called for, and it
// is NOT enough headroom for the single largest catalog dataset's HEAD+GET
// pattern in one window on its own: nm000281 carries 102,532 manifest
// entries, and rclone's HTTP backend HEADs then GETs each file it doesn't
// already have, 205,064 requests if every one were a cache hit. That
// traffic naturally spans several 60s windows at real network latency
// regardless of the cap, and the bucket resets every window, so this is not
// a gap in practice -- it is why the cap does not need to be sized for that
// dataset's total in one window at all.
//
// This bucket alone is not the abuse control for the EXPENSIVE path. A cache
// hit is cheap (the number above), but a MISS on a brokered git-tracked file
// still mints a token and makes a real GitHub request, so 100,000/60s of
// misses would still be 100,000 GitHub requests a minute from one IP. That
// is why a MISS on that path is ALSO counted against its own, much smaller
// per-IP budget (`data-miss-ip`, `checkDataMissBudget` below) -- this bucket
// stays sized for the cheap, common case; the expensive, rare case gets its
// own floor. This cap stays a defense-in-depth floor for request volume, the
// same role it has always had (see the MAX_REQUESTS comment below).
//
// Public read data-plane bucket (`data.nemar.org/*`, which the host fork in
// index.ts rewrites to `/data/*`; also reachable as `/nemar/data/*`). These
// endpoints are read-only and anonymous. Plain annexed objects keep their 302
// to S3; chunk-only objects stream through the Worker with bounded discovery
// and at most 512 sequential chunk GETs per request. Since #1403 the Worker
// also carries git-tracked files itself rather than redirecting them to
// raw.githubusercontent.com, because a private repo cannot be read anonymously
// and a redirect can never be counted. The per-IP bucket limits repeated outer
// requests; it does not measure bytes, while each chunk stream has its own
// per-request subrequest bound. Note
// what is NOT true: nothing here writes an edge copy (a Worker response on a
// Custom Domain is not stored automatically — zarr-data.ts reaches
// caches.default explicitly for that reason), so every one of those requests
// still costs an upstream fetch. If that egress ever matters, this bucket
// needs splitting rather than widening. A parallel client (e.g. `nemar-py
// --jobs 16` on its HTTPS backend,
// or `rclone`) legitimately bursts hundreds of per-file requests for one dataset
// and was tripping the 500/60s anonymous IP floor (#615 follow-up; Bruno's
// `data.nemar.org` 429 reports). Give the data plane its own much larger
// IP-keyed bucket so a real downloader runs unthrottled while a runaway loop
// is still bounded (a scraper can't make unbounded Worker invocations), and so
// data-plane traffic and the write/management API can't starve each other —
// the same isolation rationale as the per-token bucket in #275.
const DATA_MAX_REQUESTS = 100_000;
// Matches the data sub-app mount: `/data`, `/data/...`, and the `/nemar`
// path-mount forms. Deliberately anchored with `(\/|$)` so it does NOT match
// the management API at `/datasets/*` (that keeps the standard ip/token cap).
const DATA_PATH_RE = /^\/(nemar\/)?data(\/|$)/;
// The Neurobagel artifact store's read route (epic #1586 phase 4, ADR 0084). Its own
// IP-keyed bucket, matched BEFORE the bearer branch, for two reasons the generic
// branches get wrong. The route's token is one shared deployment secret that no
// middleware validates until the handler runs, so a bearer-keyed bucket would let a
// caller mint a fresh 1,000/min bucket per request by rotating a made-up bearer AND
// make every novel one cost a D1 lookup (the hole `anonymousSurface` below documents
// for /mcp). And the one legitimate client, the node's loader, fetches an index and
// then up to three files per dataset in one run: about 2,400 requests for 800
// datasets, which the 500/min anonymous floor would refuse halfway through a first
// load. The loader is sequential and fetches at most a few requests a second, so
// 1,200/min is above any rate it sustains and still bounds a runaway caller.
const NEUROBAGEL_PATH_RE = /^\/neurobagel(\/|$)/;
const NEUROBAGEL_MAX_REQUESTS = 1200;
// The zarr serving gateway (#901), the highest-request-volume data-plane path,
// which bypassed the middleware stack and went unthrottled. Two reachable path
// shapes, because Hono's `app.route("/zarrproxy", zarrDataRoutes)` PREPENDS the
// prefix (it does not strip it before dispatch):
//   - `/<id>/zarr/...`          — the zarr.nemar.org host fork (zarrDataRoutes.fetch)
//   - `/zarrproxy/<id>/zarr/...` — the path mount, reachable on api.nemar.org and
//     the workers.dev fallback. `c.req.path` keeps the /zarrproxy prefix here.
// Match both so neither entry point is mis-bucketed to the tighter ip cap.
const ZARR_PATH_RE = /^(?:\/zarrproxy)?\/[a-z]{2}\d+\/zarr(\/|$)/;

// Stricter limits for auth endpoints
const AUTH_MAX_REQUESTS = 10;
const AUTH_PATHS = [
  "/auth/login",
  "/auth/verify",
  "/auth/request-key-regeneration",
  "/auth/confirm-key-regeneration",
  // Web-dashboard passwordless flow (#569). The route handler also
  // enforces a per-email rate limit (1/min, 5/hour) — the per-IP cap
  // here is the outer floor against flooding from a single network.
  // /auth/me is intentionally NOT in this list: the dashboard polls
  // it on every navigation and should hit the standard token/IP
  // bucket, not the stricter auth bucket.
  "/auth/code/request",
  "/auth/code/verify",
  "/auth/logout",
  // Settings self-service (#912/#911): cookie-authenticated mutations.
  // Without these entries they'd fall to the generic ip bucket (500/min);
  // the email-change request in particular reveals address collisions to
  // the (authenticated) caller, so the 10/min floor is load-bearing.
  "/auth/profile",
  "/auth/email/change/request",
  "/auth/email/change/verify",
  // Email verification (ADR 0040 phase 2): the request endpoint mails a
  // code and the verify endpoint guesses at one, so both belong in the
  // stricter bucket. One entry covers both -- the matcher below treats an
  // entry as a prefix, so "/auth/email/verify" also matches
  // "/auth/email/verify/request".
  "/auth/email/verify",
  // CLI ORCID surface (#1266, ADR 0044). `cli-start` mints an identity-link
  // intent, `cli-handoff` (and its /continue confirm step, covered by the
  // prefix match) is the only thing that can turn a leaked one into an ORCID
  // redirect, and `unlink` drops an iD outright -- all three are now reachable
  // with a bearer token, so without these entries they would sit in the
  // 1000/min token bucket instead of the 10/min floor every other identity
  // mutation has. A person links or unlinks an iD once.
  // The rest of /auth/orcid/* is deliberately NOT here: the callback is a
  // browser landing, and moving it would change the web flow's bucket.
  "/auth/orcid/cli-start",
  "/auth/orcid/cli-handoff",
  "/auth/orcid/unlink",
  // Device authorization grant (RFC 8628; epic #1272 phase 1, #1281; ADR
  // 0047). A person starts, looks up, confirms, or denies a sign-in a
  // handful of times, not in a loop, so all four -- plus /auth/keys, the
  // named-key routes the prefix match also covers (/auth/keys/:id) -- sit
  // in the strict floor like every other identity mutation above.
  // `/auth/device/token` is DELIBERATELY ABSENT: the CLI polls it roughly
  // every 5 seconds while waiting (up to ~120 polls for one 10-minute
  // code). At that cadence 10 polls fit inside the strict bucket's 60s
  // window and the 11th trips it, about 50 seconds in -- not the "third
  // poll" a looser count might suggest. In practice this route lands in
  // the plain `ip` bucket (500/min), not `token`: the CLI has not
  // collected a key yet while it is polling, so it holds no bearer to
  // authenticate a request with. Its own per-row 5-second floor
  // (`DEVICE_POLL_SQL`) answers `slow_down` to anything faster than that
  // without ever 429ing the loop.
  "/auth/device/start",
  "/auth/device/lookup",
  "/auth/device/confirm",
  "/auth/device/deny",
  "/auth/keys",
  // Docs admin gate (epic #1336 phase 0, #1338). `grant` mints a one-time code
  // for a session that already proved itself, and `exchange` spends one; a
  // person passes through both once per eight-hour docs session, so the strict
  // floor is the right home for the pair.
  //
  // Neither is called by a browser, and they are called by DIFFERENT workers:
  // `grant` by the website's server-side render, `exchange` by the docs site's
  // Pages Function. Both therefore arrive from a small pool of egress addresses
  // rather than from a person, and `grant` shares its bucket with every other
  // visitor's `/auth/logout` and `/auth/profile`. That is a pre-existing property of this bucket rather than
  // something these two introduce -- see the note on MAX_REQUESTS below, and
  // issue #1354, which proposes keying Worker-originated requests on something
  // other than the egress address. They stay here because a person passes
  // through them once per eight-hour docs session, so they add almost nothing
  // to the pressure; moving one route would hide the general problem rather
  // than fix it.
  //
  // `/auth/docs/verify` is DELIBERATELY ABSENT, for the same reason
  // `/auth/device/token` is. It is called once per gated page view, and the
  // caller is a Cloudflare Pages Function, so every admin in the organization
  // arrives from the same small pool of egress IPs and shares one per-IP
  // bucket. One admin clicking through the dozen operations pages would sit at
  // the strict cap on their own, and two browsing at once would trip it, which
  // would read as "the gate is broken" rather than "you are rate limited". It
  // rides the generic ip bucket (500/min) instead: the route mints nothing,
  // reveals nothing beyond whether one 256-bit value is a live admin session,
  // and cannot be brute-forced at any rate a bucket would help with. Note the
  // comment on MAX_REQUESTS below -- shared CF egress IPs are why that bucket
  // is 500 rather than 100 in the first place.
  //
  // `/auth/docs/cli-session` IS here, and unlike the two above it is called by
  // a person's own machine rather than by a Worker, so the per-IP key is a real
  // per-caller key for once.
  //
  // "Far above any honest use" was the first version of this sentence and it
  // overclaimed. This bucket is SHARED across every entry in this list, so an
  // admin who reads a dozen runbook pages as a dozen separate
  // `nemar admin docs` invocations spends the same ten-per-minute budget that
  // `nemar auth login` needs, and can lock their own machine out of signing in.
  // The CLI takes several paths per invocation specifically so that a reading
  // session costs one mint rather than one per page, which keeps normal use far
  // inside the cap -- but that is a property of how the CLI is written, not a
  // property of the limit. Someone scripting a loop over single pages will feel
  // it. Issue #1354 tracks keying these buckets on something better than the
  // address; until then, do not read this cap as generous.
  //
  // The stronger claim -- that a stolen admin key cannot be turned into a
  // stream of docs credentials from one address -- was written here first and
  // was FALSE, because `/nemar/auth/docs/cli-session` matched nothing in this
  // list. See `__normalizeMountPath` above, which is what makes it true, and
  // note that it was true of no entry in this list before that.
  "/auth/docs/grant",
  "/auth/docs/exchange",
  "/auth/docs/cli-session",
  // `/auth/private/grant` (ADR 0079) is DELIBERATELY ABSENT. Every sign-in to
  // the private site reaches it through the website's server-side render, so
  // every caller arrives from a few Cloudflare egress addresses (issue #1354),
  // and this bucket's ten a minute would be shared by everyone signing in at
  // once. It is limited per ACCOUNT instead (`checkPrivateGrantBudget` below,
  // called by the route once the session names the account), and rides the
  // generic `ip` bucket here.
  // NOT an /auth path, and deliberately in this list anyway (ADR 0042, #1253):
  // POST /users/me/upload-access/request spends a live GitHub API call on the
  // shared installation token for every attempt, and a refused one writes
  // nothing, so it is replayable. On the generic token bucket that is ~1000
  // GitHub calls a minute from one verified account. The strict floor is the
  // point: a human asks for upload access once.
  "/users/me/upload-access/request",
];

type RateLimitContext = Context<{ Bindings: Bindings; Variables: Variables }>;

/**
 * Read a syntactically-plausible bearer token from the request, without
 * touching the database. Returns `null` for missing/malformed headers —
 * those fall through to the IP bucket. The auth middleware later runs
 * a real validation against D1; this lookup is only used to pick a
 * stable bucket key for a *plausible* authenticated request. Even if
 * the token turns out to be invalid in the auth middleware (and the
 * request 401s), bucketing it separately from the per-IP pool means a
 * single bad client can't blow through the unauthenticated cap on
 * shared egress IPs.
 *
 * Exported (with the `__` test-only prefix) for the focused unit test
 * in `test/rate-limit-buckets.test.ts`.
 */
export function __readBearerTokenFromHeader(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.substring(7);
  // The auth middleware enforces `length >= 32`. Mirror that here so
  // a 3-char "Bearer abc" attempt doesn't get the higher authenticated
  // cap.
  if (!token || token.length < 32) return null;
  return token;
}

/**
 * Bucket selection — the core of the #275 fix. Pure function of the
 * request shape so the test suite can exercise every branch without
 * standing up a Cloudflare runtime. Returns the bucket key kind, the
 * raw key value, and the cap.
 *
 *  - `auth-ip` for the strict-bucket paths (10/60s, IP-keyed). Mostly
 *    `/auth/*`, which stays pre-auth-friendly (login/verify have no token
 *    yet), plus any authenticated endpoint whose per-request cost is an
 *    external call rather than a D1 read -- see AUTH_PATHS.
 *  - `token` for any request carrying a syntactically-valid bearer
 *    (1000/60s). Admin orchestration (`publish approve`, CI deploy
 *    sweeps) fits here; per-token bucketing means one admin's batch
 *    can't 429 another admin's batch through the shared IP pool.
 *  - `data-ip` for the public read data plane (`/data/*`, `/nemar/data/*`).
 *    100,000/60s, IP-keyed. Checked before the bearer branch because the data
 *    plane is anonymous-by-design; a tokened request to a public file is
 *    still charged to the (generous) IP bucket, not the tighter token bucket.
 *    A MISS on this bucket (no cached copy, a real GitHub request) is
 *    additionally charged against its own, much smaller `data-miss-ip`
 *    budget (10,000/60s, `checkDataMissBudget`/`DATA_MISS_MAX_REQUESTS`
 *    below) -- this bucket alone does not bound the expensive path.
 *  - `neurobagel-ip` for the Neurobagel artifact store's read route
 *    (`/neurobagel/*`). 1,200/60s, IP-keyed, checked before the bearer branch for
 *    the reasons at NEUROBAGEL_PATH_RE.
 *  - `ip` for everything else (the unauthenticated cap).
 *
 * Admin endpoints used to be entirely exempt; that gave an admin
 * running a malformed loop unbounded access to the worker. Keeping the
 * limit but raising the cap for authenticated buckets preserves the
 * floor without the floor being absent.
 */
export interface __BucketSelection {
  keyKind: "auth-ip" | "ip" | "token" | "data-ip" | "neurobagel-ip";
  /** Pre-hash key material: the IP, or the raw bearer token. */
  rawKey: string;
  maxRequests: number;
}

/**
 * The API sub-app is mounted TWICE in `backend/src/index.ts`: at `/` and at
 * `/nemar`. Hono hands middleware the FULL request path, not the path relative
 * to the mount, so every path rule in this file saw `/nemar/auth/login` for one
 * of the two spellings and matched none of them.
 *
 * FOUND BY REVIEW OF THE DOCS CLI ROUTE (#1384), and it was never specific to
 * that route: every entry in `AUTH_PATHS` was reachable at 500/min (or, with a
 * bearer, the 1000/min token bucket and the admin bypass beyond it) by
 * prefixing `/nemar`. `/auth/login`, `/auth/code/request`, `/auth/keys` and the
 * device-flow routes all sat behind a strict floor that one extra path segment
 * stepped over. Measured, not inferred: middleware inside the prefixed mount
 * reports `c.req.path` as `/nemar/auth/docs/cli-session`, and both spellings
 * reach the same handler.
 *
 * Normalizing here rather than at each call site is deliberate: this is the one
 * place that turns a path into a bucket, so a rule added later gets the fix for
 * free. The data and zarr regexes benefit too, for the same reason.
 */
const MOUNT_PREFIX = "/nemar";

export function __normalizeMountPath(path: string): string {
  if (path === MOUNT_PREFIX) return "/";
  return path.startsWith(`${MOUNT_PREFIX}/`) ? path.slice(MOUNT_PREFIX.length) : path;
}

export function __selectBucket(
  rawPath: string,
  authHeader: string | undefined,
  ip: string,
): __BucketSelection {
  const path = __normalizeMountPath(rawPath);
  if (AUTH_PATHS.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`))) {
    return { keyKind: "auth-ip", rawKey: ip, maxRequests: AUTH_MAX_REQUESTS };
  }
  // Public read data plane gets its own generous IP bucket before the bearer
  // check: it is anonymous-by-design (no token), and even a tokened request to
  // a public file should not be charged against the tighter token bucket.
  if (DATA_PATH_RE.test(path) || ZARR_PATH_RE.test(path)) {
    return { keyKind: "data-ip", rawKey: ip, maxRequests: DATA_MAX_REQUESTS };
  }
  // The artifact store's read route: IP-keyed whatever bearer it carries, so a made-up
  // bearer neither mints a bucket nor reaches the privileged-token lookup.
  if (NEUROBAGEL_PATH_RE.test(path)) {
    return { keyKind: "neurobagel-ip", rawKey: ip, maxRequests: NEUROBAGEL_MAX_REQUESTS };
  }
  const bearer = __readBearerTokenFromHeader(authHeader);
  if (bearer) {
    return { keyKind: "token", rawKey: bearer, maxRequests: TOKEN_MAX_REQUESTS_AUTHED };
  }
  return { keyKind: "ip", rawKey: ip, maxRequests: MAX_REQUESTS };
}

/**
 * Rate limiting middleware
 *
 * - Disabled in development environment
 * - Uses Cache API in production (no KV daily limits)
 * - Supports test bypass for CI/CD
 */
/**
 * Cached lookup: does this token belong to an admin or owner user?
 *
 * Bulk admin orchestration (`nemar admin reindex --missing-metadata`,
 * release sweeps, mass-publish) routinely fans out beyond the 1000/60s
 * token bucket. Capping admins at the same per-token bucket as any other
 * authenticated user makes those operations brittle and forces operators
 * to add manual pacing.
 *
 * The lookup hits D1 once per token-and-window: results are memoized in
 * caches.default for the rate-limit window (60s), so the hot path stays
 * O(1) cache lookup. Cache misses fall through to a D1 SELECT joining
 * tokens -> users. Failures (cache outage, D1 error) return false so we
 * never accidentally grant unlimited quota.
 */
async function isPrivilegedToken(env: Bindings, hashedApiKey: string): Promise<boolean> {
  const cacheKey = new Request(`https://rate-limit.internal/admin-flag:${hashedApiKey}`);
  try {
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      const data = (await cached.json()) as { admin: boolean };
      return data.admin === true;
    }
    // Same status set authMiddleware accepts (ADR 0040 phase 2): the quota a
    // token gets must be decided over the same population that token can
    // authenticate as, or an admin sitting at `verified` would authenticate
    // fine and then be throttled as an anonymous stranger. The privilege
    // itself still comes from `role`, which this widening does not touch.
    const row = await env.DB.prepare(
      `SELECT u.role FROM tokens t JOIN users u ON t.user_id = u.id
       WHERE t.api_key_hash = ?
         AND t.revoked_at IS NULL
         AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))
         AND u.status IN ${ACTIVE_ACCOUNT_STATUS_SQL_LIST}
         AND u.deleted_at IS NULL`,
    )
      .bind(hashedApiKey)
      .first<{ role: string | null }>();
    const admin = row?.role === "admin" || row?.role === "owner";
    const ttl = admin ? WINDOW_SIZE : Math.min(WINDOW_SIZE, 30);
    await cache.put(
      cacheKey,
      new Response(JSON.stringify({ admin }), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `max-age=${ttl}`,
        },
      }),
    );
    return admin;
  } catch (err) {
    console.warn(`[rate-limit] admin-flag lookup failed: ${(err as Error).message ?? err}`);
    return false;
  }
}

export interface RateLimiterOptions {
  /**
   * Count this request against its bucket's cache entry -- the SAME
   * IP-keyed bucket a proxied request from the same client is enforced
   * against -- without ever blocking THIS request (#1181 phase 6 / issue
   * #1061). Built for the zarr sub-app's redirect branch: a 302 costs a
   * fraction of a millisecond of CPU and zero bytes through this Worker, so
   * it must never itself 429, but the counter is still the SAME shared
   * bucket -- a client hammering an IP hard enough to matter is still
   * visible, and a later PROXIED request from that IP correctly 429s once
   * the shared bucket is exhausted, observed traffic included.
   *
   * Logs exactly ONE `console.warn` per window, the first time the count
   * reaches the point enforcement would have blocked -- never per request,
   * which would be the same noise this option replaces (an unconditional
   * per-request log the zarr sub-app used to emit for every exempted hit).
   */
  observeOnly?: boolean;

  /**
   * This surface has NO authentication, so ignore any `Authorization` header
   * when picking the bucket and key on the IP like an anonymous caller.
   *
   * Built for the MCP sub-app (epic #1065), where the default behavior was a
   * real hole rather than a nuisance. `/mcp` matches neither `AUTH_PATHS` nor
   * the data-plane patterns, so the bearer branch below used to win, and the
   * MCP sub-app registers no auth middleware at all -- nothing ever validates
   * that bearer. Two consequences, both reachable by an anonymous caller:
   *
   *  1. The bucket is keyed on the raw bearer, so rotating a fresh 32-character
   *     string per request minted a fresh 1000/min bucket every time and the
   *     500/min IP floor was bypassed entirely.
   *  2. Every novel token reached {@link isPrivilegedToken}, which is a cache
   *     miss plus a D1 `SELECT` joining `tokens` to `users` -- an
   *     unauthenticated D1-query amplifier, one query per request, from one IP.
   *
   * The zarr and data planes are immune by accident of ordering: their path
   * patterns are tested BEFORE the bearer branch. This option is the explicit
   * version of that, for a sub-app whose own paths (`/mcp`, and the descriptor
   * at `/`) cannot be pattern-matched from here without colliding with the api
   * root.
   */
  anonymousSurface?: boolean;
}

export async function rateLimiter(
  c: RateLimitContext,
  next: Next,
  options: RateLimiterOptions = {},
) {
  // Skip rate limiting in development. Deliberately the exact string
  // "development", not `isNonProductionEnv`: the staging worker runs with
  // ENVIRONMENT="development" (this IS its bypass), but `isNonProductionEnv`
  // would ALSO match "test", and every test that sets ENVIRONMENT="test" to
  // exercise other behavior would silently stop exercising the limiter too.
  // Both forms fail closed on an unset value; do not widen this one.
  if (c.env.ENVIRONMENT === "development") {
    await next();
    return;
  }

  // Check for test bypass header (for CI/CD and integration tests)
  const testBypassToken = c.req.header("X-Test-Bypass");
  if (testBypassToken && c.env.TEST_BYPASS_TOKEN && testBypassToken === c.env.TEST_BYPASS_TOKEN) {
    await next();
    return;
  }

  const path = c.req.path;
  // Fall back to a random UUID instead of the shared "unknown" sentinel
  // so headerless requests each get their own bucket rather than pooling.
  const ip =
    c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For") || crypto.randomUUID();

  // `c.executionCtx.waitUntil`, or undefined outside a real Worker
  // invocation -- Hono throws on the getter then, the same fallback
  // `routes/data.ts`'s `deferOf` uses. Read once per request; only the
  // `data-ip` bucket (below) ever uses it.
  const dataPlaneDefer = (): ((work: Promise<unknown>) => void) | undefined => {
    try {
      const ctx = c.executionCtx;
      return (work) => ctx.waitUntil(work);
    } catch {
      return undefined;
    }
  };

  // An anonymous surface's bearer is meaningless (nothing validates it), so it
  // must not select the bucket. Withholding the header here rather than adding a
  // path pattern keeps the whole sub-app covered, descriptor included, and skips
  // the privileged-token D1 lookup as a consequence of never being `token`.
  const { keyKind, rawKey, maxRequests } = __selectBucket(
    path,
    options.anonymousSurface ? undefined : c.req.header("Authorization"),
    ip,
  );

  // Token buckets hash the raw bearer; the auth middleware later
  // re-hashes the same value to look the user up in D1. IP buckets use
  // the raw IP as the bucket key directly — no hashing needed.
  const bucketKeyValue = keyKind === "token" ? await hashApiKey(rawKey) : rawKey;

  // Admin / owner tokens bypass the app-side limiter entirely. Bulk
  // operations (mass reindex, release sweeps) routinely exceed the
  // 1000/60s token bucket; capping them produced opaque "Network error"
  // failures in the CLI because requests dropped after the local
  // limiter 429d. The CF-edge layer still enforces its own per-IP
  // ceilings, so the floor isn't absent.
  if (keyKind === "token" && (await isPrivilegedToken(c.env, bucketKeyValue))) {
    c.header("X-RateLimit-Bucket", "admin-bypass");
    await next();
    return;
  }

  // Cache API key. The URL just needs to be a unique, stable string —
  // we never actually `fetch()` it; it's a placeholder identity for
  // the cache entry. Each kind gets its own prefix so a token bucket
  // and an IP bucket can't collide on the same key material.
  const cacheKey = new Request(`https://rate-limit.internal/rl:${keyKind}:${bucketKeyValue}`);

  // #1516: the data plane is the one bucket where the counter write itself
  // was measured to matter -- a full-dataset download is thousands of
  // requests against ONE cache entry, and every one of them used to pay for
  // a synchronous read-modify-write just to persist a number the very next
  // request would immediately overwrite. Handing the write to `waitUntil`
  // means a slow or wedged `cache.put` can never add latency to a data-plane
  // response; it costs this bucket a wider (already-existing) race window
  // where a burst of concurrent requests can all read the same stale count
  // before any of their writes land, undercounting by a few requests at
  // most. Acceptable for a bucket sized in the hundred-thousands where the
  // undercounted requests are cache hits (`checkDataMissBudget` below counts
  // the expensive misses synchronously, on its own much smaller budget).
  // Every other bucket keeps the exact synchronous behavior it always had.
  async function writeCount(write: Promise<unknown>): Promise<void> {
    if (keyKind !== "data-ip") {
      await write;
      return;
    }
    const logFailure = (err: unknown) => {
      console.error("[rate-limit] cache failure", {
        route: path,
        keyKind,
        error: err instanceof Error ? err.message : String(err),
      });
    };
    const defer = dataPlaneDefer();
    if (defer) {
      defer(write.catch(logFailure));
      return;
    }
    // No execution context -- a route test driving the app directly, per
    // `routes/data.ts`'s `deferOf` fallback. Bound the wait so a stalled
    // cache double cannot hang the request, mirroring
    // `git-file-cache.ts`'s own no-`waitUntil` fallback: a healthy write
    // settles in microtasks, so this bound is never felt in practice, and
    // it keeps the count observable to a test that awaits the response.
    await Promise.race([
      write.catch(logFailure),
      new Promise<void>((resolve) => setTimeout(resolve, RATE_LIMIT_WRITE_STALL_MS)),
    ]);
  }

  try {
    const cache = caches.default;

    // Get current count (and, for the observe-only path, whether this
    // window already warned once) from cache.
    const cached = await cache.match(cacheKey);
    let count = 0;
    let warned = false;

    if (cached) {
      const data = (await cached.json()) as { count: number; warned?: boolean };
      count = data.count;
      warned = data.warned === true;
    }

    if (options.observeOnly) {
      // Never block -- just record the hit against the shared bucket and
      // warn once if it crossed the trip point. `warned` rides in the same
      // cache record as `count` so it resets on the same window TTL.
      if (count >= maxRequests && !warned) {
        // Hashed, not raw: this is a log line, not the enforcement key
        // itself (which stays keyed on the raw IP, same as before) --
        // avoids putting a raw client IP into structured logs.
        // Same helper web-session.ts uses for privacy-preserving IP storage, so
        // every IP hash in the codebase is produced by one named function.
        const ipHash = await hashIp(rawKey);
        console.warn("[rate-limit] observe-only bucket would have tripped", {
          ipHash,
          path,
          count: count + 1,
        });
        warned = true;
      }
      const newCount = count + 1;
      await writeCount(
        cache.put(
          cacheKey,
          new Response(JSON.stringify({ count: newCount, warned }), {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": `max-age=${WINDOW_SIZE}`,
            },
          }),
        ),
      );
      await next();
      return;
    }

    if (count >= maxRequests) {
      // Calculate retry-after (approximate)
      const retryAfter = WINDOW_SIZE;

      return c.json(
        {
          error: "Rate limit exceeded",
          message: `Too many requests. Please try again in ${retryAfter} seconds.`,
          retry_after: retryAfter,
        },
        429,
        {
          "Retry-After": retryAfter.toString(),
          "X-RateLimit-Limit": maxRequests.toString(),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": (Math.floor(Date.now() / 1000) + retryAfter).toString(),
          "X-RateLimit-Bucket": keyKind,
        },
      );
    }

    // Increment counter and store in cache with TTL
    const newCount = count + 1;
    const response = new Response(JSON.stringify({ count: newCount, warned }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `max-age=${WINDOW_SIZE}`,
      },
    });
    await writeCount(cache.put(cacheKey, response));

    // Add rate limit headers to response
    c.header("X-RateLimit-Limit", maxRequests.toString());
    c.header("X-RateLimit-Remaining", (maxRequests - newCount).toString());
    c.header("X-RateLimit-Bucket", keyKind);
  } catch (error) {
    // Fail open so a cache outage doesn't block all traffic, but emit a
    // structured log (deduped to once per window per isolate, see
    // `logCacheFaultOnce`) so Workers tail / log tooling surfaces the issue.
    // TODO(#478): replace with Sentry captureException once DSN is wired.
    logCacheFaultOnce({
      route: path,
      keyKind,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await next();
}

/**
 * Per-IP budget on a brokered git-tracked file CACHE MISS (#1516 review).
 *
 * `DATA_MAX_REQUESTS` above is sized for the cheap case -- a cache hit costs
 * a D1 read, a manifest lookup and a Cache API read, no GitHub round trip.
 * A MISS is the expensive case: it mints a token and makes a real request to
 * GitHub's raw host (occasionally the blobs API too), so letting misses ride
 * the 100,000/60s data-ip bucket unbounded would let one IP spend up to
 * 100,000 GitHub requests a minute -- the exact amplifier
 * `BLOB_FALLBACK_PER_WINDOW` already exists to bound on the blobs side, with
 * nothing bounding the raw-host side at all. This is that bound, and it is
 * deliberately its OWN counter rather than a second check against `data-ip`:
 * a request that hits the cache must never be throttled by how many OTHER
 * requests happened to miss.
 *
 * 10,000/60s -- the data plane's PREVIOUS overall cap, before #1516 made
 * hits cheap enough to need a bigger one. Sized against a real cold
 * full-dataset download: nm000134 has 7,891 git-tracked files, and a cold
 * miss (no token cached yet, a real GitHub round trip) costs on the order of
 * 1 second under real network conditions. At 16 requests in flight, that
 * download produces roughly 16 misses/second while it runs, about
 * 1,000/minute -- an order of magnitude under this budget. A client that
 * trips it is not downloading one dataset; it is missing on a scale no
 * legitimate cold download reaches.
 */
const DATA_MISS_MAX_REQUESTS = 10_000;

/** The bucket name `X-RateLimit-Bucket` and the internal cache key report
 *  for the git-file miss budget. Not part of `__selectBucket`'s
 *  `__BucketSelection` union: this bucket is never chosen from a request
 *  PATH the way the others are, because whether a request is a "miss" is
 *  something only `serveGitTrackedFile` can know, after it has already
 *  checked the git-file cache. */
const DATA_MISS_BUCKET_KIND = "data-miss-ip";

export type DataMissBudgetOutcome =
  | { allowed: true }
  | {
      allowed: false;
      /** A ready-to-serve 429, the same shape `rateLimiter`'s own blocking
       *  branch answers with, so a client cannot tell which bucket tripped
       *  from the response shape alone -- only `X-RateLimit-Bucket` differs. */
      response: Response;
    };

/**
 * Count one cache miss against its IP's miss budget, and refuse it if the
 * budget is already spent. Call exactly once per miss, immediately before
 * going upstream -- never on a hit (the whole point), never on HEAD (HEAD
 * never reaches GitHub at all), never on an annexed file response (302 or
 * streamed chunks), a directory
 * listing, or the "not in the manifest at all" 404 (none of those go through
 * this path either).
 *
 * Mirrors `rateLimiter`'s own mechanics: a Cache API counter (`{count}`
 * under `max-age=<WINDOW_SIZE>`; it needs no `warned` flag, having no
 * observe-only mode), the same dev-environment and `X-Test-Bypass`
 * exemptions, and the same
 * `waitUntil`-deferred write with the bounded no-context fallback (so a
 * route-suite call with no execution context cannot hang on a stalled test
 * cache). Kept as a standalone function rather than folded into the
 * `rateLimiter` middleware because the decision it makes cannot be made from
 * a request's PATH: the middleware runs before the route handler even knows
 * whether this git-tracked file is cached.
 */
export async function checkDataMissBudget(
  env: Pick<Bindings, "ENVIRONMENT" | "TEST_BYPASS_TOKEN">,
  request: Request,
  waitUntil: ((work: Promise<unknown>) => void) | undefined,
): Promise<DataMissBudgetOutcome> {
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For") ||
    crypto.randomUUID();
  return consumeKeyedBudget(
    env,
    request,
    { kind: DATA_MISS_BUCKET_KIND, key: ip, maxRequests: DATA_MISS_MAX_REQUESTS },
    waitUntil,
  );
}

/**
 * Ten private-site grants a minute per ACCOUNT (ADR 0079). A person signs in
 * to the private site once per eight-hour session; ten a minute is far above
 * that and far below what a script replaying a stolen app session could want.
 */
const PRIVATE_GRANT_MAX_REQUESTS = 10;
const PRIVATE_GRANT_BUCKET_KIND = "private-grant-account";

/**
 * Count one `POST /auth/private/grant` against its account's budget, and
 * refuse it once the budget is spent. Keyed by the user id the authenticated
 * app session names, never by address: the route is called server-side by
 * the website, so every sign-in arrives from a few Cloudflare egress
 * addresses (issue #1354), and a per-IP bucket would make strangers share one
 * limit. The route calls this after authentication, because the account is
 * only known then; that is why it is not a path rule in `__selectBucket`.
 */
export async function checkPrivateGrantBudget(
  env: Pick<Bindings, "ENVIRONMENT" | "TEST_BYPASS_TOKEN">,
  request: Request,
  userId: number,
  waitUntil: ((work: Promise<unknown>) => void) | undefined,
): Promise<DataMissBudgetOutcome> {
  return consumeKeyedBudget(
    env,
    request,
    {
      kind: PRIVATE_GRANT_BUCKET_KIND,
      key: `user-${userId}`,
      maxRequests: PRIVATE_GRANT_MAX_REQUESTS,
    },
    waitUntil,
  );
}

/**
 * The shared core of the keyed budgets a route checks itself, because the
 * key is something only the route knows (whether a request missed the cache,
 * which account a session names). Mirrors `rateLimiter`'s own mechanics: a
 * Cache API counter (`{count}` under `max-age=<WINDOW_SIZE>`, with no
 * `warned` flag because there is no observe-only mode), the same
 * dev-environment and `X-Test-Bypass`
 * exemptions, the same fail-open on a cache outage, and the same
 * `waitUntil`-deferred write with the bounded no-context fallback.
 */
async function consumeKeyedBudget(
  env: Pick<Bindings, "ENVIRONMENT" | "TEST_BYPASS_TOKEN">,
  request: Request,
  bucket: { kind: string; key: string; maxRequests: number },
  waitUntil: ((work: Promise<unknown>) => void) | undefined,
): Promise<DataMissBudgetOutcome> {
  // Same narrower check as `rateLimiter`'s dev bypass, deliberately: staging
  // runs as "development" and must be exempt, but "test" must NOT be, or
  // every test that sets ENVIRONMENT="test" stops exercising this budget.
  if (env.ENVIRONMENT === "development") return { allowed: true };

  const testBypassToken = request.headers.get("X-Test-Bypass");
  if (testBypassToken && env.TEST_BYPASS_TOKEN && testBypassToken === env.TEST_BYPASS_TOKEN) {
    return { allowed: true };
  }

  const cacheKey = new Request(`https://rate-limit.internal/rl:${bucket.kind}:${bucket.key}`);

  try {
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    const count = cached ? ((await cached.json()) as { count: number }).count : 0;

    if (count >= bucket.maxRequests) {
      const retryAfter = WINDOW_SIZE;
      return {
        allowed: false,
        response: new Response(
          JSON.stringify({
            error: "Rate limit exceeded",
            message: `Too many requests. Please try again in ${retryAfter} seconds.`,
            retry_after: retryAfter,
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": retryAfter.toString(),
              "X-RateLimit-Limit": bucket.maxRequests.toString(),
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": (Math.floor(Date.now() / 1000) + retryAfter).toString(),
              "X-RateLimit-Bucket": bucket.kind,
            },
          },
        ),
      };
    }

    const newCount = count + 1;
    const write = cache
      .put(
        cacheKey,
        new Response(JSON.stringify({ count: newCount }), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `max-age=${WINDOW_SIZE}`,
          },
        }),
      )
      .catch((err: unknown) => {
        console.error("[rate-limit] cache failure", {
          keyKind: bucket.kind,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    if (waitUntil) {
      waitUntil(write);
    } else {
      await Promise.race([
        write,
        new Promise<void>((resolve) => setTimeout(resolve, RATE_LIMIT_WRITE_STALL_MS)),
      ]);
    }
    return { allowed: true };
  } catch (error) {
    // Fail open, the same policy `rateLimiter` itself follows on a cache
    // outage: a broken Cache API must not block traffic. Deduped the same
    // way, and against the SAME timestamp: one outage should log once total,
    // not once per bucket kind.
    logCacheFaultOnce({
      keyKind: bucket.kind,
      error: error instanceof Error ? error.message : String(error),
    });
    return { allowed: true };
  }
}

// Internal limits exposed for the focused unit test in
// `test/rate-limit-buckets.test.ts`. Prefixed with `__` so static
// analysis flags any production code that tries to import them.
export const __limits = {
  AUTH_MAX_REQUESTS,
  TOKEN_MAX_REQUESTS_AUTHED,
  MAX_REQUESTS,
  DATA_MAX_REQUESTS,
  DATA_MISS_MAX_REQUESTS,
  NEUROBAGEL_MAX_REQUESTS,
  PRIVATE_GRANT_MAX_REQUESTS,
  WINDOW_SIZE,
};
