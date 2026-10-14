/**
 * The wire shapes of the publication review's admin surfaces (ADR 0102, section 8):
 *
 *   GET  /admin/publish/requests              each row gains `publication_review`
 *   GET  /admin/publish/:id/review            the review of the active request, with its history
 *   POST /admin/publish/:id/review/start      start the review of the current screened commit
 *
 * and the shapes the approval and the comment answer with (ADR 0102, sections 8 and 9):
 *
 *   POST /admin/publish/:id/approve           409 for a blocked request, and when the review gate refuses
 *   POST /admin/publish/:id/approve-dispatch  409 when the review gate refuses
 *   POST /admin/publish/:id/comment           a typed message mailed to the depositor
 *
 * Types and closed vocabularies only, so the Worker that answers and the CLI that prints read ONE
 * definition. Every sentence comes from `shared/publication-review.ts`: `describePublicationReview`,
 * `describeUnreadableReview` and the reasons table; a client renders the server's words and decides
 * nothing itself.
 * No shape here carries a nonce, a token, a path, a file name or a screen finding.
 */

import type { ScreenState } from "../identifier-screen-report.js";
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
  ReviewGateRefusal,
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
  ReviewGateRefusal,
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
  /**
   * The whole reason as one line in the shared words (`reasonLine`: the sentence, the detail in
   * words and the cure), the line `description.lines` carries for it. A client prints this and
   * composes nothing from `detail`, whose closed words are not words for a person. Absent from a
   * Worker that predates the field; a client then falls back to the sentence and the cure.
   */
  line?: string;
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
  /**
   * An administrator's `start` is offered for this request: the one rule `describePublicationReview`
   * uses for its next command (`startOffered`), and the route's own screen precondition. False
   * unless the review is on and applies. A start the platform's allowance or the Worker's
   * ownership refuses is still offered here, and answers 409; a client that starts many stops on
   * `platform_limit`.
   */
  start_offered: boolean;
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

/**
 * The request's identifier screen in `describeScreen`'s words: the same view the list row's
 * `identifier_screen` carries, one function behind both. `state` is the stored state, `exempt` for
 * a sandbox dataset, or null when no screen was started.
 */
export interface PublicationReviewScreenView {
  state: ScreenState | "exempt" | null;
  headline: string;
  tone: "ok" | "note" | "warn" | "stop";
  lines: string[];
}

/** `GET /admin/publish/:id/review`. */
export interface PublicationReviewDetail {
  environment: PublicationReviewEnvironment;
  enabled: boolean;
  dataset_id: string;
  request_id: number;
  request_status: string;
  anonymous: boolean;
  /** The request's screen, so `approve` and `next` show it from the one read they make. */
  identifier_screen: PublicationReviewScreenView;
  /** The screen acknowledgment on record (who and when), or null. Its reason is not carried. */
  screen_acknowledgment: { by: number; at: string } | null;
  /** The request's block reason when it is blocked, as a plain word (`shownBlockReason`), else null. */
  block_reason: string | null;
  /**
   * The request is `approving`, or `blocked` by the owner-name walk-back, and a step after the
   * validation-only ones completed (`hasStartedPublishing`): a resume passes no gate, and
   * `approve` without `--resume` would start the run over.
   */
  started_publishing: boolean;
  /** `datasets.total_files` (the manifest-first count), or null when unknown. */
  total_files: number | null;
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

// ---------------------------------------------------------------------------------------------
// The approval gate (ADR 0102, sections 8 and 9)
// ---------------------------------------------------------------------------------------------

/**
 * What an administrator approves over: the review shown and the reasons shown. The Worker records
 * an override only when `review_id` is the review in force and `reasons` names every override-class
 * reason that stands, so it attaches to what was shown or to nothing (`uncoveredByOverride`).
 */
export interface PublicationReviewOverride {
  /** The review in force when it was shown; null when no review of the screened commit exists. */
  review_id: number | null;
  /** The reason codes shown. Only override-class codes are recorded. */
  reasons: ReasonCode[];
}

/**
 * The approval routes' body field. `/approve` accepts it from a bearer key only; the website
 * records one through `approve-dispatch`.
 */
export const OVERRIDE_FIELD = "override_publication_review";

/**
 * The `error` of the 409 the approval routes answer with when the review gate refuses. A code in
 * `error` and the sentence in `message`, so the CLI's client leads with the sentence
 * (`APPROVAL_REFUSAL_ERROR_CODES`).
 */
export const PUBLICATION_REVIEW_NOT_CLEAR_CODE = "publication_review_not_clear";

/** The `error` of the 409 `POST /admin/publish/:id/approve` answers with for a blocked request. */
export const REQUEST_BLOCKED_CODE = "request_blocked";

/**
 * 409 from `POST /admin/publish/:id/approve` and `approve-dispatch` when the review gate cannot
 * read what it needs (`refusal: "unverified"`): it refuses rather than guess, so it has no review
 * to describe. The refusal says nothing about the review: no outcome, no reason, no review id.
 * `fact` names the check that could not be completed (the request or the review; a failed record of
 * an override is the review's too), a field no client reads: the sentence in `message` is what an
 * administrator is told.
 */
export interface PublicationReviewUnverifiedRefusalBody {
  error: typeof PUBLICATION_REVIEW_NOT_CLEAR_CODE;
  refusal: "unverified";
  /** `REVIEW_UNREADABLE_HEADLINE`. */
  headline: string;
  /** `reviewGateRefusalText("unverified", ...)`. */
  message: string;
  outcome: null;
  reasons: [];
  uncovered: [];
  review_id: null;
  fact: "request" | "review";
}

/**
 * 409 from `POST /admin/publish/:id/approve` and `approve-dispatch` when the review gate refuses a
 * review it read: every refusal word but `unverified`. It carries no `fact`. The review's headline
 * and every live reason in the shared words come with it, except on the `review_changed` fallback
 * after a re-read that failed, which is bare (the unreadable headline, no outcome, no reasons).
 */
export interface PublicationReviewReasonedRefusalBody {
  error: typeof PUBLICATION_REVIEW_NOT_CLEAR_CODE;
  refusal: Exclude<ReviewGateRefusal, "unverified">;
  /** The review's headline (`REVIEW_UNREADABLE_HEADLINE` on the bare `review_changed` fallback). */
  headline: string;
  /** `reviewGateRefusalText`, then for `hard_reason` the first hard reason's sentence and cure. */
  message: string;
  outcome: PublicationOutcome | null;
  /** Every live reason in the shared words (`reasonViewsOf`). */
  reasons: ReasonView[];
  /**
   * The override-class codes the override did not name; empty unless the refusal is about them
   * (`override_not_covering`, `needs_override`).
   */
  uncovered: ReasonCode[];
  review_id: number | null;
}

/**
 * 409 from `POST /admin/publish/:id/approve` and `approve-dispatch` when the review gate refuses,
 * discriminated by `refusal` so a client switches on it exhaustively: `unverified` carries a
 * `fact` and nothing of a review, every other word carries the review and no `fact`.
 */
export type PublicationReviewGateRefusalBody =
  | PublicationReviewUnverifiedRefusalBody
  | PublicationReviewReasonedRefusalBody;

/**
 * 409 from `POST /admin/publish/:id/approve` for a blocked request, whatever the flag says: a
 * blocked request is refused by the mechanical rules, not by the review. `block_reason` is a
 * top-level field so the CLI's existing hints for a block reason work unchanged.
 */
export interface RequestBlockedRefusalBody {
  error: typeof REQUEST_BLOCKED_CODE;
  block_reason: string | null;
  /** `REASONS.request_blocked.sentence` and its cure; the word is the separate `block_reason`. */
  message: string;
}

// ---------------------------------------------------------------------------------------------
// The administrator's comment
// ---------------------------------------------------------------------------------------------

/** The most characters a comment may have once trimmed; it must have at least one. */
export const PUBLICATION_COMMENT_MAX_LENGTH = 2000;

/** `POST /admin/publish/:id/comment`: the administrator's words, which the depositor is mailed. */
export interface PublicationCommentBody {
  message: string;
}

/** HTTP 200: the message was mailed to the depositor and the request stays open. */
export interface PublicationCommentResponse {
  dataset_id: string;
  request_id: number;
  mailed: true;
}

/**
 * Every error word the comment route answers with, in the body's `code`. A send that failed is one
 * of two, by what the Worker knows of the mail:
 *
 *  - `comment_not_sent`: it knows nothing was delivered (the provider refused the message with a
 *    4xx, the environment's fence refused the recipient, the depositor has no address, or the
 *    depositor could not be read), so it says so.
 *  - `comment_not_confirmed`: it cannot know (a provider's server error, an unreachable host or a
 *    lost answer), so the mail may also have arrived and the sentence tells the administrator to
 *    check with the depositor before sending it again.
 *
 * Both are HTTP 502, and the audit row records the first as `not_sent` and the second as `unknown`.
 */
export const PUBLICATION_COMMENT_ERROR_CODES = [
  "bad_dataset",
  "not_found",
  "origin_not_allowed",
  "invalid_body",
  "comment_not_sent",
  "comment_not_confirmed",
  "internal",
] as const;
export type PublicationCommentErrorCode = (typeof PUBLICATION_COMMENT_ERROR_CODES)[number];

/**
 * The body of every refusal and fault of the comment route: a fixed sentence and a closed code,
 * the convention of the review routes (`{ error: sentence, code: word }`), unlike the approval
 * refusals above, which carry their word in `error`.
 */
export interface PublicationCommentErrorBody {
  error: string;
  code: PublicationCommentErrorCode;
}
