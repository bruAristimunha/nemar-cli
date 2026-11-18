/**
 * An administrator's commands on NEMAR's own pipelines (epic #2005 phase A6, #2011; ADR 0118):
 *
 *   POST /admin/compute/pipeline/run      run a recipe over one dataset version, or over the next datasets
 *                                         it has not been run over; `dry_run` says what it would do
 *   GET  /admin/compute/pipeline/status   the stamps, filtered, newest first, after they were synced
 *
 * A run over the eligible datasets is bounded, for every actor, by its `limit`, the per-invocation bound
 * (`COMPUTE_PIPELINE_RUN_PER_INVOCATION`), what is left of `pipelines.dailyJobCap` and what is left of the
 * live cap of the recipe's pool (`dispatchEligible`); the answer's `room` says what was left and which of
 * them bounded the run. One named dataset is bounded by the live cap (the hold refuses it as
 * `over_concurrency`) and only counted by the daily cap (issue #2121). A dry run reports the same room and
 * trims what it would dispatch to it.
 *
 * The request names a recipe, then ONE dataset (with an optional version) or `eligible` with a `limit`,
 * `dry_run`, and optionally the `executor` (`tapis`, the default, or `runner`, ADR 0121) and the `input`
 * (`bids` or `zarr`, plan D12; the executor's own when absent: `bids` on Tapis, `zarr` on a runner). A recipe
 * lists the executors it may be dispatched to and one it does not list is `invalid_body` naming `executor`;
 * so is a runner run over `eligible`; a live runner run is refused `runners_disabled` unless the runners
 * switch is on. An input the recipe does not list, or one the executor does not run (`bids` on a runner,
 * `zarr` on Tapis), is `invalid_spec` naming `input`, before anything is read or written.
 * A runner run makes a job with no hold that waits for a runner and is never submitted. It names nothing else: the dataset row (and with it eligibility, ADR 0065), the version
 * row, the service account, the pool and the runtime image are the Worker's own. A request with any other
 * key is refused, so a field a caller believes it can set is never silently dropped.
 *
 * A dry run reads only and works in every environment; it writes nothing, not even an audit row. A live
 * run refuses `compute_disabled` unless compute is on, and a live Tapis run refuses `tapis_unconfigured` while
 * the Worker has no usable Tapis configuration; both are answered before anything is written. A run that goes
 * ahead is audited as `compute.pipeline.run` with counts and fixed words (never a path, a name or a value).
 * The stamps are synced before every run and every status read. Every refusal is `{ error: <sentence>, code: <word> }`; an invalid body names the
 * fields and never echoes a value. The routes sit behind the admin router's middleware (authentication,
 * the admin role, the cookie-origin guard). Nothing here touches GitHub or sends mail.
 */

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import {
  RECIPE_INPUTS,
  defaultInput,
  findRecipe,
  recipeRunsInput,
  recipeRunsOn,
} from "../../../../shared/compute-recipes.js";
import { COMPUTE_ROUTE_SENTENCES } from "../../../../shared/compute-state.js";
import {
  COMPUTE_ADMIN_ERROR_STATUS,
  COMPUTE_PIPELINE_REFUSAL_STATUS,
  COMPUTE_PIPELINE_RUN_LIMIT_DEFAULT,
  COMPUTE_PIPELINE_RUN_LIMIT_MAX,
  COMPUTE_PIPELINE_STAMP_STATES,
  COMPUTE_PIPELINE_STATUS_PAGE_MAX,
  type ComputePipelineRefusal,
  type ComputePipelineResult,
  type ComputePipelineStampView,
} from "../../../../shared/contract/compute-admin.js";
import {
  COMPUTE_DATASET_ID_RE,
  COMPUTE_DATASET_VERSION_RE,
} from "../../../../shared/contract/compute.js";
import { AUDIT_LOG_INSERT_SQL } from "../../db/audit-log.js";
import { tapisSubmitConfigured } from "../../services/compute-lifecycle.js";
import {
  type DispatchResult,
  type PipelineRefusal,
  type StampRow,
  dispatchEligible,
  dispatchPipelineJob,
  listPipelineStamps,
  pipelineDryRun,
  syncPipelineStamps,
} from "../../services/compute-pipeline.js";
import { fieldPath } from "../../services/compute-policy.js";
import { computeEnabled } from "../../services/compute-switches.js";
import type { Bindings, Variables } from "../../types/bindings.js";
import type { AdminRouter } from "./shared.js";

type Ctx = Context<{ Bindings: Bindings; Variables: Variables }>;

/** The audit action of a live run. */
export const PIPELINE_RUN_AUDIT_ACTION = "compute.pipeline.run";

/** One sentence per word, and a word without one does not compile. */
const SENTENCES = {
  recipe_unknown: "There is no such recipe.",
  recipe_not_automatic: "That recipe is not run automatically.",
  recipe_placeholder: "That recipe is a placeholder and cannot be run.",
  runners_disabled: "Runners are not switched on.",
  tapis_unconfigured:
    "Tapis is not configured on this Worker, so a Tapis job cannot be submitted; nothing was written.",
  registry_drift:
    "A finished run reported another recipe version, engine or input than the registry names, so the recipe is held for that input.",
  dataset_not_eligible: "That dataset is not eligible for processing.",
  version_not_found: "That dataset has no such version.",
  version_untagged: "That version has no name the data plane serves.",
  too_many_files: "That version has more files than a job can stage.",
  zarr_version_not_newest:
    "That recipe reads the dataset's one Zarr copy, which describes only the newest version.",
  zarr_copy_not_ready: "That dataset has no ready Zarr copy to read.",
  zarr_source_mismatch:
    "That dataset's Zarr copy could not be shown to be the tagged version's data; the reason says what was not shown.",
  zarr_source_unverifiable:
    "The Zarr copy or the tagged version could not be read, so nothing was checked; try again shortly.",
  runtime_unavailable: "NEMAR's runtime image is not configured.",
  pipelines_account_missing: "The pipelines account is not set up.",
  compute_disabled: COMPUTE_ROUTE_SENTENCES.compute_disabled,
  live_attempt_exists: "That recipe is already running or finished on that dataset version.",
  insufficient_balance: "The pipelines pool cannot cover the job.",
  platform_budget_exhausted: "The platform budget is exhausted.",
  suspended: "The pipelines pool is suspended.",
  over_concurrency: "NEMAR's pipelines already have as many live jobs as the owner allows.",
  platform_busy: "NEMAR's share of the cluster is full right now; try again shortly.",
  daily_cap_reached: "NEMAR's pipelines have already made as many jobs today as the owner allows.",
  invalid_spec: "The job could not be built from the recipe.",
  create_failed: "The job could not be created.",
  run_failed: "The run stopped on an unexpected error.",
  // Words a run does not produce today, but that its type admits (the ledger's own, and the
  // create-job refusals): said plainly so a new producer needs no second edit to be answered.
  partition_not_offered: "That partition is not offered.",
  over_job_limit: "The job is over a limit.",
  bundle_too_large: "The bundle is too large.",
} as const satisfies { [K in PipelineRefusal]?: string };

/** The words the route can answer with: those with a sentence, and every one of them is a refusal word. */
type SentencedRefusal = keyof typeof SENTENCES;
type MissingSentence = Exclude<PipelineRefusal, SentencedRefusal>;
// A word the run can produce that has no sentence is a compile error here: `never` is the only value.
const noMissingSentence: [MissingSentence] extends [never] ? true : MissingSentence = true;
void noMissingSentence;
// Every word the service can refuse with has a status in the contract (the contract may hold more: the
// ledger's whole vocabulary). A word added to `PipelineRefusal` without one is a compile error here.
const everyWordHasAStatus: [Exclude<PipelineRefusal, ComputePipelineRefusal>] extends [never]
  ? true
  : Exclude<PipelineRefusal, ComputePipelineRefusal> = true;
void everyWordHasAStatus;

const refuse = (c: Ctx, code: SentencedRefusal, extra: object = {}) =>
  c.json(
    { error: SENTENCES[code], code, ...extra },
    COMPUTE_PIPELINE_REFUSAL_STATUS[code] as ContentfulStatusCode,
  );

/**
 * An input the recipe does not read, or one the executor does not run, in `invalid_spec`'s own status and
 * word, naming the `input` field: the sentence says what is allowed, and nothing a caller sent is echoed.
 */
const refuseInput = (c: Ctx) =>
  c.json(
    {
      error:
        "That recipe does not run on that input with that executor: bids runs on Tapis and zarr runs on a runner.",
      code: "invalid_spec",
      field: "input",
    },
    COMPUTE_PIPELINE_REFUSAL_STATUS.invalid_spec as ContentfulStatusCode,
  );

/** A 400 that names the fields and what is wrong with each, never what was sent. */
function invalid(c: Ctx, kind: "invalid_body" | "invalid_query", error: z.ZodError) {
  const named = error.issues
    .slice(0, 5)
    .map((i) => `${fieldPath(i.path) || (kind === "invalid_body" ? "body" : "query")}: ${i.code}`);
  return c.json(
    {
      error: `The ${kind === "invalid_body" ? "request body" : "query"} is not valid: ${named.join("; ")}`,
      code: kind,
    },
    COMPUTE_ADMIN_ERROR_STATUS[kind],
  );
}

/** A validation error that names the `executor` field, in the words `invalid` answers every bad body with. */
const executorIssue = (message: string) =>
  new z.ZodError([{ code: z.ZodIssueCode.custom, path: ["executor"], message }]);

const RECIPE_NAME = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

const runBody = z
  .object({
    recipe: RECIPE_NAME,
    executor: z.enum(["tapis", "runner"]).optional(),
    input: z.enum(RECIPE_INPUTS).optional(),
    dataset: z.string().regex(COMPUTE_DATASET_ID_RE).optional(),
    version: z.string().regex(COMPUTE_DATASET_VERSION_RE).optional(),
    eligible: z.boolean().optional(),
    limit: z.number().int().min(1).max(COMPUTE_PIPELINE_RUN_LIMIT_MAX).optional(),
    dry_run: z.boolean().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const one = body.dataset !== undefined;
    const queue = body.eligible === true;
    if (one === queue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dataset"],
        message: "name one dataset or ask for the eligible ones, not both and not neither",
      });
    }
    if (body.version !== undefined && !one) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["version"],
        message: "a version belongs to a named dataset",
      });
    }
    if (body.limit !== undefined && !queue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["limit"],
        message: "a limit belongs to the eligible datasets",
      });
    }
  });

const statusQuery = z.object({
  recipe: RECIPE_NAME.optional(),
  dataset: z.string().regex(COMPUTE_DATASET_ID_RE).optional(),
  state: z.enum(COMPUTE_PIPELINE_STAMP_STATES).optional(),
  before: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.coerce.number().int().min(1).max(COMPUTE_PIPELINE_STATUS_PAGE_MAX).default(50),
});

async function readJson(c: Ctx): Promise<unknown | null> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/** One dispatch's outcome as the wire shows it: fixed words, ids and numbers. */
function resultView(r: DispatchResult): ComputePipelineResult {
  if (r.ok) {
    return {
      dataset_id: r.datasetId,
      ok: true,
      version: r.version,
      job_id: r.jobId,
      stamp_id: r.stampId,
      attempt: r.attempt,
      submit: r.submit,
      ...(r.recordsWritten === undefined ? {} : { records_written: r.recordsWritten }),
    };
  }
  return {
    dataset_id: r.datasetId,
    ok: false,
    code: r.code,
    ...(r.version === undefined ? {} : { version: r.version }),
    ...(r.blockedBy === undefined ? {} : { blocked_by: r.blockedBy }),
    ...(r.reason === undefined ? {} : { reason: r.reason }),
    ...(r.stampId === undefined ? {} : { stamp_id: r.stampId }),
  };
}

/** `updated_at` of a `dispatched` stamp is when the sync last examined it, not when it changed. */
function stampView(row: StampRow): ComputePipelineStampView {
  return {
    id: row.id,
    dataset_id: row.dataset_id,
    version: row.version,
    recipe: row.recipe,
    recipe_version: row.recipe_version,
    engine: row.engine,
    input: row.input,
    attempt: row.attempt,
    state: row.state,
    job_id: row.job_id,
    refusal_code: row.refusal_code,
    reader: row.reader,
    input_engine: row.input_engine,
    input_digest: row.input_digest,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** The audit row of a live run: counts and fixed words only. */
async function audit(
  c: Ctx,
  recipe: string,
  mode: "dataset" | "eligible",
  counts: { dispatched: number; refused: number },
  stoppedBy: string | null,
  executor: "tapis" | "runner",
): Promise<boolean> {
  // The run has happened by now: jobs are made and holds taken. A failed audit write must not turn that
  // into a 500 that hides the job ids, so it is logged and the answer says the audit row is pending.
  try {
    await c.env.DB.prepare(AUDIT_LOG_INSERT_SQL)
      .bind(
        c.get("user").id,
        PIPELINE_RUN_AUDIT_ACTION,
        "compute_pipeline",
        recipe,
        JSON.stringify({ mode, executor, ...counts, stopped_by: stoppedBy }),
      )
      .run();
    return true;
  } catch (err) {
    console.error(
      `[admin/compute-pipeline] audit_pending recipe=${recipe} mode=${mode} dispatched=${counts.dispatched} error=${err instanceof Error ? err.name : "unknown"}`,
    );
    return false;
  }
}

function fail(c: Ctx, err: unknown) {
  console.error(
    "[admin/compute-pipeline] unexpected failure:",
    err instanceof Error ? err.name : typeof err,
  );
  return c.json(
    { error: "The pipeline routes failed unexpectedly.", code: "internal" },
    COMPUTE_ADMIN_ERROR_STATUS.internal,
  );
}

export function registerComputePipelineAdminRoutes(admin: AdminRouter): void {
  admin.post("/compute/pipeline/run", async (c) => {
    const parsed = runBody.safeParse(await readJson(c));
    if (!parsed.success) return invalid(c, "invalid_body", parsed.error);
    const body = parsed.data;
    const recipe = findRecipe(body.recipe);
    if (recipe === null) return refuse(c, "recipe_unknown");
    // The executor is part of the request's validity, decided from the registry before anything is read:
    // a recipe is dispatched only to an executor it lists, and a runner run names ONE dataset (the queue's
    // clamps are Tapis's: the daily cap and the tenant ceiling mean nothing to a runner job). It is asked
    // before the placeholder, as the service asks it, so that a placeholder is answered for its executors too.
    const executor = body.executor ?? "tapis";
    if (!recipeRunsOn(recipe, executor)) {
      return invalid(
        c,
        "invalid_body",
        executorIssue("that recipe is not dispatched to that executor"),
      );
    }
    if (recipe.placeholder === true) return refuse(c, "recipe_placeholder");
    if (executor === "runner" && body.dataset === undefined) {
      return invalid(c, "invalid_body", executorIssue("a runner run names one dataset"));
    }
    // The input, named or the executor's own, is decided from the registry too, before anything is read.
    const input = body.input ?? defaultInput(executor);
    if (!recipeRunsInput(recipe, input, executor)) return refuseInput(c);
    try {
      if (body.dry_run === true) {
        const dry = await pipelineDryRun(c.env, {
          recipe: body.recipe,
          datasetId: body.dataset,
          version: body.version,
          limit: body.limit ?? COMPUTE_PIPELINE_RUN_LIMIT_DEFAULT,
          executor,
          input,
        });
        if (!dry.ok) return refuse(c, dry.code);
        return c.json({ ...dry, ok: true, dry_run: true });
      }
      if (!computeEnabled(c.env)) return refuse(c, "compute_disabled");
      // A Tapis run on a Worker that cannot submit to Tapis is refused here, as `compute_disabled` is, before
      // the stamp sync, the dispatch and the audit row; `dispatchPipelineJob` holds the same line for every
      // other caller. A runner run never asks, and a dry run is answered above.
      if (executor === "tapis" && !tapisSubmitConfigured(c.env)) {
        return refuse(c, "tapis_unconfigured");
      }
      const actor = { kind: "admin", userId: c.get("user").id } as const;

      if (body.dataset !== undefined) {
        await syncPipelineStamps(c.env);
        const result = await dispatchPipelineJob(c.env, {
          recipe: body.recipe,
          datasetId: body.dataset,
          version: body.version,
          actor,
          executor,
          input,
        });
        const audited = await audit(
          c,
          body.recipe,
          "dataset",
          { dispatched: result.ok ? 1 : 0, refused: result.ok ? 0 : 1 },
          result.ok ? null : result.code,
          executor,
        );
        const pending = audited ? {} : { audit_pending: true };
        if (!result.ok) return refuse(c, result.code, { ...resultView(result), ...pending });
        return c.json(
          {
            ok: true,
            dry_run: false,
            recipe: body.recipe,
            executor,
            input,
            results: [resultView(result)],
            dispatched: 1,
            stopped_by: null,
            ...pending,
          },
          201,
        );
      }

      const run = await dispatchEligible(c.env, {
        recipe: body.recipe,
        limit: body.limit ?? COMPUTE_PIPELINE_RUN_LIMIT_DEFAULT,
        actor,
      });
      const audited = await audit(
        c,
        body.recipe,
        "eligible",
        { dispatched: run.dispatched, refused: run.results.length - run.dispatched },
        run.stoppedBy,
        executor,
      );
      return c.json(
        {
          ok: true,
          dry_run: false,
          recipe: body.recipe,
          executor,
          input,
          results: run.results.map(resultView),
          dispatched: run.dispatched,
          stopped_by: run.stoppedBy,
          ...(run.room === null
            ? {}
            : {
                room: {
                  daily_left: run.room.daily_left,
                  live_left: run.room.live_left,
                  tenant_left: run.room.tenant_left,
                  limited_by: run.room.limited_by,
                },
              }),
          ...(audited ? {} : { audit_pending: true }),
        },
        run.dispatched > 0 ? 201 : 200,
      );
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.get("/compute/pipeline/status", async (c) => {
    const query = statusQuery.safeParse(c.req.query());
    if (!query.success) return invalid(c, "invalid_query", query.error);
    try {
      await syncPipelineStamps(c.env);
      const page = await listPipelineStamps(c.env.DB, {
        recipe: query.data.recipe,
        dataset: query.data.dataset,
        state: query.data.state,
        before: query.data.before,
        limit: query.data.limit,
      });
      return c.json({ stamps: page.stamps.map(stampView), next_before: page.nextBefore });
    } catch (err) {
      return fail(c, err);
    }
  });
}
