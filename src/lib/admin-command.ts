/**
 * Plumbing shared by the admin command groups that live in their own files (`commands/admin-*.ts`).
 *
 * A command file may not import `admin.ts`: it imports the command files, and the cycle would run
 * `adminCommand.addCommand` before the group existed. So what a group needs from it lives here.
 * `handleCommandError` is `admin.ts`'s own, moved, and `admin.ts` imports it back. `failWith`,
 * `failMessage` and `requireSignedIn` are for a group that exits non-zero on every failure (#1581);
 * the commands that are still in `admin.ts` print and exit 0 for the same failures, which is left
 * to a follow-up.
 *
 * There is one way to fail. Every string that came from the network passes `plain()` before it is
 * printed; with `--json` the failure goes to standard error, so `nemar ... --json | jq` never reads
 * a sentence; the exit code is 1; and whether the exit hook may invite a bug report is decided in
 * one place (`isAnswered`), by the LAST failure of the run.
 */

import chalk from "chalk";
import type { Ora } from "ora";
import { PUBLICATION_DATASET_ID_RE } from "../../shared/publication-limits.js";
import { ApiError, errorDetail } from "./api/errors.js";
import { reviewErrorCode } from "./api/publish.js";
import { isAuthenticated } from "./config.js";
import { markReportedExit, unmarkReportedExit } from "./debug-log.js";
import { plain } from "./terminal-text.js";

/**
 * Hints keyed on a publication `block_reason`, which outrank the status-code
 * hint: a 422 from the publish paths is not always a CI problem, and telling
 * an admin to "fix the CI issues" when the real problem is a missing
 * researcher name sends them to the wrong place entirely (#1255).
 */
export const BLOCK_REASON_HINTS: Record<string, string> = {
  owner_name_missing:
    "Run `nemar admin backfill-names --apply` if the owner's ORCID record publishes their name; an ORCID-linked owner must otherwise make it public on ORCID and sign in again, and an owner with no linked ORCID can now type it into Settings on nemar.org (ADR 0042).",
};

/** A line sink: standard error under `--json`, standard output otherwise. */
export function say(json: boolean | undefined): (line: string) => void {
  return json ? (line) => console.error(line) : (line) => console.log(line);
}

/**
 * Whether a failure is the Worker's own answer, so that exit 1 is the command's answer and not a
 * crash: a refusal or a not-found (a 4xx), or a 5xx that names its closed word (`dispatch_unconfigured`,
 * `comment_not_sent`). A 5xx without a word or with `internal`, a network failure and anything that is
 * not an `ApiError` may be a bug, and keep the "attach the log to a new issue" hint.
 */
export function isAnswered(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.statusCode >= 400 && error.statusCode < 500) return true;
  const word = reviewErrorCode(error);
  return word !== undefined && word !== "internal";
}

type Sink = (line: string) => void;

function emit(message: string, spinner: Ora | null | undefined, out: Sink, hint?: string): void {
  if (spinner) spinner.fail(message);
  else out(chalk.red(message));
  if (hint) out(chalk.dim(`  ${hint}`));
}

function report(
  error: unknown,
  spinner: Ora | null,
  defaultMsg: string,
  hints: Record<number, string> | undefined,
  out: Sink,
): void {
  if (error instanceof ApiError) {
    const reasonHint = error.blockReason ? BLOCK_REASON_HINTS[error.blockReason] : undefined;
    const hint =
      reasonHint ??
      hints?.[error.statusCode] ??
      (error.statusCode === 403 ? "This command requires admin privileges" : undefined);
    emit(plain(error.message), spinner, out, hint);
    return;
  }
  emit(defaultMsg, spinner, out, `Error details: ${plain(errorDetail(error))}`);
}

/** Handle common error patterns in admin CLI commands (the ones that exit 0). */
export function handleCommandError(
  error: unknown,
  spinner: Ora,
  defaultMsg: string,
  hints?: Record<number, string>,
): void {
  report(error, spinner, defaultMsg, hints, say(false));
}

/**
 * Report an error of a request and exit 1: the one way a command of a group that exits non-zero
 * reports an error, so no failure path can print without failing (#1581).
 *
 * `spinner` is failed when there is one; `null` prints the sentence instead (a command that has no
 * spinner under `--json`). The Worker's sentence and the error's details are made plain, and
 * `opts.json` sends all of it to standard error.
 */
export function failWith(
  error: unknown,
  spinner: Ora | null,
  defaultMsg: string,
  hints?: Record<number, string>,
  opts: { json?: boolean } = {},
): void {
  report(error, spinner, defaultMsg, hints, say(opts.json));
  process.exitCode = 1;
  if (isAnswered(error)) markReportedExit();
  else unmarkReportedExit();
}

/**
 * Print a failure that has a message of its own and no error object, and exit 1. `answered` says exit
 * 1 is the command's answer and not a crash (a refusal the Worker made, a mistyped argument), which
 * suppresses the "attach the log to a new issue" hint (`markReportedExit`); anything that may be a
 * bug leaves it, and clears a mark an earlier failure of the same run made.
 */
export function failMessage(
  message: string,
  opts: { spinner?: Ora | null; json?: boolean; answered: boolean; hint?: string },
): void {
  emit(plain(message), opts.spinner, say(opts.json), opts.hint);
  process.exitCode = 1;
  if (opts.answered) markReportedExit();
  else unmarkReportedExit();
}

/**
 * A dataset id typed on the command line, checked before anything is sent; null (after saying so,
 * with exit 1) when it is not one. A mistyped id is an answer, not a crash, so no bug-report hint.
 */
export function checkedDatasetId(raw: string, json?: boolean): string | null {
  if (PUBLICATION_DATASET_ID_RE.test(raw)) return raw;
  failMessage(`"${raw}" is not a dataset id (like nm000108).`, { json, answered: true });
  return null;
}

/**
 * Check authentication: when nobody is signed in, say so (on standard error under `--json`), set
 * the exit code to 1 and return false so the caller can `return`. A command that is not signed in
 * has done nothing, and a script has to be able to tell. The message already says what to do, so
 * the bug-report hint is suppressed.
 */
export function requireSignedIn(json?: boolean): boolean {
  if (isAuthenticated()) return true;
  const out = say(json);
  out(chalk.red("Error: Not authenticated"));
  out(chalk.dim("  Run 'nemar auth login' first"));
  process.exitCode = 1;
  markReportedExit();
  return false;
}
