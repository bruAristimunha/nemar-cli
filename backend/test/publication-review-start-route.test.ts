/**
 * POST /admin/publish/:id/review/start (ADR 0102, section 8).
 *
 * An administrator starts the review of a request's current screened commit, or starts again one
 * that was declined, errored, never reported or is past its deadline. What is pinned here is the
 * ROUTE: who may call it (a bearer key, or a session cookie from a NEMAR page and nobody else),
 * which answer each outcome gets (202 for a run that is going, a closed code with 409 for a
 * request that cannot be started, 404 for no request, 500 for a database fault), the audit row of
 * a start, and that nothing a response carries is a nonce or a token. The start's own rules (the
 * caps, the restart rule, the claim) are pinned through the service in
 * publication-review-callbacks.test.ts and publication-review-flow.test.ts; the cases here prove
 * that the route reaches them as an administrator's start and says what they said.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the real `/admin`
 * router behind its real auth middleware (hashed API keys, and a real web session for the cookie
 * path the website uses), review rows seeded through the production parser. GitHub is the
 * harness's `Bun.serve()` stand-in, so the dispatch each case sends is read off the wire.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  PUBLICATION_REVIEW_ERROR_CODES,
  type PublicationReviewErrorBody,
  type PublicationReviewErrorCode,
  START_NOT_HANDED_OVER_REASONS,
  START_REASONS,
  START_REFUSED_REASONS,
  START_STARTED_REASONS,
  type StartPublicationReviewResponse,
} from "../../shared/contract/publication-review-admin";
import { isOneOf } from "../../shared/pr-review";
import { DEPOSITOR_DAILY_CAP, PLATFORM_DAILY_CAP } from "../../shared/publication-review";
import { adminRoutes } from "../src/routes/admin";
import {
  NOT_HANDED_OVER,
  START_REFUSALS,
  startResponseOf,
} from "../src/routes/admin/publication-review";
import { START_RESULTS, type StartResult } from "../src/services/publication-review";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { realD1, wrapD1 } from "./helpers/d1";
import { SCREENED_HEAD } from "./helpers/identifier-screen";
import { logged } from "./helpers/logs";
import {
  type SeedScreenedRequest,
  seedPublicationReview,
  seedScreenedRequest,
  seedUser,
} from "./helpers/publication-review";
import { DEV_DATASET, PROD_DATASET, createHarness } from "./helpers/publication-review-harness";

const ADMIN_KEY = "start-admin-key-0123456789abcdef0123456789abcdef";
const MEMBER_KEY = "start-member-key-0123456789abcdef0123456789abcdef";
const APP_ORIGIN = "https://app.nemar.org";

const h = createHarness();

let admin: Hono<{ Bindings: Bindings; Variables: Variables }>;
let adminId: number;
let memberId: number;

beforeEach(async () => {
  admin = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  admin.route("/admin", adminRoutes);
  adminId = await seedUser(h.db, "startadmin", "admin", ADMIN_KEY);
  memberId = await seedUser(h.db, "startmember", "member", MEMBER_KEY);
});

/** The n-th extra production-owned dataset id (never a live one, never a reserved fixture). */
const ds = (n: number) => `nm${String(1000 + n).padStart(6, "0")}`;

function start(
  datasetId: string,
  o: { key?: string; headers?: Record<string, string>; bindings?: Bindings } = {},
) {
  return admin.request(
    `/admin/publish/${datasetId}/review/start`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${o.key ?? ADMIN_KEY}`, ...o.headers },
    },
    o.bindings ?? h.env(),
  );
}

async function cookieFor(userId: number): Promise<string> {
  const { cookieIdRaw } = await issueSession(
    h.env(),
    userId,
    false,
    "test-agent",
    "127.0.0.1",
    "orcid",
  );
  return `nemar_session=${cookieIdRaw}`;
}

function startWithCookie(datasetId: string, cookie: string, origin?: string) {
  return admin.request(
    `/admin/publish/${datasetId}/review/start`,
    { method: "POST", headers: { Cookie: cookie, ...(origin ? { Origin: origin } : {}) } },
    h.env(),
  );
}

type ErrorBody = PublicationReviewErrorBody;

async function bodyOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function auditRows() {
  return h.db
    .query("SELECT * FROM audit_log WHERE action = 'publication_review_started' ORDER BY id")
    .all() as Record<string, unknown>[];
}

/** A native request with a clear screen at SCREENED_HEAD; no review of it yet. */
function request(datasetId = PROD_DATASET, over: Omit<SeedScreenedRequest, "datasetId"> = {}) {
  return seedScreenedRequest(h.db, { ...over, datasetId });
}

/** `n` reviews that reached a model for other depositors in the last day. */
function fillPlatform(n: number) {
  for (let i = 0; i < n; i++) {
    const datasetId = ds(500 + i);
    const r = request(datasetId);
    seedPublicationReview(h.db, {
      requestId: r.requestId,
      datasetId,
      state: "reported",
      claimed: true,
    });
  }
}

/** What a refused start leaves behind: no row, no dispatch, no audit row. */
function expectNothingStarted(rowsBefore = 0) {
  expect(h.reviews()).toHaveLength(rowsBefore);
  expect(h.dispatches()).toHaveLength(0);
  expect(auditRows()).toHaveLength(0);
}

// ============================================================================

describe("who may start a review", () => {
  test("a bearer key starts the review: 202, one dispatch, started by the administrator", async () => {
    const { requestId } = request();
    const res = await start(PROD_DATASET);
    expect(res.status).toBe(202);
    const body = await bodyOf<StartPublicationReviewResponse>(res);
    const rows = h.reviews();
    expect(rows).toHaveLength(1);
    expect(body).toEqual({
      environment: "production",
      started: true,
      reason: "dispatched",
      review_id: rows[0].id as number,
    });
    expect(rows[0]).toMatchObject({
      request_id: requestId,
      head_sha: SCREENED_HEAD,
      state: "dispatched",
      started_by: adminId,
    });
    const dispatches = h.dispatches();
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].event_type).toBe("run-publication-review");
    expect(dispatches[0].client_payload).toMatchObject({
      dataset_id: PROD_DATASET,
      request_id: requestId,
      review_id: rows[0].id,
      head_sha: SCREENED_HEAD,
    });
  });

  test("a bearer key is not asked for an Origin: a terminal sends none, and a foreign one is no concern", async () => {
    request();
    const res = await start(PROD_DATASET, { headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(202);
  });

  test("an administrator's session cookie from a NEMAR page starts the review, and is the starter", async () => {
    request();
    const res = await startWithCookie(PROD_DATASET, await cookieFor(adminId), APP_ORIGIN);
    expect(res.status).toBe(202);
    expect(h.reviews()[0]).toMatchObject({ state: "dispatched", started_by: adminId });
  });

  test("a cookie request from a foreign origin is refused 403 origin_not_allowed, and nothing starts", async () => {
    // A cookie rides along with any cross-site request a browser can be tricked into making, and
    // this route spends the platform's money.
    request();
    const res = await startWithCookie(
      PROD_DATASET,
      await cookieFor(adminId),
      "https://evil.example",
    );
    expect(res.status).toBe(403);
    expect((await bodyOf<ErrorBody>(res)).code).toBe("origin_not_allowed");
    expectNothingStarted();
  });

  test("a cookie request with no Origin at all is refused too", async () => {
    request();
    const res = await startWithCookie(PROD_DATASET, await cookieFor(adminId));
    expect(res.status).toBe(403);
    expect((await bodyOf<ErrorBody>(res)).code).toBe("origin_not_allowed");
    expectNothingStarted();
  });

  test("a member is refused 403, whatever the credential, and nothing starts", async () => {
    request();
    expect((await start(PROD_DATASET, { key: MEMBER_KEY })).status).toBe(403);
    const res = await startWithCookie(PROD_DATASET, await cookieFor(memberId), APP_ORIGIN);
    expect(res.status).toBe(403);
    expectNothingStarted();
  });

  test("no credential is 401 and nothing starts", async () => {
    request();
    const res = await admin.request(
      `/admin/publish/${PROD_DATASET}/review/start`,
      { method: "POST" },
      h.env(),
    );
    expect(res.status).toBe(401);
    expectNothingStarted();
  });

  test("a malformed dataset id is 400 bad_dataset", async () => {
    const res = await start("not-a-dataset");
    expect(res.status).toBe(400);
    expect((await bodyOf<ErrorBody>(res)).code).toBe("bad_dataset");
    expectNothingStarted();
  });
});

// ============================================================================

describe("a request that cannot be started", () => {
  test("no active request is 404 not_found: none at all, or only a published or denied one", async () => {
    const none = await start(PROD_DATASET);
    expect(none.status).toBe(404);
    expect((await bodyOf<ErrorBody>(none)).code).toBe("not_found");

    for (const [i, requestStatus] of (["published", "denied"] as const).entries()) {
      const datasetId = ds(i);
      request(datasetId, { requestStatus });
      const res = await start(datasetId);
      expect(res.status).toBe(404);
      expect((await bodyOf<ErrorBody>(res)).code).toBe("not_found");
    }
    expectNothingStarted();
  });

  /** Each reason a start can refuse, how to arrange it, and the closed code it carries. */
  const refusals: [
    PublicationReviewErrorCode,
    string,
    () => { dataset: string; env?: Bindings },
  ][] = [
    [
      "review_disabled",
      "the review is switched off",
      () => {
        request();
        return { dataset: PROD_DATASET, env: h.env({ PUBLICATION_REVIEW_ENABLED: undefined }) };
      },
    ],
    [
      "not_applicable",
      "the dataset is an OpenNeuro mirror",
      () => {
        request(PROD_DATASET, { source: "openneuro" });
        return { dataset: PROD_DATASET };
      },
    ],
    [
      "not_applicable",
      "the dataset is an exemplar",
      () => {
        request(PROD_DATASET, { isExemplar: 1 });
        return { dataset: PROD_DATASET };
      },
    ],
    [
      "not_owned_here",
      "the dataset belongs to the other Worker (a reserved fixture, asked of production)",
      () => {
        request(DEV_DATASET);
        return { dataset: DEV_DATASET };
      },
    ],
    [
      "not_owned_here",
      "the dataset belongs to the other Worker (a real dataset, asked of the dev Worker)",
      () => {
        request();
        return { dataset: PROD_DATASET, env: h.env({ ENVIRONMENT: "development" }) };
      },
    ],
    [
      "request_not_requested",
      "the request is blocked",
      () => {
        request(PROD_DATASET, {
          datasetId: PROD_DATASET,
          requestStatus: "blocked",
          blockReason: "min_requirements_failed",
        });
        return { dataset: PROD_DATASET };
      },
    ],
    [
      "request_not_requested",
      "the request is being approved",
      () => {
        request(PROD_DATASET, { requestStatus: "approving" });
        return { dataset: PROD_DATASET };
      },
    ],
    [
      "screen_not_ready",
      "the identifier screen is still running",
      () => {
        request(PROD_DATASET, { status: "pending" });
        return { dataset: PROD_DATASET };
      },
    ],
    [
      "screen_not_ready",
      "the identifier screen found direct identifiers",
      () => {
        request(PROD_DATASET, { status: "direct-identifiers" });
        return { dataset: PROD_DATASET };
      },
    ],
    [
      "screen_not_ready",
      "the identifier screen did not report",
      () => {
        request(PROD_DATASET, { status: "unreported" });
        return { dataset: PROD_DATASET };
      },
    ],
    [
      "running",
      "a review of the commit is running",
      () => {
        const { requestId } = request();
        seedPublicationReview(h.db, {
          requestId,
          datasetId: PROD_DATASET,
          state: "dispatched",
          createdMinutesAgo: 5,
        });
        return { dataset: PROD_DATASET };
      },
    ],
    [
      "has_result",
      "a review of the commit has reported",
      () => {
        const { requestId } = request();
        seedPublicationReview(h.db, { requestId, datasetId: PROD_DATASET, state: "reported" });
        return { dataset: PROD_DATASET };
      },
    ],
  ];

  for (const [code, why, arrange] of refusals) {
    test(`409 ${code} when ${why}: the code, a sentence, and nothing written`, async () => {
      const { dataset, env } = arrange();
      const rowsBefore = JSON.stringify(h.reviews());
      const res = await start(dataset, { bindings: env });
      expect(res.status).toBe(409);
      const body = await bodyOf<ErrorBody>(res);
      expect(body.code).toBe(code);
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
      expect(PUBLICATION_REVIEW_ERROR_CODES).toContain(body.code);
      expect(Object.keys(body).sort()).toEqual(["code", "error"]);
      // Nothing moved: the same rows, no dispatch, no audit row.
      expect(JSON.stringify(h.reviews())).toBe(rowsBefore);
      expect(h.dispatches()).toHaveLength(0);
      expect(auditRows()).toHaveLength(0);
    });
  }

  test("every refusal the route can make is exercised, and each is a closed code of the contract", () => {
    // The route's own table, not a list typed here: a refusal added to it without a case above (or
    // in the platform's cap, which writes a declined row and so has its own test below) fails here.
    const exercised = new Set<string>([...refusals.map(([code]) => code), "platform_limit"]);
    expect([...exercised].sort()).toEqual(Object.keys(START_REFUSALS).sort());
    expect(Object.keys(START_REFUSALS).sort()).toEqual([...START_REFUSED_REASONS].sort());
    for (const [reason, refusal] of Object.entries(START_REFUSALS)) {
      expect(PUBLICATION_REVIEW_ERROR_CODES as readonly string[]).toContain(refusal.code);
      // One word each: what the service says and what the body's `code` carries are the same.
      expect(refusal.code).toBe(reason);
      expect(refusal.error.length).toBeGreaterThan(10);
    }
  });

  test("the platform's allowance is worded for a rolling window, not a calendar day", () => {
    expect(START_REFUSALS.platform_limit.error).not.toMatch(/tomorrow/i);
    expect(START_REFUSALS.platform_limit.error).toContain("24 hours");
  });
});

// ============================================================================

describe("starting again", () => {
  test("a declined row is restarted: 202 redispatched with the same review id", async () => {
    const { requestId } = request();
    const reviewId = seedPublicationReview(h.db, {
      requestId,
      datasetId: PROD_DATASET,
      state: "declined",
      detail: "depositor_limit",
    });
    const res = await start(PROD_DATASET);
    expect(res.status).toBe(202);
    expect(await bodyOf<StartPublicationReviewResponse>(res)).toEqual({
      environment: "production",
      started: true,
      reason: "redispatched",
      review_id: reviewId,
    });
    expect(h.review(reviewId)).toMatchObject({ state: "dispatched", started_by: adminId });
    expect(h.dispatches()).toHaveLength(1);
  });

  const restartable: [
    string,
    "errored" | "unreported" | "dispatched",
    string | undefined,
    number,
  ][] = [
    ["an errored row (the model was unavailable)", "errored", "model_unavailable", 0],
    ["an errored row (the dispatch failed)", "errored", "dispatch_failed", 0],
    ["a row that never reported", "unreported", undefined, 120],
    ["a dispatched row past its deadline", "dispatched", undefined, 45],
  ];
  for (const [what, state, detail, minutesAgo] of restartable) {
    test(`${what} is restarted: 202 redispatched`, async () => {
      const { requestId } = request();
      const reviewId = seedPublicationReview(h.db, {
        requestId,
        datasetId: PROD_DATASET,
        state,
        detail,
        createdMinutesAgo: minutesAgo,
        claimed: true,
      });
      const oldNonce = h.nonceOf(reviewId);
      const res = await start(PROD_DATASET);
      expect(res.status).toBe(202);
      expect(await bodyOf<StartPublicationReviewResponse>(res)).toMatchObject({
        started: true,
        reason: "redispatched",
        review_id: reviewId,
      });
      expect(h.review(reviewId)).toMatchObject({ state: "dispatched", claimed_at: null });
      expect(h.nonceOf(reviewId)).not.toBeNull();
      expect(h.nonceOf(reviewId)).not.toBe(oldNonce);
      expect(h.dispatches()).toHaveLength(1);
    });
  }

  test("the second start of one commit is refused: the first one is running", async () => {
    request();
    expect((await start(PROD_DATASET)).status).toBe(202);
    const again = await start(PROD_DATASET);
    expect(again.status).toBe(409);
    expect((await bodyOf<ErrorBody>(again)).code).toBe("running");
    expect(h.dispatches()).toHaveLength(1);
    expect(auditRows()).toHaveLength(1);
  });

  test("the dev Worker starts a reserved fixture it owns, and says it is not production", async () => {
    request(DEV_DATASET);
    const res = await start(DEV_DATASET, { bindings: h.env({ ENVIRONMENT: "development" }) });
    expect(res.status).toBe(202);
    expect(await bodyOf<StartPublicationReviewResponse>(res)).toMatchObject({
      environment: "non-production",
      started: true,
      reason: "dispatched",
    });
    expect(h.dispatches()[0].client_payload.environment).toBe("dev");
  });
});

// ============================================================================

describe("the caps", () => {
  test("the depositor's allowance does not hold an administrator's start", async () => {
    // Five model calls by one depositor in a day is the depositor's whole allowance.
    expect(DEPOSITOR_DAILY_CAP).toBe(5);
    const { requestId, userId } = request();
    for (let i = 0; i < DEPOSITOR_DAILY_CAP; i++) {
      const datasetId = ds(400 + i);
      const r = request(datasetId, { requestedBy: userId });
      seedPublicationReview(h.db, {
        requestId: r.requestId,
        datasetId,
        state: "reported",
        claimed: true,
      });
    }
    const res = await start(PROD_DATASET);
    expect(res.status).toBe(202);
    expect(await bodyOf<StartPublicationReviewResponse>(res)).toMatchObject({
      started: true,
      reason: "dispatched",
    });
    const mine = h.reviews().find((r) => r.request_id === requestId);
    expect(mine).toMatchObject({ state: "dispatched", detail: null });
  });

  test("the platform's allowance does: 409 platform_limit, the row is declined, nothing is sent", async () => {
    expect(PLATFORM_DAILY_CAP).toBe(50);
    fillPlatform(PLATFORM_DAILY_CAP);
    const { requestId } = request();
    const before = h.reviews().length;
    const res = await start(PROD_DATASET);
    expect(res.status).toBe(409);
    expect((await bodyOf<ErrorBody>(res)).code).toBe("platform_limit");
    const mine = h.reviews().find((r) => r.request_id === requestId);
    expect(mine).toMatchObject({ state: "declined", detail: "platform_limit", nonce: null });
    expect(h.reviews()).toHaveLength(before + 1);
    expect(h.dispatches()).toHaveLength(0);
    // Nothing started, so there is no audit row.
    expect(auditRows()).toHaveLength(0);
  });

  test("one call under the platform's allowance still starts", async () => {
    fillPlatform(PLATFORM_DAILY_CAP - 1);
    request();
    expect((await start(PROD_DATASET)).status).toBe(202);
  });
});

// ============================================================================

describe("the audit row", () => {
  test("a start writes publication_review_started: who, which request, which review, why, which commit", async () => {
    const { requestId } = request();
    const res = await start(PROD_DATASET);
    const { review_id } = await bodyOf<StartPublicationReviewResponse>(res);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: adminId,
      action: "publication_review_started",
      resource_type: "dataset",
      resource_id: PROD_DATASET,
    });
    expect(JSON.parse(rows[0].details as string)).toEqual({
      request_id: requestId,
      review_id,
      reason: "dispatched",
      head_sha: SCREENED_HEAD,
    });
  });

  test("a restart writes one too, with its own reason", async () => {
    const { requestId } = request();
    const reviewId = seedPublicationReview(h.db, {
      requestId,
      datasetId: PROD_DATASET,
      state: "errored",
      detail: "model_unavailable",
      claimed: true,
    });
    await start(PROD_DATASET);
    expect(JSON.parse(auditRows()[0].details as string)).toEqual({
      request_id: requestId,
      review_id: reviewId,
      reason: "redispatched",
      head_sha: SCREENED_HEAD,
    });
  });

  test("an audit row that cannot be written is logged by ids and fixed words, and the start stands", async () => {
    const { requestId } = request();
    const fault = "D1_ERROR: secret-sql-detail-sentinel";
    const faulty = wrapD1(realD1(h.db), (sql) => {
      if (sql.includes("INSERT INTO audit_log")) throw new Error(fault);
    });
    let status = 0;
    const lines = await logged(async () => {
      status = (await start(PROD_DATASET, { bindings: h.env({ DB: faulty }) })).status;
    });
    expect(status).toBe(202);
    expect(h.reviews()[0]).toMatchObject({ request_id: requestId, state: "dispatched" });
    expect(h.dispatches()).toHaveLength(1);
    expect(auditRows()).toHaveLength(0);
    const line = lines.find((l) => l.includes("audit"));
    expect(line).toBeDefined();
    expect(line).toContain(PROD_DATASET);
    expect(lines.join("\n")).not.toContain("secret-sql-detail-sentinel");
    expect(lines.join("\n")).not.toContain("INSERT");
  });
});

// ============================================================================

describe("a start that did not hand the review over", () => {
  test("GitHub refusing the dispatch is 502 with the reason, no audit row, and the row is dispatch_failed", async () => {
    request();
    h.dispatchStatus = 500;
    const res = await start(PROD_DATASET);
    expect(res.status).toBe(502);
    const body = await bodyOf<StartPublicationReviewResponse>(res);
    // The union is narrowed by `started`, so `error` and `code` are read without a cast.
    if (body.started) throw new Error("a start that was not handed over said it started");
    expect(body).toEqual({
      environment: "production",
      started: false,
      reason: "dispatch_failed",
      review_id: expect.any(Number),
      code: "dispatch_failed",
      error: NOT_HANDED_OVER.dispatch_failed.error,
    });
    expect(PUBLICATION_REVIEW_ERROR_CODES).toContain(body.code);
    expect(h.reviews()[0]).toMatchObject({
      id: body.review_id,
      state: "errored",
      detail: "dispatch_failed",
      nonce: null,
    });
    expect(auditRows()).toHaveLength(0);

    // Once GitHub answers, a start takes the same row up again.
    h.dispatchStatus = 204;
    const again = await start(PROD_DATASET);
    expect(again.status).toBe(202);
    expect(await bodyOf<StartPublicationReviewResponse>(again)).toMatchObject({
      started: true,
      reason: "redispatched",
      review_id: body.review_id,
    });
  });

  test("a Worker with no callback secret or no GitHub credential is 502 dispatch_unconfigured, and nothing is sent", async () => {
    request();
    for (const missing of [
      { PRESCREEN_CALLBACK_SECRET: undefined },
      { GITHUB_ADMIN_PAT: undefined },
    ] as Partial<Bindings>[]) {
      const res = await start(PROD_DATASET, { bindings: h.env(missing) });
      expect(res.status).toBe(502);
      const body = await bodyOf<StartPublicationReviewResponse>(res);
      if (body.started) throw new Error("a start that was not handed over said it started");
      expect(body).toMatchObject({
        started: false,
        reason: "dispatch_unconfigured",
        code: "dispatch_unconfigured",
        error: NOT_HANDED_OVER.dispatch_unconfigured.error,
      });
      expect(PUBLICATION_REVIEW_ERROR_CODES).toContain(body.code);
    }
    expect(h.reviews()[0]).toMatchObject({ state: "errored", detail: "dispatch_unconfigured" });
    expect(h.dispatches()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  test("a dispatch that failed after the job already claimed it is 202 dispatch_claimed: the run stands", async () => {
    request();
    h.dispatchStatus = 500;
    h.duringDispatch = async () => {
      const id = h.reviews()[0].id as number;
      expect((await h.claim(id)).status).toBe(200);
    };
    const res = await start(PROD_DATASET);
    expect(res.status).toBe(202);
    const body = await bodyOf<StartPublicationReviewResponse>(res);
    expect(body).toMatchObject({ started: true, reason: "dispatch_claimed" });
    expect(h.review(body.review_id as number)).toMatchObject({ state: "dispatched" });
    // A run is going, so it is an audited start.
    expect(JSON.parse(auditRows()[0].details as string)).toMatchObject({
      reason: "dispatch_claimed",
      review_id: body.review_id,
    });
  });

  test("a database fault after the row is written is 500 internal, with no SQL in the body or the log", async () => {
    const { requestId } = request();
    const faulty = wrapD1(realD1(h.db), (sql) => {
      if (sql.includes("COALESCE(SUM(attempts)")) {
        throw new Error("D1_ERROR: SELECT secret-sql-detail-sentinel FROM publication_reviews");
      }
    });
    let res: Response | undefined;
    const lines = await logged(async () => {
      res = await start(PROD_DATASET, { bindings: h.env({ DB: faulty }) });
    });
    expect(res?.status).toBe(500);
    const text = await (res as Response).text();
    expect(JSON.parse(text)).toEqual({
      error: expect.any(String),
      code: "internal",
    });
    expect(text).not.toContain("secret-sql-detail-sentinel");
    expect(text).not.toContain("SELECT");
    expect(lines.join("\n")).not.toContain("secret-sql-detail-sentinel");
    expect(lines.join("\n")).not.toContain("SELECT");
    expect(lines.some((l) => l.includes(PROD_DATASET))).toBe(true);
    // The start marked the row before it threw, so nothing waits for a job that was never sent.
    const mine = h.reviews().find((r) => r.request_id === requestId);
    expect(mine).toMatchObject({ state: "errored", detail: "dispatch_failed", nonce: null });
    expect(h.dispatches()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  test("a fault before anything is written is 500 internal too", async () => {
    request();
    const faulty = wrapD1(realD1(h.db), (sql) => {
      if (sql.includes("FROM publication_requests pr JOIN datasets")) {
        throw new Error("D1_ERROR: secret-sql-detail-sentinel");
      }
    });
    const res = await start(PROD_DATASET, { bindings: h.env({ DB: faulty }) });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text).code).toBe("internal");
    expect(text).not.toContain("secret-sql-detail-sentinel");
    expect(h.reviews()).toHaveLength(0);
  });
});

// ============================================================================

describe("what a response carries", () => {
  test("never a nonce, a token or a secret, in any answer", async () => {
    const secrets = ["publication-review-callback-secret", "ghp_publication_review_test"];
    const answers: string[] = [];

    // A start, a refusal, a restart, a failure and a missing request.
    request();
    answers.push(await (await start(PROD_DATASET)).text());
    const dispatch = h.dispatches()[0].client_payload;
    const token = dispatch.callback_token as string;
    const nonce = h.nonceOf(h.reviews()[0].id as number) as string;
    answers.push(await (await start(PROD_DATASET)).text());
    h.db.run("UPDATE publication_reviews SET created_at = datetime('now', '-60 minutes')");
    answers.push(await (await start(PROD_DATASET)).text());
    const nonce2 = h.nonceOf(h.reviews()[0].id as number) as string;
    h.dispatchStatus = 500;
    request(ds(1));
    answers.push(await (await start(ds(1))).text());
    answers.push(await (await start(ds(2))).text());

    expect(token.length).toBeGreaterThan(10);
    for (const text of answers) {
      for (const secret of [token, nonce, nonce2, ...secrets]) {
        expect(text).not.toContain(secret);
      }
      expect(Object.keys(JSON.parse(text))).not.toContain("nonce");
      expect(Object.keys(JSON.parse(text))).not.toContain("callback_token");
    }
  });

  test("every word the service can answer a start with has exactly one answer, from the contract's words", () => {
    // Over EVERY word of the service's result, not a sample: the route's mapping is total, and the
    // words it puts in a body are the contract's. `duplicate` (a screen result's own answer) and
    // `depositor_limit` (the depositor's allowance, which holds only a screen result's start) are
    // never an administrator's, so they are the route's unexpected branch: a 500, not a made-up
    // 2xx or 4xx, and not a word the contract does not list.
    const statusOf = new Map<StartResult, number>();
    for (const reason of START_RESULTS) {
      const out = startResponseOf(
        isOneOf(START_STARTED_REASONS, reason)
          ? { started: true, reason, reviewId: 7 }
          : { started: false, reason, reviewId: null },
        "production",
      );
      statusOf.set(reason, out.status);
      if (out.status === 202) {
        expect(out.body).toEqual({
          environment: "production",
          started: true,
          reason,
          review_id: 7,
        });
        expect(START_REASONS).toContain(out.body.reason);
      } else if (out.status === 409) {
        if (!isOneOf(START_REFUSED_REASONS, reason)) throw new Error("a 409 for a non-refusal");
        expect(out.body).toEqual(START_REFUSALS[reason]);
        expect(PUBLICATION_REVIEW_ERROR_CODES).toContain(out.body.code);
      } else if (out.status === 502) {
        if (!isOneOf(START_NOT_HANDED_OVER_REASONS, reason))
          throw new Error("a 502 for a hand-over");
        expect(out.body).toEqual({
          environment: "production",
          started: false,
          reason,
          review_id: null,
          code: reason,
          error: NOT_HANDED_OVER[reason].error,
        });
        expect(START_REASONS).toContain(out.body.reason);
        expect(PUBLICATION_REVIEW_ERROR_CODES).toContain(out.body.code);
      } else {
        expect(out.status).toBe(500);
        expect(out.body).toEqual({
          error: "The publication review could not be started. Try again.",
          code: "internal",
        });
      }
    }
    const answeredWith = (status: number) =>
      [...statusOf].filter(([, s]) => s === status).map(([word]) => word);
    expect(answeredWith(202)).toEqual([...START_STARTED_REASONS]);
    expect(answeredWith(409)).toEqual([...START_REFUSED_REASONS]);
    expect(answeredWith(502)).toEqual([...START_NOT_HANDED_OVER_REASONS]);
    expect(answeredWith(500)).toEqual(["duplicate", "depositor_limit"]);
  });
});
