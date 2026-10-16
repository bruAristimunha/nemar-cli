/**
 * `nemar admin publish show | start`: the automated review of a publication request, from the
 * administrator's side (ADR 0102, section 8).
 *
 *   nemar admin publish show <ds>            the review of the active request, in the Worker's words
 *   nemar admin publish start <ds>           start the review of the current screened commit
 *   nemar admin publish start --all          start every review that can be started
 *
 * Registered on the `publish` group by `admin-publish.ts`. Every sentence about a review comes
 * from the Worker (`describePublicationReview`), and `publication-review-display.ts` prints it;
 * this file decides nothing about a review. What it does decide is the exit code: 0 when the thing
 * asked for happened or already exists, 1 for everything else (#1581).
 */

import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import { PLATFORM_DAILY_CAP } from "../../shared/publication-review.js";
import {
  checkedDatasetId,
  failMessage,
  failWith,
  isAnswered,
  requireSignedIn,
} from "../lib/admin-command.js";
import { ApiError } from "../lib/api/errors.js";
import {
  type PublishRequestsResponse,
  type StartedPublicationReview,
  getPublicationReview,
  listPublishRequests,
  reviewErrorCode,
  startPublicationReview,
} from "../lib/api/publish.js";
import { type ConfirmResult, YES_OPTION, confirm } from "../lib/confirm.js";
import { markReportedExit } from "../lib/debug-log.js";
import {
  NON_PRODUCTION_NOTE,
  reviewDetailLines,
  startedSentence,
} from "../lib/publication-review-display.js";
import { startAllCandidates } from "../lib/publication-review-queue.js";
import { plain } from "../lib/terminal-text.js";

type Row = PublishRequestsResponse["requests"][number];

export function registerReviewCommands(group: Command): void {
  group
    .command("show")
    .description("Show the automated review of a publication request")
    .argument("<dataset-id>", "Dataset ID")
    .option("--json", "Output the detail as JSON instead of text")
    .addHelpText(
      "after",
      `
Description:
  Read the review of the dataset's active publication request: its identifier
  screen, then the review's outcome with every reason it is not a pass and what
  clears it, the four questions it asked, the facts the platform used to lower an
  answer, what the model found and said, the evidence it was given, what it was
  shown, any override on record, and the command to run next.

  The findings and the summary are written by the model, from text the depositor
  wrote, and are printed under labels that say so: they inform your decision and
  never make it. Whether a README names the depositors is not assessed.

Examples:
  $ nemar admin publish show nm000480
  $ nemar admin publish show nm000480 --json`,
    )
    .action(async (datasetArg: string, options: { json?: boolean }) => {
      const json = options.json === true;
      if (!requireSignedIn(json)) return;
      const datasetId = checkedDatasetId(datasetArg, json);
      if (datasetId === null) return;

      const spinner = json ? null : ora("Reading the review...").start();
      try {
        const detail = await getPublicationReview(datasetId);
        spinner?.stop();
        if (json) {
          console.log(JSON.stringify(detail, null, 2));
          return;
        }
        console.log();
        for (const line of reviewDetailLines(detail)) console.log(line);
        console.log();
      } catch (error) {
        failWith(error, spinner, "Could not read the review", undefined, { json });
      }
    });

  group
    .command("start")
    .description("Start the automated review of a publication request, or of every one waiting")
    .argument("[dataset-id]", "Dataset ID")
    .option("--all", "Every request whose review can be started, oldest first")
    .option("--dry-run", "With --all: list what would be started and start nothing")
    .option(YES_OPTION, "With --all: do not ask before starting")
    .option("--json", "Output JSON instead of text")
    .addHelpText(
      "after",
      `
Description:
  Start the review of the request's current screened commit, or start again one
  that was declined, ended in an error, never reported or is past its deadline.
  A review that is running or has reported is not started again. The review runs
  in the background; read it with 'nemar admin publish show <dataset-id>'.

  The review needs a screen result to read, so a request whose identifier screen
  has not reported is not startable until it has. The Worker also refuses a
  request that is not waiting for its decision, and one the other environment's
  Worker owns.

  --all lists the requests the Worker offers a start for (oldest first), asks
  before spending (--yes skips that), and starts them one at a time. Each is one
  model call, and the platform allows ${PLATFORM_DAILY_CAP} in any 24 hours: when that is
  spent the run stops and says how many were not tried. A piped command with no
  --yes is cancelled, and so is one with --json, which keeps standard output for
  the one document.

Exit status:
  0 when the review is going or already exists (a start, a review that is running
  or has reported); 1 for everything else: any other refusal, a Worker that could
  not hand the review over, and for --all, a cancelled run or any request that was
  not started, failed or was not tried.

Examples:
  $ nemar admin publish start nm000480
  $ nemar admin publish start --all --dry-run
  $ nemar admin publish start --all --yes`,
    )
    .action(
      async (
        datasetArg: string | undefined,
        options: { all?: boolean; dryRun?: boolean; yes?: boolean; json?: boolean },
      ) => {
        const json = options.json === true;
        if (!requireSignedIn(json)) return;
        if (options.all) {
          if (datasetArg !== undefined) {
            failMessage("Give either a dataset id or --all, not both.", { json, answered: true });
            return;
          }
          await startAll({ dryRun: options.dryRun, yes: options.yes, json });
          return;
        }
        if (datasetArg === undefined) {
          failMessage("Give a dataset id, or --all.", {
            json,
            answered: true,
            hint: "nemar admin publish start nm000480",
          });
          return;
        }
        if (options.dryRun) {
          failMessage("--dry-run goes with --all.", { json, answered: true });
          return;
        }
        const datasetId = checkedDatasetId(datasetArg, json);
        if (datasetId === null) return;
        await startOne(datasetId, json);
      },
    );
}

// ---------------------------------------------------------------------------------------------
// One start
// ---------------------------------------------------------------------------------------------

/** What a start came to, from the answer the Worker made. */
type StartAnswer =
  /** HTTP 202: a run is going, or already stands. */
  | { kind: "started"; body: StartedPublicationReview }
  /** HTTP 409 `running` or `has_result`: the review exists. */
  | { kind: "has_review"; word: string; sentence: string; body: unknown }
  /** Any other HTTP 409: the request cannot be started as it stands. */
  | { kind: "not_started"; word: string; sentence: string; platformLimit: boolean }
  /** Everything else: the Worker could not hand the review over, a fault, no request, no network. */
  | { kind: "failed"; error: unknown; word: string | undefined; sentence: string };

/** The Worker's sentence for a refusal: the body's `error`, which `ApiError.message` carries. */
function sentenceOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const body = error.rawBody;
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      const sentence = (body as Record<string, unknown>).error;
      if (typeof sentence === "string") return plain(sentence);
    }
    return plain(error.message);
  }
  return fallback;
}

/**
 * Ask the Worker to start the review of one dataset and sort what it said. The sort is the exit
 * code's: a review that is going or exists is an answer of success, every other word is a start
 * that did not happen, and a script has to be able to tell.
 */
async function attemptStart(datasetId: string): Promise<StartAnswer> {
  try {
    return { kind: "started", body: await startPublicationReview(datasetId) };
  } catch (error) {
    const word = reviewErrorCode(error);
    const sentence = sentenceOf(error, "The review could not be started.");
    if (error instanceof ApiError && error.statusCode === 409 && word !== undefined) {
      if (word === "running" || word === "has_result") {
        return { kind: "has_review", word, sentence, body: error.rawBody };
      }
      return { kind: "not_started", word, sentence, platformLimit: word === "platform_limit" };
    }
    return { kind: "failed", error, word, sentence };
  }
}

/** The sentence with the closed word behind it: `A review of this commit is running. (running)`. */
const withWord = (sentence: string, word: string | undefined): string =>
  word === undefined ? sentence : `${sentence} (${plain(word)})`;

async function startOne(datasetId: string, json: boolean): Promise<void> {
  const spinner = json ? null : ora("Starting the review...").start();
  const answer = await attemptStart(datasetId);
  spinner?.stop();
  switch (answer.kind) {
    case "started": {
      if (json) {
        console.log(JSON.stringify(answer.body, null, 2));
        return;
      }
      console.log(chalk.green(startedSentence(answer.body.reason, datasetId)));
      console.log(chalk.dim(`  nemar admin publish show ${datasetId}   read it when it reports`));
      if (answer.body.environment !== "production") {
        console.log(chalk.yellow(`  ${NON_PRODUCTION_NOTE}`));
      }
      return;
    }
    case "has_review":
      // The review exists, which is what was asked for: said, and not a failure.
      if (json) console.log(JSON.stringify(answer.body, null, 2));
      else console.log(chalk.yellow(withWord(`${datasetId}: ${answer.sentence}`, answer.word)));
      return;
    case "not_started":
      failMessage(withWord(`${datasetId}: ${answer.sentence}`, answer.word), {
        json,
        answered: true,
      });
      return;
    case "failed":
      if (answer.word !== undefined) {
        failMessage(withWord(`${datasetId}: ${answer.sentence}`, answer.word), {
          json,
          answered: isAnswered(answer.error),
          hint:
            answer.error instanceof ApiError && answer.error.statusCode === 403
              ? "This command requires admin privileges"
              : undefined,
        });
      } else {
        failWith(answer.error, null, "Could not start the review", undefined, { json });
      }
      return;
  }
}

// ---------------------------------------------------------------------------------------------
// start --all
// ---------------------------------------------------------------------------------------------

/** What one request of a `--all` run came to, in the JSON too. */
interface StartResult {
  dataset_id: string;
  outcome: "started" | "already_has_review" | "not_started" | "failed";
  /** The Worker's closed word: the start's reason, or the refusal's code. */
  reason: string | null;
  review_id: number | null;
  message: string | null;
}

const reasonCodes = (row: Row): string[] => (row.publication_review?.reasons ?? []).map(plain);

async function startAll(options: {
  dryRun?: boolean;
  yes?: boolean;
  json: boolean;
}): Promise<void> {
  const { json } = options;
  const spinner = json ? null : ora("Reading the publication requests...").start();
  let rows: Row[];
  try {
    rows = (await listPublishRequests("requested")).requests;
    spinner?.stop();
  } catch (error) {
    failWith(error, spinner, "Could not read the publication requests", undefined, { json });
    return;
  }
  // The review is off, or this Worker is older than the review: nothing to ask about, and saying
  // "nothing to start" would hide why.
  if (rows.length > 0 && rows.every((r) => r.publication_review?.enabled === false)) {
    failMessage("The automated review is off on this Worker, so nothing was started.", {
      json,
      answered: true,
    });
    return;
  }
  if (rows.length > 0 && rows.every((r) => r.publication_review === undefined)) {
    failMessage(
      "This Worker does not report the publication review (it is older than the review), so nothing was started.",
      { json, answered: true },
    );
    return;
  }

  const candidates = startAllCandidates(rows);
  if (!json) {
    console.log();
    if (candidates.length === 0) {
      console.log("Nothing to start: no request is waiting for a review that can be started.");
    } else {
      console.log(
        chalk.bold(
          `${candidates.length} request${candidates.length === 1 ? "" : "s"} whose review can be started (oldest first)`,
        ),
      );
      const width = Math.max(...candidates.map((r) => plain(r.requested_by_username).length));
      for (const r of candidates) {
        console.log(
          `  ${plain(r.dataset_id)}  ${plain(r.requested_by_username).padEnd(width)}  ${chalk.dim(reasonCodes(r).join(", "))}`,
        );
      }
    }
  }
  if (options.dryRun) {
    if (json) {
      const would = candidates.map((r) => ({
        dataset_id: r.dataset_id,
        requested_by: r.requested_by_username,
        reasons: r.publication_review?.reasons ?? [],
      }));
      console.log(JSON.stringify({ dry_run: true, would_start: would }, null, 2));
    } else if (candidates.length > 0) {
      console.log(chalk.dim("\nThis was a dry run: nothing was started."));
    }
    return;
  }
  if (candidates.length === 0) {
    if (json) console.log(JSON.stringify(summaryDocument([], 0), null, 2));
    return;
  }

  if (!json) console.log();
  const n = candidates.length;
  // `inquirer` writes its question to standard output, which `--json` keeps for the one document a
  // pipe reads, so under `--json` the question is not asked, at a terminal or not: the same refusal
  // as a command with no terminal to ask on.
  let go: ConfirmResult;
  if (json && !options.yes) {
    console.error(
      "--json cannot ask for a confirmation, which would be written to standard output; pass --yes, or --dry-run to see what would start.",
    );
    go = "cancelled";
  } else {
    go = await confirm(
      `Start the automated review of ${n} request${n === 1 ? "" : "s"}? Each is one model call, and the platform allows ${PLATFORM_DAILY_CAP} in any 24 hours.`,
      { yes: options.yes },
    );
  }
  if (go !== "confirmed") {
    // Nothing was started, and a script that asked for it has to be able to tell. Not on standard
    // output under --json, which is read as one document.
    failMessage("Cancelled.", { json, answered: true });
    return;
  }

  const results: StartResult[] = [];
  let notTried = 0;
  let unexplained = false;
  let environment = "production";
  for (let i = 0; i < candidates.length; i++) {
    const id = candidates[i].dataset_id;
    const answer = await attemptStart(id);
    const result = resultOf(id, answer);
    results.push(result);
    if (answer.kind === "started") environment = answer.body.environment;
    if (answer.kind === "failed" && !isAnswered(answer.error)) unexplained = true;
    if (!json) console.log(`  ${plain(id)}  ${resultText(answer)}`);
    if (answer.kind === "not_started" && answer.platformLimit) {
      // The allowance is the platform's, so every start after this one would be declined the same
      // way (and each decline writes a row): the rest are not asked.
      notTried = candidates.length - (i + 1);
      break;
    }
  }

  const doc = summaryDocument(results, notTried);
  if (json) {
    console.log(JSON.stringify(doc, null, 2));
  } else {
    console.log();
    console.log(
      `${doc.started} started, ${doc.already_had_review} already had a review, ${doc.not_started} not started, ${doc.failed} failed`,
    );
    if (notTried > 0) {
      console.log(
        chalk.yellow(
          `Stopped: the platform's allowance for the last 24 hours is spent, so ${notTried} ${notTried === 1 ? "was" : "were"} not tried.`,
        ),
      );
    }
    if (environment !== "production") console.log(chalk.yellow(`  ${NON_PRODUCTION_NOTE}`));
  }
  if (doc.failed > 0 || doc.not_started > 0 || notTried > 0) {
    process.exitCode = 1;
    // The summary above is the answer, unless a start failed in a way that may be a bug.
    if (!unexplained) markReportedExit();
  }
}

function resultOf(datasetId: string, answer: StartAnswer): StartResult {
  switch (answer.kind) {
    case "started":
      return {
        dataset_id: datasetId,
        outcome: "started",
        reason: answer.body.reason,
        review_id: answer.body.review_id,
        message: null,
      };
    case "has_review":
      return {
        dataset_id: datasetId,
        outcome: "already_has_review",
        reason: answer.word,
        review_id: null,
        message: answer.sentence,
      };
    case "not_started":
      return {
        dataset_id: datasetId,
        outcome: "not_started",
        reason: answer.word,
        review_id: null,
        message: answer.sentence,
      };
    case "failed":
      return {
        dataset_id: datasetId,
        outcome: "failed",
        reason: answer.word ?? null,
        review_id: null,
        message: answer.sentence,
      };
  }
}

/** What a `--all` run prints beside a request: the outcome and, when it is a refusal, why. */
function resultText(answer: StartAnswer): string {
  switch (answer.kind) {
    case "started":
      return chalk.green(
        answer.body.reason === "redispatched"
          ? "started again"
          : answer.body.reason === "dispatch_claimed"
            ? "already handed over, and stands"
            : "started",
      );
    case "has_review":
      return chalk.yellow(`already has a review (${plain(answer.word)})`);
    case "not_started":
      return chalk.yellow(`not started: ${withWord(answer.sentence, answer.word)}`);
    case "failed":
      return chalk.red(`failed: ${withWord(answer.sentence, answer.word)}`);
  }
}

function summaryDocument(results: StartResult[], notTried: number) {
  const count = (outcome: StartResult["outcome"]) =>
    results.filter((r) => r.outcome === outcome).length;
  return {
    results,
    started: count("started"),
    already_had_review: count("already_has_review"),
    not_started: count("not_started"),
    failed: count("failed"),
    not_tried: notTried,
  };
}
