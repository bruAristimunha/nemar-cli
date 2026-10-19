/**
 * `lastWeeklyCronFiring` against fixed, real instants (#1843).
 *
 * The bug lived in a three-hour window each week (Monday 00:00 to 02:59:59 UTC), so
 * the proof cannot wait for the window and must not fake the clock: the function takes
 * the instant as an argument and every case below is an ordinary `Date`.
 *
 * 2026-09-07 and 2026-09-14 are Mondays, and the expected values are written out as
 * literals rather than derived, so the expectation does not share the implementation's
 * arithmetic.
 */

import { describe, expect, test } from "bun:test";
import { shouldRunWeeklySummary } from "../../src/services/import-weekly-summary";
import { WEEKLY_CRON_HOUR_UTC, lastWeeklyCronFiring } from "./weekly-cron-firing";

const WEEK_MS = 7 * 86_400_000;

const firing = (at: string): string => lastWeeklyCronFiring(new Date(at)).toISOString();

describe("the window, where the current week's Monday 03:00 is still ahead", () => {
  test("Monday 00:00:00 UTC is the week before's firing", () => {
    expect(firing("2026-09-07T00:00:00Z")).toBe("2026-08-31T03:00:00.000Z");
  });

  test("Monday 02:59:59 UTC is still the week before's firing", () => {
    expect(firing("2026-09-07T02:59:59Z")).toBe("2026-08-31T03:00:00.000Z");
  });
});

describe("outside the window", () => {
  test("Monday 03:00:00 UTC is itself a firing", () => {
    expect(firing("2026-09-07T03:00:00Z")).toBe("2026-09-07T03:00:00.000Z");
  });

  test("Sunday 23:59:59 UTC is the Monday six days earlier", () => {
    expect(firing("2026-09-13T23:59:59Z")).toBe("2026-09-07T03:00:00.000Z");
  });

  test("the next Monday 03:00:00 UTC is the next firing", () => {
    expect(firing("2026-09-14T03:00:00Z")).toBe("2026-09-14T03:00:00.000Z");
  });

  test("the next Monday's window falls back to the firing just before it", () => {
    expect(firing("2026-09-14T00:00:00Z")).toBe("2026-09-07T03:00:00.000Z");
  });

  test("midweek is the Monday of that week", () => {
    expect(firing("2026-09-10T12:34:56Z")).toBe("2026-09-07T03:00:00.000Z");
  });
});

describe("the calendar does not bend it", () => {
  test("the window at an ISO year boundary reaches into the previous year", () => {
    // 2027-01-04 is the Monday of 2027-W01; the firing before it is 2026-12-28.
    expect(firing("2027-01-04T01:00:00Z")).toBe("2026-12-28T03:00:00.000Z");
  });

  test("a month boundary is crossed by plain arithmetic", () => {
    // 2026-08-03 is a Monday, so the firing before 02:00 is 2026-07-27.
    expect(firing("2026-08-03T02:00:00Z")).toBe("2026-07-27T03:00:00.000Z");
  });
});

describe("the contract, at every hour of five weeks", () => {
  // Hourly across 2026-08-31 to 2026-10-05, plus the second before each hour, which is
  // where the 03:00 and 00:00 boundaries sit. Every result must be a Monday at 03:00 UTC
  // that is not later than the instant and is less than a week before it.
  const start = Date.parse("2026-08-31T00:00:00Z");
  const instants: Date[] = [];
  for (let h = 0; h < 5 * 7 * 24; h++) {
    instants.push(new Date(start + h * 3_600_000));
    instants.push(new Date(start + h * 3_600_000 - 1_000));
  }

  test("never later than the instant, and less than a week behind it", () => {
    for (const at of instants) {
      const age = at.getTime() - lastWeeklyCronFiring(at).getTime();
      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThan(WEEK_MS);
    }
  });

  test("always a Monday at the cron hour, to the millisecond", () => {
    for (const at of instants) {
      const f = lastWeeklyCronFiring(at);
      expect(f.getUTCDay()).toBe(1);
      expect(f.getUTCHours()).toBe(WEEKLY_CRON_HOUR_UTC);
      expect(f.getUTCMinutes() + f.getUTCSeconds() + f.getUTCMilliseconds()).toBe(0);
    }
  });

  test("on a day the weekly summary is allowed to run", () => {
    // The product's own Monday predicate, so this helper cannot drift from the day
    // the cron actually reports on.
    for (const at of instants) {
      expect(shouldRunWeeklySummary(lastWeeklyCronFiring(at))).toBe(true);
    }
  });
});
