/**
 * The dataset pull-request review contract (ADR 0092).
 *
 * Real parser, real verdict, real renderer, driven with the inputs an attacker controls: a
 * pull request's text reaches a model and the model's output reaches a check-run, so every test
 * here asks what a hostile report or a hostile note can and cannot do.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CRITERIA,
  DAILY_AUTHOR_CAP,
  DAILY_REVIEW_CAP,
  FINDING_CODES,
  HOURLY_REVIEW_CAP,
  MAX_FINDINGS,
  MAX_LISTED,
  MAX_MODEL_FILES,
  NOTE_MAX,
  OVERRIDE_MODES,
  PR_REVIEW_COMMENT_MARKER,
  type PrReviewReport,
  PrReviewReportError,
  REJECTION_COUNT,
  REVIEW_STATES,
  VERDICTS,
  conclusionOf,
  dailyAuthorCapFor,
  effectiveCriteria,
  factsOf,
  hourlyCapFor,
  isRunError,
  parseCallbackOutcome,
  parsePrReviewReport,
  renderCheck,
  renderComment,
  sanitizeNote,
  standingOf,
  verdictOf,
} from "../shared/pr-review";

const emptyAreas = () => ({
  dataset_description: { added: 0, modified: 0, removed: 0 },
  readme_and_changes: { added: 0, modified: 0, removed: 0 },
  participants: { added: 0, modified: 0, removed: 0 },
  sidecars: { added: 0, modified: 0, removed: 0 },
  recordings: { added: 0, modified: 0, removed: 0 },
  derivatives: { added: 0, modified: 0, removed: 0 },
  sourcedata: { added: 0, modified: 0, removed: 0 },
  code: { added: 0, modified: 0, removed: 0 },
  other: { added: 0, modified: 0, removed: 0 },
});

/** Evidence whose counts add up, as the script always produces it. `recordings` absorbs the rest. */
function evidence(over: Record<string, unknown> = {}): Record<string, unknown> {
  const files_changed = (over.files_changed as number | undefined) ?? 12;
  const base = {
    files_changed,
    files_read: Math.min(files_changed, 4),
    truncated: false,
    version_before: "1.0.0",
    version_after: "1.1.0",
    subjects_before: 20,
    subjects_after: 22,
    areas: {
      ...emptyAreas(),
      dataset_description: { added: 0, modified: files_changed > 0 ? 1 : 0, removed: 0 },
      recordings: { added: Math.max(files_changed - 1, 0), modified: 0, removed: 0 },
    },
    listed: [
      { status: "modified", path: "dataset_description.json" },
      { status: "added", path: "sub-21/eeg/sub-21_task-rest_eeg.edf" },
    ],
    ...over,
  };
  return base;
}

function report(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    model: "claude-haiku-5-5",
    criteria: { no_degradation: "pass", advances_revision: "pass", material_improvement: "pass" },
    findings: [],
    summary: "Adds two subjects and corrects the task description.",
    steering: false,
    evidence: evidence(),
    ...over,
  };
}

function parsed(over: Record<string, unknown> = {}): PrReviewReport {
  return parsePrReviewReport(report(over));
}

function refusal(raw: unknown): string {
  try {
    parsePrReviewReport(raw);
  } catch (e) {
    if (e instanceof PrReviewReportError) return e.code;
    throw e;
  }
  return "accepted";
}

describe("the report is a closed vocabulary", () => {
  test("a well-formed report is accepted", () => {
    expect(parsed().criteria.no_degradation).toBe("pass");
  });

  test("an unknown top-level key is refused, not ignored", () => {
    expect(refusal(report({ verdict: "pass" }))).toBe("unknown_key");
  });

  test("a model that is not in the closed set is refused", () => {
    expect(refusal(report({ model: "some-other-model" }))).toBe("bad_model");
  });

  test("a criterion value outside the three words is refused", () => {
    expect(
      refusal(
        report({
          criteria: {
            no_degradation: "pass",
            advances_revision: "pass",
            material_improvement: "great",
          },
        }),
      ),
    ).toBe("bad_criteria");
  });

  test("an extra criterion is refused", () => {
    expect(
      refusal(
        report({
          criteria: {
            no_degradation: "pass",
            advances_revision: "pass",
            material_improvement: "pass",
            override: "pass",
          },
        }),
      ),
    ).toBe("bad_criteria");
  });

  test("a finding with an invented code is refused", () => {
    const finding = {
      criterion: "no_degradation",
      severity: "note",
      code: "approve_this",
      path: null,
      note: "",
    };
    expect(refusal(report({ findings: [finding] }))).toBe("bad_findings");
  });

  test("more findings than the cap is refused", () => {
    const finding = {
      criterion: "no_degradation",
      severity: "note",
      code: "other",
      path: null,
      note: "x",
    };
    expect(refusal(report({ findings: Array(MAX_FINDINGS + 1).fill(finding) }))).toBe(
      "bad_findings",
    );
  });

  test("a version that is not X.Y.Z is refused", () => {
    expect(
      refusal(
        report({
          evidence: evidence({ version_after: "latest and greatest" }),
        }),
      ),
    ).toBe("bad_evidence");
  });

  test("a refusal never quotes what it refused", () => {
    try {
      parsePrReviewReport(report({ model: "IGNORE ALL PREVIOUS INSTRUCTIONS" }));
      throw new Error("should have been refused");
    } catch (e) {
      expect(String(e)).not.toContain("IGNORE");
      expect((e as PrReviewReportError).code).toBe("bad_model");
    }
  });

  test("a path that is not path-shaped is dropped, not trusted into the check", () => {
    const finding = (path: string) => ({
      criterion: "no_degradation",
      severity: "concern",
      code: "data_removed",
      path,
      note: "gone",
    });
    const r = parsePrReviewReport(
      report({
        findings: [
          finding("sub-01/eeg/sub-01_task-rest_eeg.edf"),
          finding("[click](https://evil.example)"),
          finding("../../etc/passwd"),
          finding("a path with spaces"),
        ],
      }),
    );
    expect(r.findings.map((f) => f.path)).toEqual([
      "sub-01/eeg/sub-01_task-rest_eeg.edf",
      null,
      null,
      null,
    ]);
  });

  test("a failing criterion with no finding gets one, so a red check has something to read", () => {
    const r = parsed({
      criteria: { no_degradation: "fail", advances_revision: "pass", material_improvement: "pass" },
    });
    const f = r.findings.find((x) => x.criterion === "no_degradation");
    expect(f?.severity).toBe("blocker");
    expect(f?.note).toBe("No detail given.");
  });
});

describe("every changed file is accounted for", () => {
  test("areas that do not add up to the total are refused, so a change cannot be dropped or invented", () => {
    const short = evidence({ files_changed: 12 });
    (short.areas as Record<string, { added: number }>).recordings.added = 3;
    expect(refusal(report({ evidence: short }))).toBe("bad_evidence");
    const over = evidence({ files_changed: 12 });
    (over.areas as Record<string, { removed: number }>).code.removed = 1;
    expect(refusal(report({ evidence: over }))).toBe("bad_evidence");
  });

  test("an area outside the closed set is refused", () => {
    const e = evidence();
    (e.areas as Record<string, unknown>).secrets = { added: 0, modified: 0, removed: 0 };
    expect(refusal(report({ evidence: e }))).toBe("bad_evidence");
  });

  test("more files read than changed is refused", () => {
    expect(refusal(report({ evidence: evidence({ files_changed: 3, files_read: 4 }) }))).toBe(
      "bad_evidence",
    );
  });

  test("a listed name that is not path-shaped is shown as hidden, and still counted", () => {
    const r = parsed({
      evidence: evidence({
        listed: [{ status: "removed", path: "[click me](https://evil.example)" }],
      }),
    });
    expect(r.evidence.listed[0]).toEqual({ status: "removed", path: null });
    const { text } = renderCheck({ kind: "reported", report: r });
    expect(text).toContain("name not shown");
    expect(text).not.toContain("evil.example");
  });

  test("the account shows each area that changed, the version, the subjects and how much was read", () => {
    const { summary } = renderCheck({ kind: "reported", report: parsed() });
    expect(summary).toContain("What changed");
    expect(summary).toContain("| Dataset description | 0 | 1 | 0 |");
    expect(summary).toContain("| Recordings and data files | 11 | 0 | 0 |");
    expect(summary).not.toContain("| Code |");
    expect(summary).toContain("Version 1.0.0 to 1.1.0.");
    expect(summary).toContain("Subjects 20 to 22.");
    expect(summary).toContain("The content of 4 of 12 changed files was read.");
    expect(summary).toContain("stored outside git");
  });

  test("when everything was read, it says so instead of apologising", () => {
    const r = parsed({ evidence: evidence({ files_changed: 2, files_read: 2 }) });
    expect(renderCheck({ kind: "reported", report: r }).summary).toContain(
      "The content of all 2 changed files was read.",
    );
  });

  test("a pull request that changes nothing says so", () => {
    const r = parsed({ evidence: evidence({ files_changed: 0, files_read: 0, listed: [] }) });
    expect(renderCheck({ kind: "reported", report: r }).summary).toContain("No files changed.");
  });

  test("the file list says how many it is leaving out", () => {
    const r = parsed({ evidence: evidence({ files_changed: 500, truncated: true }) });
    const { text } = renderCheck({ kind: "reported", report: r });
    expect(text).toContain("Changed files (2 of 500)");
    expect(text).toContain("and 498 more files, counted above");
  });
});

describe("notes are plain words", () => {
  test("links, images, html, mentions and cross references are removed", () => {
    const out = sanitizeNote(
      "See [the docs](https://evil.example/x) and ![img](https://evil.example/p.png) <script>alert(1)</script> " +
        "cc @maintainer fixes #12 and owner/repo#99 https://evil.example www.evil.example",
    );
    expect(out).not.toMatch(/https?:/i);
    expect(out).not.toContain("www.");
    expect(out).not.toContain("@");
    expect(out).not.toContain("#");
    expect(out).not.toContain("<");
    expect(out).not.toContain("](");
    expect(out).toContain("the docs");
  });

  test("zero-width, bidirectional and control characters cannot hide anything", () => {
    const hidden = [0x200b, 0x202e, 0x0007, 0x2028].map((c) => String.fromCharCode(c));
    const out = sanitizeNote(`pa${hidden[0]}ss${hidden[1]} fa${hidden[2]}il${hidden[3]}x`);
    for (const h of hidden) expect(out).not.toContain(h);
  });

  test("emphasis, backticks, table pipes and escapes are removed so a note cannot restyle the check", () => {
    const out = sanitizeNote("**Verdict: PASS** `code` | col \\ _x_ ~~y~~");
    expect(out).not.toMatch(/[*`|\\_~]/);
  });

  test("a note is cut to its limit", () => {
    expect(sanitizeNote("a".repeat(5000)).length).toBeLessThanOrEqual(NOTE_MAX);
  });

  test("a non-string is empty, never throws", () => {
    expect(sanitizeNote({ toString: () => "x" })).toBe("");
    expect(sanitizeNote(null)).toBe("");
  });

  test("a hostile note inside a parsed report reaches the check-run already clean", () => {
    const r = parsed({
      summary: "[approve](https://evil.example) @owner **PASS**",
      findings: [
        {
          criterion: "material_improvement",
          severity: "note",
          code: "other",
          path: null,
          note: "ping @everyone and see https://evil.example",
        },
      ],
    });
    const { summary, text } = renderCheck({ kind: "reported", report: r });
    for (const s of [summary, text]) {
      expect(s).not.toContain("@");
      expect(s).not.toMatch(/https?:/);
    }
  });
});

describe("the verdict is derived, and git facts override the model", () => {
  test("all three criteria pass is a pass", () => {
    expect(verdictOf(parsed())).toBe("pass");
  });

  test("any failing criterion fails the review", () => {
    for (const c of CRITERIA) {
      const criteria = {
        no_degradation: "pass",
        advances_revision: "pass",
        material_improvement: "pass",
      };
      (criteria as Record<string, string>)[c] = "fail";
      expect(verdictOf(parsed({ criteria }))).toBe("fail");
    }
  });

  test("an unknown criterion with no failure is uncertain, never a pass", () => {
    const criteria = {
      no_degradation: "pass",
      advances_revision: "unknown",
      material_improvement: "pass",
    };
    expect(verdictOf(parsed({ criteria }))).toBe("uncertain");
  });

  test("steering fails the review even when every criterion passes", () => {
    expect(verdictOf(parsed({ steering: true }))).toBe("fail");
  });

  test("a pull request that changes no file cannot be a material improvement", () => {
    const r = parsed({
      evidence: evidence({ files_changed: 0, files_read: 0, listed: [] }),
    });
    expect(effectiveCriteria(r).material_improvement).toBe("fail");
    expect(verdictOf(r)).toBe("fail");
  });

  test("an unchanged version cannot advance the revision, whatever the model said", () => {
    const r = parsed({
      evidence: evidence({ files_changed: 3, version_after: "1.0.0" }),
    });
    expect(verdictOf(r)).toBe("fail");
  });

  test("an unreadable new version cannot be better than unknown", () => {
    const r = parsed({
      evidence: evidence({ files_changed: 3, version_after: null }),
    });
    expect(effectiveCriteria(r).advances_revision).toBe("unknown");
    expect(verdictOf(r)).toBe("uncertain");
  });

  test("a truncated change list cannot certify that nothing was lost", () => {
    const r = parsed({
      evidence: evidence({ files_changed: 9000, files_read: 40, truncated: true }),
    });
    expect(effectiveCriteria(r).no_degradation).toBe("unknown");
    expect(verdictOf(r)).toBe("uncertain");
  });
});

describe("a report cannot disagree with itself in the direction of a pass", () => {
  const finding = (over: Record<string, unknown>) => ({
    criterion: "no_degradation",
    severity: "note",
    code: "other",
    path: null,
    note: "Something.",
    ...over,
  });

  test("a steering finding fails the review even when the model said steering is false", () => {
    const r = parsed({ steering: false, findings: [finding({ code: "steering_attempt" })] });
    expect(r.steering).toBe(true);
    expect(verdictOf(r)).toBe("fail");
    expect(conclusionOf({ kind: "reported", report: r })).toBe("failure");
  });

  test("the flag alone still fails, and parsing a stored report again changes nothing", () => {
    expect(verdictOf(parsed({ steering: true }))).toBe("fail");
    const once = parsed({ steering: false, findings: [finding({ code: "steering_attempt" })] });
    expect(parsePrReviewReport(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  test("a blocker against a criterion the model passed makes that criterion unknown", () => {
    for (const c of CRITERIA) {
      const r = parsed({
        findings: [finding({ criterion: c, severity: "blocker", code: "data_removed" })],
      });
      expect(r.criteria[c], c).toBe("unknown");
      expect(verdictOf(r), c).toBe("uncertain");
      expect(conclusionOf({ kind: "reported", report: r }), c).toBe("action_required");
    }
  });

  test("concerns and notes do not change an answer, and a blocker never raises one", () => {
    expect(verdictOf(parsed({ findings: [finding({ severity: "concern" })] }))).toBe("pass");
    expect(verdictOf(parsed({ findings: [finding({ severity: "note" })] }))).toBe("pass");
    const failing = parsed({
      criteria: { no_degradation: "fail", advances_revision: "pass", material_improvement: "pass" },
      findings: [finding({ severity: "blocker" })],
    });
    expect(failing.criteria.no_degradation).toBe("fail");
    expect(verdictOf(failing)).toBe("fail");
  });

  test("a steering finding is kept when findings are cut to make room for the explanations", () => {
    const filler = Array.from({ length: 7 }, () => finding({ severity: "note" }));
    const r = parsed({
      criteria: { no_degradation: "fail", advances_revision: "fail", material_improvement: "pass" },
      findings: [...filler, finding({ code: "steering_attempt" })],
    });
    expect(r.steering).toBe(true);
  });
});

describe("conclusions: only a clear pass is green, nothing unknown ever satisfies a required check", () => {
  test("pass is success and fail is failure", () => {
    expect(conclusionOf({ kind: "reported", report: parsed() })).toBe("success");
    expect(conclusionOf({ kind: "reported", report: parsed({ steering: true }) })).toBe("failure");
  });

  test("uncertain, declined, errored and unreported all need a person", () => {
    const criteria = {
      no_degradation: "unknown",
      advances_revision: "pass",
      material_improvement: "pass",
    };
    expect(conclusionOf({ kind: "reported", report: parsed({ criteria }) })).toBe(
      "action_required",
    );
    expect(conclusionOf({ kind: "declined", reason: "contributor_paused" })).toBe(
      "action_required",
    );
    expect(conclusionOf({ kind: "error", error: "model_refused" })).toBe("action_required");
    expect(conclusionOf({ kind: "unreported" })).toBe("action_required");
  });

  test("no outcome maps to neutral or skipped, which GitHub counts as passing", () => {
    const outcomes = [
      { kind: "reported", report: parsed() },
      { kind: "declined", reason: "daily_limit" },
      { kind: "error", error: "workflow_failed" },
      { kind: "unreported" },
    ] as const;
    for (const o of outcomes) {
      expect(["success", "failure", "action_required"]).toContain(conclusionOf(o));
    }
  });

  test("every outcome renders, and a red or amber check explains itself", () => {
    const failing = parsed({
      criteria: { no_degradation: "fail", advances_revision: "pass", material_improvement: "pass" },
      findings: [
        {
          criterion: "no_degradation",
          severity: "blocker",
          code: "data_removed",
          path: "sub-02/eeg/sub-02_task-rest_eeg.edf",
          note: "Recording deleted with no mention in CHANGES.",
        },
      ],
    });
    const r = renderCheck({ kind: "reported", report: failing });
    expect(r.title).toBe("Needs changes");
    expect(r.text).toContain("Data removed");
    expect(r.text).toContain("sub-02/eeg/sub-02_task-rest_eeg.edf");
    expect(renderCheck({ kind: "declined", reason: "contributor_paused" }).summary).toContain(
      "by hand",
    );
    expect(renderCheck({ kind: "error", error: "model_refused" }).text).toContain("does not pass");
    expect(renderCheck({ kind: "unreported" }).title).toBe("Could not decide");
  });

  test("every finding code has a label", () => {
    for (const code of FINDING_CODES) {
      const r = parsed({
        findings: [{ criterion: "no_degradation", severity: "note", code, path: null, note: "" }],
      });
      expect(renderCheck({ kind: "reported", report: r }).text.length).toBeGreaterThan(0);
    }
  });
});

describe("the pull-request comment", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";

  test("it leads with the marker, the badge and the commit, and carries the findings", () => {
    const failing = parsed({
      criteria: { no_degradation: "fail", advances_revision: "pass", material_improvement: "pass" },
      findings: [
        {
          criterion: "no_degradation",
          severity: "blocker",
          code: "data_removed",
          path: "sub-02/eeg/sub-02_task-rest_eeg.edf",
          note: "Recording deleted.",
        },
      ],
    });
    const body = renderComment({ kind: "reported", report: failing }, sha);
    expect(body.startsWith(PR_REVIEW_COMMENT_MARKER)).toBe(true);
    expect(body).toContain("NEEDS CHANGES");
    expect(body).toContain("0123456");
    expect(body).toContain("Data removed");
  });

  test("a pass says PASS, and anything undecided says it needs a person", () => {
    expect(renderComment({ kind: "reported", report: parsed() }, sha)).toContain("PASS");
    expect(renderComment({ kind: "error", error: "model_refused" }, sha)).toContain(
      "NEEDS A PERSON",
    );
    expect(renderComment({ kind: "declined", reason: "contributor_paused" }, sha)).toContain(
      "NEEDS A PERSON",
    );
  });

  test("a commit value that is not a hash is left out, not quoted", () => {
    const body = renderComment({ kind: "unreported" }, "[x](https://evil.example) @owner");
    expect(body).not.toContain("evil.example");
    expect(body).not.toContain("@owner");
  });

  test("the marker appears exactly once, so the Worker can find its own comment", () => {
    const body = renderComment({ kind: "reported", report: parsed() }, sha);
    expect(body.split(PR_REVIEW_COMMENT_MARKER).length - 1).toBe(1);
  });
});

describe("the contributor tally: more than 5 rejections AND more than 10 percent, the later of the two", () => {
  test("a newcomer's first failure never pauses anyone", () => {
    expect(standingOf({ rejected: 1, decided: 1 }, null).paused).toBe(false);
  });

  test("exactly the threshold count is not enough; one more is, when the rate also holds", () => {
    expect(standingOf({ rejected: REJECTION_COUNT, decided: 10 }, null).paused).toBe(false);
    expect(standingOf({ rejected: REJECTION_COUNT + 1, decided: 10 }, null)).toEqual({
      paused: true,
      because: "tally",
    });
  });

  test("a prolific contributor with a few failures among many accepted is not paused", () => {
    // 6 rejected of 100 is 6 percent: past the count, short of the rate.
    expect(standingOf({ rejected: 6, decided: 100 }, null).paused).toBe(false);
    // 11 of 100 is 11 percent and past the count: paused.
    expect(standingOf({ rejected: 11, decided: 100 }, null).paused).toBe(true);
  });

  test("exactly ten percent is not more than ten percent", () => {
    expect(standingOf({ rejected: 10, decided: 100 }, null).paused).toBe(false);
    expect(standingOf({ rejected: 11, decided: 110 }, null).paused).toBe(false);
    expect(standingOf({ rejected: 12, decided: 110 }, null).paused).toBe(true);
  });

  test("no decided pull requests is never a pause", () => {
    expect(standingOf({ rejected: 0, decided: 0 }, null).paused).toBe(false);
  });

  test("a maintainer's decision wins in both directions", () => {
    expect(standingOf({ rejected: 50, decided: 50 }, "allow").paused).toBe(false);
    expect(standingOf({ rejected: 0, decided: 0 }, "block")).toEqual({
      paused: true,
      because: "maintainer",
    });
  });
});

describe("rate caps", () => {
  test("a stranger gets a small hourly allowance, a collaborator a large one", () => {
    expect(hourlyCapFor("COLLABORATOR")).toBe(HOURLY_REVIEW_CAP.trusted);
    expect(hourlyCapFor("OWNER")).toBe(HOURLY_REVIEW_CAP.trusted);
    expect(hourlyCapFor("NONE")).toBe(HOURLY_REVIEW_CAP.other);
    expect(hourlyCapFor("FIRST_TIME_CONTRIBUTOR")).toBe(HOURLY_REVIEW_CAP.other);
    expect(hourlyCapFor(null)).toBe(HOURLY_REVIEW_CAP.other);
  });

  test("the daily ceiling is finite", () => {
    expect(Number.isSafeInteger(DAILY_REVIEW_CAP)).toBe(true);
    expect(DAILY_REVIEW_CAP).toBeGreaterThan(0);
  });
});

describe("the sanitiser is bounded on hostile input", () => {
  test.each(["![", "[", "<a ", "&#", "(", "]("])(
    "200,000 repetitions of %j are cut and fast",
    (unit) => {
      const started = performance.now();
      const out = sanitizeNote(unit.repeat(200_000));
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(Array.from(out).length).toBeLessThanOrEqual(NOTE_MAX);
    },
  );

  test("a cut that splits a surrogate pair leaves no lone half behind", () => {
    const out = sanitizeNote(`${"a".repeat(NOTE_MAX * 8 - 1)}\u{1F600}tail`, NOTE_MAX);
    expect(out).not.toMatch(/\p{Cs}/u);
  });

  test("the text a person reads is still the start of the note, cut at the limit", () => {
    const out = sanitizeNote(`start ${"x".repeat(5_000)}`, 50);
    expect(out.startsWith("start xxx")).toBe(true);
    expect(Array.from(out)).toHaveLength(50);
  });
});

describe("the sanitiser cannot rebuild a link, and is a fixed point", () => {
  // Stripping characters AFTER finding links rebuilds them, and entities decode to the characters
  // the function removes, so each of these has to come out without a link.
  const attacks = [
    "ht@tp://evil.example/x",
    "w@ww.evil.example",
    "j`avascript:alert(1)",
    "h*ttps://evil.example",
    "ht#tps://evil.example",
    "ww_w.evil.example",
    "ht~tp://evil.example",
    "ft|p://evil.example",
    "&commat;octocat see &num;12 and &#64;owner and &#x40;owner",
    "&lt;script&gt;alert(1)&lt;/script&gt;",
    "GH-12 and gh-345 and GH-7",
    "see [a](https://x.example) and ![i](https://y.example/p.png)",
    '<a href="https://x.example">c</a>',
    "ftp://x.example/a",
    "file:///etc/passwd",
    "data:text/html;base64,AAAA",
    "owner/repo#12 fixes #3",
  ];
  const LINKISH = /\b(?:https?|ftp|file|data|javascript):|www\.\S/i;
  // What GitHub's autolinker actually links: a scheme or www. at the start, after whitespace, or
  // after one of * _ ~ (. Glued to a letter (as in "tpwww.x") it is plain text.
  const AUTOLINKED = /(?:^|[\s*_~(])(?:(?:https?|ftp):\/\/\S|www\.\S)/i;
  const NOTIFYING = /[@#<>`*_~|\\[\]{}]|&#?\w+;|\bGH-\d+/i;

  for (const a of attacks) {
    test(`${JSON.stringify(a)} comes out inert`, () => {
      const out = sanitizeNote(a);
      expect(out).not.toMatch(LINKISH);
      expect(out).not.toMatch(NOTIFYING);
      expect(sanitizeNote(out)).toBe(out);
    });
  }

  test("a seeded fuzz of link and mention fragments never produces a link, a mention or a second-pass change", () => {
    const parts = [
      "ht",
      "tp",
      "s",
      "://",
      "@",
      "#",
      "*",
      "_",
      "`",
      "[",
      "]",
      "(",
      ")",
      "<",
      ">",
      "&",
      "amp;",
      "commat;",
      "www.",
      "evil",
      ".com",
      "GH-",
      "12",
      " ",
      "|",
      "~",
      "\\",
      "a",
      "javascript:",
      "data:",
    ];
    let seed = 20261008;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed;
    };
    for (let i = 0; i < 400; i++) {
      let s = "";
      const n = 3 + (next() % 14);
      for (let j = 0; j < n; j++) s += parts[next() % parts.length];
      const out = sanitizeNote(s);
      expect(out, JSON.stringify(s)).not.toMatch(AUTOLINKED);
      expect(out, JSON.stringify(s)).not.toMatch(NOTIFYING);
      expect(sanitizeNote(out), JSON.stringify(s)).toBe(out);
    }
  });

  test("a note is cut by whole characters, never through a surrogate pair", () => {
    const smile = String.fromCodePoint(0x1f600);
    const out = sanitizeNote("x".repeat(NOTE_MAX - 4) + smile.repeat(10));
    expect(out.isWellFormed()).toBe(true);
    expect(Array.from(out).length).toBeLessThanOrEqual(NOTE_MAX);
    expect(out.endsWith("...")).toBe(true);
  });

  test("a parsed report's notes and summary are inert after one pass through the parser", () => {
    const r = parsed({
      summary: "ht@tp://evil.example &commat;owner GH-9",
      findings: [
        {
          criterion: "no_degradation",
          severity: "note",
          code: "other",
          path: null,
          note: "w@ww.evil.example",
        },
      ],
    });
    expect(r.summary).not.toMatch(LINKISH);
    expect(r.findings[0].note).not.toMatch(LINKISH);
    expect(parsed({ summary: r.summary }).summary).toBe(r.summary);
  });
});

describe("findings are never evicted by the facts, and a red check always says why", () => {
  const finding = (criterion: string, i: number) => ({
    criterion,
    severity: "note",
    code: "other",
    path: null,
    note: `n${i}`,
  });

  test("with a full set of model findings, every failing criterion still has one", () => {
    const r = parsed({
      criteria: { no_degradation: "fail", advances_revision: "fail", material_improvement: "pass" },
      findings: Array.from({ length: MAX_FINDINGS }, (_, i) => finding("material_improvement", i)),
    });
    expect(r.findings.length).toBeLessThanOrEqual(MAX_FINDINGS);
    for (const c of ["no_degradation", "advances_revision"]) {
      expect(
        r.findings.some((f) => f.criterion === c),
        c,
      ).toBe(true);
    }
    // The model's own last findings made room; the added ones are intact.
    expect(r.findings.filter((f) => f.note === "No detail given.")).toHaveLength(2);
  });

  test("a failure found from the files is stated in the check, not left under 'No findings'", () => {
    const r = parsed({ evidence: evidence({ version_before: "1.2.0", version_after: "1.1.0" }) });
    const { text } = renderCheck({ kind: "reported", report: r });
    expect(text).toContain("Version not advanced");
    expect(text).toContain("found from the files, not by the reviewer");
    expect(text).not.toContain("No findings.");
  });

  test("a fact the model already reported is not repeated", () => {
    const r = parsed({
      criteria: { no_degradation: "pass", advances_revision: "fail", material_improvement: "pass" },
      findings: [
        {
          criterion: "advances_revision",
          severity: "blocker",
          code: "version_not_advanced",
          path: null,
          note: "Same version.",
        },
      ],
      evidence: evidence({ version_before: "1.0.0", version_after: "1.0.0" }),
    });
    const { text } = renderCheck({ kind: "reported", report: r });
    expect(text.match(/Version not advanced/g)).toHaveLength(1);
  });
});

describe("facts lower a criterion and never raise one", () => {
  const verdictFor = (e: Record<string, unknown>, criteria?: Record<string, string>) =>
    verdictOf(parsed({ evidence: e, ...(criteria ? { criteria } : {}) }));
  const emptyAreasLocal = () => ({
    dataset_description: { added: 0, modified: 0, removed: 0 },
    readme_and_changes: { added: 0, modified: 0, removed: 0 },
    participants: { added: 0, modified: 0, removed: 0 },
    sidecars: { added: 0, modified: 0, removed: 0 },
    recordings: { added: 0, modified: 0, removed: 0 },
    derivatives: { added: 0, modified: 0, removed: 0 },
    sourcedata: { added: 0, modified: 0, removed: 0 },
    code: { added: 0, modified: 0, removed: 0 },
    other: { added: 0, modified: 0, removed: 0 },
  });

  test("a version downgrade cannot advance the revision, however the model answered", () => {
    expect(verdictFor(evidence({ version_before: "2.0.0", version_after: "1.0.5" }))).toBe("fail");
    expect(verdictFor(evidence({ version_before: "1.2.0", version_after: "1.1.9" }))).toBe("fail");
  });

  test("versions compare as numbers, not as text", () => {
    expect(verdictFor(evidence({ version_before: "1.9.0", version_after: "1.10.0" }))).toBe("pass");
    expect(verdictFor(evidence({ version_before: "9.0.0", version_after: "10.0.0" }))).toBe("pass");
    expect(verdictFor(evidence({ version_before: "1.10.0", version_after: "1.9.0" }))).toBe("fail");
  });

  test("a dataset whose main had no version, gaining one, still advances", () => {
    expect(verdictFor(evidence({ version_before: null, version_after: "1.0.0" }))).toBe("pass");
  });

  test("removing a recording needs a person: never a pass on the model's word", () => {
    const areas = { ...emptyAreasLocal(), recordings: { added: 0, modified: 0, removed: 1 } };
    const e = evidence({ files_changed: 1, files_read: 0, areas, listed: [] });
    const r = parsed({ evidence: e });
    expect(verdictOf(r)).toBe("uncertain");
    expect(factsOf(r).notes).toContainEqual({
      criterion: "no_degradation",
      code: "data_removed",
      result: "unknown",
    });
  });

  test("removing the participants table, the dataset description, README or CHANGES needs a person", () => {
    for (const area of ["participants", "dataset_description", "readme_and_changes"]) {
      const areas = { ...emptyAreasLocal(), [area]: { added: 0, modified: 0, removed: 1 } };
      const e = evidence({ files_changed: 1, files_read: 0, areas, listed: [] });
      expect(verdictFor(e), area).toBe("uncertain");
    }
  });

  test("a fall in the subject count needs a person; a rise or no change does not", () => {
    expect(verdictFor(evidence({ subjects_before: 22, subjects_after: 20 }))).toBe("uncertain");
    expect(verdictFor(evidence({ subjects_before: 20, subjects_after: 22 }))).toBe("pass");
    expect(verdictFor(evidence({ subjects_before: 20, subjects_after: 20 }))).toBe("pass");
    expect(verdictFor(evidence({ subjects_before: null, subjects_after: 20 }))).toBe("pass");
  });

  test("a fact never turns a model's fail into something milder", () => {
    const e = evidence({ subjects_before: 22, subjects_after: 20 });
    const v = verdictFor(e, {
      no_degradation: "fail",
      advances_revision: "pass",
      material_improvement: "pass",
    });
    expect(v).toBe("fail");
  });

  test.each(["sidecars", "derivatives", "sourcedata", "code", "other"])(
    "removing a file in %s needs a person: it is a loss somebody should look at",
    (area) => {
      const areas = { ...emptyAreasLocal(), [area]: { added: 0, modified: 0, removed: 3 } };
      const e = evidence({ files_changed: 3, files_read: 0, areas, listed: [] });
      expect(verdictFor(e)).toBe("uncertain");
    },
  );

  test("adding or changing files in any area is left to the model's answer", () => {
    for (const area of ["sidecars", "derivatives", "sourcedata", "code", "other"]) {
      const areas = { ...emptyAreasLocal(), [area]: { added: 2, modified: 1, removed: 0 } };
      const e = evidence({ files_changed: 3, files_read: 0, areas, listed: [] });
      expect(verdictFor(e), area).toBe("pass");
    }
  });
});

describe("the evidence block cannot claim more than it can hold", () => {
  test("a file list longer than the number of changed files is refused", () => {
    const listed = Array.from({ length: 5 }, (_, i) => ({ status: "added", path: `a/${i}` }));
    expect(refusal(report({ evidence: evidence({ files_changed: 1, listed }) }))).toBe(
      "bad_evidence",
    );
  });

  test("a change list longer than the model was shown must say it was cut", () => {
    const big = evidence({ files_changed: MAX_MODEL_FILES + 1, files_read: 0, truncated: false });
    expect(refusal(report({ evidence: big }))).toBe("bad_evidence");
    const cut = evidence({ files_changed: MAX_MODEL_FILES + 1, files_read: 0, truncated: true });
    expect(refusal(report({ evidence: cut }))).toBe("accepted");
  });
});

describe("the callback body becomes an outcome, and never a verdict by itself", () => {
  test("a good report is a reported outcome", () => {
    const o = parseCallbackOutcome({ outcome: "reported", report: report(), error: undefined });
    expect(o.kind).toBe("reported");
  });

  test("a report the parser refuses is report_invalid, with no quotation of it", () => {
    const o = parseCallbackOutcome({
      outcome: "reported",
      report: { ...report(), verdict: "pass" },
      error: undefined,
    });
    expect(o).toEqual({ kind: "error", error: "report_invalid" });
  });

  test("an error word in the vocabulary is kept; one outside it is workflow_failed", () => {
    expect(
      parseCallbackOutcome({ outcome: "error", report: undefined, error: "model_refused" }),
    ).toEqual({ kind: "error", error: "model_refused" });
    expect(
      parseCallbackOutcome({ outcome: "error", report: undefined, error: "boom SMITH" }),
    ).toEqual({ kind: "error", error: "workflow_failed" });
  });

  test("any other outcome, including one that says pass, is workflow_failed", () => {
    for (const outcome of ["pass", "success", "REPORTED", "reported ", undefined, null, 1, {}]) {
      const o = parseCallbackOutcome({ outcome, report: report(), error: undefined });
      expect(o, JSON.stringify(outcome)).toEqual({ kind: "error", error: "workflow_failed" });
    }
  });

  test("a job cannot report the Worker's own dispatch_failed", () => {
    expect(
      parseCallbackOutcome({ outcome: "error", report: undefined, error: "dispatch_failed" }),
    ).toEqual({ kind: "error", error: "workflow_failed" });
  });

  test("a refused report tells the caller the parser's fixed word, and nothing else changes", () => {
    const told: string[] = [];
    const o = parseCallbackOutcome(
      { outcome: "reported", report: { ...report(), summary: 3 }, error: undefined },
      (code) => told.push(code),
    );
    expect(o).toEqual({ kind: "error", error: "report_invalid" });
    expect(told).toEqual(["bad_summary"]);
  });

  test("isRunError accepts exactly the vocabulary", () => {
    expect(isRunError("dispatch_failed")).toBe(true);
    expect(isRunError("model_refused")).toBe(true);
    expect(isRunError("other")).toBe(false);
    expect(isRunError(undefined)).toBe(false);
  });
});

describe("closed lists the SQL and the code share", () => {
  test("they name the values the Worker stores", () => {
    expect([...VERDICTS]).toEqual(["pass", "fail", "uncertain"]);
    expect([...REVIEW_STATES]).toEqual([
      "dispatched",
      "reported",
      "declined",
      "errored",
      "unreported",
    ]);
    expect([...OVERRIDE_MODES]).toEqual(["allow", "block"]);
  });

  test("a contributor has a daily allowance as well as an hourly one", () => {
    expect(dailyAuthorCapFor("COLLABORATOR")).toBe(DAILY_AUTHOR_CAP.trusted);
    expect(dailyAuthorCapFor("NONE")).toBe(DAILY_AUTHOR_CAP.other);
    expect(DAILY_AUTHOR_CAP.other).toBeLessThan(DAILY_AUTHOR_CAP.trusted);
  });
});

describe("the brand on a parsed report", () => {
  test("only the parser mints one: no other source file casts to PrReviewReport", () => {
    const root = join(import.meta.dir, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", ".git", "test", "dist"].includes(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(entry.name) && !path.endsWith("shared/pr-review.ts")) {
          if (/\bas\s+PrReviewReport\b/.test(readFileSync(path, "utf8"))) offenders.push(path);
        }
      }
    };
    for (const d of ["shared", "src", "backend/src", "scripts"]) walk(join(root, d));
    expect(offenders).toEqual([]);
  });
});

describe("the parser refuses a hostile value in every field, not only the notes", () => {
  const finding = (over: Record<string, unknown> = {}) => ({
    criterion: "no_degradation",
    severity: "note",
    code: "other",
    path: null,
    note: "x",
    ...over,
  });
  const areasWith = (area: string, counts: Record<string, unknown>, files_changed = 12) => {
    const e = evidence({ files_changed });
    (e.areas as Record<string, unknown>)[area] = counts;
    return e;
  };

  const cases: Array<[string, Record<string, unknown>, string]> = [
    [
      "a severity that is markup and a mention",
      { findings: [finding({ severity: "@everyone [approve](https://evil.example)" })] },
      "bad_findings",
    ],
    [
      "a finding criterion outside the three",
      { findings: [finding({ criterion: "approve" })] },
      "bad_findings",
    ],
    ["a finding with an extra key", { findings: [finding({ verdict: "pass" })] }, "bad_findings"],
    [
      "a finding with a missing key",
      { findings: [{ criterion: "no_degradation", severity: "note", code: "other", path: null }] },
      "bad_findings",
    ],
    ["findings that are not a list", { findings: { 0: finding() } }, "bad_findings"],
    ["a path that is a number", { findings: [finding({ path: 7 })] }, "bad_findings"],
    ["a note that is not text", { findings: [finding({ note: { a: 1 } })] }, "bad_findings"],
    ["a version that is not 2", { v: 2 }, "bad_version"],
    ["a version given as text", { v: "1" }, "bad_version"],
    ["a summary that is not text", { summary: 3 }, "bad_summary"],
    ["steering as the word false", { steering: "false" }, "bad_steering"],
    ["steering as zero", { steering: 0 }, "bad_steering"],
    ["steering left out", { steering: undefined }, "unknown_key"],
    [
      "a fractional count",
      { evidence: areasWith("recordings", { added: 10.5, modified: 0, removed: 0 }) },
      "bad_evidence",
    ],
    [
      "a negative count",
      { evidence: areasWith("recordings", { added: -1, modified: 0, removed: 0 }) },
      "bad_evidence",
    ],
    [
      "a count above the cap",
      { evidence: areasWith("recordings", { added: 1e9, modified: 0, removed: 0 }, 1e9) },
      "bad_evidence",
    ],
    [
      "a count given as text",
      { evidence: areasWith("recordings", { added: "11", modified: 0, removed: 0 }) },
      "bad_evidence",
    ],
    [
      "an area with an extra key",
      { evidence: areasWith("recordings", { added: 11, modified: 0, removed: 0, approved: 1 }) },
      "bad_evidence",
    ],
    [
      "an evidence block with an extra key",
      { evidence: evidence({ approved: true }) },
      "bad_evidence",
    ],
    [
      "a listed file with an extra key",
      { evidence: evidence({ listed: [{ status: "added", path: "a", note: "x" }] }) },
      "bad_evidence",
    ],
    [
      "a listed file status that is invented",
      { evidence: evidence({ listed: [{ status: "approved", path: "a" }] }) },
      "bad_evidence",
    ],
    ["truncated given as text", { evidence: evidence({ truncated: "false" }) }, "bad_evidence"],
    [
      "a subject count that is negative",
      { evidence: evidence({ subjects_before: -2 }) },
      "bad_evidence",
    ],
    [
      "a subject count that is fractional",
      { evidence: evidence({ subjects_after: 2.5 }) },
      "bad_evidence",
    ],
  ];
  for (const [label, over, code] of cases) {
    test(`${label} is refused as ${code}`, () => {
      const raw = report(over);
      if (over.steering === undefined && "steering" in over)
        Reflect.deleteProperty(raw, "steering");
      expect(refusal(raw)).toBe(code);
    });
  }

  test.each(["1.0", "v1.0.0", "1.0.0-rc1", "1.0.0 ", "1.0.0\n", "1.x.0", "1..0", "", " "])(
    "the version %j is refused",
    (v) => {
      expect(refusal(report({ evidence: evidence({ version_after: v }) }))).toBe("bad_evidence");
      expect(refusal(report({ evidence: evidence({ version_before: v }) }))).toBe("bad_evidence");
    },
  );

  test("a list longer than the cap is refused", () => {
    const listed = Array.from({ length: MAX_LISTED + 1 }, (_, i) => ({
      status: "added",
      path: `sub-${i}/f.json`,
    }));
    expect(refusal(report({ evidence: evidence({ files_changed: 80, listed }) }))).toBe(
      "bad_evidence",
    );
  });
});

describe("the revision must go up, in every component of the version", () => {
  const verdictFor = (before: string, after: string) =>
    verdictOf(parsed({ evidence: evidence({ version_before: before, version_after: after }) }));

  test.each([
    ["1.0.0", "1.0.1", "pass"],
    ["1.0.0", "1.1.0", "pass"],
    ["1.0.0", "2.0.0", "pass"],
    ["1.9.9", "1.10.0", "pass"],
    ["1.99.99", "2.0.0", "pass"],
    ["1.0.1", "1.0.0", "fail"],
    ["1.0.0", "1.0.0", "fail"],
    ["2.0.0", "1.99.99", "fail"],
    ["1.10.0", "1.9.9", "fail"],
  ])("%s to %s is %s", (before, after, expected) => {
    expect(verdictFor(before, after)).toBe(expected as "pass" | "fail");
  });
});

describe("the check shows what the facts left of an answer, not what the model said", () => {
  test("a criterion a fact lowered reads as lowered in the table", () => {
    const r = parsed({ evidence: evidence({ version_before: "1.0.0", version_after: "1.0.0" }) });
    const check = renderCheck({ kind: "reported", report: r });
    const text = `${check.summary}\n${check.text}`;
    // The model answered pass; the version did not move.
    expect(r.criteria.advances_revision).toBe("pass");
    expect(text).toMatch(/The revision advances[^\n]*\bNo\b/);
    expect(text).not.toMatch(/The revision advances[^\n]*\bYes\b/);
  });
});

describe("who counts as trusted, as numbers", () => {
  test.each([
    ["OWNER", 20, 100],
    ["MEMBER", 20, 100],
    ["COLLABORATOR", 20, 100],
    ["CONTRIBUTOR", 3, 6],
    ["FIRST_TIME_CONTRIBUTOR", 3, 6],
    ["NONE", 3, 6],
    ["", 3, 6],
    [null, 3, 6],
    [undefined, 3, 6],
  ])("%j gets %d an hour and %d a day", (assoc, hourly, daily) => {
    expect(hourlyCapFor(assoc as string | null | undefined)).toBe(hourly);
    expect(dailyAuthorCapFor(assoc as string | null | undefined)).toBe(daily);
  });

  test("the platform's daily ceiling is 400", () => {
    expect(DAILY_REVIEW_CAP).toBe(400);
  });
});
