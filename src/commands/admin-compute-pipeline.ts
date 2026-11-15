/**
 * `nemar admin compute pipeline`: an administrator runs NEMAR's own processing recipes through the compute
 * gateway and reads the stamps they leave (epic #2005 phase A6, #2011; ADR 0118; design section 10).
 *
 *   nemar admin compute pipeline run <recipe> --dataset <id>[@version] [--executor tapis|runner] [--input bids|zarr] [--dry-run]
 *   nemar admin compute pipeline run <recipe> --eligible [--limit <n>] [--dry-run]
 *   nemar admin compute pipeline status [--recipe <name>] [--dataset <id>] [--state <state>] [--limit <n>]
 *
 * A run names a recipe and then ONE dataset (with an optional version) or the queue of eligible datasets
 * with a limit. Every run, whoever asks, is bounded by the owner's live and daily caps and by
 * `COMPUTE_PIPELINE_RUN_PER_INVOCATION` per invocation (issue #2121); the answer's `room` says which
 * one it was. It names nothing else: the dataset row (and with it eligibility), the version row, the
 * service account, the pool and the runtime image are the Worker's. `--dry-run` reads only and works against
 * every Worker, including a development one with compute off. A live run is refused by the Worker unless
 * compute is switched on. Every command takes `--json` (standard output stays pure JSON) and exits 1 on any
 * failure; a refused dataset exits 1 with the Worker's word.
 */

import { Command } from "commander";
import { RECIPE_INPUTS } from "../../shared/compute-recipes.js";
import {
  COMPUTE_PIPELINE_RUN_LIMIT_DEFAULT,
  COMPUTE_PIPELINE_RUN_LIMIT_MAX,
  COMPUTE_PIPELINE_RUN_PER_INVOCATION,
  COMPUTE_PIPELINE_STAMP_STATES,
  COMPUTE_PIPELINE_STATUS_PAGE_MAX,
  type ComputePipelineResult,
  type ComputePipelineRoom,
  type ComputePipelineRunRequest,
  type ComputePipelineRunResponse,
  type ComputePipelineStampView,
} from "../../shared/contract/compute-admin.js";
import {
  COMPUTE_DATASET_ID_RE,
  COMPUTE_DATASET_VERSION_RE,
  formatSu,
} from "../../shared/contract/compute.js";
import { failMessage, failWith, requireSignedIn } from "../lib/admin-command.js";
import {
  computeRefusalCode,
  getComputePipelineStatus,
  runComputePipeline,
} from "../lib/api/compute.js";
import { plain } from "../lib/terminal-text.js";

const say = (line: string): void => console.log(line);

const RECIPE_RE = /^[a-z][a-z0-9-]{0,63}$/;

/** A fixed word, made plain before it reaches a terminal. */
const word = (value: string): string => plain(value);

/** One dataset's outcome on a line. */
function resultLine(r: ComputePipelineResult): string {
  if (r.ok) {
    const line =
      `  ${word(r.dataset_id)} ${word(r.version ?? "")}: dispatched` +
      ` (attempt ${r.attempt ?? "?"}, job ${word(r.job_id ?? "?")}, submit ${word(r.submit ?? "?")})`;
    return r.records_written === false
      ? `${line}; its records were NOT written: the job waits until they are (records_not_written)`
      : line;
  }
  const blocked =
    r.blocked_by && r.blocked_by.length > 0 ? ` [${r.blocked_by.map(word).join(", ")}]` : "";
  return `  ${word(r.dataset_id)}${r.version ? ` ${word(r.version)}` : ""}: refused, ${word(r.code ?? "?")}${blocked}`;
}

/** What a run had room for, and what bounded it, in words a person reads (the fixed words are the Worker's). */
const LIMITED_BY_TEXT: Record<string, string> = {
  limit: "the limit asked for",
  per_invocation: `the bound of ${COMPUTE_PIPELINE_RUN_PER_INVOCATION} per invocation, run it again for more`,
  daily_cap: "the daily cap",
  live_cap: "the live cap of the pool",
  tenant: "the tenant ceiling (NEMAR's share of the cluster)",
};

function roomLine(room: ComputePipelineRoom, when: string): string {
  const by = LIMITED_BY_TEXT[room.limited_by] ?? word(room.limited_by);
  return `  room ${when}: ${room.daily_left} left of the daily cap, ${room.live_left} left of the live cap${
    room.tenant_left === undefined ? "" : `, ${room.tenant_left} left under the tenant ceiling`
  }; bounded by ${by}`;
}

/** The runners' room: a runner job has no daily cap and no tenant slot, only the runners' live cap. */
function runnerRoomLine(room: { live_left: number; live_cap: number }, when: string): string {
  return `  runner room ${when}: ${room.live_left} left of the runners' live cap of ${room.live_cap}`;
}

function printRun(res: ComputePipelineRunResponse): void {
  const runner = res.executor === "runner";
  if (res.dry_run) {
    say(`dry run of ${word(res.recipe)}${runner ? " on a runner" : ""}: nothing was written`);
    if (runner) {
      say("  executor: runner (no hold, no service units; a runner pulls the job)");
    } else if (res.estimate_milli_per_job !== undefined) {
      say(
        `  estimated hold per job: ${formatSu(res.estimate_milli_per_job)} SU, ` +
          `in total ${formatSu(res.estimate_milli_total ?? 0)} SU`,
      );
    }
    if (res.config) {
      const c = res.config;
      const needs = [
        `compute ${c.compute_enabled ? "on" : "OFF"}`,
        `runtime image ${c.runtime_image ? "set" : "NOT SET"}`,
        `pipelines account ${c.pipelines_account ? "present" : "MISSING"}`,
      ];
      if (runner) needs.push(`runners ${c.runners_enabled ? "on" : "OFF"}`);
      else if (c.tapis_configured !== undefined) {
        needs.push(c.tapis_configured ? "Tapis configured" : "Tapis NOT CONFIGURED");
      }
      say(`  a real run needs: ${needs.join(", ")}`);
    }
    if (res.room) say(roomLine(res.room, "now"));
    if (res.runner_room) say(runnerRoomLine(res.runner_room, "now"));
    const would = res.would_dispatch ?? [];
    say(`  would dispatch ${would.length}:`);
    for (const d of would) say(`    ${word(d.dataset_id)} ${word(d.version)}`);
    if (res.blocked) {
      const terms =
        res.blocked.blocked_by.length > 0
          ? ` [${res.blocked.blocked_by.map(word).join(", ")}]`
          : "";
      const reason = res.blocked.reason ? `, reason ${word(res.blocked.reason)}` : "";
      say(`  blocked: ${word(res.blocked.code)}${terms}${reason}`);
    }
    if (res.blocked_by_term) {
      const rows = Object.entries(res.blocked_by_term).filter(([, n]) => Number(n) > 0);
      say(
        `  datasets failing each term: ${rows.length === 0 ? "none" : rows.map(([t, n]) => `${word(t)} ${Number(n)}`).join(", ")}`,
      );
    }
    return;
  }
  const results = res.results ?? [];
  say(
    `${word(res.recipe)}${runner ? " (runner)" : ""}: dispatched ${res.dispatched ?? 0} of ${results.length} tried`,
  );
  for (const r of results) say(resultLine(r));
  if (res.stopped_by) say(`  stopped by ${word(res.stopped_by)}`);
  if (res.room) say(roomLine(res.room, "before the run"));
}

function stampLine(s: ComputePipelineStampView): string {
  const tail = s.refusal_code ? ` ${word(s.refusal_code)}` : "";
  const job = s.job_id ? ` job ${word(s.job_id)}` : "";
  return (
    `${String(s.id).padStart(5)}  ${word(s.dataset_id)} ${word(s.version).padEnd(8)} ` +
    `${word(s.recipe)} ${word(s.recipe_version)} ${word(s.engine)} ${word(s.input ?? "bids")} ` +
    `attempt ${s.attempt}  ${word(s.state)}${tail}${job}`
  );
}

/** `nm000104` or `nm000104@1.0.2`: the dataset and the version, or null after saying why (exit 1). */
function parseDatasetArg(raw: string, json: boolean): { dataset: string; version?: string } | null {
  const [dataset, version, ...rest] = raw.split("@");
  if (
    !dataset ||
    !COMPUTE_DATASET_ID_RE.test(dataset) ||
    rest.length > 0 ||
    (version !== undefined && !COMPUTE_DATASET_VERSION_RE.test(version))
  ) {
    failMessage(`"${raw}" is not a dataset (like nm000104, or nm000104@1.0.2).`, {
      json,
      answered: true,
    });
    return null;
  }
  return version === undefined ? { dataset } : { dataset, version };
}

/** A whole number option within bounds, or null after saying why (exit 1). */
function wholeNumber(
  raw: string,
  name: string,
  min: number,
  max: number,
  json: boolean,
): number | null {
  if (/^[0-9]{1,9}$/.test(raw)) {
    const value = Number(raw);
    if (value >= min && value <= max) return value;
  }
  failMessage(`${name} is a whole number from ${min} to ${max}.`, { json, answered: true });
  return null;
}

const RUN_HELP = `
Runs a processing recipe on NEMAR's own datasets through the compute gateway, or says what that would do.

  <recipe>                  a recipe of the Worker's registry, such as nemar-floor
  --dataset <id>[@version]  one dataset; the newest version when none is given
  --eligible [--limit <n>]  the next <n> eligible datasets the recipe has not been run over (default
                            ${COMPUTE_PIPELINE_RUN_LIMIT_DEFAULT}, at most ${COMPUTE_PIPELINE_RUN_LIMIT_MAX}); a run is also
                            bounded by the live cap of the pool, the daily cap and at most
                            ${COMPUTE_PIPELINE_RUN_PER_INVOCATION} per invocation, and says which one bounded it
  --executor <who>          tapis (the default) or runner. A recipe lists the executors it may be run
                            on (nemar-floor on both) and the Worker refuses another with invalid_body
                            naming executor. A runner run names one dataset
                            (not --eligible), needs the runners switch (runners_disabled when it is off),
                            makes a job with no hold and no service units that a registered runner pulls,
                            and is bounded only by the owner's live cap for runners (over_concurrency),
                            never by the daily cap or the tenant ceiling
  --input <kind>            what the run reads: bids (the dataset's files, on tapis) or zarr (its Zarr
                            serving copy, on a runner). When none is given it is the executor's own, so
                            the run on a runner reads zarr. A recipe lists the inputs it reads, and an
                            input it does not list, or one the executor does not run (bids on a runner,
                            zarr on tapis), is refused as invalid_spec naming input, before anything is
                            written. A dataset's bids run and its zarr run are separate runs of the same
                            version and do not block each other
  --dry-run                 read only: the datasets it would run, the estimated SU (none for a runner),
                            the room (for a runner, the runners' live cap), what a real run lacks, and what
                            blocks the rest; works against every Worker

The caps are the owner's, for every path: a run that finds the pool full or the day's cap used stops
with over_concurrency or daily_cap_reached and dispatches nothing. One named dataset is refused as
over_concurrency when the pool is full; it counts toward the daily cap and is not refused by it.
NEMAR's share of the cluster has a ceiling too: a job that would pass it, or take slots kept for
people or partners, is refused as platform_busy, which stops a run (try again shortly). A run is
clamped to the room under it (the room line says how many are left and, when it is the smallest,
that the tenant ceiling bounded the run), and a dry run of one named dataset reports it as blocked.

Only a public, non-anonymous, first-published, non-withdrawn dataset with EEG data and at least one
version is eligible; the Worker decides that from its own record, never from this command. A dataset
that has a run in flight or finished for the same recipe version and engine is refused as
live_attempt_exists. A live run is refused as compute_disabled unless compute is switched on.

Admin or owner. --json prints the Worker's answer as it is.

Exit codes:
  0  the run was made, or the dry run answered (a queue run that dispatched nothing is still 0).
  1  the arguments are wrong, the dataset was refused, or the Worker refused or could not be reached.`;

const STATUS_HELP = `
Lists the stamps NEMAR's pipelines leave, newest first: one per dataset version, recipe, recipe version and
engine, with the attempt, the state (dispatched, succeeded, failed, refused), the job, and a fixed word for
a failure or a refusal. The Worker brings the open stamps up to date with their jobs before it answers.

Admin or owner. --json prints the Worker's answer as it is.

Exit codes:
  0  the page was printed.
  1  an option is wrong, or the Worker refused or could not be reached.`;

export const pipelineCommand = new Command("pipeline").description(
  "Run NEMAR's own processing recipes and read their stamps (admin)",
);

pipelineCommand
  .command("run <recipe>")
  .description("Run a recipe over one dataset or the eligible ones, or dry-run it")
  .option("--dataset <id>", "One dataset, nm000104 or nm000104@1.0.2")
  .option("--executor <who>", "Who runs the job: tapis (default) or runner")
  .option("--input <kind>", "What the run reads: bids (on tapis) or zarr (on a runner)")
  .option("--eligible", "The next eligible datasets the recipe has not been run over")
  .option("--limit <n>", "With --eligible: how many datasets at most")
  .option("--dry-run", "Say what would happen; write nothing")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", RUN_HELP)
  .action(
    async (
      recipe: string,
      o: {
        dataset?: string;
        executor?: string;
        input?: string;
        eligible?: boolean;
        limit?: string;
        dryRun?: boolean;
        json?: boolean;
      },
    ) => {
      const json = o.json === true;
      if (!requireSignedIn(json)) return;
      if (!RECIPE_RE.test(recipe)) {
        failMessage(`"${recipe}" is not a recipe name.`, { json, answered: true });
        return;
      }
      if ((o.dataset !== undefined) === (o.eligible === true)) {
        failMessage(
          "Name one dataset with --dataset, or ask for --eligible; not both and not neither.",
          {
            json,
            answered: true,
          },
        );
        return;
      }
      const request: ComputePipelineRunRequest = { recipe };
      if (o.executor !== undefined) {
        if (o.executor !== "tapis" && o.executor !== "runner") {
          failMessage("--executor is tapis or runner.", { json, answered: true });
          return;
        }
        if (o.executor === "runner" && o.dataset === undefined) {
          failMessage("A runner run names one dataset with --dataset, not --eligible.", {
            json,
            answered: true,
          });
          return;
        }
        request.executor = o.executor;
      }
      if (o.input !== undefined) {
        if (o.input !== "bids" && o.input !== "zarr") {
          failMessage(`--input is ${RECIPE_INPUTS.join(" or ")}.`, { json, answered: true });
          return;
        }
        request.input = o.input;
      }
      if (o.dataset !== undefined) {
        if (o.limit !== undefined) {
          failMessage("--limit goes with --eligible.", { json, answered: true });
          return;
        }
        const parsed = parseDatasetArg(o.dataset, json);
        if (parsed === null) return;
        request.dataset = parsed.dataset;
        if (parsed.version !== undefined) request.version = parsed.version;
      } else {
        request.eligible = true;
        if (o.limit !== undefined) {
          const limit = wholeNumber(o.limit, "--limit", 1, COMPUTE_PIPELINE_RUN_LIMIT_MAX, json);
          if (limit === null) return;
          request.limit = limit;
        }
      }
      if (o.dryRun === true) request.dry_run = true;
      try {
        const res = await runComputePipeline(request);
        if (json) console.log(JSON.stringify(res, null, 2));
        else printRun(res);
      } catch (err) {
        const refusal = computeRefusalCode(err);
        if (refusal && err instanceof Error) {
          const terms =
            refusal.blockedBy.length > 0
              ? `, blocked by ${refusal.blockedBy.map(word).join(", ")}`
              : "";
          const reason = refusal.reason ? `, reason ${word(refusal.reason)}` : "";
          failMessage(`${err.message} (${word(refusal.code)}${terms}${reason})`, {
            json,
            answered: true,
          });
          return;
        }
        failWith(err, null, "Could not run the pipeline.", undefined, { json });
      }
    },
  );

pipelineCommand
  .command("status")
  .description("List the stamps of the pipeline runs")
  .option("--recipe <name>", "Only this recipe")
  .option("--dataset <id>", "Only this dataset")
  .option("--state <state>", `Only this state (${COMPUTE_PIPELINE_STAMP_STATES.join(", ")})`)
  .option(
    "--limit <n>",
    `How many stamps (default 50, at most ${COMPUTE_PIPELINE_STATUS_PAGE_MAX})`,
  )
  .option("--before <id>", "Continue after the page that ended at this stamp id")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", STATUS_HELP)
  .action(
    async (o: {
      recipe?: string;
      dataset?: string;
      state?: string;
      limit?: string;
      before?: string;
      json?: boolean;
    }) => {
      const json = o.json === true;
      if (!requireSignedIn(json)) return;
      if (o.recipe !== undefined && !RECIPE_RE.test(o.recipe)) {
        failMessage(`"${o.recipe}" is not a recipe name.`, { json, answered: true });
        return;
      }
      if (o.dataset !== undefined && !COMPUTE_DATASET_ID_RE.test(o.dataset)) {
        failMessage(`"${o.dataset}" is not a dataset id (like nm000104).`, {
          json,
          answered: true,
        });
        return;
      }
      if (
        o.state !== undefined &&
        !(COMPUTE_PIPELINE_STAMP_STATES as readonly string[]).includes(o.state)
      ) {
        failMessage(`--state is one of ${COMPUTE_PIPELINE_STAMP_STATES.join(", ")}.`, {
          json,
          answered: true,
        });
        return;
      }
      let limit: number | undefined;
      if (o.limit !== undefined) {
        const n = wholeNumber(o.limit, "--limit", 1, COMPUTE_PIPELINE_STATUS_PAGE_MAX, json);
        if (n === null) return;
        limit = n;
      }
      let before: number | undefined;
      if (o.before !== undefined) {
        const n = wholeNumber(o.before, "--before", 1, Number.MAX_SAFE_INTEGER, json);
        if (n === null) return;
        before = n;
      }
      try {
        const res = await getComputePipelineStatus({
          recipe: o.recipe,
          dataset: o.dataset,
          state: o.state,
          limit,
          before,
        });
        if (json) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        if (res.stamps.length === 0) say("no stamps");
        for (const s of res.stamps) say(stampLine(s));
        if (res.next_before !== null) say(`more: --before ${res.next_before}`);
      } catch (err) {
        failWith(err, null, "Could not read the pipeline stamps.", undefined, { json });
      }
    },
  );
