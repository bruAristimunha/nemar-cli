/**
 * Sandbox training commands for NEMAR CLI
 *
 * Commands:
 * - nemar sandbox         - Run sandbox training (main entry point)
 * - nemar sandbox status  - Check if sandbox training is completed
 * - nemar sandbox reset   - Reset sandbox status for re-training
 */

import chalk from "chalk";
import { Command } from "commander";
import ora from "ora";
import { formatBytesCli } from "../../shared/bytes.js";
import { completeSandbox, getSandboxStatus, resetSandbox } from "../lib/api/auth.js";
import { requestUploadCredentials } from "../lib/api/data.js";
import { createDataset, finalizeDataset } from "../lib/api/datasets.js";
import { ApiError } from "../lib/api/errors.js";
import { SANDBOX_ATTESTATION } from "../lib/attestation.js";
import { deleteConfig, getConfig, isAuthenticated, setConfig } from "../lib/config.js";
import {
  type ConfirmOptions,
  NO_DESCRIPTION,
  NO_OPTION,
  YES_DESCRIPTION,
  YES_OPTION,
  confirm,
} from "../lib/confirm.js";
import { pushToGitHub, saveDataset } from "../lib/git-annex/clone-push.js";
import {
  acceptGitHubInvitation,
  configureGitHubRemote,
  verifyGitHubAuth,
} from "../lib/git-annex/github.js";
import { configureLargefiles, gitAnnexAdd, initDataset } from "../lib/git-annex/init.js";
import { checkPrerequisites } from "../lib/git-annex/prereq.js";
import {
  clearAnnexCredentials,
  configureS3Remote,
  toS3Credentials,
} from "../lib/git-annex/s3-remote.js";
import { copyToAnnexRemote } from "../lib/git-annex/transfer.js";
import { resolveSandboxCompletion } from "../lib/sandbox-status.js";
import {
  cleanupSandboxDataset,
  generateSandboxDataset,
  getSandboxDatasetSize,
} from "../lib/sandbox.js";
import { setVerbose } from "../lib/verbose.js";

export const sandboxCommand = new Command("sandbox")
  .description("Complete sandbox training before uploading datasets")
  .option("-v, --verbose", "Print full subprocess output (git, git-annex) for debugging")
  .addHelpText(
    "after",
    `
Description:
  Sandbox training verifies your setup and familiarizes you with the upload
  workflow. You must complete sandbox training before uploading real datasets.

  The training creates a placeholder BIDS dataset (~500KB) and uploads it to
  the sandbox environment, testing your git-annex and SSH setup.

Examples:
  $ nemar sandbox             # Run sandbox training
  $ nemar sandbox --verbose   # Run with full subprocess output (debug stuck runs)
  $ nemar sandbox status      # Check if training is completed
  $ nemar sandbox reset       # Reset for re-training
`,
  )
  .action(sandboxAction);

// ============================================================================
// Main sandbox training action
// ============================================================================

/**
 * What {@link saveAndPush} did: it worked (`warning` is set when the main branch was
 * pushed and the git-annex branch was not), or the named step failed.
 */
export type SaveAndPushResult =
  | { ok: true; warning?: string }
  | { ok: false; step: "save" | "push"; error: string };

/**
 * Commit the dataset and push it. `saveDataset` and `pushToGitHub` report failure in
 * their result rather than by throwing, so each result is read here: a save that failed
 * closed (a git that could not report or clear its flags, or a failed commit) must not be
 * reported as "Pushed to GitHub", and a push that only half worked says so.
 */
export async function saveAndPush(
  datasetPath: string,
  message: string,
  author?: { name: string; email: string },
): Promise<SaveAndPushResult> {
  const saved = await saveDataset(datasetPath, message, author);
  if (!saved.success) return { ok: false, step: "save", error: saved.error ?? "unknown error" };
  const pushed = await pushToGitHub(datasetPath);
  if (!pushed.success) return { ok: false, step: "push", error: pushed.error ?? "unknown error" };
  return { ok: true, ...(pushed.warning ? { warning: pushed.warning } : {}) };
}

async function sandboxAction(options: { verbose?: boolean } = {}): Promise<void> {
  if (options.verbose) {
    setVerbose(true);
  }

  console.log();
  console.log(chalk.bold("NEMAR Sandbox Training"));
  console.log(chalk.dim("Verify your setup and learn the upload workflow"));
  if (options.verbose) {
    console.log(chalk.dim("Verbose mode: subprocess invocations will be printed"));
  }
  console.log();

  // Step 1: Check authentication
  if (!isAuthenticated()) {
    console.log(chalk.red("Not authenticated"));
    console.log(chalk.dim("Run 'nemar auth login' first"));
    return;
  }

  // Step 2: Check if already completed. The local flag is a CACHE of a fact
  // the account carries (#1274), so a miss asks the backend instead of walking
  // somebody who trained on another machine through training again. A failed
  // ask says so and continues: the user typed `nemar sandbox`, and the run is
  // idempotent enough to be the right default when nobody can say otherwise.
  const completion = await resolveSandboxCompletion();
  if (completion.status === "unknown") {
    console.log(chalk.yellow("Could not confirm your training status with the server."));
    console.log(chalk.dim(`  ${completion.reason}`));
    console.log(chalk.dim("  Continuing; run 'nemar sandbox status --refresh' to re-check."));
    console.log();
  }
  // Re-read: a server answer above may have just written both fields.
  const config = getConfig();
  if (completion.status === "completed") {
    console.log(chalk.green("Sandbox training already completed!"));
    console.log(chalk.dim(`Dataset ID: ${config.sandboxDatasetId}`));
    console.log();
    console.log("You can upload real datasets with:");
    console.log(chalk.cyan("  nemar dataset upload ./your-dataset"));
    console.log();
    console.log(chalk.dim("To re-run training, use: nemar sandbox reset"));
    return;
  }

  // Step 3: Check prerequisites
  console.log(chalk.bold("Step 1/6: Checking prerequisites..."));
  const prereqSpinner = ora("Checking prerequisites...").start();

  const prereqs = await checkPrerequisites();
  if (!prereqs.allPassed) {
    prereqSpinner.fail("Prerequisites check failed");
    console.log();
    console.log(chalk.red("Missing requirements:"));
    for (const error of prereqs.errors) {
      console.log(chalk.yellow(`  - ${error}`));
    }
    if (prereqs.errors.some((e) => e.includes("GitHub"))) {
      console.log(chalk.dim("    Run 'gh auth login' to authenticate with GitHub"));
    }
    return;
  }
  prereqSpinner.succeed("All prerequisites met");

  // Step 3b: Verify gh CLI authentication
  const ghSpinner = ora("Verifying GitHub CLI authentication...").start();
  const ghAuth = await verifyGitHubAuth(config.githubUsername);

  if (!ghAuth.authenticated) {
    ghSpinner.fail("GitHub CLI not authenticated");
    console.log(chalk.red(`  ${ghAuth.error}`));
    console.log();
    console.log("GitHub CLI is required for sandbox training. Install and authenticate:");
    console.log(chalk.cyan("  brew install gh       # or visit https://cli.github.com/"));
    console.log(chalk.cyan("  gh auth login"));
    return;
  }

  if (config.githubUsername && !ghAuth.matches) {
    ghSpinner.warn("GitHub CLI user mismatch");
    console.log(chalk.yellow(`  ${ghAuth.error}`));
    console.log();
    console.log(
      "Your gh CLI is authenticated as a different GitHub account than your NEMAR account.",
    );
    console.log("This may cause issues with repository access. To fix:");
    console.log(chalk.cyan(`  gh auth login    # Login as ${config.githubUsername}`));
    console.log();
    console.log(
      chalk.yellow(
        "WARNING: If upload fails with permission errors, this mismatch is the likely cause.",
      ),
    );
    console.log();
    // Continue with warning; don't block
  } else {
    ghSpinner.succeed(`GitHub CLI authenticated as ${ghAuth.username}`);
  }

  // Step 4: Generate sandbox dataset
  console.log();
  console.log(chalk.bold("Step 2/6: Generating test dataset..."));
  const genSpinner = ora("Creating minimal BIDS structure...").start();

  let datasetPath: string;
  try {
    const paths = generateSandboxDataset();
    datasetPath = paths.root;
    const size = getSandboxDatasetSize(paths);
    genSpinner.succeed(`Test dataset created (${formatBytesCli(size)})`);
    console.log(chalk.dim(`  Location: ${datasetPath}`));
  } catch (error) {
    genSpinner.fail("Failed to generate test dataset");
    console.log(chalk.red(`  ${error instanceof Error ? error.message : "Unknown error"}`));
    return;
  }

  // Step 5: Create dataset via API
  console.log();
  console.log(chalk.bold("Step 3/6: Registering sandbox dataset..."));
  const apiSpinner = ora("Creating dataset on NEMAR...").start();

  let datasetId: string;
  let sshUrl: string;
  let githubUrl: string;
  let s3Config: { bucket: string; region: string; public_url: string };
  let s3Prefix: string;

  try {
    const response = await createDataset({
      name: "Sandbox Training Dataset",
      description: "Placeholder dataset for sandbox training",
      files: [
        { path: "sub-01/eeg/sub-01_task-rest_eeg.edf", size: 512000, type: "data" },
        { path: "dataset_description.json", size: 200, type: "metadata" },
        { path: "participants.tsv", size: 50, type: "metadata" },
        { path: "README", size: 500, type: "metadata" },
        { path: "sub-01/eeg/sub-01_task-rest_eeg.json", size: 300, type: "metadata" },
      ],
      sandbox: true,
      // Training fixtures, not participant data: attested as owner fixtures
      // so sandbox rows carry a real record instead of NULLs (ADR 0024).
      attestation: SANDBOX_ATTESTATION,
    });

    datasetId = response.dataset.dataset_id;
    sshUrl = response.dataset.ssh_url;
    githubUrl = response.dataset.github_url;
    s3Config = response.s3_config;
    s3Prefix = response.dataset.s3_prefix;

    apiSpinner.succeed(`Sandbox dataset created: ${chalk.cyan(datasetId)}`);
    console.log(chalk.dim(`  GitHub: ${githubUrl}`));

    // Wait for IAM policy propagation (AWS is eventually consistent)
    // This initial wait helps reduce retry attempts during upload
    await new Promise((resolve) => setTimeout(resolve, 10000));
  } catch (error) {
    apiSpinner.fail("Failed to create sandbox dataset");
    if (error instanceof ApiError) {
      console.log(chalk.red(`  ${error.message}`));
    } else {
      console.log(chalk.red(`  ${error instanceof Error ? error.message : "Unknown error"}`));
    }
    cleanupSandboxDataset(datasetPath);
    return;
  }

  // Step 5b: Accept GitHub invitation
  const inviteSpinner = ora("Accepting GitHub repository invitation...").start();

  // Extract repo full name from github_url (e.g., "https://github.com/nemarDatasets/xx000123")
  // Validate URL format: must be a valid GitHub URL with owner/repo pattern
  const repoMatch = githubUrl?.match(/github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/);
  const repoFullName = repoMatch ? repoMatch[1].replace(/\.git$/, "") : null;

  if (!repoFullName) {
    inviteSpinner.fail("Invalid GitHub repository URL from backend");
    console.log(chalk.red(`  Received: ${githubUrl || "(empty)"}`));
    console.log(chalk.red("  Expected format: https://github.com/owner/repo"));
    console.log();
    console.log("This may indicate a backend issue. Please contact support.");
    cleanupSandboxDataset(datasetPath);
    return;
  }

  const inviteResult = await acceptGitHubInvitation(repoFullName);
  if (inviteResult.accepted) {
    if (inviteResult.alreadyCollaborator) {
      inviteSpinner.succeed("Already a collaborator on this repository");
    } else {
      inviteSpinner.succeed("GitHub invitation accepted");
    }
  } else {
    inviteSpinner.warn("Could not auto-accept invitation");
    console.log(chalk.yellow(`  ${inviteResult.error}`));
    console.log();
    console.log("You may need to accept the invitation manually:");
    console.log(chalk.cyan(`  https://github.com/${repoFullName}/invitations`));
    console.log();
    // Continue anyway - user can accept manually
  }

  // Step 6: Initialize git-annex and configure remotes
  console.log();
  console.log(chalk.bold("Step 4/6: Initializing repository..."));
  const initSpinner = ora("Setting up git-annex...").start();

  // Use NEMAR user identity for all commits (including initial dataset creation)
  const author =
    config.username && config.email ? { name: config.username, email: config.email } : undefined;

  try {
    const initResult = await initDataset(datasetPath, { author });
    if (!initResult.success) {
      throw new Error(initResult.error || "Failed to initialize dataset");
    }
    await configureLargefiles(datasetPath);
    await configureGitHubRemote(datasetPath, sshUrl);
    initSpinner.succeed("Repository initialized");
  } catch (error) {
    initSpinner.fail("Failed to initialize repository");
    console.log(chalk.red(`  ${error instanceof Error ? error.message : "Unknown error"}`));
    cleanupSandboxDataset(datasetPath);
    return;
  }

  console.log();
  console.log(chalk.bold("Step 5/6: Uploading to S3..."));

  const credsSpinner = ora("Requesting upload credentials...").start();
  let credsResponse: Awaited<ReturnType<typeof requestUploadCredentials>>;
  try {
    credsResponse = await requestUploadCredentials(datasetId);
    credsSpinner.succeed("Upload credentials received");
  } catch (error) {
    credsSpinner.fail("Could not get upload credentials");
    console.log(chalk.red(`  ${error instanceof Error ? error.message : "Unknown error"}`));
    cleanupSandboxDataset(datasetPath);
    return;
  }

  const credentials = toS3Credentials(credsResponse.credentials);

  const remoteSpinner = ora("Configuring S3 remote...").start();
  const remoteResult = await configureS3Remote(
    datasetPath,
    {
      name: "nemar-s3",
      bucket: credsResponse.s3.bucket,
      prefix: `${s3Prefix}/objects`,
      region: credsResponse.s3.region,
      publicUrl: s3Config.public_url,
    },
    credentials,
  );
  if (!remoteResult.success) {
    remoteSpinner.fail("Failed to configure S3 remote");
    console.log(chalk.red(`  ${remoteResult.error}`));
    console.log(chalk.dim("  Re-run with --verbose to see git-annex output."));
    cleanupSandboxDataset(datasetPath);
    return;
  }
  remoteSpinner.succeed("S3 remote configured");

  const addSpinner = ora("Tracking data files with git-annex...").start();
  const addResult = await gitAnnexAdd(datasetPath);
  if (!addResult.success) {
    addSpinner.fail("Failed to track data files");
    console.log(chalk.red(`  ${addResult.error}`));
    console.log(chalk.dim("  Re-run with --verbose to see git-annex output."));
    cleanupSandboxDataset(datasetPath);
    return;
  }
  addSpinner.succeed("Data files tracked by git-annex");

  const uploadSpinner = ora("Uploading data files to S3...").start();
  const uploadResult = await copyToAnnexRemote(datasetPath, "nemar-s3", 4, credentials);

  // Clear cached STS creds so subsequent `git annex get` falls back to publicurl
  await clearAnnexCredentials(datasetPath);

  if (!uploadResult.success) {
    uploadSpinner.fail("S3 upload failed");
    console.log(chalk.red(`  ${uploadResult.error}`));
    console.log(chalk.dim("  Re-run with --verbose to see git-annex output."));
    cleanupSandboxDataset(datasetPath);
    return;
  }
  uploadSpinner.succeed(`Uploaded ${uploadResult.filesCopied} data file(s) to S3`);

  // Step 8: Save and push to GitHub
  console.log();
  console.log(chalk.bold("Step 6/6: Pushing to GitHub..."));
  const pushSpinner = ora("Saving and pushing...").start();

  try {
    const published = await saveAndPush(datasetPath, "Initial sandbox training upload", author);
    if (!published.ok) {
      pushSpinner.fail(
        published.step === "save" ? "Failed to save the dataset" : "Failed to push to GitHub",
      );
      console.log(chalk.red(`  ${published.error}`));
      cleanupSandboxDataset(datasetPath);
      return;
    }
    if (published.warning) {
      pushSpinner.warn("Pushed to GitHub (with warning)");
      console.log(chalk.yellow(`  ${published.warning}`));
    } else {
      pushSpinner.succeed("Pushed to GitHub");
    }
  } catch (error) {
    pushSpinner.fail("Failed to save and push");
    console.log(chalk.red(`  ${error instanceof Error ? error.message : "Unknown error"}`));
    cleanupSandboxDataset(datasetPath);
    return;
  }

  // Step 9: Finalize and mark complete
  const finalizeSpinner = ora("Finalizing...").start();

  try {
    await finalizeDataset(datasetId);
    await completeSandbox(datasetId);

    // Update local config
    setConfig("sandboxCompleted", true);
    setConfig("sandboxDatasetId", datasetId);

    finalizeSpinner.succeed("Sandbox training complete!");
  } catch (error) {
    finalizeSpinner.fail("Failed to finalize");
    console.log(chalk.red(`  ${error instanceof Error ? error.message : "Unknown error"}`));
    cleanupSandboxDataset(datasetPath);
    return;
  }

  // Cleanup temp directory
  cleanupSandboxDataset(datasetPath);

  // Success message
  console.log();
  console.log(chalk.green.bold("Congratulations! Sandbox training completed successfully."));
  console.log();
  console.log("Your setup is verified and you're ready to upload real datasets:");
  console.log(chalk.cyan("  nemar dataset upload ./your-dataset"));
  console.log();
  console.log(chalk.dim(`Sandbox dataset: ${datasetId}`));
}

// ============================================================================
// Status command
// ============================================================================

sandboxCommand
  .command("status")
  .description("Check sandbox training completion status")
  .option("--refresh", "Fetch latest status from server")
  .action(async (options: { refresh?: boolean }) => {
    if (!isAuthenticated()) {
      console.log(chalk.red("Not authenticated"));
      console.log(chalk.dim("Run 'nemar auth login' first"));
      return;
    }

    if (options.refresh) {
      // Fetch from server
      const spinner = ora("Checking status...").start();
      try {
        const status = await getSandboxStatus();
        setConfig("sandboxCompleted", status.sandbox_completed);
        if (status.sandbox_dataset_id) {
          setConfig("sandboxDatasetId", status.sandbox_dataset_id);
        }
        spinner.stop();

        if (status.sandbox_completed) {
          console.log(chalk.green("Sandbox training: Completed"));
          console.log(chalk.dim(`  Dataset ID: ${status.sandbox_dataset_id}`));
          if (status.sandbox_completed_at) {
            console.log(chalk.dim(`  Completed: ${status.sandbox_completed_at}`));
          }
        } else {
          console.log(chalk.yellow("Sandbox training: Not completed"));
          console.log();
          console.log("Run sandbox training with:");
          console.log(chalk.cyan("  nemar sandbox"));
        }
      } catch (error) {
        spinner.fail("Failed to check status");
        if (error instanceof ApiError) {
          console.log(chalk.red(`  ${error.message}`));
        }
      }
    } else {
      // Check local config
      const config = getConfig();
      if (config.sandboxCompleted) {
        console.log(chalk.green("Sandbox training: Completed"));
        console.log(chalk.dim(`  Dataset ID: ${config.sandboxDatasetId}`));
      } else {
        console.log(chalk.yellow("Sandbox training: Not completed"));
        console.log();
        console.log("Run sandbox training with:");
        console.log(chalk.cyan("  nemar sandbox"));
      }
    }
  });

// ============================================================================
// Reset command
// ============================================================================

sandboxCommand
  .command("reset")
  .description("Reset sandbox training status for re-training")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(async (options: ConfirmOptions) => {
    if (!isAuthenticated()) {
      console.log(chalk.red("Not authenticated"));
      console.log(chalk.dim("Run 'nemar auth login' first"));
      return;
    }

    const localConfig = getConfig();
    if (!localConfig.sandboxCompleted) {
      console.log(chalk.yellow("Sandbox training not yet completed"));
      console.log(chalk.dim("Nothing to reset"));
      return;
    }

    const result = await confirm(
      "Reset sandbox training status? You will need to complete training again.",
      options,
    );
    if (result !== "confirmed") {
      console.log(chalk.dim(result === "declined" ? "Skipped" : "Cancelled"));
      return;
    }

    const spinner = ora("Resetting sandbox status...").start();

    try {
      await resetSandbox();

      // Clear local config
      deleteConfig("sandboxCompleted");
      deleteConfig("sandboxDatasetId");

      spinner.succeed("Sandbox status reset");
      console.log();
      console.log("Run sandbox training again with:");
      console.log(chalk.cyan("  nemar sandbox"));
    } catch (error) {
      spinner.fail("Failed to reset");
      if (error instanceof ApiError) {
        console.log(chalk.red(`  ${error.message}`));
      } else {
        console.log(chalk.red(`  ${error instanceof Error ? error.message : "Unknown error"}`));
      }
    }
  });
