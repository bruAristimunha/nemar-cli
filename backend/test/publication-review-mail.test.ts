/**
 * The admin mail and the publication review (ADR 0102, section 6), end to end through the real
 * mail lease, the real watchdog and the real screen callback route.
 *
 * The mail of a publication request WAITS for the identifier screen's verdict (ADR 0086), and
 * while the review is on it also waits for a review of the screened commit that is in flight and
 * not overdue. What it must never do is wait for good (the review reports, or ages past its
 * deadline), wait for the wrong request (another commit, the other kind of release, another
 * status), wait while the review is off, or carry a word the model wrote.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, review rows seeded
 * through the production parser (`helpers/publication-review.ts`), the real `/webhooks` route,
 * and Resend captured at the network boundary (`helpers/resend.ts`), so the mail checked is the
 * mail that would go. Mail goes only to the seeded admin; nothing leaves the machine.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import {
  NOT_ASSESSED_LINE,
  PLATFORM_DAILY_CAP,
  PUBLICATION_REVIEW_DEADLINE_MINUTES,
  REASONS,
  describePublicationReview,
  parsePublicationReviewReport,
} from "../../shared/publication-review";
import { datasetRoutes } from "../src/routes/datasets";
import webhooks from "../src/routes/webhooks";
import { sendPublicationRequestEmail } from "../src/services/email";
import { signIdentifierScreenCallbackToken } from "../src/services/github";
import {
  SCREEN_SWEEP_LIMIT,
  notifyAdminsOfScreen,
  screenEmailSection,
  sweepIdentifierScreens,
} from "../src/services/identifier-screen";
import {
  startPublicationReview,
  storePublicationReviewResult,
  sweepPublicationReviews,
} from "../src/services/publication-review";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, interceptingD1, realD1, yieldingD1 } from "./helpers/d1";
import { SCREENED_HEAD, cleanScreenReportBody } from "./helpers/identifier-screen";
import { logged } from "./helpers/logs";
import {
  NOTE_SENTINEL,
  SUMMARY_SENTINEL,
  type SeedReview,
  type SeedScreenedRequest,
  failingReport,
  goodPublicationReport,
  seedPublicationReview,
  seedScreenedRequest,
  textOf,
} from "./helpers/publication-review";
import { type CapturedEmail, type ResendSendBody, asSend, withFakeResend } from "./helpers/resend";

const ADMIN_EMAIL = "reviewadmin@example.org";
const SECRET = "publication-review-mail-secret";
const OTHER_HEAD = "f".repeat(40);

let db: Database;
let counter = 0;

beforeEach(() => {
  db = freshDb();
  counter = 0;
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        service_access, sandbox_completed, given_name, family_name)
     VALUES ('reviewadmin', ?, 'x', 'approved', 'admin', 1, 1, 1, 'Grace', 'Hopper')`,
    [ADMIN_EMAIL],
  );
});

function env(over: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
    PRESCREEN_CALLBACK_SECRET: SECRET,
    PUBLICATION_REVIEW_ENABLED: "1",
    ...over,
  } as Bindings;
}

/** A fresh native dataset id per request, so one test can seed several. */
function nextDataset(): string {
  counter += 1;
  return `nm0006${String(counter).padStart(2, "0")}`;
}

/** A native request whose screen reported and whose admin mail has not gone out. */
function unmailed(over: Partial<SeedScreenedRequest> = {}) {
  const datasetId = over.datasetId ?? nextDataset();
  const { requestId } = seedScreenedRequest(db, { ...over, datasetId, mailed: false });
  return { requestId, datasetId };
}

function sends(calls: CapturedEmail[]): ResendSendBody[] {
  return calls
    .filter((c) => c.path === "/emails")
    .map(asSend)
    .filter((b) => b.to.includes(ADMIN_EMAIL));
}

function mailState(requestId: number) {
  return db
    .query<{ emailed: string | null; claimed: string | null }, [number]>(
      `SELECT identifier_screen_emailed_at AS emailed, identifier_screen_mail_claimed_at AS claimed
         FROM publication_requests WHERE id = ?`,
    )
    .get(requestId) as { emailed: string | null; claimed: string | null };
}

/** A D1 whose read of the review rows fails with `error`, and nothing else does. */
function failingReviewReads(error: Error): D1Database {
  return interceptingD1(realD1(db), (sql) => {
    // The review row's read, not the lease (which only checks that one exists).
    if (/^\s*SELECT .*FROM publication_reviews/s.test(sql)) throw error;
  });
}

const RESEND_KEY = "resend-owner-key-0123456789abcdef0123456789abcdef";
const resendApp = new Hono<{ Bindings: Bindings; Variables: Variables }>();
resendApp.route("/datasets", datasetRoutes);
/** Each depositor's key, by dataset: a key's hash is unique. */
const resendKeys = new Map<string, string>();

/** A request whose screen reported, owned by a depositor who holds a key, last touched days ago. */
async function resendable(over: Partial<SeedScreenedRequest> = {}) {
  const datasetId = over.datasetId ?? nextDataset();
  const { requestId, userId } = seedScreenedRequest(db, { ...over, datasetId, mailed: false });
  const key = `${RESEND_KEY}-${datasetId}`;
  resendKeys.set(datasetId, key);
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    userId,
    await hashApiKey(key),
    key.slice(0, 8),
  );
  // Days, not hours: the route reads this text as LOCAL time, and a suite that has changed the
  // process's time zone (as a neighbouring file's does) must not turn "hours ago" into "later".
  db.run("UPDATE publication_requests SET updated_at = datetime('now', '-2 days') WHERE id = ?", [
    requestId,
  ]);
  return { requestId, datasetId };
}

const resend = (datasetId: string, bindings: Bindings = env()) =>
  resendApp.request(
    `/datasets/${datasetId}/publish/resend`,
    { method: "POST", headers: { Authorization: `Bearer ${resendKeys.get(datasetId)}` } },
    bindings,
  );

// ============================================================================

describe("the mail waits for a review that is in flight", () => {
  test("a young dispatched review of the screened commit and flag holds the mail, and takes no lease", async () => {
    const { requestId, datasetId } = unmailed();
    seedPublicationReview(db, { requestId, datasetId, state: "dispatched", createdMinutesAgo: 2 });
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(env(), requestId)).toBe("not-claimed");
      expect(calls).toHaveLength(0);
    });
    expect(mailState(requestId)).toEqual({ emailed: null, claimed: null });
  });

  test("the review reporting releases it, and the mail carries the review's headline and the next command", async () => {
    const { requestId, datasetId } = unmailed();
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(env(), requestId)).toBe("sent");
      const mail = sends(calls);
      expect(mail).toHaveLength(1);
      const text = textOf(mail[0].html);
      expect(text).toContain("Publication review: pass");
      expect(text).toContain(`nemar admin publish approve ${datasetId}`);
      expect(text).toContain(NOT_ASSESSED_LINE);
      // The identifier screen's own section is still there, before the review's.
      expect(text.indexOf("Identifier screen")).toBeLessThan(text.indexOf("Publication review"));
      // The subject is the screen's, unchanged.
      expect(mail[0].subject).toEndWith("IDENTIFIER SCREEN: clean");
    });
    expect(mailState(requestId).emailed).not.toBeNull();
  });

  const settled: Array<{
    name: string;
    seed: Omit<SeedReview, "requestId" | "datasetId">;
    headline: string;
    reasons: Array<keyof typeof REASONS>;
    words: string[];
    next: string;
  }> = [
    {
      name: "errored",
      seed: { state: "errored", detail: "workflow_failed" },
      headline: "Publication review: action required",
      reasons: ["review_could_not_run"],
      words: ["the review job failed before it finished"],
      next: "nemar admin publish start",
    },
    {
      name: "declined",
      seed: { state: "declined", detail: "depositor_limit" },
      headline: "Publication review: action required",
      reasons: ["review_limit_reached"],
      words: ["this depositor's daily limit"],
      next: "nemar admin publish start",
    },
    {
      name: "unreported",
      seed: { state: "unreported" },
      headline: "Publication review: action required",
      reasons: ["review_did_not_report"],
      words: [],
      next: "nemar admin publish start",
    },
    {
      // The mail goes once the lease frees it, at the 30-minute deadline, and says what is true
      // then: the review did not report. The lists and the detail wait for the deadline plus a
      // watchdog tick (60 minutes) before they say it, because they have no lease to explain.
      name: "dispatched past the 30-minute deadline",
      seed: { state: "dispatched", createdMinutesAgo: 31 },
      headline: "Publication review: action required",
      reasons: ["review_did_not_report"],
      words: [],
      next: "nemar admin publish start",
    },
    {
      name: "dispatched past the views' overdue bound",
      seed: { state: "dispatched", createdMinutesAgo: 61 },
      headline: "Publication review: action required",
      reasons: ["review_did_not_report"],
      words: [],
      next: "nemar admin publish start",
    },
    {
      name: "reported with a failed question",
      seed: { state: "reported", report: failingReport() },
      headline: "Publication review: FAIL",
      reasons: ["question_failed"],
      words: ["findings: README does not match the dataset"],
      next: "--force",
    },
  ];

  for (const c of settled) {
    test(`${c.name}: the mail goes once, with each reason's sentence and cure and the next command`, async () => {
      const { requestId, datasetId } = unmailed();
      seedPublicationReview(db, { requestId, datasetId, ...c.seed });
      await withFakeResend(async (calls) => {
        expect(await notifyAdminsOfScreen(env(), requestId)).toBe("sent");
        expect(await notifyAdminsOfScreen(env(), requestId)).toBe("not-claimed");
        const mail = sends(calls);
        expect(mail).toHaveLength(1);
        const text = textOf(mail[0].html);
        expect(text).toContain(c.headline);
        for (const code of c.reasons) {
          const rule = REASONS[code];
          expect(text).toContain(rule.sentence.replace(/\.$/, ""));
          expect(text).toContain(rule.cure.replaceAll("<dataset>", datasetId));
        }
        for (const w of c.words) expect(text).toContain(w);
        expect(text).toContain(c.next);
        expect(text).toContain(NOT_ASSESSED_LINE);
      });
    });
  }

  test("a review of another commit does not hold the mail, and is not the review in force", async () => {
    const { requestId, datasetId } = unmailed();
    seedPublicationReview(db, {
      requestId,
      datasetId,
      head: OTHER_HEAD,
      state: "dispatched",
      createdMinutesAgo: 2,
    });
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(env(), requestId)).toBe("sent");
      const text = textOf(sends(calls)[0].html);
      // The other commit's row is history: this commit has no review.
      expect(text).toContain(REASONS.review_not_started.sentence);
      expect(text).not.toContain(REASONS.review_running.sentence);
    });
  });

  test("a review of the other kind of release does not hold the mail", async () => {
    const { requestId, datasetId } = unmailed({ anonymous: false });
    seedPublicationReview(db, {
      requestId,
      datasetId,
      anonymous: true,
      state: "dispatched",
      createdMinutesAgo: 2,
    });
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(env(), requestId)).toBe("sent");
      expect(textOf(sends(calls)[0].html)).toContain(REASONS.review_not_started.sentence);
    });
  });

  test("a review of another request does not hold this one", async () => {
    const first = unmailed();
    const second = unmailed();
    seedPublicationReview(db, {
      requestId: second.requestId,
      datasetId: second.datasetId,
      state: "dispatched",
      createdMinutesAgo: 2,
    });
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(env(), first.requestId)).toBe("sent");
      expect(await notifyAdminsOfScreen(env(), second.requestId)).toBe("not-claimed");
      expect(sends(calls)).toHaveLength(1);
    });
  });

  test("only a request in requested waits: a blocked request is mailed at once", async () => {
    const { requestId, datasetId } = unmailed({
      requestStatus: "blocked",
      blockReason: "min_requirements_failed",
    });
    seedPublicationReview(db, { requestId, datasetId, state: "dispatched", createdMinutesAgo: 2 });
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(env(), requestId)).toBe("sent");
      const text = textOf(sends(calls)[0].html);
      // Never an in-flight wait for a request that is not reviewed: it reads as not reported.
      expect(text).toContain(REASONS.request_blocked.sentence.replace(/\.$/, ""));
      expect(text).not.toContain(REASONS.review_running.sentence);
    });
  });

  test("a screen that needs an acknowledgment is reviewed and held the same way", async () => {
    const { requestId, datasetId } = unmailed({ status: "review" });
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId,
      state: "dispatched",
      createdMinutesAgo: 2,
    });
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(env(), requestId)).toBe("not-claimed");
      expect(calls).toHaveLength(0);
      db.run("DELETE FROM publication_reviews WHERE id = ?", [reviewId]);
      seedPublicationReview(db, { requestId, datasetId, state: "reported" });
      expect(await notifyAdminsOfScreen(env(), requestId)).toBe("sent");
      // A clean review does not clear the screen's own reason: the outcome still needs a person.
      const text = textOf(sends(calls)[0].html);
      expect(text).toContain("Publication review: action required");
      expect(text).toContain(
        REASONS.identifier_screen_needs_acknowledgment.sentence.replace(/\.$/, ""),
      );
    });
  });
});

// ============================================================================

describe("with the review off, the mail is what it was before the review existed", () => {
  test("a young dispatched review does not hold the mail, and the section says the review is off", async () => {
    const { requestId, datasetId } = unmailed();
    seedPublicationReview(db, { requestId, datasetId, state: "dispatched", createdMinutesAgo: 2 });
    for (const flag of [undefined, "0", "true", "yes", " 1", "1 "]) {
      db.run(
        "UPDATE publication_requests SET identifier_screen_emailed_at = NULL, identifier_screen_mail_claimed_at = NULL WHERE id = ?",
        [requestId],
      );
      await withFakeResend(async (calls) => {
        expect(
          await notifyAdminsOfScreen(env({ PUBLICATION_REVIEW_ENABLED: flag }), requestId),
        ).toBe("sent");
        const text = textOf(sends(calls)[0].html);
        expect(text).toContain("advice only, the automated review is off");
        expect(text).toContain("this review is advice and gates nothing");
        expect(text).toContain(NOT_ASSESSED_LINE);
        // Off is never green: nothing in the section reads as a pass.
        expect(text).not.toContain("Publication review: pass");
      });
    }
  });

  // The publication-request mail as it was sent before the review section existed, for inputs
  // that are all literal here: the hash of the subject, a newline and the HTML, taken from the
  // commit before the section was added. Not a snapshot of wording: it pins that the template
  // changed by not one byte (whitespace included) when there is no review to add. A deliberate
  // edit to the mail updates these hashes in the same commit and says so.
  const MAIL_BEFORE_THE_REVIEW: Array<{
    name: string;
    opts: Parameters<typeof sendPublicationRequestEmail>[8];
    sha256: string;
  }> = [
    {
      name: "a named request with the screen's section",
      opts: {
        anonymous: false,
        screen: {
          headline: "Identifier screen: clean",
          tone: "ok",
          lines: ["a <b>", "c"],
          next: "next & step",
        },
      },
      sha256: "5d95f3c4105c5351eea61a6e1bca201fa9cca342ea79f65d75dd9679d47b80b3",
    },
    {
      name: "an anonymous release with a stopping screen",
      opts: {
        anonymous: true,
        screen: { headline: "Identifier screen: FOUND IDENTIFIERS", tone: "stop", lines: [] },
      },
      sha256: "1e491a8558d772d564d4a10d75f4ec55faff36170560048e28c0d4f0426a2a55",
    },
    {
      name: "no sections at all",
      opts: {},
      sha256: "909739632837b8af2525ab29495747d8481ab0754304dd538aaf37350e2e9b8c",
    },
  ];

  for (const c of MAIL_BEFORE_THE_REVIEW) {
    test(`the template is byte for byte what it was before the review existed: ${c.name}`, async () => {
      await withFakeResend(async (calls) => {
        await sendPublicationRequestEmail(
          [ADMIN_EMAIL],
          "nm000450",
          "ada",
          "re_test",
          "NEMAR <noreply@nemar.org>",
          undefined,
          false,
          { ENVIRONMENT: "production" },
          c.opts,
        );
        const mail = sends(calls)[0];
        const hash = createHash("sha256").update(`${mail.subject}\n${mail.html}`).digest("hex");
        expect(hash).toBe(c.sha256);
      });
    });
  }

  test("with the review off and no review row the mail carries nothing the screen's does not", async () => {
    const { requestId, datasetId } = unmailed();
    const row = db
      .query<{ s: string; r: string }, [number]>(
        "SELECT identifier_screen_status AS s, identifier_screen_report AS r FROM publication_requests WHERE id = ?",
      )
      .get(requestId) as { s: string; r: string };
    await withFakeResend(async (calls) => {
      // The same mail, built directly from the screen's section alone.
      await sendPublicationRequestEmail(
        [ADMIN_EMAIL],
        datasetId,
        `depositor_${datasetId}`,
        "re_test",
        "NEMAR <noreply@nemar.org>",
        undefined,
        false,
        { ENVIRONMENT: "production" },
        { anonymous: false, screen: screenEmailSection(datasetId, row.s, row.r) },
      );
      expect(
        await notifyAdminsOfScreen(env({ PUBLICATION_REVIEW_ENABLED: undefined }), requestId),
      ).toBe("sent");
      const [direct, viaRoute] = sends(calls);
      expect(viaRoute.html).toBe(direct.html);
      expect(viaRoute.subject).toBe(direct.subject);
      expect(viaRoute.html).not.toContain("Publication review");
    });
  });

  test("with the review off and no review row, a failed read of the review rows leaves the mail exactly as it was", async () => {
    // A deploy before migration 0098 is applied: the table is not there, and the review is off, so
    // the mail has nothing to say about it. It must not gain a "could not be read" section.
    const { requestId, datasetId } = unmailed();
    const row = db
      .query<{ s: string; r: string }, [number]>(
        "SELECT identifier_screen_status AS s, identifier_screen_report AS r FROM publication_requests WHERE id = ?",
      )
      .get(requestId) as { s: string; r: string };
    const failing = failingReviewReads(new Error("no such table: publication_reviews"));
    await withFakeResend(async (calls) => {
      await sendPublicationRequestEmail(
        [ADMIN_EMAIL],
        datasetId,
        `depositor_${datasetId}`,
        "re_test",
        "NEMAR <noreply@nemar.org>",
        undefined,
        false,
        { ENVIRONMENT: "production" },
        { anonymous: false, screen: screenEmailSection(datasetId, row.s, row.r) },
      );
      let outcome: string | undefined;
      const lines = await logged(async () => {
        outcome = await notifyAdminsOfScreen(
          env({ PUBLICATION_REVIEW_ENABLED: undefined, DB: failing }),
          requestId,
        );
      });
      expect(outcome).toBe("sent");
      const [direct, viaRoute] = sends(calls);
      expect(viaRoute.html).toBe(direct.html);
      expect(viaRoute.subject).toBe(direct.subject);
      expect(viaRoute.html).not.toContain("Publication review");
      // The failure is still logged, with its class and never its message.
      expect(lines.join("\n")).toContain("no_such_table");
    });
  });

  test("a request the review does not apply to says so only while the review is on", async () => {
    const exempt: Array<Partial<SeedScreenedRequest>> = [
      { source: "openneuro" },
      { isExemplar: 1 },
    ];
    for (const apply of exempt) {
      const on = unmailed(apply);
      const off = unmailed(apply);
      await withFakeResend(async (calls) => {
        expect(await notifyAdminsOfScreen(env(), on.requestId)).toBe("sent");
        expect(textOf(sends(calls)[0].html)).toContain("Publication review: not applicable");
        expect(textOf(sends(calls)[0].html)).toContain(NOT_ASSESSED_LINE);
      });
      await withFakeResend(async (calls) => {
        expect(
          await notifyAdminsOfScreen(env({ PUBLICATION_REVIEW_ENABLED: undefined }), off.requestId),
        ).toBe("sent");
        expect(sends(calls)[0].html).not.toContain("Publication review");
      });
    }
  });
});

// ============================================================================

describe("the watchdog's unmailed pass", () => {
  /** The watchdog only takes a result its own path has had five minutes to mail. */
  function ageScreen(requestId: number) {
    db.run(
      "UPDATE publication_requests SET identifier_screen_at = datetime('now', '-10 minutes') WHERE id = ?",
      [requestId],
    );
  }

  test("skips a row held for a review, and mails it once the review has reported", async () => {
    const { requestId, datasetId } = unmailed();
    ageScreen(requestId);
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId,
      state: "dispatched",
      createdMinutesAgo: 2,
    });
    await withFakeResend(async (calls) => {
      const held = await sweepIdentifierScreens(env());
      expect(held.emailed).toBe(0);
      expect(held.undelivered).toBe(0);
      expect(calls).toHaveLength(0);

      db.run("DELETE FROM publication_reviews WHERE id = ?", [reviewId]);
      seedPublicationReview(db, { requestId, datasetId, state: "reported" });
      const released = await sweepIdentifierScreens(env());
      expect(released.emailed).toBe(1);
      expect(textOf(sends(calls)[0].html)).toContain("Publication review: pass");

      // Mailed once: the next tick finds nothing.
      expect((await sweepIdentifierScreens(env())).emailed).toBe(0);
      expect(sends(calls)).toHaveLength(1);
    });
  });

  test("rows held for a review do not fill the tick's slots", async () => {
    // One more held row than a tick takes, all older than the one that is ready: without the
    // exclusion in the query the ready request would never be reached.
    for (let i = 0; i < SCREEN_SWEEP_LIMIT + 1; i++) {
      const held = unmailed();
      ageScreen(held.requestId);
      seedPublicationReview(db, {
        requestId: held.requestId,
        datasetId: held.datasetId,
        state: "dispatched",
        createdMinutesAgo: 2,
      });
    }
    const ready = unmailed();
    ageScreen(ready.requestId);
    await withFakeResend(async (calls) => {
      const result = await sweepIdentifierScreens(env());
      expect(result.emailed).toBe(1);
      expect(sends(calls)).toHaveLength(1);
      expect(mailState(ready.requestId).emailed).not.toBeNull();
    });
  });

  test("a review that never reports cannot hold the mail for good", async () => {
    const { requestId, datasetId } = unmailed();
    ageScreen(requestId);
    seedPublicationReview(db, { requestId, datasetId, state: "dispatched", createdMinutesAgo: 31 });
    await withFakeResend(async (calls) => {
      // No watchdog marked the row, and it is past the deadline: the mail goes.
      expect((await sweepIdentifierScreens(env())).emailed).toBe(1);
      expect(sends(calls)).toHaveLength(1);
    });
  });

  test("with the review off, a young dispatched row is mailed like any other", async () => {
    const { requestId, datasetId } = unmailed();
    ageScreen(requestId);
    seedPublicationReview(db, { requestId, datasetId, state: "dispatched", createdMinutesAgo: 2 });
    await withFakeResend(async (calls) => {
      expect(
        (await sweepIdentifierScreens(env({ PUBLICATION_REVIEW_ENABLED: undefined }))).emailed,
      ).toBe(1);
      expect(sends(calls)).toHaveLength(1);
    });
  });
});

// ============================================================================

describe("a review that never reports is mailed once, and the mail says so", () => {
  const DID_NOT_REPORT = REASONS.review_did_not_report.sentence.replace(/\.$/, "");
  const RUNNING = REASONS.review_running.sentence;

  /** An unmailed request whose screen is old enough for the watchdog and whose review is dispatched. */
  function neverReporting(minutesAgo = 40) {
    const r = unmailed();
    db.run(
      "UPDATE publication_requests SET identifier_screen_at = datetime('now', '-90 minutes') WHERE id = ?",
      [r.requestId],
    );
    seedPublicationReview(db, {
      requestId: r.requestId,
      datasetId: r.datasetId,
      state: "dispatched",
      createdMinutesAgo: minutesAgo,
    });
    return r;
  }

  const mailsOf = (calls: CapturedEmail[], datasetId: string) =>
    sends(calls).filter((m) => m.subject.includes(datasetId));

  test("at the deadline the lease frees the mail, and the mail says the review did not report", async () => {
    // The lease and the mail's section read the same window: a mail the lease lets go is never
    // told the review is running, because nothing would mail the "did not report" afterwards.
    const young = unmailed();
    seedPublicationReview(db, {
      requestId: young.requestId,
      datasetId: young.datasetId,
      state: "dispatched",
      createdMinutesAgo: 29,
    });
    const old = unmailed();
    seedPublicationReview(db, {
      requestId: old.requestId,
      datasetId: old.datasetId,
      state: "dispatched",
      createdMinutesAgo: 31,
    });
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(env(), young.requestId)).toBe("not-claimed");
      expect(await notifyAdminsOfScreen(env(), old.requestId)).toBe("sent");
      const text = textOf(mailsOf(calls, old.datasetId)[0].html);
      expect(text).toContain(DID_NOT_REPORT);
      expect(text).not.toContain(RUNNING);
      expect(sends(calls)).toHaveLength(1);
    });
  });

  test("the identifier sweep alone mails it once, as did not report, and the review sweep then adds nothing", async () => {
    const { requestId, datasetId } = neverReporting();
    await withFakeResend(async (calls) => {
      expect((await sweepIdentifierScreens(env())).emailed).toBe(1);
      const first = mailsOf(calls, datasetId);
      expect(first).toHaveLength(1);
      expect(textOf(first[0].html)).toContain(DID_NOT_REPORT);
      expect(textOf(first[0].html)).not.toContain(RUNNING);

      // The review's own watchdog finds the row afterwards: the mail has gone, so there is
      // nothing for it to send, and the row is closed as unreported.
      expect(await sweepPublicationReviews(env())).toMatchObject({ timedOut: 1, mailed: 0 });
      expect(mailsOf(calls, datasetId)).toHaveLength(1);
    });
    expect(mailState(requestId).emailed).not.toBeNull();
  });

  test("the review sweep first mails it once, as did not report, and the identifier sweep then adds nothing", async () => {
    const { datasetId } = neverReporting();
    await withFakeResend(async (calls) => {
      expect(await sweepPublicationReviews(env())).toMatchObject({ timedOut: 1, mailed: 1 });
      const first = mailsOf(calls, datasetId);
      expect(first).toHaveLength(1);
      expect(textOf(first[0].html)).toContain(DID_NOT_REPORT);
      expect((await sweepIdentifierScreens(env())).emailed).toBe(0);
      expect(mailsOf(calls, datasetId)).toHaveLength(1);
    });
  });

  test("the review sweep failing outright changes nothing: the identifier sweep mails it, as did not report", async () => {
    const { requestId, datasetId } = neverReporting();
    const broken = env({
      DB: interceptingD1(realD1(db), (sql) => {
        // The review watchdog's own query, and nothing else.
        if (/^\s*SELECT id, request_id FROM publication_reviews/.test(sql)) {
          throw new Error("D1_ERROR: simulated");
        }
      }),
    });
    await withFakeResend(async (calls) => {
      let swept: Awaited<ReturnType<typeof sweepPublicationReviews>> | undefined;
      await logged(async () => {
        swept = await sweepPublicationReviews(broken);
      });
      expect(swept).toMatchObject({ timedOut: 0, errors: 1 });
      expect((await sweepIdentifierScreens(env())).emailed).toBe(1);
      const mails = mailsOf(calls, datasetId);
      expect(mails).toHaveLength(1);
      expect(textOf(mails[0].html)).toContain(DID_NOT_REPORT);
    });
    expect(mailState(requestId).emailed).not.toBeNull();
  });

  test("both sweeps at once, over more requests than the review sweep takes in a tick: each is mailed once and none is told the review is running", async () => {
    // 25 never-reporting reviews: the review sweep takes 20 a tick and the identifier sweep 10,
    // each in the same order, so both reach the same requests at the same time, and a few
    // requests are left for the next tick.
    const requests = Array.from({ length: 25 }, () => neverReporting());
    const racing = env({ DB: yieldingD1(realD1(db)) });
    await withFakeResend(async (calls) => {
      await Promise.all([sweepIdentifierScreens(racing), sweepPublicationReviews(racing)]);
      for (const r of requests) expect(mailsOf(calls, r.datasetId).length).toBeLessThanOrEqual(1);
      // The next tick finishes the rest, and nothing is ever mailed twice.
      await Promise.all([sweepIdentifierScreens(racing), sweepPublicationReviews(racing)]);
      await Promise.all([sweepIdentifierScreens(racing), sweepPublicationReviews(racing)]);
      for (const r of requests) {
        const mails = mailsOf(calls, r.datasetId);
        expect(mails).toHaveLength(1);
        const text = textOf(mails[0].html);
        expect(text).toContain(DID_NOT_REPORT);
        expect(text).not.toContain(RUNNING);
      }
      expect(sends(calls)).toHaveLength(25);
    });
  });
});

// ============================================================================

describe("the depositor's resend carries the review's section", () => {
  test("a review in flight is in the reminder, and the review's own mail still goes when it reports", async () => {
    const { requestId, datasetId } = await resendable();
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId,
      state: "dispatched",
      createdMinutesAgo: 2,
      // The job took its claim, as every real run does before it reports.
      claimed: true,
    });
    await withFakeResend(async (calls) => {
      expect((await resend(datasetId)).status).toBe(200);
      const [reminder] = sends(calls);
      const text = textOf(reminder.html);
      expect(text).toContain("Publication review: action required");
      expect(text).toContain(REASONS.review_running.sentence);
      expect(text).toContain(NOT_ASSESSED_LINE);
      // The mail that waits for the review has NOT gone: the reminder said it is still running.
      expect(mailState(requestId).emailed).toBeNull();

      // The review reports: its result tries the mail, and it goes, carrying the verdict.
      const nonce = db
        .query<{ nonce: string }, [number]>("SELECT nonce FROM publication_reviews WHERE id = ?")
        .get(reviewId)?.nonce as string;
      const stored = await storePublicationReviewResult(env(), reviewId, datasetId, nonce, {
        kind: "reported",
        report: parsePublicationReviewReport(goodPublicationReport()),
      });
      expect(stored).toEqual({ stored: true, state: "reported" });
      const mails = sends(calls);
      expect(mails).toHaveLength(2);
      expect(textOf(mails[1].html)).toContain("Publication review: pass");
      expect(mailState(requestId).emailed).not.toBeNull();
    });
  });

  test("one instant decides both what the reminder says and whether it counts as the mail", async () => {
    // The review is a second past its deadline by the database's clock and a few seconds short of it
    // by the Worker's: the reminder, built from the Worker's clock, says it is running, so the
    // review's own mail has to still go. Deciding "counts as the mail" at a later instant than the
    // section was built at stamped the request as mailed, and the review's mail was skipped.
    const { requestId, datasetId } = await resendable();
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId,
      state: "dispatched",
      claimed: true,
    });
    const deadlineSeconds = PUBLICATION_REVIEW_DEADLINE_MINUTES * 60;
    db.run("UPDATE publication_reviews SET created_at = datetime('now', ?) WHERE id = ?", [
      `-${deadlineSeconds + 1} seconds`,
      reviewId,
    ]);
    await withFakeResend(async (calls) => {
      try {
        // The Worker's clock reads five seconds earlier than the database's.
        setSystemTime(new Date(Date.now() - 5_000));
        expect((await resend(datasetId)).status).toBe(200);
      } finally {
        setSystemTime();
      }
      const [reminder] = sends(calls);
      expect(textOf(reminder.html)).toContain(REASONS.review_running.sentence);
      // The reminder said the review is running, so it is NOT the mail that carries the verdict.
      expect(mailState(requestId).emailed).toBeNull();

      // The review reports: its result tries the mail, and it goes.
      const nonce = db
        .query<{ nonce: string }, [number]>("SELECT nonce FROM publication_reviews WHERE id = ?")
        .get(reviewId)?.nonce as string;
      expect(
        await storePublicationReviewResult(env(), reviewId, datasetId, nonce, {
          kind: "reported",
          report: parsePublicationReviewReport(goodPublicationReport()),
        }),
      ).toEqual({ stored: true, state: "reported" });
      const mails = sends(calls);
      expect(mails).toHaveLength(2);
      expect(textOf(mails[1].html)).toContain("Publication review: pass");
      expect(mailState(requestId).emailed).not.toBeNull();
    });
  });

  test("a review that has reported is in the reminder, and the reminder counts as the mail", async () => {
    const { requestId, datasetId } = await resendable();
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    await withFakeResend(async (calls) => {
      expect((await resend(datasetId)).status).toBe(200);
      const mail = sends(calls);
      expect(mail).toHaveLength(1);
      expect(textOf(mail[0].html)).toContain("Publication review: pass");
      expect(textOf(mail[0].html)).toContain(`nemar admin publish approve ${datasetId}`);
      // Nothing waits for a review any more, so the watchdog must not send it again.
      expect(mailState(requestId).emailed).not.toBeNull();
      expect(await notifyAdminsOfScreen(env(), requestId)).toBe("not-claimed");
    });
  });

  test("a review past its deadline is in the reminder as one that did not report", async () => {
    const { requestId, datasetId } = await resendable();
    seedPublicationReview(db, { requestId, datasetId, state: "dispatched", createdMinutesAgo: 31 });
    await withFakeResend(async (calls) => {
      expect((await resend(datasetId)).status).toBe(200);
      const text = textOf(sends(calls)[0].html);
      expect(text).toContain(REASONS.review_did_not_report.sentence.replace(/\.$/, ""));
      expect(text).not.toContain(REASONS.review_running.sentence);
    });
  });

  test("with the review off the reminder is what it was: no review section", async () => {
    const { requestId, datasetId } = await resendable();
    seedPublicationReview(db, { requestId, datasetId, state: "dispatched", createdMinutesAgo: 2 });
    const other = await resendable();
    await withFakeResend(async (calls) => {
      // A stored row shows as advice, as in the screen's own mail; no row, no section at all.
      expect((await resend(datasetId, env({ PUBLICATION_REVIEW_ENABLED: undefined }))).status).toBe(
        200,
      );
      expect(textOf(sends(calls)[0].html)).toContain("advice only, the automated review is off");
      expect(
        (await resend(other.datasetId, env({ PUBLICATION_REVIEW_ENABLED: undefined }))).status,
      ).toBe(200);
      expect(sends(calls)[1].html).not.toContain("Publication review");
    });
  });
});

// ============================================================================

describe("what the mail may carry", () => {
  test("never a nonce, never the model's summary, never a finding's note", async () => {
    const { requestId, datasetId } = unmailed();
    seedPublicationReview(db, { requestId, datasetId, state: "reported", report: failingReport() });
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(env(), requestId)).toBe("sent");
      const html = sends(calls)[0].html;
      expect(html).toContain("Publication review: FAIL");
      // The model's words reach a person in the detail view and nowhere else.
      expect(html).not.toContain(SUMMARY_SENTINEL);
      expect(html).not.toContain(NOTE_SENTINEL);
      expect(html).not.toContain("Reviewer&#39;s summary");
    });
  });

  test("no nonce of a row that can still be answered is ever in the mail", async () => {
    const { requestId, datasetId } = unmailed();
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId,
      state: "unreported",
      nonce: "NONCE-SENTINEL-0123456789abcdef",
    });
    expect(
      db
        .query<{ nonce: string }, [number]>("SELECT nonce FROM publication_reviews WHERE id = ?")
        .get(reviewId)?.nonce,
    ).toBe("NONCE-SENTINEL-0123456789abcdef");
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(env(), requestId)).toBe("sent");
      expect(sends(calls)[0].html).not.toContain("NONCE-SENTINEL");
    });
  });

  test("the shared description keeps the summary in a field of its own, so the mail never receives it", () => {
    // The mail is built from `description.lines`. The summary is not one of them, by construction,
    // so no filter has to recognize it and no rewording can let it through.
    const report = parsePublicationReviewReport(failingReport());
    const described = describePublicationReview({
      datasetId: "nm000601",
      applies: true,
      enabled: true,
      outcome: "fail",
      reasons: [],
      row: { kind: "reported", report, stored: "fail" },
      model: report.model,
      head: SCREENED_HEAD,
      version: "1.0.0",
      startable: true,
    });
    expect(described.summary).toBe(SUMMARY_SENTINEL);
    expect(described.lines.join("\n")).not.toContain(SUMMARY_SENTINEL);
    expect(described.lines.join("\n")).not.toContain("summary");
  });

  test("an anonymous release's notice is unchanged, and its review is the anonymous one", async () => {
    const { requestId, datasetId } = unmailed({ anonymous: true });
    seedPublicationReview(db, { requestId, datasetId, anonymous: true, state: "reported" });
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(env(), requestId)).toBe("sent");
      const text = textOf(sends(calls)[0].html);
      expect(text).toContain(
        "Anonymous release. Approving this publishes the data while withholding the depositor",
      );
      expect(text).toContain("Publication review: pass");
    });
  });

  test("a failed read is logged by the error's name and a closed class, never by its message", async () => {
    const message = "D1_ERROR: SECRET-SQL-SENTINEL near publication_reviews";
    const timeout = Object.assign(new Error(message), { name: "TimeoutError" });
    const cases: Array<[Error, string]> = [
      [new Error(`${message}: no such table: publication_reviews`), "Error, no_such_table"],
      [timeout, "TimeoutError, timeout"],
      [new Error(message), "Error, other"],
    ];
    for (const [error, words] of cases) {
      const { requestId } = unmailed();
      const failing = env({ DB: failingReviewReads(error) });
      await withFakeResend(async (calls) => {
        const lines = await logged(async () => {
          expect(await notifyAdminsOfScreen(failing, requestId)).toBe("sent");
        });
        // Still the fixed sentence for the administrator: the flag is on.
        expect(textOf(sends(calls).at(-1)?.html ?? "")).toContain(
          "Publication review: could not be read",
        );
        const log = lines.join("\n");
        expect(log).toContain(`(${words})`);
        expect(log).not.toContain("SECRET-SQL-SENTINEL");
      });
    }
  });

  test("a review that cannot be read is said so, never passed over and never a pass", async () => {
    const { requestId, datasetId } = unmailed();
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    const failing = {
      ...env(),
      DB: interceptingD1(realD1(db), (sql) => {
        // The review row's read, not the lease (which only checks that one exists).
        if (/^\s*SELECT .*FROM publication_reviews/s.test(sql))
          throw new Error("D1_ERROR: simulated");
      }),
    } as Bindings;
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(failing, requestId)).toBe("sent");
      const text = textOf(sends(calls)[0].html);
      expect(text).toContain("Publication review: could not be read");
      expect(text).toContain("This is not a pass.");
      expect(text).toContain(`nemar admin publish show ${datasetId}`);
      expect(text).toContain(NOT_ASSESSED_LINE);
      expect(text).not.toContain("Publication review: pass");
    });
  });
});

// ============================================================================

describe("through the real screen callback", () => {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/webhooks", webhooks);

  test("the result is stored and the mail waits for the review; the watchdog mails it once the review has reported", async () => {
    const datasetId = "nm000660";
    const { requestId } = seedScreenedRequest(db, { datasetId, status: "pending" });
    const reviewId = seedPublicationReview(db, {
      requestId,
      datasetId,
      state: "dispatched",
      createdMinutesAgo: 1,
    });
    // The nonce `seedScreenedRequest` stores for a pending screen.
    const token = await signIdentifierScreenCallbackToken(
      { datasetId, requestId, nonce: "n" },
      SECRET,
    );
    await withFakeResend(async (calls) => {
      const res = await app.request(
        "/webhooks/identifier-screen-result",
        {
          method: "POST",
          headers: { "X-Webhook-Token": token, "Content-Type": "application/json" },
          body: JSON.stringify({
            dataset_id: datasetId,
            request_id: requestId,
            report: cleanScreenReportBody(datasetId),
          }),
        },
        env(),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, state: "clean" });
      // Stored, and not mailed: the review of this commit is still in flight.
      expect(mailState(requestId).emailed).toBeNull();
      expect(calls).toHaveLength(0);

      db.run("DELETE FROM publication_reviews WHERE id = ?", [reviewId]);
      seedPublicationReview(db, { requestId, datasetId, state: "reported" });
      db.run(
        "UPDATE publication_requests SET identifier_screen_at = datetime('now', '-10 minutes') WHERE id = ?",
        [requestId],
      );
      expect((await sweepIdentifierScreens(env())).emailed).toBe(1);
      const mail = sends(calls);
      expect(mail).toHaveLength(1);
      expect(textOf(mail[0].html)).toContain("Publication review: pass");
    });
  });
});

// ============================================================================

describe("from a development Worker, no review mail is sent unless DEV_ADMIN_NOTIFICATIONS opts in", () => {
  // AGENTS.md: the dev Worker shares the users table with production, so a mail it sends can reach
  // a real person. Every review mail goes through `getAdminEmailsForCategory`, which is the fence;
  // this walks each new way to a mail and shows that none of them has a way around it. Each
  // trigger also has its positive control (opted in, with the admin on the allowlist, it IS sent),
  // so a silent run proves the fence and not a trigger that never fired.
  const DEV_DATASET = "nm099998"; // a standing fixture the dev Worker owns
  // The admin is on the delivery allowlist in BOTH cases, so the only thing that can stop a mail
  // here is the admin-notification fence this test is about, not the recipient fence behind it.
  const dev = (over: Partial<Bindings> = {}) =>
    env({
      ENVIRONMENT: "development",
      GITHUB_ADMIN_PAT: "ghp_dev_test",
      DEV_EMAIL_ALLOWLIST: ADMIN_EMAIL,
      ...over,
    });
  const optedIn = () => dev({ DEV_ADMIN_NOTIFICATIONS: "1" });

  const adminId = () =>
    db.query<{ id: number }, []>("SELECT id FROM users WHERE username = 'reviewadmin'").get()
      ?.id as number;

  interface Trigger {
    name: string;
    /** Whether an opted-in dev Worker sends this mail (the two watchdogs are production-only). */
    sendsWhenOptedIn: boolean;
    run: (e: Bindings) => Promise<void>;
  }

  const triggers: Trigger[] = [
    {
      name: "an administrator's start that is declined",
      sendsWhenOptedIn: true,
      async run(e) {
        const { requestId, datasetId } = unmailed({ datasetId: DEV_DATASET });
        // The platform's allowance is spent by other depositors' reviews in the last day.
        for (let i = 0; i < PLATFORM_DAILY_CAP; i++) {
          const other = unmailed();
          seedPublicationReview(db, {
            requestId: other.requestId,
            datasetId: other.datasetId,
            state: "reported",
            claimed: true,
          });
        }
        const out = await startPublicationReview(e, {
          requestId,
          datasetId,
          adminUserId: adminId(),
        });
        // The trigger fired: the start reached the allowance and recorded a decline.
        expect(out).toMatchObject({ started: false, reason: "platform_limit" });
      },
    },
    {
      name: "a review's result being stored",
      sendsWhenOptedIn: true,
      async run(e) {
        const { requestId, datasetId } = unmailed({ datasetId: DEV_DATASET });
        const reviewId = seedPublicationReview(db, {
          requestId,
          datasetId,
          state: "dispatched",
          createdMinutesAgo: 2,
          claimed: true,
        });
        const nonce = db
          .query<{ nonce: string }, [number]>("SELECT nonce FROM publication_reviews WHERE id = ?")
          .get(reviewId)?.nonce as string;
        const stored = await storePublicationReviewResult(e, reviewId, datasetId, nonce, {
          kind: "reported",
          report: parsePublicationReviewReport(goodPublicationReport()),
        });
        expect(stored).toEqual({ stored: true, state: "reported" });
      },
    },
    {
      name: "the review watchdog",
      // Production only, whatever the opt-in says: the dev Worker never ages or mails a row.
      sendsWhenOptedIn: false,
      async run(e) {
        const { requestId, datasetId } = unmailed({ datasetId: DEV_DATASET });
        seedPublicationReview(db, {
          requestId,
          datasetId,
          state: "dispatched",
          createdMinutesAgo: 90,
        });
        expect(await sweepPublicationReviews(e)).toMatchObject({ skipped: true, mailed: 0 });
      },
    },
    {
      name: "the identifier watchdog's unmailed pass, which now waits for a review",
      // Production only too: the identifier sweep is skipped on any other Worker.
      sendsWhenOptedIn: false,
      async run(e) {
        const { requestId, datasetId } = unmailed({ datasetId: DEV_DATASET });
        db.run(
          "UPDATE publication_requests SET identifier_screen_at = datetime('now', '-10 minutes') WHERE id = ?",
          [requestId],
        );
        seedPublicationReview(db, { requestId, datasetId, state: "reported" });
        expect(await sweepIdentifierScreens(e)).toMatchObject({ skipped: true, emailed: 0 });
      },
    },
    {
      name: "the depositor's resend",
      sendsWhenOptedIn: true,
      async run(e) {
        const { datasetId } = await resendable({ datasetId: DEV_DATASET });
        expect((await resend(datasetId, e)).status).toBe(200);
      },
    },
  ];

  for (const trigger of triggers) {
    test(`${trigger.name}: sends nothing without the opt-in`, async () => {
      await withFakeResend(async (calls) => {
        let lines: string[] = [];
        lines = await logged(async () => {
          await trigger.run(dev());
        });
        expect(calls).toHaveLength(0);
        // The fence says so where it fires; the review watchdog never reaches it.
        if (trigger.sendsWhenOptedIn) expect(lines.join("\n")).toContain("suppressed");
      });
    });

    test(`${trigger.name}: ${trigger.sendsWhenOptedIn ? "is sent once the Worker opts in" : "still sends nothing when the Worker opts in"}`, async () => {
      await withFakeResend(async (calls) => {
        await trigger.run(optedIn());
        expect(sends(calls)).toHaveLength(trigger.sendsWhenOptedIn ? 1 : 0);
      });
    });
  }

  test("a production Worker sends the same mail with no opt-in at all", async () => {
    // The fence turns on the environment alone: this is the contrast the cases above rest on.
    const { requestId, datasetId } = unmailed();
    seedPublicationReview(db, { requestId, datasetId, state: "reported" });
    await withFakeResend(async (calls) => {
      expect(await notifyAdminsOfScreen(env(), requestId)).toBe("sent");
      expect(sends(calls)).toHaveLength(1);
    });
  });
});
