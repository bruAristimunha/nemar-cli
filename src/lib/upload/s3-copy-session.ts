/**
 * Bounded-batch planning and STS lease metadata for uploads.
 *
 * The orchestration and retry decisions live in `copyAnnexedToRemote`, where
 * every retry can be checked against git-annex's actual location log. Keeping
 * that check at the caller prevents JSON record counts from being mistaken for
 * durable upload progress.
 */

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
