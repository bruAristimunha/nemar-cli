/**
 * The wire shapes of the pull-request review queue's admin routes (ADR 0093, following ADR 0092):
 *
 *   GET    /admin/pr-reviews                      every open pull request to `main`, with its review,
 *                                                 and the volume of reviews over the last day and week
 *   GET    /admin/pr-reviews/:dataset/:pr         one pull request: the stored report, its history
 *   GET    /admin/pr-review-authors/:login        a contributor's record, override and standing
 *   PUT    /admin/pr-review-authors/:login        block a contributor, or lift a block (allow)
 *   DELETE /admin/pr-review-authors/:login        remove that decision
 *   POST   /admin/pr-reviews/:dataset/:pr/start   review a pull request that is already open
 *
 * Types, the closed vocabularies, and nothing else, so the Worker that answers and the CLI that
 * prints read ONE definition. Every string a pull request's author controls (title, branch) arrives
 * here already reduced to plain words; the CLI strips control characters again on the way to the
 * terminal, because it should not rely on a server's hygiene alone.
 */

import type {
  AuthorTally,
  DeclineReason,
  OverrideMode,
  ReviewState,
  RunError,
  Standing,
  StoredOutcome,
} from "../pr-review.js";

// The review's own vocabulary (ADR 0092) is declared once, in `shared/pr-review.ts`.
export type { OverrideMode, ReviewState };

/**
 * What the queue shows for one pull request, in the words an administrator uses.
 *
 *  - `pass`, `fail`, `uncertain`: the derived verdict of a review OF THE CURRENT COMMIT.
 *  - `not_reviewed`: no review of the current commit is on record. That is also the answer when the
 *    review is off, when the contributor was paused (`detail` says so; a row from before the
 *    limits were removed may say rate limited or daily limit), and when the review on record is of
 *    another commit (`review_current` is false and `stale_verdict` says what that one concluded). A
 *    verdict is never carried over to a commit it did not read.
 *  - `in_progress`: the review was handed to GitHub and has not reported.
 *  - `could_not_decide`: the review ran and ended without a verdict (an error, or it never
 *    reported). `detail` says why.
 *  - `exempt`: the pull request's author is a NEMAR owner or administrator, who are not reviewed
 *    (ADR 0107), so no review of the current commit is on record and none is wanted. Its review
 *    check is posted as `skipped` when the commit arrives; this list does not verify that. A review
 *    of the current commit still wins over this word, because a push by someone who is not exempt
 *    IS reviewed, and a review of another commit is never carried over to this one.
 */
export const QUEUE_VERDICTS = [
  "pass",
  "fail",
  "uncertain",
  "not_reviewed",
  "in_progress",
  "could_not_decide",
  "exempt",
] as const;
export type QueueVerdict = (typeof QUEUE_VERDICTS)[number];

/**
 * A verdict a STORED review can have: every word but `exempt`, which is about a pull request with
 * no review of its current commit and is never what a row says. The queue and the detail view may
 * say `exempt`; a review record and a history item may not.
 */
export type StoredVerdict = Exclude<QueueVerdict, "exempt">;

/** Every {@link StoredVerdict}: the queue's own words but `exempt`, so a word added there is counted too. */
export const STORED_VERDICTS: readonly StoredVerdict[] = QUEUE_VERDICTS.filter(
  (v): v is StoredVerdict => v !== "exempt",
);

/** A verdict that means the review READ a commit and concluded something about it. */
export type ReadVerdict = "pass" | "fail" | "uncertain";

/** The state of one required check on the pull request's head commit. */
export const CHECK_STATES = ["pass", "fail", "pending", "missing", "unknown"] as const;
export type CheckState = (typeof CHECK_STATES)[number];

export type QueueEnvironment = "production" | "non-production";

/** The closed reason behind a `not_reviewed` (a decline) or `could_not_decide` (a run error). */
export type VerdictDetail = DeclineReason | RunError | "unreported";

/**
 * Every error word these routes answer with, in the body's `code` field. (The body's `error` field
 * is the sentence; a client that wants the word reads `code`, not `error`.)
 */
export const QUEUE_ERROR_CODES = [
  "bad_verdict",
  "bad_dataset",
  "bad_pr",
  "bad_head",
  "bad_login",
  "not_owned_here",
  "no_such_pull_request",
  "no_such_user",
  "not_a_user",
  "ambiguous_login",
  "github_unavailable",
  "github_timeout",
  "github_rate_limited",
  "github_refused",
  "github_graphql_error",
  "github_bad_response",
  "internal",
] as const;
export type QueueErrorCode = (typeof QUEUE_ERROR_CODES)[number];

export interface QueueEntry {
  dataset_id: string;
  pr_number: number;
  url: string;
  /** Plain words only (`sanitizeNote`). */
  title: string;
  author_login: string;
  /** GitHub's numeric id, the key of the contributor tally. Null for a ghost, a bot or an organisation. */
  author_id: number | null;
  from_fork: boolean;
  /** `branch`, or `owner:branch` for a fork. A conservative character set; anything else becomes `?`. */
  head_label: string;
  head_sha: string;
  draft: boolean;
  created_at: string;
  updated_at: string;
  verdict: QueueVerdict;
  detail: VerdictDetail | null;
  /** The commit the review on record read, or null when there is none. */
  reviewed_sha: string | null;
  /** True when the review on record is of this pull request's current head; null with no review. */
  review_current: boolean | null;
  /** What the review of ANOTHER commit concluded, when `review_current` is false. Null if it gave no verdict. */
  stale_verdict: ReadVerdict | null;
  /** The BIDS validation check (`Run BIDS Validation`, pinned to the NEMAR App; `bids-validation` on a legacy repo). */
  bids: CheckState;
  /** The `version-check` check. */
  version: CheckState;
  /** An administrator can act on this one now: approve it, or review it by hand. */
  needs_you: boolean;
}

export interface QueueSkipped {
  /** Open pull requests in repositories whose name is not a dataset id. */
  not_a_dataset: number;
  /** Datasets the other environment's Worker answers for (the dev/production ownership fence). */
  not_owned_here: number;
  /** Search results GitHub returned that could not be read as a pull request, so they are not in the list. */
  unreadable: number;
}

export interface QueueFilters {
  verdicts: QueueVerdict[];
  dataset: string | null;
  author: string | null;
  needs_me: boolean;
}

/**
 * What the review did over one window of time. Information for the administrator who reads the
 * list, and never an input to a decision: no count here, or anywhere, decides whether a pull
 * request is reviewed (ADR 0107).
 */
export interface VolumeWindow {
  /** Review records created in the window. A commit started again counts as a new record. */
  reviews: number;
  /**
   * Model calls those records cost, or may yet cost: the sum of their attempts, leaving out a
   * decline and a run that never reached the model (a dispatch GitHub did not run, a commit a newer
   * one superseded).
   */
  model_calls: number;
  /** The records by what they came to, in the words the list uses. Every word is there, zero if unseen. */
  by_verdict: Record<StoredVerdict, number>;
  /** The declined records by their reason word. Every stored word is there, zero if unseen. */
  declines: Record<DeclineReason, number>;
}

/** The volume of the last day and of the last week, counted from when each record was created. */
export interface QueueVolume {
  last_24_hours: VolumeWindow;
  last_7_days: VolumeWindow;
}

export interface QueueResponse {
  environment: QueueEnvironment;
  /** The review itself is switched on in this environment (`PR_REVIEW_ENABLED`). */
  review_enabled: boolean;
  /** Pull requests after the filters, ordered with the ones an administrator can act on first. */
  entries: QueueEntry[];
  /** Open dataset pull requests this Worker answers for, before the filters were applied. */
  total_open: number;
  /** GitHub search returned fewer pull requests than exist (its 1000-result cap, or a page limit). */
  truncated: boolean;
  skipped: QueueSkipped;
  filters: QueueFilters;
  /**
   * What the review has done lately across the whole platform, whatever the filters are. Null when
   * it could not be read this time: informing never holds up the list, and an unread count is not
   * a count of zero.
   */
  volume: QueueVolume | null;
}

/**
 * What starting the review of one open pull request came to. `reason` is one of the review's own
 * fixed words (ADR 0092): `dispatched`, `redispatched` (a commit started again) or `dispatch_claimed`
 * (GitHub's answer was lost but the workflow had already claimed it) when it was handed to GitHub,
 * otherwise why not (`duplicate`, `contributor_paused`, `exempt_author` (its author is an owner or
 * administrator, so it is not reviewed and its check was posted as skipped), `draft`,
 * `not_open`, `not_main`, `bot_author`, `dataset_not_reviewable`, `pr_review_disabled`, ...).
 * `review_id` is null when no review row exists for it.
 */
export interface StartReviewResponse {
  environment: QueueEnvironment;
  dispatched: boolean;
  reason: string;
  review_id: number | null;
  /** The pull request's author, when GitHub gave a login of the shape a login has; else null. */
  author_login: string | null;
}

export interface ReviewHistoryItem {
  id: number;
  head_sha: string;
  state: ReviewState;
  verdict: StoredVerdict;
  created_at: string;
  decided_at: string | null;
}

export interface ReviewRecord {
  id: number;
  head_sha: string;
  /** What this review concluded of ITS OWN commit, re-derived from the stored report. */
  verdict: StoredVerdict;
  detail: VerdictDetail | null;
  author_login: string;
  author_id: number;
  from_fork: boolean;
  created_at: string;
  decided_at: string | null;
  /** The stored outcome, re-validated on the way out; null while the review is in progress. */
  outcome: StoredOutcome | null;
}

/** What GitHub says about the pull request right now. Best effort: null when GitHub could not be read. */
export interface LivePullRequest {
  state: "open" | "closed" | "merged";
  draft: boolean;
  head_sha: string;
  base_ref: string;
  url: string;
  title: string;
  author_login: string;
  author_id: number | null;
  from_fork: boolean;
  head_label: string;
}

export interface ContributorStanding {
  login: string;
  author_id: number;
  /** The record of rejected pull requests: information, and never a reason to pause anyone. */
  tally: AuthorTally;
  override: null | {
    mode: OverrideMode;
    reason: string | null;
    set_at: string;
    set_by: string | null;
  };
  /** The standing the review gate applies today. Only a block pauses a contributor; the tally never does. */
  standing: Standing;
  /** The latest decided review of each of the contributor's most recent pull requests. */
  recent: Array<{
    dataset_id: string;
    pr_number: number;
    head_sha: string;
    verdict: "pass" | "fail";
    decided_at: string | null;
  }>;
  /**
   * Where the login and id came from: GitHub just now, or the Worker's own records (the review
   * history or an override) because GitHub was not asked or could not answer.
   */
  resolved_from: "github" | "history";
}

export interface PrReviewDetail {
  environment: QueueEnvironment;
  review_enabled: boolean;
  dataset_id: string;
  pr_number: number;
  /**
   * The commit the verdict below is about: the `head` the caller named, else the head GitHub reports
   * now. Null when neither is known, in which case no verdict is asserted (see `verdict`).
   */
  head_sha: string | null;
  /**
   * What the queue would call this pull request at `head_sha`: a stored verdict only when the review
   * on record read that commit. With no commit to compare against it is `not_reviewed`, never the
   * stored verdict, because a pass whose commit is unknown is not a pass about this one. Unlike the
   * list, which reads the stored column, this is the STRICTER of that column and the verdict
   * re-derived from the stored report: a report that no longer parses reads as `could_not_decide`
   * here unless the column says `fail`, and a rule change that would now pass an old `fail` does not.
   */
  verdict: QueueVerdict;
  detail: VerdictDetail | null;
  /** What the review on record concluded when it is not (or not known to be) of `head_sha`. */
  stale_verdict: ReadVerdict | null;
  /** The review of `head_sha` if one exists, else the newest review on record; null if none. */
  review: ReviewRecord | null;
  /** The 20 most recent stored reviews of this pull request, newest first. */
  history: ReviewHistoryItem[];
  /** There are older stored reviews than `history` holds. */
  history_truncated: boolean;
  live: LivePullRequest | null;
  /**
   * Why `live` is what it is: `found`, `missing` (GitHub answered 404, so there is no such pull
   * request or the datasets token cannot see it) or `unreadable` (GitHub could not be asked, or
   * its answer could not be read). A `live` of null is not one thing.
   */
  live_status: "found" | "missing" | "unreadable";
  /** True when `review` is of `head_sha`; null when there is no review or no `head_sha`. */
  review_current: boolean | null;
  /** The pull request's author, with the standing the review gate would apply today. */
  author: ContributorStanding | null;
}

/** The body of `PUT /admin/pr-review-authors/:login`. */
export interface SetOverrideRequest {
  mode: OverrideMode;
  /** Plain words; kept to 200 characters. */
  reason?: string;
}

export interface SetOverrideResponse {
  environment: QueueEnvironment;
  /** What the contributor had before this call. */
  previous: OverrideMode | null;
  standing: ContributorStanding;
}

export interface ClearOverrideResponse {
  environment: QueueEnvironment;
  /** What was removed; null when there was nothing to remove. */
  removed: OverrideMode | null;
  standing: ContributorStanding;
}
