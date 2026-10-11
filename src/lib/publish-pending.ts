/**
 * `nemar dataset publish request` right after an upload: a CI-pending refusal.
 *
 * A publication request made before the dataset's BIDS validation has concluded
 * is refused with block_reason `bids_validation_pending` (no run yet) or
 * `bids_validation_in_progress` (a run is going). The request is recorded as
 * `blocked`, and the blocked-request sweep releases it once validation passes.
 *
 * It is a pending state, not an error: the request is recorded, the CLI says so
 * and exits 0, so neither a depositor nor a script reads it as a rejection. The
 * CLI does not wait or poll. Checking validation is `nemar dataset ci <id>`.
 */

import {
  CI_PENDING_BLOCK_REASONS,
  type CiPendingReason,
  isCiPendingReason,
} from "../../shared/contract/publication.js";
import { ApiError } from "./api/errors.js";

// Declared once in the shared contract, which the route and the sweep read too.
export { CI_PENDING_BLOCK_REASONS, isCiPendingReason };
export type { CiPendingReason };

/**
 * True for a publication refusal that only says CI has not finished: a 422
 * whose body is a recorded block (`status: "blocked"`) with a pending reason.
 * The status is read as well as the reason so that the same word in some other
 * kind of answer is not taken for this one.
 */
export function isCiPendingBlock(
  error: unknown,
): error is ApiError & { blockReason: CiPendingReason } {
  return (
    error instanceof ApiError &&
    error.statusCode === 422 &&
    (error.rawBody as { status?: unknown } | undefined)?.status === "blocked" &&
    isCiPendingReason(error.blockReason)
  );
}

/** The link to the dataset's CI runs that the refusal carried, if it is a plain https URL. */
export function ciUrlOf(error: ApiError): string | undefined {
  const url = (error.rawBody as { ci_url?: unknown } | undefined)?.ci_url;
  return typeof url === "string" && /^https:\/\/\S+$/.test(url) ? url : undefined;
}

/**
 * The first line printed for a CI-pending request. It tells the two reasons
 * apart in one clause: no run has been seen yet, or a run is going.
 */
export function ciPendingHeadline(reason: CiPendingReason): string {
  return reason === "bids_validation_in_progress"
    ? "Request recorded: BIDS validation is still running."
    : "Request recorded: BIDS validation has not started yet.";
}

/**
 * The lines that follow the headline. They start with "Your request is
 * recorded" because the headline goes to stderr and these to stdout, so a
 * caller that drops stderr still reads that a request exists. No time is
 * promised: the server re-checks blocked requests on its own schedule.
 *
 * Asking again re-states the request, and a request made WITHOUT `--anonymous`
 * is a normal publication whatever the earlier one said (the backend resets the
 * flag on every re-request). An anonymous depositor must therefore be handed the
 * flag back, or the line meant to help would turn a blind request into a named
 * one. `anonymous` is what the depositor TYPED (or, for `publish status`, what
 * the recorded request says), never an echo that might be missing.
 *
 * If validation fails, or a submission minimum fails when the sweep goes to
 * release the request, the sweep relabels it and mails nobody, so the last
 * lines say where to look.
 */
export function ciPendingHint(datasetId: string, anonymous = false): string[] {
  const again = `nemar dataset publish request ${datasetId}${anonymous ? " --anonymous" : ""}`;
  return [
    "  Your request is recorded. NEMAR re-checks it automatically and continues once validation passes.",
    `  If you would rather not wait for that, check validation with: nemar dataset ci ${datasetId}`,
    `  Once it has passed, request again: ${again}`,
    "  If it says a request already exists, nothing more is needed.",
    "  If validation fails or a submission minimum fails, the request stays blocked and nothing is emailed:",
    `  check nemar dataset ci ${datasetId} or nemar dataset publish status ${datasetId}.`,
  ];
}
