/**
 * What `nemar admin pr-reviews` puts on a terminal, tested as the pure functions it is made of
 * (ADR 0093). The spawned-CLI suite goes through the real Worker, which has already reduced
 * author-controlled text to plain words, so it would pass with every one of the CLI's own
 * `plain()` calls deleted. These tests feed the CLI hostile text directly, which is the only way
 * to prove the CLI does not depend on a server's hygiene.
 */

import { describe, expect, test } from "bun:test";
import type { ContributorStanding, QueueEntry } from "../shared/contract/pr-review-admin";
import {
  ageOf,
  plain,
  renderQueue,
  reportLines,
  standingLines,
  terminalize,
  verdictText,
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
    by_record: { paused: false },
    thresholds: { rejected_more_than: 5, percent_more_than: 10 },
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
        by_record: { paused: true, because: "tally" },
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
    // 6 of 59 is 10.17%: "10%" would sit beside "more than 10%" and read as not exceeding it.
    expect(lines.join("\n")).toContain("6 of 59 decided pull requests rejected (10.2%)");
  });

  test("says what the record alone would do beside an allow, from the server's own answer", () => {
    const text = standingLines(
      standing({
        override: { mode: "allow", reason: null, set_at: "2026-10-01", set_by: "queueadmin" },
        by_record: { paused: true, because: "tally" },
      }),
    )
      .map((l) => l.replace(ANSI, ""))
      .join("\n");
    expect(text).toContain("the record alone would pause them; the decision wins");
    expect(text).toContain("not paused: reviewed automatically, within the rate limits");
  });

  test("says where an identity came from when GitHub was not asked", () => {
    const text = standingLines(standing({ resolved_from: "history" })).join("\n");
    expect(text).toContain("from the Worker's records");
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
