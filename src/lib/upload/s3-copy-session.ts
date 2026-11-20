/**
 * Bounded-batch planning and STS lease metadata for uploads.
 *
 * The orchestration and retry decisions live in `copyAnnexedToRemote`, where
 * every retry can be checked against git-annex's actual location log. Keeping
 * that check at the caller prevents JSON record counts from being mistaken for
 * durable upload progress.
 */

import { ApiError } from "../api/errors.js";
import type { S3Credentials } from "../git-annex/s3-remote.js";

/** Credentials plus the wall-clock instant (ms) they stop working. */
export interface CredentialLease {
  credentials: S3Credentials;
  expiresAtMs: number;
}

/** Refresh before the remaining lease cannot cover this margin and one batch. */
export const DEFAULT_REFRESH_MARGIN_MS = 20 * 60 * 1000;
/** Batch bounds keep a long upload resumable without changing git-annex's own job count. */
export const DEFAULT_BATCH_MAX_FILES = 200;
export const DEFAULT_BATCH_MAX_BYTES = 50 * 1024 ** 3;
/** Upper bound on credential renewals in one upload (~2 h each). */
export const DEFAULT_MAX_REFRESHES = 48;
/**
 * Tries of ONE credential renewal before the upload gives up. Renewal starts
 * `DEFAULT_REFRESH_MARGIN_MS` (20 min) plus the longest batch before expiry, so
 * the waits between tries (5, 10, 20, 40, then 60 s: about 4 min in all) fit
 * inside the lease that is still valid.
 */
export const RENEW_ATTEMPTS = 8;
/** First wait between renewal tries; it doubles each try, up to `RENEW_RETRY_MAX_DELAY_MS`. */
export const RENEW_RETRY_DELAY_MS = 5_000;
export const RENEW_RETRY_MAX_DELAY_MS = 60_000;

/**
 * Whether a failed renewal is worth trying again: no answer (statusCode 0), a
 * timeout (408), rate limiting (429) or a server error (5xx). One HTTP 500 from
 * `POST /datasets/:id/upload-credentials` used to end an upload of many hours.
 * Anything else (401, 403, 404, ...) is the server's real answer and is final.
 */
export function isTransientRenewError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const status = error.statusCode;
  return status === 0 || status === 408 || status === 429 || (status >= 500 && status < 600);
}

/**
 * The wait after renewal try `attempt` (1-based). `NEMAR_RENEW_RETRY_DELAY_MS`, a
 * whole number of milliseconds, can only SHORTEN the first wait (tests use 0); any
 * other value leaves the default.
 */
export function renewRetryDelayMs(attempt: number): number {
  const raw = process.env.NEMAR_RENEW_RETRY_DELAY_MS;
  let base = RENEW_RETRY_DELAY_MS;
  if (raw !== undefined && /^\d+$/.test(raw)) {
    const ms = Number(raw);
    if (Number.isSafeInteger(ms) && ms <= RENEW_RETRY_DELAY_MS) base = ms;
  }
  return Math.min(base * 2 ** (attempt - 1), RENEW_RETRY_MAX_DELAY_MS);
}

/** Stop after repeated expired-credential retries without a smaller pending set. */
export const MAX_FRUITLESS_REFRESHES = 2;
/** Conservative lease when the server omits an expiration timestamp. */
const FALLBACK_LEASE_MS = 55 * 60 * 1000;

/**
 * Lease from an upload-credentials response. A missing or unparseable
 * expiration falls back to 55 minutes, rather than trusting the 2 h maximum.
 */
export function leaseFromResponse(
  credentials: S3Credentials,
  expiration: string | undefined,
  nowMs = Date.now(),
): CredentialLease {
  const parsed = expiration ? Date.parse(expiration) : Number.NaN;
  const expiresAtMs = Number.isFinite(parsed) ? parsed : nowMs + FALLBACK_LEASE_MS;
  return { credentials, expiresAtMs };
}

/** Split paths in order, bounded by count and known total bytes. */
export function planCopyBatches(
  paths: string[],
  sizes: Map<string, number>,
  bounds: { maxFiles?: number; maxBytes?: number } = {},
): string[][] {
  const maxFiles = bounds.maxFiles ?? DEFAULT_BATCH_MAX_FILES;
  const maxBytes = bounds.maxBytes ?? DEFAULT_BATCH_MAX_BYTES;
  const batches: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const size = sizes.get(path);
    if (size === undefined) {
      // A legacy annexed path can be absent from today's data-file inventory.
      // Unknown is not zero: isolate it so it cannot share a lease batch with
      // another file whose transfer size is also unknown.
      if (current.length > 0) {
        batches.push(current);
        current = [];
        bytes = 0;
      }
      batches.push([path]);
      continue;
    }
    if (current.length > 0 && (current.length >= maxFiles || bytes + size > maxBytes)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(path);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** git-annex / S3 wording for credentials that stopped working mid-copy. */
export function isExpiredCredentialError(message: string | undefined): boolean {
  if (!message) return false;
  return /ExpiredToken|RequestExpired|token (has|is) expired|security token included in the request is (expired|invalid)|InvalidToken|InvalidAccessKeyId/i.test(
    message,
  );
}
