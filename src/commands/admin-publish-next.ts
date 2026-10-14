/**
 * `nemar admin publish next`: the publication requests that need an administrator, one card at a
 * time (ADR 0102, section 8; the shape of `nemar admin pr-reviews next`, ADR 0093).
 *
 *   nemar admin publish next [--force] [--once] [--dataset <id>]
 *
 * For each request it shows who asked, the screen, a short read of the review and, for a large
 * dataset, what locking it will take, then waits for one answer: `y` approves from this terminal
 * (the loop `approve` runs), `n` denies with a reason you type, `c` mails the depositor a message
 * and leaves the request open, `d` shows the whole review, `s` leaves it, `q` stops.
 *
 * The rules are `publication-review-next.ts`'s, and are tested without a terminal; this file is
 * the terminal. Two things in it are the point of an interactive walk and are held by tests on a
 * pseudo-terminal: a line typed before a card was shown is not an answer to it (`discardTyped`),
 * and the question that confirms an approval over reasons cannot be answered by type-ahead.
 * Every answer is one line the administrator typed; there is no `--yes` here, and the answers of a
 * piped run are the script's own.
 *
 * Nothing in the walk decides a review: the words are the Worker's, the approval is the Worker's
 * gate, and an override is built from the card that was shown (`yAnswer`), never from a second read.
 */

import chalk from "chalk";
import type { Command } from "commander";
import { PUBLICATION_COMMENT_MAX_LENGTH } from "../../shared/contract/publication-review-admin.js";
import {
  ACKNOWLEDGMENT_MAX_LENGTH,
  ACKNOWLEDGMENT_MIN_LENGTH,
  DENIAL_REASON_MAX_LENGTH,
} from "../../shared/publication-limits.js";
import { checkedDatasetId, failWith, requireSignedIn } from "../lib/admin-command.js";
import { commentOnPublication, denyPublication, listPublishRequests } from "../lib/api/publish.js";
import { LineReader } from "../lib/prompt-lines.js";
import { type ReviewRead, readReview, reasonViewLine } from "../lib/publication-review-approve.js";
import { NON_PRODUCTION_NOTE, reviewDetailLines } from "../lib/publication-review-display.js";
import {
  type NextTally,
  type PublishRow,
  type YAnswer,
  cardLines,
  emptyTally,
  exitCodeOf,
  nextQueue,
  parseChoice,
  resumeOf,
  stillNeedYou,
  tallyLine,
  yAnswer,
} from "../lib/publication-review-next.js";
import { plain } from "../lib/terminal-text.js";
import { runApproval } from "./admin-publish-approve.js";

export function registerNextCommand(group: Command): void {
  group
    .command("next")
    .description(
      "Go through the publication requests that need you, one at a time: y approves, n denies with a reason, c comments",
    )
    .option("--dataset <id>", "Only this dataset")
    .option(
      "--force",
      "Let y approve over a review that is not a pass; each such approval asks once more",
    )
    .option("--once", "Handle one request and stop")
    .addHelpText(
      "after",
      `
Description:
  Walk the publication requests that need you, oldest first: waiting for your
  decision (unless only waiting for the screen or the review to report), or an
  approval that stopped and can be resumed. Not a request that is blocked (the
  depositor acts) or has an approval running. For each it shows who asked, the
  identifier screen, a short read of the review and, for a large dataset, what
  locking its files will take, then waits for one answer:

    y   approve it from this terminal: the loop 'approve' runs, a stopped run
        continues. Not offered for a reason nothing clears (a blocked request, a
        failed submission minimum, direct identifiers, a screen that did not run or
        is stale). The identifier screen's own reason asks for your reason, 10 to
        500 characters. A review that is not a pass needs --force: y then shows
        the reasons again and asks once more, defaulting to no, and the override
        is recorded with your account for the review and the reasons shown.
    n   deny it. You are asked for a reason, which the depositor is mailed.
    c   mail the depositor a message you type; the request stays open.
    d   show the whole review, then ask again.
    s   leave it for now (it is not shown again in this run).   q   stop.

  An empty reason or message cancels and asks again, and a typed answer is one
  line. In a terminal, anything you type before a card has been shown is
  ignored, so an impatient Enter cannot answer a request you have not seen.
  There is no --yes: piped answers are the script's own, each one lined up with
  the question it answers, the extra question for --force included.

  The review is read once per card, and what y sends is the review shown and the
  reasons shown, so an approval attaches to what you saw or to nothing: the API
  refuses one when the reasons have changed since.

Exit status:
  0 when nothing failed; 1 when an approval was refused or failed, a denial or a
  comment could not be sent, or the requests could not be read; 130 when stopped
  with Ctrl+C. Skipping, or leaving a request open, is not a failure.

Examples:
  $ nemar admin publish next
  $ nemar admin publish next --force            # y may approve over a review that is not a pass
  $ nemar admin publish next --dataset nm000480
  $ nemar admin publish next --once`,
    )
    .action(async (options: { dataset?: string; force?: boolean; once?: boolean }) => {
      if (!requireSignedIn()) return;
      if (options.dataset !== undefined && checkedDatasetId(options.dataset) === null) return;
      await walk({
        dataset: options.dataset,
        force: options.force === true,
        once: options.once === true,
      });
    });
}

// ---------------------------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------------------------

interface WalkOptions {
  dataset: string | undefined;
  force: boolean;
  once: boolean;
}

/** What the answers of one card share. */
interface Step {
  reader: LineReader;
  tally: NextTally;
}

/** The card being answered: the row, the review as it was read for the card, and what `y` may do. */
interface Card {
  row: PublishRow;
  read: ReviewRead;
  answer: YAnswer;
}

/** What an answer came to: the card is finished, it asks again, or the input ended. */
type Outcome = "done" | "again" | "ended";

/** The requests an administrator could act on: `requested` and `approving` are all `needsAdministrator` keeps. */
async function readQueue(dataset: string | undefined): Promise<PublishRow[]> {
  const [requested, approving] = await Promise.all([
    listPublishRequests("requested"),
    listPublishRequests("approving"),
  ]);
  const rows = [...requested.requests, ...approving.requests];
  return dataset === undefined ? rows : rows.filter((r) => r.dataset_id === dataset);
}

async function walk(options: WalkOptions): Promise<void> {
  const { dataset, force, once } = options;
  console.log(
    chalk.dim(
      "Going through the publication requests that need you, oldest first. Each card says what y may do; n denies, c comments, d shows the review, s skips, q stops.",
    ),
  );
  if (force) {
    console.log(
      chalk.yellow(
        "  --force: y can approve over a review that is not a pass, after asking about each reason.",
      ),
    );
  }

  const reader = new LineReader();
  const handled = new Set<string>();
  const tally = emptyTally();
  const step: Step = { reader, tally };
  let first = true;
  let noted = false;
  const endedWords = () =>
    reader.interrupted
      ? "Interrupted; stopping."
      : "Input ended; stopping.\nSee what needs you with: nemar admin publish list --needs-me";

  // Whatever the loop throws (a field this version of the CLI did not expect, from a Worker of
  // another version), the reader is closed and the tally says what was done before it.
  let completed = false;
  try {
    run: for (;;) {
      let rows: PublishRow[];
      try {
        rows = await readQueue(dataset);
      } catch (error) {
        failWith(error, null, "Could not read the publication requests");
        tally.failed++;
        break;
      }
      if (first) {
        first = false;
        if (rows.length > 0 && rows.every((r) => r.publication_review?.enabled === false)) {
          console.log(
            chalk.dim(
              "  The automated review is off on this Worker, so no review gates an approval.",
            ),
          );
        }
      }
      const pending = nextQueue(rows, handled);
      const row = pending[0];
      if (!row) {
        const left = stillNeedYou(tally);
        if (handled.size === 0 && dataset !== undefined) {
          console.log(
            chalk.dim(
              `\n${dataset} is not waiting for you now: it has no open request, it is blocked, an approval is running, or it is only waiting for the screen or the review.`,
            ),
          );
        } else if (left === 0) {
          console.log(chalk.green("\nNothing left that needs you."));
        } else {
          console.log(
            chalk.yellow(
              `\nNo more requests to show, but ${left} still ${left === 1 ? "needs" : "need"} you (skipped or failed).`,
            ),
          );
        }
        break;
      }
      // The input has ended (Ctrl+D, Ctrl+C or a closed pipe, usually while the last answer was an
      // approval that took its time) and nothing is left to answer with: a card nobody can answer
      // is not drawn, nor its review read.
      if (!reader.canAnswer) {
        console.log(chalk.dim(`\n${endedWords()}`));
        break;
      }
      handled.add(row.dataset_id);

      // The review as it is now, read once: the card, `d` and an override all come from this one.
      const read = await readReview(row.dataset_id);
      const answer = yAnswer(row.dataset_id, read, force, resumeOf(row));
      const card: Card = { row, read, answer };
      if (!noted && read.kind === "detail" && read.detail.environment !== "production") {
        noted = true;
        console.log(chalk.yellow(`\n  ${NON_PRODUCTION_NOTE}`));
      }
      console.log();
      for (const line of cardLines({
        position: handled.size,
        total: handled.size - 1 + pending.length,
        row,
        read,
        answer,
        force,
      })) {
        console.log(line);
      }

      // What was typed before this card existed was not an answer to it.
      const dropped = await reader.discardTyped();
      if (dropped > 0) {
        console.log(chalk.dim(`  Ignored ${dropped} line(s) typed before this card was shown.`));
      }

      for (;;) {
        const raw = await reader.ask(
          `\n${answer.offered ? "y approve, " : ""}n deny, c comment, d details, s skip, q quit > `,
        );
        if (raw === null) {
          console.log(chalk.dim(`\n${endedWords()}`));
          break run;
        }
        const choice = parseChoice(raw);
        if (choice === null) {
          console.log(chalk.dim("  Type y, n, c, d, s or q."));
          continue;
        }
        if (choice === "quit") break run;
        if (choice === "skip") {
          tally.skipped++;
          break;
        }
        let outcome: Outcome;
        switch (choice) {
          case "details":
            showDetails(card);
            outcome = "again";
            break;
          case "approve":
            outcome = await approve(step, card);
            break;
          case "deny":
            outcome = await deny(step, card);
            break;
          case "comment":
            outcome = await comment(step, card);
            break;
        }
        if (outcome === "ended") {
          console.log(chalk.dim(`\n${endedWords()}`));
          break run;
        }
        if (outcome === "done") break;
      }
      if (once) break;
    }

    completed = true;
  } finally {
    reader.close();
    console.log();
    console.log(tallyLine(tally));
    process.exitCode = completed ? exitCodeOf(tally, reader.interrupted) : 1;
  }
}

// ---------------------------------------------------------------------------------------------
// The answers
// ---------------------------------------------------------------------------------------------

/** `d`: the review as the card was read, with the model's words under their labels. */
function showDetails(card: Card): void {
  console.log();
  if (card.read.kind === "detail") {
    let lines: string[];
    try {
      lines = reviewDetailLines(card.read.detail);
    } catch {
      // A detail that parsed but lacks what the rendering reads: a Worker of another version.
      console.log(
        chalk.dim(
          "  The review cannot be shown by this version of the CLI (the NEMAR API sent a shape it does not know). Update the CLI to read it.",
        ),
      );
      return;
    }
    for (const line of lines) console.log(line);
    return;
  }
  const why =
    card.read.kind === "unreadable"
      ? `The review could not be read (${plain(card.read.why)}), so there is nothing more to show.`
      : "The Worker has no review to show for this request.";
  console.log(chalk.dim(`  ${why}`));
}

/**
 * One line the administrator typed, trimmed. An empty line cancels, and so does a line that came
 * with others (a pasted paragraph is one line plus lines that would answer the next questions): a
 * terminal drops them and sends nothing, and a pipe is a script and keeps its lines.
 */
async function askLine(
  reader: LineReader,
  prompt: string,
  what: string,
): Promise<{ kind: "text"; text: string } | { kind: "cancelled" } | { kind: "ended" }> {
  const typed = await reader.ask(prompt);
  if (typed === null) return { kind: "ended" };
  const extra = await reader.discardTyped(40);
  if (extra > 0) {
    console.log(
      chalk.yellow(
        `A ${what} is one line; ${extra} more line(s) arrived with it. Nothing was sent.`,
      ),
    );
    return { kind: "cancelled" };
  }
  const text = typed.trim();
  if (text === "") {
    console.log(chalk.dim("  Cancelled. Nothing was sent."));
    return { kind: "cancelled" };
  }
  return { kind: "text", text };
}

/** `y`: the acknowledgment if the screen needs one, the extra question if reasons are overridden, then the loop `approve` runs. */
async function approve(step: Step, card: Card): Promise<Outcome> {
  const { answer, row, read } = card;
  if (!answer.offered) {
    console.log(chalk.yellow(`  Not approved: ${answer.why}`));
    return "again";
  }

  let acknowledge: string | undefined;
  if (answer.askAcknowledgment) {
    for (;;) {
      const got = await askLine(
        step.reader,
        `Reason for approving over the identifier screen (${ACKNOWLEDGMENT_MIN_LENGTH} to ${ACKNOWLEDGMENT_MAX_LENGTH} characters; empty cancels): `,
        "reason",
      );
      if (got.kind === "ended") return "ended";
      if (got.kind === "cancelled") return "again";
      if (
        got.text.length < ACKNOWLEDGMENT_MIN_LENGTH ||
        got.text.length > ACKNOWLEDGMENT_MAX_LENGTH
      ) {
        console.log(
          chalk.yellow(
            `A reason is ${ACKNOWLEDGMENT_MIN_LENGTH} to ${ACKNOWLEDGMENT_MAX_LENGTH} characters; this one is ${got.text.length}.`,
          ),
        );
        continue;
      }
      acknowledge = got.text;
      break;
    }
  }

  if (answer.overrideReasons.length > 0) {
    // The reasons again, with what clears them, so the question is answered knowing what it names.
    console.log();
    console.log("Approving over:");
    if (read.kind === "detail") {
      for (const r of read.detail.reasons) {
        if (answer.overrideReasons.includes(r.code)) console.log(`  ${plain(reasonViewLine(r))}`);
      }
    }
    // Whatever was typed while this was being drawn is not the answer to it.
    await step.reader.discardTyped();
    const sure = await step.reader.ask(
      `Approve over ${answer.overrideReasons.join(", ")}? This records the override with your account. [y/N] `,
    );
    if (sure === null) return "ended";
    if (!["y", "yes"].includes(sure.trim().toLowerCase())) {
      console.log(chalk.dim("  Cancelled. Nothing was sent."));
      return "again";
    }
  }

  const stopListening = onInterrupt(step, row.dataset_id);
  let run: Awaited<ReturnType<typeof runApproval>>;
  try {
    run = await runApproval(row.dataset_id, {
      resume: resumeOf(row),
      sandbox: false,
      skipCiCheck: false,
      acknowledge,
      // The review and the reasons the card showed: never a second read.
      override: answer.override,
    });
  } finally {
    stopListening();
  }
  keepListening(step.reader);
  if (run.ok) step.tally.approved++;
  else step.tally.failed++;
  return "done";
}

/** `n`: deny with the reason typed, which the Worker mails to the depositor. */
async function deny(step: Step, card: Card): Promise<Outcome> {
  const id = card.row.dataset_id;
  const got = await askLine(
    step.reader,
    "Reason for the denial, mailed to the depositor (empty cancels): ",
    "reason",
  );
  if (got.kind === "ended") return "ended";
  if (got.kind === "cancelled") return "again";
  if (got.text.length > DENIAL_REASON_MAX_LENGTH) {
    console.log(
      chalk.yellow(
        `A denial reason is at most ${DENIAL_REASON_MAX_LENGTH} characters; this one is ${got.text.length}. Nothing was sent.`,
      ),
    );
    return "again";
  }
  try {
    await denyPublication(id, got.text);
  } catch (error) {
    failWith(error, null, `Could not deny ${plain(id)}`);
    step.tally.failed++;
    return "done";
  }
  console.log(chalk.green(`Denied ${plain(id)}; the depositor is mailed the reason.`));
  step.tally.denied++;
  return "done";
}

/** `c`: mail the depositor the message typed, and leave the request exactly as it is. */
async function comment(step: Step, card: Card): Promise<Outcome> {
  const id = card.row.dataset_id;
  const got = await askLine(step.reader, "Message for the depositor (empty cancels): ", "message");
  if (got.kind === "ended") return "ended";
  if (got.kind === "cancelled") return "again";
  if (got.text.length > PUBLICATION_COMMENT_MAX_LENGTH) {
    console.log(
      chalk.yellow(
        `A message is at most ${PUBLICATION_COMMENT_MAX_LENGTH} characters; this one is ${got.text.length}. Nothing was sent.`,
      ),
    );
    return "again";
  }
  try {
    await commentOnPublication(id, got.text);
  } catch (error) {
    // The Worker's own sentence: a failed send may still have reached the depositor, and the
    // sentence says so. It is not rewritten into a claim that nothing was sent.
    failWith(error, null, `Could not send the message for ${plain(id)}`);
    step.tally.failed++;
    return "done";
  }
  console.log(
    chalk.green(`Mailed the message to the depositor of ${plain(id)}; the request stays open.`),
  );
  step.tally.commented++;
  return "done";
}

// ---------------------------------------------------------------------------------------------
// The terminal
// ---------------------------------------------------------------------------------------------

/**
 * Hear Ctrl+C while an approval runs, and return the function that stops listening.
 *
 * The approval's spinner takes over standard input and turns Ctrl+C into a SIGINT event for the
 * whole process, so the walk's reader (which hears Ctrl+C only at a prompt) never sees it. With no
 * listener of its own the CLI's exit hooks turn that event into a plain death: no word, no tally,
 * and an approval that may well go on to publish. With this one registered, they leave it alone.
 *
 * What is said is what is known: the request was sent and nobody heard how it ended, so the run may
 * still be going or may be finished on the server. The two commands that find out and go on are
 * named, then the tally of the rest, and the walk exits 130 as it does for Ctrl+C at a prompt.
 */
function onInterrupt(step: Step, datasetId: string): () => void {
  const handler = () => {
    step.reader.interrupt();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    const id = plain(datasetId);
    console.log();
    console.log(chalk.yellow(`Interrupted while approving ${id}.`));
    console.log(
      "  The approval may still be running, or may have finished on the server. It is not counted below.",
    );
    console.log(
      chalk.dim(`  nemar admin publish show ${id}                find out where it stands`),
    );
    console.log(
      chalk.dim(`  nemar admin publish approve ${id} --resume    continue it if it stopped`),
    );
    console.log();
    console.log(tallyLine(step.tally));
    process.exit(exitCodeOf(step.tally, true));
  };
  process.on("SIGINT", handler);
  return () => {
    process.off("SIGINT", handler);
  };
}

/**
 * Put a terminal's input back the way the walk's reader needs it. The approval's spinner takes
 * over standard input while it spins, and when it stops it pauses the stream and leaves the
 * terminal in line mode; a walk that went on from there would never hear another answer, and
 * would end without a word, because nothing is left to keep the process alive.
 *
 * Only while the reader is still open: after Ctrl+C or Ctrl+D (which can arrive while the
 * approval runs) the stream has been paused on purpose, and resuming it would keep the process
 * from ever exiting.
 */
function keepListening(reader: LineReader): void {
  if (!process.stdin.isTTY || !reader.open) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
}
