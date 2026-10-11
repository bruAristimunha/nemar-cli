import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearStepCompleted,
  clearUploadProgress,
  getFilesNeedingUpload,
  getProgressSummary,
  hasFileListChanged,
  initUploadProgress,
  isStepCompleted,
  markFileFailed,
  markFileUploaded,
  markStepCompleted,
  readUploadProgress,
  writeUploadProgress,
} from "../src/lib/upload-progress";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `nemar-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

const testFiles = [
  { path: "sub-01/eeg/sub-01_eeg.edf", size: 1024000 },
  { path: "sub-01/eeg/sub-01_events.tsv", size: 5000 },
  { path: "sub-02/eeg/sub-02_eeg.edf", size: 2048000 },
];

describe("initUploadProgress", () => {
  test("creates progress file with all files as pending", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);

    expect(progress.dataset_id).toBe("nm000123");
    expect(Object.keys(progress.files)).toHaveLength(3);
    expect(progress.completed_steps).toEqual([]);

    for (const file of testFiles) {
      expect(progress.files[file.path].status).toBe("pending");
      expect(progress.files[file.path].size).toBe(file.size);
    }

    // Verify file was written to disk
    expect(existsSync(join(testDir, ".nemar", "upload-progress.json"))).toBe(true);
  });

  test("creates .nemar directory if it does not exist", () => {
    expect(existsSync(join(testDir, ".nemar"))).toBe(false);
    initUploadProgress(testDir, "nm000123", testFiles);
    expect(existsSync(join(testDir, ".nemar"))).toBe(true);
  });

  test("handles empty file list", () => {
    const progress = initUploadProgress(testDir, "nm000123", []);
    expect(Object.keys(progress.files)).toHaveLength(0);
    expect(progress.completed_steps).toEqual([]);
  });
});

describe("readUploadProgress", () => {
  test("returns null when no progress file exists", () => {
    expect(readUploadProgress(testDir)).toBeNull();
  });

  test("round-trips init -> read", () => {
    initUploadProgress(testDir, "nm000123", testFiles);
    const read = readUploadProgress(testDir);

    expect(read).not.toBeNull();
    expect(read?.dataset_id).toBe("nm000123");
    expect(Object.keys(read?.files)).toHaveLength(3);
  });

  test("returns null for invalid JSON", () => {
    const dir = join(testDir, ".nemar");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "upload-progress.json"), "not valid json{{{");

    expect(readUploadProgress(testDir)).toBeNull();
  });

  test("returns null for valid JSON with missing required fields", () => {
    const dir = join(testDir, ".nemar");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "upload-progress.json"), JSON.stringify({ foo: "bar" }));

    expect(readUploadProgress(testDir)).toBeNull();
  });

  test("returns null for malformed file entries", () => {
    const dir = join(testDir, ".nemar");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "upload-progress.json"),
      JSON.stringify({
        dataset_id: "nm000123",
        started_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        files: { "sub-01/eeg.edf": { status: "banana", size: -1 } },
        completed_steps: [],
      }),
    );

    expect(readUploadProgress(testDir)).toBeNull();
  });

  test("returns null for invalid step values", () => {
    const dir = join(testDir, ".nemar");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "upload-progress.json"),
      JSON.stringify({
        dataset_id: "nm000123",
        started_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        files: {},
        completed_steps: ["nonexistent_step"],
      }),
    );

    expect(readUploadProgress(testDir)).toBeNull();
  });

  test("returns null when files is array-valued (deliberate narrowing)", () => {
    // typeof [] === "object", so an array-valued `files` used to pass the
    // old hand-rolled check and then silently resume with zero matching
    // file paths (every lookup against an array by string path misses).
    // z.record categorizes an array as ZodParsedType "array", never
    // "object", so this is now rejected outright. See PR body.
    const dir = join(testDir, ".nemar");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "upload-progress.json"),
      JSON.stringify({
        dataset_id: "nm000123",
        started_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        files: [],
        completed_steps: [],
      }),
    );

    expect(readUploadProgress(testDir)).toBeNull();
  });

  test("returns null when a file entry omits updated_at (deliberate narrowing)", () => {
    // FileProgress declares updated_at as required and every writer in the
    // module sets it (initUploadProgress, markFileUploaded, markFileFailed),
    // but the old hand-rolled check never verified it -- so isValidProgress's
    // `data is UploadProgress` predicate asserted a field nothing had checked.
    // The schema now requires it. Unlike mtimeMs, which really is absent from
    // pre-#884 files, no NEMAR-written progress file has ever lacked this.
    const dir = join(testDir, ".nemar");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "upload-progress.json"),
      JSON.stringify({
        dataset_id: "nm000123",
        started_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        files: { "sub-01/eeg.edf": { status: "pending", size: 10 } },
        completed_steps: [],
      }),
    );

    expect(readUploadProgress(testDir)).toBeNull();
  });

  test("round-trips per-file error, unknown per-file key, and unknown top-level key", () => {
    // readUploadProgress returns the raw JSON.parse result rather than a
    // stripping `result.data`, so a resumed upload does not silently lose a
    // per-file error message or any forward-compatibility field the next
    // writeUploadProgress would otherwise drop.
    const dir = join(testDir, ".nemar");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "upload-progress.json"),
      JSON.stringify({
        dataset_id: "nm000123",
        started_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        files: {
          "sub-01/eeg.edf": {
            status: "failed",
            size: 10,
            updated_at: "2026-01-01T00:00:00Z",
            error: "Connection timeout",
            futureFileField: "keep-me",
          },
        },
        completed_steps: [],
        futureTopLevelField: "keep-me-too",
      }),
    );

    const read = readUploadProgress(testDir);
    expect(read).not.toBeNull();
    if (!read) return; // narrowing guard
    expect(read.files["sub-01/eeg.edf"].error).toBe("Connection timeout");
    expect((read.files["sub-01/eeg.edf"] as Record<string, unknown>).futureFileField).toBe(
      "keep-me",
    );
    expect((read as unknown as Record<string, unknown>).futureTopLevelField).toBe("keep-me-too");
  });
});

describe("writeUploadProgress", () => {
  test("writes and reads back progress", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    progress.files[testFiles[0].path].status = "uploaded";

    const written = writeUploadProgress(testDir, progress);
    expect(written).toBe(true);

    const read = readUploadProgress(testDir);
    expect(read?.files[testFiles[0].path].status).toBe("uploaded");
  });
});

describe("markFileUploaded / markFileFailed", () => {
  test("marks file as uploaded", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markFileUploaded(progress, testFiles[0].path);

    expect(progress.files[testFiles[0].path].status).toBe("uploaded");
    expect(progress.files[testFiles[0].path].error).toBeUndefined();
  });

  test("marks file as failed with error", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markFileFailed(progress, testFiles[0].path, "Connection timeout");

    expect(progress.files[testFiles[0].path].status).toBe("failed");
    expect(progress.files[testFiles[0].path].error).toBe("Connection timeout");
  });

  test("clears error when re-marking as uploaded", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markFileFailed(progress, testFiles[0].path, "Connection timeout");
    markFileUploaded(progress, testFiles[0].path);

    expect(progress.files[testFiles[0].path].status).toBe("uploaded");
    expect(progress.files[testFiles[0].path].error).toBeUndefined();
  });

  test("no-ops for unknown file paths", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markFileUploaded(progress, "nonexistent/file.edf");
    markFileFailed(progress, "nonexistent/file.edf", "error");

    expect(progress.files["nonexistent/file.edf"]).toBeUndefined();
  });
});

describe("step completion", () => {
  test("tracks step completion", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);

    expect(isStepCompleted(progress, "s3_upload")).toBe(false);
    markStepCompleted(progress, "s3_upload");
    expect(isStepCompleted(progress, "s3_upload")).toBe(true);
  });

  test("does not duplicate steps", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markStepCompleted(progress, "s3_upload");
    markStepCompleted(progress, "s3_upload");

    expect(progress.completed_steps.filter((s) => s === "s3_upload")).toHaveLength(1);
  });

  test("tracks multiple steps independently", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markStepCompleted(progress, "s3_upload");
    markStepCompleted(progress, "url_registration");

    expect(isStepCompleted(progress, "s3_upload")).toBe(true);
    expect(isStepCompleted(progress, "url_registration")).toBe(true);
    expect(isStepCompleted(progress, "github_push")).toBe(false);
  });

  test("step completion survives write/read cycle", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markStepCompleted(progress, "s3_upload");
    markStepCompleted(progress, "github_push");
    writeUploadProgress(testDir, progress);

    const read = readUploadProgress(testDir);
    expect(read).not.toBeNull();
    if (!read) return; // narrowing guard
    expect(isStepCompleted(read, "s3_upload")).toBe(true);
    expect(isStepCompleted(read, "github_push")).toBe(true);
    expect(isStepCompleted(read, "dataset_save")).toBe(false);
  });

  test("tracking step (#884) persists and validates through disk", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markStepCompleted(progress, "tracking");
    writeUploadProgress(testDir, progress);

    const read = readUploadProgress(testDir);
    expect(read).not.toBeNull();
    if (!read) return; // narrowing guard
    expect(isStepCompleted(read, "tracking")).toBe(true);
  });
});

describe("clearStepCompleted (#884)", () => {
  test("removes a completed step so it re-runs", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markStepCompleted(progress, "tracking");
    markStepCompleted(progress, "s3_upload");

    clearStepCompleted(progress, "tracking");
    expect(isStepCompleted(progress, "tracking")).toBe(false);
    // Other steps are untouched
    expect(isStepCompleted(progress, "s3_upload")).toBe(true);
  });

  test("no-op when the step was never completed", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    clearStepCompleted(progress, "tracking");
    expect(progress.completed_steps).toEqual([]);
  });

  test("cleared step survives a write/read cycle as not-completed", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markStepCompleted(progress, "tracking");
    clearStepCompleted(progress, "tracking");
    writeUploadProgress(testDir, progress);

    const read = readUploadProgress(testDir);
    expect(read).not.toBeNull();
    if (!read) return; // narrowing guard
    expect(isStepCompleted(read, "tracking")).toBe(false);
  });
});

describe("hasFileListChanged (#884 tracking invalidation)", () => {
  test("false when the manifest matches the recorded files exactly", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    expect(hasFileListChanged(progress, testFiles)).toBe(false);
  });

  test("false regardless of upload status (status changes are not list changes)", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markFileUploaded(progress, testFiles[0].path);
    markFileFailed(progress, testFiles[1].path, "timeout");
    expect(hasFileListChanged(progress, testFiles)).toBe(false);
  });

  test("true when a new file appears in the manifest", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles.slice(0, 2));
    expect(hasFileListChanged(progress, testFiles)).toBe(true);
  });

  test("true when a recorded file changes size", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    const grown = testFiles.map((f, i) => (i === 0 ? { ...f, size: f.size + 1 } : f));
    expect(hasFileListChanged(progress, grown)).toBe(true);
  });

  test("false when a recorded file disappears (removals need no re-add)", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    expect(hasFileListChanged(progress, testFiles.slice(0, 2))).toBe(false);
  });

  test("empty manifest never invalidates", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    expect(hasFileListChanged(progress, [])).toBe(false);
  });
});

describe("mtime change detection (#884 review: same-size rewrites)", () => {
  const timedFiles = [
    { path: "sub-01/eeg/sub-01_eeg.edf", size: 1024000, mtimeMs: 1_700_000_000_000 },
    { path: "sub-02/eeg/sub-02_eeg.edf", size: 2048000, mtimeMs: 1_700_000_100_000 },
  ];

  test("same-size different-mtime invalidates tracking", () => {
    const progress = initUploadProgress(testDir, "nm000123", timedFiles);
    const rewritten = timedFiles.map((f, i) => (i === 0 ? { ...f, mtimeMs: f.mtimeMs + 5000 } : f));
    expect(hasFileListChanged(progress, rewritten)).toBe(true);
  });

  test("same-size different-mtime file needs re-upload even when marked uploaded", () => {
    const progress = initUploadProgress(testDir, "nm000123", timedFiles);
    markFileUploaded(progress, timedFiles[0].path);
    markFileUploaded(progress, timedFiles[1].path);
    const rewritten = timedFiles.map((f, i) => (i === 0 ? { ...f, mtimeMs: f.mtimeMs + 5000 } : f));
    const needing = getFilesNeedingUpload(progress, rewritten);
    expect(needing.map((f) => f.path)).toEqual([timedFiles[0].path]);
  });

  test("unchanged mtime and size: no invalidation, nothing to re-upload", () => {
    const progress = initUploadProgress(testDir, "nm000123", timedFiles);
    markFileUploaded(progress, timedFiles[0].path);
    markFileUploaded(progress, timedFiles[1].path);
    expect(hasFileListChanged(progress, timedFiles)).toBe(false);
    expect(getFilesNeedingUpload(progress, timedFiles)).toEqual([]);
  });

  test("old-format progress without mtimes: manifest mtimes fail toward re-adding", () => {
    // Pre-#884 progress files recorded size only. Simulate by initializing
    // without mtimes, then presenting a manifest that carries them.
    const progress = initUploadProgress(
      testDir,
      "nm000123",
      timedFiles.map(({ path, size }) => ({ path, size })),
    );
    markFileUploaded(progress, timedFiles[0].path);
    markFileUploaded(progress, timedFiles[1].path);
    expect(hasFileListChanged(progress, timedFiles)).toBe(true);
    expect(getFilesNeedingUpload(progress, timedFiles)).toHaveLength(2);
  });

  test("manifest without mtimes falls back to size-only comparison", () => {
    const progress = initUploadProgress(testDir, "nm000123", timedFiles);
    markFileUploaded(progress, timedFiles[0].path);
    markFileUploaded(progress, timedFiles[1].path);
    const sizeOnly = timedFiles.map(({ path, size }) => ({ path, size }));
    expect(hasFileListChanged(progress, sizeOnly)).toBe(false);
    expect(getFilesNeedingUpload(progress, sizeOnly)).toEqual([]);
  });

  test("markFileUploaded with fileInfo refreshes the recorded identity", () => {
    const progress = initUploadProgress(testDir, "nm000123", timedFiles);
    const rewritten = { ...timedFiles[0], mtimeMs: timedFiles[0].mtimeMs + 5000 };
    // Re-upload of the rewritten file records its new mtime...
    markFileUploaded(progress, rewritten.path, {
      size: rewritten.size,
      mtimeMs: rewritten.mtimeMs,
    });
    markFileUploaded(progress, timedFiles[1].path);
    // ...so the next run sees a stable list again.
    expect(hasFileListChanged(progress, [rewritten, timedFiles[1]])).toBe(false);
    expect(getFilesNeedingUpload(progress, [rewritten, timedFiles[1]])).toEqual([]);
  });

  test("markFileUploaded with a new size and no mtime drops the old mtime instead of keeping it", () => {
    // Guards the refresh. The old mtime next to the new size describes a file that never
    // existed, and it makes the next run report a change for the wrong reason.
    const progress = initUploadProgress(testDir, "nm000123", timedFiles);
    markFileUploaded(progress, timedFiles[0].path, { size: timedFiles[0].size + 1 });
    expect(progress.files[timedFiles[0].path].size).toBe(timedFiles[0].size + 1);
    expect(progress.files[timedFiles[0].path].mtimeMs).toBeUndefined();
  });

  test("mtimeMs round-trips through disk and validates", () => {
    const progress = initUploadProgress(testDir, "nm000123", timedFiles);
    writeUploadProgress(testDir, progress);
    const read = readUploadProgress(testDir);
    expect(read).not.toBeNull();
    if (!read) return; // narrowing guard
    expect(read.files[timedFiles[0].path].mtimeMs).toBe(timedFiles[0].mtimeMs);
  });

  test("non-numeric mtimeMs in the file is rejected as corrupt", () => {
    const dir = join(testDir, ".nemar");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "upload-progress.json"),
      JSON.stringify({
        dataset_id: "nm000123",
        started_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        files: {
          "sub-01/eeg.edf": { status: "pending", size: 10, mtimeMs: "yesterday" },
        },
        completed_steps: [],
      }),
    );
    expect(readUploadProgress(testDir)).toBeNull();
  });
});

describe("getFilesNeedingUpload", () => {
  test("returns all files when none are uploaded", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    const needing = getFilesNeedingUpload(progress, testFiles);

    expect(needing).toHaveLength(3);
  });

  test("excludes uploaded files", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markFileUploaded(progress, testFiles[0].path);

    const needing = getFilesNeedingUpload(progress, testFiles);
    expect(needing).toHaveLength(2);
    expect(needing.find((f) => f.path === testFiles[0].path)).toBeUndefined();
  });

  test("includes failed files", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markFileFailed(progress, testFiles[0].path, "timeout");

    const needing = getFilesNeedingUpload(progress, testFiles);
    expect(needing).toHaveLength(3); // pending + failed
    expect(needing.find((f) => f.path === testFiles[0].path)).toBeDefined();
  });

  test("includes new files not in progress", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles.slice(0, 2));
    markFileUploaded(progress, testFiles[0].path);
    markFileUploaded(progress, testFiles[1].path);

    const needing = getFilesNeedingUpload(progress, testFiles);
    expect(needing).toHaveLength(1);
    expect(needing[0].path).toBe(testFiles[2].path);
  });

  test("ignores files removed from manifest between runs", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markFileUploaded(progress, testFiles[0].path);

    // Manifest now only has 2 of the original 3 files
    const reducedManifest = testFiles.slice(1);
    const needing = getFilesNeedingUpload(progress, reducedManifest);
    expect(needing).toHaveLength(2); // pending files only from reduced manifest
    expect(needing.find((f) => f.path === testFiles[0].path)).toBeUndefined();
  });

  test("includes files whose size changed", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markFileUploaded(progress, testFiles[0].path);

    const changedManifest = testFiles.map((f) =>
      f.path === testFiles[0].path ? { ...f, size: f.size + 100 } : f,
    );

    const needing = getFilesNeedingUpload(progress, changedManifest);
    expect(needing.find((f) => f.path === testFiles[0].path)).toBeDefined();
  });
});

describe("clearUploadProgress", () => {
  test("deletes the progress file", () => {
    initUploadProgress(testDir, "nm000123", testFiles);
    expect(existsSync(join(testDir, ".nemar", "upload-progress.json"))).toBe(true);

    const result = clearUploadProgress(testDir);
    expect(result).toBe(true);
    expect(existsSync(join(testDir, ".nemar", "upload-progress.json"))).toBe(false);
  });

  test("returns true when no progress file exists", () => {
    expect(clearUploadProgress(testDir)).toBe(true);
  });
});

describe("getProgressSummary", () => {
  test("counts files by status", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markFileUploaded(progress, testFiles[0].path);
    markFileFailed(progress, testFiles[1].path, "error");

    const summary = getProgressSummary(progress);
    expect(summary.total).toBe(3);
    expect(summary.uploaded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.pending).toBe(1);
  });

  test("handles empty progress", () => {
    const progress = initUploadProgress(testDir, "nm000123", []);
    const summary = getProgressSummary(progress);
    expect(summary.total).toBe(0);
    expect(summary.uploaded).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.pending).toBe(0);
    expect(summary.completedSteps).toEqual([]);
  });

  test("includes completed steps", () => {
    const progress = initUploadProgress(testDir, "nm000123", testFiles);
    markStepCompleted(progress, "s3_upload");
    markStepCompleted(progress, "github_push");

    const summary = getProgressSummary(progress);
    expect(summary.completedSteps).toEqual(["s3_upload", "github_push"]);
  });
});
