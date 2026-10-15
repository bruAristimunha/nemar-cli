/**
 * The publication review as a gate on approval (ADR 0102, sections 8 and 9; epic #1726, phase 2).
 *
 * `POST /admin/publish/:id/approve` and `approve-dispatch` run the review gate after the identifier
 * screen's gate and before the request is marked `approving`. These tests drive those two routes,
 * the places an approval starts, and read the result off the database and the wire.
 *
 * Approvals use the golden resume path of publication-approve-golden.test.ts: every step done but
 * the two logged no-ops, so a run the gate lets through reaches `published` without touching an
 * external service, and a refused one provably never marked the request `approving`. The requests
 * are `requested` and the runs pass `resume: true` on purpose: a resume of a request that never
 * started is how the import pipeline retries, and it must not be a way around either gate.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration, the real auth middleware and
 * routes, review rows seeded through the production parser, and a `Bun.serve()` stand-in for
 * api.github.com (the screen gate's read of `main`, the BIDS validation run, and the dispatch the
 * web route sends). Nothing of the gate or the derivation is replaced.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import {
  APPROVAL_REFUSAL_ERROR_CODES,
  DECISION_WITH_DISPATCH_TOKEN_MESSAGE,
  DISPATCH_SUPERSEDED_MESSAGE,
  REQUEST_CHANGED_MESSAGE,
} from "../../shared/contract/publication";
import {
  OVERRIDE_FIELD,
  type PublicationReviewDetail,
  type PublicationReviewGateRefusalBody,
} from "../../shared/contract/publication-review-admin";
import {
  REASONS,
  type ReasonCode,
  parsePublicationReviewReport,
  reviewGateRefusalText,
} from "../../shared/publication-review";
import { adminRoutes } from "../src/routes/admin";
import { approveSchema } from "../src/services/publication-orchestrator";
import {
  startPublicationReview,
  storePublicationReviewResult,
} from "../src/services/publication-review";
import {
  RECORD_OVERRIDE_SQL,
  evaluateApprovalReviewGate,
  requestBlockedRefusal,
  reviewGateStateOf,
} from "../src/services/publication-review-gate";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, interceptingD1, realD1 } from "./helpers/d1";
import { SCREENED_HEAD } from "./helpers/identifier-screen";
import {
  DONE,
  type SeedScreenedRequest,
  evidenceFor,
  failingReport,
  goodPublicationReport,
  seedPublicationReview,
  seedScreenedRequest,
  seedUser,
  setOverride,
  webClaim,
} from "./helpers/publication-review";
import { hookedD1 } from "./helpers/publication-review-harness";

const ADMIN_A_KEY = "review-gate-admin-a-0123456789abcdef0123456789abcdef";
const ADMIN_B_KEY = "review-gate-admin-b-0123456789abcdef0123456789abcdef";
const GATE_SECRET = "review-gate-secret";
const DATASET = "nm000481";
const MIRROR = "nm000482";
const EXEMPLAR = "xx099960";

let server: Server;
let calls: { method: string; path: string; event?: string }[] = [];
/** The `client_payload` of every approval the Worker dispatched: what the executor is handed. */
let dispatchPayloads: Record<string, unknown>[] = [];
let mainHead = SCREENED_HEAD;
let bidsConclusion = "success";
/** Runs inside the stand-in as the request for `main` and the dispatch arrive: for ordering. */
let onRefRead: (() => void) | null = null;
let onDispatch: (() => void) | null = null;

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let adminA: number;
let adminB: number;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const p = new URL(req.url).pathname;
      const sent =
        req.method === "POST"
          ? ((await req.json().catch(() => null)) as {
              event_type?: string;
              client_payload?: Record<string, unknown>;
            } | null)
          : null;
      calls.push({ method: req.method, path: p, event: sent?.event_type });
      if (sent?.event_type === "approve-publication" && sent.client_payload) {
        dispatchPayloads.push(sent.client_payload);
      }
      if (req.method === "GET" && /\/git\/ref\/heads\/main$/.test(p)) {
        onRefRead?.();
        return Response.json({ object: { sha: mainHead } });
      }
      if (req.method === "POST" && p === "/repos/nemarDatasets/.github/dispatches") {
        onDispatch?.();
        return new Response(null, { status: 204 });
      }
      if (/\/actions\/workflows\/bids-validation\.yml\/runs$/.test(p)) {
        return Response.json({
          workflow_runs: [{ status: "completed", conclusion: bidsConclusion, html_url: "x" }],
        });
      }
      if (/\/contents\/\.github\/workflows\/bids-validation\.yml$/.test(p)) {
        return Response.json({ name: "bids-validation.yml" });
      }
      return new Response("not found", { status: 404 });
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
  dispatchPayloads = [];
  mainHead = SCREENED_HEAD;
  bidsConclusion = "success";
  onRefRead = null;
  onDispatch = null;
});

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  adminA = await seedUser(db, "gateadmina", "admin", ADMIN_A_KEY);
  adminB = await seedUser(db, "gateadminb", "admin", ADMIN_B_KEY);
});

/** The Worker's bindings: the review is lit unless a test says otherwise. */
function env(over: Partial<Bindings> = {}, lit = true): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "ghp_review_gate_test",
    PRESCREEN_CALLBACK_SECRET: GATE_SECRET,
    PUBLICATION_REVIEW_ENABLED: lit ? "1" : undefined,
    API_BASE_URL: "https://api.test.nemar.org",
    ...over,
  } as Bindings;
}

interface Seed extends Omit<SeedScreenedRequest, "datasetId"> {
  datasetId?: string;
  /** The approval's completed steps. Default: every step but the two no-ops. */
  steps?: readonly string[];
}

/** A request with its steps done, in the state `over` says. */
function seed(over: Seed = {}): { requestId: number; datasetId: string } {
  const datasetId = over.datasetId ?? DATASET;
  const { requestId } = seedScreenedRequest(db, { ...over, datasetId });
  db.run("UPDATE publication_requests SET steps_completed = ? WHERE id = ?", [
    JSON.stringify(over.steps ?? DONE),
    requestId,
  ]);
  return { requestId, datasetId };
}

function approve(
  body: Record<string, unknown> = { resume: true },
  o: { key?: string; dataset?: string; bindings?: Bindings; token?: string } = {},
): Promise<Response> {
  return app.request(
    `/admin/publish/${o.dataset ?? DATASET}/approve`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${o.key ?? ADMIN_A_KEY}`,
        "Content-Type": "application/json",
        // The proof that the call belongs to a web click's claim (#1604); a terminal sends none.
        ...(o.token === undefined ? {} : { "X-Approval-Dispatch-Token": o.token }),
      },
      body: JSON.stringify(body),
    },
    o.bindings ?? env(),
  );
}

type Row = Record<string, unknown>;

function requestRow(id: number): Row {
  return db.query("SELECT * FROM publication_requests WHERE id = ?").get(id) as Row;
}

function reviewRows(): Row[] {
  return db.query("SELECT * FROM publication_reviews ORDER BY id").all() as Row[];
}

function auditRows(action: string): { user_id: number; details: Record<string, unknown> }[] {
  return (
    db.query("SELECT user_id, details FROM audit_log WHERE action = ? ORDER BY id").all(action) as {
      user_id: number;
      details: string;
    }[]
  ).map((r) => ({ user_id: r.user_id, details: JSON.parse(r.details) }));
}

function published(): { user_id: number; details: Record<string, unknown> } {
  const rows = auditRows("dataset_published");
  expect(rows).toHaveLength(1);
  return rows[0];
}

/**
 * A web click's claim on a request, by `clicker`, and the token its dispatch carried: written the
 * way the dispatch route writes it and signed by the production signer (`webClaim`). `dispatchedAt`
 * is a SQLite modifier; the default is a claim made a minute ago, inside the 15 minute lease.
 */
const claim = (requestId: number, clicker: number, dispatchedAt = "-1 minutes"): Promise<string> =>
  webClaim(db, { requestId, clickerId: clicker, dispatchedAt, secret: GATE_SECRET });

/** The two claim columns of a request, as they stand. */
function claimOf(id: number): { by: unknown; at: unknown } {
  const r = requestRow(id);
  return { by: r.approval_requested_by, at: r.approval_dispatched_at };
}

// ============================================================================

describe("with the review off the gate reads nothing", () => {
  test("1. a failing review does not gate; the run publishes and records that the gate was off", async () => {
    const { requestId } = seed();
    seedPublicationReview(db, {
      requestId,
      datasetId: DATASET,
      state: "reported",
      report: failingReport(),
    });
    const res = await approve({ resume: true }, { bindings: env({}, false) });
    expect(res.status).toBe(200);
    expect(requestRow(requestId).status).toBe("published");
    expect(published().details).toMatchObject({ review_gate: "off", skip_ci_check: false });
    expect(auditRows("publication_review_overridden")).toHaveLength(0);
  });

  test("1. with every read of the review table failing the run still publishes: the gate read nothing", async () => {
    const { requestId } = seed();
    seedPublicationReview(db, {
      requestId,
      datasetId: DATASET,
      state: "reported",
      report: failingReport(),
    });
    const reads: string[] = [];
    const broken = hookedD1(realD1(db), {
      statement: (sql) => {
        // The gate's two reads: the request with its dataset (the detail's shape, which carries
        // the dataset's size), and the review's own table.
        if (/ds_total_files/.test(sql)) reads.push("request");
        if (/publication_reviews/.test(sql)) {
          reads.push("review");
          throw new Error("the review table is unreadable");
        }
      },
    });
    const res = await approve({ resume: true }, { bindings: env({ DB: broken }, false) });
    expect(res.status).toBe(200);
    expect(requestRow(requestId).status).toBe("published");
    expect(reads).toEqual([]);
  });
});

describe("a blocked request that has not started publishing is refused by the mechanical rules, whatever the flag says", () => {
  for (const lit of [true, false] as const) {
    for (const [what, over] of [
      ["a native dataset", {}],
      ["a mirror", { source: "openneuro", datasetId: MIRROR }],
    ] as const) {
      for (const [steps, body] of [
        [[], { resume: false }],
        // Only the validation-only steps: nothing has changed yet, so this is not a run that started.
        [["ci_check", "enrichment_check"], { resume: true }],
      ] as const) {
        test(`2. ${what}, flag ${lit ? "on" : "off"}, ${steps.length === 0 ? "a fresh run" : "only the validation steps done, resumed"}: 409 request_blocked, nothing started`, async () => {
          const { requestId, datasetId } = seed({
            ...over,
            requestStatus: "blocked",
            blockReason: "min_requirements_failed",
            steps,
          });
          const res = await approve(body, { dataset: datasetId, bindings: env({}, lit) });
          expect(res.status).toBe(409);
          const out = (await res.json()) as Record<string, unknown>;
          expect(out).toMatchObject({
            error: "request_blocked",
            block_reason: "min_requirements_failed",
          });
          expect(String(out.message)).toStartWith("The request is blocked.");
          const row = requestRow(requestId);
          expect(row.status).toBe("blocked");
          expect(row.approved_by).toBeNull();
          expect(JSON.parse(String(row.steps_completed))).toEqual([...steps]);
          expect(row.current_step).toBeNull();
          expect(auditRows("dataset_published")).toHaveLength(0);
          // The refusal comes before the screen gate's read of main.
          expect(calls.filter((c) => /\/git\/ref\//.test(c.path))).toHaveLength(0);
        });
      }
    }
  }
});

describe("a blocked request that HAS started publishing is not refused: the owner-name walk-back strands no run", () => {
  // The walk-back to `blocked` (the owner's name is missing) runs on every `/approve` call, the
  // batches of `s3_lock` included, so a depositor who clears their name mid-lock blocks a run that
  // is half published. The owner fixes the name and the run is resumed; a refusal that no re-run
  // could cure would leave the dataset half published until a re-request.
  for (const lit of [true, false] as const) {
    for (const [what, over] of [
      ["a native dataset", {}],
      ["a mirror", { source: "openneuro", datasetId: MIRROR }],
    ] as const) {
      test(`2. ${what}, flag ${lit ? "on" : "off"}: a resume carries on past the blocked status, and no gate is asked`, async () => {
        const { requestId, datasetId } = seedFailing({
          ...over,
          requestStatus: "blocked",
          blockReason: "owner_name_missing",
          steps: DONE,
        });
        // The screened commit is no longer `main`, as it is once the run's own steps committed.
        mainHead = OTHER_HEAD;
        const res = await approve({ resume: true }, { dataset: datasetId, bindings: env({}, lit) });
        expect(res.status).toBe(200);
        expect(requestRow(requestId).status).toBe("published");
        expect(requestRow(requestId).approved_by).toBe(adminA);
        expect(calls.filter((c) => /\/git\/ref\//.test(c.path))).toHaveLength(0);
        expect(overrideRows()).toHaveLength(0);
      });
    }
  }

  test("2. the walk-back as it happens: blocked again while the name is missing, resumed once it is back", async () => {
    const { requestId } = seed({ requestStatus: "approving", steps: DONE });
    const clearName = (given: string | null) =>
      db.run("UPDATE users SET given_name = ? WHERE username = ?", [given, `depositor_${DATASET}`]);
    clearName(null);
    // The call that finds the name gone walks the request back to blocked.
    const first = await approve({ resume: true });
    expect(first.status).toBe(422);
    expect(requestRow(requestId).status).toBe("blocked");
    expect(requestRow(requestId).block_reason).toBe("owner_name_missing");
    // Calling again is the same answer, not a 409 that no resume could cure.
    const second = await approve({ resume: true });
    expect(second.status).toBe(422);
    expect(((await second.json()) as { block_reason?: string }).block_reason).toBe(
      "owner_name_missing",
    );
    expect(requestRow(requestId).status).toBe("blocked");
    expect(JSON.parse(String(requestRow(requestId).steps_completed))).toEqual([...DONE]);
    // The name is back: the same resume finishes the run.
    clearName("Ada");
    const third = await approve({ resume: true });
    expect(third.status).toBe(200);
    expect(requestRow(requestId).status).toBe("published");
  });

  test("2. without --resume the run would start over, so the refusal stands for it", async () => {
    // `resume: false` discards the step list, which for a run that started is not a continuation.
    // It reaches the gates like a fresh run, and the blocked request is refused there.
    const { requestId } = seed({
      requestStatus: "blocked",
      blockReason: "owner_name_missing",
      steps: DONE,
    });
    const res = await approve({ resume: false });
    const body = await refusalOf(res);
    expect(body.refusal).toBe("hard_reason");
    expect(body.reasons.map((r) => r.code)).toContain("request_blocked");
    expect(requestRow(requestId).status).toBe("blocked");
    expect(JSON.parse(String(requestRow(requestId).steps_completed))).toEqual([...DONE]);
    expect(auditRows("dataset_published")).toHaveLength(0);
  });
});

describe("a blocked request is a run that started only when the owner-name walk-back blocked it", () => {
  // The exemption above is for ONE way of being blocked half way. A request that was blocked
  // for any other reason is blocked, however stale its step list: nothing clears `steps_completed`
  // when the depositor requests again, so a run walked back for the owner's name and then blocked
  // again by the screen or by a failed minimum still carries the steps of its first life. Trusting
  // them let a resume skip every gate and publish over the content that blocked it.
  for (const [reason, screen] of [
    ["identifier_screen_findings", "direct-identifiers"],
    ["min_requirements_failed", "clean"],
  ] as const) {
    for (const lit of [true, false] as const) {
      test(`2. blocked for ${reason}, every step done, flag ${lit ? "on" : "off"}: a resume is 409 request_blocked, nothing runs`, async () => {
        const { requestId } = seedFailing({
          requestStatus: "blocked",
          blockReason: reason,
          status: screen,
          steps: DONE,
        });
        const res = await approve({ resume: true }, { bindings: env({}, lit) });
        expect(res.status).toBe(409);
        const out = (await res.json()) as Record<string, unknown>;
        expect(out).toMatchObject({ error: "request_blocked", block_reason: reason });
        const row = requestRow(requestId);
        expect(row.status).toBe("blocked");
        expect(row.block_reason).toBe(reason);
        expect(row.approved_by).toBeNull();
        expect(JSON.parse(String(row.steps_completed))).toEqual([...DONE]);
        expect(auditRows("dataset_published")).toHaveLength(0);
        expect(overrideRows()).toHaveLength(0);
      });
    }
  }

  test("2. the control: the owner-name walk-back with the same steps resumes, and the other reasons did not", async () => {
    const { requestId } = seedFailing({
      requestStatus: "blocked",
      blockReason: "owner_name_missing",
      status: "direct-identifiers",
      steps: DONE,
    });
    const res = await approve({ resume: true });
    expect(res.status).toBe(200);
    expect(requestRow(requestId).status).toBe("published");
    expect(overrideRows()).toHaveLength(0);
  });
});

describe("a dataset the review does not apply to, and one it passes", () => {
  test("3. a mirror and an exemplar publish with no override, and the gate says n/a", async () => {
    const mirror = seed({ source: "openneuro", datasetId: MIRROR });
    const res = await approve({ resume: true }, { dataset: MIRROR });
    expect(res.status).toBe(200);
    expect(requestRow(mirror.requestId).status).toBe("published");
    expect(published().details).toMatchObject({ review_gate: "n/a" });

    const exemplar = seed({ isExemplar: 1, datasetId: EXEMPLAR });
    const second = await approve(
      { resume: true, sandbox: true },
      { dataset: EXEMPLAR, bindings: env({ ENVIRONMENT: "staging" }) },
    );
    expect(second.status).toBe(200);
    expect(requestRow(exemplar.requestId).status).toBe("published");
    const rows = auditRows("dataset_published");
    expect(rows).toHaveLength(2);
    expect(rows[1].details).toMatchObject({ review_gate: "n/a" });
    // No review was read or written for either.
    expect(reviewRows()).toHaveLength(0);
    expect(auditRows("publication_review_overridden")).toHaveLength(0);
  });

  test("4. a reported pass publishes with nothing recorded, and the gate says enforced", async () => {
    const { requestId } = seed();
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId: DATASET,
      state: "reported",
    });
    const res = await approve();
    expect(res.status).toBe(200);
    expect(requestRow(requestId).status).toBe("published");
    expect(published().details).toMatchObject({ review_gate: "enforced", skip_ci_check: false });
    expect(reviewRows()).toHaveLength(1);
    expect(reviewRows()[0]).toMatchObject({
      id: reviewId,
      override_by: null,
      override_at: null,
      override_reasons: null,
    });
    expect(auditRows("publication_review_overridden")).toHaveLength(0);
  });
});

describe("--skip-ci-check is recorded", () => {
  test("19. a run that skips the CI check says so in the approval's row and in a row of its own", async () => {
    // Only the CI check and the enrichment check left, so the run reaches the skip with no network.
    const { requestId } = seed({
      steps: DONE.filter((s) => s !== "ci_check"),
    });
    seedPublicationReview(db, { requestId, datasetId: DATASET, state: "reported" });
    const res = await approve({ resume: true, skip_ci_check: true });
    expect(res.status).toBe(200);
    expect(requestRow(requestId).status).toBe("published");
    expect(published().details).toMatchObject({ skip_ci_check: true });
    const skipped = auditRows("publication_ci_check_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].user_id).toBe(adminA);
    expect(skipped[0].details).toEqual({ request_id: requestId });
    // The BIDS conclusion was never asked for.
    expect(calls.filter((c) => /bids-validation/.test(c.path))).toHaveLength(0);
  });
});

describe("a skipped CI check is a decision, and a decision is recorded under the credential that sent it", () => {
  test("19. a skip sent with a web run's token is refused as decision_with_dispatch_token, and nothing is recorded", async () => {
    // The click made its decision; the executor carries it out and may not add one. A skip sent
    // under the token would be recorded under the clicker, who never asked for it.
    const { requestId } = seed({
      requestStatus: "approving",
      steps: DONE.filter((s) => s !== "ci_check"),
    });
    seedPublicationReview(db, { requestId, datasetId: DATASET, state: "reported" });
    const token = await claim(requestId, adminA);
    const claimBefore = claimOf(requestId);
    const before = requestRow(requestId);

    const res = await approve({ resume: true, skip_ci_check: true }, { key: ADMIN_B_KEY, token });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toEqual({
      error: "decision_with_dispatch_token",
      message: DECISION_WITH_DISPATCH_TOKEN_MESSAGE,
    });
    expect(APPROVAL_REFUSAL_ERROR_CODES).toContain(body.error);
    expect(auditRows("publication_ci_check_skipped")).toHaveLength(0);
    expect(auditRows("dataset_published")).toHaveLength(0);
    expect(requestRow(requestId)).toEqual(before);
    expect(claimOf(requestId)).toEqual(claimBefore);
  });

  test("19. the refusal is for the skip alone: an explicit false is no decision, and the run goes on under the click", async () => {
    // The CLI sends `skip_ci_check: false` on every call, so a refusal on the field's presence
    // would refuse every web run.
    const { requestId } = seed({
      requestStatus: "approving",
      steps: DONE.filter((s) => s !== "ci_check"),
    });
    seedPublicationReview(db, { requestId, datasetId: DATASET, state: "reported" });
    const token = await claim(requestId, adminA);

    const res = await approve({ resume: true, skip_ci_check: false }, { key: ADMIN_B_KEY, token });

    expect(res.status).toBe(200);
    expect(requestRow(requestId).approved_by).toBe(adminA);
    expect(auditRows("publication_ci_check_skipped")).toHaveLength(0);
    expect(published().details).toMatchObject({ approved_by: "gateadmina", skip_ci_check: false });
  });

  test("19. without the token a skip is its sender's own, claim or no claim: B's skip inside A's live claim is B's, and B takes the claim over", async () => {
    const { requestId } = seed({
      requestStatus: "approving",
      steps: DONE.filter((s) => s !== "ci_check"),
    });
    seedPublicationReview(db, { requestId, datasetId: DATASET, state: "reported" });
    await claim(requestId, adminA);

    const res = await approve({ resume: true, skip_ci_check: true }, { key: ADMIN_B_KEY });

    expect(res.status).toBe(200);
    const skipped = auditRows("publication_ci_check_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].user_id).toBe(adminB);
    // B is the approver and the caller: there is no separate executor to name.
    expect(skipped[0].details).toEqual({ request_id: requestId });
    expect(published().user_id).toBe(adminB);
    expect(published().details).toMatchObject({ skip_ci_check: true });
    expect(claimOf(requestId)).toEqual({ by: null, at: null });
  });
});

// ============================================================================
// The gate's decisions
// ============================================================================

const OTHER_HEAD = "d".repeat(40);

/** The 409 body of the review gate. */
async function refusalOf(res: Response): Promise<PublicationReviewGateRefusalBody> {
  expect(res.status).toBe(409);
  const body = (await res.json()) as PublicationReviewGateRefusalBody;
  expect(body.error).toBe("publication_review_not_clear");
  return body;
}

/** A request with a review that reported `report` (the failing one unless told otherwise). */
function seedFailing(
  over: Seed = {},
  report: Record<string, unknown> = failingReport(),
): { requestId: number; datasetId: string; reviewId: number } {
  const { requestId, datasetId } = seed(over);
  const reviewId = seedPublicationReview(db, {
    requestId,
    datasetId,
    state: "reported",
    report,
  });
  return { requestId, datasetId, reviewId };
}

/** The failing report with some of its fields replaced (its question still fails). */
function failingReportWith(over: Record<string, unknown>): Record<string, unknown> {
  return { ...failingReport(), ...over };
}

/** What the administrator is shown: the detail view of the dataset's active request. */
async function detailOf(datasetId = DATASET, key = ADMIN_A_KEY): Promise<PublicationReviewDetail> {
  const res = await app.request(
    `/admin/publish/${datasetId}/review`,
    { headers: { Authorization: `Bearer ${key}` } },
    env(),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as PublicationReviewDetail;
}

function overrideRows() {
  return auditRows("publication_review_overridden");
}

function reviewRow(id: number): Row {
  return db.query("SELECT * FROM publication_reviews WHERE id = ?").get(id) as Row;
}

describe("a review that is not a pass needs the administrator's override", () => {
  test("6. a failing report is refused, in the words the detail shows, with the override-class codes uncovered", async () => {
    const { requestId, reviewId } = seedFailing();
    const res = await approve();
    const body = await refusalOf(res);
    expect(body.refusal).toBe("needs_override");
    expect(body.message).toBe(reviewGateRefusalText("needs_override", DATASET));
    expect(body.outcome).toBe("fail");
    expect(body.review_id).toBe(reviewId);
    expect(body.uncovered).toEqual(["question_failed"]);
    // The same words the administrator was shown, from the same function.
    const detail = await detailOf();
    expect(body.reasons).toEqual(detail.reasons);
    expect(body.headline).toBe(detail.description.headline);
    // Each reason carries the humanized line the detail prints for it.
    expect(body.reasons.map((r) => r.line)).toEqual(
      detail.description.lines.slice(0, body.reasons.length),
    );
    expect(body.reasons.every((r) => typeof r.line === "string" && r.line !== "")).toBe(true);
    // Nothing started, nothing recorded.
    expect(requestRow(requestId).status).toBe("requested");
    expect(requestRow(requestId).approved_by).toBeNull();
    expect(reviewRow(reviewId).override_by).toBeNull();
    expect(overrideRows()).toHaveLength(0);
    expect(auditRows("dataset_published")).toHaveLength(0);
  });

  test("6. a refusal lists every override-class code that stands, and a partial override is refused for the rest", async () => {
    // Two reasons an override clears: a failed question, and a BIDS validation that failed at the
    // reviewed commit. The list is every code, in the table's order, whatever order they came in.
    const { reviewId } = seedFailing(
      {},
      failingReportWith({ evidence: evidenceFor(SCREENED_HEAD, false, { bids: "fail" }) }),
    );
    const refused = await refusalOf(await approve());
    expect(refused.refusal).toBe("needs_override");
    expect(refused.uncovered).toEqual(["question_failed", "bids_failed_at_review"]);

    const partial = await refusalOf(
      await approve({
        resume: true,
        override_publication_review: { review_id: reviewId, reasons: ["bids_failed_at_review"] },
      }),
    );
    expect(partial.refusal).toBe("override_not_covering");
    expect(partial.uncovered).toEqual(["question_failed"]);
    expect(overrideRows()).toHaveLength(0);
  });

  test("7. an override that covers publishes and is recorded on the row, by code, with its audit row", async () => {
    const { requestId, reviewId } = seedFailing();
    const res = await approve({
      resume: true,
      override_publication_review: {
        review_id: reviewId,
        // A hard code and the screen's own are not an override's to clear: they are not stored.
        reasons: ["question_failed", "request_blocked", "identifier_screen_needs_acknowledgment"],
      },
    });
    expect(res.status).toBe(200);
    expect(requestRow(requestId).status).toBe("published");
    const row = reviewRow(reviewId);
    expect(row.override_by).toBe(adminA);
    expect(row.override_at).not.toBeNull();
    expect(row.override_reasons).toBe(JSON.stringify(["question_failed"]));
    const audit = overrideRows();
    expect(audit).toHaveLength(1);
    expect(audit[0].user_id).toBe(adminA);
    expect(audit[0].details).toEqual({
      request_id: requestId,
      review_id: reviewId,
      head_sha: SCREENED_HEAD,
      outcome: "fail",
      reasons: ["question_failed"],
      via: "approve",
    });
    expect(published().details).toMatchObject({ review_gate: "enforced" });
  });

  test("4. an override sent for a review that needs none is ignored and not recorded", async () => {
    const { requestId } = seed();
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId: DATASET,
      state: "reported",
    });
    const res = await approve({
      resume: true,
      override_publication_review: { review_id: reviewId, reasons: ["question_failed"] },
    });
    expect(res.status).toBe(200);
    expect(reviewRow(reviewId).override_by).toBeNull();
    expect(overrideRows()).toHaveLength(0);
  });

  test("4. a screen that needed an acknowledgment, with a pass review, publishes: the screen's gate decided", async () => {
    const { requestId } = seed({ status: "review" });
    seedPublicationReview(db, { requestId, datasetId: DATASET, state: "reported" });
    const reason = "Looked at every flagged file; the free text is a device serial.";
    const res = await approve({ resume: true, acknowledge_identifier_screen: reason });
    expect(res.status).toBe(200);
    expect(overrideRows()).toHaveLength(0);
    expect(published().details).toMatchObject({ review_gate: "enforced" });
  });

  test("5. a failed submission minimum is refused whatever the override says, with the hard reason's words", async () => {
    // Seeded directly, so the store's re-block (which would have moved the request to blocked)
    // did not run: the gate still stands between this request and a publication.
    const { requestId, reviewId } = seedFailing(
      {},
      goodPublicationReport({
        evidence: evidenceFor(SCREENED_HEAD, false, {
          minimums: "failed",
          minimum_failures: ["name_too_short"],
          name_length: 5,
        }),
      }),
    );
    const res = await approve({
      resume: true,
      override_publication_review: {
        review_id: reviewId,
        reasons: ["submission_minimum_failed", "question_failed"],
      },
    });
    const body = await refusalOf(res);
    expect(body.refusal).toBe("hard_reason");
    const hard = REASONS.submission_minimum_failed;
    expect(body.message).toBe(
      `${reviewGateRefusalText("hard_reason", DATASET)} ${hard.sentence} ${hard.cure}`,
    );
    expect(body.reasons.map((r) => r.code)).toContain("submission_minimum_failed");
    expect(requestRow(requestId).status).toBe("requested");
    expect(reviewRow(reviewId).override_by).toBeNull();
    expect(overrideRows()).toHaveLength(0);
  });

  test("5. a named request that keeps the version an anonymous release used is refused the same way", async () => {
    // An earlier anonymous release left its version row; this named request would reuse it.
    seed({ anonymous: true, requestStatus: "published" });
    db.run("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, '1.0.0', ?)", [
      DATASET,
      "10.82901/nm.test",
    ]);
    const { requestId, reviewId } = seedFailing({}, goodPublicationReport());
    const res = await approve({
      resume: true,
      override_publication_review: {
        review_id: reviewId,
        reasons: ["version_kept_after_anonymous_release", "version_already_released"],
      },
    });
    const body = await refusalOf(res);
    expect(body.refusal).toBe("hard_reason");
    expect(body.message).toContain(REASONS.version_kept_after_anonymous_release.sentence);
    expect(requestRow(requestId).status).toBe("requested");
    expect(overrideRows()).toHaveLength(0);
  });

  test("8. an override given for another review than the one in force is refused, and nothing is recorded", async () => {
    const { requestId, reviewId } = seedFailing();
    // A row of an earlier head of the same request: the administrator read that one.
    const earlier = seedPublicationReview(db, {
      requestId,
      datasetId: DATASET,
      head: OTHER_HEAD,
      state: "reported",
      report: failingReport(OTHER_HEAD),
    });
    expect(earlier).not.toBe(reviewId);
    const res = await approve({
      resume: true,
      override_publication_review: { review_id: earlier, reasons: ["question_failed"] },
    });
    const body = await refusalOf(res);
    expect(body.refusal).toBe("review_changed");
    expect(body.review_id).toBe(reviewId);
    expect(requestRow(requestId).status).toBe("requested");
    expect(reviewRow(reviewId).override_by).toBeNull();
    expect(reviewRow(earlier).override_by).toBeNull();
    expect(overrideRows()).toHaveLength(0);
  });

  test("9. a reason that came up after it was shown is not covered, and the refusal says which", async () => {
    const { requestId, reviewId } = seedFailing();
    // The release of this very version lands after the administrator read the review.
    db.run("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, '1.0.0', ?)", [
      DATASET,
      "10.82901/nm.test",
    ]);
    const res = await approve({
      resume: true,
      override_publication_review: { review_id: reviewId, reasons: ["question_failed"] },
    });
    const body = await refusalOf(res);
    expect(body.refusal).toBe("override_not_covering");
    expect(body.uncovered).toEqual(["version_already_released"]);
    expect(body.reasons.map((r) => r.code)).toEqual([
      "question_failed",
      "version_already_released",
    ]);
    expect(requestRow(requestId).status).toBe("requested");
    expect(reviewRow(reviewId).override_by).toBeNull();
    expect(overrideRows()).toHaveLength(0);
  });

  test("an override that names a code it does not cover, and misses another, is refused for the missing one", async () => {
    const { reviewId } = seedFailing();
    db.run("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, '1.0.0', ?)", [
      DATASET,
      "10.82901/nm.test",
    ]);
    const res = await approve({
      resume: true,
      override_publication_review: { review_id: reviewId, reasons: ["version_already_released"] },
    });
    const body = await refusalOf(res);
    expect(body.refusal).toBe("override_not_covering");
    expect(body.uncovered).toEqual(["question_failed"]);
  });

  test("15. with no review on record the override carries no review id, and is recorded in the audit row alone", async () => {
    const { requestId } = seed();
    const refused = await approve();
    const refusal = await refusalOf(refused);
    expect(refusal.refusal).toBe("needs_override");
    expect(refusal.review_id).toBeNull();
    expect(refusal.uncovered).toEqual(["review_not_started"]);

    // A review id where there is no review is not the one in force.
    const wrong = await approve({
      resume: true,
      override_publication_review: { review_id: 1, reasons: ["review_not_started"] },
    });
    expect((await refusalOf(wrong)).refusal).toBe("review_changed");

    const res = await approve({
      resume: true,
      override_publication_review: { review_id: null, reasons: ["review_not_started"] },
    });
    expect(res.status).toBe(200);
    expect(requestRow(requestId).status).toBe("published");
    expect(reviewRows()).toHaveLength(0);
    const audit = overrideRows();
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({
      request_id: requestId,
      review_id: null,
      head_sha: SCREENED_HEAD,
      reasons: ["review_not_started"],
      via: "approve",
    });
    // The audit row is the only record of this override, so the outcome it holds is the one the
    // administrator was shown: the refusal's, which is the derived outcome of the review.
    expect(refusal.outcome).toBe("action_required");
    expect(audit[0].details.outcome).toBe(refusal.outcome);
    expect(audit[0].details).not.toHaveProperty("executed_by");
  });

  test("15. an approving request whose screen was re-run to a new head has no review to attach to: same rule", async () => {
    // No review can start for an approving request, so a run stopped before it published whose
    // screen was re-run reads review_not_started and can only be approved over from a terminal.
    bidsConclusion = "failure";
    const { requestId } = seed({ requestStatus: "approving", steps: [] });
    const refused = await approve({ resume: true });
    expect((await refusalOf(refused)).refusal).toBe("needs_override");
    const res = await approve({
      resume: true,
      override_publication_review: { review_id: null, reasons: ["review_not_started"] },
    });
    // Past the gate: the run stopped at the BIDS check, which is not the gate's.
    expect(res.status).toBe(422);
    expect(((await res.json()) as { step?: string }).step).toBe("ci_check");
    expect(requestRow(requestId).approved_by).toBe(adminA);
    expect(overrideRows()).toHaveLength(1);
    expect(reviewRows()).toHaveLength(0);
  });
});

describe("an override is its approver's, and it is recorded once", () => {
  test("11. an override recorded by an administrator satisfies that administrator's run and nobody else's", async () => {
    const { requestId, reviewId } = seedFailing();
    setOverride(db, reviewId, adminA, ["question_failed"]);
    // Administrator B has no lease on this request and no override of their own.
    const asB = await approve({ resume: true }, { key: ADMIN_B_KEY });
    const body = await refusalOf(asB);
    expect(body.refusal).toBe("needs_override");
    expect(body.uncovered).toEqual(["question_failed"]);
    expect(requestRow(requestId).status).toBe("requested");

    // The one who gave it passes on it, with nothing in the body and nothing written.
    const before = reviewRow(reviewId);
    const asA = await approve({ resume: true });
    expect(asA.status).toBe(200);
    expect(requestRow(requestId).approved_by).toBe(adminA);
    expect(reviewRow(reviewId)).toEqual(before);
    expect(overrideRows()).toHaveLength(0);
  });

  test("11. a recorded override does not cover a reason it was not given for", async () => {
    const { reviewId } = seedFailing();
    setOverride(db, reviewId, adminA, ["review_running"]);
    const body = await refusalOf(await approve());
    expect(body.refusal).toBe("needs_override");
    expect(body.uncovered).toEqual(["question_failed"]);
  });

  test("an override sent again with the same codes by the same administrator is not recorded again", async () => {
    // The CLI sends the override on every call of a run, and a retry must not write a second row.
    bidsConclusion = "failure";
    const { requestId, reviewId } = seedFailing({ requestStatus: "approving", steps: [] });
    const body = {
      resume: true,
      override_publication_review: { review_id: reviewId, reasons: ["question_failed"] },
    };
    const first = await approve(body);
    expect(first.status).toBe(422);
    const recorded = reviewRow(reviewId);
    expect(recorded.override_by).toBe(adminA);
    expect(overrideRows()).toHaveLength(1);
    const second = await approve(body);
    expect(second.status).toBe(422);
    expect(reviewRow(reviewId)).toEqual(recorded);
    expect(overrideRows()).toHaveLength(1);
    expect(requestRow(requestId).status).toBe("approving");
  });

  test("an override that now names more than the one on record is recorded again, by the same administrator", async () => {
    // The record is skipped only when it says exactly what stands: a reason that came up since
    // the first override is one the administrator confirms again, and the new set replaces the old.
    bidsConclusion = "failure";
    const { requestId, reviewId } = seedFailing({ requestStatus: "approving", steps: [] });
    const first = await approve({
      resume: true,
      override_publication_review: { review_id: reviewId, reasons: ["question_failed"] },
    });
    expect(first.status).toBe(422);
    expect(reviewRow(reviewId).override_reasons).toBe(JSON.stringify(["question_failed"]));
    expect(overrideRows()).toHaveLength(1);

    db.run("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, '1.0.0', ?)", [
      DATASET,
      "10.82901/nm.test",
    ]);
    const second = await approve({
      resume: true,
      override_publication_review: {
        review_id: reviewId,
        reasons: ["question_failed", "version_already_released"],
      },
    });
    expect(second.status).toBe(422);
    expect(reviewRow(reviewId).override_by).toBe(adminA);
    expect(reviewRow(reviewId).override_reasons).toBe(
      JSON.stringify(["question_failed", "version_already_released"]),
    );
    const audit = overrideRows();
    expect(audit).toHaveLength(2);
    expect(audit[1].details).toMatchObject({
      review_id: reviewId,
      reasons: ["question_failed", "version_already_released"],
    });
    expect(requestRow(requestId).status).toBe("approving");
  });

  test("an override records the codes that stand, not every override-class code the body lists, so a later reason is not pre-covered", async () => {
    // A client other than the CLI may list a code that does not stand. Only the codes that stand
    // are recorded, so the record cannot cover a reason that comes up afterwards.
    bidsConclusion = "failure";
    const { requestId, reviewId } = seedFailing({ requestStatus: "approving", steps: [] });
    const body = {
      resume: true,
      override_publication_review: {
        review_id: reviewId,
        reasons: ["question_failed", "version_already_released"],
      },
    };
    const first = await approve(body);
    // Past the gate, stopped by the BIDS check.
    expect(first.status).toBe(422);
    expect(reviewRow(reviewId).override_reasons).toBe(JSON.stringify(["question_failed"]));
    expect(overrideRows()).toHaveLength(1);
    expect(overrideRows()[0].details).toMatchObject({ reasons: ["question_failed"] });

    // Sent again as it was, the set that stands is the set on record: not recorded again.
    const again = await approve(body);
    expect(again.status).toBe(422);
    expect(overrideRows()).toHaveLength(1);

    // The release of this very version lands afterwards. The record does not cover it.
    db.run("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, '1.0.0', ?)", [
      DATASET,
      "10.82901/nm.test",
    ]);
    // Seeded after the fact, so the run is gated again: it has not started publishing.
    const bare = await refusalOf(await approve({ resume: true }));
    expect(bare.refusal).toBe("needs_override");
    // A bare approval names everything an override would have to cover.
    expect(bare.uncovered).toEqual(["question_failed", "version_already_released"]);
    const named = await refusalOf(
      await approve({
        resume: true,
        override_publication_review: { review_id: reviewId, reasons: ["question_failed"] },
      }),
    );
    expect(named.refusal).toBe("override_not_covering");
    expect(named.uncovered).toEqual(["version_already_released"]);
    expect(reviewRow(reviewId).override_reasons).toBe(JSON.stringify(["question_failed"]));
    expect(requestRow(requestId).status).toBe("approving");
  });

  test("an override from another administrator for the same review replaces the recorded one", async () => {
    const { reviewId } = seedFailing();
    setOverride(db, reviewId, adminA, ["question_failed"]);
    const res = await approve(
      {
        resume: true,
        override_publication_review: { review_id: reviewId, reasons: ["question_failed"] },
      },
      { key: ADMIN_B_KEY },
    );
    expect(res.status).toBe(200);
    expect(reviewRow(reviewId).override_by).toBe(adminB);
    expect(overrideRows()).toHaveLength(1);
    expect(overrideRows()[0].user_id).toBe(adminB);
  });

  test("23. a terminal approval by B inside A's live web claim is B's own act: it does not ride on A's override, and A's claim is intact", async () => {
    // The flip of the earlier pin (#1604, ADR 0105 decisions 4 and 6). Inside a live claim, with no
    // dispatch token, B is not A's run: B is recorded as B, B needs B's own override, and a refusal
    // changes nothing, so the run the click dispatched can still be carried out by its executor.
    const { requestId, reviewId } = seedFailing();
    setOverride(db, reviewId, adminA, ["question_failed"]);
    const token = await claim(requestId, adminA);
    const claimBefore = claimOf(requestId);
    const reviewBefore = reviewRow(reviewId);

    const body = await refusalOf(await approve({ resume: true }, { key: ADMIN_B_KEY }));
    expect(body.refusal).toBe("needs_override");
    expect(body.uncovered).toEqual(["question_failed"]);

    const row = requestRow(requestId);
    expect(row.status).toBe("requested");
    expect(row.approved_by).toBeNull();
    expect(claimOf(requestId)).toEqual(claimBefore);
    expect(reviewRow(reviewId)).toEqual(reviewBefore);
    expect(auditRows("dataset_published")).toHaveLength(0);
    expect(overrideRows()).toHaveLength(0);

    // The control: the refused call took nothing over, so the executor's run, with A's token, still
    // is A's and rides on A's recorded override.
    const run = await approve({ resume: true }, { key: ADMIN_B_KEY, token });
    expect(run.status).toBe(200);
    expect(requestRow(requestId).approved_by).toBe(adminA);
    expect(published().user_id).toBe(adminA);
    expect(published().details).toMatchObject({
      approved_by: "gateadmina",
      executed_by: "gateadminb",
    });
  });

  test("23. B's own override at a terminal inside A's live claim is recorded as B's, B is the approver, and B takes the claim over", async () => {
    const { requestId, reviewId } = seedFailing();
    setOverride(db, reviewId, adminA, ["question_failed"]);
    await claim(requestId, adminA);

    const res = await approve(
      {
        resume: true,
        override_publication_review: { review_id: reviewId, reasons: ["question_failed"] },
      },
      { key: ADMIN_B_KEY },
    );
    expect(res.status).toBe(200);

    expect(requestRow(requestId).approved_by).toBe(adminB);
    expect(reviewRow(reviewId).override_by).toBe(adminB);
    expect(overrideRows()).toHaveLength(1);
    expect(overrideRows()[0].user_id).toBe(adminB);
    expect(published().user_id).toBe(adminB);
    // B is the approver and the caller: there is no separate executor to name.
    expect(published().details).not.toHaveProperty("executed_by");
    expect(claimOf(requestId)).toEqual({ by: null, at: null });
  });

  test("23. the takeover: after B approves at a terminal, the executor's call with A's token is superseded, and approved_by stays B", async () => {
    // A pass review, so B needs no override; the run stops at the CI check, after the mark, so the
    // request is still `approving` when the executor's call arrives.
    bidsConclusion = "failure";
    const executorKey = "review-gate-executor-0123456789abcdef0123456789abcdef";
    await seedUser(db, "gateexecutor", "admin", executorKey);
    const { requestId } = seed({ steps: [] });
    seedPublicationReview(db, { requestId, datasetId: DATASET, state: "reported" });
    const token = await claim(requestId, adminA);

    const asB = await approve({ resume: true }, { key: ADMIN_B_KEY });
    expect(asB.status).toBe(422);
    expect(requestRow(requestId).status).toBe("approving");
    expect(requestRow(requestId).approved_by).toBe(adminB);
    expect(claimOf(requestId)).toEqual({ by: null, at: null });
    const afterB = requestRow(requestId);

    const asExecutor = await approve({ resume: true }, { key: executorKey, token });
    expect(asExecutor.status).toBe(409);
    expect(await asExecutor.json()).toEqual({
      error: "dispatch_superseded",
      message: DISPATCH_SUPERSEDED_MESSAGE,
    });
    // Nothing about the request moved: B's approval is the one on record.
    expect(requestRow(requestId)).toEqual(afterB);
    expect(requestRow(requestId).approved_by).toBe(adminB);
    expect(auditRows("dataset_published")).toHaveLength(0);
  });

  test("23. a token-bearing call that marks keeps the claim: the same token carries the retry after the run failed, recorded as the clicker", async () => {
    // A web approval is many calls (every batch of the lock loop, every retry of a failed step)
    // and each carries the one token of the click. Only a call WITHOUT the token ends the claim;
    // a call that marks under the token must leave it standing, or every later call of the run
    // is refused as superseded.
    bidsConclusion = "failure";
    const executorKey = "review-gate-executor-0123456789abcdef0123456789abcdef";
    await seedUser(db, "gateexecutor", "admin", executorKey);
    const { requestId } = seed({ steps: DONE.filter((s) => s !== "ci_check") });
    seedPublicationReview(db, { requestId, datasetId: DATASET, state: "reported" });
    const token = await claim(requestId, adminA);
    const claimBefore = claimOf(requestId);

    const first = await approve({ resume: true }, { key: executorKey, token });
    // Marked, then stopped by the CI check.
    expect(first.status).toBe(422);
    expect(requestRow(requestId).status).toBe("approving");
    expect(requestRow(requestId).approved_by).toBe(adminA);
    expect(claimOf(requestId)).toEqual(claimBefore);

    // The retry: the check passes now, and the same token is still the claim's.
    bidsConclusion = "success";
    const retry = await approve({ resume: true }, { key: executorKey, token });
    expect(retry.status).toBe(200);
    expect(requestRow(requestId).status).toBe("published");
    expect(requestRow(requestId).approved_by).toBe(adminA);
    expect(published().user_id).toBe(adminA);
    expect(published().details).toMatchObject({
      approved_by: "gateadmina",
      executed_by: "gateexecutor",
    });
  });

  test("23. the first call of a fresh web approval (resume false) marks under the token and leaves the claim for the next call", async () => {
    // The executor's first call is not a resume. It marks the request and stops here at the CI
    // check; the claim must stand, and the next call with the token is still the click's run.
    bidsConclusion = "failure";
    const executorKey = "review-gate-executor-0123456789abcdef0123456789abcdef";
    await seedUser(db, "gateexecutor", "admin", executorKey);
    const { requestId } = seed({ steps: [] });
    seedPublicationReview(db, { requestId, datasetId: DATASET, state: "reported" });
    const token = await claim(requestId, adminA);
    const claimBefore = claimOf(requestId);

    const first = await approve({ resume: false }, { key: executorKey, token });
    expect(first.status).toBe(422);
    expect(requestRow(requestId).status).toBe("approving");
    expect(requestRow(requestId).approved_by).toBe(adminA);
    expect(claimOf(requestId)).toEqual(claimBefore);

    // The retry is a resume. It is not refused as superseded: it reaches the CI check again.
    const retry = await approve({ resume: true }, { key: executorKey, token });
    expect(retry.status).toBe(422);
    expect(requestRow(requestId).approved_by).toBe(adminA);
    expect(claimOf(requestId)).toEqual(claimBefore);
    expect(auditRows("dataset_published")).toHaveLength(0);
  });
});

/**
 * An override is recorded only under the credential that sent it, or at the clicker's own
 * dispatch (#1604, ADR 0105 decision 5). This is the guarantee the earlier refusal
 * `override_inside_web_approval` stood in for; it is now structural, and held here as a property:
 * after every scenario, every override on a review row and in the audit trail names `sender`, and
 * when `sender` is null (the call was refused, or sent none) there is none.
 */
function expectOverridesRecordedBy(sender: number | null): void {
  for (const r of reviewRows()) {
    if (r.override_by !== null) expect(r.override_by).toBe(sender);
  }
  for (const a of overrideRows()) expect(a.user_id).toBe(sender);
  if (sender === null) {
    expect(reviewRows().filter((r) => r.override_by !== null)).toHaveLength(0);
    expect(overrideRows()).toHaveLength(0);
  }
}

describe("#1604: a run the web started carries its click's decision and sends none of its own", () => {
  const override = (reviewId: number) => ({
    override_publication_review: { review_id: reviewId, reasons: ["question_failed"] },
  });

  test("23. an override sent by B with A's token is refused as decision_with_dispatch_token, and recorded under nobody", async () => {
    const { requestId, reviewId } = seedFailing();
    const token = await claim(requestId, adminA);
    const claimBefore = claimOf(requestId);

    const res = await approve({ resume: true, ...override(reviewId) }, { key: ADMIN_B_KEY, token });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toEqual({
      error: "decision_with_dispatch_token",
      message: DECISION_WITH_DISPATCH_TOKEN_MESSAGE,
    });
    expect(APPROVAL_REFUSAL_ERROR_CODES).toContain(body.error);
    // The earlier stop-gap is gone from the contract: its job is structural now (decision 5).
    expect(APPROVAL_REFUSAL_ERROR_CODES).not.toContain("override_inside_web_approval");
    // Nothing ran and nothing was recorded, under A or under B.
    expect(reviewRow(reviewId).override_by).toBeNull();
    expect(reviewRow(reviewId).override_reasons).toBeNull();
    expect(overrideRows()).toHaveLength(0);
    const row = requestRow(requestId);
    expect(row.status).toBe("requested");
    expect(row.approved_by).toBeNull();
    expect(auditRows("dataset_published")).toHaveLength(0);
    // The claim is the clicker's still: refusing the decision did not touch it.
    expect(claimOf(requestId)).toEqual(claimBefore);
    expectOverridesRecordedBy(null);
  });

  test("23. an identifier-screen acknowledgment sent with the token is refused the same way, and recorded nowhere", async () => {
    const { requestId } = seed({ status: "unchecked" });
    seedPublicationReview(db, { requestId, datasetId: DATASET, state: "reported" });
    const token = await claim(requestId, adminA);
    const before = requestRow(requestId);

    const res = await approve(
      {
        resume: true,
        acknowledge_identifier_screen: "Read the recording formats by hand, nothing to remove",
      },
      { key: ADMIN_B_KEY, token },
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("decision_with_dispatch_token");
    expect(requestRow(requestId)).toEqual(before);
    expect(requestRow(requestId).identifier_screen_ack_by).toBeNull();
    expect(auditRows("identifier_screen_acknowledged")).toHaveLength(0);
  });

  test("23. even the clicker's own override cannot travel with the token: the click recorded it already", async () => {
    const { requestId, reviewId } = seedFailing();
    const token = await claim(requestId, adminA);
    const res = await approve({ resume: true, ...override(reviewId) }, { key: ADMIN_A_KEY, token });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("decision_with_dispatch_token");
    expect(reviewRow(reviewId).override_by).toBeNull();
    expectOverridesRecordedBy(null);
  });

  test("23. the refusal is for the decision and nothing else: B with the token and no decision carries A's recorded override as A's run", async () => {
    const { requestId, reviewId } = seedFailing();
    setOverride(db, reviewId, adminA, ["question_failed"]);
    const token = await claim(requestId, adminA);

    const res = await approve({ resume: true }, { key: ADMIN_B_KEY, token });

    expect(res.status).toBe(200);
    expect(requestRow(requestId).approved_by).toBe(adminA);
    expect(published().details).toMatchObject({
      approved_by: "gateadmina",
      executed_by: "gateadminb",
    });
    // The override on the row is A's own act, recorded at the click; the run wrote none.
    expect(overrideRows()).toHaveLength(0);
    expectOverridesRecordedBy(adminA);
  });

  test("23. without the token an override is its sender's, claim or no claim: A's own inside A's claim is A's, B's outside any claim is B's", async () => {
    const own = seedFailing();
    await claim(own.requestId, adminA);
    const asA = await approve({ resume: true, ...override(own.reviewId) }, { key: ADMIN_A_KEY });
    expect(asA.status).toBe(200);
    expect(reviewRow(own.reviewId).override_by).toBe(adminA);
    expect(overrideRows()).toHaveLength(1);
    expectOverridesRecordedBy(adminA);

    // A request with no claim at all: B's override is B's.
    db.run("DELETE FROM audit_log");
    const other = seedFailing({ datasetId: "nm000484" });
    const asB = await approve(
      { resume: true, ...override(other.reviewId) },
      { key: ADMIN_B_KEY, dataset: "nm000484" },
    );
    expect(asB.status).toBe(200);
    expect(reviewRow(other.reviewId).override_by).toBe(adminB);
    expect(overrideRows()[0].details).not.toHaveProperty("executed_by");
  });

  test("23. the executor sends no decision: approve-dispatch records the click's override, and the token carries the run on it", async () => {
    // The shape of `approve-dispatch` followed by the executor's run (test 12, below), the way the
    // workflow does it: the token out of the dispatch payload, the executor's own key, no override.
    const { requestId, reviewId } = seedFailing();
    const dispatched = await dispatchApproval({
      override_publication_review: { review_id: reviewId, reasons: ["question_failed"] },
    });
    expect(dispatched.status).toBe(202);
    const token = dispatchPayloads[0]?.dispatch_token as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    // Without the token the same call is B's own act, and B has no override: refused, claim intact.
    const claimBefore = claimOf(requestId);
    const bare = await refusalOf(await approve({ resume: true }, { key: ADMIN_B_KEY }));
    expect(bare.refusal).toBe("needs_override");
    expect(claimOf(requestId)).toEqual(claimBefore);

    const run = await approve({ resume: true }, { key: ADMIN_B_KEY, token });
    expect(run.status).toBe(200);
    expect(requestRow(requestId).approved_by).toBe(adminA);
    expect(overrideRows()).toHaveLength(1);
    expectOverridesRecordedBy(adminA);
  });

  test("23. the same for the screen's acknowledgment: the click records it, the token carries the run on it, and a call without the token has none", async () => {
    // A screen that could not look at everything passes only with an administrator's recorded
    // reason. The click records A's, and the executor's run, which carries the token, is A's and
    // finds it; the same call made as B without the token is B's own, and B gave no reason.
    const why = "Read the recording formats by hand, nothing to remove";
    const { requestId } = seed({ status: "unchecked" });
    seedPublicationReview(db, { requestId, datasetId: DATASET, state: "reported" });
    const dispatched = await dispatchApproval({ acknowledge_identifier_screen: why });
    expect(dispatched.status).toBe(202);
    expect(requestRow(requestId).identifier_screen_ack_by).toBe(adminA);
    const token = dispatchPayloads[0]?.dispatch_token as string;
    const claimBefore = claimOf(requestId);

    const bare = await approve({ resume: true }, { key: ADMIN_B_KEY });
    expect(bare.status).toBe(409);
    expect(((await bare.json()) as { error: string }).error).toBe("identifier_screen_not_clear");
    expect(claimOf(requestId)).toEqual(claimBefore);
    expect(requestRow(requestId).approved_by).toBeNull();

    const run = await approve({ resume: true }, { key: ADMIN_B_KEY, token });
    expect(run.status).toBe(200);
    expect(requestRow(requestId).approved_by).toBe(adminA);
    expect(published().details).toMatchObject({
      approved_by: "gateadmina",
      executed_by: "gateadminb",
    });
  });

  // The property, over every way an override can be sent from a terminal or an executor: whatever
  // the call's answer, an override is on record only under the account that sent it.
  const SCENARIOS: Array<{
    name: string;
    claimed: boolean;
    withToken: boolean;
    key: string;
    sends: boolean;
    sender: "A" | "B" | null;
  }> = [
    {
      name: "B's override at a terminal inside A's claim",
      claimed: true,
      withToken: false,
      key: ADMIN_B_KEY,
      sends: true,
      sender: "B",
    },
    {
      name: "B's override with A's token",
      claimed: true,
      withToken: true,
      key: ADMIN_B_KEY,
      sends: true,
      sender: null,
    },
    {
      name: "A's override at a terminal inside A's claim",
      claimed: true,
      withToken: false,
      key: ADMIN_A_KEY,
      sends: true,
      sender: "A",
    },
    {
      name: "A's override with A's own token",
      claimed: true,
      withToken: true,
      key: ADMIN_A_KEY,
      sends: true,
      sender: null,
    },
    {
      name: "B's override with no claim at all",
      claimed: false,
      withToken: false,
      key: ADMIN_B_KEY,
      sends: true,
      sender: "B",
    },
    {
      name: "B's call with A's token and no override",
      claimed: true,
      withToken: true,
      key: ADMIN_B_KEY,
      sends: false,
      sender: null,
    },
  ];
  for (const sc of SCENARIOS) {
    test(`23. property: ${sc.name}: an override is recorded only under its sender`, async () => {
      const { requestId, reviewId } = seedFailing();
      const token = sc.claimed ? await claim(requestId, adminA) : undefined;
      // A call that sends no override and has no recorded one is refused: also "none recorded".
      const res = await approve(
        { resume: true, ...(sc.sends ? override(reviewId) : {}) },
        { key: sc.key, ...(sc.withToken && token ? { token } : {}) },
      );
      expect([200, 409]).toContain(res.status);
      expectOverridesRecordedBy(sc.sender === null ? null : sc.sender === "A" ? adminA : adminB);
    });
  }
});

describe("the gate runs on a resume that has not started publishing, and only on that one", () => {
  test("16. a run that has started publishing is not gated, whatever the review says", async () => {
    const { requestId } = seedFailing({ requestStatus: "approving", steps: DONE });
    mainHead = OTHER_HEAD;
    const res = await approve({ resume: true });
    expect(res.status).toBe(200);
    expect(requestRow(requestId).status).toBe("published");
    expect(calls.filter((c) => /\/git\/ref\//.test(c.path))).toHaveLength(0);
    expect(overrideRows()).toHaveLength(0);
  });

  test("17. the CLI's own retry before publishing passes on an override for a review that was running", async () => {
    // The request is `approving` with no step done, and its review was dispatched ten minutes ago.
    // Such a request is gated again when it resumes, so its review can still report: the detail
    // reads the row by time alone, as running, and the gate reads it the same way, so the override
    // the administrator was shown covers what the gate evaluates. Were they to read it differently
    // the first transient failure of a forced approval would be refused on its retry.
    bidsConclusion = "failure";
    const { requestId } = seed({ requestStatus: "approving", steps: [] });
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId: DATASET,
      state: "dispatched",
      createdMinutesAgo: 10,
      claimed: true,
    });
    // The detail says running, by time alone.
    expect((await detailOf()).reasons.map((r) => r.code)).toEqual(["review_running"]);
    // Gated: no override, no pass.
    const refused = await approve({ resume: true });
    const body = await refusalOf(refused);
    expect(body.refusal).toBe("needs_override");
    expect(body.uncovered).toEqual(["review_running"]);
    expect(requestRow(requestId).approved_by).toBeNull();

    const res = await approve({
      resume: true,
      override_publication_review: { review_id: reviewId, reasons: ["review_running"] },
    });
    // Past the gate, and stopped by the BIDS check: positive proof that the gate let it through.
    expect(res.status).toBe(422);
    expect(((await res.json()) as { step?: string }).step).toBe("ci_check");
    expect(requestRow(requestId).approved_by).toBe(adminA);
    expect(reviewRow(reviewId).override_reasons).toBe(JSON.stringify(["review_running"]));
  });

  test("17. a dispatched row past the time window is a review that did not report, which the override did not name", async () => {
    // Time alone ages the row, for the detail and the gate alike: past the window it did not report.
    const { requestId } = seed({ requestStatus: "approving", steps: [] });
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId: DATASET,
      state: "dispatched",
      createdMinutesAgo: 90,
      claimed: true,
    });
    expect((await detailOf()).reasons.map((r) => r.code)).toEqual(["review_did_not_report"]);
    const res = await approve({
      resume: true,
      override_publication_review: { review_id: reviewId, reasons: ["review_running"] },
    });
    const body = await refusalOf(res);
    expect(body.refusal).toBe("override_not_covering");
    expect(body.uncovered).toEqual(["review_did_not_report"]);
    expect(requestRow(requestId).approved_by).toBeNull();
  });
});

describe("a run that stopped before it published is gated on the version and DOI facts too", () => {
  // `approving` with no step after the validation-only ones done: the run is gated again when it
  // resumes (test 16's counterpart), and nothing it ran so far wrote a `dataset_versions` row or a
  // concept DOI, so those facts are about an EARLIER release exactly as they are for `requested`.
  const STOPPED = { requestStatus: "approving", steps: [] } as const;
  const VERSION_DOI = "10.82901/nm.test";

  /** An anonymous release of 1.0.0 that left its version row, before this request. */
  function anonymousReleaseOfOneZero(): void {
    seed({ anonymous: true, requestStatus: "published" });
    db.run("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, '1.0.0', ?)", [
      DATASET,
      VERSION_DOI,
    ]);
  }

  test("5. the probe: forced over a running review, stopped at the CI check, resumed with the report a pass: refused, and the detail says why", async () => {
    // The review had not reported when the administrator forced past it, so no version was known
    // and the gate had nothing to refuse. The report lands as a pass, naming 1.0.0, which an
    // anonymous release already used; the resume is gated again and must see it.
    bidsConclusion = "failure";
    anonymousReleaseOfOneZero();
    const { requestId } = seed({ steps: [] });
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId: DATASET,
      state: "dispatched",
      createdMinutesAgo: 5,
      claimed: true,
    });
    const forced = await approve({
      resume: true,
      override_publication_review: { review_id: reviewId, reasons: ["review_running"] },
    });
    expect(forced.status).toBe(422);
    expect(((await forced.json()) as { step?: string }).step).toBe("ci_check");
    expect(requestRow(requestId).status).toBe("approving");
    expect(JSON.parse(String(requestRow(requestId).steps_completed))).toEqual([]);

    const nonce = (
      db.query("SELECT nonce FROM publication_reviews WHERE id = ?").get(reviewId) as {
        nonce: string;
      }
    ).nonce;
    const stored = await storePublicationReviewResult(env(), reviewId, DATASET, nonce, {
      kind: "reported",
      report: parsePublicationReviewReport(goodPublicationReport()),
    });
    expect(stored.stored).toBe(true);

    // What the administrator is shown now, and what the gate says to a resume with no flag.
    const detail = await detailOf();
    expect(detail.request_status).toBe("approving");
    expect(detail.started_publishing).toBe(false);
    expect(detail.reasons.map((r) => r.code)).toEqual(["version_kept_after_anonymous_release"]);
    const resumed = await approve({ resume: true });
    const body = await refusalOf(resumed);
    expect(body.refusal).toBe("hard_reason");
    expect(body.message).toContain(REASONS.version_kept_after_anonymous_release.sentence);
    expect(body.reasons).toEqual(detail.reasons);
    // The earlier forced run's step list is untouched: nothing ran for the refused resume.
    expect(JSON.parse(String(requestRow(requestId).steps_completed))).toEqual([]);
    expect(requestRow(requestId).approved_by).toBe(adminA);
    expect(auditRows("dataset_published")).toHaveLength(0);
  });

  test("5. a named run that keeps the version an anonymous release used is refused the same way when it stopped before publishing", async () => {
    anonymousReleaseOfOneZero();
    const { requestId, reviewId } = seedFailing(STOPPED, goodPublicationReport());
    const res = await approve({
      resume: true,
      override_publication_review: {
        review_id: reviewId,
        reasons: ["version_kept_after_anonymous_release", "version_already_released"],
      },
    });
    const body = await refusalOf(res);
    expect(body.refusal).toBe("hard_reason");
    expect(body.message).toContain(REASONS.version_kept_after_anonymous_release.sentence);
    expect(body.reasons.map((r) => r.code)).toEqual(["version_kept_after_anonymous_release"]);
    expect((await detailOf()).reasons).toEqual(body.reasons);
    expect(requestRow(requestId).approved_by).toBeNull();
    expect(overrideRows()).toHaveLength(0);
  });

  test("5. a failed submission minimum is refused whatever the override says when the run stopped before publishing", async () => {
    const { requestId, reviewId } = seedFailing(
      STOPPED,
      goodPublicationReport({
        evidence: evidenceFor(SCREENED_HEAD, false, {
          minimums: "failed",
          minimum_failures: ["name_too_short"],
          name_length: 5,
        }),
      }),
    );
    const res = await approve({
      resume: true,
      override_publication_review: {
        review_id: reviewId,
        reasons: ["submission_minimum_failed", "question_failed"],
      },
    });
    const body = await refusalOf(res);
    expect(body.refusal).toBe("hard_reason");
    expect(body.reasons.map((r) => r.code)).toContain("submission_minimum_failed");
    expect((await detailOf()).reasons).toEqual(body.reasons);
    expect(requestRow(requestId).approved_by).toBeNull();
    expect(overrideRows()).toHaveLength(0);
  });

  test("9. a version the dataset already released needs the override from a run that stopped before publishing, and the override then passes", async () => {
    bidsConclusion = "failure";
    // A named request for a version an earlier NAMED release already published: not the anonymous
    // case, so `version_already_released`, which an override clears.
    seed({ requestStatus: "published" });
    db.run("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, '1.0.0', ?)", [
      DATASET,
      VERSION_DOI,
    ]);
    const { requestId, reviewId } = seedFailing(STOPPED, goodPublicationReport());
    const detail = await detailOf();
    expect(detail.reasons.map((r) => r.code)).toEqual(["version_already_released"]);

    const refused = await refusalOf(await approve({ resume: true }));
    expect(refused.refusal).toBe("needs_override");
    expect(refused.uncovered).toEqual(["version_already_released"]);
    expect(requestRow(requestId).approved_by).toBeNull();

    const res = await approve({
      resume: true,
      override_publication_review: { review_id: reviewId, reasons: ["version_already_released"] },
    });
    // Past the gate, stopped by the BIDS check: the override named what stood.
    expect(res.status).toBe(422);
    expect(((await res.json()) as { step?: string }).step).toBe("ci_check");
    expect(reviewRow(reviewId).override_reasons).toBe(JSON.stringify(["version_already_released"]));
  });

  test("9. a concept DOI the dataset already carries is a reason for a run that stopped before publishing", async () => {
    seedFailing(STOPPED, goodPublicationReport());
    db.run("UPDATE datasets SET concept_doi = '10.82901/nm.concept' WHERE dataset_id = ?", [
      DATASET,
    ]);
    const refused = await refusalOf(await approve({ resume: true }));
    expect(refused.refusal).toBe("needs_override");
    expect(refused.uncovered).toEqual(["doi_state_unexpected"]);
  });

  test("16. a run that HAS started publishing reads none of them: its own version row and DOI are not an earlier release", async () => {
    // The run wrote these itself (`doi_create`, `create_tag`), so reading them as live facts would
    // say "already released" about a run that has to be resumed, with `approve --force` as the way.
    const { requestId } = seedFailing({ requestStatus: "approving", steps: DONE });
    db.run("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, '1.0.0', ?)", [
      DATASET,
      VERSION_DOI,
    ]);
    db.run("UPDATE datasets SET concept_doi = '10.82901/nm.concept' WHERE dataset_id = ?", [
      DATASET,
    ]);
    const detail = await detailOf();
    expect(detail.started_publishing).toBe(true);
    expect(detail.reasons.map((r) => r.code)).not.toContain("version_already_released");
    expect(detail.reasons.map((r) => r.code)).not.toContain("doi_state_unexpected");
    expect(detail.reasons.map((r) => r.code)).not.toContain("version_kept_after_anonymous_release");
    const res = await approve({ resume: true });
    expect(res.status).toBe(200);
    expect(requestRow(requestId).status).toBe("published");
    expect(overrideRows()).toHaveLength(0);
  });
});

describe("the mark that starts an approval does not overwrite a change made while it was checked", () => {
  /** The statement that marks the request `approving`: the first write of a run past the gates. */
  const isMark = (sql: string) => /UPDATE publication_requests SET status = 'approving'/.test(sql);

  test("21. a failed-minimum report that re-blocks the request between the gate and the mark is not undone by the approval", async () => {
    // The administrator forces over a review that is still running; the override commits on the
    // review row. Then the job's report lands with a failed submission minimum, and its batch moves
    // the request to `blocked` (REBLOCK_SQL). The mark must not flip it back to `approving`.
    const { requestId } = seed();
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId: DATASET,
      state: "dispatched",
      createdMinutesAgo: 5,
      claimed: true,
    });
    const nonce = (
      db.query("SELECT nonce FROM publication_reviews WHERE id = ?").get(reviewId) as {
        nonce: string;
      }
    ).nonce;
    const real = realD1(db);
    const racing = interceptingD1(real, async (sql) => {
      if (!isMark(sql)) return;
      const stored = await storePublicationReviewResult(
        env({ DB: real }),
        reviewId,
        DATASET,
        nonce,
        {
          kind: "reported",
          report: parsePublicationReviewReport(
            goodPublicationReport({
              evidence: evidenceFor(SCREENED_HEAD, false, {
                minimums: "failed",
                minimum_failures: ["name_too_short"],
                name_length: 5,
              }),
            }),
          ),
        },
      );
      expect(stored.stored).toBe(true);
    });
    const res = await approve(
      {
        resume: true,
        override_publication_review: { review_id: reviewId, reasons: ["review_running"] },
      },
      { bindings: env({ DB: racing }) },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toEqual({ error: "request_changed", message: REQUEST_CHANGED_MESSAGE });
    expect(APPROVAL_REFUSAL_ERROR_CODES).toContain(body.error);
    const row = requestRow(requestId);
    // As the report's batch left it: blocked, with its reason, and nothing of an approval on it.
    expect(row.status).toBe("blocked");
    expect(row.block_reason).toBe("min_requirements_failed");
    expect(row.approved_by).toBeNull();
    expect(JSON.parse(String(row.steps_completed))).toEqual([...DONE]);
    expect(auditRows("dataset_published")).toHaveLength(0);
    // The screen gate's read of `main` is the only call: no step ran.
    expect(calls.filter((c) => !/\/git\/ref\//.test(c.path))).toEqual([]);
  });

  test("21. a denial that lands between the gate and the mark is not undone either", async () => {
    const { requestId } = seed();
    seedPublicationReview(db, { requestId, datasetId: DATASET, state: "reported" });
    const real = realD1(db);
    const racing = interceptingD1(real, (sql) => {
      if (isMark(sql)) {
        db.run("UPDATE publication_requests SET status = 'denied' WHERE id = ?", [requestId]);
      }
    });
    const res = await approve({ resume: true }, { bindings: env({ DB: racing }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "request_changed",
      message: REQUEST_CHANGED_MESSAGE,
    });
    expect(requestRow(requestId).status).toBe("denied");
    expect(requestRow(requestId).approved_by).toBeNull();
    expect(auditRows("dataset_published")).toHaveLength(0);
  });

  test("21. a request read as blocked for the owner's name, then re-blocked for another reason before the mark, is not marked", async () => {
    // The run started publishing and the owner-name walk-back blocked it, so the approval skips
    // the gates and carries on. Before the mark a depositor's re-request moves the row to a
    // different reason: the mark's blocked branch is pinned to the owner-name reason, so it
    // does not match and nothing runs.
    const { requestId } = seed({
      requestStatus: "blocked",
      blockReason: "owner_name_missing",
      steps: DONE,
    });
    const real = realD1(db);
    const racing = interceptingD1(real, (sql) => {
      if (isMark(sql)) {
        db.run(
          "UPDATE publication_requests SET block_reason = 'min_requirements_failed' WHERE id = ?",
          [requestId],
        );
      }
    });
    const res = await approve({ resume: true }, { bindings: env({ DB: racing }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "request_changed",
      message: REQUEST_CHANGED_MESSAGE,
    });
    const row = requestRow(requestId);
    expect(row.status).toBe("blocked");
    expect(row.block_reason).toBe("min_requirements_failed");
    expect(row.approved_by).toBeNull();
    expect(JSON.parse(String(row.steps_completed))).toEqual([...DONE]);
    expect(auditRows("dataset_published")).toHaveLength(0);
    expect(calls.filter((c) => !/\/git\/ref\//.test(c.path))).toEqual([]);
  });

  test("21. a request that is still waiting, or already approving, is marked as before", async () => {
    const waiting = seed();
    seedPublicationReview(db, {
      requestId: waiting.requestId,
      datasetId: DATASET,
      state: "reported",
    });
    expect((await approve()).status).toBe(200);
    expect(requestRow(waiting.requestId).status).toBe("published");
    expect(requestRow(waiting.requestId).approved_by).toBe(adminA);

    const resumed = seed({ datasetId: "nm000484", requestStatus: "approving", steps: DONE });
    expect((await approve({ resume: true }, { dataset: "nm000484" })).status).toBe(200);
    expect(requestRow(resumed.requestId).status).toBe("published");
  });
});

describe("the gate refuses what it cannot establish", () => {
  test("18. with the review table unreadable the gate refuses, as unverified, and starts nothing", async () => {
    const { requestId } = seedFailing();
    const broken = hookedD1(realD1(db), {
      statement: (sql) => {
        if (/FROM publication_reviews/.test(sql)) throw new Error("the review table is unreadable");
      },
    });
    const res = await approve({ resume: true }, { bindings: env({ DB: broken }) });
    const body = await refusalOf(res);
    expect(body.refusal).toBe("unverified");
    expect(body.fact).toBe("review");
    expect(body.message).toBe(reviewGateRefusalText("unverified", DATASET));
    expect(body.reasons).toEqual([]);
    expect(body.outcome).toBeNull();
    expect(requestRow(requestId).status).toBe("requested");
    expect(auditRows("dataset_published")).toHaveLength(0);
  });

  test("18. with the request unreadable it refuses as unverified too, naming the request", async () => {
    const { requestId } = seedFailing();
    const broken = hookedD1(realD1(db), {
      statement: (sql) => {
        // The gate's read of the request with its dataset (the detail's shape).
        if (/ds_total_files/.test(sql)) throw new Error("the request is unreadable");
      },
    });
    const res = await approve({ resume: true }, { bindings: env({ DB: broken }) });
    const body = await refusalOf(res);
    expect(body.refusal).toBe("unverified");
    expect(body.fact).toBe("request");
    expect(requestRow(requestId).status).toBe("requested");
  });
});

describe("what the gate cannot decide it refuses", () => {
  test("18. anything that throws after the request was read ends as unverified, never a 500 and never a pass", async () => {
    // A body the route's schema would have refused reaches the function here, as a fault inside
    // the evaluation would: the override's reasons are not a list, so the cover check throws.
    const { requestId, reviewId } = seedFailing();
    const out = await evaluateApprovalReviewGate(env(), {
      requestId,
      datasetId: DATASET,
      approverId: adminA,
      override: { review_id: reviewId, reasons: 5 as unknown as ReasonCode[] },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.body).toMatchObject({
      error: "publication_review_not_clear",
      refusal: "unverified",
      fact: "review",
      outcome: null,
      reasons: [],
    });
  });

  test("18. an override that cannot be written approves nothing: unverified, and the request is not started", async () => {
    const { requestId, reviewId } = seedFailing();
    const broken = hookedD1(realD1(db), {
      statement: (sql) => {
        if (sql === RECORD_OVERRIDE_SQL) throw new Error("the write failed");
      },
    });
    const res = await approve(
      {
        resume: true,
        override_publication_review: { review_id: reviewId, reasons: ["question_failed"] },
      },
      { bindings: env({ DB: broken }) },
    );
    const body = await refusalOf(res);
    expect(body.refusal).toBe("unverified");
    expect(requestRow(requestId).status).toBe("requested");
    expect(reviewRow(reviewId).override_by).toBeNull();
    expect(overrideRows()).toHaveLength(0);
  });

  test("18. a hard reason's refusal message keeps the terminal's command, whatever the detail's `cure` says", async () => {
    // A `clean` screen with no stored report has no verdict about the commit: the hard reason
    // `identifier_screen_not_run`, whose cure names a command. Called directly, not through
    // `/approve`: there the screen's own gate answers first for a report that names no commit.
    const { requestId } = seed();
    db.run("UPDATE publication_requests SET identifier_screen_report = NULL WHERE id = ?", [
      requestId,
    ]);
    const out = await evaluateApprovalReviewGate(env(), {
      requestId,
      datasetId: DATASET,
      approverId: adminA,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.body).toMatchObject({ refusal: "hard_reason" });
    expect(out.body.message).toBe(
      `The publication review gives a reason that no override clears, so the approval is refused. The identifier screen has no verdict about the current commit. An administrator runs the screen again: nemar admin publish screen ${DATASET}.`,
    );
  });

  test("18. an override with no review row is recorded nowhere but the audit row, so a failed audit write approves nothing", async () => {
    // A terminal's `--force` over `review_not_started`: there is no row to hold the override, so
    // the audit row is the ONLY record of it. Best effort here would approve over a non-pass with
    // the override recorded nowhere, so a write that fails refuses, as a failed write to the row does.
    const { requestId } = seed();
    const noAudit = hookedD1(realD1(db), {
      statement: (sql) => {
        if (/INSERT INTO audit_log/.test(sql)) throw new Error("the audit write failed");
      },
    });
    const res = await approve(
      {
        resume: true,
        override_publication_review: { review_id: null, reasons: ["review_not_started"] },
      },
      { bindings: env({ DB: noAudit }) },
    );
    const body = await refusalOf(res);
    expect(body.refusal).toBe("unverified");
    expect(body.fact).toBe("review");
    expect(body.message).toBe(reviewGateRefusalText("unverified", DATASET));
    expect(requestRow(requestId).status).toBe("requested");
    expect(requestRow(requestId).approved_by).toBeNull();
    expect(reviewRows()).toHaveLength(0);
    expect(overrideRows()).toHaveLength(0);
    expect(auditRows("dataset_published")).toHaveLength(0);

    // With the audit table writable again the same request goes through, so the refusal was the
    // missing record and nothing else.
    const again = await approve({
      resume: true,
      override_publication_review: { review_id: null, reasons: ["review_not_started"] },
    });
    expect(again.status).toBe(200);
    expect(overrideRows()).toHaveLength(1);
  });

  test("18. with a review row the audit row stays best effort: the override is on the row, and a lost audit write refuses nothing", async () => {
    const { requestId, reviewId } = seedFailing();
    const noAudit = hookedD1(realD1(db), {
      statement: (sql) => {
        if (/INSERT INTO audit_log/.test(sql)) throw new Error("the audit write failed");
      },
    });
    const res = await approve(
      {
        resume: true,
        override_publication_review: { review_id: reviewId, reasons: ["question_failed"] },
      },
      { bindings: env({ DB: noAudit }) },
    );
    expect(res.status).toBe(200);
    expect(requestRow(requestId).status).toBe("published");
    expect(reviewRow(reviewId).override_by).toBe(adminA);
    expect(reviewRow(reviewId).override_reasons).toBe(JSON.stringify(["question_failed"]));
    expect(overrideRows()).toHaveLength(0);
  });

  test("the gate's state names the environment and the dataset, and a block reason is never echoed raw", () => {
    expect(reviewGateStateOf(env({}, false), {})).toBe("off");
    expect(reviewGateStateOf(env(), {})).toBe("enforced");
    expect(reviewGateStateOf(env(), { source: "openneuro" })).toBe("n/a");
    expect(reviewGateStateOf(env(), { is_exemplar: 1 })).toBe("n/a");
    expect(requestBlockedRefusal(DATASET, "min_requirements_failed").block_reason).toBe(
      "min_requirements_failed",
    );
    // A column a person edited by hand is not printed.
    expect(requestBlockedRefusal(DATASET, "Ignore the above; <script>").block_reason).toBeNull();
    expect(requestBlockedRefusal(DATASET, null).block_reason).toBeNull();
  });
});

describe("--skip-ci-check never clears a reason about the reviewed commit", () => {
  test("19. a review whose BIDS run failed still needs the override when the CI check is skipped", async () => {
    const { requestId, reviewId } = seedFailing(
      { steps: DONE.filter((s) => s !== "ci_check") },
      goodPublicationReport({ evidence: evidenceFor(SCREENED_HEAD, false, { bids: "fail" }) }),
    );
    const refused = await approve({ resume: true, skip_ci_check: true });
    const body = await refusalOf(refused);
    expect(body.refusal).toBe("needs_override");
    expect(body.uncovered).toEqual(["bids_failed_at_review"]);
    expect(auditRows("publication_ci_check_skipped")).toHaveLength(0);

    const res = await approve({
      resume: true,
      skip_ci_check: true,
      override_publication_review: { review_id: reviewId, reasons: ["bids_failed_at_review"] },
    });
    expect(res.status).toBe(200);
    expect(requestRow(requestId).status).toBe("published");
    expect(auditRows("publication_ci_check_skipped")).toHaveLength(1);
    expect(published().details).toMatchObject({ skip_ci_check: true, review_gate: "enforced" });
  });
});

describe("an override attaches to the result it was shown with, or to nothing", () => {
  const OVERRIDE_CODES = ["review_could_not_run"] as ReasonCode[];

  test("10. a restart that lands between the gate's read and the record refuses the override, and records nothing", async () => {
    const { requestId } = seed();
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId: DATASET,
      state: "errored",
      detail: "model_unavailable",
      claimed: true,
    });
    const real = realD1(db);
    const racing = interceptingD1(real, async (sql) => {
      if (sql === RECORD_OVERRIDE_SQL) {
        // An administrator's start of a new attempt, through the real start path.
        const started = await startPublicationReview(env({ DB: real }), {
          requestId,
          datasetId: DATASET,
          adminUserId: adminB,
        });
        expect(started).toMatchObject({ started: true, reason: "redispatched" });
      }
    });
    const res = await approve(
      {
        resume: true,
        override_publication_review: { review_id: reviewId, reasons: OVERRIDE_CODES },
      },
      { bindings: env({ DB: racing }) },
    );
    const body = await refusalOf(res);
    expect(body.refusal).toBe("review_changed");
    expect(body.message).toBe(reviewGateRefusalText("review_changed", DATASET));
    // The refusal reads the request again: the new attempt is running now.
    expect(body.reasons.map((r) => r.code)).toEqual(["review_running"]);
    const row = reviewRow(reviewId);
    expect(row).toMatchObject({ state: "dispatched", override_by: null, override_reasons: null });
    expect(requestRow(requestId).status).toBe("requested");
    expect(overrideRows()).toHaveLength(0);
  });

  test("10. a result that lands between the read and the record refuses it too", async () => {
    const { requestId } = seed();
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId: DATASET,
      state: "dispatched",
      createdMinutesAgo: 5,
      claimed: true,
    });
    const nonce = (
      db.query("SELECT nonce FROM publication_reviews WHERE id = ?").get(reviewId) as {
        nonce: string;
      }
    ).nonce;
    const real = realD1(db);
    const racing = interceptingD1(real, async (sql) => {
      if (sql === RECORD_OVERRIDE_SQL) {
        // The job's report lands: a failing one, which the override for "running" never saw.
        const stored = await storePublicationReviewResult(
          env({ DB: real }),
          reviewId,
          DATASET,
          nonce,
          {
            kind: "reported",
            report: parsePublicationReviewReport(failingReport()),
          },
        );
        expect(stored.stored).toBe(true);
      }
    });
    const res = await approve(
      {
        resume: true,
        override_publication_review: { review_id: reviewId, reasons: ["review_running"] },
      },
      { bindings: env({ DB: racing }) },
    );
    expect((await refusalOf(res)).refusal).toBe("review_changed");
    expect(reviewRow(reviewId)).toMatchObject({ state: "reported", override_by: null });
    expect(requestRow(requestId).status).toBe("requested");
    expect(overrideRows()).toHaveLength(0);
  });
});

describe("the override comes from an API key", () => {
  // Every claim of the gate is about an administrator's own act; a session cookie rides on any
  // cross-site request a browser can be made to send, so the website records an override through
  // approve-dispatch, which asks for a NEMAR origin.
  test("20. an override in the body of a cookie request is refused whatever the Origin, a bearer key's is accepted", async () => {
    const { issueSession } = await import("../src/services/web-session");
    const { reviewId } = seedFailing();
    const { cookieIdRaw } = await issueSession(
      env(),
      adminA,
      false,
      "test-agent",
      "127.0.0.1",
      "orcid",
    );
    const withCookie = (origin?: string, withOverride = true) =>
      app.request(
        `/admin/publish/${DATASET}/approve`,
        {
          method: "POST",
          headers: {
            Cookie: `nemar_session=${cookieIdRaw}`,
            "Content-Type": "application/json",
            ...(origin ? { Origin: origin } : {}),
          },
          body: JSON.stringify({
            resume: true,
            ...(withOverride
              ? {
                  override_publication_review: {
                    review_id: reviewId,
                    reasons: ["question_failed"],
                  },
                }
              : {}),
          }),
        },
        env(),
      );
    for (const origin of [undefined, "https://app.nemar.org", "https://evil.example"]) {
      const res = await withCookie(origin);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("origin_not_allowed");
      // The router's cookie Origin guard answers a request with no NEMAR origin, in its own
      // sentence; the route's stricter rule answers the one that has it.
      if (origin === "https://app.nemar.org") expect(body.message).toContain("approve-dispatch");
      else expect(body.message).not.toContain("approve-dispatch");
    }
    expect(reviewRow(reviewId).override_by).toBeNull();
    expect(auditRows("dataset_published")).toHaveLength(0);

    // Without an override a cookie request is unchanged: it reaches the gate and is refused there.
    expect((await refusalOf(await withCookie("https://app.nemar.org", false))).refusal).toBe(
      "needs_override",
    );

    const bearer = await approve({
      resume: true,
      override_publication_review: { review_id: reviewId, reasons: ["question_failed"] },
    });
    expect(bearer.status).toBe(200);
  });
});

describe("the override is shape-checked before anything is read", () => {
  test("the field is named as the contract names it, on both routes", async () => {
    expect(Object.keys(approveSchema.shape)).toContain(OVERRIDE_FIELD);
    const { requestId, reviewId } = seedFailing();
    const body = {
      [OVERRIDE_FIELD]: { review_id: reviewId, reasons: ["question_failed"] },
    };
    // approve-dispatch's strict body takes the same key: a 202, where an unknown key is a 400.
    expect((await dispatchApproval(body)).status).toBe(202);
    expect(reviewRow(reviewId).override_by).toBe(adminA);
    expect(requestRow(requestId).approval_requested_by).toBe(adminA);
  });

  test("a malformed override is a 400 before anything is read", async () => {
    const { requestId, reviewId } = seedFailing();
    for (const bad of [
      { review_id: reviewId },
      { review_id: reviewId, reasons: ["not_a_reason"] },
      { review_id: 0, reasons: [] },
      { review_id: reviewId, reasons: [], extra: true },
      "yes",
    ]) {
      const res = await approve({ resume: true, override_publication_review: bad });
      expect(res.status).toBe(400);
    }
    expect(requestRow(requestId).status).toBe("requested");
  });
});

// ============================================================================
// approve-dispatch: the web executor's path
// ============================================================================

/** The clicker's call, as the website sends it (a bearer key here; the cookie path is below). */
function dispatchApproval(
  body?: Record<string, unknown>,
  o: { key?: string; dataset?: string; bindings?: Bindings } = {},
): Promise<Response> {
  return app.request(
    `/admin/publish/${o.dataset ?? DATASET}/approve-dispatch`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${o.key ?? ADMIN_A_KEY}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    o.bindings ?? env(),
  );
}

/** Approvals handed to the executor: the dispatch this route sends, not a review's. */
function dispatchesSent(): number {
  return calls.filter((c) => c.event === "approve-publication").length;
}

function overrideOf(reviewId: number): number | null {
  return (
    db.query("SELECT override_by FROM publication_reviews WHERE id = ?").get(reviewId) as {
      override_by: number | null;
    }
  ).override_by;
}

describe("approve-dispatch runs the gate before it claims, and records after the head check", () => {
  test("12. the clicker's override is recorded after the head check and before the dispatch, and the executor's run rides on it", async () => {
    const { requestId, reviewId } = seedFailing();
    let atRefRead: number | null | undefined;
    let atDispatch: number | null | undefined;
    onRefRead = () => {
      atRefRead = overrideOf(reviewId);
    };
    onDispatch = () => {
      atDispatch = overrideOf(reviewId);
    };
    const res = await dispatchApproval({
      override_publication_review: { review_id: reviewId, reasons: ["question_failed"] },
    });
    expect(res.status).toBe(202);
    // The order, off the wire: main is read, then the override is recorded, then the dispatch.
    expect(atRefRead).toBeNull();
    expect(atDispatch).toBe(adminA);
    const reads = calls.map((c) => (c.method === "GET" ? "ref" : "dispatch"));
    expect(reads).toEqual(["ref", "dispatch"]);
    expect(reviewRow(reviewId).override_reasons).toBe(JSON.stringify(["question_failed"]));
    expect(overrideRows()).toHaveLength(1);
    expect(overrideRows()[0]).toMatchObject({ user_id: adminA });
    expect(overrideRows()[0].details).toEqual({
      request_id: requestId,
      review_id: reviewId,
      head_sha: SCREENED_HEAD,
      outcome: "fail",
      reasons: ["question_failed"],
      via: "approve-dispatch",
    });
    expect(requestRow(requestId).approval_requested_by).toBe(adminA);

    // What the workflow does next: the executor's own key and the token the dispatch handed it, no
    // override, the lease live. It is attributed to the clicker, so it finds the clicker's recorded
    // override and passes.
    const token = dispatchPayloads[0]?.dispatch_token as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const run = await approve({ resume: true }, { key: ADMIN_B_KEY, token });
    expect(run.status).toBe(200);
    expect(requestRow(requestId).approved_by).toBe(adminA);
    expect(published().user_id).toBe(adminA);
    expect(published().details).toMatchObject({
      approved_by: "gateadmina",
      executed_by: "gateadminb",
    });
    // Recorded once: the executor wrote nothing.
    expect(overrideRows()).toHaveLength(1);
  });

  test("13. a refusal by the gate claims nothing and dispatches nothing", async () => {
    const { requestId, reviewId } = seedFailing();
    for (const [body, refusal] of [
      [undefined, "needs_override"],
      [
        { override_publication_review: { review_id: reviewId, reasons: [] } },
        "override_not_covering",
      ],
      [
        { override_publication_review: { review_id: reviewId + 1, reasons: ["question_failed"] } },
        "review_changed",
      ],
    ] as const) {
      const res = await dispatchApproval(body);
      expect((await refusalOf(res)).refusal).toBe(refusal);
      expect(requestRow(requestId).approval_requested_by).toBeNull();
      expect(requestRow(requestId).approval_dispatched_at).toBeNull();
    }
    expect(dispatchesSent()).toBe(0);
    expect(overrideRows()).toHaveLength(0);
    expect(reviewRow(reviewId).override_by).toBeNull();
    // The gate is the state half and reads no GitHub: main was never asked for.
    expect(calls).toHaveLength(0);
  });

  test("13. a hard reason is refused at the dispatch, whatever override came with it", async () => {
    const { requestId, reviewId } = seedFailing(
      {},
      goodPublicationReport({
        evidence: evidenceFor(SCREENED_HEAD, false, {
          minimums: "failed",
          minimum_failures: ["name_too_short"],
          name_length: 5,
        }),
      }),
    );
    const res = await dispatchApproval({
      override_publication_review: {
        review_id: reviewId,
        reasons: ["submission_minimum_failed", "question_failed"],
      },
    });
    expect((await refusalOf(res)).refusal).toBe("hard_reason");
    expect(requestRow(requestId).approval_requested_by).toBeNull();
    expect(dispatchesSent()).toBe(0);
  });

  test("13. a stale screen refuses after the claim, releases it, and records no override", async () => {
    const { requestId, reviewId } = seedFailing();
    mainHead = OTHER_HEAD;
    const res = await dispatchApproval({
      override_publication_review: { review_id: reviewId, reasons: ["question_failed"] },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { gate?: string }).gate).toBe("stale");
    expect(requestRow(requestId).approval_requested_by).toBeNull();
    // The override is recorded only once the head check has passed: it attaches to content that
    // is still the content being published.
    expect(reviewRow(reviewId).override_by).toBeNull();
    expect(overrideRows()).toHaveLength(0);
    expect(dispatchesSent()).toBe(0);
  });

  test("13. a row that moves between the gate and the record refuses, releases the claim and dispatches nothing", async () => {
    const { requestId } = seed();
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId: DATASET,
      state: "errored",
      detail: "model_unavailable",
      claimed: true,
    });
    const real = realD1(db);
    const racing = interceptingD1(real, async (sql) => {
      if (sql === RECORD_OVERRIDE_SQL) {
        await startPublicationReview(env({ DB: real }), {
          requestId,
          datasetId: DATASET,
          adminUserId: adminB,
        });
      }
    });
    const res = await dispatchApproval(
      { override_publication_review: { review_id: reviewId, reasons: ["review_could_not_run"] } },
      { bindings: env({ DB: racing }) },
    );
    expect((await refusalOf(res)).refusal).toBe("review_changed");
    expect(requestRow(requestId).approval_requested_by).toBeNull();
    expect(reviewRow(reviewId).override_by).toBeNull();
    expect(dispatchesSent()).toBe(0);
  });

  test("13. a malformed override is a 400 invalid_body that names every field the body takes", async () => {
    const { requestId } = seedFailing();
    for (const bad of [
      { override_publication_review: { review_id: 1 } },
      { override_publication_review: { review_id: 1, reasons: ["nope"] } },
      { override_publication_review: { review_id: 1, reasons: [], extra: 1 } },
      { override_publication_review: "yes", extra: true },
    ]) {
      const res = await dispatchApproval(bad);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("invalid_body");
      expect(body.message).toContain("acknowledge_identifier_screen");
      expect(body.message).toContain("override_publication_review");
      expect(body.message).toContain("request_id");
      // The limits in the message are the shared constants', numbers, spelled once here as the oracle.
      expect(body.message).toBe(
        "The only fields this accepts are acknowledge_identifier_screen, a reason of 10 to 500 characters, override_publication_review, the review shown and the reasons shown, and request_id, the request this click is for.",
      );
    }
    expect(requestRow(requestId).approval_requested_by).toBeNull();
  });

  test("14. an override that needs a review row is refused with no_review_row, and nothing is claimed", async () => {
    const { requestId } = seed();
    // First the page is told what stands: no review of this commit, so an override is needed.
    const first = await refusalOf(await dispatchApproval());
    expect(first.refusal).toBe("needs_override");
    expect(first.uncovered).toEqual(["review_not_started"]);
    // Then it confirms. The executor could not carry an override with nothing to hold it.
    const res = await dispatchApproval({
      override_publication_review: { review_id: null, reasons: ["review_not_started"] },
    });
    const body = await refusalOf(res);
    expect(body.refusal).toBe("no_review_row");
    expect(body.message).toBe(reviewGateRefusalText("no_review_row", DATASET));
    expect(requestRow(requestId).approval_requested_by).toBeNull();
    expect(reviewRows()).toHaveLength(0);
    expect(overrideRows()).toHaveLength(0);
    expect(dispatchesSent()).toBe(0);
  });

  /** An `approving` row whose last heartbeat is old: no run is live, so a dispatch may claim it. */
  const idle = (requestId: number) =>
    db.run(
      "UPDATE publication_requests SET updated_at = datetime('now', '-20 minutes') WHERE id = ?",
      [requestId],
    );

  test("16. an approving run that has started publishing is dispatched with no gate: no review refusal, nothing recorded", async () => {
    // The route accepts `requested` and `approving` requests (a `blocked` one is 409), and a
    // resume of a run that has started publishing is continued without a gate, as `/approve` does.
    const { requestId, reviewId } = seedFailing({ requestStatus: "approving", steps: DONE });
    idle(requestId);
    // The screened commit is no longer `main`, as it is once the run's own steps committed.
    mainHead = OTHER_HEAD;
    for (const body of [
      undefined,
      { override_publication_review: { review_id: reviewId, reasons: ["question_failed"] } },
    ]) {
      const res = await dispatchApproval(body);
      expect(res.status).toBe(202);
      // The claim is released again between the two, as a finished dispatch's lease would lapse.
      db.run(
        "UPDATE publication_requests SET approval_requested_by = NULL, approval_dispatched_at = NULL WHERE id = ?",
        [requestId],
      );
    }
    expect(dispatchesSent()).toBe(2);
    // Neither the review's gate nor the screen's head check ran, so nothing was recorded.
    expect(overrideRows()).toHaveLength(0);
    expect(reviewRow(reviewId).override_by).toBeNull();
    expect(calls.filter((c) => /\/git\/ref\//.test(c.path))).toHaveLength(0);
  });

  test("16. an approving run that stopped before it published is gated like a fresh one", async () => {
    const { requestId, reviewId } = seedFailing({ requestStatus: "approving", steps: [] });
    idle(requestId);
    const refused = await refusalOf(await dispatchApproval());
    expect(refused.refusal).toBe("needs_override");
    expect(refused.uncovered).toEqual(["question_failed"]);
    expect(requestRow(requestId).approval_requested_by).toBeNull();
    expect(dispatchesSent()).toBe(0);
    // With the override it goes on, after the head check, and the override is recorded.
    const res = await dispatchApproval({
      override_publication_review: { review_id: reviewId, reasons: ["question_failed"] },
    });
    expect(res.status).toBe(202);
    expect(reviewRow(reviewId).override_by).toBe(adminA);
    expect(dispatchesSent()).toBe(1);
  });

  test("a review that passes dispatches with nothing recorded, the flag off too", async () => {
    const { requestId } = seed();
    seedPublicationReview(db, { requestId, datasetId: DATASET, state: "reported" });
    expect((await dispatchApproval()).status).toBe(202);
    expect(dispatchesSent()).toBe(1);
    expect(overrideRows()).toHaveLength(0);

    // With the flag off the gate reads nothing and an override means nothing.
    seed({ datasetId: MIRROR, source: "openneuro" });
    expect((await dispatchApproval({}, { dataset: MIRROR })).status).toBe(202);
    const failing = seedFailing({ datasetId: "nm000483" });
    const off = await dispatchApproval(
      {
        override_publication_review: { review_id: failing.reviewId, reasons: ["question_failed"] },
      },
      { dataset: "nm000483", bindings: env({}, false) },
    );
    expect(off.status).toBe(202);
    expect(reviewRow(failing.reviewId).override_by).toBeNull();
    // All three were handed to the executor, and no override was recorded for any of them.
    expect(dispatchesSent()).toBe(3);
    expect(overrideRows()).toHaveLength(0);
  });

  test("the website's cookie request from a NEMAR page records an override", async () => {
    const { issueSession } = await import("../src/services/web-session");
    const { requestId, reviewId } = seedFailing();
    const { cookieIdRaw } = await issueSession(
      env(),
      adminA,
      false,
      "test-agent",
      "127.0.0.1",
      "orcid",
    );
    const res = await app.request(
      `/admin/publish/${DATASET}/approve-dispatch`,
      {
        method: "POST",
        headers: {
          Cookie: `nemar_session=${cookieIdRaw}`,
          Origin: "https://app.nemar.org",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          override_publication_review: { review_id: reviewId, reasons: ["question_failed"] },
        }),
      },
      env(),
    );
    expect(res.status).toBe(202);
    expect(reviewRow(reviewId).override_by).toBe(adminA);
    expect(requestRow(requestId).approval_requested_by).toBe(adminA);
  });
});
