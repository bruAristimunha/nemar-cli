/**
 * Upload progress tracking for resume capability
 *
 * Stores per-file upload status and step completion in .nemar/upload-progress.json.
 * Enables resuming interrupted uploads without re-uploading completed files.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export type FileStatus = "pending" | "uploaded" | "failed";

export type UploadStep =
  | "tracking"
  | "s3_upload"
  | "url_registration"
  | "metadata_write"
  | "dataset_save"
  | "github_push"
  | "ci_deploy";

export interface FileProgress {
  status: FileStatus;
  size: number;
  /** Working-tree mtime when recorded; absent in pre-#884 progress files. */
  mtimeMs?: number;
  updated_at: string;
  error?: string;
}

export interface UploadProgress {
  dataset_id: string;
  started_at: string;
  updated_at: string;
  files: Record<string, FileProgress>;
  completed_steps: UploadStep[];
  /**
   * When step 9 last had the remote itself confirm the annexed path/key set at its current
   * target, its timestamp, count, and fingerprint. A resume within
   * {@link RECORDED_CHECK_VALID_MS} skips the check only when the effective target and
   * currently recorded path/key set match that fingerprint. The count alone is not enough:
   * a collaborator can replace one recorded key with another without changing the number of
   * files. These persisted values are read only through
   * {@link isRecordedCheckFresh}; anything damaged or mismatched means "check".
   */
  remote_checked_at?: unknown;
  remote_checked_count?: unknown;
  remote_checked_fingerprint?: unknown;
}

/** How long a passed check of the recorded files stays good: six hours. */
export const RECORDED_CHECK_VALID_MS = 6 * 60 * 60 * 1000;

/** {@link RECORDED_CHECK_VALID_MS} as words for a message: "6 hours". */
export const RECORDED_CHECK_VALID_TEXT = `${RECORDED_CHECK_VALID_MS / (60 * 60 * 1000)} hours`;

/** Stable, compact identity for the target and annexed paths/keys whose remote state was checked. */
export function fingerprintAnnexedFiles(
  entries: Iterable<readonly [string, string]>,
  remoteIdentity: string,
): string {
  const sorted = [...entries].sort(([pathA, keyA], [pathB, keyB]) => {
    if (pathA !== pathB) return pathA < pathB ? -1 : 1;
    if (keyA === keyB) return 0;
    return keyA < keyB ? -1 : 1;
  });
  const hash = createHash("sha256");
  hash.update(remoteIdentity).update("\0");
  for (const [path, key] of sorted) hash.update(path).update("\0").update(key).update("\0");
  return hash.digest("hex");
}

/**
 * Whether a check of the recorded files passed recently enough, over as many files as
 * there are now, to skip the next one. The timestamp, count, and fingerprint all have to
 * match. A missing, damaged or future stamp (a clock that moved back) is not fresh: the
 * check is the safe direction, and a stamp that cannot be read must never skip it.
 */
export function isRecordedCheckFresh(
  progress: UploadProgress,
  recordedCount: number,
  fingerprint: string,
  now: number = Date.now(),
): boolean {
  const stamp: unknown = progress.remote_checked_at;
  if (typeof stamp !== "string") return false;
  if (progress.remote_checked_count !== recordedCount) return false;
  if (progress.remote_checked_fingerprint !== fingerprint) return false;
  const at = Date.parse(stamp);
  if (Number.isNaN(at)) return false;
  return at <= now && now - at < RECORDED_CHECK_VALID_MS;
}

/** Record that the current target has just confirmed the annexed path/key set and its size. */
export function markRecordedChecked(
  progress: UploadProgress,
  recordedCount: number,
  fingerprint: string,
  now: number = Date.now(),
): void {
  progress.remote_checked_at = new Date(now).toISOString();
  progress.remote_checked_count = recordedCount;
  progress.remote_checked_fingerprint = fingerprint;
}

const PROGRESS_DIR = ".nemar";
const PROGRESS_FILE = "upload-progress.json";

function getProgressPath(datasetPath: string): string {
  return join(datasetPath, PROGRESS_DIR, PROGRESS_FILE);
}

/** All files start as "pending". Writes progress to disk. */
export function initUploadProgress(
  datasetPath: string,
  datasetId: string,
  files: Array<{ path: string; size: number; mtimeMs?: number }>,
): UploadProgress {
  const now = new Date().toISOString();
  const progress: UploadProgress = {
    dataset_id: datasetId,
    started_at: now,
    updated_at: now,
    files: {},
    completed_steps: [],
  };

  for (const file of files) {
    progress.files[file.path] = {
      status: "pending",
      size: file.size,
      mtimeMs: file.mtimeMs,
      updated_at: now,
    };
  }

  writeUploadProgress(datasetPath, progress);
  return progress;
}

/**
 * Read existing upload progress from disk.
 * Returns null if file doesn't exist or is invalid.
 * Logs a warning if the file exists but cannot be parsed.
 */
export function readUploadProgress(datasetPath: string): UploadProgress | null {
  const progressPath = getProgressPath(datasetPath);
  if (!existsSync(progressPath)) {
    return null;
  }

  try {
    const content = readFileSync(progressPath, "utf-8");
    const parsed = JSON.parse(content);

    if (!isValidProgress(parsed)) {
      console.warn(`Warning: Upload progress file is invalid or corrupted (${progressPath})`);
      console.warn("  Use --restart to clear progress and start fresh.");
      return null;
    }

    return parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: Could not read upload progress (${progressPath}): ${detail}`);
    console.warn("  Use --restart to clear progress and start fresh.");
    return null;
  }
}

/**
 * Write upload progress to disk.
 * Mutates progress.updated_at to the current timestamp before writing.
 * Logs a warning on failure.
 */
export function writeUploadProgress(datasetPath: string, progress: UploadProgress): boolean {
  const dir = join(datasetPath, PROGRESS_DIR);
  const progressPath = getProgressPath(datasetPath);

  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    progress.updated_at = new Date().toISOString();
    writeFileSync(progressPath, JSON.stringify(progress, null, 2));
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: Could not save upload progress (${progressPath}): ${detail}`);
    console.warn("  If the upload is interrupted, resume may not work correctly.");
    return false;
  }
}

/**
 * Mark a file as successfully uploaded.
 * No-ops silently if filePath is not tracked in progress.
 *
 * When `fileInfo` is given, the recorded size/mtime are refreshed to the
 * just-uploaded working-tree state, so a file that was re-uploaded after a
 * content change stops registering as changed on subsequent runs (#884).
 */
export function markFileUploaded(
  progress: UploadProgress,
  filePath: string,
  fileInfo?: { size: number; mtimeMs?: number },
): void {
  const entry = progress.files[filePath];
  if (entry) {
    entry.status = "uploaded";
    entry.updated_at = new Date().toISOString();
    entry.error = undefined;
    if (fileInfo) {
      entry.size = fileInfo.size;
      // The mtime is replaced with the new one even when there is none: leaving the old
      // one beside the new size would describe a file that never existed. A record with
      // no mtime fails toward a harmless re-add (see fileEntryChanged).
      entry.mtimeMs = fileInfo.mtimeMs;
    }
  }
}

/**
 * Mark a file as failed with an error message.
 * No-ops silently if filePath is not tracked in progress.
 */
export function markFileFailed(progress: UploadProgress, filePath: string, error: string): void {
  const entry = progress.files[filePath];
  if (entry) {
    entry.status = "failed";
    entry.updated_at = new Date().toISOString();
    entry.error = error;
  }
}

export function markStepCompleted(progress: UploadProgress, step: UploadStep): void {
  if (!progress.completed_steps.includes(step)) {
    progress.completed_steps.push(step);
  }
}

export function isStepCompleted(progress: UploadProgress, step: UploadStep): boolean {
  return progress.completed_steps.includes(step);
}

/**
 * Un-complete a step so it re-runs on the next attempt. Used when a later
 * discovery invalidates earlier work (e.g. the data-file list changed after
 * git-annex tracking was marked complete, #884). No-op if not completed.
 */
export function clearStepCompleted(progress: UploadProgress, step: UploadStep): void {
  progress.completed_steps = progress.completed_steps.filter((s) => s !== step);
}

/**
 * Whether the current manifest carries data files the progress has not seen
 * (new path) or that changed size or mtime since they were recorded (see
 * fileEntryChanged; removals never invalidate). Drives the invalidation of
 * the completed "tracking" step on resume (#884): unchanged lists skip the
 * multi-hour git-annex re-add entirely.
 */
export function hasFileListChanged(
  progress: UploadProgress,
  currentManifest: Array<{ path: string; size: number; mtimeMs?: number }>,
): boolean {
  return currentManifest.some((file) => fileEntryChanged(progress.files[file.path], file));
}

/**
 * Whether a manifest file differs from its recorded progress entry: new
 * path, size change, or mtime change. Same-size content rewrites (e.g.
 * re-anonymization) move the mtime, so size alone misses them (#884
 * review). A record without a stored mtime (pre-#884 progress file) is
 * treated as changed when the manifest carries one -- failing toward a
 * harmless content-addressed re-add. Manifests without mtimes fall back to
 * size-only comparison.
 */
function fileEntryChanged(
  existing: FileProgress | undefined,
  file: { size: number; mtimeMs?: number },
): boolean {
  if (!existing) return true;
  if (existing.size !== file.size) return true;
  if (file.mtimeMs !== undefined && existing.mtimeMs !== file.mtimeMs) return true;
  return false;
}

/**
 * Get files that need uploading: pending, failed, new (not in progress),
 * size-changed, or mtime-changed (see fileEntryChanged).
 *
 * @param progress - existing progress state
 * @param currentManifest - current data files from the upload manifest
 * @returns files that need to be uploaded
 */
export function getFilesNeedingUpload<T extends { path: string; size: number; mtimeMs?: number }>(
  progress: UploadProgress,
  currentManifest: T[],
): T[] {
  return currentManifest.filter((file) => {
    const existing = progress.files[file.path];
    // Skip only if previously uploaded and unchanged since
    return !existing || existing.status !== "uploaded" || fileEntryChanged(existing, file);
  });
}

/**
 * Delete the upload progress file. The .nemar/ directory is preserved.
 * Logs a warning on failure.
 */
export function clearUploadProgress(datasetPath: string): boolean {
  const progressPath = getProgressPath(datasetPath);
  try {
    if (existsSync(progressPath)) {
      unlinkSync(progressPath);
    }
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: Could not clear upload progress (${progressPath}): ${detail}`);
    return false;
  }
}

export function getProgressSummary(progress: UploadProgress): {
  total: number;
  uploaded: number;
  failed: number;
  pending: number;
  completedSteps: UploadStep[];
} {
  const entries = Object.values(progress.files);
  let uploaded = 0;
  let failed = 0;
  let pending = 0;

  for (const file of entries) {
    switch (file.status) {
      case "uploaded":
        uploaded++;
        break;
      case "failed":
        failed++;
        break;
      case "pending":
        pending++;
        break;
    }
  }

  return {
    total: entries.length,
    uploaded,
    failed,
    pending,
    completedSteps: progress.completed_steps,
  };
}

const fileStatusSchema = z.enum(["pending", "uploaded", "failed"]) satisfies z.ZodType<FileStatus>;

const uploadStepSchema = z.enum([
  "tracking",
  "s3_upload",
  "url_registration",
  "metadata_write",
  "dataset_save",
  "github_push",
  "ci_deploy",
]) satisfies z.ZodType<UploadStep>;

// `mtimeMs` is optional because it is genuinely absent from pre-#884 progress
// files; `updated_at` is NOT, and is required here, because every writer in
// this module (initUploadProgress, markFileUploaded, markFileFailed) has always
// set it. The old hand-rolled check skipped it, which left the `data is
// UploadProgress` predicate below asserting a field nothing had verified.
// `error` and any other per-file key are intentionally left undeclared: this
// schema is used only as a type guard (see isValidProgress), never to derive
// the returned value, so unknown keys are neither validated nor stripped from
// what the caller gets back.
const fileProgressSchema = z.object({
  status: fileStatusSchema,
  size: z.number().nonnegative(),
  mtimeMs: z.number().nonnegative().optional(),
  updated_at: z.string(),
});

// started_at/updated_at are validated only as strings -- real progress files
// carry values a stricter z.string().datetime() would reject, so none is
// applied here.
//
// `files` is intentionally neither `.optional()` nor `.nullable()`: null or a
// non-object fails the same way the old `typeof !== "object"` check did. It is
// also where the one deliberate narrowing lives. Zod's ZodParsedType
// categorizes an array as "array", never "object", so z.record rejects an
// array-valued `files` -- unlike `typeof [] === "object"`, which let the old
// check treat an array as a valid (empty-keyed) files map and then silently
// resume with zero matching file paths, since every lookup of a string path
// against an array misses. See the PR body.
const uploadProgressSchema = z.object({
  dataset_id: z.string().min(1),
  started_at: z.string(),
  updated_at: z.string(),
  files: z.record(z.string(), fileProgressSchema),
  completed_steps: z.array(uploadStepSchema),
  // Deliberately unchecked: isRecordedCheckFresh treats anything but a recent timestamp
  // with a matching count and fingerprint as "no stamp", so damaged values must cost one
  // check, not the whole progress file.
  remote_checked_at: z.unknown().optional(),
  remote_checked_count: z.unknown().optional(),
  remote_checked_fingerprint: z.unknown().optional(),
});

/**
 * Validates the structure of a parsed progress file, including individual
 * file entries and step values.
 *
 * Used purely as a type guard: `readUploadProgress` returns the raw parsed
 * value (not `result.data`) so unknown top-level keys, unknown per-file
 * keys, and the `error` field survive the read unchanged.
 */
function isValidProgress(data: unknown): data is UploadProgress {
  return uploadProgressSchema.safeParse(data).success;
}
