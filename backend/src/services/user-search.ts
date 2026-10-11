/**
 * Admin account search and the columns an admin may read (ADR 0096).
 *
 * `GET /admin/users?q=` has to look at "all fields" of an account without
 * becoming an oracle for the fields that must never be read, and it has to stay
 * true as the table grows. Both come from ONE classification of every `users`
 * column, {@link USER_COLUMN_ROLES}; the search SQL, the detail SELECT and the
 * test that fails on an unclassified column are all derived from it. A column
 * added by a migration with no entry here fails the "column classification"
 * block of `backend/test/admin-user-search-route.test.ts` until someone decides
 * what it is.
 *
 * WHY ONE HAYSTACK AND NOT A CONDITION PER COLUMN. "Is this word anywhere in the
 * account" is one expression over one lower-cased string of the searchable
 * columns, not a run of about 25 `OR`s per word. A word is looked for with
 * `instr()` rather than `LIKE`, so `%` and `_` in what the admin types are
 * ordinary characters and need no escaping. D1's limit of 100 bound parameters
 * per statement is met a different way: by numbering. A word is bound once as
 * `?N` and that placeholder is reused wherever the word appears, so a search
 * costs one parameter per word however many columns it covers.
 *
 * MATCHING. Every word must be found somewhere in the account (AND), in any
 * column, so `ada lovelace` finds given name Ada with family name Lovelace and
 * `ucsd 2026-09` finds an affiliation plus any date in September 2026 (created,
 * approved, revoked, ...). Case-insensitive for ASCII only, exactly like SQLite's
 * `LIKE`: the stored text is folded by SQLite's `lower()` and the word by the
 * same ASCII-only rule in {@link parseSearchTerms}, so `Ekström` is found by
 * `ekström` but not by `EKSTRÖM`. (When nothing matches, the close-match pass in
 * ./user-fuzzy.ts does fold accents.)
 */

import {
  ADMIN_USER_SEARCH_MAX_TERMS,
  ADMIN_USER_SEARCH_MAX_TERM_CHARS,
} from "../../../shared/contract/admin-user.js";

/**
 * What a `users` column is to the admin lookup.
 *
 *   id      the primary key. Matched exactly, and only by a purely numeric word.
 *   text    searched (as a substring) and returned. Everything an admin would
 *           read off an account.
 *   flag    returned, NOT searched. A 0/1 column searched as text makes the word
 *           `1` match every account; the tier and status filters
 *           (`--verified`, `--no-upload-access`, ...) are how flags are asked for.
 *   ref     returned, NOT searched. A numeric pointer to another user, which as
 *           text would match unrelated rows.
 *   secret  NEVER searched and NEVER returned. A credential, a hash, a token, or
 *           the expiry that belongs to one. Searching a secret is an oracle: an
 *           admin could recover a hash prefix by prefix from the match count.
 *   omit    neither searched nor returned. Not a secret; just not account
 *           detail (the notification preferences have their own route).
 */
export type UserColumnRole = "id" | "text" | "flag" | "ref" | "secret" | "omit";

/**
 * Every column of `users`, classified. Keep in step with the migrations; the
 * test compares this table's keys with `PRAGMA table_info(users)` on a fully
 * migrated database, in both directions.
 */
export const USER_COLUMN_ROLES = {
  id: "id",

  username: "text",
  email: "text",
  github_username: "text",
  orcid: "text",
  given_name: "text",
  family_name: "text",
  affiliation: "text",
  city: "text",
  country: "text",
  description: "text",
  status: "text",
  role: "text",
  account_kind: "text",
  signup_source: "text",
  aws_iam_username: "text",
  sandbox_dataset_id: "text",
  created_at: "text",
  updated_at: "text",
  approved_at: "text",
  revoked_at: "text",
  deleted_at: "text",
  sandbox_completed_at: "text",
  service_access_granted_at: "text",
  upload_access_requested_at: "text",
  upload_access_notified_at: "text",

  email_verified: "flag",
  orcid_verified: "flag",
  service_access: "flag",
  sandbox_completed: "flag",
  identity_conflict: "flag",
  username_auto_assigned: "flag",

  service_access_granted_by: "ref",

  password_hash: "secret",
  verification_token: "secret",
  verification_expires_at: "secret",
  aws_access_key_id_encrypted: "secret",
  aws_secret_access_key_encrypted: "secret",

  email_preferences: "omit",
} as const satisfies Record<string, UserColumnRole>;

/** A column of `users`, as the classification above spells it. Anything that
 *  names a column and wants the compiler to check it uses this. */
export type UserColumn = keyof typeof USER_COLUMN_ROLES;

/** The columns the classification gives role `R`. */
export type ColumnsOf<R extends UserColumnRole> = {
  [K in UserColumn]: (typeof USER_COLUMN_ROLES)[K] extends R ? K : never;
}[UserColumn];

function columnsWithRole<R extends UserColumnRole>(...roles: R[]): ColumnsOf<R>[] {
  // The one cast: Object.entries widens the keys to string. Filtering by the
  // very table the type is derived from is what makes it sound.
  return (Object.entries(USER_COLUMN_ROLES) as Array<[UserColumn, UserColumnRole]>)
    .filter(([, role]) => (roles as UserColumnRole[]).includes(role))
    .map(([column]) => column) as ColumnsOf<R>[];
}

/** Columns searched as text, in the order they are checked and reported. */
export const USER_SEARCH_TEXT_COLUMNS: readonly ColumnsOf<"text">[] = columnsWithRole("text");

/** Columns that must never be searched or returned. */
export const USER_SECRET_COLUMNS: readonly ColumnsOf<"secret">[] = columnsWithRole("secret");

/**
 * The columns an exact hit can be on besides the id: the identifiers a person
 * is looked up by. The SQL that finds an exact hit and the code that labels one
 * (./user-fuzzy.ts) both read this list, so they cannot disagree.
 */
export const EXACT_IDENTIFIER_COLUMNS = [
  "username",
  "email",
  "github_username",
  "orcid",
] as const satisfies readonly ColumnsOf<"text">[];

/**
 * The `SELECT` list for one account's details, prefixed with the table alias
 * `u`. An explicit list, never `u.*`: `SELECT *` is how a credential column
 * added next year, or the ones added years ago, ends up in an admin's terminal.
 */
export const ADMIN_USER_DETAIL_SELECT: string = columnsWithRole("id", "text", "flag", "ref")
  .map((column) => `u.${column}`)
  .join(", ");

/**
 * Every column that is NOT a secret, prefixed `u.`: {@link ADMIN_USER_DETAIL_SELECT}
 * plus the `omit` columns (today the notification preferences).
 *
 * For the older username-keyed `GET /admin/users/:username`, which has always
 * returned the whole row. The fix for it removes the credentials and nothing
 * else, so a caller reading a non-secret column from it keeps working; new
 * routes use the narrower list above.
 */
export const ADMIN_USER_NON_SECRET_SELECT: string = columnsWithRole(
  "id",
  "text",
  "flag",
  "ref",
  "omit",
)
  .map((column) => `u.${column}`)
  .join(", ");

/**
 * Columns whose SEARCHABLE value is not the stored one. A member's `role` may be
 * NULL (nothing forbids it, and `GET /admin/users?role=member` already treats
 * NULL as a member), and every surface calls that account a member, so the word
 * `member` must find it.
 */
const SEARCH_VALUE_SQL: Readonly<Partial<Record<UserColumn, string>>> = {
  role: "COALESCE(role, 'member')",
};

function valueSql(column: UserColumn): string {
  return SEARCH_VALUE_SQL[column] ?? column;
}

/** One lower-cased string of every searchable column, with an unprintable
 *  separator (U+001F) so a word can never match across two fields. */
const HAYSTACK_SQL = `lower(${USER_SEARCH_TEXT_COLUMNS.map(
  (column) => `COALESCE(${valueSql(column)}, '')`,
).join(" || char(31) || ")})`;

export type SearchTermsResult = { ok: true; terms: string[] } | { ok: false; message: string };

/**
 * Split what the admin typed into search words. Whitespace separates words; no
 * quoting is supported because AND-ing the words already finds a phrase.
 *
 * Folds ASCII case only (see the file header) so the word and the haystack are
 * lower-cased by the same rule. `String.prototype.toLowerCase()` would also fold
 * `É`, which SQLite's `lower()` leaves alone, and the word would then never
 * match the stored text it was typed from.
 */
export function parseSearchTerms(q: string): SearchTermsResult {
  const terms = q
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => word.replace(/[A-Z]/g, (ch) => ch.toLowerCase()));
  if (terms.length === 0) {
    return { ok: false, message: "Enter at least one word to search for" };
  }
  if (terms.length > ADMIN_USER_SEARCH_MAX_TERMS) {
    return {
      ok: false,
      message: `Search takes at most ${ADMIN_USER_SEARCH_MAX_TERMS} words; narrow it with a filter such as --role or --kind instead`,
    };
  }
  const tooLong = terms.find((word) => word.length > ADMIN_USER_SEARCH_MAX_TERM_CHARS);
  if (tooLong !== undefined) {
    return {
      ok: false,
      message: `Each search word must be at most ${ADMIN_USER_SEARCH_MAX_TERM_CHARS} characters`,
    };
  }
  return { ok: true, terms };
}

/** A purely numeric word may also be an account id. */
const NUMERIC_TERM_RE = /^\d{1,15}$/;

export interface UserSearchSql {
  /** A boolean SQL expression: true when every word is found in the account. */
  where: string;
  /** A SQL expression yielding the matching column names, space separated. */
  matchedIn: string;
}

/**
 * Build the WHERE condition and the "found in" expression for a set of words.
 *
 * `bind` registers one word and returns its numbered placeholder (`?3`). The
 * placeholder is reused wherever the word appears, so a search costs one bound
 * parameter per word however many columns it covers. The caller should use
 * numbered placeholders for every other parameter of the same statement too:
 * a bare `?` takes the number after the highest one so far, which silently
 * collides with a numbered placeholder that is reused later.
 */
export function buildUserSearchSql(
  terms: readonly string[],
  bind: (term: string) => string,
): UserSearchSql {
  const placeholders = terms.map((term) => ({ term, p: bind(term) }));
  const numeric = placeholders.filter(({ term }) => NUMERIC_TERM_RE.test(term));

  const where = placeholders
    .map(({ term, p }) =>
      NUMERIC_TERM_RE.test(term)
        ? `(instr(${HAYSTACK_SQL}, ${p}) > 0 OR id = CAST(${p} AS INTEGER))`
        : `instr(${HAYSTACK_SQL}, ${p}) > 0`,
    )
    .join(" AND ");

  const parts: string[] = [];
  if (numeric.length > 0) {
    const cond = numeric.map(({ p }) => `id = CAST(${p} AS INTEGER)`).join(" OR ");
    parts.push(`CASE WHEN ${cond} THEN 'id ' ELSE '' END`);
  }
  for (const column of USER_SEARCH_TEXT_COLUMNS) {
    const cond = placeholders
      .map(({ p }) => `instr(lower(COALESCE(${valueSql(column)}, '')), ${p}) > 0`)
      .join(" OR ");
    parts.push(`CASE WHEN ${cond} THEN '${column} ' ELSE '' END`);
  }

  return { where, matchedIn: `TRIM(${parts.join(" || ")})` };
}

/**
 * A condition that is true for the account(s) whose id, username, email, GitHub
 * handle or ORCID iD equals one of `keys` (already normalised and lower-cased by
 * `identityKeys`), or null when there are no keys.
 *
 * This is OR-ed with the substring search rather than left to it, because an
 * identifier written the way people paste it (`@name`, an ORCID URL) is not a
 * substring of anything stored and the substring search alone would miss the
 * one account that query names outright. Each key costs one bound parameter.
 */
export function buildExactIdentifierSql(
  keys: readonly string[],
  bind: (term: string) => string,
): string | null {
  if (keys.length === 0) return null;
  const list = keys.map(bind).join(", ");
  const conditions = [
    ...EXACT_IDENTIFIER_COLUMNS.map((column) => `lower(COALESCE(${column}, '')) IN (${list})`),
    `CAST(id AS TEXT) IN (${list})`,
  ];
  return `(${conditions.join("\n    OR ")})`;
}

/** `matched_in` as it comes back from SQL (space separated) to the wire array. */
export function splitMatchedIn(value: unknown): string[] {
  return typeof value === "string" ? value.split(" ").filter((name) => name.length > 0) : [];
}
