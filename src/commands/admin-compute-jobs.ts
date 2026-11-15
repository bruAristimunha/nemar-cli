/**
 * `nemar admin compute jobs`: an administrator's commands on compute jobs (epic #2005 phase A5, #2010, and
 * phase A7, #2012; ADR 0118).
 *
 *   nemar admin compute jobs cancel <id>    cancel a job: at Tapis, or here for a job that never started
 *   nemar admin compute jobs advance <id>   one step: submit a `created` job, or read a submitted one
 *                                           back from Tapis, or give a finished one what it is owed
 *   nemar admin compute jobs list           jobs by flag, state, account, executor, accounting and
 *                                           runner; `--unmatched` lists Expanse's rows that no job claims
 *   nemar admin compute jobs record <ref>   one job by NEMAR id, Tapis uuid or Slurm id; with
 *                                           `--identity` or `--spec` and `--reason`, the owner's read
 *   nemar admin compute jobs report         one account's jobs and charge in a date range (`--csv`);
 *                                           runner jobs are shown apart, never in service units
 *   nemar admin compute jobs access-report  a quarter's distinct gateway users and jobs (`--csv`)
 *   nemar admin compute jobs hold|release-hold|holds   legal holds on `job:<id>` or `account:<id>`
 *   nemar admin compute jobs access-reports  ACCESS report rows, `failed` ones by their fixed word
 *   nemar admin compute jobs requeue-access-report <job id> --confirmed-not-recorded   (owner only)
 *
 * `advance` is how a job moves in development, where no compute cron runs. Both call the same code the
 * Worker's webhook, its 30-minute tick and a person's own cancel run. They print the job as the Worker
 * shows it to an administrator: fixed words, numbers and times, the four flags, and `platform failure`,
 * an information flag that says NEMAR caused the failure so that it can be compensated by a manual grant
 * (nothing is refunded automatically). Never an identity, a specification, a token or a log.
 *
 * A job id is `job_` and 24 lowercase hexadecimal digits, checked before anything is sent. Every command
 * takes `--json` (standard output stays pure JSON) and exits 1 on any failure.
 */

import { Command } from "commander";
import {
  COMPUTE_ACCESS_REPORT_STATES,
  COMPUTE_ACCOUNTING,
  COMPUTE_EXECUTORS,
  COMPUTE_HOLD_SCOPES,
  COMPUTE_JOB_FLAGS,
  COMPUTE_STATES,
  COMPUTE_WORD_RE,
} from "../../shared/compute-state.js";
import {
  COMPUTE_PARTIAL_USAGE_NOTE,
  COMPUTE_RECORD_REASON_MAX,
  COMPUTE_RECORD_REASON_MIN,
  COMPUTE_UNKNOWN_PARTIAL_NOTE,
  type ComputeJobAdminResponse,
  type ComputeJobView,
  runnerMarkNotes,
} from "../../shared/contract/compute-admin.js";
import { RUNNER_ID_RE } from "../../shared/contract/compute-runner.js";
import { COMPUTE_JOB_ID_RE } from "../../shared/contract/compute.js";
import { formatSu } from "../../shared/contract/compute.js";
import { failMessage, failWith, requireSignedIn } from "../lib/admin-command.js";
import {
  advanceComputeJobAsAdmin,
  cancelComputeJobAsAdmin,
  getComputeAccessReport,
  getComputeAccountReport,
  getComputeRecord,
  listComputeAccessReports,
  listComputeHolds,
  listComputeJobs,
  listUnmatchedComputeRows,
  mintComputeObserverRun,
  placeComputeHold,
  readComputeRecord,
  releaseComputeHold,
  requeueComputeAccessReport,
} from "../lib/api/compute.js";
import { plain } from "../lib/terminal-text.js";

const say = (line: string): void => console.log(line);

/**
 * The note a runner figure carries. Partial when the runner said so; nothing when it said the usage is whole;
 * and UNKNOWN when there is usage but no mark (the job completed before the mark was stored, or the Worker
 * predates it), because a figure with no mark is never shown as complete. No usage, no note.
 */
function partialNote(partial: unknown, usagePresent: boolean): string {
  if (partial === true) return COMPUTE_PARTIAL_USAGE_NOTE;
  if (partial === false) return "";
  return usagePresent ? COMPUTE_UNKNOWN_PARTIAL_NOTE : "";
}

/** How a job is accounted: a service-unit figure is shown for every job except one accounted `none`. */
const inServiceUnits = (accounting: unknown): boolean => accounting !== "none";

/** A whole number a Worker sent for a runner figure, or `?` when it has not been reported. */
function figure(value: unknown): string {
  return typeof value === "number" ? String(value) : "?";
}

/**
 * A runner job's own figures as one phrase: the runner-reported usage and its partial mark, never service
 * units. `usage` is the account report's `runner_usage`; the list view has the same figures on the job.
 */
function runnerPhrase(
  runnerId: unknown,
  usage: { wall: unknown; cpu: unknown; partial: unknown },
): string {
  const who = typeof runnerId === "string" ? `runner ${plain(runnerId)}` : "runner (unclaimed)";
  if (typeof usage.wall !== "number" && typeof usage.cpu !== "number") {
    return `${who}, no usage reported yet`;
  }
  return `${who}, runner-reported wall ${figure(usage.wall)} s, cpu ${figure(usage.cpu)} s${partialNote(usage.partial, true)}`;
}

/** The job as lines for a terminal; everything the Worker sent is made plain first. */
function printJob(res: ComputeJobAdminResponse): void {
  const job: ComputeJobView | null = res.job;
  say(`outcome: ${plain(res.outcome)}${res.submit ? ` (submit: ${plain(res.submit)})` : ""}`);
  if (job === null) return;
  say(`job ${plain(job.id)}`);
  say(
    `  state: ${plain(job.state)}${job.tapis_status ? ` (Tapis ${plain(job.tapis_status)})` : ""}` +
      `${job.cancel_requested ? "  cancel requested" : ""}`,
  );
  if (job.failure_code) {
    say(
      `  failure: ${plain(job.failure_code)}${job.failure_detail ? ` / ${plain(job.failure_detail)}` : ""}`,
    );
    say(
      `  platform failure: ${job.platform_failure ? "yes (NEMAR caused it; compensate by a manual grant if warranted)" : "no"}`,
    );
  }
  say(`  partition: ${plain(job.partition)} (${plain(job.pool)})`);
  if (job.executor === "runner") {
    // A runner job has no hold and no ledger entry: its usage is the runner's own figure, never SU.
    say(
      `  executor: runner, accounting: ${plain(job.accounting ?? "none")} (no hold, no service units)`,
    );
    say(
      `  runner: ${job.runner_id ? plain(job.runner_id) : "none yet"}` +
        `${job.runner_backend ? ` (${plain(job.runner_backend)})` : ""}` +
        `${job.runner_claimed_at ? `, claimed ${plain(job.runner_claimed_at)}` : ""}`,
    );
    say(
      `  runner-reported: wall ${job.runner_wall_seconds ?? "?"} s, cpu ${job.runner_cpu_seconds ?? "?"} s, ` +
        `max resident ${job.runner_max_rss_mb ?? "?"} MB${partialNote(job.runner_usage_partial, typeof job.runner_wall_seconds === "number")}`,
    );
  } else {
    say(
      `  held ${formatSu(job.held_milli)} SU, charged ${formatSu(job.charged_milli)} SU, ${job.settled ? "settled" : "not settled"}`,
    );
  }
  say(`  flags: ${job.flags.length > 0 ? job.flags.map(plain).join(", ") : "none"}`);
  say(
    `  results: upload ${job.outputs_completed ? "complete" : "not complete"}, ` +
      `${job.results_verified ? "verified" : "not verified"}, ` +
      `files ${job.records_copied ? "copied to the records" : "not copied yet"}`,
  );
  say(`  created ${plain(job.created_at)}${job.ended_at ? `, ended ${plain(job.ended_at)}` : ""}`);
}

/** A job id typed on the command line, or null after saying why (exit 1, nothing sent). */
function jobIdArg(id: string, json: boolean): string | null {
  if (COMPUTE_JOB_ID_RE.test(id)) return id;
  failMessage(`"${id}" is not a job id: it is job_ and 24 lowercase hexadecimal digits.`, {
    json,
    answered: true,
  });
  return null;
}

const CANCEL_HELP = `
Cancels one compute job. A job that never reached Tapis is ended here and its hold released; one that
did is cancelled AT TAPIS and becomes cancelled when Tapis says so, charged what it used. The intent is
recorded first, so a Tapis that cannot be reached now is asked again by the Worker's own sweep. A job
that has already ended, other than cancelled, is refused.

Admin or owner. --json prints the Worker's answer as it is.

Exit codes:
  0  the cancel was recorded (or the job was already cancelled).
  1  the id is not a job id, there is no such job, it has ended, or the Worker refused.`;

const ADVANCE_HELP = `
Takes one compute job one step, wherever it is: a created job is submitted to Tapis (once, whatever a
lost answer did), a submitted one is read back from Tapis and brought to the state Tapis shows, and a
finished one gets what it is still owed (its settlement, the copy of its files). The way a job moves in
development, where no compute cron runs. It does what the webhook and the 30-minute tick do, and no more.

The submit is refused while compute is switched off: a created job stays created (the answer is
"waiting", with submit compute_disabled), and everything else, a read-back, a settlement, a copy, still
happens, because a job that is already on a cluster is never stranded by the switch.

Admin or owner. --json prints the Worker's answer as it is.

Exit codes:
  0  the step was taken (or there was nothing to do); the outcome says which.
  1  the id is not a job id, there is no such job, or the Worker refused.`;

const jobsCommand = new Command("jobs").description(
  "Cancel, advance, list and report on compute jobs; legal holds and ACCESS reports (admin; some owner only)",
);

jobsCommand
  .command("cancel <id>")
  .description("Cancel a compute job")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", CANCEL_HELP)
  .action(async (id: string, o: { json?: boolean }) => {
    const json = o.json === true;
    if (!requireSignedIn(json)) return;
    const jobId = jobIdArg(id, json);
    if (jobId === null) return;
    try {
      const res = await cancelComputeJobAsAdmin(jobId);
      if (json) console.log(JSON.stringify(res, null, 2));
      else printJob(res);
    } catch (err) {
      failWith(err, null, "Could not cancel the job.", undefined, { json });
    }
  });

jobsCommand
  .command("advance <id>")
  .description("Take a compute job one step on")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", ADVANCE_HELP)
  .action(async (id: string, o: { json?: boolean }) => {
    const json = o.json === true;
    if (!requireSignedIn(json)) return;
    const jobId = jobIdArg(id, json);
    if (jobId === null) return;
    try {
      const res = await advanceComputeJobAsAdmin(jobId);
      if (json) console.log(JSON.stringify(res, null, 2));
      else printJob(res);
    } catch (err) {
      failWith(err, null, "Could not advance the job.", undefined, { json });
    }
  });

// --- Reporting, holds and ACCESS reports (phase A7, #2012) ---------------------------------------------------------

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const QUARTER_RE = /^\d{4}Q[1-4]$/;
const ACCOUNT_RE = /^[1-9]\d{0,14}$/;

/** A positive whole number typed on the command line, or null after saying why (exit 1, nothing sent). */
function wholeOption(
  raw: string | undefined,
  name: string,
  json: boolean,
  max = Number.MAX_SAFE_INTEGER,
  min = 1,
): number | undefined | null {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
    failMessage(`${name} is a whole number from ${min} to ${max}.`, { json, answered: true });
    return null;
  }
  return n;
}

/** One CSV field: quoted when it holds a comma, a quote or a line break, and never trusted. */
function csvField(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function printCsv(rows: Array<Array<string | number | null | undefined>>): void {
  for (const row of rows) console.log(row.map(csvField).join(","));
}

/** `--csv` and `--json` are two ways to print the same thing; asking for both is a mistake. */
function formatChoice(o: { csv?: boolean; json?: boolean }): boolean {
  if (o.csv === true && o.json === true) {
    failMessage("Choose --csv or --json, not both.", { json: true, answered: true });
    return false;
  }
  return true;
}

const LIST_HELP = `
Lists compute jobs, newest first, with their state, source, partition, pool, charge and flags. Filters
combine: --flag unreserved|unattributed|mismatch|overrun, --state <state>, --account <id>,
--executor tapis|runner, --accounting su|none, --runner <runner id>. A runner job shows the runner and
its runner-reported usage instead of a charge, marked "(partial: Docker or Podman)" when the runner said
it could not measure all of it. A page is at most 200 jobs; the last line names the --after value that
continues it. --unmatched lists instead the rows of Expanse's own accounting (posted by the observer)
that no job claims. No identity is shown.

Admin or owner. --json prints the Worker's answer as it is.

Exit codes:
  0  listed (an empty page is a success).
  1  an option is not valid, or the Worker refused.`;

jobsCommand
  .command("list")
  .description("List compute jobs by flag, state, account, executor, accounting and runner")
  .option("--flag <name>", `One of ${COMPUTE_JOB_FLAGS.join(", ")}`)
  .option("--state <state>", `One of ${COMPUTE_STATES.join(", ")}`)
  .option("--account <id>", "Only this account's jobs")
  .option("--executor <word>", `Who runs the job: ${COMPUTE_EXECUTORS.join(" or ")}`)
  .option("--accounting <word>", `How it is accounted for: ${COMPUTE_ACCOUNTING.join(" or ")}`)
  .option("--runner <id>", "Only the jobs this runner claimed (rnr_ and 24 hexadecimal digits)")
  .option("--limit <n>", "Jobs per page, 1 to 200", "50")
  .option("--after <n>", "Continue after this page's last row")
  .option("--unmatched", "List Expanse's rows that no job claims")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", LIST_HELP)
  .action(
    async (o: {
      flag?: string;
      state?: string;
      account?: string;
      executor?: string;
      accounting?: string;
      runner?: string;
      limit: string;
      after?: string;
      unmatched?: boolean;
      json?: boolean;
    }) => {
      const json = o.json === true;
      if (!requireSignedIn(json)) return;
      if (o.flag !== undefined && !(COMPUTE_JOB_FLAGS as readonly string[]).includes(o.flag)) {
        failMessage(`--flag is one of ${COMPUTE_JOB_FLAGS.join(", ")}.`, { json, answered: true });
        return;
      }
      if (o.state !== undefined && !(COMPUTE_STATES as readonly string[]).includes(o.state)) {
        failMessage(`--state is one of ${COMPUTE_STATES.join(", ")}.`, { json, answered: true });
        return;
      }
      if (
        o.executor !== undefined &&
        !(COMPUTE_EXECUTORS as readonly string[]).includes(o.executor)
      ) {
        failMessage(`--executor is one of ${COMPUTE_EXECUTORS.join(", ")}.`, {
          json,
          answered: true,
        });
        return;
      }
      if (
        o.accounting !== undefined &&
        !(COMPUTE_ACCOUNTING as readonly string[]).includes(o.accounting)
      ) {
        failMessage(`--accounting is one of ${COMPUTE_ACCOUNTING.join(", ")}.`, {
          json,
          answered: true,
        });
        return;
      }
      if (o.runner !== undefined && !RUNNER_ID_RE.test(o.runner)) {
        failMessage("--runner is a runner id: rnr_ and 24 lowercase hexadecimal digits.", {
          json,
          answered: true,
        });
        return;
      }
      const limit = wholeOption(o.limit, "--limit", json, 200);
      const account = wholeOption(o.account, "--account", json);
      const after = wholeOption(o.after, "--after", json, Number.MAX_SAFE_INTEGER, 0);
      if (limit === null || account === null || after === null) return;
      try {
        if (o.unmatched === true) {
          const res = await listUnmatchedComputeRows(limit);
          if (json) {
            console.log(JSON.stringify(res, null, 2));
            return;
          }
          say(`${res.total} row(s) of Expanse's accounting match no job`);
          for (const r of res.rows) {
            say(
              `  ${plain(r.slurm_job_id)}  ${plain(r.state)}  ${plain(r.partition)}  ` +
                `${r.elapsed_seconds}s  ${r.alloc_nodes} node(s) ${r.alloc_cpus} cpu(s) ${r.alloc_gpus} gpu(s)  ` +
                `${r.charged_milli === null ? "no figure" : `${formatSu(r.charged_milli)} SU`}  ${plain(r.ingested_at)}`,
            );
          }
          return;
        }
        const res = await listComputeJobs({
          flag: o.flag,
          state: o.state,
          account,
          executor: o.executor,
          accounting: o.accounting,
          runner: o.runner,
          limit,
          after,
        });
        if (json) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        if (res.jobs.length === 0) say("No jobs.");
        for (const j of res.jobs) {
          say(
            `${plain(j.id)}  ${plain(j.state).padEnd(10)} ${plain(j.source).padEnd(8)} ${plain(j.partition)}/${plain(j.pool)}  ` +
              `${[
                inServiceUnits(j.accounting)
                  ? `${formatSu(j.charged_milli)} SU${j.settled ? "" : " (not settled)"}`
                  : "",
                j.executor === "runner"
                  ? runnerPhrase(j.runner_id, {
                      wall: j.runner_wall_seconds,
                      cpu: j.runner_cpu_seconds,
                      partial: j.runner_usage_partial,
                    })
                  : "",
              ]
                .filter((part) => part !== "")
                .join(", ")}  ` +
              `${j.flags.length > 0 ? `[${j.flags.map(plain).join(",")}]  ` : ""}${plain(j.created_at)}`,
          );
        }
        if (res.next_after !== null) say(`More: --after ${res.next_after}`);
      } catch (err) {
        failWith(err, null, "Could not list the jobs.", undefined, { json });
      }
    },
  );

const RECORD_HELP = `
Shows one job by its NEMAR id (job_ and 24 hex digits), its Tapis job uuid or its Slurm job id: the index
row, its ledger entries, the launcher's provenance and a summary of the result manifest (a count and a
size, never a path). It carries NO identity.

--identity reads the identity snapshot taken at submission, and --spec reads the specification: both are
OWNER ONLY, need --reason (${COMPUTE_RECORD_REASON_MIN} to ${COMPUTE_RECORD_REASON_MAX} characters, which are recorded), and are audited before
anything is read. An administrator is refused.

Exit codes:
  0  shown.
  1  the reference is not a job, an option is not valid, the Worker refused (an administrator asking for
     an identity included).`;

jobsCommand
  .command("record <ref>")
  .description("Show one job by NEMAR id, Tapis uuid or Slurm id; --identity or --spec (owner)")
  .option("--identity", "Read the identity snapshot (owner only, needs --reason)")
  .option("--spec", "Read the job's specification (owner only, needs --reason)")
  .option("--reason <text>", "Why the record is read (recorded in the audit log)")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", RECORD_HELP)
  .action(
    async (
      ref: string,
      o: { identity?: boolean; spec?: boolean; reason?: string; json?: boolean },
    ) => {
      const json = o.json === true;
      if (!requireSignedIn(json)) return;
      if (o.identity === true && o.spec === true) {
        failMessage("Choose --identity or --spec, not both.", { json, answered: true });
        return;
      }
      const reading = o.identity === true || o.spec === true;
      if (!reading && o.reason !== undefined) {
        failMessage("--reason goes with --identity or --spec.", { json, answered: true });
        return;
      }
      const reason = (o.reason ?? "").trim();
      if (
        reading &&
        (reason.length < COMPUTE_RECORD_REASON_MIN || reason.length > COMPUTE_RECORD_REASON_MAX)
      ) {
        failMessage(
          `--reason is required to read a record, ${COMPUTE_RECORD_REASON_MIN} to ${COMPUTE_RECORD_REASON_MAX} characters.`,
          { json, answered: true },
        );
        return;
      }
      try {
        if (reading) {
          const res = await readComputeRecord(
            ref,
            o.identity === true ? "identity.json" : "spec.json",
            reason,
          );
          if (json) console.log(JSON.stringify(res, null, 2));
          else say(JSON.stringify(res.content ?? res.url ?? null, null, 2));
          return;
        }
        const res = await getComputeRecord(ref);
        if (json) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        printJob({ ok: true, outcome: "record", job: res.job as ComputeJobView });
        const ids = res.identifiers as Record<string, unknown>;
        say(
          `  tapis ${plain(String(ids.tapis_uuid ?? "-"))}  slurm ${plain(String(ids.slurm_job_id ?? "-"))}  ` +
            `app ${plain(String(ids.app_id ?? "-"))}@${plain(String(ids.app_version ?? "-"))}`,
        );
        say(`  legal hold: ${res.legal_hold ? "yes" : "no"}`);
        say("  ledger:");
        for (const l of res.ledger as Array<Record<string, unknown>>) {
          say(
            `    ${plain(String(l.kind)).padEnd(8)} held ${Number(l.held_delta_milli)}  charged ${Number(l.charged_delta_milli)}  ` +
              `${plain(String(l.reason ?? ""))}  ${plain(String(l.created_at))}`,
          );
        }
        // A null value has two causes the Worker names: the object is not there (`missing`) or is there
        // and cannot be read (`unreadable`). An older Worker names neither, and prints as before.
        say(
          `  provenance: ${
            res.provenance === null
              ? recordAbsence(res.provenance_status)
              : plain(JSON.stringify(res.provenance))
          }`,
        );
        say(
          `  manifest: ${
            res.manifest === null
              ? recordAbsence(res.manifest_status)
              : `${res.manifest.files} file(s), ${res.manifest.bytes} bytes`
          }`,
        );
        if (typeof res.retention_until === "string") {
          say(`  records kept until: ${plain(res.retention_until)}`);
        }
        if (Array.isArray(res.launcher_files) && res.launcher_files.length > 0) {
          say(`  launcher files: ${res.launcher_files.map(plain).join(", ")}`);
        }
      } catch (err) {
        failWith(err, null, "Could not read the record.", undefined, { json });
      }
    },
  );

/** ", N not settled, X SU still held" for a total or a pool with open holds, and nothing when none is open. */
function unsettledNote(t: { unsettled?: unknown; open_hold_milli?: unknown }): string {
  const n = Number(t.unsettled ?? 0);
  return n > 0
    ? `, ${n} not settled (${formatSu(Number(t.open_hold_milli ?? 0))} SU still held)`
    : "";
}

/** Why a record's value is absent from a summary, in words that keep a missing file apart from a broken one. */
function recordAbsence(status: string | undefined): string {
  if (status === "missing") return "missing (no such record)";
  if (status === "unreadable") return "unreadable (present but not readable as expected)";
  return "none";
}

const REPORT_HELP = `
One account's jobs created from --from to the end of --to (dates, YYYY-MM-DD), the SU they were charged
by pool, and one line for each job. --csv prints the lines as comma-separated values (id, created, ended,
state, partition, pool, source, SU charged, settled, SU still held, flags, then executor, accounting, runner
and the runner-reported wall seconds, CPU seconds, largest resident memory and partial mark) and nothing
else. A job that is not settled yet has charged nothing so far and still holds SU: the totals count those
jobs and the SU they hold, so a running account does not look cheaper than it is.

A job a runner ran is accounted by the runner's own measurements, never in SU: the SU totals count the jobs
accounted in SU only, a line of its own gives the runner jobs, their wall and CPU seconds and their
runner-reported core-hours (CPU seconds over 3600, rounded down to three decimals), and a runner job's line
shows its usage and no SU (its SU cells in the CSV are empty). Usage the runner marked partial (Docker or
Podman could not measure all of it) is marked "(partial: Docker or Podman)", and the runner totals say how
many jobs are partial, so the sums are a lower bound. No identity is shown.

Exit codes:
  0  reported.
  1  an option is not valid, or the Worker refused.`;

jobsCommand
  .command("report")
  .description("One account's jobs and charge between two dates")
  .requiredOption("--account <id>", "The account")
  .requiredOption("--from <date>", "First day, YYYY-MM-DD")
  .requiredOption("--to <date>", "Last day, YYYY-MM-DD")
  .option("--csv", "Print comma-separated values")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", REPORT_HELP)
  .action(
    async (o: { account: string; from: string; to: string; csv?: boolean; json?: boolean }) => {
      const json = o.json === true;
      if (!requireSignedIn(json)) return;
      if (!formatChoice(o)) return;
      if (!ACCOUNT_RE.test(o.account)) {
        failMessage("--account is an account number.", { json, answered: true });
        return;
      }
      if (!DATE_RE.test(o.from) || !DATE_RE.test(o.to)) {
        failMessage("--from and --to are dates, YYYY-MM-DD.", { json, answered: true });
        return;
      }
      try {
        const res = await getComputeAccountReport({
          account: Number(o.account),
          from: o.from,
          to: o.to,
        });
        if (json) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        const jobs = res.jobs as Array<Record<string, unknown>>;
        if (o.csv === true) {
          printCsv([
            [
              "id",
              "created_at",
              "ended_at",
              "state",
              "partition",
              "pool",
              "source",
              "su_charged",
              "settled",
              "su_held",
              "flags",
              "executor",
              "accounting",
              "runner_id",
              "runner_wall_seconds",
              "runner_cpu_seconds",
              "runner_max_rss_mb",
              "runner_usage_partial",
            ],
            ...jobs.map((j) => {
              // A job accounted `none` has no SU, as the Worker's totals count it: its three SU cells are
              // empty, never a zero. The runner columns follow the executor.
              const noSu = !inServiceUnits(j.accounting);
              const usage = (j.executor === "runner" ? j.runner_usage : null) as Record<
                string,
                unknown
              > | null;
              return [
                String(j.id),
                String(j.created_at),
                j.ended_at === null ? "" : String(j.ended_at),
                String(j.state),
                String(j.partition),
                String(j.pool),
                String(j.source),
                noSu ? "" : formatSu(Number(j.charged_milli)),
                noSu ? "" : j.settled === false ? "no" : "yes",
                noSu ? "" : formatSu(Number(j.open_hold_milli ?? 0)),
                Array.isArray(j.flags) ? j.flags.join(" ") : "",
                typeof j.executor === "string" ? j.executor : "",
                typeof j.accounting === "string" ? j.accounting : "",
                typeof j.runner_id === "string" ? j.runner_id : "",
                typeof usage?.wall_seconds === "number" ? usage.wall_seconds : "",
                typeof usage?.cpu_seconds === "number" ? usage.cpu_seconds : "",
                typeof usage?.max_rss_mb === "number" ? usage.max_rss_mb : "",
                usage?.partial === true
                  ? "yes"
                  : usage?.partial === false
                    ? "no"
                    : typeof usage?.wall_seconds === "number"
                      ? "unknown"
                      : "",
              ];
            }),
          ]);
          return;
        }
        say(
          `account ${res.account_id}, ${plain(res.from)} to ${plain(res.to)}: ${res.totals.jobs} SU job(s), ${formatSu(res.totals.charged_milli)} SU charged${unsettledNote(res.totals)}`,
        );
        for (const [pool, t] of Object.entries(res.by_pool)) {
          const row = t as Record<string, unknown>;
          say(
            `  ${plain(pool)}: ${Number(row.jobs)} SU job(s), ${formatSu(Number(row.charged_milli))} SU charged${unsettledNote(row)}`,
          );
        }
        const runnerTotals = res.runner_totals;
        if (runnerTotals !== undefined && runnerTotals.jobs > 0) {
          // Apart from the SU above, and never added to it.
          // A zero sum over jobs that have not reported is not zero usage, so the count that reported is said.
          const reported = runnerTotals.reported_jobs;
          say(
            `  runner jobs (runner-reported, never service units): ${runnerTotals.jobs} job(s), ` +
              `${reported === undefined ? "" : `${reported} with usage reported, `}` +
              `${
                reported === 0
                  ? "no usage reported yet"
                  : `wall ${runnerTotals.wall_seconds} s, cpu ${runnerTotals.cpu_seconds} s, ` +
                    `${runnerTotals.core_hours.toFixed(3)} runner-reported core-hours`
              }${runnerMarkNotes(runnerTotals)}`,
          );
        }
        for (const j of jobs) {
          // The SU figure is for a job accounted in SU; the runner's figures for a job a runner ran. A job
          // accounted `none` never has an SU figure next to it.
          const note =
            j.settled === false
              ? `  (not settled, ${formatSu(Number(j.open_hold_milli ?? 0))} SU held)`
              : "";
          const usage = (j.runner_usage ?? {}) as Record<string, unknown>;
          const parts = [
            inServiceUnits(j.accounting) ? `${formatSu(Number(j.charged_milli))} SU${note}` : "",
            j.executor === "runner"
              ? runnerPhrase(j.runner_id, {
                  wall: usage.wall_seconds,
                  cpu: usage.cpu_seconds,
                  partial: usage.partial,
                })
              : "",
          ].filter((part) => part !== "");
          say(
            `  ${plain(String(j.id))}  ${plain(String(j.state))}  ${plain(String(j.partition))}  ${parts.join(", ")}  ${plain(String(j.created_at))}`,
          );
        }
        if (res.truncated) say("  (the list is cut at 5,000 jobs; narrow the range)");
      } catch (err) {
        failWith(err, null, "Could not make the report.", undefined, { json });
      }
    },
  );

const ACCESS_REPORT_HELP = `
For ACCESS, the jobs the scheduler took in a quarter (--quarter 2026Q4, by the scheduler's own submission
time in UTC, and only jobs with a Slurm job id, as reported to ACCESS): the distinct gateway
users (pseudonyms, counted and never listed) and the jobs, by partition and source. A person is counted
once however many jobs they ran. A job that skipped the reservation or whose owner NEMAR could not
attribute is left out. --csv prints quarter, partition, source, distinct users and jobs, then a total.

Exit codes:
  0  reported.
  1  the quarter is not valid, or the Worker refused.`;

jobsCommand
  .command("access-report")
  .description("For ACCESS: a quarter's distinct gateway users and jobs by partition and source")
  .requiredOption("--quarter <yyyyQn>", "For example 2026Q4")
  .option("--csv", "Print comma-separated values")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", ACCESS_REPORT_HELP)
  .action(async (o: { quarter: string; csv?: boolean; json?: boolean }) => {
    const json = o.json === true;
    if (!requireSignedIn(json)) return;
    if (!formatChoice(o)) return;
    if (!QUARTER_RE.test(o.quarter)) {
      failMessage("--quarter is a year and a quarter, for example 2026Q4.", {
        json,
        answered: true,
      });
      return;
    }
    try {
      const res = await getComputeAccessReport(o.quarter);
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      if (o.csv === true) {
        printCsv([
          ["quarter", "partition", "source", "distinct_users", "jobs"],
          ...res.rows.map((r) => [res.quarter, r.partition, r.source, r.distinct_users, r.jobs]),
          [res.quarter, "total", "total", res.totals.distinct_users, res.totals.jobs],
        ]);
        return;
      }
      say(
        `${plain(res.quarter)}: ${res.totals.distinct_users} distinct user(s), ${res.totals.jobs} job(s)`,
      );
      for (const r of res.rows) {
        say(
          `  ${plain(r.partition)}/${plain(r.source)}: ${r.distinct_users} user(s), ${r.jobs} job(s)`,
        );
      }
    } catch (err) {
      failWith(err, null, "Could not make the report.", undefined, { json });
    }
  });

/** `job:<id>` or `account:<id>`, as the two scopes and their ref, or null after saying why. */
function holdTarget(raw: string, json: boolean): { scope: string; ref: string } | null {
  const [scope, ref, ...rest] = raw.split(":");
  const scopeOk = (COMPUTE_HOLD_SCOPES as readonly string[]).includes(scope ?? "");
  const refOk = scope === "job" ? COMPUTE_JOB_ID_RE.test(ref ?? "") : ACCOUNT_RE.test(ref ?? "");
  if (!scopeOk || !refOk || rest.length > 0) {
    failMessage(`"${raw}" is not a target: it is job:<job id> or account:<account number>.`, {
      json,
      answered: true,
    });
    return null;
  }
  return { scope: scope as string, ref: ref as string };
}

const HOLD_HELP = `
Places a legal hold on one job (job:<id>) or on every job of one account (account:<number>). The
retention sweep deletes nothing under a hold: a job's records and logs stay past their retention until the
hold is released. A hold never keeps a result (results expire on their own rule). --reason is a fixed word
(lowercase letters, digits and _), never free text.

OWNER ONLY; audited. A second hold on the same target is refused.

Exit codes:
  0  placed.
  1  the target or reason is not valid, the target does not exist, it is already held, or the Worker refused.`;

jobsCommand
  .command("hold <target>")
  .description("Place a legal hold on job:<id> or account:<id> (owner)")
  .requiredOption("--reason <word>", "A fixed word, for example legal_request")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", HOLD_HELP)
  .action(async (target: string, o: { reason: string; json?: boolean }) => {
    const json = o.json === true;
    if (!requireSignedIn(json)) return;
    const t = holdTarget(target, json);
    if (t === null) return;
    if (!COMPUTE_WORD_RE.test(o.reason)) {
      failMessage("--reason is a word of lowercase letters, digits and _.", {
        json,
        answered: true,
      });
      return;
    }
    try {
      const res = await placeComputeHold({ ...t, reason: o.reason });
      if (json) console.log(JSON.stringify(res, null, 2));
      else say(`Hold ${res.hold.id} placed on ${plain(target)} (${plain(res.hold.reason)}).`);
    } catch (err) {
      failWith(err, null, "Could not place the hold.", undefined, { json });
    }
  });

const RELEASE_HELP = `
Releases the active legal hold on job:<id> or account:<number>. The hold stays as a row, released; the
retention sweep may delete what it kept the next time it runs.

OWNER ONLY; audited.

Exit codes:
  0  released.
  1  the target is not valid, it is not held, or the Worker refused.`;

jobsCommand
  .command("release-hold <target>")
  .description("Release the legal hold on job:<id> or account:<id> (owner)")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", RELEASE_HELP)
  .action(async (target: string, o: { json?: boolean }) => {
    const json = o.json === true;
    if (!requireSignedIn(json)) return;
    const t = holdTarget(target, json);
    if (t === null) return;
    try {
      const active = await listComputeHolds(t);
      const hold = active.holds[0];
      if (hold === undefined) {
        failMessage(`${target} is not under a hold.`, { json, answered: true });
        return;
      }
      const res = await releaseComputeHold(hold.id);
      if (json) console.log(JSON.stringify(res, null, 2));
      else say(`Hold ${res.hold.id} on ${plain(target)} released.`);
    } catch (err) {
      failWith(err, null, "Could not release the hold.", undefined, { json });
    }
  });

jobsCommand
  .command("holds")
  .description("List the active legal holds")
  .option("--json", "Print the Worker's answer as JSON")
  .action(async (o: { json?: boolean }) => {
    const json = o.json === true;
    if (!requireSignedIn(json)) return;
    try {
      const res = await listComputeHolds();
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      if (res.holds.length === 0) say("No active holds.");
      for (const h of res.holds) {
        say(
          `${h.id}  ${plain(h.scope)}:${plain(h.ref)}  ${plain(h.reason)}  placed ${plain(h.placed_at)}`,
        );
      }
      if (res.truncated === true) {
        say(
          `The list is cut at the oldest ${res.holds.length} active holds; there are more. A target's own hold is found with release-hold <target>.`,
        );
      }
    } catch (err) {
      failWith(err, null, "Could not list the holds.", undefined, { json });
    }
  });

const ACCESS_REPORTS_HELP = `
Lists the ACCESS gateway-attributes reports in one state (default failed), and counts the failed ones by
their fixed word:
  outcome_unknown   the request may or may not have been recorded; it is NEVER sent again by code
  no_gateway_user   the job has no pseudonym to report (a partner's job with no account)
  no_submit_time    the scheduler's submission time never showed
  refused, busy, unavailable   the retry classes, once their attempts ran out
("unconfigured" is a word of a PENDING report that waits for the ACCESS key and resource name; a failed
report never carries it.) A failed report is not retried. If you have confirmed with ACCESS that one was NOT recorded, the owner
re-queues it with requeue-access-report.

Exit codes:
  0  listed.
  1  an option is not valid, or the Worker refused.`;

jobsCommand
  .command("access-reports")
  .description("List ACCESS reports by state; the failed ones are counted by their fixed word")
  .option("--state <state>", `One of ${COMPUTE_ACCESS_REPORT_STATES.join(", ")}`, "failed")
  .option("--limit <n>", "Rows per page, 1 to 200", "50")
  .option("--after <job id>", "Continue after this job")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", ACCESS_REPORTS_HELP)
  .action(async (o: { state: string; limit: string; after?: string; json?: boolean }) => {
    const json = o.json === true;
    if (!requireSignedIn(json)) return;
    if (!(COMPUTE_ACCESS_REPORT_STATES as readonly string[]).includes(o.state)) {
      failMessage(`--state is one of ${COMPUTE_ACCESS_REPORT_STATES.join(", ")}.`, {
        json,
        answered: true,
      });
      return;
    }
    const limit = wholeOption(o.limit, "--limit", json, 200);
    if (limit === null) return;
    if (o.after !== undefined && !COMPUTE_JOB_ID_RE.test(o.after)) {
      failMessage("--after is a job id.", { json, answered: true });
      return;
    }
    try {
      const res = await listComputeAccessReports({ state: o.state, limit, after: o.after });
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      const words = Object.entries(res.failed_by_word);
      say(
        `failed ACCESS reports: ${words.length === 0 ? "none" : words.map(([w, n]) => `${plain(w)} ${String(n)}`).join(", ")}`,
      );
      for (const r of res.rows) {
        say(
          `  ${plain(r.job_id)}  ${plain(r.state)}  attempts ${r.attempts}  ${plain(r.last_error_code ?? "-")}`,
        );
      }
      if (res.next_after !== null) say(`More: --after ${plain(res.next_after)}`);
    } catch (err) {
      failWith(err, null, "Could not list the ACCESS reports.", undefined, { json });
    }
  });

const REQUEUE_HELP = `
Puts one FAILED ACCESS report back to pending, so the reporter sends it again. OWNER ONLY, audited, and it
needs --confirmed-not-recorded: your statement that the report is CONFIRMED NOT recorded at ACCESS. An
outcome the Worker could not judge (outcome_unknown) is never resent automatically, because a report may be
lost but is never doubled; resending one that ACCESS did record would double it. Without the flag nothing
is sent to the Worker.

Exit codes:
  0  re-queued.
  1  the id is not a job id, the flag is missing, there is no failed report for the job, or the Worker
     refused (an administrator included).`;

jobsCommand
  .command("requeue-access-report <id>")
  .description("Put a failed ACCESS report back to pending (owner; needs --confirmed-not-recorded)")
  .option("--confirmed-not-recorded", "I have confirmed ACCESS did NOT record this report")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", REQUEUE_HELP)
  .action(async (id: string, o: { confirmedNotRecorded?: boolean; json?: boolean }) => {
    const json = o.json === true;
    if (!requireSignedIn(json)) return;
    const jobId = jobIdArg(id, json);
    if (jobId === null) return;
    if (o.confirmedNotRecorded !== true) {
      failMessage(
        "This needs --confirmed-not-recorded: the report must be confirmed NOT recorded at ACCESS, because an unknown outcome is never resent automatically.",
        { json, answered: true },
      );
      return;
    }
    try {
      const res = await requeueComputeAccessReport(jobId);
      if (json) console.log(JSON.stringify(res, null, 2));
      else
        say(
          `The report for ${plain(jobId)} is pending again (it had failed: ${plain(res.previous ?? "-")}).`,
        );
    } catch (err) {
      failWith(err, null, "Could not re-queue the report.", undefined, { json });
    }
  });

// --- The observer's token -----------------------------------------------------------------------------------------

const OBSERVER_HELP = `
Mints a one-hour token for ONE post of the observer (Expanse's queue summary and accounting export). The
token is printed once and never stored: only the run is. Anyone holding it can make that one post, so put
it where the observer reads it and nowhere else. The post is bounded (1 MiB and 5,000 rows) and refused
with one answer for a wrong, an expired or an already used token. The run and its minting are audited.

Admin or owner.

Exit codes:
  0  minted.
  1  the Worker has no callback secret to sign with, or refused.`;

const observerCommand = new Command("observer").description("The observer's per-run token (admin)");

observerCommand
  .command("mint")
  .description("Mint a one-hour token for one observer post")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", OBSERVER_HELP)
  .action(async (o: { json?: boolean }) => {
    const json = o.json === true;
    if (!requireSignedIn(json)) return;
    try {
      const res = await mintComputeObserverRun();
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      say(`run ${plain(res.run_id)} (valid ${res.expires_in_minutes} minutes, one post)`);
      say(`token ${plain(res.token)}`);
    } catch (err) {
      failWith(err, null, "Could not mint the token.", undefined, { json });
    }
  });

export { jobsCommand, observerCommand };
