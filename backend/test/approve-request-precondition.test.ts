/**
 * `POST /admin/publish/:id/approve` takes an optional `request_id` (#1579, ADR 0103 decisions 4
 * and 7).
 *
 * An approval is a run, and a run is for ONE request: the one an administrator read, or the one a
 * click was shown. Between that read and the run the request can be denied and filed again, and
 * the run, which finds the newest active request by itself, would then approve a request nobody
 * looked at. The body can name the request it is for; a name that is not the newest active
 * request's id is a 409 `request_mismatch`, answered right after the 404 for no request and before
 * the blocked refusal, every gate, the approver's resolution and every write. What is pinned here
 * is that ORDER, by what a mismatch leaves behind: the request row as it was (no `approving` mark,
 * no new `last_error`, no approver), no override and no screen acknowledgment recorded for the
 * request that replaced the one the run was for, no audit row and no call to GitHub.
 *
 * The runs use the golden resume path of publication-approve-golden.test.ts: every step done but
 * the two logged no-ops, so a run the checks let through reaches `published` without touching an
 * external service, and a refused one provably never marked the request `approving`.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the real auth
 * middleware and the real route, review rows through the production parser, and a `Bun.serve()`
 * stand-in for api.github.com (the identifier screen gate's one read of `main`).
 *
 * CI TIER: unit-pure. Hermetic: an in-process Worker over a local database and a local stand-in.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import {
  APPROVAL_REFUSAL_ERROR_CODES,
  REQUEST_MISMATCH_MESSAGE,
} from "../../shared/contract/publication";
import { adminRoutes } from "../src/routes/admin";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { SCREENED_HEAD, mainRefAnswer } from "./helpers/identifier-screen";
import {
  DONE,
  type SeedScreenedRequest,
  failingReport,
  seedPublicationReview,
  seedScreenedRequest,
  seedUser,
} from "./helpers/publication-review";

const ADMIN_KEY = "precondition-admin-key-0123456789abcdef0123456789abcdef";
const DATASET = "nm000481";

let server: Server;
let calls: { method: string; path: string }[] = [];

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let adminId: number;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      calls.push({ method: req.method, path: new URL(req.url).pathname });
      return mainRefAnswer(req, SCREENED_HEAD) ?? new Response("not found", { status: 404 });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

afterEach(() => {
  calls = [];
});

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  adminId = await seedUser(db, "preconditionadmin", "admin", ADMIN_KEY);
});

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "ghp_precondition_test",
    PRESCREEN_CALLBACK_SECRET: "precondition-secret",
    PUBLICATION_REVIEW_ENABLED: "1",
    API_BASE_URL: "https://api.test.nemar.org",
  } as Bindings;
}

/**
 * A request with its steps done, in the state `over` says, and (unless `review` is false) a review
 * that passed, so the run the review gate lets through reaches `published` and a refusal in a test
 * is the one the test is about.
 */
function seed(
  over: Partial<SeedScreenedRequest> & { steps?: readonly string[]; review?: boolean } = {},
): number {
  const { requestId } = seedScreenedRequest(db, { datasetId: DATASET, ...over });
  db.run("UPDATE publication_requests SET steps_completed = ? WHERE id = ?", [
    JSON.stringify(over.steps ?? DONE),
    requestId,
  ]);
  if (over.review !== false) {
    seedPublicationReview(db, { requestId, datasetId: DATASET, state: "reported" });
  }
  return requestId;
}

function approve(body: Record<string, unknown>, dataset = DATASET): Promise<Response> {
  return app.request(
    `/admin/publish/${dataset}/approve`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env(),
  );
}

type Row = Record<string, unknown>;

function requestRow(id: number): Row {
  return db.query("SELECT * FROM publication_requests WHERE id = ?").get(id) as Row;
}

function auditActions(): string[] {
  return (db.query("SELECT action FROM audit_log ORDER BY id").all() as { action: string }[]).map(
    (r) => r.action,
  );
}

function reviewRow(id: number): Row {
  return db.query("SELECT * FROM publication_reviews WHERE id = ?").get(id) as Row;
}

async function errorOf(res: Response): Promise<{ error: string; message: string }> {
  return (await res.json()) as { error: string; message: string };
}

describe("a request_id that is the newest active request's", () => {
  test("is accepted: the run goes through and publishes", async () => {
    const id = seed();
    const res = await approve({ resume: true, request_id: id });
    expect(res.status).toBe(200);
    expect(requestRow(id).status).toBe("published");
    expect(requestRow(id).approved_by).toBe(adminId);
  });

  test("left out, the run is what it always was", async () => {
    const id = seed();
    const res = await approve({ resume: true });
    expect(res.status).toBe(200);
    expect(requestRow(id).status).toBe("published");
  });
});

describe("a request_id that is not a request id", () => {
  test.each([0, -3, 1.5, "7", null, true])(
    "%p is a 400, and the request is not touched",
    async (value) => {
      const id = seed();
      const before = requestRow(id);
      const res = await approve({ resume: true, request_id: value });
      expect(res.status).toBe(400);
      expect(requestRow(id)).toEqual(before);
      expect(auditActions()).toEqual([]);
      expect(calls).toEqual([]);
    },
  );
});

describe("a request_id that is not the request in force is 409 request_mismatch, with nothing recorded", () => {
  test("the answer is the contract's word and sentence", async () => {
    const id = seed();
    const res = await approve({ resume: true, request_id: id + 1 });
    expect(res.status).toBe(409);
    const refused = await errorOf(res);
    expect(refused).toEqual({
      error: "request_mismatch",
      message: REQUEST_MISMATCH_MESSAGE,
    });
    expect(APPROVAL_REFUSAL_ERROR_CODES).toContain(refused.error);
  });

  test("an `approving` request with an error of its own keeps it: no new mark, no cleared last_error", async () => {
    const id = seed({ requestStatus: "approving" });
    db.run(
      "UPDATE publication_requests SET last_error = 'EZID 503', updated_at = datetime('now', '-1 hours') WHERE id = ?",
      [id],
    );
    const before = requestRow(id);
    const res = await approve({ resume: true, request_id: id + 1 });
    expect(res.status).toBe(409);
    const after = requestRow(id);
    // The mark would have set `approved_by`, cleared `last_error` and bumped `updated_at`.
    expect(after).toEqual(before);
    expect(after.status).toBe("approving");
    expect(after.last_error).toBe("EZID 503");
    expect(after.approved_by).toBeNull();
    expect(auditActions()).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("an override sent with it is not recorded (the control records it for the right request)", async () => {
    const id = seed({ review: false });
    const reviewId = seedPublicationReview(db, {
      requestId: id,
      datasetId: DATASET,
      state: "reported",
      report: failingReport(),
    });
    const override = { review_id: reviewId, reasons: ["question_failed"] };

    const refused = await approve({
      resume: true,
      request_id: id + 1,
      override_publication_review: override,
    });
    expect(refused.status).toBe(409);
    expect((await errorOf(refused)).error).toBe("request_mismatch");
    expect(reviewRow(reviewId).override_by).toBeNull();
    expect(reviewRow(reviewId).override_reasons).toBeNull();
    expect(auditActions()).toEqual([]);
    expect(requestRow(id).status).toBe("requested");

    // The same body for the request in force is recorded and runs: the refusal was the id's.
    const ok = await approve({
      resume: true,
      request_id: id,
      override_publication_review: override,
    });
    expect(ok.status).toBe(200);
    expect(reviewRow(reviewId).override_by).toBe(adminId);
    expect(auditActions()).toContain("publication_review_overridden");
  });

  test("a screen acknowledgment sent with it is not recorded (the control records it)", async () => {
    const id = seed({ status: "review" });
    const reason = "Looked at every flagged file; the free text is a device serial.";

    const refused = await approve({
      resume: true,
      request_id: id + 1,
      acknowledge_identifier_screen: reason,
    });
    expect(refused.status).toBe(409);
    expect((await errorOf(refused)).error).toBe("request_mismatch");
    const row = requestRow(id);
    expect(row.identifier_screen_ack_at).toBeNull();
    expect(row.identifier_screen_ack_by).toBeNull();
    expect(row.identifier_screen_ack_reason).toBeNull();
    expect(row.status).toBe("requested");
    expect(auditActions()).toEqual([]);
    expect(calls).toEqual([]);

    const ok = await approve({
      resume: true,
      request_id: id,
      acknowledge_identifier_screen: reason,
    });
    expect(ok.status).toBe(200);
    expect(requestRow(id).identifier_screen_ack_by).toBe(adminId);
    expect(auditActions()).toContain("identifier_screen_acknowledged");
  });

  test("it comes before the gates: a review that would refuse answers request_mismatch", async () => {
    const id = seed({ review: false });
    seedPublicationReview(db, {
      requestId: id,
      datasetId: DATASET,
      state: "reported",
      report: failingReport(),
    });
    const gated = await approve({ resume: true, request_id: id });
    expect(gated.status).toBe(409);
    expect((await errorOf(gated)).error).toBe("publication_review_not_clear");

    const res = await approve({ resume: true, request_id: id + 1 });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).error).toBe("request_mismatch");
  });

  test("and before the blocked refusal: a blocked request answers request_mismatch for another id", async () => {
    const id = seed({
      requestStatus: "blocked",
      blockReason: "min_requirements_failed",
      steps: [],
    });
    const blocked = await approve({ resume: false, request_id: id });
    expect(blocked.status).toBe(409);
    expect((await errorOf(blocked)).error).toBe("request_blocked");

    const res = await approve({ resume: false, request_id: id + 1 });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).error).toBe("request_mismatch");
    expect(requestRow(id).status).toBe("blocked");
  });

  test("no active request at all is the 404, whatever id the body names", async () => {
    const res = await approve({ resume: true, request_id: 7 });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "No active publication request found" });
  });
});

describe("the case of #1579: a run for a request that was denied and filed again", () => {
  test("a run for the denied request is refused and the new request is untouched; one for the new request runs", async () => {
    // Request 1 was read, and denied; the depositor filed request 2. A run started for 1 would
    // find the newest active request by itself and approve 2, which nobody had read.
    const denied = seed();
    db.run("UPDATE publication_requests SET status = 'denied' WHERE id = ?", [denied]);
    const filed = seed();
    const before = requestRow(filed);

    const stale = await approve({ resume: true, request_id: denied });
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).error).toBe("request_mismatch");
    expect(requestRow(filed)).toEqual(before);
    expect(requestRow(denied).status).toBe("denied");
    expect(auditActions()).toEqual([]);

    const current = await approve({ resume: true, request_id: filed });
    expect(current.status).toBe(200);
    expect(requestRow(filed).status).toBe("published");
    expect(requestRow(denied).status).toBe("denied");
  });

  test("an older request that is still open is not the one in force either", async () => {
    const older = seed();
    db.run(
      "UPDATE publication_requests SET requested_at = datetime('now', '-2 hours') WHERE id = ?",
      [older],
    );
    const newer = seed();
    const res = await approve({ resume: true, request_id: older });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).error).toBe("request_mismatch");
    expect(requestRow(older).status).toBe("requested");
    expect(requestRow(newer).status).toBe("requested");
  });
});
