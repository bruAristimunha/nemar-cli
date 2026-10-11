/**
 * Authentication commands for NEMAR CLI
 *
 * Commands:
 * - nemar auth login     - Authenticate with API key
 * - nemar auth signup    - Register new account
 * - nemar auth status    - Check authentication status
 * - nemar auth whoami    - Alias for status (common pattern)
 * - nemar auth logout    - Clear stored credentials
 * - nemar auth request-upload-access - Ask an admin for upload access
 * - nemar auth switch    - Switch between stored accounts
 * - nemar auth setup-ssh - Configure SSH for GitHub (optional, gh CLI preferred)
 *
 * Note: The two-prong structure (nemar auth <cmd>) follows CLI best practices
 * for discoverability and organization. Root-level shortcuts (nemar login,
 * nemar whoami, etc.) are provided as convenience aliases in index.ts.
 */

import chalk from "chalk";
import { Command, InvalidArgumentError } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import { accountCopy } from "../../shared/contract/account-copy.js";
import type { ApiKeySummary } from "../../shared/contract/device-auth.js";
import { resolveProfileGaps } from "../../shared/contract/profile-gaps.js";
import {
  type ContractUser,
  UPLOAD_ACCESS_WHY_MAX_CHARS,
  UPLOAD_ACCESS_WHY_MIN_CHARS,
} from "../../shared/contract/user.js";
import { printGapList, printProfileGaps } from "../lib/account-gaps.js";
import {
  type ProfilePatchRequest,
  type UploadAccessRequestResponse,
  createApiKey,
  getCurrentUser,
  listApiKeys,
  login,
  requestEmailChange,
  requestKeyRegeneration,
  requestUploadAccess,
  resendVerification,
  revokeApiKey,
  revokeApiKeyWithBearer,
  startOrcidCliLink,
  suggestUsername,
  unlinkOrcid,
  updateProfile,
  verifyEmailChange,
} from "../lib/api/auth.js";
import { ApiError, MaintenanceError, errorDetail } from "../lib/api/errors.js";
import { openInBrowser } from "../lib/browser.js";
import { printStepFailure } from "../lib/cli-output.js";
import {
  type Config,
  type KeyFields,
  accountKeyFor,
  clearAllConfig,
  clearConfig,
  deleteConfig,
  getAccounts,
  getConfig,
  getConfigPath,
  isAuthenticated,
  renameActiveAccount,
  setConfig,
  switchAccount,
  upsertAccount,
} from "../lib/config.js";
import {
  type ConfirmOptions,
  NO_DESCRIPTION,
  NO_OPTION,
  YES_DESCRIPTION,
  YES_OPTION,
  confirm,
} from "../lib/confirm.js";
import { markReportedExit, markUsageExit, recordStep } from "../lib/debug-log.js";
import {
  type DeviceLoginOutcome,
  describeDeviceOutcome,
  runDeviceLogin,
} from "../lib/device-login.js";
import { addVerboseHelp } from "../lib/help.js";
import { warnMissingPrerequisites } from "../lib/prerequisites.js";
import {
  configureSSHForGitHub,
  generateSSHKey,
  getSSHKeyPaths,
  nemarSSHKeyExists,
  readPublicKey,
  testGitHubSSH,
} from "../lib/ssh.js";

export const authCommand = new Command("auth").description("Authentication management");

addVerboseHelp(
  authCommand,
  `
Description:
  Manage your NEMAR account authentication. New users sign in with their
  browser (ORCID creates the account); that activates it (browse, download,
  API key, sandbox training). Uploading datasets additionally needs upload
  access, a one-time admin approval 'nemar auth signup' requests for you
  once your profile is complete.

Workflow:
  1. nemar auth signup   - Browser sign-in; ORCID creates the account, then
                            a few questions for whatever is still missing
  2. Verify your email   - Click the link NEMAR sends you
  3. nemar sandbox        - Complete sandbox training before your first upload

Keys:
  Every browser-based 'nemar auth login' names a key for the machine it
  runs on (list/create/revoke the whole set with 'nemar auth keys'); the
  -k/--key or NEMAR_API_KEY path stores the key you paste and mints
  nothing new. 'regenerate-key' replaces a lost key by an emailed link and
  revokes the key on every machine; there is no password sign-in.

Examples:
  $ nemar auth signup                    # Sign in with your browser; complete your profile
  $ nemar auth login                     # Sign in with your browser
  $ nemar auth login -k <api-key>        # Paste an existing key instead
  $ nemar auth keys                      # List this account's named keys
  $ nemar auth status --refresh          # Check authentication status
  $ nemar auth whoami                    # Alias for status
  $ nemar auth switch                    # Switch between accounts
  $ nemar auth logout                    # Clear active account
  $ nemar auth logout --all              # Clear all accounts`,
);

// ============================================================================
// Login
// ============================================================================

/**
 * Decide how `nemar auth login` should treat a credential already on disk.
 *
 * The gate used to be `isAuthenticated()` alone, which only answers "is *a*
 * key string stored?" — true even when that key was revoked or expired
 * server-side (e.g. after `nemar auth regenerate-key` was run elsewhere).
 * That made the CLI announce "Already logged in" and ask "different account?"
 * when the user actually just needed to re-enter a renewed key for the SAME
 * account (#851). We probe the stored key's liveness and branch on the result.
 *
 * Pure on purpose: all I/O (the liveness probe) happens in the caller so this
 * decision stays unit-testable.
 */
export type LoginPreflight =
  | { kind: "fresh" } // no usable stored credential — prompt for a key
  | { kind: "stale"; username: string } // stored key confirmed dead — re-auth same account
  | { kind: "active"; username: string }; // stored key valid OR unverifiable — multi-account prompt

/** Liveness of a stored key, as determined by probing POST /auth/login. */
export type KeyLivenessState = "valid" | "invalid" | "unknown";

/**
 * Input to {@link decideLoginPreflight}. A discriminated union so the type
 * rejects phantom states: a key's liveness and username only exist when a key
 * is actually stored.
 */
export type LoginPreflightInput =
  | { hasStoredKey: false }
  | { hasStoredKey: true; storedKeyState: KeyLivenessState; username?: string };

export function decideLoginPreflight(input: LoginPreflightInput): LoginPreflight {
  if (!input.hasStoredKey) return { kind: "fresh" };
  const username = input.username || "unknown";
  // Only a definitive "invalid" (the server confirmed the key is revoked or
  // expired) routes to same-account re-auth. "valid" and "unknown" — the
  // latter an offline run or any transient failure where we never reached the
  // server — both keep the original multi-account behavior, so a network
  // hiccup never mislabels a good key as dead (#851).
  return input.storedKeyState === "invalid"
    ? { kind: "stale", username }
    : { kind: "active", username };
}

/**
 * Update the ACTIVE account's local config from a freshly known server user:
 * rename the entry once a username appears (#1266, ADR 0047), and cache the
 * fields `nemar auth status` reads. Shared by every place that learns a
 * user object -- `writeSignedInAccount` below (right after the credential
 * half of a sign-in is written), `refreshStoredAccount` (the `profile set-*`
 * subcommands), and `statusAction`'s `--refresh` branch -- so a rename and a
 * cache update happen the same way regardless of which one triggered it.
 *
 * Synchronous: both `renameActiveAccount` and `setConfig` are.
 */
function applyServerUser(user: {
  username: string | null;
  email: string;
  github_username: string | null;
  role: string;
  service_access?: boolean;
  profile_gaps?: ContractUser["profile_gaps"];
  sandbox_completed?: boolean;
  sandbox_dataset_id?: string | null;
  orcid_verified?: boolean;
  /** What this account IS (epic #1272 phase 4, #1284; ADR 0048). Reuses
   *  ContractUser's own field type (#1284 review) rather than a bare
   *  `string`, matching `profile_gaps` above. */
  account_kind?: ContractUser["account_kind"];
}): void {
  if (user.username && renameActiveAccount(user.username) === "key_taken") {
    console.log(
      chalk.yellow(`  This machine already has a different account stored as '${user.username}'.`),
    );
    console.log(
      chalk.dim(
        "  Your credentials stay under the old name; 'nemar auth switch' still selects that one.",
      ),
    );
  }
  setConfig("username", user.username ?? undefined);
  setConfig("email", user.email);
  setConfig("githubUsername", user.github_username ?? undefined);
  if (user.service_access !== undefined) setConfig("serviceAccess", user.service_access);
  if (user.profile_gaps !== undefined) setConfig("profileGaps", user.profile_gaps);
  if (user.sandbox_completed !== undefined) setConfig("sandboxCompleted", user.sandbox_completed);
  // A returning trained account's login/refresh must not lose the sandbox
  // dataset id `nemar sandbox` already recorded -- `undefined` means the
  // server did not report it (predates the field, or genuinely never
  // trained), and both leave the cached value untouched.
  if (user.sandbox_dataset_id) setConfig("sandboxDatasetId", user.sandbox_dataset_id);
  if (user.orcid_verified !== undefined) setConfig("orcidVerified", user.orcid_verified);
  setConfig("role", user.role);
  if (user.account_kind !== undefined) setConfig("accountKind", user.account_kind);
}

/**
 * Write a successful sign-in's credential to disk and print the welcome
 * block -- the one place `loginAction`'s device and `--key` paths converge
 * (ADR 0047).
 *
 * `keyInfo` ties `source` and the minted key TOGETHER as one tagged value
 * (matching `Config`'s own `KeyFields` shape in lib/config.ts) instead of
 * two separately-typed parameters that happened to always agree at every
 * call site: a `"device"` login always carries the row `POST
 * /auth/device/token` just minted, and a `"paste"` login never mints one,
 * so there is nothing to make invalid states of "device with no key"
 * representable for. `upsertAccount`'s merge still explicitly clears
 * `keyId`/`keyName`/`keyCreatedAt` on the `"paste"` branch (set to
 * `undefined`, which its JSON write drops) rather than leaving them stale
 * from a previous device login on this same machine.
 *
 * `oldKeyKnownDead` comes from the preflight probe this action already ran:
 * when it already confirmed the STORED key was dead, the revoke below is
 * still attempted (best-effort; a repeat revoke of an already-gone row is
 * harmless), but the "(replaced...)" confirmation line is skipped -- there
 * is nothing meaningfully replaced about a key that was already dead.
 *
 * If `upsertAccount` itself throws (a corrupt store, an unwritable config
 * dir), the sign-in already succeeded server-side -- a device login already
 * minted a real, live key -- so nothing landed on disk is worse than the
 * save failure alone. Caught below: a `"device"` key is best-effort revoked
 * with ITSELF as bearer (`revokeApiKeyWithBearer`, since nothing was ever
 * stored to authenticate the ordinary way), and the failure is reported
 * with exit 1 rather than propagating as an uncaught exception.
 */
async function writeSignedInAccount(
  user: {
    username: string | null;
    email: string;
    github_username: string | null;
    role: string;
    sandbox_completed: boolean;
    sandbox_dataset_id?: string | null;
  },
  apiKey: string,
  keyInfo: { source: "device"; key: ApiKeySummary } | { source: "paste" },
  oldKeyKnownDead: boolean,
): Promise<void> {
  const accountKey = accountKeyFor(user);
  const keyFields: KeyFields =
    keyInfo.source === "device"
      ? {
          keySource: "device",
          keyId: keyInfo.key.id,
          keyName: keyInfo.key.name,
          keyCreatedAt: keyInfo.key.created_at,
        }
      : // Explicitly present-but-undefined, not merely omitted: a pasted key
        // replaces whatever this account's key WAS, so a stale keyId/keyName/
        // keyCreatedAt from a previous device login on this same machine must
        // be cleared, not left referring to a key that is no longer current.
        { keySource: "paste", keyId: undefined, keyName: undefined, keyCreatedAt: undefined };
  let previous: Config | undefined;
  try {
    ({ previous } = upsertAccount(accountKey, {
      apiKey,
      email: user.email,
      ...keyFields,
    }));
  } catch (error) {
    // A corrupt store or an unwritable config dir: the sign-in itself
    // succeeded server-side (a device login already minted a real key), but
    // nothing landed on disk. Leaving a live, un-saved key behind would be
    // worse than the save failure alone -- best-effort revoke it with ITS
    // OWN bearer (writeSignedInAccount was never called with it stored, so
    // getConfig().apiKey is stale or absent) before reporting.
    if (keyInfo.source === "device") {
      try {
        await revokeApiKeyWithBearer(keyInfo.key.id, apiKey);
      } catch {
        // Best-effort: report the save failure below regardless.
      }
    }
    console.log();
    console.log(
      chalk.red(
        `  Could not save your credentials (${errorDetail(error)}).${
          keyInfo.source === "device" ? " The new key was revoked;" : ""
        } fix ${getConfigPath()} and run \`nemar auth login\` again.`,
      ),
    );
    process.exitCode = 1;
    return;
  }
  applyServerUser(user);

  console.log();
  // "Welcome back" on the --key/NEMAR_API_KEY path, unchanged from before
  // this phase: a person pasting a key already holds an account. The
  // device path is the new first-time-or-returning browser flow, and gets
  // the plain "Welcome" this phase introduced.
  const greeting = keyInfo.source === "paste" ? "Welcome back" : "Welcome";
  console.log(`  ${greeting}${user.username ? `, ${chalk.cyan(user.username)}` : ""}!`);
  if (user.role === "owner") {
    console.log(`  ${chalk.red("Owner access enabled")}`);
  } else if (user.role === "admin") {
    console.log(`  ${chalk.magenta("Admin access enabled")}`);
  }

  if (!user.sandbox_completed) {
    console.log();
    console.log(chalk.yellow("  Note: Sandbox training required before uploading datasets"));
    console.log(chalk.dim("  Run 'nemar sandbox' to complete training"));
  }

  // A re-login on the SAME machine replaces its key, so a run never mints a
  // row per invocation until the MAX_LIVE_API_KEYS cap. Only when the merge
  // landed on an existing entry that already held a DIFFERENT
  // "device"-sourced key -- a pasted or password-era key belongs to more
  // than this one machine by definition, and is never revoked here. The
  // revoke is attempted even when the preflight probe already found the
  // stored key dead (a repeat revoke of an already-gone row is harmless,
  // caught below like any other failure) -- what that foreknowledge skips
  // is only the confirmation line, since there is nothing meaningfully
  // "replaced" about a key that was already dead.
  if (
    keyInfo.source === "device" &&
    previous?.keySource === "device" &&
    previous.keyId !== undefined &&
    previous.keyId !== keyInfo.key.id
  ) {
    try {
      await revokeApiKey(previous.keyId);
      if (!oldKeyKnownDead) {
        console.log(chalk.dim("  (replaced this machine's previous key)"));
      }
    } catch (error) {
      // The new key is already stored and works either way -- but a live
      // orphaned key is a real, actionable loose end, not silence: name it
      // and say how to clean it up by hand.
      console.log(
        chalk.yellow(
          `  Could not revoke this machine's previous key (${errorDetail(error)}); it stays active until you run \`nemar auth keys revoke ${previous.keyId}\`.`,
        ),
      );
    }
  }

  const refreshed = getConfig();
  printProfileGaps({
    gaps: refreshed.profileGaps,
    orcidVerified: refreshed.orcidVerified,
    sandboxCompleted: refreshed.sandboxCompleted,
  });
}

/** Print a non-success device-flow outcome and set the exit code (130 for a
 *  cancel, 1 for anything else). `login` and `signup` both funnel through
 *  this so a failure reads identically. */
function printDeviceOutcomeFailure(
  outcome: Exclude<DeviceLoginOutcome, { kind: "success" }>,
): void {
  const { lines, exitCode } = describeDeviceOutcome(outcome);
  console.log();
  const color = outcome.kind === "cancelled" ? chalk.yellow : chalk.red;
  for (const line of lines) console.log(color(line));
  process.exitCode = exitCode;
}

/** Exported login action handler for use in root-level shortcuts */
export async function loginAction(
  options: { key?: string; open?: boolean } & ConfirmOptions,
): Promise<void> {
  // `-k ""` is a REFUSAL, not a fall-through to the browser. `options.key || ...`
  // treats an explicitly-passed empty key as "no key given", so `-k "$VAR"` with
  // an unset VAR used to silently start a device sign-in against whatever backend
  // was configured -- opening a browser and beginning an account sign-in nobody
  // asked for. Found by test/cli.test.ts, which passes an empty TEST_ADMIN_API_KEY
  // when test/.env.test is absent and so opened the production authorize page.
  //
  // The flag and the env var are deliberately treated differently: passing a flag
  // is an intent to use THIS key, so an empty value is an error; an empty env var
  // is conventionally the same as an unset one, and still falls through.
  if (options.key !== undefined && options.key.trim() === "") {
    console.log(chalk.red("--key was given but is empty."));
    console.log(
      chalk.dim("  Pass the key itself, or drop --key to sign in with your browser instead."),
    );
    // This is a usage error, so suppress the exit hook's "attach the log to a new
    // issue" nudge (src/index.ts): inviting a bug report for someone's own typo
    // wastes their time and ours. Commander sets this itself for the errors it
    // raises -- `-k` with no value at all already prints no nudge -- so marking it
    // here keeps the two spellings of the same mistake consistent.
    markUsageExit();
    process.exitCode = 1;
    return;
  }

  const pastedKey = options.key || process.env.NEMAR_API_KEY;

  // Check for existing authentication. isAuthenticated() only proves a key
  // STRING is on disk, not that it still works, so probe the stored key's
  // liveness before deciding how to greet the user (#851).
  let oldKeyKnownDead = false;
  if (isAuthenticated()) {
    const cfg = getConfig();
    const storedKey = cfg.apiKey;
    let storedKeyState: KeyLivenessState = "unknown";
    if (storedKey) {
      const probe = ora("Checking your saved credentials...").start();
      try {
        const check = await login(storedKey);
        storedKeyState = check.valid ? "valid" : "invalid";
        probe.stop();
      } catch (error) {
        probe.stop();
        // Maintenance mode (503) already printed its own banner inside the API
        // layer; don't layer a contradictory "add another account?" prompt on
        // top of it — just stop here so the user retries when service is back.
        if (error instanceof MaintenanceError) return;
        // A definitive 401 means the key was revoked or expired server-side, so
        // mark it "invalid"; decideLoginPreflight routes that to same-account
        // re-auth. Anything else (offline network error, 5xx, unexpected) stays
        // "unknown": we keep the original multi-account prompt rather than
        // wrongly telling the user a working key is dead.
        storedKeyState =
          error instanceof ApiError && error.statusCode === 401 ? "invalid" : "unknown";
      }
    }
    oldKeyKnownDead = storedKeyState === "invalid";

    const preflight = decideLoginPreflight({
      hasStoredKey: true,
      storedKeyState,
      username: cfg.username,
    });

    if (pastedKey) {
      // --key / NEMAR_API_KEY is the one path that still asks a question.
      // Its "identity" is just a string on the command line, so
      // unlike the device flow it cannot establish for itself whether this
      // is the same account signing back in or a different one being added.
      if (preflight.kind === "active") {
        console.log(chalk.yellow(`Already logged in as ${preflight.username}`));
        console.log(
          chalk.dim("  This will add another account (use 'nemar auth switch' to switch)"),
        );
        const result = await confirm("Add a different account?", options);
        if (result !== "confirmed") return;
      } else if (preflight.kind === "stale") {
        // Stale: SAME account, dead key. Guide a straightforward re-auth instead
        // of the misleading "different account?" prompt the bug report hit.
        console.log(
          chalk.yellow(`Your saved API key for ${preflight.username} is no longer valid.`),
        );
        console.log(
          chalk.dim(
            "  It may have expired or been revoked (e.g. via 'nemar auth regenerate-key').",
          ),
        );
        console.log(chalk.dim("  Enter your new key below to re-authenticate."));
      }
    } else if (preflight.kind === "active") {
      // Device path: one notice, never a question -- the browser step is
      // where identity is actually established.
      console.log(
        chalk.yellow(
          `Already signed in as ${preflight.username}; signing in again refreshes this machine's key.`,
        ),
      );
    } else if (preflight.kind === "stale") {
      // The stale wording names the browser, not "enter your key": there is
      // no key to enter on this path.
      console.log(chalk.yellow(`Your saved key for ${preflight.username} is no longer valid.`));
      console.log(chalk.dim("  Sign in again below; the browser step continues."));
    }
  }

  if (pastedKey) {
    await loginWithPastedKey(pastedKey, oldKeyKnownDead);
    return;
  }

  const outcome = await runDeviceLogin({ open: options.open });
  if (outcome.kind === "success") {
    await writeSignedInAccount(
      outcome.user,
      outcome.api_key,
      { source: "device", key: outcome.key },
      oldKeyKnownDead,
    );
    return;
  }
  printDeviceOutcomeFailure(outcome);
}

/** The `--key`/`NEMAR_API_KEY` path: validate a pasted key with the backend
 *  before writing anything. */
async function loginWithPastedKey(apiKey: string, oldKeyKnownDead: boolean): Promise<void> {
  const spinner = ora("Validating API key...").start();

  try {
    const result = await login(apiKey);

    if (!result.valid) {
      // Routed through printStepFailure (rather than a bare spinner.fail)
      // so this feeds the debug bundle's "Failing step" line -- see #1257
      // review item 23.
      printStepFailure(spinner, "Invalid API key", "Check that your API key is correct");
      process.exitCode = 1;
      return;
    }

    spinner.succeed("Login successful");
    await writeSignedInAccount(result.user, apiKey, { source: "paste" }, oldKeyKnownDead);
  } catch (error) {
    // Same defect as the two branches above, same fix: this catch has
    // always been reachable on a genuine failure (a real 401/403/5xx, or a
    // network error) and never set an exit code either.
    process.exitCode = 1;
    if (error instanceof ApiError) {
      spinner.fail(error.message);
      recordStep(error.message);
      if (error.statusCode === 401) {
        console.log(chalk.dim("  Check that your API key is correct"));
      } else if (error.statusCode === 403) {
        console.log(chalk.dim("  Your account is not active; verify your email first"));
      }
    } else {
      spinner.fail("Connection failed");
      recordStep("Connection failed");
      console.log(chalk.dim("  Check your internet connection"));
    }
  }
}

const loginCmd = authCommand
  .command("login")
  .description("Sign in with your browser (opens NEMAR's device sign-in page)")
  .option("-k, --key <key>", "Paste an existing API key instead (alternative: NEMAR_API_KEY)")
  .option("--no-open", "Print the sign-in link instead of trying to open a browser")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(loginAction);

addVerboseHelp(
  loginCmd,
  `
Description:
  Prints a link and a code, tries to open your browser to it, then waits
  for you to authorize this machine there. The link and code are the real
  mechanism -- on a headless or remote host, copy the link into any
  browser; the browser attempt is only a convenience.

  Use --key (or set NEMAR_API_KEY) to paste an existing key instead, for a
  host that cannot poll or open a browser at all. It is validated with the
  backend before anything is written.

Environment Variables:
  NEMAR_API_KEY      An API key to use with --key
  NEMAR_NO_BROWSER=1 Never try to open a browser (same as --no-open)

Examples:
  $ nemar auth login                     # Browser sign-in
  $ nemar auth login --no-open           # Print the link only (headless)
  $ nemar auth login -k nemar_abc123...  # Paste an existing key`,
);

// ============================================================================
// Signup (epic #1272 phase 3; ADR 0045: one rule)
// ============================================================================
//
// The account itself is created by the device flow's browser step (ORCID
// sign-in), so there is no separate registration form here, no password,
// and no typed ORCID iD -- signup IS login, plus a few questions afterward
// for whatever `profile_gaps` says is still missing.

/** Prints one line naming what is still missing and returns `true` when
 *  stdin cannot prompt and at least one answer is still needed -- checked
 *  BEFORE any `inquirer.prompt` call in the flow below, for the same reason
 *  `confirm()` in lib/confirm.ts checks its own non-interactive guard up
 *  front rather than relying on a catch: under `stdin: "ignore"` inquirer's
 *  prompt never settles at all, so a failure this early has to be knowable
 *  without ever calling it. */
function guardNonInteractive(pendingFlags: string[]): boolean {
  if (pendingFlags.length === 0 || process.stdin.isTTY) return false;
  console.log(chalk.yellow(`Provide ${pendingFlags.join(", ")} (this terminal cannot prompt).`));
  process.exitCode = 1;
  return true;
}

export interface SignupCompletionOptions extends ConfirmOptions {
  username?: string;
  github?: string;
  city?: string;
  country?: string;
  why?: string;
  /** `false` for `--no-upload-access`. */
  uploadAccess?: boolean;
}

async function promptForRequired(message: string): Promise<string> {
  const { value } = await inquirer.prompt([
    {
      type: "input",
      name: "value",
      message,
      validate: (v: string) => (v?.trim() ? true : "Required"),
    },
  ]);
  return String(value).trim();
}

/**
 * Guided completion after the device flow signs into a fresh (or returning)
 * account: fetch the live profile, fill in what the CLI can set --
 * username, GitHub handle, city, country, exactly `PROFILE_GAP_MATRIX`'s CLI
 * fields (ADR 0045) -- via flag or prompt in ONE `PATCH /auth/profile`,
 * request upload access unless
 * `--no-upload-access`, then print whatever is still outstanding through
 * `printProfileGaps`. `profile_gaps` IS the checklist: the same one `nemar
 * auth status` and a refused upload-access request already read, so this
 * asks for nothing the server does not already say is missing -- a name
 * under a verified ORCID iD, for instance, is never prompted for here, only
 * reported.
 */
async function completeProfile(options: SignupCompletionOptions): Promise<void> {
  const spinner = ora("Checking your profile...").start();
  let user: ContractUser;
  try {
    user = await getCurrentUser();
    spinner.stop();
  } catch (error) {
    spinner.fail(`Could not read your profile: ${errorDetail(error)}`);
    process.exitCode = 1;
    return;
  }

  const gapFields = new Set((user.profile_gaps ?? []).map((gap) => gap.field));
  // Addressed even when it is not a `profile_gaps` entry: a server-assigned
  // handle (e.g. "jsmith2") is still worth a "keep or change" the moment an
  // account is new, and `isMissing` for `username` is false the instant it
  // is non-blank -- auto-assigned or not.
  const usernameIsGap = gapFields.has("username") || !user.username;
  const offerUsernameChange = user.username_auto_assigned === true;

  // Computed WITHOUT any I/O, so the one non-interactive line below can be
  // printed before the first prompt rather than discovered mid-flow. `-n`
  // deterministically declines the keep-or-change question (see below), so
  // it is the only offerUsernameChange case that provably needs the flag;
  // "keep" (confirmed, or a non-TTY default) needs nothing.
  const pendingFlags: string[] = [];
  if (usernameIsGap && !options.username) pendingFlags.push("--username");
  if (offerUsernameChange && !options.username && options.no === true)
    pendingFlags.push("--username");
  if (gapFields.has("github_username") && !options.github) pendingFlags.push("--github");
  if (gapFields.has("city") && !options.city) pendingFlags.push("--city");
  if (gapFields.has("country") && !options.country) pendingFlags.push("--country");
  if (guardNonInteractive(pendingFlags)) return;

  const patch: ProfilePatchRequest = {};

  if (offerUsernameChange) {
    if (options.username) {
      if (options.username !== user.username) patch.username = options.username;
    } else {
      // `confirm()` already carries its own non-TTY guard (returning
      // "cancelled"); treated the same as "confirmed" here -- keeping the
      // server's own pick is the safe default when nobody answered.
      const keep = await confirm(`Keep the username '${user.username}'?`, options, true);
      if (keep === "declined") {
        patch.username = options.username ?? (await promptForRequired("New username:"));
      }
    }
  } else if (usernameIsGap) {
    if (options.username) {
      patch.username = options.username;
    } else {
      // Best-effort: a suggestion failure still lets the person type one.
      const suggestion = await suggestUsername().catch(() => null);
      const { chosen } = await inquirer.prompt([
        {
          type: "input",
          name: "chosen",
          message: "Choose a username:",
          default: suggestion?.suggestion ?? undefined,
          validate: (v: string) => (v?.trim() ? true : "A username is required"),
        },
      ]);
      patch.username = String(chosen).trim();
    }
  }

  if (gapFields.has("github_username")) {
    patch.github_username =
      options.github ?? (await promptForRequired("GitHub username (for PR collaboration):"));
  }
  if (gapFields.has("city")) {
    patch.city = options.city ?? (await promptForRequired("City (for export-control screening):"));
  }
  if (gapFields.has("country")) {
    patch.country =
      options.country ?? (await promptForRequired("Country (for export-control screening):"));
  }

  if (Object.keys(patch).length > 0) {
    const patchSpinner = ora("Saving your profile...").start();
    try {
      await updateProfile(patch);
      patchSpinner.succeed("Profile updated");
    } catch (error) {
      failWithApiError(patchSpinner, error, "Could not save your profile");
      return;
    }
  }

  if (options.uploadAccess !== false) {
    let why = options.why?.trim();
    if (!why) {
      if (guardNonInteractive(["--why"])) return;
      const answers = await inquirer.prompt([
        {
          type: "input",
          name: "why",
          message: "What do you intend to upload to NEMAR?",
          validate: validateUploadAccessWhy,
        },
      ]);
      why = String(answers.why).trim();
    }
    await submitUploadAccessRequest(why);
  }

  await refreshStoredAccount();
  const cfg = getConfig();
  printProfileGaps({
    gaps: cfg.profileGaps,
    orcidVerified: cfg.orcidVerified,
    sandboxCompleted: cfg.sandboxCompleted,
  });
}

/** Exported signup action handler for use in root-level shortcuts */
export async function signupAction(
  options: SignupCompletionOptions & { open?: boolean },
): Promise<void> {
  console.log(chalk.cyan("NEMAR Account Sign-Up"));
  console.log(chalk.dim("Sign in with your browser to create or continue your account\n"));

  // Non-fatal heads-up about external tools needed for upload/validation, so
  // users (especially on Windows) learn what to install before they get there.
  await warnMissingPrerequisites();

  const outcome = await runDeviceLogin({ open: options.open });
  if (outcome.kind !== "success") {
    printDeviceOutcomeFailure(outcome);
    return;
  }
  // The stored-key preflight above never runs for a fresh signup on an
  // authenticated-from-scratch machine, so there is no "old key" to skip
  // revoking -- `oldKeyKnownDead` (ADR 0047: the revoke is attempted even
  // when the preflight probe already found the old key dead; it only skips
  // the confirmation line) is only ever meaningful when a stale key was
  // already probed.
  await writeSignedInAccount(
    outcome.user,
    outcome.api_key,
    { source: "device", key: outcome.key },
    false,
  );

  await completeProfile(options);
}

const signupCmd = authCommand
  .command("signup")
  .description("Create or continue your NEMAR account (browser sign-in, then a few questions)")
  .option("--username <name>", "Username to set, or to change to")
  .option("--github <handle>", "GitHub username")
  .option("--city <city>", "City")
  .option("--country <country>", "Country")
  .option("--why <text>", "What you intend to upload (20-500 characters)")
  .option("--no-upload-access", "Skip the upload-access request")
  .option("--no-open", "Print the sign-in link instead of trying to open a browser")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(signupAction);

addVerboseHelp(
  signupCmd,
  `
Description:
  Signs in with your browser like 'nemar auth login' -- ORCID creates a
  brand-new account the first time, or signs into an existing one. Then
  asks only what 'profile_gaps' says is still missing: a username (kept or
  changed if the server already assigned one), a GitHub handle, city, and
  country. Anything the CLI cannot set -- a name under a verified ORCID iD,
  for instance -- is reported, never prompted for.

  Ends by requesting upload access, unless --no-upload-access.

Examples:
  $ nemar auth signup
  $ nemar auth signup --no-open
  $ nemar auth signup --github octocat --city "San Diego" --country USA \\
      --why "Sharing our lab's 64-channel EEG study of motor imagery"`,
);

// ============================================================================
// Status / Whoami
// ============================================================================

/**
 * The `Key:` line (epic #1272 phase 3): what this machine's stored
 * credential IS, so a person can tell a browser-minted key from a
 * pasted one without running `nemar auth keys`. `undefined` when there is
 * no stored key at all (statusAction already returns before reaching this
 * for that case, but the guard keeps the function honest on its own).
 *
 * `keySource` absent is a password-era key: it predates both the device
 * flow and the `--key` validation this phase adds, so neither "device" nor
 * "paste" describes it.
 */
function describeStoredKey(cfg: {
  apiKey?: string;
  keyName?: string | null;
  keyCreatedAt?: string;
  keySource?: "device" | "paste";
}): string | undefined {
  if (!cfg.apiKey) return undefined;
  if (cfg.keySource === "device") {
    const name = cfg.keyName || "this machine";
    const when = cfg.keyCreatedAt ? cfg.keyCreatedAt.slice(0, 10) : "an unknown date";
    return `${name}, signed in via browser on ${when}`;
  }
  if (cfg.keySource === "paste") return "pasted key";
  return "password-era key; run `nemar auth login` to replace it with a machine-named key";
}

/** Exported status action handler for use in root-level shortcuts (whoami) */
export async function statusAction(options: { refresh?: boolean }): Promise<void> {
  if (!isAuthenticated()) {
    console.log(chalk.yellow("Not authenticated"));
    console.log();
    console.log("  Run 'nemar auth login' to authenticate");
    console.log("  Run 'nemar auth signup' to create an account");
    return;
  }

  // If refresh requested, fetch latest from server
  let userRole: string | undefined;
  // What this account IS (epic #1272 phase 4, #1284; ADR 0048), cached the
  // same way `userRole` is: printed only after a refresh, not read back from
  // the config cache on a plain `auth status`.
  let userKind: string | undefined;
  // Set when a requested refresh did not complete for a reason that is neither
  // 401 nor 403 (offline, 5xx, a shape drift). Everything printed below then
  // comes from the config cache, and the upload-access line in particular must
  // not present a stale `true` as the current answer (ADR 0040).
  let refreshFailure: string | undefined;
  if (options.refresh) {
    const spinner = ora("Fetching user info...").start();
    try {
      const user = await getCurrentUser();
      // Renames the stored entry once a username appears, and caches every
      // field below through the SAME logic `writeSignedInAccount` and
      // `refreshStoredAccount` use (epic #1272 phase 3) -- previously this
      // branch set the fields inline and never renamed, so an email-keyed
      // entry stayed email-keyed even after the account got a username.
      applyServerUser(user);
      userRole = user.role;
      userKind = user.account_kind;
      spinner.stop();
    } catch (error) {
      // Put the reason ON the failure line. It used to scroll past as a bare
      // "Could not refresh user info" and the cached values below then read as
      // if they had just been fetched.
      const reason = error instanceof Error ? error.message : String(error);
      spinner.fail(`Could not refresh user info: ${reason}`);
      refreshFailure = reason;
      if (error instanceof ApiError && error.statusCode === 401) {
        // The stored key is dead — don't fall through to a green "Authenticated"
        // banner that contradicts the failed refresh (#851).
        console.log(chalk.yellow("  Your saved API key is no longer valid (expired or revoked)."));
        console.log(chalk.dim("  Run 'nemar auth login' with a new key to re-authenticate."));
        return;
      }
      if (error instanceof ApiError && error.statusCode === 403) {
        // The key authenticates but the account is not active: unverified
        // email, or revoked. NOT "awaiting approval" -- approval is the
        // upload grant now (ADR 0040) and never gates the key. Same
        // reasoning as the 401 case: don't print a green "Authenticated"
        // banner that contradicts the failed refresh (#851).
        console.log(chalk.yellow("  Your account is not active (unverified email, or revoked)."));
        console.log(
          chalk.dim(
            "  Verify your email, or contact a NEMAR admin if you believe this is an error.",
          ),
        );
        return;
      }
    }
  }

  // Re-read config after potential refresh to show up-to-date values
  const cfg = getConfig();

  // Display active account status
  console.log(chalk.green("Authenticated"));
  console.log();
  if (cfg.username) {
    console.log(`  Username: ${chalk.cyan(cfg.username)}`);
  }
  if (cfg.email) {
    console.log(`  Email:    ${cfg.email}`);
  }
  if (cfg.githubUsername) {
    console.log(`  GitHub:   @${cfg.githubUsername}`);
  }
  if (userRole) {
    const roleDisplay =
      userRole === "owner"
        ? chalk.red("Owner")
        : userRole === "admin"
          ? chalk.magenta("Admin")
          : chalk.white("Member");
    console.log(`  Role:     ${roleDisplay}`);
  }
  // Only when not `person` (epic #1272 phase 4, #1284; ADR 0048): the
  // overwhelming majority of accounts are people, and a line that always
  // said "Kind: person" would be noise on every status check.
  if (userKind && userKind !== "person") {
    console.log(`  Kind:     ${chalk.yellow(userKind)}`);
  }
  const keyLine = describeStoredKey(cfg);
  if (keyLine) console.log(`  Key:      ${keyLine}`);
  // Upload access is the one-time admin approval (ADR 0040); `status` no
  // longer implies it, which is why it gets its own line. `undefined` means
  // this account has never been refreshed against a backend that reports it.
  //
  // A refresh that was asked for and failed makes the cached value a claim
  // about the past, not the present — the grant may have been revoked in
  // between, and "granted" is the answer that would send someone to attempt an
  // upload that then 403s. Report unknown and say why.
  if (refreshFailure) {
    console.log(
      `  Upload access: ${chalk.dim("unknown (refresh failed; showing cached account)")}`,
    );
  } else if (cfg.serviceAccess === true) {
    console.log(`  Upload access: ${chalk.green("granted")}`);
  } else if (cfg.serviceAccess === false) {
    // The explanation and the next step both come from the shared copy table
    // (#1268, ADR 0045), so the terminal and the website's upload-access card
    // say the same thing. They used to point at the support page, which was the
    // only answer available before ADR 0042 built the request.
    console.log(`  Upload access: ${chalk.yellow("not granted")}`);
    console.log(`    ${chalk.dim(accountCopy("upload_access.section.lede"))}`);
    console.log(`    ${chalk.cyan(accountCopy("cli.upload_access.cta"))}`);
  } else {
    console.log(`  Upload access: ${chalk.dim("unknown (run 'nemar auth status --refresh')")}`);
  }
  console.log(`  Config:   ${chalk.dim(getConfigPath())}`);

  // What the account is still missing, in the same sentences the website and a
  // refused upload-access request use (#1268, ADR 0045). Read from the cache
  // like the upload-access line above it, and for the same reason: this command
  // is expected to work offline. A refresh that was ASKED FOR and failed makes
  // the cache a claim about the past, so it reports not-checked rather than
  // presenting yesterday's list as today's.
  printProfileGaps({
    gaps: refreshFailure ? undefined : cfg.profileGaps,
    orcidVerified: cfg.orcidVerified,
    sandboxCompleted: refreshFailure ? undefined : cfg.sandboxCompleted,
  });

  // Show other stored accounts
  const accounts = getAccounts();
  const others = accounts.filter((a) => !a.active);
  if (others.length > 0) {
    console.log();
    // `a.username` is honestly optional now (epic #1272 phase 3): an entry
    // keyed by email has none, and reporting the map key instead of a made-up
    // username tells the truth about what `nemar auth switch` will select.
    console.log(
      `  Other accounts: ${others.map((a) => chalk.dim(a.username ?? a.key)).join(", ")}`,
    );
    console.log(chalk.dim("  Run 'nemar auth switch' to switch accounts"));
  }
}

authCommand
  .command("status")
  .description("Check current authentication status")
  .option("--refresh", "Refresh user info from server")
  .action(statusAction);

// whoami is an alias for status (common CLI pattern)
authCommand
  .command("whoami")
  .description("Show current user (alias for status)")
  .option("--refresh", "Refresh user info from server")
  .action(statusAction);

// ============================================================================
// Switch
// ============================================================================

/** Try to switch the gh CLI to the matching GitHub account (best-effort) */
async function switchGitHubAuth(githubUsername: string): Promise<void> {
  try {
    // Use Bun globals directly; dynamic import("bun") gets mangled by bun build --minify
    const ghPath = Bun.which("gh");
    if (!ghPath) {
      console.log(chalk.dim("  GitHub CLI (gh) not found in PATH, skipping"));
      return;
    }
    const proc = Bun.spawn({
      cmd: [ghPath, "auth", "switch", "--user", githubUsername],
      stdout: "pipe",
      stderr: "pipe",
    });
    // Read stderr before awaiting exit to avoid stream race conditions
    const stderrText = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      console.log(`  GitHub CLI switched to ${chalk.cyan(`@${githubUsername}`)}`);
    } else {
      const msg = stderrText.trim();
      if (msg.includes("not found") || msg.includes("no accounts")) {
        console.log(
          chalk.dim(`  GitHub CLI: @${githubUsername} not logged in (run 'gh auth login')`),
        );
      } else {
        console.log(chalk.dim(`  GitHub CLI switch failed: ${msg || `exit code ${exitCode}`}`));
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(chalk.dim(`  GitHub CLI switch skipped: ${msg}`));
  }
}

/** Exported switch action handler for use in root-level shortcuts */
export async function switchAction(identifier?: string): Promise<void> {
  const accounts = getAccounts();

  if (accounts.length === 0) {
    console.log(chalk.yellow("No stored accounts"));
    console.log("  Run 'nemar auth login' to add an account");
    return;
  }

  if (accounts.length === 1) {
    const only = accounts[0];
    if (only.active) {
      console.log(chalk.yellow(`Only one account stored: ${only.username ?? only.key}`));
      console.log("  Run 'nemar auth login' to add another account");
      return;
    }
  }

  // Same falsy-empty class as `auth login -k ""`, found by the same review: an
  // explicitly-passed empty identifier is falsy, so `nemar switch "$VAR"` with an
  // unset VAR fell through to the INTERACTIVE PICKER instead of refusing -- a
  // hanging prompt in a script, where `switch nobody` correctly says so and exits.
  if (identifier !== undefined && identifier.trim() === "") {
    console.log(chalk.red("Account name was given but is empty."));
    console.log(chalk.dim("  Name an account, or run 'nemar switch' with no argument to choose."));
    markUsageExit();
    process.exitCode = 1;
    return;
  }

  let target: string;

  if (identifier) {
    target = identifier;
  } else {
    // Interactive picker. `value`/`default` use `a.key` -- the actual
    // accounts-map key `switchAccount` indexes by -- not `a.username`,
    // which is honestly absent for an email-keyed entry (epic #1272 phase
    // 3) and would otherwise make that choice unselectable.
    const choices = accounts.map((a) => ({
      name: `${a.username ?? a.key}${a.githubUsername ? ` (@${a.githubUsername})` : ""}${a.active ? chalk.green(" (active)") : ""}`,
      value: a.key,
      short: a.username ?? a.key,
    }));

    const { selected } = await inquirer.prompt([
      {
        type: "list",
        name: "selected",
        message: "Switch to account:",
        choices,
        default: accounts.find((a) => a.active)?.key,
      },
    ]);
    target = selected;
  }

  // Check if already active
  const current = accounts.find((a) => a.active);
  if (current && current.key === target) {
    console.log(chalk.yellow(`Already using account ${current.username ?? current.key}`));
    return;
  }

  const switched = switchAccount(target);
  if (!switched) {
    console.log(chalk.red(`Account not found: ${target}`));
    console.log(chalk.dim("  Provide a NEMAR username or GitHub username"));
    console.log(chalk.dim(`  Available: ${accounts.map((a) => a.username ?? a.key).join(", ")}`));
    // Exit code, not just a message: a named account that does not exist is a
    // failure, and this returning 0 meant `nemar switch "$NAME" && do-something`
    // carried on against whichever account was already active. The empty-name guard
    // above exits 1, so 0 here would also make the weaker mistake the louder one.
    process.exitCode = 1;
    return;
  }

  console.log(chalk.green(`Switched to ${chalk.cyan(switched.username || target)}`));

  // Switch gh CLI auth if possible
  if (switched.githubUsername) {
    await switchGitHubAuth(switched.githubUsername);
  }
}

const switchCmd = authCommand
  .command("switch [username]")
  .description("Switch between stored accounts")
  .action(switchAction);

addVerboseHelp(
  switchCmd,
  `
Description:
  Switch the active NEMAR account. You can specify a NEMAR username or
  GitHub username. If no username is given, an interactive picker is shown.

  Switching also updates the GitHub CLI (gh) to the matching account.

Examples:
  $ nemar auth switch              # Interactive picker
  $ nemar auth switch yahya        # Switch by NEMAR username
  $ nemar auth switch cool-vibers  # Switch by GitHub username`,
);

// ============================================================================
// Logout
// ============================================================================

/**
 * Best-effort revoke of the ACTIVE account's key (epic #1272 phase 3, ADR
 * 0047).
 *
 * Default: revoke only a `"device"`-sourced key -- a pasted or password-era
 * key is by definition not this machine's alone to kill, so it is kept and
 * the caller is told where to revoke it deliberately. `--revoke-key` forces
 * a revoke regardless of source; `--no-revoke-key` skips it entirely; both
 * are declared as a negatable Commander pair so ABSENCE of either reads as
 * `undefined` ("derive from keySource"), not as a false default.
 *
 * A 401 counts as already done (the key is gone either way). Anything else
 * -- network failure, 5xx -- is reported as a warning; the caller clears the
 * LOCAL account regardless, since a revoke that could not be confirmed is
 * not a reason to leave a dead credential sitting in the config file.
 */
async function revokeStoredKey(
  account: { keySource?: "device" | "paste" },
  options: { revokeKey?: boolean },
): Promise<void> {
  if (options.revokeKey === false) return;
  const shouldRevoke = options.revokeKey === true || account.keySource === "device";
  if (!shouldRevoke) {
    if (account.keySource !== "device") {
      console.log(
        chalk.dim(
          "  This key may be used on other machines and was kept; revoke it with " +
            "'nemar auth keys revoke' or in Settings on nemar.org.",
        ),
      );
    }
    return;
  }
  try {
    await revokeApiKey("current");
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 401) return;
    console.log(
      chalk.yellow(
        `  Could not revoke this machine's key (${errorDetail(error)}); it stays valid.`,
      ),
    );
  }
}

/** Exported logout action handler for use in root-level shortcuts */
export async function logoutAction(
  options: ConfirmOptions & { all?: boolean; revokeKey?: boolean },
): Promise<void> {
  if (!isAuthenticated()) {
    console.log(chalk.yellow("Not currently authenticated"));
    return;
  }

  if (options.all) {
    const accounts = getAccounts();
    const result = await confirm(`Log out all ${accounts.length} stored account(s)?`, options);
    if (result !== "confirmed") return;
    // Each account's key is revoked with ITS OWN bearer: the active account
    // has to be switched to it first, since request()'s authenticated path
    // always reads the currently active credential. `account.key` (the
    // accounts-map key, epic #1272 phase 3) rather than `account.username`,
    // which is honestly absent for an email-keyed entry and would switch to
    // nothing for exactly the accounts this loop most needs to reach.
    for (const account of accounts) {
      switchAccount(account.key);
      await revokeStoredKey(account, options);
    }
    clearAllConfig();
    console.log(chalk.green("All accounts removed"));
    return;
  }

  const cfg = getConfig();
  const result = await confirm(`Log out ${cfg.username || "current user"}?`, options);
  if (result !== "confirmed") return;

  await revokeStoredKey(cfg, options);

  clearConfig();
  console.log(chalk.green("Logged out successfully"));

  // If other accounts remain, inform the user
  const remaining = getAccounts();
  if (remaining.length > 0) {
    const active = remaining.find((a) => a.active);
    if (active) {
      console.log(`  Switched to ${chalk.cyan(active.username)}`);
    }
  }
}

const logoutCmd = authCommand
  .command("logout")
  .description("Remove the active account (use --all to remove all)")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .option("--all", "Remove all stored accounts")
  .option("--revoke-key", "Revoke this machine's key even if it may be shared")
  .option("--no-revoke-key", "Never revoke the key server-side, only clear it locally")
  .action(logoutAction);

addVerboseHelp(
  logoutCmd,
  `
Description:
  Clears the active account's credential from this machine. A key this
  machine's own 'nemar auth login' minted (device sign-in) is also revoked
  server-side by default, since it is not used anywhere else; a pasted or
  password-era key may be shared with other machines and is kept -- revoke
  it deliberately with 'nemar auth keys revoke' or in Settings on nemar.org.

Examples:
  $ nemar auth logout                # Remove the active account
  $ nemar auth logout --no-revoke-key # Clear locally, keep the key valid
  $ nemar auth logout --all          # Remove every stored account`,
);

// ============================================================================
// Resend Verification
// ============================================================================

authCommand
  .command("resend-verification")
  .description("Resend email verification link")
  .action(async () => {
    const { email } = await inquirer.prompt([
      {
        type: "input",
        name: "email",
        message: "Enter your email address:",
        validate: (input) => {
          if (!input || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input)) {
            return "Please enter a valid email address";
          }
          return true;
        },
      },
    ]);

    const spinner = ora("Sending verification email...").start();

    try {
      const result = await resendVerification(email);
      spinner.succeed(result.message);
    } catch (error) {
      if (error instanceof ApiError) {
        spinner.fail(error.message);
        if (error.statusCode === 0) {
          console.log(chalk.dim("  Check your internet connection"));
        }
      } else {
        spinner.fail(
          `Failed to send verification email: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
        console.log(chalk.dim("  Check your internet connection"));
      }
    }
  });

// ============================================================================
// Setup SSH
// ============================================================================

/** Exported setup-ssh action handler for use in root-level shortcuts */
export async function setupSSHAction(options: { force?: boolean }): Promise<void> {
  // Check authentication
  if (!isAuthenticated()) {
    console.log(chalk.yellow("Not authenticated"));
    console.log();
    console.log("  Run 'nemar auth login' first to authenticate");
    return;
  }

  const config = getConfig();

  // Test if SSH already works
  if (!options.force) {
    const spinner = ora("Checking existing SSH access...").start();
    const sshTest = await testGitHubSSH();

    if (sshTest.success) {
      spinner.succeed("SSH access to GitHub already configured");
      if (sshTest.username) {
        console.log(`  GitHub user: ${chalk.cyan(sshTest.username)}`);
      }
      console.log();
      console.log(chalk.dim("Use --force to regenerate SSH key anyway"));
      return;
    }
    spinner.info("SSH access to GitHub not configured");
  }

  console.log();
  console.log(chalk.cyan("Setting up SSH access for GitHub"));
  console.log(chalk.dim("This will generate a dedicated SSH key for NEMAR uploads\n"));

  // Step 1: Generate SSH key
  let publicKey: string | null = null;
  const paths = getSSHKeyPaths();

  if (nemarSSHKeyExists() && !options.force) {
    console.log(chalk.dim(`  Using existing key: ${paths.privateKey}`));
    publicKey = readPublicKey();
  } else {
    const spinner = ora("Generating SSH key...").start();
    const keyResult = await generateSSHKey(config.email || "nemar-user");

    if (!keyResult.success) {
      spinner.fail("Failed to generate SSH key");
      console.log(chalk.dim(`  ${keyResult.error}`));
      return;
    }

    spinner.succeed("SSH key generated");
    console.log(chalk.dim(`  Private key: ${paths.privateKey}`));
    console.log(chalk.dim(`  Public key: ${paths.publicKey}`));
    publicKey = keyResult.publicKey || null;
  }

  if (!publicKey) {
    console.log(chalk.red("Could not read public key"));
    return;
  }

  // Step 2: Configure SSH
  const configSpinner = ora("Configuring SSH...").start();
  const configResult = configureSSHForGitHub();

  if (!configResult.success) {
    configSpinner.fail("Failed to configure SSH");
    console.log(chalk.dim(`  ${configResult.error}`));
    return;
  }
  configSpinner.succeed("SSH configured for GitHub");

  // Step 3: Check if key is already registered with GitHub
  console.log();
  const verifySpinner = ora("Testing SSH connection to GitHub...").start();

  const verifyResult = await testGitHubSSH();

  if (verifyResult.success) {
    verifySpinner.succeed("SSH connection verified");
    if (verifyResult.username) {
      console.log(`  GitHub user: ${chalk.cyan(verifyResult.username)}`);
    }
    console.log();
    console.log(chalk.green("SSH setup complete! You can now upload datasets."));
    return;
  }

  verifySpinner.info("SSH key generated but not yet added to GitHub");

  // Step 4: Show instructions to add key to GitHub
  console.log();
  console.log(chalk.yellow("To complete setup, add this SSH key to your GitHub account:"));
  console.log();
  console.log(chalk.cyan(`  ${publicKey}`));
  console.log();
  console.log("Steps:");
  console.log("  1. Copy the key above");
  console.log(`  2. Go to: ${chalk.underline("https://github.com/settings/ssh/new")}`);
  console.log(`  3. Title: ${chalk.dim("NEMAR CLI")}`);
  console.log("  4. Paste the key and click 'Add SSH key'");
  console.log();
  console.log(chalk.dim("After adding the key, run 'nemar auth setup-ssh' again to verify."));
}

const setupSshCmd = authCommand
  .command("setup-ssh")
  .description("Configure SSH access for GitHub (optional, gh CLI preferred)")
  .option("-f, --force", "Regenerate SSH key even if one exists")
  .action(setupSSHAction);

addVerboseHelp(
  setupSshCmd,
  `
Description:
  Configures SSH access for GitHub as an alternative to gh CLI (HTTPS).
  Most users should use 'gh auth login' instead; SSH is only needed if
  you cannot use the GitHub CLI.

  1. Generate a dedicated Ed25519 SSH key for NEMAR (~/.ssh/nemar_ed25519)
  2. Configure SSH to use this key for GitHub
  3. Verify the connection (prompts you to add the key to GitHub if needed)

Examples:
  $ nemar auth setup-ssh          # Set up SSH access
  $ nemar auth setup-ssh --force  # Regenerate key even if exists`,
);

// ============================================================================
// Retired: retrieve-key (ADR 0097)
// ============================================================================

// A hidden stub rather than a deletion. The "your API key is ready" mail sent
// when an account verified its email, and pages outside this repository, told
// people to run it, so "unknown command" would leave them with no next step.
// It takes no input, prompts for nothing and calls no endpoint.
authCommand
  .command("retrieve-key", { hidden: true })
  .description("Removed: there is no password sign-in")
  .allowUnknownOption()
  .allowExcessArguments()
  .action(() => {
    console.error(
      chalk.yellow("Password sign-in was removed, so 'nemar auth retrieve-key' no longer exists."),
    );
    console.error(
      `  Run ${chalk.cyan("nemar auth login")} to sign in with your browser; it also creates your API key.`,
    );
    // A command retired on purpose is an answer, not a crash: no "attach a debug log" hint.
    markReportedExit();
    process.exitCode = 1;
  });

// ============================================================================
// Regenerate Key
// ============================================================================

const regenerateKeyCmd = authCommand
  .command("regenerate-key")
  .description("Request a new API key (revokes current key, requires email verification)")
  .action(async () => {
    console.log(
      chalk.dim(
        "  This revokes the key on EVERY machine, not just this one; see 'nemar auth keys revoke'.",
      ),
    );
    console.log();
    console.log(chalk.yellow("API Key Regeneration"));
    console.log(chalk.dim("This will revoke your current key and generate a new one\n"));

    const { email } = await inquirer.prompt([
      {
        type: "input",
        name: "email",
        message: "Email address associated with your account:",
        validate: (input) => {
          if (!input || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input)) {
            return "Please enter a valid email address";
          }
          return true;
        },
      },
    ]);

    const spinner = ora("Sending verification email...").start();

    try {
      const result = await requestKeyRegeneration(email);
      spinner.succeed("Verification email sent");
      console.log();
      console.log("Next steps:");
      console.log("  1. Check your email for a verification link");
      console.log("  2. Click the link to generate your new API key");
      console.log("  3. Copy the new key and run 'nemar auth login -k <new-key>'");
      console.log();
      console.log(chalk.dim("The link expires in 1 hour"));
    } catch (error) {
      // This is the only way to replace a lost key without an already signed-in
      // machine, so a failure has to be visible to a script, not only a person.
      process.exitCode = 1;
      if (error instanceof ApiError) {
        // A refusal the server explained (not allowed, rate limit) is reported, not a bug. A
        // 400, 404 or 405 is a client and server that disagree about the route, which is when the
        // debug-log nudge is wanted.
        if ([401, 403, 429].includes(error.statusCode)) markReportedExit();
        spinner.fail(error.message);
      } else {
        spinner.fail("Failed to send verification email");
        console.log(chalk.dim("  Check your internet connection"));
      }
    }
  });

addVerboseHelp(
  regenerateKeyCmd,
  `
Description:
  If you lost your API key or it was compromised, use this command to
  request a new one. A verification email will be sent to confirm the
  request. Clicking the link will:

  1. Revoke your current API key ON EVERY MACHINE, not just this one --
     use 'nemar auth keys revoke' instead to remove only one machine's key
  2. Generate a new API key (shown in the browser)
  3. Use the new key with 'nemar auth login -k <new-key>'; a plain
     'nemar auth login' signs in with your browser and makes another key

Examples:
  $ nemar auth regenerate-key`,
);

// ============================================================================
// Request Upload Access (ADR 0042, #1253, epic #1250)
//
// Verifying your email makes the account usable (browse, API key, sandbox);
// UPLOADING needs a one-time admin grant on top of it, and this is how you ask
// for it. Before #1253 the 403 could only point at the support page.
// ============================================================================

/**
 * Say so when the request landed but no admin was reached.
 *
 * The request IS recorded either way, so this is a warning and not a failure;
 * what makes it worth printing is that the fix is in the user's hands (run the
 * command again) and is otherwise invisible -- a silent `ok` here means waiting
 * for a review nobody has been asked for. `undefined` is a backend that
 * predates the notification stamp, and says nothing rather than guessing.
 */
function warnIfAdminsNotNotified(result: UploadAccessRequestResponse): void {
  if (result.email_sent !== false) return;
  console.log();
  console.log(
    chalk.yellow(
      "  Warning: your request is recorded but admins could not be notified;\n" +
        "  it will be retried when you run this command again.",
    ),
  );
}

/**
 * The prompt's own check on the why text, extracted so it can be tested.
 *
 * Returns `true` when the text is acceptable, or the message inquirer should
 * show. It exists to stop a user typing 400 characters and THEN being refused
 * by the server for a reason the terminal already knew -- it is not the rule
 * itself, which lives at the route (services/upload-access.ts). Both read their
 * bounds from shared/contract so the prompt cannot accept something the server
 * will reject, which is the failure mode a local copy of "20" would create.
 */
export function validateUploadAccessWhy(input: string | undefined): true | string {
  const text = (input ?? "").trim();
  if (text.length < UPLOAD_ACCESS_WHY_MIN_CHARS) {
    return `Please write at least ${UPLOAD_ACCESS_WHY_MIN_CHARS} characters`;
  }
  if (text.length > UPLOAD_ACCESS_WHY_MAX_CHARS) {
    return `Please keep it under ${UPLOAD_ACCESS_WHY_MAX_CHARS} characters`;
  }
  return true;
}

/**
 * `POST /users/me/upload-access/request`, and every line of its rendering --
 * shared by `nemar auth request-upload-access` and `nemar auth signup`'s
 * guided completion (epic #1272 phase 3) so the two say exactly
 * the same thing about the same request rather than two near-identical
 * copies drifting apart. Sets `process.exitCode = 1` on any failure; never
 * throws.
 */
async function submitUploadAccessRequest(why: string): Promise<void> {
  const spinner = ora("Submitting upload access request...").start();
  try {
    const result = await requestUploadAccess(why);
    // Both outcomes are stated in the website's own words (#1268, ADR 0045):
    // a person who asked from the dashboard and then checked from a terminal
    // must not be told two different things about one request.
    if (result.already_requested) {
      spinner.info(accountCopy("upload_access.requested.title"));
      console.log(chalk.dim(`  ${accountCopy("upload_access.requested.lede")}`));
      warnIfAdminsNotNotified(result);
      return;
    }
    spinner.succeed(accountCopy("upload_access.requested.title"));
    console.log();
    console.log(`  ${accountCopy("upload_access.requested.body")}`);
    console.log(chalk.dim("  Check any time with 'nemar auth status --refresh'."));
    warnIfAdminsNotNotified(result);
  } catch (error) {
    if (!(error instanceof ApiError)) {
      spinner.fail("Failed to submit upload access request");
      console.log(chalk.dim("  Check your internet connection"));
      process.exitCode = 1;
      return;
    }

    spinner.fail(error.message);
    // The API names the fields it is still missing; print each one with
    // where to fix it rather than making the user map an error sentence back
    // onto a settings form (ADR 0042).
    if (error.missing && error.missing.length > 0) {
      // `orcidVerified` from the config cache, because a refusal names the
      // FIELD and not the account state (#1268). It is what decides whether
      // the name halves point at `nemar auth profile set-name` or at the
      // ORCID record -- with a verified iD linked the record owns the name
      // and the PATCH refuses the edit, so the command would be advice that
      // cannot work. Absent (never refreshed) reads as false, which is the
      // pre-#1268 wording rather than a wrong one.
      printGapList(
        accountCopy("gaps.request.title"),
        resolveProfileGaps(error.missing, { orcidVerified: getConfig().orcidVerified === true }),
      );
      console.log();
      console.log(chalk.dim("  Settings: https://nemar.org/settings"));
    }
    process.exitCode = 1;
  }
}

const requestUploadAccessCmd = authCommand
  .command("request-upload-access")
  .description("Ask an admin for upload access (one-time)")
  .option("--why <text>", "What you intend to upload (20-500 characters)")
  .action(async (options: { why?: string }) => {
    // Checked before the spinner starts, rather than left to the client's own
    // 401: this is an action, not a query, so it exits non-zero, and a script
    // must not see "Submitting upload access request..." for a request that was
    // never going to be sent.
    if (!isAuthenticated()) {
      console.log(chalk.yellow("Not authenticated"));
      console.log();
      console.log("  Run 'nemar auth login' to authenticate");
      process.exitCode = 1;
      return;
    }

    let why = (options.why ?? "").trim();
    if (!why) {
      if (!process.stdin.isTTY) {
        console.log(chalk.yellow("Provide --why (this terminal cannot prompt)."));
        process.exitCode = 1;
        return;
      }
      const answers = await inquirer.prompt([
        {
          type: "input",
          name: "why",
          message: "What do you intend to upload to NEMAR?",
          validate: validateUploadAccessWhy,
        },
      ]);
      why = String(answers.why).trim();
    }

    await submitUploadAccessRequest(why);
  });

addVerboseHelp(
  requestUploadAccessCmd,
  `
Description:
  Uploading datasets needs upload access: a one-time grant an admin makes
  after reviewing who you are and where you are. Verifying your email is
  not enough on its own, and nothing grants it automatically.

  Before asking, your account needs a username, your given and family name,
  a GitHub username that exists, and your city and country. Set them in
  Settings on nemar.org; the request tells you which ones are missing.

  Asking twice does nothing: while a request is open the command reports
  that and no second message reaches the admins.

Examples:
  $ nemar auth request-upload-access
  $ nemar auth request-upload-access --why "Sharing our lab's 64-channel EEG study of motor imagery"`,
);

// ============================================================================
// Keys (epic #1272 phase 3; ADR 0047)
// ============================================================================
//
// Every named key on the account -- one minted per machine by the device
// flow, plus any pasted key created here for a host that cannot run it.
// `nemar auth login`/`logout` cover the common case (this machine's own
// key); this group is for looking at or managing the whole set, including
// another machine's.

/** One row of `nemar auth keys`. Exported so the rendering is testable
 *  without parsing terminal output. */
export function formatKeyRow(key: ApiKeySummary): string {
  const name = key.name || chalk.dim("(unnamed)");
  const marker = key.current ? chalk.dim(" (this machine)") : "";
  const lastUsed = key.last_used_at ? key.last_used_at.slice(0, 10) : "never";
  return `  ${chalk.cyan(String(key.id))}  ${name}${marker}\n      ${key.prefix}...  created ${key.created_at.slice(0, 10)}, last used ${lastUsed}`;
}

/** `nemar auth keys` (also the group's default action -- no subcommand). */
export async function keysListAction(): Promise<void> {
  if (!isAuthenticated()) {
    console.log(chalk.yellow("Not authenticated"));
    console.log();
    console.log("  Run 'nemar auth login' to authenticate");
    process.exitCode = 1;
    return;
  }
  const spinner = ora("Fetching keys...").start();
  try {
    const { keys } = await listApiKeys();
    spinner.stop();
    if (keys.length === 0) {
      console.log(chalk.yellow("No keys on this account"));
      return;
    }
    for (const key of keys) console.log(formatKeyRow(key));
  } catch (error) {
    failWithApiError(spinner, error, "Could not fetch keys");
  }
}

/** `nemar auth keys create <name>`: the paste-key fallback for a machine
 *  that cannot run the device flow's browser half. */
export async function keysCreateAction(name: string): Promise<void> {
  if (!isAuthenticated()) {
    console.log(chalk.yellow("Not authenticated"));
    console.log();
    console.log("  Run 'nemar auth login' to authenticate");
    process.exitCode = 1;
    return;
  }
  const spinner = ora(`Creating key "${name}"...`).start();
  try {
    const result = await createApiKey(name);
    spinner.succeed("Key created");
    console.log();
    console.log(
      chalk.yellow("Your new API key (store this securely; it will not be shown again):"),
    );
    console.log(`  ${result.api_key}`);
    console.log();
    console.log("  Paste it into the CLI on the other machine:");
    console.log(
      `    ${chalk.cyan("nemar auth login --key")} ${chalk.dim("<paste the key above>")}`,
    );
  } catch (error) {
    failWithApiError(spinner, error, "Could not create the key");
  }
}

/** Either a key's row id, or the literal `"current"` for the key presenting
 *  THIS request. Validated at the Commander argument boundary, matching
 *  `parseOrcidTimeout`: a bad value is a usage error, not a request that
 *  reaches the backend only to be told `key_not_found`. */
export type KeyRevokeTarget = number | "current";

export function parseKeyRevokeTarget(raw: string): KeyRevokeTarget {
  if (raw === "current") return "current";
  if (/^\d+$/.test(raw)) return Number(raw);
  throw new InvalidArgumentError("Expected a key id (a number) or 'current'");
}

/** `nemar auth keys revoke <id|current>`. */
export async function keysRevokeAction(target: KeyRevokeTarget): Promise<void> {
  if (!isAuthenticated()) {
    console.log(chalk.yellow("Not authenticated"));
    console.log();
    console.log("  Run 'nemar auth login' to authenticate");
    process.exitCode = 1;
    return;
  }
  const spinner = ora(
    target === "current" ? "Revoking this machine's key..." : `Revoking key ${target}...`,
  ).start();
  try {
    await revokeApiKey(target);
    spinner.succeed(target === "current" ? "This machine's key revoked" : `Key ${target} revoked`);
    if (target === "current") {
      console.log(chalk.dim("  Run 'nemar auth login' to sign back in on this machine."));
    }
  } catch (error) {
    failWithApiError(spinner, error, "Could not revoke the key");
  }
}

const keysCmd = authCommand
  .command("keys")
  .description("List, create, or revoke this account's named API keys")
  .action(keysListAction);

keysCmd
  .command("list")
  .description("List this account's live keys (same as 'nemar auth keys')")
  .action(keysListAction);

keysCmd
  .command("create")
  .description("Mint a named key -- the paste-key fallback for a machine without a browser")
  .argument("<name>", "A name for the machine this key is for")
  .action(keysCreateAction);

keysCmd
  .command("revoke")
  .description("Revoke a key by id, or 'current' for this machine's own")
  .argument("<idOrCurrent>", "A key id, or 'current'", parseKeyRevokeTarget)
  .action(keysRevokeAction);

addVerboseHelp(
  keysCmd,
  `
Description:
  Every named key on this account: one minted per machine by a
  browser-based 'nemar auth login' (the -k/--key or NEMAR_API_KEY path
  stores the key you paste and mints nothing new), plus any created here
  for a machine that cannot open a browser.

  'nemar auth login'/'logout' already cover the common case -- this
  machine's own key; use this group to look at or manage the whole set.

Examples:
  $ nemar auth keys                       # List (default action)
  $ nemar auth keys create build-box      # Mint a key for a headless host
  $ nemar auth keys revoke 12             # Revoke by id
  $ nemar auth keys revoke current        # Revoke this machine's own key`,
);

// ============================================================================
// Profile (#1254, epic #1250; ADR 0043)
// ============================================================================

/** Rendered for a field the backend sent as null/empty. */
const NOT_SET = "not set";

/**
 * `verified` / `not verified` / `unknown` for a tri-state flag.
 *
 * `undefined` is a backend that predates #1254, and it renders as unknown
 * rather than as "not verified" for the same reason `Upload access` does (ADR
 * 0040): telling someone their confirmed inbox is unconfirmed sends them to
 * redeem a code they do not need.
 */
function verifiedMark(flag: boolean | undefined): string {
  if (flag === undefined) return chalk.dim("verification state unknown");
  return flag ? chalk.green("verified") : chalk.yellow("not verified");
}

/**
 * `nemar auth profile` — what this account's identifiers currently are, and
 * where each one is changed.
 *
 * Separate from `nemar auth status`, which answers "am I logged in and can I
 * upload" from the CONFIG CACHE. This one always fetches: it is the command
 * someone runs because they are about to change an identifier, and a cached
 * answer is exactly the wrong thing to hand them there.
 *
 * The footer is the load-bearing half. Identity uniqueness means a duplicate
 * account is refused rather than created (ADR 0043), so the message a person
 * hits is "that iD already belongs to an account" -- and the only useful next
 * sentence is where to go and change it. Since #1266 every one of them is
 * self-service from here as well as from Settings, so the footer names the
 * command rather than a page the person then has to find.
 */
export async function profileAction(): Promise<void> {
  if (!isAuthenticated()) {
    console.log(chalk.yellow("Not authenticated"));
    console.log();
    console.log("  Run 'nemar auth login' to authenticate");
    return;
  }

  const spinner = ora("Fetching account profile...").start();
  let user: Awaited<ReturnType<typeof getCurrentUser>>;
  try {
    user = await getCurrentUser();
    spinner.stop();
  } catch (error) {
    spinner.fail(`Could not fetch your profile: ${errorDetail(error)}`);
    if (error instanceof ApiError && error.statusCode === 401) {
      console.log(chalk.dim("  Run 'nemar auth login' with a current API key."));
    }
    process.exitCode = 1;
    return;
  }

  const fullName = [user.given_name, user.family_name].filter(Boolean).join(" ");

  console.log();
  console.log(chalk.bold("Account"));
  console.log(`  Username: ${user.username ? chalk.cyan(user.username) : chalk.dim(NOT_SET)}`);
  console.log(`  Name:     ${fullName ? fullName : chalk.dim(NOT_SET)}`);
  console.log(`  Email:    ${user.email}  ${verifiedMark(user.email_verified)}`);
  console.log(
    `  GitHub:   ${user.github_username ? `@${user.github_username}` : chalk.dim(NOT_SET)}`,
  );
  console.log(
    `  ORCID:    ${user.orcid ? `${user.orcid}  ${verifiedMark(user.orcid_verified)}` : chalk.dim(NOT_SET)}`,
  );
  console.log(`  Role:     ${user.role}`);

  console.log();
  console.log(chalk.bold("Access"));
  console.log(`  Tier:          ${user.status ?? chalk.dim("unknown")}`);
  // Same three states as `nemar auth status`, and for the same reason: a
  // backend that predates ADR 0040 sends nothing, and "not granted" is the one
  // wrong answer to give someone who already holds the grant.
  if (user.service_access === true) {
    console.log(`  Upload access: ${chalk.green("granted")}`);
  } else if (user.service_access === false) {
    console.log(`  Upload access: ${chalk.yellow("not granted")}`);
    console.log(`    ${chalk.dim(accountCopy("upload_access.section.lede"))}`);
    console.log(`    ${chalk.cyan(accountCopy("cli.upload_access.cta"))}`);
  } else {
    console.log(`  Upload access: ${chalk.dim("unknown (backend did not report it)")}`);
  }

  // The same block `nemar auth status` prints, from a live fetch rather than
  // from the cache. `undefined` here is a backend that predates phase 8, not a
  // stale cache, so it says so rather than telling the user to refresh -- this
  // command just did.
  printProfileGaps({
    gaps: user.profile_gaps,
    orcidVerified: user.orcid_verified === true,
    sandboxCompleted: user.sandbox_completed,
    unknownReason: accountCopy("cli.gaps.unreported"),
  });

  console.log();
  console.log(chalk.bold("Where to change each"));
  console.log(`  Email       ${chalk.cyan("nemar auth profile set-email <address>")}`);
  console.log(`  Username    ${chalk.cyan("nemar auth profile set-username <name>")}`);
  console.log(
    `  Name        ${chalk.cyan("nemar auth profile set-name --given <g> --family <f>")}`,
  );
  console.log(`  GitHub      ${chalk.cyan("nemar auth profile set-github <handle>")}`);
  console.log(`  ORCID       ${chalk.cyan("nemar auth profile orcid link|relink|unlink")}`);
  console.log(
    `  Location    ${chalk.cyan("nemar auth profile set-location --city <c> --country <k>")}`,
  );
  console.log(
    `  Upload access          ${chalk.dim("one-time admin approval; nemar auth request-upload-access")}`,
  );
  console.log();
  console.log(
    chalk.dim(
      "  Every one of these is also in Settings on https://nemar.org/settings — same rules, same checks.",
    ),
  );
  console.log();
  console.log(
    chalk.dim(
      "An ORCID iD, an email address, and a GitHub username each back at most one NEMAR account. If a sign-up or a link is refused because one is taken, change it on the account that already has it rather than making a second one.",
    ),
  );
}

const profileCmd = authCommand
  .command("profile")
  .description("Show your account identifiers and where to change each")
  .action(profileAction);

addVerboseHelp(
  profileCmd,
  `
Description:
  Prints the identifiers on your account — username, name, email, GitHub
  username, ORCID iD — with the verification state of the email and the
  ORCID link, your access tier, and whether upload access has been granted.

  Always fetched from the server, never from the local config cache: this is
  the command you run before changing something, so a stale answer is worse
  than no answer.

  Each of the ORCID iD, the email address, and the GitHub username backs at
  most one NEMAR account. A second sign-up with any of them is refused rather
  than creating a duplicate; the fix is to change the identifier on the
  account that already holds it.

Subcommands (the same changes Settings on nemar.org makes):
  set-email <address>     mail a code to a new address, then verify-email
  verify-email <code>     finish the change
  set-username <name>     set your NEMAR handle (locked once approved)
  set-name                --given / --family (ORCID wins when a verified iD is linked)
  set-github <handle>     set the GitHub username (checked against GitHub)
  set-location            --city / --country
  orcid link|relink|unlink   opens a browser for ORCID's consent screen

Examples:
  $ nemar auth profile
  $ nemar auth profile set-email ada@lab.example.org
  $ nemar auth profile orcid link`,
);

// ============================================================================
// Profile self-service subcommands (#1266, epic #1250; ADR 0044)
// ============================================================================
//
// The identifiers a person can fix themselves, from the terminal, with the
// same verification the website does: an email change is still proved by a
// code mailed to the NEW address, an ORCID link is still an ORCID consent
// screen in a browser, and every rule and refusal is the backend's, not a
// second copy living here.

/** Where the same change can be made in a browser. Printed by every
 *  subcommand, because the CLI is the second surface, not the only one. */
const SETTINGS_HINT = "Also changeable in Settings on https://nemar.org/settings";

/**
 * Guard every subcommand: an action must not print a spinner for a request
 * that was never going to be sent, and must exit non-zero (`nemar auth
 * profile` itself is a query and exits 0).
 */
function requireAuthenticatedForChange(): boolean {
  if (isAuthenticated()) return true;
  console.log(chalk.yellow("Not authenticated"));
  console.log();
  console.log("  Run 'nemar auth login' to authenticate");
  process.exitCode = 1;
  return false;
}

/**
 * Re-read the account from the server and update the local config cache.
 *
 * Called after every successful change so `nemar auth status` stops showing
 * the value that was just replaced. A failure here is NOT a failure of the
 * change -- the change has landed on the server -- so it is reported as a
 * dim note and the command still exits 0.
 */
async function refreshStoredAccount(): Promise<void> {
  try {
    const user = await getCurrentUser();
    // `applyServerUser` (epic #1272 phase 3) is the same rename-then-cache
    // logic `writeSignedInAccount` and `statusAction --refresh` use: the
    // accounts map is KEYED by username, so a rename has to move the key as
    // well as the field, or `nemar auth switch <new>` cannot find the
    // account it just renamed (#1266 review), and it declines to overwrite
    // a DIFFERENT stored account holding that key so a naming collision
    // never silently orphans one entry's credentials under the other's name.
    applyServerUser(user);
  } catch (error) {
    console.log(
      chalk.dim(
        `  (local copy not refreshed: ${errorDetail(error)} — run 'nemar auth status --refresh')`,
      ),
    );
  }
}

/**
 * Apply a local config write that must not be mistaken for the network call
 * that preceded it (#1266 review item 5).
 *
 * The server has already changed something by the time these run -- the email
 * has moved and the code is spent -- so a failed `conf` write is a stale local
 * copy, not a failed change. Inside the request's own try/catch it printed
 * "Could not confirm the new address" for a change that had in fact landed,
 * which is the one sentence that sends a person to re-request a code they no
 * longer need.
 */
function updateLocalConfig(apply: () => void): void {
  try {
    apply();
  } catch (error) {
    console.log(
      chalk.yellow(
        `  The change is live on the server; your local config could not be updated: ${errorDetail(error)}`,
      ),
    );
    console.log(chalk.dim("  Run 'nemar auth status --refresh' once the problem is fixed."));
  }
}

/**
 * Fail a subcommand with the backend's own sentence.
 *
 * Every refusal these routes raise carries a machine code in `error` and the
 * actionable sentence in `message`, and lib/api/client.ts already prefers the
 * sentence for the declared code vocabularies (shared/contract). So there is
 * nothing to map here: printing `error.message` IS printing the backend's
 * wording, which is the point -- a second copy in the CLI is how the two
 * surfaces start telling people different things.
 */
function failWithApiError(spinner: ReturnType<typeof ora>, error: unknown, fallback: string): void {
  if (error instanceof ApiError || error instanceof MaintenanceError) {
    spinner.fail(error.message);
  } else {
    spinner.fail(fallback);
    console.log(chalk.dim(`  ${errorDetail(error)}`));
  }
  process.exitCode = 1;
}

/** Apply a `PATCH /auth/profile` patch and report it uniformly. */
async function applyProfilePatch(
  patch: ProfilePatchRequest,
  pending: string,
  succeeded: string,
): Promise<void> {
  if (!requireAuthenticatedForChange()) return;
  const spinner = ora(pending).start();
  try {
    await updateProfile(patch);
    spinner.succeed(succeeded);
    await refreshStoredAccount();
    console.log(chalk.dim(`  ${SETTINGS_HINT}`));
  } catch (error) {
    failWithApiError(spinner, error, "Could not update your profile");
  }
}

// ---------------------------------------------------------------- set-email

const profileSetEmailCmd = profileCmd
  .command("set-email <address>")
  .description("Start an email change: mails a confirmation code to the new address")
  .action(async (address: string) => {
    if (!requireAuthenticatedForChange()) return;
    const spinner = ora(`Sending a confirmation code to ${address}...`).start();
    let result: Awaited<ReturnType<typeof requestEmailChange>>;
    try {
      result = await requestEmailChange(address);
    } catch (error) {
      failWithApiError(spinner, error, "Could not send the confirmation code");
      return;
    }

    // Past this point the code IS in the person's inbox, so nothing below may
    // report a failure of the request. The local write gets its own guarded
    // step for exactly that reason (#1266 review).
    spinner.succeed(`Code sent to ${result.masked_email}`);
    updateLocalConfig(() => setConfig("pendingEmailChange", address));

    console.log();
    console.log("  The address is not changed until you confirm the code:");
    console.log(`    ${chalk.cyan("nemar auth profile verify-email <code>")}`);
    console.log(chalk.dim("  The code expires in 10 minutes."));
    if (result.dev_code) {
      console.log(chalk.dim(`  (development backend echoed the code: ${result.dev_code})`));
    }
    if (result.dev_skip) {
      console.log(
        chalk.yellow(
          "  This backend is non-production and did not mail anything (delivery allow-list).",
        ),
      );
    }
    console.log(chalk.dim(`  ${SETTINGS_HINT}`));
  });

addVerboseHelp(
  profileSetEmailCmd,
  `
Description:
  Step one of changing the email address your NEMAR account signs in with.
  A 6-digit code goes to the NEW address; nothing changes until you enter it
  with 'nemar auth profile verify-email'. The old address is told once the
  change lands, so a change you did not make is visible to you.

  An address that already belongs to a NEMAR account is refused: one person,
  one account. Change it on the account that holds it instead.

  Your API key keeps working across the change -- it is tied to the account,
  not to the address.

Examples:
  $ nemar auth profile set-email ada@lab.example.org
  $ nemar auth profile verify-email 123456`,
);

// ------------------------------------------------------------- verify-email

const profileVerifyEmailCmd = profileCmd
  .command("verify-email <code>")
  .description("Finish an email change with the code sent to the new address")
  .option("--email <address>", "The address the code was sent to (defaults to the last requested)")
  .action(async (code: string, options: { email?: string }) => {
    if (!requireAuthenticatedForChange()) return;
    const address = (options.email ?? getConfig().pendingEmailChange ?? "").trim();
    if (!address) {
      // No stored request: a code alone cannot say which address it proves.
      console.log(chalk.yellow("No pending email change on this machine"));
      console.log();
      console.log("  Run 'nemar auth profile set-email <address>' first,");
      console.log("  or pass the address with --email <address>.");
      process.exitCode = 1;
      return;
    }

    const spinner = ora(`Confirming ${address}...`).start();
    let result: Awaited<ReturnType<typeof verifyEmailChange>>;
    try {
      result = await verifyEmailChange(address, code);
    } catch (error) {
      failWithApiError(spinner, error, "Could not confirm the new address");
      return;
    }

    // The address HAS moved and the code is spent, so success is reported
    // before anything local is touched: a `conf` write failure here used to
    // print "Could not confirm the new address" for a change that had landed
    // (#1266 review).
    spinner.succeed(`Account email is now ${address}`);
    // Written from the address we just proved rather than from the refresh
    // below: a refresh that fails must not leave the old address cached as if
    // nothing had happened.
    updateLocalConfig(() => {
      setConfig("email", address);
      deleteConfig("pendingEmailChange");
    });
    if (result.old_address_notified === false) {
      console.log(
        chalk.yellow("  The previous address could not be notified; the change still applied."),
      );
    }
    await refreshStoredAccount();
    console.log(chalk.dim("  Sign-in codes and NEMAR mail now go to the new address."));
  });

addVerboseHelp(
  profileVerifyEmailCmd,
  `
Description:
  Step two of an email change. The code is bound to BOTH the new address and
  your account, so a code from someone else's request cannot be redeemed here,
  and five wrong guesses invalidate it -- request a new one with
  'nemar auth profile set-email'.

  The address is remembered from the set-email step; pass --email if you are
  finishing a change started on another machine.

Examples:
  $ nemar auth profile verify-email 123456
  $ nemar auth profile verify-email 123456 --email ada@lab.example.org`,
);

// -------------------------------------------------------------- set-github

const profileSetGithubCmd = profileCmd
  .command("set-github <handle>")
  .description("Set the GitHub username on your account")
  .action(async (handle: string) => {
    await applyProfilePatch(
      { github_username: handle },
      `Checking GitHub for ${handle}...`,
      `GitHub username set to ${handle}`,
    );
  });

addVerboseHelp(
  profileSetGithubCmd,
  `
Description:
  Sets the GitHub username your dataset repositories are shared with. The
  handle must EXIST on GitHub -- it is looked up before it is stored -- and it
  may back only one NEMAR account.

  Ownership is not proved here: what matters for a review is that the account
  an admin will add as a collaborator resolves.

Examples:
  $ nemar auth profile set-github octocat`,
);

// ------------------------------------------------------------ set-username

const profileSetUsernameCmd = profileCmd
  .command("set-username <name>")
  .description("Set your NEMAR username (locked once an admin approves the account)")
  .action(async (name: string) => {
    await applyProfilePatch(
      { username: name },
      `Setting your username to ${name}...`,
      `Username set to ${name}`,
    );
  });

addVerboseHelp(
  profileSetUsernameCmd,
  `
Description:
  Your NEMAR handle: what 'nemar admin approve <username>' addresses and what
  the dataset repositories you own are attributed to.

  It can be set while it is empty at any time, and CHANGED until an admin
  approves your account -- after that a rename needs an admin, because other
  records already point at it.

Examples:
  $ nemar auth profile set-username alovelace`,
);

// ---------------------------------------------------------------- set-name

const profileSetNameCmd = profileCmd
  .command("set-name")
  .description("Set the given and family name your DOIs cite")
  .option("--given <name>", "Given (first) name")
  .option("--family <name>", "Family (last) name")
  .action(async (options: { given?: string; family?: string }) => {
    if (options.given === undefined && options.family === undefined) {
      console.log(chalk.yellow("Nothing to set"));
      console.log();
      console.log("  Pass --given and/or --family, e.g.");
      console.log("    nemar auth profile set-name --given Ada --family Lovelace");
      process.exitCode = 1;
      return;
    }
    const patch: ProfilePatchRequest = {};
    if (options.given !== undefined) patch.given_name = options.given;
    if (options.family !== undefined) patch.family_name = options.family;
    await applyProfilePatch(patch, "Setting your name...", "Name updated");
  });

addVerboseHelp(
  profileSetNameCmd,
  `
Description:
  The name a DOI cites you by. Both halves are required before a dataset can
  be published, which is why this is settable at all.

  It is refused while a VERIFIED ORCID iD is linked: ORCID is canonical there
  and its record is re-read on every sign-in, so an edit here would be
  silently overwritten. Change it at orcid.org and sign in again, or unlink
  the iD first.

Examples:
  $ nemar auth profile set-name --given Ada --family Lovelace`,
);

// ------------------------------------------------------------ set-location

const profileSetLocationCmd = profileCmd
  .command("set-location")
  .description("Set the city and country on your account")
  .option("--city <city>", "City")
  .option("--country <country>", "Country")
  .action(async (options: { city?: string; country?: string }) => {
    if (options.city === undefined && options.country === undefined) {
      console.log(chalk.yellow("Nothing to set"));
      console.log();
      console.log("  Pass --city and/or --country, e.g.");
      console.log("    nemar auth profile set-location --city 'San Diego' --country USA");
      process.exitCode = 1;
      return;
    }
    const patch: ProfilePatchRequest = {};
    if (options.city !== undefined) patch.city = options.city;
    if (options.country !== undefined) patch.country = options.country;
    await applyProfilePatch(patch, "Setting your location...", "Location updated");
  });

addVerboseHelp(
  profileSetLocationCmd,
  `
Description:
  City and country are required for the export-control screening an admin
  does before granting upload access, so an upload-access request is refused
  without them. Neither may be blank.

Examples:
  $ nemar auth profile set-location --city "San Diego" --country USA`,
);

// ------------------------------------------------------------------- orcid

/** How often the link flow re-checks whether the iD has landed. */
const ORCID_POLL_INTERVAL_MS = 3000;

/**
 * Wait for a browser-side ORCID link to finish, or give up.
 *
 * The link is completed by the ORCID callback in the browser, so there is
 * nothing for the CLI to await except the account itself changing. Polling
 * `/users/me` is that: for a link, an iD appearing; for a relink, a DIFFERENT
 * iD appearing, which is why the previous value is passed in rather than
 * re-read (a relink to the same account keeps `orcid` non-null throughout,
 * so "non-null" would report success the instant it started).
 *
 * A transient failure mid-wait is ignored on purpose -- the browser flow is
 * unaffected by our polling, and the timeout is the only thing that ends the
 * wait unhappily.
 */
/**
 * Consecutive unreachable polls before the wait is abandoned. Three at the
 * three-second interval is roughly ten seconds of silence -- long enough to
 * ride out one dropped request, short enough not to spend five minutes
 * pretending to wait for a browser flow that cannot report back.
 */
const ORCID_POLL_MAX_NETWORK_FAILURES = 3;

/**
 * Why a wait ended. `timeout` is the ordinary "they walked away" case; the
 * other two are conditions that will not improve by waiting longer, and each
 * has a different thing for the person to do (#1266 review item 7).
 */
type OrcidWaitOutcome =
  | { kind: "linked"; orcid: string }
  | { kind: "timeout" }
  | { kind: "unauthenticated" }
  | { kind: "unreachable"; detail: string };

async function waitForOrcidLink(
  previousOrcid: string | null,
  timeoutMs: number,
): Promise<OrcidWaitOutcome> {
  const deadline = Date.now() + timeoutMs;
  let networkFailures = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, ORCID_POLL_INTERVAL_MS));
    try {
      const user = await getCurrentUser();
      networkFailures = 0;
      const current = user.orcid ?? null;
      if (current && current !== previousOrcid) return { kind: "linked", orcid: current };
    } catch (error) {
      // A 401 is not a transient poll failure: the key this command is holding
      // has been revoked or regenerated, and no amount of waiting fixes it.
      // Burning the full timeout on it ends in "gave up waiting", which sends
      // the person to look at their browser rather than at their credentials.
      if (error instanceof ApiError && error.statusCode === 401) {
        return { kind: "unauthenticated" };
      }
      // statusCode 0 is this codebase's convention for a network-layer
      // failure (lib/api/client.ts). One is noise; several in a row means the
      // API is not reachable from here, and the browser flow's result is
      // unknowable until it is.
      if (error instanceof ApiError && error.statusCode === 0) {
        networkFailures += 1;
        if (networkFailures >= ORCID_POLL_MAX_NETWORK_FAILURES) {
          return { kind: "unreachable", detail: errorDetail(error) };
        }
      } else {
        // Anything else (a 5xx, a contract drift) is treated as transient:
        // it says nothing about the browser flow, which is what we are
        // actually waiting on.
        networkFailures = 0;
      }
    }
  }
  return { kind: "timeout" };
}

/**
 * Parse `--timeout` at the ARGUMENT boundary, so a bad value is a usage error
 * (#1266 review item 9).
 *
 * It used to fall back to 300 silently, which is the worst of both: a typo
 * (`--timeout 5m`) was accepted and then ignored, and the person watched a
 * five-minute wait they thought they had shortened. Commander turns an
 * InvalidArgumentError into its own usage failure with a non-zero exit.
 */
export function parseOrcidTimeout(raw: string): number {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds) || seconds <= 0) {
    throw new InvalidArgumentError("--timeout must be a whole number of seconds greater than 0");
  }
  return seconds;
}

const profileOrcidCmd = profileCmd
  .command("orcid <action>")
  .description("Link, re-link, or unlink your ORCID iD (link opens a browser)")
  .option("--no-open", "Print the URL instead of opening a browser")
  .option(
    "--timeout <seconds>",
    "How long to wait for the browser flow to finish",
    parseOrcidTimeout,
    300,
  )
  .option("-y, --yes", "Skip the confirmation prompt (unlink)")
  .option("-n, --no", "Decline the confirmation prompt (unlink)")
  .action(
    async (
      action: string,
      options: { open?: boolean; timeout?: number; yes?: boolean; no?: boolean },
    ) => {
      if (action !== "link" && action !== "relink" && action !== "unlink") {
        console.log(chalk.yellow(`Unknown action '${action}'`));
        console.log();
        console.log("  Use one of: link, relink, unlink");
        process.exitCode = 1;
        return;
      }
      if (!requireAuthenticatedForChange()) return;

      if (action === "unlink") {
        const result = await confirm(
          "Unlink your ORCID iD from this NEMAR account?",
          { yes: options.yes, no: options.no },
          false,
        );
        if (result !== "confirmed") {
          console.log(result === "declined" ? "Declined" : "Cancelled");
          return;
        }
        const spinner = ora("Unlinking your ORCID iD...").start();
        try {
          await unlinkOrcid();
          spinner.succeed("ORCID iD unlinked");
          console.log(
            chalk.dim(
              "  Your account no longer claims that iD. Link it again any time with 'nemar auth profile orcid link'.",
            ),
          );
          await refreshStoredAccount();
        } catch (error) {
          failWithApiError(spinner, error, "Could not unlink your ORCID iD");
        }
        return;
      }

      // link / relink: ORCID's consent screen is a browser page, so the CLI's
      // job is to get the person in front of it and then wait for the account
      // to change.
      const spinner = ora("Preparing the ORCID sign-in link...").start();
      let authorizeUrl: string;
      let previousOrcid: string | null = null;
      try {
        // Read the current iD FIRST: a relink is only observable as a change
        // from this value.
        previousOrcid = (await getCurrentUser()).orcid ?? null;
        const started = await startOrcidCliLink(action);
        authorizeUrl = started.authorize_url;
        spinner.stop();
      } catch (error) {
        failWithApiError(spinner, error, "Could not start the ORCID flow");
        return;
      }

      console.log();
      console.log("  Open this link and sign in with ORCID:");
      console.log(`    ${chalk.cyan(authorizeUrl)}`);
      console.log(chalk.dim("  The link is good for 10 minutes and works only for this account."));
      if (options.open !== false && openInBrowser(authorizeUrl)) {
        // "Trying", not "opened": the spawn returns before the child can fail,
        // so this is a claim about what was attempted (#1266 review item 8).
        console.log(chalk.dim("  (trying to open your browser; use the link above if it doesn't)"));
      }
      console.log();

      // Already validated by parseOrcidTimeout at the argument boundary.
      const timeoutSeconds = options.timeout ?? 300;
      const waitSpinner = ora("Waiting for you to finish in the browser...").start();
      const outcome = await waitForOrcidLink(previousOrcid, timeoutSeconds * 1000);
      if (outcome.kind === "linked") {
        waitSpinner.succeed(`ORCID iD ${outcome.orcid} is linked to your account`);
        await refreshStoredAccount();
        console.log(chalk.dim(`  ${SETTINGS_HINT}`));
        return;
      }
      if (outcome.kind === "unauthenticated") {
        waitSpinner.fail("Your credentials no longer authenticate");
        console.log();
        console.log("  Run 'nemar auth login' with a current API key, then try again.");
        console.log(
          chalk.dim("  If you finished the browser step, the link may still have been made."),
        );
        process.exitCode = 1;
        return;
      }
      if (outcome.kind === "unreachable") {
        waitSpinner.fail(`Cannot reach the API: ${outcome.detail}`);
        console.log();
        console.log("  The browser step may still have worked; check with 'nemar auth profile'.");
        process.exitCode = 1;
        return;
      }
      waitSpinner.warn("Gave up waiting for the browser flow");
      console.log();
      console.log("  If you finished it, check with 'nemar auth profile'.");
      console.log("  If the browser showed an error, run this command again.");
      process.exitCode = 1;
    },
  );

addVerboseHelp(
  profileOrcidCmd,
  `
Description:
  ORCID stays a browser flow: the consent screen is ORCID's, and no NEMAR
  command should ever ask for an ORCID password. This mints a short-lived link
  for THIS account, opens it if it can, and then waits for the iD to appear.

  link     attach an ORCID iD to an account that has none
  relink   replace the linked iD with a different one
  unlink   remove the link (and the iD this account claims)

  An iD backs at most one NEMAR account. If it is already linked elsewhere,
  unlink it there first.

  The link URL is printed whether or not a browser opens, so a headless or
  remote machine is a copy-and-paste rather than a dead end. Pass --no-open,
  or set NEMAR_NO_BROWSER=1, to stop the CLI reaching for a browser at all.

  Opening the link shows a NEMAR page naming the account it will link to
  before it sends you to ORCID. If that account is not yours, close the tab:
  the link was made by somebody else and would attach YOUR iD to THEIR
  account. A link can only be used once.

  --timeout is a whole number of seconds (default 300); the wait stops early
  if your credentials stop working or the API becomes unreachable.

Examples:
  $ nemar auth profile orcid link
  $ nemar auth profile orcid relink --no-open
  $ nemar auth profile orcid unlink --yes`,
);
