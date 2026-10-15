/**
 * `nemar admin publish approve`: approve a publication request and run the orchestrator.
 *
 * Its own file, registered on the `publish` group at the end of `admin-publish.ts`, so the work
 * that follows (the review, the override, `next`) edits this command without editing the group.
 *
 * The order is: check the id, read the request and its review (the Worker's final word on the
 * read, a refusal of the key or the id, ends the command there), show them, decide
 * (`decideApproval`), and only then ask. A refusal never asks and never posts. The Worker is the
 * gate (ADR 0102); this explains, with the same words, and sends the override the Worker needs.
 * `runApproval` is the loop that follows the question, exported because `next` runs it too. What
 * the command prints from the network passes `plain()` where it is printed.
 */

import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import {
  PUBLICATION_REVIEW_NOT_CLEAR_CODE,
  type PublicationReviewDetail,
  type PublicationReviewOverride,
} from "../../shared/contract/publication-review-admin.js";
import {
  ACKNOWLEDGMENT_MAX_LENGTH,
  ACKNOWLEDGMENT_MIN_LENGTH,
  PUBLICATION_DATASET_ID_RE,
} from "../../shared/publication-limits.js";
import {
  PUBLICATION_STEPS,
  PUBLICATION_STEP_LABELS,
  stepsForRelease,
} from "../../shared/publication-steps.js";
import { failWith, requireSignedIn } from "../lib/admin-command.js";
import { ApiError } from "../lib/api/errors.js";
import {
  type PublishProgressInfo,
  type PublishRetryInfo,
  type StepResult,
  approvePublication,
  getPublishStatus,
} from "../lib/api/publish.js";
import {
  type ConfirmOptions,
  NO_DESCRIPTION,
  NO_OPTION,
  YES_DESCRIPTION,
  YES_OPTION,
  confirm,
} from "../lib/confirm.js";
import { markReportedExit } from "../lib/debug-log.js";
import { identifierScreenLines } from "../lib/identifier-screen-display.js";
import {
  type ApproveDecision,
  decideApproval,
  readReview,
  reasonViewLine,
} from "../lib/publication-review-approve.js";
import { approveEvidenceLines } from "../lib/publication-review-display.js";
import { plain } from "../lib/terminal-text.js";

/**
 * The environment variable a web approval's executor is handed its dispatch token in (#1604, ADR
 * 0105 decision 3). Read by `approve` and by nothing else; never printed, never logged.
 */
const DISPATCH_TOKEN_ENV = "NEMAR_APPROVAL_DISPATCH_TOKEN";

/**
 * What `approve` says on standard error, before it reads or sends anything, when the variable is
 * set: a run that presents a token is an executor's run, and a stale variable in a person's shell
 * would otherwise make their own approval fail with `dispatch_superseded` and a sentence that never
 * names it. It carries the variable's name and never its value.
 */
const DISPATCH_TOKEN_NOTICE = `This run presents the dispatch token in ${DISPATCH_TOKEN_ENV} (an executor's run for a web approval); unset the variable to approve as yourself.`;

/**
 * Appended to the Worker's sentence when it refuses the token the run presented
 * (`dispatch_superseded` or `dispatch_expired`). Said here, not in the Worker's shared sentences:
 * the Worker cannot know whether the caller is an executor or a person with a stale variable.
 */
const DISPATCH_TOKEN_UNSET_HINT = `If you are not running a dispatched approval, unset ${DISPATCH_TOKEN_ENV} and run it again.`;

/**
 * What the dispatch token variable holds, read the way `approve` uses it. The two ends are trimmed,
 * as the Worker trims the header, so a token exported with the newline a file ends with is the
 * same token (ADR 0105, decision 3). What is left is none when it is empty (an unset variable, an
 * empty one, or whitespace alone). Anything else must be what a header can carry: printable ASCII
 * with no whitespace inside, so a stray line break, a typographic quote pasted with the value or a
 * character from another script is refused here with a sentence, not handed to the HTTP client,
 * which throws on it and reports a network failure that the command would retry for a while. A
 * straight quote is printable ASCII and is sent; the Worker refuses it. The Worker mints 64
 * lowercase hexadecimal characters; this does not insist on that, so a token of another shape
 * still reaches the Worker and is refused there with the Worker's own words. The `problem` names
 * what is wrong and never the value, which is a credential.
 */
function readDispatchToken(
  raw: string | undefined,
): { kind: "none" } | { kind: "token"; value: string } | { kind: "malformed"; problem: string } {
  const value = raw?.trim() ?? "";
  if (value === "") return { kind: "none" };
  if (/^[\x21-\x7e]+$/.test(value)) return { kind: "token", value };
  return {
    kind: "malformed",
    problem: /\s/.test(value)
      ? "it contains whitespace"
      : "it contains a character outside printable ASCII",
  };
}

/** Whether `error` is the Worker refusing the dispatch token a call carried (it was replaced, or has lapsed). */
function isDispatchTokenRefusal(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.statusCode === 409 &&
    (error.code === "dispatch_superseded" || error.code === "dispatch_expired")
  );
}

export function registerApproveCommand(group: Command): void {
  group
    .command("approve")
    .description("Approve and publish a dataset (runs orchestrator)")
    .argument("<dataset-id>", "Dataset ID")
    .option("--resume", "Resume from last failed step")
    .option(
      "--sandbox",
      `Use Zenodo sandbox for testing (refused while ${DISPATCH_TOKEN_ENV} is set)`,
    )
    .option(
      "--skip-ci-check",
      `Skip the orchestrator's live BIDS validation check (recorded; clears no review reason; refused while ${DISPATCH_TOKEN_ENV} is set)`,
    )
    .option(
      "--acknowledge-identifier-screen <reason>",
      `Approve over an identifier screen that needs review, recording why (${ACKNOWLEDGMENT_MIN_LENGTH} to ${ACKNOWLEDGMENT_MAX_LENGTH} characters; refused while ${DISPATCH_TOKEN_ENV} is set)`,
    )
    .option(
      "--force",
      `Approve over a publication review that is not a pass, recorded with your account (refused while ${DISPATCH_TOKEN_ENV} is set)`,
    )
    .option(
      "--request-id <n>",
      "The request this approval is for (default: the one shown); refused if it is not the request in force",
    )
    .option(YES_OPTION, YES_DESCRIPTION)
    .option(NO_OPTION, NO_DESCRIPTION)
    .addHelpText(
      "after",
      `
Description:
  Approve a publication request and run the automated orchestrator
  to make the dataset publicly accessible with a permanent DOI.

  The request's IDENTIFIER SCREEN must allow it first. A clean screen passes.
  A screen that needs review, or could not look at everything, passes only with
  --acknowledge-identifier-screen "<reason>", which is recorded with your name.
  Direct identifiers cannot be acknowledged: the depositor fixes the data and
  requests again. A screen that did not run or did not report must be re-run
  with 'nemar admin publish screen <dataset-id>', and so must one whose commit
  is no longer the repository's main. 'nemar admin publish list' shows it.

  The PUBLICATION REVIEW (ADR 0102) is read next and shown with the screen. A pass
  approves. A reason nothing clears (a blocked request, a failed submission
  minimum, direct identifiers, a screen that did not run, is still running or is
  stale, a version kept after an anonymous release) refuses the approval and
  names who acts; --force does not change that. Any other reason (a failed or unanswered
  question, BIDS validation, the version, a review that did not run) needs
  --force, which records an override with your account for the review and the
  reasons shown. A run that has started publishing is continued with --resume
  and is not gated again. The API is the gate: this explains it first.

  --yes answers the confirmation and nothing else. It never stands in for
  --force or for --acknowledge-identifier-screen.

  The approval is for the request shown: its number is sent with every approval
  call of the run, and the API refuses it when that request was denied or filed
  again since, so a request nobody read is never approved in its place.
  --request-id <n> names it yourself (for a script that read the request
  earlier); it is refused here, before any approval is sent, when it is not the
  request shown.

  A run the website started is handed a token, in the environment variable
  ${DISPATCH_TOKEN_ENV}, and presents it on every approval call (as a header,
  never printed or logged; the reads of the review and the status carry none).
  With it the API records the administrator who clicked Approve as the approver,
  and you are only the executor. Such a run carries the
  decision its click made, so while the variable is set --force,
  --acknowledge-identifier-screen, --skip-ci-check and --sandbox are refused
  here, before anything is sent.
  Without the variable the command is your own approval, recorded under your
  account. Once it passes the gates it takes the claim over, and the website's
  run is refused at its next call. 'next' never reads the variable.
  A run that presents a token says so on standard error before it reads or sends
  anything, and a refusal of that token is followed by how to unset the variable,
  for a person whose shell still holds a stale one.

  --skip-ci-check skips the orchestrator's live CI check, and the approval's audit
  row records that it was used. It never clears a review reason: a failed or
  unconcluded BIDS validation at the reviewed commit needs --force. It is your
  own decision, so a run that presents a dispatch token never uses it, and the
  same holds for --sandbox.

  An ANONYMOUS RELEASE runs a smaller step set: the GitHub repository stays
  private, no identifier is published, and the depositor is not named. The
  confirmation banner reads the pending request and lists what will actually
  run, so approve one and read the banner rather than this list.

  WARNING: This action is PERMANENT. Published datasets cannot be unpublished.
  Once a DOI is assigned, it is permanent and cannot be deleted.

Orchestrator Steps (execution order; shared/publication-steps.ts):
   1. CI Check          - Verify BIDS validation passes, deploy workflows if missing
   2. Enrichment Check  - Verify metadata pipeline has run (warn-only, non-blocking)
   3. S3 Public Read    - Grant public read access to S3 data
   4. Repo Public       - Publish the catalog row; for an ordinary publication
                          this also makes the GitHub repository public, and for
                          an anonymous release the repository stays private
   5. Tag Protection    - Enable tag protection rules
   6. Create DOI        - Create concept DOI via EZID (or Zenodo if configured)
   7. Update Metadata   - Update dataset metadata from BIDS description
   8. Update README     - Add DOI badge and citation info to README
   9. Create Tag        - Create version tag (e.g., v1.0.0)
  10. Create Release    - Create GitHub release from tag
  11. Upload to Zenodo  - Legacy Zenodo upload (disabled; kept for step history)
  12. Publish DOI       - Make DOI public and findable (permanent, irreversible)
  13. Version DOI       - Mint the version DOI and dispatch the manifest job,
                          which is what records the version. Runs for an
                          anonymous release too, minting RESERVED (#1447)
  14. S3 Lock           - Enable S3 Object Lock (prevents data deletion)
  15. Sync NEMAR        - Legacy nemar.org sync (no-op, retired)
  16. Notify User       - Send publication confirmation email

  (Archive zip generation is not an orchestrator step; the version-DOI
  workflow dispatches it separately.)

  Steps 7, 8, 11 and 12 are skipped for an anonymous release: each one either
  publishes an identifier or writes one into a file the data plane serves
  publicly. See ANONYMOUS_RELEASE_SKIPPED_STEPS in shared/publication-steps.ts,
  which states the reason for each.

Environment Variables:
  ${DISPATCH_TOKEN_ENV}
                  The dispatch token of a web approval, set for the run that
                  executes it; leave it unset at a terminal.

Resume Capability:
  If a step fails, the orchestrator saves progress. Use --resume to retry
  from the failed step without re-running successful steps.

  The orchestrator is idempotent - safe to run multiple times. Completed
  steps are automatically skipped.

Examples:
  $ nemar admin publish approve nm099999                    # Run full orchestrator
  $ nemar admin publish approve nm099999 --resume           # Resume from failed step
  $ nemar admin publish approve nm099999 --skip-ci-check    # Skip the live CI check only
  $ nemar admin publish approve nm099999 --force            # Approve over a review that is not a pass
  $ nemar admin publish approve nm099999 --yes              # Skip confirmation (never a reason)
  $ nemar admin publish approve nm099999 --request-id 42    # Only if request 42 is the one in force

After Approval:
  - User receives email with DOI and public dataset link
  - Dataset is publicly visible on GitHub
  - Tags are protected (prevents version manipulation)
  - Data is protected by S3 Object Lock`,
    )
    .action(
      async (
        datasetId,
        options: ConfirmOptions & {
          resume?: boolean;
          sandbox?: boolean;
          skipCiCheck?: boolean;
          acknowledgeIdentifierScreen?: string;
          force?: boolean;
          requestId?: string;
        },
      ) => {
        if (!requireSignedIn()) return;

        // A malformed id is refused here, as `show` and `start` do, before anything is sent: the
        // Worker would answer 400 to the read, and the rest of the command would go on to ask.
        if (!PUBLICATION_DATASET_ID_RE.test(datasetId)) {
          console.log(chalk.red(`"${plain(datasetId)}" is not a dataset id (like nm000108).`));
          process.exitCode = 1;
          markReportedExit();
          return;
        }

        const ack = options.acknowledgeIdentifierScreen?.trim();
        if (
          ack !== undefined &&
          (ack.length < ACKNOWLEDGMENT_MIN_LENGTH || ack.length > ACKNOWLEDGMENT_MAX_LENGTH)
        ) {
          console.log(
            chalk.red(
              `--acknowledge-identifier-screen needs a reason of ${ACKNOWLEDGMENT_MIN_LENGTH} to ${ACKNOWLEDGMENT_MAX_LENGTH} characters.`,
            ),
          );
          process.exitCode = 1;
          markReportedExit();
          return;
        }

        // The request number the administrator gave, checked before anything is read or sent.
        const named =
          options.requestId === undefined ? undefined : requestNumber(options.requestId);
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

        // The dispatch token of a web approval this command is executing (#1604), from the
        // environment the workflow set it in, and only here: `next` is a person's walk and never
        // reads it, so a token left in a shell cannot turn it into an executor. Blank is none, and
        // a value no header can carry is refused (`readDispatchToken`). A run the web started
        // carries the decision its click made, and the API refuses a call that carries the token
        // and a decision of its own, so the three decision flags (the override, the screen's
        // acknowledgment and the skip of the CI check) are refused here, before anything is read or
        // sent.
        const tokenInput = readDispatchToken(process.env[DISPATCH_TOKEN_ENV]);
        if (tokenInput.kind === "malformed") {
          console.log(
            chalk.red(
              `${DISPATCH_TOKEN_ENV} is set to a value that cannot be a dispatch token (${tokenInput.problem}). Unset it to approve as yourself, or set it to the token the web approval handed this run. Nothing was sent.`,
            ),
          );
          process.exitCode = 1;
          markReportedExit();
          return;
        }
        const dispatchToken = tokenInput.kind === "token" ? tokenInput.value : undefined;
        if (dispatchToken !== undefined) {
          const decision = options.force
            ? "--force"
            : ack !== undefined
              ? "--acknowledge-identifier-screen"
              : options.skipCiCheck
                ? "--skip-ci-check"
                : options.sandbox
                  ? "--sandbox"
                  : null;
          if (decision !== null) {
            // The click recorded an override and an acknowledgment, and made no CI decision at all:
            // it has no option for one, so a run the website started never skips the CI check.
            // Each flag gets the reason that is true of it (ADR 0105, decision 5).
            const why =
              decision === "--skip-ci-check"
                ? "a run the website started never skips the CI check (the click has no such option), and the API refuses a run that asks to"
                : decision === "--sandbox"
                  ? "a run the website started never uses the sandbox (the click has no such option, and a test DOI is not what it was for), and the API refuses a run that asks to"
                  : "a run the website started carries the decision its click made, and the API refuses a run that sends one of its own";
            console.log(
              chalk.red(
                `${decision} cannot be used while ${DISPATCH_TOKEN_ENV} is set: ${why}. Unset ${DISPATCH_TOKEN_ENV} to approve as yourself. Nothing was sent.`,
              ),
            );
            process.exitCode = 1;
            markReportedExit();
            return;
          }
          // Said before anything is read or sent, on standard error so that standard output keeps
          // what a script reads. A person whose shell still holds the variable learns here, and
          // not from a refusal that does not name it, that this run is not their own approval.
          console.error(chalk.yellow(DISPATCH_TOKEN_NOTICE));
        }

        const action = options.resume
          ? `Resume publication of ${datasetId}`
          : `Approve and publish ${datasetId}`;
        console.log(chalk.cyan(`\n${action}\n`));

        // The review of the request (ADR 0102): the screen and the review, in the Worker's words,
        // then the decision. Read once, shown, and decided from what was shown, so an override is
        // built from exactly this and never from a second read.
        const read = await readReview(datasetId);
        if (read.kind === "unreadable" && read.refused !== undefined) {
          // The Worker's final word on the read (no key, not an administrator): say it, exit 1, and
          // do not ask a question about an approval it would refuse. A 404 for a request that is
          // not there is different, and goes on: the Worker's answer to the approval is the one
          // that ends it.
          failWith(printable(read.refused), ora(), "The publication review could not be read");
          return;
        }
        // The request the run is for: the one the review just shown belongs to, unless the
        // administrator named one. A name that is not the request shown is refused here, before the
        // question and before any approval is sent (the review was read, which is how the request
        // in force is known; the Worker would refuse the approval too, but later).
        const shown = read.kind === "detail" ? requestNumber(read.detail.request_id) : undefined;
        if (named !== undefined && shown !== undefined && named !== shown) {
          console.log(
            chalk.red(
              `--request-id names request #${named}, but the request in force for ${plain(datasetId)} is #${shown}. No approval was sent.`,
            ),
          );
          process.exitCode = 1;
          markReportedExit();
          return;
        }
        const requestId = named ?? shown;
        if (read.kind === "detail") {
          for (const line of reviewLines(read.detail, datasetId)) console.log(line);
        }

        // Ask the server what this request IS before describing what approving
        // it will do (#1447). An anonymous release runs a strictly smaller step
        // set, and the banner used to be a hand-numbered literal of all sixteen:
        // an admin approving one was told the repository would be made public
        // and the DOI published irreversibly, and neither happens. A banner that
        // describes the wrong operation is worse than no banner, because it is
        // the screen the decision is made from.
        //
        // The detail just read carries `anonymous`, so that is the answer when there is one; a
        // second source could disagree with what was printed above it, or fail while it did not.
        let anonymousRelease = false;
        let planUnknownReason: string | null = null;
        if (read.kind === "detail" && typeof read.detail.anonymous === "boolean") {
          anonymousRelease = read.detail.anonymous;
        } else {
          try {
            anonymousRelease = (await getPublishStatus(datasetId)).anonymous === true;
          } catch (err) {
            // Unreadable state is not a reason to refuse an approval the admin can
            // still make, but it IS a reason to stop asserting what will happen --
            // and to say WHY. A bare `catch {}` here printed "could not read the
            // request's state" for an expired key, a 404 and a network failure
            // alike, which is three different next actions rendered as one.
            planUnknownReason = err instanceof Error ? err.message : String(err);
          }
        }

        const decision = decideApproval(datasetId, read, {
          force: !!options.force,
          acknowledge: ack,
          resume: !!options.resume,
        });
        if (decision.kind === "refuse") {
          printRefusal(decision);
          return;
        }
        for (const line of noteLines(decision.notes)) console.log(line);

        const steps = stepsForRelease(anonymousRelease);
        if (planUnknownReason === null) {
          console.log(
            anonymousRelease
              ? `This is an ANONYMOUS RELEASE and will run ${steps.length} of the ${PUBLICATION_STEPS.length} orchestrator steps:`
              : `This will run the following ${steps.length}-step orchestrator:`,
          );
        } else {
          console.log(
            chalk.yellow(
              `Could not read the request's state (${plain(planUnknownReason)}), so this lists all ${steps.length} steps; an anonymous release runs fewer.`,
            ),
          );
        }
        // Two columns, generated from the step list rather than typed out, so
        // adding a step cannot leave the banner describing the old publication.
        const half = Math.ceil(steps.length / 2);
        for (let i = 0; i < half; i++) {
          const left = steps[i];
          const right = steps[i + half];
          const label = (step: (typeof steps)[number], n: number): string => {
            const text =
              step === "doi_create" && options.sandbox
                ? `${PUBLICATION_STEP_LABELS[step]} (SANDBOX)`
                : PUBLICATION_STEP_LABELS[step];
            return `${String(n).padStart(2, " ")}. ${text}`;
          };
          const leftCell = label(left, i + 1).padEnd(34, " ");
          console.log(`   ${leftCell}${right ? label(right, i + half + 1) : ""}`.trimEnd());
        }
        if (anonymousRelease) {
          console.log();
          console.log(
            chalk.yellow("  The GitHub repository stays PRIVATE and no identifier is published:"),
          );
          console.log(
            chalk.yellow(
              "  the concept and version DOIs stay reserved until the deposit is published for real.",
            ),
          );
        }
        console.log();

        // Sandbox warning
        if (options.sandbox) {
          console.log(chalk.yellow("━".repeat(60)));
          console.log(chalk.yellow.bold("                 SANDBOX MODE ENABLED"));
          console.log(chalk.yellow("━".repeat(60)));
          console.log(chalk.yellow("  • DOI will be created in sandbox mode (EZID test shoulder)"));
          console.log(chalk.yellow("  • DOI will NOT be indexed by DataCite"));
          console.log(chalk.yellow("  • DOI will NOT resolve in production"));
          console.log(chalk.yellow("  • Use this for testing workflows only"));
          console.log(chalk.yellow("━".repeat(60)));
          console.log();
        }

        const confirmResult = await confirm(`${action}?`, options);
        if (confirmResult !== "confirmed") {
          console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
          // Nothing was approved, and a script that asked for an approval has to be able to tell.
          // The administrator's own answer is not a crash, so no bug-report hint.
          process.exitCode = 1;
          markReportedExit();
          return;
        }

        await runApproval(datasetId, {
          resume: !!options.resume,
          sandbox: !!options.sandbox,
          skipCiCheck: !!options.skipCiCheck,
          acknowledge: ack,
          override: decision.override,
          requestId,
          dispatchToken,
        });
      },
    );
}

/**
 * `value` as a request number: a positive whole number, from the text of `--request-id` or from a
 * field of the review (a number there, but the client does not check that it is). Undefined for
 * anything else, so a Worker that sends none, or sends something else, names no request.
 */
export function requestNumber(value: unknown): number | undefined {
  const n = typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * The lines of the screen and the review of the request, as the Worker worded them (colour and
 * indentation only), with the evidence behind the reasons from the same detail
 * ({@link approveEvidenceLines}), and a blank line after. Every string of the detail passes
 * `plain()`: the Worker reduces what it stores, and a terminal should not depend on that alone.
 */
export function reviewLines(detail: PublicationReviewDetail, datasetId: string): string[] {
  const { headline, tone, lines } = detail.description;
  // What the administrator needs to decide goes ahead of the standing line, which is last, as in
  // `show`: what the model was shown and what was withheld, and where the whole review is.
  const evidence = approveEvidenceLines(detail.review, datasetId);
  const review = {
    state: null,
    headline: plain(headline),
    tone,
    lines: [
      `Gate: ${plain(detail.gate)}`,
      ...lines.slice(0, -1),
      ...evidence,
      ...lines.slice(-1),
    ].map(plain),
  };
  const screen = detail.identifier_screen;
  return [
    ...identifierScreenLines(
      screen && typeof screen.headline === "string"
        ? {
            ...screen,
            headline: plain(screen.headline),
            lines: Array.isArray(screen.lines) ? screen.lines.map(plain) : [],
          }
        : undefined,
      2,
    ),
    ...identifierScreenLines(review, 2),
    "",
  ];
}

/** A refusal before anything was asked or posted: the reasons, the cure, and exit 1. */
function printRefusal(decision: Extract<ApproveDecision, { kind: "refuse" }>): void {
  for (const line of refusalLines(decision)) console.log(line);
  // The command declined to act; that is its answer, not a crash, so no bug-report hint.
  process.exitCode = 1;
  markReportedExit();
}

/** The lines of a refusal: "Not approved:", each reason with its cure, and a blank line. */
export function refusalLines(decision: Extract<ApproveDecision, { kind: "refuse" }>): string[] {
  // What nothing clears reads as a stop; what the administrator can clear with a flag, as a note.
  const colour = decision.why === "hard" || decision.why === "blocked" ? chalk.red : chalk.yellow;
  return [colour("Not approved:"), ...decision.lines.map((line) => colour(`  ${plain(line)}`)), ""];
}

/** The notes of a decision that goes on, indented, with a blank line after; nothing for none. */
export function noteLines(notes: readonly string[]): string[] {
  return notes.length === 0 ? [] : [...notes.map((note) => chalk.yellow(`  ${plain(note)}`)), ""];
}

/** Whether the approval ran to the end. A refusal, a failure and a run that gave up are all `ok: false`, and already reported. */
export type ApprovalRun = { ok: true } | { ok: false };

interface RunApprovalOptions {
  resume: boolean;
  sandbox: boolean;
  skipCiCheck: boolean;
  acknowledge?: string;
  /** The review shown and the reasons shown, sent on every call of the run; null when none. */
  override: PublicationReviewOverride | null;
  /** The request the run is for, sent on every call of the run so the Worker can refuse a stale one (#1579). */
  requestId?: number;
  /**
   * The dispatch token of the web approval this run executes, sent as a header on every approval
   * call of it and on no read (#1604). Only `approve` sets it, from the environment; `next` never
   * does.
   */
  dispatchToken?: string;
}

/**
 * `error` with a message that is safe to print: `failWith` prints it as it is, and it came from the
 * network (a Worker's refusal, a body that was not JSON). The message is cleaned in place; the error
 * is about to be reported and dropped.
 */
export function printable(error: unknown): unknown {
  if (error instanceof Error) error.message = plain(error.message);
  return error;
}

/** Whether the Worker refused the approval for the review: a 409 whose `error` is the review gate's word. */
function isReviewRefusal(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.statusCode === 409 &&
    error.code === PUBLICATION_REVIEW_NOT_CLEAR_CODE
  );
}

/** The lines that tell an administrator the CLI is about to retry a step the Worker failed. */
export function retryNoticeLines(info: PublishRetryInfo): string[] {
  const stepLabel = info.step ? plain(info.step).replace(/_/g, " ") : "step";
  return [
    chalk.yellow(`  [!] ${stepLabel} failed: ${plain(info.error)}`),
    chalk.dim(
      `  Retrying in ${Math.round(info.delayMs / 1000)}s (attempt ${info.attempt + 1}/${info.maxAttempts})...`,
    ),
  ];
}

/** Each reason of a review refusal with its cure, then where to read the whole review; nothing when it carries none. */
export function reviewRefusalLines(error: unknown, datasetId: string): string[] {
  const reasons = refusalReasons(error);
  if (reasons.length === 0) return [];
  return [
    ...reasons.map((line) => chalk.dim(`  ${line}`)),
    `  Next: nemar admin publish show ${plain(datasetId)}`,
  ];
}

/** The reasons a review refusal carries, one sentence and cure each; those it does not carry are left out. */
export function refusalReasons(error: unknown): string[] {
  const body = error instanceof ApiError ? error.rawBody : undefined;
  const reasons = (body as { reasons?: unknown } | undefined)?.reasons;
  if (!Array.isArray(reasons)) return [];
  return reasons
    .filter(
      (r): r is { sentence: string; cure: string; line?: unknown } =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as { sentence?: unknown }).sentence === "string" &&
        typeof (r as { cure?: unknown }).cure === "string",
    )
    .map((r) =>
      plain(
        reasonViewLine({
          sentence: r.sentence,
          cure: r.cure,
          line: typeof r.line === "string" ? r.line : undefined,
        }),
      ),
    );
}

/** One step of the run as one line, for the result of a run and for the timeline of one that failed. */
export function stepResultLine(sr: StepResult, idx: number, total: number): string {
  const stepNum = `[${String(idx + 1).padStart(2, " ")}/${total}]`;
  const stepName = plain(sr.step).replace(/_/g, " ");
  if (sr.status === "completed") {
    const durationSec = (sr.duration_ms / 1000).toFixed(1);
    const retryNote = sr.attempts > 1 ? ` (attempt ${plain(String(sr.attempts))})` : "";
    return `  ${chalk.green("[x]")} ${chalk.dim(stepNum)} ${stepName} ${chalk.dim(`(${durationSec}s${retryNote})`)}`;
  }
  if (sr.status === "failed") {
    return `  ${chalk.red("[!]")} ${chalk.dim(stepNum)} ${stepName}${sr.error ? `: ${chalk.red(plain(sr.error))}` : ""}`;
  }
  return `  ${chalk.dim("[-]")} ${chalk.dim(stepNum)} ${chalk.dim(stepName)} ${chalk.dim("(skipped)")}`;
}

/** What follows the spinner's success line: the step results (or the bare list of steps), and any warning. */
export function resultLines(result: {
  step_results?: StepResult[];
  steps_completed?: string[];
  warning?: string;
}): string[] {
  const out: string[] = [];
  if (result.step_results && result.step_results.length > 0) {
    const total = result.step_results.length;
    out.push("", ...result.step_results.map((sr, idx) => stepResultLine(sr, idx, total)), "");
  } else if (result.steps_completed) {
    // Fallback for responses without step_results
    out.push(
      "",
      ...result.steps_completed.map(
        (step) => `  ${chalk.green("[x]")} ${plain(step).replace(/_/g, " ")}`,
      ),
      "",
    );
  }
  // Surface non-fatal orchestrator warnings (e.g. notify_user email failure) so operators know to
  // follow up without re-running.
  if (result.warning) out.push(chalk.yellow(`  Warning: ${plain(result.warning)}`));
  return out;
}

/** The per-attempt step timeline the retry loop attached to a failed run; nothing when there is none. */
export function timelineLines(stepResults: StepResult[] | undefined): string[] {
  if (!stepResults || stepResults.length === 0) return [];
  const total = stepResults.length;
  return [
    "",
    chalk.dim("Step timeline (last attempt):"),
    ...stepResults.map((sr, idx) => stepResultLine(sr, idx, total)),
    "",
  ];
}

/**
 * The approval loop of `approve` and of `y` in `next`: the spinner, the progress, the retries, the
 * result lines and, for a refusal or a failure, the words and the exit code (1, always: #1581).
 *
 * The override, the request number and the dispatch token (when the run executes a web approval)
 * are sent on every call of the run (`approvePublication`), so a retry that lands before the run is
 * marked approving passes the gate again with the same override, a request denied and filed again
 * while the run goes is refused (`request_mismatch`), and every call proves it belongs to its
 * click. A refusal the Worker answers with (the review gate, the screen, a blocked request) is
 * printed in the shared words, and so is a failure; the result says only whether the run went
 * through.
 */
export async function runApproval(
  datasetId: string,
  opts: RunApprovalOptions,
): Promise<ApprovalRun> {
  const initialSpinnerText = "Running publication workflow (this may take a few minutes)...";
  const spinner = ora(initialSpinnerText).start();

  // Most recent step label rendered into the spinner; kept on the
  // outer scope so onRetry can restore the same line after the
  // retry notice instead of falling back to the generic text.
  let currentSpinnerText = initialSpinnerText;

  /**
   * Render the spinner line for a progress event. Shows the step
   * position and, for s3_lock, a running locked/total ratio so the
   * admin can see thousands-of-objects datasets making progress
   * instead of staring at a static spinner for minutes. See #284.
   */
  function renderProgress(info: PublishProgressInfo): string {
    const stepLabel = plain(info.step).replace(/_/g, " ");
    const head = `Step ${info.stepIndex}/${info.stepTotal}: ${stepLabel}`;
    if (
      info.step === "s3_lock" &&
      info.s3LockLocked !== undefined &&
      info.s3LockTotal !== undefined &&
      info.s3LockTotal > 0
    ) {
      const pct = ((info.s3LockLocked / info.s3LockTotal) * 100).toFixed(1);
      const resumeSuffix = info.s3LockResumed ? " (resumed)" : "";
      // The counts are numbers by contract and the client does not check that they are, so
      // they pass `plain` like every other network string (a number is unchanged by it).
      return `${head} | Locking S3 objects: ${plain(String(info.s3LockLocked))}/${plain(String(info.s3LockTotal))} (${pct}%)${resumeSuffix}`;
    }
    if (info.step === "s3_lock" && info.s3LockLocked !== undefined) {
      // Total not yet known (rare; first response before server has
      // counted). Show running count without the denominator so the
      // line still advances.
      const resumeSuffix = info.s3LockResumed ? " (resumed)" : "";
      return `${head} | Locking S3 objects: ${plain(String(info.s3LockLocked))}${resumeSuffix}`;
    }
    return head;
  }

  try {
    const result = await approvePublication(
      datasetId,
      opts.resume,
      opts.sandbox,
      opts.skipCiCheck,
      (info) => {
        // Surface transient failures the CLI is about to retry. We pause
        // the spinner so the message isn't overwritten, then resume it.
        spinner.stop();
        for (const line of retryNoticeLines(info)) console.log(line);
        spinner.start(currentSpinnerText);
      },
      (info) => {
        currentSpinnerText = renderProgress(info);
        spinner.text = currentSpinnerText;
      },
      opts.acknowledge,
      opts.override ?? undefined,
      { requestId: opts.requestId, dispatchToken: opts.dispatchToken },
    );
    // The Worker answers 200 for a run whose steps are all done but whose tail job warned, and
    // leaves the request `approving` (ADR 0105, decision 12): the warning's remedy is to approve
    // again. That is not an approval, so it is not a success line and not exit 0, and `next` does
    // not count it as approved. Only an answer that says `published` is one.
    if (result.status !== "published") {
      spinner.warn(plain(result.message));
      for (const line of resultLines(result)) console.log(line);
      console.log(
        chalk.yellow(
          `  Not published yet: the request is ${plain(String(result.status ?? "not published"))}. Do what the warning says, then run: nemar admin publish approve ${plain(datasetId)} --resume`,
        ),
      );
      // A script that asked for an approval has to be able to tell, and this is the Worker's own
      // answer rather than a crash, so no bug-report hint.
      process.exitCode = 1;
      markReportedExit();
      return { ok: false };
    }
    spinner.succeed(plain(result.message));
    for (const line of resultLines(result)) console.log(line);
    return { ok: true };
  } catch (error) {
    // A refusal of the token this run presented is followed by the way out for a person whose
    // shell holds a stale one; a run that carried no token, or was refused for another reason,
    // gets nothing added.
    const hints: Record<number, string> = { 422: "Fix the CI issues and retry with --resume" };
    if (opts.dispatchToken !== undefined && isDispatchTokenRefusal(error)) {
      hints[409] = DISPATCH_TOKEN_UNSET_HINT;
    }
    failWith(printable(error), spinner, "Failed to approve publication", hints);

    // The review gate's refusal carries every live reason in the shared words: print each with
    // its cure, then where to read the whole review. `unverified` carries none (the Worker could
    // not read the review, and its sentence says to try again).
    if (isReviewRefusal(error)) {
      for (const line of reviewRefusalLines(error, datasetId)) console.log(line);
    }

    // After all retries fail, surface the per-attempt step timeline the
    // retry loop attached to the error so the admin sees which step
    // failed when, instead of just the final 500 message.
    const stepResults = (error as { stepResults?: StepResult[] }).stepResults;
    for (const line of timelineLines(stepResults)) console.log(line);
    return { ok: false };
  }
}
