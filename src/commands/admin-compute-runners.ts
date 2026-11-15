/**
 * `nemar admin compute runners`: the owner registers, lists and revokes the machines that run jobs for
 * NEMAR (portable compute, card DM-05; protocol `nemar.runner.v1`).
 *
 *   nemar admin compute runners register <name> --pool --cores --memory-mb --scratch-gb --runtime ...
 *   nemar admin compute runners list [--json]
 *   nemar admin compute runners revoke <id> [--json]
 *   nemar admin compute runners usage --from <date> --to <date> [--json]
 *
 * The first three are the owner's; `usage` is an administrator's (it reads and changes nothing). Every
 * command exits 1 on any failure and keeps standard output pure JSON under `--json`. A registration is
 * accounted `none` (runner-reported usage); `su` is not built yet, and `usage` never shows service units.
 *
 * THE SECRET IS SHOWN ONCE. `register` prints it and the Worker keeps only its hash, so a lost secret is
 * a revoked registration and a new one. It is the only thing a runner needs to start: keep it in a file
 * only you can read (mode 0600), never in a command line, a repository or a chat.
 */

import { Command } from "commander";
import { RUNNER_BACKENDS } from "../../shared/compute-state.js";
import {
  COMPUTE_RUNNER_REPORT_DAYS_MAX,
  COMPUTE_RUNNER_USAGE_FOOTER,
  runnerMarkNotes,
} from "../../shared/contract/compute-admin.js";
import {
  RUNNER_ARCHES,
  RUNNER_ID_RE,
  RUNNER_RUNTIMES,
  RUNNER_TRUST,
  type RunnerRegisterRequest,
  RunnerRegisterRequestSchema,
} from "../../shared/contract/compute-runner.js";
import { COMPUTE_POOLS } from "../../shared/contract/compute.js";
import { failMessage, failWith, requireSignedIn } from "../lib/admin-command.js";
import {
  getComputeRunnersUsage,
  listComputeRunners,
  registerComputeRunner,
  revokeComputeRunner,
} from "../lib/api/compute-runners.js";
import { clip, plain } from "../lib/terminal-text.js";

const say = (line: string): void => console.log(line);

const REGISTER_HELP = `
Registers a runner and prints its SECRET, which is shown ONCE: NEMAR keeps only a hash, so a lost secret
is a revoked registration and a new one. Save the secret to a file that only you can read (mode 0600)
and give that file to the runner; never put it on a command line, in a repository or in a chat.

  <name>                a fixed word for this registration (lowercase letters, digits, underscore, up to 64);
                        unique among registrations that are not revoked
  --pool <cpu|gpu>      the pool its jobs are counted in
  --cores <n>           whole cores it offers (1 to 256)
  --memory-mb <n>       memory it offers, in MB (1 to 16777216)
  --gpus <n>            GPUs it offers (0 to 8; default 0)
  --scratch-gb <n>      scratch space it offers, in GB (1 to 100000)
  --backend <word>      ${RUNNER_BACKENDS.join(" or ")} (default local)
  --runtime <word>      a container runtime it has: ${RUNNER_RUNTIMES.join(", ")}; repeat for more
  --arch <word>         ${RUNNER_ARCHES.join(" or ")}
  --site <word>         where it runs, a fixed word (lowercase letters, digits, underscore, up to 32)
  --trust <word>        lab (a workstation you control) or hpc (a shared cluster)

The registration is accounted by the runner's own measurements; accounting in service units is not built.
Nothing runs until the owner also turns the runners switch on. The registration is audited.

Owner only. --json prints the Worker's answer as it is, the secret included.

Exit codes:
  0  registered; the id and the secret were printed.
  1  an option was not valid (nothing was sent), the Worker refused (you are not an owner, or a live
     registration has that name) or the write failed.`;

const LIST_HELP = `
Lists every registration, newest first: its id, name, capacity, where it runs, when it was last seen and
whether it was revoked. It never shows a secret or a hash.

Owner only. --json prints the Worker's answer as it is.

Exit codes:
  0  listed.
  1  the Worker refused (you are not an owner) or the read failed.`;

const REVOKE_HELP = `
Ends a registration, in one step: its access tokens stop working at once, its unstarted claims are
released for another runner, and its started jobs are marked unreported with no lease, so neither the
lease nor the job token of the dead runner can land outputs. The runner learns of it when its next call
is refused. Revoking a registration that is already revoked changes nothing and says so.

Owner only. --json prints the Worker's answer as it is.

Exit codes:
  0  revoked, or already revoked.
  1  the id is not a runner id (nothing was sent), the Worker refused (you are not an owner, or there is
     no such runner) or the write failed.`;

const USAGE_HELP = `
Every runner registration's usage over the jobs created from --from to the end of --to (dates,
YYYY-MM-DD, UTC days: a job belongs to the day it was created, in UTC; a range is at most ${COMPUTE_RUNNER_REPORT_DAYS_MAX} days, both
ends counted): its id, name, site and trust, whether it is revoked, its jobs by state, how many of them have
usage reported, the wall and CPU seconds the runner measured, the runner-reported core-hours (CPU seconds
over 3600, rounded down to three decimals) and the largest resident memory. A registration with no job in
the range is listed with zeros; one whose jobs have reported nothing yet says so instead of showing zeros.

These are the runners' OWN figures and are never service units, so no SU is shown and nothing here is added
to an SU total. Usage a runner marked partial (Docker or Podman could not measure all of it) is marked
"(partial: Docker or Podman)": the sums are then a lower bound. Usage with no mark (a job completed before
the mark was stored) is marked "(partial: unknown)", never as whole. No identity is shown.

Admin or owner. --json prints the Worker's answer as it is.

Exit codes:
  0  reported.
  1  an option is not valid (nothing was sent), the Worker refused (a range too long, from after to) or the
     read failed.`;

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** A whole number option, or undefined after the schema says why it is not one. */
function whole(raw: string | undefined): number | undefined {
  return raw !== undefined && /^[0-9]{1,9}$/.test(raw) ? Number(raw) : undefined;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

interface RegisterOptions {
  pool?: string;
  cores?: string;
  memoryMb?: string;
  gpus?: string;
  scratchGb?: string;
  backend?: string;
  runtime: string[];
  arch?: string;
  site?: string;
  trust?: string;
  json?: boolean;
}

export const runnersCommand = new Command("runners").description(
  "Register, list and revoke the machines that run jobs for NEMAR (owner)",
);

runnersCommand
  .command("register <name>")
  .description("Register a runner; its secret is printed once")
  .option("--pool <word>", `${COMPUTE_POOLS.join(" or ")}`)
  .option("--cores <n>", "Whole cores it offers")
  .option("--memory-mb <n>", "Memory it offers, in MB")
  .option("--gpus <n>", "GPUs it offers (default 0)")
  .option("--scratch-gb <n>", "Scratch space it offers, in GB")
  .option("--backend <word>", `${RUNNER_BACKENDS.join(" or ")} (default local)`)
  .option(
    "--runtime <word>",
    `A container runtime: ${RUNNER_RUNTIMES.join(", ")}; repeatable`,
    collect,
    [],
  )
  .option("--arch <word>", RUNNER_ARCHES.join(" or "))
  .option("--site <word>", "Where it runs, a fixed word")
  .option("--trust <word>", RUNNER_TRUST.join(" or "))
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", REGISTER_HELP)
  .action(async (name: string, o: RegisterOptions) => {
    const json = o.json === true;
    if (!requireSignedIn(json)) return;
    const candidate = {
      name,
      pool: o.pool,
      cores: whole(o.cores),
      memory_mb: whole(o.memoryMb),
      gpus: o.gpus === undefined ? 0 : whole(o.gpus),
      scratch_gb: whole(o.scratchGb),
      backend: o.backend ?? "local",
      runtimes: o.runtime,
      arch: o.arch,
      accounting: "none",
      site: o.site,
      trust: o.trust,
    };
    const checked = RunnerRegisterRequestSchema.safeParse(candidate);
    if (!checked.success) {
      const lines = checked.error.issues
        .slice(0, 10)
        .map((i) => `  ${i.path.join(".") || "registration"}: ${i.message}`);
      failMessage(`That is not a valid registration; nothing was sent:\n${lines.join("\n")}`, {
        json,
        answered: true,
      });
      return;
    }
    const body: RunnerRegisterRequest = checked.data;
    try {
      const res = await registerComputeRunner(body);
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      say(`Registered runner ${plain(res.runner_id)} (${plain(body.name)}).`);
      say("Its secret is shown ONCE; NEMAR keeps only a hash and cannot show it again:");
      say(plain(res.secret));
      say("Save it to a file only you can read (mode 0600) and give that file to the runner.");
      say("If it is lost, revoke this registration and register again.");
    } catch (err) {
      failWith(err, null, "Could not register the runner.", undefined, { json });
    }
  });

runnersCommand
  .command("list")
  .description("List the registrations, without a secret")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", LIST_HELP)
  .action(async (o: { json?: boolean }) => {
    const json = o.json === true;
    if (!requireSignedIn(json)) return;
    try {
      const res = await listComputeRunners();
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      if (res.runners.length === 0) say("No runner is registered.");
      for (const r of res.runners) {
        const state =
          r.revoked_at === null ? "live" : `revoked (${clip(r.revoke_reason ?? "", 32)})`;
        const seen = r.last_seen_at === null ? "never seen" : `seen ${plain(r.last_seen_at)}`;
        say(
          `${plain(r.id)}  ${clip(r.name, 24).padEnd(24)} ${plain(r.pool)} ${r.cores} cores ${r.memory_mb} MB ${r.gpus} gpu` +
            `  ${plain(r.backend)} ${plain(r.arch)} ${r.runtimes.map(plain).join("+")}  ${clip(r.site, 16)} ${plain(r.trust)}` +
            `  ${state}, ${seen}`,
        );
      }
    } catch (err) {
      failWith(err, null, "Could not list the runners.", undefined, { json });
    }
  });

runnersCommand
  .command("revoke <id>")
  .description("End a registration, its tokens and its work")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", REVOKE_HELP)
  .action(async (id: string, o: { json?: boolean }) => {
    const json = o.json === true;
    if (!requireSignedIn(json)) return;
    if (!RUNNER_ID_RE.test(id)) {
      failMessage(`"${id}" is not a runner id (rnr_ and 24 lowercase hex digits).`, {
        json,
        answered: true,
      });
      return;
    }
    try {
      const res = await revokeComputeRunner(id);
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      say(
        res.already_revoked
          ? `Runner ${plain(res.runner_id)} was already revoked; nothing changed.`
          : `Revoked runner ${plain(res.runner_id)}: its tokens, claims and started jobs are ended.`,
      );
    } catch (err) {
      failWith(err, null, "Could not revoke the runner.", undefined, { json });
    }
  });

runnersCommand
  .command("usage")
  .description("Every runner's usage over a date range, in the runners' own figures (never SU)")
  .requiredOption("--from <date>", "First day, YYYY-MM-DD")
  .requiredOption("--to <date>", "Last day, YYYY-MM-DD")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", USAGE_HELP)
  .action(async (o: { from: string; to: string; json?: boolean }) => {
    const json = o.json === true;
    if (!requireSignedIn(json)) return;
    if (!DATE_RE.test(o.from) || !DATE_RE.test(o.to)) {
      failMessage("--from and --to are dates, YYYY-MM-DD.", { json, answered: true });
      return;
    }
    try {
      const res = await getComputeRunnersUsage({ from: o.from, to: o.to });
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      say(`Runner usage, jobs created ${plain(res.from)} to ${plain(res.to)}:`);
      if (res.runners.length === 0) say("  No runner is registered.");
      for (const r of res.runners) {
        // The count in each state is a value the Worker sent: plain, like every other word it sent.
        const states = Object.entries(r.by_state)
          .map(([state, n]) => `${plain(state)} ${plain(String(n))}`)
          .join(", ");
        // A zero sum over jobs that have not reported is not zero usage: say so, and how many have reported.
        const reported =
          r.reported_jobs === undefined ? "" : `${r.reported_jobs} with usage reported, `;
        const figures =
          r.jobs > 0 && r.reported_jobs === 0
            ? "no usage reported yet"
            : `wall ${r.wall_seconds} s, cpu ${r.cpu_seconds} s, ${r.core_hours.toFixed(3)} runner-reported core-hours, ` +
              `max resident ${r.max_rss_mb === null ? "none reported" : `${r.max_rss_mb} MB`}`;
        say(
          `  ${plain(r.id)}  ${clip(r.name, 24).padEnd(24)} ${clip(r.site, 16)} ${plain(r.trust)}  ` +
            `${r.revoked ? "revoked" : "live"}: ${r.jobs} job(s)${states === "" ? "" : ` (${states})`}, ` +
            `${reported}${figures}${runnerMarkNotes(r)}`,
        );
      }
      const t = res.totals;
      say(
        `All runners: ${t.jobs} job(s), ${t.reported_jobs === undefined ? "" : `${t.reported_jobs} with usage reported, `}` +
          `${
            t.jobs > 0 && t.reported_jobs === 0
              ? "no usage reported yet"
              : `wall ${t.wall_seconds} s, cpu ${t.cpu_seconds} s, ${t.core_hours.toFixed(3)} runner-reported core-hours`
          }${runnerMarkNotes(t)}`,
      );
      say(COMPUTE_RUNNER_USAGE_FOOTER);
    } catch (err) {
      failWith(err, null, "Could not read the runners' usage.", undefined, { json });
    }
  });
