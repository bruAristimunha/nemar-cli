/**
 * Plain-HTTP dataset download: the path that needs no git, no git-annex and
 * no GitHub account.
 *
 * `nemar dataset download` normally clones the dataset repository and pulls
 * annexed content through git-annex. That is the right default -- it yields a
 * working repository with history, and `commit`/`push`/`update` operate on it.
 * It is also the wrong tool for three real cases:
 *
 *   1. git-annex is not installed. Today that is a hard exit, which is a poor
 *      answer to "I just want the files".
 *   2. The repository is not readable by the caller even though the DATA is
 *      public. This is the shape a temporarily-anonymous deposit takes.
 *   3. A machine where installing git-annex is impractical: a container, a
 *      login node, a CI runner.
 *
 * In all three the data plane already serves everything needed. This module
 * reads `<api>/data/<id>/<version>/manifest.json` -- one request that returns
 * every file's path, size, checksum and a direct byte URL -- and fetches the
 * selected entries with a bounded worker pool.
 *
 * **What you get is a snapshot, not a repository.** There is no `.git`, so
 * `nemar dataset commit`, `push` and `update` do not work in the result, and
 * `git annex get` cannot fetch anything that was filtered out. Re-running the
 * download with different filters is how you widen the selection. Callers must
 * say so; `printSnapshotCaveat` is the one wording.
 *
 * The data plane is addressed through the configured API origin's `/data`
 * mount rather than `data.nemar.org`, because that mount exists in every
 * environment (production, staging and the workers.dev dev deployment) while
 * the pretty hostname does not. That fixes which ENVIRONMENT is asked, in one
 * place: whichever API the CLI is already pointed at. The CLI reads each
 * entry's stable `bytes_url`, which is also its `url` in the served manifest
 * under ADR 0095. Keeping the snapshot path on `bytes_url` preserves the
 * existing CLI contract while the Worker resolves plain and chunked annex
 * storage behind the same dataset/version/path route.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import chalk from "chalk";
import {
  type DataPlaneManifestEntry,
  dataPlaneManifestSchema,
  dataPlaneVersionListingSchema,
  isMetadataEntry,
} from "../../shared/contract/data-plane.js";
import { getApiUrl } from "./api/client.js";
import { type BidsFilterResult, matchesBidsFilter } from "./bids-filter.js";
import { type FileDownloadResult, type RemoteFile, downloadFiles } from "./file-download.js";

export type { DataPlaneManifestEntry } from "../../shared/contract/data-plane.js";
export { isMetadataEntry } from "../../shared/contract/data-plane.js";

export { MAX_CONCURRENCY } from "./file-download.js";

/** Where a snapshot records what it is, so a later run can tell. */
export const SNAPSHOT_STAMP_PATH = ".nemar/http-snapshot.json";

/** Where a run leaves the complete list of files it could not fetch. */
export const FAILURE_LIST_PATH = ".nemar/http-download-failures.txt";

/** What a plain-HTTP run produced. The pool's result, verbatim. */
export type HttpDownloadResult = FileDownloadResult;

export interface VersionListing {
  latest: string;
  versions: string[];
}

/** The data plane's origin: the configured API origin plus its `/data` mount. */
export function dataPlaneBase(): string {
  return `${getApiUrl().replace(/\/+$/, "")}/data`;
}

/**
 * Thrown when the data plane cannot serve this dataset at all. Carries a
 * caller-ready sentence, because every reason is actionable by the user and
 * none of them is a bug worth a stack trace.
 */
export class DataPlaneUnavailableError extends Error {}

/**
 * Fetch and validate one data-plane document.
 *
 * Every failure mode ends as a `DataPlaneUnavailableError` carrying a sentence
 * a user can act on. That includes the body not being JSON at all, which is
 * what a captive portal or an intercepting proxy returns -- exactly the
 * networks this path exists to serve -- and which would otherwise surface as a
 * bare `SyntaxError: Unrecognized token '<'`.
 *
 * The schema is not decoration. This path reads `bytes_url` and
 * `checksum_algorithm` BY NAME, so a rename on the producing side turns into
 * "downloaded 0 files" and a green success line rather than an error. That is
 * the silent-cast failure `request()` in api/client.ts takes a schema to
 * prevent, and the same reasoning applies here.
 */
export async function getDocument<T>(
  url: string,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  what: string,
  notFoundMessage: () => string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (err) {
    throw new DataPlaneUnavailableError(
      `Could not reach the NEMAR data service at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (response.status === 404) throw new DataPlaneUnavailableError(notFoundMessage());
  if (!response.ok) throw new DataPlaneUnavailableError(await refusalSentence(response, what));

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    const contentType = response.headers.get("content-type") ?? "no content-type";
    throw new DataPlaneUnavailableError(
      `${what} did not come back as JSON (${contentType}) from ${url}. A proxy or captive portal may be intercepting the request.`,
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success || result.data === undefined) {
    throw new DataPlaneUnavailableError(
      `${what} did not match the expected shape. The data service may be mid-deploy, or this CLI may be too old for it; try upgrading.`,
    );
  }
  return result.data;
}

/**
 * The sentence for a non-OK answer. The data plane says why in a JSON
 * `error`, and that is worth more to a user than a status code, so it is read
 * when it is there (and ignored when the body is not JSON, which is what a
 * proxy error page is).
 *
 * A 413 is the one refusal with a way forward to name: `manifest.json`
 * declines a version with more files than it lists in one response
 * (nemarOrg/nemar-cli#1502; seven datasets, nm000281 among them). This path
 * has no other way to learn every file's checksum algorithm, so it cannot
 * fetch such a version by itself; git-annex can, and the body's
 * `listing_url` lets a person browse the files. Both are said.
 */
async function refusalSentence(response: Response, what: string): Promise<string> {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (parsed !== null && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // Not JSON: the status alone is all there is to say.
  }
  const detail = typeof body.error === "string" ? body.error : null;
  if (response.status === 413) {
    const listing = typeof body.listing_url === "string" ? body.listing_url : null;
    return [
      `${what} was refused (HTTP 413): ${detail ?? "it lists more files than the data service sends in one response."}`,
      "A plain-HTTP download cannot fetch this version; install git-annex and run the download again without --http, which fetches any version.",
      listing && !detail?.includes(listing) ? `Its files can be browsed from ${listing}` : null,
    ]
      .filter((line): line is string => line !== null)
      .join(" ");
  }
  return detail
    ? `${what} could not be read (HTTP ${response.status}): ${detail}`
    : `${what} could not be read (HTTP ${response.status}).`;
}

/** Published versions of a dataset, newest first, as the data plane sees them. */
export async function fetchVersions(datasetId: string): Promise<VersionListing> {
  const payload = await getDocument(
    `${dataPlaneBase()}/${datasetId}`,
    dataPlaneVersionListingSchema,
    `Dataset ${datasetId}`,
    () =>
      `Dataset ${datasetId} is not served over HTTP. The data service carries published, public datasets; a private or not-yet-published dataset has to be downloaded with git-annex.`,
  );
  const versions = payload.versions.map((v) => v.version).filter(Boolean);
  if (versions.length === 0) {
    throw new DataPlaneUnavailableError(
      `Dataset ${datasetId} has no published version to download over HTTP. Only published versions are served; use git-annex for an unpublished dataset.`,
    );
  }
  return { latest: payload.latest || versions[0], versions };
}

/**
 * Every file in one published version.
 *
 * A 404 here means something different from a 404 on the version listing, and
 * says so: the caller has just proved the dataset is published, so a missing
 * manifest is an operational gap on our side (manifests are healed through
 * `/admin/manifest/dispatch`), not a statement about visibility. Reporting it
 * as "private or not-yet-published" sends someone off to install git-annex for
 * a public dataset whose only problem is a file nobody has been told is
 * missing.
 */
export async function fetchManifest(
  datasetId: string,
  version: string,
): Promise<DataPlaneManifestEntry[]> {
  const entries = await getDocument(
    `${dataPlaneBase()}/${datasetId}/${version}/manifest.json`,
    dataPlaneManifestSchema,
    `Manifest for ${datasetId} ${version}`,
    () =>
      `${datasetId} ${version} is published, but its file list is missing from the data service. That is a NEMAR-side gap rather than a permission problem: please report it at https://github.com/nemarOrg/nemar-cli/issues. git-annex can still download this dataset meanwhile.`,
  );

  // A manifest that lists files but marks none of them as git-tracked cannot be
  // right: every BIDS dataset carries dataset_description.json in plain git
  // (ADR 0015). Reaching this means `checksum_algorithm` changed meaning, and
  // everything downstream fails silently -- `--no-data` selects nothing, and a
  // filtered download drops every sidecar and still reports success. The
  // guarantee that metadata always survives a filter is only as good as this
  // check, so it is made where it is relied on rather than assumed.
  if (entries.length > 0 && !entries.some(isMetadataEntry)) {
    throw new DataPlaneUnavailableError(
      `Manifest for ${datasetId} ${version} lists ${entries.length} files but marks none as git-tracked metadata, which cannot be right for a BIDS dataset. Refusing to download a tree that would be missing its sidecars; please report this at https://github.com/nemarOrg/nemar-cli/issues.`,
    );
  }
  return entries;
}

export function selectEntries(
  entries: DataPlaneManifestEntry[],
  filter: BidsFilterResult,
  options: { metadataOnly?: boolean } = {},
): DataPlaneManifestEntry[] {
  return entries.filter((entry) => {
    if (options.metadataOnly && !isMetadataEntry(entry)) return false;
    // Metadata is never filtered out by a BIDS entity filter: a subject-scoped
    // download still needs dataset_description.json and the sidecars, or what
    // lands on disk is not a readable BIDS dataset. The git-annex path gets
    // this for free, because those files ride along in the clone rather than
    // being fetched by `git annex get`.
    if (isMetadataEntry(entry)) return true;
    return matchesBidsFilter(entry.path, filter);
  });
}

/**
 * Download selected manifest entries into `outputDir`.
 *
 * The transfer itself -- the bounded pool, resume, size verification, retries
 * and the transport-versus-404 split -- is `downloadFiles` in
 * `lib/file-download.ts`, shared with the OpenNeuro path. What is specific to
 * the data plane, and so stays here, is which URL a manifest entry is fetched
 * from: `bytes_url`, the stable per-file route also emitted as `url` by the
 * served manifest. It remains the CLI's durable download field.
 */
export async function downloadEntries(
  entries: DataPlaneManifestEntry[],
  outputDir: string,
  options: {
    concurrency?: number;
    attempts?: number;
    onProgress?: (filesDone: number, filesTotal: number, bytesDone: number) => void;
  } = {},
): Promise<HttpDownloadResult> {
  const files: RemoteFile[] = entries.map((entry) => ({
    path: entry.path,
    url: entry.bytes_url,
    size: entry.size,
  }));
  return downloadFiles(files, outputDir, options);
}

// ===========================================================================
// Snapshot identity: what a directory already holds
// ===========================================================================

/**
 * Three distinct hazards, all of which end in a tree that looks fine and is
 * not:
 *
 *   - **A git-annex clone.** The default output path is `./<dataset-id>`, the
 *     same directory the clone path uses. Unfetched annexed files there are
 *     dangling symlinks, so `existsSync` is false and this path would write
 *     THROUGH them into the annex object store, under a key whose hash no
 *     longer matches its content -- corruption that surfaces only at the next
 *     `git annex fsck`.
 *   - **A different dataset.** Nothing about `-o ./data` stops a second
 *     dataset being poured on top of the first.
 *   - **A different version of the same dataset.** The subtle one.
 *     `dataset_description.json` carries `DatasetVersion`, and "1.0.0" ->
 *     "1.0.1" is byte-identical in length, so the resume check skips it and the
 *     tree becomes a mix of two versions whose only version marker names the
 *     older one. This command's own "re-run to widen the selection" advice is
 *     what triggers it.
 */
export type SnapshotConflict =
  | { kind: "git-repo" }
  | { kind: "other-dataset"; datasetId: string }
  | { kind: "other-version"; version: string };

export interface SnapshotStamp {
  dataset_id: string;
  version: string;
  updated_at: string;
}

export function readSnapshotStamp(outputDir: string): SnapshotStamp | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(outputDir, SNAPSHOT_STAMP_PATH), "utf8"),
    ) as Partial<SnapshotStamp>;
    if (!parsed.dataset_id || !parsed.version) return null;
    return {
      dataset_id: parsed.dataset_id,
      version: parsed.version,
      updated_at: parsed.updated_at ?? "",
    };
  } catch {
    return null;
  }
}

export function writeSnapshotStamp(outputDir: string, datasetId: string, version: string): void {
  const target = join(outputDir, SNAPSHOT_STAMP_PATH);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    `${JSON.stringify({ dataset_id: datasetId, version, updated_at: new Date().toISOString() }, null, 2)}\n`,
  );
}

/** What, if anything, stops this download from writing into `outputDir`. */
export function inspectOutputDir(
  outputDir: string,
  datasetId: string,
  version: string,
): SnapshotConflict | null {
  if (!existsSync(outputDir)) return null;
  if (existsSync(join(outputDir, ".git"))) return { kind: "git-repo" };

  const stamp = readSnapshotStamp(outputDir);
  if (!stamp) return null;
  if (stamp.dataset_id !== datasetId) {
    return { kind: "other-dataset", datasetId: stamp.dataset_id };
  }
  if (stamp.version !== version) return { kind: "other-version", version: stamp.version };
  return null;
}

/** Write the complete failure list; returns its path, or null if there is none. */
export function writeFailureList(outputDir: string, errors: string[]): string | null {
  if (errors.length === 0) return null;
  const target = join(outputDir, FAILURE_LIST_PATH);
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${errors.join("\n")}\n`);
    return target;
  } catch {
    return null;
  }
}

export function printSnapshotCaveat(outputPath: string): void {
  console.log(chalk.dim("  This is a file snapshot, not a git repository:"));
  console.log(
    chalk.dim("    - 'nemar dataset commit/push/update' need a git-annex clone, not this copy"),
  );
  console.log(
    chalk.dim(`    - to widen the selection, re-run the download into ${outputPath} with`),
  );
  console.log(chalk.dim("      different filters; already-present files are skipped"));
  console.log(
    chalk.dim("    - files are checked against their declared size, but not checksum-verified;"),
  );
  console.log(chalk.dim("      the git-annex path verifies content hashes, this one does not"));
}
