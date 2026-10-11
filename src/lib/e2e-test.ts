/**
 * E2E Test Runner
 *
 * Runs a full upload/download/update cycle against nm099999.
 * Uses real infrastructure (S3, GitHub, API) with admin credentials.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resetTestDataset } from "./api/admin.js";
import { requestUploadCredentials } from "./api/data.js";
import {
  cloneDataset,
  pushAnnexBranchToGitHub,
  pushToGitHub,
  saveDataset,
} from "./git-annex/clone-push.js";
import { configureGitHubRemote } from "./git-annex/github.js";
import { configureLargefiles, gitAnnexAdd, initDataset } from "./git-annex/init.js";
import { runCommand } from "./git-annex/run-command.js";
import {
  clearAnnexCredentials,
  configureS3Remote,
  enableS3Remote,
  toS3Credentials,
} from "./git-annex/s3-remote.js";
import { copyToAnnexRemote } from "./git-annex/transfer.js";

const TEST_DATASET_ID = "nm099999";

export interface E2EStep {
  name: string;
  passed: boolean;
  duration_ms: number;
  error?: string;
}

export interface E2EResult {
  passed: boolean;
  steps: E2EStep[];
  total_duration_ms: number;
  upload_dir?: string;
  clone_dir?: string;
}

interface E2EContext {
  uploadDir: string;
  cloneDir: string;
  verbose: boolean;
  creds?: Awaited<ReturnType<typeof requestUploadCredentials>>;
}

function log(ctx: { verbose: boolean }, ...args: unknown[]) {
  if (ctx.verbose) console.log("  ", ...args);
}

async function runStep(name: string, fn: () => Promise<void>): Promise<E2EStep> {
  const start = performance.now();
  try {
    await fn();
    return { name, passed: true, duration_ms: Math.round(performance.now() - start) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, passed: false, duration_ms: Math.round(performance.now() - start), error: msg };
  }
}

/** Run steps in order, stopping after the first failure. */
async function runStepsSequentially(
  defs: Array<{ name: string; fn: () => Promise<void> }>,
): Promise<E2EStep[]> {
  const steps: E2EStep[] = [];
  for (const { name, fn } of defs) {
    const step = await runStep(name, fn);
    steps.push(step);
    if (!step.passed) break;
  }
  return steps;
}

function assertOk(result: { success: boolean; error?: string }, msg: string) {
  if (!result.success) throw new Error(`${msg}: ${result.error}`);
}

function getCreds(ctx: E2EContext) {
  if (!ctx.creds) throw new Error("credentials not yet fetched");
  return ctx.creds;
}

/**
 * Get path to bids-minimal fixture directory.
 * Works both from source (src/) and built (dist/) locations.
 */
function getFixturePath(): string {
  // Try relative to this file's location
  const candidates = [
    resolve(__dirname, "../../test/fixtures/bids-minimal"),
    resolve(__dirname, "../test/fixtures/bids-minimal"),
    resolve(process.cwd(), "test/fixtures/bids-minimal"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    "Could not find test/fixtures/bids-minimal. Run from the nemar-cli root directory.",
  );
}

export async function runE2ETest(options: {
  verbose?: boolean;
  skipReset?: boolean;
  skipCleanup?: boolean;
}): Promise<E2EResult> {
  const verbose = options.verbose ?? false;
  const totalStart = performance.now();

  const uploadDir = mkdtempSync(join(tmpdir(), "nemar-e2e-upload-"));
  const cloneDir = mkdtempSync(join(tmpdir(), "nemar-e2e-clone-"));
  const ctx: E2EContext = { uploadDir, cloneDir, verbose };

  // Build the step pipeline; each step runs only if all previous steps passed.
  const stepDefs: Array<{ name: string; fn: () => Promise<void> }> = [];

  if (!options.skipReset) {
    stepDefs.push({
      name: "Reset nm099999",
      fn: async () => {
        const result = await resetTestDataset(TEST_DATASET_ID);
        log(ctx, `S3 objects deleted: ${result.steps.s3_deleted}`);
        log(ctx, `GitHub recreated: ${result.steps.github_recreated}`);
        log(ctx, `D1 cleaned: ${result.steps.d1_cleaned}`);
        if (!result.success) {
          const failed = [];
          if (!result.steps.github_recreated) failed.push("GitHub");
          if (!result.steps.d1_cleaned) failed.push("D1");
          throw new Error(`Reset partially failed: ${failed.join(", ")}`);
        }
      },
    });
  }

  stepDefs.push(
    {
      name: "Prepare upload",
      fn: async () => {
        const fixturePath = getFixturePath();
        cpSync(fixturePath, uploadDir, { recursive: true });
        // Remove any leftover git/nemar state from the fixture copy
        for (const stale of [".git", ".nemar", ".gitattributes"]) {
          const p = join(uploadDir, stale);
          if (existsSync(p)) {
            const chmodResult = await runCommand(["chmod", "-R", "u+w", p]);
            if (chmodResult.exitCode !== 0) {
              console.warn(
                `chmod failed for ${p} (exit ${chmodResult.exitCode}): ${chmodResult.stderr}`,
              );
            }
            rmSync(p, { recursive: true, force: true });
          }
        }
        log(ctx, `Copied fixtures to ${uploadDir}`);
      },
    },
    {
      name: "Init git + annex",
      fn: async () => {
        assertOk(await initDataset(uploadDir, { force: true }), "initDataset");
        assertOk(await configureLargefiles(uploadDir), "configureLargefiles");
        log(ctx, "Git + git-annex initialized");
      },
    },
    {
      name: "Configure remotes",
      fn: async () => {
        ctx.creds = await requestUploadCredentials(TEST_DATASET_ID);
        log(ctx, `S3 prefix: ${ctx.creds.s3.prefix}`);

        assertOk(
          await configureS3Remote(
            uploadDir,
            {
              name: "nemar-s3",
              bucket: ctx.creds.s3.bucket,
              prefix: `${TEST_DATASET_ID}/objects`,
              region: ctx.creds.s3.region,
              publicUrl: `https://${ctx.creds.s3.bucket}.s3.${ctx.creds.s3.region}.amazonaws.com/${TEST_DATASET_ID}/objects`,
            },
            toS3Credentials(ctx.creds.credentials),
          ),
          "configureS3Remote",
        );

        const sshUrl = `git@github.com:nemarDatasets/${TEST_DATASET_ID}.git`;
        assertOk(await configureGitHubRemote(uploadDir, sshUrl), "configureGitHubRemote");
        log(ctx, "S3 + GitHub remotes configured");
      },
    },
    {
      name: "Upload to S3",
      fn: async () => {
        assertOk(await gitAnnexAdd(uploadDir), "gitAnnexAdd");
        assertOk(await saveDataset(uploadDir, "Initial BIDS dataset"), "saveDataset");

        const copyResult = await copyToAnnexRemote(
          uploadDir,
          "nemar-s3",
          4,
          toS3Credentials(getCreds(ctx).credentials),
        );
        assertOk(copyResult, "copyToAnnexRemote");
        log(ctx, `Files copied to S3: ${copyResult.filesCopied}`);

        await clearAnnexCredentials(uploadDir);
      },
    },
    {
      name: "Push to GitHub",
      fn: async () => {
        const pushResult = await pushToGitHub(uploadDir);
        assertOk(pushResult, "pushToGitHub");
        if (pushResult.warning) {
          log(ctx, `Warning: ${pushResult.warning}`);
        }
        log(ctx, "Pushed to GitHub (main + git-annex branches)");
      },
    },
    {
      name: "Clone fresh",
      fn: async () => {
        const cloneUrl = `git@github.com:nemarDatasets/${TEST_DATASET_ID}.git`;
        assertOk(await cloneDataset(cloneUrl, cloneDir), "cloneDataset");

        const enableResult = await enableS3Remote(cloneDir, "nemar-s3");
        if (!enableResult.success) {
          throw new Error(`enableS3Remote: ${enableResult.error}`);
        }
        log(ctx, `Clone at ${cloneDir}, S3 remote enabled: ${enableResult.enabled}`);
      },
    },
    {
      name: "Download + verify",
      fn: async () => {
        // nm099999 is private, so we need S3 credentials for download
        const s3Creds = toS3Credentials(getCreds(ctx).credentials);
        const env: Record<string, string> = {
          AWS_ACCESS_KEY_ID: s3Creds.accessKeyId,
          AWS_SECRET_ACCESS_KEY: s3Creds.secretAccessKey,
        };
        if (s3Creds.sessionToken) {
          env.AWS_SESSION_TOKEN = s3Creds.sessionToken;
        }

        const { stdout, stderr, exitCode } = await runCommand(["git", "annex", "get", "."], {
          cwd: cloneDir,
          env,
        });
        if (exitCode !== 0) {
          throw new Error(`getDatasetData: ${stderr.trim()}`);
        }
        const getMatches = stdout.match(/^get .+ ok$/gm);
        log(ctx, `Files downloaded: ${getMatches ? getMatches.length : 0}`);

        const edfPath = join(cloneDir, "sub-01/eeg/sub-01_task-rest_eeg.edf");
        if (!existsSync(edfPath)) {
          throw new Error("EDF file not found after download");
        }
        const { size } = Bun.file(edfPath);
        if (size < 512) {
          throw new Error(`EDF file too small: ${size} bytes`);
        }
        log(ctx, `EDF file verified: ${size} bytes`);
      },
    },
    {
      name: "Update cycle",
      fn: async () => {
        const sub02Dir = join(cloneDir, "sub-02/eeg");
        mkdirSync(sub02Dir, { recursive: true });

        // Create a small EDF for sub-02
        const edfData = Buffer.alloc(1024);
        edfData.write("0".padEnd(8), 0, "ascii"); // version
        writeFileSync(join(sub02Dir, "sub-02_task-rest_eeg.edf"), edfData);
        writeFileSync(
          join(sub02Dir, "sub-02_task-rest_eeg.json"),
          JSON.stringify({ TaskName: "rest", SamplingFrequency: 256 }),
        );

        // Update participants.tsv
        const partTsv = readFileSync(join(cloneDir, "participants.tsv"), "utf-8");
        writeFileSync(join(cloneDir, "participants.tsv"), `${partTsv.trimEnd()}\nsub-02\t30\tF\n`);

        // Create branch before committing (keeps local main clean)
        const branchName = `e2e-update-${Date.now()}`;
        const { exitCode: branchCode } = await runCommand(["git", "checkout", "-b", branchName], {
          cwd: cloneDir,
        });
        if (branchCode !== 0) throw new Error("Failed to create update branch");

        // Track + commit
        assertOk(await gitAnnexAdd(cloneDir), "gitAnnexAdd (update)");
        assertOk(await saveDataset(cloneDir, "Add sub-02"), "saveDataset (update)");

        // Upload new data to S3 (fresh creds; STS tokens may expire)
        ctx.creds = await requestUploadCredentials(TEST_DATASET_ID);
        const copyResult = await copyToAnnexRemote(
          cloneDir,
          "nemar-s3",
          4,
          toS3Credentials(ctx.creds.credentials),
        );
        assertOk(copyResult, "copyToAnnexRemote (update)");
        log(ctx, `Update files copied to S3: ${copyResult.filesCopied}`);

        await clearAnnexCredentials(cloneDir);

        const pushResult = await pushToGitHub(cloneDir, "origin", branchName);
        assertOk(pushResult, "pushToGitHub (update branch)");

        const annexPush = await pushAnnexBranchToGitHub(cloneDir, "origin");
        if (!annexPush.success) {
          throw new Error(`Failed to push git-annex branch: ${annexPush.error}`);
        }

        log(ctx, `Update pushed to branch: ${branchName}`);
      },
    },
  );

  // Run steps sequentially, stopping on first failure
  const steps = await runStepsSequentially(stepDefs);

  // Cleanup unless skipped or a prior step failed
  if (!options.skipCleanup && steps.every((s) => s.passed)) {
    steps.push(
      await runStep("Cleanup", async () => {
        // git-annex creates read-only directories; chmod before rm
        await runCommand(["chmod", "-R", "u+w", uploadDir]);
        await runCommand(["chmod", "-R", "u+w", cloneDir]);
        rmSync(uploadDir, { recursive: true, force: true });
        rmSync(cloneDir, { recursive: true, force: true });
        log(ctx, "Temp directories cleaned up");
      }),
    );
  }

  return finish(steps, totalStart, uploadDir, cloneDir, options.skipCleanup);
}

function finish(
  steps: E2EStep[],
  totalStart: number,
  uploadDir: string,
  cloneDir: string,
  skipCleanup?: boolean,
): E2EResult {
  const result: E2EResult = {
    passed: steps.every((s) => s.passed),
    steps,
    total_duration_ms: Math.round(performance.now() - totalStart),
  };
  if (skipCleanup) {
    result.upload_dir = uploadDir;
    result.clone_dir = cloneDir;
  }
  return result;
}
