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
 *   - Who an address names depends on how the request arrived (#1709, ADR
 *     0098). Cloudflare sets `CF-Connecting-IP` on everything from the public
 *     network, and that value alone keys the buckets above. A request through
 *     a service binding (the website's Worker) has none, so the visitor the
 *     caller forwarded in `X-Forwarded-For` is counted instead, in `site-ip`
 *     (and in `site:`-prefixed keys of the strict, data and Neurobagel
 *     buckets), and a request with neither is counted in one shared bucket.
 *     `X-Forwarded-For` never chooses the bucket of a request that carries
 *     `CF-Connecting-IP`.
 *   - Every counter is a fixed window (`__CounterState`): it starts with the first
 *     request that finds none and ends 60 seconds later, `Retry-After` and
 *     `X-RateLimit-Reset` say when, and a busy client is refused until then and
 *     no longer. Before #1709 the window slid, which refused a pool for about a
 *     minute after every `cap / rate` seconds.
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
//
// Bumped again 500 → 1000 in #1709 (ADR 0098), as a change of its own so it can be
// reverted without touching the site-ip work below. The website's ordinary traffic
// no longer rides this bucket (it is counted per visitor in `site-ip`); this is
// defense in depth for the callers that still reach the API as one client: the
// website when it cannot use its binding (a Pages preview, local development, or
// if a binding call turns out to carry an address after all), the docs gate's
// Pages Function, and shared CI runners.
//
// What a counted request costs: one Worker invocation and, for the catalog reads
// that dominate, two or three D1 reads (a page of rows and its count; a search adds
// an index lookup). The Cache-Control those routes send lets a client that honors
// it skip the call; it does not make the Worker skip the work for one that does
// not. At 1000 per window the ceiling for one address is about 17 requests a
// second, 1.4 million a day, per data center.
//
// What the number does and does not protect against. It bounds a runaway loop from
// one address. It does not bound a crawl spread over many addresses (each has its
// own bucket, each data center its own counter), or the cost of any single call.
// `/mcp` shares this bucket, and its tools read from S3 per call; those reads are
// bounded by their own byte limits (#1498), not by this number, so a higher cap
// raises how many one address may start. No Cloudflare rule in front of the Worker
// is documented in this repository, so read this as the only floor.
//
// Why 1000 and not more. A token holder must never be limited more strictly than an
// anonymous caller. `TOKEN_MAX_REQUESTS_AUTHED` is 1000, so this cannot go
// above it without raising that one too, which is a separate decision; a test pins
// the relation. The number is not what made the website's pool trip it. Until the
// window was made fixed (`__CounterState`) each allowed request refreshed the
// counter's expiry, so a pool that never went quiet for 60 seconds was refused for
// about a minute after every `cap / rate` seconds: at six requests a second about
// 42 percent at 500 and 26 at 1000. Now a rate below the cap per window is never
// refused. ADR 0098 gives the measurements.
const MAX_REQUESTS = 1000;
// The website's own bucket, per forwarded visitor (#1709, ADR 0098). The website
// reaches this Worker through a service binding, which carries no
// `CF-Connecting-IP`, and forwards the visitor's address in `X-Forwarded-For`;
// such a request is counted here, keyed by that address, instead of in `ip`.
// The pool problem MAX_REQUESTS describes does not arise: each key is one
// visitor, not every visitor behind a handful of Cloudflare egress addresses.
//
// Sized to the heaviest page the website renders. A search page makes one search
// call and up to ten `GET /datasets/:id` hydrations, eleven calls in all, so 2000
// covers about 180 such page views in a window, three a second from one address:
// more than a person produces, and the rate at which a crawler is a load problem
// for the website itself rather than for this API. The goal for this traffic,
// robots included, is that the data gets found, so the number is generous; the
// bucket stays a floor against a runaway loop, not a quota.
//
// NEVER BELOW MAX_REQUESTS. A visitor who reaches the API through the website must
// not be treated more strictly than a caller who reaches it directly, and a test
// pins the relation so raising one cap cannot silently invert it.
//
// Counted like every bucket in this file, in a fixed window (`__CounterState`):
// 2000 requests from one visitor in one window are admitted and the 2001st is
// refused until the window ends, however busy the visitor is.
const SITE_IP_MAX_REQUESTS = 2000;
// A request with neither `CF-Connecting-IP` nor a usable `X-Forwarded-For`. The
// public network cannot produce one (Cloudflare always sets the first), so it is a
// caller inside the account that did not say who it acts for: today only the
// website, if its forwarding broke. It used to get a fresh random bucket per
// request, which is no bucket at all and silently turned the limiter off for the
// strict buckets too. Now every such request shares ONE bucket per kind, so the
// failure is bounded and visible (`X-RateLimit-Bucket: site-unattributed`, and a
// log line once per window) rather than silent.
//
// The shared bucket is the whole site's traffic at once, so its cap is far above
// any one visitor's: 20,000 is about 333 requests a second, some fifty times the
// six or so a second that the 2026-10-11 production sample implies for the whole
// website (a 40 percent refusal rate at a cap of 500), and still bounds a loop. The
// strict, data and Neurobagel buckets keep their own caps for unattributed
// callers, so a broken forward on a sign-in route throttles at the strict cap,
// the same behavior the route had behind the shared egress pool (#1354), instead
// of removing the floor.
const SITE_UNATTRIBUTED_MAX_REQUESTS = 20_000;
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

/** The longest the limiter waits for the Cache API on any one call, and for a
 *  data-plane write handed no `waitUntil`. A healthy call settles in
 *  milliseconds, so the bound is only ever felt when the cache has stalled. */
const RATE_LIMIT_WRITE_STALL_MS = 500;

const WINDOW_MS = WINDOW_SIZE * 1000;

/** When a log key last spoke, and how many lines it has swallowed since. */
interface LogSlot {
  at: number;
  suppressed: number;
}

/** Module-level so it persists across requests in a warm isolate. */
const logSlots = new Map<string, LogSlot>();

/**
 * Run `emit` at most once per rate-limit window per `key`, per isolate, and hand
 * it the number of calls swallowed since the previous emission, so a line can
 * say how much it is standing for. Every log in this file that a request can
 * trigger goes through here: during a sustained fault or a flood, one line per
 * kind per minute is the ONE line worth reading, and a line per request buries
 * it. The key space is bounded by the kinds, sources and reasons below.
 */
function logOncePerWindow(key: string, emit: (suppressed: number) => void): void {
  const now = Date.now();
  const slot = logSlots.get(key);
  // A clock that went backwards ends the quiet period as well: otherwise a slot
  // stamped in the future would silence its line until the clock caught up.
  if (slot && now >= slot.at && now - slot.at < WINDOW_MS) {
    slot.suppressed++;
    return;
  }
  logSlots.set(key, { at: now, suppressed: 0 });
  emit(slot?.suppressed ?? 0);
}

/** The error's class name and nothing else. A cache key is a URL that carries the
 *  caller's address and a runtime may quote it in a message, so no message from a
 *  cache or database fault reaches the logs. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** The Cache API did not answer within the bound. Reported like any cache fault. */
class CacheStallError extends Error {
  constructor(what: string) {
    super(`cache ${what} did not settle within ${RATE_LIMIT_WRITE_STALL_MS} ms`);
    this.name = "CacheStallError";
  }
}

/**
 * Wait for a Cache API call at most `RATE_LIMIT_WRITE_STALL_MS`, then give up
 * with a {@link CacheStallError}, which every caller treats as a cache fault: the
 * limiter fails open and logs it. Without a bound a stalled `match` or `put`
 * leaves the request pending for as long as the runtime lets it, and the
 * limiter sits in front of every API request, the website's server-side renders
 * included. A call that fails after the bound is swallowed, not left unhandled.
 */
function boundedWait<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CacheStallError(what)), RATE_LIMIT_WRITE_STALL_MS);
  });
  work.catch(() => {});
  return Promise.race([work, stalled]).finally(() => clearTimeout(timer));
}

/**
 * Log a Cache API fault (the enforcement path failing open) once per window per
 * bucket kind. One fault is one outage for every request of that kind, and a
 * request-volume-scaled flood of `console.error` lines is exactly the noise that
 * makes the line worth reading harder to find. Per kind rather than global so
 * that an outage seen only by one bucket (a failing `put` on the data plane, say)
 * is not hidden behind a different bucket's line.
 */
function logCacheFault(keyKind: string, route: string | undefined, error: unknown): void {
  logOncePerWindow(`fault:${keyKind}`, (suppressed) => {
    console.error("[rate-limit] cache failure", {
      keyKind,
      ...(route === undefined ? {} : { route }),
      error: errorName(error),
      suppressed,
    });
  });
}

/** Test-only: let a test see the very next log lines again rather than waiting
 *  out a real window. Clears every once-per-window slot. */
export function __resetRateLimitLogsForTests(): void {
  logSlots.clear();
}

/** Test-only: the same reset, under the name the fault-log tests already use. */
export const __resetCacheFaultLogForTests = __resetRateLimitLogsForTests;

/** Test-only: the same reset, under the name the identity-log tests already use. */
export const __resetIdentityLogForTests = __resetRateLimitLogsForTests;

/**
 * The state of a bucket's CURRENT window, as its cache record stores it
 * (#1709, ADR 0098). The window is FIXED: it starts with the first request that
 * finds no live window and ends `WINDOW_SIZE` seconds later, and nothing that
 * happens inside it moves the end. `windowEnd` is epoch milliseconds.
 *
 * The counter used to rewrite its record with a fresh full window on every
 * allowed request, so the window slid: a pool that never went quiet for a whole
 * window was refused for about a minute after every `cap / rate` seconds, whatever
 * the cap, and that was most of the 40 percent of refusals in #1709. Now a record
 * is written back with the time that REMAINS in its window as the cache `max-age`,
 * so the cache drops it at the end and a block ends at a boundary the client can
 * compute from `Retry-After`.
 *
 * The cost of a fixed window is that a client can spend a full cap at the end of
 * one window and another at the start of the next, up to twice the cap across the
 * boundary. The cap is a floor against a runaway loop, not a quota, and the
 * sustained ceiling is the same cap per window as before; ADR 0098 records why
 * that is acceptable.
 */
export interface __CounterState {
  count: number;
  warned: boolean;
  windowEnd: number;
  /** Set when the record had to be repaired to be read; never stored. */
  damage?: __CounterDamage;
}

/** What was wrong with a record that was repaired rather than trusted. */
export type __CounterDamage = "unparseable" | "bad-count" | "bad-end";

/** How far past one window an end may lie before it is called damage and not
 *  the small difference between two isolates' clocks. It is cut to one window
 *  either way. */
const CLOCK_SKEW_TOLERANCE_MS = 5000;

function freshWindow(now: number): __CounterState {
  return { count: 0, warned: false, windowEnd: now + WINDOW_MS };
}

/**
 * The state a cache record means at time `now`. `data` is the parsed record, or
 * undefined when there is none.
 *
 *  - No record, or one whose window has ended (the cache had not dropped it yet):
 *    a new window.
 *  - A record from before windows were stored (`{count, warned}` only) has an end
 *    nobody wrote down, but its entry cannot outlive a window from its last write,
 *    so a full window from now is an upper bound for what a client is told, and the
 *    entry's own expiry still clears it.
 *  - An end further away than one window is cut to one window, so no record can
 *    hold a bucket shut for longer than that.
 *  - A count that is not a finite number above zero is zero.
 *
 * A record that is not an object, a count that is not a whole number above or at
 * zero, and an end that is not a number or lies more than a few seconds past one
 * window are repaired as above and also reported in `damage`, so the caller can
 * say so: the bucket heals itself, and nobody learns that something wrote a bad
 * record unless it is told.
 */
export function __readCounter(data: unknown, now: number): __CounterState {
  if (data === undefined) return freshWindow(now);
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ...freshWindow(now), damage: "unparseable" };
  }
  const record = data as { count?: unknown; warned?: unknown; windowEnd?: unknown };
  const rawCount = record.count;
  const count =
    typeof rawCount === "number" && Number.isFinite(rawCount) && rawCount > 0
      ? Math.floor(rawCount)
      : 0;
  const countDamaged = typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 0;
  const warned = record.warned === true;
  const end = record.windowEnd;
  if (end === undefined) {
    return {
      count,
      warned,
      windowEnd: now + WINDOW_MS,
      ...(countDamaged ? { damage: "bad-count" as const } : {}),
    };
  }
  if (typeof end === "number" && Number.isFinite(end)) {
    if (end <= now) return freshWindow(now);
    const damage = countDamaged
      ? ("bad-count" as const)
      : end > now + WINDOW_MS + CLOCK_SKEW_TOLERANCE_MS
        ? ("bad-end" as const)
        : undefined;
    return {
      count,
      warned,
      windowEnd: Math.min(end, now + WINDOW_MS),
      ...(damage ? { damage } : {}),
    };
  }
  return {
    count,
    warned,
    windowEnd: now + WINDOW_MS,
    damage: countDamaged ? "bad-count" : "bad-end",
  };
}

/** Whole seconds left in the window, at least 1 and at most one window. */
function secondsLeft(state: __CounterState, now: number): number {
  return Math.min(WINDOW_SIZE, Math.max(1, Math.ceil((state.windowEnd - now) / 1000)));
}

/** The record to store: the state, expiring with its window rather than a full one. */
function counterRecord(state: __CounterState, now: number): Response {
  return new Response(
    JSON.stringify({ count: state.count, warned: state.warned, windowEnd: state.windowEnd }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `max-age=${secondsLeft(state, now)}`,
      },
    },
  );
}

/**
 * Read a bucket's record. A record that will not parse or will not make sense is
 * repaired, not trusted and not failed open on, and the repair is logged once per
 * window per bucket kind and kind of damage: the self-heal is right, a silent one
 * would hide whatever is writing bad records.
 */
async function readCounterRecord(
  cached: Response | undefined,
  now: number,
  keyKind: string,
): Promise<__CounterState> {
  if (!cached) return freshWindow(now);
  let data: unknown;
  try {
    data = await cached.json();
  } catch {
    data = null;
  }
  const state = __readCounter(data, now);
  if (state.damage) {
    const damage = state.damage;
    logOncePerWindow(`damage:${keyKind}:${damage}`, (suppressed) => {
      console.warn("[rate-limit] repaired a damaged counter record", {
        keyKind,
        damage,
        suppressed,
      });
    });
  }
  return state;
}

/** The 429 every counter in this file answers with: the same body and headers
 *  whichever bucket tripped, `Retry-After` and `X-RateLimit-Reset` agreeing with
 *  the window, and only `X-RateLimit-Bucket` telling the buckets apart.
 *  `X-RateLimit-Caller` says how the caller was identified (`edge`, `site` or
 *  `unattributed`) whichever bucket it landed in. */
function refusal(
  kind: string,
  maxRequests: number,
  state: __CounterState,
  now: number,
  caller?: __CallerSource,
): { body: Record<string, unknown>; headers: Record<string, string> } {
  const retryAfter = secondsLeft(state, now);
  return {
    body: {
      error: "Rate limit exceeded",
      message: `Too many requests. Please try again in ${retryAfter} seconds.`,
      retry_after: retryAfter,
    },
    headers: {
      "Retry-After": retryAfter.toString(),
      "X-RateLimit-Limit": maxRequests.toString(),
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": Math.ceil(state.windowEnd / 1000).toString(),
      "X-RateLimit-Bucket": kind,
      ...(caller === undefined ? {} : { "X-RateLimit-Caller": caller }),
    },
  };
}

/** One line per window per bucket kind for the refusals, so `wrangler tail` can
 *  show that a bucket is refusing and how often. Never an address. */
function logRefusal(keyKind: string, maxRequests: number, retryAfter: number): void {
  logOncePerWindow(`refusal:${keyKind}`, (suppressed) => {
    console.warn("[rate-limit] refusing", { keyKind, maxRequests, retryAfter, suppressed });
  });
}

/**
 * Set headers on the response a handler produced. A handler that returns its own
 * `Response` replaces the one the context was building, and the headers of a
 * `Response` from `fetch()` or `Response.redirect()` are immutable, so when the
 * first write is refused the response is rebuilt from itself, which makes them
 * writable, and written again.
 */
function stampHeaders(c: RateLimitContext, headers: Record<string, string>): void {
  const apply = (res: Response) => {
    for (const [name, value] of Object.entries(headers)) res.headers.set(name, value);
  };
  try {
    apply(c.res);
  } catch {
    c.res = new Response(c.res.body, c.res);
    apply(c.res);
  }
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
 *  - `ip` for everything else (the unauthenticated cap), or, for a caller
 *    without `CF-Connecting-IP`, `site-ip` (the visitor it forwarded) or
 *    `site-unattributed` (nobody named). The `ip` argument is the caller key
 *    from {@link __readCallerIdentity} and `source` is its source.
 *
 * Admin endpoints used to be entirely exempt; that gave an admin
 * running a malformed loop unbounded access to the worker. Keeping the
 * limit but raising the cap for authenticated buckets preserves the
 * floor without the floor being absent.
 */
export interface __BucketSelection {
  keyKind:
    | "auth-ip"
    | "ip"
    | "site-ip"
    | "site-unattributed"
    | "token"
    | "data-ip"
    | "neurobagel-ip";
  /** Pre-hash key material: the caller key (see {@link __CallerIdentity}), or the raw bearer token. */
  rawKey: string;
  maxRequests: number;
}

/**
 * How a request came to carry (or not carry) an address (#1709, ADR 0098).
 *
 *  - `edge`: it has `CF-Connecting-IP`. Cloudflare sets that header on every
 *    request that arrives from the public network and a client cannot omit or
 *    replace it, so it is the caller's address and `X-Forwarded-For` is never
 *    looked at. This is the only source a public caller can have.
 *  - `site`: no `CF-Connecting-IP`, and `X-Forwarded-For` starts with a valid IP
 *    literal. A request through a service binding does not arrive from the
 *    public network, so it carries no `CF-Connecting-IP` unless its caller sets
 *    one; the Cloudflare account is the trust boundary (ADR 0078), and the
 *    caller names the visitor it acts for. The caller must SET the header from
 *    its own `CF-Connecting-IP`, never pass a visitor's header through.
 *  - `unattributed`: neither. Not reachable from the public network.
 */
export type __CallerSource = "edge" | "site" | "unattributed";

/** A caller's source and its bucket key. The key is the address itself for an
 *  `edge` caller, `site:<address>` for a `site` caller, and a fixed word for an
 *  `unattributed` one. The prefix puts every site key in a keyspace of its own,
 *  so it cannot collide with a real address (no IP literal starts with `s`,
 *  which is not a hex digit), and the fixed word cannot be an address either.
 *  An `unattributed` caller also says why, for the log and never the response. */
export interface __CallerIdentity {
  source: __CallerSource;
  key: string;
  detail?: __UnattributedDetail;
}

/** Why `X-Forwarded-For` named nobody. None of it is the value itself. */
export type __UnattributedReason =
  | "absent"
  | "too-long"
  | "first-entry-not-an-ip"
  | "unspecified-or-loopback";

export interface __UnattributedDetail {
  reason: __UnattributedReason;
  /** Length of the header, 0 when absent. */
  forwardedLength: number;
  /** For `first-entry-not-an-ip`, a coarse class of what the first entry looked like. */
  shape?: string;
}

export type __ForwardedParse = { ok: true; ip: string } | ({ ok: false } & __UnattributedDetail);

const SITE_KEY_PREFIX = "site:";
const UNATTRIBUTED_KEY = "unattributed";
/** A longer `X-Forwarded-For` is not read at all: a forwarding hop sets one address. */
const MAX_FORWARDED_HEADER_LENGTH = 512;
/** The longest textual IP literal: eight groups, or an IPv4-mapped form, is 45 characters. */
const MAX_IP_LITERAL_LENGTH = 45;
/** Dotted-quad with each octet 0 to 255 and no leading zero, which some parsers read as octal. */
const IPV4_LITERAL_RE =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
/** What the URL parser makes of an IPv4-mapped IPv6 address: two hex groups after `::ffff:`. */
const MAPPED_IPV4_RE = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/**
 * An IP literal in canonical form, or null. IPv4 is matched strictly. IPv6 is
 * validated and compressed by the URL parser, so `2001:DB8:0:0::1` and
 * `2001:db8::1` are one key, and an IPv4-mapped address is turned back into the
 * dotted address it wraps, so `::ffff:203.0.113.7` and `203.0.113.7` are one
 * visitor too. Anything else (a host name, a port, brackets, a zone id, an
 * over-long string, `unknown`) is null.
 *
 * The 45-character bound and the character pre-check say nothing the URL parser
 * would not also refuse; they keep the parser from ever seeing an arbitrary
 * string, which is the point of having them.
 */
function canonicalIpLiteral(candidate: string): string | null {
  if (candidate.length === 0 || candidate.length > MAX_IP_LITERAL_LENGTH) return null;
  if (IPV4_LITERAL_RE.test(candidate)) return candidate;
  if (!candidate.includes(":") || !/^[0-9a-fA-F:.]+$/.test(candidate)) return null;
  let canonical: string;
  try {
    canonical = new URL(`http://[${candidate}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const mapped = MAPPED_IPV4_RE.exec(canonical);
  if (!mapped) return canonical;
  const high = Number.parseInt(mapped[1] as string, 16);
  const low = Number.parseInt(mapped[2] as string, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** The addresses a forwarding caller writes when it has no visitor to name: this host
 *  and this machine. Counting thousands of visitors in one `site:` key would be a
 *  silent bucket of everyone, so they are treated as no address at all. */
function isUnspecifiedOrLoopback(ip: string): boolean {
  return ip === "0.0.0.0" || ip === "::" || ip === "::1" || ip.startsWith("127.");
}

/** A coarse class of an entry that is not an address, never the entry. */
function shapeOf(entry: string): string {
  if (entry === "") return "empty";
  if (/[[\]]/.test(entry)) return "bracketed";
  if (entry.includes("%")) return "zone-id";
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(entry)) return "ipv4-with-port";
  if (/^[0-9a-fA-F:.]+$/.test(entry))
    return entry.includes(":") ? "malformed-ipv6" : "malformed-ipv4";
  if (/^[A-Za-z_-]+$/.test(entry)) return "word";
  return "other";
}

/**
 * Read the first entry of an `X-Forwarded-For` value: its canonical address, or
 * the reason there is none. Only the first entry is read, and an unreadable one
 * is not skipped to reach a later one.
 */
export function __parseForwardedFor(header: string | null | undefined): __ForwardedParse {
  if (!header) return { ok: false, reason: "absent", forwardedLength: 0 };
  const forwardedLength = header.length;
  if (forwardedLength > MAX_FORWARDED_HEADER_LENGTH) {
    return { ok: false, reason: "too-long", forwardedLength };
  }
  const comma = header.indexOf(",");
  const first = (comma < 0 ? header : header.slice(0, comma)).trim();
  const ip = canonicalIpLiteral(first);
  if (ip === null) {
    return { ok: false, reason: "first-entry-not-an-ip", forwardedLength, shape: shapeOf(first) };
  }
  if (isUnspecifiedOrLoopback(ip)) {
    return { ok: false, reason: "unspecified-or-loopback", forwardedLength };
  }
  return { ok: true, ip };
}

/** The first entry of an `X-Forwarded-For` value as a canonical address, or null. */
export function __firstForwardedIp(header: string | null | undefined): string | null {
  const parsed = __parseForwardedFor(header);
  return parsed.ok ? parsed.ip : null;
}

/**
 * The trust rule, in one place. `CF-Connecting-IP` wins whenever it is present
 * and `X-Forwarded-For` is then ignored; the forwarded address is read only when
 * it is absent.
 */
export function __readCallerIdentity(
  cfConnectingIp: string | null | undefined,
  xForwardedFor: string | null | undefined,
): __CallerIdentity {
  if (cfConnectingIp) return { source: "edge", key: cfConnectingIp };
  const parsed = __parseForwardedFor(xForwardedFor);
  if (parsed.ok) return { source: "site", key: `${SITE_KEY_PREFIX}${parsed.ip}` };
  const { ok: _ok, ...detail } = parsed;
  return { source: "unattributed", key: UNATTRIBUTED_KEY, detail };
}

/** The identity of a request. Shared by the middleware and the per-route budgets. */
function callerIdentityOf(headers: { get(name: string): string | null }): __CallerIdentity {
  return __readCallerIdentity(headers.get("CF-Connecting-IP"), headers.get("X-Forwarded-For"));
}

/**
 * One line per isolate per window for each (caller source, bucket kind) that is
 * not an ordinary public request. It is the way to see, with `wrangler tail`,
 * that the website's calls arrive as `site` (the property ADR 0098 rests on and
 * cannot prove before production), and to be told when a caller stops forwarding
 * a visitor, on whichever bucket that happens. An unattributed line says why,
 * by reason, header length and a coarse shape. Never per request, and never an
 * address or the value of a header.
 */
function logIdentityOnce(
  caller: __CallerIdentity,
  keyKind: string,
  maxRequests: number,
  path: string,
): void {
  if (caller.source === "edge") return;
  logOncePerWindow(`identity:${caller.source}:${keyKind}`, (suppressed) => {
    if (caller.source === "site") {
      console.log(
        "[rate-limit] counting a request without CF-Connecting-IP by its forwarded visitor",
        { keyKind, maxRequests, path, suppressed },
      );
    } else {
      console.warn(
        "[rate-limit] request with neither CF-Connecting-IP nor a usable X-Forwarded-For; counted in a shared bucket",
        { keyKind, maxRequests, path, suppressed, ...caller.detail },
      );
    }
  });
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
  source: __CallerSource = "edge",
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
  // The anonymous bucket, by how the caller was identified (#1709, ADR 0098).
  // `ip` here is the caller key, so a `site` or `unattributed` caller never
  // shares a counter with a real address. The strict, data and Neurobagel
  // buckets above keep their own caps for every source; only this one, whose
  // cap exists to be generous to the website, differs.
  if (source === "site") {
    return { keyKind: "site-ip", rawKey: ip, maxRequests: SITE_IP_MAX_REQUESTS };
  }
  if (source === "unattributed") {
    return {
      keyKind: "site-unattributed",
      rawKey: ip,
      maxRequests: SITE_UNATTRIBUTED_MAX_REQUESTS,
    };
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
    const cached = await boundedWait(cache.match(cacheKey), "match");
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
    await boundedWait(
      cache.put(
        cacheKey,
        new Response(JSON.stringify({ admin }), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `max-age=${ttl}`,
          },
        }),
      ),
      "put",
    );
    return admin;
  } catch (err) {
    logOncePerWindow("admin-flag", (suppressed) => {
      console.warn("[rate-limit] admin-flag lookup failed", { error: errorName(err), suppressed });
    });
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
  // Who this request's address names. `CF-Connecting-IP` decides whenever it is
  // present and `X-Forwarded-For` is then never read, so a client cannot choose
  // its bucket; see `__CallerSource`. A request with neither used to get a random
  // UUID, a fresh bucket each time, which is no limit at all; it now shares one.
  const caller = __readCallerIdentity(
    c.req.header("CF-Connecting-IP"),
    c.req.header("X-Forwarded-For"),
  );

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
    caller.key,
    caller.source,
  );
  logIdentityOnce(caller, keyKind, maxRequests, path);

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
    await next();
    stampHeaders(c, { "X-RateLimit-Bucket": "admin-bypass" });
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
      await boundedWait(write, "put");
      return;
    }
    const defer = dataPlaneDefer();
    if (defer) {
      defer(write.catch((err: unknown) => logCacheFault(keyKind, path, err)));
      return;
    }
    // No execution context -- a route test driving the app directly, per
    // `routes/data.ts`'s `deferOf` fallback. Bound the wait so a stalled
    // cache double cannot hang the request, mirroring
    // `git-file-cache.ts`'s own no-`waitUntil` fallback: a healthy write
    // settles in microtasks, so this bound is never felt in practice, and
    // it keeps the count observable to a test that awaits the response.
    try {
      await boundedWait(write, "put");
    } catch (err) {
      logCacheFault(keyKind, path, err);
    }
  }

  // The headers this request's answer will carry, decided here and applied after
  // the handler ran: a handler that builds its own `Response` replaces anything
  // set on the context before it, so setting them first would lose them.
  let stamp: Record<string, string> | undefined;

  try {
    const cache = caches.default;

    // The bucket's current window: its count and (for the observe-only path)
    // whether it already warned once. Read after the cache lookup, because a
    // Worker's clock only moves at I/O.
    const cached = await boundedWait(cache.match(cacheKey), "match");
    const now = Date.now();
    const state = await readCounterRecord(cached, now, keyKind);
    const count = state.count;
    let warned = state.warned;

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
      const observed = { ...state, count: count + 1, warned };
      await writeCount(cache.put(cacheKey, counterRecord(observed, now)));
    } else if (count >= maxRequests) {
      const refused = refusal(keyKind, maxRequests, state, now, caller.source);
      logRefusal(keyKind, maxRequests, refused.body.retry_after as number);
      return c.json(refused.body, 429, refused.headers);
    } else {
      // Increment the counter. The record keeps the window's original end and
      // expires with it; a refused request above writes nothing.
      const newCount = count + 1;
      await writeCount(cache.put(cacheKey, counterRecord({ ...state, count: newCount }, now)));
      stamp = {
        "X-RateLimit-Limit": maxRequests.toString(),
        "X-RateLimit-Remaining": (maxRequests - newCount).toString(),
        "X-RateLimit-Bucket": keyKind,
        "X-RateLimit-Caller": caller.source,
      };
    }
  } catch (error) {
    // Fail open so a cache outage doesn't block all traffic, but emit a
    // structured log (once per window per bucket kind per isolate, see
    // `logCacheFault`) so Workers tail / log tooling surfaces the issue.
    // TODO(#478): replace with Sentry captureException once DSN is wired.
    logCacheFault(keyKind, path, error);
  }

  await next();
  if (stamp) stampHeaders(c, stamp);
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
 * Mirrors `rateLimiter`'s own mechanics: the same fixed-window Cache API
 * counter (`__CounterState`; its `warned` flag is unused, there being no
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
  // The same identity the middleware uses, so a visitor forwarded by the website
  // is charged to their own miss budget and an unattributed caller to one shared
  // budget, not to a fresh random one.
  const caller = callerIdentityOf(request.headers);
  return consumeKeyedBudget(
    env,
    request,
    {
      kind: DATA_MISS_BUCKET_KIND,
      key: caller.key,
      maxRequests: DATA_MISS_MAX_REQUESTS,
      caller: caller.source,
    },
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
 * which account a session names). Mirrors `rateLimiter`'s own mechanics: the
 * same fixed-window Cache API counter (`__CounterState`, read and written by the
 * same functions), the same dev-environment and `X-Test-Bypass`
 * exemptions, the same fail-open on a cache outage, and the same
 * `waitUntil`-deferred write with the bounded no-context fallback.
 */
async function consumeKeyedBudget(
  env: Pick<Bindings, "ENVIRONMENT" | "TEST_BYPASS_TOKEN">,
  request: Request,
  bucket: { kind: string; key: string; maxRequests: number; caller?: __CallerSource },
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
    const cached = await boundedWait(cache.match(cacheKey), "match");
    const now = Date.now();
    const state = await readCounterRecord(cached, now, bucket.kind);

    if (state.count >= bucket.maxRequests) {
      const refused = refusal(bucket.kind, bucket.maxRequests, state, now, bucket.caller);
      logRefusal(bucket.kind, bucket.maxRequests, refused.body.retry_after as number);
      return {
        allowed: false,
        response: new Response(JSON.stringify(refused.body), {
          status: 429,
          headers: { "Content-Type": "application/json", ...refused.headers },
        }),
      };
    }

    const write = cache.put(cacheKey, counterRecord({ ...state, count: state.count + 1 }, now));
    if (waitUntil) {
      waitUntil(write.catch((err: unknown) => logCacheFault(bucket.kind, undefined, err)));
    } else {
      try {
        await boundedWait(write, "put");
      } catch (err) {
        logCacheFault(bucket.kind, undefined, err);
      }
    }
    return { allowed: true };
  } catch (error) {
    // Fail open, the same policy `rateLimiter` itself follows on a cache
    // outage: a broken Cache API must not block traffic. Logged the same way,
    // once per window per bucket kind.
    logCacheFault(bucket.kind, undefined, error);
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
  SITE_IP_MAX_REQUESTS,
  SITE_UNATTRIBUTED_MAX_REQUESTS,
  DATA_MAX_REQUESTS,
  DATA_MISS_MAX_REQUESTS,
  NEUROBAGEL_MAX_REQUESTS,
  PRIVATE_GRANT_MAX_REQUESTS,
  WINDOW_SIZE,
};
