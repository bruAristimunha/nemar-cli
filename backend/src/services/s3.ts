/**
 * S3 service using aws4fetch
 *
 * Handles presigned URL generation (upload/download), version manifests,
 * S3 Object Lock, bucket policy management, object deletion, and archive
 * download URLs. Uses aws4fetch for Cloudflare Workers compatibility.
 */

import { AwsClient } from "aws4fetch";
import { escapeXml, unescapeXml } from "../lib/escape.js";
import {
  type BucketPolicy,
  MAX_BUCKET_POLICY_BYTES,
  addPrivateDataset,
  isDatasetPrivate,
  policyByteSize,
  removePrivateDataset,
} from "./bucket-policy.js";
import { isValidDatasetId } from "./datasetId.js";

export interface PresignedUrlOptions {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * TEST-ONLY origin override, the same idiom `ZarrFidelityS3Options` and
   * `ZarrCatalogS3Options` already use: a test points a read at a local
   * `Bun.serve()` receiver instead of mocking `fetch`. Unset in every
   * deployment, where the bucket's real endpoint is derived below.
   */
  endpointUrl?: string;
}

interface GenerateUrlsParams {
  prefix: string;
  files: string[];
  expiresIn?: number; // seconds, default 3600 (1 hour)
}

// Bucket-policy shape and pure transforms live in ./bucket-policy.ts. The
// public-access model is documented there: a single public-by-default Allow
// with a NotResource carve-out for private (and staging) prefixes.

/**
 * Create an AWS client for S3 operations
 */
function createS3Client(options: PresignedUrlOptions): AwsClient {
  return new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    region: options.region,
    service: "s3",
  });
}

/**
 * Generate presigned PUT URLs for uploading files
 */
/**
 * Reject a traversal, an absolute path, a backslash or a NUL byte in an S3
 * key, checking both the raw string and its URL-decoded form so a
 * double-encoded traversal (`%252e%252e`) cannot slip past the raw check.
 * Shared by {@link generatePresignedGetUrl} and {@link buildPublicObjectUrl}:
 * both build the same `<datasetId>/objects/<annexKey>` shape of key, one
 * signed and one not, and both must refuse the same malformed input.
 */
function assertValidS3Key(key: string): void {
  const decoded = decodeURIComponent(key);
  if (
    decoded.includes("..") ||
    decoded.startsWith("/") ||
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    key.includes("..") ||
    key.startsWith("/") ||
    key.includes("\\")
  ) {
    throw new Error(`Invalid S3 key: ${key}`);
  }
}

export async function generatePresignedPutUrls(
  options: PresignedUrlOptions,
  params: GenerateUrlsParams,
): Promise<Record<string, string>> {
  const { bucket, region } = options;
  const { prefix, files, expiresIn = 3600 } = params;

  const aws = createS3Client(options);
  const urls: Record<string, string> = {};

  for (const file of files) {
    // Check both raw and URL-decoded forms to catch double-encoded traversal (e.g. %252e%252e)
    const decoded = decodeURIComponent(file);
    if (
      decoded.includes("..") ||
      decoded.startsWith("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0") ||
      file.includes("..") ||
      file.startsWith("/") ||
      file.includes("\\")
    ) {
      throw new Error(`Invalid file path: ${file}`);
    }
    const key = `${prefix}/${file}`;
    // Include X-Amz-Expires in URL BEFORE signing so it's part of the signature
    const url = `https://${bucket}.s3.${region}.amazonaws.com/${key}?X-Amz-Expires=${expiresIn}`;

    // Create presigned PUT URL with expiration included in signature
    const signedRequest = await aws.sign(url, {
      method: "PUT",
      aws: { signQuery: true },
    });

    urls[file] = signedRequest.url;
  }

  return urls;
}

/**
 * Generate presigned GET URL for downloading a file.
 *
 * `responseContentDisposition`, when set, becomes a `response-content-disposition`
 * query parameter that S3 echoes back as the `Content-Disposition` response
 * header. The value is URL-encoded and included in the SigV4 signature, so it
 * cannot be tampered with after presigning. Used by the data.nemar.org route to
 * force BIDS-shaped filenames despite content-addressed object names.
 */
export async function generatePresignedGetUrl(
  options: PresignedUrlOptions,
  key: string,
  expiresIn = 3600,
  responseContentDisposition?: string,
): Promise<string> {
  assertValidS3Key(key);
  const { bucket, region } = options;
  const aws = createS3Client(options);

  // Include X-Amz-Expires (and optional response-content-disposition) in the URL
  // BEFORE signing so aws4fetch canonicalises them into the signature.
  //
  // The disposition value MUST be URL-encoded here even though aws4fetch
  // re-canonicalises searchParams later: the raw value contains `;`, `=`,
  // `"`, and (for some filenames) `&`, all of which would derail URL/query
  // parsing before aws4fetch ever sees them. The `new URL(url)` call inside
  // aws4fetch decodes one layer back to the original string, which is then
  // re-encoded for the SigV4 canonical form, so the on-wire URL and the
  // canonical-string-to-sign agree.
  const queryParts = [`X-Amz-Expires=${expiresIn}`];
  if (responseContentDisposition) {
    queryParts.push(
      `response-content-disposition=${encodeURIComponent(responseContentDisposition)}`,
    );
  }
  const url = `https://${bucket}.s3.${region}.amazonaws.com/${key}?${queryParts.join("&")}`;

  const signedRequest = await aws.sign(url, {
    method: "GET",
    aws: { signQuery: true },
  });

  return signedRequest.url;
}

/**
 * Build the plain, query-string-free public URL for an S3 object (#1522).
 *
 * This is a low-level URL helper; `manifest.json` now emits stable data-plane
 * routes for every dataset (ADR 0095). Direct S3 URLs remain useful to
 * operational code and regression checks that specifically need to verify
 * S3 path encoding or public-object behavior.
 *
 * SAME ENCODING AS THE PRESIGNER, ON PURPOSE. `generatePresignedGetUrl`
 * builds its pre-signature URL the same way: a bare string-concatenated key,
 * no manual percent-encoding, fed to `new URL(...)` (inside aws4fetch's
 * signer, which parses the URL before it ever adds a query parameter). This
 * function does the identical concatenation and `new URL(...)` parse, with no
 * signing step after it, so a key that produces one path here produces the
 * SAME path there -- verified for real, not just by inspection, in
 * `s3-public-url.test.ts`'s comparison against a signed URL for the same key.
 *
 * `endpointUrl` is honored (unlike `generatePresignedGetUrl`, which hardcodes
 * the production host) because this function's whole compatibility claim --
 * "the URL this emits actually serves the object, GET and Range" -- has to be
 * checked against a real HTTP server in a test, not just read off the string.
 * Unset in every deployment, exactly as every other `endpointUrl` use in this
 * file already documents.
 */
export function buildPublicObjectUrl(options: PresignedUrlOptions, key: string): string {
  assertValidS3Key(key);
  const { bucket, region, endpointUrl } = options;
  const origin = (endpointUrl ?? `https://${bucket}.s3.${region}.amazonaws.com`).replace(
    /\/+$/,
    "",
  );
  return new URL(`${origin}/${key}`).toString();
}

/**
 * Generate presigned URLs for staging area (PR uploads)
 */
export async function generateStagingUrls(
  options: PresignedUrlOptions,
  prNumber: number,
  datasetId: string,
  files: string[],
): Promise<{
  uploadUrls: Record<string, string>;
  stagingPrefix: string;
}> {
  const stagingPrefix = `staging/pr-${prNumber}/${datasetId}/objects`;

  const uploadUrls = await generatePresignedPutUrls(options, {
    prefix: stagingPrefix,
    files,
    expiresIn: 3600, // 1 hour for staging uploads
  });

  return { uploadUrls, stagingPrefix };
}

/**
 * Generate presigned URLs for final dataset upload
 */
export async function generateDatasetUploadUrls(
  options: PresignedUrlOptions,
  datasetId: string,
  files: string[],
): Promise<Record<string, string>> {
  return generatePresignedPutUrls(options, {
    prefix: `${datasetId}/objects`,
    files,
    expiresIn: 3600,
  });
}

// ---------------------------------------------------------------------------
// S3 ListObjectsV2 pagination helper
// ---------------------------------------------------------------------------

async function* listObjectPages(
  options: PresignedUrlOptions,
  prefix: string,
): AsyncGenerator<string> {
  const { bucket, region, endpointUrl } = options;
  const aws = createS3Client(options);
  let continuationToken: string | undefined;

  do {
    const params = new URLSearchParams({
      "list-type": "2",
      prefix,
      ...(continuationToken ? { "continuation-token": continuationToken } : {}),
    });

    // endpointUrl (#1514): same test-only override every other function in
    // this file honors (see PresignedUrlOptions); this generator was the one
    // holdout that built its URL from the literal AWS host unconditionally,
    // which left getArchiveSize/getDatasetS3Stats/listObjectKeys with no way
    // to be driven by a local Bun.serve stand-in at their real entry point.
    const origin = (endpointUrl ?? `https://${bucket}.s3.${region}.amazonaws.com`).replace(
      /\/+$/,
      "",
    );
    const url = `${origin}/?${params.toString()}`;
    const response = await aws.sign(url, { method: "GET" });
    const res = await fetch(response);

    if (!res.ok) {
      throw new Error(`Failed to list objects: HTTP ${res.status}`);
    }

    const xml = await res.text();

    if (!xml.includes("<ListBucketResult")) {
      throw new Error(`Unexpected S3 response (not ListBucketResult): ${xml.slice(0, 200)}`);
    }

    yield xml;

    const truncated = xml.includes("<IsTruncated>true</IsTruncated>");
    if (truncated) {
      const tokenMatch = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
      if (!tokenMatch?.[1]) {
        throw new Error("S3 response is truncated but no NextContinuationToken found");
      }
      continuationToken = tokenMatch[1];
    } else {
      continuationToken = undefined;
    }
  } while (continuationToken);
}

/**
 * Get total size and object count for a dataset's S3 objects.
 * Uses S3 ListObjectsV2 for real file sizes (git tree shows symlink sizes for annexed files).
 *
 * @param maxPages - If provided, stop counting after this many LIST pages and
 *   return `objectCount: undefined` to signal that the total is unknown. This
 *   caps the Cloudflare Workers subrequest cost when called from within the
 *   publish orchestrator (each LIST page = 1 subrequest). Callers that need
 *   the authoritative total should pass `undefined` (default = unlimited).
 *
 * @warning When `maxPages` is exceeded, `totalSize` reflects only the pages
 *   scanned — it is a partial sum, not the dataset's true total. Callers
 *   MUST check whether `objectCount === undefined` before relying on
 *   `totalSize` for anything that requires an accurate byte count (e.g. DOI
 *   metadata, download size display). Discard or label it clearly if capped.
 */
export async function getDatasetS3Stats(
  options: PresignedUrlOptions,
  datasetId: string,
  maxPages?: number,
): Promise<{ totalSize: number; objectCount: number | undefined }> {
  let totalSize = 0;
  let objectCount = 0;
  let pageCount = 0;

  for await (const xml of listObjectPages(options, `${datasetId}/objects/`)) {
    pageCount++;
    if (maxPages !== undefined && pageCount > maxPages) {
      // Cap exceeded: return undefined so the caller knows the count is
      // incomplete rather than silently returning a low number.
      return { totalSize, objectCount: undefined };
    }
    const contentMatches = xml.matchAll(
      /<Contents>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g,
    );
    for (const match of contentMatches) {
      totalSize += Number.parseInt(match[1], 10);
      objectCount++;
    }
  }

  return { totalSize, objectCount };
}

/**
 * List all object keys under a given prefix.
 */
export async function listObjectKeys(
  options: PresignedUrlOptions,
  prefix: string,
): Promise<string[]> {
  const keys: string[] = [];

  for await (const xml of listObjectPages(options, prefix)) {
    for (const match of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      keys.push(match[1]);
    }
  }

  return keys;
}

export interface S3ListEntry {
  key: string;
  size: number;
  lastModified: string;
}

export interface S3ListResult {
  contents: S3ListEntry[];
  commonPrefixes: string[];
  truncated: boolean;
}

/**
 * One-level S3 listing with `delimiter=/`. Returns immediate-child objects in
 * `contents` and immediate-child sub-directories in `commonPrefixes` (each
 * already ends in `/`). Truncation is reported back so callers can decide
 * whether to ignore, follow continuation, or render a "listing truncated"
 * affordance.
 *
 * Unlike `listObjectPages`, this does a SINGLE round-trip — it is meant for
 * interactive directory rendering (the data.nemar.org `/qa/*` route), not
 * bulk enumeration. The route caller pages by setting `prefix` deeper.
 */
export async function listObjectsWithDelimiter(
  options: PresignedUrlOptions,
  prefix: string,
  maxKeys = 1000,
): Promise<S3ListResult> {
  const { bucket, region } = options;
  const aws = createS3Client(options);

  const params = new URLSearchParams({
    "list-type": "2",
    prefix,
    delimiter: "/",
    "max-keys": String(maxKeys),
  });
  const url = `https://${bucket}.s3.${region}.amazonaws.com/?${params.toString()}`;
  const signed = await aws.sign(url, { method: "GET" });
  const res = await fetch(signed);
  if (!res.ok) {
    throw new Error(`Failed to list objects (prefix=${prefix}): HTTP ${res.status}`);
  }
  const xml = await res.text();
  if (!xml.includes("<ListBucketResult")) {
    throw new Error(`Unexpected S3 response (not ListBucketResult): ${xml.slice(0, 200)}`);
  }

  const contents: S3ListEntry[] = [];
  const contentMatches = xml.matchAll(
    /<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<LastModified>([^<]+)<\/LastModified>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g,
  );
  for (const match of contentMatches) {
    contents.push({
      key: match[1],
      lastModified: match[2],
      size: Number.parseInt(match[3], 10),
    });
  }

  const commonPrefixes: string[] = [];
  const prefixMatches = xml.matchAll(
    /<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>\s*<\/CommonPrefixes>/g,
  );
  for (const match of prefixMatches) {
    commonPrefixes.push(match[1]);
  }

  const truncated = xml.includes("<IsTruncated>true</IsTruncated>");
  return { contents, commonPrefixes, truncated };
}

/**
 * Parse one ListBucketResult XML page's `<Contents>` entries into `sizes`
 * (mutated in place): S3 key with `prefix` stripped -> size. Extracted from
 * listObjectSizes so multi-page merging is testable purely, with no I/O at
 * all: feed it two synthetic pages and assert both merge into one Map.
 * `listObjectPages` gained an `endpointUrl` override seam of its own (#1514,
 * `PresignedUrlOptions`), so a live-page test is also possible now (see the
 * admin archive-sweep route test), but this pure parser test stays -- it is
 * cheaper and does not depend on a server being reachable. Exported for
 * testing.
 */
export function mergeObjectSizesPage(
  xml: string,
  prefix: string,
  sizes: Map<string, number>,
): void {
  const contentMatches = xml.matchAll(
    /<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g,
  );
  for (const match of contentMatches) {
    const key = match[1];
    if (!key.startsWith(prefix)) continue;
    const stripped = key.slice(prefix.length);
    if (stripped.length === 0) continue; // the prefix "directory" placeholder
    sizes.set(stripped, Number.parseInt(match[2], 10));
  }
}

/**
 * Full paginated listing of every object under `prefix` as a key -> size map
 * (S3 key with the prefix stripped, mirroring the CLI's listExistingObjects
 * in src/lib/s3-server-copy.ts). Unlike listObjectsWithDelimiter (one page,
 * directory-style), this drains every page via listObjectPages -- the
 * retry-engine's per-key integrity check (verifyDatasetVersionS3,
 * import-integrity.ts, #969) needs the COMPLETE destination listing to
 * detect missing/zero-byte objects, not just the first 1000.
 */
export async function listObjectSizes(
  options: PresignedUrlOptions,
  prefix: string,
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for await (const xml of listObjectPages(options, prefix)) {
    mergeObjectSizesPage(xml, prefix, sizes);
  }
  return sizes;
}

export interface BoundedS3ObjectList {
  /** Full object keys, with their exact S3-reported sizes. */
  sizes: Map<string, number>;
  /** False when the page or object budget prevented a complete listing. */
  complete: boolean;
}

const BOUNDED_LIST_PAGE_SIZE = 256;
export const BOUNDED_LIST_MAX_PAGES = 2;
const BOUNDED_LIST_MAX_OBJECTS = BOUNDED_LIST_PAGE_SIZE * BOUNDED_LIST_MAX_PAGES;

/**
 * List a bounded prefix without ever treating a capped or malformed result as
 * complete. Used by the file data plane to discover annex chunks: a normal
 * complete 95-chunk upload fits comfortably in this two-page budget, while an
 * unusually large or noisy prefix fails closed instead of consuming unbounded
 * Worker subrequests or memory.
 */
export async function listObjectSizesBounded(
  options: PresignedUrlOptions,
  prefix: string,
): Promise<BoundedS3ObjectList> {
  const { bucket, region, endpointUrl } = options;
  const aws = createS3Client(options);
  const origin = (endpointUrl ?? `https://${bucket}.s3.${region}.amazonaws.com`).replace(
    /\/+$/,
    "",
  );
  const sizes = new Map<string, number>();
  let continuationToken: string | undefined;

  for (let page = 0; page < BOUNDED_LIST_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      "list-type": "2",
      "encoding-type": "url",
      "max-keys": String(BOUNDED_LIST_PAGE_SIZE),
      prefix,
      ...(continuationToken ? { "continuation-token": continuationToken } : {}),
    });
    const signed = await aws.sign(`${origin}/?${params.toString()}`, { method: "GET" });
    const response = await fetch(signed);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Failed to list chunk objects: HTTP ${response.status}`);
    }

    const xml = await response.text();
    if (!xml.includes("<ListBucketResult")) {
      throw new Error("Unexpected S3 chunk-list response");
    }
    for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const keyMatch = match[1]?.match(/<Key>([\s\S]*?)<\/Key>/);
      const sizeMatch = match[1]?.match(/<Size>(\d+)<\/Size>/);
      if (!keyMatch?.[1] || !sizeMatch?.[1]) {
        throw new Error("Malformed S3 chunk-list entry");
      }
      let key: string;
      try {
        key = decodeURIComponent(unescapeXml(keyMatch[1]));
      } catch {
        throw new Error("Malformed encoded key in S3 chunk-list entry");
      }
      const size = Number(sizeMatch[1]);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error("Malformed size in S3 chunk-list entry");
      }
      if (!key.startsWith(prefix)) continue;
      if (sizes.has(key)) throw new Error("Duplicate key in S3 chunk-list response");
      sizes.set(key, size);
      if (sizes.size > BOUNDED_LIST_MAX_OBJECTS) return { sizes, complete: false };
    }

    const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml);
    if (!truncated) return { sizes, complete: true };
    const token = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1];
    if (!token) throw new Error("Truncated S3 chunk listing has no continuation token");
    continuationToken = unescapeXml(token);
  }

  return { sizes, complete: false };
}

/**
 * Authenticated object request used by the data plane after its visibility,
 * version and manifest-path gates. `Range` is sent to S3 for chunk slices;
 * callers construct it only from parsed, bounded byte offsets.
 */
export async function fetchS3Object(
  options: PresignedUrlOptions,
  key: string,
  request: { method: "GET" | "HEAD"; range?: string },
): Promise<Response> {
  assertValidS3Key(key);
  const { bucket, region, endpointUrl } = options;
  const origin = (endpointUrl ?? `https://${bucket}.s3.${region}.amazonaws.com`).replace(
    /\/+$/,
    "",
  );
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const headers = request.range ? { Range: request.range } : undefined;
  const signed = await createS3Client(options).sign(`${origin}/${encodedKey}`, {
    method: request.method,
    headers,
  });
  return fetch(signed);
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

export function extractExtensions(paths: string[]): string[] {
  const exts = new Set<string>();
  for (const p of paths) {
    const lastDot = p.lastIndexOf(".");
    if (lastDot > 0) exts.add(p.slice(lastDot));
  }
  return [...exts].sort();
}

/**
 * Upload a JSON manifest to S3 at the dataset's version path.
 * Stored at: <datasetId>/version/v<version>.json
 */
export async function uploadManifest(
  options: PresignedUrlOptions,
  datasetId: string,
  version: string,
  manifestJson: string,
): Promise<void> {
  const { bucket, region } = options;
  const aws = createS3Client(options);
  const versionTag = version.startsWith("v") ? version : `v${version}`;
  const key = `${datasetId}/version/${versionTag}.json`;
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const url = `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;

  const signed = await aws.sign(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: manifestJson,
  });

  const response = await fetch(signed);
  if (!response.ok) {
    throw new Error(`Failed to upload manifest: HTTP ${response.status}`);
  }
}

/**
 * Get a manifest from S3. Returns null if not found.
 *
 * Manifest objects are uploaded with public-read by the publication
 * pipeline (data.nemar.org loads them on every dataset page hit).
 * Fetch unsigned so a Worker-side AWS credentials outage does not also
 * take down dataset browsing. Falls back to a signed GET if unsigned
 * is rejected (private / pre-publish datasets).
 *
 * This reads the whole object into one string. The data plane no longer
 * does (#1502): a large manifest is tens of megabytes, and it reads the body
 * as a stream through {@link fetchManifestObject} instead.
 */
export async function getManifest(
  options: PresignedUrlOptions,
  datasetId: string,
  version: string,
): Promise<string | null> {
  const fetched = await fetchManifestObject(options, datasetId, version);
  return fetched.kind === "found" ? fetched.response.text() : null;
}

/**
 * What {@link fetchManifestObject} found. `not_modified` is only ever
 * returned for a conditional request.
 */
export type ManifestObjectFetch =
  | { kind: "found"; response: Response }
  | { kind: "not_modified" }
  | { kind: "absent" };

/**
 * GET a version manifest and hand back the response unread, so the caller
 * decides whether the body is streamed or buffered. Same access strategy and
 * the same outcomes as {@link getManifest}, which is built on it: unsigned
 * first, a signed retry on 403, `absent` for a 404 or a 403 that survives the
 * retry (logged, since that one means credentials rather than absence), and
 * a throw for any other failure.
 *
 * `ifNoneMatch` makes the request conditional on the object having changed
 * since the ETag the caller already holds; S3 answers 304 with no body when
 * it has not, which is what lets the data plane's edge copy be revalidated on
 * every use without moving the manifest's bytes again.
 */
export async function fetchManifestObject(
  options: PresignedUrlOptions,
  datasetId: string,
  version: string,
  conditional?: { ifNoneMatch: string },
): Promise<ManifestObjectFetch> {
  const { bucket, region, endpointUrl } = options;
  const versionTag = version.startsWith("v") ? version : `v${version}`;
  const key = `${datasetId}/version/${versionTag}.json`;
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const origin = (endpointUrl ?? `https://${bucket}.s3.${region}.amazonaws.com`).replace(
    /\/+$/,
    "",
  );
  const url = `${origin}/${encodedKey}`;
  const headers: Record<string, string> | undefined = conditional
    ? { "If-None-Match": conditional.ifNoneMatch }
    : undefined;

  let response = await fetch(url, headers ? { headers } : undefined);
  if (response.status === 403) {
    // Object exists but is not public-read (private dataset / pre-publish).
    // Try a signed GET as fallback. The refusal's body is never read, so
    // release it rather than leave the connection to the collector.
    await response.body?.cancel().catch(() => {});
    try {
      const aws = createS3Client(options);
      const signed = await aws.sign(url, { method: "GET", headers });
      response = await fetch(signed);
    } catch (err) {
      console.error(
        `[s3] getManifest signed-fallback failed dataset=${datasetId} version=${version}:`,
        err instanceof Error ? err.message : String(err),
      );
      return { kind: "absent" };
    }
  }

  if (response.status === 304 && conditional) return { kind: "not_modified" };
  if (response.status === 404) return { kind: "absent" };
  if (response.status === 403) {
    // Still 403 after the signed fallback: credentials are dead or IAM
    // lacks GetObject on this private manifest. Preserves the legacy
    // contract by returning null, but logs so an operator can tell
    // "credentials regression" from "never published" in prod logs.
    console.error(
      `[s3] getManifest 403 after fallback (credentials/permissions) dataset=${datasetId} version=${version}`,
    );
    return { kind: "absent" };
  }
  if (!response.ok) {
    throw new Error(`Failed to get manifest: HTTP ${response.status}`);
  }

  return { kind: "found", response };
}

/**
 * What {@link headManifestObject} found. `etag` is null only when S3 answered
 * without one, which a caller that needs a fingerprint must treat as unknown.
 */
export type ManifestHead = { kind: "found"; etag: string | null } | { kind: "absent" };

/**
 * HEAD a version manifest for its ETag, moving none of its bytes (epic #1586,
 * phase 4: the Neurobagel writer fingerprints a dataset by it). Same access
 * strategy as {@link fetchManifestObject}: unsigned first, a signed retry on 403,
 * `absent` for a 404 or a 403 that survives the retry, a throw for anything else.
 * `endpointUrl` is the same test-only origin override every function here honors.
 */
export async function headManifestObject(
  options: PresignedUrlOptions,
  datasetId: string,
  version: string,
): Promise<ManifestHead> {
  const { bucket, region, endpointUrl } = options;
  const key = versionArtifactKey(datasetId, version, "");
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const origin = (endpointUrl ?? `https://${bucket}.s3.${region}.amazonaws.com`).replace(
    /\/+$/,
    "",
  );
  const url = `${origin}/${encodedKey}`;

  let response = await fetch(url, { method: "HEAD" });
  if (response.status === 403) {
    try {
      const aws = createS3Client(options);
      response = await fetch(await aws.sign(url, { method: "HEAD" }));
    } catch (err) {
      console.error(
        `[s3] headManifestObject signed-fallback failed dataset=${datasetId} version=${version}:`,
        err instanceof Error ? err.message : String(err),
      );
      return { kind: "absent" };
    }
  }
  if (response.status === 404 || response.status === 403) return { kind: "absent" };
  if (!response.ok) throw new Error(`Failed to HEAD manifest: HTTP ${response.status}`);
  return { kind: "found", etag: response.headers.get("ETag") };
}

/**
 * Build the S3 object key for a per-version JSON artifact. The suffix
 * selects the sibling: "" = the canonical manifest (`version/v<X>.json`),
 * "-summary" = the summary sibling (#559), "-records" = the records sibling
 * (#615). Pure + exported so the key contract is unit-testable without S3.
 */
export function versionArtifactKey(
  datasetId: string,
  version: string,
  suffix: "" | "-summary" | "-records",
): string {
  const versionTag = version.startsWith("v") ? version : `v${version}`;
  return `${datasetId}/version/${versionTag}${suffix}.json`;
}

/**
 * Shared loader for a per-version JSON sibling artifact (summary/records).
 * Same public-read strategy as getManifest(): unsigned-fetch-first so the
 * route survives a Worker-credentials outage; signed 403 fallback for
 * private / pre-publish artifacts. 404 -> null. A 403 that survives the
 * fallback throws, so the route returns an uncached 500 instead of letting
 * the CDN pin a transient failure as a 404 (these endpoints' 404s are
 * briefly CDN-cached).
 */
async function loadVersionJson(
  options: PresignedUrlOptions,
  datasetId: string,
  version: string,
  suffix: "-summary" | "-records",
  label: string,
): Promise<string | null> {
  const { bucket, region } = options;
  const key = versionArtifactKey(datasetId, version, suffix);
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const url = `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;

  let response = await fetch(url);
  if (response.status === 403) {
    try {
      const aws = createS3Client(options);
      const signed = await aws.sign(url, { method: "GET" });
      response = await fetch(signed);
    } catch (err) {
      throw new Error(
        `${label} signed-fallback failed dataset=${datasetId} version=${version}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  if (response.status === 404) return null;
  if (response.status === 403) {
    throw new Error(
      `${label} 403 after fallback (credentials/permissions) for dataset=${datasetId} version=${version}`,
    );
  }
  if (!response.ok) {
    throw new Error(`Failed to get ${label}: HTTP ${response.status}`);
  }

  return response.text();
}

/**
 * Get a summary.json sibling artifact from S3. Returns null if not found.
 * Stored at `<datasetId>/version/v<version>-summary.json`; written by the
 * central manifest-generation workflow (epic #559) alongside manifest.json.
 * Static-passthrough: the route serves the bytes verbatim (the writer owns
 * the shape contract).
 */
export async function loadSummary(
  options: PresignedUrlOptions,
  datasetId: string,
  version: string,
): Promise<string | null> {
  return loadVersionJson(options, datasetId, version, "-summary", "loadSummary");
}

/**
 * Get a records.json sibling artifact from S3 (#615). Returns null if not
 * found. Stored at `<datasetId>/version/v<version>-records.json`; written by
 * the central generate-records workflow alongside manifest/summary. Like
 * loadSummary it is a static-passthrough artifact (the emitter owns the
 * neuroschema-record array shape).
 */
export async function loadRecords(
  options: PresignedUrlOptions,
  datasetId: string,
  version: string,
): Promise<string | null> {
  return loadVersionJson(options, datasetId, version, "-records", "loadRecords");
}

/**
 * HEAD-check whether an S3 version artifact exists. Used by the
 * /webhooks/manifest-ready callback to confirm the central workflow
 * actually uploaded both manifest.json and summary.json before we
 * commit the dataset_versions row. Suffix examples: "" (manifest),
 * "-summary" (summary sibling), or "-records" (records sibling, #615).
 * Returns true on 200, false on 404, and throws on any other status (so a
 * 5xx doesn't silently masquerade as "missing"). #557 Stream B.
 */
export async function headVersionArtifact(
  options: PresignedUrlOptions,
  datasetId: string,
  version: string,
  suffix: "" | "-summary" | "-records" = "",
): Promise<boolean> {
  const { bucket, region } = options;
  const aws = createS3Client(options);
  const key = versionArtifactKey(datasetId, version, suffix);
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const url = `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;

  const signed = await aws.sign(url, { method: "HEAD" });
  const response = await fetch(signed);

  if (response.status === 200) return true;
  if (response.status === 404) return false;
  if (response.status === 403) {
    throw new Error(
      `headVersionArtifact 403: likely IAM credentials/permissions error for ${key}. Check AWS_ACCESS_KEY_ID on the Worker.`,
    );
  }
  throw new Error(`Failed to HEAD ${key}: HTTP ${response.status}`);
}

/**
 * List available manifest versions for a dataset.
 * Reads from the version/ prefix under the dataset's S3 directory.
 */
export async function listManifests(
  options: PresignedUrlOptions,
  datasetId: string,
): Promise<string[]> {
  const keys = await listObjectKeys(options, `${datasetId}/version/`);
  return keys
    .filter((k) => k.endsWith(".json"))
    .map((k) => {
      const filename = k.split("/").pop() ?? "";
      return filename.replace(".json", "");
    })
    .sort();
}

/**
 * Get the latest zip archive size for a dataset from S3.
 * Scans archives/ prefix and returns the largest (latest version) zip file size in bytes.
 *
 * Matches any key ending `.zip` regardless of the #1491 naming change (old
 * `v<version>.zip` or new `<id>_v<version>.zip`), so this needed no change
 * for that rename. Since #1518 retains at most one archive per dataset, the
 * "largest" heuristic only actually disambiguates during the narrow window
 * between a rebuild's upload and its post-callback cleanup, when the new
 * and outgoing zips can briefly coexist.
 */
export async function getArchiveSize(
  options: PresignedUrlOptions,
  datasetId: string,
): Promise<number> {
  let maxSize = 0;
  for await (const xml of listObjectPages(options, `${datasetId}/archives/`)) {
    const matches = xml.matchAll(
      /<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g,
    );
    for (const match of matches) {
      if (match[1].endsWith(".zip")) {
        const size = Number.parseInt(match[2], 10);
        if (size > maxSize) maxSize = size;
      }
    }
  }
  return maxSize;
}

/**
 * Shape of a single channel-group entry within a zarr index store, as written
 * by generate_zarr.py. Loosely typed (external JSON off S3, not a
 * compile-time-guaranteed shape) -- aggregateRecordingStats validates every
 * field defensively before using it.
 *
 * `rate` is deliberately NOT modeled here. generate_zarr.py caps it per
 * modality at conversion time (`MODALITY_RATES` -- EEG/MEG 250 Hz, IEEG/EMG
 * 1000 Hz), so the stored value describes the Zarr viewer's serving copy, not
 * the recording's true acquisition rate. Surfacing it as
 * `data_summary.sampling_frequency_range` would put NEMAR's own viewer
 * setting into a FAIR metadata field and mislabel every dataset acquired
 * above the cap (most modern EEG). The real rate lives in the BIDS sidecar
 * (`SamplingFrequency` in `*_eeg.json`), populated by a different pipeline
 * (the enrichment/reindex walk) -- out of scope for this phase.
 * `data_summary.sampling_frequency_range` stays unpopulated because of this;
 * do not "fix" that by reading `rate` off this shape.
 */
export interface ZarrIndexGroupJson {
  n_channels?: unknown;
  duration_s?: unknown;
}

/** Shape of a single converted recording entry in index.json's `stores` array. */
export interface ZarrIndexStoreJson {
  groups?: unknown;
}

/**
 * Shape of the parsed `<id>/zarr/index.json` document (subset this module reads).
 *
 * Spans format v1 and v3 (issue #1059). v3 is additive for everything read here:
 * `pending_count`/`pending` and `discovered_count` are new, nothing was removed,
 * and the one v3 REMOVAL (per-store `source_key`, moved to a sibling manifest,
 * #1178 item 5) was never read by this module or by the website. So both
 * versions parse through the same optional fields rather than a discriminated
 * union -- there is no branch to take, and a `format_version` switch here would
 * be a second thing to update for every future additive field.
 *
 * TRUST BOUNDARY: every field is `unknown` because this document is fetched from
 * the serving bucket, not constructed here -- the writer is a cron on another
 * host. The coverage equation `discovered == store + failure + pending` is
 * enforced by that producer (`check_index_invariant` in
 * `scripts/zarr/generate_zarr.py`) before publish; this type asserts nothing
 * about it, and `aggregateRecordingStats` re-derives the sum rather than
 * trusting `discovered_count`, precisely because a type cannot carry a
 * producer's invariant across the wire.
 */
export interface ZarrIndexJson {
  store_count?: unknown;
  stores?: unknown;
  failure_count?: unknown;
  failures?: unknown;
  /** v3: recordings with no store yet that are still expected to convert. */
  pending_count?: unknown;
  pending?: unknown;
  /** v3: raw recordings the walker found, the coverage denominator. */
  discovered_count?: unknown;
}

/**
 * Dataset-level recording statistics aggregated from a zarr index (epic
 * #1144 Phase 2, issue #1146). Column names mirror neuroschema's
 * dataSummary vocabulary (v0.4.0) 1:1 -- see migration 0070 for what NULL
 * means on each field.
 */
export interface RecordingStats {
  totalRecordingDuration: number | null;
  recordingDurationMin: number | null;
  recordingDurationMax: number | null;
  recordingCount: number;
  recordingsUnavailable: number;
  recordingsMeasured: number;
  channelCountMin: number | null;
  channelCountMax: number | null;
}

/**
 * Parse a JSON value as a non-negative finite number, REJECTING (not
 * clamping) anything else: NaN, +/-Infinity, non-numbers, and negatives all
 * become null. Every field this reads (n_channels, duration_s, store_count,
 * failure_count) is `minimum: 0` in the vendored neuroschema bundle, so a
 * negative input is malformed data, not a valid-but-inconvenient value.
 * Rejecting rather than clamping to 0 matters: a clamped negative duration
 * would be indistinguishable from a genuinely measured zero-length
 * recording, which is exactly the ambiguity `measuredCount` below exists to
 * avoid for the "nothing measured" case.
 */
function toFiniteNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Aggregate dataset-level recording statistics from a parsed zarr
 * `index.json` (epic #1144 Phase 2, issue #1146). Pure -- no I/O -- so it is
 * unit-testable against fixtures without a network call. `getZarrIndex`
 * below is the only caller that fetches, and it already has the whole
 * parsed body in hand: this is zero extra network for the feature.
 *
 * Two rules this function must get right, because real data cannot
 * currently falsify either one on its own:
 *
 * 1. MAX within a store, SUM across stores. Channel groups within one store
 *    are concurrent streams of a single recording (biosigIO names them
 *    `{modality}_{rate}hz`, so a file mixing sampling rates yields several
 *    groups); a store's duration is the longest of its groups, never their
 *    sum. Every store sampled across the whole catalog to date has exactly
 *    one group, so max and sum agree everywhere real data can check --
 *    the synthetic multi-group fixture in the test suite is the only thing
 *    that exercises the transposed-rule failure mode.
 *
 * 2. `index.stores` lists only recordings that CONVERTED. ADR 0027 made zarr
 *    discovery raw-only, so `stores` + `failures` + `pending` is the complete
 *    raw set for a dataset converted since that landed. This does NOT describe
 *    every dataset in the bucket today: AGENTS.md's Zarr section is explicit
 *    that stores published under `derivatives/`/`sourcedata/`/`code/` before
 *    the raw-only cutover are a separate, still-in-progress purge, and some
 *    are still served -- an unpurged legacy dataset's `stores` can include a
 *    non-raw entry. Recordings that failed conversion live in a sibling
 *    `failures` array and appear in neither -- so `recordingCount` is a SUM,
 *    never `stores.length` alone, or a corrupt/truncated upstream file
 *    silently vanishes from the count instead of showing up as "unavailable"
 *    (true regardless of the legacy caveat above). `store_count` (the
 *    converter's own authoritative field) is preferred over `stores.length`;
 *    the two should always agree, but the field is the source of truth,
 *    matching `storeCount` below.
 *
 *    Index v3 adds the third bucket, `pending`: recordings with no store that
 *    are still expected to convert (issue #1197). Before it they were in no
 *    list at all -- on008083 had 43 raw recordings, 2 stores, 36 failures, and
 *    five that appeared NOWHERE, so this function computed 38 of 43 and every
 *    number derived from it was quietly short. Pending recordings therefore
 *    count toward `recordingCount` and toward `recordingsUnavailable`: from a
 *    reader's position "no viewer, come back later" and "no viewer, ever" are
 *    both unavailable, and conflating them with "does not exist" is the bug.
 *    `discovered_count` is preferred when present because it is the producer's
 *    own denominator and the invariant it enforces
 *    (`discovered == store + failure + pending`) makes it identical to the sum;
 *    a v1 index has neither field, so the sum reduces to the old behaviour.
 *
 * A store whose groups all lack `duration_s` (or that has no groups at all)
 * is UNMEASURED: it contributes nothing to the duration sum/range and is
 * excluded from `recordingsMeasured`, but a group's `n_channels` still
 * counts toward the channel-count range even when that same group has no
 * duration (a channel count can be known before a full read is measured).
 * The inverse also holds -- a group with `duration_s` but no `n_channels`
 * (an old/degraded converter run) contributes to the duration sum and
 * `recordingsMeasured` while leaving the channel range untouched, so
 * `channelCountMin`/`Max` can be NULL independently of whether anything was
 * measured. When nothing measured, `totalRecordingDuration`/min/max are
 * NULL, not 0 -- a zero would read as "zero-length dataset" instead of "not
 * measured yet" (ADR 0005: availability is reported, never faked).
 */
export function aggregateRecordingStats(index: ZarrIndexJson): RecordingStats {
  const stores: ZarrIndexStoreJson[] = Array.isArray(index.stores) ? index.stores : [];
  const failures: unknown[] = Array.isArray(index.failures) ? index.failures : [];
  const pending: unknown[] = Array.isArray(index.pending) ? index.pending : [];
  const failureCount = toFiniteNonNegativeNumber(index.failure_count) ?? failures.length;
  const storeCount = toFiniteNonNegativeNumber(index.store_count) ?? stores.length;
  // Both absent on a v1 index, where the sum below reduces to store + failure.
  const pendingCount = toFiniteNonNegativeNumber(index.pending_count) ?? pending.length;
  const declaredDiscovered = toFiniteNonNegativeNumber(index.discovered_count);
  const summed = storeCount + failureCount + pendingCount;
  // The producer enforces `discovered == store + failure + pending` before it
  // publishes, so these agree -- and that is exactly why a disagreement must not
  // be believed silently. It means one of the two is wrong, and the sum is the
  // one derived from data this function can see: `discovered_count` is a single
  // integer that could be stale (a partially rewritten index) while the arrays
  // and their counts are internally consistent. Prefer the declared value when
  // it checks out, fall back to the sum with a warning when it does not.
  let discoveredCount = declaredDiscovered;
  if (declaredDiscovered !== null && declaredDiscovered !== summed) {
    console.warn(
      `aggregateRecordingStats: index coverage disagrees -- discovered_count=${declaredDiscovered} but store(${storeCount})+failure(${failureCount})+pending(${pendingCount})=${summed}; using the sum`,
    );
    discoveredCount = null;
  }

  let measuredCount = 0;
  let totalDuration = 0;
  let durationMin: number | null = null;
  let durationMax: number | null = null;
  let channelMin: number | null = null;
  let channelMax: number | null = null;

  for (const store of stores) {
    const groups: unknown[] = Array.isArray(store?.groups) ? store.groups : [];
    // MAX across this store's groups -- never sum. See rule 1 above.
    let storeDuration: number | null = null;
    for (const rawGroup of groups) {
      if (!rawGroup || typeof rawGroup !== "object") continue;
      const group = rawGroup as ZarrIndexGroupJson;

      const nChannels = toFiniteNonNegativeNumber(group.n_channels);
      if (nChannels !== null) {
        channelMin = channelMin === null ? nChannels : Math.min(channelMin, nChannels);
        channelMax = channelMax === null ? nChannels : Math.max(channelMax, nChannels);
      }

      const duration = toFiniteNonNegativeNumber(group.duration_s);
      if (duration !== null) {
        storeDuration = storeDuration === null ? duration : Math.max(storeDuration, duration);
      }
    }
    if (storeDuration !== null) {
      measuredCount++;
      totalDuration += storeDuration;
      durationMin = durationMin === null ? storeDuration : Math.min(durationMin, storeDuration);
      durationMax = durationMax === null ? storeDuration : Math.max(durationMax, storeDuration);
    }
  }

  return {
    totalRecordingDuration: measuredCount > 0 ? totalDuration : null,
    recordingDurationMin: measuredCount > 0 ? durationMin : null,
    recordingDurationMax: measuredCount > 0 ? durationMax : null,
    // The producer's own denominator when it published one AND it checks out;
    // otherwise the sum. Never `stores.length`.
    recordingCount: discoveredCount ?? summed,
    recordingsUnavailable: failureCount + pendingCount,
    recordingsMeasured: measuredCount,
    channelCountMin: channelMin,
    channelCountMax: channelMax,
  };
}

/** Latest-only zarr conversion facts read from `<id>/zarr/index.json`. */
export interface ZarrIndexInfo {
  /**
   * Number of `.zarr` stores the converter wrote (its authoritative count).
   * null when index.json exists but lacks a numeric `store_count` (e.g. an older
   * converter); the row is still recorded 'ready' with a NULL count.
   */
  storeCount: number | null;
  /** Source dataset commit the conversion was built from. */
  sourceCommit: string | null;
  /**
   * The discovery/dispatch generation that produced this index
   * (`zarr_queue.ZARR_ENGINE_VERSION`, index v3+). null on a v1 index, which
   * predates the field.
   *
   * Read because a producer-side change reaches the back catalogue only through
   * this stamp (ADR 0033): during a re-conversion wave the catalog holds a mix
   * of engines, and a sweep or a dashboard that cannot tell them apart cannot
   * say whether a dataset's facts are the new ones yet.
   */
  engineVersion: string | null;
  /** ETag of index.json, mirrors what /webhooks/zarr-ready stores. */
  etag: string | null;
  /**
   * Dataset-level recording duration/count/channel-range facts, aggregated
   * from the same parsed body (epic #1144 Phase 2). Zero extra network --
   * getZarrIndex already fetched and parsed the whole index for storeCount.
   */
  recordingStats: RecordingStats;
}

/**
 * Read a dataset's zarr catalog at `s3://<bucket>/<id>/zarr/index.json`, the
 * signal of "is this dataset converted?". The converter (generate_zarr.py)
 * writes index.json only when stores exist, with a top-level integer
 * `store_count` + `source_commit`, so a 200 means converted and the count is
 * authoritative (no need to LIST `.zarr` prefixes). Used by the admin
 * zarr-sweep backfill to reconcile the stale zarr_status column from S3.
 *
 * Returns the parsed facts on 200, null on 404/403 (not converted). A 403 is
 * treated as absent (not thrown), following the same rationale as `headArchiveKey`:
 * with the Worker's S3 creds (which lack s3:ListBucket), a missing object returns
 * 403 (AccessDenied), not 404. Throwing on 403 would make the sweep never
 * converge — every legitimately-zarr-less public dataset would error on every run
 * instead of being stamped checked. (Unlike `headArchiveKey`, which retries a 403
 * before treating it as absent, this does a single GET; and unlike
 * `headVersionArtifact`, which throws on 403, this returns null.) Any OTHER
 * non-2xx still throws (a true infra failure, recorded per-dataset). The "creds
 * globally broken -> mass-mark absent" risk is bounded by the operator inspecting
 * the sweep's ready/absent counts before draining (a known-converted dataset
 * coming back absent flags it).
 *
 * Also runs `aggregateRecordingStats` over the same parsed body (epic #1144
 * Phase 2) -- zero extra network, since the whole index is already fetched
 * and parsed here for `storeCount`/`sourceCommit`.
 */
export async function getZarrIndex(
  options: PresignedUrlOptions,
  datasetId: string,
): Promise<ZarrIndexInfo | null> {
  const { bucket, region } = options;
  const key = `${datasetId}/zarr/index.json`;
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const url = `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;

  // Signed GET: works whether or not the public-read carve-out is in place for
  // this prefix, and a present object always 200s with valid Worker creds.
  const aws = createS3Client(options);
  const signed = await aws.sign(url, { method: "GET" });
  const response = await fetch(signed);

  if (response.status === 404) return null;
  if (response.status === 403) {
    // Missing object without s3:ListBucket, or a creds issue. Treat as absent
    // (mirrors headArchiveKey); the sweep stamps zarr_checked_at and moves on.
    console.warn(`getZarrIndex: 403 for ${key} (missing-without-ListBucket or creds) — absent`);
    return null;
  }
  if (!response.ok) {
    throw new Error(`getZarrIndex ${response.status} for ${key} (infra failure)`);
  }

  const etag = response.headers.get("etag");
  let parsed: ZarrIndexJson & { source_commit?: unknown; engine_version?: unknown };
  try {
    parsed = (await response.json()) as ZarrIndexJson & {
      source_commit?: unknown;
      engine_version?: unknown;
    };
  } catch (err) {
    throw new Error(
      `getZarrIndex: ${key} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return {
    storeCount: typeof parsed.store_count === "number" ? parsed.store_count : null,
    sourceCommit: typeof parsed.source_commit === "string" ? parsed.source_commit : null,
    engineVersion: typeof parsed.engine_version === "string" ? parsed.engine_version : null,
    etag,
    recordingStats: aggregateRecordingStats(parsed),
  };
}

/**
 * Apply S3 Object Lock (Governance mode) to all objects under a dataset's
 * objects/ prefix. Uses a 100-year retention period to effectively make
 * data blobs immutable. Manifests (version/) and archives (archives/) are
 * excluded so they can be updated or regenerated if needed.
 *
 * Streams via S3 ListObjectsV2 continuation tokens: each invocation issues
 * exactly **one** LIST page (capped to `batchSize` keys via `max-keys`)
 * plus up to `batchSize` PutObjectRetention calls. Per-invocation
 * subrequest cost is bounded at ~`batchSize + 1` regardless of dataset
 * size — this is the load-bearing property that keeps us under
 * Cloudflare Workers' per-invocation subrequest cap on every plan tier.
 *
 * The previous offset-based approach paginated the *entire* dataset on
 * every call (full LIST plus a 40-PUT slice), which compounded across
 * batches and tripped the cap on the SCCN deployment for datasets with
 * even a few hundred objects. See #385 for the regression analysis.
 *
 * Idempotent on retry: 403 responses (already-locked objects) are
 * counted as success, so re-invoking with the same continuation token
 * after a transient failure is safe.
 */
export interface ObjectLockFailure {
  key: string;
  error: string;
}

export async function applyObjectLockBatch(
  options: PresignedUrlOptions,
  datasetId: string,
  continuationToken?: string,
  // Sized for Cloudflare Workers Paid plan (1,000 subrequests per
  // invocation). Per-invocation cost: ~7 D1 + 1 LIST + 100 PUTs +
  // ~15 hidden runtime overhead = ~123 subrequests, leaving 8× headroom
  // before the cap. Halves CLI round-trips from the previous 25-batch
  // value (e.g. nm000103: 36 batches instead of 141) and lets most
  // approvals complete in a single invocation without using the retry
  // loop. Note: this requires the deployed worker to be on Workers Paid
  // (Free plan caps at 50 subrequests, which doesn't fit 100 PUTs).
  batchSize = 100,
): Promise<{
  locked: number;
  failed: ObjectLockFailure[];
  hasMore: boolean;
  nextContinuationToken?: string;
}> {
  const { bucket, region } = options;
  const aws = createS3Client(options);

  // Single-page list with max-keys=batchSize. This is the only LIST call
  // per invocation — no full pagination here.
  const params = new URLSearchParams({
    "list-type": "2",
    prefix: `${datasetId}/objects/`,
    "max-keys": String(batchSize),
    ...(continuationToken ? { "continuation-token": continuationToken } : {}),
  });
  const listUrl = `https://${bucket}.s3.${region}.amazonaws.com/?${params.toString()}`;
  const signedList = await aws.sign(listUrl, { method: "GET" });
  const listRes = await fetch(signedList);
  if (!listRes.ok) {
    throw new Error(`Failed to list objects for lock: HTTP ${listRes.status}`);
  }
  const xml = await listRes.text();
  if (!xml.includes("<ListBucketResult")) {
    throw new Error(`Unexpected S3 response (not ListBucketResult): ${xml.slice(0, 200)}`);
  }

  const keys: string[] = [];
  for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);

  const truncated = xml.includes("<IsTruncated>true</IsTruncated>");
  const tokenMatch = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);

  // S3 contract violation guard: IsTruncated=true MUST come with a
  // NextContinuationToken. If we silently treated this as "stream done",
  // we'd mark s3_lock complete with the dataset only partially locked —
  // exactly the failure mode S3 Object Lock exists to prevent. Throw so
  // the orchestrator surfaces a 500 and the CLI retries.
  if (truncated && !tokenMatch?.[1]) {
    throw new Error(
      "S3 LIST response was truncated but NextContinuationToken is missing; aborting to avoid partial object lock",
    );
  }
  // Only honor the token when the page is genuinely truncated. AWS does
  // not emit NextContinuationToken on a non-truncated page; this guard
  // is just defensive against malformed proxies.
  const nextContinuationToken = truncated ? tokenMatch?.[1] : undefined;

  const failed: ObjectLockFailure[] = [];
  let locked = 0;

  // Empty page is allowed by the S3 contract (e.g. all matching keys on
  // this page were deleted between request and response). Preserve the
  // continuation token so the caller can advance through subsequent
  // pages instead of stopping the stream short of the dataset's tail.
  if (keys.length === 0) {
    return {
      locked: 0,
      failed,
      hasMore: !!nextContinuationToken,
      nextContinuationToken,
    };
  }

  // Retention date: 100 years from now
  const retainUntil = new Date();
  retainUntil.setFullYear(retainUntil.getFullYear() + 100);
  const retainUntilStr = retainUntil.toISOString();

  const retentionXml = `<?xml version="1.0" encoding="UTF-8"?>
<Retention xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Mode>GOVERNANCE</Mode>
  <RetainUntilDate>${retainUntilStr}</RetainUntilDate>
</Retention>`;

  // Compute Content-MD5 (required by S3 PutObjectRetention)
  const bodyBytes = new TextEncoder().encode(retentionXml);
  const contentMd5 = await computeMd5Base64(bodyBytes);

  // Parallelize the PUTs. Subrequest count is identical to a sequential
  // loop (each fetch counts once regardless of order), but wall time
  // drops from ~50ms × N to roughly the slowest individual PUT — for
  // 100 keys that's ~500ms instead of ~5s. Workers Paid gives us a 30s
  // CPU budget, so signing 100 requests in parallel is comfortable.
  // Failure ordering becomes nondeterministic; for a partial-fail
  // batch the CLI replays via the same continuation token, so order
  // doesn't affect correctness.
  const lockResults = await Promise.all(
    keys.map(async (key) => {
      // Encode each path segment individually, preserving "/" separators
      const encodedKey = key.split("/").map(encodeURIComponent).join("/");
      const url = `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}?retention`;
      try {
        const signed = await aws.sign(url, {
          method: "PUT",
          headers: {
            "Content-Type": "application/xml",
            "Content-MD5": contentMd5,
          },
          body: retentionXml,
        });

        const res = await fetch(signed);
        if (res.ok || res.status === 403) {
          // 200: newly locked; 403: already locked (object protected)
          return { ok: true as const };
        }
        const errorText = await res.text().catch(() => "");
        return {
          ok: false as const,
          failure: { key, error: `HTTP ${res.status}: ${errorText}`.trim() },
        };
      } catch (err) {
        return {
          ok: false as const,
          failure: { key, error: err instanceof Error ? err.message : String(err) },
        };
      }
    }),
  );

  for (const r of lockResults) {
    if (r.ok) locked++;
    else failed.push(r.failure);
  }

  return {
    locked,
    failed,
    hasMore: !!nextContinuationToken,
    nextContinuationToken,
  };
}

/**
 * Get the current S3 bucket policy
 * Returns null if no policy is set
 */
export async function getBucketPolicy(options: PresignedUrlOptions): Promise<BucketPolicy | null> {
  const { bucket, region, endpointUrl } = options;
  const aws = createS3Client(options);
  // Honors the test-only endpoint override (#1522), the same idiom
  // `fetchManifestObject` already uses: unset in every deployment, so
  // production always signs against the real bucket host.
  const origin = (endpointUrl ?? `https://${bucket}.s3.${region}.amazonaws.com`).replace(
    /\/+$/,
    "",
  );
  const url = `${origin}/?policy`;

  const signed = await aws.sign(url, { method: "GET" });
  const response = await fetch(signed);

  if (response.status === 404) {
    return null; // No policy set
  }

  if (!response.ok) {
    throw new Error(`Failed to get bucket policy: HTTP ${response.status}`);
  }

  const policyText = await response.text();
  try {
    return JSON.parse(policyText);
  } catch (parseErr) {
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    throw new Error(
      `Failed to parse bucket policy for "${bucket}": ${msg} (body: ${policyText.slice(0, 200)})`,
    );
  }
}

/**
 * Overwrite the bucket policy with the given document.
 */
async function putBucketPolicy(options: PresignedUrlOptions, policy: BucketPolicy): Promise<void> {
  const size = policyByteSize(policy);
  if (size > MAX_BUCKET_POLICY_BYTES) {
    // Should be unreachable in the deny-list model (the policy scales with the
    // small private set), but guard so we fail loudly rather than let AWS
    // reject the PUT with an opaque MalformedPolicy error.
    throw new Error(
      `Bucket policy would be ${size} bytes, exceeding the ${MAX_BUCKET_POLICY_BYTES}-byte limit`,
    );
  }

  const { bucket, region } = options;
  const aws = createS3Client(options);
  const url = `https://${bucket}.s3.${region}.amazonaws.com/?policy`;

  const signed = await aws.sign(url, {
    method: "PUT",
    body: JSON.stringify(policy),
    headers: { "Content-Type": "application/json" },
  });

  const response = await fetch(signed);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to update bucket policy: HTTP ${response.status} - ${errorText}`);
  }
}

/**
 * Apply a private/public transition to the bucket policy, then verify the
 * change persisted (read-after-write) and retry on a lost update.
 *
 * The bucket policy is a single shared document mutated read-modify-write, so
 * two concurrent transitions can clobber each other. The private direction is
 * leak-sensitive (a dropped carve-out makes objects publicly readable), so we
 * re-read and retry until the policy reflects the intended state.
 */
async function transitionDatasetVisibility(
  options: PresignedUrlOptions,
  datasetId: string,
  makePrivate: boolean,
): Promise<void> {
  if (!isValidDatasetId(datasetId)) {
    throw new Error(`Invalid dataset ID for bucket policy: "${datasetId}"`);
  }
  const { bucket } = options;

  const MAX_ATTEMPTS = 3;
  let lastSeen: boolean | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const current = await getBucketPolicy(options);

    // Fast path: already in the desired state. Avoids a needless policy
    // rewrite (and the concurrent-write race it would invite) on idempotent
    // calls, e.g. deleting an already-public dataset.
    if (isDatasetPrivate(current, bucket, datasetId) === makePrivate) {
      return;
    }

    const next = makePrivate
      ? addPrivateDataset(current, bucket, datasetId)
      : removePrivateDataset(current, bucket, datasetId);
    try {
      await putBucketPolicy(options, next);
    } catch (putErr) {
      const msg = putErr instanceof Error ? putErr.message : String(putErr);
      throw new Error(
        `Bucket-policy ${makePrivate ? "private" : "public"} write for ${datasetId} failed ` +
          `(attempt ${attempt}/${MAX_ATTEMPTS}): ${msg}`,
      );
    }

    // Read-after-write: confirm the carve-out reflects the intended state.
    const verifyPolicy = await getBucketPolicy(options);
    lastSeen = isDatasetPrivate(verifyPolicy, bucket, datasetId);
    if (lastSeen === makePrivate) {
      return;
    }
    console.warn(
      `[s3] Bucket-policy ${makePrivate ? "private" : "public"} transition for ${datasetId} ` +
        `did not persist (attempt ${attempt}/${MAX_ATTEMPTS}); likely a concurrent update, retrying`,
    );
  }

  throw new Error(
    `Failed to mark ${datasetId} ${makePrivate ? "private" : "public"} after ${MAX_ATTEMPTS} attempts ` +
      `(last observed private=${lastSeen}); concurrent bucket-policy update suspected`,
  );
}

/**
 * Carve a dataset out of public access (make its objects non-public).
 *
 * Used at dataset creation and when reverting a dataset to private. Adds the
 * dataset's prefix to the public-read statement's NotResource list; private
 * objects then remain readable only via the existing IAM identity policies.
 */
export async function markDatasetPrivate(
  options: PresignedUrlOptions,
  datasetId: string,
): Promise<void> {
  await transitionDatasetVisibility(options, datasetId, true);
}

/**
 * Grant a dataset public read access (remove its private carve-out).
 *
 * Used when publishing / making a repo public. Removes the dataset's prefix
 * from the public-read statement's NotResource list so anonymous GetObject is
 * allowed. Idempotent. Also used by deletion cleanup to drop a stale carve-out.
 */
export async function markDatasetPublic(
  options: PresignedUrlOptions,
  datasetId: string,
): Promise<void> {
  await transitionDatasetVisibility(options, datasetId, false);
}

/**
 * Check whether a dataset currently has public read access (no private
 * carve-out in the bucket policy).
 *
 * Note the public-by-default semantics: a dataset is "public" whenever it is
 * not carved out, so a missing/empty policy reports `true` (the inverse of the
 * old allow-list model, where no policy meant not-public).
 */
export async function hasPublicRead(
  options: PresignedUrlOptions,
  datasetId: string,
): Promise<boolean> {
  const policy = await getBucketPolicy(options);
  return !isDatasetPrivate(policy, options.bucket, datasetId);
}

/**
 * Canonical (post-#1491) archive S3 key. The file name in a presigned S3
 * URL's path is the browser's default Save-As name, so embedding the
 * dataset id here is what makes a download named `on002718_v1.0.0.zip`
 * instead of the pre-#1491 bare `v1.0.0.zip` -- no
 * `response-content-disposition` header involved, by owner decision (#1491).
 */
export function archiveKey(datasetId: string, version: string): string {
  const versionTag = version.startsWith("v") ? version : `v${version}`;
  return `${datasetId}/archives/${datasetId}_${versionTag}.zip`;
}

/**
 * #1491 TRANSITION FALLBACK. The pre-#1491 archive key
 * (`<id>/archives/v<version>.zip`, no dataset id in the file name).
 * `resolveArchiveKey` is the ONLY caller: every reader tries {@link
 * archiveKey} first and falls back to this one so a download keeps working
 * for a dataset the lead's one-time rename sweep
 * (`scripts/rename-archives.ts`) has not reached yet. DELETE this function
 * and its one call site in `resolveArchiveKey` once the sweep has run
 * against every pre-#1491 archive -- that is the whole removal.
 */
export function legacyArchiveKey(datasetId: string, version: string): string {
  const versionTag = version.startsWith("v") ? version : `v${version}`;
  return `${datasetId}/archives/${versionTag}.zip`;
}

/**
 * HEAD one archive key. true = present, false = 404. Throws on 403
 * (credentials) or other non-404 errors so the caller can 503 rather than
 * 302 to a presigned URL that would dump an S3 NoSuchKey XML error (#670).
 *
 * `endpointUrl` is the same TEST-ONLY origin override `fetchManifestObject`
 * honors; unset in every deployment.
 */
async function headArchiveKey(options: PresignedUrlOptions, key: string): Promise<boolean> {
  const { bucket, region, endpointUrl } = options;
  const aws = createS3Client(options);
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const origin = (endpointUrl ?? `https://${bucket}.s3.${region}.amazonaws.com`).replace(
    /\/+$/,
    "",
  );
  const url = `${origin}/${encodedKey}`;

  // The first HEAD from a cold Worker isolate intermittently fails with a
  // transient network error or 5xx; retry so a download click doesn't fail on
  // the first try. 200 => present, 404 => absent.
  const MAX_ATTEMPTS = 4;
  let lastStatus = 0;
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let status: number;
    try {
      const signed = await aws.sign(url, { method: "HEAD" });
      status = (await fetch(signed)).status;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue; // network error: retry
    }
    if (status === 200) return true;
    if (status === 404) return false;
    lastStatus = status;
    lastError = `HTTP ${status}`;
    // Retry transient 5xx and an ambiguous 403 (a cold S3 edge can 403
    // transiently; a missing object also 403s when the Worker creds lack
    // s3:ListBucket). Break immediately on any other 4xx (a real client bug).
    if (status !== 403 && status < 500) break;
  }

  // A persistent 403 means the object is missing (no s3:ListBucket to get a
  // 404) or the credentials are wrong; either way it is not downloadable, so
  // report "not available" (the caller returns a clean 404) rather than 503ing
  // the user. Log for operators -- a genuine credentials outage also breaks
  // the manifest/summary routes, so it will not go unnoticed.
  if (lastStatus === 403) {
    console.warn(
      `headArchiveKey: persistent 403 for ${key} (missing object without s3:ListBucket, or credentials issue); treating as not available`,
    );
    return false;
  }
  throw new Error(`Failed to HEAD ${key} after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}

/**
 * Resolve which archive key actually exists in S3 for (datasetId, version):
 * the #1491 name first, falling back to the pre-#1491 name during the
 * transition window (see {@link legacyArchiveKey}). Returns null when
 * neither HEADs present (e.g. generation still in flight after a fresh
 * publish). This is the ONE place the #1491 fallback lives, so retiring the
 * fallback after the lead's rename sweep is a one-line change here.
 *
 * The route (`routes/data.ts`) calls this directly and presigns the result
 * itself in one pass. Earlier versions of this module exposed `headArchive`
 * and `getArchiveUrl` convenience wrappers that each called this a second
 * time; they were removed (PR review, #1491) once nothing else imported
 * them, since keeping unused wrappers around this exact function would
 * invite a future caller back into the double-resolve they were removed to
 * avoid.
 */
export async function resolveArchiveKey(
  options: PresignedUrlOptions,
  datasetId: string,
  version: string,
): Promise<string | null> {
  const newKey = archiveKey(datasetId, version);
  if (await headArchiveKey(options, newKey)) return newKey;
  // #1491 TRANSITION FALLBACK: remove this branch (and legacyArchiveKey)
  // once the lead confirms the rename sweep has reached every archive.
  const oldKey = legacyArchiveKey(datasetId, version);
  if (await headArchiveKey(options, oldKey)) return oldKey;
  return null;
}

// ---------------------------------------------------------------------------
// Public-access propagation gate (epic #736, Phase 4 / #741)
// ---------------------------------------------------------------------------

/**
 * Extract the first object `<Key>` from an S3 ListBucketResult XML page. Pure;
 * returns null when the page has no `<Contents>` (empty prefix). Reuses the
 * `<Contents>…<Key>` shape already parsed in `getArchiveSize`.
 */
export function firstObjectKeyFromListXml(xml: string): string | null {
  const m = xml.match(/<Contents>[\s\S]*?<Key>([^<]+)<\/Key>/);
  return m ? m[1] : null;
}

/** Outcome of a public-access propagation probe. */
export interface PublicPropagationResult {
  /** false when the dataset has no annexed objects to probe. */
  checked: boolean;
  /** true once an anonymous HEAD of a real blob returned 200. */
  propagated: boolean;
  /** Number of anonymous HEAD attempts made. */
  attempts: number;
  /** The probed object key (null when nothing was found to probe). */
  key: string | null;
}

/**
 * After `markDatasetPublic`, confirm a real blob is actually anonymously
 * readable. The deny-list removal is a bucket-policy change with AWS
 * eventual-consistency lag; this bounded poll surfaces a slow/stuck propagation
 * instead of the publish silently advancing while blobs still 403 to the public
 * (the nm000111 failure mode).
 *
 * Best-effort and NON-fatal -- the caller logs the result and proceeds: by the
 * time the tag push fires generate-archive (several steps later) propagation has
 * completed in practice, and Phase 1's signed reads removed the hard dependency
 * regardless. Probes with an UNSIGNED HEAD; a signed request would always 200
 * and would not test *public* access.
 */
export async function waitForPublicPropagation(
  options: PresignedUrlOptions,
  datasetId: string,
  opts?: { maxAttempts?: number; delayMs?: number },
): Promise<PublicPropagationResult> {
  const maxAttempts = opts?.maxAttempts ?? 6;
  const delayMs = opts?.delayMs ?? 2000;
  const { bucket, region } = options;

  // Grab any one blob under objects/ to probe (the first page is enough).
  let key: string | null = null;
  try {
    for await (const xml of listObjectPages(options, `${datasetId}/objects/`)) {
      key = firstObjectKeyFromListXml(xml);
      break;
    }
  } catch (err) {
    console.warn(
      `[public-propagation] could not list objects for ${datasetId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { checked: false, propagated: false, attempts: 0, key: null };
  }

  if (!key) {
    // No annexed objects (everything is in git) -> nothing to propagate.
    return { checked: false, propagated: false, attempts: 0, key: null };
  }

  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const url = `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let status = 0;
    try {
      status = (await fetch(url, { method: "HEAD" })).status;
    } catch {
      // Transient network error from a cold isolate: fall through to retry.
    }
    if (status === 200) {
      return { checked: true, propagated: true, attempts: attempt, key };
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return { checked: true, propagated: false, attempts: maxAttempts, key };
}

// ---------------------------------------------------------------------------
// Object deletion
// ---------------------------------------------------------------------------

export interface DeleteResult {
  deleted: number;
  failed: Array<{ key: string; error: string }>;
}

/**
 * Compute base64-encoded MD5 digest (required by S3 Multi-Object Delete).
 * Uses Web Crypto API available in Cloudflare Workers.
 */
async function computeMd5Base64(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("MD5", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

/**
 * Parse one batch's `<DeleteResult>` XML response from the S3 Multi-Object
 * Delete API into a deletion count and structured failures. Extracted as a
 * pure function -- mirroring `mergeObjectSizesPage` and
 * `firstObjectKeyFromListXml` above -- so it is testable directly against
 * synthetic XML without a live bucket; `deleteObjects` builds its URL from a
 * literal `<bucket>.s3.<region>.amazonaws.com` host with no override seam.
 *
 * `deleteObjects` escapes every key with `escapeXml` before sending the
 * request, so S3 echoes escaped bytes back in `<Key>` (and `<Message>`, when
 * it quotes the key). Those are decoded with `unescapeXml` here so a caller
 * inspecting `failed[].key` sees the real key, not `me&amp;you.txt` for a
 * key that is actually `me&you.txt` -- the value an operator would act on.
 * `<Code>` is left alone: S3 error codes are alphanumeric
 * (e.g. `AccessDenied`), so no code ever contains an XML entity in
 * practice, and decoding it would be a no-op either way.
 */
export function parseDeleteObjectsResponse(
  xml: string,
  batch: string[],
  batchStartIndex: number,
): Pick<DeleteResult, "deleted" | "failed"> {
  const failed: DeleteResult["failed"] = [];

  // Verify this is a valid DeleteResult response
  if (!xml.includes("<DeleteResult")) {
    for (const key of batch) {
      failed.push({ key, error: "Unexpected S3 response: missing DeleteResult" });
    }
    return { deleted: 0, failed };
  }

  // Count successful deletions
  let deleted = 0;
  const deletedMatches = xml.matchAll(/<Deleted>\s*<Key>([^<]+)<\/Key>/g);
  for (const _ of deletedMatches) {
    deleted++;
  }

  // Collect failures (handle any element order within <Error>)
  let batchFailed = 0;
  const errorBlocks = xml.matchAll(/<Error>([\s\S]*?)<\/Error>/g);
  for (const block of errorBlocks) {
    const inner = block[1];
    const keyMatch = inner.match(/<Key>([^<]+)<\/Key>/);
    const codeMatch = inner.match(/<Code>([^<]+)<\/Code>/);
    const msgMatch = inner.match(/<Message>([^<]*)<\/Message>/);
    const key = keyMatch ? unescapeXml(keyMatch[1]) : "unknown";
    const message = msgMatch ? unescapeXml(msgMatch[1]) : "";
    failed.push({
      key,
      error: `${codeMatch?.[1] ?? "UnknownError"}: ${message}`,
    });
    batchFailed++;
  }

  // Validate that parsed results account for all keys in batch
  const accounted = deleted + batchFailed;
  if (accounted < batch.length) {
    const missing = batch.length - accounted;
    failed.push({
      key: `(${missing} unaccounted keys in batch starting at index ${batchStartIndex})`,
      error: "XML parsing gap: S3 response did not account for all keys",
    });
  }

  return { deleted, failed };
}

/**
 * Delete multiple S3 objects in a single request using the Multi-Object
 * Delete API (POST /?delete). Accepts up to 1000 keys per call.
 *
 * When `bypassGovernance` is true, sends the
 * `x-amz-bypass-governance-retention` header so that objects under
 * GOVERNANCE-mode Object Lock can be deleted.
 */
export async function deleteObjects(
  options: PresignedUrlOptions,
  keys: string[],
  bypassGovernance = false,
): Promise<DeleteResult> {
  if (keys.length === 0) {
    return { deleted: 0, failed: [] };
  }

  const { bucket, region } = options;
  const aws = createS3Client(options);
  const result: DeleteResult = { deleted: 0, failed: [] };

  // S3 Multi-Object Delete accepts at most 1000 keys per request
  const BATCH_SIZE = 1000;

  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const batch = keys.slice(i, i + BATCH_SIZE);

    // Build XML request body
    const objectElements = batch.map((k) => `<Object><Key>${escapeXml(k)}</Key></Object>`).join("");
    const deleteXml = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>false</Quiet>${objectElements}</Delete>`;

    const bodyBytes = new TextEncoder().encode(deleteXml);
    const contentMd5 = await computeMd5Base64(bodyBytes);

    const url = `https://${bucket}.s3.${region}.amazonaws.com/?delete`;
    const headers: Record<string, string> = {
      "Content-Type": "application/xml",
      "Content-MD5": contentMd5,
    };
    if (bypassGovernance) {
      headers["x-amz-bypass-governance-retention"] = "true";
    }

    try {
      const signed = await aws.sign(url, {
        method: "POST",
        headers,
        body: deleteXml,
      });

      const res = await fetch(signed);
      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        for (const key of batch) {
          result.failed.push({ key, error: `HTTP ${res.status}: ${errorText}`.trim() });
        }
        continue;
      }

      const xml = await res.text();
      const parsed = parseDeleteObjectsResponse(xml, batch, i);
      result.deleted += parsed.deleted;
      result.failed.push(...parsed.failed);
    } catch (err) {
      for (const key of batch) {
        result.failed.push({ key, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return result;
}

/**
 * Delete all S3 objects belonging to a dataset.
 *
 * Scans the entire `{datasetId}/` prefix rather than enumerating known
 * sub-paths, ensuring nothing is missed if the prefix structure evolves.
 *
 * Validates the dataset ID before proceeding to prevent accidental deletion
 * of unrelated S3 paths.
 */
export async function deleteDatasetObjects(
  options: PresignedUrlOptions,
  datasetId: string,
  bypassGovernance = false,
): Promise<DeleteResult> {
  if (!isValidDatasetId(datasetId)) {
    throw new Error(`Invalid dataset ID for deletion: "${datasetId}"`);
  }

  const keys = await listObjectKeys(options, `${datasetId}/`);
  if (keys.length === 0) {
    return { deleted: 0, failed: [] };
  }

  return deleteObjects(options, keys, bypassGovernance);
}

/**
 * Delete all S3 objects in a PR staging area for a dataset.
 * Stored at: staging/pr-{prNumber}/{datasetId}/
 */
export async function deleteStagingObjects(
  options: PresignedUrlOptions,
  prNumber: number,
  datasetId: string,
): Promise<DeleteResult> {
  if (!isValidDatasetId(datasetId)) {
    throw new Error(`Invalid dataset ID for staging cleanup: "${datasetId}"`);
  }
  if (!Number.isInteger(prNumber) || prNumber < 1) {
    throw new Error(`Invalid PR number for staging cleanup: ${prNumber}`);
  }

  const prefix = `staging/pr-${prNumber}/${datasetId}/`;
  const keys = await listObjectKeys(options, prefix);

  if (keys.length === 0) {
    return { deleted: 0, failed: [] };
  }

  return deleteObjects(options, keys);
}
