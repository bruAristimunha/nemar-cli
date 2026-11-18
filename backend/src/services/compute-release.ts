/**
 * What ending an account does to its compute (epic #2005 phase A8, #2013; AGENTS.md, "Revocation
 * cascades, always"; ADR 0118; design section 7): as statements for the caller to run in the SAME
 * batch as its own credential revocations, exactly as `mailReleaseStatements`
 * (`services/ticket-assignment.ts`) does for an admin's tickets.
 *
 * TWO CALLERS, and the count is the point: `finalizeRevocation` (`routes/admin/users.ts`: admin revoke,
 * by username and by id) and `tombstoneUserCascade` (`db/user-tombstone.ts`: the owner-only soft delete
 * and the scheduled sweep of the live tests' accounts, which run the same function, so it counts once).
 * These are the two paths that end EVERY credential an account holds. A THIRD path that ends an account
 * needs these statements too. The list is `COMPUTE_END_CALLERS` below, and a source scan
 * (`backend/test/compute-end-callers.test.ts`) holds it to the code: it fails when either caller drops the
 * statements (as does `compute-release-cascade.test.ts`), and when a function that revokes all of a
 * user's keys and sessions THROUGH THE STATEMENT SHAPES THE SCAN RECOGNISES (`UPDATE tokens SET revoked_at
 * ... WHERE user_id ...`, and `UPDATE web_sessions SET revoked_at` or `DELETE FROM web_sessions WHERE
 * user_id ...`, however quoted or ordered, inline or in a constant or helper it names) neither runs them
 * nor is named in `COMPUTE_END_EXCEPTIONS`. A revocation written another way (SQL assembled from parts the
 * scan cannot fold) is not recognised: the scan is a tripwire for the shapes the Worker uses.
 *
 * A PARTNER'S RESERVATION IS LEFT ALONE. A job with `source = 'partner'` and no Tapis job yet is a
 * reservation the partner will launch its own Tapis job under (phase D4), and NEMAR never writes a launch
 * specification or takes a submit lease for it, so "never reached Tapis" below is TRUE of it whether or
 * not the partner has launched: ending it would release a hold for a job that may be running. The cascade
 * neither records an intent on it, cancels it nor releases its hold; the pools are frozen all the same,
 * and the reservation is the partner contract's to resolve (an open point for D4's brief). A partner job
 * that HAS a Tapis job is an ordinary live job here: it records the intent and the retried sweep cancels
 * it at Tapis, because NEMAR owns every Tapis job.
 *
 * DELIBERATELY NOT CALLED, and a later reader should not "fix" either:
 *  - A ROLE DEMOTION. Compute has nothing to do with an admin's standing: a person demoted to member is
 *    still an account in good standing with a grant, a pool and jobs that are theirs, and ending those
 *    would take a job away from someone who did nothing wrong. The demotion cascade ends what exists
 *    only for admins (the docs credential, the support tickets).
 *  - REVOKING AN API KEY (self-service, the owner's, the emailed regeneration). A job's identity is
 *    the account's, recorded in NEMAR's job row; Tapis never sees the key, and a person who revokes one
 *    key still has the account and its other credentials. A key's end is not an account's end.
 *    CONSEQUENCE, stated so nobody is surprised: a stolen key's jobs that were already submitted keep
 *    running (and are charged to the account) until the person cancels them or an administrator revokes
 *    the account; ending the key stops new submissions only.
 *  - Logout, which ends sessions and nothing else.
 *
 * WHAT IT DOES, in this order, every statement keyed by the account:
 *  1. every LIVE job (but a partner's reservation with no Tapis job) records the intent to cancel
 *     (`cancel_requested_at`) and the reason `account_ended`, keeping a reason and a time that were
 *     already recorded (the first cause stands: a person's earlier cancel stays `user`);
 *  2. a job that provably never reached Tapis is ended HERE: `cancelled`, its hold released and the
 *     release stamped as the settlement, as `commitTerminal` does it for a cancel (steps 2 to 4 are
 *     that job's terminal transition and its settlement, in the one batch). "Provably" is exactly the
 *     rule `driveCancel` applies before it ends a row itself: no Tapis job, no launch specification
 *     written (a submit whose answer was lost writes it BEFORE the call, and a Tapis job may exist that
 *     no search can see) and no live submit lease (a submitter is in flight). Ending any other job in
 *     SQL would release a hold for a job that then runs, charged to nobody;
 *  3. the holds of the jobs step 2 ended are released (the ledger's own conditional INSERT, the same
 *     one `releaseStatements` writes, so a job that never started consumes nothing and nothing is
 *     refunded);
 *  4. those jobs are stamped settled;
 *  5. every pool of the account is frozen, so no new hold is taken for an account that has ended
 *     (the holder's own pool; a frozen pool refuses a hold as `suspended`).
 * A job at Tapis, or one a submit may have reached, keeps its hold and stays live with the intent
 * recorded: THE TAPIS CANCEL IS NEVER MADE HERE. A network call inside a batch cannot be retried and
 * would hold the credential cascade hostage to a third party, so the batch records the intent and
 * `sweepComputeCancellations` (the 30-minute tick) cancels at Tapis, again and again until Tapis
 * says it is over, then charges what the job used. Nothing in this file calls Tapis.
 *
 * EVERY STATEMENT ENDS IN A WHERE CLAUSE, and uses plain `?` placeholders only, because
 * `tombstoneUserCascade` called with `onlyIfEmail` appends ` AND EXISTS (SELECT 1 FROM users WHERE id =
 * ? AND email = ?)` to each statement's text and its two binds after the statement's own: a statement
 * that ended in anything else (an ORDER BY, a LIMIT, a trailing semicolon) would not take the guard, and
 * a row whose address changed since the sweep read it would lose its compute to a cascade that
 * tombstoned nothing.
 *
 * REPLAYABLE: a second run changes nothing (a retried revoke re-enters its batch). Held by the ledger
 * too: its release statement writes only for a hold that is still open.
 */

import type { ComputeLedgerReason } from "../../../shared/compute-state.js";
import { DEFAULT_COMPUTE_POLICY } from "../../../shared/contract/compute.js";
import { LIVE_STATES_SQL } from "./compute-jobs.js";
import { SUBMIT_LEASE_MINUTES } from "./compute-lifecycle.js";

/** One statement of {@link computeReleaseStatements}: the caller prepares it on its own D1. */
export interface ComputeReleaseStatement {
  sql: string;
  binds: unknown[];
}

/** The cancel reason an ended account records (a word of `COMPUTE_CANCEL_REASONS`). */
const ACCOUNT_ENDED = "account_ended";

/** The ledger's own reason for a release (`COMPUTE_LEDGER_REASONS`), as `releaseStatements` writes it. */
const RELEASED: ComputeLedgerReason = "released";

/**
 * The job rows step 2 may end, as a WHERE term over `compute_jobs` (no alias): the account's, not yet at
 * Tapis, with no launch specification written and no live submit lease. `?` the account. A runner job is
 * not at Tapis and not this step's (it has no hold to release): its cancel intent is recorded by step 1 and
 * carried to its runner, and ending it here would end work a runner may be doing (ADR 0121).
 */
const NEVER_REACHED_TAPIS = `account_id = ? AND source <> 'partner' AND executor = 'tapis'
    AND state IN ('created', 'uploading') AND tapis_uuid IS NULL AND launch_spec_digest IS NULL
    AND (submit_claimed_at IS NULL
         OR submit_claimed_at < datetime('now', '-${SUBMIT_LEASE_MINUTES} minutes'))`;

/** The same rows after step 2 has ended them and before step 4 has stamped them. `?` the account. */
const ENDED_AND_UNSETTLED = `account_id = ? AND source <> 'partner'
    AND state = 'cancelled' AND tapis_uuid IS NULL AND launch_spec_digest IS NULL
    AND settled_provisional_at IS NULL`;

/** 1. The intent and the reason of every live job of the account. `?` the account. */
export const COMPUTE_RELEASE_INTENT_SQL = `UPDATE compute_jobs SET
    cancel_requested_at = COALESCE(cancel_requested_at, datetime('now')),
    cancel_reason = COALESCE(cancel_reason, '${ACCOUNT_ENDED}')
  WHERE account_id = ? AND state IN (${LIVE_STATES_SQL})
    AND NOT (source = 'partner' AND tapis_uuid IS NULL)`;

/**
 * 2. A job that never reached Tapis ends here, cancelled, with the retention `commitTerminal` gives a
 * terminal row (the current policy's records retention, in years, else the default). `?` the account.
 */
export const COMPUTE_RELEASE_CANCEL_SQL = `UPDATE compute_jobs SET
    state = 'cancelled',
    cancel_reason = COALESCE(cancel_reason, '${ACCOUNT_ENDED}'),
    ended_at = datetime('now'),
    retention_until = datetime('now', '+' || COALESCE(
      (SELECT CAST(json_extract(p.policy_json, '$.retention.recordsYears') AS INTEGER)
         FROM compute_policy p ORDER BY p.version DESC LIMIT 1),
      ${DEFAULT_COMPUTE_POLICY.retention.recordsYears}) || ' years')
  WHERE ${NEVER_REACHED_TAPIS}`;

/**
 * 3. The release of each of those jobs' whole hold: the ledger's own statement
 * (`RELEASE_INSERT_SQL` of compute-ledger.ts), over the account's ended and unsettled jobs. A hold
 * that is already closed, or never made, writes nothing. A plain INSERT: the ledger refuses a
 * conflict clause. `?` the account.
 */
export const COMPUTE_RELEASE_HOLDS_SQL = `INSERT INTO compute_ledger
    (kind, pool_id, budget_pool_id, held_delta_milli, job_id, hold_ref, reason, idempotency_key)
  SELECT 'release', h.pool_id, h.budget_pool_id, -h.held_delta_milli, h.job_id, h.id, '${RELEASED}',
         'hold:' || h.id || ':release'
    FROM compute_ledger h
   WHERE h.kind = 'hold'
     AND h.job_id IN (SELECT j.id FROM compute_jobs j
                       WHERE j.account_id = ? AND j.source <> 'partner'
                         AND j.state = 'cancelled' AND j.tapis_uuid IS NULL
                         AND j.launch_spec_digest IS NULL AND j.settled_provisional_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM compute_ledger c
                      WHERE c.hold_ref = h.id AND c.kind IN ('release', 'charge'))`;

/**
 * 4. The stamp that says the release happened (`SETTLED_STAMP_SQL` of compute-lifecycle.ts, for a job
 * that was released): written only where the ledger holds the entry that closed the hold. `?` the
 * account.
 */
export const COMPUTE_RELEASE_STAMP_SQL = `UPDATE compute_jobs SET
    settled_provisional_at = datetime('now'),
    charged_milli = (SELECT COALESCE(SUM(e.charged_delta_milli), 0) FROM compute_ledger e
                      WHERE e.job_id = compute_jobs.id)
  WHERE ${ENDED_AND_UNSETTLED}
    AND EXISTS (SELECT 1 FROM compute_ledger c
                 WHERE c.job_id = compute_jobs.id AND c.kind IN ('charge', 'release'))`;

/**
 * 5. Every pool of the account is frozen: a hold on a frozen pool is refused `suspended`. The holder
 * of an account's pool is the account id as text (`ensurePool`); the platform's and a partner's pools
 * are other holders and are never reached. `?` the account id, as text. Nothing here writes a total:
 * only the ledger's trigger does.
 */
export const COMPUTE_RELEASE_FREEZE_SQL = `UPDATE compute_pools SET
    frozen = 1, updated_at = datetime('now')
  WHERE holder_kind = 'account' AND holder_ref = ? AND frozen = 0`;

/**
 * The statements that end an account's compute, for the caller's own batch (see the header for the
 * two callers, the order and the rules every statement keeps). Pure: it builds text and binds, and
 * touches no database and no network.
 */
export function computeReleaseStatements(userId: number): ComputeReleaseStatement[] {
  if (!Number.isSafeInteger(userId) || userId < 1) {
    throw new RangeError("an account id is a positive whole number");
  }
  return [
    { sql: COMPUTE_RELEASE_INTENT_SQL, binds: [userId] },
    { sql: COMPUTE_RELEASE_CANCEL_SQL, binds: [userId] },
    { sql: COMPUTE_RELEASE_HOLDS_SQL, binds: [userId] },
    { sql: COMPUTE_RELEASE_STAMP_SQL, binds: [userId] },
    { sql: COMPUTE_RELEASE_FREEZE_SQL, binds: [String(userId)] },
  ];
}

/**
 * THE DOCUMENTED LIST of the functions that run {@link computeReleaseStatements}, as `file#function` under
 * `backend/src` (a route callback is `file#METHOD /path`). The two paths that end every credential an
 * account holds. `test/compute-end-callers.test.ts` holds this list to the code on the syntax tree, through
 * aliased and namespace imports and uses that pass the function as a value: a function that runs the set
 * and is not listed, or a listed one that no longer runs it, fails the test, and so does a new function
 * that revokes all of a user's keys and sessions through the statement shapes the scan recognises (see the
 * header) and neither runs the set nor is named in {@link COMPUTE_END_EXCEPTIONS}. A third path that ends
 * an account (the suspension of compute) therefore has to add itself here, in a reviewed change. The
 * owner's merge command, `oidc end-account` (`routes/admin/oidc.ts`), is not such a path: per ADR 0119 it
 * ends the OIDC holdings only and revokes nothing, and compute ends through the revoke or delete that
 * follows it, which are listed here.
 */
export const COMPUTE_END_CALLERS = [
  "db/user-tombstone.ts#tombstoneUserCascade",
  "routes/admin/users.ts#finalizeRevocation",
] as const;

/**
 * The functions that revoke ALL of an account's API keys and its sessions and deliberately do NOT end its
 * compute, each with its reason (the same shape as {@link COMPUTE_END_CALLERS}). A new entry is a
 * decision that an account survives the revocation, and is made in a reviewed change.
 */
export const COMPUTE_END_EXCEPTIONS: Readonly<Record<string, string>> = {
  "routes/admin/users.ts#POST /users/:username/role":
    "A role demotion revokes every API key and the docs credential because what exists only for an admin ends, but the person keeps an account in good standing with a grant, pools and jobs of their own, so their compute is not ended.",
  "routes/auth.ts#GET /confirm-key-regeneration":
    "The emailed key regeneration revokes every API key and the docs credential and mints a new key in the same request: the person keeps the account, so nothing of their compute ends.",
};
