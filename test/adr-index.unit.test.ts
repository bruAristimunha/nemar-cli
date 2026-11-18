/**
 * Keeps `.context/decisions/README.md` honest about what is actually on disk.
 *
 * The index is the entry point agents and humans are told to read first
 * (AGENTS.md "START HERE"), so an ADR missing from it is invisible, and an
 * entry pointing at a deleted or renamed file sends the reader nowhere. Both
 * failures are silent — nothing else reads this directory — so a hand-
 * maintained list would rot within a few PRs.
 *
 * Real filesystem, no mocks.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DECISIONS_DIR = join(import.meta.dir, "../.context/decisions");
const README = join(DECISIONS_DIR, "README.md");

/** Every ADR file on disk, excluding the template and the index itself. */
function adrFiles(): string[] {
  return readdirSync(DECISIONS_DIR)
    .filter((f) => f.endsWith(".md") && f !== "README.md" && f !== "0000-template.md")
    .sort();
}

/** Files linked from the README's index, in the order they appear. */
function indexedFiles(readme: string): string[] {
  return [...readme.matchAll(/\]\((\d{4}-[a-z0-9-]+\.md)\)/g)].map((m) => m[1]);
}

/**
 * ADR numbers another epic has reserved and not landed yet, so the numbering has a gap this
 * directory is not responsible for. Add a number here only while a reserved ADR is on another
 * branch, and delete it in the first change that brings the file.
 */
// 0120: reserved for the collaborator's reader epic; delete this entry when that ADR lands
const TOLERATED_GAPS: ReadonlySet<number> = new Set([120]);

/** The numbers missing between 1 and the highest one present, ascending. */
function findGaps(nums: number[]): number[] {
  const present = new Set(nums);
  const top = Math.max(0, ...nums);
  const gaps: number[] = [];
  for (let n = 1; n <= top; n++) if (!present.has(n)) gaps.push(n);
  return gaps;
}

/** The gaps nothing has said it is waiting for. */
function untoleratedGaps(
  nums: number[],
  tolerated: ReadonlySet<number> = TOLERATED_GAPS,
): number[] {
  return findGaps(nums).filter((n) => !tolerated.has(n));
}

describe("ADR index", () => {
  const readme = readFileSync(README, "utf8");
  const onDisk = adrFiles();
  const indexed = indexedFiles(readme);

  test("there are ADRs to check (guards a silently-vacuous pass)", () => {
    expect(onDisk.length).toBeGreaterThan(0);
  });

  test("every ADR on disk is listed in the index", () => {
    const missing = onDisk.filter((f) => !indexed.includes(f));
    expect(missing).toEqual([]);
  });

  test("every index entry points at a file that exists", () => {
    const dangling = indexed.filter((f) => !onDisk.includes(f));
    expect(dangling).toEqual([]);
  });

  test("the index is in ascending ADR-number order", () => {
    // Reading order is the numbering, so an out-of-order entry means someone
    // appended rather than inserted and the next reader will miss it.
    expect(indexed).toEqual([...indexed].sort());
  });

  test("ADR numbers are unique and gapless from 0001, apart from the tolerated gaps", () => {
    const nums = onDisk.map((f) => Number(f.slice(0, 4)));
    expect(new Set(nums).size).toBe(nums.length);
    expect(untoleratedGaps(nums)).toEqual([]);
  });

  test("a tolerated gap is still a gap on disk (a stale entry must be deleted)", () => {
    // The entry exists because another epic reserved a number and has not landed it yet. The
    // pull request that adds that ADR has to delete the entry, and this is what makes it: with the
    // file present the entry stops being a gap and this test names it.
    const nums = new Set(onDisk.map((f) => Number(f.slice(0, 4))));
    const stale = [...TOLERATED_GAPS].filter((n) => nums.has(n));
    expect(stale).toEqual([]);
  });

  test("a gap outside the tolerated set is reported, and one inside it is not", () => {
    // The gap check is a pure function so its two outcomes can be seen without touching the
    // directory: a check that cannot fail passes whatever the directory holds.
    expect(findGaps([1, 2, 3, 5, 6, 8])).toEqual([4, 7]);
    expect(findGaps([1, 2, 3])).toEqual([]);
    expect(untoleratedGaps([1, 2, 3, 5, 6, 8], new Set([4]))).toEqual([7]);
    expect(untoleratedGaps([1, 2, 3, 5, 6, 8], new Set([4, 7]))).toEqual([]);
    // The real directory without its tolerance: the numbers the tolerance covers are exactly the
    // ones the unfiltered check reports.
    const nums = onDisk.map((f) => Number(f.slice(0, 4)));
    expect(findGaps(nums)).toEqual([...TOLERATED_GAPS].sort((a, b) => a - b));
  });

  test("every ADR carries a Status and a Date", () => {
    const bad: string[] = [];
    for (const f of onDisk) {
      const body = readFileSync(join(DECISIONS_DIR, f), "utf8");
      if (!/^\*\*Status:\*\*/m.test(body) || !/^\*\*Date:\*\*/m.test(body)) bad.push(f);
    }
    expect(bad).toEqual([]);
  });

  test("every ADR's Status is one of the documented values", () => {
    // proposed | accepted | superseded by ADR-NNNN. A typo here silently
    // removes an ADR from any status-based reading.
    const bad: { file: string; status: string }[] = [];
    for (const f of onDisk) {
      const body = readFileSync(join(DECISIONS_DIR, f), "utf8");
      const status = /^\*\*Status:\*\*\s*(.+)$/m.exec(body)?.[1]?.trim() ?? "";
      if (!/^(proposed|accepted|superseded by ADR-\d{4}(\s+and\s+ADR-\d{4})*)$/.test(status)) {
        bad.push({ file: f, status });
      }
    }
    expect(bad).toEqual([]);
  });

  test("a superseded ADR names a target that exists", () => {
    const dangling: string[] = [];
    for (const f of onDisk) {
      const body = readFileSync(join(DECISIONS_DIR, f), "utf8");
      const status = /^\*\*Status:\*\*\s*(.+)$/m.exec(body)?.[1] ?? "";
      for (const [, num] of status.matchAll(/ADR-(\d{4})/g)) {
        if (!onDisk.some((o) => o.startsWith(num))) dangling.push(`${f} -> ADR-${num}`);
      }
    }
    expect(dangling).toEqual([]);
  });
});
