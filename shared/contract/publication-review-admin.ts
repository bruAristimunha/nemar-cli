/**
 * The wire shapes of the publication review's admin surfaces (ADR 0102, section 8):
 *
 *   GET  /admin/publish/requests              each row gains `publication_review`
 *   GET  /admin/publish/:id/review            the review of the active request, with its history
 *   POST /admin/publish/:id/review/start      start the review of the current screened commit
 *
 * Types and closed vocabularies only, so the Worker that answers and the CLI that prints read ONE
 * definition. Every sentence comes from `shared/publication-review.ts`: `describePublicationReview`,
 * `describeUnreadableReview` and the reasons table; a client renders the server's words and decides
 * nothing itself.
 * No shape here carries a nonce, a token, a path, a file name or a screen finding.
 */

import type {
  Answer,
  PublicationDeclineDetail,
  PublicationOutcome,
  PublicationReviewDescription,
  PublicationReviewEvidence,
  PublicationReviewState,
  PublicationRunError,
  Question,
  ReasonCode,
} from "../publication-review.js";

// The review's own vocabulary is declared once, in `shared/publication-review.ts`.
export type {
  Answer,
  PublicationDeclineDetail,
  PublicationOutcome,
  PublicationReviewDescription,
  PublicationReviewEvidence,
  PublicationReviewState,
  PublicationRunError,
  Question,
  ReasonCode,
};

/** Which Worker answered: its own D1, its own reviews. */
export type PublicationReviewEnvironment = "production" | "non-production";

/**
 * What a surface shows for one request, before the outcome:
 *
 *  - `not_applicable`: an OpenNeuro mirror or an exemplar; no row, no gate, no outcome.
 *  - `off`: `PUBLICATION_REVIEW_ENABLED` is not `1`. A stored review is still derived and shown,
 *    as advice that gates nothing.
 *  - `not_reviewed`: no review of the screened commit and flag is on record, or the request is
 *    over and none ever was.
 *  - `running`: the review in force was handed to GitHub and has not reported or aged out.
 *  - `decided`: the review in force reached a terminal state (reported, declined, errored or
 *    unreported); the outcome and its reasons say what that means.
 *  - `unreadable`: the review is ON and the Worker could not read what it needed to say anything
 *    about this request (a fault of its own reads, not a state of the request). The outcome is
 *    `action_required`, never a pass, with no reason: the cure of `review_could_not_run`, "start
 *    it again", is wrong advice for a read fault, so none of the reasons is reused. With the
 *    review OFF a failed read is not this kind: nothing is gated, so the row reads as `off`, not
 *    assessed, exactly as the admin email leaves it out.
 */
export const PUBLICATION_REVIEW_VIEW_KINDS = [
  "not_applicable",
  "off",
  "not_reviewed",
  "running",
  "decided",
  "unreadable",
] as const;
export type PublicationReviewViewKind = (typeof PUBLICATION_REVIEW_VIEW_KINDS)[number];

/**
 * What the approval gate does with this request: `enforced` (the review is on and applies), `off`
 * (the review is off, so a stored review is advice), or `n/a` (the review does not apply). This is
 * the state the view DECLARES for the gate that Phase 2 builds. In Phase 1 nothing enforces it:
 * no approval route reads the review, so `enforced` says what Phase 2 will do, not what happens
 * today.
 */
export type PublicationReviewGateState = "enforced" | "off" | "n/a";

/** One reason, with the shared words for it. */
export interface ReasonView {
  code: ReasonCode;
  class: "fail" | "unknown";
  cleared_by: "nothing" | "screen_acknowledgment" | "override";
  /** The closed word or words behind the reason, or null. */
  detail: string | null;
  sentence: string;
  cure: string;
}

/** The review of one row of `GET /admin/publish/requests`. */
export interface PublicationReviewSummary {
  kind: PublicationReviewViewKind;
  /** `PUBLICATION_REVIEW_ENABLED` is exactly `"1"`. */
  enabled: boolean;
  gate: PublicationReviewGateState;
  /**
   * Null when the request is not assessed: `not_applicable`, or no review is on record and none
   * gates the request (`off`, or a `not_reviewed` request that is over). Such a row has no reasons
   * either. An open request with the review on and no review on record is assessed, and reads
   * `action_required` with `review_not_started`. The one assessed row with an outcome and no
   * reason is `unreadable`.
   */
  outcome: PublicationOutcome | null;
  headline: string;
  tone: "ok" | "note" | "warn" | "stop";
  reasons: ReasonCode[];
  /** The review in force, when there is one. */
  review_id: number | null;
  head_sha: string | null;
}

/** The review in force, as `GET /admin/publish/:id/review` shows it. Counts and closed words only. */
export interface PublicationReviewRecord {
  id: number;
  head_sha: string;
  anonymous: boolean;
  state: PublicationReviewState;
  /** The closed word of a declined or errored row. */
  detail: PublicationDeclineDetail | PublicationRunError | null;
  /** The verdict column, as stored when the review reported. */
  stored_verdict: PublicationOutcome | null;
  model: string | null;
  version: string | null;
  created_at: string;
  decided_at: string | null;
  started_by: number | null;
  /** The administrator's recorded override (written by Phase 2), and the reasons it was given for. */
  override: { by: number; at: string; reasons: ReasonCode[] } | null;
  /** After the facts (`answersOf`); null when there is no readable report. */
  questions: Record<Question, Answer> | null;
  /**
   * The facts that lowered an answer below the model's, in closed words with the shared sentence
   * for each, so an answer the platform's own facts failed is never read as the reviewer's. A
   * question the model itself failed has no entry here and lists its findings instead. Empty when
   * there is no readable report. `fact` is a plain string so a newer server's word does not break
   * an older client.
   */
  fact_notes: Array<{ question: Question; fact: string; result: "fail" | "unknown"; text: string }>;
  /** Severity and code are plain strings so a newer server's word does not break an older client. */
  findings: Array<{
    question: Question;
    severity: string;
    code: string;
    document: string | null;
    note: string;
  }>;
  /** The model's summary, sanitized. */
  summary: string | null;
  evidence: PublicationReviewEvidence | null;
}

/**
 * One review of the request, newest first: every row the request has, the review in force included
 * when it is among the newest. An entry is a record of what a review concluded, never the
 * request's outcome, which is derived from the review in force and the live facts.
 */
export interface PublicationReviewHistoryEntry {
  id: number;
  head_sha: string;
  anonymous: boolean;
  state: PublicationReviewState;
  /** The verdict column as stored, named as the record names it. */
  stored_verdict: PublicationOutcome | null;
  created_at: string;
  decided_at: string | null;
}

/** `GET /admin/publish/:id/review`. */
export interface PublicationReviewDetail {
  environment: PublicationReviewEnvironment;
  enabled: boolean;
  dataset_id: string;
  request_id: number;
  request_status: string;
  anonymous: boolean;
  applies: boolean;
  gate: PublicationReviewGateState;
  /** Null when the request is not assessed; see {@link PublicationReviewSummary.outcome}. */
  outcome: PublicationOutcome | null;
  reasons: ReasonView[];
  /** Headline, tone, lines (the standing line last) and the next command. */
  description: PublicationReviewDescription;
  review: PublicationReviewRecord | null;
  history: PublicationReviewHistoryEntry[];
  history_truncated: boolean;
}

// ---------------------------------------------------------------------------------------------
// The administrator's start
// ---------------------------------------------------------------------------------------------

/**
 * A start that went (HTTP 202): `dispatched` and `redispatched` handed a run to GitHub, and
 * `dispatch_claimed` means a failed dispatch found its run already claimed, so the run stands.
 */
export const START_STARTED_REASONS = ["dispatched", "redispatched", "dispatch_claimed"] as const;
export type StartStartedReason = (typeof START_STARTED_REASONS)[number];

/**
 * A request that cannot be started as it stands (HTTP 409, an {@link PublicationReviewErrorBody}):
 * each word is also the body's `code`, one of {@link PUBLICATION_REVIEW_ERROR_CODES}.
 * `depositor_limit` is not here: the depositor's allowance holds a screen result's start, never
 * an administrator's, which only the platform's allowance holds.
 */
export const START_REFUSED_REASONS = [
  "review_disabled",
  "not_applicable",
  "not_owned_here",
  "request_not_requested",
  "screen_not_ready",
  "running",
  "has_result",
  "platform_limit",
] as const;
export type StartRefusedReason = (typeof START_REFUSED_REASONS)[number];

/**
 * A start that could not hand its review over (HTTP 502): the row is recorded, so a start can try
 * again. Each word is also the body's `code`.
 */
export const START_NOT_HANDED_OVER_REASONS = ["dispatch_failed", "dispatch_unconfigured"] as const;
export type StartNotHandedOverReason = (typeof START_NOT_HANDED_OVER_REASONS)[number];

/** Every word a start's answer carries as its `reason`: went, refused, or not handed over. */
export const START_REASONS = [
  ...START_STARTED_REASONS,
  ...START_REFUSED_REASONS,
  ...START_NOT_HANDED_OVER_REASONS,
] as const;
export type StartReason = (typeof START_REASONS)[number];

/** `POST /admin/publish/:id/review/start`, HTTP 202: a run is going. It always has a review. */
export interface StartedPublicationReview {
  environment: PublicationReviewEnvironment;
  started: true;
  reason: StartStartedReason;
  review_id: number;
}

/**
 * `POST /admin/publish/:id/review/start`, HTTP 502: the row is recorded and nothing is running.
 * `error` is a fixed sentence and `code` the same word as `reason`, so a client that reads the
 * error body of any refusal reads this one the same way.
 */
export interface NotHandedOverPublicationReview {
  environment: PublicationReviewEnvironment;
  started: false;
  reason: StartNotHandedOverReason;
  /** The row that records the failure, or null when none could be written. */
  review_id: number | null;
  error: string;
  code: StartNotHandedOverReason;
}

/**
 * `POST /admin/publish/:id/review/start`, on the two answers that carry a start's own shape,
 * discriminated by `started` so a started answer cannot carry a refusal's word and the reverse.
 * The field is `started`, not `dispatched` as in the pull-request review's start: a start here
 * also stands on a run that was dispatched earlier (`dispatch_claimed`), which "dispatched" would
 * misstate. Every other answer (a refusal, a missing request, a fault) is a
 * {@link PublicationReviewErrorBody}.
 */
export type StartPublicationReviewResponse =
  | StartedPublicationReview
  | NotHandedOverPublicationReview;

/**
 * Every error word these routes answer with, in the body's `code` field: a refusal, a missing
 * request, a fault, and the two ways a start could not hand its review over.
 */
export const PUBLICATION_REVIEW_ERROR_CODES = [
  "bad_dataset",
  "not_found",
  "origin_not_allowed",
  "review_disabled",
  "not_applicable",
  "not_owned_here",
  "request_not_requested",
  "screen_not_ready",
  "running",
  "has_result",
  "platform_limit",
  "dispatch_failed",
  "dispatch_unconfigured",
  "internal",
] as const;
export type PublicationReviewErrorCode = (typeof PUBLICATION_REVIEW_ERROR_CODES)[number];

/** The body of every refusal and fault of these routes: a fixed sentence and a closed code. */
export interface PublicationReviewErrorBody {
  error: string;
  code: PublicationReviewErrorCode;
}
