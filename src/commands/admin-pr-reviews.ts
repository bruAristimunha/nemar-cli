/**
 * `nemar admin pr-reviews`: one place to see and manage the open dataset pull requests and the
 * automated review of each (ADR 0093, following ADR 0092).
 *
 *   nemar admin pr-reviews [list]            open pull requests to main, with the automated review
 *   nemar admin pr-reviews next              go through them one at a time: y / n / c
 *   nemar admin pr-reviews show <ds> <pr>    the stored report, in the pull-request comment's words
 *   nemar admin pr-reviews start <ds> <pr>   review a pull request that is already open
 *   nemar admin pr-reviews start --all       every open pull request waiting for a review
 *   nemar admin pr-reviews approve <ds> <pr> approve as YOU, with your own GitHub login
 *   nemar admin pr-reviews allow|block|clear <login>   who the automated review is spent on
 *   nemar admin pr-reviews standing <login>  a contributor's record and what it means
 *
 * The list, the report and the contributor controls come from the NEMAR API. The approval does
 * not: it is made from this machine with your own GitHub token (see `lib/pr-review-approve.ts`).
 */

import chalk from "chalk";
import { Command } from "commander";
import ora, { type Ora } from "ora";
import {
  type CheckState,
  type ContributorStanding,
  type PrReviewDetail,
  QUEUE_VERDICTS,
  type QueueEntry,
  type QueueResponse,
  type QueueVerdict,
  type ReadVerdict,
  type StartReviewResponse,
} from "../../shared/contract/pr-review-admin.js";
import {
  type ReviewOutcome,
  factsOf,
  findingLines,
  renderCheck,
  verdictOf,
} from "../../shared/pr-review.js";
import {
  clearPrReviewAuthor,
  getPrReview,
  getPrReviewAuthor,
  listPrReviews,
  setPrReviewAuthor,
  startPrReview,
} from "../lib/api/admin.js";
import { getCurrentUser } from "../lib/api/auth.js";
import { ApiError, errorDetail } from "../lib/api/errors.js";
import { openInBrowser } from "../lib/browser.js";
import { isAuthenticated } from "../lib/config.js";
import { confirm } from "../lib/confirm.js";
import { dlog, markReportedExit } from "../lib/debug-log.js";
import {
  type ApprovalGate,
  MERGE_METHODS,
  type MergeMethod,
  type PullRequestFacts,
  type WriteResult,
  adminGitHubToken,
  approvalGate,
  closePullRequest,
  fetchPullRequest,
  githubApiBase,
  identityMatches,
  manualApprovalCommand,
  mergeWhenClean,
  postComment,
  pullRequestUrl,
  refusalFor,
  reviewForApproval,
  submitApproval,
  whoAmI,
} from "../lib/pr-review-approve.js";
import { approveAllowed, parseChoice } from "../lib/pr-review-next.js";
import { LineReader } from "../lib/prompt-lines.js";

const DATASET_ID_RE = /^(nm|xx|on)\d{6}$/;
/** The Worker keeps this much of a reason; a longer one is refused here rather than cut without a word. */
const MAX_REASON = 200;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

// ---------------------------------------------------------------------------------------------
// Plain, safe, aligned text
// ---------------------------------------------------------------------------------------------

/**
 * Text that came from the network, made safe for a terminal: control characters (an ESC sequence
 * can rewrite the screen), zero-width and bidirectional-override characters are removed. The
 * server already reduces author-controlled text to plain words; this is the second line, because a
 * terminal should not depend on a server's hygiene alone.
 */
export function plain(s: unknown): string {
  return typeof s === "string" ? s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "") : "";
}

function clip(s: string, max: number): string {
  const p = plain(s);
  return p.length > max ? `${p.slice(0, max - 1)}…` : p;
}

/** How long ago, in the unit that reads best: `12m`, `5h`, `9d`. */
export function ageOf(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "?";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const DETAIL_WORDS: Record<string, string> = {
  contributor_paused: "contributor paused",
  rate_limited: "rate limited",
  daily_limit: "daily limit",
  unreported: "never reported",
};

function detailWord(detail: string): string {
  return DETAIL_WORDS[detail] ?? plain(detail).replaceAll("_", " ");
}

const VERDICT_WORD: Record<QueueVerdict, string> = {
  pass: "pass",
  fail: "fail",
  uncertain: "uncertain",
  not_reviewed: "not reviewed",
  in_progress: "in progress",
  could_not_decide: "could not decide",
};

/** A verdict as a word. One a newer server invents is shown as itself, never as a pass. */
function verdictWord(v: string): string {
  return VERDICT_WORD[v as QueueVerdict] ?? plain(v).replaceAll("_", " ");
}

function verdictColor(v: string): (s: string) => string {
  switch (v) {
    case "pass":
      return chalk.green;
    case "fail":
      return chalk.red;
    case "uncertain":
    case "could_not_decide":
      return chalk.yellow;
    case "in_progress":
      return chalk.cyan;
    case "not_reviewed":
      return chalk.dim;
    default:
      return chalk.yellow;
  }
}

/** The verdict as a person reads it, with the closed word behind it when there is one. */
export function verdictText(e: Pick<QueueEntry, "verdict" | "detail" | "review_current">): string {
  const word = verdictWord(e.verdict);
  if (e.verdict === "not_reviewed" && e.review_current === false) {
    return `${word} (other commit)`;
  }
  return e.detail ? `${word} (${detailWord(e.detail)})` : word;
}

const CHECK_WORD: Record<CheckState, [string, (s: string) => string]> = {
  pass: ["ok", chalk.green],
  fail: ["FAIL", chalk.red],
  pending: ["pending", chalk.yellow],
  missing: ["none", chalk.yellow],
  unknown: ["?", chalk.yellow],
};

function checkCell(state: string, width: number): string {
  const [word, color] = CHECK_WORD[state as CheckState] ?? ["?", chalk.yellow];
  return color(word.padEnd(width));
}

/** The list, one pull request per line, with a header. Pure, so it is tested without a server. */
export function renderQueue(entries: QueueEntry[], now: number = Date.now()): string[] {
  if (entries.length === 0) return [];
  const rows = entries.map((e) => ({
    e,
    mark: e.needs_you ? "*" : " ",
    ds: plain(e.dataset_id),
    pr: `#${plain(String(e.pr_number))}`,
    author: clip(e.author_login, 20),
    from: clip(e.from_fork ? `fork ${e.head_label}` : `branch ${e.head_label}`, 34),
    verdict: clip(`${verdictText(e)}${e.draft ? " [draft]" : ""}`, 40),
    age: ageOf(e.created_at, now),
  }));
  const w = (f: (r: (typeof rows)[number]) => string, min: number) =>
    Math.max(min, ...rows.map((r) => f(r).length));
  const wPr = w((r) => r.pr, 3);
  const wAuthor = w((r) => r.author, 6);
  const wFrom = w((r) => r.from, 4);
  const wVerdict = w((r) => r.verdict, 7);
  const wAge = w((r) => r.age, 3);
  const header = chalk.dim(
    `  ${"DATASET".padEnd(8)}  ${"PR".padStart(wPr)}  ${"AUTHOR".padEnd(wAuthor)}  ${"FROM".padEnd(wFrom)}  ${"REVIEW".padEnd(wVerdict)}  ${"BIDS".padEnd(7)}  ${"VERSION".padEnd(7)}  ${"AGE".padStart(wAge)}  LINK`,
  );
  const lines = rows.map(
    (r) =>
      `${r.e.needs_you ? chalk.bold.cyan(r.mark) : r.mark} ${r.ds.padEnd(8)}  ${r.pr.padStart(wPr)}  ${r.author.padEnd(wAuthor)}  ${chalk.dim(r.from.padEnd(wFrom))}  ${verdictColor(r.e.verdict)(r.verdict.padEnd(wVerdict))}  ${checkCell(r.e.bids, 7)}  ${checkCell(r.e.version, 7)}  ${r.age.padStart(wAge)}  ${plain(r.e.url)}`,
  );
  return [header, ...lines];
}

/**
 * Markdown from the shared renderer, as terminal text: the same words, no HTML wrapper. Control
 * characters are removed one LINE at a time, because a newline is itself a control character and
 * stripping it from the whole text would run the report together.
 */
export function terminalize(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) =>
      plain(line.replace(/\s+$/, ""))
        .replace(/<\/?details>/g, "")
        .replace(/<summary>(.*?)<\/summary>/g, "$1")
        .replace(/^### (.*)$/, (_, t: string) => chalk.bold(t))
        .replace(/\*\*(.+?)\*\*/g, (_, t: string) => chalk.bold(t)),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A stored outcome as the report a person reads: the shared renderer's words. A server newer than
 * this CLI can send an outcome this version cannot render; that is said, not a stack trace.
 */
export function reportLines(outcome: ReviewOutcome): string[] {
  try {
    const r = renderCheck(outcome);
    return [chalk.bold(plain(r.title)), "", terminalize(r.summary), "", terminalize(r.text)];
  } catch (err) {
    dlog(`pr-reviews: the stored report could not be rendered (${errorDetail(err)})`);
    return [
      chalk.yellow(
        "The stored report could not be rendered by this version of the CLI. Update it, or read the review on the pull request.",
      ),
    ];
  }
}

/** `Version:  1.0.0 to 1.1.0   revision advances: yes`, from the review's own evidence and answer. */
function versionLine(report: Extract<ReviewOutcome, { kind: "reported" }>["report"]): string {
  const { version_before: before, version_after: after } = report.evidence;
  const advances = factsOf(report).criteria.advances_revision;
  const word =
    advances === "pass"
      ? chalk.green("revision advances: yes")
      : advances === "fail"
        ? chalk.red("revision advances: NO")
        : chalk.yellow("revision advances: unknown");
  return `Version:  ${plain(before ?? "unknown")} to ${plain(after ?? "unknown")}   ${word}`;
}

/**
 * The stored report as the short read `next` shows: the headline, the reviewer's sentence, whether
 * the version went up, and the findings when there are any. The whole report is `d`. Nothing for a
 * review that is not of this commit (`null`): another commit's report is not a statement about
 * this one.
 */
export function briefLines(outcome: unknown): string[] {
  if (outcome === null || outcome === undefined) return [];
  try {
    const o = outcome as ReviewOutcome;
    const r = renderCheck(o);
    if (o.kind !== "reported") return [chalk.bold(plain(r.title)), plain(r.summary)];
    const lines = [chalk.bold(plain(r.title))];
    if (o.report.summary) lines.push(plain(o.report.summary));
    lines.push(versionLine(o.report));
    const findings = findingLines(o.report);
    if (findings.length > 0) lines.push(chalk.bold("Findings:"), ...findings.map(terminalize));
    return lines;
  } catch (err) {
    dlog(`pr-reviews: the stored report could not be rendered (${errorDetail(err)})`);
    return [
      chalk.yellow(
        "The stored report could not be rendered by this version of the CLI. Update it, or read the review on the pull request.",
      ),
    ];
  }
}

// ---------------------------------------------------------------------------------------------
// Contributor standing
// ---------------------------------------------------------------------------------------------

/** One decimal, so 10.2% is not shown as the "10%" it is said to exceed. */
function percent(rejected: number, decided: number): string {
  return decided > 0 ? `${((rejected / decided) * 100).toFixed(1)}%` : "0%";
}

export function standingLines(s: ContributorStanding): string[] {
  const out: string[] = [];
  out.push(
    `${chalk.bold(plain(s.login))} ${chalk.dim(`(GitHub id ${plain(String(s.author_id))}${s.resolved_from === "history" ? ", from the Worker's records because GitHub was not asked or could not say" : ""})`)}`,
  );
  const { rejected, decided } = s.tally;
  out.push(
    `  Record:    ${rejected} of ${decided} decided pull request${decided === 1 ? "" : "s"} rejected${decided > 0 ? ` (${percent(rejected, decided)})` : ""}`,
  );
  out.push(
    chalk.dim(
      `             reviews pause when MORE than ${s.thresholds.rejected_more_than} are rejected AND more than ${s.thresholds.percent_more_than}% of the decided ones`,
    ),
  );
  if (s.override) {
    const by = s.override.set_by ? ` by ${plain(s.override.set_by)}` : "";
    out.push(
      `  Decision:  ${s.override.mode === "allow" ? chalk.green("allowed") : chalk.red("blocked")}${by} on ${plain(s.override.set_at)}${s.override.reason ? `: ${plain(s.override.reason)}` : ""}`,
    );
    if (s.override.mode === "allow" && s.by_record.paused) {
      out.push(chalk.dim("             the record alone would pause them; the decision wins"));
    }
  } else {
    out.push("  Decision:  none, the record decides");
  }
  out.push(
    `  Standing:  ${
      s.standing.paused
        ? chalk.red(
            s.standing.because === "maintainer"
              ? "paused by a maintainer: their pull requests need a person"
              : "paused by the record: their pull requests need a person",
          )
        : chalk.green("not paused: reviewed automatically, within the rate limits")
    }`,
  );
  if (s.recent.length > 0) {
    out.push(
      `  Recent:    ${s.recent
        .map(
          (r) =>
            `${plain(r.dataset_id)}#${plain(String(r.pr_number))} ${r.verdict === "fail" ? chalk.red("fail") : chalk.green("pass")}`,
        )
        .join(", ")}`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Shared command plumbing
// ---------------------------------------------------------------------------------------------

function requireAuth(json?: boolean): boolean {
  if (!isAuthenticated()) {
    const out = say(json);
    out(chalk.red("Error: Not authenticated"));
    out(chalk.dim("  Run 'nemar auth login' first"));
    return false;
  }
  return true;
}

/** Where an error goes: stderr when the caller asked for JSON, so stdout stays machine-readable. */
function say(json: boolean | undefined): (line: string) => void {
  return json ? (line) => console.error(line) : (line) => console.log(line);
}

function die(message: string, hint?: string, json?: boolean): never {
  const out = say(json);
  out(chalk.red(message));
  if (hint) out(chalk.dim(`  ${hint}`));
  process.exit(1);
}

/** The closed error word a NEMAR route answered with (`code`), not the sentence in `error`. */
function errorWord(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const body = err.rawBody as { code?: unknown } | undefined;
  return typeof body?.code === "string" ? body.code : undefined;
}

function failApi(err: unknown, spinner: Ora | null, fallback: string, json?: boolean): never {
  const message = err instanceof ApiError ? plain(err.message) : fallback;
  const out = say(json);
  if (spinner) spinner.fail(message);
  else out(chalk.red(message));
  if (err instanceof ApiError) {
    if (err.statusCode === 403) out(chalk.dim("  This command requires admin privileges"));
  } else {
    out(chalk.dim(`  Error details: ${errorDetail(err)}`));
  }
  process.exit(1);
}

function checkDataset(id: string, json?: boolean): string {
  if (!DATASET_ID_RE.test(id))
    die(`"${plain(id)}" is not a dataset id (like nm000108).`, undefined, json);
  return id;
}

function checkPr(raw: string, json?: boolean): number {
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n <= 0) {
    die(`"${plain(raw)}" is not a pull request number.`, undefined, json);
  }
  return n;
}

function checkLogin(raw: string, json?: boolean): string {
  const login = raw.replace(/^@/, "");
  if (!LOGIN_RE.test(login)) die(`"${plain(raw)}" is not a GitHub login.`, undefined, json);
  return login;
}

function envNote(environment: string): void {
  if (environment !== "production") {
    console.log(
      chalk.yellow(
        "  This is the non-production Worker. It holds its own record and answers only for the datasets it owns; it does not change what production reviews.",
      ),
    );
  }
}

function short(sha: string): string {
  return plain(sha).slice(0, 7);
}

// ---------------------------------------------------------------------------------------------
// The command group
// ---------------------------------------------------------------------------------------------

export const prReviewsCommand = new Command("pr-reviews")
  .description("Open dataset pull requests to main, with the automated review of each (ADR 0093)")
  .addHelpText(
    "after",
    `
One place for every open pull request to main in nemarDatasets. Run with no subcommand to list, or
'next' to go through the ones that need you one at a time (y approves and squash-merges, n closes
with a comment, c comments).

REVIEW column (the automated review of the pull request's CURRENT commit):
  pass              nothing lost, the revision advances, the dataset is materially better
  fail              the review found a problem; the author needs to change something
  uncertain         the review could not decide whether it is a good change
  not reviewed      no review of this commit is on record: the review is off, the contributor is
                    paused or rate limited, or the review on record is of another commit (shown
                    as "other commit")
  in progress       the review is running
  could not decide  the review ended without a verdict (an error, or it never reported)
A verdict is never carried over to a commit it did not read. '*' marks the pull requests you can
act on now: a pass to approve, or one nobody has decided for you (drafts are never marked).

APPROVING is YOUR act, made with your own GitHub login from this machine, never as the NEMAR
App. It uses GH_TOKEN if set, otherwise the token 'gh' holds, checks it belongs to a person and to
the GitHub account linked to your NEMAR account (if one is linked), and approves the exact commit
you were shown. It asks before approving unless you add --yes. A failing review, a running one, or
one that could not be read needs --force. Nothing merges unless you add --merge (or answer y in
'next'), and then it is attempted once, only if GitHub reports the pull request clean; it never
tries a merge GitHub reports as blocked. If 'gh' holds no signed-in account, or the token is an app or workflow token,
'approve' prints the PR link and the equivalent 'gh pr review --approve' command (and, in a
terminal, opens the link); a token GitHub rejects is reported without it.

The list comes from GitHub's search index, which can lag behind a new pull request.
`,
  );

/** What makes a queue possibly not the whole queue (the two causes the Worker can name). */
function incompleteLines(q: QueueResponse): string[] {
  const out: string[] = [];
  if (q.truncated) {
    out.push(
      chalk.yellow(
        "  GitHub's search returned fewer pull requests than exist, so this list is incomplete.",
      ),
    );
  }
  if (q.skipped.unreadable > 0) {
    out.push(
      chalk.yellow(
        `  ${q.skipped.unreadable} search result(s) could not be read as pull requests and are not listed.`,
      ),
    );
  }
  return out;
}

function collectVerdicts(value: string, previous: string[]): string[] {
  return [
    ...previous,
    ...value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  ];
}

// -- list ---------------------------------------------------------------------------------------

prReviewsCommand
  .command("list", { isDefault: true })
  .description(
    "List open pull requests to main with the automated review of each one's current commit (default)",
  )
  .option(
    "--verdict <verdict>",
    `Only these verdicts, comma separated or repeated: ${QUEUE_VERDICTS.join(", ").replaceAll("_", "-")}`,
    collectVerdicts,
    [] as string[],
  )
  .option("--dataset <id>", "Only this dataset")
  .option("--author <login>", "Only pull requests opened by this GitHub login")
  .option("--needs-me", "Only what you can act on: passes, and anything a person must decide")
  .option("--json", "Output the raw JSON instead of the table")
  .action(
    async (options: {
      verdict: string[];
      dataset?: string;
      author?: string;
      needsMe?: boolean;
      json?: boolean;
    }) => {
      if (!requireAuth(options.json)) process.exit(1);
      const verdicts = options.verdict.map((v) => v.toLowerCase().replaceAll("-", "_"));
      for (const v of verdicts) {
        if (!(QUEUE_VERDICTS as readonly string[]).includes(v)) {
          die(
            `"${plain(v)}" is not a verdict.`,
            `Use: ${QUEUE_VERDICTS.join(", ").replaceAll("_", "-")}`,
            options.json,
          );
        }
      }
      const dataset = options.dataset ? checkDataset(options.dataset, options.json) : undefined;
      const author = options.author ? checkLogin(options.author, options.json) : undefined;

      const spinner = options.json ? null : ora("Reading open pull requests...").start();
      let q: QueueResponse;
      try {
        q = await listPrReviews({ verdicts, dataset, author, needsMe: options.needsMe });
        spinner?.stop();
      } catch (err) {
        failApi(err, spinner, "Could not read the pull-request queue", options.json);
      }
      if (options.json) {
        console.log(JSON.stringify(q, null, 2));
        // stdout stays the JSON; a count taken from it alone must not look complete when it is not.
        for (const l of incompleteLines(q)) console.error(l);
        return;
      }

      const lines = renderQueue(q.entries);
      // Anything that means this list may not be the whole queue.
      const incomplete = q.truncated || q.skipped.unreadable > 0 || q.skipped.not_owned_here > 0;
      console.log();
      if (lines.length === 0) {
        console.log(
          q.total_open === 0
            ? incomplete
              ? chalk.yellow("No open pull requests found in what this Worker can see.")
              : chalk.green("No open pull requests to main.")
            : chalk.yellow(`No pull requests match (${q.total_open} open in all).`),
        );
      } else {
        for (const l of lines) console.log(l);
      }
      const needMe = q.entries.filter((e) => e.needs_you).length;
      const shown =
        q.entries.length === q.total_open
          ? `${q.total_open} open`
          : `${q.entries.length} of ${q.total_open} open`;
      console.log();
      console.log(
        `${shown} pull request${q.total_open === 1 ? "" : "s"}, ${chalk.bold(String(needMe))} you can act on.`,
      );
      for (const l of incompleteLines(q)) console.log(l);
      if (!q.review_enabled) {
        console.log(
          chalk.dim(
            "  The automated review is off in this environment (PR_REVIEW_ENABLED), so pull requests with no stored review show as not reviewed.",
          ),
        );
      }
      if (q.skipped.not_owned_here > 0) {
        console.log(
          chalk.dim(
            `  ${q.skipped.not_owned_here} pull request(s) belong to the other environment's Worker and are not listed.`,
          ),
        );
      }
      if (q.skipped.not_a_dataset > 0) {
        console.log(
          chalk.dim(
            `  ${q.skipped.not_a_dataset} pull request(s) in non-dataset repositories ignored.`,
          ),
        );
      }
      envNote(q.environment);
      if (lines.length > 0) {
        console.log(
          chalk.dim(
            "  nemar admin pr-reviews next                    go through them one at a time\n  nemar admin pr-reviews show <dataset> <pr>     read the review\n  nemar admin pr-reviews approve <dataset> <pr>  approve it as yourself",
          ),
        );
      }
    },
  );

// -- show ---------------------------------------------------------------------------------------

prReviewsCommand
  .command("show <dataset> <pr>")
  .description("Show the stored automated review of a pull request, in the words of its PR comment")
  .option("--json", "Output the raw JSON instead of the report")
  .action(async (datasetArg: string, prArg: string, options: { json?: boolean }) => {
    if (!requireAuth(options.json)) process.exit(1);
    const dataset = checkDataset(datasetArg, options.json);
    const pr = checkPr(prArg, options.json);
    const spinner = options.json ? null : ora("Reading the review...").start();
    let d: PrReviewDetail;
    try {
      d = await getPrReview(dataset, pr);
      spinner?.stop();
    } catch (err) {
      failApi(err, spinner, "Could not read the review", options.json);
    }
    if (options.json) {
      console.log(JSON.stringify(d, null, 2));
      return;
    }

    console.log();
    console.log(`${chalk.bold(`${dataset} #${pr}`)}  ${chalk.dim(pullRequestUrl(dataset, pr))}`);
    if (d.live) {
      const state = d.live.draft && d.live.state === "open" ? "open, draft" : d.live.state;
      console.log(
        `  Author:    ${plain(d.live.author_login)} (${d.live.from_fork ? "fork " : "branch "}${plain(d.live.head_label)})`,
      );
      console.log(`  State:     ${plain(state)}, now at ${short(d.live.head_sha)}`);
    } else if (d.live_status === "missing") {
      console.log(chalk.yellow("  GitHub says this pull request does not exist."));
    } else {
      console.log(
        chalk.yellow("  GitHub could not be read, so the pull request's state is unknown."),
      );
    }
    console.log();

    const color = verdictColor(d.verdict);
    if (!d.review) {
      console.log(`  Review:    ${color("not reviewed")}`);
      console.log(
        chalk.dim(
          d.review_enabled
            ? "             No automated review has been recorded for this pull request."
            : "             The automated review is off in this environment (PR_REVIEW_ENABLED), and none was recorded.",
        ),
      );
    } else {
      const reviewed = short(d.review.head_sha);
      if (d.review_current === null) {
        // GitHub could not be read, so there is no current commit to compare with.
        console.log(
          `  Review:    ${chalk.yellow(`${verdictWord(d.review.verdict)} on ${reviewed}`)} ${chalk.yellow("(whether that is the current commit is unknown: GitHub gave no current commit)")}`,
        );
      } else {
        const which =
          d.review_current === false
            ? chalk.yellow(
                `of ${reviewed}, a DIFFERENT commit (the pull request is now at ${short(d.head_sha ?? "")})`,
              )
            : `of ${reviewed}`;
        console.log(
          `  Review:    ${color(verdictText({ verdict: d.verdict, detail: d.detail, review_current: d.review_current }))} ${chalk.dim(which)}`,
        );
        if (d.review_current === false) {
          console.log(
            chalk.dim(
              `             That review said ${verdictWord(d.review.verdict)}, and it does not apply to the current commit.`,
            ),
          );
        }
      }
      console.log();
      if (d.review.outcome === null) {
        console.log(
          d.review.verdict === "in_progress"
            ? "The review is still running. It will update the pull request's check when it finishes."
            : `No report has arrived for this review (it was handed to GitHub on ${plain(d.review.created_at)}). Review the pull request by hand.`,
        );
      } else {
        for (const l of reportLines(d.review.outcome)) console.log(l);
      }
    }

    if (d.author) {
      console.log();
      for (const l of standingLines(d.author)) console.log(l);
    }
    if (d.history.length > 1) {
      console.log();
      console.log(chalk.bold("History"));
      for (const h of d.history) {
        console.log(
          `  ${short(h.head_sha)}  ${verdictColor(h.verdict)(verdictWord(h.verdict).padEnd(16))}  ${chalk.dim(plain(h.created_at))}`,
        );
      }
      if (d.history_truncated) console.log(chalk.dim("  (older reviews not shown)"));
    }
    envNote(d.environment);
    console.log();
  });

// -- shared by approve and next ------------------------------------------------------------------

interface AdminSession {
  token: string;
  me: { login: string; id: number };
  match: "match" | "unlinked";
}

/**
 * The administrator's own GitHub credential, checked before it is used: it must belong to a person,
 * and to the GitHub login linked to the NEMAR account when one is linked. Exits when it cannot be
 * used. With `fallback`, a missing or non-person token prints where to approve by hand first.
 */
async function adminSession(
  base: string,
  fallback?: { dataset: string; pr: number; url: string },
): Promise<AdminSession> {
  const tokenResult = await adminGitHubToken();
  if (!tokenResult.ok) {
    console.log(
      chalk.yellow(`Cannot ${fallback ? "approve" : "act"} from here: ${tokenResult.reason}`),
    );
    if (fallback) manualFallback(fallback.dataset, fallback.pr, fallback.url);
    process.exit(1);
  }
  const { token, source } = tokenResult;
  const sourceName = source === "GH_TOKEN" ? "GH_TOKEN" : "the token gh holds";

  const me = await whoAmI(token, base);
  if (!me.ok) {
    console.log(chalk.red(me.reason));
    console.log(chalk.dim(`  (the token came from ${sourceName})`));
    if (me.kind === "rejected" && source === "GH_TOKEN") {
      console.log(chalk.dim("  Unset GH_TOKEN to use the account gh is signed in as."));
    }
    if (me.kind === "not_a_person" && fallback) {
      manualFallback(fallback.dataset, fallback.pr, fallback.url);
    }
    process.exit(1);
  }
  let linked: string | null;
  try {
    linked = (await getCurrentUser()).github_username ?? null;
  } catch (err) {
    return failApi(err, null, "Could not read your NEMAR account");
  }
  const match = identityMatches(linked, me.user.login);
  if (match === "mismatch") {
    die(
      source === "GH_TOKEN"
        ? `GH_TOKEN belongs to @${me.user.login}, but your NEMAR account is linked to @${plain(linked)}.`
        : `gh is signed in as @${me.user.login}, but your NEMAR account is linked to @${plain(linked)}.`,
      source === "GH_TOKEN"
        ? "Unset GH_TOKEN, or set it to your own token. A review, comment or merge is recorded under the login that makes it."
        : "Switch with 'gh auth switch'. A review, comment or merge is recorded under the login that makes it.",
    );
  }
  return { token, me: me.user, match };
}

interface Assessment {
  live: PullRequestFacts;
  head: string;
  verdict: QueueVerdict;
  detail: string | null;
  staleVerdict: ReadVerdict | null;
  reviewCurrent: boolean | null;
  contributorNote: string | null;
  /** The stored report of THIS commit's review, for display. */
  outcome: unknown;
  /** Why the NEMAR API could not say what the review concluded, when it could not. */
  unread: string | undefined;
  gate: ApprovalGate;
}

type Stop =
  /** The pull request cannot be acted on (closed, merged, a draft, another branch). */
  | { kind: "refused"; message: string }
  /** GitHub will not show this token the pull request (404, 403): not a reason to end a run. */
  | { kind: "unreadable"; message: string }
  /** Something failed that the administrator should see; `error` runs through `failApi`. */
  | { kind: "failed"; message: string; error?: unknown };

type Assessed = { ok: true; value: Assessment } | { ok: false; stop: Stop };

/**
 * The pull request as GitHub says it is right now (through the administrator's own token) and what
 * the automated review concluded about THAT commit. The Worker is asked about the head just read,
 * so the verdict is about the commit an approval will be pinned to.
 */
async function assessPullRequest(
  token: string,
  dataset: string,
  pr: number,
  base: string,
): Promise<Assessed> {
  const live = await fetchPullRequest(token, dataset, pr, base);
  if (!live.ok) {
    const unreadable = live.status === 404 || live.status === 403;
    return {
      ok: false,
      stop: { kind: unreadable ? "unreadable" : "failed", message: live.reason },
    };
  }
  const refusal = refusalFor(live.value);
  if (refusal) return { ok: false, stop: { kind: "refused", message: refusal } };
  const head = live.value.headSha;

  let verdict: QueueVerdict = "not_reviewed";
  let detail: string | null = null;
  let staleVerdict: ReadVerdict | null = null;
  let reviewCurrent: boolean | null = null;
  let contributorNote: string | null = null;
  let outcome: unknown = null;
  let unread: string | undefined;
  try {
    const read = reviewForApproval(await getPrReview(dataset, pr, head), head);
    if (read.ok) {
      ({ verdict, detail, staleVerdict, reviewCurrent, contributorNote, outcome } = read);
    } else {
      unread = read.why;
    }
  } catch (err) {
    // Only the answers that mean "the Worker cannot say what the review found" continue, and as an
    // unknown. A 404 from a backend older than this CLI, an expired key or an edge error stops
    // here: a stored rejection could be hiding behind any of them.
    const word = errorWord(err);
    if (word === "not_owned_here" || word === "github_unavailable") {
      unread = err instanceof ApiError ? plain(err.message) : "the NEMAR API did not answer";
    } else if (word === "no_such_pull_request") {
      // Your own token just read this pull request, so the Worker's GitHub read disagrees with it.
      unread = "the NEMAR API could not find this pull request on GitHub";
    } else {
      return {
        ok: false,
        stop: { kind: "failed", message: "Could not read the automated review", error: err },
      };
    }
  }
  const gate = approvalGate({ verdict, staleVerdict, unread });
  return {
    ok: true,
    value: {
      live: live.value,
      head,
      verdict,
      detail,
      staleVerdict,
      reviewCurrent,
      contributorNote,
      outcome,
      unread,
      gate,
    },
  };
}

/** The review as one coloured cell: its verdict and reason, or "unknown" when it could not be read. */
function reviewCell(a: {
  verdict: QueueVerdict;
  detail: string | null;
  reviewCurrent: boolean | null;
  unread: string | undefined;
}): string {
  return a.unread
    ? chalk.yellow(`unknown (${plain(a.unread)})`)
    : verdictColor(a.verdict)(
        verdictText({
          verdict: a.verdict,
          detail: a.detail as QueueEntry["detail"],
          review_current: a.reviewCurrent,
        }),
      );
}

/** End the command for a stop that is not specific to one pull request in a run. */
function stopFor(assessed: { stop: Stop }): never {
  const { stop } = assessed;
  if (stop.kind === "failed" && stop.error !== undefined) {
    return failApi(stop.error, null, stop.message);
  }
  return die(stop.message);
}

// -- start --------------------------------------------------------------------------------------

/** Why a start did not start one, in the words an administrator reads. Keys are the gate's fixed words. */
const NOT_STARTED: Record<string, string> = {
  duplicate: "this commit already has a review (running or finished)",
  contributor_paused: "the contributor is paused",
  daily_limit: "the platform's daily pool of reviews is spent",
  draft: "it is a draft",
  not_open: "it is not open any more",
  not_main: "it does not target main",
  bot_author: "a bot opened it",
  dataset_not_reviewable: "the dataset is not a public, named publication",
  unknown_dataset: "NEMAR has no such dataset",
  pr_review_disabled: "the automated review is off in this environment (PR_REVIEW_ENABLED)",
  dispatch_failed: "GitHub did not accept the dispatch",
  misconfigured: "the Worker is missing a secret the review needs",
  malformed: "GitHub's record of the pull request could not be read",
};

/** A start that is a fault, not a decision: the exit code says so. */
const START_FAULTS = new Set([
  "pr_review_disabled",
  "dispatch_failed",
  "misconfigured",
  "unknown_dataset",
  "malformed",
]);

function startedWord(r: StartReviewResponse): string {
  return r.reason === "redispatched" ? "started again" : "started";
}

function notStartedText(r: StartReviewResponse): string {
  const why = NOT_STARTED[r.reason] ?? plain(r.reason).replaceAll("_", " ");
  const hint =
    r.reason === "contributor_paused" && r.author_login
      ? ` (lift it with: nemar admin pr-reviews allow ${plain(r.author_login)})`
      : "";
  return `not started: ${why}${hint}`;
}

prReviewsCommand
  .command("start [dataset] [pr]")
  .description(
    "Review a pull request that is already open, or start again one whose review ended without a verdict",
  )
  .option(
    "--all",
    "Every open pull request whose current commit has no review, or one that was declined or ended without a verdict",
  )
  .option("--dry-run", "With --all: list what would be started and start nothing")
  .option("-y, --yes", "With --all: do not ask before starting")
  .option("--json", "Output JSON instead of text")
  .addHelpText(
    "after",
    `
The automated review runs when GitHub tells the NEMAR API a pull request was opened or pushed to. A
pull request that was already open when the review was switched on produced no such event, so it has
no review until its author pushes again. This asks for one by name. The API reads the pull request
from GitHub itself and runs it through the same gate as any other: the contributor pause and the
platform's daily pool still apply. What a start lifts is the per-contributor hourly and daily
allowance, because you chose this one. A commit whose review was declined, ended in an error or never
reported is started again, and so is one handed to GitHub more than 30 minutes ago that never came
back; one that is running or has a result is not started again. A start that restarts a review that
already cost a model call costs a second one, and counts as one against the daily pool.

  nemar admin pr-reviews start nm000108 12
  nemar admin pr-reviews start --all --dry-run
  nemar admin pr-reviews start --all --yes

Each review is one model call. A paused contributor is asked about like any other and declined by the
Worker, which says so; after 'allow', the same command starts it. --all leaves drafts out, asks
before spending (--yes skips that), and stops when the daily pool is spent, exiting 1 so a script
knows some were not tried.
`,
  )
  .action(
    async (
      datasetArg: string | undefined,
      prArg: string | undefined,
      options: { all?: boolean; dryRun?: boolean; yes?: boolean; json?: boolean },
    ) => {
      if (!requireAuth(options.json)) process.exit(1);
      const out = say(options.json);

      if (options.all) {
        if (datasetArg !== undefined || prArg !== undefined) {
          die("Give either <dataset> <pr> or --all, not both.", undefined, options.json);
        }
        await startAll(options);
        return;
      }
      if (datasetArg === undefined || prArg === undefined) {
        die(
          "Give a dataset and a pull request number, or --all.",
          "nemar admin pr-reviews start nm000108 12",
          options.json,
        );
      }
      if (options.dryRun) die("--dry-run goes with --all.", undefined, options.json);
      const dataset = checkDataset(datasetArg, options.json);
      const pr = checkPr(prArg, options.json);

      const spinner = options.json ? null : ora("Starting the review...").start();
      let r: StartReviewResponse;
      try {
        r = await startPrReview(dataset, pr);
        spinner?.stop();
      } catch (err) {
        if (err instanceof ApiError && errorWord(err) === "no_such_pull_request") {
          spinner?.fail(`${dataset} #${pr}: GitHub has no such pull request.`);
          if (!spinner) out(chalk.red("GitHub has no such pull request."));
          // The answer to a question about a pull request, not a fault in the command.
          markReportedExit();
          process.exit(1);
        }
        failApi(err, spinner, "Could not start the review", options.json);
      }
      if (options.json) {
        console.log(JSON.stringify(r, null, 2));
        if (!r.dispatched && START_FAULTS.has(r.reason)) process.exit(1);
        return;
      }
      if (r.dispatched) {
        console.log(
          `${chalk.bold(`${dataset} #${pr}`)}  ${chalk.green(startedWord(r))}. ${chalk.dim("The pull request's check shows the review as running.")}`,
        );
      } else {
        const text = notStartedText(r);
        const fault = START_FAULTS.has(r.reason);
        console.log(
          `${chalk.bold(`${dataset} #${pr}`)}  ${fault ? chalk.red(text) : chalk.yellow(text)}`,
        );
        if (fault) process.exit(1);
      }
      envNote(r.environment);
    },
  );

/** What one pull request of a `--all` run came to, in the JSON too. */
type StartResult =
  | (StartReviewResponse & { dataset_id: string; pr_number: number })
  | { dataset_id: string; pr_number: number; error: string };

/** The `--all` run: list, show, ask, then start one at a time. */
async function startAll(options: {
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
}): Promise<void> {
  const json = options.json === true;
  const spinner = json ? null : ora("Reading the open pull requests...").start();
  let q: QueueResponse;
  try {
    q = await listPrReviews({ verdicts: ["not_reviewed", "could_not_decide"] });
    spinner?.stop();
  } catch (err) {
    failApi(err, spinner, "Could not read the open pull requests", options.json);
  }
  if (!q.review_enabled) {
    die(
      "The automated review is off in this environment (PR_REVIEW_ENABLED), so nothing was started.",
      'Set PR_REVIEW_ENABLED = "1" in the Worker\'s [vars], deploy, then run this again.',
      options.json,
    );
  }

  const drafts = q.entries.filter((e) => e.draft);
  const todo = q.entries.filter((e) => !e.draft);
  const incomplete = q.truncated || q.skipped.unreadable > 0;
  const common = { environment: q.environment, drafts: drafts.length, truncated: incomplete };

  if (!json) {
    console.log();
    if (todo.length === 0) {
      console.log(
        incomplete
          ? "Nothing to start in what GitHub returned."
          : "Nothing to start: no open pull request is waiting for a review.",
      );
    } else {
      console.log(
        chalk.bold(
          `${todo.length} pull request${todo.length === 1 ? "" : "s"} waiting for a review (none of the current commit, or one that was declined or ended without a verdict)`,
        ),
      );
      for (const e of todo) {
        console.log(
          `  ${e.dataset_id} #${e.pr_number}  ${plain(e.author_login)}  ${chalk.dim(clip(e.title, 60))}`,
        );
      }
    }
    if (drafts.length > 0) {
      console.log(chalk.dim(`${drafts.length} draft${drafts.length === 1 ? "" : "s"} left out.`));
    }
    if (incomplete) {
      console.log(
        chalk.yellow(
          "GitHub returned fewer pull requests than exist, or some could not be read, so this list is incomplete.",
        ),
      );
    }
  }
  if (todo.length === 0) {
    if (json)
      console.log(JSON.stringify({ ...common, results: [], failed: 0, not_tried: 0 }, null, 2));
    return;
  }
  if (options.dryRun) {
    if (json) {
      const would = todo.map((e) => ({
        dataset_id: e.dataset_id,
        pr_number: e.pr_number,
        author_login: e.author_login,
      }));
      console.log(JSON.stringify({ ...common, dry_run: true, would_start: would }, null, 2));
    } else {
      console.log(chalk.dim("\nThis was a dry run: nothing was started."));
    }
    return;
  }
  if (!json) console.log();
  const go = await confirm(
    `Start the automated review of ${todo.length} pull request${todo.length === 1 ? "" : "s"}? Each is one model call.`,
    { yes: options.yes },
  );
  if (go !== "confirmed") {
    // Not on stdout under --json, which is read as one document.
    (json ? console.error : console.log)("Cancelled.");
    process.exit(1);
  }

  const results: StartResult[] = [];
  let failed = 0;
  let notTried = 0;
  for (let i = 0; i < todo.length; i++) {
    const e = todo[i];
    const label = `${e.dataset_id} #${e.pr_number}`;
    try {
      const r = await startPrReview(e.dataset_id, e.pr_number);
      results.push({ ...r, dataset_id: e.dataset_id, pr_number: e.pr_number });
      if (!json) {
        console.log(
          `  ${label}  ${r.dispatched ? chalk.green(startedWord(r)) : chalk.yellow(notStartedText(r))}`,
        );
      }
      if (r.reason === "daily_limit") {
        // The pool is the platform's, so the rest would be declined the same way.
        notTried = todo.length - (i + 1);
        break;
      }
    } catch (err) {
      failed++;
      const word =
        err instanceof ApiError ? (errorWord(err) ?? `http_${err.statusCode}`) : "unknown";
      results.push({ dataset_id: e.dataset_id, pr_number: e.pr_number, error: word });
      if (!json) {
        const gone = word === "no_such_pull_request";
        console.log(
          `  ${label}  ${chalk.red(gone ? "failed: GitHub has no such pull request" : `failed: ${err instanceof ApiError ? plain(err.message) : "could not be started"}`)}`,
        );
      }
    }
  }

  if (json) {
    console.log(JSON.stringify({ ...common, results, failed, not_tried: notTried }, null, 2));
  } else {
    const answered = results.filter(
      (r): r is StartReviewResponse & { dataset_id: string; pr_number: number } => "reason" in r,
    );
    const started = answered.filter((r) => r.dispatched).length;
    const had = answered.filter((r) => r.reason === "duplicate").length;
    const other = answered.length - started - had;
    console.log();
    console.log(
      `${started} started, ${had} already had a review, ${other} not started, ${failed} failed`,
    );
    if (notTried > 0) {
      console.log(
        chalk.yellow(
          `Stopped: the platform's daily pool is spent, so ${notTried} were not tried. It counts the last 24 hours; run this again once reviews from then have aged out.`,
        ),
      );
    }
    envNote(q.environment);
  }
  const faulted = results.some((r) => "reason" in r && !r.dispatched && START_FAULTS.has(r.reason));
  if (failed > 0 || faulted || notTried > 0) process.exit(1);
}

// -- approve ------------------------------------------------------------------------------------

prReviewsCommand
  .command("approve <dataset> <pr>")
  .description("Approve a pull request as YOURSELF (your GitHub login); merges only with --merge")
  .option("--merge", "After approving, merge it if GitHub reports it clean (attempted once)")
  .option("--method <method>", `How to merge, with --merge: ${MERGE_METHODS.join(", ")}`, "merge")
  .option("--message <text>", "The text of your approval")
  .option("--force", "Approve although the review failed, is running, or could not be read")
  .option(
    "--dry-run",
    "Check your token, the pull request and the review and show what would be approved; approve and merge nothing",
  )
  .option(
    "-y, --yes",
    "Do not ask for confirmation (a failing, running or unreadable review still needs --force)",
  )
  .action(
    async (
      datasetArg: string,
      prArg: string,
      options: {
        merge?: boolean;
        method: string;
        message?: string;
        force?: boolean;
        dryRun?: boolean;
        yes?: boolean;
      },
    ) => {
      if (!requireAuth()) process.exit(1);
      const dataset = checkDataset(datasetArg);
      const pr = checkPr(prArg);
      const method = options.method as MergeMethod;
      if (!MERGE_METHODS.includes(method)) {
        die(
          `"${plain(options.method)}" is not a merge method.`,
          `Use: ${MERGE_METHODS.join(", ")}`,
        );
      }
      const url = pullRequestUrl(dataset, pr);
      let base: string;
      try {
        base = githubApiBase();
      } catch (err) {
        return die(err instanceof Error ? err.message : String(err));
      }

      // 1-2. Your own GitHub credential, checked to be a person's and the one linked to your account.
      const { token, me, match } = await adminSession(base, { dataset, pr, url });

      // 3-4. The pull request as GitHub says it is now, and what the automated review concluded
      //      about THIS commit (the Worker is asked about the head just read).
      const assessed = await assessPullRequest(token, dataset, pr, base);
      if (!assessed.ok) return stopFor(assessed);
      const { live, head, verdict, detail, reviewCurrent, contributorNote, unread, gate } =
        assessed.value;

      if (gate.kind === "needs_force" && !options.force) die(gate.reason);

      console.log();
      console.log(chalk.bold(`Approve ${dataset} #${pr}`));
      console.log(`  Author:   @${plain(live.authorLogin)}`);
      console.log(`  Commit:   ${short(head)}`);
      console.log(`  Review:   ${reviewCell({ verdict, detail, reviewCurrent, unread })}`);
      if (contributorNote) console.log(chalk.yellow(`            ${plain(contributorNote)}`));
      console.log(
        `  You are:  @${me.login} ${match === "match" ? chalk.dim("(linked to your NEMAR account)") : chalk.yellow("(your NEMAR account names no GitHub login, so this cannot be checked)")}`,
      );
      if (gate.kind === "confirm") console.log(chalk.yellow(`  ${gate.warning}`));
      if (gate.kind === "needs_force") console.log(chalk.yellow("  Approving anyway (--force)."));
      if (options.merge) console.log(`  Then:     merge (${method}) if GitHub reports it clean`);

      if (options.dryRun) {
        console.log();
        console.log(chalk.cyan("Dry run: nothing was approved or merged."));
        return;
      }
      const answer = await confirm(`Approve ${dataset} #${pr} as @${me.login}?`, {
        yes: options.yes,
      });
      if (answer !== "confirmed") {
        console.log(chalk.dim("Not approved."));
        process.exit(1);
      }

      const text =
        options.message?.slice(0, 2000) ||
        `Approved with nemar admin pr-reviews approve. Automated review of this commit: ${unread ? "unknown" : verdictWord(verdict)}.`;
      const approved = await submitApproval(token, dataset, pr, head, me.login, text, base);
      if (!approved.ok) {
        if (approved.outcome === "unknown") {
          console.log(chalk.yellow(approved.reason));
          console.log(
            chalk.yellow(
              `Outcome unknown: GitHub may have recorded the approval. Check ${url} before trying again.`,
            ),
          );
          process.exit(1);
        }
        if (approved.outcome === "different") {
          die(approved.reason, `Check ${url} before trying again.`);
        }
        die(`Not approved: ${approved.reason}`);
      }
      console.log(chalk.green(`Approved ${dataset} #${pr} at ${short(head)} as @${me.login}.`));

      if (!options.merge) {
        console.log(
          chalk.dim(
            "  It is not merged. Run approve again with --merge (this records another approval), or merge it on GitHub.",
          ),
        );
        return;
      }
      const merged = await mergeWhenClean(token, dataset, pr, head, method, { base });
      if (!merged.ok) {
        console.log(chalk.yellow(merged.reason));
        if (merged.outcome === "unknown") {
          console.log(
            chalk.yellow(
              `Outcome unknown: GitHub may have merged it. Check ${url} before trying again.`,
            ),
          );
        }
        process.exit(1);
      }
      console.log(chalk.green(`Merged ${dataset} #${pr} (${method}).`));
    },
  );

// -- next ---------------------------------------------------------------------------------------

interface NextTally {
  merged: number;
  approved: number;
  closed: number;
  commented: number;
  skipped: number;
  failed: number;
  /** Writes GitHub did not answer in a way that says what happened: they may have been applied. */
  unknown: number;
}

function tallyLine(t: NextTally): string {
  const parts = [
    t.merged && `${t.merged} merged`,
    t.approved && `${t.approved} approved but not merged`,
    t.closed && `${t.closed} closed`,
    t.commented && `${t.commented} commented`,
    t.skipped && `${t.skipped} skipped`,
    t.failed && `${t.failed} failed`,
    t.unknown && `${t.unknown} with an unknown outcome (check the pull request)`,
  ].filter(Boolean);
  return parts.length === 0 ? "Nothing was changed." : `Done: ${parts.join(", ")}.`;
}

/** Pull requests the run leaves for the administrator: skipped, failed, unknown, or approved only. */
function outstanding(t: NextTally): number {
  return t.skipped + t.failed + t.unknown + t.approved;
}

/**
 * Say what a failed write is and count it. Returns true when the run must stop: a result that is
 * not known (GitHub may have applied it) or a record that is not what was asked for needs the
 * administrator to look at the pull request before anything else is done to it or to the next one.
 * A refusal, or a merge that was never sent, is counted under `bucket` and the run goes on.
 */
function reportFailedWrite(
  w: Extract<WriteResult, { ok: false }>,
  spec: {
    didNot: string;
    mayHave: string;
    url: string;
    tally: NextTally;
    bucket: "failed" | "approved";
  },
): boolean {
  if (w.outcome === "unknown") {
    console.log(chalk.yellow(w.reason));
    console.log(
      chalk.yellow(`Outcome unknown: GitHub may have ${spec.mayHave}. Check ${spec.url}.`),
    );
    spec.tally.unknown++;
    return true;
  }
  if (w.outcome === "different") {
    console.log(chalk.red(w.reason));
    console.log(chalk.dim(`  Check ${spec.url}.`));
    spec.tally.unknown++;
    return true;
  }
  spec.tally[spec.bucket]++;
  if (w.outcome === "not_sent") {
    // A sentence of its own ("Not merged: ... The approval stands."), and nothing was sent.
    console.log(chalk.yellow(w.reason));
    return false;
  }
  console.log(chalk.red(`Not ${spec.didNot}: ${w.reason}`));
  return false;
}

/** Why `d` has no report to show, in words that do not call an unreadable report "none". */
function noReportWhy(a: {
  unread: string | undefined;
  reviewCurrent: boolean | null;
  verdict: QueueVerdict;
}): string {
  if (a.unread) return `The report could not be read (${plain(a.unread)}).`;
  if (a.reviewCurrent === false) {
    return "The review on record is of another commit, so its report is not shown.";
  }
  if (a.verdict === "in_progress") return "The review is still running.";
  if (a.verdict === "not_reviewed") return "This commit has not been reviewed.";
  return "A review of this commit is on record, but its report could not be read.";
}

prReviewsCommand
  .command("next")
  .description(
    "Go through the pull requests that need you, one at a time: y approves and squash-merges, n closes with a comment, c comments",
  )
  .option("--dataset <id>", "Only this dataset")
  .option("--author <login>", "Only pull requests opened by this GitHub login")
  .option("--all", "Include pull requests whose review failed or is still running")
  .option("--force", "Let y approve although the review failed, is running, or could not be read")
  .option("--once", "Handle one pull request and stop")
  .addHelpText(
    "after",
    `
For each pull request it shows who opened it, the automated review's summary, whether the two
required checks (BIDS and version) are green and whether the version went up, then waits for one
answer:

  y   approve it as YOU (your own GitHub login), then squash-merge it. Only offered when both
      required checks are green and GitHub says it can be merged as it is; a failing, running or
      unreadable review also needs --force.
  n   close it. You are asked for a comment, which is posted first so the author sees why.
  c   comment on it and leave it open. You are asked for the comment.
  d   show the whole report, then ask again.
  s   leave it for now (it is not shown again in this run).   q   stop.

An empty comment cancels the n or c and asks again, and a comment is one line. The squash merge is
attempted once, only if GitHub reports the pull request clean, exactly as for 'approve --merge'.
Nothing is sent to GitHub except what you answer, with your own token, and a write whose outcome is
unknown stops the run. In a terminal, anything you type before a card has been shown is ignored, so
an impatient Enter cannot answer a pull request you have not seen; piped answers are all kept.
`,
  )
  .action(
    async (options: {
      dataset?: string;
      author?: string;
      all?: boolean;
      force?: boolean;
      once?: boolean;
    }) => {
      if (!requireAuth()) process.exit(1);
      const dataset = options.dataset ? checkDataset(options.dataset) : undefined;
      const author = options.author ? checkLogin(options.author) : undefined;
      let base: string;
      try {
        base = githubApiBase();
      } catch (err) {
        return die(err instanceof Error ? err.message : String(err));
      }
      const session = await adminSession(base);
      const login = session.me.login;
      console.log(
        chalk.dim(
          `Going through the queue as @${login}.  y approve + squash merge   n close with a comment   c comment   d details   s skip   q quit`,
        ),
      );
      if (session.match === "unlinked") {
        console.log(
          chalk.yellow(
            `  Your NEMAR account names no GitHub login, so @${login} cannot be checked against it.`,
          ),
        );
      }

      const reader = new LineReader();
      const handled = new Set<string>();
      const tally: NextTally = {
        merged: 0,
        approved: 0,
        closed: 0,
        commented: 0,
        skipped: 0,
        failed: 0,
        unknown: 0,
      };
      let stopped = false;
      let first = true;
      const endedWords = () =>
        reader.interrupted ? "Interrupted; stopping." : "Input ended; stopping.";
      /** Close the input and say what was done. Every way out of the run goes through here. */
      const finish = () => {
        reader.close();
        console.log();
        console.log(tallyLine(tally));
      };

      run: for (;;) {
        let q: QueueResponse;
        try {
          q = await listPrReviews({ verdicts: [], dataset, author, needsMe: !options.all });
        } catch (err) {
          finish();
          return failApi(err, null, "Could not read the pull-request queue");
        }
        if (first) {
          for (const l of incompleteLines(q)) console.log(l);
          first = false;
        }
        const pending = q.entries.filter(
          (e) => !e.draft && !handled.has(`${e.dataset_id}#${e.pr_number}`),
        );
        const e = pending[0];
        if (!e) {
          // "Nothing left" is only said when it is known: nothing skipped, failed or half done, and
          // a list that was read whole.
          const notes = incompleteLines(q);
          if (q.skipped.not_owned_here > 0) {
            notes.push(
              chalk.yellow(
                `  ${q.skipped.not_owned_here} pull request(s) belong to the other environment's Worker and are not shown.`,
              ),
            );
          }
          const left = outstanding(tally);
          if (left === 0 && notes.length === 0) {
            console.log(chalk.green("\nNothing left that needs you."));
          } else {
            console.log(
              chalk.yellow(
                `\nNo more pull requests to show${left > 0 ? `, but ${left} still ${left === 1 ? "needs" : "need"} you (skipped, failed, with an unknown outcome, or approved and not merged)` : ""}.`,
              ),
            );
            for (const l of notes) console.log(l);
          }
          break;
        }
        handled.add(`${e.dataset_id}#${e.pr_number}`);
        const url = pullRequestUrl(e.dataset_id, e.pr_number);

        // The pull request as it is now: the list can trail a merge or a push by a minute.
        const assessed = await assessPullRequest(session.token, e.dataset_id, e.pr_number, base);
        if (!assessed.ok) {
          const { stop } = assessed;
          if (stop.kind === "refused" || stop.kind === "unreadable") {
            console.log(chalk.dim(`\n${e.dataset_id} #${e.pr_number}: skipped, ${stop.message}`));
            // Closed, merged or drafted under us is resolved; one this token cannot read is not.
            if (stop.kind === "unreadable") tally.failed++;
            continue;
          }
          finish();
          return stopFor(assessed);
        }
        const a = assessed.value;
        // The list's check states are about the commit the list named.
        const moved = a.head !== e.head_sha;
        const bids = moved ? "unknown" : e.bids;
        const version = moved ? "unknown" : e.version;
        const allowed = approveAllowed({
          gate: a.gate,
          force: options.force === true,
          bids,
          version,
          mergeable: a.live.mergeableState,
        });
        // The stored verdict and the report can disagree (ADR 0093: the stricter is used).
        const shown = a.outcome as ReviewOutcome | null | undefined;
        const rederived = shown?.kind === "reported" ? verdictOf(shown.report) : null;

        console.log();
        console.log(
          `${chalk.bold(`[${handled.size} of ${handled.size - 1 + pending.length}] ${plain(e.dataset_id)} #${e.pr_number}`)}  ${chalk.dim(url)}`,
        );
        console.log(`  Title:    ${clip(e.title, 100)}`);
        console.log(
          `  Author:   @${plain(a.live.authorLogin)} (${e.from_fork ? "fork " : "branch "}${plain(e.head_label)}), opened ${ageOf(e.created_at)} ago`,
        );
        console.log(
          `  Commit:   ${short(a.head)}${moved ? chalk.yellow("  (changed since the list was read)") : ""}`,
        );
        console.log(`  Review:   ${reviewCell(a)}`);
        console.log(`  Checks:   BIDS ${checkCell(bids, 0)}   version ${checkCell(version, 0)}`);
        if (a.live.mergeableState === "dirty") {
          console.log(chalk.red("  Merge:    it has merge conflicts"));
        } else if (a.live.mergeableState === "behind") {
          console.log(chalk.yellow("  Merge:    the branch is behind main"));
        }
        if (a.contributorNote) console.log(chalk.yellow(`  ${plain(a.contributorNote)}`));
        if (a.gate.kind === "confirm") console.log(chalk.yellow(`  ${a.gate.warning}`));
        if (a.gate.kind === "needs_force" && options.force) {
          console.log(
            chalk.red(
              `  --force: y will approve although the review ${a.unread ? "could not be read" : a.verdict === "in_progress" ? "is still running" : "says it needs changes"}.`,
            ),
          );
        }
        if (rederived !== null && !a.unread && a.verdict !== rederived) {
          console.log(
            chalk.yellow(
              `  The stored verdict is ${verdictWord(a.verdict)}; the report below would now read ${verdictWord(rederived)}. The stricter is used.`,
            ),
          );
        }
        // `a.outcome` is the report of THIS commit's review, or null (see reviewForApproval).
        const brief = briefLines(a.outcome);
        if (brief.length > 0) {
          console.log();
          for (const l of brief) console.log(`  ${l}`);
        }
        if (!allowed.ok) {
          console.log();
          console.log(chalk.yellow(`  y is not available: ${allowed.reason}`));
        }

        // What was typed before this card existed was not an answer to it.
        const dropped = await reader.discardTyped();
        if (dropped > 0) {
          console.log(chalk.dim(`  Ignored ${dropped} line(s) typed before this card was shown.`));
        }

        for (;;) {
          const raw = await reader.ask(
            `\n${allowed.ok ? "y approve + squash merge, " : ""}n close, c comment, d details, s skip, q quit > `,
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
          if (choice === "details") {
            console.log();
            if (a.outcome === null || a.outcome === undefined) {
              console.log(chalk.dim(`  ${noReportWhy(a)}`));
            } else {
              for (const l of reportLines(a.outcome as ReviewOutcome)) console.log(l);
            }
            continue;
          }
          if (choice === "skip") {
            tally.skipped++;
            break;
          }

          if (choice === "approve") {
            if (!allowed.ok) {
              console.log(chalk.yellow(`  Not approved: ${allowed.reason}`));
              continue;
            }
            const text = `Approved with nemar admin pr-reviews next. Automated review of this commit: ${a.unread ? "unknown" : verdictWord(a.verdict)}.`;
            const approved = await submitApproval(
              session.token,
              e.dataset_id,
              e.pr_number,
              a.head,
              login,
              text,
              base,
            );
            if (!approved.ok) {
              stopped = reportFailedWrite(approved, {
                didNot: "approved",
                mayHave: "recorded the approval",
                url,
                tally,
                bucket: "failed",
              });
              if (stopped) break run;
              break;
            }
            console.log(
              chalk.green(
                `Approved ${e.dataset_id} #${e.pr_number} at ${short(a.head)} as @${login}.`,
              ),
            );
            const merged = await mergeWhenClean(
              session.token,
              e.dataset_id,
              e.pr_number,
              a.head,
              "squash",
              { base },
            );
            if (merged.ok) {
              console.log(chalk.green(`Merged ${e.dataset_id} #${e.pr_number} (squash).`));
              tally.merged++;
            } else {
              stopped = reportFailedWrite(merged, {
                didNot: "merged",
                mayHave: "merged it",
                url,
                tally,
                bucket: "approved",
              });
              if (stopped) break run;
            }
            break;
          }

          // n and c: a comment, typed by the administrator, posted exactly as typed.
          const closing = choice === "close";
          const typed = await reader.ask(
            closing
              ? "Comment for the author, posted before it is closed (empty cancels): "
              : "Comment (empty cancels): ",
          );
          if (typed === null) {
            console.log(chalk.dim(`\n${endedWords()}`));
            break run;
          }
          // A pasted comment of several lines is one line plus lines that would answer the next
          // cards. A terminal drops them and sends nothing; a pipe is a script and keeps its lines.
          const extra = await reader.discardTyped(40);
          if (extra > 0) {
            console.log(
              chalk.yellow(
                `A comment is one line; ${extra} more line(s) arrived with it. Nothing was sent.`,
              ),
            );
            continue;
          }
          const text = typed.trim();
          if (text === "") {
            console.log(chalk.dim("  Cancelled. Nothing was sent."));
            continue;
          }
          // A comment and a close are not pinned to the commit the card showed, and typing takes a
          // while: look again, and write nothing if the pull request is no longer the one shown.
          const now = await fetchPullRequest(session.token, e.dataset_id, e.pr_number, base);
          if (!now.ok) {
            console.log(
              chalk.yellow(
                `Could not re-read the pull request, so nothing was sent: ${now.reason}`,
              ),
            );
            tally.failed++;
            break;
          }
          if (now.value.state !== "open" || now.value.headSha !== a.head) {
            console.log(
              chalk.yellow(
                `This pull request changed while it was open here (now ${now.value.state}, at ${short(now.value.headSha)}). Nothing was sent.`,
              ),
            );
            tally.skipped++;
            break;
          }
          const posted = await postComment(session.token, e.dataset_id, e.pr_number, text, base);
          if (!posted.ok) {
            stopped = reportFailedWrite(posted, {
              didNot: "commented",
              mayHave: "posted the comment",
              url,
              tally,
              bucket: "failed",
            });
            if (stopped) break run;
            break;
          }
          if (!closing) {
            console.log(chalk.green(`Commented on ${e.dataset_id} #${e.pr_number}.`));
            tally.commented++;
            break;
          }
          console.log(chalk.dim("  The comment was posted."));
          const closed = await closePullRequest(session.token, e.dataset_id, e.pr_number, base);
          if (!closed.ok) {
            stopped = reportFailedWrite(closed, {
              didNot: "closed",
              mayHave: "closed it",
              url,
              tally,
              bucket: "failed",
            });
            if (stopped) break run;
            break;
          }
          console.log(chalk.green(`Closed ${e.dataset_id} #${e.pr_number}, with your comment.`));
          tally.closed++;
          break;
        }
        if (options.once) break;
      }

      finish();
      if (reader.interrupted) process.exit(130);
      if (stopped || tally.failed > 0 || tally.unknown > 0) process.exit(1);
    },
  );

/** When there is no safe way to approve from here: where to do it by hand. */
function manualFallback(dataset: string, pr: number, url: string): void {
  console.log();
  console.log("Approve it on GitHub with your own account:");
  console.log(`  ${url}`);
  console.log(`  ${manualApprovalCommand(dataset, pr)}`);
  if (process.stdout.isTTY) openInBrowser(url);
}

// -- allow / block / clear / standing -----------------------------------------------------------

function overrideCommand(mode: "allow" | "block"): void {
  prReviewsCommand
    .command(`${mode} <login>`)
    .description(
      mode === "allow"
        ? "Review this contributor's pull requests even when their record would pause them (rate limits still apply)"
        : "Never review this contributor's pull requests automatically; each needs a person",
    )
    .option("--reason <text>", "Why, in plain words (up to 200 characters; kept with the decision)")
    .option("--json", "Output the raw JSON")
    .action(async (loginArg: string, options: { reason?: string; json?: boolean }) => {
      if (!requireAuth(options.json)) process.exit(1);
      const login = checkLogin(loginArg, options.json);
      if (options.reason && options.reason.length > MAX_REASON) {
        die(
          `The reason is ${options.reason.length} characters; ${MAX_REASON} is the most that is kept.`,
          undefined,
          options.json,
        );
      }
      const spinner = options.json ? null : ora(`Setting ${mode} for ${login}...`).start();
      try {
        const r = await setPrReviewAuthor(login, mode, options.reason);
        spinner?.stop();
        if (options.json) {
          console.log(JSON.stringify(r, null, 2));
          return;
        }
        console.log(
          mode === "allow"
            ? chalk.green(
                `Allowed ${plain(r.standing.login)}: their pull requests are reviewed even when their record would pause them (rate limits still apply).`,
              )
            : chalk.red(
                `Blocked ${plain(r.standing.login)}: none of their pull requests is reviewed automatically; each needs a person.`,
              ),
        );
        if (r.previous && r.previous !== mode)
          console.log(chalk.dim(`  (it was ${r.previous} before)`));
        if (mode === "allow") {
          console.log(
            chalk.dim("  Pull requests already opened are not re-reviewed until their next push."),
          );
        }
        console.log();
        for (const l of standingLines(r.standing)) console.log(l);
        envNote(r.environment);
      } catch (err) {
        failApi(err, spinner, `Could not ${mode} ${login}`, options.json);
      }
    });
}

overrideCommand("allow");
overrideCommand("block");

prReviewsCommand
  .command("clear <login>")
  .description("Remove an allow or block, so the contributor's record decides again")
  .option("--json", "Output the raw JSON")
  .action(async (loginArg: string, options: { json?: boolean }) => {
    if (!requireAuth(options.json)) process.exit(1);
    const login = checkLogin(loginArg, options.json);
    const spinner = options.json ? null : ora(`Clearing ${login}...`).start();
    try {
      const r = await clearPrReviewAuthor(login);
      spinner?.stop();
      if (options.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      console.log(
        r.removed
          ? chalk.green(
              `Removed the ${r.removed} for ${plain(r.standing.login)}. Their record decides again.`,
            )
          : r.standing.resolved_from === "history"
            ? chalk.yellow(
                `No allow or block found for ${plain(r.standing.login)} under the id the Worker has on file (GitHub did not confirm this login).`,
              )
            : chalk.dim(`${plain(r.standing.login)} had no allow or block.`),
      );
      console.log();
      for (const l of standingLines(r.standing)) console.log(l);
      envNote(r.environment);
    } catch (err) {
      failApi(err, spinner, `Could not clear ${login}`, options.json);
    }
  });

prReviewsCommand
  .command("standing <login>")
  .description(
    "A contributor's rejected-pull-request record, any allow or block, and what it means",
  )
  .option("--json", "Output the raw JSON")
  .action(async (loginArg: string, options: { json?: boolean }) => {
    if (!requireAuth(options.json)) process.exit(1);
    const login = checkLogin(loginArg, options.json);
    const spinner = options.json ? null : ora(`Reading ${login}...`).start();
    try {
      const s = await getPrReviewAuthor(login);
      spinner?.stop();
      if (options.json) {
        console.log(JSON.stringify(s, null, 2));
        return;
      }
      console.log();
      for (const l of standingLines(s)) console.log(l);
      console.log();
    } catch (err) {
      failApi(err, spinner, `Could not read ${login}`, options.json);
    }
  });
