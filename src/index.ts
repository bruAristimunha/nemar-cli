#!/usr/bin/env node
/**
 * NEMAR CLI - Command-line interface for NEMAR dataset management
 *
 * NEMAR: Neuroelectromagnetic Data Archive and Tools Resource
 * https://github.com/nemarOrg
 *
 * Note: The canonical commands use a two-prong structure (e.g., nemar auth login)
 * following CLI best practices for discoverability. Root-level shortcuts
 * (nemar login, nemar whoami, etc.) are provided as convenience aliases.
 */

// IMPORTANT: help.ts must be imported first. It patches Commander's
// Command.prototype.addHelpText at module load time so that all subsequent
// command module imports pick up the concise-by-default help behavior.
import { configureColorHelp } from "./lib/help.js";

import chalk from "chalk";
import { Command } from "commander";
import { adminCommand } from "./commands/admin.js";
import {
  authCommand,
  loginAction,
  logoutAction,
  signupAction,
  statusAction,
  switchAction,
} from "./commands/auth.js";
import { completionCommand } from "./commands/completion.js";
import { createDownloadCommand, createUploadCommand, datasetCommand } from "./commands/dataset.js";
import { doctorCommand } from "./commands/doctor.js";
import { sandboxCommand } from "./commands/sandbox.js";
import { IS_DEV_BUILD } from "./lib/api/client.js";
import { MaintenanceError, errorDetail } from "./lib/api/errors.js";
import {
  MisplacedShadowedOptionError,
  MissingShadowedValueError,
  bindShadowedOptionValues,
} from "./lib/argv-shadowing.js";
import { runComplete } from "./lib/completion/run.js";
import { NO_DESCRIPTION, NO_OPTION, YES_DESCRIPTION, YES_OPTION } from "./lib/confirm.js";
import {
  enableDebug,
  getLastWriteFailureReason,
  isDebugEnabled,
  markUsageExit,
  primeEnvironmentSnapshot,
  shouldEnableDebug,
  wasReportedExit,
  wasUsageExit,
  writeDebugLogSync,
} from "./lib/debug-log.js";
import { printMaintenanceBanner } from "./lib/maintenance-banner.js";
import { fetchAndDisplayNotices } from "./lib/notices.js";
import { initUpdateCheck, printUpdateBanner } from "./lib/update-check.js";
import { version } from "./lib/version.js";

/**
 * Index into `argv` (already `process.argv.slice(2)`) of the `__complete`
 * token, or null if this is not a completion invocation. `argv[2]` alone is
 * not reliable: a global flag typed before the subcommand (`nemar --verbose
 * __complete -- ...`) shifts `__complete` to a later position, and checking
 * position 2 positionally missed it entirely (#1173 review) -- the guard
 * below never fired, so the request fell through to `initUpdateCheck()` and
 * paid a real blocking fetch before Commander finally rejected it as an
 * unknown command.
 *
 * Every global option this program declares (`--no-color`, `--verbose`,
 * `--help-all`, `--debug`, `-v`/`--version`) is boolean, so "the first token
 * that is not itself a flag" is unambiguous here: it is either `__complete` or the
 * name of a subcommand. `nemar dataset get __complete` must NOT dispatch --
 * `dataset` is that first non-flag token, and `__complete` there is just an
 * (unusual) positional argument to `dataset get`.
 *
 * Defined here (moved up from further down the file) so the `--debug` exit
 * handler below can use it too: a shell asking for completion candidates on
 * every keystroke, combined with a `NEMAR_DEBUG=1` a user forgot was set in
 * their shell rc, must not write a log per keystroke (see isCompletionRequest).
 */
function findCompletionArgsStart(argv: string[]): number | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("-")) continue;
    return argv[i] === "__complete" ? i : null;
  }
  return null;
}

// ============================================================================
// --debug / NEMAR_DEBUG=1 diagnostic bundle (issue #1256, epic #1250 phase 6)
// ============================================================================
//
// Set up as early as possible, before `program` even exists: HTTP calls
// through lib/api/client.ts's `request()` can happen from the `preAction`
// hook below (fetchAndDisplayNotices) or from `initUpdateCheck()`, both of
// which run before Commander dispatches to any command action.
const rawArgs = process.argv.slice(2);
if (shouldEnableDebug(rawArgs)) {
  enableDebug();
}

// A persistent NEMAR_DEBUG=1 (set in a shell rc, say) combined with shell-tab
// completion would otherwise write one log per completion request -- these
// fire on every keystroke -- and evict real logs from the MAX_DEBUG_LOGS
// window well before a user gets to attach one (review finding, PR #1257).
const isCompletionRequest = findCompletionArgsStart(rawArgs) !== null;

/**
 * Print the standard "how to help us help you" hint on any non-zero exit --
 * unless the command asked for machine-readable output (`--json`) or the
 * exit came from Commander itself (help/version/a usage error): those are
 * self-explanatory and don't need a bug-report nudge. If --debug was on and
 * the log was written, its path replaces the generic hint (the log already
 * IS the artifact the hint would have asked for); if --debug was on but the
 * log could NOT be written (see getLastWriteFailureReason), the hint says so
 * instead of telling the user to re-run with the flag they just used.
 *
 * Registered as a `process.on("exit", ...)` handler -- not tied to any one
 * of the ~270 `process.exit()` call sites across the CLI -- because that is
 * the one place every exit path (a command's own process.exit, an uncaught
 * error escaping to main().catch() below, or Commander's own _exit) funnels
 * through. 'exit' handlers must be synchronous; writeDebugLogSync() is
 * synchronous by construction for exactly this reason (see its docstring).
 *
 * Exit code 130 (128 + SIGINT) is a fourth self-explanatory case, alongside
 * `--json`/usage exits (epic #1272 phase 3): a Ctrl-C during
 * `nemar auth login`'s device-flow poll (lib/device-login.ts) already
 * printed its own "Sign-in canceled" sentence, and nothing about walking
 * away from a prompt is evidence of a bug worth a debug log's nudge. The
 * log itself is still written either way -- only the NUDGE below is
 * suppressed, matching every other case this early return covers.
 */
process.on("exit", (code) => {
  const exitCode = code ?? 0;
  const logPath = isCompletionRequest ? null : writeDebugLogSync(rawArgs, exitCode);
  if (
    exitCode === 0 ||
    exitCode === 130 ||
    rawArgs.includes("--json") ||
    wasUsageExit() ||
    // A reported verdict: the exit code is the answer, so there is nothing to file.
    wasReportedExit()
  )
    return;
  if (logPath) {
    process.stderr.write(`Debug log: ${logPath}\n`);
  } else if (isDebugEnabled()) {
    const reason = getLastWriteFailureReason();
    process.stderr.write(
      `Debug log could not be written${reason ? ` (${reason})` : ""}; attach the [debug] lines above to the issue\n`,
    );
  } else {
    process.stderr.write(
      "Run again with --debug and attach the log to a new issue: " +
        "https://github.com/nemarOrg/nemar-cli/issues/new?template=bug_report.yml\n",
    );
  }
});

const program = new Command();

program
  .name("nemar")
  .description(
    `CLI for NEMAR (Neuroelectromagnetic Data Archive and Tools Resource)

NEMAR is a curated repository for neurophysiology data in BIDS format.
This CLI provides tools for uploading, downloading, and managing datasets.`,
  )
  .version(version, "-v, --version", "Output the current version")
  .option("--no-color", "Disable colored output")
  .option("--verbose", "Enable verbose output")
  .option("--help-all", "Show detailed help with examples and descriptions")
  .option(
    "--debug",
    "Write a diagnostic log for this run (see NEMAR_DEBUG=1); attach it to a bug report",
  )
  .addHelpText(
    "after",
    `
Examples:
  $ nemar auth login              # Sign in with your browser
  $ nemar dataset validate ./my-dataset
  $ nemar dataset upload ./my-dataset -n "My EEG Dataset"
  $ nemar dataset download nm000104

Documentation:
  https://docs.nemar.org

Support:
  https://github.com/nemarOrg/nemar-cli/issues`,
  );

// Register command groups
program.addCommand(authCommand);
program.addCommand(datasetCommand);
program.addCommand(sandboxCommand);
program.addCommand(adminCommand);
program.addCommand(doctorCommand);
program.addCommand(completionCommand);

// ============================================================================
// Root-level shortcuts (convenience aliases)
// Note: The canonical commands are under 'nemar auth <cmd>'. These shortcuts
// are provided for user convenience but are not the primary entry point.
// ============================================================================

program
  .command("login")
  .description("Sign in with your browser (shortcut for 'auth login')")
  .option("-k, --key <key>", "Paste an existing API key instead (alternative: NEMAR_API_KEY)")
  .option("--no-open", "Print the sign-in link instead of trying to open a browser")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .action(loginAction);

program
  .command("logout")
  .description("Remove the active account (shortcut for 'auth logout')")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .option("--all", "Remove all stored accounts")
  .option("--revoke-key", "Revoke this machine's key even if it may be shared")
  .option("--no-revoke-key", "Never revoke the key server-side, only clear it locally")
  .action(logoutAction);

const signupFlags = (cmd: Command): Command =>
  cmd
    .option("--username <name>", "Username to set, or to change to")
    .option("--github <handle>", "GitHub username")
    .option("--city <city>", "City")
    .option("--country <country>", "Country")
    .option("--why <text>", "What you intend to upload (20-500 characters)")
    .option("--no-upload-access", "Skip the upload-access request")
    .option("--no-open", "Print the sign-in link instead of trying to open a browser")
    .option(YES_OPTION, YES_DESCRIPTION)
    .option(NO_OPTION, NO_DESCRIPTION);

signupFlags(
  program
    .command("signup")
    .description("Create or continue your account (shortcut for 'auth signup')"),
).action(signupAction);

signupFlags(
  program.command("register").description("Create or continue your account (alias for signup)"),
).action(signupAction);

// The two dataset commands that dominate real use get root shortcuts too.
// Each is a FRESH instance from the same factory, not the one already
// attached under `dataset`: Commander gives a Command exactly one parent, so
// re-adding the same object would move it out of `nemar dataset`. Only the
// description differs, and the flags cannot drift because there is one
// definition.
program.addCommand(
  createDownloadCommand().description(
    "Download a dataset from NEMAR or OpenNeuro (shortcut for 'dataset download')",
  ),
);
program.addCommand(
  createUploadCommand().description(
    "Upload a BIDS dataset to NEMAR (shortcut for 'dataset upload')",
  ),
);

program
  .command("whoami")
  .description("Show current user (shortcut for 'auth status')")
  .option("--refresh", "Refresh user info from server")
  .action(statusAction);

program
  .command("switch [username]")
  .description("Switch between accounts (shortcut for 'auth switch')")
  .action(switchAction);

// Apply color formatting to all commands (must be after addCommand calls)
configureColorHelp(program);

/**
 * Tell a Commander-detected exit (help, `--version`, or a usage/validation
 * error) apart from a command's own `process.exit()` call, so the failure
 * hint above doesn't fire on "error: unknown option '--bogus'" (Commander
 * already explained itself).
 *
 * `exitOverride`'s callback runs BEFORE Commander's own `process.exit()`,
 * not instead of it (see node_modules/commander lib/command.js `_exit`) --
 * passing a callback that doesn't throw leaves exit codes and printed text
 * byte-identical to not overriding at all. Applied to every command in the
 * tree individually (not just `program`) because `addCommand()` does not
 * propagate `exitOverride` to the subtrees it attaches (only Commander's
 * own `.command()` copies parent settings, and only at creation time).
 */
function markCommanderExitsRecursively(cmd: Command): void {
  cmd.exitOverride(() => markUsageExit());
  for (const sub of cmd.commands) {
    markCommanderExitsRecursively(sub);
  }
}
markCommanderExitsRecursively(program);

// Display system notices before command execution
program.hook("preAction", async () => {
  await fetchAndDisplayNotices();
});

// Warn if running a dev build (injected URL via CI)
if (IS_DEV_BUILD) {
  console.warn(
    chalk.yellow.bold("[DEV BUILD]") +
      chalk.yellow(" Connected to development backend. Not for production use."),
  );
}

// Initialize update check before parsing (may block up to 5s on first run)
async function main() {
  // Shell completion (epic #1144 phase 5b, #1149, D1). This guard does two
  // separable things; an earlier version of this comment conflated them and
  // asserted something false (#1173 review).
  //
  // 1. It DISPATCHES `__complete`, which is deliberately not a registered
  //    Commander command. Falling through to parseAsync() would not run it
  //    slowly -- it would not run it at all: Commander's _findCommand finds
  //    no match, takes the unknownCommand() branch, and exits 1 with
  //    "error: unknown command '__complete'" BEFORE any preAction hook can
  //    fire. Verified by disabling this guard and running it.
  // 2. Sitting ABOVE initUpdateCheck() is what avoids the one network cost
  //    that is real on this path today: on a cold cache initUpdateCheck()
  //    does a blocking fetch (see update-check.ts), and it runs before
  //    parseAsync() regardless of which command was typed.
  //
  // The preAction hook's unconditional GET /notices is a hazard of the
  // ALTERNATIVE design, not of this one: it is why `__complete` is not
  // registered as a normal command (see commands/completion.ts), not
  // something this early return is currently skipping.
  //
  // The budget is ~100ms and __complete must touch the network zero times --
  // not even with a timeout, since a timeout still pays DNS and connect on
  // exactly the networks where someone is offline pressing TAB.
  const completionArgsStart = findCompletionArgsStart(rawArgs);
  if (completionArgsStart !== null) {
    await runComplete(program, rawArgs.slice(completionArgsStart + 1));
    return;
  }

  // Capture CLI/OS/Bun version, account, and tool-version info ONCE, up
  // front, before anything can fail. See lib/debug-log.ts's docstring for
  // why this can't be deferred to the (synchronous) exit handler above.
  if (isDebugEnabled()) {
    await primeEnvironmentSnapshot();
  }

  const pendingUpdate = await initUpdateCheck();

  if (pendingUpdate) {
    // postAction fires after commands; exit handler covers --help/--version
    // where postAction does not fire. printUpdateBanner is internally
    // idempotent (prints at most once per process).
    program.hook("postAction", () => printUpdateBanner(pendingUpdate));
    process.on("exit", () => printUpdateBanner(pendingUpdate));
  }

  // `nemar dataset release <id> --version X.Y.Z` must reach `release`, not
  // the root --version (#1493); see lib/argv-shadowing.ts.
  let argv: string[];
  try {
    argv = bindShadowedOptionValues(program, rawArgs);
  } catch (err) {
    if (err instanceof MissingShadowedValueError || err instanceof MisplacedShadowedOptionError) {
      // A mistyped option, reported as Commander reports one. error() exits;
      // routing through it runs the exitOverride whose markUsageExit() skips
      // the bug-report nudge, since a wrong flag is not a bug.
      err.command.error(err.message, { code: err.code });
    }
    // Anything else is a defect in the pre-pass itself, not in the user's
    // arguments: say so, instead of letting it read as a command failure.
    throw new Error(`argv pre-pass failed: ${errorDetail(err)}`, { cause: err });
  }
  await program.parseAsync(argv, { from: "user" });
}

main().catch((err) => {
  if (err instanceof MaintenanceError) {
    printMaintenanceBanner(err);
    process.exit(1);
  }
  console.error(errorDetail(err));
  process.exit(1);
});
