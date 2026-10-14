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
