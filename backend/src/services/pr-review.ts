/**
 * The dataset pull-request review, Worker side (ADR 0092).
 *
 * A pull request opened or updated against `main` of a dataset repository reaches the Worker as a
 * `pull_request` delivery from the NEMAR GitHub App (once the App is subscribed to those events).
 * The Worker decides whether to review it, records the attempt in `pr_reviews`, and dispatches a
 * workflow to `nemarDatasets/.github`. The workflow CLAIMS the review (the Worker accepts the
 * one-shot token and records the time) before it spends anything, reads the change as git
 * data, and asks a model three questions. It posts a report back; the Worker validates it against
 * the closed vocabulary in `shared/pr-review.ts`, derives the verdict, and publishes a check-run
 * and one pull-request comment.
 *
 * **Why the Worker is the gate.** Every pull request reaches it, a fork's included, from a
 * delivery GitHub signs; no workflow in a dataset repository takes part, so no collaborator can
 * edit the review or reach the credentials it uses by editing a branch. It is also the only place
 * that can count: who opened which pull request, how many were rejected, how many reviews were
 * started this hour. Those counts decide whether a review is spent at all. A `repository_dispatch`
 * can be sent by anyone holding a dataset repository's workflow credentials, so the caps bind
 * only reviews the Worker started; the claim step is what makes a forged dispatch buy nothing.
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
 * the delivery shows as failed in the App's delivery log, where it can be redelivered. Redelivery
 * is safe because (dataset, pull request, commit) is unique.
 */

import {
  type AuthorOverride,
  type AuthorTally,
  type CallbackOutcome,
  DAILY_REVIEW_CAP,
  type DeclineReason,
  PrReviewReportError,
  type ReviewOutcome,
  type ReviewState,
  conclusionOf,
  dailyAuthorCapFor,
  hourlyCapFor,
  isDeclineReason,
  isOverrideMode,
  isRunError,
  parsePrReviewReport,
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

/** `pull_request` actions that put new content in front of a reviewer. */
export const PR_REVIEW_ACTIONS: ReadonlySet<string> = new Set([
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
]);

/** The branch whose pull requests are reviewed. */
export const PR_REVIEW_BASE_BRANCH = "main";

/** How long a dispatched review may take before the watchdog gives up on it. The workflow's own limit is 20. */
export const PR_REVIEW_DEADLINE_MINUTES = 30;

/**
 * A result that did not reach GitHub is eligible to be tried again this long after it was decided,
 * up to {@link PUBLISH_MAX_ATTEMPTS} times. The watchdog runs on a 30-minute tick, so the real gap
 * between attempts is that tick, and five attempts take about two and a half hours.
 */
const PUBLISH_RETRY_AFTER_MINUTES = 2;
export const PUBLISH_MAX_ATTEMPTS = 5;

/** Rows the watchdog handles per query (it runs two: overdue reviews, and unpublished results). */
const SWEEP_LIMIT = 20;

/** How long the dispatch may wait for GitHub before the Worker answers the webhook. */
const DISPATCH_TIMEOUT_MS = 10_000;

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
  authorAssociation: string | null;
  fromFork: boolean;
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

/**
 * Read a `pull_request` delivery. Everything in it is attacker-influenced (the title, the branch
 * names, the fork's name), and none of that text is used: only ids, the head commit, the base
 * branch and fixed-shape logins are read, each checked against the shape it must have.
 */
export function readPullRequestEvent(payload: unknown): IntakeResult {
  const p = rec(payload);
  const pr = rec(p?.pull_request);
  const repo = rec(p?.repository);
  if (!p || !pr || !repo) return { ok: false, reason: "malformed" };
  if (typeof p.action !== "string" || !PR_REVIEW_ACTIONS.has(p.action)) {
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
  if (
    prNumber === null ||
    authorId === null ||
    typeof head?.sha !== "string" ||
    !SHA40.test(head.sha) ||
    typeof user?.login !== "string"
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
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The gate: who is reviewed, and how often
// ---------------------------------------------------------------------------------------------

/**
 * Rows that cost a model call, or may yet: everything except a decline (never sent) and a run
 * that errored before the model was reached (the dataset was ineligible, a newer delivery
 * superseded it, or the dispatch failed).
 */
const COUNTS_TOWARD_CAPS = `state != 'declined' AND NOT (state = 'errored' AND detail IN ('stale_head', 'dispatch_failed'))`;

/**
 * The tally for one contributor, counted from the reviews themselves.
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

/**
 * A row's place in its allowance: how many rows that count against it, up to and including this
 * one, were created inside the window. Counted AFTER the row is inserted, so two deliveries that
 * race each see the other and at most the cap survive; checking before inserting let a burst of
 * pull requests all pass the same check.
 */
const AUTHOR_HOURLY_RANK_SQL = `SELECT COUNT(*) AS n FROM pr_reviews
  WHERE author_id = ? AND ${COUNTS_TOWARD_CAPS} AND created_at >= datetime('now', '-1 hour') AND id <= ?`;
const AUTHOR_DAILY_RANK_SQL = `SELECT COUNT(*) AS n FROM pr_reviews
  WHERE author_id = ? AND ${COUNTS_TOWARD_CAPS} AND created_at >= datetime('now', '-1 day') AND id <= ?`;
const PLATFORM_DAILY_RANK_SQL = `SELECT COALESCE(SUM(attempts), 0) AS n FROM pr_reviews
  WHERE ${COUNTS_TOWARD_CAPS} AND created_at >= datetime('now', '-1 day') AND id <= ?`;

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

/** Which allowance, if any, the row just inserted is over. */
async function capDecision(
  db: Db,
  pr: PrIntake,
  rowId: number,
  skipAuthorCaps = false,
  extraCalls = 0,
): Promise<Extract<DeclineReason, "rate_limited" | "daily_limit"> | null> {
  // An administrator who asks for a review by name is not an outsider spending the platform's
  // money, so the per-contributor allowances do not hold it back; the platform's pool still does.
  if (!skipAuthorCaps) {
    const hourly = await db
      .prepare(AUTHOR_HOURLY_RANK_SQL)
      .bind(pr.authorId, rowId)
      .first<{ n: number }>();
    if ((hourly?.n ?? 0) > hourlyCapFor(pr.authorAssociation)) return "rate_limited";
    const daily = await db
      .prepare(AUTHOR_DAILY_RANK_SQL)
      .bind(pr.authorId, rowId)
      .first<{ n: number }>();
    if ((daily?.n ?? 0) > dailyAuthorCapFor(pr.authorAssociation)) return "rate_limited";
  }
  const platform = await db.prepare(PLATFORM_DAILY_RANK_SQL).bind(rowId).first<{ n: number }>();
  // The pool counts model calls, not rows: a restart of an attempt that already spent one is a
  // second call that no row yet shows, so it is added here and recorded once it is handed over.
  if ((platform?.n ?? 0) + extraCalls > DAILY_REVIEW_CAP) return "daily_limit";
  return null;
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
}

const ROW_COLUMNS =
  "id, dataset_id, pr_number, head_sha, state, detail, report, check_run_id, comment_id";

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

/** The outcome a stored row stands for, or null for a review still waiting for its report. */
export function outcomeOfRow(row: ReviewRow): ReviewOutcome | null {
  if (row.state === "reported") {
    try {
      return { kind: "reported", report: parsePrReviewReport(JSON.parse(row.report ?? "null")) };
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
 * Publish an outcome to GitHub: the check-run on the reviewed commit, and (for any outcome but
 * `running`, and only while this is still the last commit of the pull request seen) the
 * pull-request comment. Each surface fails on its own and is logged by status; neither can lose
 * the stored verdict. Returns whether the check-run reached GitHub: a decided outcome whose check
 * did is marked published; one that did not stays unpublished and the watchdog tries again.
 * `running` is bounded (it runs inside the webhook request) and publishes the in-progress check
 * only. `commentOnly` re-states a stored result on the pull request without touching the check.
 */
export async function publishOutcome(
  env: Bindings,
  row: ReviewRow,
  outcome: ReviewOutcome | "running",
  opts: { commentOnly?: boolean } = {},
): Promise<boolean> {
  let checked = false;
  let token: string;
  let refresh: () => Promise<string>;
  try {
    ({ token, refresh } = await getDatasetsTokenWithRefresher(env));
  } catch (err) {
    console.error(`[pr-review] review ${row.id}: no GitHub token (${errName(err)})`);
    return false;
  }
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

  if (outcome === "running") return checked;
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

  if (checked) {
    try {
      await db
        .prepare("UPDATE pr_reviews SET published_at = datetime('now') WHERE id = ?")
        .bind(row.id)
        .run();
    } catch (err) {
      console.error(`[pr-review] review ${row.id}: published_at not stored (${errName(err)})`);
    }
  }
  return checked;
}

/**
 * A stranger pushing commit after commit would otherwise cost two GitHub writes per push for a
 * message that never changes. A decline is published the first time; the same decline for the
 * same pull request within the hour is recorded without being published again.
 */
async function publishDecline(env: Bindings, row: ReviewRow, reason: DeclineReason): Promise<void> {
  const repeat = await env.DB.prepare(
    `SELECT 1 AS ok FROM pr_reviews
      WHERE dataset_id = ? AND pr_number = ? AND state = 'declined' AND detail = ?
        AND published_at IS NOT NULL AND id < ? AND created_at >= datetime('now', '-1 hour')
      LIMIT 1`,
  )
    .bind(row.datasetId, row.prNumber, reason, row.id)
    .first<{ ok: number }>();
  if (repeat) {
    await env.DB.prepare("UPDATE pr_reviews SET published_at = datetime('now') WHERE id = ?")
      .bind(row.id)
      .run();
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
   * from GitHub's own record of the pull request. It lifts the per-contributor allowances for this
   * one review and lets a commit whose review ended without a verdict be started again.
   */
  adminStart?: boolean;
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

  const existing = await readRowByKey(db, pr.datasetId, pr.prNumber, pr.headSha);
  if (existing) return await handleRepeat(env, existing, secret, pr, options);

  const standing = standingOf(
    await readAuthorTally(db, pr.authorId),
    await readAuthorOverride(db, pr.authorId),
  );
  const paused = standing.paused;
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
    return await decideInserted(env, pr, reviewId, paused, nonce, secret, options);
  } catch (err) {
    await markDispatchFailed(db, reviewId);
    throw err;
  }
}

/**
 * The row exists but nothing has run for it (a database error between the insert and the
 * dispatch). Left as 'dispatched' it would count against the caps and wait for the watchdog to call
 * it late, and a redelivery would find it and answer "duplicate". Mark it as a dispatch that did not
 * happen, which a redelivery retries; the caller lets the route answer 500.
 */
async function markDispatchFailed(db: Db, reviewId: number): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE pr_reviews SET state = 'errored', detail = 'dispatch_failed', nonce = NULL,
                decided_at = datetime('now')
          WHERE id = ? AND state = 'dispatched' AND claimed_at IS NULL`,
      )
      .bind(reviewId)
      .run();
  } catch (inner) {
    console.error(`[pr-review] review ${reviewId}: failure not recorded (${errName(inner)})`);
  }
}

/** Everything after the insert: publish a decline, or check the allowances and start the review. */
async function decideInserted(
  env: Bindings,
  pr: PrIntake,
  reviewId: number,
  paused: boolean,
  nonce: string,
  secret: string,
  options: PrReviewOptions & { restarted?: boolean; extraCalls?: number } = {},
): Promise<PrReviewResponse> {
  const db = env.DB;
  const row = await readRow(db, reviewId);
  if (!row) return no("duplicate", reviewId);

  if (paused) {
    await publishDecline(env, row, "contributor_paused");
    return no("contributor_paused", reviewId);
  }

  // A restarted row keeps its old id, which the allowance queries (`id <= ?`) would rank ahead of
  // everything inserted since: it is ranked as the newest instead.
  const over = await capDecision(
    db,
    pr,
    options.restarted ? Number.MAX_SAFE_INTEGER : reviewId,
    options.adminStart === true,
    options.extraCalls ?? 0,
  );
  if (over) {
    await db
      .prepare(
        `UPDATE pr_reviews SET state = 'declined', detail = ?, nonce = NULL, decided_at = datetime('now')
          WHERE id = ? AND state = 'dispatched'`,
      )
      .bind(over, reviewId)
      .run();
    const declined = await readRow(db, reviewId);
    await publishDecline(env, declined ?? row, over);
    return no(over, reviewId);
  }

  // The attempt is going ahead, so a call the row had already spent is now a second one.
  if ((options.extraCalls ?? 0) > 0) {
    await db
      .prepare("UPDATE pr_reviews SET attempts = attempts + ? WHERE id = ?")
      .bind(options.extraCalls, reviewId)
      .run();
  }
  return await startReview(env, row, nonce, secret);
}

/**
 * The commit has been delivered before. It is marked seen again (so it is the pull request's
 * current commit, which is what force-pushing back to an earlier reviewed commit means), its
 * stored result is re-stated on the pull request, and a review whose dispatch failed is tried
 * again. Nothing else is reviewed twice, except that an administrator's start also restarts a
 * commit whose review ended without a verdict (see `isRestartable`).
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

  let current = existing;
  if (await isRestartable(db, existing, options)) {
    const restarted = await restartReview(env, existing, pr, secret, options);
    if (restarted) return restarted;
    // Another delivery moved the row first; what is re-stated below is what it is now, not what
    // this call read before the other one ran.
    current = (await readRow(db, existing.id)) ?? existing;
  }

  const outcome = outcomeOfRow(current);
  if (outcome) await publishOutcome(env, current, outcome, { commentOnly: true });
  return no("duplicate", existing.id);
}

/**
 * A commit whose review can be tried again. A dispatch that failed was not run by GitHub (and a late
 * claim of it is refused, its nonce having been cleared), so a redelivery restarts it. A commit that
 * was declined, ended in an error or never reported is restarted only when an administrator asks by
 * name: a new delivery of the same commit must not buy a second model call. So is one handed to
 * GitHub that is past the watchdog's deadline: the production watchdog would have closed it as
 * `unreported`, and the dev Worker never runs it. A review that is running, or has a result, is never
 * restarted.
 */
async function isRestartable(db: Db, row: ReviewRow, options: PrReviewOptions): Promise<boolean> {
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

/** Whether a row's attempt may have cost a model call: the complement of a decline or an attempt GitHub never ran. */
function spentACall(row: ReviewRow): boolean {
  if (row.state === "declined") return false;
  return !(
    row.state === "errored" &&
    (row.detail === "stale_head" || row.detail === "dispatch_failed")
  );
}

/**
 * Give a commit a fresh attempt, held to the same gate as a new one: a contributor who is paused is
 * declined, and the allowances that apply to it are asked again (an administrator's start only the
 * platform's pool), with the row ranked as the newest (see `decideInserted`). Null when another
 * delivery moved the row first.
 */
async function restartReview(
  env: Bindings,
  existing: ReviewRow,
  pr: PrIntake,
  secret: string,
  options: PrReviewOptions,
): Promise<PrReviewResponse | null> {
  const db = env.DB;
  const standing = standingOf(
    await readAuthorTally(db, pr.authorId),
    await readAuthorOverride(db, pr.authorId),
  );
  const paused = standing.paused;
  const nonce = crypto.randomUUID();
  const reset = await db
    .prepare(
      `UPDATE pr_reviews
          SET state = ?, detail = ?, nonce = ?, claimed_at = NULL, published_at = NULL,
              publish_attempts = 0, decided_at = ${paused ? "datetime('now')" : "NULL"},
              created_at = datetime('now')
        WHERE id = ? AND state = ? AND detail IS ?`,
    )
    .bind(
      paused ? "declined" : "dispatched",
      paused ? "contributor_paused" : null,
      paused ? null : nonce,
      existing.id,
      existing.state,
      existing.detail,
    )
    .run();
  if ((reset.meta.changes ?? 0) !== 1) return null;
  try {
    const res = await decideInserted(env, pr, existing.id, paused, nonce, secret, {
      ...options,
      restarted: true,
      // The earlier attempt cost a model call unless it never got that far.
      extraCalls: spentACall(existing) ? 1 : 0,
    });
    return res.dispatched && res.reason === "dispatched" ? { ...res, reason: "redispatched" } : res;
  } catch (err) {
    await markDispatchFailed(db, existing.id);
    throw err;
  }
}

/** Show the review as running, hand it to GitHub, and record a failure to do so. */
async function startReview(
  env: Bindings,
  row: ReviewRow,
  nonce: string,
  secret: string,
): Promise<PrReviewResponse> {
  const db = env.DB;
  await publishOutcome(env, row, "running");
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
 * caller has verified the token. A review is claimed once, so one dispatch buys one model call;
 * a dispatch for a commit that is no longer the latest delivery recorded by the Worker is refused
 * and recorded as `stale_head`. The workflow also compares the dispatched SHA against the fetched
 * pull ref and current pull-request API response before the model call.
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
