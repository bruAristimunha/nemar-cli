/**
 * Starting a publication review from a stored screen result, through the real routes (ADR 0102).
 *
 * A screen result reaches POST /webhooks/identifier-screen-result; when its gate is clear or needs
 * an acknowledgment, the Worker records a review of THAT commit and dispatches it, subject to the
 * flag, the dataset's owner, the request's state and the daily caps. Every other result starts
 * nothing. A fault in the review never fails the callback that stores the screen.
 *
 * The test enters where production does, at the screen's callback, and reads what a person or the
 * database would: the review rows, the dispatches the stand-in recorded, the request.
 * The callbacks that answer a dispatch are in publication-review-callbacks.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { DATASET_STATUSES } from "../../shared/identifier-screen-report";
import {
  DEPOSITOR_DAILY_CAP,
  NEVER_REACHED_MODEL,
  PLATFORM_DAILY_CAP,
} from "../../shared/publication-review";
import { DEPOSITOR_RANK_SQL, startPublicationReview } from "../src/services/publication-review";
import { interceptingD1, realD1, wrapD1, yieldingD1 } from "./helpers/d1";
import { SCREENED_HEAD } from "./helpers/identifier-screen";
import {
  type SeedScreenedRequest,
  seedPublicationReview,
  seedScreenedRequest,
} from "./helpers/publication-review";
import {
  CALLBACK_SECRET,
  DEV_DATASET,
  GITHUB_PAT,
  PROD_DATASET,
  answersWithin,
  createHarness,
  reportFor,
} from "./helpers/publication-review-harness";
import { withFakeResend } from "./helpers/resend";

const h = createHarness();

const OTHER_HEAD = "e".repeat(40);
/** The soak fixture of ADR 0102: a reserved id the dev Worker owns. */
const SOAK_FIXTURE = "nm099997";

/** The n-th extra production-owned dataset id (never a live one, never a reserved fixture). */
const ds = (n: number) => `nm${String(1000 + n).padStart(6, "0")}`;

/** A request whose screen is running, and the screen result that finishes it. */
function pending(
  datasetId = PROD_DATASET,
  o: Omit<SeedScreenedRequest, "datasetId" | "status"> = {},
) {
  return seedScreenedRequest(h.db, { ...o, datasetId, status: "pending" });
}

/** Every state a screen can store, sorted into the two the review cares about. */
const REVIEWABLE = [
  "clean",
  "dates-only",
  "no-recordings",
  "review",
  "unchecked",
  "not-screened",
  "clean-edf-only-others-unscreened",
];
const NOT_REVIEWABLE = ["direct-identifiers", "error", "unreported"];

describe("a screen result starts one review of its commit", () => {
  test("a clean result records a dispatched review and hands over exactly the coordinates", async () => {
    const { requestId } = pending();
    const res = await h.screenResult(requestId, PROD_DATASET);
    // The screen's own answer is unchanged by the review.
    expect(res).toEqual({
      status: 200,
      body: { ok: true, dataset_id: PROD_DATASET, state: "clean", blocked: false },
    });

    const [row] = h.reviews();
    expect(row).toMatchObject({
      request_id: requestId,
      dataset_id: PROD_DATASET,
      head_sha: SCREENED_HEAD,
      anonymous: 0,
      state: "dispatched",
      verdict: null,
      detail: null,
      attempts: 1,
      started_by: null,
      claimed_at: null,
    });
    expect(row.nonce).toEqual(expect.any(String));

    const [d] = h.dispatches();
    expect(h.dispatches()).toHaveLength(1);
    expect(d.event_type).toBe("run-publication-review");
    expect(Object.keys(d.client_payload).sort()).toEqual([
      "anonymous",
      "callback_token",
      "dataset_id",
      "environment",
      "head_sha",
      "request_id",
      "review_id",
    ]);
    expect(d.client_payload).toMatchObject({
      dataset_id: PROD_DATASET,
      request_id: requestId,
      review_id: row.id,
      head_sha: SCREENED_HEAD,
      anonymous: false,
      environment: "production",
    });
    // Nothing the dataset wrote, and nothing of the screen, travelled to GitHub.
    const wire = JSON.stringify(h.calls);
    expect(wire).not.toContain("A sufficiently descriptive title");
    expect(wire).not.toContain(".tsv");
    expect(wire).not.toContain("identifier");
    // The review is a read: the dispatch is the only call the Worker made to GitHub.
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /repos/nemarDatasets/.github/dispatches",
    ]);

    // And the token it carries is the one that opens THIS review's claim, and only that.
    const token = d.client_payload.callback_token as string;
    expect((await h.claim(row.id as number, token)).status).toBe(200);
  });

  test("every state whose gate clears or needs an acknowledgment starts one", async () => {
    for (const [i, status] of REVIEWABLE.entries()) {
      const dataset = ds(i);
      const { requestId } = pending(dataset);
      await h.screenResult(requestId, dataset, { status });
      const row = h.reviews().find((r) => r.dataset_id === dataset);
      expect(row, status).toMatchObject({ state: "dispatched", head_sha: SCREENED_HEAD });
    }
    expect(h.dispatches()).toHaveLength(REVIEWABLE.length);
  });

  test("a result that blocks, did not run or did not report starts none", async () => {
    // A blocked request mails its depositor; the capture keeps that off the network.
    await withFakeResend(async () => {
      for (const [i, status] of NOT_REVIEWABLE.entries()) {
        const dataset = ds(50 + i);
        const { requestId } = pending(dataset);
        const res = await h.screenResult(requestId, dataset, { status });
        expect(res.status).toBe(200);
        expect(
          h.reviews().filter((r) => r.dataset_id === dataset),
          status,
        ).toHaveLength(0);
      }
    });
    expect(h.dispatches()).toHaveLength(0);
  });

  test("the two lists above name every state the scanner can report, so a new one must be sorted", () => {
    const scanner = [...DATASET_STATUSES].sort();
    const named = [...REVIEWABLE, "direct-identifiers"].sort();
    expect(named).toEqual(scanner);
  });

  test("a result that blocks leaves the request blocked, and no review of it", async () => {
    const { requestId } = pending();
    await withFakeResend(async () => {
      await h.screenResult(requestId, PROD_DATASET, { status: "direct-identifiers" });
    });
    expect(h.requestRow(requestId)).toMatchObject({
      status: "blocked",
      block_reason: "identifier_screen_findings",
    });
    expect(h.reviews()).toHaveLength(0);
  });

  test("a screen that was blocked for findings and is clear on a re-run is reviewed", async () => {
    // storeScreenResult lifts that one block, so the request waits again and is reviewed.
    const { requestId } = pending(PROD_DATASET, {
      requestStatus: "blocked",
      blockReason: "identifier_screen_findings",
    });
    await h.screenResult(requestId, PROD_DATASET);
    expect(h.requestRow(requestId).status).toBe("requested");
    expect(h.reviews()).toHaveLength(1);
  });

  test("a request blocked for any other reason is not reviewed, whatever its screen says", async () => {
    const { requestId } = pending(PROD_DATASET, {
      requestStatus: "blocked",
      blockReason: "min_requirements_failed",
    });
    await h.screenResult(requestId, PROD_DATASET);
    expect(h.requestRow(requestId)).toMatchObject({
      status: "blocked",
      block_reason: "min_requirements_failed",
    });
    expect(h.reviews()).toHaveLength(0);
    expect(h.dispatches()).toHaveLength(0);
  });

  test("a request that is being approved, denied or published is not reviewed", async () => {
    for (const [i, requestStatus] of (["approving", "denied", "published"] as const).entries()) {
      const dataset = ds(100 + i);
      const { requestId } = pending(dataset, { requestStatus });
      await h.screenResult(requestId, dataset);
      expect(
        h.reviews().filter((r) => r.dataset_id === dataset),
        requestStatus,
      ).toHaveLength(0);
    }
    expect(h.dispatches()).toHaveLength(0);
  });

  test("an OpenNeuro mirror and an exemplar are not reviewed", async () => {
    const mirror = pending(ds(110), { source: "openneuro" });
    const exemplar = pending(ds(111), { isExemplar: 1 });
    await h.screenResult(mirror.requestId, ds(110));
    await h.screenResult(exemplar.requestId, ds(111));
    expect(h.reviews()).toHaveLength(0);
    expect(h.dispatches()).toHaveLength(0);
  });

  test("the kill switch is the word 1: nothing else starts a review", async () => {
    for (const [i, value] of (
      ["0", "", "true", " 1", "1 ", "yes", "ON", undefined] as const
    ).entries()) {
      const dataset = ds(120 + i);
      const { requestId } = pending(dataset);
      await h.screenResult(requestId, dataset, {
        bindings: h.env({ PUBLICATION_REVIEW_ENABLED: value }),
      });
      expect(
        h.reviews().filter((r) => r.dataset_id === dataset),
        String(value),
      ).toHaveLength(0);
    }
    expect(h.dispatches()).toHaveLength(0);
    // The control: the same request with the word 1 is reviewed.
    const { requestId } = pending(ds(130));
    await h.screenResult(requestId, ds(130));
    expect(h.dispatches()).toHaveLength(1);
  });

  test("with the review off the screen is stored and mailed exactly as it was", async () => {
    const { requestId } = pending();
    const res = await h.screenResult(requestId, PROD_DATASET, {
      bindings: h.env({ PUBLICATION_REVIEW_ENABLED: undefined }),
    });
    expect(res.body).toMatchObject({ state: "clean" });
    expect(h.requestRow(requestId).identifier_screen_status).toBe("clean");
    expect(h.calls).toHaveLength(0);
  });

  test("the review's row exists before the admin mail is tried", async () => {
    // ADR 0102, section 6: the mail waits for the review, and the lease can only see a row that
    // has been written. The mail lease is the first statement the callback runs after the start.
    const { requestId } = pending();
    let seenWhenMailTried: number | null = null;
    const watching = interceptingD1(realD1(h.db), (sql) => {
      if (seenWhenMailTried === null && sql.includes("SET identifier_screen_mail_claimed_at")) {
        seenWhenMailTried = (
          h.db.query("SELECT COUNT(*) AS n FROM publication_reviews").get() as { n: number }
        ).n;
      }
    });
    await h.screenResult(requestId, PROD_DATASET, { bindings: h.env({ DB: watching }) });
    expect(seenWhenMailTried).toBe(1);
  });
});

describe("the screen's answer does not wait for the review or the mail", () => {
  test("it answers while GitHub is still taking the dispatch; the review follows, then the mail", async () => {
    // The dispatch may take ten seconds to fail. The screen job's POST must not wait for it, and
    // the review row must still exist before the mail is tried, so the two stay in one task, in
    // that order.
    const { requestId } = pending();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.dispatchStatus = 500;
    h.duringDispatch = () => gate;
    let seenWhenMailTried: number | null = null;
    const watching = interceptingD1(realD1(h.db), (sql) => {
      if (seenWhenMailTried === null && sql.includes("SET identifier_screen_mail_claimed_at")) {
        seenWhenMailTried = (
          h.db.query("SELECT COUNT(*) AS n FROM publication_reviews").get() as { n: number }
        ).n;
      }
    });
    h.deferred = [];
    const res = await answersWithin(
      h.screenResult(requestId, PROD_DATASET, { bindings: h.env({ DB: watching }) }),
    );
    expect(res).toEqual({
      status: 200,
      body: { ok: true, dataset_id: PROD_DATASET, state: "clean", blocked: false },
    });
    // The screen is stored. The review's start is a task of its own, handed to the runtime.
    expect(h.requestRow(requestId).identifier_screen_status).toBe("clean");
    expect(h.deferred).toHaveLength(1);
    // Wait for the dispatch to reach GitHub: the review is written and is out, and no mail yet.
    for (let i = 0; i < 200 && h.dispatches().length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(h.dispatches()).toHaveLength(1);
    expect(h.reviews()[0]).toMatchObject({ state: "dispatched", claimed_at: null });
    expect(seenWhenMailTried).toBeNull();

    release();
    await Promise.allSettled(h.deferred);
    expect(h.reviews()[0]).toMatchObject({ state: "errored", detail: "dispatch_failed" });
    // The mail was tried only now, with the review row written.
    expect(seenWhenMailTried).toBe(1);
  });

  test("a fault in the review cannot fail the answer or keep the mail from being tried", async () => {
    const { requestId } = pending();
    let mailTried = false;
    const faulty = wrapD1(realD1(h.db), (sql) => {
      if (sql.includes("FROM publication_requests pr JOIN datasets d")) {
        throw new Error("D1_ERROR: simulated fault");
      }
      if (sql.includes("SET identifier_screen_mail_claimed_at")) mailTried = true;
    });
    h.deferred = [];
    const res = await h.screenResult(requestId, PROD_DATASET, { bindings: h.env({ DB: faulty }) });
    expect(res.status).toBe(200);
    await Promise.allSettled(h.deferred);
    expect(h.reviews()).toHaveLength(0);
    expect(mailTried).toBe(true);
  });
});

describe("one review of a commit and release kind", () => {
  test("the same commit reported twice is one review and one dispatch", async () => {
    const { requestId } = pending();
    await h.screenResult(requestId, PROD_DATASET);
    h.rearmScreen(requestId);
    await h.screenResult(requestId, PROD_DATASET);
    expect(h.reviews()).toHaveLength(1);
    expect(h.dispatches()).toHaveLength(1);
  });

  test("a new commit is a new review, and the old one is history", async () => {
    const { requestId } = pending();
    await h.screenResult(requestId, PROD_DATASET);
    h.rearmScreen(requestId);
    await h.screenResult(requestId, PROD_DATASET, { head: OTHER_HEAD });
    const rows = h.reviews();
    expect(rows.map((r) => r.head_sha)).toEqual([SCREENED_HEAD, OTHER_HEAD]);
    expect(h.dispatches()).toHaveLength(2);
  });

  test("a re-request that flips the release kind at the same commit makes a second review", async () => {
    const { requestId } = pending();
    await h.screenResult(requestId, PROD_DATASET);
    h.db.run("UPDATE publication_requests SET anonymous = 1 WHERE id = ?", [requestId]);
    h.rearmScreen(requestId);
    await h.screenResult(requestId, PROD_DATASET);
    expect(h.reviews().map((r) => [r.head_sha, r.anonymous])).toEqual([
      [SCREENED_HEAD, 0],
      [SCREENED_HEAD, 1],
    ]);
    expect(h.dispatches().map((d) => d.client_payload.anonymous)).toEqual([false, true]);

    // The same flag and commit again finds the second row and starts nothing.
    h.rearmScreen(requestId);
    await h.screenResult(requestId, PROD_DATASET);
    expect(h.reviews()).toHaveLength(2);
    expect(h.dispatches()).toHaveLength(2);
  });

  test("a result is stored once: a repeat of the same callback starts nothing", async () => {
    const { requestId } = pending();
    await h.screenResult(requestId, PROD_DATASET);
    // The screen's nonce was spent by the first, so the repeat is refused before the hook.
    const again = await h.screenResult(requestId, PROD_DATASET);
    expect(again.status).toBe(401);
    expect(h.reviews()).toHaveLength(1);
  });

  // An attempt that never reached a model is retried by the next screen result for the commit,
  // at no cost. Every other row stands until an administrator starts it again.
  for (const detail of NEVER_REACHED_MODEL) {
    test(`a review that ended ${detail} is started again by the next screen result, at no cost`, async () => {
      const { requestId } = pending();
      const reviewId = seedPublicationReview(h.db, {
        requestId,
        datasetId: PROD_DATASET,
        state: "errored",
        detail,
      });
      await h.screenResult(requestId, PROD_DATASET);
      expect(h.reviews()).toHaveLength(1);
      expect(h.review(reviewId)).toMatchObject({ state: "dispatched", detail: null, attempts: 1 });
      expect(h.dispatches()).toHaveLength(1);
    });
  }

  const standing: [string, string][] = [
    ["declined", "depositor_limit"],
    ["errored", "model_unavailable"],
    ["errored", "workflow_failed"],
    ["unreported", ""],
    ["reported", ""],
    ["dispatched", ""],
  ];
  for (const [rowState, detail] of standing) {
    test(`a ${rowState}${detail ? ` (${detail})` : ""} review stands: a new screen result buys no second call`, async () => {
      const { requestId } = pending();
      const reviewId = seedPublicationReview(h.db, {
        requestId,
        datasetId: PROD_DATASET,
        state: rowState as never,
        detail: detail || undefined,
      });
      const before = JSON.stringify(h.review(reviewId));
      await h.screenResult(requestId, PROD_DATASET);
      expect(JSON.stringify(h.review(reviewId))).toBe(before);
      expect(h.dispatches()).toHaveLength(0);
    });
  }
});

describe("the daily caps", () => {
  function depositor() {
    const { requestId } = seedScreenedRequest(h.db, { datasetId: "nm000900" });
    return h.requestRow(requestId).requested_by as number;
  }

  /** `n` reviews of other datasets by `requestedBy`, each a call that was made. */
  function spend(n: number, requestedBy: number, minutesAgo = 0, from = 0) {
    for (let i = 0; i < n; i++) {
      const dataset = ds(600 + from + i);
      const r = seedScreenedRequest(h.db, { datasetId: dataset, requestedBy });
      seedPublicationReview(h.db, {
        requestId: r.requestId,
        datasetId: dataset,
        state: "reported",
        claimed: true,
        createdMinutesAgo: minutesAgo,
      });
    }
  }

  test("a depositor's sixth call in a day is declined, and sends nothing", async () => {
    const who = depositor();
    spend(DEPOSITOR_DAILY_CAP - 1, who);
    const { requestId } = pending(PROD_DATASET, { requestedBy: who });
    await h.screenResult(requestId, PROD_DATASET);
    expect(h.dispatches()).toHaveLength(1);

    const next = pending(ds(1), { requestedBy: who });
    await h.screenResult(next.requestId, ds(1));
    const declined = h.reviews().find((r) => r.dataset_id === ds(1));
    expect(declined).toMatchObject({
      state: "declined",
      detail: "depositor_limit",
      nonce: null,
      attempts: 1,
    });
    expect(h.dispatches()).toHaveLength(1);
  });

  test("another depositor is not held by this one's allowance", async () => {
    const who = depositor();
    spend(DEPOSITOR_DAILY_CAP, who);
    const { requestId } = pending(PROD_DATASET);
    await h.screenResult(requestId, PROD_DATASET);
    expect(h.dispatches()).toHaveLength(1);
  });

  test("the platform's fifty-first call in a day is declined", async () => {
    // Each by a different depositor, so only the platform's allowance can hold the next.
    for (let i = 0; i < PLATFORM_DAILY_CAP - 1; i++) {
      const dataset = ds(700 + i);
      const r = seedScreenedRequest(h.db, { datasetId: dataset });
      seedPublicationReview(h.db, {
        requestId: r.requestId,
        datasetId: dataset,
        state: "reported",
        claimed: true,
      });
    }
    const last = pending(PROD_DATASET);
    await h.screenResult(last.requestId, PROD_DATASET);
    expect(h.dispatches()).toHaveLength(1);

    const over = pending(ds(2));
    await h.screenResult(over.requestId, ds(2));
    expect(h.reviews().find((r) => r.dataset_id === ds(2))).toMatchObject({
      state: "declined",
      detail: "platform_limit",
      nonce: null,
    });
    expect(h.dispatches()).toHaveLength(1);
  });

  test("calls older than a day, declines, and attempts no model saw do not count", async () => {
    const who = depositor();
    // Five calls made more than a day ago.
    spend(DEPOSITOR_DAILY_CAP, who, 25 * 60, 0);
    // Five declines, and one of each attempt that never reached a model.
    for (let i = 0; i < DEPOSITOR_DAILY_CAP; i++) {
      const dataset = ds(800 + i);
      const r = seedScreenedRequest(h.db, { datasetId: dataset, requestedBy: who });
      seedPublicationReview(h.db, {
        requestId: r.requestId,
        datasetId: dataset,
        state: "declined",
        detail: "platform_limit",
      });
    }
    for (const [i, detail] of NEVER_REACHED_MODEL.entries()) {
      const dataset = ds(820 + i);
      const r = seedScreenedRequest(h.db, { datasetId: dataset, requestedBy: who });
      seedPublicationReview(h.db, {
        requestId: r.requestId,
        datasetId: dataset,
        state: "errored",
        detail,
      });
    }
    const { requestId } = pending(PROD_DATASET, { requestedBy: who });
    await h.screenResult(requestId, PROD_DATASET);
    expect(h.reviews().find((r) => r.request_id === requestId)).toMatchObject({
      state: "dispatched",
    });
  });

  // What a row costs. The claim precedes any model spend, so a row nobody claimed spent nothing,
  // and an `unreported` row nobody ever claimed (the workflow undeployed, Actions down) must not
  // hold an allowance for a day. A row still `dispatched` may yet be claimed, so it counts.
  const COSTS: [string, string | undefined, boolean, boolean][] = [
    // state, detail, claimed, counts
    ["unreported", undefined, false, false],
    ["unreported", undefined, true, true],
    ["errored", "model_unavailable", false, false],
    ["errored", "workflow_failed", false, false],
    ["errored", "model_unavailable", true, true],
    ["errored", "workflow_failed", true, true],
    ["errored", "stale_head", true, false],
    ["errored", "dispatch_failed", false, false],
    ["dispatched", undefined, false, true],
    ["dispatched", undefined, true, true],
    ["declined", "platform_limit", false, false],
    ["reported", undefined, true, true],
  ];
  for (const [rowState, detail, claimed, counts] of COSTS) {
    const label = `${rowState}${detail ? ` (${detail})` : ""}, ${claimed ? "claimed" : "never claimed"}`;
    test(`a depositor's allowance: a ${label} row ${counts ? "counts" : "does not count"}`, async () => {
      const who = depositor();
      for (let i = 0; i < DEPOSITOR_DAILY_CAP; i++) {
        const dataset = ds(1100 + i);
        const r = seedScreenedRequest(h.db, { datasetId: dataset, requestedBy: who });
        seedPublicationReview(h.db, {
          requestId: r.requestId,
          datasetId: dataset,
          state: rowState as never,
          detail,
          claimed,
        });
      }
      const next = pending(PROD_DATASET, { requestedBy: who });
      await h.screenResult(next.requestId, PROD_DATASET);
      expect(h.reviews().find((r) => r.request_id === next.requestId)).toMatchObject(
        counts
          ? { state: "declined", detail: "depositor_limit" }
          : { state: "dispatched", detail: null },
      );
      expect(h.dispatches()).toHaveLength(counts ? 0 : 1);
    });
  }

  test("the platform's allowance is not held by fifty reviews nobody ever claimed", async () => {
    for (let i = 0; i < PLATFORM_DAILY_CAP; i++) {
      const dataset = ds(1200 + i);
      const r = seedScreenedRequest(h.db, { datasetId: dataset });
      seedPublicationReview(h.db, {
        requestId: r.requestId,
        datasetId: dataset,
        state: "unreported",
        createdMinutesAgo: 90,
      });
    }
    const next = pending(PROD_DATASET);
    await h.screenResult(next.requestId, PROD_DATASET);
    expect(h.reviews().find((r) => r.request_id === next.requestId)).toMatchObject({
      state: "dispatched",
    });
  });

  test("an administrator's call on a depositor's request still counts against the depositor", async () => {
    // Intended, not an oversight: an administrator is not held by the depositor's allowance (the
    // allowance exists to stop a depositor spending the platform's money, and an administrator is
    // not one), but the call still costs the platform, so it is the depositor's tally that grows
    // and the depositor's own next request that is held.
    const who = depositor();
    spend(DEPOSITOR_DAILY_CAP, who);
    const first = seedScreenedRequest(h.db, { datasetId: ds(1300), requestedBy: who });
    const second = pending(ds(1301), { requestedBy: who });
    const out = await startPublicationReview(h.env(), {
      requestId: first.requestId,
      datasetId: ds(1300),
      adminUserId: 1,
    });
    expect(out).toMatchObject({ started: true, reason: "dispatched" });
    const tally = h.db.query(DEPOSITOR_RANK_SQL).get(who, Number.MAX_SAFE_INTEGER) as { n: number };
    expect(tally.n).toBe(DEPOSITOR_DAILY_CAP + 1);

    await h.screenResult(second.requestId, ds(1301));
    expect(h.reviews().find((r) => r.request_id === second.requestId)).toMatchObject({
      state: "declined",
      detail: "depositor_limit",
    });
  });

  test("eight concurrent starts by one depositor leave exactly the allowance", async () => {
    const who = depositor();
    const ids: [number, string][] = [];
    for (let i = 0; i < 8; i++) {
      const dataset = ds(900 + i);
      ids.push([pending(dataset, { requestedBy: who }).requestId, dataset]);
    }
    // Real D1 is a round trip per statement, so concurrent callbacks interleave BETWEEN a route's
    // statements. The synchronous test engine would hide a check that is not atomic; this does not.
    const slow = h.env({ DB: yieldingD1(realD1(h.db)) });
    await Promise.all(ids.map(([id, dataset]) => h.screenResult(id, dataset, { bindings: slow })));
    const rows = h.reviews().filter((r) => ids.some(([, d]) => d === r.dataset_id));
    expect(rows).toHaveLength(8);
    expect(rows.filter((r) => r.state === "dispatched")).toHaveLength(DEPOSITOR_DAILY_CAP);
    expect(rows.filter((r) => r.detail === "depositor_limit")).toHaveLength(
      8 - DEPOSITOR_DAILY_CAP,
    );
    expect(h.dispatches()).toHaveLength(DEPOSITOR_DAILY_CAP);
  });

  test("concurrent starts by many depositors leave exactly the platform's allowance", async () => {
    const total = PLATFORM_DAILY_CAP + 6;
    const ids: [number, string][] = [];
    for (let i = 0; i < total; i++) {
      const dataset = ds(1000 + i);
      ids.push([pending(dataset).requestId, dataset]);
    }
    const slow = h.env({ DB: yieldingD1(realD1(h.db)) });
    await Promise.all(ids.map(([id, dataset]) => h.screenResult(id, dataset, { bindings: slow })));
    const rows = h.reviews();
    expect(rows).toHaveLength(total);
    expect(rows.filter((r) => r.state === "dispatched")).toHaveLength(PLATFORM_DAILY_CAP);
    expect(rows.filter((r) => r.detail === "platform_limit")).toHaveLength(6);
    expect(h.dispatches()).toHaveLength(PLATFORM_DAILY_CAP);
  });
});

describe("when the review cannot be handed over", () => {
  test("a GitHub failure is recorded as dispatch_failed and the nonce is cleared", async () => {
    h.dispatchStatus = 500;
    const { requestId } = pending();
    const res = await h.screenResult(requestId, PROD_DATASET);
    expect(res.status).toBe(200);
    expect(h.reviews()[0]).toMatchObject({
      state: "errored",
      detail: "dispatch_failed",
      nonce: null,
      claimed_at: null,
    });
    expect(h.requestRow(requestId).identifier_screen_status).toBe("clean");
  });

  test("the stand-in's hook runs while GitHub accepts a dispatch too, with the row already written", async () => {
    // `duringDispatch` is documented as running while the stand-in answers a dispatch, and it
    // used to run only for a refusal. The row is written before anything is sent, so the hook sees
    // a `dispatched` row whatever the answer is.
    let seen: unknown = null;
    h.duringDispatch = async () => {
      seen = h.reviews()[0]?.state ?? null;
    };
    const { requestId } = pending();
    await h.screenResult(requestId, PROD_DATASET);
    expect(h.dispatchStatus).toBe(204);
    expect(seen).toBe("dispatched");
    expect(h.dispatches()).toHaveLength(1);
    expect(h.reviews()[0]).toMatchObject({ state: "dispatched", claimed_at: null });
  });

  test("a dispatch that fails after the job already claimed it is kept, not failed", async () => {
    // GitHub may have accepted the dispatch and lost only the answer: the job can already be
    // running. Clearing its nonce would make its valid report fail, and a retry could buy a
    // second model call.
    h.dispatchStatus = 500;
    h.duringDispatch = async () => {
      const id = h.reviews()[0].id as number;
      expect((await h.claim(id)).status).toBe(200);
    };
    const { requestId } = pending();
    await h.screenResult(requestId, PROD_DATASET);
    expect(h.reviews()[0]).toMatchObject({
      state: "dispatched",
      claimed_at: expect.any(String),
    });
    expect(h.reviews()[0].nonce).not.toBeNull();

    // The token the failed dispatch carried still answers for the run.
    const token = h.dispatches()[0].client_payload.callback_token as string;
    const id = h.reviews()[0].id as number;
    const result = await h.result(
      id,
      { outcome: "reported", report: reportFor(SCREENED_HEAD, false) },
      token,
    );
    expect(result.status).toBe(200);
    expect(h.reviews()[0]).toMatchObject({ state: "reported", verdict: "pass" });
  });

  test("no GitHub credential: dispatch_unconfigured, nothing sent, the callback still answers", async () => {
    const { requestId } = pending();
    const res = await h.screenResult(requestId, PROD_DATASET, {
      bindings: h.env({ GITHUB_ADMIN_PAT: undefined }),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: "clean" });
    expect(h.reviews()[0]).toMatchObject({
      state: "errored",
      detail: "dispatch_unconfigured",
      nonce: null,
      attempts: 1,
    });
    expect(h.dispatches()).toHaveLength(0);
  });

  test("a database fault after the row is written leaves dispatch_failed and a stored screen", async () => {
    const { requestId } = pending();
    const faulty = wrapD1(realD1(h.db), (sql) => {
      if (sql.includes("COALESCE(SUM(attempts)")) throw new Error("D1_ERROR: simulated fault");
    });
    const res = await h.screenResult(requestId, PROD_DATASET, { bindings: h.env({ DB: faulty }) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: "clean" });
    expect(h.requestRow(requestId).identifier_screen_status).toBe("clean");
    expect(h.reviews()[0]).toMatchObject({
      state: "errored",
      detail: "dispatch_failed",
      nonce: null,
    });
    expect(h.dispatches()).toHaveLength(0);
  });

  test("a fault before anything is written fails nothing: the screen is stored, no review exists", async () => {
    const { requestId } = pending();
    const faulty = wrapD1(realD1(h.db), (sql) => {
      if (sql.includes("FROM publication_requests pr JOIN datasets d")) {
        throw new Error("D1_ERROR: simulated fault");
      }
    });
    const res = await h.screenResult(requestId, PROD_DATASET, { bindings: h.env({ DB: faulty }) });
    expect(res.status).toBe(200);
    expect(h.requestRow(requestId).identifier_screen_status).toBe("clean");
    expect(h.reviews()).toHaveLength(0);
  });

  test("a failed dispatch prints no token, nonce, credential or secret", async () => {
    const lines: string[] = [];
    const originals = { log: console.log, warn: console.warn, error: console.error };
    const grab = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    console.log = grab;
    console.warn = grab;
    console.error = grab;
    h.dispatchStatus = 500;
    try {
      const { requestId } = pending();
      await h.screenResult(requestId, PROD_DATASET);
    } finally {
      Object.assign(console, originals);
    }
    const out = lines.join("\n");
    // The error's name and a closed word for what it was (here GitHub's refusal, by status).
    expect(out).toContain("dispatch failed (Error, http_500)");
    const sent = JSON.stringify(h.calls);
    const token = (h.dispatches()[0].client_payload.callback_token as string) ?? "";
    for (const secret of [token, GITHUB_PAT, CALLBACK_SECRET]) {
      expect(secret.length).toBeGreaterThan(8);
      expect(out).not.toContain(secret);
    }
    expect(sent).toContain(token);
  });
});

describe("each Worker reviews only the datasets it owns", () => {
  test("production starts for its own dataset and says so in the dispatch", async () => {
    const { requestId } = pending(PROD_DATASET);
    await h.screenResult(requestId, PROD_DATASET);
    expect(h.dispatches()[0].client_payload.environment).toBe("production");
  });

  test("the dev Worker starts for a fixture it owns, and the dispatch names the dev environment", async () => {
    const dev = h.env({ ENVIRONMENT: "development" });
    const { requestId } = pending(DEV_DATASET);
    await h.screenResult(requestId, DEV_DATASET, { bindings: dev });
    expect(h.reviews()).toHaveLength(1);
    expect(h.dispatches()[0].client_payload).toMatchObject({
      dataset_id: DEV_DATASET,
      environment: "dev",
    });
  });

  test("the soak fixture nm099997 is the dev Worker's, and production never starts a review for it", async () => {
    // Declared in DEV_OWNED_FIXTURE_IDS before it exists (ADR 0102), so the release that ships the
    // review already stops production claiming it.
    const dev = h.env({ ENVIRONMENT: "development" });
    const mine = pending(SOAK_FIXTURE);
    await h.screenResult(mine.requestId, SOAK_FIXTURE, { bindings: dev });
    expect(h.dispatches().map((d) => d.client_payload)).toEqual([
      expect.objectContaining({ dataset_id: SOAK_FIXTURE, environment: "dev" }),
    ]);

    const other = h.env();
    const theirs = pending(ds(3));
    await h.screenResult(theirs.requestId, ds(3), { bindings: other });
    h.rearmScreen(mine.requestId);
    await h.screenResult(mine.requestId, SOAK_FIXTURE, { bindings: other });
    // Production started one for its own dataset, and none for the fixture.
    expect(h.reviews().filter((r) => r.dataset_id === SOAK_FIXTURE)).toHaveLength(1);
    expect(h.reviews().filter((r) => r.dataset_id === ds(3))).toHaveLength(1);
  });

  test("the dev Worker does not start for a dataset production owns", async () => {
    const dev = h.env({ ENVIRONMENT: "development" });
    const { requestId } = pending(PROD_DATASET);
    const res = await h.screenResult(requestId, PROD_DATASET, { bindings: dev });
    expect(res.status).toBe(200);
    expect(h.reviews()).toHaveLength(0);
    expect(h.dispatches()).toHaveLength(0);
  });

  test("production does not start for a fixture the dev Worker owns", async () => {
    const { requestId } = pending(DEV_DATASET);
    await h.screenResult(requestId, DEV_DATASET);
    expect(h.reviews()).toHaveLength(0);
    expect(h.dispatches()).toHaveLength(0);
  });

  test("an unrecognized environment is production: it does not start for a dev fixture", async () => {
    const { requestId } = pending(DEV_DATASET);
    await h.screenResult(requestId, DEV_DATASET, {
      bindings: h.env({ ENVIRONMENT: "preview" }),
    });
    expect(h.reviews()).toHaveLength(0);
  });
});
