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
  VolumeWindow,
} from "../shared/contract/pr-review-admin";
import {
  ageOf,
  plain,
  renderQueue,
  reportLines,
  standingLines,
  terminalize,
  verdictText,
  volumeLines,
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
    model_calls: 9,
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
          model_calls: 1,
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
      "  Last 24 hours: 1 review recorded, 1 model call; 1 pass.",
      "  Last 7 days:   14 reviews recorded, 9 model calls; 5 pass, 4 fail, 1 could not decide, 4 not reviewed (1 contributor paused, 1 rate limited, 2 daily limit).",
    ]);
  });

  test("a window with nothing in it says so, and a count of zero is not left out of a real one", () => {
    const quiet = window({
      reviews: 0,
      model_calls: 0,
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
      "  Last 24 hours: 14 reviews recorded, 9 model calls; what they came to could not be read.",
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
