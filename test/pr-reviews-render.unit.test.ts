/**
 * What `nemar admin pr-reviews` puts on a terminal, tested as the pure functions it is made of
 * (ADR 0093). The spawned-CLI suite goes through the real Worker, which has already reduced
 * author-controlled text to plain words, so it would pass with every one of the CLI's own
 * `plain()` calls deleted. These tests feed the CLI hostile text directly, which is the only way
 * to prove the CLI does not depend on a server's hygiene.
 */

import { describe, expect, test } from "bun:test";
import type {
  ContributorStanding,
  QueueEntry,
  StartReviewResponse,
  VolumeWindow,
  WaiveNamingResponse,
} from "../shared/contract/pr-review-admin";
import {
  parsePrReviewReport,
  parseStoredPrReviewReport,
  renderCheck,
  verdictOf,
} from "../shared/pr-review";
import {
  ageOf,
  briefLines,
  namingFactLines,
  notStartedText,
  plain,
  renderQueue,
  reportLines,
  standingLines,
  startAllQuestion,
  terminalize,
  tokenText,
  verdictText,
  volumeLines,
  waiverLines,
} from "../src/commands/admin-pr-reviews";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
/** Anything a terminal could act on: control, format (zero-width, bidi overrides), line and paragraph separators. */
const DANGEROUS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// Escape sequences, a bidirectional override, a zero-width space and a line separator, written as
// escapes so the fixture is readable in a diff.
const HOSTILE = `${ESC}[2J${ESC}]0;title\u0007x\u202ey\u200bz\u2028w`;

function entry(over: Partial<QueueEntry> = {}): QueueEntry {
  return {
    dataset_id: "nm000201",
    pr_number: 7,
    url: "https://github.com/nemarDatasets/nm000201/pull/7",
    title: "Add subjects",
    author_login: "alice",
    author_id: 42,
    from_fork: false,
    head_label: "add-subjects",
    head_sha: "a".repeat(40),
    draft: false,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-02T00:00:00Z",
    verdict: "pass",
    detail: null,
    reviewed_sha: "a".repeat(40),
    review_current: true,
    stale_verdict: null,
    bids: "pass",
    version: "pass",
    needs_you: true,
    ...over,
  };
}

function standing(over: Partial<ContributorStanding> = {}): ContributorStanding {
  return {
    login: "alice",
    author_id: 77,
    tally: { rejected: 0, decided: 0 },
    override: null,
    standing: { paused: false },
    recent: [],
    resolved_from: "github",
    ...over,
  };
}

describe("plain", () => {
  test("removes what a terminal could act on, keeps the words, and says nothing for a non-string", () => {
    expect(plain(HOSTILE)).toBe("[2J]0;titlexyzw");
    expect(DANGEROUS.test(plain(HOSTILE))).toBe(false);
    expect(plain("a plain sentence")).toBe("a plain sentence");
    for (const notText of [undefined, null, 7, {}, ["x"]]) expect(plain(notText)).toBe("");
  });
});

describe("terminalize", () => {
  test("keeps the report's layout and strips control characters line by line", () => {
    const md = [
      "| Area | Added |",
      "| --- | ---: |",
      `| Code | 2${ESC}[31m |`,
      "",
      "",
      "",
      "<details><summary>Changed files (1 of 3)</summary>",
      "",
      "- changed `a.json`   ",
      "",
      "</details>",
    ].join("\n");
    const out = terminalize(md).replace(ANSI, "");
    const lines = out.split("\n");
    expect(lines.slice(0, 3)).toEqual(["| Area | Added |", "| --- | ---: |", "| Code | 2[31m |"]);
    expect(lines).toContain("Changed files (1 of 3)");
    expect(lines).toContain("- changed `a.json`");
    expect(out).not.toMatch(/<\/?(details|summary)>/);
    expect(out).not.toMatch(/\n{3,}/);
    expect(DANGEROUS.test(out.replaceAll("\n", ""))).toBe(false);
  });
});

describe("renderQueue", () => {
  test("no line carries a control sequence, whatever the server sent", () => {
    const lines = renderQueue([
      entry({
        dataset_id: `nm00${HOSTILE}`,
        author_login: HOSTILE,
        head_label: HOSTILE,
        url: `https://x.test/${HOSTILE}`,
        detail: HOSTILE as never,
        verdict: "not_reviewed",
      }),
    ]);
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(DANGEROUS.test(l.replace(ANSI, ""))).toBe(false);
  });

  test("marks what you can act on, flags drafts, and names another commit's review", () => {
    const rows = renderQueue([
      entry({ pr_number: 1 }),
      entry({ pr_number: 2, needs_you: false, verdict: "fail" }),
      entry({ pr_number: 3, draft: true, needs_you: false }),
      entry({
        pr_number: 4,
        verdict: "not_reviewed",
        review_current: false,
        stale_verdict: "pass",
      }),
    ]).map((l) => l.replace(ANSI, ""));
    expect(rows[0]).toMatch(/^ +DATASET +PR +AUTHOR +FROM +REVIEW +BIDS +VERSION +AGE +LINK$/);
    expect(rows[1]).toMatch(/^\* nm000201 +#1 /);
    expect(rows[2]).toMatch(/^ {2}nm000201 +#2 .* fail /);
    expect(rows[3]).toContain("pass [draft]");
    expect(rows[4]).toContain("not reviewed (other commit)");
    // An owner's or administrator's pull request is named for what it is, in the word the API
    // sends, and is not marked as yours to act on.
    const exempt = renderQueue([entry({ verdict: "exempt", needs_you: false })]).map((l) =>
      l.replace(ANSI, ""),
    );
    expect(exempt[1]).toContain("exempt (owner or admin)");
    expect(exempt[1]).toMatch(/^ {2}nm000201 /);
    // Fork or branch.
    expect(rows[1]).toContain("branch add-subjects");
    expect(renderQueue([entry({ from_fork: true, head_label: "bob:fix" })])[1]).toContain(
      "fork bob:fix",
    );
  });

  test("an exempt row the naming rule holds says what releases it, whole, even as a draft", () => {
    const rows = renderQueue([
      entry({ pr_number: 1, verdict: "exempt", detail: "naming_rule", needs_you: false }),
      entry({
        pr_number: 2,
        verdict: "exempt",
        detail: "naming_unchecked",
        draft: true,
        needs_you: false,
      }),
      entry({ pr_number: 3, verdict: "exempt", detail: null, needs_you: false }),
    ]).map((l) => l.replace(ANSI, ""));
    expect(rows[1]).toContain("exempt, naming rule failed: needs allow --admin  ");
    expect(rows[2]).toContain(
      "exempt, naming rule not checked: start once, else fix the file [draft]",
    );
    // Whole: nothing the table cut off.
    expect(rows.join("\n")).not.toContain("…");
    // The plain exemption keeps its word, so the held rows are told apart from it.
    expect(rows[3]).toContain("exempt (owner or admin)");
    expect(rows[3]).not.toContain("naming rule");
    // The columns still line up with the longer word in the column.
    const linkColumn = rows.map((l) =>
      l.indexOf("https://") === -1 ? l.indexOf("LINK") : l.indexOf("https://"),
    );
    expect(new Set(linkColumn).size).toBe(1);
  });

  test("a hostile detail on an exempt row is cleaned like any other", () => {
    const rows = renderQueue([
      entry({ verdict: "exempt", detail: HOSTILE as never, needs_you: false }),
    ]).map((l) => l.replace(ANSI, ""));
    expect(DANGEROUS.test(rows[1])).toBe(false);
  });

  test("an empty queue renders nothing, and the columns line up", () => {
    expect(renderQueue([])).toEqual([]);
    const rows = renderQueue([
      entry({ pr_number: 7, author_login: "al" }),
      entry({ pr_number: 12345, author_login: "a-very-long-login-name-indeed" }),
    ]).map((l) => l.replace(ANSI, ""));
    const linkColumn = rows.map((l) =>
      l.indexOf("https://") === -1 ? l.indexOf("LINK") : l.indexOf("https://"),
    );
    expect(new Set(linkColumn).size).toBe(1);
  });
});

describe("verdictText", () => {
  test("a verdict this version does not know is shown as itself and is not a pass", () => {
    const text = verdictText({ verdict: "brilliant" as never, detail: null, review_current: true });
    expect(text).toBe("brilliant");
    expect(text).not.toContain("pass");
    expect(
      verdictText({
        verdict: "could_not_decide",
        detail: "model_unavailable",
        review_current: true,
      }),
    ).toBe("could not decide (model unavailable)");
    expect(
      verdictText({ verdict: "not_reviewed", detail: "contributor_paused", review_current: null }),
    ).toBe("not reviewed (contributor paused)");
  });

  test("an owner's or administrator's pull request reads exempt (owner or admin), whatever else is on record", () => {
    expect(verdictText({ verdict: "exempt", detail: null, review_current: null })).toBe(
      "exempt (owner or admin)",
    );
    // Another commit's review does not turn it into "other commit", which is a not_reviewed word.
    expect(verdictText({ verdict: "exempt", detail: null, review_current: false })).toBe(
      "exempt (owner or admin)",
    );
  });

  test("an exempt pull request the naming rule holds says what it waits for", () => {
    expect(verdictText({ verdict: "exempt", detail: "naming_rule", review_current: null })).toBe(
      "exempt, naming rule failed: needs allow --admin",
    );
    expect(
      verdictText({ verdict: "exempt", detail: "naming_unchecked", review_current: false }),
    ).toBe("exempt, naming rule not checked: start once, else fix the file");
    // The two words belong to an exempt row alone: anywhere else they are shown as themselves.
    expect(
      verdictText({ verdict: "not_reviewed", detail: "naming_rule", review_current: true }),
    ).toBe("not reviewed (naming rule)");
  });
});

describe("ageOf", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
  test("picks the unit that reads best at each boundary", () => {
    expect(ageOf(ago(0), now)).toBe("0m");
    expect(ageOf(ago(59), now)).toBe("0m");
    expect(ageOf(ago(60), now)).toBe("1m");
    expect(ageOf(ago(3599), now)).toBe("59m");
    expect(ageOf(ago(3600), now)).toBe("1h");
    expect(ageOf(ago(86399), now)).toBe("23h");
    expect(ageOf(ago(86400), now)).toBe("1d");
    expect(ageOf(ago(86400 * 40), now)).toBe("40d");
  });
  test("a time in the future is not a negative age, and garbage is a question mark", () => {
    expect(ageOf(ago(-3600), now)).toBe("0m");
    expect(ageOf("yesterday", now)).toBe("?");
    expect(ageOf("", now)).toBe("?");
  });
});

describe("standingLines", () => {
  test("text from the server is cleaned again, and the record shows a decimal", () => {
    const lines = standingLines(
      standing({
        login: HOSTILE,
        tally: { rejected: 6, decided: 59 },
        override: {
          mode: "block",
          reason: HOSTILE,
          set_at: "2026-10-01 00:00:00",
          set_by: HOSTILE,
        },
        standing: { paused: true, because: "maintainer" },
        recent: [
          {
            dataset_id: HOSTILE,
            pr_number: 3,
            head_sha: "a".repeat(40),
            verdict: "fail",
            decided_at: null,
          },
        ],
      }),
    ).map((l) => l.replace(ANSI, ""));
    for (const l of lines) expect(DANGEROUS.test(l)).toBe(false);
    // 6 of 59 is 10.17%: shown as "10%" it would read as a round number it is not.
    expect(lines.join("\n")).toContain("6 of 59 decided pull requests rejected (10.2%)");
  });

  test("a record of rejections is information, and a block is the only thing that pauses", () => {
    const record = standingLines(standing({ tally: { rejected: 9, decided: 10 } }))
      .map((l) => l.replace(ANSI, ""))
      .join("\n");
    expect(record).toContain("9 of 10 decided pull requests rejected (90.0%)");
    expect(record).toContain("does not pause anyone's reviews, only a block does");
    expect(record).toContain("not paused: reviewed automatically");
    expect(record).toContain("Decision:  none");
    // The rule that used to pause on this record is not described, and the limits are not mentioned.
    expect(record).not.toContain("MORE than");
    expect(record).not.toContain("rate limit");

    const blocked = standingLines(
      standing({
        override: { mode: "block", reason: null, set_at: "2026-10-01", set_by: "queueadmin" },
        standing: { paused: true, because: "maintainer" },
      }),
    )
      .map((l) => l.replace(ANSI, ""))
      .join("\n");
    expect(blocked).toContain("blocked by queueadmin on 2026-10-01");
    expect(blocked).toContain(
      "paused by an administrator's block: their pull requests need a person",
    );

    const allowed = standingLines(
      standing({
        override: { mode: "allow", reason: null, set_at: "2026-10-01", set_by: "queueadmin" },
      }),
    )
      .map((l) => l.replace(ANSI, ""))
      .join("\n");
    expect(allowed).toContain("allowed by queueadmin on 2026-10-01");
    expect(allowed).toContain("not paused: reviewed automatically");
  });

  test("a pause this CLI does not know the cause of is a plain pause, never called a block", () => {
    // An older Worker still pauses by the contributor's record, and says so as `tally`.
    const text = standingLines(standing({ standing: { paused: true, because: "tally" } as never }))
      .map((l) => l.replace(ANSI, ""))
      .join("\n");
    expect(text).toContain("paused: their pull requests need a person");
    expect(text).not.toContain("administrator's block");
  });

  test("says an owner or administrator is exempt whatever is decided, so a block or an allow is not misread", () => {
    for (const s of [
      standing(),
      standing({
        override: { mode: "block", reason: null, set_at: "2026-10-01", set_by: "queueadmin" },
        standing: { paused: true, because: "maintainer" },
      }),
    ]) {
      const text = standingLines(s)
        .map((l) => l.replace(ANSI, ""))
        .join("\n");
      expect(text).toContain(
        "a NEMAR owner or administrator is not reviewed whatever is decided here",
      );
    }
  });

  test("says where an identity came from when GitHub was not asked", () => {
    const text = standingLines(standing({ resolved_from: "history" })).join("\n");
    expect(text).toContain("from the Worker's records");
  });
});

describe("volumeLines", () => {
  const window = (over: Partial<VolumeWindow> = {}): VolumeWindow => ({
    reviews: 14,
    review_runs: 9,
    by_verdict: {
      pass: 5,
      fail: 4,
      uncertain: 0,
      could_not_decide: 1,
      in_progress: 0,
      not_reviewed: 4,
    },
    declines: { contributor_paused: 1, rate_limited: 1, daily_limit: 2 },
    ...over,
  });
  const text = (lines: string[]) => lines.map((l) => l.replace(ANSI, ""));

  test("says in a sentence for each window what was recorded, what it cost and what it came to", () => {
    const lines = text(
      volumeLines({
        last_24_hours: window({
          reviews: 1,
          review_runs: 1,
          by_verdict: {
            ...window().by_verdict,
            pass: 1,
            fail: 0,
            could_not_decide: 0,
            not_reviewed: 0,
          },
          declines: { contributor_paused: 0, rate_limited: 0, daily_limit: 0 },
        }),
        last_7_days: window(),
      }),
    );
    expect(lines).toEqual([
      "Review volume, for information only (no count limits reviews):",
      "  Last 24 hours: 1 review recorded, 1 review run; 1 pass.",
      "  Last 7 days:   14 reviews recorded, 9 review runs; 5 pass, 4 fail, 1 could not decide, 4 not reviewed (1 contributor paused, 1 rate limited, 2 daily limit).",
    ]);
  });

  test("a window with nothing in it says so, and a count of zero is not left out of a real one", () => {
    const quiet = window({
      reviews: 0,
      review_runs: 0,
      by_verdict: {
        pass: 0,
        fail: 0,
        uncertain: 0,
        could_not_decide: 0,
        in_progress: 0,
        not_reviewed: 0,
      },
      declines: { contributor_paused: 0, rate_limited: 0, daily_limit: 0 },
    });
    const lines = text(volumeLines({ last_24_hours: quiet, last_7_days: window() }));
    expect(lines[1]).toBe("  Last 24 hours: no reviews recorded.");
    expect(lines[2]).toContain("14 reviews recorded");
  });

  test("a volume that could not be read is said, and an older server that sent none is not made to look empty", () => {
    expect(text(volumeLines(null))).toEqual(["The review volume could not be read this time."]);
    expect(volumeLines(undefined)).toEqual([]);
  });

  test("a count that is not a whole number is a question mark and never a zero", () => {
    const broken = window({
      by_verdict: { ...window().by_verdict, pass: Number.NaN, fail: -3 },
    });
    const lines = text(
      volumeLines({ last_24_hours: broken, last_7_days: window({ reviews: 1.5 }) }),
    );
    expect(lines[1]).toContain("? pass, ? fail");
    // A window whose own totals cannot be read is not guessed at.
    expect(lines[2]).toBe("  Last 7 days:   could not be read.");
  });

  test("a breakdown the server did not send is said to be missing, and is never read as nothing", () => {
    const noBreakdown = text(
      volumeLines({
        last_24_hours: window({ by_verdict: null as never }),
        last_7_days: window({ by_verdict: undefined as never }),
      }),
    );
    expect(noBreakdown[1]).toBe(
      "  Last 24 hours: 14 reviews recorded, 9 review runs; what they came to could not be read.",
    );
    expect(noBreakdown[2]).toContain("what they came to could not be read");

    // A word every server sends and this one did not: a question mark, not a zero and not nothing.
    const { in_progress: _missing, ...rest } = window().by_verdict;
    const lines = text(
      volumeLines({
        last_24_hours: window({ by_verdict: rest as never }),
        last_7_days: window(),
      }),
    );
    expect(lines[1]).toContain("? in progress");
    expect(lines[2]).not.toContain("in progress");

    // Not reviewed with no reasons sent: the reasons are said to be missing, not left out.
    const noReasons = text(
      volumeLines({
        last_24_hours: window({ declines: undefined as never }),
        last_7_days: window({ declines: null as never }),
      }),
    );
    expect(noReasons[1]).toContain("4 not reviewed (reasons could not be read)");
    expect(noReasons[2]).toContain("4 not reviewed (reasons could not be read)");
  });

  test("a word a newer server adds is shown as itself, cleaned, after the ones this version knows", () => {
    const lines = text(
      volumeLines({
        last_24_hours: window({
          by_verdict: { ...window().by_verdict, [`brilliant${HOSTILE}`]: 2 } as never,
          declines: { ...window().declines, [`odd_reason${HOSTILE}`]: 1 } as never,
        }),
        last_7_days: window(),
      }),
    );
    for (const l of lines) expect(DANGEROUS.test(l)).toBe(false);
    expect(lines[1]).toContain("4 not reviewed (");
    expect(lines[1]).toMatch(/, 2 brilliant\[2J\]0;titlexyzw$|, 2 brilliant\[2J\]0;titlexyzw\.$/);
  });

  test("no line is JSON, a hash or an escaped string: only counts, the list's own words and punctuation", () => {
    const lines = text(volumeLines({ last_24_hours: window(), last_7_days: window() }));
    for (const l of lines) {
      expect(l).not.toMatch(/[{}"\\]|\b[0-9a-f]{12,}\b|\\u|_/);
    }
  });
});

describe("reportLines", () => {
  test("an outcome this version cannot render is said so, not thrown", () => {
    const lines = reportLines({ kind: "reported", report: {} } as never);
    expect(lines).toHaveLength(1);
    expect(lines[0].replace(ANSI, "")).toContain(
      "could not be rendered by this version of the CLI",
    );
  });

  test("a decline renders in the words the comment uses", () => {
    const text = reportLines({ kind: "declined", reason: "rate_limited" }).join("\n");
    expect(text).toContain("Not reviewed");
    expect(text).toContain("rate limited");
  });
});

describe("a version 2 report on the terminal", () => {
  const areas = {
    dataset_description: { added: 0, modified: 1, removed: 0 },
    readme_and_changes: { added: 0, modified: 0, removed: 0 },
    participants: { added: 0, modified: 0, removed: 0 },
    sidecars: { added: 0, modified: 0, removed: 0 },
    recordings: { added: 0, modified: 0, removed: 0 },
    derivatives: { added: 0, modified: 0, removed: 0 },
    sourcedata: { added: 0, modified: 0, removed: 0 },
    code: { added: 0, modified: 0, removed: 0 },
    other: { added: 0, modified: 0, removed: 0 },
  };
  const evidence = (over: Record<string, unknown> = {}) => ({
    files_changed: 1,
    files_read: 0,
    truncated: true,
    version_before: "1.0.0",
    version_after: "1.0.1",
    subjects_before: 2,
    subjects_after: 2,
    areas,
    listed: [{ status: "modified", path: "dataset_description.json" }],
    description_empty: false,
    description_cut: false,
    // Every report this file builds ended at the screen, which never read the change log.
    changelog_entry: null,
    title_problem: null,
    name_problem: null,
    ...over,
  });
  const screen = (over: Record<string, unknown> = {}) =>
    parsePrReviewReport({
      v: 2,
      stage: "screen",
      models: { screen: "claude-haiku-5-5", review: null },
      criteria: {
        genuine_contribution: "fail",
        no_degradation: "unknown",
        advances_revision: "unknown",
        material_improvement: "unknown",
        clear_title_and_description: "unknown",
        description_not_misleading: "unknown",
      },
      findings: [
        {
          criterion: "genuine_contribution",
          severity: "blocker",
          code: "spam",
          path: null,
          note: "",
        },
      ],
      summary: "The description advertises an unrelated service.",
      steering: false,
      evidence: evidence(),
      usage: { screen: { input_tokens: 900, output_tokens: 300 }, review: null },
      ...over,
    });

  test("a screen report says the revision was not assessed, not unknown", () => {
    const lines = briefLines({ kind: "reported", report: screen() }).map((l) =>
      l.replace(ANSI, ""),
    );
    expect(lines.join("\n")).toContain("revision advances: not assessed (stopped by the screen)");
    expect(lines[0]).toBe("Needs changes: stopped by the screen");
  });

  /** A report that ended at the facts: the naming rule decided it and no model was asked. */
  const factsOnly = (evidenceOver: Record<string, unknown>) =>
    parsePrReviewReport({
      v: 2,
      stage: "facts",
      models: { screen: null, review: null },
      criteria: {
        genuine_contribution: "unknown",
        no_degradation: "unknown",
        advances_revision: "unknown",
        material_improvement: "unknown",
        clear_title_and_description: "unknown",
        description_not_misleading: "unknown",
      },
      findings: [],
      summary: "",
      steering: false,
      evidence: evidence(evidenceOver),
      usage: { screen: { input_tokens: 0, output_tokens: 0 }, review: null },
    });
  const brief = (report: ReturnType<typeof factsOnly>) =>
    briefLines({ kind: "reported", report }).map((l) => l.replace(ANSI, ""));

  test("a facts report says the review did not run and why, not that the revision is unknown", () => {
    const refused = brief(factsOnly({ title_problem: "author_year" }));
    expect(refused[0]).toBe("Needs changes: the naming rule");
    expect(refused).toContain(
      "Version:  1.0.0 to 1.0.1   stage: facts only; the review did not run (the naming rule found a problem)",
    );
    expect(refused.join("\n")).not.toContain("revision advances: unknown");

    // A name that could not be read is a different reason, in the check's own words.
    const unread = brief(factsOnly({ name_problem: "unchecked" }));
    expect(unread[0]).toBe("Could not decide: the naming rule was not checked");
    expect(unread).toContain(
      "Version:  1.0.0 to 1.0.1   stage: facts only; the review did not run (the naming rule could not check the dataset name)",
    );
    expect(unread.join("\n")).not.toContain("revision advances: unknown");
  });

  test("a facts report of a DOI is printed in the naming rule's sentence, not as its code", () => {
    const lines = brief(factsOnly({ title_problem: "doi" }));
    expect(lines[0]).toBe("Needs changes: the naming rule");
    const text = lines.join("\n");
    expect(text).toContain("Naming rule:");
    expect(text).toContain("The title has a citation (an author and a year, or a DOI)");
    expect(text).toContain(
      "Version:  1.0.0 to 1.0.1   stage: facts only; the review did not run (the naming rule found a problem)",
    );
    expect(text).not.toMatch(/title_doi|\bdoi\b/);
  });

  test("a facts report whose version did not go up still says so, and then that the review did not run", () => {
    const lines = brief(factsOnly({ title_problem: "template_field", version_after: "1.0.0" }));
    expect(lines).toContain(
      "Version:  1.0.0 to 1.0.0   revision advances: NO; stage: facts only; the review did not run (the naming rule found a problem)",
    );
  });

  test("the title, the copy and the reason line follow the naming fact, not the verdict", () => {
    // A name that could not be read, with a version that did not go up: the verdict fails (the
    // revision does not advance), but the naming rule refused nothing, and every surface that says
    // why the review did not run says that the name was not checked.
    const report = factsOnly({ name_problem: "unchecked", version_after: "1.0.0" });
    expect(verdictOf(report)).toBe("fail");
    const check = renderCheck({ kind: "reported", report });
    expect(check.title).toBe("Could not decide: the naming rule was not checked");
    expect(check.summary).toContain("could not check this pull request's new dataset name");
    expect(check.summary).not.toContain("found a problem with this pull request");
    const next = brief(report);
    expect(next[0]).toBe("Could not decide: the naming rule was not checked");
    expect(next).toContain(
      "Version:  1.0.0 to 1.0.0   revision advances: NO; stage: facts only; the review did not run (the naming rule could not check the dataset name)",
    );
    const show = reportLines({ kind: "reported", report }).map((l) => l.replace(ANSI, ""));
    expect(show[0]).toBe("Could not decide: the naming rule was not checked");
    expect(show.join("\n")).toContain("could not check this pull request's new dataset name");

    // The same version with a refusal reads "found a problem" in all three, and so does a refusal
    // beside an unreadable name: what the rule found decides over what it could not read.
    for (const found of [
      { title_problem: "author_year" },
      { name_problem: "template_field" },
      { title_problem: "template_field", name_problem: "unchecked" },
    ]) {
      const refused = factsOnly({ ...found, version_after: "1.0.0" });
      expect(verdictOf(refused)).toBe("fail");
      const said = renderCheck({ kind: "reported", report: refused });
      expect(said.title, JSON.stringify(found)).toBe("Needs changes: the naming rule");
      expect(said.summary, JSON.stringify(found)).toContain(
        "found a problem with this pull request",
      );
      expect(brief(refused).join("\n"), JSON.stringify(found)).toContain(
        "(the naming rule found a problem)",
      );
    }
  });

  /** A full report: the screen let the pull request through, and the review read the files and answered. */
  const full = (criteriaOver: Record<string, string> = {}) =>
    parsePrReviewReport({
      v: 2,
      stage: "full",
      models: { screen: "claude-haiku-5-5", review: "claude-sonnet-5-5" },
      criteria: {
        genuine_contribution: "pass",
        no_degradation: "pass",
        advances_revision: "pass",
        material_improvement: "pass",
        clear_title_and_description: "pass",
        description_not_misleading: "pass",
        ...criteriaOver,
      },
      findings: [],
      summary: "Adds a subject.",
      steering: false,
      evidence: evidence({ files_read: 1, truncated: false, changelog_entry: "added" }),
      usage: {
        screen: { input_tokens: 900, output_tokens: 300 },
        review: { input_tokens: 5000, output_tokens: 700 },
      },
    });

  test("a screen report and a full report keep their own words", () => {
    const stopped = brief(screen());
    expect(stopped.join("\n")).not.toContain("stage: facts only");
    expect(stopped.join("\n")).toContain("revision advances: not assessed (stopped by the screen)");

    // A full report read the files, so an answer it could not give is unknown, and it is not said
    // to be unassessed: the review ran and could not tell.
    const unsure = brief(full({ advances_revision: "unknown" })).join("\n");
    expect(unsure).toContain("Version:  1.0.0 to 1.0.1   revision advances: unknown");
    expect(unsure).not.toContain("not assessed");
    expect(unsure).not.toContain("stage: facts only");
    // A complete one answers, and says neither.
    const sure = brief(full()).join("\n");
    expect(sure).toContain("Version:  1.0.0 to 1.0.1   revision advances: yes");
    expect(sure).not.toContain("revision advances: unknown");
    expect(sure).not.toContain("not assessed");
    expect(sure).not.toContain("stage: facts only");
  });

  test("the naming rule's findings are printed in sentences", () => {
    const lines = briefLines({
      kind: "reported",
      report: screen({ evidence: evidence({ title_problem: "author_year" }) }),
    }).map((l) => l.replace(ANSI, ""));
    const text = lines.join("\n");
    expect(text).toContain("Naming rule:");
    expect(text).toContain("The title has a citation (an author and a year, or a DOI)");
    expect(text).not.toMatch(/author_year/);
    for (const l of lines) expect(DANGEROUS.test(l)).toBe(false);
  });

  test("a stored version 1 report still renders in full", () => {
    const report = parseStoredPrReviewReport({
      v: 1,
      model: "claude-haiku-5-5",
      criteria: { no_degradation: "pass", advances_revision: "pass", material_improvement: "pass" },
      findings: [],
      summary: "Adds a subject.",
      steering: false,
      evidence: {
        files_changed: 1,
        files_read: 1,
        truncated: false,
        version_before: "1.0.0",
        version_after: "1.0.1",
        subjects_before: 2,
        subjects_after: 3,
        areas,
        listed: [],
      },
    });
    const text = reportLines({ kind: "reported", report })
      .map((l) => l.replace(ANSI, ""))
      .join("\n");
    expect(text).toContain("Passes: nothing lost, revision advances, materially better");
    expect(text).toContain("Reviewed with claude-haiku-5-5.");
  });
});

describe("startAllQuestion", () => {
  test("says how many pull requests, and that a review is a run of up to two model calls", () => {
    expect(startAllQuestion(1)).toBe(
      "Start the automated review of 1 pull request? Each is one run of up to two model calls.",
    );
    expect(startAllQuestion(3)).toBe(
      "Start the automated review of 3 pull requests? Each is one run of up to two model calls.",
    );
    expect(startAllQuestion(3)).not.toContain("one or two");
  });
});

describe("tokenText", () => {
  const window = (tokens: unknown, cost: unknown = 0.12): VolumeWindow =>
    ({
      reviews: 1,
      review_runs: 2,
      by_verdict: {},
      declines: {},
      tokens,
      estimated_cost_usd: cost,
    }) as unknown as VolumeWindow;

  test("says the totals, the stages, how many reports, and the estimate", () => {
    const text = tokenText(
      window({
        screen_input: 3000,
        screen_output: 1200,
        review_input: 20000,
        review_output: 8000,
        reviews_counted: 1,
      }),
    );
    expect(text).toBe(
      "23,000 in and 9,200 out over 1 report (screen 3,000 in, 1,200 out; review 20,000 in, 8,000 out), about $0.12 at list prices; runs that ended without a report are not counted",
    );
  });

  test("says nothing for an older server, or when no report carries its usage", () => {
    expect(tokenText(window(undefined))).toBeNull();
    expect(
      tokenText(
        window({
          screen_input: 0,
          screen_output: 0,
          review_input: 0,
          review_output: 0,
          reviews_counted: 0,
        }),
      ),
    ).toBeNull();
  });

  test("a count that cannot be read is said to be unreadable, never a zero", () => {
    expect(
      tokenText(
        window({
          screen_input: -1,
          screen_output: 0,
          review_input: 0,
          review_output: 0,
          reviews_counted: 1,
        }),
      ),
    ).toBe("token counts could not be read");
  });
});

describe("waiverLines", () => {
  const answer = (over: Partial<WaiveNamingResponse>): WaiveNamingResponse => ({
    environment: "production",
    waived: false,
    reason: "nothing_to_waive",
    head_sha: "a".repeat(40),
    facts: null,
    ...over,
  });
  const text = (r: WaiveNamingResponse) =>
    waiverLines(r, "nm000201", 7)
      .map((l) => l.replace(ANSI, ""))
      .join("\n");

  test("a waiver says what the rule found, in words, and that it is for this commit only", () => {
    const t = text(
      answer({
        waived: true,
        reason: "waived",
        facts: { title: "author_year", name: "template_field" },
      }),
    );
    expect(t).toContain("Waived the naming rule for nm000201 #7 at aaaaaaa.");
    expect(t).toContain(
      "The rule found: the title has a citation (an author and a year, or a DOI); the pull request changes the dataset name to one with an unfilled template field.",
    );
    expect(t).toContain("a new commit is checked again");
    expect(t).not.toMatch(/author_year|template_field|[{}]/);
  });

  test("a waiver of a name with a key says so in the same plain words as for a title", () => {
    const t = text(
      answer({ waived: true, reason: "waived", facts: { title: null, name: "author_year" } }),
    );
    expect(t).toContain(
      "The rule found: the pull request changes the dataset name to one that has a citation (an author and a year, or a DOI).",
    );
    expect(t).not.toMatch(/author_year|[{}]/);
  });

  test("a waiver of a DOI is told in the words of an author and a year, and not as its code", () => {
    const title = text(
      answer({ waived: true, reason: "waived", facts: { title: "doi", name: null } }),
    );
    expect(title).toContain(
      "The rule found: the title has a citation (an author and a year, or a DOI).",
    );
    const name = text(
      answer({ waived: true, reason: "waived", facts: { title: null, name: "doi" } }),
    );
    expect(name).toContain(
      "The rule found: the pull request changes the dataset name to one that has a citation (an author and a year, or a DOI).",
    );
    for (const t of [title, name]) expect(t).not.toMatch(/\bdoi\b|[{}]/);
    // A name and a title of the two kinds are one line each, since they say one thing.
    const both = text(
      answer({
        waived: true,
        reason: "waived",
        facts: { title: "doi", name: "author_year" },
      }),
    );
    expect(both).toContain(
      "The rule found: the title has a citation (an author and a year, or a DOI); the pull request changes the dataset name to one that has a citation (an author and a year, or a DOI).",
    );
  });

  test("each refusal is a sentence a person reads, with no code word in it", () => {
    for (const reason of ["not_exempt", "reviewed", "already_waived", "draft", "not_open"]) {
      const t = text(answer({ reason }));
      expect(t, reason).not.toMatch(/_/);
      expect(t.length, reason).toBeGreaterThan(20);
    }
    expect(text(answer({ reason: "not_exempt" }))).toContain(
      "is not a NEMAR owner or administrator",
    );
  });

  test("an unread name is not met with a retry alone: a file with no readable Name is found unreadable again", () => {
    // The persistent case. Every retry reads the same file, so each surface that says what to do
    // says to fix the file, and none of them says to wait for GitHub.
    const exempt = renderCheck({ kind: "naming", facts: { title: null, name: "unchecked" } });
    const beside = renderCheck({
      kind: "naming",
      facts: { title: "author_year", name: "unchecked" },
    });
    const surfaces: Record<string, string> = {
      "the list's label": verdictText({
        verdict: "exempt",
        detail: "naming_unchecked",
        review_current: null,
      }),
      "the answer of an override": text(answer({ reason: "naming_unchecked" })),
      "the check": `${exempt.summary}\n${exempt.text}`,
      "the check beside a refused title": `${beside.summary}\n${beside.text}`,
    };
    for (const [where, said] of Object.entries(surfaces)) {
      expect(said, where).toMatch(/fix (?:the file|dataset_description\.json)/);
      expect(said, where).not.toMatch(/in a moment/i);
    }
    // The ones with room for it say both causes, and a single retry before the fix.
    for (const where of [
      "the answer of an override",
      "the check",
      "the check beside a refused title",
    ]) {
      expect(surfaces[where], where).toContain("GitHub may not have answered");
      expect(surfaces[where], where).toContain("has no readable Name");
      expect(surfaces[where], where).toMatch(/\bonce\b/);
    }
  });

  test("a word that Object also has is a word, not the function it names", () => {
    // `NOT_STARTED` is a plain object: `constructor` or `toString` would find an inherited function,
    // and printing it prints that function's source. Every name Object.prototype has is tried.
    const names = Object.getOwnPropertyNames(Object.prototype);
    expect(names).toContain("constructor");
    for (const name of names) {
      const waiver = text(answer({ reason: name }));
      expect(waiver, name).not.toContain("native code");
      expect(waiver, name).not.toContain("[object");
      const start = notStartedText({
        environment: "production",
        dispatched: false,
        reason: name,
        review_id: null,
        author_login: null,
      } satisfies StartReviewResponse);
      expect(start, name).not.toContain("native code");
      expect(start, name).not.toContain("[object");
      // The generic text: the word itself, with its underscores as spaces.
      const word = name.replaceAll("_", " ");
      expect(waiver, name).toBe(`Not waived: ${word}.`);
      expect(start, name).toBe(`not started: ${word}`);
    }
  });

  test("namingFactLines names an unreadable name as such", () => {
    expect(namingFactLines({ title: null, name: "unchecked" })).toEqual([
      "the dataset name could not be read to be checked",
    ]);
    expect(namingFactLines(null)).toEqual([]);
  });

  describe("whatever the server or the caller sent", () => {
    const LONG = "x".repeat(10_000);
    const lines = (r: WaiveNamingResponse, dataset = "nm000201") =>
      waiverLines(r, dataset, 7).map((l) => l.replace(ANSI, ""));

    test("no line carries a control sequence, in any answer", () => {
      const answers: WaiveNamingResponse[] = [
        // The word a newer or hostile server invents, in the default branch.
        answer({ reason: HOSTILE }),
        // The commit it names.
        answer({ reason: "waived", waived: true, head_sha: HOSTILE }),
        answer({ reason: "already_waived", waived: true, head_sha: HOSTILE }),
        answer({ reason: "nothing_to_waive", head_sha: HOSTILE }),
        answer({ reason: "not_exempt", head_sha: HOSTILE }),
        answer({ reason: "reviewed", head_sha: HOSTILE }),
        answer({ reason: "naming_unchecked", head_sha: HOSTILE }),
        // What the rule found, when the words are not the closed ones.
        answer({
          reason: "waived",
          waived: true,
          facts: { title: HOSTILE as never, name: HOSTILE as never },
        }),
      ];
      for (const r of answers) {
        const out = lines(r, `nm00${HOSTILE}`);
        expect(out.length, r.reason).toBeGreaterThan(0);
        for (const l of out)
          expect(DANGEROUS.test(l), `${r.reason}: ${JSON.stringify(l)}`).toBe(false);
      }
    });

    test("a word that is not text is not a crash, and not a word", () => {
      for (const notText of [undefined, null, 7, {}, ["x"]]) {
        const out = lines(answer({ reason: notText as never }));
        expect(out).toEqual(["Not waived: ."]);
      }
    });

    test("a very long word from the server does not run on: the line stays short and says it was cut", () => {
      const out = lines(answer({ reason: LONG }));
      expect(out).toHaveLength(1);
      expect(out[0].length).toBeLessThan(200);
      expect(out[0]).toContain("…");
      // Nor does one the CLI builds from the commit it was given.
      for (const l of lines(answer({ reason: "waived", waived: true, head_sha: LONG }))) {
        expect(l.length).toBeLessThan(400);
      }
    });
  });
});
