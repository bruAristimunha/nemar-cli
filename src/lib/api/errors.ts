/**
 * NEMAR API client: error types.
 *
 * Split from lib/api.ts by endpoint group (#908, epic #902); bodies moved
 * verbatim. All API functions throw ApiError on failure.
 */

/** Extract a human-readable message from an unknown error value. */
export function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * API error with status code and message.
 *
 * `step` carries the top-level `step` field from orchestrator-style error
 * responses (publish-approve, etc.), where the failing pipeline step is
 * surfaced separately from `details`. It is optional because most endpoints
 * don't use this field.
 *
 * `blockReason` carries the top-level `block_reason` from a publication
 * refusal, so a caller can key an actionable hint on WHY it was refused
 * rather than on the status code alone (#1255): a 422 from the publish paths
 * used to always print the CI hint, which is the wrong advice for a missing
 * researcher name.
 *
 * `missing` is the same idea one step further (ADR 0042, #1253): the
 * upload-access request refuses with a LIST of account fields that still need
 * filling in, and the CLI prints each one with where to fix it. Like `step`
 * and `blockReason` it is a TOP-LEVEL field of the error body, which is why it
 * cannot ride inside `details`.
 *
 * `code` and `reason` (epic #1272 phase 3; ADR 0047) are the raw `error` and
 * `reason` fields of a JSON error body, when present and string-valued --
 * assigned by `request()` AFTER construction rather than taken as
 * constructor parameters, so the existing call sites that build an ApiError
 * directly (tests, retry classifiers) are unaffected. `pollDeviceToken`
 * (lib/api/auth.ts) switches on `code` to tell a device-flow "keep polling"
 * answer (`authorization_pending`, `slow_down`) from a terminal one, and
 * reads `reason` -- present only on a terminal answer -- for the more
 * specific refusal code `message` was already built from (the two disagree
 * on purpose, ADR 0047).
 *
 * `rawBody` is the whole parsed JSON error body, unlike `code`/`reason`/
 * `details` which each pick out one field generically for every caller.
 * `pollDeviceToken` re-parses it against `deviceTokenErrorSchema` instead of
 * probing individual fields, so a caller that needs the CONTRACT's full
 * shape (a discriminated union, not just two loose strings) has it without
 * every other `request()` caller paying for a second body it never asked
 * for.
 */
export class ApiError extends Error {
  public code?: string;
  public reason?: string;
  public rawBody?: unknown;

  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown,
    public step?: string,
    public blockReason?: string,
    public missing?: string[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Whether the Worker answered because it has no such route, as opposed to a route that looked and
 * found nothing (a missing dataset, a missing user). The API's own not-found signature is
 * `404 { error: "Not Found", message: "Route POST /x not found" }` (backend/src/lib/not-found.ts);
 * the client words such an error as "this NEMAR backend does not support this command yet". A
 * hint written for the second kind ("User not found") under the first one points at the wrong
 * cause, so a command that has such hints asks this first.
 */
export function isRouteNotFound(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.statusCode !== 404) return false;
  const body = error.rawBody;
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { error?: unknown }).error === "Not Found" &&
    typeof (body as { message?: unknown }).message === "string"
  );
}

/**
 * Thrown when the backend is in maintenance mode (503 with a `mode` body).
 * Mode describes what the server is rejecting; CLI treats it as an expected
 * temporary state and shows a friendly banner instead of a stack trace.
 */
export class MaintenanceError extends ApiError {
  constructor(
    public readonly mode: "read-only" | "full",
    message: string,
    public readonly eta: string | null,
    details?: unknown,
  ) {
    super(503, message, details);
    this.name = "MaintenanceError";
  }
}
