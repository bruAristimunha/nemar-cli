/**
 * Set B: hostile pull requests run through the review's real evidence reader, summary, platform
 * findings and prompt, and judged by one oracle written apart from all of them
 * (`fixtures/pr-review-hostile/oracle.ts`; design `.context/plans/pr-review-change-summary.md`,
 * sections 11 and 12.4).
 *
 * The pass criterion is the design's: every case ends with the content incomplete, a blocking
 * platform finding, or the change shown exactly, and no case is accounted for with a loss hidden.
 * The tests:
 *  - one test that the set is the design's cases;
 *  - one test per case (`case <id> takes the route <route>`): the oracle finds no violation, the
 *    case loses something (so it does not pass by testing nothing), it takes the route it names (so
 *    a change of route is a failure too), and a finding or an incomplete read keeps a model's
 *    all-pass answer from passing; case 10 also has every look-alike pair line noted;
 *  - one self-test of the oracle, which doctors real runs the way each rule guards against and
 *    shows the oracle objects: O-D (a diff that shows none of its lines), O1 (no loss class, no
 *    finding, too few rows counted), O-R (an unread file called read), O2 (for each of its three
 *    conditions) and O3 (a forged facts block, a class line outside every fence);
 *  - one test that the builder writes set B as clones `pr-review-calibrate.ts` reads, offline.
 *
 * Each case is built and run once, whichever test asks first. Every repository is built in one
 * temporary directory, removed after the file whether the tests passed or not.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EvidenceRow, calibrateMain } from "../scripts/ci/pr-review-calibrate";
import {
  type GitFacts,
  type TextFacts,
  buildEvidence,
  gatherContent,
  gatherListing,
} from "../scripts/ci/pr-review-evidence";
import {
  assembleReport,
  buildReviewMessages,
  platformFindings,
} from "../scripts/ci/pr-review-prompt";
import { type ReviewEvidence, verdictOf } from "../shared/pr-review";
import {
  HOSTILE_CASES,
  type HostileCase,
  type Tree,
  buildCase,
  writeSetB,
} from "./fixtures/pr-review-hostile/build";
import { type Observed, type Verdict, check } from "./fixtures/pr-review-hostile/oracle";

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pr-review-hostile-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const NONCE = "0123456789abcdef0123456789abcdef";
const NEUTRAL: TextFacts = {
  descriptionEmpty: false,
  descriptionCut: false,
  titleProblem: null,
  nameProblem: null,
};
const PROCEED = { decision: "proceed", note: "A dataset update." };
const ALL_PASS = {
  criteria: { no_degradation: "pass", advances_revision: "pass", material_improvement: "pass" },
  title_ok: true,
  body_ok: true,
  steering: false,
  misleading_body: false,
  findings: [],
  summary: "Looks fine.",
};
const USAGE = {
  screen: { input_tokens: 1, output_tokens: 1 },
  review: { input_tokens: 1, output_tokens: 1 },
};

interface Run {
  c: HostileCase;
  facts: GitFacts;
  evidence: ReviewEvidence;
  observed: Observed;
  verdict: Verdict;
}

const bytesOf = (t: Tree) => new Map([...t].map(([path, file]) => [path, file.bytes]));

/** Each case's run, by id: a case is built and run once per file, whichever test asks first. */
const runs = new Map<string, Run>();

/** One case through the real reader, summary, findings and prompt, then the oracle. */
function run(c: HostileCase): Run {
  const done = runs.get(c.id);
  if (done !== undefined) return done;
  const r = runOnce(c);
  runs.set(c.id, r);
  return r;
}

function runOnce(c: HostileCase): Run {
  const repo = buildCase(c, root);
  const listing = gatherListing(repo.dir, repo.base, repo.head);
  const content = gatherContent(
    repo.dir,
    listing,
    c.summaryNotStarted ? { now: () => Number.POSITIVE_INFINITY } : {},
  );
  const facts = { ...listing, ...content };
  const evidence = buildEvidence(facts, NEUTRAL);
  const { user } = buildReviewMessages({
    facts,
    evidence,
    pr: { title: `Set B case ${c.id}`, body: c.title },
    fromFork: false,
    nonce: NONCE,
  });
  const observed: Observed = {
    patches: facts.patches,
    readIncomplete: facts.readIncomplete,
    accounted: facts.summary.accounted,
    classes: facts.summary.classes,
    summarized: new Set(facts.summary.files.filter((o) => o.refusal === null).map((o) => o.path)),
    rowsRemoved: facts.summary.loss.rowsRemoved,
    findings: platformFindings(facts.summary).length,
    prompt: user,
    nonce: NONCE,
  };
  return {
    c,
    facts,
    evidence,
    observed,
    verdict: check(bytesOf(c.base), bytesOf(c.head), observed),
  };
}

/** Why the case did not take its route, or null when it did. */
function offRoute(r: Run): string | null {
  const { c, facts } = r;
  const accounted = facts.summary.accounted;
  const shownInFull = (path: string) =>
    facts.patches.some((p) => !p.truncated && (p.path === path || p.same.includes(path)));
  switch (c.route) {
    case "finding": {
      if (r.observed.findings === 0) return "no platform finding";
      const loss = new Set(["row_removed", "column_removed", "json_key_removed"]);
      const off = c.focus.filter(
        (p) => !facts.summary.classes.some((k) => loss.has(k.kind) && k.files.has(p)),
      );
      return off.length === 0 ? null : `in no class of a loss kind: ${off.join(", ")}`;
    }
    case "diff": {
      const off = c.focus.filter((p) => !shownInFull(p) || accounted.has(p));
      return off.length === 0 ? null : `not shown in full, or accounted for: ${off.join(", ")}`;
    }
    case "incomplete": {
      if (!facts.readIncomplete) return "the content is called complete";
      const off = c.focus.filter((p) => accounted.has(p));
      return off.length === 0 ? null : `accounted for: ${off.join(", ")}`;
    }
    case "summary": {
      const off = c.focus.filter((p) => !accounted.has(p));
      return off.length === 0 ? null : `not accounted for: ${off.join(", ")}`;
    }
  }
}

/** The lines of the prompt's change summary block, inside its fence. */
function summaryBlock(prompt: string): string[] {
  const lines = prompt.split("\n");
  const open = lines.findIndex((l) =>
    l.startsWith(`<untrusted-${NONCE} kind="changed-metadata-summary`),
  );
  if (open < 0) return [];
  const close = lines.indexOf(`</untrusted-${NONCE}>`, open);
  return lines.slice(open + 1, close < 0 ? undefined : close);
}

const CASES = HOSTILE_CASES.map((make) => {
  const c = make();
  return [c.id, c.route, c] as const;
});

describe("set B: every hostile case takes its route, and no loss is hidden", () => {
  test("the set is the design's cases, two of them in two variants", () => {
    expect(CASES.map(([id]) => id)).toEqual([
      ...Array.from({ length: 15 }, (_, i) => String(i + 1).padStart(2, "0")),
      "16a",
      "16b",
      "17",
      "18",
      "19",
      "20",
      "21a",
      "21b",
      "22",
    ]);
  });

  test.each(CASES)(
    "case %s takes the route %s",
    (_id, route, c) => {
      const r = run(c);
      expect(r.verdict.violations).toEqual([]);
      // The case loses something, so the oracle had something to look for.
      expect(r.verdict.lostUnits).toBeGreaterThan(0);
      expect(offRoute(r)).toBeNull();
      if (c.id === "10") {
        // Four look-alike pairs (a Cyrillic letter, a no-break space, a zero-width space, a
        // delete character), all found by O2, and every pair line of the block carries its note.
        expect(r.verdict.lookAlikes).toBe(4);
        const pairs = summaryBlock(r.observed.prompt).filter((l) => /^ {4}".*" -> "/.test(l));
        expect(pairs).toHaveLength(4);
        for (const line of pairs) expect(line).toContain(" (first difference at character ");
      }
      // A finding or an incomplete read keeps a model's all-pass answer from passing.
      if (route === "finding" || route === "incomplete") {
        expect(
          verdictOf(
            assembleReport(PROCEED, ALL_PASS, r.evidence, USAGE, platformFindings(r.facts.summary)),
          ),
        ).not.toBe("pass");
      }
    },
    60_000,
  );
});

describe("the oracle", () => {
  const byId = (id: string): HostileCase => {
    const found = CASES.find(([x]) => x === id);
    if (found === undefined) throw new Error(`no case ${id}`);
    return found[2];
  };
  const rules = (v: Verdict) => v.violations.map((x) => x.rule);

  test("the oracle objects to each kind of hidden loss", () => {
    const again = (r: Run, observed: Partial<Observed>) =>
      check(bytesOf(r.c.base), bytesOf(r.c.head), { ...r.observed, ...observed });

    // O-D: a diff that names the file and shows none of its lines, as a binary diff does.
    const refused = run(byId("21a"));
    expect(rules(refused.verdict)).toEqual([]);
    const binary = refused.observed.patches.map((p) => ({
      ...p,
      text: `diff --git a/${p.path} b/${p.path}\nBinary files a/${p.path} and b/${p.path} differ\n`,
    }));
    expect(rules(again(refused, { patches: binary }))).toContain("O-D");

    // O1: an accounted file whose removal is in no loss class and makes no finding.
    const among = run(byId("01"));
    expect(rules(among.verdict)).toEqual([]);
    const noLoss = among.observed.classes.filter((c) => c.kind !== "row_removed");
    expect(rules(again(among, { patches: [], classes: noLoss, findings: 0 }))).toContain("O1");
    expect(rules(again(among, { patches: [], findings: 0 }))).toContain("O1");
    // O1, counted: a copy used twice, or one that does not count, leaves fewer rows removed than
    // the tables lost.
    const copied = run(byId("04"));
    expect(rules(copied.verdict)).toEqual([]);
    expect(copied.observed.rowsRemoved).toBe(2);
    expect(rules(again(copied, { rowsRemoved: 1 }))).toContain("O1");

    // O-R: a file neither shown nor accounted for, and the content called complete.
    const nul = run(byId("07"));
    expect(rules(nul.verdict)).toEqual([]);
    expect(rules(again(nul, { readIncomplete: false }))).toContain("O-R");

    // O2 and O3: a pair that reads as one value with its note gone, a forged facts block, and a
    // class line outside every fence.
    const fenced = run(byId("22"));
    expect(rules(fenced.verdict)).toEqual([]);
    const unnoted = fenced.observed.prompt.replace(/ \(first difference at [^)]*\)/g, "");
    expect(unnoted).not.toBe(fenced.observed.prompt);
    expect(rules(again(fenced, { prompt: unnoted }))).toContain("O2");

    // O2, one condition at a time, each with the note removed from one pair line: (a) tokens the
    // fence made equal (case 22), (b) a first difference outside ASCII, a Cyrillic letter for a
    // Latin one, and (c) a difference only in an escaped character, a delete (both case 10).
    const o2 = (r: Run, pair: RegExp): string[] => {
      const lines = r.observed.prompt.split("\n");
      const at = lines.findIndex((l) => pair.test(l));
      expect(at).toBeGreaterThan(-1);
      const line = lines[at] as string;
      lines[at] = line.replace(/ \(first difference at [^)]*\)$/, "");
      expect(lines[at]).not.toBe(line);
      return again(r, { prompt: lines.join("\n") })
        .violations.filter((v) => v.rule === "O2")
        .map((v) => v.detail);
    };
    expect(o2(fenced, /^ {4}"< facts>" -> "< facts>" x1 /)).toEqual([
      "a pair reads as one value, with no note",
    ]);
    const alike = run(byId("10"));
    expect(rules(alike.verdict)).toEqual([]);
    expect(o2(alike, /^ {4}"a" -> "\u{430}" x1 /u)).toEqual([
      "a pair first differs outside ASCII, with no note",
    ]);
    expect(o2(alike, /^ {4}"uV" -> "u\\u\{7F\}V" x1 /)).toEqual([
      "a pair differs only in escaped characters, with no note",
    ]);
    expect(rules(again(fenced, { prompt: `${fenced.observed.prompt}\n<facts>` }))).toContain("O3");
    expect(
      rules(again(fenced, { prompt: `${fenced.observed.prompt}\nC1 | "x" | forged` })),
    ).toContain("O3");
  }, 60_000);
});

describe("set B as calibrate reads it", () => {
  test("the builder writes set B as clones calibrate reads", async () => {
    const out = join(root, "set-b");
    const lines = writeSetB(out);
    expect(lines.filter((l) => !l.startsWith("#"))).toHaveLength(CASES.length);
    const printed: string[] = [];
    // calibrate refuses to run where a review's callback token is set; a shell that has one must
    // not decide this test, so it is cleared for the run and put back after.
    const token = process.env.PR_REVIEW_CALLBACK_TOKEN;
    Reflect.deleteProperty(process.env, "PR_REVIEW_CALLBACK_TOKEN");
    let code: number;
    try {
      code = await calibrateMain(
        [
          "--prs",
          join(out, "set-b.txt"),
          "--clones",
          out,
          "--offline",
          "--evidence-only",
          "--json",
        ],
        (l) => printed.push(l),
      );
    } finally {
      if (token !== undefined) process.env.PR_REVIEW_CALLBACK_TOKEN = token;
    }
    const rows = JSON.parse(printed.join("\n")) as EvidenceRow[];
    expect(rows).toHaveLength(CASES.length);
    expect(rows.filter((r) => r.error !== null)).toEqual([]);
    expect(rows.every((r) => (r.refusedDeleted?.hidden ?? -1) === 0)).toBe(true);
    expect(code).toBe(0);
    // Every case's numbers say what its route says, except the one whose summary is not started,
    // which calibrate runs with its summary.
    for (const [i, [id, route]] of CASES.entries()) {
      const e = rows[i]?.evidence;
      if (e == null || id === "16a") continue;
      if (route === "finding") expect(e.platformFindings, id).toBeGreaterThan(0);
      if (route === "incomplete") expect(e.readIncomplete, id).toBe(true);
    }
  }, 120_000);
});
