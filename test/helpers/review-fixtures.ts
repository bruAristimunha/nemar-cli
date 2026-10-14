/**
 * The review a test of the command's pure rules hands to the code under test: a detail as the
 * Worker words it, and a list row (`publication-review-approve.unit.test.ts`,
 * `publication-review-next.unit.test.ts`, `publication-review-display.unit.test.ts`).
 *
 * The reasons are made by the Worker's own `reasonViewsOf`, so a sentence, a cure or a class the
 * table changes changes in every test that reads them. Everything else is a fixed, plausible value
 * that a test overrides by naming it in its {@link Spec} or in the `over` of {@link row}.
 */

import { reasonViewsOf } from "../../backend/src/services/publication-review-view";
import type {
  PublicationReviewDetail,
  PublicationReviewGateState,
  PublicationReviewRecord,
} from "../../shared/contract/publication-review-admin";
import { NOT_ASSESSED_LINE, type ReasonCode } from "../../shared/publication-review";
import type { PublicationReviewSummary, PublishRequestsResponse } from "../../src/lib/api/publish";
import type { ReviewRead } from "../../src/lib/publication-review-approve";

/** The dataset every fixture here is for. */
export const ID = "nm000460";

export type Row = PublishRequestsResponse["requests"][number];

export interface Spec {
  /** The reasons shown, as codes or `[code, detail]`, in the order given. */
  reasons?: Array<ReasonCode | [ReasonCode, string]>;
  status?: string;
  gate?: PublicationReviewGateState;
  startedPublishing?: boolean;
  blockReason?: string | null;
  acknowledged?: boolean;
  /** `null`: no review row. A number: the id of the review in force. */
  reviewId?: number | null;
  override?: { by: number; at: string; reasons: ReasonCode[] } | null;
  anonymous?: boolean;
  totalFiles?: number | null;
  evidence?: PublicationReviewRecord["evidence"];
  headline?: string;
}

export function recordOf(id: number, spec: Spec): PublicationReviewRecord {
  return {
    id,
    head_sha: "0123456789abcdef0123456789abcdef01234567",
    anonymous: false,
    state: "reported",
    detail: null,
    stored_verdict: "action_required",
    model: "claude-haiku-5-5",
    version: "1.0.0",
    created_at: "2026-10-13 10:00:00",
    decided_at: "2026-10-13 10:05:00",
    started_by: null,
    override: spec.override ?? null,
    questions: null,
    fact_notes: [],
    findings: [],
    summary: null,
    evidence: spec.evidence ?? null,
  };
}

export function detailOf(spec: Spec = {}): PublicationReviewDetail {
  const status = spec.status ?? "requested";
  const reasons = reasonViewsOf(
    (spec.reasons ?? []).map((r) =>
      typeof r === "string" ? { code: r, detail: null } : { code: r[0], detail: r[1] },
    ),
    ID,
    status === "requested",
    // No report: these lines lack the report-derived findings text of a failed question.
    null,
  );
  const reviewId = spec.reviewId === undefined ? 11 : spec.reviewId;
  return {
    environment: "production",
    enabled: (spec.gate ?? "enforced") !== "off",
    dataset_id: ID,
    request_id: 7,
    request_status: status,
    anonymous: spec.anonymous ?? false,
    identifier_screen: {
      state: "clean",
      headline: "Identifier screen: clean",
      tone: "ok",
      lines: [],
    },
    screen_acknowledgment: spec.acknowledged ? { by: 3, at: "2026-10-13 09:00:00" } : null,
    block_reason: spec.blockReason ?? null,
    started_publishing: spec.startedPublishing ?? false,
    total_files: spec.totalFiles ?? null,
    applies: (spec.gate ?? "enforced") !== "n/a",
    gate: spec.gate ?? "enforced",
    outcome: reasons.length === 0 ? "pass" : "action_required",
    reasons,
    description: {
      headline: spec.headline ?? "Publication review: action required",
      tone: "warn",
      lines: [NOT_ASSESSED_LINE],
      summary: null,
      next: null,
    },
    review: reviewId === null ? null : recordOf(reviewId, spec),
    history: [],
    history_truncated: false,
  };
}

/** The detail of `spec`, read successfully. */
export const read = (spec?: Spec): ReviewRead => ({ kind: "detail", detail: detailOf(spec) });

export function summary(over: Partial<PublicationReviewSummary> = {}): PublicationReviewSummary {
  return {
    kind: "decided",
    enabled: true,
    gate: "enforced",
    outcome: "action_required",
    headline: "Publication review: action required",
    tone: "warn",
    reasons: ["review_not_started"],
    start_offered: false,
    review_id: null,
    head_sha: null,
    ...over,
  };
}

export function row(over: Partial<Row> = {}): Row {
  return {
    id: 1,
    dataset_id: ID,
    status: "requested",
    requested_at: "2026-10-12 09:14:03",
    requested_by_username: "alice",
    requested_by_email: "alice@example.org",
    steps_completed: [],
    current_step: null,
    last_error: null,
    approval_in_flight: false,
    publication_review: summary(),
    ...over,
  };
}
