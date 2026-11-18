/**
 * The daily dispatcher of NEMAR's own pipelines (epic #2005 phase A6, #2011; ADR 0118; design section 10):
 * once a day, in production only, and only after the owner has turned two switches on, dispatch the
 * automatic recipes over the datasets they have not been run over, within the owner's caps.
 *
 * DARK BY DEFAULT, THREE TIMES OVER. It returns null outside exact production before it reads or writes
 * anything (the development database shares real users); it does nothing while
 * `COMPUTE_PIPELINES_DISPATCH_ENABLED` is not exactly `"1"` or compute is off (`computePipelinesDispatchEnabled`,
 * which reads both), touching no table; and it is wired only into the production-only daily block of
 * `scheduled()`, absent from `DEV_CRON_ALLOWLIST`. The two switches are absent from every table of
 * `backend/wrangler-sccn.toml`; the owner adds them in a reviewed change (`compute-switches-flag.test.ts`).
 *
 * WHAT IT DISPATCHES. Only recipes whose registry entry says `autoDispatch` (the service refuses a cron
 * that asks for another). For each, the eligible datasets whose newest version holds no live or succeeded
 * stamp for the recipe's tuple, through `dispatchPipelineJob`, so every dataset is decided again from its
 * own row. The stamps are synced first.
 *
 * THE CAPS, all the owner's, read from the policy on every run:
 *  - `policy.pipelines.dailyJobCap` minus the pipeline jobs already made today (UTC), across all recipes;
 *  - `policy.pipelines.maxLiveJobs` per pool, minus the pipeline jobs live in that pool, so a recipe never
 *    takes more of the cluster than the owner allows;
 *  - {@link CRON_DISPATCH_PER_TICK}, a bound of this file's own on one tick (below).
 * Both reads are `pipelineRoom`, the one an administrator's run uses, and every pipeline hold also carries
 * the live cap as a guard inside its own statement, so the cron and an administrator's run cannot together
 * exceed it (issue #2121): what this file reads here decides what it TRIES, the hold decides what is made.
 * A refused hold stops the run for that pool: the next recipe of the same pool is not asked, because it
 * would be refused for the same reason. A refusal that would repeat for every pool (the switch off, no
 * image, no account) stops the run.
 *
 * REGISTRY DRIFT. When a job finishes, the sync compares the tuple its record names with the tuple its stamp
 * claimed. A difference holds the CLAIMED tuple (a `tuple_mismatch` stamp, `tupleHeld`): the registry is out
 * of date or the image is, and dispatching again would run the same datasets over and over under a tuple the
 * table does not name. The hold is checked on every path (`dispatchPipelineJob`, the queue, the dry run), so
 * this cron skips the recipe (`registry_drift`) and says so. It does not clear by time. It clears when the
 * registry declares another tuple (a version bump, which is never held) or when its rows are deleted, which
 * deleting the dataset they name does; the next mismatch on any dataset holds the tuple again. What remains
 * exposed are the jobs already in flight when a mismatch first appears: they finish under the same mismatch.
 *
 * COST. The daily tick shares one subrequest allowance with every daily job. The tick syncs the stamps ONCE
 * (each run over the queue is told not to sync again): at most 50 open stamps at 5 to 9 statements and calls
 * each (5 for a stamp whose job is still live: the touch, the job read, and the record reads of a finished
 * one; up to 9 when it also looks a job up by its key, rewrites its tuple and writes a hold), so 250 to
 * 450. One dispatch is about 25 (the dataset and version reads, the claim, the job's batch and records, the
 * submit), and the tick dispatches at most 10, so 250, whatever the owner's daily cap says; the queue and
 * cap reads add about 10. The bound is therefore about 510 in the usual case and 710 at the worst, counting
 * every D1 and R2 binding call as a subrequest although whether they count is UNVERIFIED, against an
 * allowance of 1,000 that the other daily jobs share. The cap is a ceiling and not a rate, and the pilot of
 * twenty datasets takes two days. Raising the bound needs a measurement first.
 *
 * NO MAIL, NO GITHUB. Nothing here imports a mail service or reaches GitHub; the only network is Tapis,
 * through the gateway's own submit.
 */

import { COMPUTE_RECIPES, type ComputeRecipe } from "../../../shared/compute-recipes.js";
import { COMPUTE_PIPELINE_RUN_PER_INVOCATION } from "../../../shared/contract/compute-admin.js";
import type { Bindings } from "../types/bindings.js";
import {
  type PipelineRefusal,
  type SyncResult,
  dispatchEligible,
  pipelineJobsToday,
  pipelineRoom,
  poolOfRecipe,
  syncPipelineStamps,
} from "./compute-pipeline.js";
import { ComputePolicyUnreadable, getPolicy } from "./compute-policy.js";
import { computePipelinesDispatchEnabled } from "./compute-switches.js";
import { isExactProduction } from "./repull-switches.js";

/**
 * The most jobs one daily tick dispatches, whatever the owner's daily cap says: see COST above. It IS the
 * per-invocation bound of `dispatchEligible` (declared once in the contract), never a second number: a
 * tick bound raised alone would be clamped per recipe by `dispatchEligible` without the tick saying why.
 */
export const CRON_DISPATCH_PER_TICK = COMPUTE_PIPELINE_RUN_PER_INVOCATION;

/** The refusals that would repeat for every recipe and every pool: they end the run. */
export const ENDS_THE_RUN: ReadonlySet<PipelineRefusal> = new Set<PipelineRefusal>([
  "compute_disabled",
  "runtime_unavailable",
  "pipelines_account_missing",
  // No Tapis job can be submitted from this Worker, whatever the recipe or the pool.
  "tapis_unconfigured",
  // The tenant ceiling does not depend on the pool or the recipe: no other recipe would be admitted.
  "platform_busy",
]);

export type RecipeSkip =
  | "daily_cap"
  | "live_cap"
  | "tick_cap"
  | "pool_refused"
  | "registry_drift"
  | "run_ended";

export interface RecipeOutcome {
  recipe: string;
  dispatched: number;
  /** Why nothing (or less than the room) was dispatched, as a fixed word. */
  skipped: RecipeSkip | null;
  /** The refusal that stopped this recipe's run, if one did. */
  stopped_by: string | null;
}

export interface PipelineCronResult {
  /** `off`: a switch is off and nothing was read; `ran`: the dispatcher examined its recipes. */
  outcome: "off" | "ran";
  synced: SyncResult | null;
  /** Pipeline jobs made today before this run. */
  today: number;
  dispatched: number;
  recipes: RecipeOutcome[];
  /** Fixed words; never a message. */
  errors: string[];
}

const emptyResult = (outcome: PipelineCronResult["outcome"]): PipelineCronResult => ({
  outcome,
  synced: null,
  today: 0,
  dispatched: 0,
  recipes: [],
  errors: [],
});

/**
 * One daily run. Null outside exact production, before anything is read or written. In production with
 * either switch off it returns `{ outcome: "off" }` and has touched nothing. Otherwise it syncs the
 * stamps and dispatches within the caps. It never throws: a failure is a fixed word in `errors`.
 */
export async function runComputePipelineDispatchCron(
  env: Bindings,
): Promise<PipelineCronResult | null> {
  if (!isExactProduction(env)) return null;
  if (!computePipelinesDispatchEnabled(env)) return emptyResult("off");

  const result = emptyResult("ran");
  const db = env.DB;
  try {
    result.synced = await syncPipelineStamps(env);
    const policy = (await getPolicy(db)).policy;
    // The one scan of the day's count in a tick (`PIPELINE_JOBS_TODAY_SQL` is a full table scan): every
    // recipe's room adds what this tick has dispatched to it, and `dispatchEligible` is handed the room.
    result.today = await pipelineJobsToday(db);
    let tickLeft = CRON_DISPATCH_PER_TICK;
    const refusedPools = new Set<string>();
    let ended = false;

    for (const recipe of COMPUTE_RECIPES) {
      if (!recipe.autoDispatch) continue;
      const outcome: RecipeOutcome = {
        recipe: recipe.name,
        dispatched: 0,
        skipped: null,
        stopped_by: null,
      };
      result.recipes.push(outcome);
      const pool = poolOfRecipe(recipe);
      if (ended) {
        outcome.skipped = "run_ended";
        continue;
      }
      if (refusedPools.has(pool)) {
        outcome.skipped = "pool_refused";
        continue;
      }
      // The one reading of both caps (`pipelineRoom`), shared with an administrator's run: what an
      // administrator made today and what is live now count here as they count there.
      const caps = await pipelineRoom(db, policy, pool, result.today + result.dispatched);
      const { daily_left: dailyLeft, live_left: liveLeft } = caps;
      if (dailyLeft <= 0) {
        outcome.skipped = "daily_cap";
        continue;
      }
      if (liveLeft <= 0) {
        outcome.skipped = "live_cap";
        continue;
      }
      if (tickLeft <= 0) {
        outcome.skipped = "tick_cap";
        continue;
      }
      const room = Math.min(dailyLeft, liveLeft, tickLeft);
      // The bound of this file's own is what limits the run, and it was used up: more may be waiting.
      const cutByTick = tickLeft < dailyLeft && tickLeft < liveLeft;

      const run = await dispatchEligible(env, {
        recipe: recipe.name,
        limit: room,
        actor: { kind: "cron" },
        sync: false,
        room: caps,
      });
      outcome.dispatched = run.dispatched;
      outcome.stopped_by = run.stoppedBy;
      result.dispatched += run.dispatched;
      tickLeft -= run.dispatched;
      if (cutByTick && run.dispatched >= room && run.stoppedBy === null) {
        outcome.skipped = "tick_cap";
      }
      if (run.stoppedBy === "registry_drift") {
        outcome.skipped = "registry_drift";
      } else if (run.stoppedBy === "run_failed") {
        result.errors.push("run_failed");
        ended = true;
      } else if (run.stoppedBy !== null) {
        if (ENDS_THE_RUN.has(run.stoppedBy)) ended = true;
        else refusedPools.add(pool);
      }
    }
  } catch (err) {
    result.errors.push(err instanceof ComputePolicyUnreadable ? "policy_unreadable" : "run_failed");
    console.error(
      `[compute-pipeline-dispatch] failed dispatched=${result.dispatched} error=${err instanceof Error ? err.name : typeof err}`,
    );
  }
  return result;
}

/**
 * The one log line of a run, or null when it did nothing worth a line (off, or ran and dispatched,
 * skipped and failed nothing). Counts and fixed words: no dataset id, job id, name or path.
 */
export function pipelineDispatchLogLine(
  r: PipelineCronResult,
): { level: "info" | "warn" | "error"; line: string } | null {
  if (r.outcome === "off") return null;
  const skipped = r.recipes.filter((x) => x.skipped !== null || x.stopped_by !== null);
  const syncTrouble = r.synced !== null && (r.synced.later > 0 || r.synced.errored > 0);
  if (r.dispatched === 0 && r.errors.length === 0 && skipped.length === 0 && !syncTrouble) {
    return null;
  }
  const parts = [
    `dispatched=${r.dispatched}`,
    `today=${r.today}`,
    ...(r.synced
      ? [
          `synced_succeeded=${r.synced.succeeded}`,
          `synced_failed=${r.synced.failed}`,
          // Only when there is something to say, so a clean run's line is unchanged.
          ...(r.synced.later > 0 ? [`synced_later=${r.synced.later}`] : []),
          ...(r.synced.errored > 0 ? [`synced_errored=${r.synced.errored}`] : []),
        ]
      : []),
    ...r.recipes.flatMap((x) => [
      ...(x.skipped ? [`${x.recipe}_skipped=${x.skipped}`] : []),
      ...(x.stopped_by ? [`${x.recipe}_stopped_by=${x.stopped_by}`] : []),
    ]),
    ...(r.errors.length > 0 ? [`errors=${r.errors.join(",")}`] : []),
  ];
  const drift = r.recipes.some((x) => x.skipped === "registry_drift");
  // A sync that threw is as loud as any other error; one that could not decide yet is a warning.
  const level =
    r.errors.length > 0 || (r.synced?.errored ?? 0) > 0
      ? "error"
      : drift || syncTrouble || r.recipes.some((x) => x.stopped_by)
        ? "warn"
        : "info";
  return { level, line: `[compute-pipeline-dispatch] ${parts.join(" ")}` };
}
