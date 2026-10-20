/**
 * The weekly import summary (epic #1306 phase 4, #1312).
 *
 * Driven against real in-memory SQLite with every migration applied: the real
 * queries, the real classifier, the real `first_incomplete_at` arithmetic and the
 * real body all run. Only the GitHub calls, the token and phase 3's coverage sweep
 * are injected.
 *
 * The assertions that matter are about what CANNOT happen:
 *
 *   - a failed read must not become a zero, at any layer;
 *   - the same week must not be posted twice, whether the audit gate or the title is
 *     the thing that catches it;
 *   - a report must never be silently truncated, because a report that stops at N
 *     under-counts and reads as good news.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NEUROBAGEL_STORE_CHECK } from "../src/services/anonymity-sweep";
import type { GitHubIssue } from "../src/services/github/issues";
import type { ImportCoverageSweepResult } from "../src/services/import-coverage-sweep";
import {
  IMPORT_WEEKLY_ISSUE_LABEL,
  importWeeklySummaryIssueTitle,
} from "../src/services/import-issue-identity";
import { isoWeekLabel } from "../src/services/import-weekly-summary";
import {
  WEEKLY_SUMMARY_AUDIT_ACTION,
  type WeeklySummaryDeps,
  runWeeklyImportSummary,
  runWeeklyImportSummaryCron,
  weeklySummaryCronLine,
} from "../src/services/import-weekly-summary-sweep";
import { readLedger, recordLedgerState } from "../src/services/neurobagel-plan";
import { neurobagelStatus } from "../src/services/neurobagel-status";
import { runNeurobagelVerificationSweep } from "../src/services/neurobagel-verify";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import {
  RECORDED,
  type UpstreamStandin,
  startUpstreamStandin,
} from "./helpers/neurobagel-upstream";
import { lastWeeklyCronFiring } from "./helpers/weekly-cron-firing";

const WEEK_MS = 7 * 86_400_000;

/**
 * The instant the weekly cron last fired: the latest Monday 03:00 UTC that is not later
 * than the real clock (`lastWeeklyCronFiring`).
 *
 * THE PREMISE. A report comes from a scheduled firing, or from an admin run (the
 * `force` tests) that this fixture pins to one; either way `now` is an instant the real
 * clock has already passed. The tests inject this as `now`, while
 * three other things read the REAL clock: `audit_log.timestamp` (SQL `datetime('now')`),
 * `seedImported`, and the imported-this-week window. An injected `now` AHEAD of the real
 * clock therefore describes a window the database cannot fill.
 *
 * THE WINDOW. An ISO week starts at Monday 00:00 UTC but the cron fires at 03:00, so
 * from Monday 00:00 to 02:59:59 UTC the current week's firing is still ahead and the
 * latest one is seven days earlier. Two earlier fixtures each missed something different:
 *
 *   1. A hardcoded `2026-09-07T03:00:00Z` (2026-W37) missed that the real clock moves.
 *      It agreed with the database only while the wall clock sat in the same ISO week,
 *      so the three gate tests failed on every run from 2026-09-14 onward, on every
 *      branch, taking the required `unit-pure` check with them. Nothing had changed but
 *      the date.
 *   2. Monday 03:00 of the CURRENT ISO week followed the clock but missed the window. It
 *      failed "NOW is never in the future" for the first three hours of every Monday
 *      (#1843): the instant it named had not happened yet.
 *
 * Inside the window NOW is therefore in the week BEFORE the real clock's, by design:
 * the cron has not fired yet this week. Anything that has the product write a row
 * stamped by the real clock and then reads it back through NOW's ISO week has to move
 * that stamp to NOW; see `stampReservationsAt`, which the gate tests use.
 *
 * The audit-log window queries are bound from `now`, and their fixtures are dated
 * relative to NOW, so they are unaffected. Apart from that reservation stamp, only the
 * imported-this-week window and `seedImported` (with the boundary rows seeded against
 * that window) still read the real clock, on both sides, so they never depended on
 * this value.
 *
 * The residual is a run that crosses Monday 03:00:00 UTC itself between this line and
 * the guard below, which would leave NOW a week and a few seconds behind. That is
 * inherent in reading a clock once at load and is not what broke here.
 */
const NOW = lastWeeklyCronFiring(new Date());

describe("the injected clock is the last cron firing on the database's clock", () => {
  // THE GUARDS FOR THE BUGS ABOVE, one property each. Together they fail the moment
  // someone re-hardcodes NOW (the age bound), rounds it to the wrong weekday or hour
  // (the shape), or lets it run ahead of the real clock (the future check), rather
  // than a week later on an unrelated pull request, which is how the first was found.
  test("NOW is the most recent firing, less than seven days behind the real clock", () => {
    // The NEXT firing is still ahead. A hardcoded literal fails this once a week has
    // passed; the current-week fixture passes it all week, which is what the
    // never-in-the-future test below is for.
    expect(NOW.getTime() + WEEK_MS).toBeGreaterThan(Date.now());
  });

  test("NOW is a Monday at 03:00 UTC, when the cron fires", () => {
    expect(NOW.getUTCDay()).toBe(1);
    expect(NOW.getUTCHours()).toBe(3);
    expect(NOW.getUTCMinutes()).toBe(0);
  });

  test("NOW is never in the future", () => {
    // The imported-this-week window and the audit stamps end at the real now, so an
    // injected clock ahead of it would describe a window the database cannot fill.
    // This is the assertion that failed from Monday 00:00 to 03:00 UTC (#1843).
    expect(NOW.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

/**
 * There are TWO week notions here and conflating them is the trap.
 *
 * `coveredWeekOf` is the week the data describes -- what the title and body carry --
 * and `runWeekOf` is the calendar week the run happens in, which is what the
 * once-per-week gate compares. They differ by one, because the cron fires Monday
 * 03:00 UTC over the preceding seven days. Named separately so an assertion has to
 * say which one it means.
 */
const coveredWeekOf = (d: Date): string => isoWeekLabel(new Date(d.getTime() - WEEK_MS));
const runWeekOf = (d: Date): string => isoWeekLabel(d);
const THIS_WEEK = coveredWeekOf(NOW);

function envFor(db: Database, environment = "test"): Bindings {
  return { DB: realD1(db), ENVIRONMENT: environment } as unknown as Bindings;
}

function seedImported(db: Database, sourceId: string, opts: { daysAgo?: number } = {}): void {
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, source, source_id, status, visibility, created_at)
     VALUES (?, ?, 1, 'openneuro', ?, 'active', 'public', datetime('now', ?))`,
  ).run(`on${sourceId.slice(2)}`, `Dataset ${sourceId}`, sourceId, `-${opts.daysAgo ?? 0} days`);
}

function seedImportJob(
  db: Database,
  datasetId: string,
  opts: {
    status?: string;
    lastError?: string | null;
    blocklisted?: boolean;
    reason?: string | null;
    firstIncompleteDaysAgo?: number | null;
  } = {},
): void {
  db.query(
    `INSERT INTO import_jobs
       (dataset_id, source, source_id, stage, status, last_error, blocklisted, blocklist_reason, first_incomplete_at)
     VALUES (?, 'openneuro', ?, 'prepare', ?, ?, ?, ?, ?)`,
  ).run(
    datasetId,
    `ds${datasetId.slice(2)}`,
    opts.status ?? "failed",
    opts.lastError ?? null,
    opts.blocklisted === true ? 1 : 0,
    opts.reason ?? null,
    // Anchored to the test's injected NOW, not SQLite's `now`. Using
    // `datetime('now', ...)` here mixed two clocks: the fixture would be relative to
    // the real date while the assertion was relative to NOW, so the expected
    // duration drifted by however far apart they happened to be.
    opts.firstIncompleteDaysAgo === null || opts.firstIncompleteDaysAgo === undefined
      ? null
      : sqliteUtc(new Date(NOW.getTime() - opts.firstIncompleteDaysAgo * 86_400_000)),
  );
}

/** `YYYY-MM-DD HH:MM:SS`, the format SQLite's `datetime()` writes and
 *  `parseSqliteUtc` reads. */
function sqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Stamp the weekly reservation(s) as of `at`.
 *
 * The product writes the reservation with SQL `datetime('now')`, the real clock. In
 * production that IS the run's `now`; here `now` is injected, and from Monday 00:00 to
 * 02:59:59 UTC the latest cron firing (NOW) is in the ISO week BEFORE the real clock's
 * (#1843). The gate compares ISO weeks, so an unmoved stamp reads as a post from the
 * following week and a second run sails through. Moving the stamp to the injected
 * instant restores what production has by construction: the row and the run agree on
 * when it ran. Same move `heartbeat` makes for the verification sweep's row.
 *
 * It overwrites what the product wrote, so it first checks that there is something real
 * to overwrite: exactly one reservation, with a stamp that parses, written within the
 * last minute by the run the test just made. Otherwise a run that wrote nothing, wrote
 * twice, or left an old row behind would be "repaired" into a gate test that passes for
 * the wrong reason. Age is measured on SQLite's own clock, the one that wrote the stamp,
 * because that is the clock a test of the window cannot move.
 */
function stampReservationsAt(db: Database, at: Date): void {
  const rows = db
    .query<{ age: number | null }, [string]>(
      `SELECT CAST(strftime('%s', 'now') AS INTEGER) - CAST(strftime('%s', timestamp) AS INTEGER) AS age
         FROM audit_log WHERE action = ?`,
    )
    .all(WEEKLY_SUMMARY_AUDIT_ACTION);
  if (rows.length !== 1) {
    throw new Error(`expected exactly one weekly reservation to restamp, found ${rows.length}`);
  }
  const age = rows[0]?.age;
  if (age === null || age === undefined) {
    throw new Error("the weekly reservation's timestamp does not parse, so it was not restamped");
  }
  if (Math.abs(age) > 60) {
    throw new Error(`the weekly reservation is ${age}s old, not the run just made; not restamping`);
  }
  db.query("UPDATE audit_log SET timestamp = ? WHERE action = ?").run(
    sqliteUtc(at),
    WEEKLY_SUMMARY_AUDIT_ACTION,
  );
}

/**
 * An `import_issue_triage` audit row, as phase 2's cron now writes.
 *
 * Dated relative to the INJECTED clock, not SQLite's `datetime('now')`. The window
 * is now bound from the same `now` the report fixes `windowStart` from -- the whole
 * point of that change -- so a fixture anchored to the real wall clock lands outside
 * a window centred on 2026-09-07 and the row silently does not count. Same
 * two-clocks trap the `first_incomplete_at` fixtures hit earlier.
 */
function seedTriageAudit(db: Database, details: Record<string, unknown>, daysAgo = 1): void {
  db.query(
    `INSERT INTO audit_log (action, resource_type, resource_id, details, timestamp)
     VALUES ('import_issue_triage', 'issue', 'x', ?, ?)`,
  ).run(JSON.stringify(details), sqliteUtc(new Date(NOW.getTime() - daysAgo * 86_400_000)));
}

function coverageResult(over: Partial<ImportCoverageSweepResult> = {}): ImportCoverageSweepResult {
  return {
    applied: false,
    status: "healthy",
    kind: null,
    reason: "nothing outstanding",
    enabled: true,
    lastDispatchAt: "2026-09-07 01:00:00",
    dispatchAgeHours: 2,
    lastDispatchSourceId: "ds000001",
    dispatchLost: false,
    discovered: 766,
    imported: 764,
    importedInScan: 760,
    importedNotInScan: 4,
    inFlight: 0,
    terminal: 0,
    backlog: { neverAttempted: [], untracked: [], tracked: [], blocklisted: [] },
    issue: null,
    errors: [],
    ...over,
  };
}

function weeklyIssue(number: number, week: string): GitHubIssue {
  return {
    number,
    html_url: `https://example/${number}`,
    state: "open",
    title: importWeeklySummaryIssueTitle(week),
    labels: [{ name: IMPORT_WEEKLY_ISSUE_LABEL }],
  };
}

function recordingDeps(
  open: GitHubIssue[] = [],
  coverage: ImportCoverageSweepResult | Error = coverageResult(),
  fail: { create?: Error; close?: Error; comment?: Error } = {},
): WeeklySummaryDeps & {
  created: { title: string; body: string; labels: string[] }[];
  closed: number[];
  comments: { n: number; body: string }[];
} {
  const created: { title: string; body: string; labels: string[] }[] = [];
  const closed: number[] = [];
  const comments: { n: number; body: string }[] = [];
  return {
    created,
    closed,
    comments,
    token: async () => "test-token",
    listOpenIssues: async () => open,
    coverage: async () => {
      if (coverage instanceof Error) throw coverage;
      return coverage;
    },
    create: async (_repo, title, body, labels) => {
      if (fail.create) throw fail.create;
      created.push({ title, body, labels });
      return weeklyIssue(900, THIS_WEEK);
    },
    close: async (_repo, n) => {
      if (fail.close) throw fail.close;
      closed.push(n);
    },
    comment: async (_repo, n, body) => {
      if (fail.comment) throw fail.comment;
      comments.push({ n, body });
    },
  };
}

function auditRows(
  db: Database,
  action = WEEKLY_SUMMARY_AUDIT_ACTION,
): { details: string | null }[] {
  return db
    .query<{ details: string | null }, [string]>(
      "SELECT details FROM audit_log WHERE action = ? ORDER BY id",
    )
    .all(action);
}

// ---------------------------------------------------------------------------
// The report arrives, and it is right
// ---------------------------------------------------------------------------

describe("the report is produced from real queries", () => {
  test("counts imports in the window and the total separately", async () => {
    const db = freshDb();
    for (const d of ["ds000001", "ds000002", "ds000003"]) seedImported(db, d, { daysAgo: 2 });
    // Older than the window: counts toward the total, not toward this week.
    seedImported(db, "ds000900", { daysAgo: 40 });
    const deps = recordingDeps();

    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, deps);

    expect(r.facts?.importedThisWeek).toBe(3);
    expect(r.facts?.importedTotal).toBe(4);
  });

  test("a folded legacy shadow row counts as neither", async () => {
    // owner_user_id = -1 is an un-imported browse pointer. Counting them as imported
    // is what caused the 2026-06-20 stall, and it would also overstate this report.
    const db = freshDb();
    db.query(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, source, source_id, status, visibility)
       VALUES ('ds000001', 'shadow', -1, 'openneuro', 'ds000001', 'active', 'public')`,
    ).run();
    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());
    expect(r.facts?.importedTotal).toBe(0);
    expect(r.facts?.importedThisWeek).toBe(0);
  });

  test("open failures are grouped by classified cause, zero-filled", async () => {
    const db = freshDb();
    seedImportJob(db, "on000001", {
      status: "failed",
      lastError:
        "Failed to push: remote: Invalid username or token. Password authentication is not supported for Git operations.",
    });
    seedImportJob(db, "on000002", {
      status: "failed",
      lastError:
        "Failed to configure S3 remote: The bucket already exists, and its annex-uuid file indicates it is used by a different special remote.",
    });
    seedImportJob(db, "on000003", { status: "incomplete", lastError: null });

    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());

    expect(r.facts?.openFailureTotal).toBe(3);
    expect(r.facts?.failuresByCause?.["auth-invalid"]).toBe(1);
    expect(r.facts?.failuresByCause?.["annex-uuid-conflict"]).toBe(1);
    expect(r.facts?.failuresByCause?.["needs-triage"]).toBe(1);
    // Zero-filled: a cause absent from the map is indistinguishable from a cause at
    // zero, which is the same unknown-vs-zero confusion one level down.
    expect(r.facts?.failuresByCause?.timeout).toBe(0);
  });

  test("a blocklisted row is not double-counted as an open failure", async () => {
    const db = freshDb();
    seedImportJob(db, "on000001", { status: "failed", blocklisted: true, reason: "no_source" });
    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());
    expect(r.facts?.openFailureTotal).toBe(0);
    expect(r.facts?.parked).toHaveLength(1);
  });

  /**
   * `first_incomplete_at` is the anchor because it is write-once. `updated_at` is
   * bumped by the slow blocklist re-check, so a row parked two months but probed
   * yesterday would read as one day old.
   */
  test("parked duration comes from the write-once anchor", async () => {
    const db = freshDb();
    seedImportJob(db, "on004148", {
      blocklisted: true,
      reason: "upstream_403_after_window",
      firstIncompleteDaysAgo: 64,
    });
    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());
    expect(r.facts?.parked?.[0]?.parkedDays).toBe(64);
    expect(r.facts?.parked?.[0]?.reason).toBe("upstream_403_after_window");
  });

  test("a blocklisted row with no anchor is unknown, not zero days", async () => {
    // Possible on rows predating the retry engine. "0 days" would say "parked today".
    const db = freshDb();
    seedImportJob(db, "on005279", { blocklisted: true, reason: "no_source" });
    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());
    expect(r.facts?.parked?.[0]?.parkedDays).toBeNull();
    expect(r.renderedBody).toContain("| on005279 | no_source | unknown |");
  });

  test("parked datasets are ordered longest-first", async () => {
    const db = freshDb();
    seedImportJob(db, "on000001", { blocklisted: true, firstIncompleteDaysAgo: 5 });
    seedImportJob(db, "on000002", { blocklisted: true, firstIncompleteDaysAgo: 50 });
    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());
    expect(r.facts?.parked?.map((p) => p.datasetId)).toEqual(["on000002", "on000001"]);
  });

  test("sweep activity is summed from the cron's audit rows", async () => {
    const db = freshDb();
    seedTriageAudit(db, { source: "cron", closed: 2, relabelled: 1 }, 1);
    seedTriageAudit(db, { source: "cron", closed: 3, relabelled: 0 }, 3);
    // Outside the window: must not count.
    seedTriageAudit(db, { source: "cron", closed: 99, relabelled: 99 }, 30);

    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());

    expect(r.facts?.issuesClosed).toBe(5);
    expect(r.facts?.issuesRelabelled).toBe(1);
  });

  test("no audit rows at all is unknown, not zero", async () => {
    // Genuinely ambiguous: nothing happened, or the crons have not started writing.
    const db = freshDb();
    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());
    expect(r.facts?.issuesClosed).toBeNull();
    expect(r.facts?.issuesRelabelled).toBeNull();
  });

  test("coverage numbers come from phase 3's sweep, run read-only", async () => {
    const db = freshDb();
    let sawApply: boolean | undefined;
    const deps = recordingDeps();
    deps.coverage = async (_env, opts) => {
      sawApply = opts?.apply;
      return coverageResult({ discovered: 766, importedNotInScan: 4 });
    };

    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, deps);

    // Read-only: the weekly report must never file or close the coverage issue as a
    // side effect of writing a report.
    expect(sawApply).toBe(false);
    expect(r.facts?.discovered).toBe(766);
    expect(r.facts?.importedNotInScan).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// A failed read is a reported unknown, never a zero
// ---------------------------------------------------------------------------

describe("a failure in one section does not zero it or abort the report", () => {
  test("a coverage unknown blanks the coverage numbers and is listed", async () => {
    const db = freshDb();
    seedImported(db, "ds000001", { daysAgo: 1 });
    const deps = recordingDeps(
      [],
      coverageResult({ status: "unknown", reason: "OpenNeuro discovery failed" }),
    );

    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, deps);

    expect(r.facts?.outstanding).toBeNull();
    expect(r.facts?.discovered).toBeNull();
    expect(r.facts?.errors?.some((e) => e.stage === "coverage")).toBe(true);
    // The rest of the report still arrives.
    expect(r.facts?.importedThisWeek).toBe(1);
  });

  test("a coverage throw is listed and the report still arrives", async () => {
    const db = freshDb();
    seedImported(db, "ds000001", { daysAgo: 1 });
    const deps = recordingDeps([], new Error("GraphQL 502"));

    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, deps);

    expect(r.facts?.coverageStatus).toBeNull();
    expect(r.facts?.errors?.[0]?.stage).toBe("coverage");
    expect(r.facts?.importedThisWeek).toBe(1);
    expect(r.renderedBody).toContain("**unknown**, not zero");
  });

  test("a dropped table makes that section unknown, not zero", async () => {
    const db = freshDb();
    seedImported(db, "ds000001", { daysAgo: 1 });
    db.run("DROP TABLE import_jobs");

    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());

    expect(r.facts?.failuresByCause).toBeNull();
    expect(r.facts?.openFailureTotal).toBeNull();
    expect(r.facts?.parked).toBeNull();
    // ...and the sections that could be read are intact.
    expect(r.facts?.importedThisWeek).toBe(1);
    expect(r.facts?.errors?.map((e) => e.stage).sort()).toEqual(["failures", "parked"]);
  });

  test("an unknown anywhere marks the week as needing attention", async () => {
    const db = freshDb();
    db.run("DROP TABLE import_jobs");
    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());
    // A report that cannot see is not a report that found nothing.
    expect(r.renderedBody).toContain("Needs attention");
  });
});

// ---------------------------------------------------------------------------
// Once per week, whichever mechanism catches it
// ---------------------------------------------------------------------------

describe("the same week is never posted twice", () => {
  test("a first run posts and reserves the audit row", async () => {
    const db = freshDb();
    const deps = recordingDeps();

    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, deps);

    expect(r.posted).toBe(true);
    expect(deps.created[0]?.title).toBe(importWeeklySummaryIssueTitle(THIS_WEEK));
    expect(deps.created[0]?.labels).toEqual([IMPORT_WEEKLY_ISSUE_LABEL]);
    const rows = auditRows(db);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.details ?? "{}")).toMatchObject({ week: THIS_WEEK });
  });

  test("a second run in the same week is refused by the audit gate", async () => {
    const db = freshDb();
    const first = recordingDeps();
    await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, first);
    stampReservationsAt(db, NOW);

    const second = recordingDeps();
    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, second);

    expect(r.posted).toBe(false);
    expect(r.gateReason).toContain(`already posted for ${runWeekOf(NOW)}`);
    expect(second.created).toEqual([]);
    expect(auditRows(db)).toHaveLength(1);
  });

  /**
   * The belt-and-braces half. The audit gate is a read-then-write with a race window;
   * the week-labelled title is immune to it, because GitHub is the one that would
   * hold two issues with one title.
   */
  test("an existing issue for this week stops a post even if the gate let it through", async () => {
    const db = freshDb();
    const deps = recordingDeps([weeklyIssue(700, THIS_WEEK)]);

    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, deps);

    expect(r.posted).toBe(false);
    expect(deps.created).toEqual([]);
    // No audit row either: nothing was reserved because nothing was posted.
    expect(auditRows(db)).toEqual([]);
  });

  test("the following week proceeds", async () => {
    const db = freshDb();
    await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, recordingDeps());
    stampReservationsAt(db, NOW);
    const next = new Date(NOW.getTime() + WEEK_MS);
    const deps = recordingDeps();

    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: next }, deps);

    expect(r.posted).toBe(true);
    expect(deps.created[0]?.title).toContain(coveredWeekOf(next));
  });

  test("an unreadable gate timestamp refuses rather than posting", async () => {
    const db = freshDb();
    db.query(
      `INSERT INTO audit_log (action, details, timestamp)
       VALUES ('${WEEKLY_SUMMARY_AUDIT_ACTION}', '{}', 'not-a-timestamp')`,
    ).run();
    const deps = recordingDeps();

    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, deps);

    expect(r.posted).toBe(false);
    expect(r.gateReason).toContain("unreadable");
    expect(deps.created).toEqual([]);
  });

  /**
   * The gate must fail CLOSED, and this test used to pass for the wrong reason.
   *
   * Dropping `audit_log` breaks the gate SELECT *and* the reservation INSERT, so with
   * the gate wrongly proceeding the post was still blocked -- by the reservation --
   * and every assertion held either way. Review proved it: flipping the catch to
   * `proceed: true` left the whole suite green.
   *
   * `facts === null` is the witness that distinguishes them: it can only be null if
   * the function returned BEFORE `gatherImports`, which is what fail-closed means
   * here. With a seeded dataset, a gate that wrongly proceeded would report 1.
   */
  test("a gate query that throws refuses BEFORE gathering anything", async () => {
    const db = freshDb();
    seedImported(db, "ds000001", { daysAgo: 1 });
    db.run("DROP TABLE audit_log");
    const deps = recordingDeps();

    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, deps);

    expect(r.posted).toBe(false);
    expect(r.gateReason).toContain("gate query failed");
    expect(deps.created).toEqual([]);
    // The witness: nothing was gathered, so nothing can be reported.
    expect(r.facts).toBeNull();
    expect(r.renderedBody).toBeNull();
  });

  /**
   * The reservation is written BEFORE the GitHub call, per `autoImportTick`'s rule.
   * If it cannot be written we must not post: posting anyway risks one issue per day
   * for as long as the write keeps failing.
   */
  test("a failed reservation means no post", async () => {
    const db = freshDb();
    // Gate read succeeds (table exists, no rows); the reservation INSERT then fails.
    db.run("DROP INDEX IF EXISTS idx_audit_action");
    db.run("ALTER TABLE audit_log RENAME TO audit_log_moved");
    db.run("CREATE VIEW audit_log AS SELECT * FROM audit_log_moved");
    const deps = recordingDeps();

    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, deps);

    expect(deps.created).toEqual([]);
    expect(r.facts?.errors?.some((e) => e.stage === "post")).toBe(true);
  });

  /**
   * A failed post must not burn the week. Reserve-before-acting is autoImportTick's
   * rule, but that rule assumes a caller retrying every 30 minutes; here the
   * Monday-only guard means the next attempt is seven days away, and the route forces
   * past the gate only on a DRY run -- so an un-released reservation would leave no
   * way to re-file at all.
   */
  test("a failed post releases its reservation, so the week can be re-attempted", async () => {
    const db = freshDb();
    const failing = recordingDeps([], coverageResult(), {
      create: new Error("HTTP 502 from GitHub"),
    });

    const first = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, failing);

    expect(first.posted).toBe(false);
    expect(first.facts?.errors.some((e) => e.stage === "post")).toBe(true);
    // Released: no reservation is left behind.
    expect(auditRows(db)).toEqual([]);

    // ...so a retry in the same week works, rather than waiting until next Monday.
    const retry = recordingDeps();
    const second = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, retry);
    expect(second.posted).toBe(true);
    expect(retry.created).toHaveLength(1);
  });

  test("force bypasses the gate but still writes nothing on a dry run", async () => {
    const db = freshDb();
    await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, recordingDeps());
    const deps = recordingDeps();

    // What the admin route's dry run does: an operator asking to READ the report
    // should not be told to wait until next Monday.
    const r = await runWeeklyImportSummary(envFor(db), { force: true, now: NOW }, deps);

    expect(r.renderedBody).toContain(`# Import summary, ${THIS_WEEK}`);
    expect(deps.created).toEqual([]);
    expect(auditRows(db)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Rollover
// ---------------------------------------------------------------------------

describe("filing this week closes last week", () => {
  test("the previous week is closed and commented, close first", async () => {
    const db = freshDb();
    const previous = isoWeekLabel(new Date(NOW.getTime() - 2 * WEEK_MS));
    const order: string[] = [];
    const deps = recordingDeps([weeklyIssue(700, previous)]);
    const wrappedClose = deps.close;
    const wrappedComment = deps.comment;
    deps.close = async (...a) => {
      order.push("close");
      return wrappedClose?.(...a);
    };
    deps.comment = async (...a) => {
      order.push("comment");
      return wrappedComment?.(...a);
    };

    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, deps);

    expect(r.closedPrevious).toBe(700);
    // ADR 0052: mutate then comment, so a failed close cannot leave a claim behind.
    expect(order).toEqual(["close", "comment"]);
    expect(deps.comments[0]?.body).toContain(THIS_WEEK);
    // And it points at the issue that was actually filed, so the closed one is
    // navigable forward without searching the repo for a title.
    expect(deps.comments[0]?.body).toContain(`#${r.issue?.number}`);
  });

  test("the OLDEST is not closed when several are open -- only the latest previous", async () => {
    const db = freshDb();
    const w35 = isoWeekLabel(new Date(NOW.getTime() - 3 * WEEK_MS));
    const w36 = isoWeekLabel(new Date(NOW.getTime() - 2 * WEEK_MS));
    const deps = recordingDeps([weeklyIssue(600, w35), weeklyIssue(700, w36)]);

    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, deps);

    // Chosen by sorting week LABELS, not issue numbers: the numbers are shared with
    // every other issue on the repo, so a manual re-file would break that ordering.
    expect(r.closedPrevious).toBe(700);
    expect(deps.closed).toEqual([700]);
  });

  /**
   * A clock-skewed or hand-filed issue labelled with a LATER week used to win the
   * descending sort, so the rollover closed it, commented a false supersession, and
   * left the real previous week open forever.
   */
  test("a future-labelled issue is never closed, and last week still is", async () => {
    const db = freshDb();
    const previous = isoWeekLabel(new Date(NOW.getTime() - 2 * WEEK_MS));
    const future = isoWeekLabel(new Date(NOW.getTime() + 3 * WEEK_MS));
    const deps = recordingDeps([weeklyIssue(700, previous), weeklyIssue(800, future)]);

    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, deps);

    expect(r.closedPrevious).toBe(700);
    expect(deps.closed).toEqual([700]);
  });

  test("a rollover failure does not undo this week's report", async () => {
    const db = freshDb();
    const previous = isoWeekLabel(new Date(NOW.getTime() - 2 * WEEK_MS));
    const deps = recordingDeps([weeklyIssue(700, previous)], coverageResult(), {
      close: new Error("HTTP 403"),
    });

    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, deps);

    // This week's report is the deliverable; tidying is not.
    expect(r.posted).toBe(true);
    expect(deps.created).toHaveLength(1);
    expect(r.closedPrevious).toBeNull();
    expect(r.facts?.errors?.some((e) => e.stage === "rollover")).toBe(true);
  });

  test("an unrelated issue carrying the label is not mistaken for a weekly one", async () => {
    const db = freshDb();
    const deps = recordingDeps([
      {
        number: 42,
        html_url: "https://example/42",
        state: "open",
        title: "Someone's note about the weekly summary",
        labels: [{ name: IMPORT_WEEKLY_ISSUE_LABEL }],
      },
    ]);

    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, deps);

    expect(r.posted).toBe(true);
    expect(deps.closed).toEqual([]);
  });

  test("nothing to close on the first week ever", async () => {
    const db = freshDb();
    const deps = recordingDeps();
    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, deps);
    expect(r.closedPrevious).toBeNull();
    expect(deps.closed).toEqual([]);
  });
});

describe("a dry run writes nothing", () => {
  test("no issue, no audit row, but a full rendered body", async () => {
    const db = freshDb();
    seedImported(db, "ds000001", { daysAgo: 1 });
    const deps = recordingDeps();

    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, deps);

    expect(r.applied).toBe(false);
    expect(r.posted).toBe(false);
    expect(deps.created).toEqual([]);
    expect(deps.closed).toEqual([]);
    expect(auditRows(db)).toEqual([]);
    // The point of a dry run: review exactly what would be filed.
    expect(r.renderedBody).toContain("@nemarAdmin");
    expect(r.renderedBody).toContain("| Imported this week | 1 |");
  });
});

// ---------------------------------------------------------------------------
// The cron wrapper's guard, both directions
// ---------------------------------------------------------------------------

describe("runWeeklyImportSummaryCron refuses outside production", () => {
  for (const environment of ["development", "staging", "test"]) {
    test(`${environment} skips without touching anything`, async () => {
      const db = freshDb();
      const deps = recordingDeps();
      const r = await runWeeklyImportSummaryCron(envFor(db, environment), deps);
      expect(r).toBeNull();
      expect(deps.created).toEqual([]);
      expect(auditRows(db)).toEqual([]);
    });
  }

  // Fail-closed: anything not recognised as non-production must RUN, or a mis-set
  // variable silently stops the report -- the regression this epic exists to prevent.
  for (const environment of ["production", "", undefined, "prod", "Production"]) {
    test(`${environment === undefined ? "undefined" : `"${environment}"`} runs with apply on`, async () => {
      const db = freshDb();
      const deps = recordingDeps();
      const r = await runWeeklyImportSummaryCron(
        { ...envFor(db), ENVIRONMENT: environment } as Bindings,
        deps,
      );
      expect(r).not.toBeNull();
      expect(r?.applied).toBe(true);
    });
  }
});

describe("weeklySummaryCronLine", () => {
  test("a gate refusal says so rather than pretending to report", async () => {
    const db = freshDb();
    await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, recordingDeps());
    stampReservationsAt(db, NOW);
    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, recordingDeps());
    expect(weeklySummaryCronLine(r)).toContain("not posted:");
  });

  test("a posted run names the week, the issue and the rollover", async () => {
    const db = freshDb();
    const previous = isoWeekLabel(new Date(NOW.getTime() - 2 * WEEK_MS));
    const deps = recordingDeps([weeklyIssue(700, previous)]);
    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, deps);
    const line = weeklySummaryCronLine(r);
    expect(line).toContain(`week=${THIS_WEEK}`);
    expect(line).toContain("issue=#900");
    expect(line).toContain("closed_previous=#700");
  });
});

// ---------------------------------------------------------------------------
// Boundaries and malformed inputs
// ---------------------------------------------------------------------------

describe("the import window boundary is inclusive", () => {
  /** `>=` vs `>` survived mutation because every fixture straddled the boundary by
   *  days. A dataset imported exactly at the edge belongs to the window it names. */
  test("a dataset at exactly the window edge is counted", async () => {
    const db = freshDb();
    // datetime('now','-7 days') to the second, which is the query's own boundary.
    db.query(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, source, source_id, status, visibility, created_at)
       VALUES ('on000001', 'edge', 1, 'openneuro', 'ds000001', 'active', 'public', datetime('now', '-7 days'))`,
    ).run();
    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());
    expect(r.facts?.importedThisWeek).toBe(1);
  });

  test("a dataset just outside it is not", async () => {
    const db = freshDb();
    db.query(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, source, source_id, status, visibility, created_at)
       VALUES ('on000001', 'outside', 1, 'openneuro', 'ds000001', 'active', 'public', datetime('now', '-7 days', '-1 second'))`,
    ).run();
    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());
    expect(r.facts?.importedThisWeek).toBe(0);
    // ...but it still counts toward the total, which has no window.
    expect(r.facts?.importedTotal).toBe(1);
  });
});

describe("a week of FAILED cron runs is not a quiet week", () => {
  /**
   * The third state, from the report's side. A failed heartbeat proves the cron ran,
   * so it must not trigger "the daily jobs may not be running" -- but it measured
   * nothing, so it must not read as "0 recovered" either. An expired PAT is the
   * likeliest way to get a week of these, and both wrong answers point the operator
   * away from it.
   */
  test("all runs failed: counts stay unknown and the reason is surfaced", async () => {
    const db = freshDb();
    for (const daysAgo of [1, 2, 3]) {
      seedTriageAudit(
        db,
        { source: "cron", ran: true, failed: true, error: "Bad credentials" },
        daysAgo,
      );
    }

    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());

    expect(r.facts?.issuesClosed).toBeNull();
    expect(r.facts?.issuesRelabelled).toBeNull();
    const said = r.facts?.errors.filter((e) => e.stage === "sweep-activity") ?? [];
    expect(said).toHaveLength(3);
    expect(said[0]?.error).toContain("Bad credentials");
  });

  test("a mix of failed and successful runs reports the successful counts", async () => {
    const db = freshDb();
    seedTriageAudit(db, { source: "cron", ran: true, failed: true, error: "HTTP 502" }, 3);
    seedTriageAudit(db, { source: "cron", closed: 2, relabelled: 1 }, 2);
    seedTriageAudit(db, { source: "cron", closed: 1, relabelled: 0 }, 1);

    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());

    // The failure does not zero the week, and the successes are not hidden by it.
    expect(r.facts?.issuesClosed).toBe(3);
    expect(r.facts?.issuesRelabelled).toBe(1);
    expect(r.facts?.errors.some((e) => e.error.includes("HTTP 502"))).toBe(true);
  });
});

describe("the window tiles between consecutive weeks", () => {
  /**
   * The window used to be `datetime('now', '-7 days')`, evaluated when the query ran
   * -- minutes into the tick, after a full paginated OpenNeuro scan whose duration
   * varies. So week N's window started later or earlier than week N-1's ended, and
   * rows in the gap appeared in NEITHER report (or, the other way, in both). Monday's
   * own triage row sits exactly on that boundary, and under-reporting recoveries
   * reads as good news.
   */
  test("a row exactly at the window start is counted", async () => {
    const db = freshDb();
    seedTriageAudit(db, { source: "cron", closed: 3 }, 7);
    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());
    expect(r.facts?.issuesClosed).toBe(3);
  });

  test("a row just before the window start is not", async () => {
    const db = freshDb();
    seedTriageAudit(db, { source: "cron", closed: 3 }, 7.001);
    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());
    // NULL, not 0: no cron rows in the window means the section could not see, which
    // this phase reports as unknown and treats as needing attention. A 0 here would
    // be the founding confusion -- "nothing recovered" versus "nothing recorded".
    expect(r.facts?.issuesClosed).toBeNull();
  });

  test("a row after `now` is excluded, so next week's report owns it", async () => {
    // The upper bound is what makes the windows tile rather than overlap: without it
    // a row written between this query and the report's own `now` would be counted
    // twice, once here and once next week.
    const db = freshDb();
    seedTriageAudit(db, { source: "cron", closed: 5 }, -0.5);
    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());
    expect(r.facts?.issuesClosed).toBeNull();
  });

  test("two consecutive weeks partition the rows exactly once each", async () => {
    // The property, stated directly: sum over both weeks equals the number seeded,
    // with no row counted twice and none dropped.
    const db = freshDb();
    for (const daysAgo of [0.5, 3, 6.5, 7.5, 10, 13.5]) {
      seedTriageAudit(db, { source: "cron", closed: 1 }, daysAgo);
    }
    const thisWeek = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());
    const lastWeek = await runWeeklyImportSummary(
      envFor(db),
      { now: new Date(NOW.getTime() - 7 * 86_400_000) },
      recordingDeps(),
    );
    expect(thisWeek.facts?.issuesClosed).toBe(3);
    expect(lastWeek.facts?.issuesClosed).toBe(3);
  });
});

describe("the title dedup reports already-filed, not would-create", () => {
  /**
   * `already-filed` was declared, documented at length, and consumed by the log
   * formatter -- but nothing returned it, so an APPLIED run that hit the dedup logged
   * "not posted (dry run)", and index.ts escalates that line to console.error. The
   * loudest line of the week was a false one.
   */
  test("an applied run that finds the week already open says so, with the number", async () => {
    const db = freshDb();
    const week = isoWeekLabel(new Date(NOW.getTime() - WEEK_MS));
    const deps = recordingDeps([weeklyIssue(881, week)]);

    const r = await runWeeklyImportSummary(envFor(db), { apply: true, now: NOW }, deps);

    expect(r.posted).toBe(false);
    expect(r.issue?.action).toBe("already-filed");
    // The number matters: an operator asking why nothing was posted wants the issue
    // that already exists, not a bare "no".
    expect(r.issue?.number).toBe(881);
    expect(deps.created).toEqual([]);
    // And the log line says what happened rather than claiming a dry run.
    expect(weeklySummaryCronLine(r)).toContain("already filed as #881");
    expect(weeklySummaryCronLine(r)).not.toContain("dry run");
  });
});

describe("a failed post releases only its own reservation", () => {
  /**
   * The release was keyed on (action, week), so a second attempt at a week that had
   * ALREADY been posted once would delete both rows -- destroying the durable record
   * of the successful post, in a table the rest of the system treats as append-only.
   */
  test("an earlier successful reservation for the same week survives", async () => {
    const db = freshDb();
    const week = isoWeekLabel(new Date(NOW.getTime() - WEEK_MS));
    // A prior, successful post of this same week.
    db.query(
      `INSERT INTO audit_log (action, resource_type, resource_id, details, timestamp)
       VALUES ('import_weekly_summary', 'issue', ?, '{"note":"earlier good post"}', ?)`,
    ).run(week, sqliteUtc(new Date(NOW.getTime() - 60_000)));

    const deps = recordingDeps([], coverageResult(), { create: new Error("GitHub 502") });

    // The post failure is caught and reported as a `post`-stage error, not rethrown
    // (the report is the deliverable; ADR 0054), so `force` is needed to get past the
    // gate that the earlier row would otherwise close.
    const r = await runWeeklyImportSummary(
      envFor(db),
      { apply: true, force: true, now: NOW },
      deps,
    );
    expect(r.posted).toBe(false);
    expect(r.facts?.errors.some((e) => e.stage === "post")).toBe(true);

    const rows = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'import_weekly_summary'",
      )
      .get();
    // Exactly the earlier row remains: this run's was released, that one was not.
    expect(rows?.n).toBe(1);
    const kept = db
      .query<{ details: string }, []>(
        "SELECT details FROM audit_log WHERE action = 'import_weekly_summary'",
      )
      .get();
    expect(kept?.details).toContain("earlier good post");
  });
});

describe("malformed audit rows do not corrupt the section", () => {
  test("a row whose details is not JSON is reported, not silently dropped", async () => {
    const db = freshDb();
    // Dated from the injected clock, like every other audit fixture here.
    const inWindow = sqliteUtc(new Date(NOW.getTime() - 86_400_000));
    db.query(
      `INSERT INTO audit_log (action, details, timestamp)
       VALUES ('import_issue_triage', '{"source":"cron","closed":2}', ?)`,
    ).run(inWindow);
    db.query(
      `INSERT INTO audit_log (action, details, timestamp)
       VALUES ('import_issue_triage', 'not json at all', ?)`,
    ).run(inWindow);

    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());

    // The readable row still counts; the unreadable one is surfaced rather than
    // quietly treated as a zero.
    expect(r.facts?.issuesClosed).toBe(2);
    expect(r.facts?.errors.some((e) => e.stage === "sweep-activity")).toBe(true);
  });

  test("a manual admin run is not reported as daily sweep activity", async () => {
    // The admin route writes the same action with the same keys and no `source`, so
    // without the filter a hand-run triage would be published as something the cron
    // did.
    const db = freshDb();
    db.query(
      `INSERT INTO audit_log (user_id, action, details, timestamp)
       VALUES (1, 'import_issue_triage', '{"closed":9,"relabelled":9}', ?)`,
    ).run(sqliteUtc(new Date(NOW.getTime() - 86_400_000)));

    const r = await runWeeklyImportSummary(envFor(db), { now: NOW }, recordingDeps());

    expect(r.facts?.issuesClosed).toBeNull();
  });
});

describe("the default coverage collaborator is the read-only sweep", () => {
  /**
   * Every other test injects `coverage`, so the `??` default is never evaluated --
   * review confirmed that swapping it for `runImportCoverageSweepCron`, which forces
   * `apply: true` and would file/close the coverage issue as a side effect of writing
   * a report, left the whole suite green.
   *
   * Pinned statically rather than behaviourally on purpose: exercising the real
   * default means a live OpenNeuro call, and a test that reaches the network is a test
   * that fails for reasons unrelated to the thing it names. The identity of the
   * default is exactly what needs guarding, and it is visible in the source.
   */
  test("the default is the raw sweep, never the apply-forcing cron wrapper", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "src", "services", "import-weekly-summary-sweep.ts"),
      "utf-8",
    );
    expect(src).toContain("deps.coverage ?? runImportCoverageSweep;");
    expect(src).not.toContain("deps.coverage ?? runImportCoverageSweepCron");
    // And the call site must ask for a read.
    expect(src).toContain("coverage(env, { apply: false })");
  });
});

// ---------------------------------------------------------------------------
// The Neurobagel section (epic #1586, phase 6)
// ---------------------------------------------------------------------------

describe("the Neurobagel section of the weekly report", () => {
  /**
   * The rows are REAL heartbeats, written by the real sweep against a real local stand-in for
   * upstream's public API, and then dated inside the report's window (the database stamps
   * `now`, the report's window ends at the injected Monday). This environment has no bucket and
   * a writer that is off, so the store, node and registration checks are `unchecked` in them.
   */
  let upstream: UpstreamStandin;
  beforeAll(() => {
    upstream = startUpstreamStandin();
  });
  afterAll(() => upstream.stop());
  const moved = () => {
    upstream.answers = {
      ...upstream.answers,
      "/repos/neurobagel/api/releases/latest": { tag_name: "v0.99.0" },
    };
  };
  const unmoved = () => {
    upstream.answers = { ...RECORDED };
  };

  /** Run the sweep once and move its heartbeat `daysAgo` before the report's `NOW`. */
  async function heartbeat(
    db: Database,
    daysAgo: number,
    trigger: "cron" | "admin" = "cron",
  ): Promise<void> {
    await runNeurobagelVerificationSweep(envFor(db), { trigger, timeoutMs: 3000 });
    db.query(
      "UPDATE audit_log SET timestamp = ? WHERE id = (SELECT MAX(id) FROM audit_log WHERE action = 'neurobagel_verification')",
    ).run(sqliteUtc(new Date(NOW.getTime() - daysAgo * 86_400_000)));
  }

  /** `n` daily runs, on the `n` days before the report. */
  async function dailyRuns(db: Database, n: number): Promise<void> {
    for (let day = 1; day <= n; day++) await heartbeat(db, day);
  }

  async function report(db: Database) {
    const r = await runWeeklyImportSummary(envFor(db), { force: true, now: NOW }, recordingDeps());
    if (!r.facts) throw new Error("no facts");
    return { facts: r.facts, body: r.renderedBody ?? "" };
  }

  test("no heartbeat in the window is unknown, not zero, and the headline asks for attention", async () => {
    const db = freshDb();
    unmoved();
    const { facts, body } = await report(db);
    expect(facts.neurobagel).toBeNull();
    expect(body).toContain("## Neurobagel federation");
    expect(body).toContain(
      "No daily verification run was recorded in this window, which is unknown rather than zero",
    );
    expect(body).toContain("no Neurobagel verification run was recorded");
    expect(body).not.toContain("Nothing needs attention");
  });

  test("the daily runs are counted by verdict, and by check, and an on-demand run is not the daily job", async () => {
    const db = freshDb();
    unmoved();
    await heartbeat(db, 5);
    moved();
    await heartbeat(db, 3);
    unmoved();
    await heartbeat(db, 1);
    // An admin's run an hour before the report: not evidence that the daily job ran.
    moved();
    await heartbeat(db, 0.04, "admin");
    unmoved();

    const { facts, body } = await report(db);
    // Drift alone ran, so a healthy drift is "unchecked" overall, and the alarm day is an alarm.
    expect(facts.neurobagel).toMatchObject({
      runs: 3,
      failedRuns: 0,
      days: { healthy: 0, alarm: 1, unknown: 0, unchecked: 2 },
      checkDays: {
        store: { unchecked: 3 },
        node: { unchecked: 3 },
        registration: { unchecked: 3 },
        drift: { healthy: 2, alarm: 1 },
      },
      latest: { overall: "unchecked" },
    });
    expect(body).toMatch(/Latest daily run \(.+\): \*\*UNCHECKED\*\*\./);
    expect(body).toContain("| store | unchecked | The writer is off");
    expect(body).toContain("| node | unchecked | NEUROBAGEL_NODE_URL is not set");
    expect(body).toContain("| drift | healthy |");
    expect(body).toContain(
      "Daily runs in this window: 3 of 7 expected (healthy 0, alarm 1, unknown 0, unchecked 2; the sweep itself failed on 0).",
    );
    expect(body).toContain(
      "Checks that did not run: store 3 day(s), node 3 day(s), registration 3 day(s).",
    );
    // The latest is not an alarm but a day alarmed, and only 3 of 7 daily runs exist: both asked for.
    expect(body).toContain("Neurobagel verification alarmed on 1 day(s) this week");
    expect(body).toContain("missing for 4 of 7 day(s)");
  });

  test("an alarming latest run is the headline, with the reason the sweep gave", async () => {
    const db = freshDb();
    moved();
    await dailyRuns(db, 1);
    unmoved();
    const { body } = await report(db);
    expect(body).toContain("**Needs attention:**");
    expect(body).toContain("Neurobagel verification is alarming");
    expect(body).toContain("node API v0.11.0 -> v0.99.0");
  });

  test("a run that failed outright is counted as failed and as unknown, not skipped", async () => {
    const db = freshDb();
    unmoved();
    await heartbeat(db, 2);
    const opts = {
      trigger: "cron",
      get timeoutMs(): number {
        throw new Error("boom");
      },
    } as never;
    const quiet = console.error;
    console.error = () => {};
    await runNeurobagelVerificationSweep(envFor(db), opts);
    console.error = quiet;
    db.query(
      "UPDATE audit_log SET timestamp = ? WHERE id = (SELECT MAX(id) FROM audit_log WHERE action = 'neurobagel_verification')",
    ).run(sqliteUtc(new Date(NOW.getTime() - 86_400_000)));
    const { facts, body } = await report(db);
    expect(facts.neurobagel).toMatchObject({
      runs: 2,
      failedRuns: 1,
      days: { unchecked: 1, unknown: 1 },
      latest: { overall: "unknown" },
    });
    expect(body).toContain("Neurobagel verification could not be determined");
    expect(body).toContain("the Neurobagel sweep itself failed on 1 run(s)");
  });

  test("only the window counts: a run eight days old is not this week's", async () => {
    const db = freshDb();
    unmoved();
    await heartbeat(db, 8);
    const { facts } = await report(db);
    expect(facts.neurobagel).toBeNull();
  });

  test("a heartbeat row that is not one is reported, and the rest are still counted", async () => {
    const db = freshDb();
    unmoved();
    await heartbeat(db, 2);
    db.query(
      "INSERT INTO audit_log (action, resource_type, resource_id, details, timestamp) VALUES ('neurobagel_verification', 'neurobagel', 'cron', '{\"overall\":\"healthy\"}', ?)",
    ).run(sqliteUtc(new Date(NOW.getTime() - 86_400_000)));
    const { facts, body } = await report(db);
    expect(facts.neurobagel?.runs).toBe(1);
    expect(facts.errors.map((e) => e.error)).toContain(
      "a verification heartbeat row could not be read",
    );
    expect(body).toContain("Parts of this report that failed");
  });

  test("a cron that stopped on day two is flagged: one missing daily run is tolerated, two are not", async () => {
    unmoved();
    for (const [runs, flagged] of [
      [7, false],
      [6, false],
      [5, true],
      [2, true],
    ] as const) {
      const db = freshDb();
      await dailyRuns(db, runs);
      const { body } = await report(db);
      expect(body.includes("daily Neurobagel verification is missing for")).toBe(flagged);
      expect(body).toContain(`Daily runs in this window: ${runs} of 7 expected`);
    }
  });

  describe("findings are counted as findings, from every place, and never named", () => {
    const row = (
      db: Database,
      action: string,
      resourceId: string | null,
      details: string,
      daysAgo = 1,
    ) =>
      db
        .query(
          "INSERT INTO audit_log (action, resource_type, resource_id, details, timestamp) VALUES (?, 'dataset', ?, ?, ?)",
        )
        .run(
          action,
          resourceId,
          details,
          sqliteUtc(new Date(NOW.getTime() - daysAgo * 86_400_000)),
        );
    const storeFinding = JSON.stringify({
      findings: [{ check: NEUROBAGEL_STORE_CHECK, severity: "invariant" }],
    });
    /** The writer's own ledger row, through the writer's own function. */
    async function ledgerFinding(db: Database, id: string, daysAgo = 1): Promise<void> {
      const d1 = realD1(db);
      await recordLedgerState(d1, await readLedger(d1), id, { state: "anonymity" });
      db.query(
        "UPDATE audit_log SET timestamp = ? WHERE id = (SELECT MAX(id) FROM audit_log WHERE action = 'neurobagel_anonymity_finding')",
      ).run(sqliteUtc(new Date(NOW.getTime() - daysAgo * 86_400_000)));
    }

    test("a dataset found on three daily runs is one finding, and a second dataset is a second", async () => {
      const db = freshDb();
      unmoved();
      await dailyRuns(db, 1);
      for (const daysAgo of [1, 2, 3])
        row(db, "anonymity_findings", "nm099998", storeFinding, daysAgo);
      row(db, "neurobagel_verify_anonymity_finding", "nm099997", JSON.stringify({ check: "x" }));
      // A different check on the same dataset, and a finding from before the window.
      row(
        db,
        "anonymity_findings",
        "nm099998",
        JSON.stringify({ findings: [{ check: "repo_public" }] }),
      );
      row(db, "anonymity_findings", "nm099995", storeFinding, 9);
      const { facts, body } = await report(db);
      expect(facts.neurobagelFindings).toBe(2);
      expect(body).toContain("over the window and what stands: 2.");
      expect(body).toContain("2 Neurobagel finding(s) need attention (see the audit log)");
    });

    test("the writer's standing finding is counted, as status counts it, from before the window too", async () => {
      const db = freshDb();
      unmoved();
      await dailyRuns(db, 1);
      await ledgerFinding(db, "nm099996", 40);
      const { facts } = await report(db);
      expect(facts.neurobagelFindings).toBe(1);
      // The weekly and `status` say the same number.
      const status = await neurobagelStatus(envFor(db));
      expect(status.anonymity_findings).toBe(1);
      expect(facts.neurobagelFindings).toBe(status.anonymity_findings as number);

      // Cleared, it is gone from both.
      const d1 = realD1(db);
      await recordLedgerState(d1, await readLedger(d1), "nm099996", { state: "clear" });
      const after = await report(db);
      expect(after.facts.neurobagelFindings).toBe(0);
      expect((await neurobagelStatus(envFor(db))).anonymity_findings).toBe(0);
    });

    test("one dataset recorded in all three places is one finding", async () => {
      const db = freshDb();
      unmoved();
      await dailyRuns(db, 1);
      await ledgerFinding(db, "nm099998");
      row(db, "anonymity_findings", "nm099998", storeFinding);
      row(db, "neurobagel_verify_anonymity_finding", "nm099998", JSON.stringify({ check: "x" }));
      expect((await report(db)).facts.neurobagelFindings).toBe(1);
    });

    test("findings need attention even in a week the daily sweep never wrote a row", async () => {
      const db = freshDb();
      unmoved();
      await ledgerFinding(db, "nm099998");
      const { facts, body } = await report(db);
      expect(facts.neurobagel).toBeNull();
      expect(facts.neurobagelFindings).toBe(1);
      expect(body).toContain("1 Neurobagel finding(s) need attention (see the audit log)");
      expect(body).toContain("over the window and what stands: 1.");
    });

    test("an audit row that cannot be read makes the count unknown, never low", async () => {
      const db = freshDb();
      unmoved();
      await dailyRuns(db, 1);
      row(db, "anonymity_findings", "nm099998", "not json at all");
      const { facts, body } = await report(db);
      expect(facts.neurobagelFindings).toBeNull();
      expect(body).toContain("over the window and what stands: unknown.");
      expect(body).toContain("Neurobagel findings could not be counted");
    });

    test("none recorded is a zero, said as a zero", async () => {
      const db = freshDb();
      unmoved();
      await dailyRuns(db, 1);
      const { facts, body } = await report(db);
      expect(facts.neurobagelFindings).toBe(0);
      expect(body).toContain("over the window and what stands: 0.");
    });

    test("the report, in a week full of findings, names no dataset and no kind", async () => {
      const db = freshDb();
      moved();
      await dailyRuns(db, 3);
      unmoved();
      await ledgerFinding(db, "nm099996");
      row(db, "anonymity_findings", "nm099998", storeFinding);
      row(db, "neurobagel_verify_anonymity_finding", "nm099997", JSON.stringify({ check: "x" }));
      const { body } = await report(db);
      const section = body.slice(
        body.indexOf("## Neurobagel federation"),
        body.indexOf("## Blocklisted datasets"),
      );
      for (const text of [section, body.split("\n")[2] ?? ""]) {
        expect(text).not.toMatch(/anonym|deposit|\bclass\b/i);
      }
      expect(body).not.toMatch(/nm09999[5-8]/);
      expect(body).toContain("3 Neurobagel finding(s) need attention");
    });
  });
});
