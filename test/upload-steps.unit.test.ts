/**
 * Unit tests for the extracted dataset-upload step functions (#907).
 * Real fixtures + tmp dirs, no mocks. Pure CI tier (no CLI spawn, no network).
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLocalConfig } from "../src/lib/dataset-config";
import {
  initUploadProgress,
  isStepCompleted,
  markFileUploaded,
  readUploadProgress,
  writeUploadProgress,
} from "../src/lib/upload-progress";
import { analyzeDataset } from "../src/lib/upload/enrich";
import { writeNemarMetadata } from "../src/lib/upload/finalize";
import {
  computeFilesToUpload,
  prepareUploadProgress,
  reconcileProgressWithDataset,
  showUploadPlan,
} from "../src/lib/upload/plan";
import {
  LOW_VMEM_WARN_BYTES,
  detectVirtualMemoryLimit,
  parseUlimitVirtualMemory,
} from "../src/lib/upload/preflight";
import { ensureGitignoreHasNemar, parseRepoFullName } from "../src/lib/upload/transfer";

const scratchDirs: string[] = [];
function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratchDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const FIXTURE = join(import.meta.dir, "fixtures", "bids-minimal");

describe("analyzeDataset", () => {
  test("bids-minimal: name from BIDS Name, manifest classifies files", async () => {
    const { datasetName, manifest, bidsDescription } = await analyzeDataset(FIXTURE, {});
    expect(datasetName).toBe("E2E Test Dataset");
    expect(bidsDescription.Name).toBe("E2E Test Dataset");
    expect(manifest.files.length).toBe(7);
    expect(manifest.dataFiles).toBe(1);
    expect(manifest.metadataFiles).toBe(6);
    // Every manifest entry carries the working-tree mtime that drives
    // upload-progress change detection (#884).
    expect(manifest.files.every((f) => typeof f.mtimeMs === "number" && f.mtimeMs > 0)).toBe(true);
  });

  test("--name override wins over BIDS Name", async () => {
    const { datasetName } = await analyzeDataset(FIXTURE, { name: "Override Name" });
    expect(datasetName).toBe("Override Name");
  });

  test("falls back to directory basename when Name is absent", async () => {
    const dir = join(scratchDir("nemar-analyze-"), "my-dataset-dir");
    cpSync(FIXTURE, dir, { recursive: true });
    const desc = JSON.parse(readFileSync(join(dir, "dataset_description.json"), "utf-8"));
    delete desc.Name;
    writeFileSync(join(dir, "dataset_description.json"), JSON.stringify(desc, null, 2));
    const { datasetName } = await analyzeDataset(dir, {});
    expect(datasetName).toBe("my-dataset-dir");
  });
});

describe("prepareUploadProgress", () => {
  const manifest = {
    files: [
      { path: "sub-01/eeg/a.edf", size: 100, type: "data" as const },
      { path: "sub-01/eeg/b.edf", size: 200, type: "data" as const },
      { path: "dataset_description.json", size: 50, type: "metadata" as const },
    ],
    dataFiles: 2,
    metadataFiles: 1,
    totalSize: 350,
  };

  test("fresh dataset: all data files need uploading, no progress", () => {
    const dir = scratchDir("nemar-prepare-fresh-");
    const { dataFiles, uploadProgress } = prepareUploadProgress(dir, manifest, {});
    expect(dataFiles.map((f) => f.path)).toEqual(["sub-01/eeg/a.edf", "sub-01/eeg/b.edf"]);
    expect(uploadProgress).toBeNull();
    expect(computeFilesToUpload(uploadProgress, dataFiles)).toEqual(dataFiles);
  });

  test("persisted progress: already-uploaded files are excluded", () => {
    const dir = scratchDir("nemar-prepare-resume-");
    const progress = initUploadProgress(dir, "nm000001", [
      { path: "sub-01/eeg/a.edf", size: 100 },
      { path: "sub-01/eeg/b.edf", size: 200 },
    ]);
    markFileUploaded(progress, "sub-01/eeg/a.edf");
    writeUploadProgress(dir, progress);
    const { dataFiles, uploadProgress } = prepareUploadProgress(dir, manifest, {});
    const filesToUpload = computeFilesToUpload(uploadProgress, dataFiles);
    expect(filesToUpload.map((f) => f.path)).toEqual(["sub-01/eeg/b.edf"]);
  });

  test("--restart clears persisted progress and uploads everything", () => {
    const dir = scratchDir("nemar-prepare-restart-");
    const progress = initUploadProgress(dir, "nm000001", [{ path: "sub-01/eeg/a.edf", size: 100 }]);
    markFileUploaded(progress, "sub-01/eeg/a.edf");
    writeUploadProgress(dir, progress);
    const { dataFiles, uploadProgress } = prepareUploadProgress(dir, manifest, {
      restart: true,
    });
    expect(uploadProgress).toBeNull();
    expect(computeFilesToUpload(uploadProgress, dataFiles).length).toBe(2);
    expect(readUploadProgress(dir)).toBeNull();
  });

  test("stale progress for a DIFFERENT dataset no longer filters filesToUpload (#884)", () => {
    // The quirk previously pinned here is fixed: the sequencer computes
    // filesToUpload from the RECONCILED progress, so stale progress that
    // reconcile discards cannot silently skip files.
    const dir = scratchDir("nemar-prepare-stale-");
    const stale = initUploadProgress(dir, "nm999999", [{ path: "sub-01/eeg/a.edf", size: 100 }]);
    markFileUploaded(stale, "sub-01/eeg/a.edf");
    writeUploadProgress(dir, stale);
    const { dataFiles, uploadProgress } = prepareUploadProgress(dir, manifest, {});
    expect(uploadProgress?.dataset_id).toBe("nm999999");
    // reconcile discards the stale progress...
    const reconciled = reconcileProgressWithDataset(dir, uploadProgress, "nm000001");
    expect(reconciled).toBeNull();
    // ...and the post-reconcile list includes every data file again.
    const filesToUpload = computeFilesToUpload(reconciled, dataFiles);
    expect(filesToUpload.map((f) => f.path)).toEqual(["sub-01/eeg/a.edf", "sub-01/eeg/b.edf"]);
  });

  // Entry-point coverage for the zod-based isValidProgress replacement
  // (issue #1230): prepareUploadProgress is the orchestration function the
  // upload command actually reaches the resume path through, so these drive
  // it directly rather than the schema (an isolated helper) in isolation.
  test("valid resume: a well-formed progress file resumes with its dataset_id and files intact", () => {
    const dir = scratchDir("nemar-prepare-valid-resume-");
    const progress = initUploadProgress(dir, "nm000123", [
      { path: "sub-01/eeg/a.edf", size: 100 },
      { path: "sub-01/eeg/b.edf", size: 200 },
    ]);
    markFileUploaded(progress, "sub-01/eeg/a.edf");
    writeUploadProgress(dir, progress);

    const { uploadProgress } = prepareUploadProgress(dir, manifest, {});
    expect(uploadProgress).not.toBeNull();
    if (!uploadProgress) return; // narrowing guard
    expect(uploadProgress.dataset_id).toBe("nm000123");
    expect(uploadProgress.files["sub-01/eeg/a.edf"].status).toBe("uploaded");
    expect(uploadProgress.files["sub-01/eeg/b.edf"].status).toBe("pending");
  });

  test("malformed progress file: an invalid status refuses the resume (uploadProgress is null)", () => {
    const dir = scratchDir("nemar-prepare-malformed-");
    mkdirSync(join(dir, ".nemar"), { recursive: true });
    writeFileSync(
      join(dir, ".nemar", "upload-progress.json"),
      JSON.stringify({
        dataset_id: "nm000123",
        started_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        files: {
          "sub-01/eeg/a.edf": { status: "banana", size: 100 },
        },
        completed_steps: [],
      }),
    );

    const { uploadProgress } = prepareUploadProgress(dir, manifest, {});
    expect(uploadProgress).toBeNull();
  });
});

describe("checkUploadPrerequisites", () => {
  test("missing tools: prints the failure and returns fail (not ok)", () => {
    // Real subprocess with a PATH containing ONLY bun, so git-annex/gh/ssh
    // are genuinely absent (works regardless of where CI installs them).
    // Pins the process.exit(1) -> return FAIL mapping for the failure branch
    // (#918 review found this branch had zero coverage).
    const binDir = scratchDir("nemar-prereq-bin-");
    symlinkSync(Bun.which("bun") ?? "/usr/local/bin/bun", join(binDir, "bun"));
    const harnessPath = join(scratchDir("nemar-prereq-"), "harness.ts");
    writeFileSync(
      harnessPath,
      `import { checkUploadPrerequisites } from ${JSON.stringify(
        join(import.meta.dir, "..", "src", "lib", "upload", "preflight.ts"),
      )};\n` +
        `const result = await checkUploadPrerequisites();\n` +
        `console.log("STATUS:" + result.status);\n`,
    );
    const proc = Bun.spawnSync([join(binDir, "bun"), harnessPath], {
      env: { ...process.env, PATH: binDir, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString() + proc.stderr.toString();
    expect(out).toContain("Prerequisites check failed");
    expect(out).toContain("STATUS:fail");
    expect(out).not.toContain("STATUS:ok");
  });
});

describe("virtual-memory preflight (#884)", () => {
  test("parses the shell's 1024-byte block count into bytes", () => {
    // Real `ulimit -v` output for an 8 GiB cap (the SDSC Expanse login-node
    // value that OOM-killed git-annex in the issue report).
    expect(parseUlimitVirtualMemory("8388608\n")).toBe(8 * 1024 ** 3);
  });

  test("'unlimited' passes through as the sentinel string", () => {
    expect(parseUlimitVirtualMemory("unlimited\n")).toBe("unlimited");
  });

  test("garbage, empty, and negative outputs return null (no warning)", () => {
    expect(parseUlimitVirtualMemory("")).toBeNull();
    expect(parseUlimitVirtualMemory("cannot set limit")).toBeNull();
    expect(parseUlimitVirtualMemory("-1")).toBeNull();
    expect(parseUlimitVirtualMemory("12 34")).toBeNull();
  });

  test("the 8 GiB failure case is below the warning threshold; 32 GiB is not", () => {
    expect((parseUlimitVirtualMemory("8388608") as number) < LOW_VMEM_WARN_BYTES).toBe(true);
    expect((parseUlimitVirtualMemory("33554432") as number) < LOW_VMEM_WARN_BYTES).toBe(false);
  });

  test("detectVirtualMemoryLimit returns a valid shape on this machine (real shell)", async () => {
    const limit = await detectVirtualMemoryLimit();
    expect(
      limit === "unlimited" || limit === null || (typeof limit === "number" && limit > 0),
    ).toBe(true);
  });
});

describe("showUploadPlan", () => {
  test("--dry-run returns STOP after printing the plan", () => {
    const dir = scratchDir("nemar-plan-");
    const manifest = { files: [], dataFiles: 0, metadataFiles: 0, totalSize: 0 };
    const result = showUploadPlan(dir, "Test DS", manifest, { jobs: "4", dryRun: true });
    expect(result.status).toBe("stop");
  });

  test("resume: returns the existing local config written by a prior upload", () => {
    const dir = scratchDir("nemar-plan-resume-");
    writeLocalConfig(dir, {
      dataset_id: "nm000042",
      github_url: "https://github.com/nemarDatasets/nm000042",
      ssh_url: "git@github.com:nemarDatasets/nm000042.git",
      s3_prefix: "nm000042/",
      s3_config: { bucket: "nemar", region: "us-east-2", public_url: "https://x" },
      created_at: new Date().toISOString(),
    });
    const manifest = { files: [], dataFiles: 0, metadataFiles: 0, totalSize: 0 };
    const result = showUploadPlan(dir, "Test DS", manifest, { jobs: "4" });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.existingConfig?.dataset_id).toBe("nm000042");
    }
  });

  test("without --dry-run returns ok with the (null) existing config", () => {
    const dir = scratchDir("nemar-plan-ok-");
    const manifest = { files: [], dataFiles: 0, metadataFiles: 0, totalSize: 0 };
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    let result: ReturnType<typeof showUploadPlan>;
    try {
      result = showUploadPlan(dir, "Test DS", manifest, { jobs: "12", annexJobs: "8" });
    } finally {
      console.log = log;
    }
    expect(result.status).toBe("ok");
    expect(lines.join("\n")).toContain("Local git-annex add workers: 8");
    expect(lines.join("\n")).toContain("Parallel S3 copy streams: 12");
    if (result.status === "ok") {
      expect(result.value.existingConfig).toBeNull();
    }
  });
});

describe("writeNemarMetadata", () => {
  const files = [{ path: "sub-01/eeg/sub-01_task-rest_eeg.edf", size: 1024 }];
  const enrichment = {
    version: "2.0" as const,
    authors: { "A. Author": { orcid: "0000-0002-1825-0097" } },
  };

  test("writes metadata.json when missing, updates .bidsignore, marks the step", () => {
    const dir = scratchDir("nemar-meta-write-");
    const progress = initUploadProgress(dir, "nm000001", files);
    writeNemarMetadata(dir, enrichment, progress);
    expect(JSON.parse(readFileSync(join(dir, ".nemar", "metadata.json"), "utf-8")).version).toBe(
      "2.0",
    );
    expect(readFileSync(join(dir, ".bidsignore"), "utf-8")).toContain(".nemar/");
    expect(isStepCompleted(progress, "metadata_write")).toBe(true);
  });

  test("does not clobber an existing metadata.json", () => {
    const dir = scratchDir("nemar-meta-keep-");
    const progress = initUploadProgress(dir, "nm000001", files);
    mkdirSync(join(dir, ".nemar"), { recursive: true });
    writeFileSync(
      join(dir, ".nemar", "metadata.json"),
      JSON.stringify({ version: "2.0", marker: "original" }),
    );
    writeNemarMetadata(dir, enrichment, progress);
    expect(JSON.parse(readFileSync(join(dir, ".nemar", "metadata.json"), "utf-8")).marker).toBe(
      "original",
    );
  });

  test("skips entirely when the step is already completed", () => {
    const dir = scratchDir("nemar-meta-skip-");
    const progress = initUploadProgress(dir, "nm000001", files);
    writeNemarMetadata(dir, enrichment, progress); // completes the step
    rmSync(join(dir, ".bidsignore"));
    writeNemarMetadata(dir, enrichment, progress); // gated: must not rewrite
    expect(existsSync(join(dir, ".bidsignore"))).toBe(false);
  });

  test("no enrichment: still marks the step (matches monolith)", () => {
    const dir = scratchDir("nemar-meta-none-");
    const progress = initUploadProgress(dir, "nm000001", files);
    writeNemarMetadata(dir, undefined, progress);
    expect(isStepCompleted(progress, "metadata_write")).toBe(true);
    expect(existsSync(join(dir, ".nemar", "metadata.json"))).toBe(false);
  });
});

describe("parseRepoFullName", () => {
  test("standard https URL", () => {
    expect(parseRepoFullName("https://github.com/nemarDatasets/nm000123")).toBe(
      "nemarDatasets/nm000123",
    );
  });

  test(".git suffix is stripped", () => {
    expect(parseRepoFullName("https://github.com/nemarDatasets/nm000123.git")).toBe(
      "nemarDatasets/nm000123",
    );
  });

  test("ssh form is NOT matched (documents current behavior: colon, no slash)", () => {
    expect(parseRepoFullName("git@github.com:nemarDatasets/nm000123.git")).toBeNull();
  });

  test("garbage, empty, and undefined return null", () => {
    expect(parseRepoFullName("not a url")).toBeNull();
    expect(parseRepoFullName("")).toBeNull();
    expect(parseRepoFullName(undefined)).toBeNull();
  });
});

describe("ensureGitignoreHasNemar", () => {
  test("creates .gitignore with .nemar/ when absent", () => {
    const dir = scratchDir("nemar-gitignore-absent-");
    ensureGitignoreHasNemar(dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf-8")).toBe(".nemar/\n");
  });

  test("appends to an existing .gitignore without clobbering", () => {
    const dir = scratchDir("nemar-gitignore-append-");
    writeFileSync(join(dir, ".gitignore"), "node_modules/\ndist/\n\n");
    ensureGitignoreHasNemar(dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf-8")).toBe("node_modules/\ndist/\n.nemar/\n");
  });

  test("idempotent when .nemar/ already present", () => {
    const dir = scratchDir("nemar-gitignore-idem-");
    const content = "node_modules/\n.nemar/\n";
    writeFileSync(join(dir, ".gitignore"), content);
    ensureGitignoreHasNemar(dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf-8")).toBe(content);
  });
});

describe("reconcileProgressWithDataset", () => {
  const files = [{ path: "sub-01/eeg/sub-01_task-rest_eeg.edf", size: 1024 }];

  test("matching dataset id: progress returned, file intact", () => {
    const dir = scratchDir("nemar-progress-match-");
    const progress = initUploadProgress(dir, "nm000001", files);
    const result = reconcileProgressWithDataset(dir, progress, "nm000001");
    expect(result).toBe(progress);
    expect(readUploadProgress(dir)?.dataset_id).toBe("nm000001");
  });

  test("mismatched dataset id: returns null and deletes the progress file", () => {
    const dir = scratchDir("nemar-progress-stale-");
    const progress = initUploadProgress(dir, "nm000001", files);
    expect(existsSync(join(dir, ".nemar", "upload-progress.json"))).toBe(true);
    const result = reconcileProgressWithDataset(dir, progress, "nm000002");
    expect(result).toBeNull();
    expect(readUploadProgress(dir)).toBeNull();
  });

  test("null progress passes through", () => {
    const dir = scratchDir("nemar-progress-null-");
    expect(reconcileProgressWithDataset(dir, null, "nm000001")).toBeNull();
  });
});
