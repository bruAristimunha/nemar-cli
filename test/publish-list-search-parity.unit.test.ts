/**
 * The CLI's check of a list search must say what the Worker's SQL says, for every row and every
 * text, because it runs on a new Worker's answer too and must change nothing there.
 *
 * The route matches `LIKE '%<text>%' ESCAPE '\'` on the dataset id, the depositor's username and
 * the dataset's name, and puts an exact dataset id first with `LOWER(id) = LOWER(text)`
 * (backend/src/routes/admin/publish.ts). This file asks the real SQLite engine the same questions,
 * with the route's own pattern function (`substringLikePattern`, imported and not copied), over a
 * corpus built to find where a JavaScript reading would differ: letter case outside ASCII, the
 * pattern characters, a backslash, an empty text, a name that is NULL.
 *
 * CI TIER: unit-pure.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  foldAsciiCase,
  isExactIdMatch,
  matchesListSearch,
  substringLikePattern,
} from "../shared/publish-list-search";

const HAYSTACKS = [
  "nm000104",
  "NM000104",
  "A sufficiently descriptive title for nm000104",
  "depositor_nm000104",
  "Éclair",
  "éclair",
  "İstanbul",
  "ı dotless",
  "ß",
  "Straße",
  "STRASSE",
  "100%_done",
  "100 percent done",
  "a\\b",
  "a_b",
  "axb",
  "AbC",
  "日本語データ",
  "\u{1f9e0} brain",
  "",
];

const NEEDLES = [
  "nm000104",
  "NM000104",
  "Nm0001",
  "descriptive TITLE",
  "DEPOSITOR_",
  "é",
  "É",
  "i",
  "İ",
  "ss",
  "SS",
  "ß",
  "%",
  "_",
  "\\",
  "100%",
  "%_",
  "a_b",
  "a\\b",
  "A_B",
  "abc",
  "日本",
  "\u{1f9e0}",
  "zzz",
  " ",
];

const db = new Database(":memory:");
const likeAnswer = db.query<{ r: number }, [string, string]>("SELECT ? LIKE ? ESCAPE '\\' AS r");
const exactAnswer = db.query<{ r: number }, [string, string]>("SELECT LOWER(?) = LOWER(?) AS r");

describe("the CLI's reading of a list search is the SQL engine's", () => {
  test("a substring match agrees with LIKE '%text%' ESCAPE for every pair of the corpus", () => {
    let compared = 0;
    let matches = 0;
    for (const hay of HAYSTACKS) {
      for (const needle of NEEDLES) {
        const sql = likeAnswer.get(hay, substringLikePattern(needle))?.r === 1;
        expect({ hay, needle, js: matchesListSearch(needle, [hay]) }).toEqual({
          hay,
          needle,
          js: sql,
        });
        compared += 1;
        if (sql) matches += 1;
      }
    }
    // The corpus reaches both answers, so an implementation that always said yes or no fails.
    expect(compared).toBe(HAYSTACKS.length * NEEDLES.length);
    expect(matches).toBeGreaterThan(20);
    expect(compared - matches).toBeGreaterThan(200);
  });

  test("letter case folds for ASCII only, as the engine's LIKE does", () => {
    expect(matchesListSearch("abc", ["ABC"])).toBe(true);
    expect(matchesListSearch("é", ["É"])).toBe(false);
    expect(foldAsciiCase("ÉA")).toBe("Éa");
  });

  test("a NULL or missing field never matches, and a text with no characters is not a filter", () => {
    expect(matchesListSearch("x", [null, undefined])).toBe(false);
    expect(matchesListSearch("x", [null, "an x here"])).toBe(true);
    // The route skips the condition for an empty text; so does the CLI.
    expect(matchesListSearch("", [null])).toBe(true);
  });

  test("an exact id agrees with LOWER(id) = LOWER(text)", () => {
    for (const hay of HAYSTACKS) {
      for (const needle of NEEDLES) {
        const sql = exactAnswer.get(hay, needle)?.r === 1;
        expect({ hay, needle, js: isExactIdMatch(hay, needle) }).toEqual({ hay, needle, js: sql });
      }
    }
  });
});
