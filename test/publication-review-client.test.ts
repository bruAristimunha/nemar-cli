/**
 * The CLI's API client for the publication review (ADR 0102, Phase 2): `getPublicationReview`,
 * `startPublicationReview`, `commentOnPublication`, the override argument of `approvePublication`,
 * and how the client reads the two error conventions the backend uses.
 *
 * The NEMAR API is the REAL admin router over bun:sqlite with every migration applied (the
 * review's own harness), served on a local port and reached through the client's URL override.
 * GitHub is the harness's `Bun.serve()` stand-in. The wrapper in front of the router only records
 * what the client sent; it answers nothing itself, except where a test needs the transport to fail
 * or to answer with a shape the router would not make (the approval gate's refusal bodies, a
 * review the CLI cannot classify, a 404 with no review word): those tests script the answer.
 *
 * CI TIER: integration, like the other suites that point the client at a local server.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interceptingD1, realD1 } from "../backend/test/helpers/d1";
import {
  failingReport,
  seedPublicationReview,
  seedScreenedRequest,
  seedUser,
  textOf,
} from "../backend/test/helpers/publication-review";
import { PROD_DATASET, createHarness } from "../backend/test/helpers/publication-review-harness";
import { asSend, withFakeResend } from "../backend/test/helpers/resend";
import {
  APPROVAL_CLOSED_DURING_RUN_MESSAGE,
  APPROVAL_IN_FLIGHT_MESSAGE,
  APPROVAL_REFUSAL_ERROR_CODES,
  DECISION_WITH_DISPATCH_TOKEN_MESSAGE,
  DENY_AFTER_PUBLISHING_MESSAGE,
  DISPATCH_EXPIRED_MESSAGE,
  DISPATCH_SUPERSEDED_MESSAGE,
  IDENTIFIER_SCREEN_ERROR_CODES,
  INVALID_DATASET_ID_MESSAGE,
  REQUEST_CHANGED_MESSAGE,
  REQUEST_MISMATCH_MESSAGE,
} from "../shared/contract/publication";
import {
  OVERRIDE_FIELD,
  PUBLICATION_REVIEW_NOT_CLEAR_CODE,
  type PublicationReviewGateRefusalBody,
  type PublicationReviewOverride,
  REQUEST_BLOCKED_CODE,
  type RequestBlockedRefusalBody,
} from "../shared/contract/publication-review-admin";
import { APPROVE_RETRY_DELAY_MS } from "../shared/publication-retry";
import {
  REASONS,
  REVIEW_GATE_REFUSALS,
  REVIEW_UNREADABLE_HEADLINE,
  reviewGateRefusalText,
} from "../shared/publication-review";
import { request } from "../src/lib/api/client";
import { ApiError } from "../src/lib/api/errors";
import {
  approvePublication,
  commentOnPublication,
  getPublicationReview,
  reviewErrorCode,
  startPublicationReview,
} from "../src/lib/api/publish";
import { decideApproval, readReview } from "../src/lib/publication-review-approve";

const ADMIN_KEY = "client-admin-key-0123456789abcdef0123456789abcdef";
const MEMBER_KEY = "client-member-key-0123456789abcdef0123456789abcd";

const h = createHarness();

interface Seen {
  method: string;
  path: string;
  contentType: string | null;
  body: string;
  /** The value of the `X-Approval-Dispatch-Token` header, or null when the call carried none. */
  dispatchToken: string | null;
}

let server: ReturnType<typeof Bun.serve>;
let configDir: string;
let previousConfigDir: string | undefined;
let previousApiUrl: string | undefined;
let seen: Seen[] = [];
/** Answers the wrapper gives instead of the router's, in order: the one place the transport is made to answer. */
let scripted: Array<{ status: number; body: unknown }> = [];

function useKey(key: string) {
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ activeAccount: "client", accounts: { client: { apiKey: key } } }),
  );
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({
        method: req.method,
        path: url.pathname,
        contentType: req.headers.get("content-type"),
        body: req.method === "GET" ? "" : await req.clone().text(),
        dispatchToken: req.headers.get("x-approval-dispatch-token"),
      });
      const next = scripted.shift();
      if (next) return Response.json(next.body, { status: next.status });
      return h.app.fetch(req, h.env());
    },
  });
  configDir = mkdtempSync(join(tmpdir(), "nemar-review-client-"));
  previousConfigDir = process.env.NEMAR_CONFIG_DIR;
  process.env.NEMAR_CONFIG_DIR = configDir;
  previousApiUrl = process.env.TEST_API_URL;
  process.env.TEST_API_URL = `http://localhost:${server.port}`;
});

afterAll(() => {
  // Guarded restore (#1175): assigning undefined stringifies to "undefined" and poisons the
  // variable for every later test in this shared process.
  if (previousConfigDir === undefined) Reflect.deleteProperty(process.env, "NEMAR_CONFIG_DIR");
  else process.env.NEMAR_CONFIG_DIR = previousConfigDir;
  if (previousApiUrl === undefined) Reflect.deleteProperty(process.env, "TEST_API_URL");
  else process.env.TEST_API_URL = previousApiUrl;
  rmSync(configDir, { recursive: true, force: true });
  server.stop(true);
});

beforeEach(async () => {
  seen = [];
  scripted = [];
  await seedUser(h.db, "clientadmin", "admin", ADMIN_KEY);
  await seedUser(h.db, "clientmember", "member", MEMBER_KEY);
  useKey(ADMIN_KEY);
});

afterEach(() => {
  seen = [];
  scripted = [];
});

async function thrown(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("expected the call to throw an ApiError");
}

describe("getPublicationReview, against the real router", () => {
  test("resolves the detail, with what approve and next show from the one read", async () => {
    const { requestId } = seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
    seedPublicationReview(h.db, {
      requestId,
      datasetId: PROD_DATASET,
      state: "reported",
      report: failingReport(),
    });
    h.db.run("UPDATE datasets SET total_files = 12400 WHERE dataset_id = ?", [PROD_DATASET]);

    const detail = await getPublicationReview(PROD_DATASET);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "GET", path: `/admin/publish/${PROD_DATASET}/review` });
    expect(detail).toMatchObject({
      dataset_id: PROD_DATASET,
      request_id: requestId,
      request_status: "requested",
      enabled: true,
      gate: "enforced",
      outcome: "fail",
      screen_acknowledgment: null,
      block_reason: null,
      started_publishing: false,
      total_files: 12400,
    });
    expect(detail.identifier_screen.state).toBe("clean");
    expect(detail.reasons.map((r) => r.code)).toEqual(["question_failed"]);
    expect(detail.reasons[0].cleared_by).toBe("override");
    expect(detail.description.next).toBe(`nemar admin publish approve ${PROD_DATASET} --force`);
    expect(detail.review?.id).not.toBeNull();
  });

  test("a request with no active request is a 404 whose word is in rawBody.code, and err.code is the sentence", async () => {
    const err = await thrown(() => getPublicationReview(PROD_DATASET));
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe(`${PROD_DATASET} has no active publication request.`);
    // The review routes answer `{ error: sentence, code: word }`, and `ApiError.code` is the body's
    // `error`: here the sentence. The closed word is `reviewErrorCode`'s.
    expect(err.code).toBe(err.message);
    expect(reviewErrorCode(err)).toBe("not_found");
    expect(err.rawBody).toEqual({ error: err.message, code: "not_found" });
  });

  test("a malformed dataset id is a 400 bad_dataset", async () => {
    const err = await thrown(() => getPublicationReview("not-a-dataset"));
    expect(err.statusCode).toBe(400);
    expect(reviewErrorCode(err)).toBe("bad_dataset");
  });

  test("a member's key is refused by the router before the route, and carries no review word", async () => {
    useKey(MEMBER_KEY);
    seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
    const err = await thrown(() => getPublicationReview(PROD_DATASET));
    expect(err.statusCode).toBe(403);
    expect(reviewErrorCode(err)).toBeUndefined();
  });

  test("a review that cannot be read is a 500 internal with a fixed sentence", async () => {
    seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
    h.envOverrides = {
      DB: interceptingD1(realD1(h.db), (sql) => {
        if (/FROM publication_requests pr/.test(sql)) throw new Error("D1_ERROR: simulated");
      }),
    };
    const err = await thrown(() => getPublicationReview(PROD_DATASET));
    expect(err.statusCode).toBe(500);
    expect(reviewErrorCode(err)).toBe("internal");
    expect(err.message).toBe("The publication review could not be read. Try again.");
    expect(REVIEW_UNREADABLE_HEADLINE).toContain("could not be read");
  });
});

describe("startPublicationReview, against the real router", () => {
  test("a 202 resolves with the run that is going, and the dispatch went to GitHub", async () => {
    const { requestId } = seedScreenedRequest(h.db, { datasetId: PROD_DATASET });

    const started = await startPublicationReview(PROD_DATASET);

    expect(seen[0]).toMatchObject({
      method: "POST",
      path: `/admin/publish/${PROD_DATASET}/review/start`,
    });
    expect(started).toEqual({
      environment: "production",
      started: true,
      reason: "dispatched",
      review_id: expect.any(Number),
    });
    expect(h.reviews()).toHaveLength(1);
    expect(h.reviews()[0]).toMatchObject({ id: started.review_id, request_id: requestId });
    expect(h.dispatches()).toHaveLength(1);
  });

  test("a 409 throws with the route's sentence and its word in rawBody.code", async () => {
    seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
    await startPublicationReview(PROD_DATASET);
    // The first start is running: the second is refused.
    const running = await thrown(() => startPublicationReview(PROD_DATASET));
    expect(running.statusCode).toBe(409);
    expect(reviewErrorCode(running)).toBe("running");
    expect(running.message).toBe(
      "A review of this commit is running. Wait for its report, or for its deadline.",
    );
    expect(running.code).toBe(running.message);

    seedScreenedRequest(h.db, {
      datasetId: "nm000481",
      requestStatus: "blocked",
      blockReason: "min_requirements_failed",
    });
    const blocked = await thrown(() => startPublicationReview("nm000481"));
    expect(blocked.statusCode).toBe(409);
    expect(reviewErrorCode(blocked)).toBe("request_not_requested");
  });

  test("a 502 throws with the recorded row's id: the review could not be handed over", async () => {
    seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
    h.envOverrides = { PRESCREEN_CALLBACK_SECRET: undefined };
    const err = await thrown(() => startPublicationReview(PROD_DATASET));
    expect(err.statusCode).toBe(502);
    expect(reviewErrorCode(err)).toBe("dispatch_unconfigured");
    expect(err.rawBody).toMatchObject({
      started: false,
      reason: "dispatch_unconfigured",
      code: "dispatch_unconfigured",
      review_id: expect.any(Number),
    });
    expect(h.dispatches()).toHaveLength(0);
  });

  test("no active request is a 404 not_found", async () => {
    const err = await thrown(() => startPublicationReview(PROD_DATASET));
    expect(err.statusCode).toBe(404);
    expect(reviewErrorCode(err)).toBe("not_found");
  });
});

describe("reviewErrorCode", () => {
  test("reads the closed word of a review route's body, and nothing else", () => {
    const withBody = (raw: unknown) => {
      const err = new ApiError(409, "a sentence");
      err.rawBody = raw;
      return err;
    };
    expect(reviewErrorCode(withBody({ error: "a sentence", code: "running" }))).toBe("running");
    expect(reviewErrorCode(withBody({ error: "a sentence" }))).toBeUndefined();
    expect(reviewErrorCode(withBody({ error: "x", code: 7 }))).toBeUndefined();
    expect(reviewErrorCode(withBody({ error: "x", code: null }))).toBeUndefined();
    expect(reviewErrorCode(withBody(null))).toBeUndefined();
    expect(reviewErrorCode(withBody("code"))).toBeUndefined();
    expect(reviewErrorCode(withBody([]))).toBeUndefined();
    expect(reviewErrorCode(new ApiError(500, "no body at all"))).toBeUndefined();
    for (const other of [new Error("x"), "running", undefined, null, 7, { code: "running" }]) {
      expect(reviewErrorCode(other)).toBeUndefined();
    }
  });
});

describe("commentOnPublication, against the real router", () => {
  test("posts the administrator's words as JSON to the comment route, and nothing else", async () => {
    // No request is open, so the route refuses; what is pinned here is what the client sent and
    // what it makes of the refusal, both read at the real router.
    const err = await thrown(() => commentOnPublication(PROD_DATASET, "Please add a license."));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(404);
    expect(reviewErrorCode(err)).toBe("not_found");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      method: "POST",
      path: `/admin/publish/${PROD_DATASET}/comment`,
      contentType: "application/json",
      body: JSON.stringify({ message: "Please add a license." }),
      // A comment is not an approval: no dispatch token rides on it.
      dispatchToken: null,
    });
  });

  test("resolves the route's 200 once the depositor was mailed the words, and the request stays open", async () => {
    const { requestId } = seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
    const { answer, calls } = await withFakeResend(async (sent) => ({
      answer: await commentOnPublication(PROD_DATASET, "Please add a license."),
      calls: sent,
    }));
    expect(answer).toEqual({ dataset_id: PROD_DATASET, request_id: requestId, mailed: true });
    expect(calls).toHaveLength(1);
    expect(asSend(calls[0]).to).toEqual([`depositor_${PROD_DATASET}@example.org`]);
    expect(textOf(asSend(calls[0]).html)).toContain("Please add a license.");
    expect(h.requestRow(requestId).status).toBe("requested");
  });

  test("a message that certainly was not mailed throws the route's 502 with its closed word and says nothing was sent", async () => {
    seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
    const err = await withFakeResend(
      () => thrown(() => commentOnPublication(PROD_DATASET, "Please add a license.")),
      { status: 422 },
    );
    expect(err.statusCode).toBe(502);
    expect(reviewErrorCode(err)).toBe("comment_not_sent");
    expect(err.message).toBe(
      "The message could not be mailed, so nothing was sent to the depositor.",
    );
  });

  test("a message that may have been mailed throws the route's 502 with its own closed word and the hedge", async () => {
    seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
    const err = await withFakeResend(
      () => thrown(() => commentOnPublication(PROD_DATASET, "Please add a license.")),
      { status: 503 },
    );
    expect(err.statusCode).toBe(502);
    expect(reviewErrorCode(err)).toBe("comment_not_confirmed");
    expect(err.message).toBe(
      "The mail may not have been sent, and it may also have arrived. Check with the depositor before sending it again.",
    );
  });

  test("a message the route refuses (blank) throws its 400 with its closed word", async () => {
    seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
    const err = await withFakeResend(() => thrown(() => commentOnPublication(PROD_DATASET, "   ")));
    expect(err.statusCode).toBe(400);
    expect(reviewErrorCode(err)).toBe("invalid_body");
  });
});

describe("approvePublication carries the override beside the acknowledgment", () => {
  const override: PublicationReviewOverride = {
    review_id: 41,
    reasons: ["question_failed", "text_withheld"],
  };

  test("sent as override_publication_review exactly as given, only when given", async () => {
    const run = (...args: Parameters<typeof approvePublication>) =>
      thrown(() => approvePublication(...args));
    // The real route refuses a dataset with no active request; the client's body is what is read.
    await run(PROD_DATASET, true, false, false, undefined, undefined, undefined, override);
    const sent = JSON.parse(seen[0].body) as Record<string, unknown>;
    expect(seen[0]).toMatchObject({
      method: "POST",
      path: `/admin/publish/${PROD_DATASET}/approve`,
    });
    expect(OVERRIDE_FIELD in sent).toBe(true);
    expect(sent[OVERRIDE_FIELD]).toEqual(override);
    expect(sent.resume).toBe(true);

    // A null review id is an override with no review to attach to (the terminal's, ADR 0102).
    await run(PROD_DATASET, true, false, false, undefined, undefined, undefined, {
      review_id: null,
      reasons: ["review_not_started"],
    });
    expect(JSON.parse(seen[1].body)[OVERRIDE_FIELD]).toEqual({
      review_id: null,
      reasons: ["review_not_started"],
    });

    // Both fields at once; neither displaces the other.
    await run(
      PROD_DATASET,
      false,
      false,
      false,
      undefined,
      undefined,
      "a recorded reason",
      override,
    );
    const both = JSON.parse(seen[2].body) as Record<string, unknown>;
    expect(both.acknowledge_identifier_screen).toBe("a recorded reason");
    expect(both[OVERRIDE_FIELD]).toEqual(override);

    // Not given: the key is not on the wire at all, so an older Worker sees the body it always did.
    await run(PROD_DATASET, true);
    expect(OVERRIDE_FIELD in JSON.parse(seen[3].body)).toBe(false);
    await run(PROD_DATASET, true, false, false, undefined, undefined, undefined, undefined);
    expect(OVERRIDE_FIELD in JSON.parse(seen[4].body)).toBe(false);
  });
});

describe("approvePublication presents the dispatch token of a run the web started (#1604)", () => {
  const TOKEN = `${"c0ffee".repeat(10)}abcd`;
  const IDENTITY = { requestId: 7, dispatchToken: TOKEN };
  const finished = { message: "done", hasMore: false };

  /** The wait between attempts, shortened to nothing (it can only shorten) for the length of `run`. */
  async function withNoRetryWait<T>(run: () => Promise<T>): Promise<T> {
    const previous = process.env.NEMAR_APPROVE_RETRY_DELAY_MS;
    process.env.NEMAR_APPROVE_RETRY_DELAY_MS = "0";
    try {
      return await run();
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(process.env, "NEMAR_APPROVE_RETRY_DELAY_MS");
      else process.env.NEMAR_APPROVE_RETRY_DELAY_MS = previous;
    }
  }

  test("the header is on every call of the run: the first, each lock batch and the retry after a server error", async () => {
    scripted = [
      { status: 200, body: { hasMore: true, s3_lock_continuation_token: "t1", step: "s3_lock" } },
      { status: 500, body: { error: "boom", message: "EZID 503" } },
      { status: 200, body: { hasMore: true, s3_lock_continuation_token: "t2", step: "s3_lock" } },
      { status: 200, body: finished },
    ];

    await withNoRetryWait(() =>
      approvePublication(
        PROD_DATASET,
        true,
        false,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        IDENTITY,
      ),
    );

    expect(seen).toHaveLength(4);
    for (const call of seen) {
      expect(call.path).toBe(`/admin/publish/${PROD_DATASET}/approve`);
      expect(call.dispatchToken).toBe(TOKEN);
      // The request it is for rides with it, on the same calls.
      expect(JSON.parse(call.body).request_id).toBe(7);
    }
  });

  test("the token is a header and only a header: it is never in the body", async () => {
    scripted = [{ status: 200, body: finished }];
    await approvePublication(
      PROD_DATASET,
      true,
      false,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      IDENTITY,
    );
    expect(seen[0].dispatchToken).toBe(TOKEN);
    expect(seen[0].body).not.toContain(TOKEN);
  });

  test("without one no header is sent, on any call of the run", async () => {
    scripted = [
      { status: 200, body: { hasMore: true, s3_lock_continuation_token: "t1", step: "s3_lock" } },
      { status: 200, body: finished },
    ];
    await approvePublication(
      PROD_DATASET,
      true,
      false,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        requestId: 7,
      },
    );
    expect(seen).toHaveLength(2);
    for (const call of seen) expect(call.dispatchToken).toBeNull();
    // And with no identity at all, as every existing caller calls it.
    seen = [];
    scripted = [{ status: 200, body: finished }];
    await approvePublication(PROD_DATASET, true);
    expect(seen[0].dispatchToken).toBeNull();
  });
});

describe("how the client reads an approval refusal (the gate's bodies, scripted)", () => {
  function gateBody(over: Partial<PublicationReviewGateRefusalBody> = {}) {
    const refusal = over.refusal ?? "needs_override";
    const body: PublicationReviewGateRefusalBody = {
      error: PUBLICATION_REVIEW_NOT_CLEAR_CODE,
      refusal,
      headline: "Publication review: FAIL",
      message: reviewGateRefusalText(refusal, PROD_DATASET),
      outcome: "fail",
      reasons: [
        {
          code: "question_failed",
          class: "fail",
          cleared_by: "override",
          detail: "complete_and_honest",
          sentence: REASONS.question_failed.sentence,
          cure: REASONS.question_failed.cure,
        },
      ],
      uncovered: ["question_failed"],
      review_id: 41,
      ...over,
    };
    return body;
  }

  test("a 409 publication_review_not_clear leads with the sentence, and the word and the whole body stay readable", async () => {
    for (const refusal of REVIEW_GATE_REFUSALS) {
      const body = gateBody({ refusal });
      scripted = [{ status: 409, body }];
      const err = await thrown(() =>
        request("/admin/publish/nm000480/approve", { method: "POST" }, true),
      );
      expect(err.statusCode).toBe(409);
      expect(err.message).toBe(reviewGateRefusalText(refusal, PROD_DATASET));
      expect(err.code).toBe("publication_review_not_clear");
      expect(err.rawBody).toEqual(body);
    }
  });

  test("a 409 request_blocked leads with the sentence, and the block reason reaches the hints that already read it", async () => {
    const body: RequestBlockedRefusalBody = {
      error: REQUEST_BLOCKED_CODE,
      block_reason: "min_requirements_failed",
      message: `${REASONS.request_blocked.sentence} ${REASONS.request_blocked.cure}`,
    };
    scripted = [{ status: 409, body }];
    const err = await thrown(() =>
      request("/admin/publish/nm000480/approve", { method: "POST" }, true),
    );
    expect(err.message).toBe(body.message);
    expect(err.code).toBe("request_blocked");
    expect(err.blockReason).toBe("min_requirements_failed");

    // No block reason on record: the code alone still makes the sentence win over the bare word.
    scripted = [{ status: 409, body: { ...body, block_reason: null } }];
    const bare = await thrown(() =>
      request("/admin/publish/nm000480/approve", { method: "POST" }, true),
    );
    expect(bare.message).toBe(body.message);
    expect(bare.blockReason).toBeUndefined();
  });

  test("a 409 request_changed leads with the sentence, not the bare word", async () => {
    const body = {
      error: "request_changed",
      message: REQUEST_CHANGED_MESSAGE,
    };
    scripted = [{ status: 409, body }];
    const err = await thrown(() =>
      request("/admin/publish/nm000480/approve", { method: "POST" }, true),
    );
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe(body.message);
    expect(err.code).toBe("request_changed");
  });

  test("each refusal of the dispatch token, the request precondition and the denial leads with its sentence", async () => {
    const refusals: [string, string][] = [
      ["request_mismatch", REQUEST_MISMATCH_MESSAGE],
      ["dispatch_superseded", DISPATCH_SUPERSEDED_MESSAGE],
      ["dispatch_expired", DISPATCH_EXPIRED_MESSAGE],
      ["decision_with_dispatch_token", DECISION_WITH_DISPATCH_TOKEN_MESSAGE],
      ["approval_in_flight", APPROVAL_IN_FLIGHT_MESSAGE],
      ["deny_after_publishing", DENY_AFTER_PUBLISHING_MESSAGE],
      ["invalid_dataset_id", INVALID_DATASET_ID_MESSAGE],
      ["approval_closed_during_run", APPROVAL_CLOSED_DURING_RUN_MESSAGE],
    ];
    for (const [code, message] of refusals) {
      scripted = [{ status: 409, body: { error: code, message } }];
      const err = await thrown(() =>
        request("/admin/publish/nm000480/approve", { method: "POST" }, true),
      );
      expect(err.statusCode).toBe(409);
      expect(err.message).toBe(message);
      expect(err.code).toBe(code);
    }
  });

  test("the words are declared once, with the screen's, and do not collide with it", () => {
    expect([...APPROVAL_REFUSAL_ERROR_CODES]).toEqual([
      PUBLICATION_REVIEW_NOT_CLEAR_CODE,
      REQUEST_BLOCKED_CODE,
      "request_changed",
      "request_mismatch",
      "dispatch_superseded",
      "dispatch_expired",
      "decision_with_dispatch_token",
      "approval_in_flight",
      "deny_after_publishing",
      "invalid_dataset_id",
      "approval_closed_during_run",
    ]);
    for (const code of APPROVAL_REFUSAL_ERROR_CODES) {
      expect(IDENTIFIER_SCREEN_ERROR_CODES).not.toContain(code);
    }
  });

  test("a refusal that is not one of these keeps the client's old reading: the word leads", async () => {
    // An `error` that is a sentence of some other route is printed as it was before.
    scripted = [{ status: 409, body: { error: "Some other refusal", message: "never preferred" } }];
    const err = await thrown(() =>
      request("/admin/publish/nm000480/approve", { method: "POST" }, true),
    );
    expect(err.message).toBe("Some other refusal");
  });
});

describe("the wait between approval attempts", () => {
  /** The wait `approvePublication` announces before its first retry; the run is ended there, so no test sleeps. */
  async function announcedDelay(): Promise<number> {
    scripted = [{ status: 500, body: { error: "boom" } }];
    const stop = new Error("stop after the notice");
    let delay = -1;
    await approvePublication(PROD_DATASET, true, false, false, (info) => {
      delay = info.delayMs;
      throw stop;
    }).catch((err: unknown) => {
      if (err !== stop) throw err;
    });
    return delay;
  }

  async function withKnob(value: string | undefined): Promise<number> {
    const previous = process.env.NEMAR_APPROVE_RETRY_DELAY_MS;
    if (value === undefined) Reflect.deleteProperty(process.env, "NEMAR_APPROVE_RETRY_DELAY_MS");
    else process.env.NEMAR_APPROVE_RETRY_DELAY_MS = value;
    try {
      return await announcedDelay();
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, "NEMAR_APPROVE_RETRY_DELAY_MS");
      } else process.env.NEMAR_APPROVE_RETRY_DELAY_MS = previous;
    }
  }

  test("is the shared default unless the knob names a whole number of milliseconds up to it", async () => {
    expect(await withKnob(undefined)).toBe(APPROVE_RETRY_DELAY_MS);
    expect(await withKnob("0")).toBe(0);
    expect(await withKnob("250")).toBe(250);
    expect(await withKnob(String(APPROVE_RETRY_DELAY_MS))).toBe(APPROVE_RETRY_DELAY_MS);
  });

  test("the knob can only shorten it: a longer wait, a negative one and anything else leave the default", async () => {
    for (const value of [
      String(APPROVE_RETRY_DELAY_MS + 1),
      "99999999",
      "-5",
      "1.5",
      "1e3",
      "",
      " 5",
      "ten",
    ]) {
      expect(await withKnob(value), JSON.stringify(value)).toBe(APPROVE_RETRY_DELAY_MS);
    }
  });
});

describe("readReview and a review the CLI cannot classify as the API does", () => {
  test("a reason with another cleared_by than this CLI's table is unreadable, and --force says it was not sent", async () => {
    const { requestId } = seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
    seedPublicationReview(h.db, {
      requestId,
      datasetId: PROD_DATASET,
      state: "reported",
      report: failingReport(),
    });
    // The Worker's own detail, as a newer Worker that moved `question_failed` out of the override
    // class would send it: the one word of the reason that decides what the CLI may do.
    const live = await getPublicationReview(PROD_DATASET);
    const skewed = JSON.parse(JSON.stringify(live));
    expect(skewed.reasons[0].code).toBe("question_failed");
    skewed.reasons[0].cleared_by = "nothing";
    scripted = [{ status: 200, body: skewed }];

    const read = await readReview(PROD_DATASET);

    expect(read).toEqual({
      kind: "unreadable",
      why: "this version of the CLI classifies a reason differently from the API",
    });
    const decision = decideApproval(PROD_DATASET, read, {
      force: true,
      acknowledge: undefined,
      resume: false,
    });
    expect(decision.kind).toBe("proceed");
    if (decision.kind === "proceed") {
      expect(decision.override).toBeNull();
      expect(decision.notes).toEqual([
        "The publication review could not be read (this version of the CLI classifies a reason differently from the API); the API still checks it.",
        "--force was not sent: no review could be read to approve over.",
      ]);
    }
    // The detail the Worker really sent is read as it always was.
    scripted = [{ status: 200, body: live }];
    expect((await readReview(PROD_DATASET)).kind).toBe("detail");
  });
});

describe("readReview carries the Worker's definitive refusal of the read", () => {
  test("a 400, 401 or 403 is the Worker's final word on the read; no other status is", async () => {
    for (const status of [400, 401, 403]) {
      scripted = [{ status, body: { error: "Refused", code: "refused" } }];
      const read = await readReview(PROD_DATASET);
      expect(read.kind, String(status)).toBe("unreadable");
      if (read.kind === "unreadable") {
        expect(read.refused?.statusCode, String(status)).toBe(status);
        expect(read.refused?.message).toBe("Refused");
        expect(read.why).toBe(`HTTP ${status}`);
      }
    }
    for (const status of [409, 429, 500, 502, 503]) {
      scripted = [{ status, body: { error: "Not final" } }];
      const read = await readReview(PROD_DATASET);
      expect(read.kind, String(status)).toBe("unreadable");
      if (read.kind === "unreadable") expect(read.refused, String(status)).toBeUndefined();
    }
    // A request with no active request is not one: the Worker decides what the approval says.
    scripted = [{ status: 404, body: { error: "None", code: "not_found" } }];
    expect(await readReview(PROD_DATASET)).toEqual({ kind: "absent", why: "no_request" });
  });

  test("a member's key, against the real router, is a refusal", async () => {
    useKey(MEMBER_KEY);
    seedScreenedRequest(h.db, { datasetId: PROD_DATASET });
    const read = await readReview(PROD_DATASET);
    expect(read.kind).toBe("unreadable");
    if (read.kind === "unreadable") expect(read.refused?.statusCode).toBe(403);
  });
});

describe("readReview tells a backend with no review route from a request with no review", () => {
  test("a 404 without the review's word is no_route, and the approval goes on with its own sentence", async () => {
    // An older backend has no `/review` route: its 404 is a bare `{ error }` with no `code`.
    scripted = [{ status: 404, body: { error: "Not found" } }];
    const read = await readReview(PROD_DATASET);
    expect(read).toEqual({ kind: "absent", why: "no_route" });
    const decision = decideApproval(PROD_DATASET, read, {
      force: false,
      acknowledge: undefined,
      resume: false,
    });
    expect(decision.kind).toBe("proceed");
    if (decision.kind === "proceed") {
      expect(decision.notes).toEqual(["This API has no publication review."]);
      expect(decision.override).toBeNull();
    }
  });

  test("a 404 with the review's not_found word is no_request: the Worker, not the CLI, answers for the request", async () => {
    const read = await readReview(PROD_DATASET);
    expect(read).toEqual({ kind: "absent", why: "no_request" });
  });
});
