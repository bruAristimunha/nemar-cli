/**
 * POST /admin/publish/:id/comment (ADR 0102, section 8).
 *
 * An administrator types a message, the route mails it to the depositor, and the request stays
 * open. What is pinned here is the ROUTE and the words it sends: who may call it (a bearer key, or
 * a session cookie from a NEMAR page and nobody else, because it mails a real person), that the
 * mail is the typed words in a fixed frame and nothing of the review, that it goes to the
 * depositor and to nobody else through the environment's delivery fence, which answer each
 * outcome gets (a send that certainly did not go is told apart from one that may have), and that
 * the audit row says what happened whichever way the send went.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the real `/admin`
 * router behind its real auth middleware (hashed API keys, and a real web session for the cookie
 * path the website uses), review rows seeded through the production parser. Resend is the shared
 * real-boundary capture: `services/email.ts` runs unchanged, builds its real HTML and applies its
 * real fence, and only the destination of the `fetch` moves, so every mail is read off the wire
 * and no test can reach a real address. Every call of the route runs inside it, including the
 * ones that must send nothing: a call outside it would reach the real Resend host if the route
 * were wrong.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  type OriginNotAllowedBody,
  PUBLICATION_COMMENT_ERROR_CODES,
  PUBLICATION_COMMENT_MAX_LENGTH,
  type PublicationCommentErrorBody,
  type PublicationCommentResponse,
  type PublicationReviewDetail,
} from "../../shared/contract/publication-review-admin";
import { PUBLICATION_COMMENT_SENTENCES } from "../src/routes/admin/publish-comment";
import { issueSession } from "../src/services/web-session";
import type { Bindings } from "../src/types/bindings";
import { realD1 } from "./helpers/d1";
import {
  NOTE_SENTINEL,
  SUMMARY_SENTINEL,
  type SeedScreenedRequest,
  failingReport,
  seedPublicationReview,
  seedScreenedRequest,
  seedUser,
  textOf,
} from "./helpers/publication-review";
import { PROD_DATASET, createHarness, hookedD1 } from "./helpers/publication-review-harness";
import { type CapturedEmail, asSend, withFakeResend } from "./helpers/resend";

const ADMIN_KEY = "comment-admin-key-0123456789abcdef0123456789abcdef";
const MEMBER_KEY = "comment-member-key-0123456789abcdef0123456789abcd";
const APP_ORIGIN = "https://app.nemar.org";
const ACTION = "publication_request_commented";

/** What the frame says so the depositor knows who wrote. */
const FRAME_SENTENCE = "This is a message from a NEMAR administrator. Your request stays open";
/** The invitation to answer, which the frame carries only when the Worker has a reply address. */
const REPLY_INVITATION = "reply to this email to answer";
const REPLY_TO = "admin-inbox@example.org";
// The oracle for the two failure sentences, kept as literals: the route's own constants are
// compared with these in one test and used by the rest.
const NOT_SENT_SENTENCE = "The message could not be mailed, so nothing was sent to the depositor.";
// Deliberately not "nothing was sent": a Resend 5xx or a lost answer can leave the mail accepted,
// and an administrator who read "nothing was sent" might send it again.
const NOT_CONFIRMED_SENTENCE =
  "The mail may not have been sent, and it may also have arrived. Check with the depositor before sending it again.";

const h = createHarness();

let adminId: number;
let memberId: number;

beforeEach(async () => {
  adminId = await seedUser(h.db, "commentadmin", "admin", ADMIN_KEY);
  memberId = await seedUser(h.db, "commentmember", "member", MEMBER_KEY);
});

/** The depositor `seedScreenedRequest` creates for a dataset. */
const depositorEmail = (datasetId = PROD_DATASET) => `depositor_${datasetId}@example.org`;

/** The n-th extra production-owned dataset id (never a live one, never a reserved fixture). */
const ds = (n: number) => `nm${String(1000 + n).padStart(6, "0")}`;

/** A native request with a clear screen; the depositor is created with it. */
function request(datasetId = PROD_DATASET, over: Omit<SeedScreenedRequest, "datasetId"> = {}) {
  return seedScreenedRequest(h.db, { ...over, datasetId });
}

interface Sent {
  res: Response;
  /** Every request that reached the Resend stand-in. */
  calls: CapturedEmail[];
  /** The answer's body as sent. */
  text: string;
  /** The JSON of the answer, or null when it was not JSON. */
  json: unknown;
}

interface SendOptions {
  key?: string;
  /** Replaces the bearer key: the request carries this session cookie instead. */
  cookie?: string;
  headers?: Record<string, string>;
  env?: Partial<Bindings>;
  /** The body as bytes, for the cases that are not JSON of the shape under test. */
  raw?: string;
  /** What the Resend stand-in answers with. Default 200. */
  resendStatus?: number;
  /** The Resend host cannot be reached at all: the send's `fetch` rejects, as in a network fault. */
  resendUnreachable?: boolean;
}

/** POST the comment route as the Worker would answer it, inside the Resend stand-in. */
function send(datasetId: string, body: unknown, o: SendOptions = {}): Promise<Sent> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...o.headers };
  if (o.cookie) headers.Cookie = o.cookie;
  else headers.Authorization = `Bearer ${o.key ?? ADMIN_KEY}`;
  return withFakeResend(
    async (calls) => {
      // The network fault is the Resend boundary's too: only the destination host is cut off.
      const reachable = globalThis.fetch;
      if (o.resendUnreachable) {
        globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.hostname === "api.resend.com")
            return Promise.reject(new TypeError("fetch failed"));
          return reachable(input as RequestInfo, init);
        }) as typeof fetch;
      }
      let res: Response;
      try {
        res = await h.app.request(
          `/admin/publish/${datasetId}/comment`,
          { method: "POST", headers, body: o.raw ?? JSON.stringify(body) },
          h.env(o.env),
        );
      } finally {
        globalThis.fetch = reachable;
      }
      const text = await res.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        // A bare status with no body is a legitimate answer for a case that does not reach the route.
      }
      return { res, calls, text, json };
    },
    { status: o.resendStatus },
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

function auditRows() {
  return h.db.query("SELECT * FROM audit_log WHERE action = ? ORDER BY id").all(ACTION) as Record<
    string,
    unknown
  >[];
}

/** What a refused or failed call leaves behind besides its answer: no mail, and no change. */
function expectNothingMailed(calls: CapturedEmail[]) {
  expect(calls).toHaveLength(0);
}

// ============================================================================

describe("the mail is the typed words in a fixed frame, to the depositor", () => {
  test("a bearer key mails the depositor the typed words, escaped, and nobody else; the request stays open", async () => {
    const { requestId } = request();
    const before = h.requestRow(requestId);
    const typed = `  Please add a LICENSE file. <script>alert("x")</script> & thanks, it's fine.\n\nSecond paragraph.  `;

    const { res, calls, json } = await send(PROD_DATASET, { message: typed });

    expect(res.status).toBe(200);
    const body = json as PublicationCommentResponse;
    expect(body).toEqual({ dataset_id: PROD_DATASET, request_id: requestId, mailed: true });

    // One send, to the depositor and to nobody else (not the administrator who typed it).
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/emails");
    const mail = asSend(calls[0]);
    expect(mail.to).toEqual([depositorEmail()]);
    expect(mail.subject).toBe(`About your publication request: ${PROD_DATASET}`);

    // The typed words, trimmed, escaped: a `<script>` arrives as text, never as markup.
    expect(mail.html).toContain(
      "Please add a LICENSE file. &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; thanks, it&#39;s fine.\n\nSecond paragraph.",
    );
    expect(mail.html).not.toContain("<script");
    expect(mail.html).toContain("white-space: pre-wrap");
    expect(textOf(mail.html)).toContain(
      `Please add a LICENSE file. <script>alert("x")</script> & thanks, it's fine. Second paragraph.`,
    );
    expect(textOf(mail.html)).toContain(`${FRAME_SENTENCE}.`);
    expect(textOf(mail.html)).toContain("Hello depositor_nm000480,");

    // The request is not touched: still waiting for its decision.
    const after = h.requestRow(requestId);
    expect(after.status).toBe("requested");
    expect(after).toEqual(before);

    // One audit row says who typed what, and that it went.
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: adminId,
      resource_type: "dataset",
      resource_id: PROD_DATASET,
    });
    expect(JSON.parse(rows[0].details as string)).toEqual({
      request_id: requestId,
      outcome: "sent",
      message: typed.trim(),
    });
  });

  test("the reply invitation is in the frame only when the Worker has a reply address to send answers to", async () => {
    request();
    const without = await send(PROD_DATASET, { message: "Please add a LICENSE file." });
    expect(without.res.status).toBe(200);
    expect((without.calls[0].body as { reply_to?: string }).reply_to).toBeUndefined();
    const bare = textOf(asSend(without.calls[0]).html);
    expect(bare).toContain(`${FRAME_SENTENCE}.`);
    expect(bare).not.toContain(REPLY_INVITATION);
    expect(bare).not.toContain("reply");

    const withReply = await send(
      PROD_DATASET,
      { message: "Please add a LICENSE file." },
      { env: { REPLY_TO } },
    );
    expect(withReply.res.status).toBe(200);
    expect((withReply.calls[0].body as { reply_to?: string }).reply_to).toBe(REPLY_TO);
    expect(textOf(asSend(withReply.calls[0]).html)).toContain(
      `${FRAME_SENTENCE}; ${REPLY_INVITATION}.`,
    );
    // The rest of the frame does not depend on it.
    expect(textOf(asSend(withReply.calls[0]).html)).toContain("Hello depositor_nm000480,");
    expect(textOf(asSend(withReply.calls[0]).html)).toContain("Please add a LICENSE file.");
  });

  test("the review is not gated by its switch: with the review off the mail still goes", async () => {
    request();
    const { res, calls } = await send(
      PROD_DATASET,
      { message: "Please add a LICENSE file." },
      { env: { PUBLICATION_REVIEW_ENABLED: "0" } },
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test("a blocked request and an approving one are commented on too, and stay as they are", async () => {
    for (const [i, requestStatus] of (["blocked", "approving"] as const).entries()) {
      const datasetId = ds(i);
      const { requestId } = request(datasetId, { requestStatus });
      const { res, calls } = await send(datasetId, { message: "A question about the data." });
      expect(res.status).toBe(200);
      expect(asSend(calls[0]).to).toEqual([depositorEmail(datasetId)]);
      expect(h.requestRow(requestId).status).toBe(requestStatus);
    }
  });

  test("a depositor with no username is greeted without one and still mailed", async () => {
    request();
    h.db.run("UPDATE users SET username = NULL WHERE email = ?", [depositorEmail()]);
    const { res, calls } = await send(PROD_DATASET, { message: "Please add a LICENSE file." });
    expect(res.status).toBe(200);
    expect(asSend(calls[0]).to).toEqual([depositorEmail()]);
    expect(textOf(asSend(calls[0]).html)).toContain("Hello there,");
  });
});

// ============================================================================

describe("nothing of the review reaches the depositor", () => {
  test("a request with a failing review: no summary, no note, no headline, no reason sentence in the mail", async () => {
    const { requestId } = request();
    seedPublicationReview(h.db, {
      requestId,
      datasetId: PROD_DATASET,
      state: "reported",
      report: failingReport(),
    });

    // What an administrator reads about this request, from the real detail route: the words that
    // must not travel. Read first, so the test cannot pass because the review said nothing.
    const detailRes = await h.app.request(
      `/admin/publish/${PROD_DATASET}/review`,
      { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      h.env(),
    );
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as PublicationReviewDetail;
    expect(detail.review?.summary).toBe(SUMMARY_SENTINEL);
    expect(detail.reasons.length).toBeGreaterThan(0);
    const reviewWords = [
      SUMMARY_SENTINEL,
      NOTE_SENTINEL,
      detail.description.headline,
      ...detail.description.lines,
      ...detail.reasons.flatMap((r) => [r.sentence, r.cure]),
      ...(detail.review?.findings ?? []).map((f) => f.note),
      ...(detail.review?.fact_notes ?? []).map((f) => f.text),
    ].filter((w) => w.trim() !== "");
    expect(detail.description.headline.length).toBeGreaterThan(10);
    expect(reviewWords.length).toBeGreaterThan(4);

    const { res, calls } = await send(PROD_DATASET, {
      message: "Please describe the recording setup in the README.",
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const mail = asSend(calls[0]);
    const text = textOf(mail.html);
    for (const word of reviewWords) {
      expect(mail.html).not.toContain(word);
      expect(text).not.toContain(word);
    }
    // And the subject is only the fixed one.
    expect(mail.subject).toBe(`About your publication request: ${PROD_DATASET}`);
    // What does arrive: the typed words and the frame.
    expect(text).toContain("Please describe the recording setup in the README.");
    expect(text).toContain(`${FRAME_SENTENCE}.`);
  });
});

// ============================================================================

describe("who may call it, and what it refuses", () => {
  test("a bearer key needs no Origin: a terminal sends none, and a foreign one is no concern", async () => {
    request();
    const none = await send(PROD_DATASET, { message: "One." });
    expect(none.res.status).toBe(200);
    const foreign = await send(
      PROD_DATASET,
      { message: "Two." },
      { headers: { Origin: "https://evil.example" } },
    );
    expect(foreign.res.status).toBe(200);
  });

  test("a session cookie from a NEMAR page mails the depositor", async () => {
    request();
    const { res, calls } = await send(
      PROD_DATASET,
      { message: "Please add a LICENSE file." },
      { cookie: await cookieFor(adminId), headers: { Origin: APP_ORIGIN } },
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({ user_id: adminId });
  });

  test("a session cookie from a foreign origin, or with no Origin, is 403 origin_not_allowed and nothing is mailed", async () => {
    // A cookie rides along with any cross-site request a browser can be tricked into making, and
    // this route mails a real person.
    request();
    const cookie = await cookieFor(adminId);
    for (const headers of [{ Origin: "https://evil.example" }, {}]) {
      const { res, calls, json } = await send(
        PROD_DATASET,
        { message: "Please add a LICENSE file." },
        { cookie, headers },
      );
      expect(res.status).toBe(403);
      // Answered by the admin router's cookie Origin guard, which carries the code in `code` as the
      // comment's contract reads it (and in `error` as approve-dispatch's does), the sentence in
      // `message`.
      expect(json).toEqual({
        error: "origin_not_allowed",
        code: "origin_not_allowed",
        message: PUBLICATION_COMMENT_SENTENCES.origin_not_allowed,
      } satisfies OriginNotAllowedBody);
      expectNothingMailed(calls);
    }
    expect(auditRows()).toHaveLength(0);
  });

  test("a member is 403, and no credential is 401, and nothing is mailed", async () => {
    request();
    const asMember = await send(PROD_DATASET, { message: "Hello." }, { key: MEMBER_KEY });
    expect(asMember.res.status).toBe(403);
    expectNothingMailed(asMember.calls);
    const memberCookie = await send(
      PROD_DATASET,
      { message: "Hello." },
      { cookie: await cookieFor(memberId), headers: { Origin: APP_ORIGIN } },
    );
    expect(memberCookie.res.status).toBe(403);
    expectNothingMailed(memberCookie.calls);

    const anonymous = await withFakeResend(async (calls) => {
      const res = await h.app.request(
        `/admin/publish/${PROD_DATASET}/comment`,
        { method: "POST", body: JSON.stringify({ message: "Hello." }) },
        h.env(),
      );
      return { res, calls };
    });
    expect(anonymous.res.status).toBe(401);
    expectNothingMailed(anonymous.calls);
    expect(auditRows()).toHaveLength(0);
  });

  test("a malformed dataset id is 400 bad_dataset", async () => {
    const { res, calls, json } = await send("not-a-dataset", { message: "Hello." });
    expect(res.status).toBe(400);
    expect(json).toEqual({
      error: "That is not a dataset id.",
      code: "bad_dataset",
    } satisfies PublicationCommentErrorBody);
    expectNothingMailed(calls);
  });

  test("no active request is 404 not_found: none at all, or only a published or denied one", async () => {
    const none = await send(PROD_DATASET, { message: "Hello." });
    expect(none.res.status).toBe(404);
    expect((none.json as PublicationCommentErrorBody).code).toBe("not_found");
    expectNothingMailed(none.calls);

    for (const [i, requestStatus] of (["published", "denied"] as const).entries()) {
      const datasetId = ds(i);
      request(datasetId, { requestStatus });
      const { res, calls, json } = await send(datasetId, { message: "Hello." });
      expect(res.status).toBe(404);
      expect((json as PublicationCommentErrorBody).code).toBe("not_found");
      expectNothingMailed(calls);
    }
    expect(auditRows()).toHaveLength(0);
  });

  test("the body is exactly { message }, a string of 1 to 2,000 characters once trimmed", async () => {
    request();
    const sentence =
      "The body must be a JSON object with one field, message, of 1 to 2000 characters.";
    const bad: [string, { body?: unknown; raw?: string }][] = [
      ["an empty message", { body: { message: "" } }],
      ["a message of whitespace only", { body: { message: " \n\t  " } }],
      [
        `${PUBLICATION_COMMENT_MAX_LENGTH + 1} characters`,
        { body: { message: "x".repeat(PUBLICATION_COMMENT_MAX_LENGTH + 1) } },
      ],
      ["an extra key", { body: { message: "Hello.", extra: 1 } }],
      ["no message", { body: {} }],
      ["a message that is not a string", { body: { message: 42 } }],
      ["a bare string", { body: "Hello." }],
      ["an array", { body: ["Hello."] }],
      ["null", { body: null }],
      ["no JSON at all", { raw: "message=Hello." }],
      ["an empty body", { raw: "" }],
    ];
    for (const [name, o] of bad) {
      const { res, calls, json } = await send(PROD_DATASET, o.body, { raw: o.raw });
      expect([name, res.status]).toEqual([name, 400]);
      const body = json as PublicationCommentErrorBody;
      expect([name, body.code]).toEqual([name, "invalid_body"]);
      expect(body.error).toBe(sentence);
      expectNothingMailed(calls);
    }
    expect(auditRows()).toHaveLength(0);

    // The limit counts what is left after trimming: 2,000 characters among spaces is accepted.
    const edge = await send(PROD_DATASET, {
      message: `  ${"x".repeat(PUBLICATION_COMMENT_MAX_LENGTH)}  `,
    });
    expect(edge.res.status).toBe(200);
    expect(edge.calls).toHaveLength(1);
    expect(auditRows()).toHaveLength(1);
  });

  test("the error codes the route answers with are all in the contract's list", async () => {
    request();
    const answers = [
      await send("not-a-dataset", { message: "Hello." }),
      await send(ds(7), { message: "Hello." }),
      await send(PROD_DATASET, { message: "" }),
      await send(PROD_DATASET, { message: "Hello." }, { resendStatus: 422 }),
      await send(PROD_DATASET, { message: "Hello." }, { resendStatus: 503 }),
    ];
    const codes = answers.map((a) => (a.json as PublicationCommentErrorBody).code);
    expect(codes).toEqual([
      "bad_dataset",
      "not_found",
      "invalid_body",
      "comment_not_sent",
      "comment_not_confirmed",
    ]);
    for (const code of codes) {
      expect(PUBLICATION_COMMENT_ERROR_CODES as readonly string[]).toContain(code);
    }
  });

  test("every closed code has a sentence of its own, and the two failure sentences are the oracle's", () => {
    expect(Object.keys(PUBLICATION_COMMENT_SENTENCES).sort()).toEqual(
      [...PUBLICATION_COMMENT_ERROR_CODES].sort(),
    );
    expect(new Set(Object.values(PUBLICATION_COMMENT_SENTENCES)).size).toBe(
      PUBLICATION_COMMENT_ERROR_CODES.length,
    );
    expect(PUBLICATION_COMMENT_SENTENCES.comment_not_sent).toBe(NOT_SENT_SENTENCE);
    expect(PUBLICATION_COMMENT_SENTENCES.comment_not_confirmed).toBe(NOT_CONFIRMED_SENTENCE);
    // The certain one says nothing was sent; the other never does, because it may have arrived.
    expect(NOT_SENT_SENTENCE).toContain("nothing was sent");
    expect(NOT_CONFIRMED_SENTENCE).not.toMatch(/nothing was sent/i);
    expect(NOT_CONFIRMED_SENTENCE).toContain("may also have arrived");
  });
});

// ============================================================================

describe("a send that fails, and whether the mail can have arrived", () => {
  const typed = "Please add a LICENSE file.";

  /** The answer and the audit row of a failed send, with what must hold of both. */
  function expectFailure(
    r: Sent,
    want: { code: "comment_not_sent" | "comment_not_confirmed"; outcome: "not_sent" | "unknown" },
    requestId: number,
    before: Record<string, unknown>,
  ) {
    expect(r.res.status).toBe(502);
    expect(r.json).toEqual({
      error: PUBLICATION_COMMENT_SENTENCES[want.code],
      code: want.code,
    } satisfies PublicationCommentErrorBody);
    expect(h.requestRow(requestId)).toEqual(before);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: adminId, resource_id: PROD_DATASET });
    expect(JSON.parse(rows[0].details as string)).toEqual({
      request_id: requestId,
      outcome: want.outcome,
      message: typed,
    });
    // Neither what the administrator reads nor what is on record carries the depositor's address.
    expect(r.text).not.toContain(depositorEmail());
    expect(JSON.stringify(rows)).not.toContain(depositorEmail());
  }

  // Resend answered with a 4xx: it refused the message itself, whatever the 4xx.
  for (const resendStatus of [400, 401, 422, 429]) {
    test(`Resend refusing the message (${resendStatus}) certainly delivered nothing: it says so and is audited not_sent`, async () => {
      const { requestId } = request();
      const before = h.requestRow(requestId);
      const r = await send(PROD_DATASET, { message: typed }, { resendStatus });
      // The send was attempted: it is Resend that refused.
      expect(r.calls).toHaveLength(1);
      expectFailure(r, { code: "comment_not_sent", outcome: "not_sent" }, requestId, before);
    });
  }

  // Resend answered with a 5xx: the mail may have been accepted and only the answer failed.
  for (const resendStatus of [500, 502, 503, 504]) {
    test(`a Resend outage (${resendStatus}) may have delivered the mail: it says so and is audited unknown`, async () => {
      const { requestId } = request();
      const before = h.requestRow(requestId);
      const r = await send(PROD_DATASET, { message: typed }, { resendStatus });
      expect(r.calls).toHaveLength(1);
      expectFailure(r, { code: "comment_not_confirmed", outcome: "unknown" }, requestId, before);
    });
  }

  test("a host that cannot be reached may have delivered the mail: it says so and is audited unknown", async () => {
    const { requestId } = request();
    const before = h.requestRow(requestId);
    const r = await send(PROD_DATASET, { message: typed }, { resendUnreachable: true });
    // The request never reached the stand-in: the send threw before an answer came.
    expect(r.calls).toHaveLength(0);
    expectFailure(r, { code: "comment_not_confirmed", outcome: "unknown" }, requestId, before);
  });

  test("a depositor with no address on record is a certain non-delivery and nothing reaches Resend", async () => {
    const { userId, requestId } = request();
    h.db.run("UPDATE users SET email = '' WHERE id = ?", [userId]);
    const before = h.requestRow(requestId);
    const r = await send(PROD_DATASET, { message: typed });
    expectNothingMailed(r.calls);
    expectFailure(r, { code: "comment_not_sent", outcome: "not_sent" }, requestId, before);
  });

  test("a depositor whose row cannot be read is a certain non-delivery and nothing reaches Resend", async () => {
    const { requestId } = request();
    const before = h.requestRow(requestId);
    const DB = hookedD1(realD1(h.db), {
      statement: (sql) => {
        if (sql.includes("FROM users")) throw new Error("D1_ERROR: simulated fault");
      },
    });
    const r = await send(PROD_DATASET, { message: typed }, { env: { DB } });
    expectNothingMailed(r.calls);
    expectFailure(r, { code: "comment_not_sent", outcome: "not_sent" }, requestId, before);
  });

  test("an ambiguous failure never reads as 'nothing was sent', and a certain one never invites a second check", async () => {
    request();
    const certain = await send(PROD_DATASET, { message: typed }, { resendStatus: 422 });
    const ambiguous = await send(PROD_DATASET, { message: typed }, { resendStatus: 503 });
    const say = (r: Sent) => (r.json as PublicationCommentErrorBody).error;
    expect(say(certain)).toContain("nothing was sent");
    expect(say(certain)).not.toContain("may also have arrived");
    expect(say(ambiguous)).not.toMatch(/nothing was sent/i);
    expect(say(ambiguous)).toContain("Check with the depositor");
  });
});

// ============================================================================

describe("a database fault", () => {
  test("a fault reading the request is 500 internal: nothing is mailed and nothing is audited", async () => {
    request();
    const DB = hookedD1(realD1(h.db), {
      statement: (sql) => {
        if (sql.includes("FROM publication_requests")) throw new Error("D1_ERROR: simulated fault");
      },
    });
    const { res, calls, json } = await send(PROD_DATASET, { message: "Hello." }, { env: { DB } });
    expect(res.status).toBe(500);
    expect((json as PublicationCommentErrorBody).code).toBe("internal");
    expectNothingMailed(calls);
    expect(auditRows()).toHaveLength(0);
  });

  test("an audit row that cannot be written does not turn a sent message into an error", async () => {
    request();
    const DB = hookedD1(realD1(h.db), {
      statement: (sql) => {
        if (sql.includes("INSERT INTO audit_log")) throw new Error("D1_ERROR: simulated fault");
      },
    });
    const { res, calls, json } = await send(PROD_DATASET, { message: "Hello." }, { env: { DB } });
    expect(res.status).toBe(200);
    expect((json as PublicationCommentResponse).mailed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(auditRows()).toHaveLength(0);
  });
});

// ============================================================================

describe("the environment's delivery fence", () => {
  const OTHER = "someone-else@example.org";

  test("outside production a depositor off DEV_EMAIL_ALLOWLIST is 502 and nothing reaches Resend", async () => {
    const { requestId } = request();
    for (const env of [
      { ENVIRONMENT: "staging", DEV_EMAIL_ALLOWLIST: OTHER },
      { ENVIRONMENT: "development", DEV_EMAIL_ALLOWLIST: OTHER },
      // Unset means no one is allow-listed, not everyone.
      { ENVIRONMENT: "staging", DEV_EMAIL_ALLOWLIST: undefined },
      // An unrecognized environment is not production.
      { ENVIRONMENT: "nowhere", DEV_EMAIL_ALLOWLIST: OTHER },
    ] as Partial<Bindings>[]) {
      const { res, calls, json, text } = await send(PROD_DATASET, { message: "Hello." }, { env });
      expect([env.ENVIRONMENT, res.status]).toEqual([env.ENVIRONMENT, 502]);
      expect(text).not.toContain(depositorEmail());
      // The fence refuses before any request is made: a certain non-delivery.
      expect(json).toEqual({
        error: PUBLICATION_COMMENT_SENTENCES.comment_not_sent,
        code: "comment_not_sent",
      } satisfies PublicationCommentErrorBody);
      expectNothingMailed(calls);
    }
    expect(h.requestRow(requestId).status).toBe("requested");
    // Each refusal is a send failure that certainly delivered nothing, audited as one.
    const rows = auditRows();
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(JSON.parse(row.details as string).outcome).toBe("not_sent");
    }
    expect(JSON.stringify(rows)).not.toContain(depositorEmail());
  });

  test("outside production a depositor on DEV_EMAIL_ALLOWLIST is mailed: the fence refuses the others, not everyone", async () => {
    request();
    const { res, calls } = await send(
      PROD_DATASET,
      { message: "Hello." },
      { env: { ENVIRONMENT: "development", DEV_EMAIL_ALLOWLIST: `${OTHER}, ${depositorEmail()}` } },
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const mail = asSend(calls[0]);
    expect(mail.to).toEqual([depositorEmail()]);
    // The development backend marks its mail so it is never read as a production one.
    expect(mail.subject).toBe(`[DEV] About your publication request: ${PROD_DATASET}`);
  });
});
