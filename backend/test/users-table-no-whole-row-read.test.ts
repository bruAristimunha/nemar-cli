/**
 * No code selects a whole row of `users` (ADR 0096).
 *
 * `users` carries credential columns (`password_hash`, `verification_token`, the
 * encrypted AWS pair). A query that selects the whole row hands every one of
 * them to whatever serialises the result, and `GET /admin/users/:username` did
 * exactly that for any admin until this guard's change. The fix is an explicit
 * column list; this test keeps the pattern from coming back anywhere in the
 * backend by scanning for it.
 *
 * A source scan, because the thing being forbidden is a SHAPE OF QUERY and no
 * route test can know which route will be written next. Comments are removed
 * first so a sentence explaining the rule does not trip it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "migrations" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** The code with block comments and whole-line `//` comments removed. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

// A whole row of `users` is read by:
//   1. `SELECT * ...` whose outer FROM / JOIN includes users,
//   2. `SELECT x.* ...` where x is users or the alias users was given there,
//   3. `UPDATE|INSERT INTO|DELETE FROM users ... RETURNING *`.
//
// Found by walking each statement's OUTER tables (parenthesis depth 0), not by
// one regex: that is what lets `SELECT d.*, (SELECT username FROM users ...)
// FROM datasets d` through (it reads one column of users) while still catching
// `SELECT *, (SELECT ...) AS n FROM users`, which a "star then FROM users"
// pattern would miss, and `main.users`, a quoted "users" and `users.*`.
const SELECT_STAR = /\bSELECT\s+(?:DISTINCT\s+)?((?:["`]?\w+["`]?\.)?\*)/gi;
const TABLE_REF = /([()])|\b(?:FROM|JOIN)\s+(?:main\.)?["`[]?(\w+)["`\]]?(?:\s+(?:AS\s+)?(\w+))?/gi;
const NOT_AN_ALIAS = new Set(
  "WHERE JOIN LEFT RIGHT INNER OUTER CROSS FULL NATURAL ON USING GROUP ORDER HAVING LIMIT UNION RETURNING SET".split(
    " ",
  ),
);
const RETURNING_STAR_OF_USERS =
  /\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(?:main\.)?["`[]?users["`\]]?\b[^;`]*?\bRETURNING\s+\*/i;

/** The tables named by FROM and JOIN at the statement's own level. */
function outerTables(
  statement: string,
  from: number,
): Array<{ table: string; alias: string | null }> {
  const tables: Array<{ table: string; alias: string | null }> = [];
  const re = new RegExp(TABLE_REF.source, "gi");
  re.lastIndex = from;
  let depth = 0;
  for (let m = re.exec(statement); m; m = re.exec(statement)) {
    if (m[1] === "(") depth++;
    else if (m[1] === ")") {
      depth--;
      if (depth < 0) break;
    } else if (depth === 0) {
      const alias = m[3] && !NOT_AN_ALIAS.has(m[3].toUpperCase()) ? m[3].toLowerCase() : null;
      tables.push({ table: m[2].toLowerCase(), alias });
    }
  }
  return tables;
}

/** Where the statement's own FROM is: the first one at parenthesis depth 0. */
function outerFromIndex(statement: string, from: number): number {
  const re = /([()])|\bFROM\b/gi;
  re.lastIndex = from;
  let depth = 0;
  for (let m = re.exec(statement); m; m = re.exec(statement)) {
    if (m[1] === "(") depth++;
    else if (m[1] === ")") {
      depth--;
      if (depth < 0) return -1;
    } else if (depth === 0) return m.index;
  }
  return -1;
}

function readsWholeUserRow(source: string): boolean {
  if (RETURNING_STAR_OF_USERS.test(source)) return true;
  for (const m of source.matchAll(SELECT_STAR)) {
    // The statement ends at a `;` or at the template literal's closing backtick.
    const statement = source.slice(m.index).split(/[;`]/)[0];
    const fromIndex = outerFromIndex(statement, m[0].length);
    if (fromIndex < 0) continue;
    const tables = outerTables(statement, fromIndex);
    const qualifier = m[1].includes(".")
      ? m[1].split(".")[0].replace(/["`]/g, "").toLowerCase()
      : null;
    const leaks = tables.some(
      ({ table, alias }) =>
        table === "users" &&
        (qualifier === null || qualifier === "users" || (alias !== null && alias === qualifier)),
    );
    if (leaks) return true;
  }
  return false;
}

describe("no query reads a whole row of users", () => {
  const files = sourceFiles(SRC);

  test("the scan covers the backend (guards a vacuous pass)", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith(join("routes", "admin", "users.ts")))).toBe(true);
  });

  test("the pattern catches the shapes it exists to forbid", () => {
    for (const bad of [
      "SELECT * FROM users WHERE id = ?",
      "SELECT u.* FROM users u",
      "select u.*,\n  (SELECT COUNT(*) FROM datasets) as n\n  FROM users u",
      "SELECT DISTINCT * FROM users",
      "SELECT x.* FROM datasets d JOIN users x ON x.id = d.owner_user_id",
      // The spellings a "star then FROM users" pattern misses:
      "SELECT users.* FROM users",
      "SELECT *, (SELECT COUNT(*) FROM tokens WHERE user_id = users.id) AS n FROM users",
      "UPDATE users SET city = ? WHERE id = ? RETURNING *",
      "INSERT INTO users (email) VALUES (?) RETURNING *",
      "SELECT * FROM main.users",
      'SELECT * FROM "users" WHERE id = ?',
      "SELECT * FROM datasets d JOIN users u ON u.id = d.owner_user_id",
    ]) {
      expect(readsWholeUserRow(bad), bad).toBe(true);
    }
    for (const fine of [
      "SELECT id, username FROM users",
      "SELECT COUNT(*) FROM users",
      "SELECT * FROM datasets WHERE dataset_id = ?",
      "SELECT d.*, (SELECT username FROM users WHERE id = d.owner_user_id) AS owner FROM datasets d",
      "SELECT d.* FROM datasets d JOIN users u ON u.id = d.owner_user_id",
      "SELECT * FROM datasets WHERE owner_user_id IN (SELECT id FROM users)",
      "UPDATE users SET city = ? WHERE id = ?",
      "UPDATE datasets SET x = 1 WHERE id = ? RETURNING *",
      "SELECT * FROM tokens WHERE user_id = ?",
    ]) {
      expect(readsWholeUserRow(fine), fine).toBe(false);
    }
  });

  test("no backend source file contains one", () => {
    const offenders = files.filter((file) =>
      readsWholeUserRow(withoutComments(readFileSync(file, "utf8"))),
    );
    expect(
      offenders.map((f) => f.slice(SRC.length + 1)),
      "Select the columns you need. The classification of users columns is USER_COLUMN_ROLES in services/user-search.ts.",
    ).toEqual([]);
  });
});
