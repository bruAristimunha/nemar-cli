/**
 * `nemar admin compute derivatives`: an administrator reads and raises the derivative store (portable compute,
 * card V1b; ADR 0123; plan D14).
 *
 *   nemar admin compute derivatives list [--dataset <id>] [--limit <n>] [--json]
 *   nemar admin compute derivatives show <key> [--json]
 *   nemar admin compute derivatives promote <key> [--to catalog|published] [--json]
 *   nemar admin compute derivatives sync [--max-objects <n>] [--json]
 *
 * A finished pipeline job's product is copied, server side, into a private bucket under a key that names what
 * the job read; this command lists those derivatives, shows one with its description, raises its retention
 * class one step, and runs one bounded pass of the store (which is what the production cron does daily, and
 * the only way a staging or local Worker advances it). Raising to `published` is the OWNER's alone; the Worker
 * decides that from the key's role, never this command. Nothing here lowers a class, deletes a derivative,
 * mints a DOI or reads an object's bytes. Every command takes `--json` (standard output stays pure JSON) and
 * exits 1 on any failure, and a Worker whose store is not bound answers `derivatives_unavailable`.
 */

import { Command } from "commander";
import { z } from "zod";
import { COMPUTE_DATASET_ID_RE } from "../../shared/contract/compute.js";
import { failMessage, failWith, requireSignedIn } from "../lib/admin-command.js";
import { request } from "../lib/api/client.js";
import { computeRefusalCode } from "../lib/api/compute.js";
import { YES_DESCRIPTION, YES_OPTION, confirm } from "../lib/confirm.js";
import { plain } from "../lib/terminal-text.js";

/** The most objects one sync may be asked to copy: the Worker's `DERIVATIVE_MAX_OBJECTS`, which it enforces. */
const MAX_OBJECTS = 150;

const say = (line: string): void => console.log(line);

/** A fixed word or a number from the Worker, made plain before it reaches a terminal. */
const word = (value: string | number | null): string => plain(value === null ? "-" : String(value));

const KEY_RE = /^[0-9a-f]{64}$/;

/** What the Worker's answers must hold; any other key it adds is kept and shown. */
const RowSchema = z
  .object({
    key: z.string(),
    dataset_id: z.string(),
    version: z.string(),
    recipe: z.string(),
    recipe_version: z.string(),
    input: z.string(),
    profile: z.string(),
    state: z.string(),
    retention: z.string(),
    failure: z.string().nullable(),
    copied: z.number(),
    object_count: z.number(),
    bytes: z.number(),
    created_at: z.string(),
    stored_at: z.string().nullable(),
    superseded_at: z.string().nullable(),
    expires_at: z.string().nullable(),
    doi: z.string().nullable(),
  })
  .passthrough();

type Row = z.infer<typeof RowSchema>;

const ListSchema = z.object({ derivatives: z.array(RowSchema) }).passthrough();
const ShowSchema = z.object({ derivative: RowSchema, description: z.unknown() }).passthrough();
const PromoteSchema = z.object({ ok: z.literal(true), derivative: RowSchema }).passthrough();
const SyncSchema = z
  .object({
    ok: z.literal(true),
    examined: z.number(),
    created: z.number(),
    duplicate: z.number(),
    derivative_unkeyable: z.record(z.string(), z.number()),
    copied: z.number(),
    stored: z.number(),
    failed: z.number(),
    expired: z.number(),
    deleted: z.number(),
    later: z.number(),
    errored: z.number(),
  })
  .passthrough();

const get = <T>(path: string, schema: z.ZodType<T>): Promise<T> => request(path, {}, true, schema);

const post = <T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> =>
  request(path, { method: "POST", body: JSON.stringify(body) }, true, schema);

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

/** The Worker's own refusal, with its word, or the failure of the request. */
function failRequest(err: unknown, json: boolean, what: string): void {
  const refusal = computeRefusalCode(err);
  if (refusal && err instanceof Error) {
    failMessage(`${err.message} (${word(refusal.code)})`, { json, answered: true });
    return;
  }
  failWith(err, null, what, undefined, { json });
}

function rowLine(r: Row): string {
  const stored = r.state === "copying" ? ` ${r.copied}/${r.object_count}` : "";
  const expires = r.expires_at === null ? "" : ` expires ${word(r.expires_at)}`;
  const failure = r.failure === null ? "" : ` ${word(r.failure)}`;
  return (
    `${word(r.key)}  ${word(r.dataset_id)} ${word(r.version)} ${word(r.recipe)} ${word(r.recipe_version)} ` +
    `${word(r.input)}  ${word(r.retention)}  ${word(r.state)}${stored}${failure}${expires}`
  );
}

const LIST_HELP = `
Lists derivatives of the store, newest first: the key (a name, not a secret), the dataset and version, the
recipe and its version, the input, the retention class (canary, catalog, published), the state (copying,
stored, failed, expired) and, when the row has one, the date it expires.

  --dataset <id>  only this dataset's derivatives
  --limit <n>     how many (default 50, at most 200)

Admin or owner. --json prints the Worker's answer as it is.

Exit codes:
  0  the list was printed.
  1  an option is wrong, or the Worker refused (derivatives_unavailable while the store is not bound) or could not be reached.`;

const SHOW_HELP = `
Shows one derivative: its row and, once it is stored, its description (derivative.json: the key text, what
generated it, the source dataset and version with its DOI when it has one, the profile and the citation).
The bytes of its files are never shown.

Admin or owner. --json prints the Worker's answer as it is.

Exit codes:
  0  it was printed.
  1  the key is wrong or unknown, or the Worker refused or could not be reached.`;

const PROMOTE_HELP = `
Raises a derivative's retention class one step, and never lowers one:

  --to catalog    (the default) a stored canary becomes catalog: it is kept until a later catalog derivative
                  of the same dataset, recipe, input and profile is promoted, and the earlier ones are then
                  superseded and expire 30 days after
  --to published  a stored catalog derivative becomes published, which never expires and is never deleted by
                  code, and which NOTHING can lower (the database refuses it too). ONLY AN OWNER may do
                  this (owner_only otherwise), and the command asks first (-y, --yes skips the question).
                  It makes no DOI: a DOI is a separate, owner-only action that does not exist yet

Admin or owner for catalog; owner for published. --json prints the Worker's answer as it is.

Exit codes:
  0  the derivative was raised.
  1  the key is wrong or unknown, the class is refused (not_promotable, owner_only), the question was not
     answered yes, or the Worker could not be reached.`;

const SYNC_HELP = `
Runs one bounded pass of the store: marks what is due expired and deletes its objects (a published derivative is
never touched), decides the succeeded pipeline stamps that have no derivative (a stamp that fails a check of
ADR 0123 is skipped and counted under its word), and copies at most --max-objects objects server side from
the results bucket. The production cron runs the same pass once a day with 100; a development or staging Worker
advances only through this command.

  --max-objects <n>  objects copied at most (default 100, at most 150); deleting has a bound of its own

Admin or owner. --json prints the Worker's answer as it is.

Exit codes:
  0  the pass ran (its counts were printed, even when nothing was left to do).
  1  an option is wrong, or the Worker refused (derivatives_unavailable while the store is not bound) or could not be reached.`;

export const derivativesCommand = new Command("derivatives").description(
  "Read and raise the derivative store of pipeline products (admin)",
);

derivativesCommand
  .command("list")
  .description("List derivatives, newest first")
  .option("--dataset <id>", "Only this dataset")
  .option("--limit <n>", "How many (default 50, at most 200)")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", LIST_HELP)
  .action(async (o: { dataset?: string; limit?: string; json?: boolean }) => {
    const json = o.json === true;
    if (!requireSignedIn(json)) return;
    if (o.dataset !== undefined && !COMPUTE_DATASET_ID_RE.test(o.dataset)) {
      failMessage(`"${o.dataset}" is not a dataset id (like nm000104).`, { json, answered: true });
      return;
    }
    const params = new URLSearchParams();
    if (o.dataset !== undefined) params.set("dataset", o.dataset);
    if (o.limit !== undefined) {
      const limit = wholeNumber(o.limit, "--limit", 1, 200, json);
      if (limit === null) return;
      params.set("limit", String(limit));
    }
    try {
      const query = params.toString();
      const res = await get(`/admin/compute/derivatives${query ? `?${query}` : ""}`, ListSchema);
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      if (res.derivatives.length === 0) say("No derivatives.");
      for (const r of res.derivatives) say(rowLine(r));
    } catch (err) {
      failRequest(err, json, "Could not list the derivatives.");
    }
  });

derivativesCommand
  .command("show <key>")
  .description("Show one derivative and its description")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", SHOW_HELP)
  .action(async (key: string, o: { json?: boolean }) => {
    const json = o.json === true;
    if (!requireSignedIn(json)) return;
    if (!KEY_RE.test(key)) {
      failMessage("A derivative key is 64 lowercase hexadecimal digits.", { json, answered: true });
      return;
    }
    try {
      const res = await get(`/admin/compute/derivatives/${key}`, ShowSchema);
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      const r = res.derivative;
      say(rowLine(r));
      say(
        `  created ${word(r.created_at)}, stored ${word(r.stored_at)}, ${r.object_count} files, ${r.bytes} bytes`,
      );
      if (r.superseded_at !== null) say(`  superseded ${word(r.superseded_at)}`);
      const d = res.description as { Citation?: unknown; Description?: unknown } | null;
      if (d && typeof d.Citation === "string") say(`  ${plain(d.Citation)}`);
      if (d && typeof d.Description === "string") say(`  ${plain(d.Description)}`);
      if (!d) say("  (no description yet: it is written when the copy is whole)");
    } catch (err) {
      failRequest(err, json, "Could not read the derivative.");
    }
  });

derivativesCommand
  .command("promote <key>")
  .description("Raise a derivative's retention class one step (published is the owner's)")
  .option("--to <class>", "catalog (the default) or published")
  .option(YES_OPTION, YES_DESCRIPTION)
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", PROMOTE_HELP)
  .action(async (key: string, o: { to?: string; yes?: boolean; json?: boolean }) => {
    const json = o.json === true;
    if (!requireSignedIn(json)) return;
    const klass = o.to ?? "catalog";
    if (klass !== "catalog" && klass !== "published") {
      failMessage("--to is catalog or published.", { json, answered: true });
      return;
    }
    if (!KEY_RE.test(key)) {
      failMessage("A derivative key is 64 lowercase hexadecimal digits.", { json, answered: true });
      return;
    }
    // Nothing can lower a published derivative, and no code ever deletes it: ask before raising to it.
    if (klass === "published") {
      const answer = await confirm(
        `Raise ${key} to published? It will never expire, and nothing can lower it or delete it.`,
        { yes: o.yes },
      );
      if (answer !== "confirmed") {
        failMessage("Nothing was changed: the question was not answered yes (use --yes).", {
          json,
          answered: true,
        });
        return;
      }
    }
    try {
      const res = await post(
        `/admin/compute/derivatives/${key}/retention`,
        { class: klass },
        PromoteSchema,
      );
      if (json) console.log(JSON.stringify(res, null, 2));
      else say(`raised to ${word(res.derivative.retention)}: ${rowLine(res.derivative)}`);
    } catch (err) {
      failRequest(err, json, "Could not raise the derivative.");
    }
  });

derivativesCommand
  .command("sync")
  .description("Run one bounded pass of the store")
  .option("--max-objects <n>", "Objects copied at most (default 100, at most 150)")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", SYNC_HELP)
  .action(async (o: { maxObjects?: string; json?: boolean }) => {
    const json = o.json === true;
    if (!requireSignedIn(json)) return;
    const body: { max_objects?: number } = {};
    if (o.maxObjects !== undefined) {
      const n = wholeNumber(o.maxObjects, "--max-objects", 1, MAX_OBJECTS, json);
      if (n === null) return;
      body.max_objects = n;
    }
    try {
      const res = await post("/admin/compute/derivatives/sync", body, SyncSchema);
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      say(
        `examined ${res.examined}: created ${res.created}, duplicate ${res.duplicate}; ` +
          `copied ${res.copied}, stored ${res.stored}, failed ${res.failed}; ` +
          `expired ${res.expired}, deleted ${res.deleted}; later ${res.later}, errored ${res.errored}`,
      );
      for (const [w, n] of Object.entries(res.derivative_unkeyable)) {
        say(`  skipped ${n} as ${word(w)}`);
      }
    } catch (err) {
      failRequest(err, json, "Could not run the derivative store.");
    }
  });
