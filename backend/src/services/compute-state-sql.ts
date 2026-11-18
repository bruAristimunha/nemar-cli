/**
 * The job states as SQL lists, declared once and imported by every compute statement that names them
 * (`compute-jobs.ts` re-exports them under their old names). The lists are written LITERALLY into each
 * statement, because a partial index serves a query only if the query states the same list as the
 * index's own `WHERE`; a bind would defeat it.
 *
 * Its own file so `compute-tenant.ts`, which `compute-jobs.ts` imports, can read the live list without
 * a cycle between the two.
 */

import {
  LIVE_COMPUTE_STATES,
  TAPIS_REPORTING_STATES,
  TERMINAL_COMPUTE_STATES,
} from "../../../shared/compute-state.js";

/** `'a', 'b'` for a SQL `IN (...)`, from this tree's own fixed state words (never a caller's). */
const sqlList = (states: readonly string[]) => states.map((s) => `'${s}'`).join(", ");

/** The live states and the terminal states as SQL lists. */
export const LIVE_STATES_SQL = sqlList(LIVE_COMPUTE_STATES);
export const TERMINAL_STATES_SQL = sqlList(TERMINAL_COMPUTE_STATES);
/** The live states whose Tapis job exists and is reported on (what a long silence turns `unreported`). */
export const TAPIS_REPORTING_STATES_SQL = sqlList(TAPIS_REPORTING_STATES);
