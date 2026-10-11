/**
 * Upload pipeline: dataset creation and data-transfer steps.
 *
 * Steps print their own output and never call process.exit (the command sequencer
 * owns exits). The data-transfer step (step 9) keeps its decisions apart from what
 * it prints: `copyAnnexedToRemote` decides from git-annex's own records and returns
 * data, and `transferAnnexedData` turns that data into output, progress records and
 * cleanup.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import ora, { type Ora } from "ora";
import type { UploaderPreflight } from "../../../shared/identifier-screen-report.js";
import { requestUploadCredentials } from "../api/data.js";
import {
  type PreflightRecording,
  createDataset,
  getDataset,
  recordDepositAttestation,
} from "../api/datasets.js";
import { ApiError, errorDetail } from "../api/errors.js";
import type { DepositAttestation } from "../attestation.js";
import { printStepFailure } from "../cli-output.js";
import { type LocalDatasetConfig, writeLocalConfig } from "../dataset-config.js";
import { displayName, isPrintableInCommand } from "../display-name.js";
import { acceptGitHubInvitation, configureGitHubRemote } from "../git-annex/github.js";
import {
  ADD_CHUNK_MAX_PATHS,
  chunkAddTargets,
  configureLargefiles,
  ensureGitAnnexInitialized,
  gitAnnexAdd,
  initDataset,
  isGitAnnexDataset,
  replaceDefaultAnnexDescription,
  unstageTrackedPaths,
} from "../git-annex/init.js";
import {
  ANNEX_SIZE_THRESHOLD_BYTES,
  describeAnnexSizeThreshold,
  isCaseVariantData,
} from "../git-annex/policy.js";
import { ensureLocalMainBranch, getCurrentBranch } from "../git-annex/repo-state.js";
import { runCommand } from "../git-annex/run-command.js";
import {
  type S3Credentials,
  buildS3RemoteArgs,
  clearAnnexCredentials,
  configureS3Remote,
  toS3Credentials,
} from "../git-annex/s3-remote.js";
import {
  type CopyOutcome,
  type OutputState,
  type RemoteHoldsOutcome,
  checkRemoteHolds,
  copyPathsToAnnexRemote,
  listAnnexedKeys,
} from "../git-annex/transfer.js";
import {
  RECORDED_CHECK_VALID_TEXT,
  type UploadProgress,
  clearStepCompleted,
  fingerprintAnnexedFiles,
  hasFileListChanged,
  initUploadProgress,
  isRecordedCheckFresh,
  isStepCompleted,
  markFileUploaded,
  markRecordedChecked,
  markStepCompleted,
  writeUploadProgress,
} from "../upload-progress.js";
import { describeInactivityDuration, persistSpinnerWarning } from "./inactivity.js";
import {
  type CredentialLease,
  DEFAULT_MAX_REFRESHES,
  DEFAULT_REFRESH_MARGIN_MS,
  MAX_FRUITLESS_REFRESHES,
  isExpiredCredentialError,
  leaseFromResponse,
  planCopyBatches,
} from "./s3-copy-session.js";
import { type DatasetInfo, FAIL, type Step, ok } from "./types.js";

export interface UploadFileEntry {
  path: string;
  size: number;
  type: "metadata" | "data";
  /** Working-tree mtime; drives upload-progress change detection (#884). */
  mtimeMs?: number;
}

function trackingInactivityWarning(idleMs: number): string {
  return [
    "Warning: local git-annex tracking has produced no stdout or stderr for",
    `${describeInactivityDuration(idleMs)}. git-annex is still running and may be reading a large file.`,
    "Wait, or interrupt and rerun the upload; earlier completed batches remain resumable.",
  ].join(" ");
}

function persistOptionalSpinnerWarning(spinner: Ora | null, warning: string): Ora | null {
  if (!spinner) {
    console.log(chalk.yellow(`  ${warning}`));
    return null;
  }
  return persistSpinnerWarning(spinner, warning);
}

/**
 * Extract repo full name from github_url (e.g., "https://github.com/nemarDatasets/nm000123").
 * Validate URL format: must be a valid GitHub URL with owner/repo pattern.
 * Returns null when the URL doesn't match (caller prints the failure).
 */
export function parseRepoFullName(githubUrl: string | undefined): string | null {
  const repoMatch = githubUrl?.match(/github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/);
  return repoMatch ? repoMatch[1].replace(/\.git$/, "") : null;
}

/** Ensure .nemar/ is gitignored (internal config, not dataset content). Warn-and-continue. */
export function ensureGitignoreHasNemar(absolutePath: string): void {
  try {
    const gitignorePath = resolve(absolutePath, ".gitignore");
    let gitignoreContent = "";
    if (existsSync(gitignorePath)) {
      gitignoreContent = readFileSync(gitignorePath, "utf-8");
    }
    if (!gitignoreContent.includes(".nemar/")) {
      const newContent = gitignoreContent
        ? `${gitignoreContent.trimEnd()}\n.nemar/\n`
        : ".nemar/\n";
      writeFileSync(gitignorePath, newContent);
    }
  } catch (gitignoreErr) {
    console.log(
      chalk.yellow(`  Warning: Could not update .gitignore: ${errorDetail(gitignoreErr)}`),
    );
  }
}

/**
 * Say so when the identifier preflight did not reach the dataset (ADR 0087). It warns and never
 * fails the upload: nothing gates on the record (the publication screen is the check that holds),
 * so stopping an upload over it would invent a refusal. But it is never silent, because an
 * absent record reads, correctly, as "no preflight on record", and the uploader should know.
 */
export function warnUnrecordedPreflight(
  sent: UploaderPreflight | undefined,
  outcome: PreflightRecording | { error: unknown },
): boolean {
  if (sent === undefined) return false;
  if (
    "identifier_preflight_recorded" in outcome &&
    outcome.identifier_preflight_recorded === true
  ) {
    return false;
  }
  // Four different facts, each said as itself: the call failed; the record was refused at the
  // door; the server took it and could not store it; or the server never mentioned it, which is
  // what a backend that predates the preflight does (it drops the field without a word).
  let why: string;
  if ("error" in outcome) why = `the request failed: ${errorDetail(outcome.error)}`;
  else if (outcome.identifier_preflight_refused) {
    why = `the server refused it (${outcome.identifier_preflight_refused})`;
  } else if (outcome.identifier_preflight_recorded === false) {
    why = "the server could not store it; running the upload again records it";
  } else why = "this NEMAR server does not record it";
  console.log(
    chalk.yellow(
      `  Warning: the identifier preflight was not recorded with your attestation (${why}).`,
    ),
  );
  console.log(
    chalk.dim("  The upload continues; NEMAR screens the dataset again before publication."),
  );
  return true;
}

/** Step 6: Create a new dataset in the backend, or resume an existing one. */
export async function createOrResumeDataset(
  absolutePath: string,
  options: { description?: string; datasetId?: string },
  datasetName: string,
  dataFiles: UploadFileEntry[],
  existingConfig: LocalDatasetConfig | null,
  attestation?: DepositAttestation,
  identifierPreflight?: UploaderPreflight,
): Promise<Step<DatasetInfo>> {
  let datasetInfo: DatasetInfo;

  // Check if this is a resume (existing local config was read by showUploadPlan)
  const isResume = existingConfig !== null;

  let spinner: Ora;

  if (isResume) {
    // Step 6: Resume existing dataset upload
    spinner = ora(`Resuming upload for ${existingConfig.dataset_id}...`).start();

    try {
      // Verify dataset still exists on backend (throws ApiError if not found)
      await getDataset(existingConfig.dataset_id);

      // Presigned URLs are requested adaptively in Step 9 (not upfront)
      datasetInfo = {
        dataset_id: existingConfig.dataset_id,
        ssh_url: existingConfig.ssh_url,
        s3_prefix: existingConfig.s3_prefix,
        github_url: existingConfig.github_url,
        upload_urls: {},
        s3_config: existingConfig.s3_config,
      };

      spinner.succeed(`Resuming upload: ${datasetInfo.dataset_id}`);
    } catch (error) {
      printStepFailure(spinner, "Failed to resume upload", error);
      if (error instanceof ApiError && error.statusCode === 404) {
        console.log(
          chalk.yellow("  The dataset may have been deleted. Try uploading as a new dataset."),
        );
        console.log(chalk.dim(`  Remove ${absolutePath}/.nemar to start fresh.`));
      }
      return FAIL;
    }

    // A resume from a local config never reaches the create call, so the attestation answered
    // at the prompt, and the preflight of the files about to be sent, are recorded here instead
    // (ADR 0087). The server's own resume path (a dedup hit on create) records both the same way.
    if (attestation) {
      try {
        const recorded = await recordDepositAttestation(datasetInfo.dataset_id, {
          attestation,
          identifier_preflight: identifierPreflight,
        });
        warnUnrecordedPreflight(identifierPreflight, recorded);
      } catch (error) {
        console.log(
          chalk.yellow(
            `  Warning: the deposit attestation could not be recorded on resume: ${errorDetail(error)}`,
          ),
        );
        warnUnrecordedPreflight(identifierPreflight, { error });
      }
    } else {
      // The preflight is recorded WITH the attestation; without one it has nowhere to go.
      warnUnrecordedPreflight(identifierPreflight, {
        identifier_preflight_recorded: false,
        identifier_preflight_refused: "preflight-without-attestation",
      });
    }
  } else {
    // Step 6: Create new dataset in backend with file manifest
    spinner = ora("Creating dataset in NEMAR...").start();

    try {
      const response = await createDataset({
        name: datasetName,
        description: options.description,
        files: dataFiles.map((f) => ({ path: f.path, size: f.size, type: f.type })),
        attestation,
        // Undefined on a call with no preflight, and `JSON.stringify` drops it then.
        identifier_preflight: identifierPreflight,
        // Undefined unless `--dataset-id` was given, and `JSON.stringify` drops
        // an undefined value, so an ordinary upload's body is unchanged by this
        // option existing. Never defaulted: a dataset id is allocated, and the
        // one reserved-band exception is something an operator asks for by name.
        dataset_id: options.datasetId,
      });

      datasetInfo = {
        dataset_id: response.dataset.dataset_id,
        ssh_url: response.dataset.ssh_url,
        s3_prefix: response.dataset.s3_prefix,
        github_url: response.dataset.github_url,
        upload_urls: response.upload_urls || {},
        s3_config: response.s3_config,
      };

      // Save local config for potential resume
      const localConfig: LocalDatasetConfig = {
        dataset_id: datasetInfo.dataset_id,
        github_url: datasetInfo.github_url,
        ssh_url: datasetInfo.ssh_url,
        s3_prefix: datasetInfo.s3_prefix,
        s3_config: datasetInfo.s3_config,
        created_at: new Date().toISOString(),
      };
      writeLocalConfig(absolutePath, localConfig);

      spinner.succeed(
        response.resumed
          ? `Resumed existing dataset: ${datasetInfo.dataset_id}`
          : `Dataset created: ${datasetInfo.dataset_id}`,
      );
      // One call for both answers, so the warning cannot be dropped from either.
      warnUnrecordedPreflight(identifierPreflight, response);
      if (!response.resumed) {
        // Wait for IAM policy propagation (AWS is eventually consistent)
        // This initial wait helps reduce retry attempts during upload
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }
    } catch (error) {
      printStepFailure(spinner, "Failed to create dataset", error);
      return FAIL;
    }
  }

  return ok(datasetInfo);
}

/** Step 6b: Accept the GitHub repository invitation (warns and continues on failure). */
export async function acceptRepoInvitation(datasetInfo: DatasetInfo): Promise<Step> {
  const spinner = ora("Accepting GitHub repository invitation...").start();

  const repoFullName = parseRepoFullName(datasetInfo.github_url);

  if (!repoFullName) {
    spinner.fail("Invalid GitHub repository URL from backend");
    console.log(chalk.red(`  Received: ${datasetInfo.github_url || "(empty)"}`));
    console.log(chalk.red("  Expected format: https://github.com/owner/repo"));
    console.log();
    console.log("This may indicate a backend issue. Please contact support.");
    return FAIL;
  }

  const inviteResult = await acceptGitHubInvitation(repoFullName);
  if (inviteResult.accepted) {
    if (inviteResult.alreadyCollaborator) {
      spinner.succeed("Already a collaborator on this repository");
    } else {
      spinner.succeed("GitHub invitation accepted");
    }
  } else {
    spinner.warn("Could not auto-accept invitation");
    console.log(chalk.yellow(`  ${inviteResult.error}`));
    console.log();
    console.log("You may need to accept the invitation manually:");
    console.log(chalk.cyan(`  https://github.com/${repoFullName}/invitations`));
    console.log();
    // Continue anyway - user can accept manually
  }
  return ok();
}

/** Step 7: Initialize git-annex (init, largefiles, adjusted-branch note, .gitignore). */
export async function initializeAnnexDataset(
  absolutePath: string,
  author: { name: string; email: string } | undefined,
): Promise<Step> {
  const spinner = ora("Initializing git-annex dataset...").start();

  const isExistingDataset = await isGitAnnexDataset(absolutePath);
  if (!isExistingDataset) {
    const createResult = await initDataset(absolutePath, { author });
    if (!createResult.success) {
      printStepFailure(spinner, "Failed to initialize git-annex dataset", createResult.error);
      return FAIL;
    }
  }

  // Ensure git-annex is initialized (handles both new and existing datasets)
  const gitAnnexResult = await ensureGitAnnexInitialized(absolutePath);
  if (!gitAnnexResult.success) {
    printStepFailure(spinner, "Failed to initialize git-annex", gitAnnexResult.error);
    return FAIL;
  }

  // A repository initialized by an older CLI (or by hand) carries git-annex's
  // default `user@host:/path` description, which the push below would publish
  // in uuid.log (#1399). Replace it before anything is pushed.
  const description = await replaceDefaultAnnexDescription(absolutePath);
  if (!description.success) {
    printStepFailure(
      spinner,
      "Failed to set a non-identifying git-annex description",
      description.error,
    );
    return FAIL;
  }

  // Configure largefiles pattern
  const largefilesResult = await configureLargefiles(absolutePath);
  if (!largefilesResult.success) {
    spinner.warn("Could not configure largefiles pattern");
    console.log(chalk.dim(`  ${largefilesResult.error}`));
  }

  spinner.succeed("git-annex dataset initialized");
  if (description.changed) {
    console.log(chalk.dim("  Replaced the repository's user@host:/path annex description (#1399)"));
  }

  // Inform user that the adjusted branch name is normal
  const postInitBranch = await getCurrentBranch(absolutePath);
  if (postInitBranch?.startsWith("adjusted/")) {
    console.log(chalk.dim(`  Note: Your local branch is "${postInitBranch}".`));
    console.log(
      chalk.dim("  This is normal; it keeps files unlocked so you can work with them directly."),
    );
    console.log(chalk.dim('  Pushes will go to the "main" branch on GitHub automatically.'));
  }

  ensureGitignoreHasNemar(absolutePath);
  return ok();
}

/** Step 8: Configure the GitHub remote and ensure the local branch is "main". */
export async function configureRemotes(
  absolutePath: string,
  datasetInfo: DatasetInfo,
  options: { yes?: boolean },
): Promise<Step> {
  const spinner = ora("Configuring GitHub remote...").start();

  const githubResult = await configureGitHubRemote(absolutePath, datasetInfo.ssh_url);
  if (!githubResult.success) {
    printStepFailure(spinner, "Failed to configure GitHub remote", githubResult.error);
    return FAIL;
  }

  spinner.succeed("GitHub remote configured");

  // Step 8b: Ensure local branch is named "main"
  const branchOk = await ensureLocalMainBranch(absolutePath, { yes: options.yes });
  if (!branchOk) {
    return FAIL;
  }
  return ok();
}

/**
 * What a failed read-only git call says: its own message, then how it ended. A call
 * killed by a signal (137 is SIGKILL, the out-of-memory killer's) prints nothing, so the
 * exit status is the only account of what happened.
 */
function commandFailure(command: string, stderr: string, exitCode: number): string {
  const detail = stderr.trim();
  return detail
    ? `${detail} (${command} exited ${exitCode})`
    : `${command} failed (exit status ${exitCode})`;
}

/**
 * Paths currently tracked by git, read from the index (`git ls-files -z`).
 * No content access, so this is cheap at any dataset size. Throws on git
 * failure so callers fail loudly instead of deciding from an empty set.
 */
export async function listTrackedPaths(absolutePath: string): Promise<Set<string>> {
  const { stdout, stderr, exitCode } = await runCommand(["git", "ls-files", "-z"], {
    cwd: absolutePath,
  });
  if (exitCode !== 0) {
    throw new Error(commandFailure("git ls-files", stderr, exitCode));
  }
  return new Set(stdout.split("\0").filter(Boolean));
}

/**
 * Annexed working-tree files; with `remote`, only those whose content the
 * location log records as present at that remote. Log/index reads only --
 * no content access and no network.
 */
export async function listAnnexedPaths(
  absolutePath: string,
  remote?: string,
): Promise<Set<string>> {
  // NUL-separated: a file name may contain a newline, and a newline-split list turns
  // it into two bogus paths that `git annex copy` then rejects as pathspecs.
  const args = remote
    ? ["git", "annex", "find", "--in", remote, "--print0"]
    : ["git", "annex", "find", "--include", "*", "--print0"];
  const { stdout, stderr, exitCode } = await runCommand(args, { cwd: absolutePath });
  if (exitCode !== 0) {
    throw new Error(commandFailure("git annex find", stderr, exitCode));
  }
  return new Set(stdout.split("\0").filter(Boolean));
}

/**
 * Annexed working-tree files the location log does NOT record at `remote`: the
 * complement of `listAnnexedPaths(path, remote)` within `listAnnexedPaths(path)`,
 * in one walk. When `paths` is supplied, the literal pathspecs scope the answer
 * to those paths so each bounded upload batch need not rescan the whole dataset.
 * Any matching option makes git-annex consider every annexed file rather than
 * only those whose content is present, so `--not --in` alone is enough; adding
 * `--include '*'` to it costs about 1.6 times as much for the same answer.
 * Measured on 10,000 annexed files against a directory remote: 3.7 s against 6.1 s
 * with nothing recorded at the remote, 3.65 s against 5.75 s with everything
 * recorded there. (Absolute times move between runs of the same machine; the ratio
 * does not.) No content access and no network.
 */
export async function listAnnexedPathsNotAt(
  absolutePath: string,
  remote: string,
  paths?: string[],
): Promise<Set<string>> {
  const args = paths
    ? [
        "git",
        "--literal-pathspecs",
        "annex",
        "find",
        "--not",
        "--in",
        remote,
        "--print0",
        "--",
        ...paths,
      ]
    : ["git", "annex", "find", "--not", "--in", remote, "--print0"];
  const { stdout, stderr, exitCode } = await runCommand(args, { cwd: absolutePath });
  if (exitCode !== 0) {
    throw new Error(commandFailure("git annex find", stderr, exitCode));
  }
  return new Set(stdout.split("\0").filter(Boolean));
}

/**
 * The files the git-annex add must cover: everything still needing upload
 * PLUS any data file git does not currently track, regardless of what the
 * progress file claims (#884 review). A progress file can outlive the git
 * state it describes (deleted .git, partial rsync of the dataset to another
 * node); a file marked "uploaded" but untracked would otherwise be skipped
 * by the targeted add AND silently omitted by `git annex copy` (which exits
 * 0 for files it does not consider annexed), leaving content with no
 * location-log record anywhere while the upload reports success.
 * Re-adding such files is content-addressed, so a re-put is harmless; the
 * point is re-establishing the location log.
 */
export function computeAddTargets<T extends { path: string }>(
  filesToUpload: T[],
  dataFiles: T[],
  trackedPaths: Set<string>,
): T[] {
  const targets = [...filesToUpload];
  const seen = new Set(filesToUpload.map((f) => f.path));
  for (const file of dataFiles) {
    if (!trackedPaths.has(file.path) && !seen.has(file.path)) {
      targets.push(file);
      seen.add(file.path);
    }
  }
  return targets;
}

/** Upload-local git-annex add workers; separate from the S3-copy `--jobs` value. */
export const DEFAULT_UPLOAD_ANNEX_JOBS = 4;

/**
 * Hand the data files to git-annex, with the CLI's reading of the policy
 * authoritative for the files where git-annex cannot read it.
 *
 * git-annex's `include=` and `exclude=` globs are case-sensitive, so `UPPER.EDF`,
 * `Mixed.Edf` and `X_MOTION.tsv` are not data to it by name, while the upload plan
 * (`shouldAnnex`, which folds case) has promised them to S3. Measured with the
 * production expression: `UPPER.EDF` under the size threshold stays in git, and
 * `X_MOTION.tsv` stays in git at ANY size because `exclude=*.tsv` matches it and
 * `include=*_motion.tsv` does not. Those files are added with `--force-large`;
 * everything else is added under the repository's own `annex.largefiles`, so an
 * override of the policy (an inherited `.gitattributes`) is still seen by the
 * not-annexed check rather than papered over. Re-running is a no-op for a file
 * already annexed and unmodified. See ADR 0031, amendment of 2026-10-07.
 */
export async function trackDataFiles(
  absolutePath: string,
  paths: string[],
  options: { annexJobs?: number; onInactivityWarning?: (idleMs: number) => void } = {},
): Promise<{ success: boolean; error?: string }> {
  const forced = paths.filter(isCaseVariantData);
  const regular = paths.filter((p) => !isCaseVariantData(p));
  const addOptions = {
    annexJobs: options.annexJobs ?? DEFAULT_UPLOAD_ANNEX_JOBS,
    ...(options.onInactivityWarning ? { onInactivityWarning: options.onInactivityWarning } : {}),
  };
  const added = await gitAnnexAdd(absolutePath, regular, {}, addOptions);
  if (!added.success || forced.length === 0) return added;
  // `{}` is gitAnnexAdd's chunking slot and the object after it its options. This call
  // must keep meaning "default chunking, --force-large" whatever shape that signature
  // takes; the test in test/upload-track-data.unit.test.ts that annexes a small
  // `UPPER.EDF` is what fails if it stops.
  return gitAnnexAdd(absolutePath, forced, {}, { forceLarge: true, ...addOptions });
}

/**
 * Data files from this run's add targets that git-annex did not annex, split by
 * whether that matters. The targets are data by NEMAR's annex policy
 * (`shouldAnnex`), so a file larger than the policy's size threshold that is
 * NOT annexed was routed into git by something overriding the policy (an
 * inherited `.gitattributes`, ADR 0060): it would be pushed to GitHub instead
 * of reaching S3, which is a hard failure. A file at or under the size threshold
 * does not block, because committing it to git is harmless, but it is not harmless
 * to say nothing: it is either in git or, when a `.gitignore` pattern matches it, in
 * no commit at all (see {@link SmallNotAnnexed}). The CLI folds case where
 * git-annex's globs do not, but `trackDataFiles` forces those case variants into the
 * annex, so what lands here is an override of the policy or an ignore pattern.
 * Pure; exported for unit tests.
 */
export function findDataFilesNotAnnexed<T extends { path: string; size: number; type?: string }>(
  addTargets: T[],
  annexedPaths: Set<string>,
): { blocking: T[]; small: T[] } {
  const missing = addTargets.filter(
    (f) => (f.type ?? "data") === "data" && !annexedPaths.has(f.path),
  );
  return {
    blocking: missing.filter((f) => f.size > ANNEX_SIZE_THRESHOLD_BYTES),
    small: missing.filter((f) => f.size <= ANNEX_SIZE_THRESHOLD_BYTES),
  };
}

/** "1 data file" / "165 data files". */
function countDataFiles(n: number): string {
  return `${n} data ${n === 1 ? "file" : "files"}`;
}

/** "was" / "were", by count. */
const wasWere = (n: number): string => (n === 1 ? "was" : "were");

/** Extra facts the success line can state; see {@link formatUploadSummary}. */
export interface UploadSummaryExtras {
  /**
   * Of the files sent as new, how many git-annex reported transferring; the others were
   * found at the remote already. Defaults to `confirmed`.
   */
  sent?: number;
  /** Files the location log recorded at the remote that were missing there and were sent again. */
  resent?: number;
  /** Recorded files whose content is not in this repository, checked with `git annex fsck`. */
  recordedNoLocal?: number;
  /** True when the recorded files were not asked about, because a recent check covered them. */
  recordedCheckSkipped?: boolean;
  /** How much of git-annex's output for the files sent as new could be used; default `understood`. */
  output?: OutputState;
  /** The same for the check of the recorded files. */
  recordedOutput?: OutputState;
}

/** Why a count git-annex printed cannot be trusted, in words. */
function whyUnknown(state: OutputState): string {
  return state === "partial"
    ? "git-annex gave no result for some of them"
    : "git-annex's output was not recognized";
}

/**
 * The success line of the S3 step, stated from the location log rather than from a count
 * of copy records: `total` annexed files are now recorded at the remote, of which
 * `attempted` were not recorded before this run and were copied, and `confirmed` of those
 * were reported as successful copies by git-annex. The rest, `total - attempted`, were
 * already recorded and were checked (see {@link UploadSummaryExtras}) unless a recent
 * check made this run skip that.
 *
 * It says what was done and no more. "Uploaded" is used only when git-annex reported
 * transferring every file it was given; a count git-annex could not give, or a check whose
 * output was not understood, is said to be unknown rather than rounded to the good case.
 * "Recorded", not "verified": the evidence for a file sent now is S3's acknowledged,
 * MD5-checked PUT and for one already recorded git-annex's own presence check against the
 * remote in this run, and neither is a bucket listing.
 * Pure; exported for unit tests.
 */
export function formatUploadSummary(
  total: number,
  attempted: number,
  confirmed: number,
  extras: UploadSummaryExtras = {},
): string {
  if (total === 0) return "No annexed data files, so nothing was copied to S3";
  const resent = extras.resent ?? 0;
  const noLocal = extras.recordedNoLocal ?? 0;
  const sent = extras.sent ?? confirmed;
  const skipped = extras.recordedCheckSkipped === true;
  const copyOutput = extras.output ?? "understood";
  const checkOutput = extras.recordedOutput ?? "understood";
  const recorded = Math.max(0, total - attempted);

  if (attempted === 0 && resent === 0) {
    if (skipped) {
      return `All ${total} data files are recorded at the S3 remote; not checked again, because these files and their annex keys passed a check at this destination within the last ${RECORDED_CHECK_VALID_TEXT}`;
    }
    if (checkOutput !== "understood") {
      return `All ${total} data files are recorded at the S3 remote (${whyUnknown(checkOutput)}, so what its check found is unknown)`;
    }
    let how: string;
    if (noLocal === 0) how = total === 1 ? "git-annex checked it" : "git-annex checked each one";
    else if (noLocal >= total) {
      how =
        total === 1
          ? "it has no local content, so it was checked with git-annex fsck"
          : "none has local content, so git-annex fsck checked them";
    } else {
      how = `${total - noLocal} checked by git-annex copy, ${noLocal} without local content checked with git-annex fsck`;
    }
    return total === 1
      ? `The 1 data file is already at the S3 remote (${how}; nothing to copy)`
      : `All ${total} data files are already at the S3 remote (${how}; nothing to copy)`;
  }

  const parts: string[] = [];
  if (attempted > 0) {
    const files = countDataFiles(attempted);
    const hedge =
      copyOutput !== "understood"
        ? `${whyUnknown(copyOutput)}, so how many it transferred is unknown; the location log is what shows them recorded`
        : confirmed < attempted
          ? `git-annex confirmed ${confirmed} of ${attempted}; the rest are recorded in the location log`
          : confirmed > attempted
            ? `git-annex reported ${confirmed} successful copies for ${attempted} files`
            : sent < attempted
              ? `git-annex reported transferring ${sent}`
              : "";
    parts.push(
      hedge
        ? `${files} not yet recorded at the S3 remote ${wasWere(attempted)} copied (${hedge})`
        : `Uploaded ${files} to S3`,
    );
  } else {
    parts.push("Sent no new files to S3");
  }
  if (recorded > 0) {
    if (skipped) {
      parts.push(
        `${recorded} already recorded at the remote ${wasWere(recorded)} not checked again, because these files and their annex keys passed a check at this destination within the last ${RECORDED_CHECK_VALID_TEXT}`,
      );
    } else if (checkOutput !== "understood") {
      parts.push(
        `${recorded} ${wasWere(recorded)} already recorded at the remote (${whyUnknown(checkOutput)}, so what its check found is unknown)`,
      );
    } else {
      const present = Math.max(0, recorded - noLocal - resent);
      if (present > 0) parts.push(`${present} ${wasWere(present)} already at the remote`);
      if (noLocal > 0) {
        parts.push(
          `${noLocal} recorded ${noLocal === 1 ? "file" : "files"} with no local content ${wasWere(noLocal)} checked with git-annex fsck`,
        );
      }
      if (resent > 0) {
        const verb = wasWere(resent);
        parts.push(`${resent} ${verb} recorded but missing at the remote and ${verb} sent again`);
      }
    }
  }
  parts.push("all recorded at the remote");
  return parts.join("; ");
}

/** What the S3 step decided before copying, for the caller's progress line. */
export interface S3CopyPlan {
  /** Annexed data files in the dataset. */
  total: number;
  /** Of those, the ones the location log does not yet record at the remote. */
  pending: number;
  /** Bounded copy batches needed for those pending paths. */
  copyBatchCount: number;
  /**
   * The ones the log already records. Unless `recordedCheckSkipped`, the remote itself is
   * asked about each, after the pending copy, and any it has lost are sent again or, with
   * no local content to send, reported missing.
   */
  recorded: number;
  /**
   * Of `recorded`, the ones whose content is not in this repository. `git annex copy`
   * cannot check those, so they are asked with `git annex fsck --fast --from`.
   */
  recordedNoLocal: number;
  /** True when a recent check of these recorded files and annex keys means they are not asked again. */
  recordedCheckSkipped: boolean;
  /** Data files at or under the size threshold that the annex did not take; see {@link SmallNotAnnexed}. */
  smallNotAnnexed: SmallNotAnnexed;
}

/**
 * Data files at or under the size threshold that git-annex did not annex, split by
 * where they ended up. A file over the threshold in this state blocks the upload; a
 * small one does not, because committing it to git is harmless, but the two groups
 * must not be described alike.
 */
export interface SmallNotAnnexed {
  /** Tracked by git: committed as ordinary files, so they travel with the metadata push. */
  inGit: string[];
  /**
   * Tracked by neither git nor the annex, most likely because a `.gitignore` pattern
   * matches them (git-annex skips an ignored file without a word, while the upload
   * plan, which walks the directory, still lists it). They are in no commit and not at
   * the remote: the published dataset will not have them.
   */
  leftOut: string[];
}

/**
 * Everything the S3 step concluded, as data; the caller prints it. `ok` carries
 * the annexed set so the save step does not walk the tree for it again.
 */
export type S3CopyOutcome =
  | {
      status: "ok";
      total: number;
      /** Copied as new: the files the location log did not record at the remote. */
      attempted: number;
      /** Of `attempted`, the ones git-annex reported as successful copies. */
      confirmed: number;
      /** Of `attempted`, the ones git-annex reported transferring rather than finding there. */
      sent: number;
      /** Recorded at the remote by the log but missing there, and sent again. */
      resent: number;
      /** Recorded files with no content here, whose presence was asked with `git annex fsck`. */
      recordedNoLocal: number;
      /** The recorded files were not asked about, because a recent check covered them. */
      recordedCheckSkipped: boolean;
      /** How much of git-annex's output for the new files could be used. */
      output: OutputState;
      /** The same for the check of the recorded files. */
      recordedOutput: OutputState;
      /**
       * Every annexed file was sent or asked about in THIS run and git-annex's output
       * for all of it was understood: the one state worth stamping as a passed check.
       */
      remoteConfirmed: boolean;
      /** Fingerprint of the target and annexed path/key set, or null if keys/identity are unavailable. */
      recordedCheckFingerprint: string | null;
      annexedPaths: Set<string>;
      smallNotAnnexed: SmallNotAnnexed;
    }
  | { status: "unreadable"; error: string }
  | { status: "blocked"; blocking: Array<{ path: string; size: number }> }
  | { status: "copy_failed"; error: string }
  | { status: "unverifiable"; error: string }
  | {
      status: "incomplete";
      missing: string[];
      total: number;
      /** Of `missing`, the ones whose content is not in this repository. */
      notLocal: string[];
      /**
       * False when the walk that finds `notLocal` failed, so it holds only the files known
       * to have no content here (the ones `fsck` asked about) and may be short.
       */
      notLocalKnown: boolean;
      /**
       * Of `missing`, the ones the log recorded at the remote and `fsck` reported it no
       * longer holds. `fsck` can also strike a key because the remote could not be read.
       */
      lostAtRemote: string[];
    };

interface PendingCopyOutcome {
  success: boolean;
  error?: string;
  filesCopied: number;
  filesSent: number;
  output: OutputState;
}

interface UploadCredentialSession {
  credentials: S3Credentials | undefined;
  lease: CredentialLease | undefined;
  renewLease: (() => Promise<CredentialLease>) | undefined;
  refreshes: number;
  longestBatchMs: number;
  onCredentialsRenewed: ((count: number, reason: string) => void) | undefined;
}

function currentUploadCredentials(session: UploadCredentialSession): S3Credentials | undefined {
  return session.lease?.credentials ?? session.credentials;
}

function uploadCredentialsNeedRefresh(session: UploadCredentialSession): boolean {
  return Boolean(
    session.lease &&
      session.renewLease &&
      session.lease.expiresAtMs - Date.now() < DEFAULT_REFRESH_MARGIN_MS + session.longestBatchMs,
  );
}

function recordUploadBatchDuration(session: UploadCredentialSession, durationMs: number): void {
  session.longestBatchMs = Math.max(session.longestBatchMs, durationMs);
}

async function renewUploadCredentials(
  session: UploadCredentialSession,
  reason: string,
  operation: string,
): Promise<string | null> {
  if (!session.renewLease) return "Upload credentials cannot be renewed in this remote";
  if (session.refreshes >= DEFAULT_MAX_REFRESHES) {
    return `Upload credentials were renewed ${session.refreshes} times and the ${operation} is still not done; re-run the command to continue`;
  }
  try {
    session.lease = await session.renewLease();
  } catch (error) {
    return `Could not renew upload credentials (${reason}): ${errorDetail(error)}`;
  }
  session.refreshes++;
  session.onCredentialsRenewed?.(session.refreshes, reason);
  return null;
}

function expiredCredentialError(outcome: CopyOutcome | RemoteHoldsOutcome): string | undefined {
  const errors = [
    outcome.error,
    ...("absent" in outcome ? outcome.absent.flatMap((file) => file.errors) : []),
  ];
  return errors.find(isExpiredCredentialError);
}

function planRecordedCheckBatches(
  paths: string[],
  sizes: Map<string, number>,
  maxFiles?: number,
): string[][] {
  const batches: string[][] = [];
  let knownSizePaths: string[] = [];
  const flushKnownSizePaths = () => {
    if (knownSizePaths.length === 0) return;
    batches.push(
      ...planCopyBatches(knownSizePaths, sizes, {
        maxFiles: maxFiles ?? ADD_CHUNK_MAX_PATHS,
      }),
    );
    knownSizePaths = [];
  };

  for (const path of paths) {
    if (sizes.has(path)) {
      knownSizePaths.push(path);
    } else {
      // Legacy annexed paths can be outside today's upload plan. A missing size is
      // unknown, not zero: isolate it so it cannot hide inside a large lease batch.
      flushKnownSizePaths();
      batches.push([path]);
    }
  }
  flushKnownSizePaths();
  return batches;
}

/**
 * Run one argv-bounded recorded-file check under the shared upload lease. A check
 * that reports an expired lease is repeated only for this chunk; after refresh its
 * result replaces the stale attempt, including any fsck location-log corrections.
 */
async function runRecordedCheckChunk<T extends CopyOutcome | RemoteHoldsOutcome>(args: {
  session: UploadCredentialSession;
  run: (credentials: S3Credentials | undefined) => Promise<T>;
  operation: "copy check" | "presence check";
}): Promise<{ success: true; outcome: T } | { success: false; error: string }> {
  let fruitlessExpiredAttempts = 0;
  let useJustRenewedLease = false;
  const sentPaths = new Set<string>();
  let sentCountReliable = true;
  for (;;) {
    if (!useJustRenewedLease && uploadCredentialsNeedRefresh(args.session)) {
      const renewalError = await renewUploadCredentials(
        args.session,
        "close to expiry",
        "recorded-file verification",
      );
      if (renewalError) return { success: false, error: renewalError };
    }
    useJustRenewedLease = false;

    const started = Date.now();
    const outcome = await args.run(currentUploadCredentials(args.session));
    recordUploadBatchDuration(args.session, Date.now() - started);

    const sentCountBeforeAttempt = sentPaths.size;
    if ("sentPaths" in outcome) {
      for (const path of outcome.sentPaths) sentPaths.add(path);
      if (outcome.output !== "understood" || outcome.filesSent !== outcome.sentPaths.length) {
        sentCountReliable = false;
      }
    }
    // A newly reported transfer makes the next chunk retry less fruitless. This
    // signal only bounds retries; the location log remains the durable authority.
    const transferredNewPath = sentPaths.size > sentCountBeforeAttempt;

    const explicitExpiry = expiredCredentialError(outcome);
    // S3 HeadObject errors are generic, so git-annex cannot always name an expired
    // token. If an errored check returns after its known lease expiration, refresh it.
    const failedAfterLeaseExpiry = Boolean(
      args.session.lease &&
        args.session.lease.expiresAtMs <= Date.now() &&
        (outcome.error !== undefined || ("absent" in outcome && outcome.absent.length > 0)),
    );
    const expired =
      explicitExpiry ??
      (failedAfterLeaseExpiry
        ? "The credential lease expired while the recorded-file check was running"
        : undefined);
    if (!expired) {
      if (!outcome.success) {
        return {
          success: false,
          error: outcome.error ?? `Failed to run the recorded-file ${args.operation}`,
        };
      }
      if ("sentPaths" in outcome) {
        return {
          success: true,
          outcome: {
            ...outcome,
            filesSent: sentCountReliable ? sentPaths.size : outcome.filesSent,
            sentPaths: [...sentPaths],
            output: sentCountReliable
              ? outcome.output
              : worseOutputState(outcome.output, "unrecognized"),
          } as T,
        };
      }
      return { success: true, outcome };
    }

    if (!args.session.lease || !args.session.renewLease) {
      return {
        success: false,
        error:
          outcome.error ??
          `Expired upload credentials interrupted the recorded-file ${args.operation}: ${expired}`,
      };
    }
    if (transferredNewPath) {
      fruitlessExpiredAttempts = 0;
    } else {
      fruitlessExpiredAttempts++;
    }
    if (fruitlessExpiredAttempts >= MAX_FRUITLESS_REFRESHES) {
      return {
        success: false,
        error: `Recorded-file ${args.operation} keeps failing with expired credentials: ${expired}`,
      };
    }
    const renewalError = await renewUploadCredentials(
      args.session,
      explicitExpiry
        ? "expired during recorded-file verification"
        : "lease expired during recorded-file verification",
      "recorded-file verification",
    );
    if (renewalError) return { success: false, error: renewalError };
    useJustRenewedLease = true;
  }
}

function worseOutputState(a: OutputState, b: OutputState): OutputState {
  return a === "unrecognized" || b === "unrecognized"
    ? "unrecognized"
    : a === "partial" || b === "partial"
      ? "partial"
      : "understood";
}

async function checkRecordedWithContent(args: {
  absolutePath: string;
  remote: string;
  paths: string[];
  sizes: Map<string, number>;
  jobs: number;
  batchMaxFiles?: number;
  credentialSession: UploadCredentialSession;
}): Promise<
  { success: true; filesSent: number; output: OutputState } | { success: false; error: string }
> {
  let filesSent = 0;
  let output: OutputState = "understood";
  for (const batch of planRecordedCheckBatches(args.paths, args.sizes, args.batchMaxFiles)) {
    for (const chunk of chunkAddTargets(batch)) {
      const check = await runRecordedCheckChunk({
        session: args.credentialSession,
        operation: "copy check",
        run: (credentials) =>
          copyPathsToAnnexRemote(args.absolutePath, args.remote, chunk, args.jobs, credentials),
      });
      if (!check.success) return check;
      filesSent += check.outcome.filesSent;
      output = worseOutputState(output, check.outcome.output);
    }
  }
  return { success: true, filesSent, output };
}

async function checkRecordedWithoutLocalContent(args: {
  absolutePath: string;
  remote: string;
  paths: string[];
  jobs: number;
  credentialSession: UploadCredentialSession;
}): Promise<RemoteHoldsOutcome> {
  let present = 0;
  let absent: RemoteHoldsOutcome["absent"] = [];
  let unanswered: string[] = [];
  let output: OutputState = "understood";
  for (const chunk of chunkAddTargets(args.paths)) {
    const check = await runRecordedCheckChunk({
      session: args.credentialSession,
      operation: "presence check",
      run: (credentials) =>
        checkRemoteHolds(args.absolutePath, args.remote, chunk, args.jobs, credentials),
    });
    if (!check.success) {
      return { success: false, error: check.error, present, absent, unanswered, output };
    }
    present += check.outcome.present;
    absent = absent.concat(check.outcome.absent);
    unanswered = unanswered.concat(check.outcome.unanswered);
    output = worseOutputState(output, check.outcome.output);
  }
  return { success: true, present, absent, unanswered, output };
}

/**
 * Copy pending paths in bounded batches. After every attempt, the location log
 * is the authority for what remains: JSON record counts never reset the
 * fruitless-retry limit or claim durable progress.
 */
async function copyPendingInBatches(args: {
  absolutePath: string;
  remote: string;
  batches: string[][];
  jobs: number;
  credentialSession: UploadCredentialSession;
}): Promise<PendingCopyOutcome> {
  let filesCopied = 0;
  let filesSent = 0;
  const sentPaths = new Set<string>();
  let output: OutputState = "understood";
  const fail = (error: string): PendingCopyOutcome => ({
    success: false,
    error,
    filesCopied,
    filesSent,
    output,
  });

  for (const batch of args.batches) {
    let noProgressExpiredAttempts = 0;
    let useJustRenewedLease = false;
    for (;;) {
      let pendingBefore: Set<string>;
      try {
        pendingBefore = await listAnnexedPathsNotAt(args.absolutePath, args.remote, batch);
      } catch (error) {
        return fail(`Could not read the annex location log before copying: ${errorDetail(error)}`);
      }
      const toCopy = batch.filter((path) => pendingBefore.has(path));
      if (toCopy.length === 0) break;

      if (useJustRenewedLease) {
        // A retry must first try the lease just obtained for the expired-token error.
        // This also avoids burning another API lease when the issued duration is shorter
        // than the proactive refresh margin (as in the 15-minute integration case).
        useJustRenewedLease = false;
      } else if (uploadCredentialsNeedRefresh(args.credentialSession)) {
        const renewalError = await renewUploadCredentials(
          args.credentialSession,
          "close to expiry",
          "copy",
        );
        if (renewalError) return fail(renewalError);
      }

      const started = Date.now();
      const copied = await copyPathsToAnnexRemote(
        args.absolutePath,
        args.remote,
        toCopy,
        args.jobs,
        currentUploadCredentials(args.credentialSession),
      );
      recordUploadBatchDuration(args.credentialSession, Date.now() - started);

      let pendingAfter: Set<string>;
      try {
        pendingAfter = await listAnnexedPathsNotAt(args.absolutePath, args.remote, batch);
      } catch (error) {
        return fail(`Could not read the annex location log after copying: ${errorDetail(error)}`);
      }
      const remaining = toCopy.filter((path) => pendingAfter.has(path));
      const delivered = toCopy.length - remaining.length;
      filesCopied += delivered;
      // Keep unique positive send records for reporting even if the location log
      // has not caught up yet; only that log determines durable retry progress.
      for (const path of copied.sentPaths) sentPaths.add(path);
      filesSent = sentPaths.size;
      output = worseOutputState(output, copied.output);

      // The location log wins over process status: git-annex can report an
      // expired sibling after other paths in the same batch were already sent.
      if (remaining.length === 0) break;
      if (copied.success) {
        // A clean git-annex exit can omit a path whose content is not in this
        // repository. Preserve the existing fsck/final-location-log diagnosis
        // below instead of turning that condition into a generic copy error.
        break;
      }
      if (!isExpiredCredentialError(copied.error)) {
        return fail(copied.error ?? "Failed to copy pending files to the remote");
      }
      if (!args.credentialSession.lease || !args.credentialSession.renewLease) {
        return fail(copied.error ?? "Expired upload credentials cannot be renewed in this remote");
      }

      noProgressExpiredAttempts = delivered > 0 ? 0 : noProgressExpiredAttempts + 1;
      if (noProgressExpiredAttempts >= MAX_FRUITLESS_REFRESHES) {
        return fail(
          `Copy keeps failing with expired credentials and the pending location-log set did not shrink: ${copied.error ?? "expired credentials"}`,
        );
      }
      const renewalError = await renewUploadCredentials(
        args.credentialSession,
        "expired during copy",
        "copy",
      );
      if (renewalError) return fail(renewalError);
      useJustRenewedLease = true;
    }
  }

  return { success: true, filesCopied, filesSent, output };
}

/**
 * The decisions of upload step 9, in order, against git-annex's own records:
 *
 *  1. Read what is annexed and what the location log does not yet record at
 *     `remote`. On a resume the second set is the remainder; on a fresh upload it
 *     is every annexed data file.
 *  2. Refuse, BEFORE copying anything, a data file over the size threshold that
 *     git-annex did not annex. It would be committed to git and never reach S3, and
 *     step 4 cannot see it: it only looks at annexed files. Failing here costs
 *     nothing; failing after the copy would have spent the whole STS window first.
 *  3. Copy exactly the pending paths.
 *  4. Have git-annex ask the remote about every path the log already records, unless
 *     `skipRecordedCheck` says it did recently. A `copy` WITHOUT `--fast` makes one
 *     presence check per key (bounded by `-J`) and sends again any the remote has lost;
 *     the log only says what git-annex recorded, and a bucket that was emptied, an
 *     object that expired, or a wrong `setpresentkey` all leave it claiming content the
 *     store does not hold. A path whose content is not in this repository cannot be
 *     asked that way (`copy` skips it with exit 0 and never contacts the remote), so
 *     those go through `git annex fsck --fast --from`, which fails the record it finds
 *     missing and corrects the log. The cost is one request per recorded file either way.
 *  5. Require EVERY annexed file to be recorded at the remote, not only this run's
 *     targets: an annexed file left behind by an earlier interrupted run, or annexed
 *     since the plan was made, is as missing from S3 as one added today. This walk of
 *     the log runs whether or not step 4 did.
 *
 * The caller owns the spinner, the credentials and the words; `onPlan` fires once,
 * after step 2 and before the copy, so the progress line can say how much is left.
 */
export async function copyAnnexedToRemote(args: {
  absolutePath: string;
  remote: string;
  addTargets: Array<{ path: string; size: number; type?: string }>;
  /** Sizes for the complete current data-file inventory, including resumed paths. */
  dataFiles: Array<{ path: string; size: number }>;
  jobs: number;
  credentials?: S3Credentials;
  lease?: CredentialLease;
  renewLease?: () => Promise<CredentialLease>;
  /** Smaller batch cap used by the real-API integration test. */
  batchMaxFiles?: number;
  /** Smaller byte cap used by the real-API integration test. */
  batchMaxBytes?: number;
  onCredentialsRenewed?: (count: number, reason: string) => void;
  /** Effective destination identity; absent for direct callers disables stamp reuse. */
  remoteIdentity?: string;
  /**
   * Whether a recent check covers this count and target/path/key fingerprint (see
   * `isRecordedCheckFresh`), so the remote is not asked about them again. Without a target
   * identity, the key walk and stamp reuse are both skipped.
   */
  skipRecordedCheck?: (recordedCount: number, fingerprint: string) => boolean;
  onPlan?: (plan: S3CopyPlan) => void | Promise<void>;
}): Promise<S3CopyOutcome> {
  const { absolutePath, remote, addTargets } = args;

  let annexedBefore: Set<string>;
  let pending: string[];
  try {
    annexedBefore = await listAnnexedPaths(absolutePath);
    pending = [...(await listAnnexedPathsNotAt(absolutePath, remote))].sort();
  } catch (listError) {
    return { status: "unreadable", error: errorDetail(listError) };
  }

  // The count alone cannot identify what the remote check covered: a collaborator can
  // replace one recorded key with another without changing the count. This local key walk
  // gives the resume stamp a stable identity; if it cannot be read, or there is no target
  // identity to bind it to, the upload still performs the remote check but does not cache it.
  let annexedKeys: Map<string, string> | null = null;
  if (annexedBefore.size > 0 && args.remoteIdentity) {
    try {
      annexedKeys = await listAnnexedKeys(absolutePath);
    } catch {
      // This lookup only enables the resume optimization. The ordinary copy and remote
      // checks below remain the source of truth.
    }
  }
  const fingerprintPaths = (paths: Iterable<string>): string | null => {
    if (!annexedKeys) return null;
    const entries: Array<readonly [string, string]> = [];
    for (const path of paths) {
      const key = annexedKeys.get(path);
      if (key === undefined) return null;
      entries.push([path, key]);
    }
    if (!args.remoteIdentity) return null;
    return fingerprintAnnexedFiles(entries, args.remoteIdentity);
  };
  const checkedFingerprint = fingerprintPaths(annexedBefore);

  const notAnnexed = findDataFilesNotAnnexed(addTargets, annexedBefore);
  if (notAnnexed.blocking.length > 0) {
    return {
      status: "blocked",
      blocking: notAnnexed.blocking.map((f) => ({ path: f.path, size: f.size })),
    };
  }
  const smallNotAnnexed: SmallNotAnnexed = { inGit: [], leftOut: [] };
  if (notAnnexed.small.length > 0) {
    let tracked: Set<string>;
    try {
      tracked = await listTrackedPaths(absolutePath);
    } catch (listError) {
      return { status: "unreadable", error: errorDetail(listError) };
    }
    for (const file of notAnnexed.small) {
      (tracked.has(file.path) ? smallNotAnnexed.inGit : smallNotAnnexed.leftOut).push(file.path);
    }
    smallNotAnnexed.inGit.sort();
    smallNotAnnexed.leftOut.sort();
  }

  const pendingSet = new Set(pending);
  const recorded = [...annexedBefore].filter((p) => !pendingSet.has(p)).sort();
  const recordedFingerprint = fingerprintPaths(recorded);
  const skipCheck =
    recorded.length > 0 &&
    checkedFingerprint !== null &&
    recordedFingerprint !== null &&
    args.skipRecordedCheck?.(recorded.length, recordedFingerprint) === true;
  // Split the recorded files by whether this repository holds their content: `copy` can
  // check those that it does, and only `fsck` can check the others.
  let recordedWithContent = recorded;
  let recordedNoLocal: string[] = [];
  if (recorded.length > 0 && !skipCheck) {
    try {
      const notHere = await listAnnexedPathsNotAt(absolutePath, "here");
      recordedNoLocal = recorded.filter((p) => notHere.has(p));
      recordedWithContent = recorded.filter((p) => !notHere.has(p));
    } catch (listError) {
      return { status: "unreadable", error: errorDetail(listError) };
    }
  }
  // Pending and recorded paths come from the annex location log, not just this
  // run's add targets. Use the complete current inventory so resumed paths keep
  // their real sizes and the byte bound still applies. Only a path missing from
  // the inventory has an unknown size and is checked alone (ADR 0094); sizing
  // the recorded check from addTargets instead isolates every recorded file on
  // a resume, which starts one git-annex process per file.
  const inventorySizes = new Map(args.dataFiles.map((file) => [file.path, file.size]));
  const copyBatches = planCopyBatches(pending, inventorySizes, {
    maxFiles: args.batchMaxFiles,
    maxBytes: args.batchMaxBytes,
  });
  await args.onPlan?.({
    total: annexedBefore.size,
    pending: pending.length,
    copyBatchCount: copyBatches.length,
    recorded: recorded.length,
    recordedNoLocal: recordedNoLocal.length,
    recordedCheckSkipped: skipCheck,
    smallNotAnnexed,
  });

  const credentialSession: UploadCredentialSession = {
    credentials: args.credentials,
    lease: args.lease,
    renewLease: args.renewLease,
    refreshes: 0,
    longestBatchMs: 0,
    onCredentialsRenewed: args.onCredentialsRenewed,
  };
  const copy = await copyPendingInBatches({
    absolutePath,
    remote,
    batches: copyBatches,
    jobs: args.jobs,
    credentialSession,
  });
  if (!copy.success) {
    return { status: "copy_failed", error: copy.error ?? "Failed to copy to remote" };
  }

  let resent = 0;
  let recordedOutput: OutputState = "understood";
  let notConfirmed: Array<{ file: string; errors: string[] }> = [];
  let unanswered: string[] = [];
  if (!skipCheck) {
    const check = await checkRecordedWithContent({
      absolutePath,
      remote,
      paths: recordedWithContent,
      sizes: inventorySizes,
      jobs: args.jobs,
      batchMaxFiles: args.batchMaxFiles,
      credentialSession,
    });
    if (!check.success) {
      return { status: "copy_failed", error: check.error ?? "Failed to check the remote" };
    }
    resent = check.filesSent;
    recordedOutput = check.output;

    if (recordedNoLocal.length > 0) {
      const holds = await checkRecordedWithoutLocalContent({
        absolutePath,
        remote,
        paths: recordedNoLocal,
        jobs: args.jobs,
        credentialSession,
      });
      if (!holds.success) {
        return { status: "copy_failed", error: holds.error ?? "Failed to check the remote" };
      }
      // A file the remote lacks is struck from the location log by fsck, so the walk below
      // reports it, and the content is not here to send again. A file fsck could not ask
      // about (an unreachable remote) is NOT struck, so the walk cannot see it: it is
      // sorted out after the walk, never read as present.
      notConfirmed = holds.absent;
      // A path fsck printed no record for was not asked; it is never read as present.
      unanswered = holds.unanswered;
      if (holds.output !== "understood" && recordedOutput === "understood") {
        recordedOutput = holds.output;
      }
    }
  }

  let missing: string[];
  try {
    missing = [...(await listAnnexedPathsNotAt(absolutePath, remote))].sort();
  } catch (verifyError) {
    return { status: "unverifiable", error: errorDetail(verifyError) };
  }
  const missingSet = new Set(missing);
  const unasked: Array<{ file: string; why: string }> = [
    ...notConfirmed
      .filter((a) => !missingSet.has(a.file))
      .map((a) => ({ file: a.file, why: a.errors[0] ?? "no reason given" })),
    ...unanswered.map((file) => ({ file, why: "git-annex gave no result for it" })),
  ];
  if (unasked.length > 0) {
    const first = unasked[0];
    return {
      status: "unverifiable",
      error: `git-annex could not confirm that ${unasked.length} recorded ${unasked.length === 1 ? "file" : "files"} with no local content ${unasked.length === 1 ? "is" : "are"} at the remote (${displayName(first.file)}: ${first.why})`,
    };
  }
  if (missing.length > 0) {
    // A file annexed since the plan counts toward the total as well as the missing.
    const total = annexedBefore.size + missing.filter((p) => !annexedBefore.has(p)).length;
    // `copy` skips, silently and with exit 0, a path whose content is not in this
    // repository (dropped, or never fetched). Re-running cannot fix that, so say which.
    let notLocal: string[] = [];
    let notLocalKnown = true;
    try {
      const absent = await listAnnexedPathsNotAt(absolutePath, "here");
      notLocal = missing.filter((p) => absent.has(p));
    } catch {
      // The hint is a courtesy, but it must not point the wrong way: a file fsck asked
      // about because it has no content here, or struck as lost, has none, so those are
      // still known. The rest are not.
      notLocalKnown = false;
      const known = new Set([...recordedNoLocal, ...notConfirmed.map((a) => a.file)]);
      notLocal = missing.filter((p) => known.has(p));
    }
    return {
      status: "incomplete",
      missing,
      total,
      notLocal,
      notLocalKnown,
      lostAtRemote: notConfirmed.map((a) => a.file).sort(),
    };
  }

  return {
    status: "ok",
    total: annexedBefore.size,
    attempted: pending.length,
    confirmed: copy.filesCopied,
    sent: copy.filesSent,
    resent,
    recordedNoLocal: recordedNoLocal.length,
    recordedCheckSkipped: skipCheck,
    output: copy.output,
    recordedOutput,
    remoteConfirmed: !skipCheck && copy.output === "understood" && recordedOutput === "understood",
    recordedCheckFingerprint: checkedFingerprint,
    annexedPaths: annexedBefore,
    smallNotAnnexed,
  };
}

/** What {@link recoverBlockedTracking} managed to do. */
export interface BlockedRecovery {
  /** Files taken out of the index, or null when that did not complete. */
  unstaged: number | null;
  /** The blocked files that were staged, so the ones that needed unstaging. */
  staged: string[];
  /** What went wrong, when something did. */
  error?: string;
}

/**
 * Make a blocked upload re-runnable.
 *
 * A data file git-annex refused is left staged as a plain git blob, and the
 * tracking step is stamped complete. Re-running after fixing the cause would then
 * do nothing: `git annex add` only considers files git sees as new or modified, so
 * on a staged, unmodified file it exits 0 and changes nothing (ADR 0060, verified
 * against git-annex 10.20260901). So the blob is dropped from the index (the file
 * stays on disk, untouched) and the stamp is cleared; the next run finds the file
 * untracked, adds it afresh, and annexes it if the cause is gone.
 *
 * The stamp is cleared FIRST, before anything that can fail. Unstaging can stop
 * half way (an index lock, a later chunk), and a user who then fixes the cause by
 * hand leaves nothing untracked, so nothing would ever reopen the tracking step;
 * with the stamp already gone, the next run tracks again. That run's `git annex add`
 * is still a no-op on a blob left staged, so it finds the file blocked once more;
 * {@link transferAnnexedData} answers a blocked verdict by calling this and then
 * adding the files again in the same run, so a cause fixed in the meantime takes
 * effect in the same run. A file that was never
 * staged because `.gitignore` matches it (git-annex skips an ignored file silently,
 * while the upload plan is `find`-based and lists it) has nothing to unstage; the
 * stamp alone is what the re-run needs once the pattern is fixed. Never throws: what
 * failed comes back in `error`, and `unstaged` is null only when unstaging itself did
 * not complete.
 */
export async function recoverBlockedTracking(
  absolutePath: string,
  progress: UploadProgress,
  blockedPaths: string[],
): Promise<BlockedRecovery> {
  clearStepCompleted(progress, "tracking");
  const saved = writeUploadProgress(absolutePath, progress);

  let staged = blockedPaths;
  let unstaged: number | null = null;
  const problems: string[] = [];
  try {
    const tracked = await listTrackedPaths(absolutePath);
    staged = blockedPaths.filter((p) => tracked.has(p));
    await unstageTrackedPaths(absolutePath, staged);
    unstaged = staged.length;
  } catch (e) {
    problems.push(errorDetail(e));
  }
  if (!saved) {
    problems.push(
      "the upload progress could not be saved, so the next run may skip the tracking step; if it does, run the upload with --restart",
    );
  }
  return { unstaged, staged, ...(problems.length > 0 ? { error: problems.join("; ") } : {}) };
}

/**
 * First few paths, then a count of the rest; shared by the step's failure messages. Each
 * name goes through {@link displayName}, so a newline in one cannot split its bullet.
 */
function previewPaths(paths: string[], limit = 5): string[] {
  const lines = paths.slice(0, limit).map((p) => `  - ${displayName(p)}`);
  if (paths.length > limit) lines.push(`  ... and ${paths.length - limit} more`);
  return lines;
}

/** A word for a POSIX shell: single-quoted, so spaces, globs and quotes survive. */
function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The most paths worth printing in a command; past it the re-run does the work. */
const MAX_PRINTED_UNSTAGE_PATHS = 50;

/**
 * The lines printed when large data files were not annexed, from what
 * {@link recoverBlockedTracking} did. When unstaging did not complete, the exact
 * command is printed with every path quoted for a shell (and `--literal-pathspecs`,
 * so a name with a `*` in it means itself); past {@link MAX_PRINTED_UNSTAGE_PATHS}
 * paths, or when a name has a control character no command can carry, it says instead
 * that the re-run unstages them. When unstaging did complete and something else went
 * wrong (the progress file could not be saved), it says that and offers no command
 * for work already done. Pure; exported for tests.
 */
export function describeBlockedTracking(
  blocking: Array<{ path: string; size: number }>,
  recovery: BlockedRecovery,
): string[] {
  const paths = blocking.map((f) => f.path);
  const lines = [
    `${countDataFiles(blocking.length)} over ${describeAnnexSizeThreshold()} ${blocking.length === 1 ? "was" : "were"} not added to git-annex and would be committed to git instead of uploaded to S3:`,
    ...previewPaths(paths),
  ];
  if (recovery.unstaged !== null) {
    lines.push(
      recovery.unstaged > 0
        ? `  ${recovery.unstaged} of them ${wasWere(recovery.unstaged)} unstaged so the next run can annex them; the files themselves are untouched.`
        : "  None of them was staged, so nothing needed unstaging.",
    );
    if (recovery.error) lines.push(`  But: ${recovery.error}.`);
  } else {
    lines.push(`  Could not finish making the next run able to annex them: ${recovery.error}.`);
    if (recovery.staged.length === 0) {
      lines.push("  None of them is staged, so fixing the cause is all that is left.");
    } else if (recovery.staged.length > MAX_PRINTED_UNSTAGE_PATHS) {
      lines.push(
        `  ${recovery.staged.length} paths are involved; the next run tries again, unstaging them.`,
      );
    } else if (!recovery.staged.every(isPrintableInCommand)) {
      lines.push(
        "  A name has a character that cannot go in a command; the next run tries again, unstaging them.",
      );
    } else {
      lines.push(
        "  The next run tries again; to do it now, run this in the dataset directory:",
        `    git --literal-pathspecs rm --cached --quiet --ignore-unmatch -- ${recovery.staged.map(shellQuote).join(" ")}`,
      );
    }
  }
  lines.push(
    "  Find out why git-annex declined them, fix that, then re-run `nemar dataset upload`:",
    "    - a .gitattributes `annex.largefiles` setting overrides NEMAR's annex policy",
    "    - a .gitignore pattern matches the file: git-annex skips an ignored file without saying so, while the upload plan lists every file on disk",
  );
  return lines;
}

/** What step 9 hands to the steps after it. */
export interface S3StepState {
  progress: UploadProgress;
  /**
   * Every annexed path step 9 listed before it copied, or null when it did not copy
   * (nothing to upload, or already complete). Optional input to the save step.
   */
  annexedPaths: Set<string> | null;
}

/** The special remote the upload copies to. */
export const S3_REMOTE_NAME = "nemar-s3";

/**
 * Whether `remote` is a special remote configured in this repository. Asked of the
 * local git config (`remote.<name>.annex-uuid`, which `initremote` and `enableremote`
 * both write), not of `git annex info`: that command also computes statistics and
 * took 3.9 s on a dataset of 10,000 annexed files, against a millisecond here. An
 * EMPTY value counts as not configured: `git config --get` exits 0 for it, and
 * git-annex then fails every call that names the remote with an internal trace that no
 * retry repairs, where treating the remote as absent lets `enableremote` write it again.
 * Only exit status 1 means the key is absent; any other failure (3 and 128 are a config
 * file git could not read or parse) throws, because "not configured" would send the
 * caller to reconfigure a repository whose config could not be read.
 */
export async function specialRemoteConfigured(
  absolutePath: string,
  remote: string,
): Promise<boolean> {
  const { stdout, stderr, exitCode } = await runCommand(
    ["git", "config", "--get", `remote.${remote}.annex-uuid`],
    { cwd: absolutePath },
  );
  if (exitCode === 1) return false;
  if (exitCode !== 0) throw new Error(commandFailure("git config", stderr, exitCode));
  return stdout.trim().length > 0;
}

/**
 * Annexed paths the location log does not record at `remote`. When the remote is not
 * configured in this repository at all, nothing can be recorded there, so every
 * annexed path is pending. Throws when git-annex cannot be read, which callers must
 * not take for "nothing pending".
 */
export async function listPendingAtRemote(absolutePath: string, remote: string): Promise<string[]> {
  const pending = (await specialRemoteConfigured(absolutePath, remote))
    ? await listAnnexedPathsNotAt(absolutePath, remote)
    : await listAnnexedPaths(absolutePath);
  return [...pending].sort();
}

/**
 * Makes the special remote ready to copy to and says which credentials to use (none
 * for a remote that needs none). `remoteIdentity` describes the effective target without
 * credentials, so a resume can only reuse a stamp for the destination it checked. The
 * production version asks the backend for STS credentials and configures the S3 remote;
 * a test can register a `directory` remote and return its directory as the identity.
 */
export interface OpenedRemote {
  credentials?: S3Credentials;
  /** Present for STS-backed remotes so a bounded copy can renew before expiry. */
  lease?: CredentialLease;
  renewLease?: () => Promise<CredentialLease>;
  remoteIdentity?: string;
}

export type OpenRemote = () => Promise<Step<OpenedRemote>>;

/** The production {@link OpenRemote}: STS credentials from the backend, then the S3 remote. */
function openS3Remote(absolutePath: string, datasetInfo: DatasetInfo): OpenRemote {
  return async () => {
    // Get STS credentials for S3 access
    let spinner = ora("Requesting upload credentials...").start();
    let creds: Awaited<ReturnType<typeof requestUploadCredentials>>;
    try {
      creds = await requestUploadCredentials(datasetInfo.dataset_id);
      spinner.succeed("Upload credentials received (2h expiry)");
    } catch (credError) {
      spinner.fail(`Could not get upload credentials: ${errorDetail(credError)}`);
      console.log(chalk.red("  Upload credentials are required for S3 access."));
      console.log(chalk.dim("  Re-run the command to retry."));
      return FAIL;
    }

    // Configure S3 special remote (idempotent: enables existing if already created)
    spinner = ora("Configuring S3 remote...").start();
    const config = {
      name: S3_REMOTE_NAME,
      bucket: creds.s3.bucket,
      prefix: `${datasetInfo.dataset_id}/objects`,
      region: creds.s3.region,
      publicUrl: datasetInfo.s3_config.public_url,
    };
    const s3Result = await configureS3Remote(
      absolutePath,
      config,
      toS3Credentials(creds.credentials),
    );
    if (!s3Result.success) {
      spinner.fail(`Failed to configure S3 remote: ${s3Result.error}`);
      console.log(chalk.dim("  Re-run the command to retry."));
      return FAIL;
    }
    spinner.succeed("S3 remote configured");
    const lease = leaseFromResponse(
      toS3Credentials(creds.credentials),
      creds.credentials.expiration,
    );
    return ok({
      credentials: lease.credentials,
      lease,
      renewLease: async () => {
        const fresh = await requestUploadCredentials(datasetInfo.dataset_id);
        return leaseFromResponse(toS3Credentials(fresh.credentials), fresh.credentials.expiration);
      },
      // STS credentials authenticate the request but do not identify its destination.
      // Include every effective annex S3 option so a resume against another environment,
      // bucket, region, prefix, or public URL cannot reuse the previous target's stamp.
      remoteIdentity: JSON.stringify([S3_REMOTE_NAME, buildS3RemoteArgs(config)]),
    });
  };
}

/** Recorded files above which the check of the remote is announced with an estimate. */
const ANNOUNCE_CHECK_ABOVE = 5_000;

/**
 * What one presence check against S3 costs: 50 to 100 ms a request from a typical
 * host, so the middle of that. It is an estimate for a person deciding whether to wait,
 * not a bound.
 */
const CHECK_SECONDS_PER_FILE = 0.075;

/** "about 5 minutes", "about 1 hour 10 minutes": a duration for a person, never to the second. */
export function describeDuration(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const h = `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return rest === 0 ? `about ${h}` : `about ${h} ${rest} ${rest === 1 ? "minute" : "minutes"}`;
}

/**
 * The lines that say what the check of the already-recorded files will cost, or that it is
 * being skipped. Asking the remote about a recorded file costs one request each, so on a
 * dataset with tens of thousands of files a resume spends minutes on it before anything
 * else, and a silent wait of that size reads as a hang. Empty when nothing is recorded.
 * Otherwise it says that the check is skipped, or how many files need `fsck` and, above
 * {@link ANNOUNCE_CHECK_ABOVE} recorded files, the estimate. Pure; exported for tests.
 */
export function describeRecordedCheck(plan: S3CopyPlan, jobs: number): string[] {
  const lines: string[] = [];
  if (plan.recorded === 0) return lines;
  if (plan.recordedCheckSkipped) {
    lines.push(
      `  These ${plan.recorded} recorded files and their annex keys passed a check at this destination within the last ${RECORDED_CHECK_VALID_TEXT}; the remote is not asked about them again.`,
    );
    return lines;
  }
  if (plan.recordedNoLocal > 0) {
    lines.push(
      `  ${countDataFiles(plan.recordedNoLocal)} recorded at the S3 remote ${plan.recordedNoLocal === 1 ? "has" : "have"} no content in this repository, so the remote is asked about ${plan.recordedNoLocal === 1 ? "it" : "them"} with git-annex fsck.`,
    );
  }
  if (plan.recorded > ANNOUNCE_CHECK_ABOVE) {
    const seconds = Math.ceil((plan.recorded * CHECK_SECONDS_PER_FILE) / Math.max(1, jobs));
    lines.push(
      `  The remote is asked about each of the ${plan.recorded.toLocaleString("en-US")} files already recorded there, one request each: ${describeDuration(seconds)} with ${jobs} parallel ${jobs === 1 ? "job" : "jobs"} (50 to 100 ms a request; --jobs changes it). A run that gets through it, with git-annex's answers understood, lets a re-run within ${RECORDED_CHECK_VALID_TEXT} skip it.`,
    );
  }
  return lines;
}

/**
 * Open the remote, copy, and turn what happened into side effects: what to print, which
 * files to record as uploaded, what to undo. All of it hangs off the outcome of
 * {@link copyAnnexedToRemote}, which decides; this function only acts, and is exported
 * so a test can drive it with a real directory remote.
 *
 * A blocked verdict (a large data file git-annex declined) is answered here, once: the
 * staged blobs are unstaged, the files are added again, and the copy decision is taken a
 * second time. If the cause was fixed since the run that staged them, the second
 * decision passes and this run finishes; if it was not, the second verdict is the same,
 * the blobs are unstaged once more, and the run fails with the reason.
 *
 * The credentials git-annex caches under `.git/annex/creds` are removed at the START
 * (a run killed by a signal mid-copy leaves them behind) and on EVERY exit after the
 * remote was opened, including a remote that failed to open: a failed `initremote` has
 * already written them (mode 600, STS keys) by the time it fails.
 */
export async function transferAnnexedData(args: {
  absolutePath: string;
  progress: UploadProgress;
  addTargets: Array<{ path: string; size: number; mtimeMs?: number; type?: string }>;
  dataFiles: Array<{ path: string; size: number }>;
  jobs: number;
  annexJobs?: number;
  openRemote: OpenRemote;
  /** Test-only cap for exercising multiple genuine API leases in a small repo. */
  copyBatchMaxFiles?: number;
}): Promise<Step<{ annexedPaths: Set<string> }>> {
  const { absolutePath, progress, addTargets } = args;
  let spinner: Ora | null = null;
  const fail = (message: string): void => {
    if (spinner) spinner.fail(message);
    else console.log(chalk.red(message));
  };

  await clearAnnexCredentials(absolutePath);
  let outcome: S3CopyOutcome;
  let recovery: BlockedRecovery | null = null;
  let retracked = 0;
  try {
    const opened = await args.openRemote();
    if (opened.status === "fail") return FAIL;
    const copyArgs = {
      absolutePath,
      remote: S3_REMOTE_NAME,
      remoteIdentity: opened.value.remoteIdentity,
      addTargets,
      dataFiles: args.dataFiles,
      jobs: args.jobs,
      credentials: opened.value.credentials,
      lease: opened.value.lease,
      renewLease: opened.value.renewLease,
      batchMaxFiles: args.copyBatchMaxFiles,
      onCredentialsRenewed: (count: number, reason: string) => {
        const line = `Renewed upload credentials (${reason}; renewal ${count})`;
        if (spinner) {
          spinner.info(line);
          spinner = ora("Uploading data files to S3...").start();
        } else {
          console.log(chalk.dim(`  ${line}`));
        }
      },
      skipRecordedCheck: (recordedCount: number, fingerprint: string) =>
        isRecordedCheckFresh(progress, recordedCount, fingerprint),
      onPlan: (plan: S3CopyPlan) => {
        const { inGit, leftOut } = plan.smallNotAnnexed;
        if (inGit.length > 0) {
          console.log(
            chalk.dim(
              `  ${inGit.length} small data file(s) (<= ${describeAnnexSizeThreshold()}) were stored in git rather than the annex:`,
            ),
          );
          for (const line of previewPaths(inGit, 3)) console.log(chalk.dim(line));
        }
        if (leftOut.length > 0) {
          console.log(
            chalk.yellow(
              `  Warning: ${leftOut.length} small data file(s) (<= ${describeAnnexSizeThreshold()}) are in neither git nor the annex and will NOT be uploaded; a .gitignore pattern probably matches them:`,
            ),
          );
          for (const line of previewPaths(leftOut, 3)) console.log(chalk.yellow(line));
        }
        for (const line of describeRecordedCheck(plan, args.jobs)) console.log(chalk.dim(line));
        const asking = plan.recordedCheckSkipped ? 0 : plan.recorded;
        if (plan.pending > 0) {
          spinner = ora(
            `Uploading ${countDataFiles(plan.pending)} in ${plan.copyBatchCount.toLocaleString()} ${plan.copyBatchCount === 1 ? "copy batch" : "copy batches"} to S3${asking > 0 ? ` (then checking the S3 remote for ${countDataFiles(asking)} already recorded)` : ""}...`,
          ).start();
        } else if (asking > 0) {
          spinner = ora(`Checking the S3 remote for ${countDataFiles(asking)}...`).start();
        }
      },
    };
    outcome = await copyAnnexedToRemote(copyArgs);
    while (outcome.status === "blocked") {
      const blocked = outcome.blocking.map((f) => f.path);
      recovery = await recoverBlockedTracking(absolutePath, progress, blocked);
      if (retracked > 0 || recovery.unstaged === null) break;
      // The blobs are out of the index. Add the files again: a cause fixed since the run
      // that staged them lets git-annex take them now. If it was not fixed, the verdict
      // below is the same and the loop ends, with the blobs unstaged once more.
      const added = await trackDataFiles(absolutePath, blocked, {
        annexJobs: args.annexJobs,
        onInactivityWarning: (idleMs) => {
          spinner = persistOptionalSpinnerWarning(spinner, trackingInactivityWarning(idleMs));
        },
      });
      if (!added.success) {
        console.log(chalk.red(`Failed to track data files: ${added.error}`));
        // The recovery before it may have had its own trouble (an unsaved progress file);
        // that account is the only record of it.
        if (recovery.error)
          console.log(chalk.yellow(`The recovery before it also reported: ${recovery.error}`));
        console.log(chalk.yellow("Re-run the same command to resume tracking."));
        return FAIL;
      }
      retracked = blocked.length;
      outcome = await copyAnnexedToRemote(copyArgs);
    }
  } finally {
    // Cached STS credentials are cleared whatever the outcome, so downloads use the
    // public URL.
    await clearAnnexCredentials(absolutePath);
  }

  const blockedCheckRan =
    outcome.status === "ok" ||
    outcome.status === "copy_failed" ||
    outcome.status === "incomplete" ||
    outcome.status === "unverifiable";
  if (retracked > 0 && blockedCheckRan) {
    // The recovery cleared the tracking stamp; the add that followed it is what completed
    // the step, so say so, or the next run adds the whole list again. Only a verdict that
    // got past the not-annexed check says the files are annexed now: a second verdict that
    // could not read the log says nothing.
    markStepCompleted(progress, "tracking");
    writeUploadProgress(absolutePath, progress);
    console.log(
      chalk.dim(
        `  ${countDataFiles(retracked)} git-annex had declined ${wasWere(retracked)} unstaged and added again; ${retracked === 1 ? "it is" : "they are"} annexed now.`,
      ),
    );
  }

  switch (outcome.status) {
    case "unreadable":
      console.log(chalk.red(`Could not read the annex location log: ${outcome.error}`));
      console.log(chalk.yellow("Re-run the same command to retry."));
      return FAIL;
    case "blocked": {
      // `recovery` is set by the loop above whenever the verdict is blocked.
      const recovered = recovery ?? { unstaged: null, staged: [], error: "no recovery ran" };
      for (const line of describeBlockedTracking(outcome.blocking, recovered)) {
        console.log(line.startsWith("    ") ? chalk.yellow(line) : chalk.red(line));
      }
      return FAIL;
    }
    case "copy_failed":
      fail(`S3 upload failed: ${outcome.error}`);
      console.log(chalk.yellow("Re-run the same command to resume uploading."));
      return FAIL;
    case "unverifiable":
      fail(`Could not confirm the S3 upload is recorded: ${outcome.error}`);
      console.log(chalk.yellow("Re-run the same command to retry."));
      return FAIL;
    case "incomplete": {
      fail(
        `S3 upload incomplete: ${outcome.missing.length} of ${outcome.total} annexed data files are not recorded at the S3 remote`,
      );
      for (const line of previewPaths(outcome.missing)) console.log(chalk.red(line));
      const lost = outcome.lostAtRemote.length;
      if (lost > 0) {
        console.log(
          chalk.red(
            `git-annex reports that the S3 remote no longer holds ${lost} of them: fsck did not find ${lost === 1 ? "it" : "them"} there and struck ${lost === 1 ? "it" : "them"} from the location log.`,
          ),
        );
        console.log(
          chalk.yellow(
            `If the remote could not be read, rather than having lost the objects, \`git annex fsck --fast --from ${S3_REMOTE_NAME}\` puts back the keys that were struck only for that reason.`,
          ),
        );
      }
      const n = outcome.notLocal.length;
      if (n > 0) {
        const first = outcome.notLocal[0];
        // One printable name that is known to be the only one is spelled out; anything
        // else gets the command that means exactly this set (content absent here and
        // absent at the remote).
        const explicit = n === 1 && outcome.notLocalKnown && isPrintableInCommand(first);
        const command = explicit
          ? `git annex get -- ${shellQuote(first)}`
          : `git annex get --not --in ${S3_REMOTE_NAME}`;
        const atLeast = outcome.notLocalKnown ? "" : "At least ";
        const some = `${atLeast}${n} of them ${n === 1 ? "has" : "have"} no content in this repository, so ${n === 1 ? "it cannot" : "they cannot"} be uploaded from here.`;
        console.log(
          chalk.yellow(
            `${some} ${lost > 0 ? "Get the content from another copy of the dataset" : `Fetch ${n === 1 ? "it" : "them"}`} with \`${command}\`, then re-run.`,
          ),
        );
      } else if (!outcome.notLocalKnown) {
        console.log(
          chalk.yellow(
            `Which of them have no content in this repository could not be read. If re-running does not help, fetch the missing content with \`git annex get --not --in ${S3_REMOTE_NAME}\`, then re-run.`,
          ),
        );
      } else {
        console.log(chalk.yellow("Re-run the same command to resume uploading."));
      }
      return FAIL;
    }
    case "ok":
      break;
  }

  // Only now, with every file recorded at the remote, is anything marked uploaded.
  for (const file of addTargets) {
    // Refresh the recorded size/mtime so a re-uploaded changed file
    // stops registering as changed on the next run (#884).
    markFileUploaded(progress, file.path, { size: file.size, mtimeMs: file.mtimeMs });
  }
  // A run that had the remote answer for every file, and understood the answers, is what a
  // re-run may rely on for a while; a skipped or unreadable check must not refresh it. The
  // count and target/path/key fingerprint keep changed destinations or replaced annex keys from riding on it.
  if (outcome.remoteConfirmed && outcome.recordedCheckFingerprint !== null) {
    markRecordedChecked(progress, outcome.total, outcome.recordedCheckFingerprint);
  }
  writeUploadProgress(absolutePath, progress);
  const summary = formatUploadSummary(outcome.total, outcome.attempted, outcome.confirmed, {
    sent: outcome.sent,
    resent: outcome.resent,
    recordedNoLocal: outcome.recordedNoLocal,
    recordedCheckSkipped: outcome.recordedCheckSkipped,
    output: outcome.output,
    recordedOutput: outcome.recordedOutput,
  });
  // A summary that says something is unknown is a warning, not a success line.
  const uncertain = outcome.output !== "understood" || outcome.recordedOutput !== "understood";
  if (spinner) {
    if (uncertain) (spinner as Ora).warn(summary);
    else (spinner as Ora).succeed(summary);
  } else console.log(uncertain ? chalk.yellow(summary) : summary);
  return ok({ annexedPaths: outcome.annexedPaths });
}

/**
 * Step 9: Upload data files to S3 via the git-annex S3 special remote,
 * gated by the persisted "s3_upload" step. Returns the (possibly newly
 * initialized) progress so the finalize steps share one instance, and the annexed
 * paths it listed (see {@link S3StepState}).
 *
 * git-annex tracking (#884) is its own persisted "tracking" step, adds only
 * the files that need it (not the whole tree), and runs BEFORE the
 * credential request so a multi-hour add on a multi-TB dataset cannot burn
 * the 2h STS window. On resume with an unchanged file list the add is
 * skipped entirely; a changed list clears the step (see the merge loop
 * below). The skip decision never trusts the progress file alone: the git
 * index is consulted first (computeAddTargets), the location log is asked what
 * the remote lacks (`listPendingAtRemote`, even when there is nothing to add), and
 * the log is checked again after the copy before anything is marked uploaded, so a
 * progress file that outlived its .git state cannot fake availability.
 *
 * `deps.openRemote` replaces how the remote is opened (credentials and S3
 * configuration); nothing else differs.
 */
export async function uploadDataToS3(
  absolutePath: string,
  options: { jobs: string; annexJobs?: string },
  dataFiles: UploadFileEntry[],
  filesToUpload: Array<{ path: string; size: number; mtimeMs?: number }>,
  uploadProgress: UploadProgress | null,
  datasetInfo: DatasetInfo,
  deps: { openRemote?: OpenRemote } = {},
): Promise<Step<S3StepState>> {
  let progress = uploadProgress;
  let spinner: Ora;
  // The annexed paths step 9 listed, handed on so the save step need not walk the
  // tree for them again. Stays null when step 9 did not run its copy.
  let annexedPaths: Set<string> | null = null;
  // Initialize progress tracking if not already present
  if (!progress) {
    progress = initUploadProgress(absolutePath, datasetInfo.dataset_id, dataFiles);
  } else {
    // A completed git-annex tracking pass only covers the file list it saw;
    // new or size-changed files invalidate it so the add re-runs (#884).
    if (isStepCompleted(progress, "tracking") && hasFileListChanged(progress, dataFiles)) {
      clearStepCompleted(progress, "tracking");
      console.log(chalk.dim("  Data files changed since the last run; re-running git-annex add"));
    }
    // Add any new files to progress tracking
    for (const file of dataFiles) {
      if (!progress.files[file.path]) {
        progress.files[file.path] = {
          status: "pending",
          size: file.size,
          mtimeMs: file.mtimeMs,
          updated_at: new Date().toISOString(),
        };
      }
    }
    writeUploadProgress(absolutePath, progress);
  }

  // Reconcile against ACTUAL git state, not just the progress file: the
  // progress file can survive while .git does not match it (#884 review).
  // Cheap index read; no content access -- runs even when "s3_upload" is
  // already marked complete (#1070). A prior run's completion stamp must
  // not hide data files added to the dataset since then: filesToUpload
  // (computed by the caller from the current file list) can be non-empty
  // even though "s3_upload" is stamped, and computeAddTargets can also
  // surface git-untracked files the stamp knows nothing about. Either way,
  // reopening the gate below is what lets a resumed upload actually pick
  // those files up instead of silently skipping them forever.
  let trackedPaths: Set<string>;
  try {
    trackedPaths = await listTrackedPaths(absolutePath);
  } catch (indexError) {
    console.log(chalk.red(`Failed to read the git index: ${errorDetail(indexError)}`));
    console.log(chalk.dim("  Re-run the command to retry."));
    return FAIL;
  }
  const addTargets = computeAddTargets(filesToUpload, dataFiles, trackedPaths);
  const annexJobs =
    options.annexJobs === undefined ? DEFAULT_UPLOAD_ANNEX_JOBS : Number(options.annexJobs);

  // The same reconcile against the OTHER record: the location log. An annexed file
  // the log does not record at the remote needs copying whether or not anything is
  // left to add, and "no add targets" says nothing about it (a file tracked in an
  // earlier run and never copied, or annexed by the save's `git add -A` after the
  // copy). Asking costs one walk of the log.
  let notAtRemote: string[];
  let remoteConfigured: boolean;
  try {
    remoteConfigured = await specialRemoteConfigured(absolutePath, S3_REMOTE_NAME);
    notAtRemote = await listPendingAtRemote(absolutePath, S3_REMOTE_NAME);
  } catch (listError) {
    console.log(chalk.red(`Could not read the annex location log: ${errorDetail(listError)}`));
    console.log(chalk.yellow("Re-run the same command to retry."));
    return FAIL;
  }
  const needsCopy = addTargets.length > 0 || notAtRemote.length > 0;

  const untrackedCount = addTargets.length - filesToUpload.length;
  const reopenTracking = untrackedCount > 0 && isStepCompleted(progress, "tracking");
  const reopenUpload = needsCopy && isStepCompleted(progress, "s3_upload");
  if (reopenTracking) {
    clearStepCompleted(progress, "tracking");
  }
  if (reopenUpload) {
    clearStepCompleted(progress, "s3_upload");
    // Reopening s3_upload for new content must also reopen the finalize
    // steps that depend on it (Step 11 saveDatasetStep / Step 12
    // pushMetadata in commands/dataset.ts, upload/finalize.ts). Both are
    // gated by their own persisted step and stay stamped complete from
    // the PRIOR run, so without this a new file's git-annex pointer would
    // reach S3 here but never be committed or pushed -- and
    // printUploadSuccess still clears progress and reports "Upload
    // complete!" with that pointer sitting only in the working tree
    // (review finding, critical: a run interrupted between pushMetadata
    // and printUploadSuccess -- e.g. mid deployCiStep -- leaves both
    // stamped true on disk with progress never cleared).
    clearStepCompleted(progress, "dataset_save");
    clearStepCompleted(progress, "github_push");
  }
  // One combined write instead of one per reopened step.
  if (reopenTracking || reopenUpload) {
    writeUploadProgress(absolutePath, progress);
  }
  if (reopenTracking) {
    console.log(
      chalk.yellow(
        `  ${untrackedCount} data files are missing from git despite recorded progress; re-tracking them`,
      ),
    );
  }
  if (reopenUpload) {
    console.log(
      chalk.yellow(
        addTargets.length > 0
          ? `  ${addTargets.length} data file(s) still need upload despite a completed s3_upload step; resuming`
          : remoteConfigured
            ? `  ${notAtRemote.length} annexed data file(s) are not recorded at the S3 remote despite a completed s3_upload step; resuming`
            : "  The S3 remote is not set up in this repository, so nothing can be recorded there despite a completed s3_upload step; resuming and checking every annexed data file against it",
      ),
    );
  }

  if (!isStepCompleted(progress, "s3_upload")) {
    if (needsCopy) {
      // Track data files with git-annex before anything else: the add can
      // take hours on multi-TB datasets, so it must not eat into the 2h STS
      // credential window, and its own persisted step lets a resume skip it.
      // Only files still needing upload (plus any untracked stragglers found
      // above) are added -- already-copied files are annexed already, and a
      // whole-tree add re-reads every unlocked file's content (#884).
      if (addTargets.length > 0 && !isStepCompleted(progress, "tracking")) {
        spinner = ora(`Tracking ${addTargets.length} data files with git-annex...`).start();
        const addResult = await trackDataFiles(
          absolutePath,
          addTargets.map((f) => f.path),
          {
            annexJobs,
            onInactivityWarning: (idleMs) => {
              spinner = persistSpinnerWarning(spinner, trackingInactivityWarning(idleMs));
            },
          },
        );
        if (!addResult.success) {
          spinner.fail(`Failed to track data files: ${addResult.error}`);
          console.log(chalk.yellow("Re-run the same command to resume tracking."));
          return FAIL;
        }
        spinner.succeed("Data files tracked by git-annex");
        markStepCompleted(progress, "tracking");
        writeUploadProgress(absolutePath, progress);
      } else if (addTargets.length > 0) {
        console.log(chalk.dim("  Data files already tracked by git-annex (skipping)"));
      }

      const transferred = await transferAnnexedData({
        absolutePath,
        progress,
        addTargets,
        dataFiles,
        jobs: Number.parseInt(options.jobs, 10),
        annexJobs,
        openRemote: deps.openRemote ?? openS3Remote(absolutePath, datasetInfo),
      });
      if (transferred.status === "fail") return FAIL;
      annexedPaths = transferred.value.annexedPaths;
    } else {
      console.log(chalk.dim("No data files to upload to S3"));
    }

    markStepCompleted(progress, "s3_upload");
    writeUploadProgress(absolutePath, progress);
  } else {
    console.log(chalk.dim("  S3 upload already completed (skipping)"));
  }

  return ok({ progress, annexedPaths });
}
