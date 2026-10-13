/**
 * The publication review's SQL on Miniflare D1, the implementation `wrangler --local` runs (ADR 0102).
 *
 * Every other review test runs on bun:sqlite, which is more lenient than D1. The statements that
 * carry the feature's guarantees are the ones run here, through the real service functions with
 * only the database swapped: the insert with `ON CONFLICT`, both allowance ranks, the restart's
 * compare-and-set, the claim and its refusal (`EXISTS` inside an `UPDATE`, with `json_extract` of
 * the screened commit), the two result writes, the re-block, the re-armed mail and the watchdog.
 * GitHub is a `Bun.serve()` stand-in that records the dispatch; nothing leaves the machine.
 *
 * The depositor is inserted before the request: real D1 enforces the foreign key from
 * `publication_requests.requested_by` to `users`, which bun:sqlite does not.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Miniflare } from "miniflare";
import { parseScreenReport } from "../../shared/identifier-screen-report";
import {
  DEPOSITOR_DAILY_CAP,
  PLATFORM_DAILY_CAP,
  parsePublicationReviewReport,
} from "../../shared/publication-review";
import { minimumFailureSentence } from "../../shared/submission-minimums";
import {
  PLATFORM_RANK_SQL,
  claimPublicationReview,
  startPublicationReview,
  storePublicationReviewResult,
  sweepPublicationReviews,
} from "../src/services/publication-review";
import type { Bindings } from "../src/types/bindings";
import { SCREENED_HEAD } from "./helpers/identifier-screen";
import { applyMigrations, migrationFiles } from "./helpers/miniflare-d1";
import {
  evidenceFor,
  goodPublicationReport,
  screenReportBodyFor,
} from "./helpers/publication-review";
import { sendsTo, withFakeResend } from "./helpers/resend";

const DATASET = "nm000490";
const OTHER_HEAD = "d".repeat(40);

let mf: Miniflare;
let server: Server;
let dispatches: Record<string, unknown>[] = [];
let counter = 0;

async function seededD1(): Promise<D1Database> {
  counter += 1;
  const d1 = (await mf.getD1Database(`DB${counter}`)) as unknown as D1Database;
  await applyMigrations(d1, migrationFiles());
  await d1
    .prepare(
      `INSERT INTO users (id, username, email, password_hash, status, role, email_verified)
       VALUES (1, 'd1depositor', 'd1depositor@example.org', 'x', 'approved', 'member', 1),
              (2, 'd1admin', 'd1admin@example.org', 'x', 'approved', 'admin', 1)`,
    )
    .run();
  await d1
    .prepare(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox,
                             github_repo)
       VALUES (?, 'A sufficiently descriptive title for the dataset', 1, 'active', 'private', 0, ?)`,
    )
    .bind(DATASET, `nemarDatasets/${DATASET}`)
    .run();
  const report = parseScreenReport(screenReportBodyFor(DATASET, "clean", SCREENED_HEAD));
  await d1
    .prepare(
      `INSERT INTO publication_requests (id, dataset_id, requested_by, status, anonymous,
                                         identifier_screen_status, identifier_screen_report,
                                         identifier_screen_at, identifier_screen_emailed_at)
       VALUES (1, ?, 1, 'requested', 0, 'clean', ?, datetime('now'), datetime('now'))`,
    )
    .bind(DATASET, JSON.stringify(report))
    .run();
  return d1;
}

function env(d1: D1Database): Bindings {
  return {
    DB: d1,
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "ghp_d1_test",
    PRESCREEN_CALLBACK_SECRET: "d1-callback-secret",
    PUBLICATION_REVIEW_ENABLED: "1",
    API_BASE_URL: "https://api.test.nemar.org",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
  } as Bindings;
}

type Row = Record<string, unknown>;

async function reviews(d1: D1Database): Promise<Row[]> {
  const { results } = await d1.prepare("SELECT * FROM publication_reviews ORDER BY id").all<Row>();
  return results ?? [];
}

async function request(d1: D1Database): Promise<Row> {
  return (await d1.prepare("SELECT * FROM publication_requests WHERE id = 1").first<Row>()) as Row;
}

async function nonceOf(d1: D1Database, id: number): Promise<string> {
  const row = await d1
    .prepare("SELECT nonce FROM publication_reviews WHERE id = ?")
    .bind(id)
    .first<{ nonce: string }>();
  return row?.nonce as string;
}

/** A counted call by another depositor: an errored row whose run claimed, so it reached a model. */
async function spend(d1: D1Database, n: number, requestedBy: number, from = 1000) {
  for (let i = 0; i < n; i++) {
    await d1
      .prepare(
        `INSERT INTO publication_reviews (request_id, dataset_id, head_sha, anonymous, requested_by,
                                          state, detail, claimed_at, decided_at)
         VALUES (?, 'nm000491', ?, 0, ?, 'errored', 'model_unavailable', datetime('now'),
                 datetime('now'))`,
      )
      .bind(from + i, SCREENED_HEAD, requestedBy)
      .run();
  }
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/repos/nemarDatasets/.github/dispatches") {
        dispatches.push((await req.json()) as Record<string, unknown>);
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
    compatibilityDate: "2024-12-01",
    d1Databases: Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [`DB${i + 1}`, `DB${i + 1}`]),
    ),
  });
});

afterAll(async () => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
  await mf?.dispose();
});

describe("the review's statements on D1", () => {
  test("a start inserts once, ranks, dispatches; a second start of the commit finds the row", async () => {
    dispatches = [];
    const d1 = await seededD1();
    const out = await startPublicationReview(env(d1), { requestId: 1, datasetId: DATASET });
    expect(out).toMatchObject({ started: true, reason: "dispatched" });
    const [row] = await reviews(d1);
    expect(row).toMatchObject({
      request_id: 1,
      dataset_id: DATASET,
      head_sha: SCREENED_HEAD,
      anonymous: 0,
      requested_by: 1,
      state: "dispatched",
      attempts: 1,
    });
    expect(dispatches).toHaveLength(1);

    const again = await startPublicationReview(env(d1), { requestId: 1, datasetId: DATASET });
    expect(again).toMatchObject({ started: false, reason: "duplicate", reviewId: row.id });
    expect(await reviews(d1)).toHaveLength(1);
    expect(dispatches).toHaveLength(1);
  });

  test("the depositor's allowance is ranked from attempts after the insert", async () => {
    dispatches = [];
    const d1 = await seededD1();
    await spend(d1, DEPOSITOR_DAILY_CAP, 1);
    const out = await startPublicationReview(env(d1), { requestId: 1, datasetId: DATASET });
    expect(out).toMatchObject({ started: false, reason: "depositor_limit" });
    expect((await reviews(d1)).find((r) => r.request_id === 1)).toMatchObject({
      state: "declined",
      detail: "depositor_limit",
      nonce: null,
    });
    expect(dispatches).toHaveLength(0);
  });

  test("the platform's allowance is ranked the same way, and an administrator is held by it alone", async () => {
    dispatches = [];
    const d1 = await seededD1();
    await spend(d1, PLATFORM_DAILY_CAP, 2);
    const screen = await startPublicationReview(env(d1), { requestId: 1, datasetId: DATASET });
    expect(screen).toMatchObject({ started: false, reason: "platform_limit" });
    const row = (await reviews(d1)).find((r) => r.request_id === 1) as Row;
    expect(row).toMatchObject({ state: "declined", detail: "platform_limit" });

    // The platform's pool is still full: an administrator's start is held by it too.
    const asAdmin = await startPublicationReview(env(d1), {
      requestId: 1,
      datasetId: DATASET,
      adminUserId: 2,
    });
    expect(asAdmin).toMatchObject({ started: false, reason: "platform_limit", reviewId: row.id });
    expect(dispatches).toHaveLength(0);
  });

  test("an administrator's start restarts a declined row past the depositor's allowance", async () => {
    dispatches = [];
    const d1 = await seededD1();
    await spend(d1, DEPOSITOR_DAILY_CAP, 1);
    await startPublicationReview(env(d1), { requestId: 1, datasetId: DATASET });
    const declined = (await reviews(d1)).find((r) => r.request_id === 1) as Row;
    const out = await startPublicationReview(env(d1), {
      requestId: 1,
      datasetId: DATASET,
      adminUserId: 2,
    });
    expect(out).toEqual({ started: true, reason: "redispatched", reviewId: declined.id });
    expect((await reviews(d1)).find((r) => r.request_id === 1)).toMatchObject({
      state: "dispatched",
      detail: null,
      started_by: 2,
      attempts: 1,
    });
    expect(dispatches).toHaveLength(1);
  });

  test("a restart the platform declines leaves the call it already spent counted, on D1", async () => {
    dispatches = [];
    const d1 = await seededD1();
    const started = await startPublicationReview(env(d1), { requestId: 1, datasetId: DATASET });
    const id = started.reviewId as number;
    const nonce = await nonceOf(d1, id);
    expect(await claimPublicationReview(env(d1), id, DATASET, nonce)).toBe("claimed");
    await storePublicationReviewResult(env(d1), id, DATASET, nonce, {
      kind: "error",
      error: "model_unavailable",
    });
    await spend(d1, PLATFORM_DAILY_CAP - 1, 2);
    const counted = async () =>
      (await d1.prepare(PLATFORM_RANK_SQL).bind(Number.MAX_SAFE_INTEGER).first<{ n: number }>())?.n;
    expect(await counted()).toBe(PLATFORM_DAILY_CAP);

    dispatches = [];
    const out = await startPublicationReview(env(d1), {
      requestId: 1,
      datasetId: DATASET,
      adminUserId: 2,
    });
    expect(out).toMatchObject({ started: false, reason: "platform_limit", reviewId: id });
    expect((await reviews(d1)).find((r) => r.id === id)).toMatchObject({
      state: "declined",
      detail: "platform_limit",
      attempts: 2,
    });
    expect(dispatches).toHaveLength(0);
    // Its first call is still one of the day's fifty.
    expect(await counted()).toBe(PLATFORM_DAILY_CAP);
  });

  test("the claim is one conditional write bound to the screened commit and the request", async () => {
    dispatches = [];
    const d1 = await seededD1();
    const started = await startPublicationReview(env(d1), { requestId: 1, datasetId: DATASET });
    const id = started.reviewId as number;
    const nonce = await nonceOf(d1, id);
    expect(await claimPublicationReview(env(d1), id, DATASET, nonce)).toBe("claimed");
    expect((await reviews(d1))[0].claimed_at).not.toBeNull();
    expect(await claimPublicationReview(env(d1), id, DATASET, nonce)).toBe("already_claimed");
  });

  test("a screen that moved to another commit refuses the claim, and records stale_head", async () => {
    const d1 = await seededD1();
    const started = await startPublicationReview(env(d1), { requestId: 1, datasetId: DATASET });
    const id = started.reviewId as number;
    const nonce = await nonceOf(d1, id);
    await d1
      .prepare(
        "UPDATE publication_requests SET identifier_screen_report = json_set(identifier_screen_report, '$.head', ?) WHERE id = 1",
      )
      .bind(OTHER_HEAD)
      .run();
    expect(await claimPublicationReview(env(d1), id, DATASET, nonce)).toBe("stale_head");
    expect((await reviews(d1))[0]).toMatchObject({
      state: "errored",
      detail: "stale_head",
      nonce: null,
      claimed_at: null,
    });
  });

  test("a request no longer waiting for its decision refuses the claim", async () => {
    const d1 = await seededD1();
    const started = await startPublicationReview(env(d1), { requestId: 1, datasetId: DATASET });
    const id = started.reviewId as number;
    const nonce = await nonceOf(d1, id);
    await d1.prepare("UPDATE publication_requests SET status = 'blocked' WHERE id = 1").run();
    expect(await claimPublicationReview(env(d1), id, DATASET, nonce)).toBe("stale_head");
  });

  test("a result is stored once, and a failed minimum moves the request back to blocked", async () => {
    const d1 = await seededD1();
    const started = await startPublicationReview(env(d1), { requestId: 1, datasetId: DATASET });
    const id = started.reviewId as number;
    const nonce = await nonceOf(d1, id);
    expect(await claimPublicationReview(env(d1), id, DATASET, nonce)).toBe("claimed");

    const failing = parsePublicationReviewReport(
      goodPublicationReport({
        evidence: evidenceFor(SCREENED_HEAD, false, {
          minimums: "failed",
          minimum_failures: ["name_too_short"],
          name_length: 10,
        }),
      }),
    );
    const stored = await storePublicationReviewResult(env(d1), id, DATASET, nonce, {
      kind: "reported",
      report: failing,
    });
    expect(stored).toEqual({ stored: true, state: "reported" });
    expect((await reviews(d1))[0]).toMatchObject({
      state: "reported",
      verdict: "fail",
      nonce: null,
    });
    const req = await request(d1);
    expect(req).toMatchObject({ status: "blocked", block_reason: "min_requirements_failed" });
    expect(JSON.parse(req.min_requirements_reasons as string)).toEqual([
      minimumFailureSentence("name_too_short"),
    ]);

    // A replay finds the nonce spent and stores nothing.
    const again = await storePublicationReviewResult(env(d1), id, DATASET, nonce, {
      kind: "error",
      error: "model_refused",
    });
    expect(again).toEqual({ stored: false, state: null });
  });

  test("a fault inside the result's batch rolls all of it back on D1, and the token still answers", async () => {
    // The re-block runs ahead of the write of the result in the same batch. A trigger that aborts
    // it makes D1 itself prove the unit: nothing is stored, the nonce is not spent, and the retry
    // (the trigger gone) lands the result and the block together.
    const d1 = await seededD1();
    const started = await startPublicationReview(env(d1), { requestId: 1, datasetId: DATASET });
    const id = started.reviewId as number;
    const nonce = await nonceOf(d1, id);
    expect(await claimPublicationReview(env(d1), id, DATASET, nonce)).toBe("claimed");
    const failing = parsePublicationReviewReport(
      goodPublicationReport({
        evidence: evidenceFor(SCREENED_HEAD, false, {
          minimums: "failed",
          minimum_failures: ["name_too_short"],
          name_length: 10,
        }),
      }),
    );
    await d1
      .prepare(
        `CREATE TRIGGER abort_reblock BEFORE UPDATE ON publication_requests
           WHEN NEW.status = 'blocked' BEGIN SELECT RAISE(ABORT, 'simulated fault'); END`,
      )
      .run();
    await expect(
      storePublicationReviewResult(env(d1), id, DATASET, nonce, {
        kind: "reported",
        report: failing,
      }),
    ).rejects.toThrow();
    expect((await reviews(d1))[0]).toMatchObject({ state: "dispatched", report: null, nonce });
    expect(await request(d1)).toMatchObject({ status: "requested" });

    await d1.prepare("DROP TRIGGER abort_reblock").run();
    expect(
      await storePublicationReviewResult(env(d1), id, DATASET, nonce, {
        kind: "reported",
        report: failing,
      }),
    ).toEqual({ stored: true, state: "reported" });
    expect((await reviews(d1))[0]).toMatchObject({
      state: "reported",
      verdict: "fail",
      nonce: null,
    });
    expect(await request(d1)).toMatchObject({ status: "blocked" });
  });

  test("a fault after the re-block takes the re-block back with it on D1", async () => {
    // The re-block runs first in the batch and the write of the result after it. A trigger that
    // aborts the write of the result makes D1 prove the transaction: the re-block is undone too.
    const d1 = await seededD1();
    const started = await startPublicationReview(env(d1), { requestId: 1, datasetId: DATASET });
    const id = started.reviewId as number;
    const nonce = await nonceOf(d1, id);
    expect(await claimPublicationReview(env(d1), id, DATASET, nonce)).toBe("claimed");
    const failing = parsePublicationReviewReport(
      goodPublicationReport({
        evidence: evidenceFor(SCREENED_HEAD, false, {
          minimums: "failed",
          minimum_failures: ["name_too_short"],
          name_length: 10,
        }),
      }),
    );
    await d1
      .prepare(
        `CREATE TRIGGER abort_store BEFORE UPDATE ON publication_reviews
           WHEN NEW.state = 'reported' BEGIN SELECT RAISE(ABORT, 'simulated fault'); END`,
      )
      .run();
    await expect(
      storePublicationReviewResult(env(d1), id, DATASET, nonce, {
        kind: "reported",
        report: failing,
      }),
    ).rejects.toThrow();
    expect((await reviews(d1))[0]).toMatchObject({ state: "dispatched", report: null, nonce });
    expect(await request(d1)).toMatchObject({ status: "requested", block_reason: null });
  });

  test("the watchdog ages a row, keeps its nonce, and a late report lands and re-arms the mail", async () => {
    const d1 = await seededD1();
    const started = await startPublicationReview(env(d1), { requestId: 1, datasetId: DATASET });
    const id = started.reviewId as number;
    const nonce = await nonceOf(d1, id);
    expect(await claimPublicationReview(env(d1), id, DATASET, nonce)).toBe("claimed");
    await d1
      .prepare(
        "UPDATE publication_reviews SET created_at = datetime('now', '-45 minutes') WHERE id = ?",
      )
      .bind(id)
      .run();
    const swept = await sweepPublicationReviews(env(d1));
    expect(swept).toMatchObject({ timedOut: 1, errors: 0, skipped: false });
    expect((await reviews(d1))[0]).toMatchObject({ state: "unreported", nonce });

    // The screen's mail went long ago: a late report re-arms it, so the next send is not lost.
    expect((await request(d1)).identifier_screen_emailed_at).not.toBeNull();
    await withFakeResend(async (calls) => {
      const late = await storePublicationReviewResult(env(d1), id, DATASET, nonce, {
        kind: "reported",
        report: parsePublicationReviewReport(goodPublicationReport()),
      });
      expect(late).toEqual({ stored: true, state: "reported" });
      expect(sendsTo(calls, "d1admin@example.org")).toHaveLength(1);
    });
    expect((await reviews(d1))[0]).toMatchObject({ state: "reported", verdict: "pass" });
  });

  test("a report past the deadline re-arms the mail on a row no watchdog has marked, and one inside it does not", async () => {
    const d1 = await seededD1();
    const started = await startPublicationReview(env(d1), { requestId: 1, datasetId: DATASET });
    const id = started.reviewId as number;
    const nonce = await nonceOf(d1, id);
    // A report comes only from a run that took its claim.
    expect(await claimPublicationReview(env(d1), id, DATASET, nonce)).toBe("claimed");
    const stamp = (await request(d1)).identifier_screen_emailed_at;
    expect(stamp).not.toBeNull();

    // Inside the deadline: nothing is re-armed and the sent mail stands.
    await withFakeResend(async (calls) => {
      const spare = await seededD1();
      const spareStart = await startPublicationReview(env(spare), {
        requestId: 1,
        datasetId: DATASET,
      });
      const spareId = spareStart.reviewId as number;
      const spareNonce = await nonceOf(spare, spareId);
      expect(await claimPublicationReview(env(spare), spareId, DATASET, spareNonce)).toBe(
        "claimed",
      );
      await storePublicationReviewResult(env(spare), spareId, DATASET, spareNonce, {
        kind: "reported",
        report: parsePublicationReviewReport(goodPublicationReport()),
      });
      expect(sendsTo(calls, "d1admin@example.org")).toHaveLength(0);
      expect((await request(spare)).identifier_screen_emailed_at).not.toBeNull();
    });

    // Past the deadline and still `dispatched`: the mail went at the deadline and said the review
    // did not report, so the report re-arms it.
    await d1
      .prepare(
        "UPDATE publication_reviews SET created_at = datetime('now', '-45 minutes') WHERE id = ?",
      )
      .bind(id)
      .run();
    expect((await reviews(d1))[0]).toMatchObject({ state: "dispatched" });
    await withFakeResend(async (calls) => {
      const late = await storePublicationReviewResult(env(d1), id, DATASET, nonce, {
        kind: "reported",
        report: parsePublicationReviewReport(goodPublicationReport()),
      });
      expect(late).toEqual({ stored: true, state: "reported" });
      expect(sendsTo(calls, "d1admin@example.org")).toHaveLength(1);
    });
  });

  test("a restart of an errored row takes a new nonce and a second call on D1", async () => {
    dispatches = [];
    const d1 = await seededD1();
    const started = await startPublicationReview(env(d1), { requestId: 1, datasetId: DATASET });
    const id = started.reviewId as number;
    const first = await nonceOf(d1, id);
    const nonce = first;
    // The run took its claim, so the error it reports came after a model was reached.
    expect(await claimPublicationReview(env(d1), id, DATASET, nonce)).toBe("claimed");
    await storePublicationReviewResult(env(d1), id, DATASET, nonce, {
      kind: "error",
      error: "model_unavailable",
    });
    const out = await startPublicationReview(env(d1), {
      requestId: 1,
      datasetId: DATASET,
      adminUserId: 2,
    });
    expect(out).toEqual({ started: true, reason: "redispatched", reviewId: id });
    expect((await reviews(d1))[0]).toMatchObject({ state: "dispatched", attempts: 2 });
    expect(await nonceOf(d1, id)).not.toBe(first);
  });
});
