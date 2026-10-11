/**
 * Dataset management commands for NEMAR CLI
 *
 * Commands:
 * - nemar dataset validate        - Validate BIDS dataset locally
 * - nemar dataset upload          - Upload dataset to NEMAR
 * - nemar dataset download        - Download dataset from NEMAR
 * - nemar dataset status          - Check dataset status
 * - nemar dataset list            - List user's datasets
 * - nemar dataset release         - Create version bump PR
 * - nemar dataset update          - Update dataset via PR
 * - nemar dataset request-access  - Request access to a dataset
 * - nemar dataset invite          - Invite user as collaborator
 * - nemar dataset collaborators   - List dataset collaborators
 * - nemar dataset commit          - Stage and commit changes
 * - nemar dataset save            - Stage and commit changes (alias for commit)
 * - nemar dataset push            - Push commits and data to remotes
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "bun";
import chalk from "chalk";
import { Command, Option } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import { formatBytesCli } from "../../shared/bytes.js";
import {
  describeSandboxGap,
  describeUncheckedSandboxGap,
} from "../../shared/contract/profile-gaps.js";
import { datasetLandingUrl } from "../../shared/datacite-constants.js";
import {
  PREFLIGHT_ACKNOWLEDGEABLE,
  publicationRequestNotice,
} from "../../shared/identifier-screen-report.js";
import { LICENSE_TIERS } from "../../shared/license-tiers.js";
import { stepsForRelease } from "../../shared/publication-steps.js";
import { RangeParseError } from "../../shared/range.js";
import { addCi } from "../lib/api/admin.js";
import { getCurrentUser } from "../lib/api/auth.js";
import { requestDownloadCredentials, requestUploadCredentials } from "../lib/api/data.js";
import {
  type Dataset,
  type DatasetSearchResult,
  type DatasetsListResponse,
  type NemarMetadataPayload,
  ORCID_REGEX,
  approveAccessRequest,
  createDataset,
  denyAccessRequest,
  getDataset,
  getManifest,
  getUserCiStatus,
  getVersionHistory,
  inviteCollaborator,
  listAccessRequests,
  listCollaborators,
  listDatasets,
  listManifestVersions,
  requestDatasetAccess,
  resolveSourceId,
  searchDatasets,
} from "../lib/api/datasets.js";
import { ApiError, errorDetail } from "../lib/api/errors.js";
import {
  getPublishStatus,
  requestPublication,
  resendPublishNotification,
} from "../lib/api/publish.js";
import { type DepositAttestation, resolveAttestation } from "../lib/attestation.js";
import { isAwsCliAvailable } from "../lib/aws-cli.js";
import { type BidsFilterResult, buildBidsFilterArgs, chooseGetFilter } from "../lib/bids-filter.js";
import {
  type BidsValidationResult,
  checkDenoInstalled,
  formatValidationResult,
  getValidatorVersion,
  isValidatorCacheStale,
  runBidsValidatorDirect,
  updateValidatorCache,
  validateBidsDataset,
} from "../lib/bids-validator.js";
import {
  printNoVerifyMismatches,
  printNoVerifyNotice,
  printPartialRetrieval,
  requireAuth,
} from "../lib/cli-output.js";
import { triggerOpportunisticRefresh } from "../lib/completion/refresh.js";
import { getConfig, isAuthenticated } from "../lib/config.js";
import { NO_DESCRIPTION, YES_DESCRIPTION, YES_OPTION, confirm } from "../lib/confirm.js";
import {
  type LocalDatasetConfig,
  readLocalConfig,
  updateLastUpload,
  writeLocalConfig,
} from "../lib/dataset-config.js";
import {
  FacetEnumCliError,
  RANGE_FORMS_HELP,
  addFacetOptions,
  buildFacetParams,
  formatExcludedUnknownNote,
} from "../lib/facet-options.js";
import {
  cloneDataset,
  pushAnnexBranchToGitHub,
  pushBranch,
  pushToGitHub,
  saveDataset,
} from "../lib/git-annex/clone-push.js";
import {
  acceptGitHubInvitation,
  configureGitHubRemote,
  verifyGitHubAuth,
} from "../lib/git-annex/github.js";
import {
  configureLargefiles,
  ensureGitAnnexInitialized,
  gitAnnexAdd,
  initDataset,
  isGitAnnexDataset,
} from "../lib/git-annex/init.js";
import { checkDownloadPrerequisites, checkPrerequisites } from "../lib/git-annex/prereq.js";
import {
  detectImportMarker,
  ensureLocalMainBranch,
  getCurrentBranch,
  getDatasetIdFromRemote,
  getLocalDatasetInfo,
  gitFetchOrigin,
  gitMergeFastForward,
  isWorkingTreeDirty,
  readLocalDatasetVersion,
  readRemoteHeadDatasetVersion,
  resolveUpstreamRef,
} from "../lib/git-annex/repo-state.js";
import {
  clearAnnexCredentials,
  configureS3Remote,
  enableS3Remote,
  getAnnexS3Remotes,
  selectAnnexS3Remote,
  toS3Credentials,
} from "../lib/git-annex/s3-remote.js";
import {
  collectFileManifest,
  copyToAnnexRemote,
  countPendingDownload,
  dropFiles,
  dropUnusedAnnexObjects,
  getDatasetData,
} from "../lib/git-annex/transfer.js";
import { invokedAs } from "../lib/help.js";
import {
  type DataPlaneManifestEntry,
  DataPlaneUnavailableError,
  MAX_CONCURRENCY,
  downloadEntries,
  fetchManifest,
  fetchVersions,
  inspectOutputDir,
  printSnapshotCaveat,
  selectEntries,
  writeFailureList,
  writeSnapshotStamp,
} from "../lib/http-download.js";
import { identifierScreenLines } from "../lib/identifier-screen-display.js";
import {
  detectLicense,
  ensureLicenseFile,
  isResearchCompatible,
  promptForLicense,
  updateLicenseInDescription,
} from "../lib/license.js";
import { diffManifests } from "../lib/manifest-diff.js";
import {
  downloadWithAwsCli,
  downloadWithHttps,
  isOpenNeuroDatasetId,
  listOpenNeuroObjects,
  openNeuroDatasetExists,
} from "../lib/openneuro.js";
import { checkPrerequisitesForCommand } from "../lib/prerequisites.js";
import { DownloadProgressTracker } from "../lib/progress.js";
import { promptForProvenance } from "../lib/provenance.js";
import {
  ciPendingHeadline,
  ciPendingHint,
  ciUrlOf,
  isCiPendingBlock,
  isCiPendingReason,
} from "../lib/publish-pending.js";
import { renderSnippetLine, truncateTokenList } from "../lib/render/snippet.js";
import { resolveSandboxCompletion } from "../lib/sandbox-status.js";
import { bumpVersion, isValidStableVersion, parseVersion } from "../lib/semver.js";
import { theme } from "../lib/theme.js";
import type { UploadProgress } from "../lib/upload-progress.js";
import {
  clearUploadProgress,
  getFilesNeedingUpload,
  getProgressSummary,
  initUploadProgress,
  isStepCompleted,
  markFileUploaded,
  markStepCompleted,
  readUploadProgress,
  writeUploadProgress,
} from "../lib/upload-progress.js";
import { runDataSteps } from "../lib/upload/data-steps.js";
import { applyUploadDates, planUploadDates } from "../lib/upload/date-normalization.js";
import {
  analyzeDataset,
  collectAuthorOrcids,
  collectProvenance,
  resolveLicenseStep,
} from "../lib/upload/enrich.js";
import { deployCiStep, printUploadSuccess, pushMetadata } from "../lib/upload/finalize.js";
import {
  ACKNOWLEDGE_FLAG,
  collectAcknowledgment,
  identifierPreflightStep,
  recheckIdentifierPreflight,
} from "../lib/upload/identifier-preflight.js";
import {
  computeFilesToUpload,
  prepareUploadProgress,
  reconcileProgressWithDataset,
  showUploadPlan,
} from "../lib/upload/plan.js";
import {
  checkUploadAccessStep,
  checkUploadPrerequisites,
  validateBidsStep,
  verifyGhCli,
} from "../lib/upload/preflight.js";
import {
  DEFAULT_UPLOAD_ANNEX_JOBS,
  acceptRepoInvitation,
  configureRemotes,
  createOrResumeDataset,
  initializeAnnexDataset,
} from "../lib/upload/transfer.js";

/**
 * What to call a failed dataset lookup.
 *
 * Only a real 404 is "not found". Everything else -- a connection failure, a 500, a
 * 401 -- is a request that produced no answer about the dataset, and reporting it as
 * absence is the CLI inventing a fact. A 403 is named separately because "no access"
 * and "does not exist" are different things to the person reading it, and the backend
 * deliberately distinguishes them.
 */
export function datasetLookupFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.statusCode === 404) return "Dataset not found";
    if (error.statusCode === 403) return "Dataset not accessible";
    return `Could not read the dataset (HTTP ${error.statusCode})`;
  }
  return "Could not reach the backend";
}

export const datasetCommand = new Command("dataset").description("Dataset management").addHelpText(
  "after",
  `
Description:
  Manage BIDS datasets on NEMAR. Upload, download, validate, and version
  neurophysiology datasets in Brain Imaging Data Structure (BIDS) format.

Prerequisites:
  - git-annex (for upload/download)
  - Deno runtime (for BIDS validation)
  - NEMAR account (for upload)

Workflows:
  New dataset:          nemar dataset upload <path>
  Edit (private):       nemar dataset commit -> nemar dataset push
  Edit (public):        nemar dataset update
  New version:          nemar dataset release
  Download (one-shot):  nemar dataset download <id>            (clone + fetch data)
  Download (lazy):      nemar dataset clone <id>               (clone only, then 'cd' in)
                        nemar dataset get [paths]              (fetch data later)
  Request publication:  nemar dataset publish request <id>

Note:
  'download' runs OUTSIDE a dataset directory and clones + fetches in one step.
  'get' runs INSIDE an already-cloned dataset directory and only fetches data.
  For NEMAR datasets (nm/on prefix), both default-skip content under stimuli/
  and derivatives/ (large folders); pass --stimuli or --derivatives to include
  them. OpenNeuro datasets (ds prefix) ignore these flags and download the
  full tree.

Examples:
  $ nemar dataset validate ./my-dataset          # Validate locally
  $ nemar dataset upload ./my-dataset            # Upload to NEMAR
  $ nemar dataset download nm000104              # Download (skips stimuli/derivatives)
  $ nemar dataset download nm000104 --stimuli    # Also fetch stimuli/
  $ nemar dataset get --derivatives              # Fetch derivatives/ in a clone
  $ nemar dataset list --mine                    # List your datasets
  $ nemar dataset status nm000104                # Check dataset status
  $ nemar dataset request-access nm000104        # Request collaborator access
  $ nemar dataset invite johndoe nm000104        # Invite user as collaborator

Learn More:
  https://nemar-cli.pages.dev/commands/dataset/`,
);

// Validate command
datasetCommand
  .command("validate")
  .description("Validate a BIDS dataset using the official BIDS validator (requires Deno)")
  .argument("[path]", "Path to BIDS dataset directory", ".")
  .option("--ignore-warnings", "Only report errors, not warnings")
  .option("-c, --config <file>", "Validation config file (.bidsvalidatorrc)")
  .option("-r, --recursive", "Validate derivatives subdirectories")
  .option("--prune", "Skip sourcedata and derivatives for faster validation")
  .option("-v, --verbose", "Show verbose output")
  .option("--json", "Output results as JSON (for scripting)")
  .option("--version-info", "Show BIDS validator version info")
  .option("--update", "Force update the BIDS validator to the latest version")
  .allowUnknownOption()
  .addHelpText(
    "after",
    `
  Extra flags after known options are passed through to the BIDS validator.
  See all validator flags: deno run jsr:@bids/validator --help

  Examples:
    $ nemar dataset validate                            # Validate current directory
    $ nemar dataset validate ./ds --prune               # Skip derivatives
    $ nemar dataset validate ./ds --json > out.json     # JSON for scripting
    $ nemar dataset validate ./ds --ignoreNiftiHeaders  # Pass-through flag
    $ nemar dataset validate ./ds --max-rows 0           # Headers only`,
  )
  .action(async (datasetPath, options) => {
    // Handle --update: force-refresh the validator cache
    if (options.update) {
      const deno = await checkDenoInstalled();
      if (!deno.installed) {
        console.log(chalk.red("Deno is not installed"));
        console.log("Install Deno: https://deno.com");
        process.exit(1);
      }

      const oldVersion = await getValidatorVersion();
      const spinner = ora("Updating BIDS validator to latest version...").start();
      const newVersion = await updateValidatorCache();

      if (!newVersion) {
        spinner.fail("Failed to update BIDS validator");
        process.exit(1);
      }

      if (oldVersion && oldVersion !== newVersion) {
        spinner.succeed(`BIDS validator updated: ${oldVersion} -> ${newVersion}`);
      } else {
        spinner.succeed(`BIDS validator is up to date (v${newVersion})`);
      }

      // If no dataset path given, just update and exit
      if (!datasetPath || datasetPath === ".") {
        const cwd = process.cwd();
        if (!existsSync(resolve(cwd, "dataset_description.json"))) {
          return;
        }
      }
    }

    // Show version info if requested
    if (options.versionInfo) {
      const deno = await checkDenoInstalled();
      if (!deno.installed) {
        console.log(chalk.red("Deno is not installed"));
        console.log("Install Deno: https://deno.com");
        process.exit(1);
      }

      const stale = isValidatorCacheStale();
      const version = await getValidatorVersion();
      console.log(
        `BIDS Validator: ${version || "unknown"}${stale ? chalk.yellow(" (cache may be stale, run --update to refresh)") : ""}`,
      );
      console.log(`Deno: ${deno.version || "unknown"}`);
      return;
    }

    // Path is required unless --version-info
    if (!datasetPath) {
      console.log(chalk.red("Error: Missing required argument: path"));
      console.log("Usage: nemar dataset validate <path>");
      process.exit(1);
    }

    // Check Deno is installed
    const deno = await checkDenoInstalled();
    if (!deno.installed) {
      console.log(chalk.red("Error: Deno is required for BIDS validation"));
      console.log();
      console.log("The BIDS validator runs on Deno runtime.");
      console.log("Install Deno with one of these commands:");
      console.log();
      console.log(chalk.cyan("  # macOS/Linux (curl)"));
      console.log("  curl -fsSL https://deno.land/install.sh | sh");
      console.log();
      console.log(chalk.cyan("  # macOS (Homebrew)"));
      console.log("  brew install deno");
      console.log();
      console.log(chalk.cyan("  # Windows (PowerShell)"));
      console.log("  irm https://deno.land/install.ps1 | iex");
      console.log();
      console.log("Learn more: https://docs.deno.com/runtime/getting_started/installation/");
      process.exit(1);
    }

    // Auto-refresh stale cache (>7 days old)
    const forceReload = !!options.update;
    if (!forceReload && isValidatorCacheStale()) {
      const refreshSpinner = ora("Checking for BIDS validator updates...").start();
      const newVersion = await updateValidatorCache();
      if (newVersion) {
        refreshSpinner.succeed(`BIDS validator updated to v${newVersion}`);
      } else {
        refreshSpinner.info("Could not check for validator updates, using cached version");
      }
    }

    // Resolve and check path
    const absolutePath = resolve(datasetPath);
    if (!existsSync(absolutePath)) {
      console.log(chalk.red(`Error: Path does not exist: ${absolutePath}`));
      process.exit(1);
    }

    // Check for dataset_description.json
    const descPath = resolve(absolutePath, "dataset_description.json");
    if (!existsSync(descPath)) {
      console.log(chalk.red("Error: Not a valid BIDS dataset"));
      console.log("Missing required file: dataset_description.json");
      console.log(`Path: ${absolutePath}`);
      process.exit(1);
    }

    // Collect extra args (unknown flags passed through to bids-validator)
    const extraArgs = collectPassthroughArgs();

    // Run validation with spinner, then show native output
    const spinner = ora("Validating BIDS dataset...").start();

    try {
      const { stdout, stderr, exitCode } = await runBidsValidatorDirect(absolutePath, {
        config: options.config,
        ignoreWarnings: options.ignoreWarnings,
        recursive: options.recursive,
        prune: options.prune,
        verbose: options.verbose,
        json: options.json,
        extraArgs,
        forceReload,
      });

      // No output + non-zero exit = real failure (e.g. deno error)
      if (!stdout.trim() && exitCode !== 0) {
        spinner.fail("Validation failed");
        if (stderr.trim()) {
          const relevantStderr = stderr
            .split("\n")
            .filter((l) => !l.includes("Ignored build scripts"))
            .join("\n")
            .trim();
          if (relevantStderr) {
            console.error(relevantStderr);
          }
        }
        process.exit(1);
      }

      // Has output: validation ran (exit 0 = valid, exit 1 = errors found)
      spinner.succeed("Validation complete");

      if (stdout.trim()) {
        console.log(stdout);
      }

      process.exit(exitCode);
    } catch (error) {
      spinner.fail("Validation failed");
      console.log(chalk.red((error as Error).message));
      process.exit(1);
    }
  });

/**
 * Extract unknown/passthrough args from process.argv for the validate command.
 * Commander.js's .allowUnknownOption() prevents errors but doesn't parse them.
 */
function collectPassthroughArgs(): string[] {
  const knownFlags = new Set([
    "--ignore-warnings",
    "--config",
    "-c",
    "--recursive",
    "-r",
    "--prune",
    "--verbose",
    "-v",
    "--json",
    "--version-info",
    "--help",
    "-h",
  ]);

  const extra: string[] = [];
  const commandIndex = process.argv.indexOf("validate");
  if (commandIndex < 0) return extra;

  const rawArgs = process.argv.slice(commandIndex + 1);
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];

    // Skip the dataset path argument (first non-flag arg)
    if (!arg.startsWith("-")) continue;

    // Skip known flags
    if (knownFlags.has(arg)) {
      // If it's --config / -c, skip the next arg too (its value)
      if (arg === "--config" || arg === "-c") i++;
      continue;
    }

    // Pass through unknown flags and their values
    extra.push(arg);
    // If next arg looks like a value (not a flag), include it
    if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith("-")) {
      extra.push(rawArgs[i + 1]);
      i++;
    }
  }

  return extra;
}

// Upload command. Built by a factory rather than attached inline because
// `nemar upload` registers a SECOND instance of it at the root (a Command
// belongs to exactly one parent), and the two must not drift.
export function createUploadCommand(): Command {
  return new Command("upload")
    .description("Upload a BIDS dataset to NEMAR")
    .argument("<path>", "Path to BIDS dataset directory")
    .option("-n, --name <name>", "Dataset name (defaults to BIDS Name, then directory name)")
    .option("-d, --description <desc>", "Dataset description")
    .option("--skip-validation", "Skip BIDS validation (not recommended)")
    .option("--skip-orcid", "Skip co-author ORCID collection")
    .option("--dry-run", "Show what would be uploaded without doing it")
    .option("-j, --jobs <number>", "Parallel S3 copy streams", "4")
    .option(
      "--annex-jobs <number>",
      "Parallel local git-annex add workers",
      String(DEFAULT_UPLOAD_ANNEX_JOBS),
    )
    .option(YES_OPTION, YES_DESCRIPTION)
    .option("--restart", "Clear upload progress and re-upload all files")
    .option("--no", NO_DESCRIPTION) // Long form only; -n conflicts with --name
    .option("--deposit-type <type>", "Attestation: 'owner' or 'redistribution' (non-interactive)")
    .option("--key-status <status>", "Attestation: re-identification key 'destroyed' or 'retained'")
    .option(
      "--confirm-deidentified",
      "Attestation: confirm the dataset contains no identifiable personal information",
    )
    .option(
      "--affirm-no-duplicate",
      "Attestation (redistribution only): affirm the dataset is not already archived in BIDS format",
    )
    .option(
      "--upstream-source <ref>",
      "Attestation (redistribution only): upstream release URL or accession",
    )
    .option(
      "--dataset-id <id>",
      "Name the dataset id instead of being allocated one (admin, non-production, reserved fixture band only)",
    )
    .addOption(
      new Option(
        `${ACKNOWLEDGE_FLAG} <verdicts>`,
        `Upload despite what the identifier preflight found, naming every condition it reports (non-interactive; recorded; repeatable or comma-separated: ${PREFLIGHT_ACKNOWLEDGEABLE.join(", ")}). Direct identifiers cannot be acknowledged`,
      ).argParser(collectAcknowledgment),
    )
    .addHelpText(
      "after",
      ({ command }) => `
Description:
  Upload a BIDS dataset to NEMAR. The dataset will be validated, assigned
  a unique ID (nm000XXX), and stored on GitHub (metadata) and S3 (data files).

Requirements:
  - NEMAR account (nemar auth login)
  - git-annex installed
  - GitHub CLI authenticated (gh auth login)

Process:
  1. Screens the files for identifiers on this machine, before anything is sent
  2. Validates BIDS format (unless --skip-validation)
  3. Creates GitHub repository for metadata
  4. Tracks files locally with git-annex, then copies them to S3 in parallel
  5. Enables PR-based versioning workflow

Identifier preflight:
  Every EDF/BDF header (256 bytes each), the participants and scans tables,
  and non-BIDS JSON and small text files are read locally and checked by the
  scanner NEMAR's publication screen uses. Only kinds and counts are printed.
  - Direct identifiers (names, birth dates, record numbers): the upload is
    refused. There is no override.
  - A lesser finding, an incomplete read, or recordings in a format the
    scanner cannot read: the upload needs your acknowledgment, at the prompt
    or with ${ACKNOWLEDGE_FLAG} naming every condition the
    preflight reports (for example review,unchecked). --yes does not count.
  The dataset is screened again right before anything is sent, and the
  verdict is recorded with your deposit attestation. NEMAR screens the
  dataset again when you request publication.

Note:
  Local tracking workers and S3 copy streams are separate. --annex-jobs
  controls git-annex add (default: 4); -j/--jobs controls S3 copies (default: 4).

  This command is for initial dataset creation only. To update an
  existing dataset, use 'nemar dataset commit' + 'nemar dataset push'
  (private) or 'nemar dataset update' (public).

Examples:
  $ ${invokedAs(command)} ./my-eeg-dataset
  $ ${invokedAs(command)} ./ds -n "My EEG Study" -d "64-channel EEG data"
  $ ${invokedAs(command)} ./ds --dry-run        # Preview without uploading
  $ ${invokedAs(command)} ./ds -j 16            # More parallel S3 copy streams
  $ ${invokedAs(command)} ./ds --annex-jobs 8   # More local git-annex add workers
  $ ${invokedAs(command)} ./ds --dataset-id nm099998   # Standing fixture (admin, staging)`,
    )
    .action(async (datasetPath, options) => {
      const jobsValue = String(options.jobs);
      const jobs = Number.parseInt(jobsValue, 10);
      if (!/^\d+$/.test(jobsValue) || !Number.isSafeInteger(jobs) || jobs < 1) {
        console.log(chalk.red(`Error: --jobs must be a positive integer (got "${options.jobs}").`));
        process.exit(1);
      }

      const annexJobs = Number(options.annexJobs);
      if (!Number.isSafeInteger(annexJobs) || annexJobs < 1) {
        console.log(
          chalk.red(`Error: --annex-jobs must be a positive integer (got "${options.annexJobs}").`),
        );
        process.exit(1);
      }

      // Get config for GitHub username
      const config = getConfig();

      // Step 1: Check authentication
      requireAuth();

      // Step 1b: Check sandbox training. CLI-only, and stated in the one sentence
      // every other gap is stated in (#1268, ADR 0045) -- see describeSandboxGap.
      //
      // The local flag is a CACHE, not the record (#1274): it is empty on a
      // fresh install, on a second machine and after a config reset, and reading
      // it as a definitive "no" told people who had trained to train again. A
      // miss asks the backend, which owns the fact.
      const sandbox = await resolveSandboxCompletion();
      if (sandbox.status === "not_completed") {
        console.log(chalk.yellow(describeSandboxGap()));
        console.log();
        console.log("It verifies your setup and familiarizes you with the workflow.");
        process.exit(1);
      }
      if (sandbox.status === "unknown") {
        // Still a stop -- unconfirmed is not confirmed, and the upload needs the
        // setup training verifies -- but the advice is to re-check rather than
        // to re-train, which is the wrong first move for an account that has
        // already done it. (The upload-access step below fails OPEN because a
        // grant it cannot read is one the SERVER will still enforce; nothing
        // enforces sandbox training but this gate, so it fails closed.)
        console.log(chalk.yellow(describeUncheckedSandboxGap()));
        console.log(chalk.dim(`  ${sandbox.reason}`));
        console.log();
        process.exit(1);
      }

      // Step 1c: Upload access, before anything expensive runs. A missing grant
      // is a hard stop for a real upload; --dry-run continues, since it uploads
      // nothing and the plan is what the user asked to see.
      if ((await checkUploadAccessStep({ dryRun: options.dryRun })).status === "fail") {
        process.exit(1);
      }

      // Resolve path
      const absolutePath = resolve(datasetPath);
      if (!existsSync(absolutePath)) {
        console.log(chalk.red(`Error: Path does not exist: ${absolutePath}`));
        process.exit(1);
      }

      // Identifier preflight, between steps 1c and 1d (epic #1610 phase 3, ADR 0087). Local,
      // and BEFORE every step that sends dataset content: the co-author ORCID step (4b) reads
      // names out of dataset_description.json, and the create call (6) carries every data
      // file's path. A refusal, or a verdict nobody acknowledged, stops here with nothing sent.
      //
      // The acquisition dates the upload will set to 1 January (ADR 0091) are planned first and
      // only read, so the preflight screens the files as they will be sent; nothing changes until
      // the final confirmation below.
      const datePlan = await planUploadDates(absolutePath);
      const preflight = await identifierPreflightStep(absolutePath, options, undefined, datePlan);
      if (preflight.status === "fail") process.exit(1);
      const identifierPreflight = preflight.value;

      // Step 1d: Check required tools
      await checkPrerequisitesForCommand("upload");

      // Step 2: Check prerequisites
      if ((await checkUploadPrerequisites()).status === "fail") process.exit(1);

      // Step 2b: Verify gh CLI authentication
      if ((await verifyGhCli(config)).status === "fail") process.exit(1);

      // Step 3: BIDS Validation (unless skipped)
      if ((await validateBidsStep(absolutePath, options)).status === "fail") process.exit(1);

      // Step 4: Collect file manifest and show upload plan
      const { datasetName, manifest, bidsDescription } = await analyzeDataset(
        absolutePath,
        options,
      );

      // Step 4b: Collect co-author ORCIDs (skip if metadata already exists from prior run)
      const coAuthorEnrichment = await collectAuthorOrcids(absolutePath, options, bidsDescription);

      // Step 4c: License detection and enforcement
      const resolvedLicense = await resolveLicenseStep(absolutePath, options);

      // Step 4d: Data provenance
      await collectProvenance(absolutePath, options, resolvedLicense);

      // Step 4e: Show plan (resume banner or fresh) and honor --dry-run
      const planResult = showUploadPlan(absolutePath, datasetName, manifest, options);
      if (planResult.status === "stop") return;
      const { existingConfig } = planResult.value;

      // Step 4f: Deposit attestation (contributor terms, #1077). After the
      // --dry-run exit so previews never prompt; before the final confirm so
      // declining costs nothing. --yes does not satisfy it (see attestation.ts).
      let attestation: DepositAttestation;
      try {
        attestation = await resolveAttestation(options);
      } catch (attestErr) {
        console.log(chalk.red(attestErr instanceof Error ? attestErr.message : String(attestErr)));
        process.exit(1);
      }

      // Step 5: Confirm with user
      const confirmResult = await confirm(
        "Proceed with upload?",
        { yes: options.yes, no: options.no },
        true,
      );
      if (confirmResult !== "confirmed") {
        console.log(confirmResult === "declined" ? "Upload skipped." : "Upload cancelled.");
        return;
      }

      console.log();

      // Identifier preflight, again, right before the first byte goes: the steps since the first
      // screen take as long as a person likes and some write into the tree, so what is recorded
      // and sent is the tree as it is now. Only a dry run gets no record, and it returned at the
      // plan; a null here is a bug, and it stops the upload rather than sending unscreened files.
      if (identifierPreflight === null) {
        console.log(chalk.red("Identifier preflight: no record to send. Nothing was sent."));
        process.exit(1);
      }
      // The planned dates are set now, after the confirmation and before the second screen, which
      // reads the files as they are: a file left as it was keeps its date, and that screen warns.
      const dates = applyUploadDates(absolutePath, datePlan);
      for (const file of manifest.files) {
        const mtimeMs = dates.mtimes.get(file.path);
        if (mtimeMs !== undefined) file.mtimeMs = mtimeMs;
      }
      const rechecked = await recheckIdentifierPreflight(absolutePath, identifierPreflight);
      if (rechecked.status === "fail") process.exit(1);

      const { dataFiles, uploadProgress: loadedProgress } = prepareUploadProgress(
        absolutePath,
        manifest,
        options,
      );

      // Step 6: Create new dataset or resume the existing one
      const created = await createOrResumeDataset(
        absolutePath,
        options,
        datasetName,
        dataFiles,
        existingConfig,
        attestation,
        rechecked.value,
      );
      if (created.status === "fail") process.exit(1);
      const datasetInfo = created.value;

      let uploadProgress = reconcileProgressWithDataset(
        absolutePath,
        loadedProgress,
        datasetInfo.dataset_id,
      );

      // Compute the upload list AFTER reconcile: stale progress discarded above
      // must not keep filtering the list (#884).
      const filesToUpload = computeFilesToUpload(uploadProgress, dataFiles);

      // Step 6b: Accept GitHub invitation
      if ((await acceptRepoInvitation(datasetInfo)).status === "fail") process.exit(1);

      // Step 7: Initialize git-annex dataset
      // Use NEMAR user identity for all commits (including initial dataset creation)
      const author =
        config.username && config.email
          ? { name: config.username, email: config.email }
          : undefined;
      if ((await initializeAnnexDataset(absolutePath, author)).status === "fail") process.exit(1);

      // Step 8: Configure GitHub remote + ensure local branch is "main"
      if ((await configureRemotes(absolutePath, datasetInfo, options)).status === "fail") {
        process.exit(1);
      }

      // Steps 9 to 11: copy the data to S3, write the NEMAR metadata, save
      const dataSteps = await runDataSteps({
        absolutePath,
        options,
        dataFiles,
        filesToUpload,
        uploadProgress,
        datasetInfo,
        coAuthorEnrichment,
        author,
      });
      if (dataSteps.status === "fail") process.exit(1);
      uploadProgress = dataSteps.value;

      // Step 12: Push metadata to GitHub
      if ((await pushMetadata(absolutePath, uploadProgress)).status === "fail") process.exit(1);

      // Step 12b: Deploy BIDS validation CI
      const ciOutcome = await deployCiStep(absolutePath, datasetInfo.dataset_id, uploadProgress);

      // Step 13: Success!
      printUploadSuccess(absolutePath, datasetInfo, ciOutcome);
    });
}

datasetCommand.addCommand(createUploadCommand());

function formatProgressBar(
  filesDown: number,
  filesTotal: number,
  bytesDown: number,
  bytesTotal: number,
): string {
  const percent = Math.round((filesDown / filesTotal) * 100);
  const width = 20;
  const filled = Math.round((percent / 100) * width);
  const bar = `[${"=".repeat(filled)}${" ".repeat(width - filled)}]`;
  return `${bar} ${percent}% | ${filesDown}/${filesTotal} files | ${formatBytesCli(bytesDown)} / ${formatBytesCli(bytesTotal)}`;
}

/**
 * Handle download of an OpenNeuro dataset (ds######).
 * Downloads directly from OpenNeuro's public S3 bucket.
 * Primary: AWS CLI (fast). Fallback: direct HTTPS (slower, no extra deps).
 */
/**
 * Fetch read-only S3 download credentials for a private dataset, or undefined
 * for a public one (which needs none). Shared by the download and clone
 * commands (#190). On failure it prints the auth-guidance and exits — neither
 * command can proceed without credentials. Spinner text/messages match the
 * prior inline blocks exactly. (The `get` command keeps its own flow: it does
 * an auth check before fetching.)
 */
async function fetchPrivateDatasetCreds(
  datasetId: string,
  visibility: string,
): Promise<ReturnType<typeof toS3Credentials> | undefined> {
  if (visibility === "public") return undefined;
  const spinner = ora("Requesting download credentials...").start();
  try {
    const creds = await requestDownloadCredentials(datasetId);
    spinner.succeed("Download credentials received (2h expiry)");
    return toS3Credentials(creds.credentials);
  } catch (error) {
    spinner.fail("Failed to get download credentials");
    console.log(chalk.red(`  ${(error as Error).message}`));
    console.log(
      chalk.dim("Private datasets require authentication. Run 'nemar auth login' first."),
    );
    process.exit(1);
  }
}

async function handleOpenNeuroDownload(
  datasetId: string,
  // `verify?: boolean` mirrors runHttpDownload's option: `--no-verify` is a
  // documented no-op here too, since this path already checks size only
  // (AWS CLI sync, or the shared size-verified pool in lib/file-download.ts)
  // and never computes a checksum for OpenNeuro's files.
  options: { output?: string; jobs?: string; data?: boolean; verify?: boolean },
): Promise<void> {
  // Warning: no version control
  console.log();
  console.log(chalk.yellow("OpenNeuro Dataset"));
  console.log(
    chalk.yellow(
      "This dataset will be downloaded as plain files from OpenNeuro's public S3 bucket.",
    ),
  );
  console.log(
    chalk.yellow(
      "Unlike NEMAR datasets, there is no git-annex version tracking or selective file download.",
    ),
  );
  console.log(chalk.dim("For full version control, use DataLad directly:"));
  console.log(chalk.dim(`  datalad install https://github.com/OpenNeuroDatasets/${datasetId}`));
  console.log();

  if (options.data === false) {
    console.log(
      chalk.yellow(
        "Note: --no-data is not supported for OpenNeuro downloads. Downloading all files.",
      ),
    );
    console.log();
  }

  if (options.verify === false) {
    console.error(
      chalk.dim(
        "Note: --no-verify has no effect here; OpenNeuro downloads already check size only " +
          "and have no checksum step to skip.",
      ),
    );
  }

  const outputPath = options.output || datasetId;
  const absoluteOutput = resolve(outputPath);

  if (existsSync(absoluteOutput)) {
    console.log(chalk.red(`Error: Output path already exists: ${absoluteOutput}`));
    console.log("Remove or rename the existing directory and try again.");
    process.exit(1);
  }

  // Check AWS CLI once and pass the result through to avoid spawning twice
  const hasAwsCli = await isAwsCliAvailable();

  const checkSpinner = ora(`Checking OpenNeuro for ${datasetId}...`).start();
  let exists: boolean;
  try {
    exists = await openNeuroDatasetExists(datasetId, hasAwsCli);
  } catch (err) {
    checkSpinner.fail(`Could not reach OpenNeuro: ${(err as Error).message}`);
    process.exit(1);
  }
  if (!exists) {
    checkSpinner.fail(`Dataset ${datasetId} not found on OpenNeuro`);
    process.exit(1);
  }
  checkSpinner.succeed(`Found ${datasetId} on OpenNeuro`);

  if (hasAwsCli) {
    // Primary path: AWS CLI
    console.log();
    console.log(chalk.bold("Download Plan:"));
    console.log(`  Dataset: ${datasetId} (OpenNeuro)`);
    console.log(`  Output:  ${absoluteOutput}`);
    console.log("  Method:  AWS CLI (aws s3 sync)");
    console.log();

    console.log(chalk.bold("Downloading data files..."));

    const result = await downloadWithAwsCli(datasetId, absoluteOutput, (count) => {
      process.stderr.write(`\r${chalk.cyan(`  ${count} files downloaded`)}`);
    });

    process.stderr.write(`\r${" ".repeat(40)}\r`);

    if (!result.success) {
      console.log(chalk.red(`Download failed: ${result.error}`));
      process.exit(1);
    }

    console.log(chalk.green(`Downloaded ${result.filesDownloaded} files`));
  } else {
    // Fallback path: direct HTTPS
    console.log();
    console.log(chalk.yellow("AWS CLI not found. Using direct HTTPS download."));
    console.log(chalk.yellow("This will be slower than AWS CLI. To install it:"));
    console.log(
      chalk.dim("  https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"),
    );
    console.log();

    const listSpinner = ora("Listing dataset files...").start();
    let objects: Awaited<ReturnType<typeof listOpenNeuroObjects>>;
    try {
      objects = await listOpenNeuroObjects(datasetId);
    } catch (err) {
      listSpinner.fail(`Failed to list files: ${(err as Error).message}`);
      process.exit(1);
    }

    if (objects.length === 0) {
      listSpinner.fail("No files found in dataset");
      process.exit(1);
    }

    const totalBytes = objects.reduce((sum, o) => sum + o.size, 0);
    listSpinner.succeed(`${objects.length} files (${formatBytesCli(totalBytes)})`);

    console.log(chalk.bold("Download Plan:"));
    console.log(`  Dataset: ${datasetId} (OpenNeuro)`);
    console.log(`  Output:  ${absoluteOutput}`);
    console.log("  Method:  HTTPS (direct download)");
    console.log(`  Files:   ${objects.length} (${formatBytesCli(totalBytes)})`);
    console.log();

    console.log(chalk.bold("Downloading data files..."));

    // Same ceiling as the NEMAR HTTP path, and said out loud for the same
    // reason: the pool clamps silently, so a -j the transfer will not honour
    // has to be reported rather than discovered from the progress bar.
    const requestedJobs = Number.parseInt(options.jobs || "8", 10);
    const concurrency = Math.min(requestedJobs, MAX_CONCURRENCY);
    if (requestedJobs > MAX_CONCURRENCY) {
      console.log(
        chalk.yellow(
          `Note: --jobs ${requestedJobs} capped at ${MAX_CONCURRENCY} parallel HTTP requests.`,
        ),
      );
    }
    const result = await downloadWithHttps(datasetId, absoluteOutput, objects, {
      concurrency,
      onProgress: (filesDown, filesTotal, bytesDown, bytesTotal) => {
        process.stderr.write(
          `\r${chalk.cyan(formatProgressBar(filesDown, filesTotal, bytesDown, bytesTotal))}`,
        );
      },
    });

    process.stderr.write(`\r${" ".repeat(80)}\r`);

    if (!result.success) {
      console.log(chalk.red(`\nDownload incomplete: ${result.error}`));
      if (result.filesDownloaded > 0) {
        console.log(
          chalk.yellow(
            `${result.filesDownloaded} files succeeded. Re-run to retry failed files (resume support).`,
          ),
        );
      }
      console.log(`\n  Location: ${chalk.cyan(absoluteOutput)}`);
      process.exit(1);
    }

    console.log(
      chalk.green(
        `Downloaded ${result.filesDownloaded} files (${formatBytesCli(result.totalBytes)})`,
      ),
    );
  }

  console.log();
  console.log(chalk.green.bold("Download complete!"));
  console.log();
  console.log(`  Location: ${chalk.cyan(absoluteOutput)}`);
  console.log();
}

/**
 * `nemar dataset download` over plain HTTP: no git, no git-annex, no GitHub.
 *
 * Reached by `--http`, and automatically when git-annex is missing or too old.
 * Everything it needs comes from the data plane's version listing plus one
 * manifest request; see lib/http-download.ts for why that is addressed through
 * the configured API origin rather than data.nemar.org.
 *
 * The git-annex-only flags are refused rather than ignored. `--update` and
 * `--prune` reconcile a clone against its remote, and there is no clone here;
 * silently doing nothing would look like success and leave stale files in
 * place. `--resume` is refused for a sharper reason: on the annex path it runs
 * a set of checks this path cannot make (the target is a clone of THIS dataset,
 * the tree is clean, it is not behind upstream), so accepting the flag would
 * imply guarantees that do not hold. Resuming needs no flag here anyway.
 */
async function runHttpDownload(
  datasetId: string,
  options: {
    output?: string;
    jobs?: string;
    data?: boolean;
    update?: boolean;
    prune?: boolean;
    resume?: boolean;
    requireComplete?: boolean;
    /**
     * `--no-verify` negated to `options.verify === false` (Commander's
     * `--no-` convention). Unlike the git-annex path, this is a documented
     * no-op here: `downloadEntries`/`downloadFiles` already check size only
     * and never compute a checksum (ADR 0062), so there is no verification
     * step to skip. Accepted rather than refused so the flag works "regardless
     * of transport" (#1523) -- a script that always passes --no-verify must
     * not break on the run where git-annex happens to be missing.
     */
    verify?: boolean;
  },
  filter: BidsFilterResult,
): Promise<void> {
  for (const [flag, set, why] of [
    ["--update", options.update, "reconciles a clone against its remote"],
    ["--prune", options.prune, "reconciles a clone against its remote"],
    ["--resume", options.resume, "runs clone checks this path cannot make"],
  ] as const) {
    if (set) {
      console.log(chalk.red(`Error: ${flag} needs a git-annex clone (it ${why}).`));
      if (flag === "--resume") {
        console.log(
          chalk.dim("  An HTTP download always resumes: re-run the same command and any file"),
        );
        console.log(chalk.dim("  already present at its declared size is skipped."));
      } else {
        console.log(chalk.dim("  Install git-annex, or re-download into a fresh directory."));
      }
      process.exit(1);
    }
  }

  if (options.verify === false) {
    console.error(
      chalk.dim(
        "Note: --no-verify has no effect here; an HTTP download already checks size only " +
          "and has no checksum step to skip.",
      ),
    );
  }

  const jobs = Number.parseInt(options.jobs || "4", 10);
  if (Number.isNaN(jobs) || jobs < 1) {
    console.log(chalk.red(`Error: --jobs must be a positive integer (got "${options.jobs}").`));
    process.exit(1);
  }
  const concurrency = Math.min(jobs, MAX_CONCURRENCY);
  if (jobs > MAX_CONCURRENCY) {
    console.log(
      chalk.yellow(`Note: --jobs ${jobs} capped at ${MAX_CONCURRENCY} parallel HTTP requests.`),
    );
  }

  const outputPath = options.output || datasetId;
  const absoluteOutput = resolve(outputPath);

  const spinner = ora("Reading the published file list...").start();
  let entries: DataPlaneManifestEntry[];
  let version: string;
  try {
    version = (await fetchVersions(datasetId)).latest;
    entries = await fetchManifest(datasetId, version);
  } catch (error) {
    spinner.fail("Could not read the file list");
    if (error instanceof DataPlaneUnavailableError) {
      console.log(chalk.red(`  ${error.message}`));
      process.exit(1);
    }
    throw error;
  }
  spinner.succeed(`${version}: ${entries.length} files published`);

  // What is already in the target directory decides whether writing into it is
  // safe at all. See inspectOutputDir for why each of these corrupts silently.
  const conflict = inspectOutputDir(absoluteOutput, datasetId, version);
  if (conflict) {
    console.log();
    if (conflict.kind === "git-repo") {
      console.log(chalk.red(`Error: ${absoluteOutput} is a git repository.`));
      console.log(
        chalk.dim("  Writing plain files into a git-annex clone corrupts its object store."),
      );
      console.log(chalk.dim("  Use a different -o directory, or 'nemar dataset get' in place."));
    } else if (conflict.kind === "other-dataset") {
      console.log(
        chalk.red(`Error: ${absoluteOutput} already holds dataset ${conflict.datasetId}.`),
      );
      console.log(chalk.dim("  Downloading a second dataset on top of it would merge the two."));
    } else {
      console.log(chalk.red(`Error: ${absoluteOutput} holds ${datasetId} ${conflict.version}.`));
      console.log(
        chalk.dim(
          `  Resuming into it would mix ${conflict.version} and ${version}: files whose size is`,
        ),
      );
      console.log(
        chalk.dim(
          "  unchanged between versions are skipped, including dataset_description.json, so",
        ),
      );
      console.log(chalk.dim("  the tree would misreport its own version. Use a fresh directory."));
    }
    process.exit(1);
  }

  const selected = selectEntries(entries, filter, { metadataOnly: options.data === false });
  const totalBytes = selected.reduce((sum, entry) => sum + entry.size, 0);

  if (selected.length === 0) {
    // Separate "your filters matched nothing" from "the manifest listed
    // nothing": blaming filters the user did not pass sends them to debug the
    // wrong thing.
    console.log(
      chalk.yellow(
        filter.active || options.data === false
          ? "Nothing matched the requested filters; nothing to download."
          : `${datasetId} ${version} lists no files; nothing to download.`,
      ),
    );
    if (options.requireComplete) process.exit(1);
    return;
  }

  console.log();
  console.log(chalk.bold("Download plan:"));
  console.log(`  Dataset: ${chalk.cyan(datasetId)} ${chalk.dim(version)}`);
  console.log(`  Output:  ${absoluteOutput}`);
  console.log(`  Method:  HTTP (no git-annex), ${concurrency} parallel`);
  console.log(`  Files:   ${selected.length} (${formatBytesCli(totalBytes)})`);
  for (const line of filter.summary) {
    console.log(chalk.dim(`  ${line}`));
  }
  if (options.data === false) {
    console.log(chalk.dim("  metadata only (--no-data)"));
  }
  console.log();

  const result = await downloadEntries(selected, absoluteOutput, {
    concurrency,
    onProgress: (filesDone, filesTotal, bytesDone) => {
      process.stderr.write(
        `\r${chalk.cyan(formatProgressBar(filesDone, filesTotal, bytesDone, totalBytes))}`,
      );
    },
  });
  process.stderr.write(`\r${" ".repeat(80)}\r`);

  // Stamp before reporting: a partial tree still has an identity, and the next
  // run has to be able to tell which version it holds.
  writeSnapshotStamp(absoluteOutput, datasetId, version);

  if (result.errors.length > 0) {
    const fetched = result.filesDownloaded + result.filesSkipped;
    console.log(
      chalk.yellow(
        `Downloaded ${fetched} of ${selected.length} files; ${result.errors.length} failed:`,
      ),
    );
    for (const message of result.errors.slice(0, 10)) {
      console.log(chalk.red(`  ${message}`));
    }
    const listPath = writeFailureList(absoluteOutput, result.errors);
    if (result.errors.length > 10) {
      console.log(
        chalk.dim(
          listPath
            ? `  ... and ${result.errors.length - 10} more; the full list is at ${listPath}`
            : `  ... and ${result.errors.length - 10} more`,
        ),
      );
    }
    console.log(chalk.dim("  Re-run the same command to retry only the missing files."));
  } else {
    console.log(
      chalk.green(
        `Downloaded ${result.filesDownloaded} files (${formatBytesCli(result.bytesDownloaded)})${result.filesSkipped > 0 ? `, ${result.filesSkipped} already present` : ""}`,
      ),
    );
  }

  console.log();
  console.log(`  Location: ${chalk.cyan(absoluteOutput)}`);
  printSnapshotCaveat(absoluteOutput);
  console.log();

  // ADR 0005 separates "the archive does not have it" -- reportable, still a
  // successful run -- from a transport, auth or disk fault, which is a failed
  // run whatever the tallies say. The git-annex path draws the same line in
  // classifyGetOutcome. Exiting 0 after a dropped connection is what turns
  // `download && analyze` into an analysis of half a dataset.
  if (result.hadInfrastructureFailure || (result.errors.length > 0 && options.requireComplete)) {
    process.exit(1);
  }
}

// Download command. Built by a factory rather than attached inline because
// `nemar download` registers a SECOND instance of it at the root (a Command
// belongs to exactly one parent), and the two must not drift.
export function createDownloadCommand(): Command {
  return new Command("download")
    .description("Download a dataset from NEMAR or OpenNeuro")
    .argument("<dataset-id>", "Dataset ID (e.g., nm000104 or OpenNeuro ds000248)")
    .option("-o, --output <path>", "Output directory (default: ./<dataset-id>)")
    .option("-j, --jobs <number>", "Parallel download streams (default: 4)", "4")
    .option("--no-data", "Download metadata only (skip large data files)")
    .option("--resume", "Resume a partial download into an existing clone")
    .option("--update", "Pull only the version diff into an existing clone")
    .option("--prune", "With --update, drop annex objects that no longer exist upstream")
    .option("--subjects <list>", "Comma-separated subjects (e.g. sub-01,02)")
    .option("--sessions <list>", "Comma-separated sessions (e.g. ses-pre,post)")
    .option("--tasks <list>", "Comma-separated tasks (e.g. rest,nback)")
    .option("--runs <list>", "Comma-separated runs (e.g. 1,2 — matches run-1 and run-01)")
    .option("--datatypes <list>", "Comma-separated BIDS datatypes (e.g. eeg,emg)")
    .option("--include <globs>", "Comma-separated extra include globs")
    .option("--exclude <globs>", "Comma-separated exclude globs (e.g. sourcedata/**)")
    .option("--stimuli", "Include stimuli/ content (skipped by default; can be large)")
    .option("--derivatives", "Include derivatives/ content (skipped by default; can be large)")
    .option(
      "--http",
      "Download over plain HTTP without git or git-annex (a file snapshot, not a repository)",
    )
    .option(
      "--skip-port-check",
      "Skip the porting-in-progress check (use if falsely blocked on an OpenNeuro-sourced dataset)",
    )
    .option(
      "--require-complete",
      "Exit non-zero if any file is unavailable from the archive (for strict pipelines)",
    )
    .option(
      "--no-verify",
      "Skip git-annex checksum verification for this run only (size is still checked); " +
        "a documented no-op on --http or OpenNeuro downloads, which already check size only",
    )
    .addHelpText(
      "after",
      ({ command }) => `
Description:
  Download a BIDS dataset from NEMAR or OpenNeuro.

  NEMAR datasets (nm/on prefix) use git-annex for efficient data transfer
  with parallel streams and version tracking.

  OpenNeuro datasets (ds prefix) are downloaded as plain files from
  OpenNeuro's public S3 bucket. No account or git-annex required.

  For NEMAR datasets, content under stimuli/ and derivatives/ is skipped by
  default because these folders can be very large. The git-annex pointers
  are still cloned, so you can fetch them later with 'nemar dataset get
  --stimuli' or 'nemar dataset get --derivatives' from inside the dataset
  directory. (OpenNeuro datasets ignore these flags; the full tree is
  always downloaded.)

Requirements:
  - git-annex installed (NEMAR datasets only), or --http for a file snapshot
  - NEMAR account (for private datasets)
  - AWS CLI recommended for OpenNeuro downloads (falls back to HTTPS)

Without git-annex:
  --http downloads over plain HTTP with no git, git-annex or GitHub account,
  and is used automatically when git-annex is missing. It honors the same
  filters and writes the same BIDS tree, but the result is a file snapshot,
  not a repository: 'commit', 'push' and 'update' need a git-annex clone.
  Re-running resumes, since a file already present at its declared size is
  skipped.

Verification:
  By default every file is checksum-verified against its git-annex key as it
  arrives. --no-verify skips that hash for this run only (never written to
  git config); size is still checked, so a truncated or wrong-size file is
  still rejected, but wrong content at the right size is not caught. Use it
  only over a trusted link, to save the CPU time hashing costs on a large
  dataset. It is a documented no-op on --http and OpenNeuro downloads, which
  already verify by size alone and have no checksum step to skip.

Examples:
  $ ${invokedAs(command)} nm000104              # Download NEMAR dataset (skips stimuli/derivatives)
  $ ${invokedAs(command)} nm000104 -o ./data    # Custom output directory
  $ ${invokedAs(command)} nm000104 --no-data    # Metadata only (fast)
  $ ${invokedAs(command)} nm000104 -j 8         # More parallel streams
  $ ${invokedAs(command)} nm000104 --resume     # Resume partial download
  $ ${invokedAs(command)} nm000104 --update     # Pull only the version diff
  $ ${invokedAs(command)} nm000104 --update --prune  # Plus drop orphan objects
  $ ${invokedAs(command)} nm000104 --http       # No git-annex needed (snapshot)
  $ ${invokedAs(command)} nm000104 --no-verify  # Skip checksum verification (size still checked)
  $ ${invokedAs(command)} nm000104 --subjects sub-01,02      # Only these subjects
  $ ${invokedAs(command)} nm000104 --tasks rest --datatypes eeg  # Subset
  $ ${invokedAs(command)} nm000104 --stimuli                 # Also download stimuli/
  $ ${invokedAs(command)} nm000104 --stimuli --derivatives   # Download everything
  $ ${invokedAs(command)} ds000248              # Download from OpenNeuro`,
    )
    .action(async (datasetId, options) => {
      // OpenNeuro datasets (ds######) - check for NEMAR counterpart first
      const effectiveId = await resolveOpenNeuroId(datasetId);
      if (!effectiveId) {
        await handleOpenNeuroDownload(datasetId, options);
        return;
      }

      if (options.resume && options.update) {
        console.log(chalk.red("Error: --resume and --update are mutually exclusive."));
        process.exit(1);
      }
      if (options.prune && !options.update) {
        console.log(chalk.red("Error: --prune requires --update."));
        process.exit(1);
      }

      // Commander's `--no-verify` negates an implicit `verify` default of
      // true, the same pattern `--no-data` uses above: `options.verify` is
      // `undefined` unless the flag was passed, in which case it is `false`.
      const noVerify = options.verify === false;

      const filter = buildBidsFilterArgs({
        subjects: options.subjects,
        sessions: options.sessions,
        tasks: options.tasks,
        runs: options.runs,
        datatypes: options.datatypes,
        include: options.include,
        exclude: options.exclude,
        excludeStimuli: options.stimuli !== true,
        excludeDerivatives: options.derivatives !== true,
      });

      if (filter.active && options.data === false) {
        console.log(
          chalk.red(
            "Error: --no-data cannot be combined with BIDS filters (--subjects, --tasks, etc.). Filters imply data download.",
          ),
        );
        process.exit(1);
      }

      // --http is decided BEFORE any prerequisite check, because the checks are
      // the thing it exists to skip. `COMMAND_TOOLS.download` requires the GitHub
      // CLI, and this path needs no git, no git-annex and no GitHub account --
      // demanding `gh` on a container or a login node would deny the flag on
      // exactly the machines it was built for.
      if (options.http) {
        await runHttpDownload(effectiveId, options, filter);
        return;
      }

      // Step 1: Check prerequisites (fast, parallel checks)
      await checkPrerequisitesForCommand("download");

      let spinner = ora("Checking git-annex...").start();
      const prereqs = await checkDownloadPrerequisites();

      // Fall back rather than exit. A missing git-annex used to be a hard stop,
      // which is a poor answer to "I just want the files" when the data plane
      // already serves every byte over plain HTTPS. The fallback is announced
      // rather than silent: it produces a snapshot, not a repository, and someone
      // who wanted a repository has to learn that they did not get one.
      if (!prereqs.allPassed) {
        // The headline reports what actually failed. `checkDownloadPrerequisites`
        // also fails a git-annex that is installed but too old, and telling that
        // user it is "not available" sends them to install what they already have.
        spinner.warn(
          prereqs.gitAnnex.installed
            ? `git-annex ${prereqs.gitAnnex.version} is not usable here`
            : "git-annex is not installed",
        );
        for (const error of prereqs.errors) {
          console.log(chalk.dim(`  ${error}`));
        }
        console.log(chalk.yellow("  Falling back to a plain HTTP download (a file snapshot)."));
        console.log(
          chalk.dim("  Pass --http to choose this path deliberately and skip this notice."),
        );
        console.log();
        await runHttpDownload(effectiveId, options, filter);
        return;
      }

      spinner.succeed(`git-annex ${prereqs.gitAnnex.version}`);

      // Step 2: Get dataset info from backend
      spinner = ora(`Fetching dataset info for ${effectiveId}...`).start();

      let datasetInfo: Dataset;
      try {
        datasetInfo = await getDataset(effectiveId);
        spinner.succeed(`Found dataset: ${datasetInfo.name}`);
      } catch (error) {
        // Branch on the error KIND. This used to say "Dataset not found" for anything
        // that threw, so an unreachable backend was reported as a 404: the CLI
        // asserting a fact about the dataset from a request that never got an answer.
        // Surfaced while fencing the test suite off from production -- the surviving
        // output under a connection failure was "Dataset not found" immediately
        // followed by "Network error: Could not connect".
        spinner.fail(datasetLookupFailure(error));
        if (error instanceof ApiError) {
          console.log(chalk.red(`  ${error.message}`));
        } else {
          console.log(chalk.red(`  ${(error as Error).message}`));
        }
        process.exit(1);
      }

      // Step 3: Check if dataset is accessible
      if (!datasetInfo.github_repo) {
        console.log(chalk.red("Error: Dataset repository not available"));
        process.exit(1);
      }

      // Determine output path
      const outputPath = options.output || effectiveId;
      const absoluteOutput = resolve(outputPath);

      // Paths to fetch with `git annex get`. Undefined → full retrieval. Used by
      // --update to limit the get to changed annex keys.
      let updatePaths: string[] | undefined;

      // Resume / update modes share validation: target must exist, be a git-annex
      // clone of the requested dataset, with a clean working tree.
      const reuseMode = options.resume ? "resume" : options.update ? "update" : null;

      if (reuseMode) {
        if (!existsSync(absoluteOutput)) {
          console.log(chalk.red(`Error: --${reuseMode} target does not exist: ${absoluteOutput}`));
          console.log(chalk.dim(`Drop --${reuseMode} to perform a fresh clone.`));
          process.exit(1);
        }

        spinner = ora(`Validating ${reuseMode} target...`).start();

        if (!(await isGitAnnexDataset(absoluteOutput))) {
          spinner.fail("Not a git-annex dataset");
          console.log(chalk.red(`  ${absoluteOutput} is not a git-annex repository.`));
          console.log(chalk.dim(`--${reuseMode} requires a previous clone of the same dataset.`));
          process.exit(1);
        }

        const existingId = await getDatasetIdFromRemote(absoluteOutput);
        if (existingId !== effectiveId) {
          spinner.fail("Dataset ID mismatch");
          console.log(
            chalk.red(
              `  Expected ${effectiveId}, but ${absoluteOutput} is a clone of ${existingId ?? "an unknown repo"}.`,
            ),
          );
          process.exit(1);
        }

        const dirtyCheck = await isWorkingTreeDirty(absoluteOutput);
        if (dirtyCheck.error) {
          spinner.fail("Could not check working tree status");
          console.log(chalk.red(`  ${dirtyCheck.error}`));
          process.exit(1);
        }
        if (dirtyCheck.dirty) {
          spinner.fail("Working tree is dirty");
          console.log(chalk.red(`  Refusing to ${reuseMode} with uncommitted local changes.`));
          console.log(chalk.dim("  Commit, stash, or discard them first."));
          process.exit(1);
        }

        // Refresh remote refs so we can compare versions and (for update) merge.
        const fetchResult = await gitFetchOrigin(absoluteOutput);
        if (!fetchResult.success) {
          spinner.fail("Failed to fetch remote refs");
          console.log(chalk.red(`  ${fetchResult.error}`));
          process.exit(1);
        }

        const localRead = readLocalDatasetVersion(absoluteOutput);
        if (localRead.error) {
          console.log(chalk.yellow(`  Warning: ${localRead.error}`));
        }
        const remoteRead = await readRemoteHeadDatasetVersion(absoluteOutput);
        for (const w of remoteRead.warnings) {
          console.log(chalk.yellow(`  Warning: ${w}`));
        }
        const localVersion = localRead.version;
        const remoteVersion = remoteRead.version;

        if (options.resume) {
          if (localVersion && remoteVersion && localVersion !== remoteVersion) {
            spinner.fail("Local clone is behind upstream");
            console.log(
              chalk.red(`  Local version: ${localVersion} | Remote HEAD: ${remoteVersion}`),
            );
            console.log(
              chalk.dim("  Run `nemar dataset download <id> --update` to pull the version diff."),
            );
            process.exit(1);
          }
          spinner.succeed(`Resume target verified: ${effectiveId}`);
        } else {
          // --update path
          if (localVersion && remoteVersion && localVersion === remoteVersion) {
            spinner.succeed(`Already up to date (${localVersion})`);
            process.exit(0);
          }
          spinner.succeed(`Update plan: ${localVersion ?? "unknown"} → ${remoteVersion ?? "HEAD"}`);

          if (localVersion && remoteVersion) {
            spinner = ora("Computing version diff from manifests...").start();
            try {
              const [fromManifest, toManifest] = await Promise.all([
                getManifest(effectiveId, localVersion),
                getManifest(effectiveId, remoteVersion),
              ]);
              const diff = diffManifests(fromManifest, toManifest);
              spinner.succeed(
                `Diff: +${diff.added.length} added, ~${diff.changed.length} changed, -${diff.removed.length} removed`,
              );
              updatePaths = [...diff.added, ...diff.changed];
              if (updatePaths.length === 0) {
                console.log(
                  chalk.dim("  No annex content changes between versions; metadata-only update."),
                );
              }
            } catch (err) {
              const message = (err as Error).message;
              spinner.warn(`Manifest diff unavailable: ${message}`);
              if (/401|403|unauthor/i.test(message)) {
                console.log(
                  chalk.yellow("  Looks like an auth issue. Run `nemar auth status` to verify."),
                );
              } else if (!/404|not found/i.test(message)) {
                console.log(
                  chalk.yellow("  Unexpected manifest error. Please report if this recurs."),
                );
              }
              console.log(
                chalk.dim("  Falling back to full git annex get (skips already-present files)."),
              );
              updatePaths = undefined;
            }
          }

          // Refuse on git-annex adjusted branches: a normal git merge corrupts
          // the adjusted view. Users on adjusted clones should run `git annex
          // sync` (or rename their default branch) before --update.
          const localBranch = await getCurrentBranch(absoluteOutput);
          if (localBranch?.startsWith("adjusted/")) {
            console.log(
              chalk.red(
                `  --update is not supported on git-annex adjusted branches (${localBranch}).`,
              ),
            );
            console.log(
              chalk.dim(
                "  Run `git -C <clone> annex sync` to bring the clone onto a normal branch first.",
              ),
            );
            process.exit(1);
          }

          spinner = ora("Resolving remote tracking branch...").start();
          const upstreamRef = await resolveUpstreamRef(absoluteOutput);
          if (!upstreamRef.ref) {
            spinner.fail("Cannot resolve remote tracking branch");
            console.log(chalk.red(`  ${upstreamRef.error ?? "no upstream ref found"}`));
            process.exit(1);
          }
          spinner.text = `Fast-forwarding to ${upstreamRef.ref}...`;
          const mergeResult = await gitMergeFastForward(absoluteOutput, upstreamRef.ref);
          if (!mergeResult.success) {
            spinner.fail("Cannot fast-forward (local has diverging commits)");
            console.log(chalk.red(`  ${mergeResult.error}`));
            console.log(
              chalk.dim("  Use `nemar dataset update` (PR workflow) to push local changes first."),
            );
            process.exit(1);
          }
          spinner.succeed(`Merged ${upstreamRef.ref}`);
        }
      } else if (existsSync(absoluteOutput)) {
        console.log(chalk.red(`Error: Output path already exists: ${absoluteOutput}`));
        console.log(
          "Remove or rename the existing directory, or pass --resume / --update to reuse it.",
        );
        process.exit(1);
      }

      console.log();
      const planLabel = options.update
        ? "Update Plan:"
        : options.resume
          ? "Resume Plan:"
          : "Download Plan:";
      console.log(chalk.bold(planLabel));
      console.log(`  Dataset: ${datasetInfo.name} (${effectiveId})`);
      console.log(`  Output: ${absoluteOutput}`);
      console.log(`  Data files: ${options.data === false ? "metadata only" : "included"}`);
      if (options.data !== false) {
        console.log(`  Parallel jobs: ${options.jobs}`);
      }
      if (options.update && updatePaths && updatePaths.length > 0) {
        console.log(`  Files to fetch: ${updatePaths.length}`);
      }
      if (filter.active) {
        for (const line of filter.summary) {
          console.log(`  Filter ${line}`);
        }
      }
      console.log();

      // Step 4: Clone the dataset (metadata) — skipped on resume / update.
      if (!reuseMode) {
        const repoUrl = `https://github.com/${datasetInfo.github_repo}.git`;
        spinner = ora("Cloning metadata from GitHub...").start();

        const cloneResult = await cloneDataset(repoUrl, absoluteOutput);
        if (!cloneResult.success) {
          spinner.fail("Failed to clone dataset");
          console.log(chalk.red(`  ${cloneResult.error}`));
          process.exit(1);
        }

        spinner.succeed("Metadata cloned");
      }

      // OpenNeuro-sourced datasets only get their git-annex S3 objects after
      // the import workflow's final push (which carries the .nemar/metadata.json
      // commit). If the marker commit is missing locally, the porting matrix
      // job is still mid-flight — the subsequent `git annex get` would fail
      // with a cryptic "remote unavailable" error. Bail early with a clear
      // retry hint. See nemarOrg/nemar-cli#460.
      if (!options.skipPortCheck && datasetInfo.source === "openneuro" && options.data !== false) {
        const marker = await detectImportMarker(absoluteOutput);
        // "unknown" = git unavailable or non-git dir; skip port check and let git-annex handle it
        if (marker === "absent") {
          console.log();
          console.log(chalk.yellow("Porting still in progress."));
          console.log(
            chalk.dim(
              "  This dataset is being imported from OpenNeuro. Data files are not yet available.",
            ),
          );
          console.log(chalk.dim("  The metadata-only clone is already at the path above."));
          console.log(chalk.dim("  Wait 5–30 minutes (depending on dataset size), then run:"));
          console.log(chalk.dim(`    cd ${absoluteOutput} && nemar dataset get`));
          console.log(chalk.dim("  Run 'nemar dataset status <id>' to track porting progress."));
          console.log(
            chalk.dim(
              "  Pass --skip-port-check to bypass this check if you are certain porting is complete.",
            ),
          );
          process.exit(1);
        }
      }

      // For private datasets, fetch temporary S3 download credentials.
      const s3Creds = await fetchPrivateDatasetCreds(effectiveId, datasetInfo.visibility);

      // Enable S3 remote if available (new datasets have it; old ones use web URLs)
      const s3Enable = await enableS3Remote(absoluteOutput, "nemar-s3", s3Creds);
      if (s3Enable.enabled) {
        console.log(chalk.dim("  S3 remote enabled for data downloads"));
      } else if (!s3Enable.success) {
        console.log(chalk.yellow(`  Warning: Could not enable S3 remote: ${s3Enable.error}`));
      }

      // Step 5: Get data files with progress (unless --no-data)
      const skipGet =
        options.data === false || (options.update && updatePaths && updatePaths.length === 0);
      if (skipGet) {
        if (options.data === false) {
          console.log(chalk.dim("Skipping data files (--no-data flag)"));
        }
      } else {
        for (const line of filter.summary) {
          console.log(chalk.dim(`  ${line}`));
        }
        console.log(chalk.bold(`Downloading data files (${options.jobs} parallel streams)...`));

        // Pre-count pending files+bytes so the progress bar has an authoritative
        // denominator. Falls back to non-percent display if precount fails.
        const matchArgs = filter.args.length > 0 ? filter.args : undefined;
        const pending = await countPendingDownload(absoluteOutput, undefined, matchArgs);
        const tracker = new DownloadProgressTracker(
          pending?.fileCount ?? 0,
          pending?.totalBytes ?? 0,
        );

        const getResult = await getDatasetData(absoluteOutput, {
          jobs: Number.parseInt(options.jobs, 10),
          credentials: s3Creds,
          paths: updatePaths,
          extraArgs: matchArgs,
          requireComplete: Boolean(options.requireComplete),
          noVerify,
          onProgress: (line) => tracker.processLine(line),
        });

        if (!getResult.success) {
          // Counts are honest on the failure arm too: --require-complete can
          // fail a run that still landed files, and the tracker should say so.
          tracker.finish(getResult.filesDownloaded);
          console.log(chalk.red(`Failed to download data files: ${getResult.error}`));
          console.log(
            chalk.dim("The dataset was cloned but data files are not available locally."),
          );
          console.log(
            chalk.dim(`You can try again with: cd ${absoluteOutput} && nemar dataset get`),
          );
          // Print before exiting: a no-verify mismatch is carried on every
          // outcome arm (#1525 review round 3), and this is the failure arm.
          printNoVerifyMismatches(getResult.noVerifyMismatches);
          if (s3Creds) {
            await clearAnnexCredentials(absoluteOutput);
          }
          process.exit(1);
        }

        tracker.finish(getResult.filesDownloaded);
        if (getResult.outcome === "partial") {
          printPartialRetrieval(getResult);
        } else {
          console.log(chalk.green(`Data downloaded (${getResult.filesDownloaded} files)`));
        }
        printNoVerifyMismatches(getResult.noVerifyMismatches);
        if (noVerify) printNoVerifyNotice(getResult.unsizedFiles);
      }

      // --prune: drop annex objects that are no longer referenced by any branch
      // (typically files removed in the upstream version).
      if (options.update && options.prune) {
        spinner = ora("Pruning orphan annex objects...").start();
        const pruneResult = await dropUnusedAnnexObjects(absoluteOutput);
        if (pruneResult.success) {
          spinner.succeed(`Pruned ${pruneResult.dropped ?? 0} unused annex objects`);
        } else {
          spinner.warn(`Prune skipped: ${pruneResult.error}`);
        }
      }

      // Clear cached S3 credentials so future operations request fresh tokens
      if (s3Creds) {
        await clearAnnexCredentials(absoluteOutput);
      }

      // Step 6: Show completion info
      const localInfo = await getLocalDatasetInfo(absoluteOutput);

      console.log();
      const completionLabel = options.update
        ? "Update complete!"
        : options.resume
          ? "Resume complete!"
          : "Download complete!";
      console.log(chalk.green.bold(completionLabel));
      console.log();
      console.log(`  Location: ${chalk.cyan(absoluteOutput)}`);
      if (localInfo) {
        console.log(`  Files: ${localInfo.files}`);
        if (localInfo.size !== "unknown") {
          console.log(`  Size: ${localInfo.size}`);
        }
        if (localInfo.missingFiles > 0) {
          console.log(
            chalk.dim(
              `  Missing files: ${localInfo.missingFiles} (use 'git annex get' to download)`,
            ),
          );
        }
      }
      console.log();
      if (options.update) {
        console.log(
          chalk.dim("Note: --update fetches only the version diff. If a prior version was"),
        );
        console.log(
          chalk.dim("partially downloaded, run with --resume to fill any pre-existing gaps."),
        );
        console.log();
      }
      console.log(chalk.dim("To get additional data:"));
      console.log(chalk.dim(`  cd ${absoluteOutput} && git annex get <path>`));
    });
}

datasetCommand.addCommand(createDownloadCommand());

// Status command
datasetCommand
  .command("status")
  .alias("view")
  .description("Check status of a dataset (alias: view)")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .option("--json", "Output as JSON for scripting")
  .addHelpText(
    "after",
    `
Description:
  Show detailed information about a NEMAR dataset including owner,
  creation date, GitHub repository, and DOI information.

Examples:
  $ nemar dataset status nm000104
  $ nemar dataset status nm000104 --json | jq '.concept_doi'`,
  )
  .action(async (datasetId, options) => {
    const spinner = ora(`Fetching dataset info for ${datasetId}...`).start();

    let datasetInfo: Dataset;
    try {
      datasetInfo = await getDataset(datasetId);
      spinner.stop();
    } catch (error) {
      // Same shape, same rule as `dataset clone` above: only a real 404 may be
      // called "not found".
      spinner.fail(datasetLookupFailure(error));
      if (error instanceof ApiError) {
        console.log(chalk.red(`  ${error.message}`));
      } else {
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      process.exit(1);
    }

    // JSON output
    if (options.json) {
      console.log(JSON.stringify(datasetInfo, null, 2));
      return;
    }

    // Human-readable output
    console.log();
    console.log(chalk.bold(`Dataset: ${datasetInfo.dataset_id}`));
    console.log();
    console.log(`  Name:        ${datasetInfo.name}`);
    console.log(`  Owner:       ${datasetInfo.owner_username}`);
    console.log(`  Status:      ${colorizeStatus(datasetInfo.status)}`);
    // Withdrawal is a separate axis from `status`, which stays "active", so it
    // has to be printed or the dataset reads as live. Directly under Status,
    // because that is the line a reader takes their answer from (#1048).
    if (datasetInfo.withdrawn_at) {
      const reason = datasetInfo.withdrawn_reason
        ? ` ${chalk.dim(`- ${datasetInfo.withdrawn_reason}`)}`
        : "";
      console.log(
        `  Withdrawn:   ${chalk.red(new Date(datasetInfo.withdrawn_at).toLocaleDateString())}${reason}`,
      );
    }
    // #1408: a separate axis from `status`, printed for the same reason
    // `Withdrawn:` is -- a reader who sees `public` and no authors would
    // otherwise conclude the record is incomplete rather than deliberately
    // blinded. The second line says what ends it, because that is the thing a
    // depositor actually needs to know next.
    if (datasetInfo.anonymous === 1) {
      console.log(`  Anonymous:   ${chalk.yellow("identity withheld until publication")}`);
      console.log(
        chalk.dim(
          "               Restore the real Authors in dataset_description.json," +
            " then 'nemar dataset publish request' without --anonymous.",
        ),
      );
      renderAnonymityVerdict(datasetInfo);
    }
    console.log(`  Created:     ${new Date(datasetInfo.created_at).toLocaleDateString()}`);

    if (datasetInfo.description) {
      console.log(`  Description: ${datasetInfo.description}`);
    }

    // An anonymous deposit's repository is private, so printing its URL offers
    // a link that 404s and discloses that a repo exists under a predictable
    // name. The Anonymous line above already explains the absence.
    if (datasetInfo.github_repo && datasetInfo.anonymous !== 1) {
      console.log(`  GitHub:      https://github.com/${datasetInfo.github_repo}`);
    }

    if (datasetInfo.concept_doi) {
      // A withdrawn dataset's DOI resolves to a registrar tombstone, not the
      // dataset. Printing it as a bare link invites the reader to follow it and
      // conclude the dataset is fine.
      const doiUrl = `https://doi.org/${datasetInfo.concept_doi}`;
      if (datasetInfo.anonymous === 1) {
        // An anonymous release's identifier is RESERVED: pre-registered, not
        // advertised, and it does not resolve. Printing it as a bare link is
        // the same trap the withdrawn case below avoids, and worse here -- a
        // depositor mid-submission would cite it and their reviewers would get
        // a dead link, in the one situation this feature exists to serve. The
        // citable thing is the landing page, which resolves and says why the
        // dataset has no authors.
        console.log(`  DOI:         ${chalk.dim(doiUrl)} ${chalk.yellow("(reserved)")}`);
        console.log(`  Cite:        ${datasetLandingUrl(datasetInfo.dataset_id)}`);
      } else {
        console.log(
          datasetInfo.withdrawn_at
            ? `  DOI:         ${chalk.dim(doiUrl)} ${chalk.red("(tombstoned)")}`
            : `  DOI:         ${doiUrl}`,
        );
      }
    }

    // #970: surface-but-visible -- only shout when data is verified incomplete;
    // complete/not-yet-audited stay silent (mirrors the list table's Data column).
    if (datasetInfo.data_complete === 0) {
      // A withdrawn dataset's content is 0-byte BY DESIGN, so the integrity
      // sweep has nothing to find. Pointing an operator at it here is the exact
      // false lead #1048 opened with: a withdrawal cohort read as a data loss
      // incident because every surface described it as broken rather than gone.
      console.log(
        datasetInfo.withdrawn_at
          ? `  Data:        ${chalk.dim("removed as part of the withdrawal")}`
          : `  Data:        ${chalk.red("incomplete")} ${chalk.dim("(some files failed to upload; see `nemar admin data-integrity-sweep`)")}`,
      );
    }

    console.log();
    if (datasetInfo.withdrawn_at) {
      // Offering the download hint here would send the reader after content
      // that was deliberately removed.
      console.log(chalk.dim("This dataset was withdrawn; its content is no longer available."));
    } else {
      console.log(chalk.dim("To download this dataset:"));
      console.log(chalk.dim(`  nemar dataset download ${datasetId}`));
    }
  });

/**
 * If datasetId is an OpenNeuro ds ID, check whether NEMAR has a copy and
 * prompt the user to use it. Returns the NEMAR dataset_id if accepted,
 * the original datasetId for non-OpenNeuro IDs, or null if the user
 * declined (meaning the caller should fall back to OpenNeuro download).
 */
async function resolveOpenNeuroId(datasetId: string): Promise<string | null> {
  if (!isOpenNeuroDatasetId(datasetId)) {
    return datasetId;
  }

  // Only catch network/API errors; let prompt errors (Ctrl+C) propagate
  let resolved: Awaited<ReturnType<typeof resolveSourceId>> | null = null;
  try {
    resolved = await resolveSourceId(datasetId);
  } catch (err) {
    console.log(chalk.dim(`Could not check NEMAR availability: ${(err as Error).message}`));
    return null;
  }

  if (!resolved?.found || !resolved.dataset_id) {
    return null;
  }

  console.log();
  console.log(
    chalk.green(`This dataset is available on NEMAR as ${chalk.bold(resolved.dataset_id)}`),
  );
  console.log(chalk.dim("NEMAR provides git-annex version tracking and selective file download."));

  const { useNemarBackend } = await inquirer.prompt([
    {
      type: "confirm",
      name: "useNemarBackend",
      message: `Download from NEMAR (${resolved.dataset_id}) instead of OpenNeuro?`,
      default: true,
    },
  ]);

  return useNemarBackend ? resolved.dataset_id : null;
}

/**
 * Colorize dataset status for display
 */
function colorizeStatus(status: string): string {
  switch (status.toLowerCase()) {
    case "published":
      return chalk.green(status);
    case "active":
      return chalk.blue(status);
    case "archived":
      return chalk.dim(status);
    case "pending":
      return chalk.yellow(status);
    default:
      return status;
  }
}

// Shared logic for rendering dataset tables
function renderDatasetTable(
  datasets: Dataset[],
  pagination: { limit: number; offset: number; totalCount: number },
) {
  const { offset, totalCount } = pagination;
  const pageStart = offset + 1;
  const pageEnd = offset + datasets.length;
  const pageInfo =
    totalCount > datasets.length ? `${pageStart}-${pageEnd} of ${totalCount}` : `${totalCount}`;

  console.log();
  console.log(chalk.bold(`Datasets (${pageInfo}):`));
  console.log();

  const getId = (d: Dataset) => d.dataset_id || (d as unknown as { id?: string }).id || "";
  const idWidth = Math.max(10, ...datasets.map((d) => getId(d).length));
  const nameWidth = Math.min(30, Math.max(10, ...datasets.map((d) => d.name.length)));
  const modWidth = 10;
  const subjWidth = 8;
  const ownerWidth = Math.max(8, ...datasets.map((d) => (d.owner_username || "-").length));

  const dataWidth = 10;
  const header = [
    "ID".padEnd(idWidth),
    "Name".padEnd(nameWidth),
    "Modality".padEnd(modWidth),
    "Subj".padEnd(subjWidth),
    "HED".padEnd(3),
    "Data".padEnd(dataWidth),
    "Owner".padEnd(ownerWidth),
    "Status",
  ].join("  ");
  console.log(chalk.dim(header));
  console.log(chalk.dim("-".repeat(header.length)));

  for (const dataset of datasets) {
    const id = getId(dataset);
    const name =
      dataset.name.length > nameWidth
        ? `${dataset.name.substring(0, nameWidth - 3)}...`
        : dataset.name;
    const modality = (dataset.modalities || "").substring(0, modWidth);
    const subjects = dataset.participants ? String(dataset.participants) : "-";
    const owner = dataset.owner_username || "-";

    const visLabel = dataset.visibility === "public" ? chalk.green("pub") : chalk.yellow("prv");

    let idDisplay: string;
    if (dataset.source_type === "catalog") {
      // Catalog-only: dim to indicate not on GitHub
      idDisplay = chalk.dim(id.padEnd(idWidth));
    } else {
      idDisplay = chalk.cyan(id.padEnd(idWidth));
    }

    const nameDisplay = dataset.source_type === "catalog" ? chalk.dim(name) : name;

    const row = [
      idDisplay,
      nameDisplay.padEnd(
        nameWidth + (dataset.source_type === "catalog" ? chalk.dim("").length : 0),
      ),
      modality.padEnd(modWidth),
      subjects.padEnd(subjWidth),
      // Pad the plain text BEFORE colorizing so ANSI codes don't break alignment.
      dataset.has_hed === 1 ? chalk.magenta("HED".padEnd(3)) : chalk.dim("-".padEnd(3)),
      // #970: surface-but-visible -- only flag the broken case (incomplete);
      // complete/not-yet-audited both render blank, mirroring the HED column's
      // "only shout when there's something to see" convention.
      dataset.data_complete === 0
        ? chalk.red("incomplete".padEnd(dataWidth))
        : "".padEnd(dataWidth),
      owner.padEnd(ownerWidth),
      visLabel,
    ].join("  ");
    console.log(row);
  }

  console.log();
  // Pagination footer
  if (totalCount > pageEnd) {
    const currentPage = Math.floor(offset / pagination.limit) + 1;
    const totalPages = Math.ceil(totalCount / pagination.limit);
    console.log(
      chalk.dim(
        `Page ${currentPage}/${totalPages}. Next: nemar dataset list --page ${currentPage + 1}`,
      ),
    );
  }
  console.log(
    chalk.dim(
      `  * = not synced to nemar.org    ${chalk.dim("dim")} = catalog-only (not on GitHub)`,
    ),
  );
  console.log(chalk.dim("For details: nemar dataset status <dataset-id>"));
  console.log(chalk.dim("Search: nemar dataset search <query>"));
}

/**
 * Column layout for `nemar dataset search`'s result table (epic #1144 phase
 * 6, issue #1150, D4). Derives widths from the terminal width, shrinking the
 * name column first and then dropping the least load-bearing columns (HED,
 * then Subj, then Modality) in that order before the row would otherwise
 * overflow -- but never touching `idWidth`: the id is what the user copies
 * into their next command, so it is never truncated at any width, even if
 * every other column has already been dropped and the row still overflows.
 */
export interface SearchColumnPlan {
  idWidth: number;
  nameWidth: number;
  modWidth: number;
  subjWidth: number;
  showModality: boolean;
  showSubj: boolean;
  showHed: boolean;
}

const SEARCH_MAX_NAME_WIDTH = 35;
const SEARCH_MIN_NAME_WIDTH = 8;
const SEARCH_FLOOR_NAME_WIDTH = 4;
const SEARCH_MOD_WIDTH = 10;
const SEARCH_SUBJ_WIDTH = 6;
const SEARCH_HED_WIDTH = 3;
const SEARCH_COLUMN_GAP = 2;
/** Fallback terminal width (#1150 D4): `process.stdout.columns` is
 *  `undefined` for piped/non-TTY output, which is the common case for a
 *  scripted or redirected invocation. */
export const SEARCH_DEFAULT_COLUMNS = 80;

/**
 * Plan the search table's column widths for a given terminal width. Never
 * throws (#1150 D7): a non-finite or non-positive `columns` (a terminal
 * capability probe gone wrong) falls back to {@link SEARCH_DEFAULT_COLUMNS}
 * rather than producing a degenerate or negative-width layout.
 */
export function planSearchColumns(
  results: Pick<DatasetSearchResult, "id" | "name">[],
  columns: number,
): SearchColumnPlan {
  const safeColumns =
    Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : SEARCH_DEFAULT_COLUMNS;
  const idWidth = Math.max(10, ...results.map((r) => r.id.length));
  let nameWidth = Math.min(
    SEARCH_MAX_NAME_WIDTH,
    Math.max(10, ...results.map((r) => r.name.length)),
  );
  let showModality = true;
  let showSubj = true;
  let showHed = true;

  const totalWidth = (): number => {
    let width = idWidth + SEARCH_COLUMN_GAP + nameWidth;
    if (showModality) width += SEARCH_COLUMN_GAP + SEARCH_MOD_WIDTH;
    if (showSubj) width += SEARCH_COLUMN_GAP + SEARCH_SUBJ_WIDTH;
    if (showHed) width += SEARCH_COLUMN_GAP + SEARCH_HED_WIDTH;
    return width;
  };

  while (totalWidth() > safeColumns && nameWidth > SEARCH_MIN_NAME_WIDTH) nameWidth--;
  if (totalWidth() > safeColumns && showHed) showHed = false;
  if (totalWidth() > safeColumns && showSubj) showSubj = false;
  if (totalWidth() > safeColumns && showModality) showModality = false;
  // Extremely narrow terminals: shrink further rather than drop the name
  // column entirely -- id + name is the minimum a search result is legible
  // by.
  while (totalWidth() > safeColumns && nameWidth > SEARCH_FLOOR_NAME_WIDTH) nameWidth--;

  return {
    idWidth,
    nameWidth,
    modWidth: SEARCH_MOD_WIDTH,
    subjWidth: SEARCH_SUBJ_WIDTH,
    showModality,
    showSubj,
    showHed,
  };
}

/**
 * Render `nemar dataset search`'s human-readable result table as an array
 * of lines (epic #1144 phase 6, issue #1150). No `Score` column (D1: RRF
 * score is a ranking artefact on a scale the CLI's old 0.8/0.5 thresholds
 * never matched -- row order already encodes relevance).
 *
 * The README snippet line is opt-in via `options.snippets` (owner decision
 * 2026-09-03, superseding #1150 D2's default): it was always-on under
 * #1150/#1174, but a dim snippet under every row made the table slower to
 * scan for a human and noisier for an agent caller, so the compact
 * id/name/modality/subj/hed row is the default again and `--verbose` on the
 * `search` command turns snippets back on (no `-v` short alias -- see
 * `searchVerboseRequested`'s doc comment for why). This does not touch D1
 * (Score stays dropped) or the sanitisation in `src/lib/render/snippet.ts`,
 * which still applies whenever a snippet line is rendered. When enabled, a
 * snippet line follows its row only when one comes back from the API; a row
 * without one leaves no blank line behind.
 *
 * Row CONTENT rendering is fault-isolated (#1150 D7): a malformed
 * `modalities` or `snippet` on one result degrades that row to its plainest
 * safe form rather than aborting the whole table -- the dataset list the
 * user asked for is the deliverable, the decoration is not allowed to take
 * it down.
 *
 * The scope is narrower than "per-row" first reads, and the difference is
 * worth knowing (#1174 review): `planSearchColumns` runs ONCE over the whole
 * result set before the per-row try/catch, so a malformed `id` or `name`
 * throws out of this function entirely. That is caught one level up by the
 * command's own fallback to a plain id/name listing. The command still never
 * fails, which is D7's actual guarantee -- but in that case every row loses
 * its full rendering, not just the offending one.
 */
export function renderSearchResultLines(
  results: DatasetSearchResult[],
  columns: number,
  options: { snippets?: boolean } = {},
): string[] {
  const { snippets = false } = options;
  const plan = planSearchColumns(results, columns);
  const lines: string[] = [];

  const headerParts = ["ID".padEnd(plan.idWidth), "Name".padEnd(plan.nameWidth)];
  if (plan.showModality) headerParts.push("Modality".padEnd(plan.modWidth));
  if (plan.showSubj) headerParts.push("Subj".padEnd(plan.subjWidth));
  if (plan.showHed) headerParts.push("HED".padEnd(SEARCH_HED_WIDTH));
  const header = headerParts.join("  ");
  lines.push(theme.muted(header));
  lines.push(theme.muted("-".repeat(header.length)));

  for (const result of results) {
    try {
      const name =
        result.name.length > plan.nameWidth
          ? `${result.name.substring(0, plan.nameWidth - 3)}...`
          : result.name;

      const rowParts = [theme.id(result.id.padEnd(plan.idWidth)), name.padEnd(plan.nameWidth)];
      if (plan.showModality) {
        rowParts.push(
          truncateTokenList(result.modalities || "-", plan.modWidth).padEnd(plan.modWidth),
        );
      }
      if (plan.showSubj) {
        rowParts.push(
          (result.participants ? String(result.participants) : "-").padEnd(plan.subjWidth),
        );
      }
      if (plan.showHed) {
        rowParts.push(result.has_hed === 1 ? theme.metric("HED") : theme.muted("-"));
      }
      lines.push(rowParts.join("  "));

      // Opt-in only (owner decision 2026-09-03): the snippet line is skipped
      // entirely unless the caller asked for it via `--verbose`, which maps
      // to `options.snippets`. See the function doc comment above.
      if (snippets) {
        // Defence-in-depth beyond renderSnippetLine's own guard (#1150 D7):
        // a snippet that fails to render costs this row its garnish, never
        // the row itself, never the rest of the table.
        //
        // This layer is DOUBLY masked and no test can see it (#1174 review):
        // renderSnippetLine already cannot throw for any input reachable
        // here, and if it somehow did, the per-row catch below would handle
        // it with the same visible outcome. Kept because the cost is a
        // try/catch and the failure it guards against is a search silently
        // losing rows, but do not mistake the passing suite for proof that
        // it does anything.
        let snippetLine: string | null = null;
        try {
          snippetLine = renderSnippetLine(result.snippet);
        } catch {
          snippetLine = null;
        }
        if (snippetLine) lines.push(`    ${snippetLine}`);
      }
    } catch {
      // A single malformed row must not take down the rest of the table
      // (#1150 D7) -- fall back to the two fields that matter most: the id
      // the user copies onward, and the name that tells them what it is.
      lines.push(`${result.id ?? "?"}  ${result.name ?? "?"}`);
    }
  }

  return lines;
}

/**
 * Validate `--license` tiers up front, shared by `list` and `search` (epic
 * #1144 phase 4, #1148, D4/D6). The API tolerantly drops unknown tokens (so
 * the website degrades gracefully), which would silently return an
 * unfiltered list on a CLI typo -- so fail fast here instead, against the
 * SAME `LICENSE_TIERS` the backend classifies with (shared/license-tiers.ts,
 * #653) rather than a second hand-maintained copy.
 */
function validateLicenseTiersOrExit(license: string | undefined): void {
  if (!license) return;
  const bad = license
    .split(",")
    .map((t: string) => t.trim().toLowerCase())
    .filter((t: string) => t && !(LICENSE_TIERS as readonly string[]).includes(t));
  if (bad.length > 0) {
    console.log(chalk.red(`Error: invalid license tier(s): ${bad.join(", ")}`));
    console.log(`Valid tiers: ${LICENSE_TIERS.join(", ")}`);
    process.exit(1);
  }
}

/**
 * Build the wire-ready facet query params from a command's parsed options,
 * or print an error and exit 1 -- before any network call (epic #1144 phase
 * 4, #1148, D3). Shared by `list` and `search` so a bad `--subjects 100xyz`
 * behaves identically on both. `buildFacetParams`/`FacetEnumCliError` live in
 * lib/facet-options.ts, which never calls `process.exit` itself (see that
 * file's header and lib/cli-output.ts's) -- owning the exit is this command
 * module's job, same as the license-tier check above.
 */
function parseFacetOptionsOrExit(options: Record<string, unknown>): Record<string, string> {
  try {
    return buildFacetParams(options);
  } catch (err) {
    if (err instanceof RangeParseError) {
      console.log(chalk.red(`Error: ${err.message}`));
      console.log(chalk.dim(RANGE_FORMS_HELP));
    } else if (err instanceof FacetEnumCliError) {
      console.log(chalk.red(`Error: ${err.message}`));
    } else {
      throw err;
    }
    process.exit(1);
  }
}

// List command
const listCommand = datasetCommand
  .command("list")
  .description("List datasets on NEMAR (full catalog)")
  .option("--mine", "List only your datasets (both private and public)")
  .option("--owner <username>", "List datasets owned by a specific user")
  .option("--search <query>", "Search by name, description, authors, or tasks")
  .option("--modality <type>", "Filter by modality (eeg, emg, meg, etc.)")
  .option("--author <name>", "Filter by author name")
  .option("--task <name>", "Filter by task name")
  .option(
    "--license <tiers>",
    "Filter by license tier(s), comma-separated: public, attribution, sharealike, noncommercial, noderiv, unknown",
  )
  .option("--doi", "Show only datasets with DOIs")
  .option("--hed", "Show only datasets with HED annotations")
  .option("--has-zarr", "Show only datasets with a ready Zarr copy (#1062)")
  .option(
    "--has-zarr-verified",
    "Show only datasets whose Zarr copy passed fidelity verification (#1068)",
  )
  .option("--complete", "Show only datasets verified data-complete (#970)")
  .option("--recent [days]", "Show recently published datasets")
  .addOption(
    new Option("--sort <order>", "Sort order")
      .choices(["newest", "oldest", "name", "participants", "size", "citations"])
      .default("newest"),
  )
  .option(
    "--include-unknown",
    "Include datasets with an unknown value for the active facet filter(s)",
  )
  .option("--json", "Output as JSON for scripting")
  .option("-n, --limit <n>", "Results per page (default: 20, max: 200)", "20")
  .option("--page <n>", "Page number (starts at 1)")
  .option("--offset <n>", "Skip this many results (alternative to --page)")
  .option("--all", "Show all results (up to 200)");
// Epic #1144 phase 4 (#1148), D1: one registered flag per declared facet
// (shared/facets.ts), generated rather than 20 hand-written .option() calls.
addFacetOptions(listCommand);
listCommand
  .addHelpText(
    "after",
    `
Description:
  Lists the full NEMAR catalog, including legacy datasets from nemar.org
  and datasets managed via nemar-cli. Shows 20 results per page by default.
  Run 'nemar dataset list --help' for the full list of facet filters
  (--subjects, --channels, --age, --source, ...).

  With --mine: shows only YOUR datasets (requires authentication).
  With --owner <username>: shows datasets owned by a specific user.

Pagination:
  -n, --limit <n>    Results per page (default: 20, max: 200)
  --page <n>         Page number (e.g., --page 2 for results 21-40)
  --offset <n>       Skip N results (e.g., --offset 40 for results 41+)
  --all              Show all results (up to 200)

Display Indicators:
  ${chalk.cyan("cyan ID")}     Managed dataset (on GitHub)
  ${chalk.dim("dim ID")}      Catalog-only (nemar.org, not on GitHub)
  ${chalk.yellow("*")}           On GitHub but not synced to nemar.org
  ${chalk.red("!")}           Sync to nemar.org failed

Examples:
  $ nemar dataset list                         # First 20 datasets
  $ nemar dataset list --page 2                # Next 20 datasets
  $ nemar dataset list -n 50                   # 50 per page
  $ nemar dataset list --all                   # All results (up to 200)
  $ nemar dataset list --mine                  # Your datasets
  $ nemar dataset list --owner yahya           # Datasets by 'yahya'
  $ nemar dataset list --modality eeg          # EEG datasets only
  $ nemar dataset list --license public,attribution  # Permissive licenses
  $ nemar dataset list --search "motor"        # Search by keyword
  $ nemar dataset list --doi --sort size       # Published, by size
  $ nemar dataset list --subjects 20..50 --age 18..  # Facet filters
  $ nemar dataset search "resting state EEG"   # Semantic search`,
  )
  .action(async (options) => {
    if (options.mine && options.owner) {
      console.log(chalk.red("Error: --mine and --owner cannot be used together"));
      console.log("Use --mine for your datasets, or --owner <username> for another user's.");
      process.exit(1);
    }

    if (options.mine && !isAuthenticated()) {
      console.log(chalk.red("Error: Not authenticated"));
      console.log("Run 'nemar auth login' to see your datasets");
      process.exit(1);
    }

    validateLicenseTiersOrExit(options.license);
    // Epic #1144 phase 4 (#1148), D3: every facet range/enum is parsed and
    // validated here, client-side, before the spinner (and therefore before
    // any network call) starts below.
    const facets = parseFacetOptionsOrExit(options);

    // Parse pagination
    const limit = options.all ? 200 : Math.min(Number.parseInt(options.limit, 10) || 20, 200);
    let offset = 0;
    if (options.page) {
      const page = Math.max(Number.parseInt(options.page, 10) || 1, 1);
      offset = (page - 1) * limit;
    } else if (options.offset) {
      offset = Math.max(Number.parseInt(options.offset, 10) || 0, 0);
    }

    const spinner = ora("Fetching datasets...").start();

    let response: DatasetsListResponse;
    try {
      response = await listDatasets({
        mine: !!options.mine,
        search: options.search,
        modality: options.modality,
        author: options.author,
        task: options.task,
        license: options.license,
        hasDoi: !!options.doi,
        hasHed: !!options.hed,
        hasZarr: !!options.hasZarr,
        hasZarrVerified: !!options.hasZarrVerified,
        dataComplete: !!options.complete,
        recent: options.recent ? Number.parseInt(options.recent, 10) || 30 : undefined,
        sort: options.sort,
        limit,
        offset,
        owner: options.owner,
        facets,
        includeUnknown: !!options.includeUnknown,
      });
      spinner.stop();
    } catch (error) {
      spinner.fail("Failed to fetch datasets");
      if (error instanceof ApiError) {
        console.log(chalk.red(`  ${error.message}`));
      } else {
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      process.exit(1);
    }

    const datasets = response.datasets;
    const totalCount = response.total_count ?? response.count;

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            datasets,
            total_count: totalCount,
            limit,
            offset,
            fallback: response.fallback,
            warning: response.warning,
            excluded_unknown: response.excluded_unknown,
            excluded_unknown_by_facet: response.excluded_unknown_by_facet,
          },
          null,
          2,
        ),
      );
      // Epic #1144 phase 5b (#1149), D3: fire-and-forget, after output is
      // rendered, never awaited -- this list call just proved the API is
      // reachable, so refreshing the completion cache costs one extra
      // request on a path that already made one.
      triggerOpportunisticRefresh();
      return;
    }

    // Surface backend degradation (catalog/FTS/consolidation column unavailable):
    // filters were NOT applied and catalog datasets are missing, so the result is
    // not what was asked for. Make it loud rather than a silent unfiltered list (#646).
    if (response.warning) {
      console.log(chalk.yellow(`\n⚠ ${response.warning}`));
    }

    // Epic #1144 phase 4 (#1148), D5: reported on stderr (not part of the
    // rendered table/JSON on stdout) and only when at least one facet
    // actually excluded something. Always attributed per facet -- the
    // backend computes excluded_unknown_by_facet in the same query.
    if (response.excluded_unknown !== undefined && response.excluded_unknown > 0) {
      console.error(
        chalk.dim(
          formatExcludedUnknownNote(
            response.excluded_unknown,
            response.excluded_unknown_by_facet ?? {},
          ),
        ),
      );
    }

    if (datasets.length === 0) {
      console.log();
      if (options.mine) {
        console.log(chalk.yellow("You don't have any datasets yet."));
        console.log(chalk.dim("Create one with: nemar dataset upload <path>"));
      } else if (options.owner) {
        console.log(chalk.yellow(`No datasets found for user '${options.owner}'.`));
      } else if (
        options.search ||
        options.modality ||
        options.author ||
        options.hed ||
        options.complete ||
        options.license ||
        options.task
      ) {
        console.log(chalk.yellow("No datasets match your filters."));
        console.log(chalk.dim("Try broader search terms or remove filters."));
      } else {
        console.log(chalk.yellow("No datasets found."));
      }
      triggerOpportunisticRefresh();
      return;
    }

    renderDatasetTable(datasets, { limit, offset, totalCount });
    triggerOpportunisticRefresh();
  });

// Search command (semantic search via Vectorize)
const searchCommand = datasetCommand
  .command("search <query>")
  .description("Search datasets using semantic matching")
  .option("--modality <type>", "Filter by modality (eeg, emg, meg, etc.)")
  .option("--author <name>", "Filter by author name")
  .option("--task <name>", "Filter by task name")
  .option(
    "--license <tiers>",
    "Filter by license tier(s), comma-separated: public, attribution, sharealike, noncommercial, noderiv, unknown",
  )
  .option("--doi", "Show only datasets with DOIs")
  .option("--hed", "Show only datasets with HED annotations")
  .option("--has-zarr", "Show only datasets with a ready Zarr copy (#1062)")
  .option(
    "--has-zarr-verified",
    "Show only datasets whose Zarr copy passed fidelity verification (#1068)",
  )
  .option("--complete", "Show only datasets verified data-complete (#970)")
  .option("--recent [days]", "Show recently published datasets")
  .option(
    "--include-unknown",
    "Include datasets with an unknown value for the active facet filter(s)",
  )
  // No `-v` alias (#1174-class review finding, discovered implementing this
  // flag): the root program binds `-v` to `--version` (`src/index.ts`,
  // `.version(version, "-v, --version", ...)`, a deliberate deviation from
  // Commander's own `-V` default), so `-v` ANYWHERE in argv unconditionally
  // prints the version and exits before this subcommand ever runs -- proven
  // by running `nemar dataset search foo -v`. That already silently breaks
  // every OTHER `-v, --verbose` in this file (`validate` above, `sandbox`,
  // `admin`); this flag does not repeat it. See `searchVerboseRequested`
  // below for why `--verbose` (long form only) also can't be read the normal
  // way here.
  .option("--verbose", "Show a README snippet under each result (off by default)")
  .option("--json", "Output as JSON for scripting")
  .option("--limit <n>", "Limit results (default: 20)", "20");

/**
 * Whether `--verbose` was passed to `nemar dataset search`, read the ONLY way
 * that actually works for this command.
 *
 * `searchCommand`'s own `--verbose` above exists purely so `dataset search
 * --help` documents it -- the resulting value is never usable as
 * `options.verbose` inside the action below. Commander's root command
 * (`src/index.ts`) already declares a program-wide `--verbose` (one of its
 * four documented global options), and `Command.parseOptions` resolves EVERY
 * token in the full argv against the CURRENTLY-PARSING command's own options
 * top-down, before any subcommand dispatch happens at all -- so root's
 * `_findOption("--verbose")` always matches and consumes the token first,
 * regardless of where in argv it appears (before or after `search`).
 * `searchCommand`'s local option therefore never receives a value through
 * the normal per-command `options` object; it stays `undefined` even when
 * `--verbose` was typed (confirmed by tracing `options` inside this action
 * with `--verbose` passed: `Object.keys(options)` never contains `verbose`).
 * The value IS captured correctly, just one level up, on the root command.
 * `optsWithGlobals()` walks `searchCommand -> datasetCommand -> program` and
 * merges with ancestor (root) values winning on a key collision, which is
 * exactly root's own documented behaviour for `optsWithGlobals()` ("globals
 * overwrite locals") -- so this is the supported Commander mechanism for
 * reading a value an ancestor command captured, not a workaround bolted on
 * top of it.
 */
function searchVerboseRequested(): boolean {
  return !!searchCommand.optsWithGlobals().verbose;
}
// Epic #1144 phase 4 (#1148), D1/D6: same declared facet table `list` uses,
// so a facet or legacy filter fixed on the backend is reachable from search
// too instead of drifting behind list's flag set.
addFacetOptions(searchCommand);
searchCommand
  .addHelpText(
    "after",
    `
Description:
  Performs semantic search across the NEMAR dataset catalog. Unlike
  --search on the list command (which uses exact text matching), this
  uses AI embeddings to find conceptually similar datasets. The free-text
  query is always the <query> argument -- this command has no --search flag.

  Accepts the same license/author/task/doi/complete/recent filters and facet
  flags (--subjects, --age, --source, ...) as 'nemar dataset list --help'.

  For example, "brain signals during sleep" will match datasets about
  "EEG recordings in sleep studies" even if those exact words don't appear.

Examples:
  $ nemar dataset search "motor imagery EEG"
  $ nemar dataset search "resting state" --modality eeg
  $ nemar dataset search "sleep spindles" --json
  $ nemar dataset search "motor imagery" --license public --subjects 10..
  $ nemar dataset search "P300 oddball" --verbose      # Show README snippets`,
  )
  .action(async (query: string, options) => {
    validateLicenseTiersOrExit(options.license);
    // Epic #1144 phase 4 (#1148), D3: parsed and validated before the
    // spinner (and therefore before any network call) starts below.
    const facets = parseFacetOptionsOrExit(options);

    const spinner = ora("Searching datasets...").start();

    try {
      const response = await searchDatasets(query, {
        modality: options.modality,
        hasHed: !!options.hed,
        hasZarr: !!options.hasZarr,
        hasZarrVerified: !!options.hasZarrVerified,
        limit: Number.parseInt(options.limit, 10),
        author: options.author,
        task: options.task,
        license: options.license,
        hasDoi: !!options.doi,
        dataComplete: !!options.complete,
        recent: options.recent ? Number.parseInt(options.recent, 10) || 30 : undefined,
        facets,
        includeUnknown: !!options.includeUnknown,
      });
      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        triggerOpportunisticRefresh();
        return;
      }

      // Surface backend degradation (#1145 review I1: a count-query failure
      // falls back to a page-derived lower bound rather than 500ing), same
      // vocabulary and treatment as the list command's `response.warning`.
      if (response.warning) {
        console.log(theme.warn(`\n⚠ ${response.warning}`));
      }

      // Epic #1144 phase 4 (#1148), D5: same stderr-only, count-gated,
      // always-attributed note as the list command.
      if (response.excluded_unknown !== undefined && response.excluded_unknown > 0) {
        console.error(
          theme.muted(
            formatExcludedUnknownNote(
              response.excluded_unknown,
              response.excluded_unknown_by_facet ?? {},
            ),
          ),
        );
      }

      if (response.results.length === 0) {
        console.log();
        console.log(theme.warn("No datasets match your search."));
        console.log(
          theme.muted("Try different search terms or use 'nemar dataset list' for browsing."),
        );
        triggerOpportunisticRefresh();
        return;
      }

      console.log();
      console.log(
        theme.label(
          `Search results for "${query}" (${response.results.length} found, ${response.method}):`,
        ),
      );
      console.log();

      // Terminal-capability probe: never throws, never yields a degenerate
      // width (#1150 D4/D7). `process.stdout.columns` is `undefined` for
      // piped/non-TTY stdout -- the common case for a scripted invocation --
      // in which case the table lays out for SEARCH_DEFAULT_COLUMNS (80).
      let columns = SEARCH_DEFAULT_COLUMNS;
      try {
        const raw = process.stdout.columns;
        if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
          columns = Math.floor(raw);
        }
      } catch {
        columns = SEARCH_DEFAULT_COLUMNS;
      }

      try {
        for (const line of renderSearchResultLines(response.results, columns, {
          snippets: searchVerboseRequested(),
        })) {
          console.log(line);
        }
      } catch (renderErr) {
        // Presentation must never fail a command that already has its data
        // (#1150 D7): the search succeeded and `response.results` is real:
        // a bug in the table renderer degrades to the simplest possible
        // listing, not to "Search failed".
        if (process.env.VERBOSE) {
          console.error(
            theme.muted(
              `[search] table rendering failed, falling back to a plain list: ${
                renderErr instanceof Error ? renderErr.message : String(renderErr)
              }`,
            ),
          );
        }
        for (const result of response.results) {
          console.log(`${result.id}  ${result.name}`);
        }
      }

      console.log();
      console.log(theme.muted("For details: nemar dataset status <dataset-id>"));
      triggerOpportunisticRefresh();
    } catch (error) {
      spinner.fail("Search failed");
      if (error instanceof ApiError) {
        console.log(chalk.red(`  ${error.message}`));
      } else {
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      process.exit(1);
    }
  });

// Release command - create a version bump PR
datasetCommand
  .command("release")
  .description("Create a version bump PR for a dataset")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .option("--type <type>", "Bump type: patch, minor, or major")
  .option("--version <version>", "Explicit version (e.g., 2.0.0)")
  .option("--dir <path>", "Use existing local clone instead of cloning")
  .option("--monitor", "Watch CI checks and offer to merge")
  .option(YES_OPTION, YES_DESCRIPTION)
  .addHelpText(
    "after",
    `
Description:
  Create a pull request that bumps the dataset version in
  dataset_description.json. The PR triggers CI checks (BIDS validation,
  version check). On merge, GitHub Actions tags the release and
  publishes a version DOI (if a concept DOI exists).

Examples:
  $ nemar dataset release nm000104 --type patch
  $ nemar dataset release nm000104 --version 2.0.0
  $ nemar dataset release nm000104                   # interactive prompt`,
  )
  .action(
    async (
      datasetId: string,
      options: {
        type?: string;
        version?: string;
        dir?: string;
        monitor?: boolean;
        yes?: boolean;
      },
    ) => {
      requireAuth();

      await checkPrerequisitesForCommand("release");

      // Fetch dataset info
      const infoSpinner = ora("Fetching dataset info...").start();
      let dataset: Dataset;
      try {
        dataset = await getDataset(datasetId);
        infoSpinner.succeed(`Dataset: ${dataset.name || datasetId}`);
      } catch (error) {
        if (error instanceof ApiError) {
          infoSpinner.fail(error.message);
        } else {
          infoSpinner.fail("Failed to fetch dataset");
        }
        process.exit(1);
      }

      if (!dataset.github_repo) {
        console.log(chalk.red("Error: Dataset has no GitHub repository"));
        process.exit(1);
      }

      // Fetch version history (required for correct version bumping)
      let currentVersion: string;
      try {
        const history = await getVersionHistory(datasetId);
        // Backend returns the canonical vX.Y.Z tag; strip the leading v so the
        // printed version and the PR body read as bare semvers (the release tag
        // line re-adds it). Downstream bump logic strips the v regardless.
        currentVersion = history.current_version.replace(/^v/, "");
        console.log(`  Current version: ${chalk.cyan(currentVersion)}`);
        if (history.versions.length > 0) {
          console.log(`  Version DOIs: ${history.versions.length}`);
          for (const v of history.versions.slice(0, 3)) {
            console.log(`    ${v.version} - ${chalk.dim(v.doi)}`);
          }
          if (history.versions.length > 3) {
            console.log(chalk.dim(`    ... and ${history.versions.length - 3} more`));
          }
        }
      } catch (err) {
        const detail = err instanceof ApiError ? `${err.statusCode}: ${err.message}` : String(err);
        console.log(chalk.red(`Error: Could not fetch version history (${detail})`));
        console.log("  Cannot determine current version. Ensure the backend is reachable.");
        process.exit(1);
      }

      // Determine new version
      let newVersion: string;
      // `!== undefined`, not truthiness: an empty --version= is a version the
      // user gave and got wrong, not a flag they left out.
      if (options.version !== undefined) {
        if (!isValidStableVersion(options.version)) {
          console.log(chalk.red(`Error: Invalid version: ${options.version}`));
          console.log("  Expected format: X.Y.Z (e.g., 2.0.0)");
          process.exit(1);
        }
        newVersion = options.version.replace(/^v/, "");
      } else if (options.type) {
        const bumpType = options.type as "patch" | "minor" | "major";
        if (!["patch", "minor", "major"].includes(bumpType)) {
          console.log(chalk.red(`Error: Invalid bump type: ${options.type}`));
          console.log("  Expected: patch, minor, or major");
          process.exit(1);
        }
        newVersion = bumpVersion(currentVersion, bumpType);
      } else {
        // Interactive prompt
        const parsed = parseVersion(currentVersion);
        if (!parsed) {
          console.log(chalk.red(`Error: Cannot parse current version: ${currentVersion}`));
          process.exit(1);
        }

        const choices = [
          {
            name: `patch  ${currentVersion} -> ${bumpVersion(currentVersion, "patch")}`,
            value: "patch",
          },
          {
            name: `minor  ${currentVersion} -> ${bumpVersion(currentVersion, "minor")}`,
            value: "minor",
          },
          {
            name: `major  ${currentVersion} -> ${bumpVersion(currentVersion, "major")}`,
            value: "major",
          },
          { name: "custom version", value: "custom" },
        ];

        const { bumpType } = await inquirer.prompt([
          {
            type: "list",
            name: "bumpType",
            message: "Select version bump type:",
            choices,
          },
        ]);

        if (bumpType === "custom") {
          const { customVersion } = await inquirer.prompt([
            {
              type: "input",
              name: "customVersion",
              message: "Enter version (X.Y.Z):",
              validate: (v: string) =>
                isValidStableVersion(v) || "Invalid format. Use X.Y.Z (e.g., 2.0.0)",
            },
          ]);
          newVersion = customVersion.replace(/^v/, "");
        } else {
          newVersion = bumpVersion(currentVersion, bumpType);
        }
      }

      console.log();
      console.log(
        `  ${chalk.bold("Version bump:")} ${currentVersion} -> ${chalk.green(newVersion)}`,
      );

      // Confirm
      const result = await confirm(`Create release PR for ${datasetId} v${newVersion}?`, {
        yes: options.yes,
      });
      if (result !== "confirmed") {
        console.log("Cancelled.");
        return;
      }

      // Determine working directory
      let workDir: string;
      let needsClone = true;

      if (options.dir) {
        if (!existsSync(options.dir)) {
          console.log(chalk.red(`Error: Directory not found: ${options.dir}`));
          process.exit(1);
        }
        workDir = resolve(options.dir);
        needsClone = false;
      } else {
        workDir = mkdtempSync(join(tmpdir(), `nemar-release-${datasetId}-`));
      }

      // Clone if needed
      if (needsClone) {
        const cloneUrl = `https://github.com/${dataset.github_repo}.git`;
        const cloneSpinner = ora("Cloning dataset...").start();
        const cloneResult = await cloneDataset(cloneUrl, workDir);
        if (!cloneResult.success) {
          cloneSpinner.fail(`Clone failed: ${cloneResult.error}`);
          process.exit(1);
        }
        cloneSpinner.succeed("Cloned dataset");
      }

      // Create release branch
      const branchName = `release/v${newVersion}`;
      const branchSpinner = ora("Creating release branch...").start();

      const branchProc = spawn({
        cmd: ["git", "checkout", "-b", branchName],
        cwd: workDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      if ((await branchProc.exited) !== 0) {
        const stderr = await new Response(branchProc.stderr).text();
        branchSpinner.fail(`Failed to create branch: ${stderr.trim()}`);
        process.exit(1);
      }
      branchSpinner.succeed(`Created branch: ${branchName}`);

      // Update dataset_description.json
      const descPath = join(workDir, "dataset_description.json");
      if (!existsSync(descPath)) {
        console.log(chalk.red("Error: dataset_description.json not found in repo"));
        process.exit(1);
      }

      let descContent: Record<string, unknown>;
      try {
        descContent = JSON.parse(readFileSync(descPath, "utf-8"));
      } catch (err) {
        if (err instanceof SyntaxError) {
          console.log(chalk.red("Error: dataset_description.json contains invalid JSON"));
        } else {
          console.log(chalk.red(`Error: Could not read dataset_description.json: ${err}`));
        }
        process.exit(1);
      }
      descContent.Version = newVersion;
      writeFileSync(descPath, `${JSON.stringify(descContent, null, 2)}\n`);

      // Commit
      const commitSpinner = ora("Committing version bump...").start();
      const addProc = spawn({
        cmd: ["git", "add", "dataset_description.json"],
        cwd: workDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      if ((await addProc.exited) !== 0) {
        const stderr = await new Response(addProc.stderr).text();
        commitSpinner.fail(`Failed to stage changes: ${stderr.trim()}`);
        process.exit(1);
      }

      const commitProc = spawn({
        cmd: ["git", "commit", "-m", `Bump version to ${newVersion}`],
        cwd: workDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      if ((await commitProc.exited) !== 0) {
        const stderr = await new Response(commitProc.stderr).text();
        commitSpinner.fail(`Commit failed: ${stderr.trim()}`);
        process.exit(1);
      }
      commitSpinner.succeed("Committed version bump");

      // Push branch
      const pushSpinner = ora("Pushing branch...").start();
      const pushResult = await pushBranch(workDir, branchName);
      if (!pushResult.success) {
        pushSpinner.fail(`Push failed: ${pushResult.error}`);
        process.exit(1);
      }
      pushSpinner.succeed("Pushed branch");

      // Create PR via gh CLI
      let prCreated = false;
      const prSpinner = ora("Creating pull request...").start();
      try {
        const prTitle = `Release v${newVersion}`;
        const prBody = `## Version Bump\n\nBumps ${datasetId} from ${currentVersion} to ${newVersion}.\n\nOn merge, CI will:\n- Tag the release (v${newVersion})\n- Publish a version DOI (if concept DOI exists)`;

        const prProc = spawn({
          cmd: [
            "gh",
            "pr",
            "create",
            "--repo",
            dataset.github_repo,
            "--head",
            branchName,
            "--base",
            "main",
            "--title",
            prTitle,
            "--body",
            prBody,
          ],
          cwd: workDir,
          stdout: "pipe",
          stderr: "pipe",
        });

        const prUrl = (await new Response(prProc.stdout).text()).trim();
        if ((await prProc.exited) !== 0) {
          const stderr = await new Response(prProc.stderr).text();
          throw new Error(stderr.trim() || "gh pr create failed");
        }

        prCreated = true;
        prSpinner.succeed("Created pull request");
        console.log();
        console.log(`  ${chalk.cyan("PR:")} ${prUrl}`);
      } catch (prError) {
        prSpinner.fail("Failed to create PR");
        const errorMsg = prError instanceof Error ? prError.message : String(prError);
        console.log(chalk.red(`  ${errorMsg}`));
        if (errorMsg.includes("not found") || errorMsg.includes("command not found")) {
          console.log(chalk.yellow("  Install: brew install gh"));
        } else if (errorMsg.includes("auth") || errorMsg.includes("401")) {
          console.log(chalk.yellow("  Run: gh auth login"));
        }
        console.log(chalk.dim(`  Branch ${branchName} has been pushed. Create the PR manually.`));
      }

      // Monitor mode (only if PR was created successfully)
      if (options.monitor && prCreated) {
        console.log();
        console.log(chalk.dim("Monitoring CI checks..."));
        console.log(chalk.dim("  Press Ctrl+C to stop monitoring"));

        let attempts = 0;
        const maxAttempts = 60; // 10 minutes at 10s intervals

        while (attempts < maxAttempts) {
          await new Promise((r) => setTimeout(r, 10000));
          attempts++;

          const checkProc = spawn({
            cmd: ["gh", "pr", "checks", "--repo", dataset.github_repo, branchName],
            cwd: workDir,
            stdout: "pipe",
            stderr: "pipe",
          });
          const checkOutput = await new Response(checkProc.stdout).text();
          const checkExit = await checkProc.exited;

          if (checkExit === 0) {
            console.log(chalk.green("  All checks passed!"));

            const mergeResult = await confirm("Merge the PR?", { yes: options.yes });
            if (mergeResult === "confirmed") {
              const mergeProc = spawn({
                cmd: [
                  "gh",
                  "pr",
                  "merge",
                  "--repo",
                  dataset.github_repo,
                  branchName,
                  "--squash",
                  "--delete-branch",
                ],
                cwd: workDir,
                stdout: "pipe",
                stderr: "pipe",
              });
              const mergeExit = await mergeProc.exited;
              if (mergeExit === 0) {
                console.log(chalk.green("  PR merged successfully!"));
              } else {
                const mergeErr = await new Response(mergeProc.stderr).text();
                console.log(chalk.red(`  Merge failed: ${mergeErr.trim()}`));
              }
            }
            break;
          }

          // Check if any failed
          if (checkOutput.includes("fail") || checkOutput.includes("X")) {
            console.log(chalk.red("  Some checks failed:"));
            console.log(checkOutput);
            break;
          }

          process.stdout.write(chalk.dim("."));
        }

        if (attempts >= maxAttempts) {
          console.log(chalk.yellow("\n  Timed out waiting for checks."));
        }
      }

      if (needsClone) {
        console.log();
        console.log(chalk.dim(`Working directory: ${workDir}`));
        console.log(chalk.dim("You can delete this directory after the PR is merged."));
      }
    },
  );

// Update command - push data/metadata changes via PR
datasetCommand
  .command("update")
  .description("Push local changes to a dataset via PR")
  .argument("[path]", "Path to local dataset clone (default: current directory)")
  .option("--bump <type>", "Version bump type: patch, minor, or major", "patch")
  .option("--branch <name>", "Custom branch name")
  .option("-m, --message <msg>", "Commit message")
  .option("--monitor", "Watch CI checks and offer to merge")
  .option(YES_OPTION, YES_DESCRIPTION)
  .addHelpText(
    "after",
    `
Description:
  Push local changes (metadata or data files) to a dataset via a pull
  request. Automatically bumps the version, commits, pushes, and creates
  a PR. For data files (annexed), copies them to S3 via git-annex.

  Run this from inside a dataset clone, or pass the path as an argument.

Note:
  This is the recommended way to update public datasets. It creates a
  PR that must be reviewed before merging. For private datasets, you
  can also use 'nemar dataset push' for direct updates.

Examples:
  $ cd nm000104 && nemar dataset update
  $ nemar dataset update ./nm000104 --bump minor -m "Add new subjects"
  $ nemar dataset update --branch fix/metadata -m "Fix participant ages"`,
  )
  .action(
    async (
      path: string | undefined,
      options: {
        bump: string;
        branch?: string;
        message?: string;
        monitor?: boolean;
        yes?: boolean;
      },
    ) => {
      requireAuth();

      await checkPrerequisitesForCommand("update");

      const workDir = resolve(path || ".");

      if (!existsSync(join(workDir, ".git"))) {
        console.log(chalk.red("Error: Not a git repository"));
        console.log("  Run this from inside a dataset clone, or pass the path.");
        process.exit(1);
      }

      // Detect dataset ID from remote
      const datasetId = await getDatasetIdFromRemote(workDir);
      if (!datasetId) {
        console.log(chalk.red("Error: Could not detect dataset ID from git remote"));
        process.exit(1);
      }

      console.log(`  Dataset: ${chalk.cyan(datasetId)}`);

      // Check we're on main branch
      const currentBranchName = await getCurrentBranch(workDir);
      if (currentBranchName !== "main") {
        console.log(
          chalk.yellow(`Warning: Currently on branch '${currentBranchName}', expected 'main'`),
        );
        const result = await confirm("Continue anyway?", { yes: options.yes });
        if (result !== "confirmed") {
          console.log("Cancelled.");
          return;
        }
      }

      // Check for changes
      const statusProc = spawn({
        cmd: ["git", "status", "--porcelain"],
        cwd: workDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const statusOutput = (await new Response(statusProc.stdout).text()).trim();
      if ((await statusProc.exited) !== 0) {
        console.log(chalk.red("Error: Failed to check git status"));
        process.exit(1);
      }

      if (!statusOutput) {
        console.log(chalk.yellow("No changes detected."));
        console.log("  Make changes to the dataset files, then run this command again.");
        return;
      }

      // Categorize changes
      const lines = statusOutput.split("\n");
      const dataFiles: string[] = [];
      const metadataFiles: string[] = [];
      for (const line of lines) {
        const filePath = line.substring(3).trim();
        // Common neuroimaging data file extensions (typically git-annex managed)
        if (/\.(edf|bdf|set|fdt|nwb|eeg|vhdr|vmrk|cnt|mff|gz)$/i.test(filePath)) {
          dataFiles.push(filePath);
        } else {
          metadataFiles.push(filePath);
        }
      }

      console.log();
      if (metadataFiles.length > 0) {
        console.log(`  ${chalk.bold("Metadata files:")} ${metadataFiles.length}`);
        for (const f of metadataFiles.slice(0, 5)) {
          console.log(`    ${f}`);
        }
        if (metadataFiles.length > 5) {
          console.log(chalk.dim(`    ... and ${metadataFiles.length - 5} more`));
        }
      }
      if (dataFiles.length > 0) {
        console.log(`  ${chalk.bold("Data files:")} ${dataFiles.length}`);
        for (const f of dataFiles.slice(0, 5)) {
          console.log(`    ${f}`);
        }
        if (dataFiles.length > 5) {
          console.log(chalk.dim(`    ... and ${dataFiles.length - 5} more`));
        }
      }

      // Get dataset info for github_repo
      const infoSpinner = ora("Fetching dataset info...").start();
      let dataset: Dataset;
      try {
        dataset = await getDataset(datasetId);
        infoSpinner.succeed();
      } catch (error) {
        if (error instanceof ApiError) {
          infoSpinner.fail(error.message);
        } else {
          infoSpinner.fail("Failed to fetch dataset");
        }
        process.exit(1);
      }

      if (!dataset.github_repo) {
        console.log(chalk.red("Error: Dataset has no GitHub repository"));
        process.exit(1);
      }

      // Get current version (required for correct version bumping)
      let currentVersion: string;
      const versionDescPath = join(workDir, "dataset_description.json");
      if (!existsSync(versionDescPath)) {
        console.log(chalk.red("Error: dataset_description.json not found"));
        console.log("  This file is required for BIDS datasets.");
        process.exit(1);
      }
      try {
        const desc = JSON.parse(readFileSync(versionDescPath, "utf-8"));
        if (typeof desc.Version !== "string" || !desc.Version) {
          console.log(chalk.red("Error: No Version field in dataset_description.json"));
          console.log('  Set the Version field before updating (e.g., "Version": "1.0.0").');
          process.exit(1);
        }
        currentVersion = desc.Version;
      } catch (err) {
        if (err instanceof SyntaxError) {
          console.log(chalk.red("Error: dataset_description.json contains invalid JSON"));
        } else {
          console.log(chalk.red(`Error: Could not read dataset_description.json: ${err}`));
        }
        process.exit(1);
      }

      const bumpType = options.bump as "patch" | "minor" | "major";
      if (!["patch", "minor", "major"].includes(bumpType)) {
        console.log(chalk.red(`Error: Invalid bump type: ${options.bump}`));
        process.exit(1);
      }
      const newVersion = bumpVersion(currentVersion, bumpType);

      console.log(
        `  ${chalk.bold("Version bump:")} ${currentVersion} -> ${chalk.green(newVersion)}`,
      );

      // Confirm
      const confirmResult = await confirm(`Create update PR for ${datasetId}?`, {
        yes: options.yes,
      });
      if (confirmResult !== "confirmed") {
        console.log("Cancelled.");
        return;
      }

      // Create branch
      const timestamp = Date.now().toString(36);
      const branchName = options.branch || `update/${datasetId}-${timestamp}`;

      const branchSpinner = ora("Creating update branch...").start();
      const branchProc = spawn({
        cmd: ["git", "checkout", "-b", branchName],
        cwd: workDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      if ((await branchProc.exited) !== 0) {
        const stderr = await new Response(branchProc.stderr).text();
        branchSpinner.fail(`Failed to create branch: ${stderr.trim()}`);
        process.exit(1);
      }
      branchSpinner.succeed(`Created branch: ${branchName}`);

      // Bump version in dataset_description.json (already validated above)
      const descPath = join(workDir, "dataset_description.json");
      let descContent: Record<string, unknown>;
      try {
        descContent = JSON.parse(readFileSync(descPath, "utf-8"));
      } catch (err) {
        if (err instanceof SyntaxError) {
          console.log(chalk.red("Error: dataset_description.json contains invalid JSON"));
        } else {
          console.log(chalk.red(`Error: Could not read dataset_description.json: ${err}`));
        }
        process.exit(1);
      }
      descContent.Version = newVersion;
      writeFileSync(descPath, `${JSON.stringify(descContent, null, 2)}\n`);

      // Stage all changes and commit
      const commitSpinner = ora("Committing changes...").start();
      const addProc = spawn({
        cmd: ["git", "add", "-A"],
        cwd: workDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      if ((await addProc.exited) !== 0) {
        const stderr = await new Response(addProc.stderr).text();
        commitSpinner.fail(`Failed to stage changes: ${stderr.trim()}`);
        process.exit(1);
      }

      const commitMsg = options.message || `Update ${datasetId} to ${newVersion}`;
      const commitProc = spawn({
        cmd: ["git", "commit", "-m", commitMsg],
        cwd: workDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      if ((await commitProc.exited) !== 0) {
        const stderr = await new Response(commitProc.stderr).text();
        commitSpinner.fail(`Commit failed: ${stderr.trim()}`);
        process.exit(1);
      }
      commitSpinner.succeed("Committed changes");

      // If data files exist and git-annex is available, copy to S3
      if (dataFiles.length > 0) {
        const annexCheck = spawn({
          cmd: ["git", "annex", "version"],
          cwd: workDir,
          stdout: "pipe",
          stderr: "pipe",
        });
        if ((await annexCheck.exited) === 0) {
          // Get STS credentials for S3 upload
          let s3Spinner = ora("Requesting upload credentials...").start();
          let updateCreds: Awaited<ReturnType<typeof requestUploadCredentials>> | null = null;
          try {
            updateCreds = await requestUploadCredentials(datasetId);
            s3Spinner.succeed("Upload credentials received");
          } catch (credError) {
            s3Spinner.fail(`Could not get upload credentials: ${errorDetail(credError)}`);
            console.log(chalk.yellow("  Data files will not be uploaded. Push manually after PR."));
          }

          if (updateCreds) {
            // Ensure S3 remote is configured (may not exist for pre-fix datasets)
            const s3Remotes = await getAnnexS3Remotes(workDir);
            if (s3Remotes.length === 0) {
              s3Spinner = ora("Configuring S3 remote...").start();
              const s3Config = await configureS3Remote(
                workDir,
                {
                  name: "nemar-s3",
                  bucket: updateCreds.s3.bucket,
                  prefix: `${datasetId}/objects`,
                  region: updateCreds.s3.region,
                  publicUrl: `https://${updateCreds.s3.bucket}.s3.${updateCreds.s3.region}.amazonaws.com`,
                },
                toS3Credentials(updateCreds.credentials),
              );
              if (!s3Config.success) {
                s3Spinner.warn(`Failed to configure S3 remote: ${s3Config.error}`);
                console.log(
                  chalk.yellow("  Data files will not be uploaded. Push manually after PR."),
                );
              } else {
                s3Spinner.succeed("S3 remote configured");
              }
            }

            // Only attempt upload if S3 remote is configured
            const s3RemotesAfterConfig = await getAnnexS3Remotes(workDir);
            if (s3RemotesAfterConfig.includes("nemar-s3")) {
              s3Spinner = ora("Uploading data files to S3...").start();
              const copyResult = await copyToAnnexRemote(
                workDir,
                "nemar-s3",
                4,
                toS3Credentials(updateCreds.credentials),
              );
              await clearAnnexCredentials(workDir);
              if (!copyResult.success) {
                s3Spinner.warn(`S3 upload issue: ${copyResult.error}`);
                console.log(chalk.yellow("  Data files may need manual upload after PR creation."));
              } else {
                s3Spinner.succeed(`Uploaded ${copyResult.filesCopied} data files to S3`);
              }
            }
          }
        } else {
          console.log(
            chalk.yellow("  git-annex not available; data files will be committed to git."),
          );
        }
      }

      // Push branch (and git-annex branch if it exists)
      const pushSpinner = ora("Pushing branch...").start();
      const pushResult = await pushBranch(workDir, branchName);
      if (!pushResult.success) {
        pushSpinner.fail(`Push failed: ${pushResult.error}`);
        process.exit(1);
      }

      // Also push git-annex branch if data files were uploaded
      if (dataFiles.length > 0) {
        const annexPush = await pushAnnexBranchToGitHub(workDir, "origin");
        if (!annexPush.success) {
          console.log(
            chalk.yellow(`  Warning: Failed to push git-annex branch: ${annexPush.error}`),
          );
        }
      }
      pushSpinner.succeed("Pushed branch");

      // Create PR via gh CLI
      let prCreated = false;
      const prSpinner = ora("Creating pull request...").start();
      try {
        const prTitle = options.message
          ? `${options.message} (v${newVersion})`
          : `Update ${datasetId} to v${newVersion}`;
        const fileList = [...metadataFiles, ...dataFiles].slice(0, 10).join("\n- ");
        const prBody = `## Dataset Update\n\nBumps ${datasetId} from ${currentVersion} to ${newVersion}.\n\n### Changed files\n- ${fileList}${lines.length > 10 ? `\n- ... and ${lines.length - 10} more` : ""}`;

        const prProc = spawn({
          cmd: [
            "gh",
            "pr",
            "create",
            "--repo",
            dataset.github_repo,
            "--head",
            branchName,
            "--base",
            "main",
            "--title",
            prTitle,
            "--body",
            prBody,
          ],
          cwd: workDir,
          stdout: "pipe",
          stderr: "pipe",
        });

        const prUrl = (await new Response(prProc.stdout).text()).trim();
        if ((await prProc.exited) !== 0) {
          const stderr = await new Response(prProc.stderr).text();
          throw new Error(stderr.trim() || "gh pr create failed");
        }

        prCreated = true;
        prSpinner.succeed("Created pull request");
        console.log();
        console.log(`  ${chalk.cyan("PR:")} ${prUrl}`);
      } catch (prError) {
        prSpinner.fail("Failed to create PR");
        const errorMsg = prError instanceof Error ? prError.message : String(prError);
        console.log(chalk.red(`  ${errorMsg}`));
        console.log(chalk.dim(`  Branch ${branchName} has been pushed. Create the PR manually.`));
      }

      // Monitor mode (only if PR was created successfully)
      if (options.monitor && prCreated) {
        console.log();
        console.log(chalk.dim("Monitoring CI checks..."));

        let attempts = 0;
        const maxAttempts = 60; // 10 minutes at 10s intervals

        while (attempts < maxAttempts) {
          await new Promise((r) => setTimeout(r, 10000));
          attempts++;

          const checkProc = spawn({
            cmd: ["gh", "pr", "checks", "--repo", dataset.github_repo, branchName],
            cwd: workDir,
            stdout: "pipe",
            stderr: "pipe",
          });
          const checkOutput = await new Response(checkProc.stdout).text();
          const checkExit = await checkProc.exited;

          if (checkExit === 0) {
            console.log(chalk.green("  All checks passed!"));
            const mergeResult = await confirm("Merge the PR?", { yes: options.yes });
            if (mergeResult === "confirmed") {
              const mergeProc = spawn({
                cmd: [
                  "gh",
                  "pr",
                  "merge",
                  "--repo",
                  dataset.github_repo,
                  branchName,
                  "--squash",
                  "--delete-branch",
                ],
                cwd: workDir,
                stdout: "pipe",
                stderr: "pipe",
              });
              if ((await mergeProc.exited) === 0) {
                console.log(chalk.green("  PR merged successfully!"));
              } else {
                const mergeErr = await new Response(mergeProc.stderr).text();
                console.log(chalk.red(`  Merge failed: ${mergeErr.trim()}`));
              }
            }
            break;
          }

          if (checkOutput.includes("fail") || checkOutput.includes("X")) {
            console.log(chalk.red("  Some checks failed:"));
            console.log(checkOutput);
            break;
          }

          process.stdout.write(chalk.dim("."));
        }

        if (attempts >= maxAttempts) {
          console.log(chalk.yellow("\n  Timed out waiting for checks."));
        }
      }
    },
  );

// Request access command
datasetCommand
  .command("request-access")
  .description("Request collaborator access to a dataset")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .addHelpText(
    "after",
    `
Description:
  Request collaborator access to a private NEMAR dataset. The owner is
  notified and can approve or deny; once approved you can push data via
  git-annex.

  Public datasets grant no access here, because the repository is already
  open. Fork it and submit a pull request, or ask the owner for an invite
  if you need merge rights.

Requirements:
  - NEMAR account (nemar auth login)
  - Approved user status

Examples:
  $ nemar dataset request-access nm000104`,
  )
  .action(async (datasetId) => {
    requireAuth();

    const spinner = ora(`Requesting access to ${datasetId}...`).start();

    try {
      const result = await requestDatasetAccess(datasetId);
      if (result.action === "requested") {
        // Private dataset: queued for owner approval.
        spinner.succeed(result.message);
        console.log();
        console.log(
          chalk.dim("The owner will be notified. You'll be able to push once they approve."),
        );
      } else {
        // Public dataset: nothing to grant.
        spinner.info(result.message);
        if (result.github_repo) {
          console.log();
          console.log(`  GitHub: https://github.com/${result.github_repo}`);
        }
      }
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
      } else {
        spinner.fail("Failed to request access");
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      process.exit(1);
    }
  });

// Invite collaborator command
datasetCommand
  .command("invite")
  .description("Invite a user as collaborator to your dataset")
  .argument("<username>", "Username to invite")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .addHelpText(
    "after",
    `
Description:
  Invite a NEMAR user as a collaborator to your dataset.
  Only dataset owners and admins can invite collaborators.

  Works for both public and private repositories.

Requirements:
  - NEMAR account (nemar auth login)
  - Dataset ownership or admin status

Examples:
  $ nemar dataset invite johndoe nm000104`,
  )
  .action(async (username, datasetId) => {
    requireAuth();

    const spinner = ora(`Inviting ${username} to ${datasetId}...`).start();

    try {
      const result = await inviteCollaborator(datasetId, username);
      spinner.succeed(result.message);
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
      } else {
        spinner.fail("Failed to invite user");
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      process.exit(1);
    }
  });

// List collaborators command
datasetCommand
  .command("collaborators")
  .description("List collaborators for a dataset")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .option("--json", "Output as JSON for scripting")
  .addHelpText(
    "after",
    `
Description:
  List all collaborators who have access to a dataset.
  Only dataset owners and admins can view collaborators.

Examples:
  $ nemar dataset collaborators nm000104
  $ nemar dataset collaborators nm000104 --json`,
  )
  .action(async (datasetId, options) => {
    requireAuth();

    const spinner = ora(`Fetching collaborators for ${datasetId}...`).start();

    try {
      const result = await listCollaborators(datasetId);
      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log();
      console.log(chalk.bold(`Collaborators for ${datasetId} (${result.count}):`));
      console.log();

      if (result.collaborators.length === 0) {
        console.log(chalk.dim("  No collaborators yet."));
        console.log();
        console.log(chalk.dim(`Invite users with: nemar dataset invite <username> ${datasetId}`));
        return;
      }

      // Table header
      const header = ["Username", "GitHub", "Access", "Granted"].join("  ");
      console.log(chalk.dim(`  ${header}`));
      console.log(chalk.dim(`  ${"-".repeat(header.length)}`));

      for (const collab of result.collaborators) {
        const grantedDate = new Date(collab.granted_at).toLocaleDateString();
        const accessType = collab.access_type === "invited" ? "invited" : "requested";
        const row = [
          collab.username.padEnd(10),
          `@${collab.github_username}`.padEnd(15),
          accessType.padEnd(10),
          grantedDate,
        ].join("  ");
        console.log(`  ${row}`);
      }
      console.log();
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
      } else {
        spinner.fail("Failed to fetch collaborators");
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      process.exit(1);
    }
  });

// ============================================================================
// Access Requests (owner/admin)
// ============================================================================

const accessCommand = new Command("access").description(
  "Review and decide collaborator access requests (owner/admin)",
);

accessCommand
  .command("list")
  .description("List access requests for a dataset")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .option("--status <status>", "Filter by status: pending, approved, or denied", "pending")
  .option("--json", "Output as JSON for scripting")
  .addHelpText(
    "after",
    `
Description:
  List users who have requested collaborator access to a private dataset.
  Only the dataset owner or an admin can view requests. Defaults to pending.

Examples:
  $ nemar dataset access list nm000104
  $ nemar dataset access list nm000104 --status approved`,
  )
  .action(async (datasetId, options) => {
    requireAuth();

    const status = options.status as string;
    if (!["pending", "approved", "denied"].includes(status)) {
      console.log(chalk.red("Error: --status must be one of pending, approved, denied"));
      process.exit(1);
    }

    const spinner = ora(`Fetching access requests for ${datasetId}...`).start();

    try {
      const result = await listAccessRequests(
        datasetId,
        status as "pending" | "approved" | "denied",
      );
      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log();
      console.log(
        chalk.bold(`Access requests for ${datasetId} (${result.status}): ${result.count}`),
      );
      console.log();

      if (result.requests.length === 0) {
        console.log(chalk.dim("  None."));
        console.log();
        return;
      }

      const header = ["Username", "GitHub", "Status", "Requested"].join("  ");
      console.log(chalk.dim(`  ${header}`));
      console.log(chalk.dim(`  ${"-".repeat(header.length)}`));
      for (const req of result.requests) {
        const reqDate = new Date(req.created_at).toLocaleDateString();
        const row = [
          req.username.padEnd(10),
          `@${req.github_username}`.padEnd(15),
          req.status.padEnd(10),
          reqDate,
        ].join("  ");
        console.log(`  ${row}`);
      }
      console.log();
      if (result.status === "pending" && result.count > 0) {
        console.log(
          chalk.dim(`Approve with: nemar dataset access approve <username> ${datasetId}`),
        );
      }
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
      } else {
        spinner.fail("Failed to fetch access requests");
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      process.exit(1);
    }
  });

accessCommand
  .command("approve")
  .description("Approve a pending access request")
  .argument("<username>", "Username to approve")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .addHelpText(
    "after",
    `
Description:
  Grant a user collaborator (write) access after they requested it.
  Only the dataset owner or an admin can approve.

Examples:
  $ nemar dataset access approve johndoe nm000104`,
  )
  .action(async (username, datasetId) => {
    requireAuth();

    const spinner = ora(`Approving ${username} for ${datasetId}...`).start();
    try {
      const result = await approveAccessRequest(datasetId, username);
      spinner.succeed(result.message);
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
      } else {
        spinner.fail("Failed to approve access request");
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      process.exit(1);
    }
  });

accessCommand
  .command("deny")
  .description("Deny a pending access request")
  .argument("<username>", "Username to deny")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .addHelpText(
    "after",
    `
Description:
  Reject a pending access request. The user is not granted access and may
  request again later. Only the dataset owner or an admin can deny.

Examples:
  $ nemar dataset access deny johndoe nm000104`,
  )
  .action(async (username, datasetId) => {
    requireAuth();

    const spinner = ora(`Denying ${username} for ${datasetId}...`).start();
    try {
      const result = await denyAccessRequest(datasetId, username);
      spinner.succeed(result.message);
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
      } else {
        spinner.fail("Failed to deny access request");
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      process.exit(1);
    }
  });

datasetCommand.addCommand(accessCommand);

// ============================================================================
// Publication Workflow
// ============================================================================

const publishCommand = new Command("publish").description("Publication workflow management");

/** The warning for an anonymous release the server did not echo back as anonymous. */
function printAnonymousNotConfirmed(datasetId: string): void {
  console.log(
    chalk.yellow(
      "\n  WARNING: you asked for an anonymous release, but the server did not confirm it.",
    ),
  );
  console.log(
    chalk.yellow(
      `  Run 'nemar dataset publish status ${datasetId}' and check the Anonymous line before an admin approves it.`,
    ),
  );
}

publishCommand
  .command("request")
  .description("Request publication of a dataset")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .addHelpText(
    "after",
    `
Description:
  Submit a publication request to make your private dataset publicly accessible.
  NEMAR admins will be notified and can approve or deny your request.

  Once approved, your dataset will:
  - Become publicly visible on GitHub
  - Receive a permanent DOI via Zenodo
  - Have tag protection enabled (prevents version manipulation)
  - Have S3 Object Lock enabled (prevents data deletion)

  You can only have one active publication request per dataset.

  BIDS validation runs on GitHub after the upload. A request made before it has
  completed is recorded, and NEMAR continues it once validation passes.
  Check validation with: nemar dataset ci <dataset-id>

Status Flow:
  requested → approving → published (or denied)

Anonymous deposit (--anonymous):
  For submission to a double-blind venue. The data is released exactly as any
  public dataset is -- listed, browsable and downloadable -- while your identity
  is withheld: the repository stays private, the DOI stays reserved, and nothing
  NEMAR publishes names you. Reviewers follow the ordinary dataset URL.

  Blind your own dataset_description.json first (Authors: ["Anonymous"]); NEMAR
  cannot scrub the files you wrote. When the paper is accepted, restore the real
  Authors and request publication again WITHOUT the flag: that is what ends
  anonymity and publishes the record for real.

  Only available before a dataset has ever been published. Retracting an
  attribution that is already public is not something NEMAR can deliver.

Examples:
  $ nemar dataset publish request nm000104
  $ nemar dataset publish request nm000104 --anonymous   # blind, for review
  $ nemar dataset publish status nm000104     # Check request status`,
  )
  .option("--anonymous", "Release the data with your identity withheld until publication")
  .action(async (datasetId, options: { anonymous?: boolean }) => {
    requireAuth();

    const spinner = ora(
      options.anonymous
        ? `Requesting anonymous release for ${datasetId}...`
        : `Requesting publication for ${datasetId}...`,
    ).start();

    try {
      const result = await requestPublication(datasetId, { anonymous: options.anonymous });
      spinner.succeed(result.message);
      // Printed from the server's ECHO, not from the flag that was typed. A
      // request whose body never arrived would otherwise succeed with a
      // message indistinguishable from a correct one, and the depositor would
      // find out when their name appeared on the published record.
      const anonymityUnconfirmed = options.anonymous === true && result.anonymous !== true;
      if (anonymityUnconfirmed) {
        printAnonymousNotConfirmed(datasetId);
      } else if (result.anonymous === true) {
        console.log(
          chalk.dim(
            "\n  Your identity will be withheld: the repository stays private, the DOI stays\n" +
              "  reserved, and NEMAR names nobody until you publish without --anonymous.",
          ),
        );
      }
      // Epic #1610 phase 4: the screen's state as the backend worded it.
      const screen = result.identifier_screen;
      if (screen) {
        console.log();
        for (const line of identifierScreenLines(screen)) console.log(line);
      }
      // What happens next, in neutral words that name no finding, verdict or
      // date warning (ADR 0090, amendment "what an accepted request is told"): the screen runs after
      // this request and its verdict is bound to a commit, so the outcome is
      // read from `publish status` or the mail, never guessed at here. Made
      // from the shared definition rather than read off the response, so every
      // accepted request prints it whatever the Worker's version; a refused
      // one threw above and prints its own text.
      console.log();
      for (const line of publicationRequestNotice(datasetId)) console.log(`  ${line}`);
      // An anonymous release that was not confirmed would be published under
      // the real name, so a script must not read this run as a success.
      if (anonymityUnconfirmed) process.exit(1);
    } catch (error) {
      if (isCiPendingBlock(error)) {
        // Not an error: the request IS recorded, and the server re-checks it
        // and continues once BIDS validation passes. Said in the info style and
        // left to exit 0, so a script does not retry it and a depositor does
        // not read it as a rejection. A validation FAILURE is a different
        // reason and takes the error path below.
        spinner.info(ciPendingHeadline(error.blockReason));
        // The command to run again takes its `--anonymous` from what was
        // typed, never from the server's echo, which may be missing.
        for (const line of ciPendingHint(datasetId, options.anonymous === true)) {
          console.log(line);
        }
        const ciUrl = ciUrlOf(error);
        if (ciUrl) console.log(`  CI: ${ciUrl}`);
        // What was recorded, not what was typed: the recorded request is the
        // one an administrator later approves.
        const recorded = (error.rawBody as { anonymous?: unknown } | undefined)?.anonymous;
        if (options.anonymous && recorded !== true) {
          printAnonymousNotConfirmed(datasetId);
          process.exit(1);
        }
        return;
      }
      if (error instanceof ApiError) {
        spinner.fail(error.message);
        console.log(chalk.dim(`  ${error.message}`));
        if (error.statusCode === 409) {
          console.log(chalk.dim("  Use 'nemar dataset publish resend' to remind admins."));
        } else if (error.statusCode === 403) {
          console.log(chalk.dim("  Only the dataset owner can request publication."));
        } else if (error.statusCode === 422) {
          // Submission-minimums rejection (#1087): print each stated reason
          // and the policy it comes from, so the fix is actionable here.
          const details = error.details as { reasons?: string[]; policy_url?: string } | undefined;
          if (details?.reasons?.length) {
            console.log(`\n  ${chalk.red("Not accepted for publication:")}`);
            for (const reason of details.reasons) {
              console.log(`    ${chalk.red("-")} ${reason}`);
            }
            if (details.policy_url) {
              console.log(chalk.dim(`\n  Policy: ${details.policy_url}`));
            }
            console.log(
              chalk.dim("  Fix the items above, then re-run 'nemar dataset publish request'."),
            );
          }
        }
      } else {
        spinner.fail("Failed to request publication");
        const msg = error instanceof Error ? error.message : String(error);
        console.log(chalk.dim(`  Error details: ${msg}`));
      }
      process.exit(1);
    }
  });

publishCommand
  .command("status")
  .description("Check publication status of a dataset")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .addHelpText(
    "after",
    `
Description:
  Check the status of your publication request and see progress through
  the approval workflow.

Possible Statuses:
  requested  - Waiting for admin review
  approving  - Admin is running the publication process
  published  - Dataset is now public with DOI
  denied     - Request was denied (includes reason)

Steps in Approval Process:
   1. CI check          - Verify BIDS validation passes
   2. Make public       - Change repository visibility
   3. S3 public read    - Grant public read access to S3 data
   4. Tag protection    - Prevent version manipulation
   5. Create DOI        - Create concept DOI (EZID/Zenodo)
   6. Update metadata   - Update from BIDS description
   7. Update README     - Add DOI badge and citation
   8. Create tag        - Create version tag
   9. Create release    - Create GitHub release
  10. Upload to Zenodo  - Upload archive (if Zenodo provider)
  11. Publish DOI       - Make DOI public (permanent)
  12. S3 lock           - Enable Object Lock for data preservation
  13. Generate archive  - Create downloadable zip
  14. Notify user       - Send publication confirmation email

Examples:
  $ nemar dataset publish status nm000104`,
  )
  .action(async (datasetId) => {
    requireAuth();

    const spinner = ora(`Checking publication status for ${datasetId}...`).start();

    try {
      const result = await getPublishStatus(datasetId);
      spinner.stop();

      console.log(`\n${chalk.cyan("Publication Status:")} ${datasetId}\n`);

      const statusColors: Record<string, typeof chalk.green> = {
        published: chalk.green,
        denied: chalk.red,
        approving: chalk.yellow,
      };
      const statusColor = statusColors[result.status] || chalk.dim;

      console.log(`  Status: ${statusColor(result.status)}`);

      // #1408: which of the two runs was recorded. Printed on both values,
      // because a depositor who typed --anonymous needs to see the word before
      // an admin approves, and one who did not needs to see that a stale flag
      // from an earlier request is not about to conceal them.
      if (result.anonymous === true) {
        console.log(
          `  Anonymous: ${chalk.yellow("yes")} ${chalk.dim("(identity withheld; repository stays private, DOI stays reserved)")}`,
        );
      } else if (result.anonymous === false) {
        console.log(
          `  Anonymous: ${chalk.dim("no")} ${chalk.dim("(published under your name, with a resolving DOI)")}`,
        );
      }

      if (result.requested_at) {
        console.log(`  Requested: ${chalk.dim(result.requested_at)}`);
      }
      if (result.requested_by) {
        console.log(`  Requested by: ${chalk.dim(result.requested_by)}`);
      }

      if (result.status === "denied" && result.denied_reason) {
        console.log(`\n  ${chalk.red("Reason:")} ${result.denied_reason}`);
      }

      // A request waiting on validation has had no screen yet, because the
      // screen starts when validation passes and the request is released; the
      // backend words that absence as "NOT RUN for this request", in red, which
      // reads as a fault in a state that is only waiting.
      const pendingReason =
        result.status === "blocked" && isCiPendingReason(result.block_reason)
          ? result.block_reason
          : undefined;
      // Epic #1610 phase 4: the identifier screen, in the backend's words.
      const screenLines = pendingReason ? [] : identifierScreenLines(result.identifier_screen);
      if (screenLines.length > 0) {
        console.log();
        for (const line of screenLines) console.log(line);
      }

      // Blocked requests: surface WHY (e.g. BIDS validation pending/failed) plus
      // the CI link and what to do next. A request that is blocked only because
      // validation has not finished is a pending state, not a failure: it is
      // said the way `publish request` says it (info, not red, no "re-request"
      // from the server's message) and clears on its own once CI passes. Any
      // other reason stays a red block.
      if (pendingReason) {
        console.log(`\n  ${chalk.cyan("ℹ")} ${ciPendingHeadline(pendingReason)}`);
        for (const line of ciPendingHint(datasetId, result.anonymous === true)) console.log(line);
        if (result.ci_url) console.log(`  ${chalk.dim("CI:")} ${result.ci_url}`);
      } else if (result.status === "blocked") {
        if (result.message) {
          console.log(`\n  ${chalk.red("Blocked:")} ${result.message}`);
        } else if (result.block_reason) {
          console.log(`\n  ${chalk.red("Blocked:")} ${result.block_reason}`);
        }
        // Itemized submission-minimums failures persisted at request time
        // (#1087), so the status view stays as specific as the rejection.
        if (result.reasons?.length) {
          for (const reason of result.reasons) {
            console.log(`    ${chalk.red("-")} ${reason}`);
          }
          if (result.policy_url) {
            console.log(chalk.dim(`  Policy: ${result.policy_url}`));
          }
        }
        if (result.ci_url) {
          console.log(`  ${chalk.dim("CI:")} ${result.ci_url}`);
        }
        const again = `nemar dataset publish request ${datasetId}${result.anonymous === true ? " --anonymous" : ""}`;
        console.log(
          chalk.dim(
            `  This re-checks automatically once CI passes; or re-run '${again}' to retry now.`,
          ),
        );
      }

      // Non-blocking pre-screen advisory (#756): a concern to address, but it
      // does NOT block the request (yellow, not red).
      if (result.advisory?.source === "prescreen") {
        console.log(`\n  ${chalk.yellow("Pre-screen advisory")} ${chalk.dim("(non-blocking):")}`);
        for (const reason of result.advisory.reasons) {
          console.log(`    ${chalk.yellow("-")} ${reason}`);
        }
        if (result.advisory.issue_url) {
          console.log(chalk.dim(`    ${result.advisory.issue_url}`));
        }
      }

      if (result.status === "approving") {
        // Source of truth is `shared/publication-steps.ts` (re-exported by
        // src/lib/api/publish.ts), shared with the backend orchestrator.
        // Showing fewer steps here than the backend actually runs (the legacy
        // list missed enrichment_check, version_doi, sync_nemar) made the
        // status display claim "all steps complete" while the backend was
        // still running -- exactly the visibility gap #284 calls out.
        //
        // And showing MORE than it runs is the mirror of that bug (#1447): an
        // anonymous release skips several steps, so rendering all sixteen left
        // this display permanently short of its own total on a release that had
        // finished. Stated without a count on purpose -- the count changed
        // inside this very PR, from 11 to 12, when `version_doi` came off the
        // skip list. `anonymous` is already on the response, printed two lines
        // above, so the right list was in hand and unused.
        const steps = stepsForRelease(result.anonymous === true);
        const completed = result.steps_completed || [];
        const total = steps.length;
        console.log("\n  Steps:");
        steps.forEach((step, idx) => {
          const done = completed.includes(step);
          const isCurrent = result.current_step === step;
          const icon = done
            ? chalk.green("[x]")
            : isCurrent
              ? chalk.yellow("[>]")
              : chalk.dim("[ ]");
          const label = step.replace(/_/g, " ");
          const stepNum = `[${String(idx + 1).padStart(2, " ")}/${total}]`;
          console.log(
            `    ${icon} ${chalk.dim(stepNum)} ${label}${isCurrent && result.last_error ? chalk.red(` (error: ${result.last_error})`) : ""}`,
          );
        });
      }

      if (result.status === "published" && result.approved_at) {
        console.log(`  Published: ${chalk.dim(result.approved_at)}`);
      }

      console.log();
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
        console.log(chalk.dim(`  ${error.message}`));
      } else {
        spinner.fail("Failed to check publication status");
        const msg = error instanceof Error ? error.message : String(error);
        console.log(chalk.dim(`  Error details: ${msg}`));
      }
      process.exit(1);
    }
  });

publishCommand
  .command("resend")
  .description("Resend publication request notification to admins")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .addHelpText(
    "after",
    `
Description:
  Resend the publication request notification email to all NEMAR admins.
  Use this if admins haven't responded to your original request.

  This does NOT create a duplicate request - it only sends a reminder
  email for your existing publication request.

When to Use:
  - Admins haven't responded after several days
  - You want to remind admins about your pending request
  - Your request status is still "requested"

Examples:
  $ nemar dataset publish resend nm000104`,
  )
  .action(async (datasetId) => {
    requireAuth();

    const spinner = ora(`Resending notification for ${datasetId}...`).start();

    try {
      const result = await resendPublishNotification(datasetId);
      spinner.succeed(result.message);
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
        console.log(chalk.dim(`  ${error.message}`));
        if (error.statusCode === 404) {
          console.log(chalk.dim("  Publication request not found for this dataset."));
        }
      } else {
        spinner.fail("Failed to resend notification");
        const msg = error instanceof Error ? error.message : String(error);
        console.log(chalk.dim(`  Error details: ${msg}`));
      }
      process.exit(1);
    }
  });

datasetCommand.addCommand(publishCommand);

// Clone command
datasetCommand
  .command("clone")
  .description("Clone a dataset from NEMAR")
  .argument("<dataset-id>", "Dataset ID (e.g., nm000104)")
  .option("-o, --output <path>", "Output directory (default: ./<dataset-id>)")
  .addHelpText(
    "after",
    `
Description:
  Clone a NEMAR dataset repository with git-annex initialized.
  Data files are not downloaded; use 'nemar dataset get' afterward.

  Private datasets require authentication (nemar auth login) and are
  only accessible to the owner or designated collaborators.

Requirements:
  - git-annex installed
  - NEMAR account (for private datasets)

Examples:
  $ nemar dataset clone nm000104
  $ nemar dataset clone nm000104 -o ./my-dataset`,
  )
  .action(async (datasetId, options) => {
    // Check required tools first
    await checkPrerequisitesForCommand("clone");

    let spinner = ora("Checking prerequisites...").start();
    const prereqs = await checkDownloadPrerequisites();

    if (!prereqs.allPassed) {
      spinner.fail("Prerequisites check failed");
      for (const error of prereqs.errors) {
        console.log(chalk.red(`  - ${error}`));
      }
      process.exit(1);
    }
    spinner.succeed("Prerequisites OK");

    // Resolve dataset ID to repo URL
    spinner = ora(`Resolving dataset ${datasetId}...`).start();
    let repoUrl: string;
    let datasetVisibility: string;
    try {
      const dataset = await getDataset(datasetId);
      if (!dataset.github_repo || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(dataset.github_repo)) {
        spinner.fail("Dataset has no valid GitHub repository");
        console.log(chalk.red(`  Received: ${dataset.github_repo || "(empty)"}`));
        process.exit(1);
      }
      repoUrl = `https://github.com/${dataset.github_repo}.git`;
      datasetVisibility = dataset.visibility;
      spinner.succeed(`Found: ${dataset.name}`);
    } catch (error) {
      if (error instanceof ApiError && (error.statusCode === 404 || error.statusCode === 400)) {
        spinner.fail(`Dataset ${datasetId} not found`);
        console.log(chalk.red(`Error: Dataset ${datasetId} not found`));
        console.log(chalk.dim(`  ${error.message}`));
      } else if (
        error instanceof ApiError &&
        (error.statusCode === 401 || error.statusCode === 403)
      ) {
        spinner.fail("Not authorized");
        console.log(chalk.red(`Error: Not authorized to access dataset ${datasetId}`));
        console.log(chalk.dim("  Run 'nemar auth login' to authenticate."));
      } else if (error instanceof ApiError) {
        spinner.fail("Failed to resolve dataset");
        console.log(chalk.red(`Error: ${error.message}`));
      } else {
        spinner.fail("Failed to resolve dataset");
        const msg = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`Error: ${msg}`));
      }
      process.exit(1);
    }

    const outputPath = resolve(options.output || datasetId);
    if (existsSync(outputPath)) {
      console.log(chalk.red(`Error: Path already exists: ${outputPath}`));
      process.exit(1);
    }

    // For private datasets, fetch temporary S3 download credentials.
    const cloneS3Creds = await fetchPrivateDatasetCreds(datasetId, datasetVisibility);

    spinner = ora("Cloning dataset...").start();
    const result = await cloneDataset(repoUrl, outputPath);
    if (!result.success) {
      spinner.fail("Clone failed");
      console.log(chalk.red(`  ${result.error}`));
      process.exit(1);
    }

    spinner.succeed("Dataset cloned");

    // Enable S3 remote if available (new datasets have it; old ones use web URLs)
    const s3Enable = await enableS3Remote(outputPath, "nemar-s3", cloneS3Creds);
    if (s3Enable.enabled) {
      console.log(chalk.dim("  S3 remote enabled for data downloads"));
    } else if (!s3Enable.success) {
      console.log(chalk.yellow(`  Warning: Could not enable S3 remote: ${s3Enable.error}`));
    }

    // Clear cached credentials to prevent stale STS tokens
    if (cloneS3Creds) {
      await clearAnnexCredentials(outputPath);
    }

    console.log();
    console.log(`  Location: ${chalk.cyan(outputPath)}`);
    console.log();
    console.log(chalk.dim("Data files are not downloaded yet. To get them:"));
    console.log(chalk.dim(`  cd ${outputPath}`));
    console.log(chalk.dim("  nemar dataset get"));
  });

// Get command
datasetCommand
  .command("get")
  .description("Download annexed data files for the current dataset")
  .argument("[files...]", "Specific files/paths to get (default: all)")
  .option("-j, --jobs <number>", "Parallel download streams", "4")
  .option("--stimuli", "Include stimuli/ content (skipped by default; can be large)")
  .option("--derivatives", "Include derivatives/ content (skipped by default; can be large)")
  .option(
    "--skip-port-check",
    "Skip the porting-in-progress check (use if falsely blocked on an OpenNeuro-sourced dataset)",
  )
  .option(
    "--require-complete",
    "Exit non-zero if any file is unavailable from the archive (for strict pipelines)",
  )
  .option(
    "--no-verify",
    "Skip git-annex checksum verification for this run only (size is still checked)",
  )
  .addHelpText(
    "after",
    `
Description:
  Download data files from the remote for a cloned dataset.
  Must be run inside a git-annex dataset directory.

  For private datasets, credentials are fetched automatically
  if you are logged in (nemar auth login).

  By default, content under stimuli/ and derivatives/ is skipped because
  these folders can be very large. Pass --stimuli or --derivatives to
  fetch them. When you supply explicit file paths, the path itself is
  treated as the filter and the default-skip is not applied.

  --no-verify runs git-annex with checksum verification off for this call
  only (never written to git config), trading the hash check for speed on a
  trusted link. Size is still checked: a truncated or wrong-size file is
  still rejected, but wrong content at the right size is not caught.

Examples:
  $ nemar dataset get                       # Get all files (skips stimuli/derivatives)
  $ nemar dataset get --stimuli             # Get all files including stimuli/
  $ nemar dataset get --stimuli --derivatives  # Get everything
  $ nemar dataset get sub-01/eeg/           # Get specific directory
  $ nemar dataset get stimuli/              # Explicit path: fetches stimuli/
  $ nemar dataset get *.edf -j 8            # Get EDF files with 8 streams
  $ nemar dataset get --no-verify           # Skip checksum verification (size still checked)`,
  )
  .action(async (files, options) => {
    const cwd = process.cwd();

    if (!(await isGitAnnexDataset(cwd))) {
      console.log(chalk.red("Error: Not inside a git-annex dataset directory"));
      console.log(chalk.dim("Use 'nemar dataset clone <id>' first, then cd into the dataset."));
      process.exit(1);
    }

    const jobs = Number.parseInt(options.jobs, 10);
    if (Number.isNaN(jobs) || jobs < 1) {
      console.log(chalk.red("Error: --jobs must be a positive integer"));
      process.exit(1);
    }

    // Detect dataset ID and check if private (needs authenticated S3 creds)
    let getCreds: Awaited<ReturnType<typeof requestDownloadCredentials>> | null = null;
    const getDatasetId = await getDatasetIdFromRemote(cwd);
    if (getDatasetId) {
      let dsInfo: Awaited<ReturnType<typeof getDataset>> | null = null;
      let apiReachable = true;
      try {
        dsInfo = await getDataset(getDatasetId);
      } catch (err) {
        // Only fall through to offline mode for true network failures (statusCode 0).
        // Auth and authorization failures must surface so the user can re-login;
        // silencing them produced cryptic git-annex errors instead of "run nemar auth login".
        if (err instanceof ApiError && err.statusCode !== 0) {
          if (err.statusCode === 401 || err.statusCode === 403) {
            console.log(chalk.red(`✖ ${err.message}`));
            console.log(chalk.dim("  Run 'nemar auth login' or 'nemar auth regenerate-key'."));
            process.exit(1);
          }
          throw err;
        }
        apiReachable = false;
      }

      // OpenNeuro-sourced datasets only get their git-annex S3 objects after
      // the import workflow's final push (which carries the .nemar/metadata.json
      // commit). If the marker commit is missing locally, the porting matrix
      // job is still mid-flight — `git annex get` will fail with a cryptic
      // "remote unavailable" error. Bail early with a clear retry hint.
      // See nemarOrg/nemar-cli#460.
      //
      // When the API is unreachable, fall back to reading source from the local
      // .nemar/metadata.json so the check still works offline.
      if (!options.skipPortCheck) {
        let isOpenNeuroDerived = dsInfo?.source === "openneuro";
        if (!apiReachable && !isOpenNeuroDerived) {
          const localMeta = join(cwd, ".nemar", "metadata.json");
          if (existsSync(localMeta)) {
            try {
              const parsed = JSON.parse(readFileSync(localMeta, "utf-8")) as {
                source?: string;
              };
              isOpenNeuroDerived = parsed.source === "openneuro";
            } catch {
              // Malformed local metadata; skip port check
            }
          }
        }
        if (isOpenNeuroDerived) {
          const marker = await detectImportMarker(cwd);
          // "unknown" = git unavailable or non-git dir; skip port check and let git-annex handle it
          if (marker === "absent") {
            console.log(chalk.yellow("Porting still in progress."));
            console.log(
              chalk.dim(
                "  This dataset is being imported from OpenNeuro. Data files are not yet available.",
              ),
            );
            console.log(chalk.dim("  Wait 5–30 minutes (depending on dataset size), then retry."));
            console.log(chalk.dim("  Run 'nemar dataset status <id>' to track progress."));
            console.log(
              chalk.dim(
                "  Pass --skip-port-check to bypass this check if you are certain porting is complete.",
              ),
            );
            process.exit(1);
          }
        }
      }

      if (dsInfo && dsInfo.visibility !== "public") {
        if (!isAuthenticated()) {
          console.log(chalk.red("Error: This is a private dataset. Authentication required."));
          console.log(chalk.dim("Run 'nemar auth login' first."));
          process.exit(1);
        }
        const credSpinner = ora("Requesting download credentials...").start();
        try {
          getCreds = await requestDownloadCredentials(getDatasetId);
          credSpinner.succeed("Download credentials received (2h expiry)");
        } catch (error) {
          credSpinner.fail("Failed to get download credentials");
          console.log(chalk.red(`  ${(error as Error).message}`));
          console.log(
            chalk.dim("Private datasets require authentication. Run 'nemar auth login' first."),
          );
          process.exit(1);
        }
      }
    }

    const getS3Creds = getCreds ? toS3Credentials(getCreds.credentials) : undefined;

    // Enable S3 remote if available (idempotent)
    const s3Enable = await enableS3Remote(cwd, "nemar-s3", getS3Creds);
    if (!s3Enable.success && !s3Enable.enabled) {
      console.log(chalk.yellow(`  Warning: Could not enable S3 remote: ${s3Enable.error}`));
    }

    const paths = files.length > 0 ? files : undefined;

    const filter = chooseGetFilter(paths, {
      stimuli: options.stimuli,
      derivatives: options.derivatives,
    });
    const matchArgs = filter.args.length > 0 ? filter.args : undefined;

    // Print skip/summary lines first so the user sees them even when the
    // filtered precount is empty (e.g., a dataset whose only annex content
    // lives under stimuli/).
    for (const line of filter.summary) {
      console.log(chalk.dim(`  ${line}`));
    }

    // Pre-count pending files+bytes scoped to the same paths the get will use.
    const pending = await countPendingDownload(cwd, paths, matchArgs);

    if (pending && pending.fileCount === 0) {
      console.log(chalk.green("All data files already present"));
      if (getCreds) {
        await clearAnnexCredentials(cwd);
      }
      return;
    }

    const desc = paths
      ? `Getting ${paths.length} path(s)${pending ? ` (${pending.fileCount} files, ${formatBytesCli(pending.totalBytes)})` : ""}...`
      : `Getting all data files${pending ? ` (${pending.fileCount} files, ${formatBytesCli(pending.totalBytes)})` : ""}...`;
    console.log(chalk.bold(desc));

    const tracker = new DownloadProgressTracker(pending?.fileCount ?? 0, pending?.totalBytes ?? 0);

    // See the download command's identical comment: Commander negates
    // `--no-verify` onto an implicit `verify` default of true.
    const noVerify = options.verify === false;

    const result = await getDatasetData(cwd, {
      jobs,
      paths,
      credentials: getS3Creds,
      extraArgs: matchArgs,
      requireComplete: Boolean(options.requireComplete),
      noVerify,
      onProgress: (line) => tracker.processLine(line),
    });
    if (!result.success) {
      // Counts are honest on the failure arm too: --require-complete can fail
      // a run that still landed files, and the tracker should say so.
      tracker.finish(result.filesDownloaded);
      console.log(chalk.red(`  ${result.error}`));
      // Print before exiting: a no-verify mismatch is carried on every
      // outcome arm (#1525 review round 3), and this is the failure arm.
      printNoVerifyMismatches(result.noVerifyMismatches);
      if (getCreds) {
        await clearAnnexCredentials(cwd);
      }
      process.exit(1);
    }

    tracker.finish(result.filesDownloaded);

    // Clear cached S3 credentials so future operations request fresh tokens
    if (getCreds) {
      await clearAnnexCredentials(cwd);
    }

    if (result.outcome === "partial") {
      printPartialRetrieval(result);
    } else if (result.filesDownloaded === 0) {
      console.log(chalk.green("All data files already present"));
    } else {
      console.log(chalk.green(`Downloaded ${result.filesDownloaded} file(s)`));
    }
    printNoVerifyMismatches(result.noVerifyMismatches);
    if (noVerify) printNoVerifyNotice(result.unsizedFiles);
  });

// Shared action handler for commit/save
async function commitAction(options: { message: string }) {
  const cwd = process.cwd();

  if (!(await isGitAnnexDataset(cwd))) {
    console.log(chalk.red("Error: Not inside a git-annex dataset directory"));
    process.exit(1);
  }

  const spinner = ora("Saving changes...").start();
  const result = await saveDataset(cwd, options.message);

  if (!result.success) {
    spinner.fail("Save failed");
    console.log(chalk.red(`  ${result.error}`));
    process.exit(1);
  }

  spinner.succeed("Changes saved");
}

// Commit command
datasetCommand
  .command("commit")
  .description("Stage and commit changes in the current dataset")
  .option("-m, --message <msg>", "Commit message", "Save changes")
  .addHelpText(
    "after",
    `
Description:
  Stage all changes (git add -A) and commit them. Large files are
  automatically handled by git-annex based on the dataset's largefiles config.

Tip:
  After committing, use 'nemar dataset push' for private datasets
  or 'nemar dataset update' for public datasets.

Examples:
  $ nemar dataset commit
  $ nemar dataset commit -m "Add new EEG recordings"`,
  )
  .action(commitAction);

// Save command (alias for commit)
datasetCommand
  .command("save")
  .description("Stage and commit changes (alias for commit)")
  .option("-m, --message <msg>", "Commit message", "Save changes")
  .addHelpText(
    "after",
    `
Description:
  Stage all changes (git add -A) and commit them. Large files are
  automatically handled by git-annex based on the dataset's largefiles config.

  This command is an alias for 'nemar dataset commit'.

Tip:
  After committing, use 'nemar dataset push' for private datasets
  or 'nemar dataset update' for public datasets.

Examples:
  $ nemar dataset save
  $ nemar dataset save -m "Add new EEG recordings"`,
  )
  .action(commitAction);

function printBranchProtectionSuggestions(): void {
  console.log("  Options:");
  console.log(`    ${chalk.cyan("nemar dataset update")}          Update via PR (recommended)`);
  console.log(`    ${chalk.cyan("nemar dataset push --pr")}       Push branch + create PR`);
}

// Push command
datasetCommand
  .command("push")
  .description("Push commits and data to remotes")
  .option("-j, --jobs <number>", "Parallel upload streams for S3", "4")
  .option("--no-s3", "Skip pushing data to S3 remote")
  .option("--pr", "Create a pull request after pushing")
  .option("-t, --title <title>", "Pull request title (with --pr)")
  .option("-b, --body <body>", "Pull request body (with --pr)")
  .addHelpText(
    "after",
    `
Description:
  Push git commits to GitHub (main + git-annex branches) and optionally
  copy annexed data to the S3 remote.

  With --pr, creates a pull request after pushing the current branch.

  S3 push uses temporary credentials from the NEMAR API. Falls back to
  environment AWS credentials if not logged in.

Note:
  Direct push to main works for private datasets only. For public
  datasets with branch protection, use 'nemar dataset update' instead,
  or use 'push --pr' to push to a branch and create a PR.

Examples:
  $ nemar dataset push
  $ nemar dataset push --no-s3      # Git only, skip S3
  $ nemar dataset push -j 8         # More parallel S3 streams
  $ nemar dataset push --pr -t "Add new recordings"`,
  )
  .action(async (options) => {
    const cwd = process.cwd();

    await checkPrerequisitesForCommand("push");

    if (!(await isGitAnnexDataset(cwd))) {
      console.log(chalk.red("Error: Not inside a git-annex dataset directory"));
      process.exit(1);
    }

    // Public datasets have branch protection enabled; warn early instead of a cryptic git error
    const currentBranchName = await getCurrentBranch(cwd);
    const isOnMain =
      currentBranchName === "main" ||
      currentBranchName === "master" ||
      (currentBranchName?.startsWith("adjusted/main") ?? false);
    if (isOnMain && !options.pr) {
      const pushDatasetIdCheck = await getDatasetIdFromRemote(cwd);
      if (pushDatasetIdCheck && isAuthenticated()) {
        try {
          const dsInfo = await getDataset(pushDatasetIdCheck);
          if (dsInfo.visibility === "public") {
            console.log(chalk.red("Error: This dataset is public with branch protection."));
            console.log(chalk.red("  Direct push to main is not allowed."));
            printBranchProtectionSuggestions();
            process.exit(1);
          }
        } catch {
          // API call failed (network, 404, etc.); fall through and let git report errors
        }
      }
    }

    // Push git to GitHub
    let spinner = ora("Pushing to GitHub...").start();
    const gitResult = await pushToGitHub(cwd);

    if (!gitResult.success) {
      const err = gitResult.error || "";
      if (err.includes("protected branch") || err.includes("GH006")) {
        spinner.fail("Push rejected: branch protection is enabled");
        console.log();
        console.log("  Public datasets require changes via pull request.");
        printBranchProtectionSuggestions();
      } else if (err.includes("terminal prompts disabled")) {
        spinner.fail("Git push failed: authentication required");
        console.log();
        console.log("  Run 'nemar auth setup-ssh' to configure SSH authentication.");
      } else {
        spinner.fail("Git push failed");
        console.log(chalk.red(`  ${err}`));
      }
      process.exit(1);
    }

    if (gitResult.warning) {
      spinner.warn("Git pushed with warning");
      console.log(chalk.yellow(`  ${gitResult.warning}`));
    } else {
      spinner.succeed("Pushed to GitHub");
    }

    // Push annex content to S3 (if enabled and remote exists)
    let s3PushFailed = false;
    if (options.s3 !== false) {
      const s3Remotes = await getAnnexS3Remotes(cwd);
      const remoteName = await selectAnnexS3Remote(cwd, s3Remotes);
      if (remoteName) {
        if (s3Remotes.length > 1) {
          const others = s3Remotes.filter((r) => r !== remoteName).join(", ");
          console.log(
            chalk.dim(`  Multiple S3 remotes available; using ${remoteName} (skipped: ${others})`),
          );
        }
        const jobs = Number.parseInt(options.jobs, 10);
        if (Number.isNaN(jobs) || jobs < 1) {
          console.log(chalk.red("Error: --jobs must be a positive integer"));
          process.exit(1);
        }

        // Get STS credentials for S3 upload
        const pushDatasetId = await getDatasetIdFromRemote(cwd);
        let pushCreds: Awaited<ReturnType<typeof requestUploadCredentials>> | null = null;
        let credPermissionDenied = false;
        if (pushDatasetId && isAuthenticated()) {
          spinner = ora("Requesting upload credentials...").start();
          try {
            pushCreds = await requestUploadCredentials(pushDatasetId);
            spinner.succeed("Upload credentials received");
          } catch (credError) {
            // The backend returns 403 when the user is authenticated but is not
            // a NEMAR collaborator on this dataset. Detect that and call
            // request-access once. Under the publish-gated model (epic #713)
            // this no longer auto-grants: a public dataset needs an invite (or a
            // PR), and a private dataset queues a request for the owner to
            // approve — so the push cannot complete in this run; we report the
            // next step instead of retrying credentials that will still 403.
            const isCollaboratorError =
              credError instanceof ApiError &&
              credError.statusCode === 403 &&
              /collaborator/i.test(credError.message);
            if (isCollaboratorError) {
              spinner.text = "Requesting collaborator access...";
              try {
                const accessResult = await requestDatasetAccess(pushDatasetId);
                if (accessResult.action === "requested") {
                  spinner.fail("Upload requires collaborator access");
                  console.log(
                    chalk.yellow(
                      `  Access request submitted for ${pushDatasetId}; the owner must approve it before you can push. Retry once approved.`,
                    ),
                  );
                } else {
                  spinner.fail("Upload requires write access");
                  console.log(
                    chalk.yellow(
                      `  ${pushDatasetId} is public; ask the owner to invite you ('nemar dataset invite') for write access, or fork and open a PR.`,
                    ),
                  );
                }
              } catch (retryError) {
                spinner.fail(`Could not request access: ${errorDetail(retryError)}`);
              }
              credPermissionDenied = true;
            } else {
              spinner.warn(
                `Could not get upload credentials: ${errorDetail(credError)}. Falling back to environment credentials.`,
              );
            }
          }
        }

        if (credPermissionDenied) {
          s3PushFailed = true;
        } else {
          const s3Creds = pushCreds ? toS3Credentials(pushCreds.credentials) : undefined;

          if (!pushCreds) {
            const hasAwsId = Boolean(process.env.AWS_ACCESS_KEY_ID);
            const hasAwsSecret = Boolean(process.env.AWS_SECRET_ACCESS_KEY);
            if (!hasAwsId || !hasAwsSecret) {
              console.log(
                chalk.yellow(
                  `  No NEMAR credentials and AWS env vars are missing (AWS_ACCESS_KEY_ID=${
                    hasAwsId ? "set" : "unset"
                  }, AWS_SECRET_ACCESS_KEY=${hasAwsSecret ? "set" : "unset"}).`,
                ),
              );
            }
          }

          spinner = ora(`Copying data to S3 (${remoteName})...`).start();
          let s3Result: Awaited<ReturnType<typeof copyToAnnexRemote>>;
          try {
            s3Result = await copyToAnnexRemote(cwd, remoteName, jobs, s3Creds);
          } finally {
            // Always clear STS creds from .git/annex/creds/ once the copy
            // subprocess exits, regardless of outcome. Otherwise an interrupted
            // upload leaves expired credentials on disk that fail later reads.
            if (pushCreds) await clearAnnexCredentials(cwd);
          }
          if (!s3Result.success) {
            spinner.fail("S3 push failed");
            console.log(chalk.red(`  ${s3Result.error}`));
            console.log(
              chalk.yellow(
                "  Git changes were pushed successfully; data upload can be retried later with 'nemar dataset push --no-pr'.",
              ),
            );
            s3PushFailed = true;
          } else {
            spinner.succeed(`Copied ${s3Result.filesCopied} file(s) to S3`);

            // git annex copy writes new location records to the local git-annex
            // branch. The pushToGitHub at the start of this action pushed the
            // branch as it stood then; those new commits have to be pushed
            // separately or fresh clones won't know the S3 copies exist.
            const annexPushSpinner = ora("Pushing git-annex branch...").start();
            const annexPush = await pushAnnexBranchToGitHub(cwd, "origin");
            if (!annexPush.success) {
              annexPushSpinner.warn(
                `Could not push git-annex branch: ${annexPush.error || "unknown error"}`,
              );
              console.log(
                chalk.yellow(
                  "  The checked annex push was refused. Resolve the reported issue before retrying; do not push the branch manually.",
                ),
              );
              s3PushFailed = true;
            } else {
              annexPushSpinner.succeed("Pushed git-annex branch");
            }
          }
        }
      } else {
        console.log(chalk.dim("  No usable S3 remote configured; skipping data push."));
      }
    }

    // Create PR if --pr flag is set
    if (options.pr) {
      const branch = await getCurrentBranch(cwd);
      if (!branch) {
        console.log(chalk.red("  Could not determine current branch"));
        console.log(chalk.dim("  Ensure you are inside a valid git repository."));
        process.exit(1);
      }
      if (branch === "main" || branch === "master") {
        console.log(chalk.yellow("  Skipping PR: already on main branch"));
      } else {
        spinner = ora("Creating pull request...").start();
        const prArgs = ["gh", "pr", "create"];
        if (options.title) {
          prArgs.push("--title", options.title);
        } else {
          prArgs.push("--title", `Update from branch ${branch}`);
        }
        if (options.body) {
          prArgs.push("--body", options.body);
        } else {
          prArgs.push("--body", "");
        }

        try {
          const proc = spawn({
            cmd: prArgs,
            cwd,
            env: process.env,
            stdout: "pipe",
            stderr: "pipe",
          });
          const prStdout = await new Response(proc.stdout).text();
          const prStderr = await new Response(proc.stderr).text();
          const prExit = await proc.exited;

          if (prExit !== 0) {
            spinner.fail("Failed to create pull request");
            console.log(chalk.red(`  ${prStderr.trim() || prStdout.trim()}`));
            process.exit(1);
          }

          const prUrl = prStdout.trim();
          spinner.succeed("Pull request created");
          console.log(`  ${chalk.cyan(prUrl)}`);
        } catch (spawnError) {
          spinner.fail("Failed to create pull request");
          const msg = spawnError instanceof Error ? spawnError.message : String(spawnError);
          if (msg.includes("ENOENT") || msg.includes("not found")) {
            console.log(chalk.red("  'gh' CLI is not installed or not in PATH"));
            console.log(chalk.dim("  Install it: https://cli.github.com/"));
          } else {
            console.log(chalk.red(`  ${msg}`));
          }
          process.exit(1);
        }
      }
    }

    // Surface the partial-failure exit code so callers and CI scripts can tell
    // that data didn't ship even when git push (and optionally PR creation)
    // succeeded. With --pr the PR is already open at this point, so users see
    // both the URL and the nonzero exit.
    if (s3PushFailed) process.exit(1);
  });

// Drop command
datasetCommand
  .command("drop")
  .description("Free local copies of annexed files (keeps remote copies)")
  .argument("[files...]", "Specific files to drop (default: all)")
  .addHelpText(
    "after",
    `
Description:
  Remove local copies of annexed data files. Git-annex verifies that
  remote copies exist before dropping. Use 'nemar dataset get' to
  re-download later.

Examples:
  $ nemar dataset drop                   # Drop all local data
  $ nemar dataset drop sub-01/eeg/       # Drop specific directory
  $ nemar dataset drop *.edf             # Drop EDF files`,
  )
  .action(async (files) => {
    const cwd = process.cwd();

    if (!(await isGitAnnexDataset(cwd))) {
      console.log(chalk.red("Error: Not inside a git-annex dataset directory"));
      process.exit(1);
    }

    const paths = files.length > 0 ? files : undefined;
    const desc = paths ? `Dropping ${paths.length} path(s)...` : "Dropping all local data...";
    const spinner = ora(desc).start();

    const result = await dropFiles(cwd, paths);
    if (!result.success && result.dropped === 0) {
      spinner.fail("Drop failed");
      console.log(chalk.red(`  ${result.error}`));
      process.exit(1);
    }

    if (result.kept.length > 0) {
      spinner.warn(
        `Dropped ${result.dropped} file(s), ${result.kept.length} kept (no remote copy)`,
      );
      for (const f of result.kept.slice(0, 5)) {
        console.log(chalk.yellow(`  kept: ${f}`));
      }
      if (result.kept.length > 5) {
        console.log(chalk.yellow(`  ... and ${result.kept.length - 5} more`));
      }
      if (result.error) {
        console.log(chalk.dim(`  ${result.error}`));
      }
      process.exit(1);
    } else {
      spinner.succeed(`Dropped ${result.dropped} file(s)`);
    }
  });

// CI command
datasetCommand
  .command("ci")
  .description("Check BIDS validation CI status for the current dataset")
  .argument("[dataset-id]", "Dataset ID (auto-detected from git remote if omitted)")
  .addHelpText(
    "after",
    `
Description:
  Show the status of the BIDS validation CI workflow for a dataset.
  When run inside a cloned dataset, the dataset ID is auto-detected
  from the git remote URL.

Examples:
  $ nemar dataset ci              # Auto-detect from CWD
  $ nemar dataset ci nm000104     # Explicit dataset ID`,
  )
  .action(async (datasetId) => {
    requireAuth();

    // Resolve dataset ID
    let resolvedId = datasetId;
    if (!resolvedId) {
      const cwd = process.cwd();
      if (await isGitAnnexDataset(cwd)) {
        resolvedId = await getDatasetIdFromRemote(cwd);
      }
      if (!resolvedId) {
        console.log(chalk.red("Error: Could not detect dataset ID from current directory"));
        console.log(chalk.dim("Provide dataset ID explicitly: nemar dataset ci <id>"));
        process.exit(1);
      }
    }

    const spinner = ora(`Checking CI status for ${resolvedId}...`).start();

    try {
      const result = await getUserCiStatus(resolvedId);
      spinner.stop();

      console.log(chalk.bold(`CI Status: ${resolvedId}`));
      console.log();

      const { bids_validation } = result;
      if (!bids_validation.present) {
        console.log(`  BIDS Validation: ${chalk.dim("not configured")}`);
        console.log(chalk.dim(`  Ask an admin to run: nemar admin ci add ${resolvedId}`));
      } else {
        const statusColor =
          bids_validation.status === "success"
            ? chalk.green
            : bids_validation.status === "failure"
              ? chalk.red
              : chalk.yellow;
        console.log(`  BIDS Validation: ${statusColor(bids_validation.status)}`);
        if (bids_validation.url) {
          console.log(`  Latest run: ${chalk.cyan(bids_validation.url)}`);
        }
      }
      console.log();
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
      } else {
        spinner.fail("Failed to check CI status");
        const msg = error instanceof Error ? error.message : String(error);
        console.log(chalk.dim(`  ${msg}`));
      }
      process.exit(1);
    }
  });

// Manifest command
datasetCommand
  .command("manifest")
  .description("View version manifests for a dataset")
  .argument("[version]", "Version to view (lists available if omitted)")
  .option("-d, --dataset <id>", "Dataset ID (auto-detected from git remote if omitted)")
  .option("--json", "Output raw JSON")
  .addHelpText(
    "after",
    `
Description:
  View version manifests that map file paths to S3 annex keys.
  Manifests are generated when a version DOI is published.

  When run inside a dataset directory, the dataset ID is auto-detected.

Examples:
  $ nemar dataset manifest                    # List available versions
  $ nemar dataset manifest v1.0.0             # View specific version
  $ nemar dataset manifest v1.0.0 --json      # Raw JSON output
  $ nemar dataset manifest -d nm000104        # Explicit dataset ID`,
  )
  .action(async (version, options) => {
    requireAuth();

    // Resolve dataset ID
    let datasetId = options.dataset;
    if (!datasetId) {
      const cwd = process.cwd();
      if (await isGitAnnexDataset(cwd)) {
        datasetId = await getDatasetIdFromRemote(cwd);
      }
      if (!datasetId) {
        console.log(chalk.red("Error: Could not detect dataset ID"));
        console.log(chalk.dim("Provide dataset ID: nemar dataset manifest -d <id>"));
        process.exit(1);
      }
    }

    const spinner = ora("Fetching manifest info...").start();

    try {
      if (!version) {
        // List available versions
        const result = await listManifestVersions(datasetId);
        spinner.stop();

        console.log(chalk.bold(`Manifests: ${datasetId}`));
        console.log();

        if (result.versions.length === 0) {
          console.log(chalk.dim("  No manifests available yet."));
          console.log(chalk.dim("  Manifests are generated when a version DOI is published."));
        } else {
          for (const v of result.versions) {
            console.log(`  ${chalk.cyan(v)}`);
          }
        }
        console.log();
      } else {
        // Get specific manifest
        const manifest = await getManifest(datasetId, version);
        spinner.stop();

        if (options.json) {
          console.log(JSON.stringify(manifest, null, 2));
        } else {
          console.log(chalk.bold(`Manifest: ${datasetId} ${manifest.version}`));
          if (manifest.doi) {
            console.log(`  DOI: ${chalk.cyan(manifest.doi)}`);
          }
          if (manifest.concept_doi) {
            console.log(`  Concept DOI: ${chalk.dim(manifest.concept_doi)}`);
          }
          console.log(`  Created: ${manifest.created}`);
          console.log();

          const fileEntries = Object.entries(manifest.files);
          const annexed = fileEntries.filter(([, f]) => !f.key.startsWith("git:"));
          const gitFiles = fileEntries.filter(([, f]) => f.key.startsWith("git:"));

          if (annexed.length > 0) {
            console.log(chalk.bold(`  Annexed files (${annexed.length}):`));
            for (const [path, file] of annexed) {
              const sizeStr = formatBytesCli(file.size);
              console.log(`    ${path} ${chalk.dim(`(${sizeStr})`)}`);
            }
          }

          if (gitFiles.length > 0) {
            console.log();
            console.log(chalk.bold(`  Metadata files (${gitFiles.length}):`));
            for (const [path, file] of gitFiles) {
              const sizeStr = formatBytesCli(file.size);
              console.log(`    ${path} ${chalk.dim(`(${sizeStr})`)}`);
            }
          }
          console.log();
        }
      }
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
      } else {
        spinner.fail("Failed to fetch manifest");
        const msg = error instanceof Error ? error.message : String(error);
        console.log(chalk.dim(`  ${msg}`));
      }
      process.exit(1);
    }
  });

/**
 * The last anonymity verdict, as `nemar dataset status` shows it (#1409).
 *
 * The sweep's notification mail tells both audiences to run this command, so
 * this is what makes that instruction true. Served only to the owner and to an
 * admin; everyone else gets nulls from the API and sees nothing here.
 *
 * `unchecked` is printed on EVERY verdict, including `verified`. A reader of
 * "verified" is entitled to know what that word does not cover -- signal
 * headers always, sub-directory sidecars whenever there are any -- and a
 * verdict that hid its own scope would be the overstatement ADR 0067 forbids.
 */
function renderAnonymityVerdict(info: {
  anonymity_status?: string | null;
  anonymity_checked_at?: string | null;
  anonymity_findings?: string | null;
  anonymity_unchecked?: string | null;
}): void {
  if (!info.anonymity_status) return;
  const parseList = (raw: string | null | undefined): unknown[] => {
    if (!raw) return [];
    try {
      const value: unknown = JSON.parse(raw);
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  };
  const findings = parseList(info.anonymity_findings);
  const unchecked = parseList(info.anonymity_unchecked).filter(
    (u): u is string => typeof u === "string",
  );
  const checked = info.anonymity_checked_at
    ? chalk.dim(` (checked ${new Date(info.anonymity_checked_at).toLocaleDateString()})`)
    : "";

  if (info.anonymity_status === "findings") {
    console.log(`  Blind check: ${chalk.red(`${findings.length} finding(s)`)}${checked}`);
    for (const finding of findings) {
      if (typeof finding !== "object" || finding === null) continue;
      const f = finding as { check?: unknown; file?: unknown; detail?: unknown };
      const where = typeof f.file === "string" ? ` ${chalk.dim(f.file)}` : "";
      console.log(`               - ${String(f.check ?? "unknown")}${where}`);
      if (typeof f.detail === "string") console.log(chalk.dim(`                 ${f.detail}`));
    }
  } else if (info.anonymity_status === "unverifiable") {
    console.log(`  Blind check: ${chalk.yellow("could not be completed")}${checked}`);
  } else {
    console.log(`  Blind check: ${chalk.green("no findings")}${checked}`);
  }

  if (unchecked.length > 0) {
    console.log(chalk.dim(`               Not checked: ${unchecked.join(", ")}`));
  }
}
