/**
 * Weekly import summary DECISIONS and report body (epic #1306 phase 4, #1312).
 * Pure, no I/O.
 *
 * ## Why an unconditional report
 *
 * Phases 1-3 made the pipeline able to describe its own state. This phase makes
 * someone read it.
 *
 * An alarm fires only when a threshold trips, and the seven-week outage produced
 * no alarm because no threshold existed. A report that appears only when something
 * breaks cannot distinguish a healthy week from a broken reporter -- both look like
 * silence. So this arrives every week whether or not anything is wrong, which is
 * what makes "no news" mean something.
 *
 * ## Unknown is a value, and it is not zero
 *
 * The rule this phase turns on. "0 imports" and "no data about imports" looked alike,
 * and that is how the original incident stayed invisible: a dashboard full of zeroes
 * reads as a quiet week. So every count here is `number | null`, and `null` renders as
 * `unknown`.
 *
 * Every COUNT goes through one renderer ({@link count}), because a ternary per field is
 * how one of them eventually renders `0`. The handful of non-count fields -- the two
 * booleans and the dispatch phrase -- necessarily have their own three-way rendering,
 * and review found three of them unpinned, so each now has its own test: a
 * `dispatchLost === null` that rendered as `yes` is "the reporter could not see, and
 * said everything is fine", which is the founding failure exactly.
 */

import {
  NEUROBAGEL_EXPECTED_DAILY_RUNS,
  type NeurobagelWeekly,
  WEEKLY_NEUROBAGEL_CHECKS,
  weeklyAttention,
} from "../../../shared/contract/weekly-attention.js";

export type { NeurobagelWeekly };

/**
 * Rows to name before falling back to a count.
 *
 * The spirit of ADR 0036 -- an operational record carries counts and pointers, not an
 * unbounded dump -- though note 0036 is stricter than this about truncation
 * specifically. What it forbids is inlining detail that belongs elsewhere; a bounded
 * list plus an explicit "and N more" is a pointer, and the count above it is never
 * truncated.
 */
export const WEEKLY_MAX_LISTED_IDS = 20;

/**
 * The ISO-8601 week label, e.g. `2026-W37`.
 *
 * Zero-padded to two digits, which both the inverse parser and the lexical sort
 * depend on: `2026-W9` would sort after `2026-W10` and would not match a `\d{2}`
 * regex.
 *
 * ISO weeks start on Monday and week 1 is the week containing the first Thursday
 * of January -- equivalently, the week containing January 4th. The consequence
 * that makes this worth its own function and its own boundary tests: the ISO year
 * is NOT always the calendar year. 2027-01-01 is a Friday, so it belongs to
 * 2026-W53; 2024-12-30 is a Monday, so it belongs to 2025-W01. Deriving the label
 * from `getUTCFullYear()` would mislabel both, and a mislabelled week silently
 * breaks the title-as-dedup-key: two different weeks could claim one title, or one
 * week could be filed twice under two.
 *
 * The algorithm is the standard one: move to the Thursday of the current ISO week
 * (Thursday is always in the same ISO year as its week), then count weeks from
 * that year's January 4th.
 */
export function isoWeekLabel(now: Date): string {
  // Work in UTC only. A local-time reading would shift the week boundary by the
  // host's offset, and the Worker's clock is UTC while a developer's is not.
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // getUTCDay: 0 = Sunday. ISO counts Monday = 1 ... Sunday = 7.
  const isoDay = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  // Thursday of this ISO week: the day that determines the ISO year.
  d.setUTCDate(d.getUTCDate() + 4 - isoDay);
  const isoYear = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4IsoDay = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  // Monday of week 1.
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() + 1 - jan4IsoDay);
  const week = Math.floor((d.getTime() - week1Monday.getTime()) / 604_800_000) + 1;
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/**
 * Is today the day the weekly summary posts?
 *
 * Monday UTC, matching `check-summary-drift.yml`, the repo's other weekly
 * cadence (`* * 1`). `bump-validator.yml` runs monthly, so it is not a second
 * weekly rhythm.
 *
 * The daily cron fires at 03:00 UTC, so the report covers the week ending Monday
 * 03:00 UTC. That is stated in the body: an unstated window cannot be checked
 * against anything.
 */
export function shouldRunWeeklySummary(now: Date): boolean {
  return now.getUTCDay() === 1;
}

/**
 * Has this week's summary already been posted?
 *
 * Same shape as `decideAutoImportGate`, and deliberately the OPPOSITE failure
 * direction. Auto-import fails OPEN on an unreadable last-dispatch timestamp,
 * because a skipped import is worse than an early one. Here an unreadable
 * timestamp fails CLOSED: the daily cron evaluates this once a day, so a gate that
 * failed open on a bad value would post a duplicate weekly issue every day for as
 * long as the value stayed bad -- which is precisely the notification fatigue this
 * epic exists to prevent, arriving from the tool built to prevent it.
 *
 * A skipped week costs one missing report and is visible as a gap in the series,
 * because the titles are week-labelled and therefore sortable.
 */
export function decideWeeklySummaryGate(args: {
  /** `audit_log.timestamp` of the last posted summary, or null if never. */
  lastRunAt: string | null;
  /** Parsed form of the same, or null when it could not be read. Passed separately so
   *  this module needs no import from `auto-import.ts`, which is where `parseSqliteUtc`
   *  lives -- the function is pure, so purity is not the reason. */
  lastRunMs: number | null;
  now: Date;
}): { proceed: boolean; reason: string } {
  if (args.lastRunAt === null) {
    return { proceed: true, reason: "no weekly summary has ever been posted" };
  }
  if (args.lastRunMs === null) {
    return {
      proceed: false,
      reason: `last weekly summary timestamp is unreadable (${JSON.stringify(args.lastRunAt)}); refusing to post rather than risk one issue per day`,
    };
  }
  const lastWeek = isoWeekLabel(new Date(args.lastRunMs));
  const thisWeek = isoWeekLabel(args.now);
  if (lastWeek === thisWeek) {
    return { proceed: false, reason: `already posted for ${thisWeek}` };
  }
  return { proceed: true, reason: `last posted for ${lastWeek}, now ${thisWeek}` };
}

// ============================================================================
// Report content
// ============================================================================

/**
 * Render a count that may be unknown.
 *
 * The ONE renderer, used for every number in the report. A per-field ternary is
 * how one field eventually renders `unknown` as `0`, which is the single mistake
 * this phase exists to prevent -- see the module header.
 */
export function count(n: number | null): string {
  return n === null ? "unknown" : String(n);
}

/** Days between an anchor and now, or null when the anchor is unreadable. */
export function daysSince(anchorMs: number | null, nowMs: number): number | null {
  if (anchorMs === null) return null;
  return Math.max(0, Math.floor((nowMs - anchorMs) / 86_400_000));
}

/** One blocklisted dataset, with how long it has been parked. */
export interface ParkedDataset {
  datasetId: string;
  reason: string | null;
  /** From `first_incomplete_at`, the only write-once anchor. `null` when that
   *  column is NULL -- possible on rows predating #969 -- and then the duration is
   *  genuinely unknown rather than zero. */
  parkedDays: number | null;
}

/** Everything the body renders. Every count is nullable, and null means the sweep
 *  could not determine it. */
export interface WeeklySummaryFacts {
  /** The ISO week this report covers. */
  week: string;
  /** Start of the covered window, ISO 8601, so the window is checkable. */
  windowStart: string;
  windowEnd: string;

  /** OpenNeuro mirrors created in the window. */
  importedThisWeek: number | null;
  /** Managed OpenNeuro mirrors in total. */
  importedTotal: number | null;

  /** Coverage, from phase 3's sweep. `null` throughout when its verdict was
   *  `unknown`, because a coverage number the sweep could not establish must not
   *  render as zero. */
  coverageStatus: "healthy" | "alarm" | "unknown" | null;
  coverageReason: string | null;
  outstanding: number | null;
  discovered: number | null;
  importedNotInScan: number | null;

  /** Dispatch liveness. */
  autoImportEnabled: boolean | null;
  dispatchPhrase: string | null;
  dispatchLost: boolean | null;

  /** Open failures grouped by classified cause label, zero-filled so every cause
   *  appears. `null` when the query itself failed. */
  failuresByCause: Record<string, number> | null;
  openFailureTotal: number | null;

  /** Blocklisted datasets, longest-parked first. `null` when unavailable. */
  parked: ParkedDataset[] | null;

  /** What the daily sweeps did in the window, read from `audit_log`. `null` until
   *  the crons have written their first rows -- correct, not a bug. */
  issuesClosed: number | null;
  issuesRelabelled: number | null;

  /** The Neurobagel verification sweep. `null` when no daily run was recorded in the window
   *  (it writes a heartbeat on every run, so none means it did not run: unknown, not zero). */
  neurobagel: NeurobagelWeekly | null;
  /**
   * Findings in the Neurobagel feature that need a person, counted over the window and over what
   * stands, from every place the feature records one, and independent of whether the daily sweep
   * wrote a row. A COUNT only: it carries no kind and no identifier, because the report is filed
   * on a public-facing repository. `null` when it could not be counted, which is unknown.
   */
  neurobagelFindings: number | null;

  /** Anything that went wrong producing this report. Listed, never swallowed. */
  errors: { stage: string; error: string }[];
}

/**
 * Is anything in this report worth a human's attention?
 *
 * Drives the first line, so an unhealthy week is obvious without scrolling. An
 * `unknown` counts as needing attention: a report that cannot see is not a report
 * that found nothing.
 */
export function weeklyHeadline(f: WeeklySummaryFacts): { attention: boolean; line: string } {
  // ONE rule, in shared/contract: `nemar admin import-weekly` takes its exit code from the same
  // function, so the issue and the command cannot disagree about a week.
  const { attention, problems, notChecked } = weeklyAttention(f);
  if (!attention) {
    // Never "all look normal" over a check that did not run: what was not checked is said.
    const neurobagel =
      notChecked.length > 0
        ? ` Neurobagel verification did not run these checks on at least one day: ${notChecked.join(", ")}.`
        : " All four Neurobagel checks ran and look normal.";
    return {
      attention: false,
      // Names what was actually checked. It deliberately does not speak for open
      // failures or the blocklist: phases 2 and 3 own those, and a report that claimed
      // "all normal" while 40 failures sat below it would be overclaiming.
      line: `**Nothing needs attention this week.** Auto-import, coverage, dispatch and the daily sweeps look normal for ${f.week}.${neurobagel}`,
    };
  }
  return {
    attention: true,
    line: `**Needs attention:** ${problems.join("; ")}.`,
  };
}

/**
 * The weekly summary issue body.
 *
 * Written ONCE, at creation, and never rewritten -- this is a historical record of
 * a closed window, which is phase 2's rollup shape rather than phase 3's
 * current-state shape. A rewritten body would silently restate last week's numbers
 * from a different instant than the window it claims to describe.
 *
 * The first two lines carry the verdict; everything after is deliberately boring
 * and scannable, because a report that is exciting every week gets skimmed.
 */
export function buildWeeklySummaryBody(f: WeeklySummaryFacts, nowIso: string): string {
  const head = weeklyHeadline(f);
  const causeRows = f.failuresByCause
    ? Object.entries(f.failuresByCause)
        .filter(([, n]) => n > 0)
        .map(([label, n]) => `| \`${label}\` | ${n} |`)
    : [];

  return [
    `# Import summary, ${f.week}`,
    "",
    head.line,
    "",
    `Covers ${f.windowStart} to ${f.windowEnd} (UTC). Generated ${nowIso}.`,
    "",
    "cc @nemarAdmin",
    "",
    "## Imports",
    "",
    "| | |",
    "|---|---|",
    `| Imported this week | ${count(f.importedThisWeek)} |`,
    `| Managed OpenNeuro mirrors in total | ${count(f.importedTotal)} |`,
    `| In scope on OpenNeuro | ${count(f.discovered)} |`,
    `| Mirrors no longer in scope upstream | ${count(f.importedNotInScan)} |`,
    "",
    "## Coverage",
    "",
    f.coverageStatus === null
      ? "The coverage sweep did not run for this report, so none of its numbers are available. This is **unknown**, not zero."
      : `Verdict: **${f.coverageStatus.toUpperCase()}**. ${f.coverageReason ?? ""}`,
    "",
    `Datasets outstanding (nothing is working on them): ${count(f.outstanding)}`,
    "",
    "## Dispatch liveness",
    "",
    "| | |",
    "|---|---|",
    `| \`AUTO_IMPORT_ENABLED\` | ${f.autoImportEnabled === null ? "unknown" : f.autoImportEnabled ? "`true`" : "**not `true`**"} |`,
    `| Last dispatch | ${f.dispatchPhrase ?? "unknown"} |`,
    `| Dispatches landing | ${f.dispatchLost === null ? "unknown" : f.dispatchLost ? "**no**" : "yes"} |`,
    "",
    "## Open failures by cause",
    "",
    f.failuresByCause === null
      ? "Could not be read this week: **unknown**, not zero."
      : causeRows.length === 0
        ? `No open failures. (Total: ${count(f.openFailureTotal)}.)`
        : [
            "| cause | datasets |",
            "|---|---|",
            ...causeRows,
            "",
            `Total: ${count(f.openFailureTotal)}.`,
          ].join("\n"),
    "",
    "## What the daily sweeps did this week",
    "",
    f.issuesClosed === null && f.issuesRelabelled === null
      ? "**No sweep activity was recorded at all for this window, which is unknown rather than zero.** The daily crons write a row on every run, so an absence of rows means they did not run -- not that they ran and found nothing. (In the first week after this report shipped it also just means the rows did not exist yet.)"
      : `Tracking issues closed on recovery: ${count(f.issuesClosed)}. Relabelled after a cause change: ${count(f.issuesRelabelled)}.`,
    "",
    "## Neurobagel federation",
    "",
    ...neurobagelSection(f.neurobagel, f.neurobagelFindings),
    "",
    "## Blocklisted datasets",
    "",
    f.parked === null
      ? "Could not be read this week: **unknown**, not zero."
      : f.parked.length === 0
        ? "_none_"
        : [
            "| dataset | reason | parked |",
            "|---|---|---|",
            ...f.parked
              .slice(0, WEEKLY_MAX_LISTED_IDS)
              .map(
                (p) =>
                  `| ${p.datasetId} | ${p.reason ?? "unknown"} | ${p.parkedDays === null ? "unknown" : `${p.parkedDays} days`} |`,
              ),
            ...(f.parked.length > WEEKLY_MAX_LISTED_IDS
              ? ["", `...and ${f.parked.length - WEEKLY_MAX_LISTED_IDS} more.`]
              : []),
          ].join("\n"),
    "",
    ...(f.errors.length > 0
      ? [
          "## Parts of this report that failed",
          "",
          "Listed rather than omitted, so a gap is never mistaken for a zero.",
          "",
          ...f.errors.map((e) => `- \`${e.stage}\`: ${e.error}`),
          "",
        ]
      : []),
    "---",
    "",
    "Posted weekly by the import summary job whether or not anything is wrong (nemarOrg/nemar-cli#1312), because a report that only appears when something breaks cannot tell a healthy week from a broken reporter. Last week's summary is closed automatically when this one is filed; its content stays readable.",
  ].join("\n");
}

/**
 * The Neurobagel section. Counts and verdicts, and each check's own one-sentence reason (which
 * the sweep writes generically, with counts and public upstream tags only). `unchecked` is
 * printed as "unchecked": a check that is not configured here is neither good news nor zero.
 *
 * The findings line is a count with no label of its own: the report is filed on a
 * public-facing repository, and what the findings are lives in the audit log.
 */
function neurobagelSection(n: NeurobagelWeekly | null, findings: number | null): string[] {
  const findingsLine = `Findings that need a person, over the window and what stands: ${count(findings)}. A count only: the audit log holds the detail.`;
  if (n === null) {
    return [
      "**No daily verification run was recorded in this window, which is unknown rather than zero.** The sweep writes a row on every run, so an absence of rows means it did not run, not that it ran and found nothing. (In the first week after this section shipped it also just means the rows did not exist yet.)",
      "",
      findingsLine,
    ];
  }
  const verdicts = WEEKLY_NEUROBAGEL_CHECKS.map(
    (name) => `| ${name} | ${n.latest.checks[name].verdict} | ${n.latest.checks[name].reason} |`,
  );
  const notRun = WEEKLY_NEUROBAGEL_CHECKS.filter((c) => n.checkDays[c].unchecked > 0).map(
    (c) => `${c} ${n.checkDays[c].unchecked} day(s)`,
  );
  return [
    `Latest daily run (${n.latest.at}): **${n.latest.overall.toUpperCase()}**.`,
    "",
    "| check | verdict | what it found |",
    "|---|---|---|",
    ...verdicts,
    "",
    `Daily runs in this window: ${n.runs} of ${NEUROBAGEL_EXPECTED_DAILY_RUNS} expected (healthy ${n.days.healthy}, alarm ${n.days.alarm}, unknown ${n.days.unknown}, unchecked ${n.days.unchecked}; the sweep itself failed on ${n.failedRuns}).`,
    "",
    notRun.length > 0
      ? `Checks that did not run: ${notRun.join(", ")}.`
      : "Every check ran on every recorded day.",
    "",
    findingsLine,
  ];
}

/** Comment left on the previous week's issue as it is closed, so the series is
 *  navigable in both directions. */
export function buildWeeklyRolloverComment(
  nextWeek: string,
  nextIssue: number,
  nowIso: string,
): string {
  return [
    // A bare `#N`, not `owner/repo#N`: the comment is posted on the same repo the
    // successor was filed on, so GitHub renders it as a link either way, and leaving
    // the repo name out keeps this module with no imports at all.
    `Superseded by the ${nextWeek} summary, #${nextIssue} (${nowIso}).`,
    "",
    "Closed automatically. The numbers above describe the window in the title and are not updated.",
  ].join("\n");
}

/** One-line summary for the cron log. Hand-rolled rather than via `sweepLogLines`,
 *  which needs `processed`/`remaining`/per-dataset errors that a fleet-level weekly
 *  report does not have -- the same reason phases 2 and 3 hand-roll theirs. */
export function weeklySummaryLogLine(f: WeeklySummaryFacts, issue: number | null): string {
  return (
    `week=${f.week} attention=${weeklyHeadline(f).attention} ` +
    `imported_this_week=${count(f.importedThisWeek)} total=${count(f.importedTotal)} ` +
    `outstanding=${count(f.outstanding)} open_failures=${count(f.openFailureTotal)} ` +
    `parked=${f.parked === null ? "unknown" : f.parked.length} ` +
    `closed=${count(f.issuesClosed)} relabelled=${count(f.issuesRelabelled)} ` +
    `neurobagel=${f.neurobagel === null ? "unknown" : f.neurobagel.latest.overall} ` +
    `neurobagel_findings=${count(f.neurobagelFindings)} ` +
    `issue=${issue === null ? "none" : `#${issue}`} errors=${f.errors.length}`
  );
}
