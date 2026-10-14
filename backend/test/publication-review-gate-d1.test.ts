/**
 * The approval gate's statements on Miniflare D1, the implementation `wrangler --local` runs
 * (ADR 0102).
 *
 * Every other gate test runs on bun:sqlite, which is more lenient than D1 (`.memory/
 * bun-test-lenient-vs-workerd.md`). The statement that carries the gate's guarantee is the one that
 * records an override: it binds `decided_at` with `IS ?`, so that a bound NULL matches the NULL of
 * a review that is still running and a bound timestamp matches a decided one. Run here through
 * the real service functions with only the database swapped: the review is started and decided by
 * the real start, claim and store, then the real gate reads and records on it. GitHub is a
 * `Bun.serve()` stand-in that records the dispatch; nothing leaves the machine.
 *
 * The depositor is inserted before the request: real D1 enforces the foreign key from
 * `publication_requests.requested_by` to `users`, which bun:sqlite does not.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Miniflare } from "miniflare";
import { parseScreenReport } from "../../shared/identifier-screen-report";
import {
  parsePublicationReviewReport,
  reviewGateRefusalText,
} from "../../shared/publication-review";
import {
  claimPublicationReview,
  startPublicationReview,
  storePublicationReviewResult,
} from "../src/services/publication-review";
import {
  RECORD_OVERRIDE_SQL,
  evaluateApprovalReviewGate,
  recordApprovalOverride,
} from "../src/services/publication-review-gate";
import type { Bindings } from "../src/types/bindings";
import { SCREENED_HEAD } from "./helpers/identifier-screen";
import { applyMigrations, migrationFiles } from "./helpers/miniflare-d1";
import { failingReport, screenReportBodyFor } from "./helpers/publication-review";

const DATASET = "nm000491";
const DEPOSITOR = 1;
const ADMIN = 2;
const OTHER_ADMIN = 3;

let mf: Miniflare;
let server: Server;
let counter = 0;
/** How many databases the tests below need: one each, counted as they are declared. */
let databasesNeeded = 0;
/**
 * Databases beyond one per test: a test retried under `bun test --retry` runs its body again and
 * asks for another database, which would otherwise not exist.
 */
const SPARE_DATABASES = 4;

async function seededD1(): Promise<D1Database> {
  counter += 1;
  const d1 = (await mf.getD1Database(`DB${counter}`)) as unknown as D1Database;
  await applyMigrations(d1, migrationFiles());
  await d1
    .prepare(
      `INSERT INTO users (id, username, email, password_hash, status, role, email_verified)
       VALUES (1, 'gated1depositor', 'gated1depositor@example.org', 'x', 'approved', 'member', 1),
              (2, 'gated1admin', 'gated1admin@example.org', 'x', 'approved', 'admin', 1),
              (3, 'gated1admin2', 'gated1admin2@example.org', 'x', 'approved', 'admin', 1)`,
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
       VALUES (1, ?, ?, 'requested', 0, 'clean', ?, datetime('now'), datetime('now'))`,
    )
    .bind(DATASET, DEPOSITOR, JSON.stringify(report))
    .run();
  return d1;
}

/**
 * A test on a database of its own. Every test is declared before `beforeAll` provisions Miniflare,
 * so the number of databases is the number of these declarations, not a count kept by hand.
 */
function d1Test(name: string, run: (d1: D1Database) => Promise<void>): void {
  databasesNeeded += 1;
  test(name, async () => run(await seededD1()));
}

function env(d1: D1Database): Bindings {
  return {
    DB: d1,
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "ghp_gate_d1_test",
    PRESCREEN_CALLBACK_SECRET: "gate-d1-callback-secret",
    PUBLICATION_REVIEW_ENABLED: "1",
    API_BASE_URL: "https://api.test.nemar.org",
  } as Bindings;
}

type Row = Record<string, unknown>;

async function review(d1: D1Database, id: number): Promise<Row> {
  return (await d1
    .prepare("SELECT * FROM publication_reviews WHERE id = ?")
    .bind(id)
    .first<Row>()) as Row;
}

async function nonceOf(d1: D1Database, id: number): Promise<string> {
  const row = await d1
    .prepare("SELECT nonce FROM publication_reviews WHERE id = ?")
    .bind(id)
    .first<{ nonce: string }>();
  return row?.nonce as string;
}

/** The gate's evaluation for an administrator, with an override naming `reasons` when given. */
function evaluate(
  d1: D1Database,
  approverId: number,
  override?: { id: number; reasons: string[] },
) {
  return evaluateApprovalReviewGate(env(d1), {
    requestId: 1,
    datasetId: DATASET,
    approverId,
    override: override ? { review_id: override.id, reasons: override.reasons as never } : undefined,
  });
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/repos/nemarDatasets/.github/dispatches") {
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
      Array.from({ length: databasesNeeded + SPARE_DATABASES }, (_, i) => [
        `DB${i + 1}`,
        `DB${i + 1}`,
      ]),
    ),
  });
});

afterAll(async () => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
  await mf?.dispose();
});

describe("the override's statement on D1", () => {
  d1Test(
    "22. it matches a review that is still running (NULL decided_at through IS ?) and records once",
    async (d1) => {
      const started = await startPublicationReview(env(d1), { requestId: 1, datasetId: DATASET });
      const id = started.reviewId as number;
      const before = await review(d1, id);
      expect(before).toMatchObject({ state: "dispatched", decided_at: null, override_by: null });

      const gate = await evaluate(d1, ADMIN, { id, reasons: ["review_running"] });
      if (!gate.ok || gate.state !== "enforced") throw new Error("the gate refused");
      expect(gate.record?.row?.decidedAt).toBeNull();
      expect(gate.record?.reasons).toEqual(["review_running"]);

      const recorded = await recordApprovalOverride(env(d1), {
        requestId: 1,
        datasetId: DATASET,
        approverId: ADMIN,
        via: "approve",
        outcome: gate.outcome,
        headSha: gate.headSha,
        record: gate.record as NonNullable<typeof gate.record>,
      });
      expect(recorded).toEqual({ ok: true });
      expect(await review(d1, id)).toMatchObject({
        override_by: ADMIN,
        override_reasons: JSON.stringify(["review_running"]),
      });
      const audit = await d1
        .prepare(
          "SELECT user_id, details FROM audit_log WHERE action = 'publication_review_overridden'",
        )
        .all<{ user_id: number; details: string }>();
      expect(audit.results).toHaveLength(1);
      expect(JSON.parse(audit.results[0].details)).toMatchObject({
        request_id: 1,
        review_id: id,
        reasons: ["review_running"],
        via: "approve",
      });

      // The recorded override is its approver's, read back through the same read.
      const again = await evaluate(d1, ADMIN);
      expect(again).toMatchObject({ ok: true, state: "enforced", record: null });
      const other = await evaluate(d1, OTHER_ADMIN);
      expect(other.ok).toBe(false);
      if (!other.ok) expect(other.body.refusal).toBe("needs_override");
    },
  );

  d1Test(
    "22. it does not match once the state moves: the override is refused and nothing is recorded",
    async (d1) => {
      const started = await startPublicationReview(env(d1), { requestId: 1, datasetId: DATASET });
      const id = started.reviewId as number;
      const nonce = await nonceOf(d1, id);
      expect(await claimPublicationReview(env(d1), id, DATASET, nonce)).toBe("claimed");

      const gate = await evaluate(d1, ADMIN, { id, reasons: ["review_running"] });
      if (!gate.ok || gate.state !== "enforced") throw new Error("the gate refused");

      // The job's report lands between the gate's read and the record.
      const stored = await storePublicationReviewResult(env(d1), id, DATASET, nonce, {
        kind: "reported",
        report: parsePublicationReviewReport(failingReport()),
      });
      expect(stored).toEqual({ stored: true, state: "reported" });

      const recorded = await recordApprovalOverride(env(d1), {
        requestId: 1,
        datasetId: DATASET,
        approverId: ADMIN,
        via: "approve",
        outcome: gate.outcome,
        headSha: gate.headSha,
        record: gate.record as NonNullable<typeof gate.record>,
      });
      expect(recorded.ok).toBe(false);
      if (!recorded.ok) {
        expect(recorded.body.refusal).toBe("review_changed");
        expect(recorded.body.message).toBe(reviewGateRefusalText("review_changed", DATASET));
        // Read again: what stands now is the failing report, which the override never saw.
        expect(recorded.body.reasons.map((r) => r.code)).toEqual(["question_failed"]);
      }
      expect(await review(d1, id)).toMatchObject({
        state: "reported",
        override_by: null,
        override_reasons: null,
      });
      const audit = await d1
        .prepare(
          "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'publication_review_overridden'",
        )
        .first<{ n: number }>();
      expect(audit?.n).toBe(0);
    },
  );

  d1Test(
    "22. it matches a decided review through its timestamps, and a restart takes it back",
    async (d1) => {
      const started = await startPublicationReview(env(d1), { requestId: 1, datasetId: DATASET });
      const id = started.reviewId as number;
      const nonce = await nonceOf(d1, id);
      expect(await claimPublicationReview(env(d1), id, DATASET, nonce)).toBe("claimed");
      await storePublicationReviewResult(env(d1), id, DATASET, nonce, {
        kind: "error",
        error: "model_unavailable",
      });
      const decided = await review(d1, id);
      expect(decided).toMatchObject({ state: "errored", detail: "model_unavailable" });
      expect(decided.decided_at).not.toBeNull();

      const gate = await evaluate(d1, ADMIN, { id, reasons: ["review_could_not_run"] });
      if (!gate.ok || gate.state !== "enforced") throw new Error("the gate refused");
      const recorded = await recordApprovalOverride(env(d1), {
        requestId: 1,
        datasetId: DATASET,
        approverId: ADMIN,
        via: "approve",
        outcome: gate.outcome,
        headSha: gate.headSha,
        record: gate.record as NonNullable<typeof gate.record>,
      });
      expect(recorded).toEqual({ ok: true });
      expect(await review(d1, id)).toMatchObject({ override_by: ADMIN });

      // A new attempt is not the one the override was given for.
      const restarted = await startPublicationReview(env(d1), {
        requestId: 1,
        datasetId: DATASET,
        adminUserId: ADMIN,
      });
      expect(restarted).toMatchObject({ started: true, reason: "redispatched", reviewId: id });
      expect(await review(d1, id)).toMatchObject({
        state: "dispatched",
        override_by: null,
        override_at: null,
        override_reasons: null,
      });
    },
  );

  d1Test("22. each pin of the statement refuses on its own, on D1", async (d1) => {
    const started = await startPublicationReview(env(d1), { requestId: 1, datasetId: DATASET });
    const id = started.reviewId as number;
    const row = await review(d1, id);
    const run = async (over: Partial<Record<string, unknown>>) => {
      const b = {
        request_id: row.request_id,
        head_sha: row.head_sha,
        anonymous: row.anonymous,
        state: row.state,
        created_at: row.created_at,
        decided_at: row.decided_at,
        ...over,
      };
      const res = await d1
        .prepare(RECORD_OVERRIDE_SQL)
        .bind(
          ADMIN,
          JSON.stringify(["review_running"]),
          id,
          b.request_id,
          b.head_sha,
          b.anonymous,
          b.state,
          b.created_at,
          b.decided_at,
        )
        .run();
      return res.meta.changes;
    };
    // Each pin of the row, moved alone, matches nothing ...
    expect(await run({ state: "reported" })).toBe(0);
    expect(await run({ created_at: "2000-01-01 00:00:00" })).toBe(0);
    expect(await run({ decided_at: "2000-01-01 00:00:00" })).toBe(0);
    expect(await run({ head_sha: "e".repeat(40) })).toBe(0);
    expect(await run({ request_id: 99 })).toBe(0);
    expect(await run({ anonymous: 1 })).toBe(0);
    expect((await review(d1, id)).override_by).toBeNull();
    // ... and the row as read matches, once.
    expect(await run({})).toBe(1);
    expect((await review(d1, id)).override_by).toBe(ADMIN);
  });
});
