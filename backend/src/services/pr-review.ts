/**
 * The dataset pull-request review, Worker side (ADR 0092).
 *
 * A pull request opened or updated against `main` of a dataset repository reaches the Worker as a
 * `pull_request` delivery from the NEMAR GitHub App (once the App is subscribed to those events).
 * The Worker decides whether to review it, records the attempt in `pr_reviews`, and dispatches a
 * workflow to `nemarDatasets/.github`. The workflow CLAIMS the review (the Worker accepts the
 * one-shot token and records the time) before it spends anything, reads the change as git
 * data, applies the naming rule, and runs two model stages: a screen that may stop only spam, and a
 * review of the content. It posts a report back; the Worker validates it against the closed
 * vocabulary in `shared/pr-review.ts` (version 2 only, by callback), derives the verdict, and
 * publishes a check-run and one pull-request comment.
 *
 * **Why the Worker is the gate.** Every pull request reaches it, a fork's included, from a
 * delivery GitHub signs; no workflow in a dataset repository takes part, so no collaborator can
 * edit the review or reach the credentials it uses by editing a branch. It is also the only place
 * that knows who opened a pull request and whether an administrator has blocked them.
 * {@link gateDecision} is that decision, made once per delivery: exempt, then blocked, then
 * reviewed. **No count decides it** (ADR 0107): not how many reviews a contributor or the platform
 * started this hour or day, and not how many of a contributor's pull requests were rejected. Only
 * an administrator's block holds a contributor back. What bounds the cost is decided in that ADR
 * (a content screen first, and the workspace's spend limit), and the claim step is what makes a
 * forged `repository_dispatch` buy nothing, since anyone holding a dataset repository's workflow
 * credentials can send one.
 *
 * **Owners and administrators are not reviewed** (ADR 0107). A pull request opened by a NEMAR
 * owner or administrator, when an owner or administrator also caused the delivery (the push, the
 * reopening) and no review has yet touched that commit, is answered with a `skipped` check and
 * nothing else: no row, no model call. {@link isReviewExempt} decides from the accounts, never from
 * anything the pull request says, and before any row is written. A commit that already has a row
 * keeps what its review said, whoever acts on it next, when the delivery changes no text (a
 * force-push back to it, an administrator's start of a review that has a result): `skipped` is never
 * written over a review. The deliveries that do change the text are the exceptions, and they restart
 * the review of a commit that has a row, an exempt author's included: an edit, a reopening and a
 * marking as ready (below).
 * They are not exempt from the naming rule, which runs first: a title or a new dataset name it
 * refuses fails their check, and only an administrator's recorded waiver for that commit
 * (`nemar admin pr-reviews allow <dataset> <pr> --admin --reason <why>`) turns it back into
 * `skipped`.
 *
 * **An edit of the title, the body or the base re-runs the review** (ADR 0107). The job reads the
 * pull request from the API when it starts, so a review describes the text as it was then, and an
 * author who fixes a title or a description has to be judged on the fix. An `edited` delivery that
 * names `title`, `body` or `base` in `changes` (keys only, never the old text) restarts the review of
 * the commit it is on from any state, a running one and a stored result included
 * ({@link restartReview} rotates the nonce, so the superseded job's claim and report are refused).
 * A job that had already claimed is not stopped: it still spends its model call before its report is
 * refused, so superseding a claimed review costs that run in full, while one that never claimed
 * spends nothing. Only a commit with no row is a new delivery (an owner's or administrator's takes
 * the exempt path above); a commit with a row is restarted, an edit that moves the base onto `main`
 * included. A base moved off `main` is not a pull request this review applies to and is ignored
 * like any other. An edit that names nothing else is ignored.
 *
 * **A reopening and a marking as ready restart it too**, because an edit made while the pull
 * request was closed or a draft was not taken up (it is not open, or is a draft, as for any
 * delivery) and the first delivery after it is one of these two (`PrIntake.resumed`). The comment
 * the pull request carries keeps the last completed review's text until the new result lands, while
 * the check shows running: a running review publishes its check only.
 *
 * **Five such restarts are allowed for one head commit, and the sixth is refused** (ADR 0107,
 * decision 4; the owner set the number, {@link PR_REVIEW_EDIT_CAP}). {@link restartReview} counts
 * them in `pr_reviews.edit_restarts`, an administrator's start resets the count, and a push is a new
 * row. {@link refuseEdit} fails closed: the row becomes an errored review with the detail
 * `edit_limit`, a running review or a stored result superseded, and every later change only
 * restates it. A restart a race made fail is tried again (up to three tries) and counts once. The
 * cap is asked after the gate, so a contributor an administrator has blocked is declined and not
 * told "too many edits", and a declined restart is not counted.
 *
 * **A publish is checked against the row once GitHub has answered** ({@link publishOutcome}): a slow
 * write that lands after a newer result must not leave the older one on the pull request.
 *
 * **Nothing here trusts the pull request.** The event is read by {@link readPullRequestEvent},
 * which accepts only the shapes it expects; the dispatch carries the review's coordinates and not
 * the pull request's text; the report that comes back goes through `parsePrReviewReport` before a
 * byte is stored; and the check and comment are rendered from the parsed report, never from the
 * request body.
 *
 * **Unknown is never green.** A review that was declined, errored, or never reported is published
 * as `action_required`, which GitHub does not count as passing for a required check. A result that
 * could not be published is recorded as unpublished (`published_at` NULL) and the watchdog
 * publishes it again, so a GitHub outage delays a check and never leaves it "in progress".
 *
 * Database failures inside {@link handlePullRequestEvent} throw: the webhook route answers 500 so
 * the delivery shows as failed in the App's delivery log, where it can be redelivered. So does an
 * exempt pull request's check that could not be published, which has no row for the watchdog to
 * retry from. Redelivery of a reviewed commit is safe because (dataset, pull request, commit) is
 * unique; redelivery of an exempt commit is safe because a second `skipped` check is harmless. A
 * redelivered edit starts the review again, which supersedes the first, costs one more run and
 * counts toward the cap.
 */

import {
  type AuthorOverride,
  type AuthorTally,
  type CallbackOutcome,
  PR_REVIEW_EDIT_CAP,
  PrReviewReportError,
  type ProducedDeclineReason,
  type ReviewOutcome,
  type ReviewState,
  type StoredOutcome,
  conclusionOf,
  isDeclineReason,
  isOverrideMode,
  isRunError,
  parseStoredPrReviewReport,
  renderCheck,
  renderComment,
  standingOf,
  verdictOf,
} from "../../../shared/pr-review.js";
import type { Bindings } from "../types/bindings.js";
import { isValidDatasetId } from "./datasetId.js";
import { isNonProductionEnv } from "./environment.js";
import { getDatasetsToken, getDatasetsTokenWithRefresher } from "./github-auth.js";
import { signPrReviewCallbackToken } from "./github/callback-tokens.js";
import { approvalDispatchEnvironment, triggerPrReviewRun } from "./github/dispatch.js";
import { upsertReviewCheckRun, upsertReviewComment } from "./github/pr-review-api.js";
import { ORG_NAME } from "./github/shared.js";
import { isReviewExempt } from "./pr-review-exemption.js";
import {
  type NamingSubject,
  isNamingWaived,
  namingClean,
  namingFactsFor,
} from "./pr-review-naming.js";

/**
 * `pull_request` actions that put new content in front of a reviewer. `edited` is on the list and
 * is taken up only when it changed what the review reads (see {@link EDIT_KEYS}).
 */
export const PR_REVIEW_ACTIONS: ReadonlySet<string> = new Set([
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
  "edited",
]);

/**
 * The keys of an `edited` delivery's `changes` object that make an edit one the review must be run
 * for again (ADR 0107): the title and the body, which the review reads from the pull request, and
 * the base, which decides whether the pull request is reviewed at all. An edit that names none of
 * them (the milestone, say, or a label) changed nothing the review saw. Only the keys are looked
 * at; what they hold is the text from before the edit, and nothing here reads it.
 */
const EDIT_KEYS = ["title", "body", "base"] as const;

/** The branch whose pull requests are reviewed. */
export const PR_REVIEW_BASE_BRANCH = "main";

/**
 * How long a dispatched review may take, counted from when its row was recorded, before the
 * watchdog gives up on it. The review workflow's `timeout-minutes` (28) is kept below this, and the
 * job's worst case (the setup steps, both model stages at their deadlines, the callback's retries)
 * below that; a test in `test/pr-review-workflow.test.ts` checks both. The deadline runs from when
 * the row was recorded and the job's limit from when it starts, so the gap between them is the time
 * a dispatch may wait in GitHub's queue.
 */
export const PR_REVIEW_DEADLINE_MINUTES = 40;

/**
 * A result that did not reach GitHub is eligible to be tried again this long after it was decided,
 * up to {@link PUBLISH_MAX_ATTEMPTS} times. The watchdog runs on a 30-minute tick, so the real gap
 * between attempts is that tick, and five attempts take about two and a half hours.
 */
const PUBLISH_RETRY_AFTER_MINUTES = 2;
export const PUBLISH_MAX_ATTEMPTS = 5;

/** Rows the watchdog handles per query (it runs two: overdue reviews, and unpublished results). */
const SWEEP_LIMIT = 20;

/**
 * How many times an edit's restart is tried when the row moves under it (a result or the watchdog's
 * verdict landing between the read and the write), the first try included. Every try reads the row
 * again, so three is enough for any one writer to have finished, and the limit is what keeps a row
 * that keeps moving from holding the webhook.
 */
const EDIT_RESTART_TRIES = 3;

/** How long the dispatch may wait for GitHub before the Worker answers the webhook. */
const DISPATCH_TIMEOUT_MS = 10_000;

/**
 * How long a restart waits before it publishes the running check a second time, after the first
 * publish failed. Short, because the publish runs inside the webhook's own request.
 */
export const RUNNING_PUBLISH_RETRY_WAIT_MS = 1_000;

/** A review may only use a dataset that is currently a named public publication (ADR 0092). */
const REVIEWABLE_DATASET_PREDICATE = `d.status = 'active' AND d.visibility = 'public'
  AND d.anonymous = 0 AND d.first_published_at IS NOT NULL`;

type Db = D1Database;

/**
 * Whether a dataset may be reviewed: it exists and is a live, named, first-published publication.
 * Asked before anything about a pull request is read from GitHub when an administrator starts one.
 */
export async function reviewableDataset(
  db: Db,
  datasetId: string,
): Promise<"reviewable" | "unknown" | "not_reviewable"> {
  const dataset = await db
    .prepare(
      `SELECT CASE WHEN ${REVIEWABLE_DATASET_PREDICATE} THEN 1 ELSE 0 END AS reviewable
         FROM datasets AS d WHERE d.dataset_id = ?`,
    )
    .bind(datasetId)
    .first<{ reviewable: number }>();
  if (!dataset) return "unknown";
  return dataset.reviewable === 1 ? "reviewable" : "not_reviewable";
}

// ---------------------------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------------------------

export interface PrIntake {
  datasetId: string;
  prNumber: number;
  headSha: string;
  authorId: number;
  authorLogin: string;
  /**
   * GitHub's relationship label for the author, stored with the review for people to read. Nothing
   * in the gate reads it: it says CONTRIBUTOR for a private organization member, so it is no reason
   * to exempt or to reject anyone (ADR 0107).
   */
  authorAssociation: string | null;
  fromFork: boolean;
  /**
   * Who caused the delivery (GitHub's `sender`): whoever pushed, reopened or marked the pull
   * request ready. Null when the delivery names no one or a shape a login does not have, and for an
   * administrator's start, which is built from GitHub's record of the pull request and has no
   * sender. It is read only to decide the exemption, never shown or stored.
   */
  senderLogin: string | null;
  /**
   * The pull request's title, read for one purpose: the naming rule on an exempt pull request
   * (`pr-review-naming.ts`), which the review job applies to everyone else's from its own read of
   * the pull request. It is never shown, stored, logged or sent anywhere.
   */
  title: string;
  /** The base branch's commit GitHub named with the pull request, for the naming rule; or null. */
  baseSha: string | null;
  /**
   * The delivery is an edit of the title, the body or the base ({@link EDIT_KEYS}), not new
   * content. A commit that already has a review is started again for it, from whatever state it is
   * in, because the text the review judged has changed.
   */
  edited: boolean;
  /**
   * The delivery is a `reopened` or a `ready_for_review`: the pull request comes back into view
   * after a stretch in which edits were not taken up (a closed pull request, a draft), so an
   * earlier review of the commit may have judged text that is no longer the pull request's. A
   * commit that already has a review is started again for it, as for an edit.
   */
  resumed: boolean;
  /** The delivery's action (one of {@link PR_REVIEW_ACTIONS}), for the log line of a restart. */
  action: string;
}

/** Why a delivery was not taken up. Fixed words, safe to return and log. */
export type IntakeSkip =
  | "malformed"
  | "action_ignored"
  | "wrong_owner"
  | "not_a_dataset"
  | "not_main"
  | "not_open"
  | "draft"
  | "bot_author";

export type IntakeResult = { ok: true; pr: PrIntake } | { ok: false; reason: IntakeSkip };

const SHA40 = /^[0-9a-f]{40}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function rec(x: unknown): Record<string, unknown> | null {
  return typeof x === "object" && x !== null && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : null;
}

function posInt(x: unknown): number | null {
  return typeof x === "number" && Number.isSafeInteger(x) && x > 0 ? x : null;
}

/** Whether an `edited` delivery's `changes` names a key in {@link EDIT_KEYS}. Keys only. */
function changesWhatTheReviewReads(changes: unknown): boolean {
  const named = rec(changes);
  return named !== null && EDIT_KEYS.some((key) => Object.hasOwn(named, key));
}

/**
 * Read a `pull_request` delivery. Everything in it is attacker-influenced (the title, the branch
 * names, the fork's name). Only ids, the head and base commits, the base branch and fixed-shape
 * logins are read, each checked against the shape it must have, and the title, which only the
 * naming rule reads (see {@link PrIntake.title}). For an edit, the keys of `changes` are looked at
 * and what they hold, the text from before the edit, is not.
 */
export function readPullRequestEvent(payload: unknown): IntakeResult {
  const p = rec(payload);
  const pr = rec(p?.pull_request);
  const repo = rec(p?.repository);
  if (!p || !pr || !repo) return { ok: false, reason: "malformed" };
  if (typeof p.action !== "string" || !PR_REVIEW_ACTIONS.has(p.action)) {
    return { ok: false, reason: "action_ignored" };
  }
  // An edit counts only when it changed what the review reads. Anything else (a milestone, a
  // label, an edit that names nothing) puts nothing new in front of it.
  const edited = p.action === "edited";
  if (edited && !changesWhatTheReviewReads(p.changes)) {
    return { ok: false, reason: "action_ignored" };
  }
  const owner = rec(repo.owner);
  if (
    typeof owner?.login !== "string" ||
    owner.login.toLowerCase() !== ORG_NAME.toLowerCase() ||
    typeof repo.full_name !== "string"
  ) {
    return { ok: false, reason: "wrong_owner" };
  }
  if (typeof repo.name !== "string" || !isValidDatasetId(repo.name)) {
    return { ok: false, reason: "not_a_dataset" };
  }
  const base = rec(pr.base);
  if (typeof base?.ref !== "string" || base.ref !== PR_REVIEW_BASE_BRANCH) {
    return { ok: false, reason: "not_main" };
  }
  if (pr.state !== "open" || pr.merged === true) return { ok: false, reason: "not_open" };
  if (pr.draft === true) return { ok: false, reason: "draft" };

  const head = rec(pr.head);
  const user = rec(pr.user);
  const prNumber = posInt(pr.number);
  const authorId = posInt(user?.id);
  // GitHub always sends a title. One that is not a string is a delivery this cannot read, and the
  // naming rule must never take it for a clean one.
  if (
    prNumber === null ||
    authorId === null ||
    typeof head?.sha !== "string" ||
    !SHA40.test(head.sha) ||
    typeof user?.login !== "string" ||
    typeof pr.title !== "string"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (user.type === "Bot" || user.login.endsWith("[bot]")) {
    return { ok: false, reason: "bot_author" };
  }
  if (!LOGIN.test(user.login)) return { ok: false, reason: "malformed" };

  // A deleted fork leaves `head.repo` null; that is a fork. Same-repo branches name the base repo.
  const headRepo = rec(head.repo);
  const fromFork =
    typeof headRepo?.full_name !== "string" ||
    headRepo.full_name.toLowerCase() !== repo.full_name.toLowerCase();

  // The sender of a bot (`name[bot]`) is not a login, so it reads as no sender at all, and an
  // exemption never rests on one.
  const sender = rec(p.sender);

  return {
    ok: true,
    pr: {
      datasetId: repo.name,
      prNumber,
      headSha: head.sha,
      authorId,
      authorLogin: user.login,
      authorAssociation: typeof pr.author_association === "string" ? pr.author_association : null,
      fromFork,
      senderLogin:
        typeof sender?.login === "string" && LOGIN.test(sender.login) ? sender.login : null,
      title: pr.title,
      baseSha: typeof base.sha === "string" && SHA40.test(base.sha) ? base.sha : null,
      edited,
      resumed: p.action === "reopened" || p.action === "ready_for_review",
      action: p.action,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The gate: who is reviewed
// ---------------------------------------------------------------------------------------------

/**
 * The tally for one contributor, counted from the reviews themselves. It is shown to
 * administrators and decides nothing (see `AuthorTally`).
 *
 * `decided` is the number of distinct pull requests with at least one decided (pass or fail)
 * review; `rejected` is how many of those were most recently decided as a fail. Counting the
 * LATEST decided review of each pull request means a contributor who fixes a rejected pull
 * request is not punished for iterating, and five pushes to one bad pull request are one
 * rejection, not five. "Latest" is the last commit SEEN (`seen_at`), not the highest row id, so
 * force-pushing back to an earlier reviewed commit makes that commit's result the current one.
 */
export const AUTHOR_TALLY_SQL = `
  WITH latest AS (
    SELECT verdict,
           ROW_NUMBER() OVER (PARTITION BY dataset_id, pr_number ORDER BY seen_at DESC, id DESC) AS rn
      FROM pr_reviews
     WHERE author_id = ? AND state = 'reported' AND verdict IN ('pass', 'fail')
  )
  SELECT COUNT(*) AS decided,
         COALESCE(SUM(CASE WHEN verdict = 'fail' THEN 1 ELSE 0 END), 0) AS rejected
    FROM latest
   WHERE rn = 1`;

export async function readAuthorTally(db: Db, authorId: number): Promise<AuthorTally> {
  const row = await db
    .prepare(AUTHOR_TALLY_SQL)
    .bind(authorId)
    .first<{ decided: number; rejected: number }>();
  return { decided: row?.decided ?? 0, rejected: row?.rejected ?? 0 };
}

export async function readAuthorOverride(db: Db, authorId: number): Promise<AuthorOverride> {
  const row = await db
    .prepare("SELECT mode FROM pr_review_overrides WHERE author_id = ?")
    .bind(authorId)
    .first<{ mode: string }>();
  return isOverrideMode(row?.mode) ? row.mode : null;
}

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

interface ReviewRow {
  id: number;
  datasetId: string;
  prNumber: number;
  headSha: string;
  state: ReviewState;
  detail: string | null;
  report: string | null;
  checkRunId: number | null;
  commentId: number | null;
  claimedAt: string | null;
  /** Restarts an edit, a reopening or a marking as ready has caused for this commit (the cap's count). */
  editRestarts: number;
  /** The standing a publish is of: with `state`, `detail` and `report`, what {@link sameStanding} compares. */
  verdict: string | null;
  decidedAt: string | null;
}

interface RawRow {
  id: number;
  dataset_id: string;
  pr_number: number;
  head_sha: string;
  state: ReviewState;
  detail: string | null;
  report: string | null;
  check_run_id: number | null;
  comment_id: number | null;
  claimed_at: string | null;
  edit_restarts: number;
  verdict: string | null;
  decided_at: string | null;
}

const ROW_COLUMNS =
  "id, dataset_id, pr_number, head_sha, state, detail, report, check_run_id, comment_id, claimed_at, edit_restarts, verdict, decided_at";

function toRow(r: RawRow): ReviewRow {
  return {
    id: r.id,
    datasetId: r.dataset_id,
    prNumber: r.pr_number,
    headSha: r.head_sha,
    state: r.state,
    detail: r.detail,
    report: r.report,
    checkRunId: r.check_run_id,
    commentId: r.comment_id,
    claimedAt: r.claimed_at,
    editRestarts: r.edit_restarts,
    verdict: r.verdict,
    decidedAt: r.decided_at,
  };
}

async function readRow(db: Db, id: number): Promise<ReviewRow | null> {
  const r = await db
    .prepare(`SELECT ${ROW_COLUMNS} FROM pr_reviews WHERE id = ?`)
    .bind(id)
    .first<RawRow>();
  return r ? toRow(r) : null;
}

async function readRowByKey(
  db: Db,
  datasetId: string,
  prNumber: number,
  headSha: string,
): Promise<ReviewRow | null> {
  const r = await db
    .prepare(
      `SELECT ${ROW_COLUMNS} FROM pr_reviews WHERE dataset_id = ? AND pr_number = ? AND head_sha = ?`,
    )
    .bind(datasetId, prNumber, headSha)
    .first<RawRow>();
  return r ? toRow(r) : null;
}

/**
 * The outcome a stored row stands for, or null for a review still waiting for its report. A stored
 * report is read by the stored parser, which reads a version 1 report by its own rules, so a review
 * stored before the screen existed keeps the verdict it had.
 */
export function outcomeOfRow(
  row: Pick<ReviewRow, "id" | "datasetId" | "prNumber" | "state" | "detail" | "report">,
): StoredOutcome | null {
  if (row.state === "reported") {
    try {
      return {
        kind: "reported",
        report: parseStoredPrReviewReport(JSON.parse(row.report ?? "null")),
      };
    } catch (err) {
      // A stored report that no longer parses (the contract moved under it, or the column was
      // edited by hand) is shown as "could not decide". Anything else is a bug and surfaces.
      if (!(err instanceof PrReviewReportError || err instanceof SyntaxError)) throw err;
      console.error(
        `[pr-review] review ${row.id} (${row.datasetId}#${row.prNumber}): stored report refused (${errName(err)}${
          err instanceof PrReviewReportError ? `: ${err.code}` : ""
        })`,
      );
      return { kind: "error", error: "report_invalid" };
    }
  }
  if (row.state === "errored") {
    return { kind: "error", error: isRunError(row.detail) ? row.detail : "workflow_failed" };
  }
  if (row.state === "declined") {
    // The migration's CHECK keeps `detail` to the declined words; "paused" is only the fail-safe.
    return {
      kind: "declined",
      reason: isDeclineReason(row.detail) ? row.detail : "contributor_paused",
    };
  }
  if (row.state === "unreported") return { kind: "unreported" };
  return null;
}

/** The comment this pull request already carries, from any earlier review of it. */
async function existingCommentId(
  db: Db,
  datasetId: string,
  prNumber: number,
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT comment_id FROM pr_reviews
        WHERE dataset_id = ? AND pr_number = ? AND comment_id IS NOT NULL
        ORDER BY seen_at DESC, id DESC LIMIT 1`,
    )
    .bind(datasetId, prNumber)
    .first<{ comment_id: number }>();
  return row?.comment_id ?? null;
}

/** True when this row is the last commit of its pull request that was seen. */
async function isLatestReview(db: Db, row: ReviewRow): Promise<boolean> {
  const latest = await db
    .prepare(
      `SELECT id FROM pr_reviews WHERE dataset_id = ? AND pr_number = ?
        ORDER BY seen_at DESC, id DESC LIMIT 1`,
    )
    .bind(row.datasetId, row.prNumber)
    .first<{ id: number }>();
  return latest?.id === row.id;
}

const NOW_MS = "strftime('%Y-%m-%d %H:%M:%f', 'now')";

function errName(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 120) : "unknown";
}

// ---------------------------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------------------------

/**
 * How many times one {@link publishOutcome} may publish, the first included: it publishes again
 * when the row moved while it was publishing, and gives up after this many and leaves the result
 * unpublished, so the watchdog's sweep takes over. Three is enough for one other writer to have
 * finished, and the limit keeps a row that keeps moving from holding the request.
 */
const PUBLISH_ROUNDS = 3;

/**
 * Whether two reads of a row stand for the same thing on the pull request: the same state, the
 * same decision time, the same verdict, reason and report. A restart of a running review changes
 * none of them (it clears nothing a check shows), so a review that was started again while its
 * running check was published is not a move.
 */
function sameStanding(a: ReviewRow, b: ReviewRow): boolean {
  return (
    a.state === b.state &&
    a.decidedAt === b.decidedAt &&
    a.verdict === b.verdict &&
    a.detail === b.detail &&
    a.report === b.report
  );
}

/**
 * Publish an outcome to GitHub: the check-run on the reviewed commit, and (for any outcome but
 * `running`, and only while this is still the last commit of the pull request seen) the
 * pull-request comment. Each surface fails on its own and is logged by status; neither can lose
 * the stored verdict. Returns whether the check-run reached GitHub: a decided outcome whose check
 * did is marked published; one that did not stays unpublished and the watchdog tries again.
 * `running` is bounded (it runs inside the webhook request) and publishes the in-progress check
 * only. `commentOnly` re-states a stored result on the pull request without touching the check.
 *
 * **A publish is a read of the row, and the row can move while GitHub is being written to.** A
 * callback stores a pass and starts updating the check; the sixth edit refuses the row and
 * publishes the refusal; the callback's slower update lands last, and GitHub shows a pass for a
 * row that says it needs a person. So after the check or the comment is acknowledged the row is
 * read again, and when it no longer stands for what was just published (see {@link sameStanding})
 * what its row says now is published, up to {@link PUBLISH_ROUNDS} times in all. The row is stamped
 * `published_at` only while it still has the state and decision time that were published, so a
 * result that moved on after the last read is not marked as shown, and the republish sweep, which
 * selects the unstamped, corrects it. Every publisher goes through here, so every publisher has
 * this: the callback's store, the refusal, the running check, a decline and the sweep itself.
 */
export async function publishOutcome(
  env: Bindings,
  row: ReviewRow,
  outcome: StoredOutcome | "running",
  opts: { commentOnly?: boolean } = {},
): Promise<boolean> {
  let token: string;
  let refresh: () => Promise<string>;
  try {
    ({ token, refresh } = await getDatasetsTokenWithRefresher(env));
  } catch (err) {
    console.error(`[pr-review] review ${row.id}: no GitHub token (${errName(err)})`);
    return false;
  }
  const db = env.DB;

  let shown = row;
  let what = outcome;
  for (let round = 1; round <= PUBLISH_ROUNDS; round++) {
    const done = await publishRound(env, { token, refresh }, shown, what, opts);
    // Nothing reached GitHub, so nothing can be stale there, and the row stays as it was.
    if (!done.acknowledged) return done.checked;
    let fresh: ReviewRow | null;
    try {
      fresh = await readRow(db, row.id);
    } catch (err) {
      // Not knowing whether the row moved is not knowing the check is right: no stamp, and the
      // sweep publishes it again.
      console.error(
        `[pr-review] review ${row.id}: row not read after publishing (${errName(err)})`,
      );
      return done.checked;
    }
    if (fresh === null || sameStanding(fresh, shown)) {
      if (done.checked && what !== "running") await stampPublished(db, shown);
      return done.checked;
    }
    // The row moved while it was being published, so what GitHub holds may be what it was.
    if (round === PUBLISH_ROUNDS) {
      console.error(
        `[pr-review] review ${row.id}: the row kept moving while it was published; left for the sweep`,
      );
      return false;
    }
    shown = fresh;
    what = outcomeOfRow(fresh) ?? "running";
  }
  return false;
}

/**
 * Record that a row's result reached GitHub, and only for the row as it was published: the same
 * state and decision time. A row that moved on since is not stamped, so its new result still waits
 * for a publish, and the sweep takes it up if nothing else does.
 */
async function stampPublished(db: Db, row: ReviewRow): Promise<void> {
  try {
    await db
      .prepare(
        "UPDATE pr_reviews SET published_at = datetime('now') WHERE id = ? AND state = ? AND decided_at IS ?",
      )
      .bind(row.id, row.state, row.decidedAt)
      .run();
  } catch (err) {
    console.error(`[pr-review] review ${row.id}: published_at not stored (${errName(err)})`);
  }
}

/**
 * One publish of `outcome` for `row`: the check, and the comment for a decided outcome. Says whether
 * the check reached GitHub and whether anything did (the comment alone is something).
 */
async function publishRound(
  env: Bindings,
  { token, refresh }: { token: string; refresh: () => Promise<string> },
  row: ReviewRow,
  outcome: StoredOutcome | "running",
  opts: { commentOnly?: boolean },
): Promise<{ checked: boolean; acknowledged: boolean }> {
  let checked = false;
  let commented = false;
  const db = env.DB;

  if (!opts.commentOnly) {
    const rendered =
      outcome === "running"
        ? {
            title: "Review in progress",
            summary: "The changes are being reviewed. This check will update when it finishes.",
            text: "",
          }
        : renderCheck(outcome);
    try {
      const id = await upsertReviewCheckRun({
        token,
        refresh,
        quick: outcome === "running",
        repo: row.datasetId,
        headSha: row.headSha,
        checkRunId: row.checkRunId,
        conclusion: outcome === "running" ? null : conclusionOf(outcome),
        ...rendered,
      });
      checked = true;
      if (id !== row.checkRunId) {
        // Its own try: the check exists on GitHub whether or not this write lands.
        try {
          await db
            .prepare("UPDATE pr_reviews SET check_run_id = ? WHERE id = ?")
            .bind(id, row.id)
            .run();
          row.checkRunId = id;
        } catch (err) {
          console.error(`[pr-review] review ${row.id}: check id not stored (${errName(err)})`);
        }
      }
    } catch (err) {
      console.error(`[pr-review] review ${row.id}: check-run not published (${errName(err)})`);
    }
  }

  if (outcome === "running") return { checked, acknowledged: checked };
  try {
    if (await isLatestReview(db, row)) {
      const commentId = row.commentId ?? (await existingCommentId(db, row.datasetId, row.prNumber));
      const id = await upsertReviewComment({
        token,
        refresh,
        repo: row.datasetId,
        prNumber: row.prNumber,
        commentId,
        body: renderComment(outcome, row.headSha),
      });
      commented = true;
      if (id !== row.commentId) {
        try {
          await db
            .prepare("UPDATE pr_reviews SET comment_id = ? WHERE id = ?")
            .bind(id, row.id)
            .run();
          row.commentId = id;
        } catch (err) {
          console.error(`[pr-review] review ${row.id}: comment id not stored (${errName(err)})`);
        }
      }
    }
  } catch (err) {
    // Typically the App lacks pull_requests: write. The check still carries the whole review.
    console.error(`[pr-review] review ${row.id}: comment not published (${errName(err)})`);
  }
  return { checked, acknowledged: checked || commented };
}

/**
 * A stranger pushing commit after commit would otherwise cost two GitHub writes per push for a
 * message that never changes. A decline is published the first time; the same decline for the
 * same pull request within the hour is recorded without being published again.
 *
 * "The same pull request" includes this very row: an edit restarts a commit's row, and a blocked
 * contributor editing a title repeatedly would otherwise publish the decline again each time. The
 * restart keeps the row's `published_at` only when the row already carried this decline, told
 * within the hour ({@link KEEP_RECENT_DECLINE_STAMP}), so a stamp on the row itself is the proof
 * and its own `created_at`, which a restart renews, is not asked about.
 */
async function publishDecline(
  env: Bindings,
  row: ReviewRow,
  reason: ProducedDeclineReason,
): Promise<void> {
  const repeat = await env.DB.prepare(
    `SELECT 1 AS ok FROM pr_reviews
      WHERE dataset_id = ? AND pr_number = ? AND state = 'declined' AND detail = ?
        AND published_at IS NOT NULL
        AND ((id < ? AND created_at >= datetime('now', '-1 hour')) OR id = ?)
      LIMIT 1`,
  )
    .bind(row.datasetId, row.prNumber, reason, row.id, row.id)
    .first<{ ok: number }>();
  if (repeat) {
    // Recorded as told, for the row as it stands: a row that moved on since is not stamped.
    await stampPublished(env.DB, row);
    return;
  }
  await publishOutcome(env, row, { kind: "declined", reason });
}

// ---------------------------------------------------------------------------------------------
// The webhook entry point
// ---------------------------------------------------------------------------------------------

export interface PrReviewResponse {
  ok: true;
  dispatched: boolean;
  reason: string;
  review_id?: number;
}

const no = (reason: string, reviewId?: number): PrReviewResponse => ({
  ok: true,
  dispatched: false,
  reason,
  ...(reviewId === undefined ? {} : { review_id: reviewId }),
});

export interface PrReviewOptions {
  /**
   * An administrator asked for this review by name (`startPullRequestReview`). The payload was built
   * from GitHub's own record of the pull request. It lets a commit whose review ended without a
   * verdict be started again, which a new delivery of the commit does only for a dispatch GitHub did
   * not run. It names no sender, so whether the pull request is exempt is judged on its author alone.
   */
  adminStart?: boolean;
}

/**
 * Whether this delivery is one the review does not apply to (ADR 0107): the pull request's author
 * is an owner or administrator AND so is whoever caused the delivery.
 *
 * The second half is what keeps the exemption from reaching a stranger's work. Anyone with write
 * access can push to an owner's branch, reopen the pull request or mark it ready, and what they put
 * in front of the review must not be skipped because the pull request carries another name. A
 * sender who is the author (compared as GitHub does, without regard to case) needs no second look.
 * Anyone else must be exempt in their own right. A delivery that names no usable sender cannot be
 * attributed, and an unattributed delivery is reviewed.
 *
 * An administrator's start is the one delivery with no sender: its payload is GitHub's own record
 * of the pull request, built by the Worker, and nobody pushed. It is judged on the author alone.
 */
async function isExemptDelivery(
  env: Bindings,
  pr: PrIntake,
  options: PrReviewOptions,
): Promise<boolean> {
  const repo = pr.datasetId;
  if (!(await isReviewExempt(env, { login: pr.authorLogin, repo }))) return false;
  if (options.adminStart === true) return true;
  const sender = pr.senderLogin;
  if (sender === null) return false;
  if (sender.toLowerCase() === pr.authorLogin.toLowerCase()) return true;
  return await isReviewExempt(env, { login: sender, repo });
}

/** What the gate decides for a delivery. */
type Gate = "exempt" | "blocked" | "review";

/**
 * Whether a review is spent on this delivery, the one decision (ADR 0107), in this order:
 *
 *  1. **exempt**: an owner or administrator is behind the delivery ({@link isExemptDelivery}, the
 *     author AND whoever caused it, never the author alone). Asked only for a commit with no row
 *     (`commit` is `"new"`): a commit a review has touched keeps what that review said, so there
 *     `skipped` can never be the answer.
 *  2. **blocked**: an administrator has blocked the author. It holds back a restart of a commit
 *     already on record (`"on_record"`) as it does a new commit, and it never reaches an exempt
 *     delivery, because exempt is asked first.
 *  3. **review**: everything else. No count decides it: not how many reviews the author or the
 *     platform started lately, and not how many of the author's pull requests were rejected.
 *     That is what the earlier hourly, daily and platform caps and the automatic pause did, and
 *     ADR 0107 removed them.
 *
 * A database error throws, like every read of the intake.
 */
async function gateDecision(
  env: Bindings,
  pr: PrIntake,
  options: PrReviewOptions,
  commit: "new" | "on_record",
): Promise<Gate> {
  if (commit === "new" && (await isExemptDelivery(env, pr, options))) return "exempt";
  const standing = standingOf(await readAuthorOverride(env.DB, pr.authorId));
  return standing.paused ? "blocked" : "review";
}

/**
 * The exempt pull request's check could not be published. Thrown, so the webhook answers 500 and
 * the delivery shows as failed where it can be redelivered; an administrator's start turns it into
 * a sentence.
 */
export class ExemptCheckNotPublished extends Error {
  constructor() {
    super("exempt check not published");
    this.name = "ExemptCheckNotPublished";
  }
}

/**
 * What an exempt pull request's commit comes to under the naming rule (ADR 0107), which runs
 * before the exemption takes effect: `exempt` when the rule finds nothing, `exempt` and `waived`
 * when it finds something an administrator waived for this commit, and `naming` otherwise (a
 * failure, or a check that needs a person when the dataset's name could not be read).
 */
export async function exemptOutcomeFor(
  env: Bindings,
  pr: NamingSubject,
): Promise<Extract<ReviewOutcome, { kind: "exempt" | "naming" }>> {
  const facts = await namingFactsFor(env, pr);
  if (namingClean(facts)) return { kind: "exempt" };
  if (await isNamingWaived(env.DB, pr, facts)) return { kind: "exempt", waived: true };
  return { kind: "naming", facts };
}

/**
 * The fixed word an exempt outcome is answered with, for the webhook and an administrator's start.
 * A name that could not be read is `naming_unchecked` whatever the title says, because that is what
 * the check says (it needs a person) and what a waiver answers: nothing can be waived until the
 * name is read.
 */
export function exemptReason(
  outcome: Extract<ReviewOutcome, { kind: "exempt" | "naming" }>,
): string {
  if (outcome.kind === "exempt") return outcome.waived ? "exempt_naming_waived" : "exempt_author";
  return outcome.facts.name === "unchecked" ? "naming_unchecked" : "naming_rule";
}

/**
 * Post an exempt pull request's one check: a NEW check run on the commit. Throws
 * {@link ExemptCheckNotPublished} when GitHub will not take it.
 */
export async function postExemptCheck(
  env: Bindings,
  pr: { datasetId: string; prNumber: number; headSha: string },
  outcome: Extract<ReviewOutcome, { kind: "exempt" | "naming" }>,
): Promise<void> {
  try {
    const { token, refresh } = await getDatasetsTokenWithRefresher(env);
    await upsertReviewCheckRun({
      token,
      refresh,
      quick: true,
      repo: pr.datasetId,
      headSha: pr.headSha,
      checkRunId: null,
      conclusion: conclusionOf(outcome),
      ...renderCheck(outcome),
    });
  } catch (err) {
    console.error(
      `[pr-review] ${pr.datasetId}#${pr.prNumber}: exempt check not published (${errName(err)})`,
    );
    throw new ExemptCheckNotPublished();
  }
}

/**
 * Answer a pull request nobody reviews (ADR 0107) with the one check that says so, and nothing
 * else: no row, no dispatch, no model call, no "in progress" check, no comment. The naming rule
 * runs first (see {@link exemptOutcomeFor}): a title or a new dataset name it refuses fails the
 * check, because owners and administrators are exempt from the review and not from the rule.
 *
 * It is only reached for a commit that has no row (see `handlePullRequestEvent`): a commit a review
 * has touched keeps what the review said, so `skipped` is never written over a verdict, a decline
 * or an error. For the same reason a NEW check run is created and an old one is never updated (a
 * review that starts for the same commit between the row read and this publish therefore leaves
 * the commit with two checks; the ADR says so). The pull request's review comment, when an earlier
 * commit's review left one, is not touched: it names the commit it is about.
 *
 * It writes nothing, so there is nothing for the watchdog to publish again. A check that cannot
 * be published is therefore thrown ({@link ExemptCheckNotPublished}) and the webhook answers 500:
 * the delivery shows as failed in the App's delivery log, where it can be redelivered, instead of
 * leaving a pull request with no check and no trace (see the module comment).
 */
async function publishExempt(env: Bindings, pr: PrIntake): Promise<PrReviewResponse> {
  const where = `${pr.datasetId}#${pr.prNumber}`;
  const outcome = await exemptOutcomeFor(env, pr);
  await postExemptCheck(env, pr, outcome);
  const reason = exemptReason(outcome);
  // The only record that a commit was exempted: it has no row and no comment. No login, no title.
  console.info(
    `[pr-review] ${where}: exempt, ${conclusionOf(outcome)} check posted for ${pr.headSha.slice(0, 7)} (${reason})`,
  );
  return no(reason);
}

/**
 * Take up a `pull_request` delivery. The caller has already verified the delivery's signature and
 * applied the production/dev ownership fence; everything else is decided here. A database error
 * throws, and the route answers 500 (see the module comment).
 */
export async function handlePullRequestEvent(
  env: Bindings,
  payload: unknown,
  options: PrReviewOptions = {},
): Promise<PrReviewResponse> {
  if (env.PR_REVIEW_ENABLED !== "1") return no("pr_review_disabled");
  const intake = readPullRequestEvent(payload);
  if (!intake.ok) return no(intake.reason);
  const pr = intake.pr;
  const db = env.DB;

  const secret = env.PRESCREEN_CALLBACK_SECRET;
  if (!secret) {
    console.error(
      `[pr-review] PRESCREEN_CALLBACK_SECRET is unset; not reviewing ${pr.datasetId}#${pr.prNumber}`,
    );
    return no("misconfigured");
  }

  // Only review a live, named publication. An anonymous deposit is public in the catalog while
  // its GitHub repository remains private, and upload creates private unpublished rows; neither
  // may send pull-request text or metadata to the model.
  const reviewable = await reviewableDataset(db, pr.datasetId);
  if (reviewable === "unknown") return no("unknown_dataset");
  if (reviewable === "not_reviewable") return no("dataset_not_reviewable");

  // A commit a review has touched keeps what that review said, whoever acts on it next: a row means
  // someone put this commit through review (a stranger's push to an owner's branch, or an author
  // who was not exempt yet), and an exempt author's push back to it, or an administrator's start,
  // must not turn another person's failed or undecided review into `skipped`, which a required
  // check counts as passing. `handleRepeat` re-states the row instead, or, for an edit, a reopening
  // and a marking as ready, which change the text the review judged, starts the review again (and
  // never writes `skipped` either).
  const existing = await readRowByKey(db, pr.datasetId, pr.prNumber, pr.headSha);
  if (existing) return await handleRepeat(env, existing, secret, pr, options);

  // Every other delivery meets the gate once, before any row is written: an exempt pull request
  // stores no row, so no redelivery or restart can carry it into the review.
  const gate = await gateDecision(env, pr, options, "new");
  if (gate === "exempt") return await publishExempt(env, pr);
  const paused = gate === "blocked";
  const nonce = crypto.randomUUID();
  const inserted = await db
    .prepare(
      `INSERT INTO pr_reviews
         (dataset_id, pr_number, head_sha, author_id, author_login, author_association,
          from_fork, state, detail, nonce, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${paused ? "datetime('now')" : "NULL"})
       ON CONFLICT (dataset_id, pr_number, head_sha) DO NOTHING`,
    )
    .bind(
      pr.datasetId,
      pr.prNumber,
      pr.headSha,
      pr.authorId,
      pr.authorLogin,
      pr.authorAssociation,
      pr.fromFork ? 1 : 0,
      paused ? "declined" : "dispatched",
      paused ? "contributor_paused" : null,
      paused ? null : nonce,
    )
    .run();
  if ((inserted.meta.changes ?? 0) !== 1) {
    // Another delivery of the same commit won the insert between the read and the write.
    const raced = await readRowByKey(db, pr.datasetId, pr.prNumber, pr.headSha);
    return raced ? await handleRepeat(env, raced, secret, pr, options) : no("duplicate");
  }
  const reviewId = Number(inserted.meta.last_row_id);
  try {
    return await decideInserted(env, reviewId, paused, nonce, secret);
  } catch (err) {
    await markDispatchFailed(db, reviewId, nonce);
    throw err;
  }
}

/**
 * The row exists but nothing has run for it (a database error between the insert and the
 * dispatch). Left as 'dispatched' it would wait for the watchdog to call it late, and a redelivery
 * would find it and answer "duplicate". Mark it as a dispatch that did not happen, which a
 * redelivery retries; the caller lets the route answer 500.
 *
 * `nonce` is the one the failed attempt set, and the row is marked only while it still carries it.
 * A row can be restarted again while this attempt fails (an edit during a database fault), and the
 * newer attempt's nonce is the one a live job holds a token for: clearing it would refuse that
 * job's claim and report for a failure that was not its own.
 */
async function markDispatchFailed(db: Db, reviewId: number, nonce: string): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE pr_reviews SET state = 'errored', detail = 'dispatch_failed', nonce = NULL,
                decided_at = datetime('now')
          WHERE id = ? AND state = 'dispatched' AND claimed_at IS NULL AND nonce = ?`,
      )
      .bind(reviewId, nonce)
      .run();
  } catch (inner) {
    console.error(`[pr-review] review ${reviewId}: failure not recorded (${errName(inner)})`);
  }
}

/**
 * Everything after the insert: publish a decline for a blocked contributor, or start the review.
 * `secondCall` is set when this attempt restarts a row whose earlier attempt already cost a model
 * call, and adds one to the row's `attempts`, which the administrator's volume sums. That is the
 * best record there is and not an exact one: the count is made before the hand-over, so a
 * hand-over GitHub refuses leaves the row one call over until a later run, and a restart a block
 * declined has overwritten the state this rule reads, so the call after it can read one short.
 * Nothing decides on it.
 */
async function decideInserted(
  env: Bindings,
  reviewId: number,
  paused: boolean,
  nonce: string,
  secret: string,
  options: { secondCall?: boolean } = {},
): Promise<PrReviewResponse> {
  const db = env.DB;
  const row = await readRow(db, reviewId);
  if (!row) return no("duplicate", reviewId);

  if (paused) {
    await publishDecline(env, row, "contributor_paused");
    return no("contributor_paused", reviewId);
  }

  // The attempt is going ahead, so a call the row had already spent is now a second one.
  if (options.secondCall) {
    await db
      .prepare("UPDATE pr_reviews SET attempts = attempts + 1 WHERE id = ?")
      .bind(reviewId)
      .run();
  }
  return await startReview(env, row, nonce, secret);
}

/**
 * The commit has been delivered before. It is marked seen again (so it is the pull request's
 * current commit, which is what force-pushing back to an earlier reviewed commit means), its
 * stored result is re-stated on the pull request, and a review whose dispatch failed is tried
 * again. Nothing else is reviewed twice, except that an administrator's start also restarts a
 * commit whose review ended without a verdict, and an edit of the title, the body or the base, a
 * reopening and a marking as ready restart the review of the commit they are on, whatever state
 * that is in (see `isRestartable`).
 */
async function handleRepeat(
  env: Bindings,
  existing: ReviewRow,
  secret: string,
  pr: PrIntake,
  options: PrReviewOptions,
): Promise<PrReviewResponse> {
  const db = env.DB;
  await db
    .prepare(`UPDATE pr_reviews SET seen_at = ${NOW_MS} WHERE id = ?`)
    .bind(existing.id)
    .run();

  // A restart is a conditional write, so it finds nothing to change when something else moved the
  // row between the read and the write: a result stored, the watchdog's verdict, another delivery.
  // For most deliveries that is the answer (what is re-stated below is what the row is now, not what
  // this call read before the other writer ran). For a delivery that changes the text (an edit, a
  // reopening, a marking as ready) it is not: the text the stored result judged is no longer the
  // pull request's, whoever moved the row, so the change is dropped only after the restart has been
  // tried against the row as it is now, up to three times in all.
  //
  // A delivery that changes the text is also held to the cap (ADR 0107, decision 4): once the
  // commit's review has been restarted that many times by such deliveries, the next one is refused
  // instead of restarted, and every one after it re-states the refusal. The cap comes after the
  // gate: a contributor an administrator has blocked is declined by the restart below, as for any
  // delivery, and is never told "too many edits" (a declined restart is not counted either).
  let current = existing;
  const textChange = changesTheText(pr);
  const tries = textChange ? EDIT_RESTART_TRIES : 1;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (
      textChange &&
      current.editRestarts >= PR_REVIEW_EDIT_CAP &&
      (await gateDecision(env, pr, options, "on_record")) !== "blocked"
    ) {
      if (current.detail === "edit_limit") break;
      const refused = await refuseEdit(env, current, pr);
      if (refused) return refused;
      current = (await readRow(db, existing.id)) ?? current;
      continue;
    }
    if (!(await isRestartable(db, current, pr, options))) break;
    const restarted = await restartReview(env, current, pr, secret, options);
    if (restarted) return restarted;
    current = (await readRow(db, existing.id)) ?? current;
  }

  const outcome = outcomeOfRow(current);
  if (outcome) await publishOutcome(env, current, outcome, { commentOnly: true });
  return no("duplicate", existing.id);
}

/**
 * Refuse a delivery that would restart a review past the cap: the row becomes an errored review
 * with the detail `edit_limit`, its check and comment are published as such, and nothing is
 * dispatched. The state it is in is deliberately not asked about. A running review is superseded
 * (its nonce is cleared, so its claim and its report are refused), and a result stored between the
 * read and this write judged the text from before the edit, so it is overwritten too: a pass or a
 * fail that stood would be a verdict on text the pull request no longer has, and the queue that
 * approval reads would show it.
 *
 * The write is conditional on the count that was read and on the row not already being refused,
 * so it is null when another delivery moved the count (an administrator's start resets it) or
 * refused first, and the caller reads the row again. A refusal whose publish fails stays
 * unpublished, and the watchdog's republish sweep says it again.
 */
async function refuseEdit(
  env: Bindings,
  existing: ReviewRow,
  pr: PrIntake,
): Promise<PrReviewResponse | null> {
  const db = env.DB;
  const refused = await db
    .prepare(
      `UPDATE pr_reviews
          SET state = 'errored', detail = 'edit_limit', verdict = NULL, report = NULL, nonce = NULL,
              decided_at = datetime('now'), published_at = NULL, publish_attempts = 0
        WHERE id = ? AND edit_restarts = ? AND detail IS NOT 'edit_limit'`,
    )
    .bind(existing.id, existing.editRestarts)
    .run();
  if ((refused.meta.changes ?? 0) !== 1) return null;
  console.warn(
    `[pr-review] review ${existing.id} (${existing.datasetId}#${existing.prNumber}): restart refused at the cap of ${PR_REVIEW_EDIT_CAP} on ${existing.headSha.slice(0, 7)}, sender ${pr.senderLogin ?? "unknown"}`,
  );
  const row = (await readRow(db, existing.id)) ?? existing;
  await publishOutcome(env, row, { kind: "error", error: "edit_limit" });
  return no("edit_limit", existing.id);
}

/** What caused a restart, in the words of the log line: the delivery's action, in plain words. */
function causeOf(pr: PrIntake): string {
  if (pr.edited) return "an edit";
  return pr.action === "reopened" ? "a reopen" : "ready for review";
}

/**
 * Whether the delivery may have changed the text a review of its commit judged: an edit of the
 * title, the body or the base, or the return of a pull request that was closed or a draft (an edit
 * made meanwhile was not taken up, so the first thing that follows it is the reopening or the
 * marking as ready).
 */
function changesTheText(pr: PrIntake): boolean {
  return pr.edited || pr.resumed;
}

/**
 * A commit whose review can be tried again. An edit of the title, the body or the base, a
 * reopening and a marking as ready always restart it, from any state, a running review and a stored
 * result included: the review judged text that is no longer the pull request's, and a result for it
 * must not stand, as a pass or as a fail (ADR 0107). A dispatch that failed was not run by GitHub
 * (and a late claim of it is refused, its nonce having been cleared), so a redelivery restarts it.
 * A commit that was declined, ended in an error or never reported is restarted otherwise only when
 * an administrator asks by name: a new delivery of the same commit must not buy a second model
 * call. So is one handed to GitHub that is past the watchdog's deadline: the production watchdog
 * would have closed it as `unreported`, and the dev Worker never runs it. A review that is running,
 * or has a result, is not restarted by anything else.
 */
async function isRestartable(
  db: Db,
  row: ReviewRow,
  pr: PrIntake,
  options: PrReviewOptions,
): Promise<boolean> {
  if (changesTheText(pr)) return true;
  if (row.state === "errored" && row.detail === "dispatch_failed") return true;
  if (options.adminStart !== true) return false;
  if (row.state === "declined" || row.state === "errored" || row.state === "unreported") {
    return true;
  }
  if (row.state !== "dispatched") return false;
  const overdue = await db
    .prepare(
      `SELECT 1 AS overdue FROM pr_reviews
        WHERE id = ? AND created_at < datetime('now', '-' || ? || ' minutes')`,
    )
    .bind(row.id, PR_REVIEW_DEADLINE_MINUTES)
    .first<{ overdue: number }>();
  return overdue !== null;
}

/**
 * Whether a row's attempt may have reached the model (one run, of up to two calls): the complement
 * of a decline, an attempt GitHub never ran, a run that ended at the facts stage (`stage` is
 * `facts`: the naming rule decided it before any model was asked, so it made no call), and a review
 * handed to GitHub that no job has claimed (`claimed_at` is null while it is `dispatched` or
 * `unreported`: the claim comes before anything is spent, so the job that was started cannot have
 * made a call, and several quick edits before it starts are still one run). A restart of a row that
 * did spend one adds a second run to its `attempts`, and the administrator's volume count sums
 * `attempts` over the rows that did. `stage` is the stage of a stored version 2 report and is
 * absent for any other row; only a change of the text restarts a reported row, and
 * {@link stageOfReport} reads its stage for this. `claimed_at` is left out by a caller that does not
 * have it (the volume's groups), and absent is not null: it says nothing, so the row is counted.
 *
 * A review refused at the edit cap (`edit_limit`) counts as a spent call: it is a refusal and not a
 * run, but the review it superseded may have been claimed, and counting it errs the safe way, which
 * is the way this count is allowed to be wrong (nothing decides on it).
 */
export function spentACall(row: {
  state: string;
  detail: string | null;
  stage?: string | null;
  claimed_at?: string | null;
}): boolean {
  if (row.state === "declined") return false;
  if (row.stage === "facts") return false;
  if ((row.state === "dispatched" || row.state === "unreported") && row.claimed_at === null) {
    return false;
  }
  return !(
    row.state === "errored" &&
    (row.detail === "stale_head" || row.detail === "dispatch_failed")
  );
}

/** The stage of a stored version 2 report (`facts`, `screen` or `full`), or null for any other. */
function stageOfReport(report: string | null): string | null {
  if (report === null) return null;
  try {
    const stage = (JSON.parse(report) as { stage?: unknown } | null)?.stage;
    return typeof stage === "string" ? stage : null;
  } catch {
    return null;
  }
}

/**
 * A restart that ends in a decline keeps the row's `published_at` when the row already stands as
 * this decline and told it within the hour (the old values are the ones a `SET` expression reads),
 * and drops it otherwise. {@link publishDecline} then finds that stamp and does not tell the pull
 * request again. A row that stood as anything else (a pass, a fail, a running review) has a check
 * that says that, so the decline is published.
 */
const KEEP_RECENT_DECLINE_STAMP = `CASE WHEN state = 'declined' AND detail = 'contributor_paused'
    AND published_at >= datetime('now', '-1 hour') THEN published_at END`;

/**
 * Give a commit a fresh attempt, held to the same gate as a new one except for the exemption (see
 * {@link gateDecision}; the commit has a row, so `skipped` is never an answer): a contributor an
 * administrator has blocked is declined. Null when another delivery moved the row first.
 *
 * The nonce is replaced, and that is what retires the attempt this one supersedes. The superseded
 * job's token was signed over the old nonce, so its claim and its result are refused (401, the same
 * bytes as for any token that is not for the review waiting now) and its report is never stored;
 * `claimed_at` is cleared so the new job can claim. A restart of a reported row also clears its
 * `verdict` and `report`, which the table keeps null unless the state is `reported`; the old
 * result stops being the commit's the moment the review runs again, and the check shows it
 * running.
 */
async function restartReview(
  env: Bindings,
  existing: ReviewRow,
  pr: PrIntake,
  secret: string,
  options: PrReviewOptions,
): Promise<PrReviewResponse | null> {
  const db = env.DB;
  const paused = (await gateDecision(env, pr, options, "on_record")) === "blocked";
  const nonce = crypto.randomUUID();
  // The cap's count: an administrator's start begins it again when it starts the review (a start
  // that a block declines is a restart too, and a decline is no run to count), a delivery that
  // changes the text adds one unless it was declined, and anything else (a push that restarts a
  // review whose dispatch failed) leaves it as it is.
  const count = options.adminStart
    ? paused
      ? "edit_restarts"
      : "0"
    : changesTheText(pr) && !paused
      ? "edit_restarts + 1"
      : "edit_restarts";
  const reset = await db
    .prepare(
      `UPDATE pr_reviews
          SET state = ?, detail = ?, nonce = ?, claimed_at = NULL,
              published_at = ${paused ? KEEP_RECENT_DECLINE_STAMP : "NULL"},
              publish_attempts = 0, edit_restarts = ${count}, decided_at = ${paused ? "datetime('now')" : "NULL"},
              created_at = datetime('now'), verdict = NULL, report = NULL
        WHERE id = ? AND state = ? AND detail IS ? AND edit_restarts = ?`,
    )
    .bind(
      paused ? "declined" : "dispatched",
      paused ? "contributor_paused" : null,
      paused ? null : nonce,
      existing.id,
      existing.state,
      existing.detail,
      existing.editRestarts,
    )
    .run();
  if ((reset.meta.changes ?? 0) !== 1) return null;
  // One line for each restart a change of the text caused, so a commit that keeps being restarted
  // can be traced to who is doing it. The sender's login has the shape of one (it was checked on
  // the way in); the title and the body, which the pull request's author controls, are not in it.
  if (changesTheText(pr)) {
    console.info(
      `[pr-review] review ${existing.id} (${existing.datasetId}#${existing.prNumber}): restarted by ${causeOf(pr)} (${existing.editRestarts + 1} of ${PR_REVIEW_EDIT_CAP}) on ${existing.headSha.slice(0, 7)}, sender ${pr.senderLogin ?? "unknown"}`,
    );
  }
  try {
    const res = await decideInserted(env, existing.id, paused, nonce, secret, {
      // The earlier attempt cost a model call unless it never got that far.
      secondCall: spentACall({
        state: existing.state,
        detail: existing.detail,
        stage: stageOfReport(existing.report),
        claimed_at: existing.claimedAt,
      }),
    });
    return res.dispatched && res.reason === "dispatched"
      ? { ...res, reason: pr.edited ? "redispatched_after_edit" : "redispatched" }
      : res;
  } catch (err) {
    await markDispatchFailed(db, existing.id, nonce);
    throw err;
  }
}

/**
 * Show the review as running, hand it to GitHub, and record a failure to do so.
 *
 * A restart takes a completed result off the required check by updating that check run back to
 * `in_progress`. GitHub's documentation neither allows nor forbids that transition (ADR 0107 lists
 * it as unverified), so the publish can be refused, and a refused or timed-out publish must not be
 * silent: the old result would keep standing on the check until the callback or the watchdog. It is
 * tried a second time after a short wait, and a second failure is logged once, naming the review.
 */
async function startReview(
  env: Bindings,
  row: ReviewRow,
  nonce: string,
  secret: string,
): Promise<PrReviewResponse> {
  const db = env.DB;
  if (!(await publishOutcome(env, row, "running"))) {
    await new Promise((resolve) => setTimeout(resolve, RUNNING_PUBLISH_RETRY_WAIT_MS));
    if (!(await publishOutcome(env, row, "running"))) {
      console.error(
        `[pr-review] review ${row.id} (${row.datasetId}#${row.prNumber}): the running check was not published after a retry; the old result may still stand on the check until the callback or the watchdog`,
      );
    }
  }
  try {
    const token = await signPrReviewCallbackToken(
      { datasetId: row.datasetId, reviewId: row.id, nonce },
      secret,
    );
    await triggerPrReviewRun(
      {
        datasetId: row.datasetId,
        prNumber: row.prNumber,
        headSha: row.headSha,
        reviewId: row.id,
        callbackToken: token,
        environment: approvalDispatchEnvironment(env),
      },
      await getDatasetsToken(env),
      DISPATCH_TIMEOUT_MS,
    );
  } catch (err) {
    console.error(
      `[pr-review] review ${row.id} (${row.datasetId}#${row.prNumber}): dispatch failed (${errName(err)})`,
    );
    try {
      const failed = await db
        .prepare(
          `UPDATE pr_reviews SET state = 'errored', detail = 'dispatch_failed', nonce = NULL,
                  decided_at = datetime('now')
            WHERE id = ? AND state = 'dispatched' AND nonce = ? AND claimed_at IS NULL`,
        )
        .bind(row.id, nonce)
        .run();
      if ((failed.meta.changes ?? 0) === 1) {
        const fresh = await readRow(db, row.id);
        await publishOutcome(env, fresh ?? row, { kind: "error", error: "dispatch_failed" });
      } else {
        // GitHub may have accepted the dispatch and the workflow may already have claimed it
        // before the response timed out. Preserve that claim: clearing its nonce would make the
        // valid callback fail and a redelivery could buy a second model call.
        const claim = await db
          .prepare("SELECT claimed_at FROM pr_reviews WHERE id = ?")
          .bind(row.id)
          .first<{ claimed_at: string | null }>();
        if (claim?.claimed_at) {
          return { ok: true, dispatched: true, reason: "dispatch_claimed", review_id: row.id };
        }
      }
    } catch (inner) {
      console.error(`[pr-review] review ${row.id}: failure not recorded (${errName(inner)})`);
    }
    return no("dispatch_failed", row.id);
  }
  return { ok: true, dispatched: true, reason: "dispatched", review_id: row.id };
}

// ---------------------------------------------------------------------------------------------
// The claim and the callback
// ---------------------------------------------------------------------------------------------

/** The nonce of a review still waiting for its report, or null. Replays and strangers find nothing. */
export async function pendingNonce(
  db: Db,
  reviewId: number,
  datasetId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT nonce FROM pr_reviews
        WHERE id = ? AND dataset_id = ? AND state IN ('dispatched', 'unreported')
          AND nonce IS NOT NULL LIMIT 1`,
    )
    .bind(reviewId, datasetId)
    .first<{ nonce: string }>();
  return row?.nonce ?? null;
}

export type ClaimResult =
  | "claimed"
  | "already_claimed"
  | "claim_unsettled"
  | "dataset_not_reviewable"
  | "superseded";

/** A newer delivery for this pull request, ordered by the same key as `isLatestReview`. */
const NEWER_REVIEW_EXISTS = `EXISTS (
  SELECT 1 FROM pr_reviews AS newer
   WHERE newer.dataset_id = pr_reviews.dataset_id
     AND newer.pr_number = pr_reviews.pr_number
     AND (newer.seen_at > pr_reviews.seen_at
       OR (newer.seen_at = pr_reviews.seen_at AND newer.id > pr_reviews.id))
)`;

/**
 * The workflow's first real step, before it mints an identity or reads anything: take the review. The
 * caller has verified the token. A review is claimed once, so one dispatch buys one run (the
 * screen, and the review unless the screen stops it); a dispatch for a commit that is no longer the
 * latest delivery recorded by the Worker is refused and recorded as `stale_head`. The workflow also
 * compares the dispatched SHA against the fetched pull ref and current pull-request API response
 * before any model call.
 */
export async function claimPrReview(
  env: Bindings,
  reviewId: number,
  datasetId: string,
  nonce: string,
): Promise<ClaimResult> {
  const db = env.DB;
  const row = await readRow(db, reviewId);
  if (!row || row.datasetId !== datasetId) return "already_claimed";

  // Retry once if eligibility changes between the claim and refusal updates. Without the retry, a
  // dataset that becomes eligible in that gap would leave the row dispatched until the watchdog.
  for (let attempt = 0; attempt < 2; attempt++) {
    const claimed = await db
      .prepare(
        `UPDATE pr_reviews SET claimed_at = datetime('now')
          WHERE id = ? AND dataset_id = ? AND nonce = ? AND claimed_at IS NULL
            AND state IN ('dispatched', 'unreported')
            AND EXISTS (
              SELECT 1 FROM datasets AS d WHERE d.dataset_id = pr_reviews.dataset_id
                AND ${REVIEWABLE_DATASET_PREDICATE}
            )
            AND NOT ${NEWER_REVIEW_EXISTS}`,
      )
      .bind(reviewId, datasetId, nonce)
      .run();
    if ((claimed.meta.changes ?? 0) === 1) return "claimed";

    // The latest-recorded-delivery and current-dataset predicates are in the conditional claim
    // itself. A newer delivery or a dataset that became private between intake and claim cannot
    // slip through. Record the refusal only while this same unclaimed nonce is still current. The
    // workflow separately checks GitHub's fetched pull ref and API head against this SHA before
    // the model.
    const stale = await db
      .prepare(
        `UPDATE pr_reviews SET state = 'errored', detail = 'stale_head', nonce = NULL,
                decided_at = datetime('now'), published_at = NULL, publish_attempts = 0
          WHERE id = ? AND dataset_id = ? AND nonce = ? AND claimed_at IS NULL
            AND state IN ('dispatched', 'unreported')
            AND (${NEWER_REVIEW_EXISTS} OR NOT EXISTS (
              SELECT 1 FROM datasets AS d WHERE d.dataset_id = pr_reviews.dataset_id
                AND ${REVIEWABLE_DATASET_PREDICATE}
            ))`,
      )
      .bind(reviewId, datasetId, nonce)
      .run();
    if ((stale.meta.changes ?? 0) === 1) {
      const fresh = await readRow(db, reviewId);
      await publishOutcome(env, fresh ?? row, { kind: "error", error: "stale_head" });
      const reviewable = await db
        .prepare(
          `SELECT 1 AS ok FROM datasets AS d
            WHERE d.dataset_id = ? AND ${REVIEWABLE_DATASET_PREDICATE}`,
        )
        .bind(datasetId)
        .first<{ ok: number }>();
      return reviewable ? "superseded" : "dataset_not_reviewable";
    }
  }

  // If the claim and stale predicates kept changing across both attempts, fail closed and finish
  // this same unclaimed attempt. It must not remain dispatched until the watchdog or reach a model
  // without a settled claim.
  const unsettled = await db
    .prepare(
      `UPDATE pr_reviews SET state = 'errored', detail = 'stale_head', nonce = NULL,
              decided_at = datetime('now'), published_at = NULL, publish_attempts = 0
        WHERE id = ? AND dataset_id = ? AND nonce = ? AND claimed_at IS NULL
          AND state IN ('dispatched', 'unreported')`,
    )
    .bind(reviewId, datasetId, nonce)
    .run();
  if ((unsettled.meta.changes ?? 0) === 1) {
    const fresh = await readRow(db, reviewId);
    await publishOutcome(env, fresh ?? row, { kind: "error", error: "stale_head" });
    return "claim_unsettled";
  }
  return "already_claimed";
}

/**
 * Store a verified callback and publish it. The write is one conditional UPDATE keyed on the
 * nonce, so a duplicate callback stores nothing twice. The caller has already turned the body
 * into an outcome with `parseCallbackOutcome`: a report the parser refused is the run error
 * `report_invalid` and never a verdict. A late report for a row the watchdog gave up on is
 * accepted, and replaces the "could not decide" check.
 */
export async function storePrReviewResult(
  env: Bindings,
  reviewId: number,
  datasetId: string,
  nonce: string,
  outcome: CallbackOutcome,
): Promise<{ stored: boolean; state: ReviewState | null }> {
  const db = env.DB;
  const res = await db
    .prepare(
      `UPDATE pr_reviews
          SET state = ?, verdict = ?, detail = ?, report = ?, nonce = NULL,
              decided_at = datetime('now'), published_at = NULL, publish_attempts = 0
        WHERE id = ? AND dataset_id = ? AND nonce = ? AND state IN ('dispatched', 'unreported')`,
    )
    // The verdict is stored beside the report so the tally is a query. A republish recomputes it
    // from the report, so a later change to the facts moves new rows only, never the tally.
    .bind(
      outcome.kind === "reported" ? "reported" : "errored",
      outcome.kind === "reported" ? verdictOf(outcome.report) : null,
      outcome.kind === "error" ? outcome.error : null,
      outcome.kind === "reported" ? JSON.stringify(outcome.report) : null,
      reviewId,
      datasetId,
      nonce,
    )
    .run();
  if ((res.meta.changes ?? 0) !== 1) return { stored: false, state: null };
  const row = await readRow(db, reviewId);
  if (row) await publishOutcome(env, row, outcome);
  return { stored: true, state: row?.state ?? null };
}

// ---------------------------------------------------------------------------------------------
// The watchdog
// ---------------------------------------------------------------------------------------------

export interface PrReviewSweepResult {
  /** Reviews that never reported and were marked unreported. */
  timedOut: number;
  /** Stored results that had not reached GitHub and did on this pass. */
  republished: number;
  /** Results whose last allowed attempt to reach GitHub failed on this pass. */
  abandoned: number;
  errors: number;
  skipped: boolean;
}

/**
 * Two jobs, both so a check cannot stay wrong for good.
 *
 * 1. Give up on reviews that never reported. GitHub answers a dispatch 204 whether or not any
 *    workflow listens, so a review can be handed over and never run. The row is marked
 *    `unreported` and its nonce KEPT, so a report that arrives late is still accepted and then
 *    replaces the "could not decide" check.
 * 2. Publish again any stored result that did not reach GitHub (a GitHub error, a token that
 *    would not mint), a few times each.
 *
 * It does not depend on `PR_REVIEW_ENABLED`: turning the review off must not strand a check that
 * is already running. PRODUCTION-ONLY, like the other watchdogs: it writes to the shared
 * `nemarDatasets` org.
 */
export async function sweepStalePrReviews(env: Bindings): Promise<PrReviewSweepResult> {
  const result: PrReviewSweepResult = {
    timedOut: 0,
    republished: 0,
    abandoned: 0,
    errors: 0,
    skipped: false,
  };
  if (isNonProductionEnv(env)) {
    result.skipped = true;
    return result;
  }
  const db = env.DB;

  try {
    const overdue = (
      await db
        .prepare(
          `SELECT id FROM pr_reviews
            WHERE state = 'dispatched'
              AND created_at < datetime('now', '-${PR_REVIEW_DEADLINE_MINUTES} minutes')
            ORDER BY id LIMIT ?`,
        )
        .bind(SWEEP_LIMIT)
        .all<{ id: number }>()
    ).results;
    for (const { id } of overdue) {
      try {
        const res = await db
          .prepare(
            `UPDATE pr_reviews SET state = 'unreported', decided_at = datetime('now'),
                    published_at = NULL, publish_attempts = 0
              WHERE id = ? AND state = 'dispatched'`,
          )
          .bind(id)
          .run();
        if ((res.meta.changes ?? 0) !== 1) continue;
        result.timedOut++;
        const row = await readRow(db, id);
        if (row) {
          // Which dataset, so a workflow that is not deployed or not federated can be traced.
          console.warn(
            `[pr-review-sweep] review ${id} (${row.datasetId}#${row.prNumber}) did not report in time`,
          );
          await publishOutcome(env, row, { kind: "unreported" });
        }
      } catch (err) {
        result.errors++;
        console.error(`[pr-review-sweep] review ${id} failed (${errName(err)})`);
      }
    }
  } catch (err) {
    result.errors++;
    console.error(`[pr-review-sweep] overdue query failed (${errName(err)})`);
  }

  try {
    const unpublished = (
      await db
        .prepare(
          `SELECT id, publish_attempts FROM pr_reviews
            WHERE state != 'dispatched' AND published_at IS NULL
              AND publish_attempts < ${PUBLISH_MAX_ATTEMPTS}
              AND COALESCE(decided_at, created_at)
                  < datetime('now', '-${PUBLISH_RETRY_AFTER_MINUTES} minutes')
            ORDER BY id LIMIT ?`,
        )
        .bind(SWEEP_LIMIT)
        .all<{ id: number; publish_attempts: number }>()
    ).results;
    for (const { id, publish_attempts } of unpublished) {
      try {
        await db
          .prepare("UPDATE pr_reviews SET publish_attempts = publish_attempts + 1 WHERE id = ?")
          .bind(id)
          .run();
        const row = await readRow(db, id);
        const outcome = row ? outcomeOfRow(row) : null;
        if (!row || !outcome) continue;
        const published = await publishOutcome(env, row, outcome);
        if (published) {
          result.republished++;
        } else if (publish_attempts + 1 >= PUBLISH_MAX_ATTEMPTS) {
          // The last allowed attempt failed: nothing selects this row again, and its check stays
          // as it is. Say so, because nobody else will.
          result.abandoned++;
          console.error(
            `[pr-review-sweep] review ${id} (${row.datasetId}#${row.prNumber}): check not published after ${PUBLISH_MAX_ATTEMPTS} attempts; giving up`,
          );
        }
      } catch (err) {
        result.errors++;
        console.error(`[pr-review-sweep] republish ${id} failed (${errName(err)})`);
      }
    }
  } catch (err) {
    result.errors++;
    console.error(`[pr-review-sweep] republish query failed (${errName(err)})`);
  }
  return result;
}
