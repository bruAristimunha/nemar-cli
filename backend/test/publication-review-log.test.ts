/**
 * The review's shared helpers: one way to name an error in a log line, one pattern for a commit
 * (ADR 0102).
 *
 * `errorWords` is read by the write path, the callbacks, the view, the mail and the admin routes,
 * and what it prints is pinned here once, so a log line can never carry a message. A source scan
 * keeps the review's modules from growing a second copy of either: the two helpers used to be
 * declared three times (the pattern) and twice in two formats (the words).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { HEAD } from "../../shared/publication-review";
import { SHA40, errorWords } from "../src/services/publication-review-log";

const SRC = join(import.meta.dir, "../src");

describe("errorWords", () => {
  test("names the error and one word of a closed list, never its message", () => {
    const message = "D1_ERROR: SECRET-SQL-SENTINEL near publication_reviews";
    const named = (name: string, text = message) => Object.assign(new Error(text), { name });
    const cases: Array<[unknown, string]> = [
      [new Error(message), "Error, other"],
      [new Error(`${message}: no such table: publication_reviews`), "Error, no_such_table"],
      [named("TimeoutError"), "TimeoutError, timeout"],
      [named("AbortError"), "AbortError, timeout"],
      [new Error("the request timed out"), "Error, timeout"],
      [new TypeError(message), "TypeError, other"],
      [new Error("Publication review dispatch rejected: HTTP 502"), "Error, http_502"],
      // A message that only resembles the dispatch's is not read as one.
      [new Error("Publication review dispatch rejected: HTTP 502 SECRET"), "Error, other"],
      // Not an Error, or an Error whose name is not a plain identifier.
      ["a string", "unknown, other"],
      [{ message }, "unknown, other"],
      [null, "unknown, other"],
      [named("not a plain name!"), "unknown, other"],
    ];
    for (const [error, words] of cases) {
      expect(errorWords(error), String(error)).toBe(words);
      expect(errorWords(error)).not.toContain("SECRET");
    }
  });
});

describe("SHA40", () => {
  test("is the shared contract's commit pattern, and reads exactly forty lowercase hex digits", () => {
    expect(SHA40).toBe(HEAD);
    const good = "0123456789abcdef0123456789abcdef01234567";
    expect(SHA40.test(good)).toBe(true);
    for (const bad of [
      good.slice(1),
      `${good}0`,
      good.toUpperCase(),
      `${good}\n`,
      ` ${good}`,
      `${good.slice(1)}g`,
      "",
    ]) {
      expect(SHA40.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

/** Every `.ts` file under `dir`. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("the review's modules share one copy of each helper", () => {
  // Matched on the path under `src`, never the whole path: a checkout whose own directory name
  // says `publication-review` would otherwise pull every file of the backend into the scan.
  const files = walk(SRC).filter((f) => /publication-review/.test(relative(SRC, f)));

  test("the review's modules are found (the scan is not vacuous)", () => {
    const names = files.map((f) => relative(SRC, f));
    expect(names).toContain("services/publication-review.ts");
    expect(names).toContain("services/publication-review-view.ts");
    expect(names).toContain("routes/admin/publication-review.ts");
    expect(names).toContain("routes/callbacks/publication-review.ts");
  });

  test("none declares a commit pattern of its own", () => {
    const own = files
      .filter((f) => !f.endsWith("publication-review-log.ts"))
      .filter((f) => /\[0-9a-f\]\{40\}/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(own).toEqual([]);
  });

  test("none names an error in a log line by a helper of its own", () => {
    const own = files
      .filter((f) => !f.endsWith("publication-review-log.ts"))
      .filter((f) => /\b(errClass|readFailureWords)\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(own).toEqual([]);
  });
});
