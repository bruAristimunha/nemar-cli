/**
 * `nemar admin publish next` (ADR 0102, section 8): the walk through the publication requests
 * that need an administrator, one card each, with the answers piped in as a script would.
 *
 * The real command (`bun run src/index.ts ...`) against the real backend app, over a real D1
 * (`helpers/admin-publish-cli.ts`). The answers are the command's standard input, so each one lines
 * up with the question it was written for; what the command printed, what it posted and what the
 * backend recorded are read from where they really are. GitHub and Resend are the only stand-ins,
 * and no NEMAR answer is canned, so a refusal in these tests is one the Worker or the command made.
 *
 * What a person at a terminal has that a pipe does not is type-ahead: a line pressed while the
 * program was busy answers a screen that has not been drawn. The last group runs the command on a
 * pseudo-terminal, so that rule is held to the real thing and not to a reader fed by a stream.
 *
 * Mutation checks (each turns a named test red): offer `y` for a hard reason; offer `y` without
 * `--force` for a review that is not a pass; make the extra question default to yes; build the
 * override from a second read; list a blocked, an in-flight or a running-only request, or ignore
 * oldest first; deny with an empty reason; let `c` change the request; forget what was handled
 * (a skipped card comes back); exit 0 after a failed approval; keep the type-ahead before a card or
 * before the extra question; skip the extra question; never ask for the screen's acknowledgment;
 * resume every request; leave the terminal paused after an approval's spinner, or wake it after
 * the input has ended; never clear the reported mark (a refusal, then a fault that may be a bug, exits
 * with the hint suppressed); let a later answer set the mark again (a fault that may be a bug, then
 * a refusal, exits with the hint suppressed); list a request whose identifier screen is still running with the review
 * off; draw a card after the input has ended; let `d` throw on a detail it cannot render; skip the
 * `finally` of the walk; drop the SIGINT listener of an approval (Ctrl+C then kills the walk silently).
 *
 * CI TIER: unit-pure. Hermetic: an in-process backend over a local database, the CLI spawned
 * against it, stand-ins only at GitHub and Resend, no live network; it sets its own default
 * timeout.
 */

import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PUBLICATION_COMMENT_SENTENCES } from "../backend/src/routes/admin/publish-comment";
import {
  DONE,
  NOTE_SENTINEL,
  SUMMARY_SENTINEL,
  type SeedScreenedRequest,
  failingReport,
  goodPublicationReport,
  seedPublicationReview,
  seedScreenedRequest,
  setOverride,
  textOf,
} from "../backend/test/helpers/publication-review";
import { asSend } from "../backend/test/helpers/resend";
import {
  NOT_ASSESSED_LINE,
  PUBLICATION_FINDING_LABEL,
  REASONS,
  REVIEW_GATE_REFUSAL_TEXT,
  cureOf,
} from "../shared/publication-review";
import { type CliResult, startPublishCli } from "./helpers/admin-publish-cli";
import { hardReport, twoReasons, withheldReport } from "./helpers/approve-seeds";

setDefaultTimeout(60_000);

const ADMIN_KEY = "next-admin-key-0123456789abcdef0123456789abcdef";
const OTHER_ADMIN_KEY = "next-other-key-0123456789abcdef0123456789abcdef";

const h = startPublishCli();
afterAll(() => h.stop());

let adminId: number;

beforeEach(async () => {
  h.reset();
  adminId = await h.admin("nextadmin", ADMIN_KEY);
  h.setEnv({ PUBLICATION_REVIEW_ENABLED: "1" });
});

const NEXT = ["admin", "publish", "next"];
/** The prompt of a card that offers every answer but `y`. */
const PROMPT = "n deny, c comment, d details, s skip, q quit >";
const WHY_ACK = "Read the recording formats by hand, nothing to remove";

/** Run the walk with `input` piped in, one answer per line. */
const next = (input: string, flags: string[] = [], opts: Parameters<typeof h.cli>[1] = {}) =>
  h.cli([...NEXT, ...flags], { ...opts, input });

/** Everything the command printed. The approval's spinner writes its verdict to standard error. */
const output = (r: CliResult) => `${r.stdout}\n${r.stderr}`;

const count = (text: string, part: string) => text.split(part).length - 1;
const promptsIn = (r: CliResult) => count(r.stdout, PROMPT);

const approvePath = (id: string) => `/admin/publish/${id}/approve`;
const approveBodies = (id: string) =>
  h.posted.filter((p) => p.path === approvePath(id)).map((p) => p.body);
const posted = (suffix: string) => h.posted.filter((p) => p.path.endsWith(suffix));

const requestRow = (id: number) =>
  h.db
    .query<{ status: string; approved_by: number | null; denied_reason: string | null }, [number]>(
      "SELECT status, approved_by, denied_reason FROM publication_requests WHERE id = ?",
    )
    .get(id);

/**
 * A request waiting for its decision with every step but the two no-ops done (a run the gates let
 * through reaches `published`), and its review: reported with `report`, or none at all when `null`.
 * The seeds in `helpers/approve-seeds.ts` fix one dataset id; a walk needs several.
 */
function seed(
  datasetId: string,
  report: Record<string, unknown> | null = goodPublicationReport(),
  over: Partial<SeedScreenedRequest> = {},
) {
  const { requestId } = seedScreenedRequest(h.db, { datasetId, ...over });
  h.db.run("UPDATE publication_requests SET steps_completed = ? WHERE id = ?", [
    JSON.stringify(DONE),
    requestId,
  ]);
  const reviewId =
    report === null
      ? null
      : seedPublicationReview(h.db, { requestId, datasetId, state: "reported", report });
  return { requestId, reviewId };
}

const requestedAt = (datasetId: string, stamp: string) =>
  h.db.run("UPDATE publication_requests SET requested_at = ? WHERE dataset_id = ?", [
    stamp,
    datasetId,
  ]);

const A = "nm000460";
const B = "nm000461";
const C = "nm000462";

// ---------------------------------------------------------------------------------------------
// 1. y on a pass
// ---------------------------------------------------------------------------------------------

describe("y approves from the terminal", () => {
  test("y on a pass publishes it and the walk goes on to the next card, where q stops it", async () => {
    const a = seed(A);
    const b = seed(B, twoReasons());
    requestedAt(A, "2026-10-10 09:00:00");
    requestedAt(B, "2026-10-11 09:00:00");

    const r = await next("y\nq\n");

    expect(r.exitCode).toBe(0);
    expect(requestRow(a.requestId)?.status).toBe("published");
    expect(requestRow(b.requestId)?.status).toBe("requested");
    expect(approveBodies(A)).toHaveLength(1);
    expect(approveBodies(A)[0]).not.toHaveProperty("override_publication_review");
    expect(approveBodies(B)).toEqual([]);
    expect(r.stdout).toContain(`[1 of 2] ${A}`);
    expect(r.stdout).toContain(`[2 of 2] ${B}`);
    expect(r.stdout).toContain("Done: 1 approved.");
    // The first card offers y, the second (not a pass, no --force) does not.
    expect(count(r.stdout, "y approve, ")).toBe(1);
  });

  test("when the input ends during the approval, no second card is drawn and no review is read for it", async () => {
    // `y` is the last line of the script: the pipe has ended by the time the approval returns, so a
    // card for the next request could not be answered. It used to be drawn (and its review read)
    // only for the walk to say that the input had ended.
    seed(A);
    seed(B);
    requestedAt(A, "2026-10-10 09:00:00");
    requestedAt(B, "2026-10-11 09:00:00");

    const r = await next("y\n");

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`[1 of 2] ${A}`);
    expect(r.stdout).not.toContain(`[2 of 2] ${B}`);
    expect(r.stdout).not.toContain(B);
    expect(h.requests.filter((c) => c.path === `/admin/publish/${B}/review`)).toEqual([]);
    expect(count(r.stdout, "Input ended; stopping.")).toBe(1);
    expect(count(r.stdout, "See what needs you with: nemar admin publish list --needs-me")).toBe(1);
    expect(r.stdout).toContain("Done: 1 approved.");
  });

  test("the run ends with the tally when the last request is decided, and says nothing is left", async () => {
    seed(A);

    const r = await next("y\n");

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Done: 1 approved.");
    expect(r.stdout).toContain("Nothing left that needs you.");
  });

  test("a stopped run continues: an approving request is resumed, and is not gated again", async () => {
    const { requestId } = seed(A, failingReport(), { requestStatus: "approving" });
    h.db.run(
      "UPDATE publication_requests SET updated_at = datetime('now', '-3 hours') WHERE id = ?",
      [requestId],
    );

    const r = await next("y\n");

    expect(r.exitCode).toBe(0);
    expect(approveBodies(A)).toHaveLength(1);
    expect(approveBodies(A)[0]?.resume).toBe(true);
    expect(approveBodies(A)[0]).not.toHaveProperty("override_publication_review");
    expect(requestRow(requestId)?.status).toBe("published");
  });

  test("a request with no step done starts from the first: resume is false, and a step the Worker stops at is a failure", async () => {
    const { requestId } = seed(A);
    h.db.run("UPDATE publication_requests SET steps_completed = '[]' WHERE id = ?", [requestId]);
    // The BIDS validation the first step reads did not pass: a 422 the walk does not retry.
    h.bidsConclusion.value = "failure";

    const r = await next("y\n");

    expect(approveBodies(A)[0]?.resume).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("Fix the CI issues and retry with --resume");
    expect(r.stdout).toContain("Done: 1 failed.");
    expect(requestRow(requestId)?.status).toBe("approving");
  });

  test("with the review switched off nothing is gated: y is offered and approves", async () => {
    h.setEnv({ PUBLICATION_REVIEW_ENABLED: "0" });
    const { requestId } = seed(A, failingReport());

    const r = await next("y\n");

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("y approve, ");
    expect(requestRow(requestId)?.status).toBe("published");
  });
});

// ---------------------------------------------------------------------------------------------
// 2-4. a review that is not a pass
// ---------------------------------------------------------------------------------------------

describe("a review that is not a pass needs --force", () => {
  test("without --force the prompt has no y; typing y says why and asks again; nothing is posted", async () => {
    const { requestId } = seed(A, twoReasons());

    const r = await next("y\nq\n");

    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("y approve, ");
    expect(r.stdout).toContain("y is not offered:");
    expect(r.stdout).toContain("Not approved: this review is not a pass.");
    expect(r.stdout).toContain("nemar admin publish next --force");
    expect(r.stdout).toContain(`nemar admin publish approve ${A} --resume --force`);
    expect(promptsIn(r)).toBe(2);
    expect(h.posted).toEqual([]);
    expect(requestRow(requestId)?.status).toBe("requested");
  });

  test("the card names every reason with the Worker's sentence, and none of what the model wrote", async () => {
    seed(A, twoReasons());

    const r = await next("q\n");

    expect(r.stdout).toContain(REASONS.question_failed.sentence.replace(/\.$/, ""));
    expect(r.stdout).toContain(REASONS.version_missing.sentence);
    expect(r.stdout).not.toContain(SUMMARY_SENTINEL);
    expect(r.stdout).not.toContain(NOTE_SENTINEL);
  });

  test("a reason with closed words reads on the card as the Worker's line, in words for a person", async () => {
    seed(A, withheldReport());

    const r = await next("q\n");

    expect(r.stdout).toContain("(README, participants.json)");
    expect(r.stdout).not.toContain("(readme, participants_json)");
    expect(r.stdout).not.toContain("participants_json");
  });

  test("with --force y is offered, and the card says it will ask about each reason", async () => {
    seed(A, twoReasons());

    const r = await next("q\n", ["--force"]);

    expect(r.stdout).toContain("y approve, ");
    expect(r.stdout).toContain("--force: y will ask you to confirm each reason");
    expect(r.stdout).not.toContain("y is not offered");
  });

  test("with --force, y asks once more, naming the reasons, and n sends nothing", async () => {
    const { requestId } = seed(A, twoReasons());

    const r = await next("y\nn\nq\n", ["--force"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "Approve over question_failed, version_missing? This records the override with your account. [y/N] ",
    );
    // The reasons are shown again with what clears them, so the question is answered knowing them.
    expect(r.stdout).toContain(cureOf("question_failed", A, true));
    expect(r.stdout).toContain("Cancelled. Nothing was sent.");
    expect(h.posted).toEqual([]);
    expect(requestRow(requestId)?.status).toBe("requested");
  });

  test("an empty answer to the extra question is no", async () => {
    const { requestId } = seed(A, twoReasons());

    const r = await next("y\n\nq\n", ["--force"]);

    expect(r.exitCode).toBe(0);
    expect(h.posted).toEqual([]);
    expect(requestRow(requestId)?.status).toBe("requested");
  });

  test("only y or yes is yes: anything else is no", async () => {
    const { requestId } = seed(A, twoReasons());

    const r = await next("y\nsure\ny\nok\ny\nyep\nq\n", ["--force"]);

    expect(r.exitCode).toBe(0);
    expect(count(r.stdout, "This records the override with your account. [y/N] ")).toBe(3);
    expect(h.posted).toEqual([]);
    expect(requestRow(requestId)?.status).toBe("requested");
  });

  test("y, then y: the approval carries the override of the review shown and the reasons shown", async () => {
    const { requestId, reviewId } = seed(A, twoReasons());

    const r = await next("y\ny\n", ["--force"]);

    expect(r.exitCode).toBe(0);
    expect(approveBodies(A)).toHaveLength(1);
    expect(approveBodies(A)[0]?.override_publication_review).toEqual({
      review_id: reviewId,
      reasons: ["question_failed", "version_missing"],
    });
    expect(requestRow(requestId)?.status).toBe("published");
    expect(requestRow(requestId)?.approved_by).toBe(adminId);
    const row = h.db
      .query<{ override_by: number | null; override_reasons: string | null }, [number | null]>(
        "SELECT override_by, override_reasons FROM publication_reviews WHERE id = ?",
      )
      .get(reviewId);
    expect(row?.override_by).toBe(adminId);
    expect(JSON.parse(row?.override_reasons ?? "[]")).toEqual([
      "question_failed",
      "version_missing",
    ]);
  });

  test("yes works as y, and a pass under --force asks nothing more", async () => {
    seed(A, twoReasons());
    seed(B);
    requestedAt(A, "2026-10-10 09:00:00");
    requestedAt(B, "2026-10-11 09:00:00");

    const r = await next("yes\nYES\ny\n", ["--force"]);

    expect(r.exitCode).toBe(0);
    expect(approveBodies(A)).toHaveLength(1);
    expect(approveBodies(B)).toHaveLength(1);
    expect(approveBodies(B)[0]).not.toHaveProperty("override_publication_review");
    // Only the card with reasons asked.
    expect(count(r.stdout, "[y/N] ")).toBe(1);
  });

  test("a request that had no review at all is a reason too: --force names it, with no review id", async () => {
    seed(A, null);

    const refused = await next("y\nq\n");
    expect(refused.stdout).toContain("y is not offered:");
    expect(h.posted).toEqual([]);

    const r = await next("y\ny\n", ["--force"]);
    expect(r.exitCode).toBe(0);
    expect(approveBodies(A)[0]?.override_publication_review).toEqual({
      review_id: null,
      reasons: ["review_not_started"],
    });
  });
});

describe("a reason nothing clears is never offered", () => {
  test("a hard reason with --force: y is not offered, typing it is refused with the cure, nothing is posted", async () => {
    const { requestId } = seed(A, hardReport());

    const r = await next("y\nq\n", ["--force"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("y approve, ");
    expect(r.stdout).toContain("y is not offered:");
    expect(r.stdout).toContain("Not approved:");
    expect(r.stdout).toContain(cureOf("submission_minimum_failed", A, true));
    expect(h.posted).toEqual([]);
    expect(requestRow(requestId)?.status).toBe("requested");
  });
});

// ---------------------------------------------------------------------------------------------
// 5. the screen's acknowledgment
// ---------------------------------------------------------------------------------------------

describe("the screen's acknowledgment is asked for, not assumed", () => {
  test("y asks for the reason; one that is too short is refused here and asked again", async () => {
    const { requestId } = seed(A, goodPublicationReport(), { status: "unchecked" });

    const r = await next(`y\nshort\n${WHY_ACK}\n`);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "y will ask for your reason for approving over the identifier screen.",
    );
    expect(
      count(
        r.stdout,
        "Reason for approving over the identifier screen (10 to 500 characters; empty cancels): ",
      ),
    ).toBe(2);
    expect(r.stdout).toContain("A reason is 10 to 500 characters; this one is 5.");
    expect(approveBodies(A)).toHaveLength(1);
    expect(approveBodies(A)[0]?.acknowledge_identifier_screen).toBe(WHY_ACK);
    expect(approveBodies(A)[0]).not.toHaveProperty("override_publication_review");
    expect(requestRow(requestId)?.status).toBe("published");
  });

  test("an empty reason cancels, and nothing is posted", async () => {
    const { requestId } = seed(A, goodPublicationReport(), { status: "unchecked" });

    const r = await next("y\n\nq\n");

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Cancelled. Nothing was sent.");
    expect(h.posted).toEqual([]);
    expect(requestRow(requestId)?.status).toBe("requested");
  });

  test("a reason of more than 500 characters is refused here", async () => {
    seed(A, goodPublicationReport(), { status: "unchecked" });

    const r = await next(`y\n${"x".repeat(501)}\nq\n`);

    expect(r.stdout).toContain("A reason is 10 to 500 characters; this one is 501.");
    expect(h.posted).toEqual([]);
  });

  test("next to a review that is not a pass it needs --force too, and with it asks both questions", async () => {
    const { reviewId } = seed(A, twoReasons(), { status: "unchecked" });

    const without = await next("y\nq\n");
    expect(without.stdout).toContain("y is not offered:");
    expect(h.posted).toEqual([]);

    const r = await next(`y\n${WHY_ACK}\ny\n`, ["--force"]);

    expect(r.exitCode).toBe(0);
    expect(approveBodies(A)[0]?.acknowledge_identifier_screen).toBe(WHY_ACK);
    expect(approveBodies(A)[0]?.override_publication_review).toEqual({
      review_id: reviewId,
      reasons: ["question_failed", "version_missing"],
    });
  });
});

// ---------------------------------------------------------------------------------------------
// 6. n
// ---------------------------------------------------------------------------------------------

describe("n denies, with a reason the depositor is mailed", () => {
  test("a typed reason is posted as typed, denies the request and is mailed to the depositor", async () => {
    const { requestId } = seed(A);

    const r = await next("n\n  Please add a CHANGES entry.  \n");

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`Denied ${A}; the depositor is mailed the reason.`);
    expect(r.stdout).toContain("Done: 1 denied.");
    expect(posted("/deny")).toHaveLength(1);
    expect(posted("/deny")[0]?.body).toEqual({ reason: "Please add a CHANGES entry." });
    expect(requestRow(requestId)?.status).toBe("denied");
    expect(requestRow(requestId)?.denied_reason).toBe("Please add a CHANGES entry.");
    const sends = h.mail.filter((m) => m.path === "/emails").map((m) => asSend(m));
    expect(sends).toHaveLength(1);
    expect(sends[0]?.to).toEqual([`depositor_${A}@example.org`]);
    expect(textOf(sends[0]?.html ?? "")).toContain("Please add a CHANGES entry.");
  });

  test("an empty or blank reason cancels and asks again; nothing is posted", async () => {
    const { requestId } = seed(A);

    const r = await next("n\n\nn\n    \nq\n");

    expect(r.exitCode).toBe(0);
    expect(
      count(r.stdout, "Reason for the denial, mailed to the depositor (empty cancels): "),
    ).toBe(2);
    expect(count(r.stdout, "Cancelled. Nothing was sent.")).toBe(2);
    expect(promptsIn(r)).toBe(3);
    expect(h.posted).toEqual([]);
    expect(h.mail).toEqual([]);
    expect(requestRow(requestId)?.status).toBe("requested");
  });

  test("a reason too long for the Worker is refused here, and nothing is posted", async () => {
    seed(A);

    const r = await next(`n\n${"x".repeat(2001)}\nq\n`);

    expect(r.stdout).toContain("at most 2000 characters; this one is 2001");
    expect(h.posted).toEqual([]);
  });

  test("a denial the Worker refuses is a failure: its sentence is printed and the exit code is 1", async () => {
    const { requestId } = seed(A);
    // The request is published between the card and the answer.
    h.after(`GET /admin/publish/${A}/review`, () => {
      h.db.run("UPDATE publication_requests SET status = 'published' WHERE id = ?", [requestId]);
    });

    const r = await next("n\nNot ready.\n");

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("No active publication request found");
    expect(r.stdout).toContain("Done: 1 failed.");
  });
});

// ---------------------------------------------------------------------------------------------
// 7. c
// ---------------------------------------------------------------------------------------------

describe("c mails the depositor a message and leaves the request open", () => {
  test("the typed message is mailed; the request stays requested and no decision is recorded", async () => {
    const { requestId } = seed(A);

    const r = await next("c\nCould you say which task the new subjects ran?\nq\n");

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      `Mailed the message to the depositor of ${A}; the request stays open.`,
    );
    expect(r.stdout).toContain("Done: 1 commented.");
    expect(h.posted.map((p) => p.path)).toEqual([`/admin/publish/${A}/comment`]);
    expect(h.posted[0]?.body).toEqual({
      message: "Could you say which task the new subjects ran?",
    });
    expect(requestRow(requestId)).toEqual({
      status: "requested",
      approved_by: null,
      denied_reason: null,
    });
    const sends = h.mail.filter((m) => m.path === "/emails").map((m) => asSend(m));
    expect(sends).toHaveLength(1);
    expect(sends[0]?.to).toEqual([`depositor_${A}@example.org`]);
    expect(textOf(sends[0]?.html ?? "")).toContain(
      "Could you say which task the new subjects ran?",
    );
    // Nothing of the review travels with it.
    expect(textOf(sends[0]?.html ?? "")).not.toContain(SUMMARY_SENTINEL);
  });

  test("a commented request is handled for the run: it is not shown again", async () => {
    seed(A);

    const r = await next("c\nA question for you.\n");

    expect(r.exitCode).toBe(0);
    expect(count(r.stdout, `[1 of 1] ${A}`)).toBe(1);
    expect(r.stdout).toContain("Nothing left that needs you.");
  });

  test("an empty message cancels and asks again", async () => {
    seed(A);

    const r = await next("c\n\nq\n");

    expect(r.stdout).toContain("Cancelled. Nothing was sent.");
    expect(promptsIn(r)).toBe(2);
    expect(h.posted).toEqual([]);
  });

  test("a message the provider answered with a server error is a failure: the Worker's own sentence, no claim that nothing was sent, exit 1", async () => {
    const { requestId } = seed(A);

    // A 5xx can leave the mail accepted, so the Worker says it may or may not have gone.
    const r = await next("c\nCould you check the README?\n", [], { resend: { status: 503 } });

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain(PUBLICATION_COMMENT_SENTENCES.comment_not_confirmed);
    expect(output(r)).not.toMatch(/nothing was sent/i);
    expect(r.stdout).toContain("Done: 1 failed.");
    // The Worker did try, and the request is as it was.
    expect(h.mail.filter((m) => m.path === "/emails")).toHaveLength(1);
    expect(requestRow(requestId)?.status).toBe("requested");
    // A refusal the Worker made is the command's answer, not a crash to report.
    expect(output(r)).not.toContain("attach the log to a new issue");
  });

  test("a message the provider refused is a failure that says nothing was sent, exit 1", async () => {
    const { requestId } = seed(A);

    // A 4xx is a refusal before any delivery, so the Worker can say so.
    const r = await next("c\nCould you check the README?\n", [], { resend: { status: 422 } });

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain(PUBLICATION_COMMENT_SENTENCES.comment_not_sent);
    expect(r.stdout).toContain("Done: 1 failed.");
    expect(requestRow(requestId)?.status).toBe("requested");
    expect(output(r)).not.toContain("attach the log to a new issue");
  });

  test("a message too long for the Worker is refused here, and nothing is posted", async () => {
    seed(A);

    const r = await next(`c\n${"x".repeat(2001)}\nq\n`);

    expect(r.stdout).toContain("at most 2000 characters; this one is 2001");
    expect(h.posted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 8. d
// ---------------------------------------------------------------------------------------------

describe("d shows the whole review, then asks again", () => {
  test("with the model's words under their labels and the standing line; the card itself has none of them", async () => {
    seed(A, failingReport());

    const r = await next("d\nq\n");

    expect(r.exitCode).toBe(0);
    const [card] = r.stdout.split(PROMPT);
    expect(card).not.toContain(SUMMARY_SENTINEL);
    expect(card).not.toContain(NOTE_SENTINEL);
    const afterD = r.stdout.slice(r.stdout.indexOf("> d"));
    expect(afterD).toContain("written by the model; the depositor's text can steer it");
    expect(afterD).toContain("written by the model; the depositor's text can steer them");
    expect(afterD).toContain(SUMMARY_SENTINEL);
    expect(afterD).toContain(NOTE_SENTINEL);
    expect(afterD).toContain(PUBLICATION_FINDING_LABEL.readme_mismatch);
    expect(afterD).toContain(NOT_ASSESSED_LINE);
    // Asked again, on the same card.
    expect(promptsIn(r)).toBe(2);
    expect(count(r.stdout, `[1 of 1] ${A}`)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// 9. the queue
// ---------------------------------------------------------------------------------------------

describe("which requests are shown, and in what order", () => {
  test("oldest first; a blocked, an in-flight and a running-only request are not shown", async () => {
    seed(A);
    seed(B);
    seed(C);
    requestedAt(A, "2026-10-12 09:00:00");
    requestedAt(B, "2026-10-10 09:00:00");
    requestedAt(C, "2026-10-11 09:00:00");
    // Blocked: the depositor acts.
    seed("nm000463", null, { requestStatus: "blocked", blockReason: "min_requirements_failed" });
    // An approval running right now: an approving request touched a moment ago holds its lease.
    seed("nm000464", null, { requestStatus: "approving" });
    // A review that is running: only waiting.
    const running = seed("nm000465", null);
    seedPublicationReview(h.db, {
      requestId: running.requestId,
      datasetId: "nm000465",
      state: "dispatched",
      createdMinutesAgo: 1,
    });
    // The identifier screen is still running: only waiting.
    seed("nm000466", null, { status: "pending" });

    const r = await next("s\ns\ns\n");

    expect(r.exitCode).toBe(0);
    const order = [...r.stdout.matchAll(/\[(\d) of (\d)\] (nm\d{6})/g)].map((m) =>
      m.slice(1, 4).join(" "),
    );
    expect(order).toEqual([`1 3 ${B}`, `2 3 ${C}`, `3 3 ${A}`]);
    for (const hidden of ["nm000463", "nm000464", "nm000465", "nm000466"]) {
      expect(r.stdout).not.toContain(hidden);
    }
    expect(r.stdout).toContain("Done: 3 skipped.");
  });

  test("with the review off, a request whose identifier screen is still running is not shown either", async () => {
    // Nothing reports a wait when the review is off (production today), so the screen's own state
    // is the only word: a card for it would offer y, and y would fail on "Identifier screen: running".
    h.setEnv({ PUBLICATION_REVIEW_ENABLED: "0" });
    seed(A, null, { status: "pending" });
    seed(B, null);

    const r = await next("q\n");

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`[1 of 1] ${B}`);
    expect(r.stdout).not.toContain(A);
  });

  test("a skipped request is not shown again in the same run, and the run says it still needs the administrator", async () => {
    seed(A);

    const r = await next("s\nq\n");

    expect(r.exitCode).toBe(0);
    expect(count(r.stdout, `[1 of 1] ${A}`)).toBe(1);
    expect(r.stdout).toContain("Done: 1 skipped.");
    expect(r.stdout).toContain("No more requests to show, but 1 still needs you");
    expect(r.stdout).not.toContain("Nothing left that needs you.");
    expect(h.posted).toEqual([]);
  });

  test("the list is read again after each card: a request that arrives during the walk is shown", async () => {
    seed(A);
    h.after(`GET /admin/publish/${A}/review`, () => {
      seed(B);
      requestedAt(B, "2026-10-14 09:00:00");
    });

    const r = await next("s\ns\n");

    expect(count(r.stdout, `[1 of 1] ${A}`)).toBe(1);
    expect(r.stdout).toContain(`[2 of 2] ${B}`);
  });

  test("nothing waiting is said, and is not an error", async () => {
    const r = await next("");

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Nothing left that needs you.");
    expect(r.stdout).toContain("Nothing was changed.");
  });

  test("--once handles one request and stops", async () => {
    seed(A);
    seed(B);
    requestedAt(A, "2026-10-10 09:00:00");
    requestedAt(B, "2026-10-11 09:00:00");

    const r = await next("s\ns\n", ["--once"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`[1 of 2] ${A}`);
    expect(r.stdout).not.toContain(B);
    expect(r.stdout).toContain("Done: 1 skipped.");
  });

  test("--dataset shows only that request", async () => {
    seed(A);
    seed(B);
    requestedAt(A, "2026-10-10 09:00:00");
    requestedAt(B, "2026-10-11 09:00:00");

    const r = await next("s\n", ["--dataset", B]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`[1 of 1] ${B}`);
    expect(r.stdout).not.toContain(`${A} `);
  });

  test("--dataset for a request that is not waiting says so, and an id that is not one is refused", async () => {
    seed(A);

    const none = await next("", ["--dataset", "nm000999"]);
    expect(none.exitCode).toBe(0);
    expect(none.stdout).toContain("nm000999 is not waiting for you now");
    expect(none.stdout).not.toContain("Nothing left that needs you.");

    const bad = await next("", ["--dataset", "../etc"]);
    expect(bad.exitCode).toBe(1);
    expect(output(bad)).toContain("is not a dataset id");
    expect(bad.stdout).not.toContain("[1 of");
  });

  test("an input that ends is said, and is not a failure", async () => {
    seed(A);

    const r = await next("");

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Input ended; stopping.");
    // Nothing was shown, so the way to see what is waiting is named.
    expect(r.stdout).toContain("See what needs you with: nemar admin publish list --needs-me");
    expect(h.posted).toEqual([]);
  });

  test("a line that is not an answer is said, and the card asks again", async () => {
    seed(A);

    const r = await next("maybe\nq\n");

    expect(r.stdout).toContain("Type y, n, c, d, s or q.");
    expect(promptsIn(r)).toBe(2);
  });

  test("with the review off, the walk says so once", async () => {
    h.setEnv({ PUBLICATION_REVIEW_ENABLED: "0" });
    seed(A);

    const r = await next("q\n");

    expect(count(r.stdout, "The automated review is off on this Worker")).toBe(1);
  });

  test("signed out: exit 1 with the sign-in cure, and nothing is read", async () => {
    seed(A);

    const r = await next("q\n", [], { signedOut: true });

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Not authenticated");
    expect(h.requests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 10. the size line
// ---------------------------------------------------------------------------------------------

describe("a large dataset says what the lock will take, before the answer", () => {
  test("12,400 files: the count and the calls, on the card", async () => {
    seed(A);
    h.db.run("UPDATE datasets SET total_files = 12400 WHERE dataset_id = ?", [A]);

    const r = await next("q\n");

    const line = "Size:     about 12,400 files; locking them takes about 124 calls to the API";
    expect(r.stdout).toContain(line);
    expect(r.stdout.indexOf(line)).toBeLessThan(r.stdout.indexOf(PROMPT));
  });

  test("a small dataset has no size line", async () => {
    seed(A);
    h.db.run("UPDATE datasets SET total_files = 4999 WHERE dataset_id = ?", [A]);

    const r = await next("q\n");

    expect(r.stdout).not.toContain("Size:");
  });
});

// ---------------------------------------------------------------------------------------------
// The exit code, and what the Worker refuses
// ---------------------------------------------------------------------------------------------

describe("what fails exits 1, and the walk goes on", () => {
  test("an approval the Worker refuses is printed with its reasons, counted, and the exit code is 1", async () => {
    const { requestId, reviewId } = seed(A, twoReasons());
    seed(B);
    requestedAt(A, "2026-10-10 09:00:00");
    requestedAt(B, "2026-10-11 09:00:00");
    // Between the card's read of the review and the approval, a release of the version appears: a
    // reason the override was not given for.
    h.after(`GET /admin/publish/${A}/review`, () => {
      h.db.run("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, '1.0.0', ?)", [
        A,
        "10.5072/FK2.late",
      ]);
    });

    const r = await next("y\ny\ny\n", ["--force"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain(REVIEW_GATE_REFUSAL_TEXT.override_not_covering.split(" (nemar")[0]);
    expect(output(r)).toContain(REASONS.version_already_released.sentence);
    expect(h.requests.filter((c) => c.path === approvePath(A)).map((c) => c.status)).toEqual([409]);
    // Nothing was recorded, and the walk went on to the next card, which it approved.
    expect(requestRow(requestId)?.status).toBe("requested");
    expect(
      h.db
        .query<{ override_by: number | null }, [number | null]>(
          "SELECT override_by FROM publication_reviews WHERE id = ?",
        )
        .get(reviewId)?.override_by,
    ).toBeNull();
    expect(r.stdout).toContain(`[2 of 2] ${B}`);
    expect(approveBodies(B)).toHaveLength(1);
    expect(r.stdout).toContain("Done: 1 approved, 1 failed.");
    // The Worker's refusal is the command's answer, not a crash to report.
    expect(output(r)).not.toContain("attach the log to a new issue");
  });

  test("a request the Worker refused, then one that failed for a reason that may be a bug: the bug-report hint is present", async () => {
    // Card 1: the Worker's refusal (409), an answer, which marks the exit as reported. Card 2: a
    // denial the Worker could not write (500 with no closed word), which may be a bug and must
    // bring the hint back; a mark that nothing can clear would leave it suppressed.
    seed(A, twoReasons());
    seed(B);
    requestedAt(A, "2026-10-10 09:00:00");
    requestedAt(B, "2026-10-11 09:00:00");
    h.after(`GET /admin/publish/${A}/review`, () => {
      h.db.run("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, '1.0.0', ?)", [
        A,
        "10.5072/FK2.late",
      ]);
    });
    h.hookDb({
      statement(sql) {
        if (/SET status = 'denied'/.test(sql)) throw new Error("simulated write failure");
      },
    });

    const r = await next("y\ny\nn\nThe participants file is missing\n", ["--force"]);

    expect(r.exitCode).toBe(1);
    expect(h.requests.filter((c) => c.path === approvePath(A)).map((c) => c.status)).toEqual([409]);
    expect(h.requests.filter((c) => c.path.endsWith("/deny")).map((c) => c.status)).toEqual([500]);
    expect(r.stdout).toContain("Done: 2 failed.");
    expect(output(r)).toContain("attach the log to a new issue");
  });

  test("a request that failed for a reason that may be a bug, then one the Worker refused: the bug-report hint is still present", async () => {
    // Card 1: a denial the Worker could not write (500 with no closed word), which may be a bug.
    // Card 2: the Worker's refusal (409), an answer, which marks the exit as reported. A later
    // answer must not hide the earlier fault.
    seed(A);
    seed(B, twoReasons());
    requestedAt(A, "2026-10-10 09:00:00");
    requestedAt(B, "2026-10-11 09:00:00");
    h.after(`GET /admin/publish/${B}/review`, () => {
      h.db.run("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, '1.0.0', ?)", [
        B,
        "10.5072/FK2.late",
      ]);
    });
    h.hookDb({
      statement(sql) {
        if (/SET status = 'denied'/.test(sql)) throw new Error("simulated write failure");
      },
    });

    const r = await next("n\nThe participants file is missing\ny\ny\n", ["--force"]);

    expect(r.exitCode).toBe(1);
    expect(h.requests.filter((c) => c.path.endsWith("/deny")).map((c) => c.status)).toEqual([500]);
    expect(h.requests.filter((c) => c.path === approvePath(B)).map((c) => c.status)).toEqual([409]);
    expect(r.stdout).toContain("Done: 2 failed.");
    expect(output(r)).toContain("attach the log to a new issue");
  });

  test("a review that could not be read still gets a card; y is offered, the Worker refuses it, exit 1", async () => {
    const { requestId } = seed(A);
    h.hookDb({
      statement(sql) {
        if (/FROM publication_reviews/.test(sql)) throw new Error("simulated read failure");
      },
    });

    const r = await next("y\n");

    expect(r.stdout).toContain(`[1 of 1] ${A}`);
    expect(r.stdout).toContain(
      "The publication review could not be read (HTTP 500); the API still checks it.",
    );
    expect(r.stdout).toContain("y approve, ");
    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain(REVIEW_GATE_REFUSAL_TEXT.unverified);
    expect(requestRow(requestId)?.status).toBe("requested");
    expect(approveBodies(A).every((b) => !("override_publication_review" in (b ?? {})))).toBe(true);
  });

  test("d on a card whose review could not be read says so, and asks again", async () => {
    seed(A);
    h.hookDb({
      statement(sql) {
        if (/FROM publication_reviews/.test(sql)) throw new Error("simulated read failure");
      },
    });

    const r = await next("d\nq\n");

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "The review could not be read (HTTP 500), so there is nothing more to show.",
    );
    expect(promptsIn(r)).toBe(2);
  });

  test("a review this version of the CLI cannot show is said so on d, and the card asks again", async () => {
    // A detail that parses (the id and the override are there) but lacks what the rendering reads: a
    // Worker of another version. `d` used to throw out of the walk, with no tally and the reader open.
    seed(A, failingReport());
    h.rewrite(`GET /admin/publish/${A}/review`, (body) => {
      Reflect.deleteProperty(body.review as Record<string, unknown>, "questions");
    });

    const r = await next("d\nq\n");

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("cannot be shown by this version of the CLI");
    expect(promptsIn(r)).toBe(2);
    expect(r.stdout).toContain("Nothing was changed.");
    expect(r.stderr).not.toContain("TypeError");
  });

  test("a card that cannot be built still closes the reader and prints the tally before the error", async () => {
    // The second row lacks a field the walk reads: nothing in the walk catches that, so the tally
    // and the reader's close are the `finally`'s. The first card was skipped and is in the tally.
    seed(A);
    seed(B);
    requestedAt(A, "2026-10-10 09:00:00");
    requestedAt(B, "2026-10-11 09:00:00");
    h.rewrite("GET /admin/publish/requests", (body) => {
      for (const row of body.requests as Array<Record<string, unknown>>) {
        if (row.dataset_id === B) Reflect.deleteProperty(row, "steps_completed");
      }
    });

    const r = await next("s\ns\n");

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(`[1 of 2] ${A}`);
    expect(r.stdout).toContain("Done: 1 skipped.");
    expect(r.stderr).toContain("steps_completed");
  });

  test("a failed read of the list is said, and the exit code is 1", async () => {
    seed(A);
    h.hookDb({
      statement(sql) {
        if (/FROM publication_requests pr/.test(sql)) throw new Error("simulated read failure");
      },
    });

    const r = await next("q\n");

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("Done: 1 failed.");
  });
});

describe("what the walk says about itself", () => {
  test("the non-production Worker is said once, before the first card", async () => {
    h.setEnv({ ENVIRONMENT: "development" });
    seed(A);
    seed(B);
    requestedAt(A, "2026-10-10 09:00:00");
    requestedAt(B, "2026-10-11 09:00:00");

    const r = await next("s\ns\n");

    expect(count(r.stdout, "This is the non-production Worker.")).toBe(1);
    expect(r.stdout.indexOf("This is the non-production Worker.")).toBeLessThan(
      r.stdout.indexOf(`[1 of 2] ${A}`),
    );
  });

  test("the production Worker needs no such note", async () => {
    seed(A);

    const r = await next("q\n");

    expect(r.stdout).not.toContain("non-production");
  });

  test("--help says what each answer does, what --force asks and what the exit codes are", async () => {
    const r = await h.cli([...NEXT, "--help-all"]);

    expect(r.exitCode).toBe(0);
    for (const part of [
      "--dataset <id>",
      "--force",
      "--once",
      "Exit status:",
      "130",
      "There is no --yes",
    ]) {
      expect(r.stdout).toContain(part);
    }
  });
});

describe("an override already on record", () => {
  test("this administrator's own, covering every reason: y is offered without --force, nothing is sent, and it publishes", async () => {
    const { requestId, reviewId } = seed(A, twoReasons());
    setOverride(h.db, reviewId as number, adminId, ["question_failed", "version_missing"]);

    const r = await next("y\n");

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`An override by administrator #${adminId}`);
    expect(r.stdout).toContain("y approve, ");
    expect(approveBodies(A)).toHaveLength(1);
    expect(approveBodies(A)[0]).not.toHaveProperty("override_publication_review");
    expect(requestRow(requestId)?.status).toBe("published");
  });

  test("another administrator's covers nothing for this run: the Worker refuses and the walk prints it", async () => {
    const { requestId, reviewId } = seed(A, twoReasons());
    const otherId = await h.admin("otheradmin", OTHER_ADMIN_KEY);
    setOverride(h.db, reviewId as number, otherId, ["question_failed", "version_missing"]);

    const r = await next("y\n", [], { as: "nextadmin" });

    expect(r.stdout).toContain(`An override by administrator #${otherId}`);
    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain(REVIEW_GATE_REFUSAL_TEXT.needs_override.split(" Read it")[0]);
    expect(requestRow(requestId)?.status).toBe("requested");
  });
});

// ---------------------------------------------------------------------------------------------
// A terminal
// ---------------------------------------------------------------------------------------------

describe.skipIf(process.platform === "win32")("on a terminal", () => {
  test("a line typed before a card was shown is not an answer to it", async () => {
    // Two requests: the walk shows the older, and the second is a pass that a stray `y` would
    // approve. The `y` is typed in the same breath as the `s` that answers the first card, which
    // is what a person who presses Enter while the program is busy does.
    seed(A, twoReasons());
    const b = seed(B);
    requestedAt(A, "2026-10-10 09:00:00");
    requestedAt(B, "2026-10-11 09:00:00");

    const r = await h.cli(NEXT, {
      terminal: async (t) => {
        const first = await t.waitFor(PROMPT);
        t.type("s\ny\n");
        await t.waitFor("typed before this card was shown", { after: first });
        const second = await t.waitFor(PROMPT, { after: first });
        t.type("q\n");
        await t.waitFor("Done:", { after: second });
      },
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Ignored 1 line(s) typed before this card was shown.");
    expect(h.posted).toEqual([]);
    expect(requestRow(b.requestId)?.status).toBe("requested");
    expect(r.stdout).toContain("Done: 1 skipped.");
  });

  test("an approval does not leave the terminal deaf: the next card still hears its answer", async () => {
    // The approval's spinner puts the terminal's input back in line mode and pauses it when it
    // stops; a walk that went on reading from there would hang at the next card.
    const a = seed(A);
    seed(B);
    requestedAt(A, "2026-10-10 09:00:00");
    requestedAt(B, "2026-10-11 09:00:00");

    const r = await h.cli(NEXT, {
      terminal: async (t) => {
        const first = await t.waitFor(PROMPT);
        t.type("y\n");
        const second = await t.waitFor(`[2 of 2] ${B}`, { after: first });
        await t.waitFor(PROMPT, { after: second });
        t.type("q\n");
        await t.waitFor("Done:", { after: second });
      },
    });

    expect(r.exitCode).toBe(0);
    expect(requestRow(a.requestId)?.status).toBe("published");
  });

  test("a line typed while the extra question was not yet shown cannot answer it", async () => {
    const { requestId } = seed(A, twoReasons());

    const r = await h.cli([...NEXT, "--force"], {
      terminal: async (t) => {
        const first = await t.waitFor("y approve, ");
        // The second `y` arrives with the first, before the question exists.
        t.type("y\ny\n");
        const asked = await t.waitFor("[y/N] ", { after: first });
        // Nothing has answered it: the line typed ahead was dropped. Then a person says no.
        await Bun.sleep(300);
        t.type("n\n");
        await t.waitFor("Cancelled. Nothing was sent.", { after: asked });
        const again = await t.waitFor(PROMPT, { after: asked });
        t.type("q\n");
        await t.waitFor("Nothing was changed.", { after: again });
      },
    });

    expect(r.exitCode).toBe(0);
    expect(h.posted).toEqual([]);
    expect(requestRow(requestId)?.status).toBe("requested");
  });

  test("Ctrl+D while an approval runs ends the walk after it, and the command exits", async () => {
    // The input ends while the approval is running: the walk must not wake the terminal again.
    const a = seed(A);
    seed(B);
    requestedAt(A, "2026-10-10 09:00:00");
    requestedAt(B, "2026-10-11 09:00:00");

    const r = await h.cli(NEXT, {
      terminal: async (t) => {
        await t.waitFor(PROMPT);
        t.type("y\n");
        t.type("\u0004");
        await t.waitFor("Input ended; stopping.");
      },
    });

    expect(r.exitCode).toBe(0);
    expect(requestRow(a.requestId)?.status).toBe("published");
    expect(r.stdout).toContain("Done: 1 approved.");
    // The input had ended, so the second request got no card.
    expect(r.stdout).not.toContain("[2 of 2]");
  });

  test("Ctrl+C while an approval runs says which dataset was mid-approval, what to run, the tally, exits 130 and leaves the terminal as it found it", async () => {
    // The spinner's own handling of standard input turns Ctrl+C into a SIGINT event for the whole
    // process, which the CLI's exit hooks used to turn into a plain death: no word, no tally, and an
    // approval that went on to publish. The GitHub stand-in is slow so the run is still going.
    const a = seed(A);
    h.githubDelayMs.value = 2_000;

    const r = await h.cli(NEXT, {
      terminal: async (t) => {
        const first = await t.waitFor("y approve, ");
        t.type("y\n");
        const running = await t.waitFor("Running publication workflow", { after: first });
        await Bun.sleep(600);
        t.type("\u0003");
        await t.waitFor(`nemar admin publish approve ${A} --resume`, { after: running });
        await t.waitFor("Nothing was changed.", { after: running });
      },
    });

    expect(r.exitCode).toBe(130);
    expect(r.stdout).toContain(`Interrupted while approving ${A}.`);
    expect(r.stdout).toContain("may still be running, or may have finished");
    expect(r.stdout).toContain(`nemar admin publish show ${A}`);
    expect(r.stdout).toContain(`nemar admin publish approve ${A} --resume`);
    // The tally follows the pointer, and the interrupted approval is not in it.
    expect(r.stdout.indexOf("Nothing was changed.")).toBeGreaterThan(
      r.stdout.indexOf(`approve ${A} --resume`),
    );
    // No other message of a stopped walk: the interrupt is the one thing said.
    expect(r.stdout).not.toContain("Input ended; stopping.");
    // The spinner hid the cursor; the last word about it is that it is shown again.
    const hidden = r.stdout.lastIndexOf("\u001b[?25l");
    expect(hidden).toBeGreaterThan(-1);
    expect(r.stdout.lastIndexOf("\u001b[?25h")).toBeGreaterThan(hidden);

    // The Worker was already running it, and went on: that is why the message says "may".
    const deadline = Date.now() + 20_000;
    while (!h.requests.some((c) => c.path === approvePath(A)) && Date.now() < deadline) {
      await Bun.sleep(100);
    }
    expect(requestRow(a.requestId)?.status).toBe("published");
  });

  test("Ctrl+C stops the walk with the shell's code for an interrupt, and says so", async () => {
    seed(A);

    const r = await h.cli(NEXT, {
      terminal: async (t) => {
        await t.waitFor(PROMPT);
        t.type("\u0003");
      },
    });

    expect(r.exitCode).toBe(130);
    expect(r.stdout).toContain("Interrupted; stopping.");
    expect(h.posted).toEqual([]);
  });
});
