/**
 * Server-side S3 copy for OpenNeuro -> NEMAR import (Phase 1, #750).
 *
 * Replaces the old `curl '<openneuro-url>' | aws s3 cp - '<nemar-uri>'`
 * client-stream (which routed every byte through the GitHub runner and blew
 * the 6h job cap on multi-TB datasets) with `aws s3 cp s3://openneuro.org/...
 * s3://nemar/...` server-side copies that stay on AWS's backbone, plus:
 *   - resume: skip objects already present at the destination
 *   - sharding: deterministic key partitioning so one dataset's transfer
 *     parallelises across matrix jobs
 *   - per-object fallback to the old curl-stream only when a server-side copy
 *     genuinely fails (e.g. an access-restricted object)
 *
 * Verified 2026-06-15: signed cross-account read of OpenNeuro's public bucket
 * works, and `aws s3 cp` with `--source-region us-east-1 --region us-east-2`
 * does a real cross-region server-side copy (bytes never touch the runner).
 */

import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { annexKeyDeclaredSize, isKeyPresentAtDeclaredSize } from "../../shared/annex-key.js";
import { runCommand } from "./git-annex/run-command.js";

// Re-exported from shared/annex-key.ts so existing importers keep their path.
export { annexKeyDeclaredSize, isKeyPresentAtDeclaredSize };

/** A parsed S3 location. `region` is undefined when the URL didn't encode one. */
export interface S3Ref {
  bucket: string;
  key: string;
  region?: string;
}

/** One file to copy: its annex key, parsed S3 source (null when the whereis URL
 *  wasn't an S3 endpoint — then only the curl fallback can copy it), the raw
 *  whereis URL (kept for the fallback), and the NEMAR destination URI. */
export interface CopyItem {
  key: string;
  source: S3Ref | null;
  httpUrl: string | null;
  destUri: string;
}

/**
 * The keys a tree names that the bucket cannot account for (#1396).
 *
 * The publish gate asks this of the TREE, not of the import manifest. A manifest
 * is what the copy phase believed it transferred, so verifying the manifest
 * against the bucket passes whenever the manifest is the subset that worked --
 * which is how sixteen datasets were published referencing 12,039 keys that were
 * never transferred, with the location log advertising every one of them.
 */
export function keysWithoutObjects(
  treeKeys: Iterable<string>,
  existing: Map<string, number>,
): string[] {
  return [...treeKeys].filter((key) => !isKeyPresentAtDeclaredSize(key, existing));
}

/**
 * The share of a dataset's DATA a reader can actually obtain, 0 to 1 (ADR 0064).
 *
 * Data only. Metadata is never annexed (ADR 0015), so `.tsv`, `.json` and `README*`
 * arrive from GitHub whether or not one recording survived, and counting them puts
 * every dataset near 100%: `on008017` is missing 4.7% of its tracked files and 21.6%
 * of its data. The denominator is therefore the distinct annex keys the tree names.
 *
 * A dataset with no annexed keys at all is 1, not 0. It is metadata-only, which is a
 * complete dataset of its kind, and dividing by zero to call it wholly unavailable
 * would withdraw it.
 */
export function dataAvailability(state: {
  annexed: string[];
  missingContent: string[];
}): number {
  if (state.annexed.length === 0) return 1;
  return (state.annexed.length - state.missingContent.length) / state.annexed.length;
}

/**
 * Below this share of its data available, a dataset is withdrawn (ADR 0064).
 *
 * Measured AFTER recovery has reported what it cannot get. On 2026-09-15 three datasets
 * that were not already withdrawn sat under this threshold in the morning and were whole
 * by the afternoon, and six more came off the withdrawn list the same day, so a verdict
 * read from a stale column would have tombstoned content that exists.
 */
export const MIN_DATA_AVAILABILITY = 0.9;

/**
 * Max size (bytes) `curlStreamCopy` will buffer to the runner's local disk.
 * The curl fallback downloads the whole object locally so it can be verified
 * before upload (#967); this domain has recordings up to ~300GB, and GitHub
 * runners only have ~14GB of local disk, so above this limit we refuse the
 * fallback outright rather than risk ENOSPC. An object this large needs a
 * large-disk/manual remediation path instead (Phase 5).
 */
const MAX_FALLBACK_BUFFER_BYTES = 5 * 1024 * 1024 * 1024; // 5GB

/**
 * Concurrency cap on the curl-fallback download specifically, independent of
 * the outer batch/server-side-copy concurrency. Server-side copies never
 * touch local disk, so they can safely run at the full `COPY_CONCURRENCY`;
 * the curl fallback buffers a whole object to disk first, so running many of
 * those in parallel (e.g. when OpenNeuro systematically 403s a whole shard)
 * risks exhausting the runner's disk even with the per-object size guard
 * above (#967).
 */
const CURL_FALLBACK_CONCURRENCY = 3;

/**
 * Minimal counting semaphore: `acquire()` resolves once a slot is free,
 * `release()` frees it. Used to bound concurrent curl-fallback downloads
 * without touching the outer batch's concurrency.
 */
function createSemaphore(limit: number): { acquire: () => Promise<void>; release: () => void } {
  let active = 0;
  const queue: Array<() => void> = [];
  return {
    acquire(): Promise<void> {
      if (active < limit) {
        active++;
        return Promise.resolve();
      }
      return new Promise((resolve) => queue.push(resolve));
    },
    release(): void {
      const next = queue.shift();
      if (next) {
        next();
      } else {
        active--;
      }
    },
  };
}

function decodeKey(key: string): string {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

/**
 * Parse an S3 HTTP(S) URL or an `s3://` URI into {bucket, key, region?}.
 * Returns null for anything that isn't an S3 endpoint so the caller can route
 * it to the curl fallback. Handles:
 *   - s3://<bucket>/<key>
 *   - https://s3.amazonaws.com/<bucket>/<key>           (path-style)
 *   - https://s3.<region>.amazonaws.com/<bucket>/<key>  (path-style, regioned)
 *   - https://<bucket>.s3.amazonaws.com/<key>           (virtual-hosted)
 *   - https://<bucket>.s3.<region>.amazonaws.com/<key>  (virtual-hosted, regioned)
 *   - https://<bucket>.s3-<region>.amazonaws.com/<key>  (legacy dash form)
 */
export function parseS3Url(url: string): S3Ref | null {
  if (!url) return null;

  if (url.startsWith("s3://")) {
    const rest = url.slice("s3://".length);
    const slash = rest.indexOf("/");
    if (slash < 0) return null;
    const bucket = rest.slice(0, slash);
    const key = rest.slice(slash + 1);
    if (!bucket || !key) return null;
    return { bucket, key: decodeKey(key) };
  }

  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname;
  if (!host.endsWith(".amazonaws.com")) return null;

  const labels = host.split(".");
  const s3idx = labels.findIndex((l) => l === "s3" || l.startsWith("s3-"));
  if (s3idx === -1) return null;
  const path = u.pathname.replace(/^\//, "");

  if (s3idx === 0) {
    // path-style: s3[.<region>].amazonaws.com/<bucket>/<key>
    // labels = ["s3", "amazonaws", "com"] or ["s3", "<region>", "amazonaws", "com"]
    const region = labels.length === 4 ? labels[1] : undefined;
    const slash = path.indexOf("/");
    if (slash < 0) return null;
    const bucket = path.slice(0, slash);
    const key = path.slice(slash + 1);
    if (!bucket || !key) return null;
    return { bucket, key: decodeKey(key), region };
  }

  // virtual-hosted: <bucket>.s3[.<region>].amazonaws.com/<key>
  const bucket = labels.slice(0, s3idx).join(".");
  const s3label = labels[s3idx];
  let region: string | undefined;
  if (s3label.startsWith("s3-")) {
    region = s3label.slice("s3-".length);
  } else if (labels[s3idx + 1] && labels[s3idx + 1] !== "amazonaws") {
    region = labels[s3idx + 1];
  }
  if (!bucket || !path) return null;
  return { bucket, key: decodeKey(path), region };
}

/**
 * Server-side copy of one object: `aws s3 cp s3://src s3://dst` with explicit
 * source+dest regions (avoids a GetBucketLocation round-trip and the perms it
 * needs). Bytes flow on AWS's backbone, never through this process.
 */
export async function serverSideS3Copy(
  source: S3Ref,
  destUri: string,
  destRegion: string,
): Promise<{ success: boolean; error?: string }> {
  const sourceUri = `s3://${source.bucket}/${source.key}`;
  const result = await runCommand(
    [
      "aws",
      "s3",
      "cp",
      sourceUri,
      destUri,
      "--source-region",
      source.region ?? "us-east-1",
      "--region",
      destRegion,
      "--only-show-errors",
    ],
    {},
  );
  if (result.exitCode !== 0) {
    return { success: false, error: result.stderr.trim() || `aws exit ${result.exitCode}` };
  }
  return { success: true };
}

/**
 * Curl-stream fallback (the pre-#750 mechanism): download from the public
 * HTTP source to a local temp file, then `aws s3 cp` that file up. Only used
 * when a server-side copy fails AND a raw HTTP URL is available. Routes every
 * byte through the runner, so it's a last resort.
 *
 * #967: this used to pipe `curl | aws s3 cp -` directly. A curl failure mid-
 * stream (e.g. OpenNeuro 403ing partway through) still let `aws s3 cp -` read
 * an empty stdin and PUT a valid, successful 0-byte object -- `pipefail`
 * caught curl's exit code and the caller correctly reported the item as
 * failed, but the corrupt blob was already in S3 and every downstream check
 * only verified key presence, not size. Downloading to a temp file first lets
 * us verify the bytes are actually there (non-empty, and matching the size
 * declared in the annex key when the key encodes one) BEFORE anything is
 * uploaded, so a failed fetch uploads nothing at all. Refuses up front (no
 * download attempted) when the declared size exceeds the local-disk buffer
 * limit -- see `MAX_FALLBACK_BUFFER_BYTES`.
 */
export async function curlStreamCopy(
  sourceUrl: string,
  destUri: string,
  region: string,
): Promise<{ success: boolean; error?: string }> {
  const declaredSize = annexKeyDeclaredSize(destUri);
  if (declaredSize !== null && declaredSize > MAX_FALLBACK_BUFFER_BYTES) {
    return {
      success: false,
      error: `declared size ${declaredSize} bytes exceeds the ${MAX_FALLBACK_BUFFER_BYTES}-byte runner-buffered-fallback limit; needs large-disk/manual copy`,
    };
  }
  const dir = mkdtempSync(join(tmpdir(), "nemar-curl-"));
  const tempFile = join(dir, "blob");
  try {
    const curlResult = await runCommand(["curl", "-sfL", "-o", tempFile, sourceUrl], {});
    if (curlResult.exitCode !== 0) {
      return {
        success: false,
        error: curlResult.stderr.trim() || `curl exit ${curlResult.exitCode}`,
      };
    }
    const actualSize = existsSync(tempFile) ? statSync(tempFile).size : 0;
    // A 0-byte actual size is fine when the annex key legitimately declares 0
    // bytes (a real empty annexed file, declaredSize === 0); any other case
    // (no declared size, or a positive one) means curl/the source served
    // nothing and must be rejected before the upload step.
    if (actualSize === 0 && declaredSize !== 0) {
      return { success: false, error: "curl produced an empty file (0 bytes)" };
    }
    if (declaredSize !== null && actualSize !== declaredSize) {
      return {
        success: false,
        error: `downloaded ${actualSize} bytes but the annex key declares ${declaredSize}`,
      };
    }
    const cpResult = await runCommand(
      ["aws", "s3", "cp", tempFile, destUri, "--region", region, "--only-show-errors"],
      {},
    );
    if (cpResult.exitCode !== 0) {
      return { success: false, error: cpResult.stderr.trim() || `aws exit ${cpResult.exitCode}` };
    }
    return { success: true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * True when an `aws s3 cp` stderr indicates the SOURCE read was denied (the CI
 * identity lacks s3:GetObject on the OpenNeuro bucket). Such a failure is
 * deterministic, so retrying it 3x with exponential backoff is pure waste --
 * the caller fails fast to the curl fallback instead. Matches the AWS CLI's
 * "An error occurred (AccessDenied) ... Forbidden" / HTTP 403 wording (#822).
 */
export function isAccessDeniedError(stderr: string): boolean {
  // `Access ?Denied` covers both the parenthesized error code (`AccessDenied`)
  // and the human-readable message (`Access Denied`) the AWS CLI emits.
  return /Access ?Denied|\bForbidden\b|\b403\b/i.test(stderr);
}

/**
 * Copy items in parallel batches, server-side first with bounded retry, then a
 * one-shot curl fallback per object. Collects failures and returns them (never
 * exits the process mid-stream — the caller decides). `fellBack` counts objects
 * that needed the curl path so the caller can flag unexpected access issues.
 */
export async function batchServerSideCopy(
  items: CopyItem[],
  destRegion: string,
  concurrency: number,
  onProgress?: (done: number, total: number, key: string) => void,
  attempts = 3,
): Promise<{ copied: number; fellBack: number; failed: Array<{ key: string; error: string }> }> {
  let copied = 0;
  let fellBack = 0;
  const failed: Array<{ key: string; error: string }> = [];
  // Bounds concurrent curl-fallback downloads independent of `concurrency`
  // (which governs the server-side-copy path, safe to run wide -- see
  // CURL_FALLBACK_CONCURRENCY's doc comment).
  const fallbackLimiter = createSemaphore(CURL_FALLBACK_CONCURRENCY);

  const copyOne = async (item: CopyItem): Promise<"ok" | "fallback"> => {
    let lastError = "no S3 source";
    if (item.source) {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const r = await serverSideS3Copy(item.source, item.destUri, destRegion);
        if (r.success) return "ok";
        lastError = r.error ?? "unknown server-side copy error";
        // AccessDenied on the source is deterministic (the CI identity can't
        // GetObject on the OpenNeuro bucket; #822) -- don't burn the remaining
        // retries + exponential backoff, drop to the curl fallback immediately.
        if (isAccessDeniedError(lastError)) break;
        if (attempt < attempts) {
          await new Promise((res) => setTimeout(res, attempt * attempt * 1000));
        }
      }
    }
    // No S3 source, or server-side exhausted: try the curl fallback once.
    if (item.httpUrl?.startsWith("http")) {
      await fallbackLimiter.acquire();
      try {
        const fb = await curlStreamCopy(item.httpUrl, item.destUri, destRegion);
        if (fb.success) return item.source ? "fallback" : "ok";
        throw new Error(`server-side failed (${lastError}); fallback failed (${fb.error})`);
      } finally {
        fallbackLimiter.release();
      }
    }
    throw new Error(lastError);
  };

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const results = await Promise.allSettled(batch.map((item) => copyOne(item)));
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled") {
        copied++;
        if (r.value === "fallback") fellBack++;
      } else {
        failed.push({
          key: batch[j].key,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    }
    onProgress?.(copied, items.length, batch[batch.length - 1].key);
  }

  return { copied, fellBack, failed };
}

/**
 * List the objects already present under `s3://<bucket>/<prefix>` (the
 * destination `objects/` prefix). Returns a Map of annex key (the part of the
 * S3 key after `<prefix>`) -> size in bytes. Drives resume: a re-run skips keys
 * that are already there. Uses the `aws` binary (the backend s3.ts lister is
 * Workers-only via aws4fetch and isn't usable in the CLI process).
 */
export async function listExistingObjects(
  bucket: string,
  prefix: string,
  region: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const result = await runCommand(
    [
      "aws",
      "s3api",
      "list-objects-v2",
      "--bucket",
      bucket,
      "--prefix",
      prefix,
      "--region",
      region,
      "--output",
      "json",
    ],
    {},
  );
  if (result.exitCode !== 0) {
    throw new Error(`list-objects-v2 failed for ${prefix}: ${result.stderr.trim()}`);
  }
  const trimmed = result.stdout.trim();
  if (!trimmed) return out;
  let parsed: {
    Contents?: Array<{ Key?: string; Size?: number }>;
    IsTruncated?: boolean;
    NextContinuationToken?: string;
  };
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `list-objects-v2 returned unparseable JSON for ${prefix}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // The AWS CLI v2 auto-paginates list-objects-v2 and merges all pages, so a
  // truncated result means auto-pagination was disabled (CLI v1, --no-paginate,
  // or a config override). Fail loudly rather than return a partial view that
  // would make the finalize completeness check pass on an incomplete dataset.
  if (parsed.IsTruncated === true || parsed.NextContinuationToken) {
    throw new Error(
      `list-objects-v2 returned a truncated page for ${prefix} (auto-pagination disabled?). Refusing to proceed on a partial destination view.`,
    );
  }
  for (const obj of parsed.Contents ?? []) {
    if (typeof obj.Key !== "string") continue;
    if (!obj.Key.startsWith(prefix)) continue;
    const key = obj.Key.slice(prefix.length);
    if (key.length === 0) continue; // the prefix "directory" placeholder
    out.set(key, typeof obj.Size === "number" ? obj.Size : 0);
  }
  return out;
}

/**
 * Pure resume filter: split items into those still needing a copy and those
 * already present at the destination. An item is skipped when its key is
 * present AND (no expected size map given, OR the present size matches the
 * expected size). Callers pass `expectedSizes` built from
 * {@link annexKeyDeclaredSize} (see `expectedSizesFromItems`) so a 0-byte or
 * truncated object left over from a prior failed run is re-copied instead of
 * being mistaken for a completed transfer (#967).
 */
export function filterAlreadyCopied(
  items: CopyItem[],
  existing: Map<string, number>,
  expectedSizes?: Map<string, number>,
): { toCopy: CopyItem[]; skipped: string[] } {
  const toCopy: CopyItem[] = [];
  const skipped: string[] = [];
  for (const item of items) {
    if (!existing.has(item.key)) {
      toCopy.push(item);
      continue;
    }
    const expected = expectedSizes?.get(item.key);
    if (expected !== undefined && existing.get(item.key) !== expected) {
      toCopy.push(item); // present but wrong size -> re-copy
    } else {
      skipped.push(item.key);
    }
  }
  return { toCopy, skipped };
}

/**
 * Build the `expectedSizes` map `filterAlreadyCopied` needs, deriving each
 * item's declared size from its annex key via {@link annexKeyDeclaredSize}.
 * Keys with no declared size (non-annex `git:` keys, or malformed) are
 * omitted so presence-only matching still applies to them.
 */
export function expectedSizesFromItems(items: Array<{ key: string }>): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const item of items) {
    const size = annexKeyDeclaredSize(item.key);
    if (size !== null) sizes.set(item.key, size);
  }
  return sizes;
}

/** Stable 32-bit FNV-1a hash. Deterministic across runs/processes so a given
 *  annex key always lands in the same shard. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Parse a `--shard i/N` argument into {index, count}. Throws on malformed
 *  input or an out-of-range index. */
export function parseShardArg(arg: string): { index: number; count: number } {
  const m = arg.match(/^(\d+)\/(\d+)$/);
  if (!m) {
    throw new Error(`Invalid --shard "${arg}". Expected "i/N" (e.g. "0/8").`);
  }
  const index = Number(m[1]);
  const count = Number(m[2]);
  if (count < 1) throw new Error(`Invalid shard count in "${arg}": N must be >= 1.`);
  if (index < 0 || index >= count) {
    throw new Error(`Invalid shard index in "${arg}": i must satisfy 0 <= i < N.`);
  }
  return { index, count };
}

/** True when `key` belongs to shard `index` of `count`. The union over
 *  index 0..count-1 partitions any key set exactly once. */
export function keyInShard(key: string, index: number, count: number): boolean {
  if (count <= 1) return true;
  return fnv1a(key) % count === index;
}

// ---------------------------------------------------------------------------
// Manifest + shard-report staging (S3) — passes state between the prepare,
// copy (sharded), and finalize jobs, which don't share a filesystem.
// ---------------------------------------------------------------------------

export interface ImportManifestItem {
  key: string;
  /** Raw whereis URL, kept for the curl fallback. */
  sourceUrl: string | null;
  /** Parsed S3 source, or null if the whereis URL wasn't an S3 endpoint. */
  source: S3Ref | null;
  destUri: string;
  /**
   * Where this key's content comes from. **Absent means upstream**, which is the
   * ordinary case and the only thing any manifest written before #1159 can say;
   * nothing writes `"upstream"` explicitly, so read it through
   * {@link isLocallyUploaded} rather than comparing to a string.
   *
   * Upstream means the copy phase server-side copies the key from the OpenNeuro
   * bucket. `"local"` means prepare already uploaded the content from its clone
   * with `git annex copy --to nemar-s3`, because the file was a plain git blob
   * upstream and no upstream KEY exists to copy from (ADR 0060).
   *
   * The distinction is only about who transfers the bytes. Both kinds are data:
   * finalize verifies both at the destination and registers both with
   * git-annex, and both count against the empty-manifest publish guard.
   */
  origin?: "upstream" | "local";
}

/**
 * True when prepare already uploaded this key's content, so the copy phase has
 * nothing to transfer for it. Absent `origin` means upstream, which is what
 * keeps a manifest written before #1159 readable.
 */
export function isLocallyUploaded(item: Pick<ImportManifestItem, "origin">): boolean {
  return item.origin === "local";
}

/**
 * The copy work one shard owes: this shard's slice of the manifest, minus the
 * keys prepare already uploaded from the clone.
 *
 * Both numbers are about THIS shard. `localSkipped` counts only local keys that
 * fall in this shard, so summing the shards' logs gives the manifest total once
 * rather than once per shard.
 *
 * Declared here rather than inline in `copyShard` so the selection is testable
 * without AWS: past the empty-shard early return, the copy phase lists the
 * destination bucket, so an inline filter could only be exercised against the
 * real one.
 */
export function selectShardCopyItems(
  items: ImportManifestItem[],
  shard: { index: number; count: number },
): { shardItems: CopyItem[]; localSkipped: number } {
  let localSkipped = 0;
  const shardItems: CopyItem[] = [];
  for (const it of items) {
    if (!keyInShard(it.key, shard.index, shard.count)) continue;
    if (isLocallyUploaded(it)) {
      localSkipped++;
      continue;
    }
    shardItems.push({ key: it.key, source: it.source, httpUrl: it.sourceUrl, destUri: it.destUri });
  }
  return { shardItems, localSkipped };
}

/**
 * What prepare's identifier scrub tells finalize (ADR 0089). Absent on a manifest an older prepare
 * wrote, which finalize reads as "the scrub did not run" and never approves automatically.
 */
export interface ImportPrivacyRecord {
  version: 1;
  /**
   * The scrub changed content git tracks (a JSON value, a recording git held), so the pushed
   * history still holds the original: a person decides before publication.
   */
  historyHoldsOriginals: boolean;
}

export interface ImportManifest {
  openneuroId: string;
  nemarId: string;
  nemarUuid: string;
  items: ImportManifestItem[];
  privacy?: ImportPrivacyRecord;
}

function manifestUri(bucket: string, nemarId: string): string {
  return `s3://${bucket}/${nemarId}/staging/import-manifest.json`;
}

/** Write a JSON value to an S3 key via a temp file (`runCommand` has no stdin). */
async function putJson(value: unknown, uri: string, region: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nemar-staging-"));
  const file = join(dir, "payload.json");
  try {
    writeFileSync(file, JSON.stringify(value));
    const result = await runCommand(
      ["aws", "s3", "cp", file, uri, "--region", region, "--content-type", "application/json"],
      {},
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to write ${uri}: ${result.stderr.trim()}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Read a JSON value from an S3 key via `aws s3 cp <uri> -` to stdout. */
async function getJson<T>(uri: string, region: string): Promise<T> {
  const result = await runCommand(["aws", "s3", "cp", uri, "-", "--region", region], {});
  if (result.exitCode !== 0) {
    throw new Error(`Failed to read ${uri}: ${result.stderr.trim()}`);
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch (err) {
    throw new Error(
      `Failed to parse JSON from ${uri} (corrupt or truncated staging object): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function writeManifestToS3(
  manifest: ImportManifest,
  bucket: string,
  region: string,
): Promise<void> {
  await putJson(manifest, manifestUri(bucket, manifest.nemarId), region);
}

export async function readManifestFromS3(
  nemarId: string,
  bucket: string,
  region: string,
): Promise<ImportManifest> {
  return getJson<ImportManifest>(manifestUri(bucket, nemarId), region);
}

export async function cleanupStaging(
  nemarId: string,
  bucket: string,
  region: string,
): Promise<void> {
  // Best-effort: a leftover staging prefix is harmless (re-import overwrites the
  // manifest); don't fail the import, but do surface a non-zero exit so the
  // operator can sweep it (e.g. creds expired during a long run).
  const result = await runCommand(
    ["aws", "s3", "rm", `s3://${bucket}/${nemarId}/staging/`, "--recursive", "--region", region],
    {},
  );
  if (result.exitCode !== 0) {
    console.warn(`  Staging cleanup failed (non-fatal): ${result.stderr.trim()}`);
  }
}
