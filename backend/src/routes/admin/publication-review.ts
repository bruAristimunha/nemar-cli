/**
 * Admin routes for the publication review (ADR 0102, section 8):
 *
 *   GET  /admin/publish/:id/review         the review of the dataset's active request: the outcome
 *                                          and its reasons in the shared words, the review in
 *                                          force with its findings and summary, and the history
 *                                          of earlier reviews
 *   POST /admin/publish/:id/review/start   start the review of the active request's current
 *                                          screened commit, or start again one that was declined,
 *                                          errored, never reported or is past its deadline
 *
 * Admin-only through the router's `authMiddleware` and `adminMiddleware`. A read needs no switch:
 * `PUBLICATION_REVIEW_ENABLED` gates the REVIEW, not the view of it, so with the review off a
 * request reads as not reviewed (and one that has a stored review shows it as advice). The read
 * decides nothing and writes nothing: no approval, no start, no audit row.
 *
 * The read is a thin adapter over `services/publication-review-view.ts`, which owns every word of
 * it; the model's summary and the notes of its findings appear in its response and in no other.
 * The start is a thin adapter over `startPublicationReview` (the one start path, which a screen
 * result takes too): it finds the request, passes the administrator, and says what the service
 * said. There is no `start --all` route; that is a loop in the command-line interface.
 */

import type { Context } from "hono";
import {
  type NotHandedOverPublicationReview,
  type PublicationReviewEnvironment,
  type PublicationReviewErrorBody,
  type PublicationReviewErrorCode,
  START_NOT_HANDED_OVER_REASONS,
  START_REFUSED_REASONS,
  type StartNotHandedOverReason,
  type StartRefusedReason,
  type StartedPublicationReview,
} from "../../../../shared/contract/publication-review-admin";
import { isOneOf } from "../../../../shared/pr-review";
import { auditLogStatement } from "../../db/audit-log";
import { ACTIVE_REQUEST_TAIL_SQL } from "../../services/approval-dispatch";
import { isValidDatasetId } from "../../services/datasetId";
import { isNonProductionEnv } from "../../services/environment";
import { type StartOutcome, startPublicationReview } from "../../services/publication-review";
import { errorWords } from "../../services/publication-review-log";
import { readReview } from "../../services/publication-review-rows";
import { publicationReviewDetail } from "../../services/publication-review-view";
import type { AdminRouter } from "./shared";

/** Answer with a fixed sentence and a code from the contract's closed list. */
function refuse(
  c: Context,
  status: 400 | 404 | 409 | 500,
  code: PublicationReviewErrorCode,
  error: string,
) {
  const body: PublicationReviewErrorBody = { error, code };
  return c.json(body, status);
}

/** The sentence of the 500 for a start the service answered in a word an administrator's start never gets. */
const START_FAULT: PublicationReviewErrorBody = {
  error: "The publication review could not be started. Try again.",
  code: "internal",
};

/**
 * The refusals of a start: what the service said, as a closed code and a sentence for a person.
 * Each is a request that cannot be started as it stands (409), never a fault. The code is the
 * service's own word, so a client reads one word in the body's `code` and the same word anywhere
 * the service says it.
 */
export const START_REFUSALS: Record<StartRefusedReason, PublicationReviewErrorBody> = {
  review_disabled: {
    code: "review_disabled",
    error: "The publication review is switched off on this Worker.",
  },
  not_applicable: {
    code: "not_applicable",
    error: "This dataset is not reviewed: it is an OpenNeuro mirror or an exemplar.",
  },
  not_owned_here: {
    code: "not_owned_here",
    error: "The other environment's Worker answers for that dataset.",
  },
  request_not_requested: {
    code: "request_not_requested",
    error: "Only a request that is waiting for its decision can be reviewed.",
  },
  screen_not_ready: {
    code: "screen_not_ready",
    error:
      "The identifier screen has no clear result for a commit yet, so there is nothing to review.",
  },
  running: {
    code: "running",
    error: "A review of this commit is running. Wait for its report, or for its deadline.",
  },
  has_result: {
    code: "has_result",
    error:
      "A review of this commit has already reported. A new screened commit starts a new review.",
  },
  platform_limit: {
    code: "platform_limit",
    // The allowance is the reviews of any rolling 24 hours, not a calendar day.
    error:
      "The platform's allowance of reviews for the last 24 hours is spent. A start works again as earlier reviews pass 24 hours.",
  },
};

/**
 * Why a start could not hand its review over, for the two reasons that leave a recorded row: a
 * fixed sentence, and the same word as the answer's `reason` in its `code`.
 */
export const NOT_HANDED_OVER: Record<
  StartNotHandedOverReason,
  { code: StartNotHandedOverReason; error: string }
> = {
  dispatch_unconfigured: {
    code: "dispatch_unconfigured",
    error: "This Worker cannot hand a review to GitHub: a credential is not configured.",
  },
  dispatch_failed: {
    code: "dispatch_failed",
    error: "The review could not be handed to GitHub. Try again.",
  },
};

/** What a start answers with: the status, and the body the contract types for it. */
export type StartResponse =
  | { status: 202; body: StartedPublicationReview }
  | { status: 409; body: PublicationReviewErrorBody }
  | { status: 502; body: NotHandedOverPublicationReview }
  | { status: 500; body: PublicationReviewErrorBody };

/**
 * The one mapping from what the service said to what the route answers: a run that is going is 202
 * with the review; a request that cannot be started as it stands is 409 and a closed code; a
 * hand-over that failed is 502 with the row that records it (not a refusal of the request, and not
 * a start, so no 2xx); and any other word is a fault of this route, a 500. `duplicate` and
 * `depositor_limit` are those other words: they belong to a screen result's start, and an
 * administrator's start never answers them.
 */
export function startResponseOf(
  outcome: StartOutcome,
  environment: PublicationReviewEnvironment,
): StartResponse {
  if (outcome.started) {
    return {
      status: 202,
      body: { environment, started: true, reason: outcome.reason, review_id: outcome.reviewId },
    };
  }
  const { reason } = outcome;
  if (isOneOf(START_REFUSED_REASONS, reason)) return { status: 409, body: START_REFUSALS[reason] };
  if (isOneOf(START_NOT_HANDED_OVER_REASONS, reason)) {
    return {
      status: 502,
      body: {
        environment,
        started: false,
        reason,
        review_id: outcome.reviewId,
        ...NOT_HANDED_OVER[reason],
      },
    };
  }
  return { status: 500, body: START_FAULT };
}

export function registerPublicationReviewRoutes(admin: AdminRouter): void {
  admin.get("/publish/:id/review", async (c) => {
    const datasetId = c.req.param("id");
    if (!isValidDatasetId(datasetId))
      return refuse(c, 400, "bad_dataset", "That is not a dataset id.");
    try {
      const detail = await publicationReviewDetail(c.env, datasetId);
      if (detail === null) {
        return refuse(c, 404, "not_found", `${datasetId} has no active publication request.`);
      }
      return c.json(detail);
    } catch (err) {
      // Ids and fixed words only: the error text can carry SQL.
      console.error(
        `[admin/publication-review] could not read the review of ${datasetId} (${errorWords(err)})`,
      );
      return refuse(c, 500, "internal", "The publication review could not be read. Try again.");
    }
  });

  admin.post("/publish/:id/review/start", async (c) => {
    // This route spends the platform's money; the router's `cookieOriginGuard` has already refused
    // a cookie request that did not come from a NEMAR page.
    const datasetId = c.req.param("id");
    if (!isValidDatasetId(datasetId)) {
      return refuse(c, 400, "bad_dataset", "That is not a dataset id.");
    }
    const environment = isNonProductionEnv(c.env) ? "non-production" : "production";
    const userId = c.get("user").id;

    let outcome: StartOutcome;
    let requestId: number;
    try {
      const request = await c.env.DB.prepare(`SELECT id ${ACTIVE_REQUEST_TAIL_SQL}`)
        .bind(datasetId)
        .first<{ id: number }>();
      if (!request) {
        return refuse(c, 404, "not_found", `${datasetId} has no active publication request.`);
      }
      requestId = request.id;
      outcome = await startPublicationReview(c.env, {
        requestId,
        datasetId,
        adminUserId: userId,
      });
    } catch (err) {
      // Ids and fixed words only: the error text can carry SQL. `startPublicationReview` throws
      // only after a database fault, and has marked a row it wrote as `dispatch_failed` first.
      console.error(
        `[admin/publication-review] could not start the review of ${datasetId} (${errorWords(err)})`,
      );
      return c.json(START_FAULT, 500);
    }

    const response = startResponseOf(outcome, environment);
    if (response.status === 202) {
      await recordStart(c.env.DB, userId, datasetId, requestId, outcome);
    } else if (response.status === 500) {
      // Every word an administrator's start can end in is answered above. A word that is not one of
      // them (a screen result's) is a fault in this route, not a state of the request.
      console.error(
        `[admin/publication-review] ${datasetId}: unexpected start reason ${outcome.reason}`,
      );
    }
    return c.json(response.body, response.status);
  });
}

/**
 * The audit row of a start (`publication_review_started`, as `pr_review_started` is for a pull
 * request): who, which request and review, why, and which commit. Best effort: a run that is going
 * must not be reported as an error because its audit row could not be written, so a failure is
 * logged by ids and fixed words and the start stands.
 */
async function recordStart(
  db: D1Database,
  userId: number,
  datasetId: string,
  requestId: number,
  outcome: StartOutcome,
): Promise<void> {
  const reviewId = outcome.reviewId;
  try {
    // The commit the review is of is on its row, not in the answer.
    const row = reviewId === null ? null : await readReview(db, reviewId);
    await auditLogStatement(db, {
      userId,
      action: "publication_review_started",
      resourceType: "dataset",
      resourceId: datasetId,
      details: JSON.stringify({
        request_id: requestId,
        review_id: reviewId,
        reason: outcome.reason,
        head_sha: row?.headSha ?? null,
      }),
    }).run();
  } catch (err) {
    console.error(
      `[admin/publication-review] ${datasetId}: review ${reviewId} started, audit row not written (${errorWords(err)})`,
    );
  }
}
