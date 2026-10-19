/**
 * Which publication requests are an administrator's to act on, and which `start --all` would spend
 * a review on (ADR 0102, section 8). The two questions a list row has to answer.
 *
 * Both read what the Worker already decided: the request's status, whether an approval holds it
 * (`approval_in_flight`) and the review's summary. Neither derives a verdict from reason codes,
 * with one exception that is a closed pair of words, below. `start --all` in particular reads the
 * summary's `start_offered`, the one rule behind the detail's own next command, so the two cannot
 * offer different things.
 */

import type { PublishRequestsResponse } from "./api/publish.js";

type Row = PublishRequestsResponse["requests"][number];

/**
 * The reasons that are nothing but a wait: the platform's own step is still running and nothing an
 * administrator does changes it. A request whose every reason is one of these is not yet theirs.
 * A reason the vocabulary gains later is theirs until someone adds it here on purpose.
 */
const WAITS: ReadonlySet<string> = new Set(["review_running", "identifier_screen_pending"]);

/**
 * A request an administrator can act on now: `requested` and not in flight, unless it is only
 * waiting for the platform; or `approving` and not in flight (a stopped run, resumed with
 * `--resume`). Blocked (the depositor acts), published and denied are not. A row from an older
 * backend with no summary counts when it is `requested` and not in flight.
 *
 * Only waiting means one of two things. Its identifier screen is still running (the row's own
 * `identifier_screen.state`), which holds whatever the review says and is the only word there is
 * while the review is off, as it is in production today. Or every reason of the review is a wait
 * (`review_running`, `identifier_screen_pending`).
 *
 * A summary with no reason at all is not "only waiting": a pass, a review that is off and one that
 * could not be read all leave a request waiting for a person.
 */
export function needsAdministrator(row: Row): boolean {
  if (row.approval_in_flight === true) return false;
  if (row.status === "approving") return true;
  if (row.status !== "requested") return false;
  if (row.identifier_screen?.state === "pending") return false;
  const reasons = row.publication_review?.reasons ?? [];
  return reasons.length === 0 || !reasons.every((r) => WAITS.has(r));
}

/** Oldest request first, the one that has waited longest; the request id breaks a tie. A copy. */
export function byOldestFirst<T extends Pick<Row, "id" | "requested_at">>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) =>
    a.requested_at === b.requested_at ? a.id - b.id : a.requested_at < b.requested_at ? -1 : 1,
  );
}

/**
 * Rows `start --all` would start: `requested` and `publication_review.start_offered`, oldest first.
 * The Worker lists newest first; a limited allowance should serve the request that has waited
 * longest. A row from an older backend has no offer and is not a candidate.
 */
export function startAllCandidates(rows: readonly Row[]): Row[] {
  return byOldestFirst(
    rows.filter((r) => r.status === "requested" && r.publication_review?.start_offered === true),
  );
}
