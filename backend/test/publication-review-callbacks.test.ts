/**
 * The publication review's callbacks and watchdog, through the real routes (ADR 0102).
 *
 * The job claims a review (one shot, before it spends anything), and posts its report. The Worker
 * parses the report at the door, derives the verdict, moves a request whose minimum failed back to
 * blocked, and closes a review that never reported. Every way of NOT getting a verdict is checked
 * to leave a row a surface reads as needing a person, never as a pass.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the real Hono routes,
 * real WebCrypto tokens. GitHub is a `Bun.serve()` stand-in (helpers/publication-review-harness).
 * The one statement the stand-in cannot prove is D1's own behavior, which
 * publication-review-d1.test.ts runs on Miniflare.
 */

import { describe, expect, test } from "bun:test";
import {
  NEVER_REACHED_MODEL,
  PUBLICATION_RUN_ERRORS,
  WORKER_ONLY_RUN_ERRORS,
  parsePublicationCallbackOutcome,
} from "../../shared/publication-review";
import { MINIMUM_FAILURES, minimumFailureSentence } from "../../shared/submission-minimums";
import { sanitizeNote } from "../../shared/untrusted-text";
import {
  signIdentifierScreenCallbackToken,
  signIdentifierSweepCallbackToken,
  signManifestCallbackToken,
  signPrescreenCallbackToken,
} from "../src/services/github";
import {
  signPrReviewCallbackToken,
  signPublicationReviewCallbackToken,
} from "../src/services/github/callback-tokens";
import { notifyAdminsOfScreen } from "../src/services/identifier-screen";
import {
  CAP_CALLS_SQL,
  PLATFORM_RANK_SQL,
  STORE_RESULT_SQL_MARKER,
  startPublicationReview,
  storePublicationReviewResult,
  sweepPublicationReviews,
} from "../src/services/publication-review";
import { hashApiKey } from "../src/services/token";
import type { Bindings } from "../src/types/bindings";
import { interceptingD1, realD1 } from "./helpers/d1";
import { SCREENED_HEAD } from "./helpers/identifier-screen";
import { logged } from "./helpers/logs";
import {
  evidenceFor,
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
  hookedD1,
  reportFor,
} from "./helpers/publication-review-harness";
import { sendsTo, withFakeResend } from "./helpers/resend";

const h = createHarness();

const OTHER_HEAD = "f".repeat(40);
const ADMIN_EMAIL = "revadmin@example.org";

/** The n-th extra production-owned dataset id (never a live one, never a reserved fixture). */
const ds = (n: number) => `nm${String(1000 + n).padStart(6, "0")}`;

function seedAdmin() {
  h.db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access)
     VALUES ('rev_admin', ?, 'x', 'approved', 'admin', 1, 1)`,
    [ADMIN_EMAIL],
  );
}

/** A bearer key for an existing account, which is how a terminal (and these tests) reach a route. */
async function keyFor(userId: number, label: string): Promise<string> {
  const key = `${label}-key-0123456789abcdef0123456789abcdef`;
  h.db
    .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
    .run(userId, await hashApiKey(key), key.slice(0, 8));
  return key;
}

/** A new account that can use the API, with its bearer key. */
async function keyedUser(
  username: string,
  role: "admin" | "member",
): Promise<{ id: number; key: string }> {
  h.db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        service_access, sandbox_completed)
     VALUES (?, ?, 'x', 'approved', ?, 1, 1, 1)`,
    [username, `${username}@example.org`, role],
  );
  const row = h.db.query("SELECT id FROM users WHERE username = ?").get(username) as { id: number };
  return { id: row.id, key: await keyFor(row.id, username) };
}

/** A native request with a clear screen at SCREENED_HEAD and one review of it, dispatched. */
function dispatched(
  o: {
    dataset?: string;
    anonymous?: boolean;
    state?: "dispatched" | "unreported";
    minutesAgo?: number;
    mailed?: boolean;
    /** The job took its claim, as every real run does before it reports. */
    claimed?: boolean;
  } = {},
) {
  const datasetId = o.dataset ?? PROD_DATASET;
  const { requestId } = seedScreenedRequest(h.db, {
    datasetId,
    anonymous: o.anonymous,
    mailed: o.mailed,
  });
  const reviewId = seedPublicationReview(h.db, {
    requestId,
    datasetId,
    anonymous: o.anonymous,
    state: o.state ?? "dispatched",
    createdMinutesAgo: o.minutesAgo,
    claimed: o.claimed,
  });
  return { requestId, reviewId, datasetId };
}

/** A report whose submission minimum failed at `head`, as a job would post it. */
const failing = (head = SCREENED_HEAD, anonymous = false) =>
  reportFor(head, anonymous, {
    evidence: evidenceFor(head, anonymous, {
      minimums: "failed",
      minimum_failures: anonymous
        ? ["authors_not_blinded", "ethics_statement_missing"]
        : ["name_too_short", "ethics_statement_missing"],
      name_length: 10,
    }),
  });

const state = (id: number) => h.review(id);

describe("the claim", () => {
  test("the first claim is taken, once; a replay is refused and the nonce stays live", async () => {
    const { reviewId } = dispatched();
    const token = await h.tokenFor(reviewId);
    const first = await h.claim(reviewId, token);
    expect(first).toEqual({ status: 200, body: { ok: true, claimed: true } });
    expect(state(reviewId)).toMatchObject({ state: "dispatched", claimed_at: expect.any(String) });
    expect(h.nonceOf(reviewId)).not.toBeNull();

    const again = await h.claim(reviewId, token);
    expect(again).toEqual({
      status: 409,
      body: { ok: false, claimed: false, reason: "already_claimed" },
    });
  });

  test("a review the watchdog gave up on can still be claimed by a slow job", async () => {
    const { reviewId } = dispatched({ state: "unreported", minutesAgo: 120 });
    expect((await h.claim(reviewId)).status).toBe(200);
  });

  test("a missing, forged or truncated token is 401 with the same bytes every time", async () => {
    const { reviewId } = dispatched();
    const good = await h.tokenFor(reviewId);
    const bodies = new Set<string>();
    for (const token of [`${good.slice(0, -4)}0000`, good.slice(0, 20), "x"]) {
      const res = await h.app.request(
        "/webhooks/publication-review-claim",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Webhook-Token": token },
          body: JSON.stringify({ review_id: reviewId, dataset_id: PROD_DATASET }),
        },
        h.env(),
      );
      expect(res.status).toBe(401);
      bodies.add(await res.text());
    }
    const none = await h.app.request(
      "/webhooks/publication-review-claim",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ review_id: reviewId, dataset_id: PROD_DATASET }),
      },
      h.env(),
    );
    expect(none.status).toBe(401);
    bodies.add(await none.text());
    // A review that does not exist gives the same answer as a token that does not verify.
    const missing = await h.claim(9999, good);
    expect(missing.status).toBe(401);
    bodies.add(JSON.stringify(missing.body));
    expect(bodies.size).toBe(1);
    expect(state(reviewId).claimed_at).toBeNull();
  });

  test("a token minted for any other kind of callback opens nothing", async () => {
    const { requestId, reviewId } = dispatched();
    const nonce = h.nonceOf(reviewId) as string;
    const screenShaped = { datasetId: PROD_DATASET, requestId: reviewId, nonce };
    const others = [
      await signPrReviewCallbackToken(
        { datasetId: PROD_DATASET, reviewId, nonce },
        CALLBACK_SECRET,
      ),
      await signPrescreenCallbackToken(screenShaped, CALLBACK_SECRET),
      await signIdentifierScreenCallbackToken(screenShaped, CALLBACK_SECRET),
      await signIdentifierSweepCallbackToken({ datasetId: PROD_DATASET, nonce }, CALLBACK_SECRET),
      await signManifestCallbackToken(
        { datasetId: PROD_DATASET, version: String(reviewId), nonce },
        CALLBACK_SECRET,
      ),
    ];
    for (const token of others) {
      expect((await h.claim(reviewId, token)).status).toBe(401);
      expect(
        (await h.result(reviewId, { outcome: "error", error: "model_refused" }, token)).status,
      ).toBe(401);
    }
    expect(requestId).toBeGreaterThan(0);
    expect(state(reviewId)).toMatchObject({ state: "dispatched", claimed_at: null });
  });

  test("a token for another review, another dataset or another secret opens nothing", async () => {
    const a = dispatched();
    const b = dispatched({ dataset: "nm000481" });
    const nonceA = h.nonceOf(a.reviewId) as string;
    // Review B's token presented for review A.
    expect((await h.claim(a.reviewId, await h.tokenFor(b.reviewId, "nm000481"))).status).toBe(401);
    // A's token signed for the wrong dataset.
    const wrongDataset = await signPublicationReviewCallbackToken(
      { datasetId: "nm000481", reviewId: a.reviewId, nonce: nonceA },
      CALLBACK_SECRET,
    );
    expect((await h.claim(a.reviewId, wrongDataset)).status).toBe(401);
    // The right payload under the wrong secret.
    const wrongSecret = await signPublicationReviewCallbackToken(
      { datasetId: PROD_DATASET, reviewId: a.reviewId, nonce: nonceA },
      "another-secret",
    );
    expect((await h.claim(a.reviewId, wrongSecret)).status).toBe(401);
    // A body naming the other dataset finds no waiting review of that id.
    expect(
      (await h.claim(a.reviewId, await h.tokenFor(a.reviewId), undefined, "nm000481")).status,
    ).toBe(401);
    expect(state(a.reviewId).claimed_at).toBeNull();
  });

  test("the callback secret unset is a 500 and nothing is touched", async () => {
    const { reviewId } = dispatched();
    const token = await h.tokenFor(reviewId);
    const res = await h.claim(reviewId, token, h.env({ PRESCREEN_CALLBACK_SECRET: undefined }));
    expect(res.status).toBe(500);
    expect(state(reviewId).claimed_at).toBeNull();
  });

  test("a malformed dataset id or review id is a 400 before anything is read", async () => {
    const { reviewId } = dispatched();
    for (const body of [
      { review_id: reviewId, dataset_id: "not-a-dataset" },
      { review_id: reviewId },
      { review_id: 0, dataset_id: PROD_DATASET },
      { review_id: "1", dataset_id: PROD_DATASET },
      { review_id: 1.5, dataset_id: PROD_DATASET },
    ]) {
      const res = await h.app.request(
        "/webhooks/publication-review-claim",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Webhook-Token": "t" },
          body: JSON.stringify(body),
        },
        h.env(),
      );
      expect(res.status).toBe(400);
    }
  });

  test("a claim after the result finds nothing to verify", async () => {
    const { reviewId } = dispatched();
    const token = await h.tokenFor(reviewId);
    expect((await h.claim(reviewId, token)).status).toBe(200);
    expect(
      (
        await h.result(
          reviewId,
          { outcome: "reported", report: reportFor(SCREENED_HEAD, false) },
          token,
        )
      ).status,
    ).toBe(200);
    expect((await h.claim(reviewId, token)).status).toBe(401);
  });

  // Each of these is a way the request stopped being the one the review was dispatched for. The
  // claim must refuse, record `stale_head`, and leave the row free of the caps: no model was reached.
  const staleBy: [string, string, (requestId: number) => void][] = [
    [
      "the screen was run again and moved the head",
      "moved head",
      (id) => {
        h.rearmScreen(id);
        h.db.run(
          `UPDATE publication_requests SET identifier_screen_status = 'clean',
                  identifier_screen_report = json_set((SELECT identifier_screen_report FROM
                    publication_requests WHERE id = ?1), '$.head', ?2) WHERE id = ?1`,
          [id, OTHER_HEAD],
        );
      },
    ],
    [
      "the request was blocked",
      "blocked",
      (id) =>
        h.db.run(
          "UPDATE publication_requests SET status = 'blocked', block_reason = 'ci_failed' WHERE id = ?",
          [id],
        ),
    ],
    [
      "the request was denied",
      "denied",
      (id) => h.db.run("UPDATE publication_requests SET status = 'denied' WHERE id = ?", [id]),
    ],
    [
      "the request moved on to approving",
      "approving",
      (id) => h.db.run("UPDATE publication_requests SET status = 'approving' WHERE id = ?", [id]),
    ],
    [
      "the request was published",
      "published",
      (id) => h.db.run("UPDATE publication_requests SET status = 'published' WHERE id = ?", [id]),
    ],
    [
      "the release kind changed",
      "flag",
      (id) => h.db.run("UPDATE publication_requests SET anonymous = 1 WHERE id = ?", [id]),
    ],
    [
      "the screen now blocks",
      "blocks",
      (id) =>
        h.db.run(
          "UPDATE publication_requests SET identifier_screen_status = 'direct-identifiers' WHERE id = ?",
          [id],
        ),
    ],
    [
      "the screen is running again",
      "pending",
      (id) =>
        h.db.run(
          "UPDATE publication_requests SET identifier_screen_status = 'pending' WHERE id = ?",
          [id],
        ),
    ],
    [
      "the screen has no report to name a commit",
      "no report",
      (id) =>
        h.db.run("UPDATE publication_requests SET identifier_screen_report = NULL WHERE id = ?", [
          id,
        ]),
    ],
  ];
  for (const [label, , change] of staleBy) {
    test(`${label}: the claim is refused and recorded as stale_head`, async () => {
      const { requestId, reviewId } = dispatched();
      const token = await h.tokenFor(reviewId);
      change(requestId);
      const res = await h.claim(reviewId, token);
      expect(res).toEqual({
        status: 409,
        body: { ok: false, claimed: false, reason: "stale_head" },
      });
      expect(state(reviewId)).toMatchObject({
        state: "errored",
        detail: "stale_head",
        nonce: null,
        claimed_at: null,
      });
      // It never reached a model, so it is not counted against any cap.
      const counted = h.db
        .query(`SELECT ${CAP_CALLS_SQL} AS n FROM publication_reviews WHERE id = ?`)
        .get(reviewId) as { n: number };
      expect(counted.n).toBe(0);
      // And the token is spent.
      expect((await h.claim(reviewId, token)).status).toBe(401);
    });
  }

  test("every state the screen's gate clears or acknowledges is claimable", async () => {
    // The control for the refusals above: the SAME request, in each reviewable state, is claimed.
    const reviewable = [
      "clean",
      "dates-only",
      "no-recordings",
      "review",
      "unchecked",
      "not-screened",
      "clean-edf-only-others-unscreened",
    ];
    for (const [i, screenState] of reviewable.entries()) {
      const dataset = ds(i);
      const { requestId } = seedScreenedRequest(h.db, {
        datasetId: dataset,
        status: screenState as never,
      });
      const reviewId = seedPublicationReview(h.db, {
        requestId,
        datasetId: dataset,
        state: "dispatched",
      });
      expect((await h.claim(reviewId, undefined, undefined, dataset)).status).toBe(200);
    }
  });

  test("the review switched off before the job starts: 409, closed as review_disabled", async () => {
    const { reviewId } = dispatched();
    const token = await h.tokenFor(reviewId);
    const res = await h.claim(reviewId, token, h.env({ PUBLICATION_REVIEW_ENABLED: undefined }));
    expect(res).toEqual({
      status: 409,
      body: { ok: false, claimed: false, reason: "review_disabled" },
    });
    expect(state(reviewId)).toMatchObject({
      state: "errored",
      detail: "review_disabled",
      nonce: null,
      claimed_at: null,
    });
    expect((await h.claim(reviewId, token)).status).toBe(401);
  });

  test("the kill switch is the word 1: nothing else lets a claim through", async () => {
    for (const [i, value] of ["0", "", "true", " 1", "1 ", "yes", "ON"].entries()) {
      const dataset = ds(20 + i);
      const { reviewId } = dispatched({ dataset });
      const res = await h.claim(
        reviewId,
        undefined,
        h.env({ PUBLICATION_REVIEW_ENABLED: value }),
        dataset,
      );
      expect(res.status).toBe(409);
      expect(res.body.reason).toBe("review_disabled");
    }
  });

  test("a review of a dataset the other Worker owns is not claimed here, and nothing is written", async () => {
    // The dev Worker answers only from its own D1, for the datasets it owns.
    const prodRow = dispatched();
    const asDev = await h.claim(prodRow.reviewId, undefined, h.env({ ENVIRONMENT: "development" }));
    expect(asDev).toEqual({
      status: 409,
      body: { ok: false, claimed: false, reason: "not_owned_here" },
    });
    expect(state(prodRow.reviewId)).toMatchObject({ state: "dispatched", claimed_at: null });
    expect(h.nonceOf(prodRow.reviewId)).not.toBeNull();

    // Production never claims for a dataset dev owns.
    const devRow = dispatched({ dataset: DEV_DATASET });
    const asProd = await h.claim(devRow.reviewId, undefined, undefined, DEV_DATASET);
    expect(asProd.body.reason).toBe("not_owned_here");
    expect(state(devRow.reviewId)).toMatchObject({ state: "dispatched", claimed_at: null });

    // And the owners do claim.
    expect(
      (
        await h.claim(
          devRow.reviewId,
          undefined,
          h.env({ ENVIRONMENT: "development" }),
          DEV_DATASET,
        )
      ).status,
    ).toBe(200);
  });

  test("a request that changes between the claim and its refusal is closed, not stranded", async () => {
    // The claim and the refusal each read the request. If it flips between them twice, neither
    // settles, and the attempt must still end: closed as stale_head, never left dispatched.
    const { requestId, reviewId } = dispatched();
    let claimTries = 0;
    let staleTries = 0;
    const flipping = interceptingD1(realD1(h.db), (sql) => {
      if (sql.includes("SET claimed_at = datetime('now')")) {
        claimTries++;
        h.db.run("UPDATE publication_requests SET status = 'blocked' WHERE id = ?", [requestId]);
      }
      if (sql.includes("detail = 'stale_head'") && sql.includes("NOT EXISTS")) {
        staleTries++;
        h.db.run("UPDATE publication_requests SET status = 'requested' WHERE id = ?", [requestId]);
      }
    });
    const res = await h.claim(reviewId, undefined, h.env({ DB: flipping }));
    expect(res).toEqual({
      status: 409,
      body: { ok: false, claimed: false, reason: "claim_unsettled" },
    });
    expect(claimTries).toBe(2);
    expect(staleTries).toBe(2);
    expect(state(reviewId)).toMatchObject({ state: "errored", detail: "stale_head", nonce: null });
  });

  test("a request that becomes current again before the refusal is written is claimed", async () => {
    const { requestId, reviewId } = dispatched();
    h.db.run("UPDATE publication_requests SET status = 'blocked' WHERE id = ?", [requestId]);
    let claimTries = 0;
    const healing = interceptingD1(realD1(h.db), (sql) => {
      if (sql.includes("SET claimed_at = datetime('now')")) claimTries++;
      if (sql.includes("detail = 'stale_head'") && sql.includes("NOT EXISTS")) {
        h.db.run("UPDATE publication_requests SET status = 'requested' WHERE id = ?", [requestId]);
      }
    });
    const res = await h.claim(reviewId, undefined, h.env({ DB: healing }));
    expect(res.status).toBe(200);
    expect(claimTries).toBe(2);
    expect(state(reviewId).claimed_at).not.toBeNull();
  });

  test("a refused claim tells the administrators, once, because the request is waiting on it", async () => {
    seedAdmin();
    const { requestId, reviewId } = dispatched({ mailed: false });
    h.db.run(
      "UPDATE publication_requests SET identifier_screen_report = json_set(identifier_screen_report, '$.head', ?) WHERE id = ?",
      [OTHER_HEAD, requestId],
    );
    await withFakeResend(async (calls) => {
      expect((await h.claim(reviewId)).body.reason).toBe("stale_head");
      expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(1);
    });
  });
});

describe("the result", () => {
  test("a passing report is stored, its verdict derived, the token spent", async () => {
    const { reviewId } = dispatched({ claimed: true });
    const token = await h.tokenFor(reviewId);
    await h.claim(reviewId, token);
    const res = await h.result(
      reviewId,
      { outcome: "reported", report: reportFor(SCREENED_HEAD, false) },
      token,
    );
    expect(res).toEqual({ status: 200, body: { ok: true, dataset_id: PROD_DATASET } });
    const row = state(reviewId);
    expect(row).toMatchObject({ state: "reported", verdict: "pass", detail: null, nonce: null });
    expect(row.decided_at).not.toBeNull();
    const stored = JSON.parse(row.report as string);
    expect(stored.evidence.head).toBe(SCREENED_HEAD);
    expect(stored.questions.name_adequate).toBe("pass");
    // A replay finds nothing to verify.
    expect(
      (
        await h.result(
          reviewId,
          { outcome: "reported", report: reportFor(SCREENED_HEAD, false) },
          token,
        )
      ).status,
    ).toBe(401);
  });

  test("the verdict is derived by the Worker: a failing question fails, an unknown one needs a person", async () => {
    const cases: [Record<string, string>, string][] = [
      [{ meets_standards: "fail" }, "fail"],
      [{ authors_and_license: "unknown" }, "action_required"],
    ];
    for (const [answers, verdict] of cases) {
      const { reviewId } = dispatched({ claimed: true, dataset: ds(verdict === "fail" ? 40 : 41) });
      const questions = {
        complete_and_honest: "pass",
        meets_standards: "pass",
        authors_and_license: "pass",
        name_adequate: "pass",
        ...answers,
      };
      await h.result(
        reviewId,
        { outcome: "reported", report: reportFor(SCREENED_HEAD, false, { questions }) },
        undefined,
        undefined,
        h.review(reviewId).dataset_id as string,
      );
      expect(state(reviewId)).toMatchObject({ state: "reported", verdict });
    }
  });

  test("a steering attempt is a fail whatever the questions say", async () => {
    const { reviewId } = dispatched({ claimed: true });
    await h.result(reviewId, {
      outcome: "reported",
      report: reportFor(SCREENED_HEAD, false, { steering: true }),
    });
    expect(state(reviewId)).toMatchObject({ state: "reported", verdict: "fail" });
  });

  test("a verdict the job claims is not a field of the report: the report is refused", async () => {
    const { reviewId } = dispatched({ claimed: true });
    const res = await h.result(reviewId, {
      outcome: "reported",
      report: { ...reportFor(SCREENED_HEAD, false), verdict: "pass" },
    });
    expect(res.status).toBe(200);
    expect(state(reviewId)).toMatchObject({
      state: "errored",
      detail: "report_invalid",
      verdict: null,
      report: null,
    });
  });

  test("hostile free text is stored as plain words, never as markup", async () => {
    const { reviewId } = dispatched({ claimed: true });
    const note =
      "<script>alert(1)</script> @everyone [click](http://evil.example) ![x](http://evil)";
    await h.result(reviewId, {
      outcome: "reported",
      report: reportFor(SCREENED_HEAD, false, {
        summary: note,
        findings: [
          { question: "name_adequate", severity: "note", code: "other", document: null, note },
        ],
      }),
    });
    const stored = JSON.parse(state(reviewId).report as string);
    expect(stored.summary).toBe(sanitizeNote(note, 400));
    expect(stored.findings[0].note).toBe(sanitizeNote(note, 200));
    for (const text of [stored.summary, stored.findings[0].note]) {
      expect(text).not.toMatch(/[<>]/);
      expect(text).not.toContain("](");
    }
  });

  test("a result that is not a report is never a verdict", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ outcome: "pass" }, "workflow_failed"],
      [{ outcome: "reported", report: { v: 1 } }, "report_invalid"],
      [{ outcome: "reported" }, "report_invalid"],
      [{ outcome: "error", error: "something_else" }, "workflow_failed"],
      [{ outcome: "error" }, "workflow_failed"],
      [{}, "workflow_failed"],
    ];
    let n = 0;
    for (const [body, detail] of cases) {
      const { reviewId } = dispatched({ dataset: ds(50 + n++) });
      await h.result(reviewId, body, undefined, undefined, h.review(reviewId).dataset_id as string);
      expect(state(reviewId)).toMatchObject({
        state: "errored",
        detail,
        verdict: null,
        nonce: null,
      });
    }
  });

  test("a job may report any run error but the Worker's own words", async () => {
    let n = 0;
    for (const word of PUBLICATION_RUN_ERRORS) {
      const { reviewId } = dispatched({ dataset: ds(100 + n++) });
      await h.result(
        reviewId,
        { outcome: "error", error: word },
        undefined,
        undefined,
        h.review(reviewId).dataset_id as string,
      );
      const expected = (WORKER_ONLY_RUN_ERRORS as readonly string[]).includes(word)
        ? "workflow_failed"
        : word;
      expect(state(reviewId)).toMatchObject({ state: "errored", detail: expected });
    }
  });

  test("a report about another commit or another release kind is refused", async () => {
    const wrongHead = dispatched({ claimed: true });
    await h.result(wrongHead.reviewId, {
      outcome: "reported",
      report: reportFor(OTHER_HEAD, false),
    });
    expect(state(wrongHead.reviewId)).toMatchObject({ state: "errored", detail: "report_invalid" });

    const wrongKind = dispatched({ claimed: true, dataset: "nm000481" });
    await h.result(
      wrongKind.reviewId,
      { outcome: "reported", report: reportFor(SCREENED_HEAD, true) },
      undefined,
      undefined,
      "nm000481",
    );
    expect(state(wrongKind.reviewId)).toMatchObject({ state: "errored", detail: "report_invalid" });

    const anonymous = dispatched({ claimed: true, dataset: "nm000482", anonymous: true });
    await h.result(
      anonymous.reviewId,
      { outcome: "reported", report: reportFor(SCREENED_HEAD, true) },
      undefined,
      undefined,
      "nm000482",
    );
    expect(state(anonymous.reviewId)).toMatchObject({ state: "reported" });
  });

  test("a run that was claimed is stored whatever the flag says now", async () => {
    const { reviewId } = dispatched({ claimed: true });
    const token = await h.tokenFor(reviewId);
    await h.claim(reviewId, token);
    const off = h.env({ PUBLICATION_REVIEW_ENABLED: undefined });
    const res = await h.result(
      reviewId,
      { outcome: "reported", report: reportFor(SCREENED_HEAD, false) },
      token,
      off,
    );
    expect(res.status).toBe(200);
    expect(state(reviewId)).toMatchObject({ state: "reported", verdict: "pass" });
  });

  test("a report from a run that never took its claim is refused, as a row that is not waiting is", async () => {
    // A report implies a model call, and a call is made only by a run that claimed. With the flag
    // off the claim route refuses every new claim, so this is also what keeps a result from being
    // stored for a run that was never allowed to spend.
    for (const [i, flag] of ["1", undefined].entries()) {
      const dataset = ds(60 + i);
      const { requestId, reviewId } = dispatched({ dataset, claimed: false });
      const token = await h.tokenFor(reviewId, dataset);
      const nonce = h.nonceOf(reviewId);
      const refused = await h.result(
        reviewId,
        { outcome: "reported", report: reportFor(SCREENED_HEAD, false) },
        token,
        h.env({ PUBLICATION_REVIEW_ENABLED: flag }),
        dataset,
      );
      // The same bytes the route uses for a review that is not waiting.
      const spent = dispatched({ dataset: ds(70 + i), claimed: true });
      await h.result(
        spent.reviewId,
        { outcome: "error", error: "model_refused" },
        undefined,
        undefined,
        spent.datasetId,
      );
      const notWaiting = await h.result(
        spent.reviewId,
        { outcome: "error", error: "model_refused" },
        await signPublicationReviewCallbackToken(
          { datasetId: spent.datasetId, reviewId: spent.reviewId, nonce: "spent" },
          CALLBACK_SECRET,
        ),
        undefined,
        spent.datasetId,
      );
      expect(refused).toEqual(notWaiting);
      expect(refused.status).toBe(401);

      // Nothing was stored, nothing re-blocked, and the token is not spent: the run may still claim.
      expect(state(reviewId)).toMatchObject({ state: "dispatched", report: null, verdict: null });
      expect(h.nonceOf(reviewId)).toBe(nonce);
      expect(h.requestRow(requestId).status).toBe("requested");
    }
  });

  test("a failing minimum in a report nobody claimed re-blocks nothing", async () => {
    const { requestId, reviewId } = dispatched({ claimed: false });
    const res = await h.result(reviewId, { outcome: "reported", report: failing() });
    expect(res.status).toBe(401);
    expect(h.requestRow(requestId)).toMatchObject({ status: "requested", block_reason: null });
  });

  test("the same report lands once the run has claimed", async () => {
    const { reviewId } = dispatched({ claimed: false });
    const token = await h.tokenFor(reviewId);
    const body = { outcome: "reported", report: reportFor(SCREENED_HEAD, false) };
    expect((await h.result(reviewId, body, token)).status).toBe(401);
    expect((await h.claim(reviewId, token)).status).toBe(200);
    expect(await h.result(reviewId, body, token)).toEqual({
      status: 200,
      body: { ok: true, dataset_id: PROD_DATASET },
    });
    expect(state(reviewId)).toMatchObject({ state: "reported", verdict: "pass" });
  });

  test("an error word is recorded whether or not the run took its claim", async () => {
    // A failure before the claim (a payload the job could not validate, a fetch that failed) must
    // still be recorded, or it could not be diagnosed.
    for (const [i, claimed] of [false, true].entries()) {
      for (const flag of ["1", undefined]) {
        const dataset = ds(80 + i * 2 + (flag ? 0 : 1));
        const { reviewId } = dispatched({ dataset, claimed });
        const res = await h.result(
          reviewId,
          { outcome: "error", error: "evidence_unavailable" },
          undefined,
          h.env({ PUBLICATION_REVIEW_ENABLED: flag }),
          dataset,
        );
        expect(res).toEqual({ status: 200, body: { ok: true, dataset_id: dataset } });
        expect(state(reviewId)).toMatchObject({
          state: "errored",
          detail: "evidence_unavailable",
          nonce: null,
        });
      }
    }
  });

  test("the stored report is the parsed one, not the callback body", async () => {
    const { reviewId } = dispatched({ claimed: true });
    const body = reportFor(SCREENED_HEAD, false);
    await h.result(reviewId, { outcome: "reported", report: body });
    const stored = JSON.parse(state(reviewId).report as string);
    expect(Object.keys(stored).sort()).toEqual(Object.keys(body).sort());
    // The raw callback body, with its envelope, is never stored.
    expect(state(reviewId).report as string).not.toContain("review_id");
  });

  test("a replayed result through the service stores nothing twice", async () => {
    const { reviewId } = dispatched({ claimed: true });
    const nonce = h.nonceOf(reviewId) as string;
    const outcome = { kind: "error", error: "model_refused" } as const;
    const first = await storePublicationReviewResult(
      h.env(),
      reviewId,
      PROD_DATASET,
      nonce,
      outcome,
    );
    expect(first).toEqual({ stored: true, state: "errored" });
    const second = await storePublicationReviewResult(h.env(), reviewId, PROD_DATASET, nonce, {
      kind: "error",
      error: "model_truncated",
    });
    expect(second).toEqual({ stored: false, state: null });
    expect(state(reviewId).detail).toBe("model_refused");
  });
});

describe("a failed submission minimum re-blocks the request", () => {
  test("requested becomes blocked/min_requirements_failed, with sentences that quote nothing", async () => {
    const { requestId, reviewId } = dispatched({ claimed: true });
    await h.result(reviewId, { outcome: "reported", report: failing() });
    const req = h.requestRow(requestId);
    expect(req).toMatchObject({ status: "blocked", block_reason: "min_requirements_failed" });
    expect(JSON.parse(req.min_requirements_reasons as string)).toEqual([
      minimumFailureSentence("name_too_short"),
      minimumFailureSentence("ethics_statement_missing"),
    ]);
    // The review itself still reports: a fail with its reason, for the administrator.
    expect(state(reviewId)).toMatchObject({ state: "reported", verdict: "fail" });
  });

  test("every failure word has a sentence, and an anonymous release's names no author", async () => {
    const { requestId, reviewId } = dispatched({ claimed: true, anonymous: true });
    await h.result(reviewId, { outcome: "reported", report: failing(SCREENED_HEAD, true) });
    const reasons = JSON.parse(h.requestRow(requestId).min_requirements_reasons as string);
    expect(reasons).toEqual([
      minimumFailureSentence("authors_not_blinded"),
      minimumFailureSentence("ethics_statement_missing"),
    ]);
    for (const word of MINIMUM_FAILURES) {
      expect(minimumFailureSentence(word).length).toBeGreaterThan(10);
    }
  });

  test("a met minimum leaves the request alone", async () => {
    const { requestId, reviewId } = dispatched({ claimed: true });
    await h.result(reviewId, { outcome: "reported", report: reportFor(SCREENED_HEAD, false) });
    expect(h.requestRow(requestId)).toMatchObject({ status: "requested", block_reason: null });
  });

  test("it does not re-block a request that is no longer waiting for its decision", async () => {
    let n = 0;
    for (const [status, reason] of [
      ["blocked", "ci_failed"],
      ["denied", null],
      ["approving", null],
      ["published", null],
    ] as const) {
      const { requestId, reviewId } = dispatched({ dataset: ds(200 + n++) });
      h.db.run("UPDATE publication_requests SET status = ?, block_reason = ? WHERE id = ?", [
        status,
        reason,
        requestId,
      ]);
      await h.result(
        reviewId,
        { outcome: "reported", report: failing() },
        undefined,
        undefined,
        h.review(reviewId).dataset_id as string,
      );
      expect(h.requestRow(requestId)).toMatchObject({ status, block_reason: reason });
      expect(h.requestRow(requestId).min_requirements_reasons).toBeNull();
    }
  });

  test("it does not re-block when the screened commit has moved since the review started", async () => {
    const { requestId, reviewId } = dispatched({ claimed: true });
    h.db.run(
      "UPDATE publication_requests SET identifier_screen_report = json_set(identifier_screen_report, '$.head', ?) WHERE id = ?",
      [OTHER_HEAD, requestId],
    );
    await h.result(reviewId, { outcome: "reported", report: failing() });
    expect(h.requestRow(requestId).status).toBe("requested");
    expect(state(reviewId)).toMatchObject({ state: "reported" });
  });

  test("it does not re-block when the release kind has changed since", async () => {
    const { requestId, reviewId } = dispatched({ claimed: true });
    h.db.run("UPDATE publication_requests SET anonymous = 1 WHERE id = ?", [requestId]);
    await h.result(reviewId, { outcome: "reported", report: failing() });
    expect(h.requestRow(requestId).status).toBe("requested");
  });

  test("it holds with the flag off: a mechanical refusal does not depend on the review being on", async () => {
    const { requestId, reviewId } = dispatched({ claimed: true });
    const token = await h.tokenFor(reviewId);
    await h.claim(reviewId, token);
    await h.result(
      reviewId,
      { outcome: "reported", report: failing() },
      token,
      h.env({ PUBLICATION_REVIEW_ENABLED: undefined }),
    );
    expect(h.requestRow(requestId)).toMatchObject({
      status: "blocked",
      block_reason: "min_requirements_failed",
    });
  });

  test("a fault on the re-block stores nothing and spends no token, so the job's retry lands", async () => {
    // The result, the re-block and the mail re-arm are ONE unit. Run one after another, a fault
    // on the re-block left the review stored with its nonce spent: the job's retry got 401, the
    // request stayed `requested`, and nobody was ever told it had failed a minimum.
    const { requestId, reviewId } = dispatched({ claimed: true });
    const token = await h.tokenFor(reviewId);
    const nonce = h.nonceOf(reviewId);
    const faulty = hookedD1(realD1(h.db), {
      statement: (sql) => {
        if (sql.includes("SET status = 'blocked'")) throw new Error("D1_ERROR: transient");
      },
    });
    const res = await h.result(
      reviewId,
      { outcome: "reported", report: failing() },
      token,
      h.env({ DB: faulty }),
    );
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "The result could not be stored; try again" });
    expect(state(reviewId)).toMatchObject({
      state: "dispatched",
      verdict: null,
      report: null,
      decided_at: null,
    });
    expect(h.nonceOf(reviewId)).toBe(nonce);
    expect(h.requestRow(requestId)).toMatchObject({ status: "requested", block_reason: null });

    // The retry, with the same token, on a healthy database.
    const retry = await h.result(reviewId, { outcome: "reported", report: failing() }, token);
    expect(retry).toEqual({ status: 200, body: { ok: true, dataset_id: PROD_DATASET } });
    expect(state(reviewId)).toMatchObject({ state: "reported", verdict: "fail", nonce: null });
    expect(h.requestRow(requestId)).toMatchObject({
      status: "blocked",
      block_reason: "min_requirements_failed",
    });
  });

  test("a fault after the re-block has run takes the re-block back with it", async () => {
    // The unit is atomic in both directions: a fault on a LATER statement of the batch (here the
    // last write of the result) must undo the re-block that ran before it, not only a fault on
    // the re-block itself stop the writes after it.
    const { requestId, reviewId } = dispatched({ claimed: true });
    const token = await h.tokenFor(reviewId);
    const nonce = h.nonceOf(reviewId);
    let writes = 0;
    const faulty = hookedD1(realD1(h.db), {
      statement: (sql) => {
        if (sql.includes(STORE_RESULT_SQL_MARKER) && ++writes === 2) {
          throw new Error("D1_ERROR: transient");
        }
      },
    });
    const res = await h.result(
      reviewId,
      { outcome: "reported", report: failing() },
      token,
      h.env({ DB: faulty }),
    );
    // The fault was the second write of the result: a hook that never fired would also leave a 200.
    expect(writes).toBe(2);
    expect(res.status).toBe(500);
    expect(state(reviewId)).toMatchObject({ state: "dispatched", report: null });
    expect(h.nonceOf(reviewId)).toBe(nonce);
    expect(h.requestRow(requestId)).toMatchObject({ status: "requested", block_reason: null });
  });

  test("the store, the re-block and the mail re-arm go to the database as one batch", async () => {
    const { reviewId } = dispatched({ claimed: true, minutesAgo: 45 });
    await sweepPublicationReviews(h.env());
    const alone: string[] = [];
    const batches: string[][] = [];
    const watching = hookedD1(realD1(h.db), {
      statement: (sql, inBatch) => {
        if (!inBatch && /UPDATE (publication_reviews|publication_requests)/.test(sql)) {
          alone.push(sql);
        }
      },
      batch: (sqls) => void batches.push(sqls),
    });
    await h.result(
      reviewId,
      { outcome: "reported", report: failing() },
      undefined,
      h.env({ DB: watching }),
    );
    expect(batches).toHaveLength(1);
    expect(batches[0].some((q) => q.includes("SET status = 'blocked'"))).toBe(true);
    expect(batches[0].some((q) => q.includes("SET identifier_screen_emailed_at = NULL"))).toBe(
      true,
    );
    expect(batches[0].filter((q) => q.includes(STORE_RESULT_SQL_MARKER))).toHaveLength(2);
    // Nothing that changes a review or a request ran outside it (the mail lease is the mail's own).
    expect(alone.filter((q) => !q.includes("identifier_screen_mail_claimed_at"))).toEqual([]);
  });

  test("a replayed or unmatched store never re-blocks, and a replayed late one never re-arms the mail", async () => {
    const { requestId, reviewId } = dispatched({ claimed: true, minutesAgo: 45 });
    const nonce = h.nonceOf(reviewId) as string;
    await sweepPublicationReviews(h.env());
    const outcome = parsePublicationCallbackOutcome({
      outcome: "reported",
      report: failing(),
      error: undefined,
    });

    // A stranger's nonce finds nothing to store, and so nothing to re-block.
    expect(
      await storePublicationReviewResult(h.env(), reviewId, PROD_DATASET, "not-the-nonce", outcome),
    ).toEqual({ stored: false, state: null });
    expect(h.requestRow(requestId).status).toBe("requested");
    expect(h.requestRow(requestId).identifier_screen_emailed_at).not.toBeNull();

    const first = await storePublicationReviewResult(
      h.env(),
      reviewId,
      PROD_DATASET,
      nonce,
      outcome,
    );
    expect(first).toEqual({ stored: true, state: "reported" });
    expect(h.requestRow(requestId).status).toBe("blocked");

    // The depositor fixed the name and asked again at the same commit: the request waits once
    // more, with the mail already sent. A replay of the old callback must change neither.
    h.db.run(
      `UPDATE publication_requests SET status = 'requested', block_reason = NULL,
              min_requirements_reasons = NULL, identifier_screen_emailed_at = datetime('now')
        WHERE id = ?`,
      [requestId],
    );
    const stamp = h.requestRow(requestId).identifier_screen_emailed_at;
    const replay = await storePublicationReviewResult(
      h.env(),
      reviewId,
      PROD_DATASET,
      nonce,
      outcome,
    );
    expect(replay).toEqual({ stored: false, state: null });
    expect(h.requestRow(requestId)).toMatchObject({
      status: "requested",
      block_reason: null,
      min_requirements_reasons: null,
      identifier_screen_emailed_at: stamp,
    });
  });

  test("the depositor is not mailed about it", async () => {
    // Administrators only (ADR 0102, section 6); the depositor reads the block on the status view.
    seedAdmin();
    const { reviewId, requestId } = dispatched({ claimed: true, mailed: false });
    const depositor = h.db
      .query(
        "SELECT u.email FROM publication_requests pr JOIN users u ON u.id = pr.requested_by WHERE pr.id = ?",
      )
      .get(requestId) as { email: string };
    await withFakeResend(async (calls) => {
      await h.result(reviewId, { outcome: "reported", report: failing() });
      expect(sendsTo(calls, depositor.email)).toHaveLength(0);
    });
  });
});

describe("a web approval's claim does not outlive the block it meets", () => {
  /**
   * The website's Approve click, as the route sees it. With the review on, a click while the
   * review is still running needs the administrator's override of `review_running` (ADR 0102): the
   * tests that click over a running review pass it, naming the review they were shown. A click
   * with `reviewOff` is made with the review's flag off, which is how a test about the claim's
   * lifecycle stays about that where the review at the commit would refuse the click.
   */
  const click = (
    key: string,
    o: { datasetId?: string; overrideFor?: number; reviewOff?: boolean } = {},
  ) =>
    h.app.request(
      `/admin/publish/${o.datasetId ?? PROD_DATASET}/approve-dispatch`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "X-CLI-Version": "99.0.0",
          ...(o.overrideFor === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(o.overrideFor === undefined
          ? {}
          : {
              body: JSON.stringify({
                override_publication_review: {
                  review_id: o.overrideFor,
                  reasons: ["review_running"],
                },
              }),
            }),
      },
      o.reviewOff ? h.env({ PUBLICATION_REVIEW_ENABLED: undefined }) : h.env(),
    );

  const claimOf = (requestId: number) => {
    const { approval_requested_by, approval_dispatched_at } = h.requestRow(requestId);
    return { approval_requested_by, approval_dispatched_at };
  };

  // Storing a result tries the administrators' mail: the capture keeps it off the network.

  test("an administrator's click, then a failed minimum: the request is blocked and holds no claim", async () => {
    // The click claims `approval_requested_by` and `approval_dispatched_at` while the request is
    // still `requested`, and the report that arrives afterwards moves it to `blocked`. The
    // orchestrator's own walk-back to `blocked` clears both, for the reason given there.
    const admin = await keyedUser("rev_clicker", "admin");
    const { requestId, reviewId } = dispatched();
    expect((await click(admin.key, { overrideFor: reviewId })).status).toBe(202);
    expect(claimOf(requestId)).toEqual({
      approval_requested_by: admin.id,
      approval_dispatched_at: expect.any(String),
    });

    const token = await h.tokenFor(reviewId);
    await withFakeResend(async () => {
      expect((await h.claim(reviewId, token)).status).toBe(200);
      await h.result(reviewId, { outcome: "reported", report: failing() }, token);
    });

    expect(h.requestRow(requestId)).toMatchObject({
      status: "blocked",
      block_reason: "min_requirements_failed",
    });
    expect(claimOf(requestId)).toEqual({
      approval_requested_by: null,
      approval_dispatched_at: null,
    });
  });

  test("a depositor who fixes it and asks again inside the lease can be approved at once", async () => {
    // With the claim left on the blocked row, the re-request made it `requested` again with a
    // live lease: the next click was refused as "already running" and a terminal approval was
    // attributed to the administrator who had clicked before the block.
    const clicker = await keyedUser("rev_clicker", "admin");
    const next = await keyedUser("rev_next_admin", "admin");
    const { requestId, reviewId, datasetId } = dispatched();
    const depositorId = h.requestRow(requestId).requested_by as number;
    h.db.run("UPDATE users SET sandbox_completed = 1 WHERE id = ?", [depositorId]);
    const depositorKey = await keyFor(depositorId, "rev_depositor");

    await withFakeResend(async () => {
      expect((await click(clicker.key, { overrideFor: reviewId })).status).toBe(202);
      const token = await h.tokenFor(reviewId);
      await h.claim(reviewId, token);
      await h.result(reviewId, { outcome: "reported", report: failing() }, token);
      expect(h.requestRow(requestId).status).toBe("blocked");

      // The depositor asks again, through the real route.
      const again = await h.app.request(
        `/datasets/${datasetId}/publish/request`,
        { method: "POST", headers: { Authorization: `Bearer ${depositorKey}` } },
        h.env(),
      );
      expect(again.status).toBe(200);
      expect(h.requestRow(requestId)).toMatchObject({ status: "requested", block_reason: null });
      expect(claimOf(requestId)).toEqual({
        approval_requested_by: null,
        approval_dispatched_at: null,
      });

      // The re-request reset the screen, as it does; once the screen has read the commit again,
      // nothing is in flight and the next administrator's click is the run, in their name.
      h.rearmScreen(requestId);
      expect((await h.screenResult(requestId, datasetId)).status).toBe(200);
    });
    const list = await h.app.request(
      "/admin/publish/requests?status=requested",
      { headers: { Authorization: `Bearer ${next.key}`, "X-CLI-Version": "99.0.0" } },
      h.env(),
    );
    const rows = ((await list.json()) as { requests: Record<string, unknown>[] }).requests;
    expect(rows.find((r) => r.dataset_id === datasetId)?.approval_in_flight).toBe(false);
    // At the same commit the review's report still says the minimum failed, a hard reason the
    // gate refuses with the review on (its own tests own that). This test is about the lease, so
    // the click is made with the review off.
    expect((await click(next.key, { reviewOff: true })).status).toBe(202);
    expect(claimOf(requestId).approval_requested_by).toBe(next.id);
  });

  test("a request the report does not block keeps the claim of a run that is going", async () => {
    // Only the re-block releases it: a met minimum leaves the request, and the run, alone.
    const admin = await keyedUser("rev_clicker", "admin");
    const { requestId, reviewId } = dispatched();
    expect((await click(admin.key, { overrideFor: reviewId })).status).toBe(202);
    const token = await h.tokenFor(reviewId);
    await withFakeResend(async () => {
      await h.claim(reviewId, token);
      await h.result(
        reviewId,
        { outcome: "reported", report: reportFor(SCREENED_HEAD, false) },
        token,
      );
    });
    expect(h.requestRow(requestId).status).toBe("requested");
    expect(claimOf(requestId).approval_requested_by).toBe(admin.id);
  });
});

describe("the watchdog", () => {
  test("an overdue review becomes unreported with its nonce kept, and the mail is tried once", async () => {
    seedAdmin();
    const { reviewId } = dispatched({ minutesAgo: 45, mailed: false });
    const nonce = h.nonceOf(reviewId);
    await withFakeResend(async (calls) => {
      const r = await sweepPublicationReviews(h.env());
      expect(r).toEqual({ timedOut: 1, mailed: 1, errors: 0, skipped: false });
      expect(state(reviewId)).toMatchObject({ state: "unreported", nonce });
      expect(state(reviewId).decided_at).not.toBeNull();
      expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(1);

      // A second pass finds nothing to do and sends nothing.
      expect(await sweepPublicationReviews(h.env())).toEqual({
        timedOut: 0,
        mailed: 0,
        errors: 0,
        skipped: false,
      });
      expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(1);
    });
  });

  test("a review inside its deadline is untouched, and the boundary is the deadline", async () => {
    const young = dispatched({ minutesAgo: 29 });
    const old = dispatched({ dataset: "nm000481", minutesAgo: 31 });
    await sweepPublicationReviews(h.env());
    expect(state(young.reviewId).state).toBe("dispatched");
    expect(state(old.reviewId).state).toBe("unreported");
  });

  test("only a dispatched row is aged: a reported, errored or unreported one is left alone", async () => {
    const a = dispatched({ minutesAgo: 600 });
    h.db.run(
      "UPDATE publication_reviews SET state='errored', detail='model_refused', nonce=NULL, decided_at=datetime('now') WHERE id = ?",
      [a.reviewId],
    );
    const b = dispatched({ dataset: "nm000481", minutesAgo: 600, state: "unreported" });
    const before = JSON.stringify([state(a.reviewId), state(b.reviewId)]);
    expect(await sweepPublicationReviews(h.env())).toMatchObject({ timedOut: 0 });
    expect(JSON.stringify([state(a.reviewId), state(b.reviewId)])).toBe(before);
  });

  test("outside production nothing changes: the dev Worker never ages a row", async () => {
    const { reviewId } = dispatched({ dataset: DEV_DATASET, minutesAgo: 600 });
    const before = JSON.stringify(state(reviewId));
    for (const environment of ["development", "staging", "test"]) {
      const r = await sweepPublicationReviews(h.env({ ENVIRONMENT: environment }));
      expect(r).toEqual({ timedOut: 0, mailed: 0, errors: 0, skipped: true });
    }
    expect(JSON.stringify(state(reviewId))).toBe(before);
  });

  test("an unknown environment is production, which is the side that ages rows", async () => {
    const { reviewId } = dispatched({ minutesAgo: 600 });
    const r = await sweepPublicationReviews(h.env({ ENVIRONMENT: undefined }));
    expect(r.skipped).toBe(false);
    expect(state(reviewId).state).toBe("unreported");
  });

  test("it runs whatever the flag says, so a switched-off review does not strand a request", async () => {
    const { reviewId } = dispatched({ minutesAgo: 600 });
    await sweepPublicationReviews(h.env({ PUBLICATION_REVIEW_ENABLED: undefined }));
    expect(state(reviewId).state).toBe("unreported");
  });

  test("it handles a bounded batch a tick, oldest first, and finishes the rest on the next", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 25; i++) {
      ids.push(dispatched({ dataset: ds(300 + i), minutesAgo: 600 }).reviewId);
    }
    expect(await sweepPublicationReviews(h.env())).toMatchObject({ timedOut: 20 });
    const left = ids.filter((id) => state(id).state === "dispatched");
    expect(left).toEqual(ids.slice(20));
    expect(await sweepPublicationReviews(h.env())).toMatchObject({ timedOut: 5 });
  });

  test("a late report still lands, re-arms the mail and mails again", async () => {
    seedAdmin();
    const { requestId, reviewId } = dispatched({ claimed: true, minutesAgo: 45, mailed: false });
    const token = await h.tokenFor(reviewId);
    await withFakeResend(async (calls) => {
      await sweepPublicationReviews(h.env());
      expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(1);
      expect(h.requestRow(requestId).identifier_screen_emailed_at).not.toBeNull();

      const late = await h.result(
        reviewId,
        { outcome: "reported", report: reportFor(SCREENED_HEAD, false) },
        token,
      );
      expect(late.status).toBe(200);
      expect(state(reviewId)).toMatchObject({ state: "reported", verdict: "pass", nonce: null });
      // The mail already sent said the review did not report: the late report mails again.
      expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(2);
    });
  });

  test("a report past the deadline re-arms the mail even when no watchdog has marked the row", async () => {
    // The mail goes at the deadline and says the review did not report (the lease frees it
    // there). The watchdog may not have run, errored, or not reached this row among the twenty
    // it takes in a tick, so the row can still be `dispatched` when the report arrives: it is
    // late all the same, and the result has to reach the administrators.
    seedAdmin();
    const { requestId, reviewId } = dispatched({ minutesAgo: 45, mailed: false, claimed: true });
    const token = await h.tokenFor(reviewId);
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(h.env(), requestId)).toBe("sent");
      expect(state(reviewId).state).toBe("dispatched");
      expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(1);

      const late = await h.result(
        reviewId,
        { outcome: "reported", report: reportFor(SCREENED_HEAD, false) },
        token,
      );
      expect(late.status).toBe(200);
      expect(state(reviewId)).toMatchObject({ state: "reported", verdict: "pass" });
      const mails = sendsTo(calls, ADMIN_EMAIL);
      expect(mails).toHaveLength(2);
      expect(mails[1].html).toContain("Publication review: pass");
    });
  });

  test("a report inside the deadline does not re-arm a mail that has already gone", async () => {
    seedAdmin();
    const { requestId, reviewId } = dispatched({ minutesAgo: 10, mailed: true, claimed: true });
    const token = await h.tokenFor(reviewId);
    const stamp = h.requestRow(requestId).identifier_screen_emailed_at;
    await withFakeResend(async (calls) => {
      const res = await h.result(
        reviewId,
        { outcome: "reported", report: reportFor(SCREENED_HEAD, false) },
        token,
      );
      expect(res.status).toBe(200);
      expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(0);
    });
    expect(h.requestRow(requestId).identifier_screen_emailed_at).toBe(stamp);
  });

  test("a report nobody claimed is refused past the deadline too, and re-arms nothing", async () => {
    // The re-arm rides in the same batch as the write and is guarded by the same predicate, so a
    // report the write refuses (no claim was taken) cannot release a mail that already went.
    seedAdmin();
    const { requestId, reviewId } = dispatched({ minutesAgo: 45, mailed: true });
    const token = await h.tokenFor(reviewId);
    const stamp = h.requestRow(requestId).identifier_screen_emailed_at;
    await withFakeResend(async (calls) => {
      const res = await h.result(
        reviewId,
        { outcome: "reported", report: reportFor(SCREENED_HEAD, false) },
        token,
      );
      expect(res.status).toBe(401);
      expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(0);
    });
    expect(state(reviewId)).toMatchObject({ state: "dispatched" });
    expect(h.requestRow(requestId).identifier_screen_emailed_at).toBe(stamp);
  });

  test("a late error outcome re-arms the mail too: a late outcome of any kind is new information", async () => {
    seedAdmin();
    const { requestId, reviewId } = dispatched({ minutesAgo: 45, mailed: false });
    const token = await h.tokenFor(reviewId);
    await withFakeResend(async (calls) => {
      await sweepPublicationReviews(h.env());
      expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(1);
      expect(state(reviewId).state).toBe("unreported");

      const late = await h.result(reviewId, { outcome: "error", error: "model_refused" }, token);
      expect(late.status).toBe(200);
      expect(state(reviewId)).toMatchObject({
        state: "errored",
        detail: "model_refused",
        nonce: null,
      });
      // The first mail said the review did not report; this one says why it could not run.
      const mails = sendsTo(calls, ADMIN_EMAIL);
      expect(mails).toHaveLength(2);
      expect(mails[1].html).toContain("The review could not run");
      expect(h.requestRow(requestId).identifier_screen_emailed_at).not.toBeNull();
    });
  });

  test("a late report for a commit that is no longer the request's does not re-arm its mail", async () => {
    const { requestId, reviewId } = dispatched({ claimed: true, minutesAgo: 45 });
    const token = await h.tokenFor(reviewId);
    await sweepPublicationReviews(h.env());
    h.db.run(
      "UPDATE publication_requests SET identifier_screen_report = json_set(identifier_screen_report, '$.head', ?) WHERE id = ?",
      [OTHER_HEAD, requestId],
    );
    const stamp = h.requestRow(requestId).identifier_screen_emailed_at;
    expect(stamp).not.toBeNull();
    await h.result(
      reviewId,
      { outcome: "reported", report: reportFor(SCREENED_HEAD, false) },
      token,
    );
    expect(h.requestRow(requestId).identifier_screen_emailed_at).toBe(stamp);
  });

  test("a row the watchdog flips between the read and the write is still stored as late", async () => {
    // The route finds the row `dispatched`; the watchdog moves it to `unreported` before the
    // result is written. The write must still be recognised as a late report and re-arm the mail:
    // a write that decided "late" from the earlier read would send nothing here.
    seedAdmin();
    const { requestId, reviewId } = dispatched({ claimed: true, minutesAgo: 45, mailed: true });
    const token = await h.tokenFor(reviewId);
    let flipped = false;
    const racing = hookedD1(realD1(h.db), {
      batch: () => {
        flipped = true;
        h.db.run(
          "UPDATE publication_reviews SET state = 'unreported', decided_at = datetime('now') WHERE id = ? AND state = 'dispatched'",
          [reviewId],
        );
      },
    });
    await withFakeResend(async (calls) => {
      const res = await h.result(
        reviewId,
        { outcome: "reported", report: reportFor(SCREENED_HEAD, false) },
        token,
        h.env({ DB: racing }),
      );
      expect(res.status).toBe(200);
      expect(flipped).toBe(true);
      expect(state(reviewId)).toMatchObject({ state: "reported", nonce: null });
      expect(h.requestRow(requestId).identifier_screen_emailed_at).not.toBeNull();
      // Re-armed and mailed: the screen's mail had already gone, so this send IS the late path.
      expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(1);
    });
  });
});

describe("a result that arrives as the watchdog fires", () => {
  const FLIP =
    "UPDATE publication_reviews SET state = 'unreported', decided_at = datetime('now') WHERE id = ? AND state = 'dispatched'";

  test("a watchdog that lands between the two result writes cannot drop the report", async () => {
    // Two writes, one per state the row can wait in. The only move is `dispatched` to
    // `unreported`, so the write for `dispatched` must come first: written the other way round, a
    // flip between the two leaves BOTH matching nothing, the route says "duplicate", the job does
    // not retry a 200, and the spent model call is lost.
    //
    // The two writes are one batch, which D1 runs as a transaction, so no writer can land between
    // them there: this pins an ordering that matters only if the batch is ever undone. The race
    // has to happen for the pin to mean anything, which is what the two assertions on `writes`
    // and on the stored row below insist on.
    const { reviewId } = dispatched({ minutesAgo: 45, claimed: true });
    const token = await h.tokenFor(reviewId);
    let writes = 0;
    const racing = hookedD1(realD1(h.db), {
      statement: (sql) => {
        if (sql.includes(STORE_RESULT_SQL_MARKER)) {
          writes++;
          if (writes === 2) h.db.run(FLIP, [reviewId]);
        }
      },
    });
    const res = await h.result(
      reviewId,
      { outcome: "reported", report: reportFor(SCREENED_HEAD, false) },
      token,
      h.env({ DB: racing }),
    );
    // Both writes were attempted, and the flip landed between them.
    expect(writes).toBe(2);
    // Stored, and answered as stored: not the harmless "duplicate" of a lost race.
    expect(res).toEqual({ status: 200, body: { ok: true, dataset_id: PROD_DATASET } });
    expect(state(reviewId)).toMatchObject({ state: "reported", verdict: "pass", nonce: null });
    expect(state(reviewId).report).not.toBeNull();
  });
});

describe("the callbacks answer before the mail", () => {
  /** A D1 whose mail lease waits on `gate`, so the mail cannot finish until the test says so. */
  function gatedMail(gate: Promise<void>) {
    return interceptingD1(realD1(h.db), async (sql) => {
      if (sql.includes("SET identifier_screen_mail_claimed_at")) await gate;
    });
  }
  const gateOf = () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { gate, release };
  };

  test("a stored result answers while the mail is still being sent, and the mail follows", async () => {
    // The job's POST has a timeout and its retry finds the token spent, so a slow Resend must not
    // sit inside it. The result is stored before the answer; the mail finishes after it.
    seedAdmin();
    const { reviewId } = dispatched({ claimed: true, mailed: false });
    const { gate, release } = gateOf();
    h.deferred = [];
    await withFakeResend(async (calls) => {
      const res = await answersWithin(
        h.result(
          reviewId,
          { outcome: "reported", report: reportFor(SCREENED_HEAD, false) },
          undefined,
          h.env({ DB: gatedMail(gate) }),
        ),
      );
      expect(res).toEqual({ status: 200, body: { ok: true, dataset_id: PROD_DATASET } });
      expect(state(reviewId)).toMatchObject({ state: "reported", verdict: "pass", nonce: null });
      expect(h.deferred).toHaveLength(1);
      expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(0);

      release();
      await Promise.allSettled(h.deferred ?? []);
      expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(1);
    });
  });

  test("a refused claim answers while the mail is still being sent, and the mail follows", async () => {
    seedAdmin();
    const { requestId, reviewId } = dispatched({ mailed: false });
    h.db.run(
      "UPDATE publication_requests SET identifier_screen_report = json_set(identifier_screen_report, '$.head', ?) WHERE id = ?",
      [OTHER_HEAD, requestId],
    );
    const { gate, release } = gateOf();
    h.deferred = [];
    await withFakeResend(async (calls) => {
      const res = await answersWithin(h.claim(reviewId, undefined, h.env({ DB: gatedMail(gate) })));
      expect(res).toEqual({
        status: 409,
        body: { ok: false, claimed: false, reason: "stale_head" },
      });
      expect(state(reviewId)).toMatchObject({ state: "errored", detail: "stale_head" });
      expect(h.deferred).toHaveLength(1);
      expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(0);

      release();
      await Promise.allSettled(h.deferred ?? []);
      expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(1);
    });
  });

  test("without an execution context the mail is awaited, so a harness sees it done", async () => {
    seedAdmin();
    const { reviewId } = dispatched({ claimed: true, mailed: false });
    await withFakeResend(async (calls) => {
      await h.result(reviewId, { outcome: "reported", report: reportFor(SCREENED_HEAD, false) });
      expect(sendsTo(calls, ADMIN_EMAIL)).toHaveLength(1);
    });
  });

  test("a mail that fails does not fail a stored result, deferred or not", async () => {
    seedAdmin();
    for (const [i, deferred] of [true, false].entries()) {
      const dataset = ds(3000 + i);
      const { reviewId } = dispatched({ dataset, claimed: true, mailed: false });
      h.deferred = deferred ? [] : null;
      await withFakeResend(
        async () => {
          const res = await h.result(
            reviewId,
            { outcome: "reported", report: reportFor(SCREENED_HEAD, false) },
            undefined,
            undefined,
            dataset,
          );
          await Promise.allSettled(h.deferred ?? []);
          expect(res.status).toBe(200);
          expect(state(reviewId)).toMatchObject({ state: "reported" });
        },
        { status: 500 },
      );
    }
  });
});

describe("an administrator's start", () => {
  const admin = { adminUserId: 1 };

  function startable(
    state: "declined" | "errored" | "unreported" | "dispatched" | "reported",
    detail?: string,
    minutesAgo = 0,
    dataset = PROD_DATASET,
    claimed = false,
  ) {
    const { requestId } = seedScreenedRequest(h.db, { datasetId: dataset });
    const reviewId = seedPublicationReview(h.db, {
      requestId,
      datasetId: dataset,
      state,
      detail,
      createdMinutesAgo: minutesAgo,
      claimed,
    });
    return { requestId, reviewId, datasetId: dataset };
  }

  test("restarts a declined row: a new nonce, a new dispatch, no new call spent", async () => {
    const { requestId, reviewId } = startable("declined", "depositor_limit");
    const out = await startPublicationReview(h.env(), {
      requestId,
      datasetId: PROD_DATASET,
      ...admin,
    });
    expect(out).toEqual({ started: true, reason: "redispatched", reviewId });
    expect(state(reviewId)).toMatchObject({
      state: "dispatched",
      detail: null,
      attempts: 1,
      started_by: 1,
      claimed_at: null,
      decided_at: null,
    });
    expect(h.nonceOf(reviewId)).not.toBeNull();
    expect(h.dispatches()).toHaveLength(1);
  });

  test("restarts an errored row that reached a model: it costs a second call", async () => {
    const { requestId, reviewId } = startable(
      "errored",
      "model_unavailable",
      0,
      PROD_DATASET,
      true,
    );
    const out = await startPublicationReview(h.env(), {
      requestId,
      datasetId: PROD_DATASET,
      ...admin,
    });
    expect(out.reason).toBe("redispatched");
    expect(state(reviewId)).toMatchObject({ state: "dispatched", attempts: 2 });
  });

  test("restarts an unreported row, and the older run can no longer answer", async () => {
    // The older run took its claim, so it may be mid-call: that call is spent and the restart is a second.
    const { requestId, reviewId } = startable("unreported", undefined, 0, PROD_DATASET, true);
    const oldToken = await h.tokenFor(reviewId);
    const out = await startPublicationReview(h.env(), {
      requestId,
      datasetId: PROD_DATASET,
      ...admin,
    });
    expect(out.reason).toBe("redispatched");
    expect(state(reviewId).attempts).toBe(2);
    // The late report of the abandoned run is refused: its nonce was replaced.
    expect((await h.claim(reviewId, oldToken)).status).toBe(401);
    expect((await h.claim(reviewId)).status).toBe(200);
  });

  test("restarts a dispatched row only once it is past its deadline", async () => {
    const fresh = startable("dispatched", undefined, 5);
    const nonceBefore = h.nonceOf(fresh.reviewId);
    expect(
      await startPublicationReview(h.env(), {
        requestId: fresh.requestId,
        datasetId: PROD_DATASET,
        ...admin,
      }),
    ).toEqual({ started: false, reason: "running", reviewId: fresh.reviewId });
    expect(h.nonceOf(fresh.reviewId)).toBe(nonceBefore);
    expect(h.dispatches()).toHaveLength(0);

    const overdue = startable("dispatched", undefined, 45, "nm000481", true);
    const out = await startPublicationReview(h.env(), {
      requestId: overdue.requestId,
      datasetId: "nm000481",
      ...admin,
    });
    expect(out).toEqual({ started: true, reason: "redispatched", reviewId: overdue.reviewId });
    expect(state(overdue.reviewId)).toMatchObject({ state: "dispatched", attempts: 2 });
    expect(h.nonceOf(overdue.reviewId)).not.toBe(null);
  });

  test("a row nobody ever claimed is restarted for free: no model was reached", async () => {
    // The workflow was undeployed, or Actions was down. Nothing was spent, so a restart costs the
    // one call it will make and does not stack a second on an attempt that made none.
    const dead = startable("unreported", undefined, 120);
    const out = await startPublicationReview(h.env(), {
      requestId: dead.requestId,
      datasetId: PROD_DATASET,
      ...admin,
    });
    expect(out.reason).toBe("redispatched");
    expect(state(dead.reviewId)).toMatchObject({ state: "dispatched", attempts: 1 });

    const silent = startable("dispatched", undefined, 45, "nm000481");
    await startPublicationReview(h.env(), {
      requestId: silent.requestId,
      datasetId: "nm000481",
      ...admin,
    });
    expect(state(silent.reviewId)).toMatchObject({ state: "dispatched", attempts: 1 });
  });

  test("never restarts a row that has a result", async () => {
    const { requestId, reviewId } = startable("reported");
    const before = JSON.stringify(state(reviewId));
    expect(
      await startPublicationReview(h.env(), { requestId, datasetId: PROD_DATASET, ...admin }),
    ).toEqual({ started: false, reason: "has_result", reviewId });
    expect(JSON.stringify(state(reviewId))).toBe(before);
    expect(h.dispatches()).toHaveLength(0);
  });

  test("is held by the platform's cap only: the depositor's cap does not stop it", async () => {
    // Five model calls by one depositor in a day is the depositor's whole allowance.
    const { requestId } = seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
    const depositor = h.requestRow(requestId).requested_by as number;
    for (let i = 0; i < 5; i++) {
      const dataset = ds(400 + i);
      const r = seedScreenedRequest(h.db, { datasetId: dataset, requestedBy: depositor });
      seedPublicationReview(h.db, {
        requestId: r.requestId,
        datasetId: dataset,
        state: "reported",
        claimed: true,
      });
    }
    const target = seedPublicationReview(h.db, {
      requestId,
      datasetId: PROD_DATASET,
      state: "errored",
      detail: "model_unavailable",
      claimed: true,
    });
    const out = await startPublicationReview(h.env(), {
      requestId,
      datasetId: PROD_DATASET,
      ...admin,
    });
    expect(out).toEqual({ started: true, reason: "redispatched", reviewId: target });
  });

  /** `n` calls by other depositors in the last day, each a review that reported. */
  function fillPlatform(n: number) {
    for (let i = 0; i < n; i++) {
      const dataset = ds(500 + i);
      const r = seedScreenedRequest(h.db, { datasetId: dataset });
      seedPublicationReview(h.db, {
        requestId: r.requestId,
        datasetId: dataset,
        state: "reported",
        claimed: true,
      });
    }
  }

  /** The model calls the platform's allowance counts now: what a new start would be ranked against. */
  const counted = () =>
    (h.db.query(PLATFORM_RANK_SQL).get(Number.MAX_SAFE_INTEGER) as { n: number }).n;

  test("a restart of an attempt that reached a model is a second call: it fits at fifty", async () => {
    // 48 other calls and this row's own earlier call are 49; the restart is the 50th.
    fillPlatform(48);
    const target = startable("errored", "model_unavailable", 0, PROD_DATASET, true);
    const out = await startPublicationReview(h.env(), {
      requestId: target.requestId,
      datasetId: PROD_DATASET,
      ...admin,
    });
    expect(out.reason).toBe("redispatched");
    expect(state(target.reviewId)).toMatchObject({ state: "dispatched", attempts: 2 });
  });

  test("and it is declined at fifty-one, where counting it once would have let it through", async () => {
    // 49 other calls and this row's own earlier call are 50. Counted once the restart would
    // read 50 and pass; it is a second call, so it is the 51st, and the platform's cap holds.
    fillPlatform(49);
    const target = startable("errored", "model_unavailable", 0, PROD_DATASET, true);
    expect(counted()).toBe(50);
    const out = await startPublicationReview(h.env(), {
      requestId: target.requestId,
      datasetId: PROD_DATASET,
      ...admin,
    });
    expect(out).toEqual({ started: false, reason: "platform_limit", reviewId: target.reviewId });
    expect(state(target.reviewId)).toMatchObject({
      state: "declined",
      detail: "platform_limit",
      nonce: null,
    });
    expect(h.dispatches()).toHaveLength(0);
  });

  test("a restart the platform declines does not erase the call the row already spent", async () => {
    // The row's earlier call was real. Declining the restart must leave it counted: written off,
    // the tally dropped by one, the next start was admitted, and fifty-one calls were made in a day.
    fillPlatform(49);
    const target = startable("unreported", undefined, 120, PROD_DATASET, true);
    expect(counted()).toBe(50);
    const out = await startPublicationReview(h.env(), {
      requestId: target.requestId,
      datasetId: PROD_DATASET,
      ...admin,
    });
    expect(out.reason).toBe("platform_limit");
    expect(counted()).toBe(50);

    // So the next start, of another request, is still the fifty-first and is declined.
    const other = seedScreenedRequest(h.db, { datasetId: "nm000481" });
    const next = await startPublicationReview(h.env(), {
      requestId: other.requestId,
      datasetId: "nm000481",
    });
    expect(next.reason).toBe("platform_limit");
    expect(h.dispatches()).toHaveLength(0);
  });

  test("a restart whose dispatch fails does not erase the call the row already spent", async () => {
    fillPlatform(48);
    const target = startable("errored", "model_unavailable", 0, PROD_DATASET, true);
    expect(counted()).toBe(49);
    h.dispatchStatus = 500;
    const out = await startPublicationReview(h.env(), {
      requestId: target.requestId,
      datasetId: PROD_DATASET,
      ...admin,
    });
    expect(out.reason).toBe("dispatch_failed");
    expect(state(target.reviewId)).toMatchObject({
      state: "errored",
      detail: "dispatch_failed",
      nonce: null,
    });
    // The failed attempt is free, the call before it is not.
    expect(counted()).toBe(49);

    // One more start fits (the fiftieth); the one after it does not.
    h.dispatchStatus = 204;
    const a = seedScreenedRequest(h.db, { datasetId: "nm000481" });
    const b = seedScreenedRequest(h.db, { datasetId: "nm000482" });
    expect(
      (await startPublicationReview(h.env(), { requestId: a.requestId, datasetId: "nm000481" }))
        .reason,
    ).toBe("dispatched");
    expect(
      (await startPublicationReview(h.env(), { requestId: b.requestId, datasetId: "nm000482" }))
        .reason,
    ).toBe("platform_limit");
  });

  // The invariant under the tests above: within a window a restart, a decline or a failed
  // dispatch never lowers the calls counted. Checked for each way a spent row can be restarted.
  const spentRows: [string, string | undefined][] = [
    ["unreported", undefined],
    ["errored", "model_unavailable"],
    ["errored", "workflow_failed"],
  ];
  for (const [rowState, detail] of spentRows) {
    for (const outcome of ["declined", "dispatch_failed", "started"] as const) {
      test(`restarting a spent ${rowState}${detail ? ` (${detail})` : ""} row that ${outcome === "started" ? "goes ahead" : `ends ${outcome}`} never lowers what is counted`, async () => {
        const target = startable(rowState as never, detail, 120, PROD_DATASET, true);
        if (outcome === "declined") fillPlatform(49);
        const before = counted();
        h.dispatchStatus = outcome === "dispatch_failed" ? 500 : 204;
        await startPublicationReview(h.env(), {
          requestId: target.requestId,
          datasetId: PROD_DATASET,
          ...admin,
        });
        expect(counted()).toBeGreaterThanOrEqual(before);
        // A restart that goes ahead is one call more, never fewer.
        if (outcome === "started") expect(counted()).toBe(before + 1);
      });
    }
  }

  test("a declined row costs one call, not two, when it is restarted", async () => {
    fillPlatform(49);
    const target = startable("declined", "depositor_limit");
    const out = await startPublicationReview(h.env(), {
      requestId: target.requestId,
      datasetId: PROD_DATASET,
      ...admin,
    });
    expect(out.reason).toBe("redispatched");
    expect(state(target.reviewId).attempts).toBe(1);
    // One more other call and the same restart is the 51st.
  });

  test("a declined row, the one kind that never reached a model, is not counted when it is declined again", async () => {
    // Fifty other calls: the platform is full, and the declined row holds nothing of it.
    fillPlatform(50);
    const target = startable("declined", "depositor_limit");
    expect(counted()).toBe(50);
    const out = await startPublicationReview(h.env(), {
      requestId: target.requestId,
      datasetId: PROD_DATASET,
      ...admin,
    });
    expect(out.reason).toBe("platform_limit");
    expect(counted()).toBe(50);
  });

  test("without the callback secret or a GitHub credential nothing is sent, and the row says why", async () => {
    const { requestId } = seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
    const go = (env: Bindings) =>
      startPublicationReview(env, { requestId, datasetId: PROD_DATASET, ...admin });

    const noSecret = await go(h.env({ PRESCREEN_CALLBACK_SECRET: undefined }));
    expect(noSecret).toMatchObject({ started: false, reason: "dispatch_unconfigured" });
    const id = noSecret.reviewId as number;
    expect(state(id)).toMatchObject({
      state: "errored",
      detail: "dispatch_unconfigured",
      nonce: null,
      attempts: 1,
      started_by: 1,
    });
    expect(h.dispatches()).toHaveLength(0);

    // Once it is fixed, a start takes the same row up again, and it cost no call.
    expect(await go(h.env())).toEqual({ started: true, reason: "redispatched", reviewId: id });
    expect(state(id)).toMatchObject({ state: "dispatched", attempts: 1 });

    // A credential missing is the same word, whatever the row held before.
    h.db.run(
      "UPDATE publication_reviews SET state = 'errored', detail = 'model_unavailable', nonce = NULL, decided_at = datetime('now') WHERE id = ?",
      [id],
    );
    expect(await go(h.env({ GITHUB_ADMIN_PAT: undefined }))).toMatchObject({
      started: false,
      reason: "dispatch_unconfigured",
    });
    expect(state(id)).toMatchObject({
      state: "errored",
      detail: "dispatch_unconfigured",
      attempts: 1,
    });
    expect(h.dispatches()).toHaveLength(1);
  });

  test("the log says which of the two is missing, and the credential's error by its words", async () => {
    // One word for the row (`dispatch_unconfigured`) is not enough for the person who has to fix
    // the Worker: the secret and the credential are set in different places.
    const cases: Array<[Partial<Bindings>, string[], string[]]> = [
      [
        { PRESCREEN_CALLBACK_SECRET: undefined },
        ["dispatch_unconfigured (callback_secret unset)"],
        ["github_credential"],
      ],
      [
        { GITHUB_ADMIN_PAT: undefined },
        ["dispatch_unconfigured (github_credential unusable: Error, other)"],
        ["callback_secret", "No GitHub auth configured"],
      ],
      [
        { PRESCREEN_CALLBACK_SECRET: undefined, GITHUB_ADMIN_PAT: undefined },
        ["dispatch_unconfigured (callback_secret unset, github_credential unusable: Error, other)"],
        ["No GitHub auth configured"],
      ],
    ];
    for (const [i, [missing, expected, absent]] of cases.entries()) {
      const dataset = ds(3000 + i);
      const { requestId } = seedScreenedRequest(h.db, { datasetId: dataset });
      const lines = await logged(async () => {
        const out = await startPublicationReview(h.env(missing), {
          requestId,
          datasetId: dataset,
          ...admin,
        });
        expect(out).toMatchObject({ started: false, reason: "dispatch_unconfigured" });
      });
      const log = lines.join("\n");
      for (const words of expected) expect(log, words).toContain(words);
      for (const words of absent) expect(log, words).not.toContain(words);
      expect(log).toContain(`${dataset} request ${requestId}`);
      expect(log).not.toContain(CALLBACK_SECRET);
      expect(log).not.toContain(GITHUB_PAT);
    }
  });

  const unconfigured: [string, Partial<Bindings>][] = [
    ["the callback secret", { PRESCREEN_CALLBACK_SECRET: undefined }],
    ["the GitHub credential", { GITHUB_ADMIN_PAT: undefined }],
  ];

  for (const [what, missing] of unconfigured) {
    for (const claimed of [false, true]) {
      test(`without ${what}, a start does not close a ${claimed ? "claimed" : "fresh"} review that is running`, async () => {
        // The restart rule is one rule: a `dispatched` row is restarted once it is past its
        // deadline, whether or not the review can be handed over. Closed early, the running job's
        // result got 401 and, `dispatch_unconfigured` being free, a later screen result started
        // a second review while the first was still mid-call.
        const target = startable("dispatched", undefined, 1, PROD_DATASET, claimed);
        const before = JSON.stringify(state(target.reviewId));
        const nonce = h.nonceOf(target.reviewId);
        const out = await startPublicationReview(h.env(missing), {
          requestId: target.requestId,
          datasetId: PROD_DATASET,
          ...admin,
        });
        expect(out).toEqual({ started: false, reason: "running", reviewId: target.reviewId });
        expect(JSON.stringify(state(target.reviewId))).toBe(before);
        expect(h.nonceOf(target.reviewId)).toBe(nonce);
        if (claimed) {
          const stored = await h.result(target.reviewId, {
            outcome: "reported",
            report: reportFor(SCREENED_HEAD, false),
          });
          expect(stored.status).toBe(200);
          expect(state(target.reviewId)).toMatchObject({ state: "reported" });
        }
      });
    }
  }

  test("without the callback secret, an overdue review is closed, and its call stays counted", async () => {
    // Overdue and claimed: a job may have made its call before it went quiet.
    const spent = startable("dispatched", undefined, 45, PROD_DATASET, true);
    const gone = startable("dispatched", undefined, 45, "nm000481", false);
    const before = counted();
    expect(before).toBe(2);
    for (const target of [spent, gone]) {
      const out = await startPublicationReview(h.env({ PRESCREEN_CALLBACK_SECRET: undefined }), {
        requestId: target.requestId,
        datasetId: target.datasetId,
        ...admin,
      });
      expect(out).toEqual({
        started: false,
        reason: "dispatch_unconfigured",
        reviewId: target.reviewId,
      });
      expect(state(target.reviewId)).toMatchObject({
        state: "errored",
        detail: "dispatch_unconfigured",
        nonce: null,
      });
    }
    // The claimed one spent a call and the other, which nobody ever claimed, did not.
    expect(state(spent.reviewId).attempts).toBe(2);
    expect(state(gone.reviewId).attempts).toBe(1);
    expect(counted()).toBe(1);
  });

  test("a GitHub failure is dispatch_failed, and a start can try again", async () => {
    const { requestId } = seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
    h.dispatchStatus = 500;
    const failed = await startPublicationReview(h.env(), {
      requestId,
      datasetId: PROD_DATASET,
      ...admin,
    });
    expect(failed).toMatchObject({ started: false, reason: "dispatch_failed" });
    const id = failed.reviewId as number;
    expect(state(id)).toMatchObject({ state: "errored", detail: "dispatch_failed", nonce: null });

    h.dispatchStatus = 204;
    expect(
      await startPublicationReview(h.env(), { requestId, datasetId: PROD_DATASET, ...admin }),
    ).toEqual({ started: true, reason: "redispatched", reviewId: id });
  });

  test("names the reason it cannot start: off, not ours, not applicable, not waiting, not screened", async () => {
    const { requestId } = seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
    const go = (env = h.env(), id = requestId, dataset = PROD_DATASET) =>
      startPublicationReview(env, { requestId: id, datasetId: dataset, ...admin });
    expect((await go(h.env({ PUBLICATION_REVIEW_ENABLED: undefined }))).reason).toBe(
      "review_disabled",
    );
    expect((await go(h.env({ ENVIRONMENT: "development" }))).reason).toBe("not_owned_here");
    expect((await go(h.env(), requestId + 100)).reason).toBe("request_not_requested");
    h.db.run("UPDATE publication_requests SET status = 'blocked' WHERE id = ?", [requestId]);
    expect((await go()).reason).toBe("request_not_requested");
    h.db.run(
      "UPDATE publication_requests SET status = 'requested', identifier_screen_status = 'pending' WHERE id = ?",
      [requestId],
    );
    expect((await go()).reason).toBe("screen_not_ready");
    h.db.run(
      "UPDATE publication_requests SET identifier_screen_status = 'unreported' WHERE id = ?",
      [requestId],
    );
    expect((await go()).reason).toBe("screen_not_ready");
    // A screen whose gate blocks is not reviewable even when it names a commit: the gate decides,
    // not the presence of a head.
    h.db.run(
      "UPDATE publication_requests SET identifier_screen_status = 'direct-identifiers' WHERE id = ?",
      [requestId],
    );
    expect((await go()).reason).toBe("screen_not_ready");
    const mirror = seedScreenedRequest(h.db, { datasetId: "nm000483", source: "openneuro" });
    expect((await go(h.env(), mirror.requestId, "nm000483")).reason).toBe("not_applicable");
    expect(h.reviews()).toHaveLength(0);
    expect(h.dispatches()).toHaveLength(0);
  });
});

describe("no secret reaches the Worker's logs", () => {
  // Everything `fn` logged, as one text: the shared capture sees console.log, warn and error.
  async function captured(fn: () => Promise<unknown>): Promise<string> {
    const lines = await logged(async () => {
      await fn();
    });
    return lines.join("\n");
  }

  test("a wrong token, a claim, a refused report and a result print no token, nonce or secret", async () => {
    const { reviewId } = dispatched({ claimed: true });
    const good = await h.tokenFor(reviewId);
    const nonce = h.nonceOf(reviewId) as string;
    const bad = `${good.slice(0, -4)}0000`;
    const note = "SMITH-SECRET-NAME wrote this";
    const out = await captured(async () => {
      await h.result(
        reviewId,
        { outcome: "reported", report: reportFor(SCREENED_HEAD, false) },
        bad,
      );
      await h.claim(reviewId, bad);
      await h.claim(reviewId, good);
      // A refused report, with text in it that must not be echoed.
      await h.result(
        reviewId,
        {
          outcome: "reported",
          report: { ...reportFor(SCREENED_HEAD, false), summary: note, extra: note },
        },
        good,
      );
    });
    expect(out.length).toBeGreaterThan(0);
    for (const secret of [
      good,
      bad,
      nonce,
      "ghp_publication_review_test",
      CALLBACK_SECRET,
      "SMITH-SECRET",
    ]) {
      expect(out).not.toContain(secret);
    }
  });

  test("a failed store and a report nobody claimed print ids and fixed words, nothing else", async () => {
    const claimed = dispatched({ claimed: true });
    const unclaimed = dispatched({ dataset: "nm000481", claimed: false });
    const tokenA = await h.tokenFor(claimed.reviewId);
    const tokenB = await h.tokenFor(unclaimed.reviewId, "nm000481");
    const nonces = [h.nonceOf(claimed.reviewId), h.nonceOf(unclaimed.reviewId)];
    const faulty = hookedD1(realD1(h.db), {
      statement: (sql) => {
        if (sql.includes(STORE_RESULT_SQL_MARKER)) {
          throw new Error("D1_ERROR: SECRET-DRIVER-MESSAGE with HOSTILE-SUMMARY-TEXT");
        }
      },
    });
    const out = await captured(async () => {
      await h.result(
        claimed.reviewId,
        {
          outcome: "reported",
          report: reportFor(SCREENED_HEAD, false, { summary: "HOSTILE-SUMMARY-TEXT" }),
        },
        tokenA,
        h.env({ DB: faulty }),
      );
      await h.result(
        unclaimed.reviewId,
        { outcome: "reported", report: reportFor(SCREENED_HEAD, false) },
        tokenB,
        undefined,
        "nm000481",
      );
    });
    expect(out).toContain("store failed");
    expect(out).toContain("not_claimed");
    for (const secret of [
      tokenA,
      tokenB,
      ...nonces,
      "SECRET-DRIVER-MESSAGE",
      "HOSTILE-SUMMARY-TEXT",
      CALLBACK_SECRET,
    ]) {
      expect(out).not.toContain(secret as string);
    }
  });

  describe("a database fault in the door", () => {
    // The route answers a fixed sentence and logs the error's words, never the error: left
    // alone, the global handler prints the whole error object, whose text can carry SQL.
    const FAULT = "D1_ERROR: SECRET-DRIVER-MESSAGE near publication_reviews";
    const touchesReviews = (sql: string) => /publication_reviews/.test(sql);

    test("the nonce read: a fixed 500 on the claim and on the result, and nothing printed but words", async () => {
      const { reviewId } = dispatched({ claimed: false });
      const token = await h.tokenFor(reviewId);
      const nonce = h.nonceOf(reviewId) as string;
      const faulty = h.env({
        DB: hookedD1(realD1(h.db), {
          statement: (sql) => {
            if (touchesReviews(sql)) throw new Error(FAULT);
          },
        }),
      });
      const seen: Array<{ status: number; body: Record<string, unknown> }> = [];
      const out = await captured(async () => {
        seen.push(await h.claim(reviewId, token, faulty));
        seen.push(
          await h.result(
            reviewId,
            { outcome: "reported", report: reportFor(SCREENED_HEAD, false) },
            token,
            faulty,
          ),
        );
      });
      for (const res of seen) {
        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toContain("SECRET");
      }
      expect(seen[0].body).toEqual({ error: "The callback could not be checked; try again" });
      expect(seen[1].body).toEqual(seen[0].body);
      expect(out).toContain(`review ${reviewId} (${PROD_DATASET})`);
      expect(out).toContain("Error, other");
      for (const secret of [FAULT, "SECRET-DRIVER-MESSAGE", token, nonce, CALLBACK_SECRET]) {
        expect(out).not.toContain(secret);
      }
      // Nothing was written, and the token is still good once the database is.
      expect(state(reviewId)).toMatchObject({ state: "dispatched", claimed_at: null });
      expect((await h.claim(reviewId, token)).status).toBe(200);
    });

    test("the claim: a fixed 500 and a log of words, and the job's retry still takes it", async () => {
      const { reviewId } = dispatched({ claimed: false });
      const token = await h.tokenFor(reviewId);
      const nonce = h.nonceOf(reviewId) as string;
      // The first statement on the table is the door's nonce read; the claim's own come after.
      let reads = 0;
      const faulty = h.env({
        DB: hookedD1(realD1(h.db), {
          statement: (sql) => {
            if (touchesReviews(sql) && ++reads > 1) throw new Error(FAULT);
          },
        }),
      });
      let res: { status: number; body: Record<string, unknown> } | undefined;
      const out = await captured(async () => {
        res = await h.claim(reviewId, token, faulty);
      });
      expect(reads).toBeGreaterThan(1);
      expect(res?.status).toBe(500);
      expect(res?.body).toEqual({ error: "The claim could not be taken; try again" });
      expect(out).toContain(`review ${reviewId} (${PROD_DATASET}): claim failed (Error, other)`);
      for (const secret of [FAULT, "SECRET-DRIVER-MESSAGE", token, nonce, CALLBACK_SECRET]) {
        expect(out).not.toContain(secret);
      }
      expect(state(reviewId).claimed_at).toBeNull();
      expect((await h.claim(reviewId, token)).status).toBe(200);
    });
  });

  test("a hostile report's text is not logged when it is stored either", async () => {
    const { reviewId } = dispatched({ claimed: true });
    const out = await captured(async () => {
      await h.result(reviewId, {
        outcome: "reported",
        report: reportFor(SCREENED_HEAD, false, { summary: "HOSTILE-SUMMARY-TEXT" }),
      });
    });
    expect(out).not.toContain("HOSTILE-SUMMARY-TEXT");
  });
});

describe("what the caps count", () => {
  const costOf = (id: number) =>
    (
      h.db.query(`SELECT ${CAP_CALLS_SQL} AS n FROM publication_reviews WHERE id = ?`).get(id) as {
        n: number;
      }
    ).n;

  test("an attempt no model saw costs nothing, claimed or not; any other word costs a call only if claimed", () => {
    // The widening direction matters: a word dropped from NEVER_REACHED_MODEL would make a free
    // attempt cost a call, and a word added would let a costly one through for nothing.
    for (const [i, word] of PUBLICATION_RUN_ERRORS.entries()) {
      for (const claimed of [false, true]) {
        const dataset = ds(2000 + i * 2 + (claimed ? 1 : 0));
        const { requestId } = seedScreenedRequest(h.db, { datasetId: dataset });
        const id = seedPublicationReview(h.db, {
          requestId,
          datasetId: dataset,
          state: "errored",
          detail: word,
          claimed,
        });
        const never = (NEVER_REACHED_MODEL as readonly string[]).includes(word);
        expect(costOf(id), `${word} claimed=${claimed}`).toBe(never || !claimed ? 0 : 1);
      }
    }
  });

  test("a restarted attempt that did not reach a model gives back only its own slot", () => {
    // attempts 2: one call that was made, and the slot of the attempt that was not.
    for (const [i, row] of [
      { state: "declined", detail: "platform_limit" },
      { state: "errored", detail: "dispatch_failed" },
      { state: "unreported", detail: undefined },
    ].entries()) {
      const dataset = ds(2100 + i);
      const { requestId } = seedScreenedRequest(h.db, { datasetId: dataset });
      const id = seedPublicationReview(h.db, {
        requestId,
        datasetId: dataset,
        state: row.state as never,
        detail: row.detail,
        attempts: 2,
      });
      expect(costOf(id), row.state).toBe(1);
    }
  });
});
