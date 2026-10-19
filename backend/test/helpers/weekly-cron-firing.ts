/**
 * When the weekly import summary last fired on schedule, as of an instant (#1843).
 *
 * The daily cron fires at 03:00 UTC (`crons = ["0 3 * * *", ...]` in
 * `wrangler-sccn.toml`), and `shouldRunWeeklySummary` lets the report through on
 * Mondays, so the scheduled weekly summary fires on Monday at 03:00 UTC and at no
 * other instant. An admin run can happen at any time; it is not a firing.
 *
 * "Last fired" is not "the Monday of this ISO week at 03:00". An ISO week starts at
 * Monday 00:00, so from Monday 00:00 to 02:59:59 UTC the 03:00 of the current week
 * is still AHEAD, and the most recent firing is the one seven days earlier. A fixture
 * that used the current week's Monday described an instant the real clock had not
 * reached, for three hours every week, and a test asserting it was not in the future
 * failed for exactly those three hours.
 *
 * Pure: the instant is an argument, so the boundaries can be proven with real
 * instants instead of by waiting for the window.
 */

/** The hour, in UTC, at which the weekly summary fires on a Monday. */
export const WEEKLY_CRON_HOUR_UTC = 3;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** The latest Monday 03:00:00.000 UTC that is not later than `at`. */
export function lastWeeklyCronFiring(at: Date): Date {
  const utcMidnight = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  // getUTCDay: 0 = Sunday. ISO counts Monday = 1 ... Sunday = 7.
  const isoDay = at.getUTCDay() === 0 ? 7 : at.getUTCDay();
  const thisWeeksFiring = utcMidnight - (isoDay - 1) * DAY_MS + WEEKLY_CRON_HOUR_UTC * HOUR_MS;
  return new Date(thisWeeksFiring <= at.getTime() ? thisWeeksFiring : thisWeeksFiring - WEEK_MS);
}
