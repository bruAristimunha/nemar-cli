import { type Bindings, hasRole, parseRole } from "../types/bindings";
import { isActiveAccountStatus } from "./account-tier";
import { verifyApprovalDispatchToken } from "./github/callback-tokens";

/**
 * The lease behind a web-launched approval (ADR 0080).
 *
 * A run is "in flight" while something is still driving it, and the database
 * has no heartbeat for that other than two timestamps: `approval_dispatched_at`
 * (set when the dispatch route claims the request) and `updated_at` (bumped by
 * every call to `/approve`, which is every batch of the caller's S3 Object Lock
 * loop and every step the orchestrator records). The run counts as live for
 * {@link APPROVAL_LEASE_MINUTES} after its last sign of life, and the lease
 * simply lapses once the signs stop, which is the only way a crashed or
 * cancelled executor can release it.
 *
 * ONE predicate, three readers. The dispatch route claims with it (a second click,
 * or a second admin, must not start a second run beside the first), the list
 * route reports it as `approval_in_flight`, so a page never offers a button the
 * route would refuse, and the deny route refuses a request it says is in flight
 * (a denial would overwrite a run that is still writing). Clients must not
 * hard-code the minutes: they read the boolean. That is why this is SQL rather
 * than a function over a row: the claim has to be one atomic conditional UPDATE,
 * and a TypeScript copy for the list would be a second statement of the same
 * rule free to drift from the first.
 *
 * Two clauses, because there are two ways to run an approval:
 *
 *   1. dispatched within the lease. The executor may not have made its first
 *      `/approve` call yet (a queued runner), so `updated_at` alone would call
 *      a freshly dispatched run idle.
 *   2. `approving` with a fresh `updated_at`. A terminal approval never sets
 *      `approval_dispatched_at`, so without this clause the web could start a
 *      second run beside a person's own.
 *
 * Both are limited to a request that can still run (`requested` or `approving`):
 * a `published`, `denied` or `blocked` row has no run to protect, and a row
 * published a minute after its dispatch must not read as in flight.
 *
 * A FAILED run is the exception to "live for the whole lease". The orchestrator
 * records a step's failure in `last_error` and answers 500; the caller then
 * either gives up or retries. Treating the failure as "still running" for the
 * rest of the lease would hold a dead run for up to fifteen minutes. But
 * treating it as stopped AT ONCE would be wrong too: the CLI retries a failed
 * step after a fixed wait (`APPROVE_RETRY_DELAY_MS`, 10 seconds, up to five
 * times), and an executor launched in that wait would run beside the retry that
 * is about to start. So a failed run stays in flight for
 * {@link FAILED_RUN_GRACE_SECONDS}, comfortably longer than that wait, and is
 * stalled after it. A retry clears `last_error` as it starts (the orchestrator's
 * request-start UPDATE) and so is in flight again at once, and so is a fresh
 * dispatch (the claim clears it): the previous attempt's error is history.
 */

/** How long a run stays "in flight" after its last sign of life. */
export const APPROVAL_LEASE_MINUTES = 15;

/**
 * How long a run that recorded an error stays in flight after recording it.
 * Must outlast the CLI's wait between attempts; a test binds it to
 * `APPROVE_RETRY_DELAY_MS` so the two cannot drift apart.
 */
export const FAILED_RUN_GRACE_SECONDS = 60;

/**
 * SQL boolean expression: this `publication_requests` row's lease is live, by
 * time alone (the two clauses above), ignoring whether the run has failed.
 * `columnPrefix` qualifies the columns (`"pr."` in a join, `""` in an UPDATE's
 * WHERE). The interpolated value is a module constant, never input.
 *
 * Used where "is anything still associated with this request" is the question
 * rather than "is it running right now": the dispatch token's check
 * ({@link checkApprovalDispatchToken}), which must keep naming the admin who
 * clicked across a failed step's retries.
 */
export function approvalLeaseLiveSql(columnPrefix = ""): string {
  const p = columnPrefix;
  const since = `datetime('now', '-${APPROVAL_LEASE_MINUTES} minutes')`;
  return `(${p}status IN ('requested', 'approving') AND (
      (${p}approval_dispatched_at IS NOT NULL AND ${p}approval_dispatched_at >= ${since})
      OR (${p}status = 'approving' AND ${p}updated_at >= ${since})
    ))`;
}

/**
 * SQL boolean expression: this row has a live approval run RIGHT NOW. The
 * lease is live, and the run has not failed more than
 * {@link FAILED_RUN_GRACE_SECONDS} ago. This is what the dispatch claim and the
 * list route's `approval_in_flight` read.
 */
export function approvalInFlightSql(columnPrefix = ""): string {
  const p = columnPrefix;
  const failedBefore = `datetime('now', '-${FAILED_RUN_GRACE_SECONDS} seconds')`;
  return `(${approvalLeaseLiveSql(p)} AND (${p}last_error IS NULL OR ${p}updated_at >= ${failedBefore}))`;
}

/**
 * The newest request an approval could act on, for one dataset. The orchestrator
 * (`runPublicationApproval`) and the dispatch route both read it, and it must be
 * the SAME row: the executor's `/approve` call picks its request with this, so a
 * dispatch that claimed a different row would put the clicking admin on a
 * request the run never touches. `blocked` is included because `/approve` acts
 * on it; the dispatch route then refuses it separately. Selected columns are the
 * caller's: this is only the WHERE / ORDER tail, bound with the dataset id.
 */
export const ACTIVE_REQUEST_TAIL_SQL = `FROM publication_requests
   WHERE dataset_id = ? AND status IN ('requested', 'approving', 'blocked')
   ORDER BY requested_at DESC LIMIT 1`;

/**
 * The SET fragment that clears a web approval's claim (`approval_requested_by`,
 * `approval_dispatched_at`). Every statement that ends a claim spells it from here, so the day a
 * claim gains a column there is one place to add it and no statement that clears half of it.
 * It carries no trailing comma: write `SET ${APPROVAL_CLAIM_CLEAR_SQL}, other = ?` or end the
 * SET with it.
 */
export const APPROVAL_CLAIM_CLEAR_SQL =
  "approval_requested_by = NULL, approval_dispatched_at = NULL";

/** Who a publication is recorded as approved by. */
export interface Approver {
  id: number;
  username: string;
}

/**
 * The approver of a run: the admin who clicked Approve on the website when this call proves it
 * belongs to that click, otherwise the account calling `/approve`.
 *
 * Attribution forks on purpose (ADR 0080; ADR 0103, decision 4 for what it forks on). An executor
 * authenticates with its own service key, so without this the `approved_by` column and the
 * `dataset_published` audit row would name the bot for every web approval. A terminal approval
 * carries no token, so it falls through to the caller and behaves exactly as it always has; the
 * caller is the person.
 *
 * The proof is the dispatch token (#1604, ADR 0103 decisions 1 to 4): `proof` is the answer of
 * {@link checkApprovalDispatchToken}, and only its `valid` variant, a call that presented the token
 * of THIS claim of THIS request while its lease is live, carries the clicker (`clickerId`, read from
 * the claim the token was verified against, so a valid proof with no clicker cannot be built). The
 * fork is on the proof and not on the lease, so a
 * person who runs `/approve` at a terminal inside a web run's live lease is recorded as themselves
 * (and takes the claim over, at the mark), where the lease alone used to record them as the
 * clicker. A call whose token does not verify never reaches here: the caller answers 409 first.
 * The check is made at the TOP of `/approve`, before the request-start UPDATE bumps the heartbeat,
 * and reads the time-only lease (`approvalLeaseLiveSql`), so every batch call of a long web run and
 * the retry of a failed step still resolve to the clicker.
 *
 * A clicker whose account row is gone, who is no longer an active admin, or who has been deleted
 * falls back to the caller rather than failing a publication that is already underway; the dispatch
 * left its own audit row naming the clicker by id. The token authorizes nothing and joins no
 * revocation list for exactly this reason: this re-check, at each use, is what keeps a clicker's
 * ended access from being recorded as an approval.
 */
export async function resolveApprover(
  db: D1Database,
  proof: Exclude<ApprovalDispatchTokenCheck, { kind: "refused" }>,
  caller: Approver,
): Promise<Approver> {
  if (proof.kind !== "valid") return caller;
  const clicker = await db
    .prepare("SELECT id, username, email, role, status, deleted_at FROM users WHERE id = ?")
    .bind(proof.clickerId)
    .first<{
      id: number;
      username: string | null;
      email: string;
      role: string | null;
      status: string;
      deleted_at: string | null;
    }>();
  if (!clicker) return caller;
  // A clicker who has since been demoted, revoked or deleted must not be
  // recorded as the approver of a run that carries on after their access ended:
  // the executing key is who actually finished it, and the dispatch left its own
  // audit row naming the clicker by id.
  if (clicker.deleted_at !== null || !isActiveAccountStatus(clicker.status)) return caller;
  const role = parseRole(clicker.role, clicker.username ?? undefined);
  if (role === null || !hasRole(role, "admin")) return caller;
  // Web-only accounts may have no username yet; the address still names them.
  return { id: clicker.id, username: clicker.username || clicker.email };
}

/** Why a presented dispatch token was refused. */
export type ApprovalDispatchRefusal = "dispatch_superseded" | "dispatch_expired";

/** What {@link checkApprovalDispatchToken} found. */
export type ApprovalDispatchTokenCheck =
  | { kind: "absent" }
  /**
   * The token is the claim's own. `clickerId` and `claimedAt` are the claim's columns the token
   * was verified against: the administrator who clicked, and the instant that click claimed the
   * request. The caller attributes the run to the first and binds its mark to the second, so
   * there is no bare "valid" beside nullable columns to get out of step.
   */
  | { kind: "valid"; clickerId: number; claimedAt: string }
  | { kind: "refused"; code: ApprovalDispatchRefusal };

/** The columns of a `publication_requests` row that a dispatch token is checked against. */
export interface ApprovalClaimRow {
  dataset_id: string;
  id: number;
  approval_requested_by: number | null;
  approval_dispatched_at: string | null;
  /**
   * {@link approvalLeaseLiveSql} read in the SAME statement as the row, before the call's own
   * heartbeat bump: 1 when the claim's lease is live by time alone. Compared with 1, so anything
   * else (0, NULL from a missing column) is a lapsed lease.
   */
  approval_lease_live: number | null;
}

const SUPERSEDED: ApprovalDispatchTokenCheck = { kind: "refused", code: "dispatch_superseded" };
const EXPIRED: ApprovalDispatchTokenCheck = { kind: "refused", code: "dispatch_expired" };

/**
 * Does this `/approve` call carry the token of the claim on the request it is about to act on?
 *
 * The token is derived from the claim's own columns (`signApprovalDispatchToken`), so presenting
 * one that verifies means the call was dispatched by THIS click of THIS request (ADR 0103,
 * decisions 1 and 4). The rules, in this order, each deciding before the next is read:
 *
 *   1. No header, or an empty or blank one: `absent`. The caller is a person at a terminal (or an
 *      executor that predates the token), and is recorded as itself.
 *   2. No secret on the Worker, no claim on the row, or a MAC that does not match: `superseded`.
 *      The claim is gone (released, taken over, or denied), was replaced by a newer click, belongs
 *      to another request or clicker, or the token is not one. A Worker that cannot check a token
 *      is never one that honors it.
 *   3. A MAC that matches while the lease has lapsed: `expired`. The run sat quiet past its
 *      lease, so a click made long ago is not honored for work that happens now; clicking again
 *      claims afresh. Asked only AFTER the MAC, so a stranger learns nothing about a lease.
 *   4. Otherwise `valid`, carrying the claim's clicker and instant: rule 2 has already refused a
 *      claim with either column null, so a `valid` answer cannot lack them.
 *
 * A `refused` call must change nothing: the caller answers 409 with the code before any write.
 * The lease read is the time-only one (`approvalLeaseLiveSql`), not the failure-aware in-flight
 * predicate, so the retry of a failed step stays attributed to the clicker.
 */
export async function checkApprovalDispatchToken(
  env: Pick<Bindings, "PRESCREEN_CALLBACK_SECRET">,
  row: ApprovalClaimRow,
  token: string | null | undefined,
): Promise<ApprovalDispatchTokenCheck> {
  const presented = token?.trim();
  if (!presented) return { kind: "absent" };
  const secret = env.PRESCREEN_CALLBACK_SECRET;
  if (!secret || row.approval_requested_by === null || row.approval_dispatched_at === null) {
    return SUPERSEDED;
  }
  const matches = await verifyApprovalDispatchToken(
    presented,
    {
      datasetId: row.dataset_id,
      requestId: row.id,
      clickerId: row.approval_requested_by,
      claimedAt: row.approval_dispatched_at,
    },
    secret,
  );
  if (!matches) return SUPERSEDED;
  if (row.approval_lease_live !== 1) return EXPIRED;
  return {
    kind: "valid",
    clickerId: row.approval_requested_by,
    claimedAt: row.approval_dispatched_at,
  };
}
