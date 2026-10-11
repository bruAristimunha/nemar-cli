/**
 * The data plane's two public documents: a dataset's version listing and a
 * version's file manifest (`data.nemar.org/<id>` and
 * `data.nemar.org/<id>/<version>/manifest.json`, also mounted at
 * `<api>/data/...`).
 *
 * These are read by the CLI's HTTP download path, which fetches bytes by the
 * `bytes_url` on every entry and decides what `--no-data` means from
 * `checksum_algorithm`. Both of those are field names, so a rename on the
 * backend turns into "downloaded 0 files" and a green success line rather than
 * an error -- the same silent-cast failure mode `request()` in
 * `src/lib/api/client.ts` takes a schema to prevent. Validating here makes the
 * drift loud on the client, and the backend's `PublicManifestEntry` in
 * `backend/src/services/data-router.ts` is the producer these must agree with.
 *
 * Passthrough on the entry object is deliberate: the backend may add fields,
 * and an additive change must not fail a download.
 */

import { z } from "zod";

/**
 * The `error` of the 502 the data plane answers when a file the manifest names is not in
 * storage: an annex object absent from the bucket, or a git blob GitHub does not have
 * (`manifestObjectMissing`, ADR 0095). It is a different answer from the 404 for a path the
 * manifest never listed, so a gather can tell a missing optional table from lost content. A
 * downloader reads it by ADR 0005's rule that missing content is reported and never blocks the
 * delivery (not a failed run), and reads any other 502 as a transport fault to retry.
 */
export const PUBLISHED_FILE_MISSING_ERROR = "Published file is missing from storage";

/**
 * One file in a published version.
 *
 * `checksum_algorithm` is `"git"` for a file tracked in plain git and an annex
 * backend name (`SHA256E`, `MD5E`, ...) otherwise. Per ADR 0015 git carries
 * metadata and git-annex carries data, so that field -- not the file extension,
 * which ADR 0031 says is unreliable in both directions -- is what separates the
 * two.
 *
 * `size` is required rather than optional on purpose. It is what the download
 * path compares the written byte count against, and what its resume decision
 * reads; an entry without one cannot be verified or resumed, so an absent size
 * must fail validation rather than flow through as `undefined` and poison a
 * byte total with `NaN`.
 */
export const dataPlaneManifestEntrySchema = z
  .object({
    path: z.string().min(1),
    size: z.number().int().nonnegative(),
    checksum: z.string().optional(),
    checksum_algorithm: z.string().optional(),
    /** Durable, storable contract URL for the bytes. Always present (#615). */
    bytes_url: z.string().min(1),
    /**
     * Stable data-plane URL for fetching the file. It equals `bytes_url` for
     * git-tracked, plain annex and chunked annex files, regardless of bucket
     * public-read policy (ADR 0095). The route checks visibility before it
     * resolves storage and serves the bytes. Keep `bytes_url` as the explicit
     * durable download contract for clients that already consume it.
     */
    url: z.string().nullish(),
    /**
     * Set by the producer when it could not build `url` for this row, so a
     * client can fetch the rest of the dataset instead of failing the whole
     * listing. A downloader must still report it: the entry is a known-degraded
     * one, not a healthy one.
     */
    error: z.string().optional(),
  })
  .passthrough();

export type DataPlaneManifestEntry = z.infer<typeof dataPlaneManifestEntrySchema>;

/** A version's manifest: one entry per file, no envelope. */
export const dataPlaneManifestSchema = z.array(dataPlaneManifestEntrySchema);

/** `GET <data>/<id>` — every published version, newest first. */
export const dataPlaneVersionListingSchema = z
  .object({
    dataset_id: z.string().optional(),
    latest: z.string().nullish(),
    versions: z.array(z.object({ version: z.string().min(1) }).passthrough()),
  })
  .passthrough();

export type DataPlaneVersionListing = z.infer<typeof dataPlaneVersionListingSchema>;

/** Is this entry dataset metadata (plain git) rather than recorded data? */
export function isMetadataEntry(entry: { checksum_algorithm?: string }): boolean {
  return entry.checksum_algorithm === "git";
}
