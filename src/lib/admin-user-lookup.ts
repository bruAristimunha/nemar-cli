/**
 * `nemar admin users show` and `edit`: turning what an admin typed into one
 * account, and one account into text (ADR 0096).
 *
 * Pure, so the rules are testable without a server. The commands in
 * commands/admin.ts own the I/O.
 *
 * EVERYTHING A USER TYPED IS SANITISED before it reaches the terminal. A name,
 * an affiliation, a city or a signup description is text a member controls, and
 * an escape sequence in one would run in an ADMIN's terminal the moment the
 * admin looked the account up (#1150; `sanitizeSnippetText` is the same
 * defence the dataset search results use).
 */

import chalk from "chalk";
import {
  type AdminUserDetail,
  type AdminUserEditBody,
  type AdminUserEditableField,
  MATCH_KINDS,
  type MatchKind,
} from "../../shared/contract/admin-user.js";
import type { UserListItem } from "./api/admin.js";
import { sanitizeSnippetText } from "./render/snippet.js";

/** User-controlled text, made safe to print: escape sequences, line breaks and
 *  control characters removed. */
function safe(value: string | null | undefined): string {
  return sanitizeSnippetText(value ?? "");
}

/**
 * The row's `match_kind` if it is one this CLI knows, else undefined. The wire
 * value is a plain string so a kind added later does not break an older CLI;
 * this is where it becomes the typed union, so a comparison with a misspelled
 * kind fails to compile instead of never matching.
 */
export function matchKindOf(user: UserListItem): MatchKind | undefined {
  const kind = user.match_kind;
  return typeof kind === "string" && (MATCH_KINDS as readonly string[]).includes(kind)
    ? (kind as MatchKind)
    : undefined;
}

/**
 * How well a lookup resolved. `exact` means the text IS an account's id,
 * username, email, GitHub handle or ORCID iD. `partial` means it was found by
 * searching. `fuzzy` means nothing matched and this is the nearest account (a
 * typo or an accent away).
 *
 * It matters most for `edit`: an edit confirmed with `--yes` against an account
 * the admin only half-named is how the wrong person is changed, so `-y` is
 * refused unless the match is `exact`.
 */
export type LookupMatch = "exact" | "partial" | "fuzzy";

export type LookupResolution =
  | { kind: "none" }
  | { kind: "one"; user: UserListItem; match: LookupMatch }
  | { kind: "many"; users: UserListItem[]; match: Exclude<LookupMatch, "exact"> };

/** The row the search named outright, if exactly one did. The SERVER decides
 *  what "named outright" means (`match_kind: "exact"`), through the same
 *  normalisers that store an email, a handle or an ORCID iD (ADR 0043), so
 *  there is one rule and this file does not carry a second copy of it. */
export function exactHit(users: readonly UserListItem[]): UserListItem | null {
  const hits = users.filter((user) => matchKindOf(user) === "exact");
  return hits.length === 1 ? hits[0] : null;
}

/** Every row is a near miss offered because nothing matched. */
export function allFuzzy(users: readonly UserListItem[]): boolean {
  return users.length > 0 && users.every((user) => matchKindOf(user) === "fuzzy");
}

/** Whether a search response came from a backend that knows how to search.
 *  A backend that predates `?q=` ignores it and returns every account, with
 *  none of the `match_kind` a search always sets, and printing that as the
 *  answer to a search would hand an admin the whole directory under a label that
 *  says otherwise. An empty answer proves nothing either way. */
export function searchWasUnderstood(users: readonly UserListItem[]): boolean {
  return users.length === 0 || users.some((user) => matchKindOf(user) !== undefined);
}

/**
 * Resolve the rows a search returned to at most one account.
 *
 * Several rows are narrowed to one only when exactly one of them is named
 * outright (searching `ada` returns `ada` and `adalovelace`; the first is what
 * was meant). Two exact hits ARE possible, across different columns: a
 * digits-only username equals another account's id, and a username can equal
 * another account's GitHub handle. The lookup then stays `many` rather than
 * guess, which is also why `edit -y` refuses both.
 */
export function resolveLookup(users: readonly UserListItem[]): LookupResolution {
  if (users.length === 0) return { kind: "none" };
  const exact = exactHit(users);
  if (exact) return { kind: "one", user: exact, match: "exact" };
  const match = allFuzzy(users) ? "fuzzy" : "partial";
  if (users.length === 1) return { kind: "one", user: users[0], match };
  return { kind: "many", users: [...users], match };
}

/** The CLI flag (Commander's camelCase name) behind each editable field. */
export const EDIT_FLAG_FIELDS = [
  ["givenName", "given_name"],
  ["familyName", "family_name"],
  ["affiliation", "affiliation"],
  ["city", "city"],
  ["country", "country"],
  ["username", "username"],
  ["github", "github_username"],
  ["email", "email"],
] as const;

/** Compile-time proof that every editable field has a flag. (That the flags are
 *  the ones declared on the command is a test: a flag is not a type.) */
export const _everyEditableFieldHasAFlag: AdminUserEditableField extends (typeof EDIT_FLAG_FIELDS)[number][1]
  ? true
  : never = true;

/**
 * The two fields that can be removed, and the flag that removes each. An empty
 * value is NOT how: `--github "$HANDLE"` with an unset variable would wipe the
 * handle, and under `-y` nothing would ask first.
 */
export const CLEAR_FLAGS = [
  { option: "clearAffiliation", valueOption: "affiliation", field: "affiliation" },
  { option: "clearGithub", valueOption: "github", field: "github_username" },
] as const;

/** `givenName` -> `--given-name`. */
export function flagName(option: string): string {
  return `--${option.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}`;
}

export type EditBodyResult = { ok: true; body: AdminUserEditBody } | { ok: false; message: string };

/**
 * Collect the fields an admin passed as flags, or say what is wrong with them.
 * A value that is empty once trimmed (for the GitHub handle, once a leading `@`
 * is also dropped) is refused, and the message names the flag that removes the
 * field when there is one.
 */
export function editBodyFromOptions(options: Record<string, unknown>): EditBodyResult {
  const body: Record<string, string> = {};
  for (const [option, field] of EDIT_FLAG_FIELDS) {
    const value = options[option];
    if (typeof value !== "string") continue;
    const meaningful = field === "github_username" ? value.trim().replace(/^@/, "") : value.trim();
    if (meaningful === "") {
      const clear = CLEAR_FLAGS.find((c) => c.valueOption === option);
      return {
        ok: false,
        message: clear
          ? `${flagName(option)} needs a value. To remove it, say so with ${flagName(clear.option)}.`
          : `${flagName(option)} needs a value.`,
      };
    }
    body[field] = value;
  }
  for (const { option, valueOption, field } of CLEAR_FLAGS) {
    if (options[option] !== true) continue;
    if (field in body) {
      return {
        ok: false,
        message: `Use either ${flagName(valueOption)} or ${flagName(option)}, not both.`,
      };
    }
    body[field] = "";
  }
  return { ok: true, body: body as AdminUserEditBody };
}

export interface PlannedChange {
  field: keyof AdminUserEditBody;
  from: string | null;
  to: string;
}

/**
 * What an edit will do, as far as the CLI can tell WITHOUT re-implementing the
 * server's normalisation (trimming, lower-casing an email, stripping `@`).
 * It compares the typed value with the stored one exactly; the server then
 * decides what is really a change and reports it, and that report, not this
 * preview, is what the command prints afterwards. A preview that guessed at
 * normalisation would be a second copy of those rules (ADR 0043).
 */
export function planEdit(current: AdminUserDetail, body: AdminUserEditBody): PlannedChange[] {
  const plan: PlannedChange[] = [];
  for (const [, field] of EDIT_FLAG_FIELDS) {
    const to = body[field];
    if (to === undefined) continue;
    const from = current[field] ?? null;
    if ((from ?? "") === to) continue;
    plan.push({ field, from, to });
  }
  return plan;
}

function show(value: string | null | undefined, whenEmpty = "-"): string {
  const text = safe(value);
  return text !== "" ? text : whenEmpty;
}

/** A value for the before/after lines: distinguishes "none" from "cleared". */
export function displayEditValue(value: string | null): string {
  if (value === null) return chalk.dim("(none)");
  if (value === "") return chalk.dim("(cleared)");
  return show(value, chalk.dim("(blank)"));
}

function formatWhen(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime())
    ? safe(value)
    : date.toISOString().replace("T", " ").slice(0, 16);
}

/** One account's details, one printable line each. */
export function userDetailLines(user: AdminUserDetail): string[] {
  const label = (name: string): string => chalk.dim(`${name}:`.padEnd(15));
  const realName = [user.given_name, user.family_name].filter(Boolean).join(" ");
  const location = [user.city, user.country].filter(Boolean).join(", ");
  const role = user.role || "member";
  const tier =
    user.service_access === undefined || user.service_access === null
      ? "unknown"
      : user.service_access
        ? "upload"
        : "browse";
  const lines: string[] = [];

  lines.push(
    `${chalk.cyan(show(user.username ?? user.email))}${chalk.dim(` [${safe(role)}]  id ${user.id}`)}${
      user.username === null ? chalk.dim("  (no username)") : ""
    }`,
  );
  lines.push(`  ${label("Name")}${show(realName)}`);
  lines.push(
    `  ${label("Email")}${show(user.email)} ${user.email_verified ? chalk.green("(verified)") : chalk.yellow("(unverified)")}`,
  );
  lines.push(
    `  ${label("GitHub")}${user.github_username ? `@${show(user.github_username)}` : "-"}`,
  );
  lines.push(
    `  ${label("ORCID")}${user.orcid ? `${show(user.orcid)} ${user.orcid_verified ? chalk.green("(verified)") : chalk.yellow("(unverified)")}` : "-"}`,
  );
  lines.push(`  ${label("Affiliation")}${show(user.affiliation)}`);
  lines.push(`  ${label("Location")}${show(location)}`);
  lines.push(`  ${label("Status")}${safe(user.status)}`);
  lines.push(
    `  ${label("Upload access")}${tier}${
      user.service_access && user.service_access_granted_at
        ? chalk.dim(
            ` (granted ${formatWhen(user.service_access_granted_at)}${
              user.service_access_granted_by ? ` by id ${user.service_access_granted_by}` : ""
            })`,
          )
        : ""
    }`,
  );
  if (user.upload_access_requested_at) {
    lines.push(`  ${label("Asked")}${formatWhen(user.upload_access_requested_at)} (upload access)`);
  }
  lines.push(`  ${label("Kind")}${safe(user.account_kind) || "-"}`);
  lines.push(`  ${label("Signed up via")}${show(user.signup_source)}`);
  lines.push(`  ${label("Created")}${formatWhen(user.created_at)}`);
  if (user.approved_at) lines.push(`  ${label("Approved")}${formatWhen(user.approved_at)}`);
  if (user.revoked_at) lines.push(`  ${label("Revoked")}${formatWhen(user.revoked_at)}`);
  lines.push(`  ${label("Last changed")}${formatWhen(user.updated_at)}`);
  lines.push(
    `  ${label("Datasets")}${user.dataset_count ?? "-"}${chalk.dim("   API keys: ")}${user.active_tokens ?? "-"}`,
  );
  lines.push(
    `  ${label("Sign-in")}${
      user.linked_identities && user.linked_identities.length > 0
        ? user.linked_identities.map((provider) => safe(provider)).join(", ")
        : "-"
    }`,
  );
  if (user.description) lines.push(`  ${label("Description")}${show(user.description)}`);

  // The conditions worth a line only when true, so a normal account reads clean.
  if (user.identity_conflict) {
    lines.push(
      `  ${chalk.yellow("! Flagged as a duplicate identity: see 'nemar admin duplicates'")}`,
    );
  }
  if (user.username_auto_assigned) {
    lines.push(`  ${chalk.dim("The username was derived from the name, not chosen")}`);
  }
  if (user.deleted_at) {
    lines.push(`  ${chalk.red(`Deleted ${formatWhen(user.deleted_at)} (tombstoned)`)}`);
  }
  return lines;
}

/** A candidate row for the "which one did you mean" list. */
export function candidateLine(user: UserListItem): string {
  const name = [user.given_name, user.family_name].filter(Boolean).join(" ");
  const matched =
    user.matched_in && user.matched_in.length > 0
      ? chalk.dim(`  matched: ${user.matched_in.map((column) => safe(column)).join(", ")}`)
      : "";
  return `  ${String(user.id).padStart(5)}  ${chalk.cyan(show(user.username, "(no username)"))}  ${show(name, "")}  ${chalk.dim(show(user.email))}${matched}`;
}
