/**
 * Import S3 integrity primitive (epic #967 Phase 2, issue #969).
 *
 * Cheap, Worker-side per-key verification: does every annex-keyed file in a
 * dataset's published version manifest actually exist in S3 at its declared
 * size? This is the general check behind two callers:
 *   - the retry engine's reclassification sweep, which walks `complete`
 *     import_jobs rows looking for the #967 bug (a failed curl fallback left
 *     a 0-byte object behind, so the import silently under-delivered), and
 *   - the retry engine's "verify current state first" step before deciding
 *     whether to blocklist or re-dispatch an incomplete/failed/quarantined row.
 *
 * `annexKeyDeclaredSize`/`isKeyPresentAtDeclaredSize` are re-exported from
 * `shared/annex-key.ts` so existing importers keep their path. That module owns
 * the chunked-key rule: content stored as `-S<size>-C<n>` chunk objects counts as
 * present when a chunking is complete (#1565, ADR 0064 amendment 2026-10-07).
 */

import { annexKeyDeclaredSize, isKeyPresentAtDeclaredSize } from "../../../shared/annex-key.js";
import type { Bindings } from "../types/bindings.js";
import { resolveCurrentVersion } from "./archive-retry.js";
import { testS3EndpointOverride } from "./environment.js";
import { type PresignedUrlOptions, getManifest, listObjectSizes } from "./s3.js";

export { annexKeyDeclaredSize, isKeyPresentAtDeclaredSize };

/** The subset of VersionManifest (services/manifest.ts) this check needs. */
export interface ExpectedManifestFile {
  key: string;
  size: number;
}

export interface ImportIntegrityResult {
  complete: boolean;
  missingKeys: string[];
  zeroByteKeys: string[];
  expectedCount: number;
  presentCount: number;
}

/**
 * Pure comparison: the manifest's expected annex-keyed files vs. the live
 * `<id>/objects/` listing. `expected` is null when there is no published
 * manifest to compare against (the import never reached finalize/publish) --
 * conservatively `complete: false`, since completeness cannot be claimed
 * without an expected key set. `git:`-keyed entries (regular files stored in
 * GitHub, never copied to S3) are excluded from the expected set entirely.
 *
 * `zeroByteKeys` is the subset of `missingKeys` that IS present in `existing`
 * but at 0 bytes with a nonzero declared size -- the specific "corrupt
 * leftover from a failed copy" signature (#967), distinct from a key that
 * never landed at all. A key whose declared size is genuinely 0 (a real empty
 * file) is never flagged as missing or zero-byte.
 */
export function compareManifestToListing(
  expected: Record<string, ExpectedManifestFile> | null,
  existing: Map<string, number>,
): ImportIntegrityResult {
  if (expected === null) {
    return {
      complete: false,
      missingKeys: [],
      zeroByteKeys: [],
      expectedCount: 0,
      presentCount: existing.size,
    };
  }

  const annexEntries = Object.values(expected).filter((f) => !f.key.startsWith("git:"));
  const missingKeys: string[] = [];
  const zeroByteKeys: string[] = [];
  for (const entry of annexEntries) {
    if (isKeyPresentAtDeclaredSize(entry.key, existing)) continue;
    missingKeys.push(entry.key);
    const declared = annexKeyDeclaredSize(entry.key);
    if (existing.get(entry.key) === 0 && declared !== 0) zeroByteKeys.push(entry.key);
  }

  return {
    complete: missingKeys.length === 0,
    missingKeys,
    zeroByteKeys,
    expectedCount: annexEntries.length,
    presentCount: annexEntries.length - missingKeys.length,
  };
}

interface VersionManifestLike {
  files?: Record<string, ExpectedManifestFile>;
}

/**
 * Parse a version manifest JSON string into its files map, or null when the
 * JSON is unparseable OR parses but carries no `files` key. A manifest with
 * no `files` key is malformed, not "zero expected files" -- returning `{}`
 * there would make {@link compareManifestToListing} report complete:true
 * regardless of what's actually in S3, defeating the conservative-by-default
 * invariant this whole check exists to uphold. Pure; exported for testing.
 */
export function parseManifestFiles(
  manifestJson: string,
): Record<string, ExpectedManifestFile> | null {
  try {
    const parsed = JSON.parse(manifestJson) as VersionManifestLike;
    return parsed.files ?? null;
  } catch {
    return null;
  }
}

/**
 * {@link verifyDatasetVersionS3} result: the per-key completeness comparison
 * plus the totals needed to source an honest `file_size`/`total_files`/
 * `bytes_present` (epic #967 Phase 3, #970) without a second S3 round-trip.
 */
export interface DatasetVersionIntegrityResult extends ImportIntegrityResult {
  /** Sum of bytes actually present under `<id>/objects/` (the live S3 listing) --
   *  the same listing used for the completeness check, regardless of whether any
   *  given key matches its declared size. */
  bytesPresent: number;
  /** Sum of `ManifestFile.size` across EVERY parsed manifest entry (annex-keyed
   *  AND `git:`-keyed) -- the honest logical dataset size. 0 when there is no
   *  usable manifest ({@link version} is null in that case). */
  declaredBytes: number;
  /** Count of every parsed manifest entry (annex-keyed AND `git:`-keyed). 0 when
   *  there is no usable manifest. */
  declaredFiles: number;
  /** The version this result actually reflects, or null when no manifest could
   *  be resolved/parsed for it (caller should fall back to the pre-manifest S3
   *  sum and leave completeness unknown, not report a bogus zero). */
  version: string | null;
}

/**
 * Bounded audit summary of a {@link DatasetVersionIntegrityResult} (#1189).
 *
 * Flags, counts, and a pointer -- never the key arrays. Audit rows used to
 * inline `missingKeys`/`zeroByteKeys` in full via JSON.stringify(verified),
 * which scaled row size with the dataset's file count (largest production
 * row: 12,397 keys, 1.15 MB) and made the hourly D1 backup unrestorable
 * (#1188: a row's single-INSERT backup statement exceeded D1's ~100 KB
 * statement limit). The per-file detail lives in the artifact that owns it,
 * `.nemar/availability-report.json` on the dataset repo's `main`
 * (services/availability-report.ts), which is richer than the arrays were:
 * keyed by manifest path rather than annex key (two paths can share one
 * key), with a per-entry reason (`zero_byte` / `absent`), versioned in git.
 *
 * An explicit pick, not a spread, for the same reason the verify route's
 * response is (routes/admin/imports.ts): a field added to the result type
 * later must not silently start being persisted -- least of all a new
 * unbounded one.
 *
 * Migration 0074 rewrites pre-existing array-carrying audit rows into this
 * same shape (plus a `compacted_by` marker); keep the two in sync.
 */
export function integrityAuditSummary(verified: DatasetVersionIntegrityResult): {
  complete: boolean;
  expectedCount: number;
  presentCount: number;
  bytesPresent: number;
  declaredBytes: number;
  declaredFiles: number;
  version: string | null;
  missing_count: number;
  zero_byte_count: number;
  detail_ref: string;
} {
  return {
    complete: verified.complete,
    expectedCount: verified.expectedCount,
    presentCount: verified.presentCount,
    bytesPresent: verified.bytesPresent,
    declaredBytes: verified.declaredBytes,
    declaredFiles: verified.declaredFiles,
    version: verified.version,
    missing_count: verified.missingKeys.length,
    zero_byte_count: verified.zeroByteKeys.length,
    detail_ref: ".nemar/availability-report.json",
  };
}

/** A resolved, parsed manifest -- version and files travel together so
 *  "we have files but no version" (or vice versa) is unrepresentable. */
export interface ResolvedManifest {
  version: string;
  files: Record<string, ExpectedManifestFile>;
}

/**
 * Pure half of {@link verifyDatasetVersionS3}: given the resolved manifest
 * (or null when none could be resolved/parsed) and the live `<id>/objects/`
 * listing, compute the completeness comparison plus the honest-size totals.
 * Split out from the I/O wrapper so the arithmetic -- which the S3-listing
 * seam (`listObjectPages` hardcodes a `*.s3.*.amazonaws.com` host with no
 * local-test override) can't exercise -- is directly unit-testable with
 * synthetic data. `manifest` being a single nullable object (rather than
 * separate `expected`/`resolvedVersion` params) makes the invalid combo --
 * files present but no version, or vice versa -- unrepresentable at the type
 * level; `version` on the result is simply `manifest?.version ?? null`.
 * Exported for testing.
 */
export function computeVersionIntegrity(
  manifest: ResolvedManifest | null,
  existing: Map<string, number>,
): DatasetVersionIntegrityResult {
  const comparison = compareManifestToListing(manifest?.files ?? null, existing);

  let bytesPresent = 0;
  for (const size of existing.values()) bytesPresent += size;

  let declaredBytes = 0;
  let declaredFiles = 0;
  if (manifest) {
    for (const file of Object.values(manifest.files)) {
      declaredBytes += file.size;
      declaredFiles++;
    }
  }

  return {
    ...comparison,
    bytesPresent,
    declaredBytes,
    declaredFiles,
    version: manifest?.version ?? null,
  };
}

/** The bindings {@link versionReadS3Options} reads. */
type VersionReadS3Env = Pick<
  Bindings,
  | "S3_BUCKET"
  | "AWS_REGION"
  | "AWS_ACCESS_KEY_ID"
  | "AWS_SECRET_ACCESS_KEY"
  | "S3_ENDPOINT_URL"
  | "ENVIRONMENT"
>;

/**
 * The S3 options for every read that decides whether a dataset version is
 * complete: this module's LIST and manifest read, and the availability report's
 * own manifest read. One builder, so they cannot disagree about the origin.
 *
 * A test points those reads at a local server through S3_ENDPOINT_URL, which is
 * honored outside production only ({@link testS3EndpointOverride}): the verdict
 * they produce feeds data_complete and the withdrawal rule (ADR 0064).
 */
export function versionReadS3Options(env: VersionReadS3Env): PresignedUrlOptions {
  return {
    bucket: env.S3_BUCKET,
    region: env.AWS_REGION,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    endpointUrl: testS3EndpointOverride(env),
  };
}

/**
 * I/O wrapper: resolve a dataset's version manifest (a specific `version`, or
 * the latest published one when omitted) and the live `<id>/objects/`
 * listing, then run the pure comparison plus the honest-size totals (#970).
 * No manifest (import never finalized / dataset predates manifests), an
 * unparseable one, or one missing `files` all fall back to the
 * `expected: null` path in {@link compareManifestToListing} -- and to
 * `version: null` here, signaling callers to keep the S3-sum fallback rather
 * than trust a zero.
 */
export async function verifyDatasetVersionS3(
  env: Pick<Bindings, "DB"> & VersionReadS3Env,
  datasetId: string,
  version?: string,
): Promise<DatasetVersionIntegrityResult> {
  const options = versionReadS3Options(env);

  let resolvedVersion = version ?? null;
  if (!resolvedVersion) {
    // Both columns, one rule (`resolveCurrentVersion`). Reading only
    // `latest_version_doi` resolved nothing for a released ANONYMOUS deposit,
    // which leaves that column NULL on purpose (#1447), so every caller that
    // omits `version` -- the import-retry engine, the availability report, the
    // issue sweep, the admin verify route -- fell to the `expected: null` path
    // and could never reach a `data_complete` verdict for one. The version
    // artifact it goes on to read exists for those deposits: the manifest job
    // that wrote it is the same step that inserted the `dataset_versions` row.
    const row = await env.DB.prepare(
      `SELECT latest_version_doi,
              (SELECT version FROM dataset_versions dv WHERE dv.dataset_id = datasets.dataset_id
               ORDER BY created_at DESC LIMIT 1) AS recorded_version
         FROM datasets WHERE dataset_id = ?`,
    )
      .bind(datasetId)
      .first<{ latest_version_doi: string | null; recorded_version: string | null }>();
    resolvedVersion = row ? resolveCurrentVersion(row) : null;
  }

  let expected: Record<string, ExpectedManifestFile> | null = null;
  if (resolvedVersion) {
    const manifestJson = await getManifest(options, datasetId, resolvedVersion);
    if (manifestJson) {
      const parsedFiles = parseManifestFiles(manifestJson);
      if (parsedFiles) {
        expected = parsedFiles;
      } else {
        console.error(
          `[import-integrity] manifest for ${datasetId}@${resolvedVersion} is unparseable or missing "files"`,
        );
      }
    }
  }

  const existing = await listObjectSizes(options, `${datasetId}/objects/`);
  return computeVersionIntegrity(
    expected && resolvedVersion ? { version: resolvedVersion, files: expected } : null,
    existing,
  );
}
