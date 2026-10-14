/**
 * What an administrator reads about a publication review (ADR 0102, section 8), through the real
 * `/admin` router: `GET /admin/publish/requests` (each row gains `publication_review`) and
 * `GET /admin/publish/:id/review` (the detail, with history).
 *
 * The outcome shown is re-derived now from the stored report and the live facts, and is the
 * stricter of the stored verdict and the re-derived one: either can lower it and neither can raise
 * it. Nothing a viewer reads carries a nonce, and the model's own words (its summary and the notes
 * of its findings) appear in the detail response and nowhere else.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the real auth
 * middleware with a bearer key, review rows seeded through the production parser
 * (`helpers/publication-review.ts`). No stand-in answers anything here.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import type {
  PublicationReviewDetail,
  PublicationReviewGateRefusalBody,
  PublicationReviewSummary,
} from "../../shared/contract/publication-review-admin";
import {
  APPROVAL_PUBLISHING_LINE,
  APPROVAL_STOPPED_HARD_LINE,
  NOT_ASSESSED_LINE,
  REASONS,
  REASON_CODES,
  REVIEW_OVERDUE_VIEW_MINUTES,
  REVIEW_UNREADABLE_HEADLINE,
  type ReasonCode,
  shownBlockReason,
} from "../../shared/publication-review";
import { PUBLICATION_STEPS } from "../../shared/publication-steps";
import { adminRoutes } from "../src/routes/admin";
import { isScreenExempt, recordScreenAcknowledgment } from "../src/services/identifier-screen";
import { isScreenExempt as storedIsScreenExempt } from "../src/services/identifier-screen-stored";
import {
  HISTORY_LIMIT,
  LIST_CONCURRENCY,
  derivePublicationReview,
  overrideReasonsOf,
  readReviewContext,
  reasonViewsOf,
  reportOf,
} from "../src/services/publication-review-view";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, interceptingD1, realD1 } from "./helpers/d1";
import { SCREENED_HEAD } from "./helpers/identifier-screen";
import { logged } from "./helpers/logs";
import {
  NOTE_SENTINEL,
  SUMMARY_SENTINEL,
  type SeedReview,
  type SeedScreenedRequest,
  evidenceFor,
  failingReport,
  goodPublicationReport,
  seedPublicationReview,
  seedScreenedRequest,
  seedUser,
  setOverride,
} from "./helpers/publication-review";

const ADMIN_KEY = "review-admin-key-0123456789abcdef0123456789abcdef";
const MEMBER_KEY = "review-member-key-0123456789abcdef0123456789abcd";
const OTHER_HEAD = "f".repeat(40);
const NONCE_SENTINEL = "NONCE-SENTINEL-0123456789abcdef";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let counter = 0;

beforeEach(async () => {
  db = freshDb();
  counter = 0;
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedUser(db, "reviewadmin", "admin", ADMIN_KEY);
  await seedUser(db, "reviewmember", "member", MEMBER_KEY);
});

function env(over: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    PUBLICATION_REVIEW_ENABLED: "1",
    ...over,
  } as Bindings;
}

function nextDataset(): string {
  counter += 1;
  return `nm0007${String(counter).padStart(2, "0")}`;
}

/** A native request whose screen reported (clean, at SCREENED_HEAD) unless told otherwise. */
function request(over: Partial<SeedScreenedRequest> = {}) {
  const datasetId = over.datasetId ?? nextDataset();
  const { requestId } = seedScreenedRequest(db, { ...over, datasetId });
  return { requestId, datasetId };
}

function get(path: string, key = ADMIN_KEY, bindings: Bindings = env()) {
  return app.request(path, { headers: { Authorization: `Bearer ${key}` } }, bindings);
}

type ListRow = Record<string, unknown> & {
  dataset_id: string;
  status: string;
  publication_review: PublicationReviewSummary;
};

async function listBody(bindings: Bindings = env()): Promise<{ text: string; rows: ListRow[] }> {
  const res = await get("/admin/publish/requests", ADMIN_KEY, bindings);
  expect(res.status).toBe(200);
  const text = await res.text();
  return { text, rows: (JSON.parse(text) as { requests: ListRow[] }).requests };
}

/** The review of the dataset's active request in the list (the newest one still open, else the newest). */
async function review(datasetId: string, bindings: Bindings = env()) {
  const { rows } = await listBody(bindings);
  const mine = rows.filter((r) => r.dataset_id === datasetId);
  expect(mine.length).toBeGreaterThan(0);
  const open = mine.find((r) => ["requested", "approving", "blocked"].includes(r.status as string));
  return (open ?? mine[0]).publication_review;
}

async function detail(datasetId: string, bindings: Bindings = env()) {
  const res = await get(`/admin/publish/${datasetId}/review`, ADMIN_KEY, bindings);
  expect(res.status).toBe(200);
  return (await res.json()) as PublicationReviewDetail;
}

function addVersionRow(datasetId: string, version = "1.0.0") {
  db.run("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, ?, ?)", [
    datasetId,
    version,
    "10.82901/nm.test",
  ]);
}

/** The steps of an approval that has started publishing: one outside the validation-only ones is done. */
const PUBLISHING_STEPS = JSON.stringify(["ci_check", "enrichment_check", "s3_public_read"]);

function startPublishing(requestId: number): void {
  db.run("UPDATE publication_requests SET steps_completed = ? WHERE id = ?", [
    PUBLISHING_STEPS,
    requestId,
  ]);
}

// ============================================================================

describe("GET /admin/publish/requests: the review of each request", () => {
  test("a mirror and an exemplar are not applicable: no row is read and no outcome is claimed", async () => {
    const mirror = request({ source: "openneuro" });
    const exemplar = request({ isExemplar: 1 });
    for (const { datasetId } of [mirror, exemplar]) {
      expect(await review(datasetId)).toEqual({
        kind: "not_applicable",
        enabled: true,
        gate: "n/a",
        outcome: null,
        headline: "Publication review: not applicable",
        tone: "note",
        reasons: [],
        start_offered: false,
        review_id: null,
        head_sha: null,
      });
    }
  });

  test("with the review off the row says off, gates nothing and is never a pass", async () => {
    const { datasetId } = request();
    const off = await review(datasetId, env({ PUBLICATION_REVIEW_ENABLED: undefined }));
    expect(off.kind).toBe("off");
    expect(off.enabled).toBe(false);
    expect(off.gate).toBe("off");
    expect(off.headline).toBe("Publication review: not reviewed (the automated review is off)");
    // Not assessed: no outcome and no reason, as for a mirror, so a client that renders `outcome`
    // cannot contradict the headline.
    expect(off.outcome).toBeNull();
    expect(off.reasons).toEqual([]);
    // Exactly "1" turns it on: nothing else does.
    for (const flag of ["0", "true", "yes", " 1", "1 "]) {
      expect((await review(datasetId, env({ PUBLICATION_REVIEW_ENABLED: flag }))).kind).toBe("off");
    }
  });

  test("a request that is over and has no review on record is not assessed: no outcome, no reason", async () => {
    // A published or denied request that predates the review has nothing to be "action required"
    // about, and the headline says "not reviewed", so the outcome must not say otherwise.
    for (const requestStatus of ["published", "denied"] as const) {
      const { datasetId } = request({ requestStatus });
      expect(await review(datasetId)).toEqual({
        kind: "not_reviewed",
        enabled: true,
        gate: "enforced",
        outcome: null,
        headline: "Publication review: not reviewed (the request is closed)",
        tone: "note",
        reasons: [],
        start_offered: false,
        review_id: null,
        head_sha: null,
      });
    }
    // The same request, still open, IS assessed: the missing review is its reason.
    const open = request();
    expect(await review(open.datasetId)).toMatchObject({
      outcome: "action_required",
      reasons: ["review_not_started"],
    });
  });

  test("with the review off the detail of a request with no review has no outcome and no reason either", async () => {
    const { datasetId } = request();
    const d = await detail(datasetId, env({ PUBLICATION_REVIEW_ENABLED: undefined }));
    expect(d).toMatchObject({
      enabled: false,
      gate: "off",
      outcome: null,
      reasons: [],
      review: null,
    });
  });

  test("a stored review is still shown with the review off, as advice that gates nothing", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    const r = await review(datasetId, env({ PUBLICATION_REVIEW_ENABLED: undefined }));
    expect(r.kind).toBe("off");
    expect(r.gate).toBe("off");
    expect(r.headline).toBe("Publication review (advice only, the automated review is off): pass");
    expect(r.review_id).not.toBeNull();
  });

  test("a clear screen with no review is not reviewed: action required, never a pass", async () => {
    const { datasetId } = request();
    expect(await review(datasetId)).toMatchObject({
      kind: "not_reviewed",
      enabled: true,
      gate: "enforced",
      outcome: "action_required",
      reasons: ["review_not_started"],
      review_id: null,
      head_sha: null,
    });
  });

  test("a young dispatched review is running; the same row past the view's bound did not report", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, { requestId, datasetId, state: "dispatched", createdMinutesAgo: 5 });
    const running = await review(datasetId);
    expect(running).toMatchObject({
      kind: "running",
      outcome: "action_required",
      reasons: ["review_running"],
      head_sha: SCREENED_HEAD,
    });
    expect(running.review_id).not.toBeNull();

    // The dev Worker runs no watchdog, so age alone must say it: the deadline plus one tick.
    db.run("UPDATE publication_reviews SET created_at = datetime('now', ?)", [
      `-${REVIEW_OVERDUE_VIEW_MINUTES - 5} minutes`,
    ]);
    expect((await review(datasetId)).reasons).toEqual(["review_running"]);
    db.run("UPDATE publication_reviews SET created_at = datetime('now', ?)", [
      `-${REVIEW_OVERDUE_VIEW_MINUTES + 1} minutes`,
    ]);
    expect(await review(datasetId)).toMatchObject({
      kind: "decided",
      outcome: "action_required",
      reasons: ["review_did_not_report"],
    });
  });

  test("a reported pass over a clear screen and no live fact is a pass", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    expect(await review(datasetId)).toMatchObject({
      kind: "decided",
      gate: "enforced",
      outcome: "pass",
      headline: "Publication review: pass",
      tone: "ok",
      reasons: [],
    });
  });

  test("each way a review ends without a report reads as a reason, never a pass", async () => {
    const cases: Array<[Omit<SeedReview, "requestId" | "datasetId">, string]> = [
      [{ state: "errored", detail: "model_refused" }, "review_could_not_run"],
      [{ state: "declined", detail: "platform_limit" }, "review_limit_reached"],
      [{ state: "unreported" }, "review_did_not_report"],
    ];
    for (const [seed, code] of cases) {
      const { requestId, datasetId } = request();
      seedPublicationReview(db, { ...seed, requestId, datasetId });
      const r = await review(datasetId);
      expect(r.kind).toBe("decided");
      expect(r.outcome).toBe("action_required");
      expect(r.reasons).toEqual([code as ReasonCode]);
    }
  });

  test("a screen that needs an acknowledgment adds its reason, which a clean review does not clear", async () => {
    const { requestId, datasetId } = request({ status: "review" });
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    expect(await review(datasetId)).toMatchObject({
      outcome: "action_required",
      reasons: ["identifier_screen_needs_acknowledgment"],
    });
  });

  test("a screen that blocks, waits or has no verdict gives its own reason and starts no review", async () => {
    const waiting = request({ status: "pending" });
    const blocked = request({
      status: "direct-identifiers",
      requestStatus: "blocked",
      blockReason: "identifier_screen_findings",
    });
    const errored = request({ status: "error" });
    expect((await review(waiting.datasetId)).reasons).toEqual(["identifier_screen_pending"]);
    expect((await review(blocked.datasetId)).reasons).toEqual([
      "request_blocked",
      "identifier_screen_blocks",
    ]);
    expect((await review(errored.datasetId)).reasons).toEqual(["identifier_screen_not_run"]);
    for (const d of [waiting, blocked, errored]) {
      expect((await review(d.datasetId)).outcome).not.toBe("pass");
    }
  });

  test("a version row for the reviewed version lowers a stored pass to fail", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    expect((await review(datasetId)).outcome).toBe("pass");
    addVersionRow(datasetId);
    expect(await review(datasetId)).toMatchObject({
      outcome: "fail",
      reasons: ["version_already_released"],
    });
  });

  test("a version row of another version does not", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    addVersionRow(datasetId, "0.9.0");
    expect((await review(datasetId)).outcome).toBe("pass");
  });

  test("a named request after an anonymous release that keeps its version is a hard fail", async () => {
    const datasetId = nextDataset();
    // The earlier anonymous request, and the version row its release left behind.
    request({ datasetId, anonymous: true, requestStatus: "published" });
    const { requestId } = request({ datasetId });
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    addVersionRow(datasetId);
    const r = await review(datasetId);
    expect(r.outcome).toBe("fail");
    expect(r.reasons).toEqual(["version_kept_after_anonymous_release"]);
  });

  test("the same version after a NAMED release is the ordinary 'already released'", async () => {
    const datasetId = nextDataset();
    request({ datasetId, requestStatus: "published" });
    const { requestId } = request({ datasetId });
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    addVersionRow(datasetId);
    expect((await review(datasetId)).reasons).toEqual(["version_already_released"]);
  });

  test("a named request whose dataset was already published under a name is 'already released', even after an anonymous one", async () => {
    const datasetId = nextDataset();
    request({ datasetId, anonymous: true, requestStatus: "published" });
    const { requestId } = request({ datasetId });
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    addVersionRow(datasetId);
    db.run("UPDATE datasets SET first_published_at = datetime('now') WHERE dataset_id = ?", [
      datasetId,
    ]);
    expect((await review(datasetId)).reasons).toEqual(["version_already_released"]);
  });

  test("an anonymous release that reuses a version is the ordinary 'already released', not the hard one", async () => {
    const { requestId, datasetId } = request({ anonymous: true });
    seedPublicationReview(db, { requestId, datasetId, anonymous: true, state: "reported" });
    addVersionRow(datasetId);
    expect((await review(datasetId)).reasons).toEqual(["version_already_released"]);
  });

  // A review of a dataset whose description sets no Version: the orchestrator publishes
  // `Version || "1.0.0"`, so the live version checks look 1.0.0 up, as the approval will, and the
  // job looks up the tag `v1.0.0` too: only a Version that is malformed has no tag to look up.
  const noVersion = () =>
    goodPublicationReport({
      evidence: evidenceFor(SCREENED_HEAD, false, {
        version: null,
        version_shape: "missing",
        tag: "absent",
      }),
    });

  test("a request with no Version is published as 1.0.0, so a released 1.0.0 is a fail, not just a missing version", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, { requestId, datasetId, state: "reported", report: noVersion() });
    // Nothing released: only the overridable word.
    expect((await review(datasetId)).reasons).toEqual(["version_missing"]);
    addVersionRow(datasetId, "1.0.0");
    const r = await review(datasetId);
    expect(r.outcome).toBe("fail");
    expect(r.reasons).toEqual(["version_already_released", "version_missing"]);
    // A release of another version is not the one the approval would publish.
    db.run("DELETE FROM dataset_versions WHERE dataset_id = ?", [datasetId]);
    addVersionRow(datasetId, "2.0.0");
    expect((await review(datasetId)).reasons).toEqual(["version_missing"]);
  });

  test("a named request with no Version after an anonymous release at 1.0.0 is the hard reason", async () => {
    const datasetId = nextDataset();
    request({ datasetId, anonymous: true, requestStatus: "published" });
    const { requestId } = request({ datasetId });
    seedPublicationReview(db, { requestId, datasetId, state: "reported", report: noVersion() });
    addVersionRow(datasetId, "1.0.0");
    const r = await review(datasetId);
    expect(r.outcome).toBe("fail");
    expect(r.reasons).toEqual(["version_kept_after_anonymous_release", "version_missing"]);
    expect(
      (await detail(datasetId)).reasons.find(
        (x) => x.code === "version_kept_after_anonymous_release",
      ),
    ).toMatchObject({ class: "fail", cleared_by: "nothing" });
  });

  test("a malformed Version stays malformed and is not looked up", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, {
      requestId,
      datasetId,
      state: "reported",
      report: goodPublicationReport({
        evidence: evidenceFor(SCREENED_HEAD, false, {
          version: null,
          version_shape: "malformed",
          tag: "not_applicable",
        }),
      }),
    });
    addVersionRow(datasetId, "1.0.0");
    expect((await review(datasetId)).reasons).toEqual(["version_malformed"]);
  });

  test("a concept DOI no earlier anonymous release reserved is unexpected", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    db.run(
      "UPDATE datasets SET concept_doi = '10.82901/nm.concept', ezid_status = 'reserved' WHERE dataset_id = ?",
      [datasetId],
    );
    expect(await review(datasetId)).toMatchObject({
      outcome: "action_required",
      reasons: ["doi_state_unexpected"],
    });
  });

  test("the inverse: the DOI an earlier anonymous release left reserved is expected, a public one is not", async () => {
    const datasetId = nextDataset();
    request({ datasetId, anonymous: true, requestStatus: "published" });
    const { requestId } = request({ datasetId });
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    db.run(
      "UPDATE datasets SET concept_doi = '10.82901/nm.concept', ezid_status = 'reserved' WHERE dataset_id = ?",
      [datasetId],
    );
    expect((await review(datasetId)).reasons).toEqual([]);
    db.run("UPDATE datasets SET ezid_status = 'public' WHERE dataset_id = ?", [datasetId]);
    expect((await review(datasetId)).reasons).toEqual(["doi_state_unexpected"]);
  });

  test("a request is not its own predecessor: the first anonymous request's DOI is unexpected too", async () => {
    // Only EARLIER requests count. The anonymous request itself reserved nothing yet.
    const { requestId, datasetId } = request({ anonymous: true });
    seedPublicationReview(db, { requestId, datasetId, anonymous: true, state: "reported" });
    db.run(
      "UPDATE datasets SET concept_doi = '10.82901/nm.concept', ezid_status = 'reserved' WHERE dataset_id = ?",
      [datasetId],
    );
    expect((await review(datasetId)).reasons).toEqual(["doi_state_unexpected"]);
  });

  test("a review of another commit, or of the other kind of release, is history and never the outcome", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, { requestId, datasetId, head: OTHER_HEAD, state: "reported" });
    seedPublicationReview(db, { requestId, datasetId, anonymous: true, state: "reported" });
    expect(await review(datasetId)).toMatchObject({
      kind: "not_reviewed",
      outcome: "action_required",
      reasons: ["review_not_started"],
      review_id: null,
    });
  });

  test("the outcome is the stricter of the stored verdict and the one re-derived", async () => {
    // A stored fail over a report that no longer shows why: the column still lowers it.
    const failStored = request();
    seedPublicationReview(db, {
      requestId: failStored.requestId,
      datasetId: failStored.datasetId,
      state: "reported",
      verdict: "fail",
    });
    expect(await review(failStored.datasetId)).toMatchObject({
      outcome: "fail",
      reasons: ["stored_verdict_fail"],
    });

    // A stored pass over a report that fails: the stored column cannot raise it.
    const passStored = request();
    seedPublicationReview(db, {
      requestId: passStored.requestId,
      datasetId: passStored.datasetId,
      state: "reported",
      report: failingReport(),
      verdict: "pass",
    });
    expect(await review(passStored.datasetId)).toMatchObject({
      outcome: "fail",
      reasons: ["question_failed"],
    });

    // A stored action_required over a clean report is not a pass either.
    const needsPerson = request();
    seedPublicationReview(db, {
      requestId: needsPerson.requestId,
      datasetId: needsPerson.datasetId,
      state: "reported",
      verdict: "action_required",
    });
    expect(await review(needsPerson.datasetId)).toMatchObject({
      outcome: "action_required",
      reasons: ["review_could_not_run"],
    });
  });

  test("a stored report that no longer parses could not be read back: never a pass, and a stored fail stays a fail", async () => {
    const junkPass = request();
    seedPublicationReview(db, {
      requestId: junkPass.requestId,
      datasetId: junkPass.datasetId,
      state: "reported",
      rawReport: '{"v":1,"model":"gpt"}',
      verdict: "pass",
    });
    expect(await review(junkPass.datasetId)).toMatchObject({
      outcome: "action_required",
      reasons: ["review_could_not_run"],
    });
    const junkFail = request();
    seedPublicationReview(db, {
      requestId: junkFail.requestId,
      datasetId: junkFail.datasetId,
      state: "reported",
      rawReport: "not json at all",
      verdict: "fail",
    });
    expect(await review(junkFail.datasetId)).toMatchObject({
      outcome: "fail",
      reasons: ["stored_verdict_fail", "review_could_not_run"],
    });
  });

  test("a stored report whose evidence is about another commit or release kind could not be read back, and is never a pass", async () => {
    // The write path refuses such a report, and the database has no CHECK that does: a row edited
    // by hand (or written by an older build) must not read as the review of this commit.
    const cases: Array<[string, string, string | number | boolean]> = [
      ["another commit", "$.evidence.head", OTHER_HEAD],
      ["the other kind of release", "$.evidence.anonymous", 1],
    ];
    for (const [name, path, value] of cases) {
      const { requestId, datasetId } = request();
      const id = seedPublicationReview(db, { requestId, datasetId, state: "reported" });
      expect((await review(datasetId)).outcome).toBe("pass");
      db.run("UPDATE publication_reviews SET report = json_set(report, ?, ?) WHERE id = ?", [
        path,
        value,
        id,
      ]);
      const r = await review(datasetId);
      expect({ name, outcome: r.outcome, reasons: r.reasons }).toEqual({
        name,
        outcome: "action_required",
        reasons: ["review_could_not_run"],
      });
      const d = await detail(datasetId);
      expect(d.reasons).toMatchObject([{ code: "review_could_not_run", detail: "report_invalid" }]);
      // Nothing of a report that does not belong to the row is shown as the row's.
      expect(d.review).toMatchObject({ id, questions: null, evidence: null, summary: null });
      expect(d.review?.findings).toEqual([]);
    }
    // A stored fail over such a report stays a fail, as for a report that does not parse.
    const { requestId, datasetId } = request();
    const id = seedPublicationReview(db, {
      requestId,
      datasetId,
      state: "reported",
      verdict: "fail",
    });
    db.run(
      "UPDATE publication_reviews SET report = json_set(report, '$.evidence.head', ?) WHERE id = ?",
      [OTHER_HEAD, id],
    );
    expect((await review(datasetId)).reasons).toEqual([
      "stored_verdict_fail",
      "review_could_not_run",
    ]);
  });

  test("a failed minimum at the reviewed commit shows with the block it caused", async () => {
    const { requestId, datasetId } = request({
      requestStatus: "blocked",
      blockReason: "min_requirements_failed",
    });
    seedPublicationReview(db, {
      requestId,
      datasetId,
      state: "reported",
      report: goodPublicationReport({
        evidence: evidenceFor(SCREENED_HEAD, false, {
          minimums: "failed",
          minimum_failures: ["name_too_short"],
          name_length: 5,
        }),
      }),
    });
    const r = await review(datasetId);
    expect(r.outcome).toBe("fail");
    expect(r.reasons).toContain("request_blocked");
    expect(r.reasons).toContain("submission_minimum_failed");
  });

  test("a request that is blocked does not wait for a review: a dispatched row of it is one that did not report", async () => {
    const { requestId, datasetId } = request({
      requestStatus: "blocked",
      blockReason: "min_requirements_failed",
    });
    seedPublicationReview(db, {
      requestId,
      datasetId,
      state: "dispatched",
      createdMinutesAgo: 2,
    });
    const r = await review(datasetId);
    expect(r.reasons).toContain("review_did_not_report");
    expect(r.reasons).not.toContain("review_running");
    expect(r.kind).toBe("decided");
  });

  test("a request that is over reads its stored review only: no live fact is held against it", async () => {
    for (const requestStatus of ["published", "denied"] as const) {
      const { requestId, datasetId } = request({ requestStatus });
      seedPublicationReview(db, { requestId, datasetId, state: "reported" });
      addVersionRow(datasetId);
      db.run(
        "UPDATE datasets SET concept_doi = '10.82901/nm.done', ezid_status = 'public' WHERE dataset_id = ?",
        [datasetId],
      );
      const r = await review(datasetId);
      expect(r.outcome).toBe("pass");
      expect(r.reasons).toEqual([]);
    }
  });

  test("an approving request that has started publishing is read from its stored review only: what its own run wrote is not held against it", async () => {
    // The approval has already written the version row and the concept DOI of THIS release. Read
    // as live facts they would say "already released" and "unexpected DOI" about a run that is to
    // be resumed, and point at `approve --force` for it.
    const { requestId, datasetId } = request({ requestStatus: "approving" });
    startPublishing(requestId);
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    addVersionRow(datasetId);
    db.run(
      "UPDATE datasets SET concept_doi = '10.82901/nm.own-run', ezid_status = 'draft' WHERE dataset_id = ?",
      [datasetId],
    );
    expect(await review(datasetId)).toMatchObject({ outcome: "pass", reasons: [] });
    const d = await detail(datasetId);
    expect(d.request_status).toBe("approving");
    expect(d.outcome).toBe("pass");
    expect(d.reasons).toEqual([]);
    expect(d.description.next).not.toContain("--force");
  });

  test("an approving request that stopped before it published reads its live facts: they are an earlier release's", async () => {
    // Only the validation-only steps ran, which write neither a version row nor a DOI, so the run
    // is gated again when it resumes and a release row of this version is not its own.
    const { requestId, datasetId } = request({ requestStatus: "approving" });
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    addVersionRow(datasetId);
    db.run(
      "UPDATE datasets SET concept_doi = '10.82901/nm.earlier', ezid_status = 'public' WHERE dataset_id = ?",
      [datasetId],
    );
    expect(await review(datasetId)).toMatchObject({
      outcome: "fail",
      reasons: ["version_already_released", "doi_state_unexpected"],
    });
    const d = await detail(datasetId);
    expect(d.started_publishing).toBe(false);
    expect(d.reasons.map((r) => r.code)).toEqual([
      "version_already_released",
      "doi_state_unexpected",
    ]);
    expect(d.description.next).toContain("--force");
  });

  test("an approving request still shows its stored review: a failed question and a stored fail stand", async () => {
    const failed = request({ requestStatus: "approving" });
    startPublishing(failed.requestId);
    seedPublicationReview(db, {
      requestId: failed.requestId,
      datasetId: failed.datasetId,
      state: "reported",
      report: failingReport(),
    });
    addVersionRow(failed.datasetId);
    expect(await review(failed.datasetId)).toMatchObject({
      outcome: "fail",
      reasons: ["question_failed"],
    });
    const storedFail = request({ requestStatus: "approving" });
    seedPublicationReview(db, {
      requestId: storedFail.requestId,
      datasetId: storedFail.datasetId,
      state: "reported",
      verdict: "fail",
    });
    expect(await review(storedFail.datasetId)).toMatchObject({
      outcome: "fail",
      reasons: ["stored_verdict_fail"],
    });
  });

  test("a blocked request has written nothing of an approval, so its live facts are still read", async () => {
    // A request is blocked before any approval step runs (the only walk back from approving is
    // the owner-name check, ahead of the first step), so a version row or a concept DOI on its
    // dataset belongs to an earlier release, which is what the checks look for.
    const { requestId, datasetId } = request({
      requestStatus: "blocked",
      blockReason: "min_requirements_failed",
    });
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    addVersionRow(datasetId);
    const r = await review(datasetId);
    expect(r.outcome).toBe("fail");
    expect(r.reasons).toEqual(["request_blocked", "version_already_released"]);
  });

  test("every row's reasons are codes of the closed vocabulary, and a non-pass always has one", async () => {
    // A broad sweep of seeded states: no row may be an outcome without a reason.
    const seeds: Array<Partial<SeedScreenedRequest>> = [
      {},
      { status: "review" },
      { status: "pending" },
      { status: "error" },
      { status: "unchecked" },
      { status: "no-recordings" },
      { status: "dates-only" },
      { requestStatus: "blocked", blockReason: "min_requirements_failed" },
      { source: "openneuro" },
    ];
    for (const s of seeds) request(s);
    const { rows } = await listBody();
    expect(rows.length).toBe(seeds.length);
    for (const row of rows) {
      const r = row.publication_review;
      for (const code of r.reasons) expect(REASON_CODES).toContain(code);
      if (r.outcome === null) {
        // Not assessed (a mirror, or no review on record that gates anything): nothing to explain.
        expect(r.reasons).toEqual([]);
      } else if (r.outcome !== "pass") {
        expect(r.reasons.length).toBeGreaterThan(0);
      }
    }
  });
});

// ============================================================================

describe("what the list carries", () => {
  test("a row gains one key, and the joined dataset columns and every nonce stay off the wire", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, {
      requestId,
      datasetId,
      state: "unreported",
      nonce: NONCE_SENTINEL,
    });
    db.run(
      "UPDATE publication_requests SET prescreen_nonce = ?, identifier_screen_nonce = ? WHERE id = ?",
      ["PRESCREEN-NONCE-SENTINEL", "SCREEN-NONCE-SENTINEL", requestId],
    );
    const { text, rows } = await listBody();
    const row = rows.find((r) => r.dataset_id === datasetId) as ListRow;

    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(publication_requests)")
      .all()
      .map((c) => c.name);
    const withheld = ["prescreen_nonce", "identifier_screen_nonce", "identifier_screen_report"];
    const expected = [
      ...columns.filter((c) => !withheld.includes(c)),
      "requested_by_username",
      "requested_by_email",
      "approval_in_flight",
      "identifier_screen",
      "publication_review",
    ].sort();
    expect(Object.keys(row).sort()).toEqual(expected);
    expect(Object.keys(row.publication_review).sort()).toEqual(
      [
        "kind",
        "enabled",
        "gate",
        "outcome",
        "headline",
        "tone",
        "reasons",
        "start_offered",
        "review_id",
        "head_sha",
      ].sort(),
    );

    // No key anywhere is a nonce, and no nonce's value is anywhere.
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          keys.push(k);
          walk(x);
        }
      }
    };
    walk(JSON.parse(text));
    expect(keys.filter((k) => /nonce/i.test(k))).toEqual([]);
    for (const sentinel of [NONCE_SENTINEL, "PRESCREEN-NONCE-SENTINEL", "SCREEN-NONCE-SENTINEL"]) {
      expect(text).not.toContain(sentinel);
    }
  });

  test("the model's summary and the notes of its findings are not in the list", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, { requestId, datasetId, state: "reported", report: failingReport() });
    const { text } = await listBody();
    expect(text).toContain("Publication review: FAIL");
    expect(text).not.toContain(SUMMARY_SENTINEL);
    expect(text).not.toContain(NOTE_SENTINEL);
  });

  test("a dataset row that is gone reads as a native one, and never breaks the list", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    db.run("PRAGMA foreign_keys = OFF");
    db.run("DELETE FROM datasets WHERE dataset_id = ?", [datasetId]);
    expect((await review(datasetId)).outcome).toBe("pass");
  });
});

// ============================================================================

describe("the list's cost and isolation", () => {
  /** The statements one list request issues, with the values each was bound with. */
  async function listStatements(rows: number, bindings: Partial<Bindings> = {}) {
    const seen: Array<{ sql: string; binds: readonly unknown[] }> = [];
    const counting = interceptingD1(realD1(db), (sql, binds) => {
      seen.push({ sql: sql.replace(/\s+/g, " ").trim(), binds });
    });
    const { rows: listed } = await listBody(env({ DB: counting, ...bindings }));
    expect(listed).toHaveLength(rows);
    const count = (re: RegExp) => seen.filter((x) => re.test(x.sql)).length;
    return {
      total: seen.length,
      reviewReads: count(/^SELECT .* FROM publication_reviews/),
      versionLookups: count(/FROM dataset_versions/),
      earlierAnonymous: count(/FROM publication_requests WHERE dataset_id = \? AND anonymous = 1/),
      mostBinds: Math.max(0, ...seen.map((x) => x.binds.length)),
    };
  }

  let n = 0;
  /** A request with a stored review, in `status`, with `versioned` meaning a version row exists. */
  function listed(status: SeedScreenedRequest["requestStatus"], versioned = false) {
    n += 1;
    const datasetId = `nm${String(9000 + n).padStart(6, "0")}`;
    const { requestId } = request({ datasetId, requestStatus: status });
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    if (versioned) addVersionRow(datasetId);
    // An approval being run has started publishing: its own release rows are not read.
    if (status === "approving") startPublishing(requestId);
    return datasetId;
  }

  test("reads every review row in one query, and a version fact only for a request that could still be approved", async () => {
    // 22 rows: 8 over, 3 publishing, 2 approving that stopped before it published, 6 waiting, 3
    // waiting whose version has a release.
    for (let i = 0; i < 8; i++) listed("published");
    for (let i = 0; i < 3; i++) listed("approving");
    for (let i = 0; i < 2; i++) {
      const stopped = listed("approving");
      db.run("UPDATE publication_requests SET steps_completed = '[]' WHERE dataset_id = ?", [
        stopped,
      ]);
    }
    for (let i = 0; i < 6; i++) listed("requested");
    for (let i = 0; i < 3; i++) listed("requested", true);
    const cost = await listStatements(22);
    // The cost is the 3 statements of the request itself (the key's lookup and its stamp, and
    // the list), ONE read of all 22 review rows, a version lookup for each of the 11 requests that
    // could still be approved (waiting, or stopped before it published), and the earlier-anonymous
    // lookup for the 3 with a release. Requests that are over or publishing read nothing beyond
    // the one batch.
    expect(cost.reviewReads).toBe(1);
    expect(cost.versionLookups).toBe(11);
    expect(cost.earlierAnonymous).toBe(3);
    expect(cost.total).toBe(3 + 1 + 11 + 3);
  });

  test("a list of requests that are over costs one read however long it is, and stays inside D1's bound limit", async () => {
    for (let i = 0; i < 100; i++) listed("published");
    const cost = await listStatements(100);
    expect(cost.versionLookups).toBe(0);
    expect(cost.earlierAnonymous).toBe(0);
    // 45 requests a read (two values each), so three reads for 100 rows, none past D1's 100 binds.
    expect(cost.reviewReads).toBe(3);
    expect(cost.mostBinds).toBeLessThanOrEqual(100);
  });

  test("each row is read on its own: one that cannot be read does not hide the others", async () => {
    const ids = [listed("requested"), listed("requested"), listed("requested")];
    const poisoned = ids[1];
    const failing = env({
      DB: interceptingD1(realD1(db), (sql, binds) => {
        if (/FROM dataset_versions/.test(sql) && binds.includes(poisoned)) {
          throw new Error("D1_ERROR: simulated SQL text");
        }
      }),
    });
    let text = "";
    let rows: ListRow[] = [];
    const lines = await logged(async () => {
      ({ text, rows } = await listBody(failing));
    });
    expect(rows).toHaveLength(3);
    for (const id of [ids[0], ids[2]]) {
      expect(rows.find((r) => r.dataset_id === id)?.publication_review).toMatchObject({
        outcome: "pass",
        reasons: [],
      });
    }
    // The poisoned row is not a pass, and says so in the fixed words. It has no reason: "start it
    // again", the cure of review_could_not_run, is wrong advice for a fault of our own reads.
    expect(rows.find((r) => r.dataset_id === poisoned)?.publication_review).toEqual({
      kind: "unreadable",
      enabled: true,
      gate: "enforced",
      outcome: "action_required",
      headline: REVIEW_UNREADABLE_HEADLINE,
      tone: "warn",
      reasons: [],
      start_offered: false,
      review_id: null,
      head_sha: null,
    });
    // No SQL, no message, in the answer or the log: the request's id and a closed class.
    expect(text).not.toContain("simulated");
    const log = lines.join("\n");
    const poisonedRequest = rows.find((r) => r.dataset_id === poisoned)?.id;
    expect(log).toContain(`request ${poisonedRequest}`);
    expect(log).toContain("(Error, other)");
    expect(log).not.toContain("simulated");
    expect(log).not.toContain(poisoned);
  });

  test("a list whose review rows cannot be read still answers, and none of its rows is a pass", async () => {
    const waiting = listed("requested");
    const over = listed("published");
    const mirror = request({ source: "openneuro" }).datasetId;
    const failing = env({
      DB: interceptingD1(realD1(db), (sql) => {
        if (/^\s*SELECT .*FROM publication_reviews/s.test(sql)) {
          throw new Error("D1_ERROR: simulated SQL text");
        }
      }),
    });
    let text = "";
    let rows: ListRow[] = [];
    await logged(async () => {
      ({ text, rows } = await listBody(failing));
    });
    for (const id of [waiting, over]) {
      expect(rows.find((r) => r.dataset_id === id)?.publication_review).toMatchObject({
        kind: "unreadable",
        outcome: "action_required",
        headline: REVIEW_UNREADABLE_HEADLINE,
        reasons: [],
      });
    }
    // A mirror needs no review row, so there was nothing to fail to read.
    expect(rows.find((r) => r.dataset_id === mirror)?.publication_review.kind).toBe(
      "not_applicable",
    );
    expect(text).not.toContain("simulated");
  });

  test("with the review off, a read that fails leaves the row not assessed, as the mail does", async () => {
    const waiting = listed("requested");
    const over = listed("published");
    const off = { PUBLICATION_REVIEW_ENABLED: undefined };
    const unreadableRows = env({
      ...off,
      DB: interceptingD1(realD1(db), (sql) => {
        if (/^\s*SELECT .*FROM publication_reviews/s.test(sql)) {
          throw new Error("no such table: publication_reviews");
        }
      }),
    });
    const unreadableFacts = env({
      ...off,
      DB: interceptingD1(realD1(db), (sql) => {
        if (/FROM dataset_versions/.test(sql)) throw new Error("D1_ERROR: simulated SQL text");
      }),
    });
    // The row reads fail for both requests; the version lookup only for the one that could still
    // be approved (a request that is over is shown from its stored review alone).
    for (const [failing, affected] of [
      [unreadableRows, [waiting, over]],
      [unreadableFacts, [waiting]],
    ] as const) {
      let rows: ListRow[] = [];
      await logged(async () => {
        ({ rows } = await listBody(failing));
      });
      // Not "action required": a review that is off gates nothing, so a read that failed has
      // nothing to be unknown about. No outcome and no reason, whichever read failed.
      for (const id of affected) {
        expect(rows.find((r) => r.dataset_id === id)?.publication_review).toEqual({
          kind: "off",
          enabled: false,
          gate: "off",
          outcome: null,
          headline: "Publication review: not reviewed (the automated review is off)",
          tone: "note",
          reasons: [],
          start_offered: false,
          review_id: null,
          head_sha: null,
        });
      }
    }
    // The same fault with the review on is the unreadable row, which is never a pass.
    let on: ListRow[] = [];
    await logged(async () => {
      ({ rows: on } = await listBody(env({ DB: unreadableRows.DB })));
    });
    expect(on.find((r) => r.dataset_id === waiting)?.publication_review.kind).toBe("unreadable");
  });

  test("the rows that could still be approved are read a few at a time, never all at once", async () => {
    // More rows than the bound, so the bound is what holds the count down.
    const rowCount = LIST_CONCURRENCY * 2 + 4;
    for (let i = 0; i < rowCount; i++) listed("requested");
    let inFlight = 0;
    let most = 0;
    const slow = env({
      DB: interceptingD1(realD1(db), async (sql) => {
        if (!/FROM dataset_versions/.test(sql)) return;
        inFlight++;
        most = Math.max(most, inFlight);
        // Hold the slot across a macrotask, as a network round trip would.
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
      }),
    });
    const { rows } = await listBody(slow);
    expect(rows).toHaveLength(rowCount);
    expect(most).toBe(LIST_CONCURRENCY);
  });
});

// ============================================================================

describe("GET /admin/publish/:id/review", () => {
  test("the detail of a reported review: the outcome, the reasons with their clearers, the record and the standing line", async () => {
    const { requestId, datasetId } = request();
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId,
      state: "reported",
      report: failingReport(),
    });
    const d = await detail(datasetId);
    expect(d).toMatchObject({
      environment: "production",
      enabled: true,
      dataset_id: datasetId,
      request_id: requestId,
      request_status: "requested",
      anonymous: false,
      applies: true,
      gate: "enforced",
      outcome: "fail",
    });
    // The contract's keys and no others, at every level: no row is ever spread onto the wire.
    expect(Object.keys(d).sort()).toEqual(
      [
        "environment",
        "enabled",
        "dataset_id",
        "request_id",
        "request_status",
        "anonymous",
        "identifier_screen",
        "screen_acknowledgment",
        "block_reason",
        "started_publishing",
        "total_files",
        "applies",
        "gate",
        "outcome",
        "reasons",
        "description",
        "review",
        "history",
        "history_truncated",
      ].sort(),
    );
    expect(Object.keys(d.review ?? {}).sort()).toEqual(
      [
        "id",
        "head_sha",
        "anonymous",
        "state",
        "detail",
        "stored_verdict",
        "model",
        "version",
        "created_at",
        "decided_at",
        "started_by",
        "override",
        "questions",
        "fact_notes",
        "findings",
        "summary",
        "evidence",
      ].sort(),
    );
    expect(Object.keys(d.history[0]).sort()).toEqual(
      ["id", "head_sha", "anonymous", "state", "stored_verdict", "created_at", "decided_at"].sort(),
    );
    expect(Object.keys(d.reasons[0]).sort()).toEqual(
      ["code", "class", "cleared_by", "detail", "sentence", "cure", "line"].sort(),
    );
    expect(d.reasons).toEqual([
      {
        code: "question_failed",
        class: "fail",
        cleared_by: "override",
        detail: "complete_and_honest",
        sentence: REASONS.question_failed.sentence,
        cure: REASONS.question_failed.cure,
        // The line the description prints for the reason, which the detail repeats so a client
        // prints it and composes nothing from `detail`.
        line: d.description.lines[0],
      },
    ]);
    expect(d.reasons[0].line).toContain(REASONS.question_failed.cure);
    expect(d.description.headline).toBe("Publication review: FAIL");
    expect(d.description.tone).toBe("stop");
    expect(d.description.lines.at(-1)).toBe(NOT_ASSESSED_LINE);
    expect(d.description.next).toBe(`nemar admin publish approve ${datasetId} --force`);

    expect(d.review).toMatchObject({
      id: reviewId,
      head_sha: SCREENED_HEAD,
      anonymous: false,
      state: "reported",
      detail: null,
      stored_verdict: "fail",
      model: "claude-haiku-5-5",
      version: "1.0.0",
      started_by: null,
      override: null,
      questions: {
        complete_and_honest: "fail",
        meets_standards: "pass",
        authors_and_license: "pass",
        name_adequate: "pass",
      },
      // The model's own words are in the detail, and only here.
      summary: SUMMARY_SENTINEL,
    });
    expect(d.review?.findings).toEqual([
      {
        question: "complete_and_honest",
        severity: "blocker",
        code: "readme_mismatch",
        document: "readme",
        note: NOTE_SENTINEL,
      },
    ]);
    expect(d.review?.evidence?.head).toBe(SCREENED_HEAD);
    expect(d.review?.evidence?.summary.recordings).toBe(4);
    expect(d.history).toEqual([
      {
        id: reviewId,
        head_sha: SCREENED_HEAD,
        anonymous: false,
        state: "reported",
        stored_verdict: "fail",
        created_at: expect.any(String),
        decided_at: expect.any(String),
      },
    ]);
    expect(d.history_truncated).toBe(false);
  });

  test("a reason's cure names the dataset, and its detail is a closed word", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, { requestId, datasetId, state: "unreported" });
    const d = await detail(datasetId);
    expect(d.reasons).toHaveLength(1);
    expect(d.reasons[0].code).toBe("review_did_not_report");
    expect(d.reasons[0].cure).toContain(`nemar admin publish start ${datasetId}`);
    expect(d.reasons[0].cure).not.toContain("<dataset>");
    expect(d.review).toMatchObject({
      state: "unreported",
      stored_verdict: null,
      questions: null,
      evidence: null,
    });
    expect(d.review?.findings).toEqual([]);
    expect(d.review?.summary).toBeNull();
  });

  test("a question that a fact failed says which fact, and is not blamed on the reviewer", async () => {
    // A model that passed every question, over a dataset with no License and a three-character
    // Name. Both answers are the facts' (`answersOf`), there is no finding to read, and the line
    // used to say "The reviewer answered no to a question" with nothing after it.
    const { requestId, datasetId } = request();
    seedPublicationReview(db, {
      requestId,
      datasetId,
      state: "reported",
      report: goodPublicationReport({
        evidence: evidenceFor(SCREENED_HEAD, false, { name_length: 3, license_field: false }),
      }),
    });
    const d = await detail(datasetId);
    expect(d.outcome).toBe("fail");
    expect(d.reasons.map((r) => [r.code, r.detail])).toEqual([
      ["question_failed", "authors_and_license"],
      ["question_failed", "name_adequate"],
    ]);
    const failedSentence = REASONS.question_failed.sentence.replace(/\.$/, "");
    const lines = d.description.lines.filter((l) => l.startsWith(failedSentence));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("dataset_description.json sets no License");
    expect(lines[1]).toContain(
      "the Name in dataset_description.json is shorter than 25 characters",
    );
    expect(d.description.lines.join("\n")).not.toContain("answered no");
    // The record says it too, in closed words and the shared sentence, beside the (empty) findings.
    expect(d.review?.findings).toEqual([]);
    expect(d.review?.fact_notes).toEqual([
      {
        question: "authors_and_license",
        fact: "license_field_missing",
        result: "fail",
        text: "dataset_description.json sets no License",
      },
      {
        question: "name_adequate",
        fact: "name_too_short",
        result: "fail",
        text: "the Name in dataset_description.json is shorter than 25 characters",
      },
    ]);
    expect(d.review?.questions).toMatchObject({
      authors_and_license: "fail",
      name_adequate: "fail",
      complete_and_honest: "pass",
    });
  });

  test("a question a fact made unknown says so too, and a model's own fail still lists its findings", async () => {
    const cut = request();
    seedPublicationReview(db, {
      requestId: cut.requestId,
      datasetId: cut.datasetId,
      state: "reported",
      report: goodPublicationReport({
        evidence: evidenceFor(SCREENED_HEAD, false, {
          documents: {
            readme: "sent_cut",
            dataset_description: "sent",
            changes: "sent",
            license: "sent",
            participants_json: "absent",
          },
        }),
      }),
    });
    const unknown = await detail(cut.datasetId);
    expect(unknown.reasons.map((r) => [r.code, r.detail])).toEqual([
      ["question_unknown", "complete_and_honest"],
      ["question_unknown", "meets_standards"],
    ]);
    expect(unknown.description.lines.join("\n")).toContain(
      "the reviewer was not shown all of the text this question needs",
    );
    expect(unknown.review?.fact_notes.map((n) => [n.question, n.fact, n.result])).toEqual([
      ["complete_and_honest", "text_not_seen_in_full", "unknown"],
      ["meets_standards", "text_not_seen_in_full", "unknown"],
    ]);

    // The model's own fail is not a fact: its findings are listed and no fact note is made up.
    const own = request();
    seedPublicationReview(db, {
      requestId: own.requestId,
      datasetId: own.datasetId,
      state: "reported",
      report: failingReport(),
    });
    const failed = await detail(own.datasetId);
    expect(failed.review?.fact_notes).toEqual([]);
    expect(failed.description.lines.join("\n")).toContain(
      "findings: README does not match the dataset",
    );
  });

  describe("a request an administrator cannot start a review for is not told to start one", () => {
    // `POST /admin/publish/:id/review/start` refuses any request that is not `requested`
    // (409 request_not_requested), so the reasons whose cure is "start it" must not send an
    // administrator there for a request that is being approved or is blocked.
    const START = "nemar admin publish start";
    const NOT_STARTABLE = "A review starts only for a request that is waiting for its decision.";
    const startCures: Array<[ReasonCode, Omit<SeedReview, "requestId" | "datasetId"> | null]> = [
      ["review_not_started", null],
      ["review_did_not_report", { state: "unreported" }],
      ["review_limit_reached", { state: "declined", detail: "platform_limit" }],
      ["review_could_not_run", { state: "errored", detail: "model_refused" }],
    ];

    for (const status of ["approving", "blocked"] as const) {
      for (const [code, seed] of startCures) {
        test(`${status}: ${code} says what is true, and no start command is offered`, async () => {
          const { requestId, datasetId } = request({
            requestStatus: status,
            blockReason: status === "blocked" ? "min_requirements_failed" : null,
          });
          if (seed !== null) seedPublicationReview(db, { ...seed, requestId, datasetId });
          const d = await detail(datasetId);
          const reason = d.reasons.find((r) => r.code === code);
          expect(reason).toBeDefined();
          expect(reason?.cure).not.toContain(START);
          expect(reason?.cure).toContain(NOT_STARTABLE);
          expect(d.description.lines.join("\n")).not.toContain(START);
          expect(d.description.lines.join("\n")).toContain(NOT_STARTABLE);
          expect(d.description.next ?? "").not.toContain(START);
        });
      }
    }

    test("an approving request's next command is the approval, not a start the route refuses", async () => {
      const { requestId, datasetId } = request({ requestStatus: "approving" });
      seedPublicationReview(db, {
        requestId,
        datasetId,
        state: "errored",
        detail: "model_refused",
      });
      const d = await detail(datasetId);
      // A run that has not started publishing is gated again when it resumes, so its command is
      // the resume (the approval of an `approving` request that has not started publishing).
      expect(d.description.next).toBe(`nemar admin publish approve ${datasetId} --resume --force`);
      // A request waiting for its decision is still told to start it.
      const open = request();
      seedPublicationReview(db, {
        requestId: open.requestId,
        datasetId: open.datasetId,
        state: "errored",
        detail: "model_refused",
      });
      const dOpen = await detail(open.datasetId);
      expect(dOpen.description.next).toBe(`nemar admin publish start ${open.datasetId}`);
      expect(dOpen.reasons[0].cure).toContain(`${START} ${open.datasetId}`);
    });
  });

  test("a hard reason is cleared by nothing, and the screen's by its acknowledgment", async () => {
    const blocked = request({ requestStatus: "blocked", blockReason: "min_requirements_failed" });
    const hard = (await detail(blocked.datasetId)).reasons.find(
      (r) => r.code === "request_blocked",
    );
    expect(hard).toMatchObject({
      class: "fail",
      cleared_by: "nothing",
      detail: "min_requirements_failed",
    });
    const ack = request({ status: "review" });
    const screen = (await detail(ack.datasetId)).reasons.find(
      (r) => r.code === "identifier_screen_needs_acknowledgment",
    );
    expect(screen).toMatchObject({ class: "unknown", cleared_by: "screen_acknowledgment" });
  });

  test("history is newest first, capped, and says when it was cut", async () => {
    const { requestId, datasetId } = request();
    const ids: number[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 2; i++) {
      // Distinct heads: one row per (request, head, flag). The last is the screened head.
      const head = i === HISTORY_LIMIT + 1 ? SCREENED_HEAD : (i + 1).toString(16).padStart(40, "a");
      ids.push(seedPublicationReview(db, { requestId, datasetId, head, state: "unreported" }));
    }
    const d = await detail(datasetId);
    expect(d.history).toHaveLength(HISTORY_LIMIT);
    expect(d.history_truncated).toBe(true);
    expect(d.history.map((h) => h.id)).toEqual(ids.slice(-HISTORY_LIMIT).reverse());
    // The review in force is the screened head's row, and it is the newest here.
    expect(d.review?.id).toBe(ids.at(-1));
  });

  test("exactly the cap is not truncated", async () => {
    const { requestId, datasetId } = request();
    for (let i = 0; i < HISTORY_LIMIT; i++) {
      seedPublicationReview(db, {
        requestId,
        datasetId,
        head: (i + 1).toString(16).padStart(40, "b"),
        state: "unreported",
      });
    }
    const d = await detail(datasetId);
    expect(d.history).toHaveLength(HISTORY_LIMIT);
    expect(d.history_truncated).toBe(false);
  });

  test("history keeps the other commits' rows as history, not as the review", async () => {
    const { requestId, datasetId } = request();
    const old = seedPublicationReview(db, {
      requestId,
      datasetId,
      head: OTHER_HEAD,
      state: "reported",
    });
    const d = await detail(datasetId);
    expect(d.review).toBeNull();
    expect(d.outcome).toBe("action_required");
    expect(d.reasons.map((r) => r.code)).toEqual(["review_not_started"]);
    expect(d.history.map((h) => h.id)).toEqual([old]);
  });

  test("the override recorded on a review is shown with the reasons it was given for", async () => {
    const { requestId, datasetId } = request();
    const id = seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    const admin = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'reviewadmin'")
      .get() as { id: number };
    setOverride(db, id, admin.id, ["question_failed", "not_a_reason", "text_withheld"]);
    const d = await detail(datasetId);
    expect(d.review?.override).toEqual({
      by: admin.id,
      at: expect.any(String),
      reasons: ["question_failed", "text_withheld"],
    });
  });

  test("the detail is for the active request: an older denied one is not it", async () => {
    const { requestId, datasetId } = request({ requestStatus: "denied" });
    seedPublicationReview(db, { requestId, datasetId, state: "reported", report: failingReport() });
    const current = request({ datasetId });
    seedPublicationReview(db, { requestId: current.requestId, datasetId, state: "unreported" });
    const d = await detail(datasetId);
    expect(d.request_id).toBe(current.requestId);
    expect(d.history).toHaveLength(1);
    expect(d.outcome).toBe("action_required");
  });

  test("not applicable: no outcome, no review, the words that say why", async () => {
    const { datasetId } = request({ source: "openneuro" });
    const d = await detail(datasetId);
    expect(d).toMatchObject({
      applies: false,
      gate: "n/a",
      outcome: null,
      reasons: [],
      review: null,
    });
    expect(d.description.headline).toBe("Publication review: not applicable");
    expect(d.description.lines.at(-1)).toBe(NOT_ASSESSED_LINE);
  });

  test("with the review off the detail says so, and every description ends with the standing line", async () => {
    const { requestId, datasetId } = request();
    const off = env({ PUBLICATION_REVIEW_ENABLED: undefined });
    const none = await detail(datasetId, off);
    expect(none).toMatchObject({ enabled: false, gate: "off", review: null });
    expect(none.description.headline).toBe(
      "Publication review: not reviewed (the automated review is off)",
    );
    expect(none.description.next).toBeNull();
    expect(none.description.lines.at(-1)).toBe(NOT_ASSESSED_LINE);
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    const advice = await detail(datasetId, off);
    expect(advice.description.lines).toContain(
      "The automated review is off, so this review is advice and gates nothing.",
    );
    expect(advice.description.lines.at(-1)).toBe(NOT_ASSESSED_LINE);
  });

  test("the environment is the Worker's own", async () => {
    const { datasetId } = request();
    expect((await detail(datasetId, env({ ENVIRONMENT: "staging" }))).environment).toBe(
      "non-production",
    );
    expect((await detail(datasetId, env({ ENVIRONMENT: "production" }))).environment).toBe(
      "production",
    );
  });

  test("no nonce, no token and no screen finding is anywhere in the detail", async () => {
    const { requestId, datasetId } = request({ status: "review" });
    seedPublicationReview(db, { requestId, datasetId, state: "unreported", nonce: NONCE_SENTINEL });
    db.run(
      "UPDATE publication_requests SET identifier_screen_nonce = 'SCREEN-NONCE-SENTINEL' WHERE id = ?",
      [requestId],
    );
    const res = await get(`/admin/publish/${datasetId}/review`);
    const text = await res.text();
    expect(text).not.toContain(NONCE_SENTINEL);
    expect(text).not.toContain("SCREEN-NONCE-SENTINEL");
    expect(text.toLowerCase()).not.toContain('"nonce"');
  });

  test("404 with no active request; 400 for a malformed id; 403 for a member; 401 with no key", async () => {
    const published = request({ requestStatus: "published" });
    const none = await get(`/admin/publish/${published.datasetId}/review`);
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({
      error: `${published.datasetId} has no active publication request.`,
      code: "not_found",
    });
    expect((await get("/admin/publish/nm000999/review")).status).toBe(404);

    for (const bad of ["nm1", "xx12345", "nm100000", "NM000001", "requests", "abc"]) {
      const res = await get(`/admin/publish/${bad}/review`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "That is not a dataset id.", code: "bad_dataset" });
    }

    const { datasetId } = request();
    expect((await get(`/admin/publish/${datasetId}/review`, MEMBER_KEY)).status).toBe(403);
    expect((await app.request(`/admin/publish/${datasetId}/review`, {}, env())).status).toBe(401);
  });

  test("a read that fails answers 500 with a fixed sentence and no SQL", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    const failing = env({
      DB: interceptingD1(realD1(db), (sql) => {
        if (/^\s*SELECT .*FROM publication_reviews/s.test(sql))
          throw new Error("D1_ERROR: simulated SQL text");
      }),
    });
    const res = await get(`/admin/publish/${datasetId}/review`, ADMIN_KEY, failing);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "The publication review could not be read. Try again.",
      code: "internal",
    });
  });
});

// ============================================================================

describe("the view's own helpers", () => {
  test("the sandbox exemption is one predicate, which the screen and the view both use", () => {
    // `identifier-screen.ts` re-exports the predicate that lives beside the stored-screen readers
    // (the view imports it from there, because `identifier-screen.ts` imports the view), so there
    // is nothing to keep equal.
    expect(isScreenExempt).toBe(storedIsScreenExempt);
    const exempt: Array<[string, boolean]> = [
      ["xx000001", true],
      ["xx099999", true],
      ["xx12345", false],
      ["xx1234567", false],
      ["nm000001", false],
      ["on000001", false],
      ["xxabcdef", false],
      ["XX000001", false],
      ["", false],
    ];
    for (const [id, want] of exempt) expect([id, storedIsScreenExempt(id)]).toEqual([id, want]);
  });

  test("an override's reasons read from a JSON list or a comma list, and unknown words are dropped", () => {
    expect(overrideReasonsOf(null)).toEqual([]);
    expect(overrideReasonsOf(JSON.stringify(["question_failed", "question_failed", "x"]))).toEqual([
      "question_failed",
    ]);
    expect(overrideReasonsOf("question_failed, text_withheld,bogus")).toEqual([
      "question_failed",
      "text_withheld",
    ]);
    expect(overrideReasonsOf('{"a":1}')).toEqual([]);
    expect(overrideReasonsOf("")).toEqual([]);
  });
});

// ============================================================================

describe("the detail carries what approve and next show from one read", () => {
  async function adminId(): Promise<number> {
    return (db.query("SELECT id FROM users WHERE username = 'reviewadmin'").get() as { id: number })
      .id;
  }

  test("identifier_screen is the list row's, for every state a request's screen can be in", async () => {
    const cases: Array<Partial<SeedScreenedRequest>> = [
      { status: "clean" },
      { status: "review" },
      { status: "pending" },
      { status: "unchecked" },
      { status: "no-recordings" },
      { status: "error" },
      { status: "unreported" },
      {
        status: "direct-identifiers",
        requestStatus: "blocked",
        blockReason: "identifier_screen_findings",
      },
      // A sandbox dataset is not screened, and says so in words of its own.
      { datasetId: "xx000321", status: "pending" },
    ];
    for (const over of cases) {
      const { datasetId } = request(over);
      const d = await detail(datasetId);
      const row = (await listBody()).rows.find((r) => r.dataset_id === datasetId);
      expect(d.identifier_screen).toEqual(row?.identifier_screen as never);
      expect(d.identifier_screen.headline).toStartWith("Identifier screen");
      expect(Array.isArray(d.identifier_screen.lines)).toBe(true);
      // The stored state, as stored (a sandbox dataset's is `exempt`, below).
      if (over.datasetId === undefined) expect(d.identifier_screen.state).toBe(over.status);
      expect(["ok", "note", "warn", "stop"]).toContain(d.identifier_screen.tone);
    }
    const exempt = await detail("xx000321");
    expect(exempt.identifier_screen).toMatchObject({
      state: "exempt",
      headline: "Identifier screen: not applicable (sandbox)",
    });
  });

  test("screen_acknowledgment is who and when once recorded, and never the reason", async () => {
    const { requestId, datasetId } = request({ status: "review" });
    expect((await detail(datasetId)).screen_acknowledgment).toBeNull();
    const by = await adminId();
    const REASON_TEXT = "ACK-REASON-SENTINEL typed by an administrator";
    expect(
      await recordScreenAcknowledgment(realD1(db), {
        requestId,
        datasetId,
        adminUserId: by,
        reason: REASON_TEXT,
        state: "review",
      }),
    ).toBe(true);
    const at = (
      db
        .query("SELECT identifier_screen_ack_at AS at FROM publication_requests WHERE id = ?")
        .get(requestId) as { at: string }
    ).at;
    const res = await get(`/admin/publish/${datasetId}/review`);
    const text = await res.text();
    expect(JSON.parse(text).screen_acknowledgment).toEqual({ by, at });
    expect(text).not.toContain(REASON_TEXT);
    // Half a record is none: both halves or null.
    db.run("UPDATE publication_requests SET identifier_screen_ack_at = NULL WHERE id = ?", [
      requestId,
    ]);
    expect((await detail(datasetId)).screen_acknowledgment).toBeNull();
  });

  test("block_reason is a blocked request's plain word, whatever the flag says, and nothing for a request that is not blocked", async () => {
    const off = env({ PUBLICATION_REVIEW_ENABLED: undefined });
    const blocked = request({ requestStatus: "blocked", blockReason: "min_requirements_failed" });
    expect((await detail(blocked.datasetId)).block_reason).toBe("min_requirements_failed");
    // With the review off the reasons are empty, so this field is how a blocked request is told apart.
    const dOff = await detail(blocked.datasetId, off);
    expect(dOff.reasons).toEqual([]);
    expect(dOff.block_reason).toBe("min_requirements_failed");
    // The word the reasons show is the word this shows.
    const dOn = await detail(blocked.datasetId);
    expect(dOn.reasons.find((r) => r.code === "request_blocked")?.detail).toBe(dOn.block_reason);
    // Not a plain word: not shown.
    const odd = request({ requestStatus: "blocked", blockReason: "Not A Word!" });
    expect((await detail(odd.datasetId)).block_reason).toBeNull();
    expect(shownBlockReason({ status: "blocked", block_reason: "Not A Word!" })).toBeNull();
    // A request that is not blocked shows none, even with a stale column.
    const open = request();
    db.run(
      "UPDATE publication_requests SET block_reason = 'min_requirements_failed' WHERE id = ?",
      [open.requestId],
    );
    expect((await detail(open.datasetId)).block_reason).toBeNull();
    // Blocked without a reason on record.
    const bare = request({ requestStatus: "blocked", blockReason: null });
    expect((await detail(bare.datasetId)).block_reason).toBeNull();
  });

  test("started_publishing is true only for an approving request, or one the owner-name walk-back blocked, with a step outside the validation-only ones", async () => {
    const stepsOf = (requestId: number, steps: unknown) =>
      db.run("UPDATE publication_requests SET steps_completed = ? WHERE id = ?", [
        typeof steps === "string" ? steps : JSON.stringify(steps),
        requestId,
      ]);
    const approving = request({ requestStatus: "approving" });
    expect((await detail(approving.datasetId)).started_publishing).toBe(false);
    // Every step on its own, written out here: only the two before the first mutation are quiet.
    const QUIET = ["ci_check", "enrichment_check"];
    for (const step of PUBLICATION_STEPS) {
      stepsOf(approving.requestId, [step]);
      expect({ step, started: (await detail(approving.datasetId)).started_publishing }).toEqual({
        step,
        started: !QUIET.includes(step),
      });
    }
    stepsOf(approving.requestId, QUIET);
    expect((await detail(approving.datasetId)).started_publishing).toBe(false);
    stepsOf(approving.requestId, [...QUIET, "s3_public_read"]);
    expect((await detail(approving.datasetId)).started_publishing).toBe(true);
    // A column that is not a list of step names is not a run that started.
    for (const junk of ["not json", "{}", "[1, 2]", "null", ""]) {
      stepsOf(approving.requestId, junk);
      expect({ junk, started: (await detail(approving.datasetId)).started_publishing }).toEqual({
        junk,
        started: false,
      });
    }
    // The status decides first: a request that is waiting is not "publishing", whatever its steps
    // say. (A request that is over has no detail to read.)
    const waiting = request({ requestStatus: "requested" });
    stepsOf(waiting.requestId, ["ci_check", "s3_public_read", "publish_doi"]);
    expect((await detail(waiting.datasetId)).started_publishing).toBe(false);
    // A request blocked by the owner-name walk-back, which runs on every approval call, with a
    // step done is a run that stopped half published, and is told apart from one that never
    // started (which the Worker refuses outright). A blocked request with any other reason is no
    // run, whatever its steps (pinned in its own test below).
    const blocked = request({ requestStatus: "blocked", blockReason: "owner_name_missing" });
    expect((await detail(blocked.datasetId)).started_publishing).toBe(false);
    stepsOf(blocked.requestId, QUIET);
    expect((await detail(blocked.datasetId)).started_publishing).toBe(false);
    stepsOf(blocked.requestId, ["ci_check", "s3_public_read", "publish_doi"]);
    expect((await detail(blocked.datasetId)).started_publishing).toBe(true);
  });

  test("a blocked request that has started publishing reads no live fact: its own version row and DOI are not an earlier release", async () => {
    const { requestId, datasetId } = request({
      requestStatus: "blocked",
      blockReason: "owner_name_missing",
    });
    startPublishing(requestId);
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    addVersionRow(datasetId);
    db.run(
      "UPDATE datasets SET concept_doi = '10.82901/nm.own-run', ezid_status = 'draft' WHERE dataset_id = ?",
      [datasetId],
    );
    const d = await detail(datasetId);
    expect(d.started_publishing).toBe(true);
    expect(d.reasons.map((r) => r.code)).toEqual(["request_blocked"]);
  });

  test("a run the owner-name walk-back blocked half way is told it started publishing, and its next command is the resume", async () => {
    // The Worker resumes such a run with no gate, so the words say what it does: not "blocked,
    // requests again", and a command that is the resume.
    const { requestId, datasetId } = request({
      requestStatus: "blocked",
      blockReason: "owner_name_missing",
    });
    seedPublicationReview(db, { requestId, datasetId, state: "reported", report: failingReport() });
    startPublishing(requestId);
    const d = await detail(datasetId);
    expect(d.request_status).toBe("blocked");
    expect(d.started_publishing).toBe(true);
    expect(d.description.next).toBe(`nemar admin publish approve ${datasetId} --resume`);
    expect(d.description.lines).toContain(APPROVAL_PUBLISHING_LINE);
    expect(d.description.lines.at(-1)).toBe(NOT_ASSESSED_LINE);
    // Before any step changed anything it is a blocked request that never started: no run, no
    // command, the depositor's cure.
    db.run("UPDATE publication_requests SET steps_completed = ? WHERE id = ?", [
      JSON.stringify(["ci_check", "enrichment_check"]),
      requestId,
    ]);
    const quiet = await detail(datasetId);
    expect(quiet.started_publishing).toBe(false);
    expect(quiet.description.next).toBeNull();
    expect(quiet.description.lines).not.toContain(APPROVAL_PUBLISHING_LINE);
  });

  test("a blocked request with any other reason is not a run, whatever steps an earlier life left on it", async () => {
    // Nothing clears `steps_completed` when the depositor requests again, so these are the steps of
    // a run that was walked back for the owner's name and then blocked again for something else.
    for (const blockReason of ["identifier_screen_findings", "min_requirements_failed", null]) {
      const { requestId, datasetId } = request({ requestStatus: "blocked", blockReason });
      seedPublicationReview(db, {
        requestId,
        datasetId,
        state: "reported",
        report: failingReport(),
      });
      startPublishing(requestId);
      const d = await detail(datasetId);
      expect({ blockReason, started: d.started_publishing }).toEqual({
        blockReason,
        started: false,
      });
      expect(d.description.next).toBeNull();
      expect(d.description.lines).not.toContain(APPROVAL_PUBLISHING_LINE);
      // The blocked cure, which the stale steps must not replace.
      expect(d.description.lines.join("\n")).toContain(REASONS.request_blocked.cure);
    }
  });

  test("an approving request's next command follows where its approval stands: resumed gated, or resumed with no gate", async () => {
    const { requestId, datasetId } = request({ requestStatus: "approving" });
    seedPublicationReview(db, { requestId, datasetId, state: "reported", report: failingReport() });
    const stopped = await detail(datasetId);
    expect(stopped.started_publishing).toBe(false);
    expect(stopped.description.next).toBe(
      `nemar admin publish approve ${datasetId} --resume --force`,
    );
    expect(stopped.description.lines.join("\n")).not.toContain("has started publishing");

    db.run("UPDATE publication_requests SET steps_completed = ? WHERE id = ?", [
      JSON.stringify(["ci_check", "enrichment_check", "s3_public_read"]),
      requestId,
    ]);
    const publishing = await detail(datasetId);
    expect(publishing.started_publishing).toBe(true);
    // No gate applies to a run that has started publishing: no --force, and the line says why.
    expect(publishing.description.next).toBe(`nemar admin publish approve ${datasetId} --resume`);
    expect(publishing.description.lines).toContain(APPROVAL_PUBLISHING_LINE);
    expect(publishing.description.lines.at(-1)).toBe(NOT_ASSESSED_LINE);
    // A request waiting for its decision is unchanged.
    const open = request();
    seedPublicationReview(db, {
      requestId: open.requestId,
      datasetId: open.datasetId,
      state: "reported",
      report: failingReport(),
    });
    expect((await detail(open.datasetId)).description.next).toBe(
      `nemar admin publish approve ${open.datasetId} --force`,
    );
  });

  test("a stopped approval behind a failed minimum is told it cannot be resumed and is to be denied, until it starts publishing", async () => {
    // A failed-minimum report that lands on an `approving` request leaves it approving (the store's
    // move to blocked takes only a `requested` one), so no move to blocked happens to it, as the
    // table's cure allows for; the way out is a denial, and the detail says so.
    const stoppedLine = (id: string) => APPROVAL_STOPPED_HARD_LINE.replaceAll("<dataset>", id);
    const { requestId, datasetId } = request({ requestStatus: "approving" });
    seedPublicationReview(db, {
      requestId,
      datasetId,
      state: "reported",
      report: goodPublicationReport({
        evidence: evidenceFor(SCREENED_HEAD, false, {
          minimums: "failed",
          minimum_failures: ["name_too_short"],
          name_length: 5,
        }),
      }),
    });
    const stopped = await detail(datasetId);
    expect(stopped.request_status).toBe("approving");
    expect(stopped.started_publishing).toBe(false);
    expect(stopped.reasons.map((r) => r.code)).toContain("submission_minimum_failed");
    const lines = stopped.description.lines;
    const at = lines.indexOf(stoppedLine(datasetId));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at]).toContain(`(nemar admin publish deny ${datasetId})`);
    expect(lines.filter((l) => l === stoppedLine(datasetId))).toHaveLength(1);
    expect(lines.at(-1)).toBe(NOT_ASSESSED_LINE);
    expect(at).toBe(lines.length - 2);

    // A request waiting for its decision is blocked by the minimum instead, and is not told this.
    const open = request();
    seedPublicationReview(db, {
      requestId: open.requestId,
      datasetId: open.datasetId,
      state: "reported",
      report: goodPublicationReport({
        evidence: evidenceFor(SCREENED_HEAD, false, {
          minimums: "failed",
          minimum_failures: ["name_too_short"],
          name_length: 5,
        }),
      }),
    });
    const waiting = await detail(open.datasetId);
    expect(waiting.description.lines).not.toContain(stoppedLine(open.datasetId));

    // Once it has started publishing, no gate applies and the line is the other one.
    db.run("UPDATE publication_requests SET steps_completed = ? WHERE id = ?", [
      JSON.stringify(["ci_check", "enrichment_check", "s3_public_read"]),
      requestId,
    ]);
    const publishing = await detail(datasetId);
    expect(publishing.description.lines).not.toContain(stoppedLine(datasetId));
    expect(publishing.description.lines).toContain(APPROVAL_PUBLISHING_LINE);
  });

  test("total_files is the dataset's count, or null when it is not known", async () => {
    const { datasetId } = request();
    expect((await detail(datasetId)).total_files).toBeNull();
    db.run("UPDATE datasets SET total_files = ? WHERE dataset_id = ?", [12400, datasetId]);
    expect((await detail(datasetId)).total_files).toBe(12400);
    db.run("UPDATE datasets SET total_files = 0 WHERE dataset_id = ?", [datasetId]);
    expect((await detail(datasetId)).total_files).toBe(0);
    // A dataset row that is gone is a native one of unknown size.
    db.run("PRAGMA foreign_keys = OFF");
    db.run("DELETE FROM datasets WHERE dataset_id = ?", [datasetId]);
    expect((await detail(datasetId)).total_files).toBeNull();
  });
});

// ============================================================================

describe("the list's start_offered", () => {
  async function offered(datasetId: string, bindings: Bindings = env()) {
    return (await review(datasetId, bindings)).start_offered;
  }

  test("is true for a request waiting for its decision, over every row a start can create or restart", async () => {
    const none = request();
    expect(await offered(none.datasetId)).toBe(true);
    const seeds: Array<Omit<SeedReview, "requestId" | "datasetId">> = [
      { state: "errored", detail: "model_refused" },
      { state: "declined", detail: "platform_limit" },
      { state: "unreported" },
      { state: "dispatched", createdMinutesAgo: REVIEW_OVERDUE_VIEW_MINUTES + 1 },
    ];
    for (const seed of seeds) {
      const { requestId, datasetId } = request();
      seedPublicationReview(db, { ...seed, requestId, datasetId });
      expect({ seed, offered: await offered(datasetId) }).toEqual({ seed, offered: true });
    }
    // A screen that needs an acknowledgment still has a review to start.
    expect(await offered(request({ status: "review" }).datasetId)).toBe(true);
  });

  test("is false for a row a start would refuse: running, or already reported", async () => {
    const seeds: Array<Omit<SeedReview, "requestId" | "datasetId">> = [
      { state: "dispatched", createdMinutesAgo: 5 },
      { state: "reported" },
      { state: "reported", report: failingReport() },
      { state: "reported", rawReport: "{not a report", verdict: "pass" },
    ];
    for (const seed of seeds) {
      const { requestId, datasetId } = request();
      seedPublicationReview(db, { ...seed, requestId, datasetId });
      expect({ seed, offered: await offered(datasetId) }).toEqual({ seed, offered: false });
    }
  });

  test("is false for a request that is not waiting for its decision, with or without a review", async () => {
    for (const requestStatus of ["approving", "blocked", "published", "denied"] as const) {
      const bare = request({ requestStatus });
      expect({ requestStatus, offered: await offered(bare.datasetId) }).toEqual({
        requestStatus,
        offered: false,
      });
      const { requestId, datasetId } = request({ requestStatus });
      seedPublicationReview(db, {
        requestId,
        datasetId,
        state: "errored",
        detail: "model_refused",
      });
      expect({ requestStatus, offered: await offered(datasetId) }).toEqual({
        requestStatus,
        offered: false,
      });
    }
  });

  test("is false while the screen has no clear result for a commit", async () => {
    for (const status of ["pending", "error", "unreported", "direct-identifiers"] as const) {
      const { datasetId } = request({ status });
      expect({ status, offered: await offered(datasetId) }).toEqual({ status, offered: false });
    }
    // A sandbox dataset is not screened and has no screened commit: the route would refuse it.
    expect(await offered(request({ datasetId: "xx000322", status: "pending" }).datasetId)).toBe(
      false,
    );
  });

  test("is false with the review off, and for a mirror and an exemplar, whatever the row says", async () => {
    const off = env({ PUBLICATION_REVIEW_ENABLED: undefined });
    const ordinary = request();
    expect(await offered(ordinary.datasetId)).toBe(true);
    expect(await offered(ordinary.datasetId, off)).toBe(false);
    const errored = request();
    seedPublicationReview(db, {
      requestId: errored.requestId,
      datasetId: errored.datasetId,
      state: "errored",
      detail: "model_refused",
    });
    expect(await offered(errored.datasetId)).toBe(true);
    expect(await offered(errored.datasetId, off)).toBe(false);
    for (const over of [{ source: "openneuro" }, { isExemplar: 1 as const }]) {
      const { datasetId } = request(over);
      expect(await offered(datasetId)).toBe(false);
    }
  });

  test("agrees with the detail's next command, for every request it can be asked about", async () => {
    const seeds: Array<
      [Partial<SeedScreenedRequest>, Omit<SeedReview, "requestId" | "datasetId"> | null]
    > = [
      [{}, null],
      [{}, { state: "errored", detail: "model_refused" }],
      [{}, { state: "dispatched", createdMinutesAgo: 5 }],
      [{}, { state: "reported" }],
      [{ status: "review" }, null],
      [{ status: "pending" }, null],
      [{ requestStatus: "approving" }, { state: "unreported" }],
      [{ requestStatus: "blocked", blockReason: "min_requirements_failed" }, null],
    ];
    for (const [over, seed] of seeds) {
      const { requestId, datasetId } = request(over);
      if (seed) seedPublicationReview(db, { ...seed, requestId, datasetId });
      const next = (await detail(datasetId)).description.next ?? "";
      const row = await review(datasetId);
      // A start is offered only where the detail's own command is the start.
      if (row.start_offered) expect(next).toBe(`nemar admin publish start ${datasetId}`);
      else expect(next).not.toBe(`nemar admin publish start ${datasetId}`);
    }
  });
});

// ============================================================================

describe("a dispatched review is read by time alone while the request can still be gated, on every surface", () => {
  async function derive(requestId: number) {
    const ctx = await readReviewContext(env(), requestId);
    if (ctx === null) throw new Error("no such request");
    return derivePublicationReview({ env: env(), nowMs: Date.now(), ...ctx });
  }

  const codes = (d: { reasons: { code: string }[] }) => d.reasons.map((r) => r.code);

  function ageReview(minutes: number) {
    db.run("UPDATE publication_reviews SET created_at = datetime('now', ?)", [
      `-${minutes} minutes`,
    ]);
  }

  test("an approving request that has not started publishing waits for a review dispatched under the bound", async () => {
    const { requestId, datasetId } = request({ requestStatus: "approving" });
    seedPublicationReview(db, { requestId, datasetId, state: "dispatched", createdMinutesAgo: 10 });
    const d = await derive(requestId);
    expect(codes(d)).toEqual(["review_running"]);
    expect(d.rowView).toEqual({ kind: "dispatched", overdue: false });
    // Only a request waiting for its decision is offered a start.
    expect(d.startable).toBe(false);
  });

  test("time still ages it: past the view's bound it did not report", async () => {
    const { requestId, datasetId } = request({ requestStatus: "approving" });
    seedPublicationReview(db, {
      requestId,
      datasetId,
      state: "dispatched",
      createdMinutesAgo: REVIEW_OVERDUE_VIEW_MINUTES + 1,
    });
    const d = await derive(requestId);
    expect(codes(d)).toEqual(["review_did_not_report"]);
    expect(d.rowView).toEqual({ kind: "dispatched", overdue: true });
  });

  test("a request waiting for its decision reads the same, and so does a reported row", async () => {
    const waiting = request();
    seedPublicationReview(db, {
      requestId: waiting.requestId,
      datasetId: waiting.datasetId,
      state: "dispatched",
      createdMinutesAgo: 10,
    });
    expect(codes(await derive(waiting.requestId))).toEqual(["review_running"]);
    const reported = request({ requestStatus: "approving" });
    seedPublicationReview(db, {
      requestId: reported.requestId,
      datasetId: reported.datasetId,
      state: "reported",
    });
    expect((await derive(reported.requestId)).reasons).toEqual([]);
  });

  test("any other request does not wait: a dispatched row reads as one that did not report", async () => {
    const { requestId, datasetId } = request({
      requestStatus: "blocked",
      blockReason: "min_requirements_failed",
    });
    seedPublicationReview(db, { requestId, datasetId, state: "dispatched", createdMinutesAgo: 10 });
    const d = await derive(requestId);
    expect(d.rowView).toEqual({ kind: "dispatched", overdue: true });
    expect(codes(d)).toContain("review_did_not_report");
    expect(codes(d)).not.toContain("review_running");
  });

  test("the detail of an approving request reads a dispatched review by time, and offers no start", async () => {
    const { requestId, datasetId } = request({ requestStatus: "approving" });
    seedPublicationReview(db, { requestId, datasetId, state: "dispatched", createdMinutesAgo: 10 });
    const young = await detail(datasetId);
    expect(codes(young)).toEqual(["review_running"]);
    expect(young.description.next).toBe(`nemar admin publish show ${datasetId}`);

    ageReview(90);
    const old = await detail(datasetId);
    expect(codes(old)).toEqual(["review_did_not_report"]);
    expect(old.description.next).not.toBe(`nemar admin publish start ${datasetId}`);
  });

  test("the list summary of an approving request reads the same row the same way", async () => {
    const { requestId, datasetId } = request({ requestStatus: "approving" });
    seedPublicationReview(db, { requestId, datasetId, state: "dispatched", createdMinutesAgo: 10 });
    expect(await review(datasetId)).toMatchObject({
      kind: "running",
      reasons: ["review_running"],
      start_offered: false,
    });

    ageReview(90);
    expect(await review(datasetId)).toMatchObject({
      kind: "decided",
      reasons: ["review_did_not_report"],
      start_offered: false,
    });
  });

  test("a blocked request's dispatched row still reads as one that did not report, in the detail and the list", async () => {
    const { requestId, datasetId } = request({
      requestStatus: "blocked",
      blockReason: "min_requirements_failed",
    });
    seedPublicationReview(db, { requestId, datasetId, state: "dispatched", createdMinutesAgo: 10 });
    const d = await detail(datasetId);
    expect(codes(d)).toContain("review_did_not_report");
    expect(codes(d)).not.toContain("review_running");
    const summary = await review(datasetId);
    expect(summary.reasons).toContain("review_did_not_report");
    expect(summary.reasons).not.toContain("review_running");
  });
});

// ============================================================================

describe("the detail and the approval gate read one review as one", () => {
  let server: Server;

  beforeAll(() => {
    // A stand-in for api.github.com: the screen gate's read of `main`, which is the screened head.
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (req.method === "GET" && /\/git\/ref\/heads\/main$/.test(path)) {
          return Response.json({ object: { sha: SCREENED_HEAD } });
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

  function gateEnv(): Bindings {
    return env({
      GITHUB_ADMIN_PAT: "ghp_review_view_test",
      PRESCREEN_CALLBACK_SECRET: "review-view-secret",
      API_BASE_URL: "https://api.test.nemar.org",
    });
  }

  /** The reason codes the approval gate refuses an approval with, no override sent. */
  async function refusedWith(datasetId: string): Promise<string[]> {
    const res = await app.request(
      `/admin/publish/${datasetId}/approve`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ resume: true }),
      },
      gateEnv(),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as PublicationReviewGateRefusalBody;
    expect(body.error).toBe("publication_review_not_clear");
    return body.reasons.map((r) => r.code);
  }

  test("for one approving request the detail's reasons are the gate's refusal, young row or old", async () => {
    const { requestId, datasetId } = request({ requestStatus: "approving" });
    seedPublicationReview(db, {
      requestId,
      datasetId,
      state: "dispatched",
      createdMinutesAgo: 10,
      claimed: true,
    });
    const young = (await detail(datasetId, gateEnv())).reasons.map((r) => r.code);
    expect(young).toEqual(["review_running"]);
    expect(await refusedWith(datasetId)).toEqual(young);

    db.run("UPDATE publication_reviews SET created_at = datetime('now', '-90 minutes')");
    const old = (await detail(datasetId, gateEnv())).reasons.map((r) => r.code);
    expect(old).toEqual(["review_did_not_report"]);
    expect(await refusedWith(datasetId)).toEqual(old);
  });
});

// ============================================================================

describe("the exports the approval gate reads through", () => {
  test("readReviewContext reads the columns the derivation needs, and no nonce", async () => {
    const { requestId, datasetId } = request({ status: "review" });
    db.run("UPDATE datasets SET total_files = 321 WHERE dataset_id = ?", [datasetId]);
    db.run(
      "UPDATE publication_requests SET steps_completed = ?, identifier_screen_nonce = ? WHERE id = ?",
      [JSON.stringify(["ci_check"]), NONCE_SENTINEL, requestId],
    );
    const ctx = await readReviewContext(env(), requestId);
    expect(ctx).not.toBeNull();
    expect(ctx?.request).toMatchObject({
      id: requestId,
      dataset_id: datasetId,
      status: "requested",
      steps_completed: JSON.stringify(["ci_check"]),
      identifier_screen_ack_by: null,
      identifier_screen_ack_at: null,
    });
    expect(ctx?.dataset).toMatchObject({ source: null, is_exemplar: 0, total_files: 321 });
    expect(JSON.stringify(ctx)).not.toContain(NONCE_SENTINEL);
    expect(Object.keys(ctx?.request ?? {}).filter((k) => /nonce/i.test(k))).toEqual([]);
    expect(await readReviewContext(env(), requestId + 1000)).toBeNull();
    // A dataset row that is gone is a null dataset, as the derivation expects.
    db.run("PRAGMA foreign_keys = OFF");
    db.run("DELETE FROM datasets WHERE dataset_id = ?", [datasetId]);
    expect((await readReviewContext(env(), requestId))?.dataset).toBeNull();
  });

  test("readReviewContext throws when the read fails, so a caller refuses rather than guesses", async () => {
    const { requestId } = request();
    const failing = env({
      DB: interceptingD1(realD1(db), (sql) => {
        if (/FROM publication_requests pr/.test(sql)) throw new Error("D1_ERROR: simulated");
      }),
    });
    await expect(readReviewContext(failing, requestId)).rejects.toThrow("simulated");
  });

  test("each reason carries the line the description prints for it, with the detail in words", async () => {
    // A client prints `line` and composes nothing from `detail`, whose closed words (a document
    // key, a run error) are not words for a person.
    const withheld = request();
    seedPublicationReview(db, {
      requestId: withheld.requestId,
      datasetId: withheld.datasetId,
      state: "reported",
      report: {
        ...failingReport(),
        evidence: evidenceFor(SCREENED_HEAD, false, {
          documents: {
            readme: "withheld_unreadable",
            dataset_description: "sent",
            changes: "sent",
            license: "sent",
            participants_json: "withheld_not_json",
          },
        }),
      },
    });
    const a = await detail(withheld.datasetId);
    expect(a.reasons.map((r) => r.code)).toEqual([
      "question_failed",
      "text_withheld",
      "question_unknown",
    ]);
    for (const [i, r] of a.reasons.entries()) {
      expect({ code: r.code, line: r.line }).toEqual({
        code: r.code,
        line: a.description.lines[i],
      });
    }
    const withheldLine = a.reasons[1].line as string;
    expect(withheldLine).toContain("README");
    expect(withheldLine).not.toContain("participants_json");
    // The model's findings against a failed question are in the line the description prints.
    expect(a.reasons[0].line).toContain("findings:");

    const errored = request();
    seedPublicationReview(db, {
      requestId: errored.requestId,
      datasetId: errored.datasetId,
      state: "errored",
      detail: "model_unavailable",
    });
    const b = await detail(errored.datasetId);
    expect(b.reasons.map((r) => r.code)).toEqual(["review_could_not_run"]);
    expect(b.reasons[0].line).toBe(b.description.lines[0]);
    expect(b.reasons[0].line).toContain("the reviewing model was unavailable");
    expect(b.reasons[0].line).not.toContain("model_unavailable");
  });

  test("reasonViewsOf is the detail's reasons: the shared words, with the cure for this dataset and request", async () => {
    const { requestId, datasetId } = request();
    seedPublicationReview(db, { requestId, datasetId, state: "errored", detail: "model_refused" });
    const ctx = await readReviewContext(env(), requestId);
    if (ctx === null) throw new Error("no such request");
    const d = await derivePublicationReview({ env: env(), nowMs: Date.now(), ...ctx });
    const views = reasonViewsOf(d.reasons, datasetId, d.startable, reportOf(d.rowView));
    expect(views).toEqual((await detail(datasetId)).reasons);
    expect(views.map((v) => v.code)).toEqual(["review_could_not_run"]);
    expect(views[0].cure).toContain(`nemar admin publish start ${datasetId}`);
    // The cure of a request no start reaches is worded without the start.
    // No report: the cure does not depend on one.
    expect(reasonViewsOf(d.reasons, datasetId, false, null)[0].cure).not.toContain("publish start");
  });
});
