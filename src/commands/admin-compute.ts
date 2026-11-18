/**
 * `nemar admin compute`: the compute gateway's owner policy and allocation pools (epic #2005 phase
 * A2, #2007; ADR 0118).
 *
 *   nemar admin compute policy show                       the policy in force (owner)
 *   nemar admin compute policy set --file <json> [--note] the next version of it (owner)
 *   nemar admin compute pool show [--account <id>|--platform]   pools, in SU (admin)
 *   nemar admin compute pool grant <amount> ...           SU into one pool (admin; a platform budget: owner)
 *   nemar admin compute pool adjust <amount> ...          a correction of its grant (a charge: owner)
 *   nemar admin compute status [--json]                   the switches, Tapis and storage, as the Worker reads them (admin)
 *   nemar admin compute jobs cancel|advance <id> [--json] cancel a job, or take it one step on (admin; src/commands/admin-compute-jobs.ts)
 *   nemar admin compute jobs list|record|report|access-report|hold|release-hold|holds|access-reports|requeue-access-report
 *                                                         reporting, legal holds and ACCESS reports (phase A7, #2012; the same file)
 *   nemar admin compute observer mint [--json]            mint the observer's one-hour token (admin)
 *   nemar admin compute pipeline run|status ...           run NEMAR's own recipes, or read their stamps (admin; src/commands/admin-compute-pipeline.ts)
 *   nemar admin compute runners register|list|revoke ...  the machines that run jobs for NEMAR (owner; src/commands/admin-compute-runners.ts)
 *   nemar admin compute derivatives list|show|promote|sync ...  the derivative store of pipeline products (admin; published: owner; src/commands/admin-compute-derivatives.ts)
 *
 * Amounts are service units (SU) as plain decimals with at most three places (`12.5`), and are sent
 * as whole thousandths. Every write sends one fresh `Idempotency-Key`, so within one invocation the
 * request is applied once; a second invocation is a NEW request and grants again. After an answer
 * that was lost (a network failure, a timeout), run `pool show` first and look at what the pool
 * holds before running the command again. Every command exits 1 on any failure and keeps standard
 * output pure JSON under `--json`.
 *
 * `policy show` parses the answer with an open schema, so a Worker that adds a key does not break
 * this command; `policy set` checks the file with the strict schema first and sends nothing for a
 * file that is not a policy.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { Command } from "commander";
import { COMPUTE_WORD_RE } from "../../shared/compute-state.js";
import {
  COMPUTE_ADJUST_TARGETS,
  COMPUTE_PLATFORM_KEYS,
  COMPUTE_POOLS_PAGE_MAX,
  type ComputeAdjustTarget,
  type ComputePolicyResponse,
  type ComputePoolView,
  type ComputePoolWriteResponse,
  type ComputeStatusResponse,
  isComputePlatformKey,
} from "../../shared/contract/compute-admin.js";
import {
  COMPUTE_POOLS,
  ComputePolicySchema,
  type ComputePool,
  formatSu,
  parseSuToMilli,
} from "../../shared/contract/compute.js";
import { failMessage, failWith, requireSignedIn } from "../lib/admin-command.js";
import {
  adjustAccountComputePool,
  adjustPlatformComputePool,
  getAccountComputePools,
  getComputePolicy,
  getComputeStatus,
  grantAccountComputePool,
  grantPlatformComputePool,
  listComputePools,
  putComputePolicy,
} from "../lib/api/compute.js";
import { plain } from "../lib/terminal-text.js";
import { derivativesCommand } from "./admin-compute-derivatives.js";
import { jobsCommand, observerCommand } from "./admin-compute-jobs.js";
import { pipelineCommand } from "./admin-compute-pipeline.js";
import { runnersCommand } from "./admin-compute-runners.js";

const ACCOUNT_RE = /^[1-9][0-9]{0,14}$/;
const POLICY_FILE_MAX_BYTES = 256 * 1024;
const NOTE_MAX = 500;

// ---------------------------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------------------------

const su = (milli: number) => formatSu(milli);

/** What an attention count means, for the words that need a sentence (fixed text: the Worker's value is never echoed). */
const ATTENTION_HINTS: Readonly<Record<string, string>> = {
  policy_unreadable:
    " (the stored owner policy cannot be read: every hold, run and limit fails closed until a valid version is written)",
  runner_cancel_pending_failed:
    " (a runner job's recorded cancel is over an hour old and its runner has not taken it: revoke the runner, or the lease sweep ends it once the lease is not current)",
  runner_copy_abandoned:
    " (a terminal runner job's launcher files were never copied into the records and no longer will be)",
  runner_records_unwritten:
    " (a waiting runner job's records never landed and the lease sweep has neither replayed nor ended it: the sweep is not running or is starved)",
  runner_waiting_stale:
    " (a runner job has waited unclaimed for over a day: no runner of its pool is polling, or none has room for it)",
};

/** One pool on one line, in SU. Everything the Worker sent is made plain first. */
function poolLine(p: ComputePoolView): string {
  const who = `${plain(p.holder_kind)} ${plain(p.holder_ref)}`;
  return (
    `${who.padEnd(24)} ${plain(p.pool).padEnd(4)}` +
    ` granted ${su(p.granted_milli)}  held ${su(p.held_milli)}  charged ${su(p.charged_milli)}` +
    `  available ${su(p.available_milli)} SU${p.frozen ? "  (frozen)" : ""}`
  );
}

/** JSON as lines that are safe for a terminal: JSON escapes control characters, `plain` the rest. */
function jsonLines(value: unknown): string[] {
  return JSON.stringify(value, null, 2).split("\n").map(plain);
}

function say(line: string): void {
  console.log(line);
}

const isPool = (word: string): word is ComputePool =>
  (COMPUTE_POOLS as readonly string[]).includes(word);

/** An amount typed in SU, as whole milli-SU above 0, or null after saying why (exit 1, nothing sent). */
function amountArg(text: string, json: boolean): number | null {
  const milli = parseSuToMilli(text);
  if (milli === null || milli < 1) {
    failMessage(
      `"${text}" is not an amount: use a plain decimal of SU above 0 with at most three places, like 12.5.`,
      { json, answered: true },
    );
    return null;
  }
  return milli;
}

type Holder = { kind: "account"; id: number } | { kind: "platform"; key: string };

/** `--account` or `--platform` (exactly one), or null after saying so. */
function holderArg(o: { account?: string; platform?: string }, json: boolean): Holder | null {
  if ((o.account === undefined) === (o.platform === undefined)) {
    failMessage("Name the pool's holder with exactly one of --account <id> and --platform <key>.", {
      json,
      answered: true,
    });
    return null;
  }
  if (o.account !== undefined) {
    if (!ACCOUNT_RE.test(o.account)) {
      failMessage(`"${o.account}" is not an account id (a whole number from 1).`, {
        json,
        answered: true,
      });
      return null;
    }
    return { kind: "account", id: Number(o.account) };
  }
  const key = o.platform as string;
  if (!isComputePlatformKey(key)) {
    failMessage(`"${key}" is not a platform budget key (${COMPUTE_PLATFORM_KEYS.join(" or ")}).`, {
      json,
      answered: true,
    });
    return null;
  }
  return { kind: "platform", key };
}

function poolArg(word: string | undefined, json: boolean): ComputePool | null {
  if (word === undefined || !isPool(word)) {
    failMessage("--pool is cpu or gpu.", { json, answered: true });
    return null;
  }
  return word;
}

function reasonArg(word: string | undefined, json: boolean): string | undefined | null {
  if (word === undefined) return undefined;
  if (!COMPUTE_WORD_RE.test(word)) {
    failMessage(
      `"${word}" is not a reason: a fixed word of lowercase letters, digits and underscores, up to 64.`,
      { json, answered: true },
    );
    return null;
  }
  return word;
}

const holderName = (h: Holder) => (h.kind === "account" ? `account ${h.id}` : `platform ${h.key}`);

function printWrite(headline: string, res: ComputePoolWriteResponse, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  say(res.replayed ? `${headline} (an earlier request with this key; nothing changed)` : headline);
  say(poolLine(res.pool));
}

// ---------------------------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------------------------

const POLICY_SHOW_HELP = `
Shows the compute policy in force: the owner's current version, who set it and when, and the policy
itself. While no version has been set it shows the default and says so. It changes nothing. The
answer is read with an open schema, so keys the Worker has added since this CLI was released are
shown too.

The "tenant" key is NEMAR's ceiling on live jobs: { maxLiveJobs, reserved: { people, pipelines,
partner } }. maxLiveJobs is the most jobs NEMAR holds at once (0 admits nothing new: a paused
platform, and running jobs finish); each reserved number is a floor kept for that class that no
other class may use, and the three floors must not add up to more than maxLiveJobs. A policy
without the key uses the default (20, with floors 8, 2 and 0), never "no limit". The pipelines'
own caps (pipelines.maxLiveJobs) are in effect bounded by the ceiling less the people and partner
floors, and by what else occupies slots.

Owner only. --json prints the Worker's answer as it is.

Exit codes:
  0  shown.
  1  the Worker refused (you are not an owner) or the read failed.`;

const POLICY_SET_HELP = `
Writes the next version of the compute policy from a JSON file (the whole policy, as \`policy show
--json\` prints it under "policy"). The file is checked here with the strict policy schema first and
the Worker checks it again: a mistyped or unknown key is refused, never dropped, and a file that is
not a policy sends nothing. Every version is kept; the highest is in force. The write is audited.

The "tenant" key ({ maxLiveJobs, reserved: { people, pipelines, partner } }) is NEMAR's ceiling on
live jobs. The floors under "reserved" must not add up to more than maxLiveJobs, or the file is
refused; maxLiveJobs of 0 admits no new job (running jobs finish). A file without the key keeps the
default ceiling of 20, never "no limit".

Owner only. --note records why (1 to 500 characters).

Exit codes:
  0  written; the new version is printed.
  1  the file could not be read or is not a policy, the Worker refused (you are not an owner) or
     the write failed. Nothing was written then.`;

function showPolicy(res: ComputePolicyResponse): void {
  if (res.version === null) {
    say("Compute policy: the default (no version has been set).");
  } else {
    const who = res.set_by === null ? "" : ` by account ${res.set_by}`;
    say(`Compute policy: version ${res.version}, set ${plain(res.created_at ?? "")}${who}.`);
  }
  if (res.note) say(`Note: ${plain(res.note)}`);
  for (const line of jsonLines(res.policy)) say(line);
}

const policyCommand = new Command("policy").description(
  "The owner's compute policy: show it, or write the next version (owner)",
);

policyCommand
  .command("show")
  .description("Show the compute policy in force")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", POLICY_SHOW_HELP)
  .action(async (o: { json?: boolean }) => {
    const json = o.json === true;
    if (!requireSignedIn(json)) return;
    try {
      const res = await getComputePolicy();
      if (json) console.log(JSON.stringify(res, null, 2));
      else showPolicy(res);
    } catch (err) {
      failWith(err, null, "Could not read the compute policy.", undefined, { json });
    }
  });

policyCommand
  .command("set")
  .description("Write the next version of the compute policy from a JSON file")
  .option("--file <path>", "The policy, as JSON")
  .option("--note <text>", "Why this version was written (1 to 500 characters)")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", POLICY_SET_HELP)
  .action(async (o: { file?: string; note?: string; json?: boolean }) => {
    const json = o.json === true;
    if (!requireSignedIn(json)) return;
    if (o.file === undefined) {
      failMessage("--file <path> names the policy to write.", { json, answered: true });
      return;
    }
    if (o.note !== undefined && (o.note.length < 1 || o.note.length > NOTE_MAX)) {
      failMessage(`--note is 1 to ${NOTE_MAX} characters.`, { json, answered: true });
      return;
    }
    let text: string;
    try {
      if (statSync(o.file).size > POLICY_FILE_MAX_BYTES) {
        failMessage(`${o.file} is over ${POLICY_FILE_MAX_BYTES / 1024} KiB, which no policy is.`, {
          json,
          answered: true,
        });
        return;
      }
      text = readFileSync(o.file, "utf8");
    } catch (err) {
      failMessage(`Cannot read ${o.file}: ${(err as NodeJS.ErrnoException).code ?? "failed"}.`, {
        json,
        answered: true,
      });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      failMessage(`${o.file} is not valid JSON.`, { json, answered: true });
      return;
    }
    const checked = ComputePolicySchema.safeParse(parsed);
    if (!checked.success) {
      const lines = checked.error.issues
        .slice(0, 10)
        .map((i) => `  ${i.path.join(".") || "policy"}: ${i.message}`);
      failMessage(
        `${o.file} is not a valid compute policy; nothing was sent:\n${lines.join("\n")}`,
        {
          json,
          answered: true,
        },
      );
      return;
    }
    try {
      const res = await putComputePolicy(checked.data, o.note);
      if (json) console.log(JSON.stringify(res, null, 2));
      else say(`Compute policy version ${res.version} set.`);
    } catch (err) {
      failWith(err, null, "Could not write the compute policy.", undefined, { json });
    }
  });

// ---------------------------------------------------------------------------------------------
// pool
// ---------------------------------------------------------------------------------------------

const POOL_SHOW_HELP = `
Shows allocation pools in SU: what was granted, what open holds set aside, what was charged, and
what is available (granted minus held minus charged, which may be negative after an overrun).
Without options it lists every pool, the platform's budgets first, a page at a time (--limit, up to
${COMPUTE_POOLS_PAGE_MAX}, and --after with the last id of the previous page). --account <id> shows one
account's pools, none yet included; --platform lists the platform budgets.

Admin or owner. --json prints the Worker's answer as it is.

Exit codes:
  0  shown.
  1  the Worker refused or the read failed.`;

const POOL_GRANT_HELP = `
Grants SU to one pool: --account <id> (an account's pool, made on its first grant) or, for the
owner, --platform <key> (pipelines or people, NEMAR's two budgets). <amount> is SU as a plain
decimal with at most three places (12.5 is 12500 thousandths of an SU). --pool is cpu or gpu.
--reason is a fixed word (default admin_grant).

One fresh Idempotency-Key is sent for each invocation, so within one invocation the grant is
applied once. Running the command again is a NEW request and grants again: after an answer that
was lost (a network failure, a timeout), run \`pool show\` first to see whether it was applied.
The write is audited.

Examples:
  nemar admin compute pool grant 12.5 --account 4412 --pool cpu
  nemar admin compute pool grant 500 --platform people --pool gpu --reason budget_period

Exit codes:
  0  granted.
  1  the amount, holder or pool was not valid (nothing was sent), the Worker refused (a platform
     budget is the owner's; there is no such account) or the write failed.`;

const POOL_ADJUST_HELP = `
Corrects one pool: --target granted changes what was granted, --target charged changes what was
charged. It adds <amount> SU, or takes it away with --decrease. --reason is required, a fixed word.
A correction that would make a stored total negative is refused and writes nothing; one that takes
the grant below what is used is allowed, and available goes negative.

The platform \`people\` budget records consumption only. Raising an account's charge also counts
against the budget of the same word; lowering it leaves that budget as it was, so nothing done to a
person's pool gives budget back. The only entries that lower it are a job's final settlement and
the owner's own correction of the platform budget. A raise made by mistake is undone against the
budget only by the owner's correction of the platform \`people\` pool.

Correcting an account's charge is the owner's for now (an administrator corrects a grant); a
platform budget is the owner's too.

One fresh Idempotency-Key is sent for each invocation. Running the command again is a NEW request
and adjusts again: after an answer that was lost, run \`pool show\` first to see whether it was
applied. The write is audited.

Examples:
  nemar admin compute pool adjust 2.5 --account 4412 --pool cpu --target charged --reason expanse_figure
  nemar admin compute pool adjust 1 --account 4412 --pool cpu --target granted --decrease --reason correction

Exit codes:
  0  adjusted.
  1  the amount, holder, pool, target or reason was not valid (nothing was sent), the Worker
     refused (a platform budget, or an account's charge, is the owner's; there is no such pool; a
     total would go negative or pass the largest NEMAR keeps) or the write failed.`;

const poolCommand = new Command("pool").description(
  "Allocation pools in SU: show them, grant SU, correct a grant or a charge",
);

poolCommand
  .command("show")
  .description("Show pools, in SU")
  .option("--account <id>", "Show one account's pools")
  .option("--platform", "List the platform budgets")
  .option("--limit <n>", `A page of this many (1 to ${COMPUTE_POOLS_PAGE_MAX}, default 50)`)
  .option("--after <id>", "Continue after this pool id (the last of the previous page)")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", POOL_SHOW_HELP)
  .action(
    async (o: {
      account?: string;
      platform?: boolean;
      limit?: string;
      after?: string;
      json?: boolean;
    }) => {
      const json = o.json === true;
      if (!requireSignedIn(json)) return;
      if (o.account !== undefined && o.platform) {
        failMessage("Use one of --account and --platform.", { json, answered: true });
        return;
      }
      const whole = (
        text: string | undefined,
        min: number,
        max: number,
      ): number | null | undefined => {
        if (text === undefined) return undefined;
        return /^[0-9]{1,15}$/.test(text) && Number(text) >= min && Number(text) <= max
          ? Number(text)
          : null;
      };
      const limit = whole(o.limit, 1, COMPUTE_POOLS_PAGE_MAX);
      const after = whole(o.after, 0, Number.MAX_SAFE_INTEGER);
      if (limit === null || after === null) {
        failMessage(
          `--limit is 1 to ${COMPUTE_POOLS_PAGE_MAX} and --after is a pool id (a whole number).`,
          { json, answered: true },
        );
        return;
      }
      try {
        if (o.account !== undefined) {
          if (!ACCOUNT_RE.test(o.account)) {
            failMessage(`"${o.account}" is not an account id (a whole number from 1).`, {
              json,
              answered: true,
            });
            return;
          }
          const res = await getAccountComputePools(Number(o.account));
          if (json) {
            console.log(JSON.stringify(res, null, 2));
            return;
          }
          if (res.pools.length === 0) say(`Account ${res.account_id} has no pool yet.`);
          for (const p of res.pools) say(poolLine(p));
          return;
        }
        const res = await listComputePools({
          holderKind: o.platform ? "platform" : undefined,
          after,
          limit,
        });
        if (json) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        for (const p of res.pools) say(poolLine(p));
        if (res.next_after !== null) say(`More: --after ${res.next_after}`);
      } catch (err) {
        failWith(err, null, "Could not read the pools.", undefined, { json });
      }
    },
  );

interface WriteOptions {
  account?: string;
  platform?: string;
  pool?: string;
  reason?: string;
  target?: string;
  decrease?: boolean;
  json?: boolean;
}

poolCommand
  .command("grant <amount>")
  .description("Grant SU to one pool (a platform budget is the owner's)")
  .option("--account <id>", "The account whose pool it is")
  .option("--platform <key>", "A platform budget: pipelines or people (owner)")
  .option("--pool <word>", "cpu or gpu")
  .option("--reason <word>", "A fixed word saying why (default admin_grant)")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", POOL_GRANT_HELP)
  .action(async (amountText: string, o: WriteOptions) => {
    const json = o.json === true;
    if (!requireSignedIn(json)) return;
    const holder = holderArg(o, json);
    if (!holder) return;
    const pool = poolArg(o.pool, json);
    if (!pool) return;
    const amount = amountArg(amountText, json);
    if (amount === null) return;
    const reason = reasonArg(o.reason, json);
    if (reason === null) return;
    const body = { pool, amount_milli: amount, ...(reason === undefined ? {} : { reason }) };
    try {
      const key = randomUUID();
      const res =
        holder.kind === "account"
          ? await grantAccountComputePool(holder.id, body, key)
          : await grantPlatformComputePool(holder.key, body, key);
      printWrite(`Granted ${su(amount)} SU to ${holderName(holder)}'s ${pool} pool.`, res, json);
    } catch (err) {
      failWith(err, null, "Could not grant.", undefined, { json });
    }
  });

poolCommand
  .command("adjust <amount>")
  .description("Correct a pool's grant or charge, up or down (a platform budget is the owner's)")
  .option("--account <id>", "The account whose pool it is")
  .option("--platform <key>", "A platform budget: pipelines or people (owner)")
  .option("--pool <word>", "cpu or gpu")
  .option("--target <which>", `What to correct: ${COMPUTE_ADJUST_TARGETS.join(" or ")}`)
  .option("--decrease", "Take the amount away instead of adding it")
  .option("--reason <word>", "A fixed word saying why (required)")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", POOL_ADJUST_HELP)
  .action(async (amountText: string, o: WriteOptions) => {
    const json = o.json === true;
    if (!requireSignedIn(json)) return;
    const holder = holderArg(o, json);
    if (!holder) return;
    const pool = poolArg(o.pool, json);
    if (!pool) return;
    const amount = amountArg(amountText, json);
    if (amount === null) return;
    if (
      o.target === undefined ||
      !(COMPUTE_ADJUST_TARGETS as readonly string[]).includes(o.target)
    ) {
      failMessage(`--target is ${COMPUTE_ADJUST_TARGETS.join(" or ")}.`, { json, answered: true });
      return;
    }
    const target = o.target as ComputeAdjustTarget;
    if (o.reason === undefined) {
      failMessage("--reason is required: a fixed word saying why.", { json, answered: true });
      return;
    }
    const reason = reasonArg(o.reason, json);
    if (reason === null || reason === undefined) return;
    const body = {
      pool,
      target,
      delta_milli: o.decrease ? -amount : amount,
      reason,
    };
    try {
      const key = randomUUID();
      const res =
        holder.kind === "account"
          ? await adjustAccountComputePool(holder.id, body, key)
          : await adjustPlatformComputePool(holder.key, body, key);
      printWrite(
        `Adjusted the ${target} total of ${holderName(holder)}'s ${pool} pool by ${o.decrease ? "-" : "+"}${su(amount)} SU.`,
        res,
        json,
      );
    } catch (err) {
      failWith(err, null, "Could not adjust.", undefined, { json });
    }
  });

// ---------------------------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------------------------

const STATUS_HELP = `
Shows what the Worker reads of the compute gateway, so the owner can check it once the secrets are
set. It changes nothing and prints booleans and fixed words only: never a secret value, an address,
a tenant name or a username.

  switches   the environment (production, development or other) and the two dark switches, each on
             only when it is exactly "1" in production or development
  Tapis      whether it is configured (and the names of what is missing), which credential strategy
             is chosen, and the result of ONE token mint and ONE health call made now: ok,
             unconfigured, skipped, or the kind of the error (unauthorized, not_found, rejected,
             unavailable, invalid_response)
  storage    whether each compute bucket binding and the signing secrets are set
  ACCESS key whether the ACCESS gateway-attributes key is set, and (a separate line) whether the
             ACCESS resource name is set; the ACCESS reports wait until both are
  prerequisites whether the callback secret and the API base address are set, whether NEMAR's
             pipelines service account is approved, whether an owner policy exists, and whether the
             people and pipelines platform pools have a grant; each is yes or no, never a value
  reconciliation whether the tenant sweep is paused, which it is while compute is off
  tenant     the ceiling on live jobs and how many slots are occupied, by class (people, pipelines,
             partner, other); other is jobs NEMAR did not admit, and a count above the ceiling (a job
             NEMAR did not admit, or a ceiling lowered below what is live) appears as the
             attention count tenant_over_ceiling
  attention  counts of things that need a person to look (for example ACCESS reports that failed,
             or policy_unreadable when the stored owner policy cannot be read, which stops every
             hold, run and limit until a valid version is written)
  runtime image whether the runtime image variable is set, whether it is a digest-pinned reference,
             and its digest (never the reference); a python job is not submitted until it is valid

Admin or owner. --json prints the Worker's answer as it is.

Exit codes:
  0  shown (a Tapis step that failed is shown as its word and still exits 0).
  1  the Worker refused (you are not an admin) or the read failed.`;

const yesNo = (value: boolean) => (value ? "yes" : "no");
const onOff = (value: boolean) => (value ? "on" : "off");

function printStatus(res: ComputeStatusResponse): void {
  say("Compute gateway status");
  say(`  environment: ${plain(res.switches.environment)}`);
  say(`  compute switch: ${onOff(res.switches.compute_enabled)}`);
  say(`  pipelines dispatch switch: ${onOff(res.switches.pipelines_dispatch_enabled)}`);
  say("Tapis");
  if (res.tapis.configured) {
    say(`  configured: yes (strategy ${plain(res.tapis.strategy ?? "unknown")})`);
  } else {
    const problems = res.tapis.problems.map(plain).join(", ");
    say(`  configured: no${problems ? ` (${problems})` : ""}`);
  }
  say(`  token: ${plain(res.tapis.token)}`);
  say(`  health: ${plain(res.tapis.health)}`);
  say("Storage");
  say(`  records binding: ${yesNo(res.storage.records_binding)}`);
  say(`  results binding: ${yesNo(res.storage.results_binding)}`);
  say(`  signing secrets: ${yesNo(res.storage.signing_configured)}`);
  say(`ACCESS key: ${yesNo(res.access.key_configured)}`);
  const resourceName = res.access.resource_name_configured;
  say(
    `ACCESS resource name: ${
      resourceName === undefined ? "unknown (this Worker does not report it)" : yesNo(resourceName)
    }`,
  );
  if (!res.access.key_configured || resourceName === false) {
    say("  ACCESS reports wait until both are set");
  }
  const need = res.prerequisites;
  say("Prerequisites");
  if (need === undefined) {
    say("  unknown (this Worker does not report them)");
  } else {
    say(`  callback secret: ${yesNo(need.callback_secret)}`);
    say(`  API base address: ${yesNo(need.api_base_url)}`);
    say(`  pipelines service account: ${yesNo(need.pipelines_account)}`);
    say(`  owner policy: ${need.policy_set ? "set" : "not set (the default applies)"}`);
    say(`  people pool granted: ${yesNo(need.people_pool_granted)}`);
    say(`  pipelines pool granted: ${yesNo(need.pipelines_pool_granted)}`);
  }
  if (res.reconciliation?.paused === true) {
    say(
      "Reconciliation paused: compute is off, so the tenant sweep does not run (no final settlement against Expanse, no failed ACCESS report listing, and no following of jobs nobody reserved)",
    );
  }
  const tenant = res.tenant;
  if (tenant !== undefined) {
    const c = tenant.by_class;
    say(
      `Tenant: ${tenant.occupied}/${tenant.ceiling} (people ${c.people}, pipelines ${c.pipelines}, partner ${c.partner}, other ${c.other})`,
    );
  }
  for (const [word, n] of Object.entries(res.attention ?? {})) {
    if (typeof n === "number" && n > 0) {
      say(`Attention: ${plain(word)} ${n}${ATTENTION_HINTS[word] ?? ""}`);
    }
  }
  say("Runtime image");
  const image = res.runtime_image;
  if (image === undefined) {
    say("  set: unknown (this Worker does not report it)");
  } else if (!image.set) {
    say("  set: no (a python job stays created until it is)");
  } else if (!image.valid) {
    say("  set: yes, but not a digest-pinned reference (a python job stays created)");
  } else {
    say(`  set: yes, digest ${plain(image.digest ?? "unknown")}`);
  }
}

const statusCommand = new Command("status")
  .description(
    "Show the compute switches, the Tapis connection and the storage, as the Worker reads them",
  )
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", STATUS_HELP)
  .action(async (o: { json?: boolean }) => {
    const json = o.json === true;
    if (!requireSignedIn(json)) return;
    try {
      const res = await getComputeStatus();
      if (json) console.log(JSON.stringify(res, null, 2));
      else printStatus(res);
    } catch (err) {
      failWith(err, null, "Could not read the compute status.", undefined, { json });
    }
  });

export const computeCommand = new Command("compute").description(
  "The compute gateway: the owner policy, the SU allocation pools, status, jobs and their reports, legal holds, the pipeline, the observer's token (ADR 0118), the runner registry and the derivative store (ADR 0123)",
);

computeCommand.addCommand(policyCommand);
computeCommand.addCommand(poolCommand);
computeCommand.addCommand(statusCommand);
computeCommand.addCommand(observerCommand);
computeCommand.addCommand(jobsCommand);
computeCommand.addCommand(pipelineCommand);
computeCommand.addCommand(runnersCommand);
computeCommand.addCommand(derivativesCommand);
