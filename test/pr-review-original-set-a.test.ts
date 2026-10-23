/**
 * Part B on the frozen set A (design `.context/plans/pr-review-change-summary.md`, sections B1 to B7;
 * the measurements of section 1.2): the original-content facts of the 86 open dataset pull requests,
 * recorded in `fixtures/pr-review-canary/set-a-original.json` by `fixtures/pr-review-canary/original.ts`
 * with the strict merge-base anchor.
 *
 * Two kinds of test. The ones that read only the committed baseline run everywhere, CI included, and
 * hold the numbers the design measured: which README changes git shows as deletions and which of them
 * alter what the authors wrote, the CHANGES changes, the author fields, the recordings and the two
 * tripwires. The last one runs the real code on the frozen clones, when this machine has them, and
 * must give the baseline back exactly; a rule change that moves any of the 86 pull requests turns it
 * red, and is then a decision to re-record the baseline, not a drift.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AUTHOR_OWNED_KEYS, PROSE_REFUSALS } from "../scripts/ci/pr-review-original";
import {
  ORIGINAL_ROW_ERRORS,
  type OriginalRow,
  originalRows,
  readTargets,
} from "./fixtures/pr-review-canary/original";

const fixture = (name: string): string =>
  join(import.meta.dir, "fixtures", "pr-review-canary", name);
const baselineText = readFileSync(fixture("set-a-original.json"), "utf8");
const rows = JSON.parse(baselineText) as OriginalRow[];
const row = (pr: string): OriginalRow => {
  const found = rows.find((r) => r.pr === pr);
  if (found === undefined) throw new Error(`no row for ${pr}`);
  return found;
};
/** The pull requests of the rows a predicate holds for, sorted. */
const where = (holds: (r: OriginalRow) => boolean): string[] =>
  rows
    .filter(holds)
    .map((r) => r.pr)
    .sort();

/** The keys a document's facts have in a row: the module's facts, the examples dropped. */
const DOCUMENT_KEYS = [
  "anchor",
  "document",
  "finalNewlineAdded",
  "hidingMarkupInserted",
  "insertedInsideParagraph",
  "insertedLines",
  "joinedInsertedRuns",
  "laterAltered",
  "lineEndingsChanged",
  "minorEdits",
  "moved",
  "movedLines",
  "notUtf8",
  "partsAfter",
  "partsBefore",
  "preserved",
  "proseAltered",
  "protectedAltered",
  "protectedLines",
  "refusal",
  "shownPartReplaced",
];

describe("the set A baseline of original facts", () => {
  test("it is the 86 pull requests of the manifest, in its order, each read", () => {
    const manifest = readTargets(fixture("set-a.txt")).map((t) => `${t.dataset}#${t.number}`);
    expect(rows.map((r) => r.pr)).toEqual(manifest);
    expect(where((r) => r.error !== null)).toEqual([]);
  });

  test("it holds only pull request names, closed words, closed key names, numbers and booleans", () => {
    expect(baselineText).not.toContain("@");
    const closed = new Set<string>([
      "readme",
      "changes",
      "merge_base",
      ...PROSE_REFUSALS,
      ...ORIGINAL_ROW_ERRORS,
      ...AUTHOR_OWNED_KEYS,
    ]);
    const visit = (value: unknown, at: string): void => {
      if (value === null || typeof value === "number" || typeof value === "boolean") return;
      if (typeof value === "string") {
        expect(closed.has(value), at).toBe(true);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item, at);
        return;
      }
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        visit(item, `${at}.${key}`);
      }
    };
    for (const r of rows) {
      expect(r.pr).toMatch(/^(?:nm|on)\d{6}#\d+$/);
      expect(Object.keys(r)).toEqual([
        "pr",
        "error",
        "readmeGitDeleted",
        "readme",
        "changes",
        "authorFields",
        "recordings",
      ]);
      for (const document of [r.readme, r.changes]) {
        if (document === null) continue;
        const keys = Object.keys(document).sort();
        expect(keys.length === 1 ? ["refusal"] : DOCUMENT_KEYS).toEqual(keys);
      }
      if (r.authorFields !== null) {
        expect(Object.keys(r.authorFields).sort()).toEqual([
          "added",
          "altered",
          "authorFieldsAltered",
          "grown",
          "minor",
          "removed",
          "unparsed",
        ]);
      }
      expect(Object.keys(r.recordings ?? {}).sort()).toEqual([
        "moved",
        "replaced",
        "typeChanged",
        "unread",
      ]);
      const { pr: _pr, ...facts } = r;
      visit(facts, r.pr);
    }
  });

  test("29 READMEs git shows with deleted lines: 27 alter nothing, and the two that do are named", () => {
    const deleted = rows.filter((r) => (r.readmeGitDeleted ?? 0) > 0);
    expect(deleted).toHaveLength(29);
    const altered = (r: OriginalRow): boolean | null =>
      r.readme === null || r.readme.refusal !== null ? null : r.readme.proseAltered;
    expect(deleted.filter((r) => altered(r) === false)).toHaveLength(27);
    expect(where((r) => (r.readmeGitDeleted ?? 0) > 0 && altered(r) === true)).toEqual([
      "nm000501#3",
      "on002578#2",
    ]);
    // No README in set A was refused, and none alters original text without a deletion git shows.
    expect(where((r) => r.readme !== null && r.readme.refusal !== null)).toEqual([]);
    expect(where((r) => altered(r) === true)).toEqual(["nm000501#3", "on002578#2"]);
  });

  test("64 pull requests change CHANGES, and none alters an existing line", () => {
    const changed = rows.filter((r) => r.changes !== null);
    expect(changed).toHaveLength(64);
    for (const r of changed) {
      expect(r.changes?.refusal, r.pr).toBeNull();
      expect(r.changes !== null && r.changes.refusal === null && r.changes.proseAltered, r.pr).toBe(
        false,
      );
    }
  });

  test("the author fields: a link removed, a typo fixed, placeholders emptied, and three names", () => {
    expect(row("on006126#1").authorFields?.removed).toEqual(["ReferencesAndLinks"]);
    expect(row("on007353#1").authorFields?.minor).toEqual(["Funding"]);
    expect(row("on007353#1").authorFields?.authorFieldsAltered).toBe(false);
    // The seven `[""]` to `[]` changes of ReferencesAndLinks, and on004022's empty keys removed.
    for (const pr of [
      "on004588#1",
      "on004661#1",
      "on004852#1",
      "on004853#1",
      "on004854#1",
      "on004855#1",
      "on005628#1",
      "on004022#1",
    ]) {
      const facts = row(pr).authorFields;
      expect(facts, pr).not.toBeNull();
      expect([...(facts?.altered ?? []), ...(facts?.removed ?? [])], pr).toEqual([]);
    }
    // Every alteration of an author field in set A: three `Name` changes (the design measured them
    // as made by the platform's own account; whether that exempts them is the caller's to decide)
    // and the removed link.
    expect(where((r) => r.authorFields?.authorFieldsAltered === true)).toEqual([
      "nm000424#2",
      "nm000501#2",
      "nm000513#2",
      "on006126#1",
    ]);
    for (const pr of ["nm000424#2", "nm000501#2", "nm000513#2"]) {
      expect(row(pr).authorFields?.altered, pr).toEqual(["Name"]);
    }
    expect(where((r) => r.authorFields?.unparsed === true)).toEqual([]);
  });

  test("the recordings: 59 replaced, 41 and 5 turned into git files, 15 pointers moved", () => {
    expect(row("on003343#3").recordings).toEqual({
      replaced: 59,
      typeChanged: 0,
      moved: 0,
      unread: 0,
    });
    expect(row("on003029#1").recordings).toEqual({
      replaced: 0,
      typeChanged: 41,
      moved: 0,
      unread: 0,
    });
    expect(row("on004703#1").recordings).toEqual({
      replaced: 0,
      typeChanged: 5,
      moved: 0,
      unread: 0,
    });
    expect(row("on004306#1").recordings).toEqual({
      replaced: 0,
      typeChanged: 0,
      moved: 15,
      unread: 0,
    });
    const any = (r: OriginalRow): boolean => {
      const x = r.recordings;
      return x !== null && x.replaced + x.typeChanged + x.moved + x.unread > 0;
    };
    expect(where(any)).toEqual(["on003029#1", "on003343#3", "on004306#1", "on004703#1"]);
  });

  test("new lines joined to an original paragraph: one README, already altered, and one CHANGES", () => {
    const joined = (document: "readme" | "changes"): string[] =>
      where((r) => {
        const facts = r[document];
        return facts !== null && facts.refusal === null && facts.joinedInsertedRuns > 0;
      });
    expect(joined("readme")).toEqual(["nm000501#3"]);
    expect(joined("changes")).toEqual(["on003620#1"]);
    // None of the 27 README changes that git shows as deletions and that alter nothing.
    const artifacts = rows.filter(
      (r) =>
        (r.readmeGitDeleted ?? 0) > 0 &&
        r.readme !== null &&
        r.readme.refusal === null &&
        !r.readme.proseAltered,
    );
    expect(artifacts).toHaveLength(27);
    for (const r of artifacts) {
      expect(
        r.readme !== null && r.readme.refusal === null && r.readme.joinedInsertedRuns,
        r.pr,
      ).toBe(0);
    }
  });

  test("the tripwires are quiet on set A: no hiding markup inserted, no shown part replaced", () => {
    const documents = rows.flatMap((r) => [r.readme, r.changes]);
    for (const d of documents) {
      if (d === null || d.refusal !== null) continue;
      expect(d.hidingMarkupInserted).toBe(0);
      expect(d.shownPartReplaced).toBe(false);
    }
  });

  // The frozen clones are not in the repository (a git pack holds committer addresses). A machine
  // that made them has them, by default under ~/.local/share/nemar-canary/set-a (or where
  // PR_REVIEW_SET_A_CLONES says), and only there does this run; elsewhere it is skipped, as the
  // Phase 6 baseline of `pr-review-calibrate.test.ts` is.
  const clonesOfSetA =
    process.env.PR_REVIEW_SET_A_CLONES ??
    join(homedir(), ".local", "share", "nemar-canary", "set-a");
  test.skipIf(!existsSync(join(clonesOfSetA, "targets.txt")))(
    "the real code on the frozen clones gives the baseline back (runs only where the clones are)",
    () => {
      expect(originalRows(clonesOfSetA, readTargets(fixture("set-a.txt")))).toEqual(rows);
    },
    300_000,
  );
});
