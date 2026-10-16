/**
 * The mail lease that waits for a publication review, on Miniflare D1 (ADR 0102, section 6).
 *
 * Every other review test runs on bun:sqlite, which is more lenient than D1. The statements that
 * carry the lease's guarantee are the ones run here, through the real service functions with only
 * the database swapped: the `UPDATE ... RETURNING` lease with its correlated `EXISTS` over
 * `publication_reviews` and its `json_extract` of the screened head, the watchdog's unmailed
 * query with the same clause, and the review's read for the mail's section. Resend is the shared
 * capture; nothing leaves the machine.
 *
 * Real D1 enforces the foreign key from `publication_requests.requested_by` to `users`, which
 * bun:sqlite does not, so the users are inserted first.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { parseScreenReport } from "../../shared/identifier-screen-report";
import {
  SCREEN_SWEEP_LIMIT,
  notifyAdminsOfScreen,
  reviewHoldSql,
  sweepIdentifierScreens,
  unmailedScreensSql,
} from "../src/services/identifier-screen";
import { sqliteInstant } from "../src/services/publication-review-rows";
import type { Bindings } from "../src/types/bindings";
import { SCREENED_HEAD, cleanScreenReportBody } from "./helpers/identifier-screen";
import { applyMigrations, migrationFiles } from "./helpers/miniflare-d1";
import { asSend, withFakeResend } from "./helpers/resend";

const DATASET = "nm000471";
const OTHER_HEAD = "f".repeat(40);
let mf: Miniflare;
let counter = 0;

/** A request whose screen reported clean five or more minutes ago and whose mail has not gone out. */
async function seededD1(): Promise<D1Database> {
  counter += 1;
  const d1 = (await mf.getD1Database(`DB${counter}`)) as unknown as D1Database;
  await applyMigrations(d1, migrationFiles());
  await d1
    .prepare(
      `INSERT INTO users (id, username, email, password_hash, status, role, email_verified)
       VALUES (1, 'd1owner', 'd1owner@example.org', 'x', 'approved', 'member', 1),
              (2, 'd1admin', 'd1admin@example.org', 'x', 'approved', 'admin', 1)`,
    )
    .run();
  await d1
    .prepare(
      `INSERT INTO publication_requests (id, dataset_id, requested_by, status,
                                         identifier_screen_status, identifier_screen_report,
                                         identifier_screen_at)
       VALUES (1, ?, 1, 'requested', 'clean', ?, datetime('now', '-10 minutes'))`,
    )
    .bind(DATASET, JSON.stringify(parseScreenReport(cleanScreenReportBody(DATASET))))
    .run();
  return d1;
}

function env(d1: D1Database, reviewOn = true): Bindings {
  return {
    DB: d1,
    ENVIRONMENT: "production",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
    PUBLICATION_REVIEW_ENABLED: reviewOn ? "1" : undefined,
  } as Bindings;
}

async function dispatchedReview(
  d1: D1Database,
  over: { head?: string; anonymous?: number; minutesAgo?: number } = {},
) {
  await d1
    .prepare(
      `INSERT INTO publication_reviews (request_id, dataset_id, head_sha, anonymous, requested_by,
                                        state, nonce, created_at)
       VALUES (1, ?, ?, ?, 1, 'dispatched', 'n1', datetime('now', ?))`,
    )
    .bind(
      DATASET,
      over.head ?? SCREENED_HEAD,
      over.anonymous ?? 0,
      `-${over.minutesAgo ?? 2} minutes`,
    )
    .run();
}

async function mailState(d1: D1Database) {
  return d1
    .prepare(
      `SELECT identifier_screen_emailed_at AS emailed, identifier_screen_mail_claimed_at AS claimed
         FROM publication_requests WHERE id = 1`,
    )
    .first<{ emailed: string | null; claimed: string | null }>();
}

async function unmailedIds(d1: D1Database, flagOn: boolean): Promise<number[]> {
  const { results } = await d1
    .prepare(unmailedScreensSql(flagOn))
    .bind(SCREEN_SWEEP_LIMIT)
    .all<{ id: number }>();
  return results.map((r) => r.id);
}

beforeAll(() => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
    compatibilityDate: "2024-12-01",
    d1Databases: ["DB1", "DB2", "DB3", "DB4", "DB5", "DB6"],
  });
});

afterAll(async () => {
  await mf?.dispose();
});

describe("the review's lease on D1", () => {
  test("a young dispatched review holds the lease and the watchdog's query; its deadline releases both", async () => {
    const d1 = await seededD1();
    await dispatchedReview(d1, { minutesAgo: 2 });
    await withFakeResend(async (calls) => {
      expect(await unmailedIds(d1, true)).toEqual([]);
      expect(await notifyAdminsOfScreen(env(d1), 1)).toBe("not-claimed");
      expect(await mailState(d1)).toEqual({ emailed: null, claimed: null });
      expect(calls).toHaveLength(0);

      // The row ages past the deadline, with no watchdog to mark it.
      await d1
        .prepare("UPDATE publication_reviews SET created_at = datetime('now', '-31 minutes')")
        .run();
      expect(await unmailedIds(d1, true)).toEqual([1]);
      expect(await notifyAdminsOfScreen(env(d1), 1)).toBe("sent");
      const sends = calls.filter((c) => c.path === "/emails").map(asSend);
      expect(sends).toHaveLength(1);
      expect(sends[0].html).toContain("Publication review: action required");
      expect((await mailState(d1))?.emailed).not.toBeNull();
    });
  });

  test("the hold can be decided at an instant of the caller's, not only the database's", async () => {
    // The depositor's resend builds its section at an instant of the Worker's, and decides whether
    // the reminder counts as the mail at the SAME instant: a review a second past its deadline by
    // the database's clock is still in flight a few seconds earlier, and not at the later one.
    const d1 = await seededD1();
    await dispatchedReview(d1, { minutesAgo: 30 });
    await d1
      .prepare("UPDATE publication_reviews SET created_at = datetime('now', '-1801 seconds')")
      .run();
    const held = async (atMs?: number) =>
      (await d1
        .prepare(
          `SELECT 1 AS free FROM publication_requests WHERE id = 1${reviewHoldSql(true, atMs)}`,
        )
        .first()) === null;
    const now = Date.now();
    expect(await held(now - 5_000)).toBe(true);
    expect(await held(now + 5_000)).toBe(false);
    // With no instant the statement is what it always was, decided by the database's clock.
    expect(await held()).toBe(false);
    expect(reviewHoldSql(true, now - 5_000)).toContain(sqliteInstant(now - 5_000));
    expect(reviewHoldSql(false, now)).toBe("");
  });

  test("an instant that is not one never reaches a statement", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1e20]) {
      expect(() => sqliteInstant(bad)).toThrow(RangeError);
    }
    expect(sqliteInstant(Date.UTC(2026, 9, 13, 7, 41, 43, 999))).toBe("2026-10-13 07:41:43");
    expect(sqliteInstant(0)).toBe("1970-01-01 00:00:00");
  });

  test("a review of another commit or the other kind of release holds nothing", async () => {
    const d1 = await seededD1();
    await dispatchedReview(d1, { head: OTHER_HEAD });
    await dispatchedReview(d1, { anonymous: 1 });
    await withFakeResend(async (calls) => {
      expect(await unmailedIds(d1, true)).toEqual([1]);
      expect(await notifyAdminsOfScreen(env(d1), 1)).toBe("sent");
      expect(calls.filter((c) => c.path === "/emails")).toHaveLength(1);
    });
  });

  test("with the review off the statements ignore the review table, whatever it holds", async () => {
    const d1 = await seededD1();
    await dispatchedReview(d1, { minutesAgo: 2 });
    expect(await unmailedIds(d1, false)).toEqual([1]);
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(env(d1, false), 1)).toBe("sent");
      expect(calls.filter((c) => c.path === "/emails")).toHaveLength(1);
    });
  });

  test("a request that is not requested is not held", async () => {
    const d1 = await seededD1();
    await dispatchedReview(d1, { minutesAgo: 2 });
    await d1
      .prepare(
        "UPDATE publication_requests SET status = 'blocked', block_reason = 'min_requirements_failed' WHERE id = 1",
      )
      .run();
    await withFakeResend(async (calls) => {
      expect(await unmailedIds(d1, true)).toEqual([1]);
      expect(await notifyAdminsOfScreen(env(d1), 1)).toBe("sent");
      expect(calls.filter((c) => c.path === "/emails")).toHaveLength(1);
    });
  });

  test("the watchdog mails a request once its review has reported, through the real sweep", async () => {
    const d1 = await seededD1();
    await dispatchedReview(d1, { minutesAgo: 2 });
    await withFakeResend(async (calls) => {
      expect((await sweepIdentifierScreens(env(d1))).emailed).toBe(0);
      await d1
        .prepare(
          `UPDATE publication_reviews
              SET state = 'errored', detail = 'workflow_failed', nonce = NULL,
                  decided_at = datetime('now')`,
        )
        .run();
      expect((await sweepIdentifierScreens(env(d1))).emailed).toBe(1);
      const sends = calls.filter((c) => c.path === "/emails").map(asSend);
      expect(sends).toHaveLength(1);
      expect(sends[0].html).toContain("The review could not run");
    });
  });
});
