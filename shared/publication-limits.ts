/**
 * Limits and patterns of the publication approval path that the Worker enforces and the
 * `nemar admin publish` commands check before they send (ADR 0102). One definition each, so a
 * command's early refusal and the Worker's refusal cannot disagree about a number.
 */

/** The most characters of a denial reason (`POST /admin/publish/:id/deny`). */
export const DENIAL_REASON_MAX_LENGTH = 2000;

/** The fewest and the most characters of the reason an administrator gives to acknowledge the identifier screen. */
export const ACKNOWLEDGMENT_MIN_LENGTH = 10;
export const ACKNOWLEDGMENT_MAX_LENGTH = 500;

/** The id of a dataset a publication request can name (`nm`, `on` or `xx`, then six digits). */
export const PUBLICATION_DATASET_ID_RE = /^(nm|on|xx)\d{6}$/;

/**
 * The id of a dataset a web approval may DISPATCH, by environment (`POST
 * /admin/publish/:id/approve-dispatch`, #1583; ADR 0105, decision 8). The executor workflow it
 * dispatches (`approve-publication.yml`, in the central workflow repository) accepts only `nm` or
 * `on` plus six digits, and on dev also `xx` plus six digits (the exemplar fleet); a dispatch for
 * any other id, or for an `xx` id on production, would claim the lease, dispatch, and fail in the
 * workflow's validate step with the lease held for fifteen minutes. The route refuses it before
 * it claims anything.
 *
 * The workflow cannot import this file, so the rule is written on both sides: its validate step
 * mirrors these shapes by hand, in `case` patterns of its own, and, once the edit of ADR 0105
 * (decision 8) is applied, carries a comment citing this constant. Keep the two in step by hand:
 * change one and the other in the same sitting. A test here pins every accepted and rejected shape
 * on this side. `dev` is also what the Worker uses
 * for `ENVIRONMENT` unset or "test" (`approvalDispatchEnvironment`), the opposite of a
 * fail-closed default on purpose: only a Worker that says it is production gets the narrower
 * rule.
 */
export const APPROVAL_DISPATCH_ID_RE: Readonly<{ production: RegExp; dev: RegExp }> = {
  production: /^(nm|on)\d{6}$/,
  dev: /^(nm|on|xx)\d{6}$/,
};
