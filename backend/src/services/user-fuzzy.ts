/**
 * How an admin account search is ranked, which hit is "the" account, and what
 * to offer when nothing matches (ADR 0096).
 *
 * Three behaviours of an ordinary search, in the order a person meets them:
 *
 *   1. EXACT HIT. Text that IS an account's id, username, email, GitHub handle
 *      or ORCID iD names that account. The CLI goes straight to it.
 *   2. RANKED PARTIAL HITS. Everything else the substring search found, ordered
 *      by how well it matches: whole name words, then word prefixes, then a
 *      substring anywhere.
 *   3. CLOSE MATCHES. Only when nothing matched at all: names that are one or
 *      two typos away (`lovelase` for Lovelace), or differ by accents
 *      (`ekstrom` for Ekström). The substring search cannot do either, because
 *      SQLite folds ASCII case and nothing else and has no edit distance.
 *
 * Pure functions over rows already read, so the rules are testable without a
 * database. The fuzzy pass reads only {@link FUZZY_COLUMNS}, all of them
 * ordinary text columns; a test pins that none is a secret.
 */

import type { MatchKind } from "../../../shared/contract/admin-user.js";
import { normalizeEmail, normalizeGithubHandle, normalizeOrcid } from "./identity";
import { type ColumnsOf, EXACT_IDENTIFIER_COLUMNS } from "./user-search";

export type { MatchKind };

const MATCH_KIND_RANK: Readonly<Record<MatchKind, number>> = {
  exact: 0,
  name: 1,
  prefix: 2,
  substring: 3,
  fuzzy: 4,
};

/**
 * Lower-case and strip accents (`Ekström` -> `ekstrom`). NFD splits a letter
 * from its combining mark and the second pass drops the mark. Unlike
 * `username.ts`'s `asciiFold` this keeps every other character, because it is
 * comparing words and not building a handle.
 */
export function fold(value: string): string {
  // \p{M} is any combining mark, which is exactly what NFD split off.
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The folded alphanumeric words of a value (`ada-lovelace@lab.org` ->
 *  `ada`, `lovelace`, `lab`, `org`). */
export function wordsOf(value: string | null | undefined): string[] {
  if (!value) return [];
  return fold(value)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

/** The columns a search result is classified from. All are in the listing's
 *  SELECT (`LISTING_COLUMNS` in routes/admin/users.ts, which is typed against
 *  this), so ranking costs no extra read. Every one is required: an optional
 *  field would let a column dropped from that SELECT turn exact hits and name
 *  ranking off without a single error. */
export type RankableUser = {
  id: number;
  username: string | null;
  email: string;
  github_username: string | null;
  orcid: string | null;
  given_name: string | null;
  family_name: string | null;
};

/**
 * Every spelling of the query that could equal a stored identifier: as typed,
 * a GitHub handle written `@name`, an ORCID iD written as a URL, an email in
 * any case. Reuses the write-side normalisers (ADR 0043), so "is this the same
 * identifier" has one answer whether it is being stored or looked up.
 */
export function identityKeys(query: string): string[] {
  const keys = new Set<string>();
  const trimmed = query.trim();
  if (trimmed === "") return [];
  keys.add(trimmed.toLowerCase());
  keys.add(normalizeGithubHandle(trimmed).toLowerCase());
  keys.add(normalizeEmail(trimmed));
  const orcid = normalizeOrcid(trimmed);
  if (orcid) keys.add(orcid.toLowerCase());
  return [...keys];
}

/** The identifier columns an exact hit can be on, in the order they are shown:
 *  the id, then the columns the exact-hit SQL looks in (one list, in
 *  ./user-search.ts). */
const IDENTIFIER_COLUMNS = ["id", ...EXACT_IDENTIFIER_COLUMNS] as const;

/**
 * The identifier columns of this account that the query IS, empty when it is
 * none of them. An exact hit is found by this and not by the substring search:
 * `@ada-gh` and an ORCID URL are not substrings of anything stored, yet each
 * names an account outright.
 */
export function exactColumns(query: string, user: RankableUser): string[] {
  const keys = new Set(identityKeys(query));
  if (keys.size === 0) return [];
  return IDENTIFIER_COLUMNS.filter((column) => {
    const value = user[column];
    const identifier = typeof value === "number" ? String(value) : value;
    return typeof identifier === "string" && keys.has(identifier.trim().toLowerCase());
  });
}

/** Whether the query IS one of this account's identifiers. */
export function namesAccountOutright(query: string, user: RankableUser): boolean {
  return exactColumns(query, user).length > 0;
}

/**
 * Classify an account the substring search already matched. `terms` are the
 * search words as {@link parseSearchTerms} produced them.
 *
 *   exact      the whole query is an identifier of the account.
 *   name       every word is a whole word of the person's name or username.
 *   prefix     every word begins a word of the name, username, email or handle.
 *   substring  anything else the search found (a middle of a word, a date, an
 *              affiliation, an ORCID digit run).
 */
export function classifyStrictMatch(
  query: string,
  terms: readonly string[],
  user: RankableUser,
): Exclude<MatchKind, "fuzzy"> {
  if (namesAccountOutright(query, user)) return "exact";
  const wanted = terms.map(fold);
  const nameWords = [
    ...wordsOf(user.given_name),
    ...wordsOf(user.family_name),
    ...wordsOf(user.username),
  ];
  if (wanted.every((term) => nameWords.includes(term))) return "name";
  const startWords = [...nameWords, ...wordsOf(user.email), ...wordsOf(user.github_username)];
  if (wanted.every((term) => startWords.some((word) => word.startsWith(term)))) return "prefix";
  return "substring";
}

/** Stable: rows of equal kind keep their incoming order (newest first). */
export function sortByMatchKind<T extends { match_kind: MatchKind }>(rows: T[]): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        MATCH_KIND_RANK[a.row.match_kind] - MATCH_KIND_RANK[b.row.match_kind] || a.index - b.index,
    )
    .map(({ row }) => row);
}

// ---------------------------------------------------------------------------
// Close matches
// ---------------------------------------------------------------------------

/**
 * The fields close matching reads: how a person is named and where they are.
 * Deliberately NOT dates, status or role (a typo of `2026-09` or `admin` is
 * noise), the ORCID iD (a near-miss digit string names someone else), or the
 * free-text description. Every entry must be a `text` column in
 * `USER_COLUMN_ROLES`, which `satisfies` makes the compiler check; a test pins
 * the exact list so adding a column here is a decision someone sees.
 */
export const FUZZY_COLUMNS = [
  "username",
  "email",
  "github_username",
  "given_name",
  "family_name",
  "affiliation",
  "city",
  "country",
] as const satisfies readonly ColumnsOf<"text">[];
export type FuzzyColumn = (typeof FUZZY_COLUMNS)[number];

/** A close-match pass never returns more than this many accounts: it is a
 *  suggestion, and a loose one should not read like a directory. */
export const FUZZY_MAX_RESULTS = 20;

/**
 * Typos allowed in a search word, by its length. Words of three characters or
 * fewer get none: one edit turns `ada` into `ana`, `eda`, `adam`, and the
 * suggestions stop meaning anything.
 */
export function fuzzyBudget(length: number): number {
  if (length <= 3) return 0;
  if (length <= 6) return 1;
  return 2;
}

/**
 * Optimal string alignment distance (insert, delete, substitute, and swap two
 * neighbours, so `lovelcae` is ONE edit from `lovelace`), or `max + 1` as soon
 * as it cannot be within `max`.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a === b) return 0;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    rows.push(new Array<number>(b.length + 1).fill(0));
    rows[i][0] = i;
  }
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Number.POSITIVE_INFINITY;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, rows[i - 2][j - 2] + 1);
      }
      rows[i][j] = d;
      rowMin = Math.min(rowMin, d);
    }
    if (rowMin > max) return max + 1;
  }
  return Math.min(rows[a.length][b.length], max + 1);
}

/** The closest a (folded) word gets to a search word: exactly, by prefix or
 *  substring (distance 0), or by edits to the whole word or to its leading
 *  stretch, which is how a typo in a PARTIAL word (`lovelse` for `Lovelace`)
 *  is still caught. */
function closestDistance(term: string, word: string, budget: number): number {
  if (word.includes(term)) return 0;
  if (budget === 0) return budget + 1;
  let best = editDistance(term, word, budget);
  if (word.length > term.length) {
    for (const length of [term.length - 1, term.length, term.length + 1]) {
      if (length > 0 && length < word.length) {
        best = Math.min(best, editDistance(term, word.slice(0, length), budget));
      }
    }
  }
  return best;
}

export interface FuzzyScore {
  /** Total edits across the search words; lower is closer. */
  score: number;
  /** The columns the words matched in. */
  fields: FuzzyColumn[];
}

/**
 * How close an account is to ALL the search words, or null if any word has
 * nothing within its typo budget. A word is compared with each word of each
 * {@link FUZZY_COLUMNS} value and with the whole value, so `ada@lab.og` can
 * still find `ada@lab.org`. Accents and case are folded on both sides.
 */
export function scoreClose(
  terms: readonly string[],
  row: Readonly<Record<string, unknown>>,
): FuzzyScore | null {
  const candidates: Array<{ column: FuzzyColumn; words: string[] }> = FUZZY_COLUMNS.map(
    (column) => {
      const value = row[column];
      const text = typeof value === "string" ? value : "";
      return { column, words: [...new Set([...wordsOf(text), ...(text ? [fold(text)] : [])])] };
    },
  );

  let score = 0;
  const fields = new Set<FuzzyColumn>();
  for (const raw of terms) {
    const term = fold(raw);
    const budget = fuzzyBudget(term.length);
    let best = budget + 1;
    let bestColumns: FuzzyColumn[] = [];
    for (const { column, words } of candidates) {
      for (const word of words) {
        const distance = closestDistance(term, word, budget);
        if (distance < best) {
          best = distance;
          bestColumns = [column];
        } else if (distance === best && distance <= budget && !bestColumns.includes(column)) {
          bestColumns.push(column);
        }
      }
    }
    if (best > budget) return null;
    score += best;
    for (const column of bestColumns) fields.add(column);
  }
  return { score, fields: FUZZY_COLUMNS.filter((column) => fields.has(column)) };
}

/** The accounts nearest the search words, closest first, newest first among
 *  equals (the incoming order), capped at {@link FUZZY_MAX_RESULTS}. */
export function closestAccounts<T extends Record<string, unknown>>(
  terms: readonly string[],
  rows: readonly T[],
): Array<T & { match_kind: "fuzzy"; matched_in: FuzzyColumn[] }> {
  const scored: Array<{ row: T; index: number; close: FuzzyScore }> = [];
  rows.forEach((row, index) => {
    const close = scoreClose(terms, row);
    if (close) scored.push({ row, index, close });
  });
  scored.sort((a, b) => a.close.score - b.close.score || a.index - b.index);
  return scored.slice(0, FUZZY_MAX_RESULTS).map(({ row, close }) => ({
    ...row,
    match_kind: "fuzzy" as const,
    matched_in: close.fields,
  }));
}
