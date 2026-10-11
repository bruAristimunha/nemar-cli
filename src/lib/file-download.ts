/**
 * One bounded, resumable, size-verified HTTP file downloader.
 *
 * Two paths in this CLI fetch a list of files over plain HTTPS: the NEMAR data
 * plane (`lib/http-download.ts`, for a dataset with no git-annex clone) and
 * OpenNeuro's public S3 bucket (`lib/openneuro.ts`, the fallback when the AWS
 * CLI is absent). They differ only in where the list comes from -- a
 * `manifest.json` document in one case, a `ListObjectsV2` walk in the other --
 * and both then want the same thing: fetch these `n` files into this
 * directory, `c` at a time, without losing the whole transfer to one bad
 * object.
 *
 * That common half lives here, once. Everything a caller has to get right is
 * in this module rather than in each copy:
 *
 *   - **Writes are verified against the declared size.** `Bun.write` returns
 *     the true byte count and does NOT throw on a short body, so a truncated
 *     response, or an intercepting proxy's HTML login page, otherwise lands as
 *     a healthy file and the run reports success in green. A mismatch removes
 *     the file rather than leaving something that satisfies "the file exists".
 *   - **Resume is free.** A file already on disk at its declared size is left
 *     alone and reported as skipped, so an interrupted transfer is re-run with
 *     no flag.
 *   - **Retries with backoff**, because the hosts involved throttle by address
 *     (`raw.githubusercontent.com` serves most of a dataset's metadata
 *     entries), and a single 429 with no retry turns a 20,000-file download
 *     into thousands of permanent failures on a healthy link.
 *   - **Path traversal is refused.** Both file lists are server-supplied, so a
 *     `..` must not be able to write outside the output directory.
 *   - **Transport and disk faults are distinguished from a clean 404**, which
 *     is what lets a caller exit non-zero on a half-finished transfer while
 *     still treating genuinely absent content as a reportable state (ADR
 *     0005).
 *
 * What stays with each caller is what is genuinely theirs: how the list is
 * obtained, how a URL is built, what selection means, and what a partial
 * result should do to the exit code.
 */

import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import chalk from "chalk";
import { PUBLISHED_FILE_MISSING_ERROR } from "../../shared/contract/data-plane.js";

/** Upper bound on in-flight requests, and what `-j`/`--jobs` is clamped to. */
export const MAX_CONCURRENCY = 16;

/** Default attempts per file, including the first. */
const DEFAULT_ATTEMPTS = 3;

/** One file to fetch: where it goes, where it comes from, how big it is. */
export interface RemoteFile {
  /** Destination path relative to the output directory. */
  path: string;
  /** Durable URL for the bytes. */
  url: string;
  /**
   * Declared byte length. Required, not optional: it is what a write is
   * verified against and what the resume decision reads, so a file whose size
   * is unknown cannot be checked or resumed and must not reach this module.
   */
  size: number;
}

export interface FileDownloadResult {
  filesDownloaded: number;
  filesSkipped: number;
  bytesDownloaded: number;
  /**
   * Declared size of the files that were already present. Kept separate from
   * `bytesDownloaded`, which counts only what this run actually transferred:
   * a caller reporting "what is on disk" wants the sum, and one reporting
   * "what this run fetched" wants the first. Collapsing them makes a resumed
   * run claim it re-downloaded the dataset.
   */
  bytesSkipped: number;
  /** One per file that could not be fetched, each naming the file. */
  errors: string[];
  /**
   * True when at least one failure was transport, authentication or local I/O
   * rather than evidence that the object is absent upstream.
   *
   * That distinction is the one `classifyGetOutcome` draws on the git-annex
   * path, and it decides the exit code: ADR 0005 makes genuinely absent
   * content a reportable state that still serves, while a dropped connection
   * or a full disk is a failed run whatever the tallies say. Collapsing the
   * two exits 0 on a half-finished transfer.
   */
  hadInfrastructureFailure: boolean;
}

export interface FileDownloadOptions {
  concurrency?: number;
  attempts?: number;
  onProgress?: (filesDone: number, filesTotal: number, bytesDone: number) => void;
}

/** A failure that says nothing about whether the object exists upstream. */
function isInfrastructureFailure(status: number | null): boolean {
  // A thrown fetch or a failed write (status null) is network, DNS or disk:
  // never evidence of absence. Among HTTP statuses only a clean 404 is.
  return status === null ? true : status !== 404;
}

/** Statuses worth trying again: throttling and transient server faults. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** The data plane's own answer is a few dozen bytes; anything larger is somebody else's page. */
const MAX_MISSING_BODY_BYTES = 4096;

/** True for the data plane's "published file is missing from storage" answer (a small JSON body). */
async function namesAMissingPublishedFile(response: Response): Promise<boolean> {
  if (!(response.headers.get("content-type") ?? "").includes("json")) return false;
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_MISSING_BODY_BYTES) return false;
  try {
    const body = (await response.json()) as { error?: unknown } | null;
    return body?.error === PUBLISHED_FILE_MISSING_ERROR;
  } catch {
    return false;
  }
}

interface FetchOutcome {
  /** Bytes written, or null when the file was already present and correct. */
  written: number | null;
  error?: { message: string; infrastructure: boolean };
}

/**
 * Fetch one file, streaming to disk, with bounded retries.
 *
 * Every error carries `file.path`. A bare "The socket connection was closed
 * unexpectedly" repeated 800 times tells nobody which subtree is incomplete.
 */
async function fetchOne(
  file: RemoteFile,
  outputDir: string,
  attempts: number,
): Promise<FetchOutcome> {
  const filePath = join(outputDir, file.path);

  const root = resolve(outputDir);
  const resolved = resolve(filePath);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    return {
      written: null,
      error: {
        message: `${file.path}: refusing to write outside the output directory`,
        infrastructure: true,
      },
    };
  }

  if (existsSync(filePath)) {
    try {
      if (statSync(filePath).size === file.size) return { written: null };
    } catch (err) {
      // Fall through and re-fetch, but say why: the write below will fail for
      // the same reason, and a second unexplained error is a bad bug report.
      console.warn(
        chalk.dim(
          `  could not read existing ${file.path} (${err instanceof Error ? err.message : String(err)}); re-fetching`,
        ),
      );
    }
  }

  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let message = `${file.path}: download failed`;
  let infrastructure = true;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const backoff = (): Promise<void> => Bun.sleep(250 * 2 ** (attempt - 1));

    let response: Response;
    try {
      response = await fetch(file.url, { redirect: "follow" });
    } catch (err) {
      message = `${file.path}: ${err instanceof Error ? err.message : String(err)}`;
      infrastructure = isInfrastructureFailure(null);
      if (attempt < attempts) {
        await backoff();
        continue;
      }
      break;
    }

    if (!response.ok) {
      message = `${file.path}: HTTP ${response.status}`;
      infrastructure = isInfrastructureFailure(response.status);
      if (response.status === 502 && (await namesAMissingPublishedFile(response))) {
        // The manifest lists the file and storage does not have it (a partial dataset, ADR
        // 0064). ADR 0005 says missing content is reported and never blocks the delivery, so
        // this is reportable, not retried, and not a failed run. Any other 502 stays a
        // transport fault.
        message = `${file.path}: HTTP 502 (listed in the manifest, missing from storage)`;
        infrastructure = false;
        break;
      }
      if (isRetryableStatus(response.status) && attempt < attempts) {
        await backoff();
        continue;
      }
      break;
    }

    let written: number;
    try {
      written = await Bun.write(filePath, response);
    } catch (err) {
      message = `${file.path}: ${err instanceof Error ? err.message : String(err)}`;
      infrastructure = true;
      break;
    }

    if (written === file.size) return { written };

    // Remove it. Leaving a wrong-sized file behind would still be re-fetched
    // next run (the size check catches it), but it would satisfy any tool or
    // person who reads "the file exists" as "the file is there".
    try {
      rmSync(filePath, { force: true });
    } catch {
      // Best effort; the mismatch reported below is what matters.
    }
    message = `${file.path}: expected ${file.size} bytes, received ${written}`;
    infrastructure = true;
    if (attempt < attempts) {
      await backoff();
      continue;
    }
    break;
  }

  return { written: null, error: { message, infrastructure } };
}

/**
 * Download a file list into `outputDir` with a bounded worker pool.
 *
 * Failures are collected rather than thrown: a dataset with thousands of files
 * should not lose a two-hour transfer because one object 403s, and the caller
 * decides what a partial result means. The pool is a plain queue over the
 * single-threaded event loop -- `queue.shift()` completes before the first
 * `await`, so no entry is taken twice -- and `concurrency` bounds in-flight
 * requests exactly.
 */
export async function downloadFiles(
  files: RemoteFile[],
  outputDir: string,
  options: FileDownloadOptions = {},
): Promise<FileDownloadResult> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, MAX_CONCURRENCY));
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const queue = [...files];
  const result: FileDownloadResult = {
    filesDownloaded: 0,
    filesSkipped: 0,
    bytesDownloaded: 0,
    bytesSkipped: 0,
    errors: [],
    hadInfrastructureFailure: false,
  };
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const file = queue.shift();
      if (!file) return;
      const outcome = await fetchOne(file, outputDir, attempts);
      if (outcome.error) {
        result.errors.push(outcome.error.message);
        if (outcome.error.infrastructure) result.hadInfrastructureFailure = true;
      } else if (outcome.written === null) {
        result.filesSkipped++;
        result.bytesSkipped += file.size;
      } else {
        result.filesDownloaded++;
        result.bytesDownloaded += outcome.written;
      }
      done++;
      options.onProgress?.(done, files.length, result.bytesDownloaded);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length || 1) }, () => worker()),
  );
  return result;
}
