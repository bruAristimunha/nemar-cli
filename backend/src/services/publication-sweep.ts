/**
 * Re-evaluate publication requests that were blocked on BIDS validation (#428).
 *
 * When a user runs `nemar dataset publish request` while BIDS validation CI is
 * still pending/running, the request is blocked with
 * `block_reason='bids_validation_pending' | 'bids_validation_in_progress'`. That
 * block was one-shot: nothing re-checked the request when CI later went green,
 * so requests sat in `blocked` indefinitely (13 of bruaristimunha's requests
 * stuck for weeks, cleared by hand). This sweep — run from the daily cron — is
 * the defense-in-depth re-evaluation the issue asks for: it re-reads the latest
 * BIDS validation run for each blocked request and transitions it.
 *
 * It reuses the exact readiness evaluation from the publish-request path
 * (`getWorkflowRuns(..., "bids-validation.yml")` -> latest run conclusion), so
 * the cron and the interactive path can never disagree. A request that CI would
 * release is also put through the submission minimums and the anonymity blind
 * check (`checkSubmissionGate`, the function the request route calls), because
 * a request made while CI was still running is nearly always released HERE and
 * would otherwise skip both.
 */

import { CI_PENDING_BLOCK_REASONS } from "../../../shared/contract/publication.js";
import type { Bindings } from "../types/bindings.js";
import { DEV_OWNED_FIXTURE_IDS } from "./datasetId.js";
import { isNonProductionEnv } from "./environment.js";
import { getDatasetsToken } from "./github-auth.js";
import { getWorkflowRuns } from "./github.js";
import { RESET_SCREEN_COLUMNS_SQL, startScreenAndNotify } from "./identifier-screen.js";
import { type GateReadBudget, checkSubmissionGate } from "./submission-gate.js";

/**
 * Requests one sweep may unblock, and therefore screen (epic #1610 phase 4).
 * Each unblock dispatches an identifier screen and, when it reports, mails the
 * admins once; the cap keeps a backlog from becoming a burst of dispatches and
 * mail in one tick. A request over the cap stays blocked and is unblocked by a
 * later sweep, so it is never left `requested` with no screen.
 */
export const MAX_SCREENED_UNBLOCKS_PER_SWEEP = 10;

/**
 * GitHub reads the submission gate may make in ONE sweep, across all rows. A
 * row costs one read when its description lists an ethics approval and up to
 * five when it does not (the description and four README candidates), and the
 * sweep also makes one CI lookup per row; unbounded, 50 rows with no README is
 * about 300 requests in a single scheduled invocation, which is over the
 * platform's per-invocation subrequest limit. When it is spent the rows not yet
 * evaluated are left for the next run (`deferred`), which starts where this one
 * stopped because they are not touched.
 */
export const MAX_GATE_READS_PER_SWEEP = 100;

/** The block_reason values produced by the BIDS-validation readiness check. */
export const BIDS_VALIDATION_BLOCK_REASONS = [
  ...CI_PENDING_BLOCK_REASONS,
  "bids_validation_failed",
] as const;

export type BlockedBidsAction =
  | { kind: "unblock" }
  | { kind: "reblock"; blockReason: "bids_validation_failed" }
  | { kind: "keep" };

/**
 * Pure decision: given the latest BIDS validation run, what should happen to a
 * request currently blocked on validation? Mirrors the publish-request logic in
 * `routes/datasets/publication.ts`:
 *   - no runs yet                 -> still pending, keep blocked
 *   - latest conclusion 'success' -> unblock (back to 'requested')
 *   - latest conclusion 'failure' -> re-block as 'bids_validation_failed'
 *   - latest conclusion null      -> in progress, keep blocked
 *   - cancelled/skipped/timed_out -> keep blocked; a later run decides
 */
export function evaluateBlockedBidsValidation(args: {
  hasRuns: boolean;
  latestConclusion: string | null;
}): BlockedBidsAction {
  if (!args.hasRuns) return { kind: "keep" };
  if (args.latestConclusion === "success") return { kind: "unblock" };
  if (args.latestConclusion === "failure")
    return { kind: "reblock", blockReason: "bids_validation_failed" };
  return { kind: "keep" };
}

/** A blocked request as the candidate query returns it. */
interface Candidate {
  id: number;
  dataset_id: string;
  block_reason: string;
  anonymous: number | null;
  updated_at: string;
  github_repo: string | null;
  source: string | null;
  is_exemplar: number | null;
}

/**
 * The request as the sweep read it, as a WHERE clause. The sweep reads a row,
 * spends GitHub calls on it, and only then writes; a request can be made again
 * in between (`POST /datasets/:id/publish/request` rewrites the row, and may
 * turn it anonymous). Every write is conditional on the row still being what
 * was read, so a verdict about the old row is never applied to the new one.
 * `IS` rather than `=` because `anonymous` is nullable. Status alone was not
 * enough: a request re-blocked as anonymous is still `blocked`, and the sweep
 * would have released it on a verdict reached for a native one.
 */
const AS_READ_SQL =
  "id = ? AND status = 'blocked' AND anonymous IS ? AND block_reason IS ? AND updated_at IS ?";
const asRead = (row: Candidate): (string | number | null)[] => [
  row.id,
  row.anonymous,
  row.block_reason,
  row.updated_at,
];

export interface BlockedSweepResult {
  scanned: number;
  unblocked: number;
  reblocked: number;
  errors: number;
  /** Unblocked requests whose identifier screen was dispatched. */
  screened?: number;
  /** Requests left for the next run because the gate's read budget was spent. */
  deferred: number;
  /** Requests that changed between the sweep reading them and writing: left as they now are. */
  skipped: number;
  /** GitHub reads the submission gate made. */
  gateReads: number;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The non-production scope for the blocked-BIDS candidate query, as a clause
 * plus the values to bind for it.
 *
 * Exported so the test imports the REAL clause instead of retyping it.
 * `.rules/testing.md` names hand-copied SQL outright, and the version of this
 * test that predated #1440 retyped `LIKE 'xx09%'` and therefore could not see
 * the clause change under it.
 */
export function blockedSweepScope(nonProduction: boolean): { clause: string; ids: string[] } {
  if (!nonProduction) return { clause: "", ids: [] };
  const ids = [...DEV_OWNED_FIXTURE_IDS];
  const inList = ids.length > 0 ? ` OR pr.dataset_id IN (${ids.map(() => "?").join(", ")})` : "";
  return { clause: `AND (pr.dataset_id LIKE 'xx09%'${inList})`, ids };
}

/**
 * The blocked-BIDS candidate query and its binds, in one place.
 *
 * Exported WHOLE rather than just the scope clause, because the clause alone
 * was not enough: the test imported it and then rebuilt the surrounding SELECT
 * by hand, so its placeholder layout was not production's and transposing
 * `declaredIds` with `limit` in the real `.bind()` left the suite green. The
 * bind order is a property of the SQL, so the two travel together or neither
 * is tested.
 */
export function blockedCandidateQuery(
  nonProduction: boolean,
  limit: number,
): { sql: string; binds: (string | number)[] } {
  const { clause, ids } = blockedSweepScope(nonProduction);
  const placeholders = BIDS_VALIDATION_BLOCK_REASONS.map(() => "?").join(", ");
  return {
    sql: `SELECT pr.id, pr.dataset_id, pr.block_reason, pr.anonymous, pr.updated_at, d.github_repo,
                 d.source, d.is_exemplar
           FROM publication_requests pr
           JOIN datasets d ON d.dataset_id = pr.dataset_id
          WHERE pr.status = 'blocked'
            AND pr.block_reason IN (${placeholders})
            ${clause}
          ORDER BY pr.updated_at ASC
          LIMIT ?`,
    binds: [...BIDS_VALIDATION_BLOCK_REASONS, ...ids, limit],
  };
}

/**
 * Re-evaluate every publication request blocked on BIDS validation and
 * transition the ones whose CI has since resolved. Returns a tally for the cron
 * log. Never throws — per-row failures are counted and skipped so one bad repo
 * can't abort the sweep.
 *
 * Unblocked requests move to 'requested' (they re-enter the admin publish
 * queue, visible via `nemar admin publish list`) once the submission gate also
 * passes (one that fails is re-blocked as `min_requirements_failed`, counted as
 * `reblocked`; a blind that could not be verified waits for the next run,
 * counted as an error) and their identifier screen is
 * started (epic #1610 phase 4, ADR 0086), exactly as a re-request would: the
 * admins are mailed once, when the screen reports, or at once if it cannot
 * start. Without it an unblocked request would sit `requested` with no screen,
 * which the approval gate refuses and nobody is told about. The burst the old
 * no-mail rule guarded against is bounded by MAX_SCREENED_UNBLOCKS_PER_SWEEP
 * instead: a request over the cap stays blocked until a later sweep.
 */
export async function sweepBlockedBidsValidationRequests(
  env: Bindings,
  limit = 50,
  gateReadBudget = MAX_GATE_READS_PER_SWEEP,
): Promise<BlockedSweepResult> {
  const db = env.DB;
  const result: BlockedSweepResult = {
    scanned: 0,
    unblocked: 0,
    reblocked: 0,
    errors: 0,
    deferred: 0,
    skipped: 0,
    gateReads: 0,
  };
  const budget: GateReadBudget = { remaining: gateReadBudget };
  // Candidates are taken oldest `updated_at` first, `limit` at a time. A row
  // that is looked at and left as it is (CI still running, a file that could
  // not be read) keeps its old `updated_at` and so stays first in line: enough
  // of them would fill every run and starve the rows behind. A row that stays a
  // candidate after being looked at is therefore moved to the back. One that was
  // NOT looked at (over the unblock cap, or deferred by the read budget) is left
  // where it is, so the next run starts with it.
  const rotate = async (row: Candidate): Promise<void> => {
    try {
      await db
        .prepare(
          `UPDATE publication_requests SET updated_at = datetime('now') WHERE ${AS_READ_SQL}`,
        )
        .bind(...asRead(row))
        .run();
    } catch (err) {
      console.error(`[publish-sweep] could not requeue ${row.dataset_id}: ${errMsg(err)}`);
    }
  };

  // Production only (epic #923 Phase 7). The candidate query filters on request
  // status alone, with no dataset-id prefix restriction, so on the dev/staging
  // worker (whose D1 is a partial production mirror) it would select REAL
  // datasets' publication requests, read their real repos via the shared
  // nemarDatasets installation token, and rewrite their status.
  //
  // Narrowed rather than disabled: staging genuinely needs this sweep, because
  // a dataset published while its BIDS validation is still running lands in
  // exactly this 'blocked' state and would otherwise stay stuck forever.
  //
  // Scoped to what the dev worker OWNS, not to the dev id RANGE (#1440). The
  // range form (`LIKE 'xx09%'`) silently excluded the standing anonymous
  // deposit once it moved to a reserved `nm` id -- and an anonymous release IS
  // a publication request, so that fixture is the single most likely dataset on
  // staging to land in this state. It was inside the range at xx099907 and
  // dropped out of it at nm099998, which is the same regression this epic fixed
  // in three other fences.
  //
  // The declared ids are BOUND, not interpolated, and come from the same
  // exported declaration the predicates use, so this clause cannot disagree
  // with `isDevOwnedDatasetId`.
  const candidate = blockedCandidateQuery(isNonProductionEnv(env), limit);

  // Guard the initial query so a D1 outage / schema drift surfaces as errors>0
  // in the cron tally rather than an all-zero result indistinguishable from
  // "nothing to do". This keeps the "never throws" contract honest.
  let rows: { results: Candidate[] };
  try {
    rows = await db
      .prepare(candidate.sql)
      .bind(...candidate.binds)
      .all<Candidate>();
  } catch (err) {
    result.errors++;
    console.error(`[publish-sweep] initial query failed; sweep aborted: ${errMsg(err)}`);
    return result;
  }

  if (rows.results.length === 0) return result;

  let pat: string;
  try {
    pat = await getDatasetsToken(env);
  } catch (err) {
    // Auth failure with rows pending is a real error, not a no-op: count it so
    // a broken token surfaces in the audit log instead of reading as "clean".
    result.errors++;
    console.error(
      `[publish-sweep] could not resolve datasets token; skipping sweep: ${errMsg(err)}`,
    );
    return result;
  }

  result.screened = 0;
  let unblocks = 0;
  for (const row of rows.results) {
    result.scanned++;
    const repoName = row.github_repo?.split("/")[1];
    if (!repoName) {
      console.warn(`[publish-sweep] ${row.dataset_id}: no github_repo on dataset; skipping`);
      await rotate(row);
      continue;
    }

    let action: BlockedBidsAction;
    try {
      const runs = await getWorkflowRuns(repoName, "bids-validation.yml", pat);
      action = evaluateBlockedBidsValidation({
        hasRuns: runs.length > 0,
        latestConclusion: runs[0]?.conclusion ?? null,
      });
    } catch (err) {
      result.errors++;
      console.error(`[publish-sweep] CI lookup failed for ${row.dataset_id}: ${errMsg(err)}`);
      await rotate(row);
      continue;
    }

    try {
      if (action.kind === "unblock") {
        if (unblocks >= MAX_SCREENED_UNBLOCKS_PER_SWEEP) {
          // Over the cap: left blocked for a later sweep, never unblocked
          // without a screen.
          continue;
        }
        // The submission minimums and the anonymity blind check (ADR 0026, ADR
        // 0065), through the same function the request route uses. A request
        // made while CI was running was blocked on CI alone, and the route
        // checks these when it records one, but the depositor may have edited
        // `dataset_description.json` since, and a request is released under a
        // blind or a Name only if it passes NOW. A request that does not is
        // re-blocked with the reasons, as the route would have, and is no longer
        // a candidate here: the depositor fixes the data and requests again.
        // A file that could not be READ says nothing about the data, so the
        // request is left blocked for the next sweep rather than given a
        // verdict (native or anonymous: a daily batch loses a day by waiting,
        // and a release on a partial look is the one mistake that cannot be
        // taken back). Its reads never sleep or retry, and share one budget; a
        // row that needs none (an exempt dataset) is not held back by a spent
        // one.
        const gate = await checkSubmissionGate({
          datasetId: row.dataset_id,
          repoName,
          pat,
          dataset: row,
          anonymous: row.anonymous === 1,
          caller: "publish-sweep",
          budget,
        });
        if (gate.kind === "unverified") {
          if (gate.cause === "budget") {
            result.deferred++;
          } else {
            result.errors++;
            await rotate(row);
          }
          continue;
        }
        if (gate.kind === "blocked") {
          const reblock = await db
            .prepare(
              `UPDATE publication_requests
                  SET block_reason = 'min_requirements_failed', min_requirements_reasons = ?,
                      updated_at = datetime('now')
                WHERE ${AS_READ_SQL}`,
            )
            .bind(JSON.stringify(gate.reasons), ...asRead(row))
            .run();
          if ((reblock.meta.changes ?? 0) > 0) {
            result.reblocked++;
            console.log(
              `[publish-sweep] ${row.dataset_id}: BIDS validation green but submission minimums failing; request ${row.id} block_reason -> min_requirements_failed`,
            );
          } else {
            result.skipped++;
          }
          continue;
        }
        // Mirror the interactive re-request unblock (routes/datasets/publication.ts): also
        // clear stale prescreen and identifier-screen state, so a previously
        // screened request doesn't carry an old verdict back to 'requested'.
        // Guarded on the row being as it was read, so a concurrent re-request
        // can't be clobbered, and the minimums verdict a re-request recorded
        // is cleared with the release, as the route clears it.
        const upd = await db
          .prepare(
            `UPDATE publication_requests
                SET status = 'requested', block_reason = NULL, min_requirements_reasons = NULL,
                    prescreen_status = NULL, prescreen_nonce = NULL,
                    prescreen_issue_url = NULL, prescreen_reasons = NULL,
                    ${RESET_SCREEN_COLUMNS_SQL},
                    updated_at = datetime('now')
              WHERE ${AS_READ_SQL}`,
          )
          .bind(...asRead(row))
          .run();
        if ((upd.meta.changes ?? 0) > 0) {
          unblocks++;
          result.unblocked++;
          console.log(
            `[publish-sweep] ${row.dataset_id}: BIDS validation now green; request ${row.id} unblocked -> requested`,
          );
          // Its own failure is its own: startScreenAndNotify never throws, and
          // mails the admins itself when the screen cannot start.
          const started = await startScreenAndNotify(env, {
            requestId: row.id,
            datasetId: row.dataset_id,
            githubRepo: row.github_repo,
          });
          if (started.kind === "dispatched") result.screened++;
          else if (started.kind !== "exempt") result.errors++;
        } else {
          result.skipped++;
        }
      } else if (action.kind === "reblock" && row.block_reason !== action.blockReason) {
        const upd = await db
          .prepare(
            `UPDATE publication_requests
                SET block_reason = ?, updated_at = datetime('now')
              WHERE ${AS_READ_SQL}`,
          )
          .bind(action.blockReason, ...asRead(row))
          .run();
        if ((upd.meta.changes ?? 0) > 0) {
          result.reblocked++;
          console.log(
            `[publish-sweep] ${row.dataset_id}: BIDS validation failing; request ${row.id} block_reason -> ${action.blockReason}`,
          );
        } else {
          result.skipped++;
        }
      } else {
        // Still waiting on validation (no run, a run going, an inconclusive
        // one), or already labelled as failing: nothing to write, but it was
        // looked at.
        await rotate(row);
      }
    } catch (err) {
      // A transient D1 error on one row must not abort the whole sweep: count
      // it and move on so the remaining rows are still processed.
      result.errors++;
      console.error(`[publish-sweep] DB update failed for ${row.dataset_id}: ${errMsg(err)}`);
    }
  }

  result.gateReads = gateReadBudget - budget.remaining;
  if (result.deferred > 0) {
    console.warn(
      `[publish-sweep] ${result.deferred} request(s) left for the next run (gate read budget of ${gateReadBudget} spent after ${result.gateReads} reads)`,
    );
  }
  return result;
}
