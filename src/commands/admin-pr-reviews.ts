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
 *   nemar admin pr-reviews allow <ds> <pr> --admin --reason <why> [--commit <sha>]
 *                                            waive the naming rule for an owner's or an
 *                                            administrator's pull request, at its current commit
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
  type QueueVolume,
  type ReadVerdict,
  type StartReviewResponse,
  type VolumeWindow,
  type WaiveNamingResponse,
} from "../../shared/contract/pr-review-admin.js";
import {
  type NamingFacts,
  type ReviewEvidence,
  type ReviewOutcome,
  factsOf,
  factsStop,
  findingLines,
  namingLines,
  renderCheck,
  verdictOf,
} from "../../shared/pr-review.js";
import { PUBLICATION_DATASET_ID_RE } from "../../shared/publication-limits.js";
import { say } from "../lib/admin-command.js";
import {
  clearPrReviewAuthor,
  getPrReview,
  getPrReviewAuthor,
  listPrReviews,
  setPrReviewAuthor,
  startPrReview,
  waivePrReviewNaming,
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
  type MergeAdvice,
  type MergeMethod,
  type MergeRefused,
  type PullRequestFacts,
  type WriteResult,
  adminGitHubToken,
  approvalGate,
  checkMergeable,
  closePullRequest,
  fetchPullRequest,
  githubApiBase,
  identityMatches,
  manualApprovalCommand,
  mergeCheckOf,
  mergeWhenClean,
  postComment,
  pullRequestUrl,
  recheckBeforeApproval,
  refusalFor,
  reviewForApproval,
  submitApproval,
  whoAmI,
} from "../lib/pr-review-approve.js";
import { approveAllowed, parseChoice } from "../lib/pr-review-next.js";
import { LineReader, PASTE_SETTLE_MS } from "../lib/prompt-lines.js";
import { ageOf, clip, plain } from "../lib/terminal-text.js";

// Moved to `lib/terminal-text.ts`; re-exported because `test/pr-reviews-render.unit.test.ts` imports
// them from here.
export { ageOf, plain };

/** The Worker keeps this much of a reason; a longer one is refused here rather than cut without a word. */
const MAX_REASON = 200;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

// ---------------------------------------------------------------------------------------------
// Plain, safe, aligned text
// ---------------------------------------------------------------------------------------------

const DETAIL_WORDS: Record<string, string> = {
  contributor_paused: "contributor paused",
  // The limits no longer exist; a row written while they did still says so.
  rate_limited: "rate limited",
  daily_limit: "daily limit",
  unreported: "never reported",
  // The review of a commit was refused at the cap on restarts by edits (ADR 0107).
  edit_limit: "too many edits",
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
  exempt: "exempt (owner or admin)",
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
    case "exempt":
      return chalk.dim;
    default:
      return chalk.yellow;
  }
}

/**
 * The verdict as a person reads it, with the closed word behind it when there is one. An exempt
 * pull request the naming rule holds says what releases it, because "exempt" alone reads as nothing
 * waiting: the rule failed it (waive it for the commit, or the author fixes it), or could not check
 * it (GitHub may not have answered, which one more start settles, or the file has no readable name,
 * which only a fix to the file does; nothing is waivable until the name is read).
 */
export function verdictText(e: Pick<QueueEntry, "verdict" | "detail" | "review_current">): string {
  const word = verdictWord(e.verdict);
  if (e.verdict === "not_reviewed" && e.review_current === false) {
    return `${word} (other commit)`;
  }
  if (e.verdict === "exempt" && e.detail === "naming_rule") {
    return "exempt, naming rule failed: needs allow --admin";
  }
  if (e.verdict === "exempt" && e.detail === "naming_unchecked") {
    return "exempt, naming rule not checked: start once, else fix the file";
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
    // Wide enough for the longest word a row can carry: an exempt row the naming rule holds, drafted.
    verdict: clip(`${verdictText(e)}${e.draft ? " [draft]" : ""}`, 72),
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

// ---------------------------------------------------------------------------------------------
// The volume line
// ---------------------------------------------------------------------------------------------

/** A count the server sent, or null when it is not a whole number of at least zero: unknown is never zero. */
function countOf(n: unknown): number | null {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** "1 review", "2 reviews". */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The order the list reads verdicts in: what was decided, then what was not. */
const VOLUME_VERDICT_ORDER: readonly string[] = [
  "pass",
  "fail",
  "uncertain",
  "could_not_decide",
  "in_progress",
  "not_reviewed",
];

/**
 * The declined reviews as words, `2 contributor paused, 1 rate limited`, for the ones there are; a
 * plain note when the server sent no breakdown, which is not the same as there being none.
 */
function declineWords(declines: unknown): string {
  if (typeof declines !== "object" || declines === null) return "reasons could not be read";
  return Object.entries(declines)
    .filter(([, n]) => countOf(n) !== 0)
    .map(([word, n]) => `${countOf(n) ?? "?"} ${detailWord(word)}`)
    .join(", ");
}

/**
 * One window as a sentence, or null when what the server sent for it cannot be read.
 * `5 reviews recorded, 6 review runs; 3 pass, 1 fail, 1 not reviewed (1 contributor paused)`.
 * A count that cannot be read is a question mark and a missing breakdown is said to be missing,
 * never a zero: the words are the list's own, a word a newer server adds is shown as itself after
 * them, and a real zero is left out.
 */
function volumeWindowText(w: VolumeWindow | null | undefined): string | null {
  if (typeof w !== "object" || w === null) return null;
  const reviews = countOf(w.reviews);
  const runs = countOf(w.review_runs);
  if (reviews === null || runs === null) return null;
  if (reviews === 0) return "no reviews recorded";
  const head = `${plural(reviews, "review", "reviews")} recorded, ${plural(runs, "review run", "review runs")}`;
  if (typeof w.by_verdict !== "object" || w.by_verdict === null) {
    return `${head}; what they came to could not be read`;
  }
  const counts: Record<string, unknown> = { ...w.by_verdict };
  const words = [
    ...VOLUME_VERDICT_ORDER,
    ...Object.keys(counts).filter((k) => !VOLUME_VERDICT_ORDER.includes(k)),
  ];
  const parts: string[] = [];
  for (const word of words) {
    const n = counts[word];
    if (countOf(n) === 0) continue;
    const text = `${countOf(n) ?? "?"} ${verdictWord(word)}`;
    const why = word === "not_reviewed" ? declineWords(w.declines) : "";
    parts.push(why ? `${text} (${why})` : text);
  }
  return parts.length > 0 ? `${head}; ${parts.join(", ")}` : head;
}

/**
 * What the review has done lately, one line for each window, as the list prints it. Information
 * only, and it says so: no count here limits a review (ADR 0107). Nothing at all when the server
 * did not send one (an older server), and a plain note when it tried and could not read it, since
 * an unread volume is not a volume of zero.
 */
export function volumeLines(volume: QueueVolume | null | undefined): string[] {
  if (volume === undefined) return [];
  if (volume === null) return [chalk.dim("The review volume could not be read this time.")];
  const windows: Array<[string, VolumeWindow | null | undefined]> = [
    ["Last 24 hours:", volume.last_24_hours],
    ["Last 7 days:", volume.last_7_days],
  ];
  const lines = [
    chalk.dim("Review volume, for information only (no count limits reviews):"),
    ...windows.map(
      ([label, w]) => `  ${label.padEnd(15)}${plain(volumeWindowText(w) ?? "could not be read")}.`,
    ),
  ];
  const tokenWindows: Array<[string, VolumeWindow | null | undefined]> = [
    ["Tokens, 24 hours:", volume.last_24_hours],
    ["Tokens, 7 days:", volume.last_7_days],
  ];
  for (const [label, w] of tokenWindows) {
    const tokens = tokenText(w);
    if (tokens !== null) lines.push(`  ${label.padEnd(18)}${plain(tokens)}.`);
  }
  return lines;
}

/** A whole number with thousands separated, the way the list prints counts of tokens. */
function grouped(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/**
 * The tokens of a window as one sentence, with the estimate in dollars. Null when there is nothing
 * to say: the server sent no token counts (an older server), or no report in the window carries
 * them (reports from before the screen do not). Says how many reports the sum is over, because a
 * report from before the screen and a run that ended without a report are not in it.
 * `410,000 in and 95,000 out over 12 reports (screen 30,000 in, 60,000 out; review 380,000 in,
 * 35,000 out), about $1.14 at list prices; runs that ended without a report are not counted`.
 */
export function tokenText(w: VolumeWindow | null | undefined): string | null {
  if (typeof w !== "object" || w === null) return null;
  const t = w.tokens;
  if (typeof t !== "object" || t === null) return null;
  const counts = [
    t.screen_input,
    t.screen_output,
    t.review_input,
    t.review_output,
    t.reviews_counted,
  ].map(countOf);
  if (counts.some((n) => n === null)) return "token counts could not be read";
  const [si, so, ri, ro, counted] = counts as number[];
  if (counted === 0) return null;
  const cost =
    typeof w.estimated_cost_usd === "number" && Number.isFinite(w.estimated_cost_usd)
      ? `, about $${w.estimated_cost_usd.toFixed(2)} at list prices`
      : "";
  return `${grouped(si + ri)} in and ${grouped(so + ro)} out over ${plural(counted, "report", "reports")} (screen ${grouped(si)} in, ${grouped(so)} out; review ${grouped(ri)} in, ${grouped(ro)} out)${cost}; runs that ended without a report are not counted`;
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

/**
 * Why a review ended at the facts, in the words of the check's own title: the naming rule found a
 * problem (`Needs changes: the naming rule`), or it could not check the dataset's name (`Could not
 * decide: the naming rule was not checked`). Both come from the same answer, `factsStop`, so this
 * line and the title cannot disagree, whatever the verdict is.
 */
function factsReason(e: ReviewEvidence): string {
  return factsStop(e) === "refused"
    ? "the naming rule found a problem"
    : "the naming rule could not check the dataset name";
}

/**
 * `Version:  1.0.0 to 1.1.0   revision advances: yes`, from the review's own evidence and answer.
 * A report that ended before the review read anything says so instead of "unknown": the screen
 * stopped it, or, at the facts stage, the naming rule ended it and no model was asked, so the
 * revision was never assessed. A git fact that failed the revision anyway (the version did not go
 * up) is still said, and the facts stage is said after it.
 */
function versionLine(report: Extract<ReviewOutcome, { kind: "reported" }>["report"]): string {
  const { version_before: before, version_after: after } = report.evidence;
  const advances = factsOf(report).criteria.advances_revision;
  const screened = report.v === 2 && report.stage === "screen";
  const factsOnly = report.v === 2 && report.stage === "facts";
  const stage = factsOnly
    ? chalk.dim(`stage: facts only; the review did not run (${factsReason(report.evidence)})`)
    : null;
  const word =
    advances === "pass"
      ? chalk.green("revision advances: yes")
      : advances === "fail"
        ? chalk.red("revision advances: NO")
        : screened
          ? chalk.dim("revision advances: not assessed (stopped by the screen)")
          : factsOnly
            ? null
            : chalk.yellow("revision advances: unknown");
  const said = [word, stage].filter((w): w is string => w !== null).join("; ");
  return `Version:  ${plain(before ?? "unknown")} to ${plain(after ?? "unknown")}   ${said}`;
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
    const naming = namingLines(o.report);
    if (naming.length > 0) lines.push(chalk.bold("Naming rule:"), ...naming.map((l) => `- ${l}`));
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

/** One decimal, so a rate just above a round number (10.2%) is not shown as the round number. */
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
      "             shown for information: a record of rejections does not pause anyone's reviews, only a block does",
    ),
  );
  if (s.override) {
    const by = s.override.set_by ? ` by ${plain(s.override.set_by)}` : "";
    out.push(
      `  Decision:  ${s.override.mode === "allow" ? chalk.green("allowed") : chalk.red("blocked")}${by} on ${plain(s.override.set_at)}${s.override.reason ? `: ${plain(s.override.reason)}` : ""}`,
    );
  } else {
    out.push("  Decision:  none");
  }
  out.push(
    `  Standing:  ${
      s.standing.paused
        ? chalk.red(
            // A Worker older than this CLI can still pause by the record, and its pause is not a block.
            s.standing.because === "maintainer"
              ? "paused by an administrator's block: their pull requests need a person"
              : "paused: their pull requests need a person",
          )
        : chalk.green("not paused: reviewed automatically")
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
  out.push(
    chalk.dim(
      "  Exempt:    a NEMAR owner or administrator is not reviewed whatever is decided here, unless a review of the commit is already on record.",
    ),
  );
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
  if (!PUBLICATION_DATASET_ID_RE.test(id))
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
                    (a version 2 report also needs a clear title and description)
  fail              the review found a problem; the author needs to change something
  uncertain         the review could not decide whether it is a good change
  not reviewed      no review of this commit is on record: the review is off, the contributor was
                    paused ("contributor paused": an administrator's block, or, on a row from
                    before the automatic pause was removed, the contributor's record), or the
                    review on record is of another commit (shown as "other commit"). A row from
                    before the limits on reviews were removed can also say rate limited or daily
                    limit
  in progress       the review is running
  could not decide  the review ended without a verdict (an error, or it never reported)
  exempt (owner or admin)
                    a NEMAR owner or administrator opened it, so it is not reviewed (its review
                    check is posted as skipped, which this list does not verify); nothing waits
                    for you, and a push by anyone else IS reviewed. The naming rule still applies:
                    a title or a new dataset name it refuses fails the check instead, until the
                    title or the name is fixed or the rule is waived for that commit with
                    'nemar admin pr-reviews allow <dataset> <pr> --admin --reason <why>'. The row
                    says so when the check failed ("naming rule failed: needs allow --admin") or
                    when the name could not be read ("naming rule not checked: start once, else fix
                    the file": a start asks GitHub again, and a file with no readable Name has to be
                    fixed and pushed; nothing is waivable until the name is read)
A verdict is never carried over to a commit it did not read. '*' marks the pull requests you can
act on now: a pass to approve, or one nobody has decided for you (drafts are never marked).

APPROVING is YOUR act, made with your own GitHub login from this machine, never as the NEMAR
App. It uses GH_TOKEN if set, otherwise the token 'gh' holds, checks it belongs to a person and to
the GitHub account linked to your NEMAR account (if one is linked), and approves the exact commit
you were shown. It asks before approving unless you add --yes. A failing review, a running one, or
one that could not be read needs --force. Nothing merges unless you add --merge (or answer y in
'next'), and then only if GitHub reports the pull request clean. That is checked BEFORE anything is
approved, and again just before the approval is written (GitHub has no approve-and-merge call, so
that narrows the window to one request and cannot close it): a pull request that is not clean (one
the automated review holds is expected to be reported 'unstable') is neither approved nor merged by
--merge or y, you are told which state GitHub gave and why, and 'approve' without --merge approves
it. The merge is then attempted once, and it never tries a merge GitHub reports as blocked.
If 'gh' holds no signed-in account, or the token is an app or workflow token,
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
      const volume = volumeLines(q.volume);
      if (volume.length > 0) {
        console.log();
        for (const l of volume) console.log(l);
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
    if (d.verdict === "exempt") {
      // Not reviewed by design, and not a gap: say so, and do not show another commit's report.
      console.log(
        `  Review:    ${color(verdictText({ verdict: d.verdict, detail: d.detail, review_current: d.review_current }))}`,
      );
      console.log(
        chalk.dim(
          "             A NEMAR owner or administrator opened this pull request, so no automated review is required.",
        ),
      );
      console.log(
        chalk.dim(
          "             The review check on an exempt pull request is posted as skipped, which is not a pass; this view does not verify that it was.",
        ),
      );
      console.log(
        chalk.dim(
          "             The naming rule still applies: a title or a new dataset name it refuses fails the check instead (waive it for this commit with: nemar admin pr-reviews allow <dataset> <pr> --admin --reason <why>).",
        ),
      );
      if (d.review) {
        console.log(
          chalk.dim(
            `             An earlier commit (${short(d.review.head_sha)}) was reviewed and read ${verdictWord(d.review.verdict)}; this commit was not reviewed.`,
          ),
        );
      }
    } else if (!d.review) {
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

    // An exempt pull request is not held to the author's record, so the record is not shown beside it.
    if (d.author && d.verdict !== "exempt") {
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

/** The review as one colored cell: its verdict and reason, or "unknown" when it could not be read. */
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
  review_running:
    "a review of this commit is running, and a redo waits until it reports or its time (about an hour) is up",
  contributor_paused: "the contributor is blocked by an administrator",
  exempt_author: "its author is a NEMAR owner or administrator, so it is not reviewed",
  exempt_naming_waived:
    "its author is a NEMAR owner or administrator, and the naming rule was waived for this commit",
  naming_rule:
    "its author is a NEMAR owner or administrator, and the naming rule refused its title or its new dataset name, so its check failed",
  naming_unchecked:
    "its author is a NEMAR owner or administrator, and its dataset name could not be read to check the naming rule, so its check needs a person",
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
  // The dataset's name could not be read (GitHub did not answer, or the file has no readable Name),
  // so the check needs a person until a start reads it or the file is fixed.
  "naming_unchecked",
]);

/**
 * The sentence for one of the gate's fixed words, or undefined for any other. Only the table's own
 * keys are words: `NOT_STARTED` is a plain object, so `constructor` or `toString` would otherwise
 * find an inherited function, and printing it would print that function's source.
 */
function gateWord(reason: string): string | undefined {
  return Object.hasOwn(NOT_STARTED, reason) ? NOT_STARTED[reason] : undefined;
}

/**
 * What a start that went is called. Every word that starts with `redispatched` is a commit started
 * again (`redispatched`, and `redispatched_after_edit`, which only a delivery says), so an equality
 * with the first would print the second as a first start.
 */
export function startedWord(r: StartReviewResponse): string {
  return r.reason.startsWith("redispatched") ? "started again" : "started";
}

/** Why a start did not start one, as the line `start` prints. Pure, so it is tested without a server. */
export function notStartedText(r: StartReviewResponse): string {
  const why = gateWord(r.reason) ?? plain(r.reason).replaceAll("_", " ");
  const hint =
    r.reason === "contributor_paused" && r.author_login
      ? ` (lift it with: nemar admin pr-reviews allow ${plain(r.author_login)})`
      : r.reason === "naming_rule"
        ? " (the author fixes the title or the name; to waive the rule for this commit: nemar admin pr-reviews allow <dataset> <pr> --admin --reason <why>)"
        : r.reason === "naming_unchecked"
          ? " (GitHub may not have answered, or dataset_description.json has no readable Name: run the same command once more, which reads the name again and posts the check it comes to; if it says the same, fix dataset_description.json and push, because nothing can be waived until the name can be read)"
          : "";
  return `not started: ${why}${hint}`;
}

prReviewsCommand
  .command("start [dataset] [pr]")
  .description(
    "Review a pull request that is already open, or start again one whose review ended without a verdict (or, with --redo, has a result)",
  )
  .option(
    "--all",
    "Every open pull request whose current commit has no review, or one that was declined or ended without a verdict (an owner's or administrator's is exempt and left out, unless a review of its current commit is on record; one refused for too many edits is left out too, and started by name)",
  )
  .option(
    "--redo",
    "Also start again a commit whose review already has a result (a second run, which costs model calls); with --all, the pull requests whose current commit has a pass, fail or uncertain review are included",
  )
  .option("--dry-run", "With --all: list what would be started and start nothing")
  .option("-y, --yes", "With --all: do not ask before starting")
  .option("--json", "Output JSON instead of text")
  .addHelpText(
    "after",
    `
The automated review runs when GitHub tells the NEMAR API that a pull request was opened, pushed to,
reopened or marked ready for review, or that its title, description or target branch was edited. A
pull request that was already open when the review was switched on produced no such event, so it has
no review until one of those happens to it. This asks for one by name. The API reads the pull request
from GitHub itself and runs it through the same gate as any other: an administrator's block on the
contributor still applies, and a pull request opened by a NEMAR owner or administrator is not
reviewed and nothing is started. Its check is posted all the same, as the naming rule decides:
skipped when the rule finds nothing (or an administrator waived it for this commit), failed when it
refuses the title or the new dataset name, and one that needs a person when the name could not be
read. No count of reviews, and no record of rejected pull requests, holds a start back. A commit
whose review was declined, ended in an error or never reported is started again, and so is one
handed to GitHub more than 60 minutes ago that never came back and that no job claimed in the last
50 minutes; one that is running or has a
result is not started again. A start that restarts a review that already ran costs a second run.
A commit whose review was refused for too many edits (five restarts by edits, reopenings and
markings as ready) is left out of --all, so that a bulk start never lifts the cap unasked; start it
by name, which starts its review and lifts the cap.

A finished review is not run again by anything but --redo, or by an edit of the pull request's title,
description or target branch, a reopening or a marking as ready (five of those at most for one commit).
--redo starts it again on the same review: its old result leaves the pull request's check while the new
run is going. A blocked contributor's pull request is not redone: the block is the answer and the
finished review stands. An owner's or administrator's pull request is still not reviewed unless a
review of its current commit is on record. A review that is running, or whose job has not had its
time yet, is never started again, so a redo waits for it. A redo leaves the count of edits as it is
(it is no edit), and costs a second run of up to two model calls. A bulk redo cannot be resumed:
running it again redoes the reviews that finished in between.

  nemar admin pr-reviews start nm000108 12
  nemar admin pr-reviews start nm000108 12 --redo
  nemar admin pr-reviews start --all --dry-run
  nemar admin pr-reviews start --all --yes
  nemar admin pr-reviews start --all --redo --dry-run

Each review is one run of up to two model calls: the screen, and then the review unless the screen
stops it as spam; a run the naming rule ends makes none. A blocked contributor is asked about like
any other and declined by the Worker, which says so; after 'allow', the same command starts it.
--all leaves drafts out and asks before spending (--yes skips that).
`,
  )
  .action(
    async (
      datasetArg: string | undefined,
      prArg: string | undefined,
      options: {
        all?: boolean;
        redo?: boolean;
        dryRun?: boolean;
        yes?: boolean;
        json?: boolean;
      },
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
        r = await startPrReview(dataset, pr, { redo: options.redo });
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
      // An older Worker ignores the flag: what it did is reported as it was (it starts a commit
      // that has no review, and says "already has a review" of one that has), and then the
      // command says the flag did nothing and fails.
      const ignored = options.redo === true && r.redo !== true;
      if (options.json) {
        console.log(JSON.stringify(ignored ? { ...r, redo_ignored: true } : r, null, 2));
        if (ignored) markReportedExit();
        if (ignored || (!r.dispatched && START_FAULTS.has(r.reason))) process.exit(1);
        return;
      }
      if (r.dispatched) {
        console.log(
          `${chalk.bold(`${dataset} #${pr}`)}  ${chalk.green(startedWord(r))}. ${chalk.dim("The pull request's check shows the review as running.")}`,
        );
      } else {
        const text = notStartedText(r);
        console.log(
          `${chalk.bold(`${dataset} #${pr}`)}  ${START_FAULTS.has(r.reason) ? chalk.red(text) : chalk.yellow(text)}`,
        );
      }
      envNote(r.environment);
      if (ignored) {
        console.log(chalk.red(REDO_IGNORED));
        // An answer about the Worker's version, not a fault in the command: no invitation to file a
        // bug. A fault the Worker also reported (a dispatch GitHub refused) keeps its own hint.
        if (r.dispatched || !START_FAULTS.has(r.reason)) markReportedExit();
        process.exit(1);
      }
      if (!r.dispatched && START_FAULTS.has(r.reason)) process.exit(1);
    },
  );

/** What one pull request of a `--all` run came to, in the JSON too. */
type StartResult =
  | (StartReviewResponse & { dataset_id: string; pr_number: number })
  | { dataset_id: string; pr_number: number; error: string };

/**
 * The question `start --all` asks before it spends: how many pull requests, and what a review of
 * one costs, which is a run of up to two model calls (a run the screen or the naming rule ends
 * makes fewer).
 */
export function startAllQuestion(count: number, redo = false): string {
  const some = `${count} pull request${count === 1 ? "" : "s"}`;
  return redo
    ? `Start or redo the automated review of ${some}, finished reviews included? Each is one run of up to two model calls.`
    : `Start the automated review of ${some}? Each is one run of up to two model calls.`;
}

/** What `start --redo` says when the Worker answered without the echo that says it honored the flag. */
export const REDO_IGNORED =
  "This Worker does not know --redo yet, so it ignored the flag: a finished review was not redone (a commit with no review was started as usual). Deploy the Worker, or run this against an environment that has it, then run the command again.";

/** The queue verdicts `start --all` takes up: a current commit with no review, or one that ended without a verdict. */
export const START_VERDICTS: QueueVerdict[] = ["not_reviewed", "could_not_decide"];

/**
 * With `--redo` the commits whose review has a result join them. A review in progress is not one
 * (a redo never supersedes a running review) and an exempt pull request has none to redo.
 */
export const REDO_VERDICTS: QueueVerdict[] = [...START_VERDICTS, "pass", "fail", "uncertain"];

/** Whether an entry's current commit has a finished review: the ones only a redo takes up. */
function isFinished(e: Pick<QueueEntry, "verdict">): boolean {
  return !START_VERDICTS.includes(e.verdict);
}

/** Whether the review of an entry's current commit was refused at the cap on restarts by edits. */
function isCapped(e: Pick<QueueEntry, "verdict" | "detail">): boolean {
  return e.verdict === "could_not_decide" && e.detail === "edit_limit";
}

/**
 * Sort the queue's entries for a `--all` run: drafts are left out, so are the commits capped for
 * edits (starting one begins the count again, which a bulk start must not do unasked), and what is
 * left is the verdicts the run takes up. Filtering by verdict here as well as in the request keeps
 * a review in progress and an exempt pull request out of a redo whatever the Worker returns.
 */
export function splitStartCandidates<E extends Pick<QueueEntry, "draft" | "verdict" | "detail">>(
  entries: E[],
  redo: boolean,
): { drafts: E[]; capped: E[]; todo: E[] } {
  const wanted = new Set<QueueVerdict>(redo ? REDO_VERDICTS : START_VERDICTS);
  const drafts = entries.filter((e) => e.draft);
  const live = entries.filter((e) => !e.draft && wanted.has(e.verdict));
  return {
    drafts,
    capped: live.filter((e) => isCapped(e)),
    todo: live.filter((e) => !isCapped(e)),
  };
}

/** The `--all` run: list, show, ask, then start one at a time. */
async function startAll(options: {
  redo?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
}): Promise<void> {
  const json = options.json === true;
  const redo = options.redo === true;
  const spinner = json ? null : ora("Reading the open pull requests...").start();
  let q: QueueResponse;
  try {
    q = await listPrReviews({ verdicts: redo ? REDO_VERDICTS : START_VERDICTS });
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

  // A commit whose review was refused at the cap on restarts by edits is left out. Starting it
  // starts the review and begins the count again, which is the one thing a bulk start must not do
  // without being asked: an administrator starts it by name and so means it.
  const { drafts, capped, todo } = splitStartCandidates(q.entries, redo);
  const finished = todo.filter(isFinished);
  const incomplete = q.truncated || q.skipped.unreadable > 0;
  const common = {
    environment: q.environment,
    redo,
    drafts: drafts.length,
    // The commits left out for the cap, by name, so a script sees what it has to start itself.
    capped: capped.map((e) => ({
      dataset_id: e.dataset_id,
      pr_number: e.pr_number,
      author_login: e.author_login,
    })),
    truncated: incomplete,
  };

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
          redo
            ? `${todo.length} pull request${todo.length === 1 ? "" : "s"} to start or redo (${finished.length} with a finished review of the current commit, the rest waiting for one)`
            : `${todo.length} pull request${todo.length === 1 ? "" : "s"} waiting for a review (none of the current commit, or one that was declined or ended without a verdict)`,
        ),
      );
      for (const e of todo) {
        const mark = isFinished(e) ? `  ${chalk.yellow(`finished: ${e.verdict}`)}` : "";
        console.log(
          `  ${e.dataset_id} #${e.pr_number}  ${plain(e.author_login)}  ${chalk.dim(clip(e.title, 60))}${mark}`,
        );
      }
    }
    if (drafts.length > 0) {
      console.log(chalk.dim(`${drafts.length} draft${drafts.length === 1 ? "" : "s"} left out.`));
    }
    if (capped.length > 0) {
      console.log();
      console.log(
        chalk.yellow(
          `${capped.length} left out, capped by too many edits (the most one commit gets): starting one by name starts its review and lifts the cap.`,
        ),
      );
      for (const e of capped) {
        console.log(
          `  ${e.dataset_id} #${e.pr_number}  ${plain(e.author_login)}  ${chalk.dim(`capped: nemar admin pr-reviews start ${e.dataset_id} ${e.pr_number}`)}`,
        );
      }
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
    if (json) console.log(JSON.stringify({ ...common, results: [], failed: 0 }, null, 2));
    return;
  }
  if (options.dryRun) {
    if (json) {
      const would = todo.map((e) => ({
        dataset_id: e.dataset_id,
        pr_number: e.pr_number,
        author_login: e.author_login,
        // Under --redo, which of them have a finished review that would be spent again.
        ...(redo ? { verdict: e.verdict } : {}),
      }));
      console.log(JSON.stringify({ ...common, dry_run: true, would_start: would }, null, 2));
    } else {
      console.log(chalk.dim("\nThis was a dry run: nothing was started."));
    }
    return;
  }
  if (!json) console.log();
  const go = await confirm(startAllQuestion(todo.length, redo), { yes: options.yes });
  if (go !== "confirmed") {
    // Not on stdout under --json, which is read as one document.
    (json ? console.error : console.log)("Cancelled.");
    process.exit(1);
  }

  const results: StartResult[] = [];
  let failed = 0;
  // An older Worker ignores the flag. The first answer without the echo says so: it is kept like
  // any other (the Worker may have started the commit, which has no review), the run stops there so
  // that nothing more is asked of a Worker that cannot do what was asked, and the end reports both.
  let redoIgnored = false;
  for (const e of todo) {
    const label = `${e.dataset_id} #${e.pr_number}`;
    try {
      const r = await startPrReview(e.dataset_id, e.pr_number, { redo });
      results.push({ ...r, dataset_id: e.dataset_id, pr_number: e.pr_number });
      if (!json) {
        console.log(
          `  ${label}  ${r.dispatched ? chalk.green(startedWord(r)) : chalk.yellow(notStartedText(r))}`,
        );
      }
      if (redo && r.redo !== true) {
        redoIgnored = true;
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
    console.log(
      JSON.stringify(
        { ...common, results, failed, ...(redoIgnored ? { redo_ignored: true } : {}) },
        null,
        2,
      ),
    );
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
    envNote(q.environment);
    if (redoIgnored) {
      const left = todo.length - results.length;
      console.log(
        chalk.red(
          left > 0
            ? `${REDO_IGNORED} ${left} pull request${left === 1 ? " was" : "s were"} not tried.`
            : REDO_IGNORED,
        ),
      );
    }
  }
  // An answer about the Worker's version, not a fault in the command: no invitation to file a bug.
  if (redoIgnored && failed === 0) markReportedExit();
  const faulted = results.some((r) => "reason" in r && !r.dispatched && START_FAULTS.has(r.reason));
  if (failed > 0 || faulted || redoIgnored) process.exit(1);
}

// -- approve ------------------------------------------------------------------------------------

/** What the administrator can do about a merge that would not be attempted, in the words of the command that says it. */
function mergeAdvice(
  advice: MergeAdvice,
  how: "approve" | "next",
  at: { dataset: string; pr: number },
): string | null {
  if (advice === "none") return null;
  // In `next` a refused card is pinned to the head it was shown for, and when y is not offered
  // typing it does not look again, so the only way to look again is a fresh run.
  if (advice === "retry" || advice === "rerun") {
    if (how === "next") {
      return "s skips it; run 'nemar admin pr-reviews next' again to look again.";
    }
    return advice === "retry"
      ? "Run the same command again in a moment."
      : "Run the same command again to read it as it is now.";
  }
  return how === "approve"
    ? "To approve without merging, run it again without --merge. The merge is then yours to make on GitHub."
    : `To approve it without merging, run: nemar admin pr-reviews approve ${at.dataset} ${at.pr}   (without --merge). Here, s leaves it and c comments.`;
}

/** End `approve --merge` because a merge could not be asked for: nothing has been written. */
function refuseMerge(merge: MergeRefused, at: { dataset: string; pr: number }): never {
  return die(
    `${merge.why} Nothing was approved or merged.`,
    mergeAdvice(merge.advice, "approve", at) ?? undefined,
  );
}

prReviewsCommand
  .command("approve <dataset> <pr>")
  .description("Approve a pull request as YOURSELF (your GitHub login); merges only with --merge")
  .option(
    "--merge",
    "Merge it after approving, once (refused before anything is approved unless GitHub reports it clean)",
  )
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

      // A merge that was asked for is only worth an approval if it can be made, so GitHub's word on
      // that comes BEFORE anything is written (ADR 0093). The look after the approval stays, for a
      // state that changes in between, but it can only leave an approval standing.
      if (options.merge) {
        const merge = await checkMergeable(token, dataset, pr, live, { base });
        if (!merge.ok) refuseMerge(merge, { dataset, pr });
      }

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

      // The confirmation can take as long as the administrator takes, and an approval cannot be
      // taken back: look at the state once more right before writing it.
      if (options.merge) {
        const late = await recheckBeforeApproval(token, dataset, pr, head, { base });
        if (!late.ok) refuseMerge(late, { dataset, pr });
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
        // What GitHub said when the pull request was read, so the advice is not one `--merge` would
        // refuse. A state that may clear (unknown) still gets the usual advice.
        const wouldMerge = mergeCheckOf(live.mergeableState);
        console.log(
          chalk.dim(
            !wouldMerge.ok && wouldMerge.advice === "without_merge"
              ? `  It is not merged. ${wouldMerge.why} Merge it on GitHub when you decide to.`
              : "  It is not merged. Run approve again with --merge (this records another approval), or merge it on GitHub.",
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
  if (a.verdict === "exempt") {
    return "A NEMAR owner or administrator opened this pull request, so it is not reviewed.";
  }
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
      required checks are green and GitHub reports the pull request clean; a failing, running or
      unreadable review also needs --force. A pull request the automated review holds is expected
      to be reported 'unstable', so y is not offered: nothing is approved from here. Approve it
      without merging with 'nemar admin pr-reviews approve <dataset> <pr>', or leave it with s.
  n   close it. You are asked for a comment, which is posted first so the author sees why.
  c   comment on it and leave it open. You are asked for the comment.
  d   show the whole report, then ask again.
  s   leave it for now (it is not shown again in this run).   q   stop.

An empty comment cancels the n or c and asks again, and a comment is one line. The squash merge is
attempted once, after GitHub has reported the pull request clean (checked before the approval is
written), exactly as for 'approve --merge'.
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
        // `y` merges, so it is offered only when GitHub says the pull request is clean. GitHub works
        // that out lazily and the read above may have started it, so an `unknown` is asked about
        // again; one that stays unknown, cannot be read or finds another head is not clean, and the
        // card says which.
        const merge = await checkMergeable(session.token, e.dataset_id, e.pr_number, a.live, {
          base,
        });
        const allowed = approveAllowed({
          gate: a.gate,
          force: options.force === true,
          bids,
          version,
          merge,
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
        if (!merge.ok) console.log(chalk.yellow(`  Merge:    ${merge.card}`));
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
          // `next` always merges when it approves, so approving without merging is `approve`.
          const advice = merge.ok
            ? null
            : mergeAdvice(merge.advice, "next", { dataset: e.dataset_id, pr: e.pr_number });
          if (advice) console.log(chalk.dim(`  ${advice}`));
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
            // The card was built some time ago: look at the state once more right before the approval.
            const late = await recheckBeforeApproval(
              session.token,
              e.dataset_id,
              e.pr_number,
              a.head,
              { base },
            );
            if (!late.ok) {
              console.log(chalk.yellow(`  Not approved: ${late.why}`));
              const advice = mergeAdvice(late.advice, "next", {
                dataset: e.dataset_id,
                pr: e.pr_number,
              });
              if (advice) console.log(chalk.dim(`  ${advice}`));
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
          const extra = await reader.discardTyped(PASTE_SETTLE_MS);
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

/** Set a contributor's allow or block, and say what it means. */
async function setContributor(
  mode: "allow" | "block",
  loginArg: string,
  options: { reason?: string; json?: boolean },
): Promise<void> {
  const login = checkLogin(loginArg, options.json);
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
            `Allowed ${plain(r.standing.login)}: their pull requests are reviewed automatically.`,
          )
        : chalk.red(
            `Blocked ${plain(r.standing.login)}: none of their pull requests is reviewed automatically; each needs a person.`,
          ),
    );
    if (r.previous && r.previous !== mode)
      console.log(chalk.dim(`  (it was ${r.previous} before)`));
    if (mode === "allow") {
      console.log(
        chalk.dim(
          "  A pull request already opened is reviewed when it is pushed to, edited, reopened or marked ready for review, or when an administrator starts its review.",
        ),
      );
    }
    console.log();
    for (const l of standingLines(r.standing)) console.log(l);
    envNote(r.environment);
  } catch (err) {
    failApi(err, spinner, `Could not ${mode} ${login}`, options.json);
  }
}

/** What the naming rule found on a commit, in the words the check uses, for the terminal. */
export function namingFactLines(facts: NamingFacts | null): string[] {
  if (facts === null) return [];
  const out: string[] = [];
  if (facts.title === "author_year" || facts.title === "doi") {
    out.push("the title has a citation (an author and a year, or a DOI)");
  }
  if (facts.title === "template_field") out.push("the title has an unfilled template field");
  if (facts.name === "author_year" || facts.name === "doi") {
    out.push(
      "the pull request changes the dataset name to one that has a citation (an author and a year, or a DOI)",
    );
  }
  if (facts.name === "template_field") {
    out.push("the pull request changes the dataset name to one with an unfilled template field");
  }
  if (facts.name === "unchecked") out.push("the dataset name could not be read to be checked");
  return out;
}

/**
 * What a waiver came to, in plain sentences. Pure, so it is tested without a server. Nothing in it
 * is trusted to be plain: the dataset, the commit and the word the server sent are cleaned here, and
 * a word longer than a word has any reason to be is cut.
 */
export function waiverLines(r: WaiveNamingResponse, dataset: string, pr: number): string[] {
  const at = r.head_sha ? ` at ${short(r.head_sha)}` : "";
  const label = `${plain(dataset)} #${pr}${at}`;
  switch (r.reason) {
    case "waived": {
      const found = namingFactLines(r.facts);
      return [
        chalk.green(`Waived the naming rule for ${label}.`),
        ...(found.length > 0 ? [`  The rule found: ${found.join("; ")}.`] : []),
        chalk.dim(
          "  Its check is posted as skipped (not required) and says the rule was waived. The waiver is recorded with your reason, and it is for this commit only: a new commit is checked again.",
        ),
      ];
    }
    case "already_waived":
      return [
        chalk.green(`The naming rule was already waived for ${label}.`),
        chalk.dim("  Its skipped check was posted again. Nothing new was recorded."),
      ];
    case "nothing_to_waive":
      return [
        chalk.green(
          `Nothing to waive: the title and the dataset name of ${label} pass the naming rule.`,
        ),
        chalk.dim("  Its check was posted as skipped (not required). Nothing was recorded."),
      ];
    case "not_exempt":
      return [
        chalk.yellow(`Not waived: the author of ${label} is not a NEMAR owner or administrator.`),
        chalk.dim(
          "  The override replaces only the exemption of owners and administrators. Anyone else's pull request is reviewed, and the naming rule is part of that review: its author fixes the title or the name, or an owner or administrator merges it in the GitHub UI.",
        ),
      ];
    case "reviewed":
      return [
        chalk.yellow(
          `Not waived: ${label} was reviewed (someone who is not exempt pushed it), and that review stands.`,
        ),
      ];
    case "naming_unchecked":
      return [
        chalk.yellow(
          `Not waived: the dataset name of ${label} could not be read, so there is nothing definite to waive.`,
        ),
        chalk.dim(
          "  A waiver covers only what the naming rule found. GitHub may not have answered, or dataset_description.json has no readable Name. Run the same command once more; if it says the same, fix dataset_description.json and push, and the new commit is checked.",
        ),
      ];
    default: {
      const why = gateWord(r.reason) ?? clip(plain(r.reason).replaceAll("_", " "), 80);
      return [chalk.yellow(`Not waived: ${why}.`)];
    }
  }
}

/** The first seven to forty characters of a commit id, the way `git log --oneline` shortens one. */
const COMMIT_PREFIX_RE = /^[0-9a-fA-F]{7,40}$/;

/** The most of the Worker's `head_moved` sentence that is printed; its own is about 130 characters. */
const HEAD_MOVED_MAX = 300;

/** Waive the naming rule for a pull request's current commit, and say what came of it. */
async function waiveNaming(
  datasetArg: string,
  prArg: string,
  reason: string,
  options: { commit?: string; json?: boolean },
): Promise<void> {
  const dataset = checkDataset(datasetArg, options.json);
  const pr = checkPr(prArg, options.json);
  if (options.commit !== undefined && !COMMIT_PREFIX_RE.test(options.commit)) {
    die(
      `"${plain(options.commit)}" is not a commit id: give its first 7 to 40 characters (hexadecimal).`,
      'nemar admin pr-reviews allow nm000108 12 --admin --commit 1a2b3c4 --reason "Name kept until the rename release"',
      options.json,
    );
  }
  const spinner = options.json
    ? null
    : ora(`Waiving the naming rule for ${dataset} #${pr}...`).start();
  let r: WaiveNamingResponse;
  try {
    r = await waivePrReviewNaming(dataset, pr, reason, options.commit);
    spinner?.stop();
  } catch (err) {
    if (err instanceof ApiError && errorWord(err) === "no_such_pull_request") {
      spinner?.fail(`${dataset} #${pr}: GitHub has no such pull request.`);
      if (!spinner) say(options.json)(chalk.red("GitHub has no such pull request."));
      markReportedExit();
      process.exit(1);
    }
    if (err instanceof ApiError && errorWord(err) === "head_moved") {
      // An answer about the pull request, not a fault: the commit named is no longer its head. The
      // Worker's sentence is short; a longer one is some other server's, and is cut like any word.
      const said = clip(err.message, HEAD_MOVED_MAX);
      spinner?.fail(said);
      if (!spinner) say(options.json)(chalk.red(said));
      markReportedExit();
      process.exit(1);
    }
    failApi(err, spinner, "Could not waive the naming rule", options.json);
  }
  if (options.json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    for (const l of waiverLines(r, dataset, pr)) console.log(l);
    envNote(r.environment);
  }
  // Not waived is an answer about the pull request, not a fault, but a script must be able to tell.
  if (!r.waived && r.reason !== "nothing_to_waive") process.exit(1);
}

prReviewsCommand
  .command("allow <subject> [pr]")
  .description(
    "Lift a block on a contributor (allow <login>), or, with --admin, waive the naming rule for an owner's or administrator's pull request (allow <dataset> <pr> --admin --reason <why>)",
  )
  .option(
    "--admin",
    "Waive the naming rule for <dataset> <pr> at its current commit: an explicit override, recorded with your reason",
  )
  .option(
    "--reason <text>",
    "Why, in plain words (up to 200 characters; kept with the decision). Required with --admin",
  )
  .option(
    "--commit <sha>",
    "With --admin: the commit you looked at (its first 7 to 40 characters); a pull request that has moved on is not waived",
  )
  .option("--json", "Output the raw JSON")
  .addHelpText(
    "after",
    `
allow <login>
  Lift a block: review this contributor's pull requests again (nothing else pauses anyone). A NEMAR
  owner or administrator is exempt from the review whatever is decided here: their pull requests are
  not reviewed, so a block does not hold them back and an allow changes nothing. (A commit a review
  is already on record for is handled as before, a block included.)

allow <dataset> <pr> --admin
  Owners and administrators are exempt from the review, not from the naming rule: a pull request
  title that has a citation (an author and a year, as in Lee2019 EEG dataset, or a DOI) anywhere in
  it or holds an unfilled template field, and a change of the dataset's name to such a name, fail
  their check like anyone's. This is the one way past it without a change: it waives the rule for
  the pull request's CURRENT commit, records the waiver (who, the commit, what the rule found, and
  your --reason, which is required), and posts the check as skipped with a line saying the rule was
  waived. A new commit is checked again. It is refused for a pull request whose author is not an
  owner or administrator (their review includes the rule) and for a commit that was reviewed.

  Name the commit you looked at with --commit <sha> (its first 7 to 40 characters, as git log
  --oneline shows them). If the pull request has been pushed to since, nothing is waived or posted
  and the command says so. Without it, whatever the pull request's current commit is gets waived,
  and the answer says which one.

  nemar admin pr-reviews allow nm000108 12 --admin --commit 1a2b3c4 --reason "Name kept until the rename release"
`,
  )
  .action(
    async (
      subject: string,
      prArg: string | undefined,
      options: { admin?: boolean; reason?: string; commit?: string; json?: boolean },
    ) => {
      if (!requireAuth(options.json)) process.exit(1);
      if (options.reason && options.reason.length > MAX_REASON) {
        die(
          `The reason is ${options.reason.length} characters; ${MAX_REASON} is the most that is kept.`,
          undefined,
          options.json,
        );
      }
      if (options.commit !== undefined && !options.admin) {
        die(
          "--commit goes with --admin: it names the commit of a pull request whose naming rule is waived.",
          'nemar admin pr-reviews allow nm000108 12 --admin --commit 1a2b3c4 --reason "Name kept until the rename release"',
          options.json,
        );
      }
      if (options.admin) {
        if (prArg === undefined) {
          die(
            "--admin waives the naming rule for one pull request: give a dataset and a pull request number.",
            'nemar admin pr-reviews allow nm000108 12 --admin --reason "Name kept until the rename release"',
            options.json,
          );
        }
        const reason = options.reason?.trim() ?? "";
        if (reason === "") {
          die(
            "--admin needs --reason: say, in plain words, why the naming rule is waived. It is recorded with the waiver.",
            'nemar admin pr-reviews allow nm000108 12 --admin --reason "Name kept until the rename release"',
            options.json,
          );
        }
        await waiveNaming(subject, prArg, reason, options);
        return;
      }
      if (prArg !== undefined) {
        die(
          "A contributor is named by a login alone. To waive the naming rule for a pull request, add --admin.",
          'nemar admin pr-reviews allow nm000108 12 --admin --reason "Name kept until the rename release"',
          options.json,
        );
      }
      await setContributor("allow", subject, options);
    },
  );

prReviewsCommand
  .command("block <login>")
  .description("Never review this contributor's pull requests automatically; each needs a person")
  .option("--reason <text>", "Why, in plain words (up to 200 characters; kept with the decision)")
  .option("--json", "Output the raw JSON")
  .addHelpText(
    "after",
    `
A NEMAR owner or administrator is exempt from the review whatever is decided here: their pull
requests are not reviewed, so a block does not hold them back and an allow changes nothing. (A
commit a review is already on record for is handled as before, a block included.)
`,
  )
  .action(async (loginArg: string, options: { reason?: string; json?: boolean }) => {
    if (!requireAuth(options.json)) process.exit(1);
    if (options.reason && options.reason.length > MAX_REASON) {
      die(
        `The reason is ${options.reason.length} characters; ${MAX_REASON} is the most that is kept.`,
        undefined,
        options.json,
      );
    }
    await setContributor("block", loginArg, options);
  });

prReviewsCommand
  .command("clear <login>")
  .description("Remove an allow or block (a contributor with neither is reviewed automatically)")
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
              `Removed the ${r.removed} for ${plain(r.standing.login)}. Their pull requests are reviewed automatically.`,
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
    "A contributor's record of rejected pull requests (information only), and any allow or block",
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
