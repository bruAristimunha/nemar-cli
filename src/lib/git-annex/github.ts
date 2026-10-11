/**
 * git-annex service: GitHub auth, remotes, and clone credentials.
 *
 * Split from lib/git-annex.ts by concern (#908, epic #902); bodies moved
 * verbatim. getGitHubToken is exported for sibling modules (internal
 * wiring, pinned separately in test/git-annex-export-surface.unit.test.ts).
 *
 * Known duplication, deliberately NOT unified in the behavior-preserving
 * split: prereq.ts's checkGitHubSSH and this module's private testGitHubSsh
 * both probe `ssh -T git@github.com` with different flags/return shapes.
 */

import { runCommand } from "./run-command.js";

/**
 * Test if GitHub SSH access is configured and working
 *
 * Note: SSH test to GitHub returns exit code 1 even on success (GitHub's PTY restriction)
 * We check stderr for "successfully authenticated" message to confirm it works
 */
async function testGitHubSsh(): Promise<{ works: boolean; error?: string }> {
  try {
    const { exitCode, stderr } = await runCommand([
      "ssh",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      "git@github.com",
    ]);

    const works = stderr.includes("successfully authenticated");
    if (!works) {
      console.warn("SSH test to github.com failed:", {
        exitCode,
        stderr: stderr.trim().slice(0, 500),
      });
    }
    return { works, error: works ? undefined : stderr.trim().slice(0, 500) };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.warn("SSH test exception:", errorMsg);
    return { works: false, error: errorMsg };
  }
}

/**
 * Get GitHub token from gh CLI
 */
export async function getGitHubToken(): Promise<{ token: string | null; error?: string }> {
  try {
    const { stdout, exitCode, stderr } = await runCommand(["gh", "auth", "token"], {
      sensitiveOutput: true,
    });

    if (exitCode !== 0) {
      console.warn("gh CLI returned non-zero exit code:", exitCode);
      console.warn("stderr:", stderr);
      return { token: null, error: `gh auth token failed: ${stderr.trim() || "unknown error"}` };
    }

    if (!stdout.trim()) {
      console.warn("gh auth token returned empty output");
      return { token: null, error: "gh CLI returned empty token" };
    }

    return { token: stdout.trim() };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error("Failed to get GitHub token from gh CLI:", errorMsg);

    // Provide specific guidance based on error
    if (errorMsg.includes("ENOENT") || errorMsg.includes("not found")) {
      return { token: null, error: "gh CLI not installed (command not found)" };
    }

    return { token: null, error: `gh CLI error: ${errorMsg}` };
  }
}

/**
 * Verify that the gh CLI is authenticated as the expected GitHub user.
 * This is important because GitHub operations (accepting invitations, pushing)
 * must be done as the correct user.
 *
 * @param expectedUsername - The GitHub username the user should be authenticated as
 * @returns Verification result with the actual authenticated username if available
 */
export async function verifyGitHubAuth(expectedUsername?: string): Promise<{
  authenticated: boolean;
  username?: string;
  matches?: boolean;
  error?: string;
}> {
  try {
    // Check if gh CLI is authenticated and get the current user
    const { stdout, exitCode, stderr } = await runCommand(["gh", "api", "user", "--jq", ".login"]);

    if (exitCode !== 0) {
      // Check for specific error cases
      if (stderr.includes("not logged in") || stderr.includes("auth login")) {
        return {
          authenticated: false,
          error: "gh CLI not authenticated. Run 'gh auth login' to authenticate.",
        };
      }
      return {
        authenticated: false,
        error: `gh CLI error: ${stderr.trim() || "unknown error"}`,
      };
    }

    const actualUsername = stdout.trim();
    if (!actualUsername) {
      return {
        authenticated: false,
        error: "gh CLI returned empty username",
      };
    }

    // If expected username provided, check if it matches
    if (expectedUsername) {
      const matches = actualUsername.toLowerCase() === expectedUsername.toLowerCase();
      return {
        authenticated: true,
        username: actualUsername,
        matches,
        error: matches
          ? undefined
          : `gh CLI authenticated as '${actualUsername}', expected '${expectedUsername}'`,
      };
    }

    return {
      authenticated: true,
      username: actualUsername,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    if (errorMsg.includes("ENOENT") || errorMsg.includes("not found")) {
      return {
        authenticated: false,
        error: "gh CLI not installed. Install from https://cli.github.com/",
      };
    }

    return {
      authenticated: false,
      error: `Failed to verify gh CLI: ${errorMsg}`,
    };
  }
}

/**
 * Accept a pending GitHub repository invitation.
 *
 * After a dataset is created, the backend invites the user as a collaborator.
 * This function finds and accepts that invitation so the user can push without
 * manually accepting in the browser.
 *
 * @param repoFullName - The full repository name (e.g., "nemarDatasets/nm000123")
 * @returns Result indicating whether invitation was accepted
 */
export async function acceptGitHubInvitation(repoFullName: string): Promise<{
  accepted: boolean;
  error?: string;
  alreadyCollaborator?: boolean;
}> {
  // Validate repository name format to prevent injection
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repoFullName)) {
    return {
      accepted: false,
      error: `Invalid repository format: ${repoFullName}`,
    };
  }

  // List pending invitations for the current user
  // Note: We fetch all invitations and filter in JS to avoid jq injection
  const { stdout, exitCode, stderr } = await runCommand([
    "gh",
    "api",
    "/user/repository_invitations",
  ]);

  if (exitCode !== 0) {
    // Check for specific error cases
    if (stderr.includes("not logged in") || stderr.includes("auth login")) {
      return {
        accepted: false,
        error: "gh CLI not authenticated. Run 'gh auth login' to authenticate.",
      };
    }
    if (stderr.includes("API rate limit") || stderr.includes("403")) {
      return {
        accepted: false,
        error: "GitHub API rate limit exceeded. Please try again in a few minutes.",
      };
    }
    if (stderr.includes("ENOENT") || stderr.includes("not found")) {
      return {
        accepted: false,
        error: "gh CLI not installed. Install from https://cli.github.com/",
      };
    }
    return {
      accepted: false,
      error: `Failed to list invitations: ${stderr.trim() || "unknown error"}`,
    };
  }

  // Parse invitations and find the one for our repo
  let invitationId: number | null = null;
  try {
    const invitations = JSON.parse(stdout || "[]") as Array<{
      id: number;
      repository: { full_name: string };
    }>;
    const invitation = invitations.find((inv) => inv.repository.full_name === repoFullName);
    invitationId = invitation?.id ?? null;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error("Failed to parse GitHub invitations response:", errorMsg);
    console.error("  Raw response (first 500 chars):", (stdout || "").slice(0, 500));
    return {
      accepted: false,
      error: `Failed to parse GitHub API response: ${errorMsg}`,
    };
  }

  // No invitation found - user might already be a collaborator
  if (!invitationId) {
    // Check if user already has access to the repo
    const { exitCode: checkExitCode } = await runCommand([
      "gh",
      "api",
      `/repos/${repoFullName}`,
      "--silent",
    ]);

    if (checkExitCode === 0) {
      return {
        accepted: true,
        alreadyCollaborator: true,
      };
    }

    return {
      accepted: false,
      error: `No pending invitation found for ${repoFullName}. You may need to accept it manually via GitHub.`,
    };
  }

  // Accept the invitation
  const { exitCode: acceptExitCode, stderr: acceptStderr } = await runCommand([
    "gh",
    "api",
    "--method",
    "PATCH",
    `/user/repository_invitations/${invitationId}`,
  ]);

  if (acceptExitCode !== 0) {
    return {
      accepted: false,
      error: `Failed to accept invitation: ${acceptStderr.trim() || "unknown error"}`,
    };
  }

  return { accepted: true };
}

export async function configureGitHubRemote(
  path: string,
  repoUrl: string,
  remoteName = "origin",
): Promise<{ success: boolean; error?: string }> {
  // Transform GitHub SSH URL based on environment and configuration
  // Priority: CI token > SSH > HTTPS with gh token
  let finalUrl = repoUrl;

  // CI/CD: Use HTTPS with GH_TOKEN
  if (process.env.GH_TOKEN && repoUrl.startsWith("git@github.com:")) {
    const token = process.env.GH_TOKEN.trim();
    if (!token || /\s/.test(token)) {
      return {
        success: false,
        error:
          "GH_TOKEN environment variable is set but appears malformed (empty or contains whitespace)",
      };
    }
    const repoPath = repoUrl.replace("git@github.com:", "");
    finalUrl = `https://github.com/${repoPath}`;
    // Set token via credential helper instead of embedding in URL
    await runCommand(
      [
        "git",
        "config",
        "credential.https://github.com.helper",
        `!printf 'username=x-access-token\\npassword=${token}'`,
      ],
      { cwd: path, redact: [token] },
    );
  }
  // Local: Try HTTPS via gh CLI token first (preferred), then SSH as fallback
  else if (repoUrl.startsWith("git@github.com:")) {
    const repoPath = repoUrl.replace("git@github.com:", "");

    const ghTokenResult = await getGitHubToken();

    if (ghTokenResult.token) {
      finalUrl = `https://github.com/${repoPath}`;
      // Set token via credential helper instead of embedding in URL
      await runCommand(
        [
          "git",
          "config",
          "credential.https://github.com.helper",
          `!printf 'username=x-access-token\\npassword=${ghTokenResult.token}'`,
        ],
        { cwd: path, redact: [ghTokenResult.token] },
      );
    } else {
      // HTTPS not available, try SSH as last resort
      const sshResult = await testGitHubSsh();

      if (sshResult.works) {
        finalUrl = repoUrl;
      } else {
        return {
          success: false,
          error: `GitHub authentication not configured.

gh CLI failed: ${ghTokenResult.error || "could not get token"}
SSH failed: ${sshResult.error || "could not connect"}

Fix one of these:
  1. Install and authenticate gh CLI (recommended):
     brew install gh && gh auth login

  2. Configure SSH for GitHub:
     ssh-keygen -t ed25519 -C "your@email.com"
     Add the public key to https://github.com/settings/keys
     Test with: ssh -T git@github.com`,
        };
      }
    }
  }

  try {
    // Check if remote already exists
    const { stdout } = await runCommand(["git", "remote", "get-url", remoteName], { cwd: path });

    if (stdout.trim()) {
      // Remote exists, update it
      const { stderr, exitCode } = await runCommand(
        ["git", "remote", "set-url", remoteName, finalUrl],
        { cwd: path },
      );

      if (exitCode !== 0) {
        return { success: false, error: stderr.trim() };
      }
    } else {
      // Remote doesn't exist, add it
      const { stderr, exitCode } = await runCommand(
        ["git", "remote", "add", remoteName, finalUrl],
        { cwd: path },
      );

      if (exitCode !== 0) {
        return { success: false, error: stderr.trim() };
      }
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * GitHub credential-helper config value that authenticates HTTPS git operations
 * with a token as the `x-access-token` user. Same shape `configureGitHubRemote`
 * persists; centralised so the clone path and the remote path can't drift.
 */
export function githubTokenCredentialHelper(token: string): string {
  return `!printf 'username=x-access-token\\npassword=${token}'`;
}

/**
 * Pure resolution of how to clone a GitHub repo given an optional token.
 *
 * A `git@github.com:` URL is rewritten to HTTPS and authenticated with the
 * token when one is supplied; the finalize phase of the OpenNeuro import runs
 * on a CI runner that has an HTTPS App token but no SSH key, so a raw SSH clone
 * fails with "Permission denied (publickey)" (nemarOrg/nemar-cli#768). Without a
 * usable token the SSH URL is returned unchanged so a developer's own key still
 * works. Non-SSH URLs (e.g. the public OpenNeuro HTTPS clone) pass through
 * untouched. A malformed token (empty, containing whitespace, or containing a
 * single quote that would break out of the `printf` helper string) is treated
 * as "no token" so a broken credential helper is never baked into the clone.
 */
export function resolveGitHubCloneAuth(
  repoUrl: string,
  token: string | null,
): { url: string; credentialHelper?: string } {
  if (!repoUrl.startsWith("git@github.com:")) return { url: repoUrl };
  const trimmed = token?.trim();
  // Whitespace or a single quote means the token can't be safely embedded in the
  // printf credential helper; treat as no token rather than emit a broken helper.
  if (!trimmed || /[\s']/.test(trimmed)) return { url: repoUrl };
  const repoPath = repoUrl.replace("git@github.com:", "");
  return {
    url: `https://github.com/${repoPath}`,
    credentialHelper: githubTokenCredentialHelper(trimmed),
  };
}
