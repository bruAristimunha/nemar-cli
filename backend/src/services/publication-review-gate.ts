/**
 * The publication review as a gate on approval (ADR 0102, sections 8 and 9).
 *
 * `POST /admin/publish/:id/approve` and `approve-dispatch` ask this module, after the identifier
 * screen's gate and before the request is marked `approving`, whether the review lets the approval
 * through. It never approves or denies anything: it answers yes, or a refusal in the shared words
 * (`reviewGateRefusalText`), and it records the administrator's override when one was needed.
 *
 * Only the OVERRIDE is recorded last, and only after every gate has passed: the routes call
 * {@link recordApprovalOverride} then. It can remain on its row, bound to that review, those
 * reasons and its approver, when a later check or the dispatch then fails. The screen's
 * acknowledgment is not part of that: it is the screen gate's own, recorded when that gate passes,
 * and it stands on its own (it is about the screen, and a later run by the same administrator uses
 * it). An approval this module refuses can therefore leave the acknowledgment on the record, and
 * that is intended.
 *
 * What it pins, and why each line is here:
 *
 *  - **With the flag off it reads nothing.** Production is dark until the review is switched on, so
 *    a fault of the review table must not stop an approval there. The mechanical rules that hold
 *    with the flag off live outside this module (the blocked refusal, the store's re-block).
 *  - **It fails closed.** A read that fails, a record of the override that cannot be written, or
 *    anything that throws after the request was read, is a refusal (`unverified`), never a pass
 *    and never a 500 (ADR 0053, ADR 0054).
 *  - **Hard reasons are checked before the override.** Nothing clears them, so an override in the
 *    body changes nothing for a request that has one.
 *  - **An override attaches to what was shown, or to nothing.** It names the review it was given
 *    for and the reasons shown; it is recorded only when that review is still the one in force,
 *    and only by a statement that pins the row as it was read (`RECORD_OVERRIDE_SQL`).
 *  - **A recorded override is its approver's.** It satisfies a later run only when that run is
 *    attributed to the same administrator (`resolveApprover`; ADR 0103, decision 4): a run the
 *    web started (it carries the click's dispatch token) passes on its clicker's override, and
 *    any other administrator's run, a terminal's included, does not.
 */

import {
  PUBLICATION_REVIEW_NOT_CLEAR_CODE,
  type PublicationReviewGateRefusalBody,
  type PublicationReviewOverride,
  type PublicationReviewReasonedRefusalBody,
  REQUEST_BLOCKED_CODE,
  type RequestBlockedRefusalBody,
} from "../../../shared/contract/publication-review-admin.js";
import {
  OVERRIDE_REASONS,
  type PublicationOutcome,
  REASONS,
  REVIEW_UNREADABLE_HEADLINE,
  type ReasonCode,
  type ReviewGateRefusal,
  cureOf,
  hardReasonsOf,
  overrideClassReasonsOf,
  reviewGateRefusalText,
  shownBlockReason,
  uncoveredByOverride,
  verdictOf,
} from "../../../shared/publication-review.js";
import { auditLogStatement } from "../db/audit-log";
import type { Bindings } from "../types/bindings";
import { errorWords } from "./publication-review-log.js";
import type { PublicationReviewRow } from "./publication-review-rows.js";
import {
  type DerivedPublicationReview,
  derivePublicationReview,
  overrideReasonsOf,
  publicationReviewApplies,
  readReviewContext,
  reasonViewsOf,
  reportOf,
  reviewEnabled,
} from "./publication-review-view.js";

/** The gate's state for this environment and dataset: what the approval's audit row records. */
export function reviewGateStateOf(
  env: Bindings,
  dataset: { source?: string | null; is_exemplar?: number | null },
): "enforced" | "off" | "n/a" {
  if (!reviewEnabled(env)) return "off";
  return publicationReviewApplies(dataset) ? "enforced" : "n/a";
}

/**
 * The 409 body for a blocked request. It holds whatever the flag says and for every dataset, since
 * it is the mechanical rule and not the review's verdict, so it is its own code rather than
 * `publication_review_not_clear`. The block reason is a top-level field so the CLI's hints for it
 * work unchanged, and it is shown only when it is a plain word (`shownBlockReason`).
 */
export function requestBlockedRefusal(
  datasetId: string,
  blockReason: string | null,
): RequestBlockedRefusalBody {
  const rule = REASONS.request_blocked;
  return {
    error: REQUEST_BLOCKED_CODE,
    block_reason: shownBlockReason({ status: "blocked", block_reason: blockReason }),
    message: `${rule.sentence} ${cureOf("request_blocked", datasetId, false)}`,
  };
}

export interface ReviewGateArgs {
  requestId: number;
  datasetId: string;
  /** The administrator the run is attributed to: `c.approver.id` in /approve, the clicker in approve-dispatch. */
  approverId: number;
  /** The caller's override, shape-checked by zod; undefined when none was sent. */
  override?: PublicationReviewOverride;
  /**
   * The web dispatch cannot carry an override that has no review row to hold it (the executor that
   * follows reads the clicker's override from the row), so it refuses `no_review_row` instead of
   * passing with an override to record. A terminal does not set this: its override is recorded in
   * the audit row alone.
   */
  requireRow?: boolean;
  nowMs?: number;
}

export interface OverrideToRecord {
  /** The review in force as it was read, or null when there is none (terminal only). */
  row: PublicationReviewRow | null;
  /** The override-class codes that stand and the override covers, unique, in `REASON_CODES` order. */
  reasons: ReasonCode[];
}

export type ReviewGateResult =
  | { ok: true; state: "off" | "n/a" }
  | {
      ok: true;
      state: "enforced";
      outcome: PublicationOutcome;
      headSha: string | null;
      /** Set when the caller's override was needed and is not already on the row as given. */
      record: OverrideToRecord | null;
    }
  | { ok: false; body: PublicationReviewGateRefusalBody };

type Refused = { ok: false; body: PublicationReviewGateRefusalBody };

/**
 * A refusal for a request or a review the gate could not check: a read that failed, or a write of
 * the override that did. No reasons, no outcome, and which fact it was.
 */
function unverified(datasetId: string, fact: "request" | "review"): Refused {
  return {
    ok: false,
    body: {
      error: PUBLICATION_REVIEW_NOT_CLEAR_CODE,
      refusal: "unverified",
      headline: REVIEW_UNREADABLE_HEADLINE,
      message: reviewGateRefusalText("unverified", datasetId),
      outcome: null,
      reasons: [],
      uncovered: [],
      review_id: null,
      fact,
    },
  };
}

function bareRefusal(
  kind: Exclude<ReviewGateRefusal, "unverified">,
  datasetId: string,
  headline: string,
): PublicationReviewReasonedRefusalBody {
  return {
    error: PUBLICATION_REVIEW_NOT_CLEAR_CODE,
    refusal: kind,
    headline,
    message: reviewGateRefusalText(kind, datasetId),
    outcome: null,
    reasons: [],
    uncovered: [],
    review_id: null,
  };
}

/**
 * A refusal in the shared words of the review as it was read: the same `reasonViewsOf` and
 * headline the detail view carries, so the administrator is told what the page showed. For a hard
 * reason the message continues with the first one's sentence and its cure.
 */
function refusal(
  kind: Exclude<ReviewGateRefusal, "unverified">,
  datasetId: string,
  d: DerivedPublicationReview,
  uncovered: ReasonCode[] = [],
): Refused {
  const reasons = reasonViewsOf(d.reasons, datasetId, d.startable, reportOf(d.rowView));
  let message = reviewGateRefusalText(kind, datasetId);
  if (kind === "hard_reason") {
    const first = hardReasonsOf(reasons)[0];
    if (first)
      message = `${message} ${first.sentence} ${cureOf(first.code, datasetId, d.startable)}`;
  }
  return {
    ok: false,
    body: {
      error: PUBLICATION_REVIEW_NOT_CLEAR_CODE,
      refusal: kind,
      headline: d.description.headline,
      message,
      outcome: d.outcome,
      reasons,
      uncovered,
      review_id: d.row?.id ?? null,
    },
  };
}

function sameCodes(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((code) => b.includes(code));
}

/**
 * Does the review let this approval through? Called for a run that has not started publishing,
 * after the identifier screen's gate and before the request is marked `approving`.
 *
 *  1. With the review off nothing is read: `{ ok: true, state: "off" }`.
 *  2. The request is read (the detail view's read). A read that fails, or no request, refuses
 *     `unverified`.
 *  3. A dataset the review does not apply to passes as `n/a`.
 *  4. The review is derived exactly as the detail view derives it.
 *  5. A hard reason refuses `hard_reason`, an override or not.
 *  6. With no override-class reason standing the approval passes (a pass, or only the screen's own
 *     reason, which the screen gate enforced). An override in the body is ignored.
 *  7. With an override in the body: it must name the review in force (`review_changed`) and every
 *     override-class reason that stands (`override_not_covering`). It passes with the override to
 *     record, which holds exactly the reasons that stand, unless this administrator's own record on
 *     the row already says the same.
 *  8. Without one, the override recorded on the review in force counts only when it is this
 *     approver's and covers every reason that stands; otherwise `needs_override`.
 *
 * Everything after the request was read fails closed: whatever throws is `unverified`.
 */
export async function evaluateApprovalReviewGate(
  env: Bindings,
  args: ReviewGateArgs,
): Promise<ReviewGateResult> {
  if (!reviewEnabled(env)) return { ok: true, state: "off" };
  const nowMs = args.nowMs ?? Date.now();
  let ctx: Awaited<ReturnType<typeof readReviewContext>>;
  try {
    ctx = await readReviewContext(env, args.requestId);
  } catch (err) {
    console.error(
      `[publication-review-gate] request ${args.requestId} (${args.datasetId}): the request could not be read (${errorWords(err)})`,
    );
    return unverified(args.datasetId, "request");
  }
  if (ctx === null) {
    console.error(
      `[publication-review-gate] request ${args.requestId} (${args.datasetId}): the request is gone`,
    );
    return unverified(args.datasetId, "request");
  }
  if (!publicationReviewApplies(ctx.dataset ?? {})) return { ok: true, state: "n/a" };
  try {
    const d = await derivePublicationReview({ env, nowMs, ...ctx });
    return decide(args, d);
  } catch (err) {
    console.error(
      `[publication-review-gate] request ${args.requestId} (${args.datasetId}): the review could not be read or evaluated (${errorWords(err)})`,
    );
    return unverified(args.datasetId, "review");
  }
}

function decide(args: ReviewGateArgs, d: DerivedPublicationReview): ReviewGateResult {
  const { datasetId, approverId, override } = args;
  if (hardReasonsOf(d.reasons).length > 0) return refusal("hard_reason", datasetId, d);

  const need = overrideClassReasonsOf(d.reasons);
  const row = d.row;
  const enforced = (record: OverrideToRecord | null): ReviewGateResult => ({
    ok: true,
    state: "enforced",
    outcome: d.outcome ?? verdictOf(d.reasons),
    headSha: row?.headSha ?? d.live.screen.head,
    record,
  });
  if (need.length === 0) return enforced(null);

  if (override !== undefined) {
    if (override.review_id !== (row?.id ?? null)) return refusal("review_changed", datasetId, d);
    const uncovered = uncoveredByOverride(need, override.reasons);
    if (uncovered.length > 0) return refusal("override_not_covering", datasetId, d, uncovered);
    // Recorded: the override-class codes that STAND, in the table's order (`uncoveredByOverride`
    // just guaranteed the body names every one), never the others the body lists. A record that
    // held a code that does not stand would pre-cover a reason that comes up on this row later.
    const reasons = OVERRIDE_REASONS.filter((code) => need.some((r) => r.code === code));
    if (row === null && args.requireRow === true) return refusal("no_review_row", datasetId, d);
    if (
      row !== null &&
      row.overrideBy === approverId &&
      sameCodes(overrideReasonsOf(row.overrideReasons), reasons)
    ) {
      return enforced(null);
    }
    return enforced({ row, reasons });
  }

  if (
    row !== null &&
    row.overrideBy === approverId &&
    uncoveredByOverride(need, overrideReasonsOf(row.overrideReasons)).length === 0
  ) {
    return enforced(null);
  }
  return refusal("needs_override", datasetId, d, uncoveredByOverride(need, []));
}

/**
 * Record the override the gate said to record: on the review row as it was read (one conditional
 * statement, {@link RECORD_OVERRIDE_SQL}), then the audit row. Called by the route after every
 * other gate has passed, and only then. A later check can still refuse (the orchestrator's own
 * conditional mark can refuse `request_changed`, and approve-dispatch's dispatch can fail or go
 * unconfirmed); the override then stays on its row, bound to that review, those reasons and its
 * approver. Zero
 * changes means the row moved between the read and now, and the override is refused as
 * `review_changed`, read again so the refusal carries what is true now. A write that fails refuses
 * `unverified`: an override that could not be recorded approves nothing.
 *
 * With no review row (a terminal's override for `review_not_started`) nothing is written to the
 * review table and the audit row alone is the record, so there a failed audit write refuses
 * `unverified` as well: approving over a non-pass with the override recorded nowhere is the one
 * thing this function exists to prevent.
 *
 * With a review row the audit row is best effort, as the screen acknowledgment's is: the override
 * is on the row, and losing the second record must not refuse an approval already decided.
 *
 * The audit row names no executor. An override is its sender's act and is recorded under the
 * approver of record, and the one run whose approver is not its sender (a call carrying a valid
 * dispatch token, whose approver is the clicker) may send none: the approval route refuses it
 * (`decision_with_dispatch_token`, ADR 0103 decision 5) before the gate runs, so the sender and
 * the approver are the same administrator whenever one is recorded.
 */
export async function recordApprovalOverride(
  env: Bindings,
  args: {
    requestId: number;
    datasetId: string;
    approverId: number;
    via: "approve" | "approve-dispatch";
    outcome: PublicationOutcome;
    headSha: string | null;
    record: OverrideToRecord;
    nowMs?: number;
  },
): Promise<{ ok: true } | Refused> {
  const { record, datasetId } = args;
  const row = record.row;
  if (row !== null) {
    let changes: number;
    try {
      const res = await env.DB.prepare(RECORD_OVERRIDE_SQL)
        .bind(
          args.approverId,
          JSON.stringify(record.reasons),
          row.id,
          row.requestId,
          row.headSha,
          row.anonymous ? 1 : 0,
          row.state,
          row.createdAt,
          row.decidedAt,
        )
        .run();
      changes = res.meta.changes ?? 0;
    } catch (err) {
      console.error(
        `[publication-review-gate] review ${row.id} (${datasetId}): the override could not be recorded (${errorWords(err)})`,
      );
      return unverified(datasetId, "review");
    }
    if (changes !== 1) return await movedRefusal(env, args.requestId, datasetId, args.nowMs);
  }
  try {
    await auditLogStatement(env.DB, {
      userId: args.approverId,
      action: "publication_review_overridden",
      resourceType: "dataset",
      resourceId: datasetId,
      details: JSON.stringify({
        request_id: args.requestId,
        review_id: row?.id ?? null,
        head_sha: args.headSha,
        outcome: args.outcome,
        reasons: record.reasons,
        via: args.via,
      }),
    }).run();
  } catch (err) {
    console.error(
      `[publication-review-gate] audit write for the override on ${datasetId} failed (${errorWords(err)})`,
    );
    // The audit row is the only record of an override that has no review row to hold it.
    if (row === null) return unverified(datasetId, "review");
  }
  return { ok: true };
}

/**
 * The refusal for an override whose row moved before it could be recorded: the review is read
 * again, so the body carries the reasons that stand now, not the ones the override was given for.
 * If that read fails too the refusal still stands, with no reasons.
 */
async function movedRefusal(
  env: Bindings,
  requestId: number,
  datasetId: string,
  nowMs: number | undefined,
): Promise<Refused> {
  try {
    const ctx = await readReviewContext(env, requestId);
    if (ctx !== null) {
      const d = await derivePublicationReview({ env, nowMs: nowMs ?? Date.now(), ...ctx });
      return refusal("review_changed", datasetId, d);
    }
  } catch (err) {
    console.error(
      `[publication-review-gate] request ${requestId} (${datasetId}): the review could not be read again after it moved (${errorWords(err)})`,
    );
  }
  return {
    ok: false,
    body: bareRefusal("review_changed", datasetId, REVIEW_UNREADABLE_HEADLINE),
  };
}

/**
 * The statement that records an override, and the only one: it writes the administrator, the time
 * and the reason codes together (the migration's CHECK keeps them whole) on the row as the gate
 * read it. `state`, `created_at` and `decided_at` pin the ATTEMPT and its RESULT: a result that
 * lands moves `state` (and `decided_at`), a restart moves all three, and the watchdog moves
 * `state`, so an override can only attach to the result the administrator was shown. `decided_at`
 * is compared with `IS`, which is how a bound NULL matches the `NULL` of a row still running.
 * Zero changes means the row moved, and the override is refused (`review_changed`).
 *
 * Binds, in order: the administrator, the reason codes as JSON, then the row as read: its id, its
 * request, its screened head, its release kind (0 or 1), its state, `created_at` and `decided_at`.
 */
export const RECORD_OVERRIDE_SQL = `UPDATE publication_reviews
     SET override_by = ?, override_at = datetime('now'), override_reasons = ?
   WHERE id = ? AND request_id = ? AND head_sha = ? AND anonymous = ?
     AND state = ? AND created_at = ? AND decided_at IS ?`;
