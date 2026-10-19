/**
 * `nemar admin publish`: the publication workflow, from the administrator's side.
 *
 *   nemar admin publish list [--all|--<state>|-s <s>] [--search <t>]
 *                                              the publication requests, with the identifier screen
 *   nemar admin publish show <ds>              the automated review of one request (admin-publish-review.ts)
 *   nemar admin publish start <ds> | --all     start the automated review (admin-publish-review.ts)
 *   nemar admin publish next                   the requests that need you, one card each (admin-publish-next.ts)
 *   nemar admin publish approve <ds>           approve and publish (admin-publish-approve.ts)
 *   nemar admin publish deny <ds> [-r <why>]   deny one, mailing the depositor the reason
 *   nemar admin publish screen <ds>            run the identifier screen of a request again
 *
 * Split out of `admin.ts` (epic #1726, phase 2) so the publication review's commands do not grow
 * a file of ten thousand lines. The group is registered on `adminCommand` at the position it
 * always had, so `nemar admin --help` is unchanged. `show` and `start` are registered from their own
 * file right after `list`, and `approve` and `next` after `screen`; commander lists a group's
 * subcommands alphabetically, so the order of registration does not show in `--help`.
 */

import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";
import ora from "ora";
import { DENIAL_REASON_MAX_LENGTH } from "../../shared/publication-limits.js";
import { searchLimitProblem } from "../../shared/publish-list-search.js";
import { checkedDatasetId, failMessage, failWith, requireSignedIn } from "../lib/admin-command.js";
import { denyPublication, listPublishRequests, rerunIdentifierScreen } from "../lib/api/publish.js";
import {
  type ConfirmOptions,
  NO_DESCRIPTION,
  NO_OPTION,
  YES_DESCRIPTION,
  YES_OPTION,
  confirm,
} from "../lib/confirm.js";
import { markReportedExit } from "../lib/debug-log.js";
import { LineReader } from "../lib/prompt-lines.js";
import { readReview } from "../lib/publication-review-approve.js";
import { reviewListLine, screenViewLines } from "../lib/publication-review-display.js";
import { needsAdministrator } from "../lib/publication-review-queue.js";
import {
  type ListFilterOptions,
  choseListScope,
  describeListScope,
  resolveListStatuses,
} from "../lib/publish-list-filter.js";
import { plain } from "../lib/terminal-text.js";
import { printable, registerApproveCommand, requestNumber } from "./admin-publish-approve.js";
import { registerNextCommand } from "./admin-publish-next.js";
import { registerReviewCommands } from "./admin-publish-review.js";

export const publishCommand = new Command("publish").description("Publication workflow management");

publishCommand
  .command("list")
  .description("List publication requests (active ones by default)")
  .option("--all", "Show every request, whatever its state")
  .option("--requested", "Show requests awaiting admin action")
  .option("--approving", "Show requests being processed by the orchestrator")
  .option("--blocked", "Show requests blocked on the depositor")
  .option("--published", "Show published requests")
  .option("--denied", "Show denied requests")
  .option(
    "-s, --status <status>",
    "Show one exact status (requested, approving, blocked, published, denied)",
  )
  .option("--search <text>", "Match dataset ID, requester username or dataset name")
  .option("--needs-me", "Only the requests you can act on now (marked *)")
  .option("--json", "Output the response as JSON instead of the list")
  .addHelpText(
    "after",
    `
Description:
  List publication requests from users. By default only the active ones are
  shown (requested, approving and blocked); the state flags, or -s/--status with
  one status, narrow the list to those states, and --all shows every request.
  Shows dataset ID, status, requesting user, the identifier screen and the
  automated review of each (ADR 0102): its outcome, then the reasons it is not a
  pass, as codes. 'nemar admin publish show <dataset>' says what each one means.

  A * marks a request you can act on now: one waiting for your decision (unless
  it is only waiting for the screen or the review to report), or an approval that
  stopped and can be resumed. It is not marked when it is blocked (the depositor
  acts) or an approval is running.

States:
  requested  - Pending requests awaiting admin action
  approving  - Currently being processed by orchestrator
  blocked    - Held until the depositor fixes something and requests again
  published  - Successfully published datasets
  denied     - Denied requests, with reasons. Also lists the requests their
               depositor withdrew, shown as "withdrawn" (stored as denied).

Search:
  --search matches a substring (case-insensitive for ASCII letters) of the
  dataset ID, the requester's username or the dataset name, within the states being shown.
  An exact dataset ID is listed first.

  --needs-me keeps only the requests marked *, after the states and --search.
  --json prints the response (with --needs-me, the rows it keeps) and nothing else
  on standard output; errors go to standard error.

Examples:
  $ nemar admin publish list                       # Active requests
  $ nemar admin publish list --all                 # Every request
  $ nemar admin publish list --denied              # Denied only
  $ nemar admin publish list -s denied             # Same as --denied
  $ nemar admin publish list --published --denied  # Both states
  $ nemar admin publish list --needs-me            # What is yours to act on
  $ nemar admin publish list --search nm099999 --all   # Look up one dataset, any state`,
  )
  .action(
    async (options: ListFilterOptions & { search?: string; needsMe?: boolean; json?: boolean }) => {
      const json = options.json === true;
      if (!requireSignedIn(json)) return;

      // The server cannot run a longer pattern (D1's LIKE limit); say so here
      // rather than after a round trip.
      const search = options.search?.trim() || undefined;
      const tooLong = search ? searchLimitProblem(search) : null;
      if (tooLong) {
        // A mistyped argument is the command's answer: on standard error (as under `--json`), exit
        // 1, and no "attach the log" hint.
        console.error(chalk.red(plain(tooLong)));
        process.exitCode = 1;
        markReportedExit();
        return;
      }

      const spinner = json ? null : ora("Fetching publication requests...").start();

      try {
        const result = await listPublishRequests({
          statuses: resolveListStatuses(options),
          search,
        });
        spinner?.stop();

        const rows = options.needsMe ? result.requests.filter(needsAdministrator) : result.requests;
        if (json) {
          console.log(JSON.stringify({ ...result, requests: rows, count: rows.length }, null, 2));
          return;
        }

        const scope = describeListScope(options);
        if (result.requests.length === 0) {
          const widen = choseListScope(options) ? "" : " Use --all to include every state.";
          console.log(
            chalk.dim(
              `\n  No ${scope} found${search ? ` matching "${plain(search)}"` : ""}.${widen}\n`,
            ),
          );
          return;
        }

        console.log(`\n${chalk.cyan("Publication Requests")} (${rows.length}, ${scope})\n`);
        if (rows.length === 0) console.log(chalk.dim("  No publication request needs you now.\n"));

        for (const req of rows) {
          const statusColor =
            req.status === "published"
              ? chalk.green
              : req.status === "denied"
                ? chalk.red
                : req.status === "approving"
                  ? chalk.yellow
                  : chalk.white;

          // A request its depositor took back is stored as finished (denied), but an administrator
          // should not read it as a refusal. It is listed wherever `denied` is in scope
          // (`--denied`, `-s denied`, `--all`). It is history: no longer active, so the review
          // never gates it and nothing below marks it.
          const withdrawn = req.status === "denied" && Boolean(req.withdrawn_at);
          // The dataset name and the username are typed by the depositor: an escape sequence in
          // either would run in this administrator's terminal.
          const name = plain(req.dataset_name ?? "");
          // `*` is the CLI's reading of what the Worker said (`needsAdministrator`); an approval
          // that is running says so instead, because it is neither the administrator's nor stopped.
          const mark = needsAdministrator(req)
            ? `  ${chalk.bold.cyan("*")}`
            : req.approval_in_flight === true
              ? `  ${chalk.yellow("(approval running)")}`
              : "";
          console.log(
            `  ${chalk.bold(plain(req.dataset_id))}  ${withdrawn ? chalk.yellow("withdrawn") : statusColor(plain(req.status))}  by ${plain(req.requested_by_username)}  ${chalk.dim(plain(req.requested_at))}${name ? `  ${chalk.dim(name)}` : ""}${mark}`,
          );
          // #1408: an anonymous release and a publication reach this list
          // looking identical, and approving the wrong one is not reversible in
          // either direction -- publishing names a depositor who asked to be
          // concealed; releasing anonymously withholds a DOI someone needs.
          if (req.anonymous === 1) {
            console.log(
              `    ${chalk.yellow("! anonymous release:")} ${chalk.dim(
                "repository stays private, DOI stays reserved, depositor is not named",
              )}`,
            );
          }
          // Epic #1610 phase 4: the identifier screen, in the backend's words.
          for (const line of screenViewLines(req.identifier_screen, 4)) console.log(line);
          // ADR 0102: the automated review, in the backend's words; nothing for a request it did
          // not assess.
          const review = reviewListLine(req.publication_review, 4);
          if (review !== null) console.log(review);
          if (req.current_step && req.status === "approving") {
            console.log(
              `    ${chalk.yellow(">")} ${plain(req.current_step).replace(/_/g, " ")}${req.last_error ? chalk.red(` (${plain(req.last_error)})`) : ""}`,
            );
          }
          // Non-blocking pre-screen advisory (#756): a concern for the admin to
          // weigh before approving, NOT a block.
          if (req.prescreen_status === "concern") {
            let reasons: string[] = [];
            try {
              const parsed = JSON.parse(req.prescreen_reasons || "[]");
              if (Array.isArray(parsed))
                reasons = parsed.filter((x) => typeof x === "string").map(plain);
            } catch {
              // malformed -> show the flag without inline reasons
            }
            const summary = reasons.length ? reasons.join("; ") : "see pre-screen";
            console.log(`    ${chalk.yellow("! pre-screen advisory:")} ${chalk.dim(summary)}`);
          }
        }

        const total = result.requests.length;
        const count =
          rows.length === total
            ? `${total} request${total === 1 ? "" : "s"}`
            : `Showing ${rows.length} of ${total} request${total === 1 ? "" : "s"}`;
        // Counted over what is on the screen, so the line cannot disagree with the rows above it.
        const mine = rows.filter(needsAdministrator).length;
        console.log();
        console.log(
          `${count}, ${chalk.bold(String(mine))} you can act on.  ${chalk.dim("nemar admin publish next | show <dataset> | approve <dataset>")}`,
        );
        // Said once, and only when every row says it: a Worker answers for one flag, so a mix would
        // mean an older backend, whose rows carry no summary at all.
        if (result.requests.every((req) => req.publication_review?.enabled === false)) {
          console.log(
            chalk.dim(
              "  The automated review is off on this Worker, so no review gates an approval.",
            ),
          );
        }
        console.log();
      } catch (error) {
        failWith(error, spinner, "Failed to list publication requests", undefined, { json });
      }
    },
  );

registerReviewCommands(publishCommand);

/**
 * The reason for a denial when `--reason` was not given: asked for at a terminal, and read as the
 * first line of standard input when that is a pipe (null when it holds none). Not asked through
 * `inquirer` unless there is a terminal: on a stdin that has ended its prompt dies with an
 * uncatchable ERR_USE_AFTER_CLOSE stack trace, which `confirm()` guards against in the same way.
 */
async function askReason(): Promise<string | null> {
  if (process.stdin.isTTY) {
    const { inputReason } = await inquirer.prompt([
      { type: "input", name: "inputReason", message: "Reason for denial:" },
    ]);
    return typeof inputReason === "string" && inputReason.trim() !== "" ? inputReason : null;
  }
  const reader = new LineReader();
  try {
    const line = await reader.ask("");
    return line !== null && line.trim() !== "" ? line.trim() : null;
  } finally {
    reader.close();
  }
}

publishCommand
  .command("deny")
  .description("Deny a publication request")
  .argument("<dataset-id>", "Dataset ID")
  .option("-r, --reason <reason>", "Reason for denial")
  .option(
    "--request-id <n>",
    "The request this denial is for (default: the one in force); refused if it is not the request in force",
  )
  .option(YES_OPTION, YES_DESCRIPTION)
  .option(NO_OPTION, NO_DESCRIPTION)
  .addHelpText(
    "after",
    `
Description:
  Deny a user's publication request with a specific reason.
  The user will receive an email notification with your reason.

  A clear, actionable reason helps users understand what to fix
  before resubmitting their publication request.

  A request cannot be denied while an approval of it is running, or once an
  approval has run a step that publishes (the dataset may be public): wait for
  the run to end. After a step has published, check the dataset: a blocked
  request waits for its depositor to fix what blocked it; for any other, check
  whether approving it again can finish it, or repair it by hand.

Requirements:
  - Must provide a reason for denial: --reason or, with no --reason, one typed
    at a terminal or the first line of piped input (in a script, pass --reason)
  - Reason will be sent to the user via email (at most 2000 characters)
  - User can fix issues and submit a new request

  The denial is for the request shown in the confirmation: its number is sent,
  and the API refuses the denial when that request was withdrawn, denied or filed
  again since, so a request nobody looked at is never denied in its place.
  --request-id <n> names it yourself (for a script that read the request
  earlier); it is refused here, before anything is sent, when it is not the
  request in force.

Examples:
  $ nemar admin publish deny nm099999 --reason "BIDS validation failing"
  $ nemar admin publish deny nm099999 -r "Dataset incomplete - missing subjects"
  $ nemar admin publish deny nm099999    # Prompts for reason interactively
  $ nemar admin publish deny nm099999 --request-id 42 -r "..."  # Only if request 42 is the one in force`,
  )
  .action(
    async (
      datasetArg: string,
      options: ConfirmOptions & { reason?: string; requestId?: string },
    ) => {
      if (!requireSignedIn()) return;
      const datasetId = checkedDatasetId(datasetArg);
      if (datasetId === null) return;

      // The request number the administrator gave, and a reason the Worker would refuse for its
      // length, are both refused before anything is read or sent.
      const named = options.requestId === undefined ? undefined : requestNumber(options.requestId);
      if (options.requestId !== undefined && named === undefined) {
        console.log(
          chalk.red(
            `--request-id needs a request number (a positive whole number); "${plain(options.requestId)}" is not one.`,
          ),
        );
        process.exitCode = 1;
        markReportedExit();
        return;
      }
      if (!reasonFits(options.reason)) return;

      let reason = options.reason;
      if (!reason) {
        reason = (await askReason()) ?? undefined;
        if (!reason) {
          failMessage("Reason is required", {
            answered: true,
            hint: process.stdin.isTTY
              ? undefined
              : `Pass --reason "<why>"; there is no terminal to ask on and nothing was piped in.`,
          });
          return;
        }
      }

      if (!reasonFits(reason)) return;

      // The request this denial is for: the one in force, as `approve` finds it, named in the
      // question and sent with the denial, so a request withdrawn or denied and filed again since
      // is the Worker's 409 and not denied in its place (#1579, ADR 0105 decision 7). A name that is
      // not the request in force is refused here, before anything is sent. A read that cannot say
      // (no such route, a body this CLI cannot read) names none, and the Worker denies the newest
      // active request, as it always did.
      const read = await readReview(datasetId);
      if (read.kind === "unreadable" && read.refused !== undefined) {
        failWith(printable(read.refused), ora(), "The publication review could not be read");
        return;
      }
      const shown = read.kind === "detail" ? requestNumber(read.detail.request_id) : undefined;
      if (named !== undefined && shown !== undefined && named !== shown) {
        console.log(
          chalk.red(
            `--request-id names request #${named}, but the request in force for ${plain(datasetId)} is #${shown}. Nothing was denied.`,
          ),
        );
        process.exitCode = 1;
        markReportedExit();
        return;
      }
      const requestId = named ?? shown;

      const confirmResult = await confirm(
        `Deny publication of ${datasetId}${requestId === undefined ? "" : ` (request #${requestId})`}?`,
        options,
      );
      if (confirmResult !== "confirmed") {
        console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
        // Nothing was denied, and a script that asked for a denial has to be able to tell. The
        // administrator's own answer is not a crash, so no bug-report hint.
        process.exitCode = 1;
        markReportedExit();
        return;
      }

      const spinner = ora(`Denying publication for ${datasetId}...`).start();

      try {
        await denyPublication(datasetId, reason, requestId);
        spinner.succeed(`Publication denied for ${datasetId}`);
        console.log(chalk.dim("  User has been notified."));
      } catch (error) {
        failWith(error, spinner, "Failed to deny publication");
      }
    },
  );

/**
 * Whether a denial reason is short enough for the Worker (`DENIAL_REASON_MAX_LENGTH`), saying so
 * and setting the exit code when it is not; `next` makes the same check before it sends. A missing
 * reason fits: it is asked for next.
 */
function reasonFits(reason: string | undefined): boolean {
  if (reason === undefined || reason.length <= DENIAL_REASON_MAX_LENGTH) return true;
  console.log(
    chalk.red(
      `A denial reason is at most ${DENIAL_REASON_MAX_LENGTH} characters; this one is ${reason.length}. Nothing was sent.`,
    ),
  );
  process.exitCode = 1;
  markReportedExit();
  return false;
}

publishCommand
  .command("screen")
  .description("Re-run the identifier screen of a publication request")
  .argument("<dataset-id>", "Dataset ID")
  .addHelpText(
    "after",
    `
Description:
  Dispatch the identifier screen again for the dataset's active publication
  request (requested or blocked). Use it when the screen did not run, did not
  report, or read a commit that is no longer the repository's main. The admins
  are mailed when it reports, as for a new request.

  Refused while a screen is already running and recent, and for sandbox (xx)
  datasets, which are not screened.

Examples:
  $ nemar admin publish screen nm099999`,
  )
  .action(async (datasetArg: string) => {
    if (!requireSignedIn()) return;
    const datasetId = checkedDatasetId(datasetArg);
    if (datasetId === null) return;
    const spinner = ora(`Re-running the identifier screen for ${datasetId}...`).start();
    try {
      const result = await rerunIdentifierScreen(datasetId);
      if (result.status === "pending") {
        spinner.succeed(`Identifier screen dispatched for ${datasetId}`);
        console.log(chalk.dim("  The admins are mailed when it reports."));
      } else {
        spinner.warn(`The identifier screen for ${datasetId} could not be started`);
        for (const line of screenViewLines(result.identifier_screen, 2)) console.log(line);
        console.log(
          chalk.dim(
            "  Nothing is running. Run this command again once the cause is fixed; the Worker mails the admins when a screen cannot start.",
          ),
        );
        // The Worker answered 202 but nothing was started: a failure, and the Worker's own answer
        // rather than a crash (ADR 0102, Phase 2 amendment, item 12).
        process.exitCode = 1;
        markReportedExit();
      }
    } catch (error) {
      failWith(error, spinner, "Failed to re-run the identifier screen");
    }
  });

registerApproveCommand(publishCommand);
registerNextCommand(publishCommand);
