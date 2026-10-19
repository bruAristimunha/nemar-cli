/**
 * `nemar admin publish list | show | start` with the publication review (ADR 0102, section 8),
 * the real command against the real backend app (`helpers/admin-publish-cli.ts`).
 *
 * Every answer a test reads is one the Worker itself made from rows seeded the way the Worker
 * leaves them: review reports go through the production parser, the screen's report through the
 * production screen parser, and the list, the detail and the start are the real routes behind
 * their real auth. GitHub (the dispatch a start sends) and Resend are the only stand-ins.
 *
 * What these tests hold the CLI to: it prints the Worker's words and decides nothing itself (which
 * requests need a person, which a start is offered for), what the model wrote is printed only under
 * a label that says so and never carries a terminal control, and every command's exit code says
 * whether the thing asked for happened.
 *
 * Mutation checks (each turns a named test red): drop the `*` marker (list); count a blocked
 * request or an approval in flight as needing a person, or one whose only reasons are waits
 * (`needsAdministrator`); print the review line for a request that is not assessed; print the
 * model's summary without its label or a note without `plain()` (show); let `--json` print a line
 * besides the JSON; exit 0 for a refused start other than `running` and `has_result`; recompute
 * `start --all`'s candidates from reason codes; continue `start --all` after `platform_limit`;
 * start without a confirmation in a pipe; ask the confirmation of `start --all --json` at a terminal
 * (its question goes to standard output); print the step, the error or the pre-screen's reasons of
 * `list` without `plain()`; count a request whose identifier screen is running as needing a person
 * when the review is off.
 *
 * CI TIER: unit-pure. Hermetic: an in-process backend over a local database, the CLI spawned
 * against it, stand-ins only at GitHub and Resend, no live network; it sets its own default
 * timeout.
 */

import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { NOT_HANDED_OVER, START_REFUSALS } from "../backend/src/routes/admin/publication-review";
import { SCREENED_HEAD } from "../backend/test/helpers/identifier-screen";
import {
  NOTE_SENTINEL,
  SUMMARY_SENTINEL,
  type SeedScreenedRequest,
  evidenceFor,
  failingReport,
  goodPublicationReport,
  seedPublicationReview,
  seedScreenedRequest,
  setOverride,
} from "../backend/test/helpers/publication-review";
import type { PublicationReviewDetail } from "../shared/contract/publication-review-admin";
import {
  NOT_ASSESSED_LINE,
  PLATFORM_DAILY_CAP,
  PUBLICATION_FINDING_LABEL,
  QUESTION_FACT_TEXT,
  QUESTION_LABEL,
  REASONS,
  START_CURE_REASONS,
  cureOf,
} from "../shared/publication-review";
import type { PublishRequestsResponse } from "../src/lib/api/publish";
import { type CliResult, startPublishCli } from "./helpers/admin-publish-cli";

setDefaultTimeout(60_000);

const ADMIN_KEY = "review-cli-admin-key-0123456789abcdef0123456789abcdef";

const h = startPublishCli();
afterAll(() => h.stop());

beforeEach(async () => {
  h.reset();
  // The review is on unless a test says otherwise: the flag is the Worker's own binding.
  h.setEnv({ PUBLICATION_REVIEW_ENABLED: "1" });
  await h.admin("reviewadmin", ADMIN_KEY);
});

/**
 * The generic nudge the exit hook prints on a non-zero exit (src/index.ts). Where exit 1 is the
 * command's answer it is noise, and `markReportedExit` suppresses it; where the Worker itself
 * failed it stays, because that may be a bug worth a report.
 */
const BUG_HINT = "attach the log to a new issue";

/** Anything a terminal could act on, in any line of what was printed. */
const DANGEROUS_IN_LINES = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** What the command printed, standard output and standard error together. */
const output = (r: CliResult) => `${r.stdout}\n${r.stderr}`;

/** The block of lines that belongs to one dataset in `list`: its own line and what is indented under it. */
function blockOf(stdout: string, datasetId: string): string[] {
  const lines = stdout.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`  ${datasetId}  `));
  if (at < 0) return [];
  const block = [lines[at]];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith("    ")) break;
    block.push(line);
  }
  return block;
}

/** A request whose review reported the failing report (one failed question, one blocker finding). */
function seedFailing(datasetId: string, over: Partial<SeedScreenedRequest> = {}) {
  const { requestId } = seedScreenedRequest(h.db, { datasetId, ...over });
  const reviewId = seedPublicationReview(h.db, {
    requestId,
    datasetId,
    state: "reported",
    report: failingReport(),
    claimed: true,
  });
  return { requestId, reviewId };
}

/** A request whose review reported a clean pass. */
function seedPassing(datasetId: string) {
  const { requestId } = seedScreenedRequest(h.db, { datasetId });
  const reviewId = seedPublicationReview(h.db, {
    requestId,
    datasetId,
    state: "reported",
    report: goodPublicationReport(),
    claimed: true,
  });
  return { requestId, reviewId };
}

const LIST = ["admin", "publish", "list"];

// ---------------------------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------------------------

describe("list with the review", () => {
  /** One request of each kind an administrator has to tell apart, and what the marker should say. */
  function seedQueue() {
    seedFailing("nm000480");
    // A review that is running: only waiting.
    const running = seedScreenedRequest(h.db, { datasetId: "nm000481" });
    seedPublicationReview(h.db, {
      requestId: running.requestId,
      datasetId: "nm000481",
      state: "dispatched",
      createdMinutesAgo: 1,
    });
    // Blocked: the depositor acts.
    seedScreenedRequest(h.db, {
      datasetId: "nm000482",
      requestStatus: "blocked",
      blockReason: "min_requirements_failed",
    });
    // An approval running right now (an approving request touched a moment ago holds its lease).
    seedScreenedRequest(h.db, { datasetId: "nm000483", requestStatus: "approving" });
    seedPassing("nm000484");
    // The identifier screen is still running: only waiting.
    seedScreenedRequest(h.db, { datasetId: "nm000485", status: "pending" });
    // A stopped approval: approving, and nothing has touched it for hours.
    seedScreenedRequest(h.db, { datasetId: "nm000486", requestStatus: "approving" });
    h.db.run(
      "UPDATE publication_requests SET updated_at = datetime('now', '-2 hours') WHERE dataset_id = 'nm000486'",
    );
  }

  test("prints the review line with its reason codes, and a * on exactly the requests that need a person", async () => {
    seedQueue();

    const r = await h.cli(LIST);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Publication Requests (7, active requests)");

    const failing = blockOf(r.stdout, "nm000480");
    expect(failing[0].trimEnd().endsWith("*")).toBe(true);
    expect(failing.join("\n")).toContain("Publication review: FAIL  question_failed");
    // The review line follows the screen's, under the request.
    const screenAt = failing.findIndex((l) => l.includes("Identifier screen:"));
    const reviewAt = failing.findIndex((l) => l.includes("Publication review:"));
    expect(screenAt).toBeGreaterThan(-1);
    expect(reviewAt).toBeGreaterThan(screenAt);

    const passing = blockOf(r.stdout, "nm000484");
    expect(passing[0].trimEnd().endsWith("*")).toBe(true);
    expect(passing.join("\n")).toContain("Publication review: pass");

    // A request whose approval was stopped is the administrator's to resume.
    expect(blockOf(r.stdout, "nm000486")[0].trimEnd().endsWith("*")).toBe(true);

    // Waiting for the review, waiting for the screen, blocked, and an approval in flight: no mark.
    for (const id of ["nm000481", "nm000485", "nm000482", "nm000483"]) {
      expect(blockOf(r.stdout, id)[0].trimEnd().endsWith("*")).toBe(false);
    }
    expect(blockOf(r.stdout, "nm000481").join("\n")).toContain("review_running");
    expect(blockOf(r.stdout, "nm000485").join("\n")).toContain("identifier_screen_pending");
    expect(blockOf(r.stdout, "nm000482").join("\n")).toContain("request_blocked");
    expect(blockOf(r.stdout, "nm000483")[0]).toContain("(approval running)");

    expect(r.stdout).toContain("7 requests, 3 you can act on.");
    expect(r.stdout).toContain("nemar admin publish next | show <dataset> | approve <dataset>");
    // The review is on, so nothing says it is off.
    expect(r.stdout).not.toContain("The automated review is off");
  });

  test("--needs-me keeps exactly the requests a person can act on and says how many it hid", async () => {
    seedQueue();

    const r = await h.cli([...LIST, "--needs-me"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Publication Requests (3, active requests)");
    for (const id of ["nm000480", "nm000484", "nm000486"]) expect(r.stdout).toContain(id);
    for (const id of ["nm000481", "nm000482", "nm000483", "nm000485"]) {
      expect(r.stdout).not.toContain(id);
    }
    expect(r.stdout).toContain("Showing 3 of 7 requests, 3 you can act on.");
  });

  test("--json prints the response and nothing else on standard output", async () => {
    seedQueue();

    const r = await h.cli([...LIST, "--json"]);

    expect(r.exitCode).toBe(0);
    // One document: parsing the whole of standard output is the check that nothing else was printed.
    const body = JSON.parse(r.stdout) as PublishRequestsResponse;
    expect(body.count).toBe(7);
    expect(body.requests).toHaveLength(7);
    const failing = body.requests.find((q) => q.dataset_id === "nm000480");
    expect(failing?.publication_review).toMatchObject({
      outcome: "fail",
      reasons: ["question_failed"],
    });
    expect(r.stdout.trimStart().startsWith("{")).toBe(true);
  });

  test("--json with --needs-me prints the rows a person can act on, counted", async () => {
    seedQueue();

    const r = await h.cli([...LIST, "--json", "--needs-me"]);

    const body = JSON.parse(r.stdout) as PublishRequestsResponse;
    expect(body.requests.map((q) => q.dataset_id).sort()).toEqual([
      "nm000480",
      "nm000484",
      "nm000486",
    ]);
    expect(body.count).toBe(3);
  });

  test("--json sends an error to standard error and leaves standard output empty", async () => {
    const r = await h.cli([...LIST, "--json"], { signedOut: true });

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Not authenticated");
  });

  test("--status accepts blocked and the help says so", async () => {
    seedQueue();

    const r = await h.cli([...LIST, "--status", "blocked"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Publication Requests (1, requests with status blocked)");
    expect(r.stdout).toContain("nm000482");
    const help = await h.cli([...LIST, "--help"]);
    expect(help.stdout).toContain("blocked");
  });
});

describe("list prints what came from the network as plain text", () => {
  // The fields a request row holds raw: the step and error of a run, and the pre-screen's reasons,
  // which the model writes from text the depositor wrote. None of them passes through the Worker's
  // own words, so the CLI's `plain()` is the only thing between them and the terminal.
  const ESC = String.fromCharCode(27);
  const hostile = `${ESC}[2J${ESC}]0;title\u0007steered\u202ereversed\u200b\u2028end`;
  const cleaned = "[2J]0;titlesteeredreversedend";

  test("the step, the error and the pre-screen's reasons carry no terminal control", async () => {
    const running = seedScreenedRequest(h.db, {
      datasetId: "nm000480",
      requestStatus: "approving",
    });
    h.db.run("UPDATE publication_requests SET current_step = ?, last_error = ? WHERE id = ?", [
      `ci_check${hostile}`,
      hostile,
      running.requestId,
    ]);
    const concern = seedScreenedRequest(h.db, { datasetId: "nm000481" });
    h.db.run(
      "UPDATE publication_requests SET prescreen_status = 'concern', prescreen_reasons = ? WHERE id = ?",
      [JSON.stringify([hostile, "a plain reason"]), concern.requestId],
    );

    const r = await h.cli(LIST);

    expect(r.exitCode).toBe(0);
    expect(blockOf(r.stdout, "nm000480").join("\n")).toContain(`ci check${cleaned}`);
    expect(blockOf(r.stdout, "nm000480").join("\n")).toContain(`(${cleaned})`);
    expect(blockOf(r.stdout, "nm000481").join("\n")).toContain(`${cleaned}; a plain reason`);
    for (const line of r.stdout.split("\n")) expect(line).not.toMatch(DANGEROUS_IN_LINES);
  });
});

describe("list with the review off", () => {
  beforeEach(() => {
    h.setEnv({ PUBLICATION_REVIEW_ENABLED: "0" });
  });

  test("a request with no review has no review line, and the footer says the review is off", async () => {
    seedScreenedRequest(h.db, { datasetId: "nm000480" });
    seedScreenedRequest(h.db, { datasetId: "nm000481" });

    const r = await h.cli(LIST);

    expect(r.exitCode).toBe(0);
    for (const id of ["nm000480", "nm000481"]) {
      const block = blockOf(r.stdout, id);
      expect(block.length).toBeGreaterThan(0);
      expect(block.join("\n")).not.toContain("Publication review");
      // Not assessed is not a pass and not a wait: a person can still decide it.
      expect(block[0].trimEnd().endsWith("*")).toBe(true);
    }
    expect(r.stdout).toContain(
      "The automated review is off on this Worker, so no review gates an approval.",
    );
  });

  test("a request whose identifier screen is still running is only waiting, with the review off too", async () => {
    seedScreenedRequest(h.db, { datasetId: "nm000480", status: "pending" });
    seedScreenedRequest(h.db, { datasetId: "nm000481" });

    const r = await h.cli(LIST);

    expect(r.exitCode).toBe(0);
    // No review reports a wait here (the flag is off), so the screen's own state is the only word.
    expect(blockOf(r.stdout, "nm000480")[0].trimEnd().endsWith("*")).toBe(false);
    expect(blockOf(r.stdout, "nm000481")[0].trimEnd().endsWith("*")).toBe(true);
    expect(r.stdout).toContain("2 requests, 1 you can act on.");

    const mine = await h.cli([...LIST, "--needs-me"]);

    expect(mine.stdout).toContain("Publication Requests (1, active requests)");
    expect(mine.stdout).toContain("nm000481");
    expect(mine.stdout).not.toContain("nm000480");
  });

  test("a stored review is printed as advice, and the footer still says the review is off", async () => {
    seedScreenedRequest(h.db, { datasetId: "nm000480" });
    seedFailing("nm000481");

    const r = await h.cli(LIST);

    const stored = blockOf(r.stdout, "nm000481").join("\n");
    expect(stored).toContain(
      "Publication review (advice only, the automated review is off): FAIL  question_failed",
    );
    expect(blockOf(r.stdout, "nm000480").join("\n")).not.toContain("Publication review");
    // Every row says the review is off, whether or not it holds a review.
    expect(r.stdout).toContain("The automated review is off on this Worker");
  });
});

// ---------------------------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------------------------

const ACK_AT = "2026-10-13 10:01:00";
const OVERRIDE_AT = "2026-10-13 10:02:11";

/**
 * A request whose review has everything `show` prints: a question the platform's own facts failed
 * (no README), a finding and a summary in the model's words, a cut and a withheld document, an
 * older review of another commit, an override on record and a screen acknowledgment.
 */
function seedRich(datasetId: string): { requestId: number; reviewId: number } {
  const adminId = h.db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'reviewadmin'")
    .get()?.id as number;
  const { requestId } = seedScreenedRequest(h.db, { datasetId, status: "review" });
  h.db.run(
    `UPDATE publication_requests
        SET identifier_screen_ack_by = ?, identifier_screen_ack_reason = 'dates only, read them',
            identifier_screen_ack_at = ?
      WHERE id = ?`,
    [adminId, ACK_AT, requestId],
  );
  const report = goodPublicationReport({
    summary: SUMMARY_SENTINEL,
    findings: [
      {
        question: "meets_standards",
        severity: "concern",
        code: "ethics_statement_inadequate",
        document: "dataset_description",
        note: NOTE_SENTINEL,
      },
    ],
    evidence: evidenceFor(SCREENED_HEAD, false, {
      version: "1.2.0",
      documents: {
        readme: "absent",
        dataset_description: "sent",
        changes: "absent",
        license: "sent_cut",
        participants_json: "withheld_finding",
      },
      withheld_findings: { "edf-patient-name": 1 },
    }),
  });
  const reviewId = seedPublicationReview(h.db, {
    requestId,
    datasetId,
    state: "reported",
    report,
    claimed: true,
    createdMinutesAgo: 5,
  });
  setOverride(h.db, reviewId, adminId, ["question_failed", "text_withheld"], OVERRIDE_AT);
  // An earlier attempt on another commit: history, not the review in force.
  seedPublicationReview(h.db, {
    requestId,
    datasetId,
    head: "a".repeat(40),
    state: "errored",
    detail: "model_unavailable",
    createdMinutesAgo: 120,
  });
  return { requestId, reviewId };
}

/** The detail as the Worker answered it: the oracle for the words `show` must print as they are. */
async function detailOf(datasetId: string): Promise<PublicationReviewDetail> {
  const r = await h.cli(["admin", "publish", "show", datasetId, "--json"]);
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout) as PublicationReviewDetail;
}

/** The positions of `markers` in `text`, which must all be found and in this order. */
function expectInOrder(text: string, markers: string[]): void {
  let from = 0;
  for (const marker of markers) {
    const at = text.indexOf(marker, from);
    expect(at, `"${marker}" after position ${from}`).toBeGreaterThanOrEqual(0);
    from = at + marker.length;
  }
}

describe("show", () => {
  test("prints the screen, the headline, the gate, the reasons with their cures, the questions, the facts, the findings and summary under their labels, the evidence, what was shown, the standing line and the next command", async () => {
    const { requestId } = seedRich("nm000480");
    const detail = await detailOf("nm000480");
    // The words come from the Worker; the test reads what it said and holds the CLI to printing it.
    expect(detail.description.headline).toBe("Publication review: FAIL");
    expect(detail.description.next).not.toBeNull();

    const before = h.requests.length;
    const r = await h.cli(["admin", "publish", "show", "nm000480"]);

    expect(r.exitCode).toBe(0);
    const questionFailed = REASONS.question_failed.sentence.replace(/\.$/, "");
    expectInOrder(r.stdout, [
      `nm000480  request ${requestId}, requested, named publication`,
      "Identifier screen:",
      `Acknowledged by administrator ${detail.screen_acknowledgment?.by} at ${ACK_AT}.`,
      detail.description.headline,
      "Gate: enforced",
      questionFailed,
      cureOf("question_failed", "nm000480", true),
      "Questions:",
      "complete_and_honest",
      "fail",
      QUESTION_LABEL.complete_and_honest,
      "Platform facts that lowered an answer:",
      `complete_and_honest: ${QUESTION_FACT_TEXT.readme_absent}`,
      "Findings (written by the model; the depositor's text can steer them):",
      `[concern] ${PUBLICATION_FINDING_LABEL.ethics_statement_inadequate} (dataset_description.json): ${NOTE_SENTINEL}`,
      "Summary (written by the model; the depositor's text can steer it):",
      SUMMARY_SENTINEL,
      "Evidence: version 1.2.0 (tag absent), BIDS pass, minimums met, 4 subjects, 0 sessions, 4 recordings (.edf 4), datatypes eeg, sampling rates 256 Hz, channel counts 32, sidecars read 4 of 4",
      "Shown to the model: README absent, dataset_description.json sent (9 keys shown, 1 not), CHANGES absent, LICENSE sent (cut), participants.json withheld (finding)",
      "Withheld for findings: edf-patient-name 1",
      `Override: by administrator ${detail.review?.override?.by} at ${OVERRIDE_AT} for question_failed, text_withheld`,
      NOT_ASSESSED_LINE,
      `Next: ${detail.description.next}`,
      "History",
    ]);
    // Every line of the Worker's description is printed as it came.
    for (const line of detail.description.lines) expect(r.stdout).toContain(line);
    // The history lists the reviews, the one in force marked.
    const history = r.stdout.slice(r.stdout.indexOf("History"));
    expect(history).toContain("reported");
    expect(history).toContain("errored");
    expect(history).toContain("in force");
    // Read-only: the command wrote nothing.
    expect(h.requests.slice(before).map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /admin/publish/nm000480/review",
    ]);
  });

  test("the model's words are printed once, under their labels, and nowhere else", async () => {
    seedRich("nm000480");

    const r = await h.cli(["admin", "publish", "show", "nm000480"]);

    const lines = r.stdout.split("\n");
    expect(lines.filter((l) => l.includes(SUMMARY_SENTINEL))).toHaveLength(1);
    expect(lines.filter((l) => l.includes(NOTE_SENTINEL))).toHaveLength(1);
    const labelAt = lines.findIndex((l) => l.includes("Summary (written by the model;"));
    expect(lines[labelAt + 1]).toContain(SUMMARY_SENTINEL);
    const findingsAt = lines.findIndex((l) => l.includes("Findings (written by the model;"));
    expect(lines[findingsAt + 1]).toContain(NOTE_SENTINEL);
    // The list, which an administrator reads at a glance, carries neither.
    const list = await h.cli(LIST);
    expect(list.stdout).not.toContain(SUMMARY_SENTINEL);
    expect(list.stdout).not.toContain(NOTE_SENTINEL);
  });

  test("a passing review prints its pass, no findings and no reason, and the approve command", async () => {
    seedPassing("nm000484");

    const r = await h.cli(["admin", "publish", "show", "nm000484"]);

    expect(r.exitCode).toBe(0);
    const detail = await detailOf("nm000484");
    expectInOrder(r.stdout, [
      "nm000484  request",
      "Identifier screen:",
      "Publication review: pass",
      "Gate: enforced",
      "Questions:",
      "Summary (written by the model; the depositor's text can steer it):",
      "Evidence:",
      "Shown to the model:",
      NOT_ASSESSED_LINE,
      `Next: ${detail.description.next}`,
    ]);
    expect(r.stdout).not.toContain("Findings (");
    expect(r.stdout).not.toContain("Platform facts");
    expect(r.stdout).not.toContain("Override:");
    expect(r.stdout).not.toContain("History");
  });

  test("a request with no review says so in the Worker's words, and the flag off says the gate is off", async () => {
    h.setEnv({ PUBLICATION_REVIEW_ENABLED: "0" });
    seedScreenedRequest(h.db, { datasetId: "nm000480" });

    const r = await h.cli(["admin", "publish", "show", "nm000480"]);

    expect(r.exitCode).toBe(0);
    const detail = await detailOf("nm000480");
    expectInOrder(r.stdout, [
      detail.description.headline,
      "Gate: off (advice only)",
      NOT_ASSESSED_LINE,
    ]);
    expect(r.stdout).not.toContain("Questions:");
  });

  test("a blocked request shows why, even with the review off and no reasons", async () => {
    h.setEnv({ PUBLICATION_REVIEW_ENABLED: "0" });
    seedScreenedRequest(h.db, {
      datasetId: "nm000480",
      requestStatus: "blocked",
      blockReason: "min_requirements_failed",
    });

    const r = await h.cli(["admin", "publish", "show", "nm000480"]);

    expect(r.stdout).toContain("blocked (min_requirements_failed)");
  });

  test("an anonymous release says so up front", async () => {
    seedScreenedRequest(h.db, { datasetId: "nm000480", anonymous: true });

    const r = await h.cli(["admin", "publish", "show", "nm000480"]);

    expect(r.stdout.split("\n")[1]).toContain("ANONYMOUS RELEASE");
  });

  test("the non-production Worker says it is not production", async () => {
    h.setEnv({ ENVIRONMENT: "staging" });
    seedScreenedRequest(h.db, { datasetId: "nm000480" });

    const r = await h.cli(["admin", "publish", "show", "nm000480"]);

    expect(r.stdout).toContain("This is the non-production Worker.");
    const production = await h.cli(LIST);
    expect(production.stdout).not.toContain("non-production");
  });

  test("--json prints the detail and nothing else", async () => {
    seedRich("nm000480");

    const r = await h.cli(["admin", "publish", "show", "nm000480", "--json"]);

    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout) as PublicationReviewDetail;
    expect(body.dataset_id).toBe("nm000480");
    expect(body.review?.summary).toBe(SUMMARY_SENTINEL);
    expect(r.stdout.trimStart().startsWith("{")).toBe(true);
    expect(r.stdout.trimEnd().endsWith("}")).toBe(true);
  });

  test("a model's text carrying a terminal escape and a bidirectional override prints without them", async () => {
    // The Worker reduces the model's words to plain ones before it sends them; this is the end of
    // the chain, a stored report that carries the controls, read back through the real route. The
    // CLI's own `plain()` is held to the same by publication-review-display.unit.test.ts, which
    // feeds it hostile text the Worker would never send.
    const ESC = String.fromCharCode(27);
    const hostile = `${ESC}[2J${ESC}]0;title\u0007steered\u202ereversed\u200b\u2028end`;
    const { requestId } = seedScreenedRequest(h.db, { datasetId: "nm000480" });
    const base = failingReport() as { findings: Array<{ note: string }>; summary: string };
    base.summary = hostile;
    base.findings[0].note = hostile;
    seedPublicationReview(h.db, {
      requestId,
      datasetId: "nm000480",
      state: "reported",
      rawReport: JSON.stringify(base),
      verdict: "fail",
      claimed: true,
    });

    const r = await h.cli(["admin", "publish", "show", "nm000480"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Summary (written by the model;");
    // Every line, split on the newline that separates them: any other control is hostile (the run
    // has no colour, so none of it is the CLI's own).
    for (const line of r.stdout.split("\n")) expect(line).not.toMatch(DANGEROUS_IN_LINES);
  });

  test("a dataset with no active request exits 1 with the Worker's sentence and no bug-report hint", async () => {
    seedScreenedRequest(h.db, { datasetId: "nm000480", requestStatus: "published" });

    const r = await h.cli(["admin", "publish", "show", "nm000480"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("nm000480 has no active publication request.");
    expect(output(r)).not.toContain(BUG_HINT);
    expect(h.requests.at(-1)?.status).toBe(404);
  });

  test("a malformed id exits 1 before any request is made", async () => {
    const r = await h.cli(["admin", "publish", "show", "not-a-dataset"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain('"not-a-dataset" is not a dataset id');
    expect(output(r)).not.toContain(BUG_HINT);
    expect(h.requests).toEqual([]);
  });

  test("signed out exits 1 and says so on standard output, or on standard error under --json", async () => {
    seedScreenedRequest(h.db, { datasetId: "nm000480" });

    const text = await h.cli(["admin", "publish", "show", "nm000480"], { signedOut: true });
    expect(text.exitCode).toBe(1);
    expect(text.stdout).toContain("Not authenticated");

    const json = await h.cli(["admin", "publish", "show", "nm000480", "--json"], {
      signedOut: true,
    });
    expect(json.exitCode).toBe(1);
    expect(json.stdout).toBe("");
    expect(json.stderr).toContain("Not authenticated");
    expect(h.requests).toEqual([]);
  });

  test("a read the Worker could not make exits 1 and keeps the bug-report hint", async () => {
    seedPassing("nm000484");
    h.hookDb({
      statement(sql) {
        if (/FROM publication_reviews/.test(sql)) throw new Error("simulated read failure");
      },
    });

    const r = await h.cli(["admin", "publish", "show", "nm000484"]);

    expect(r.exitCode).toBe(1);
    expect(h.requests.at(-1)?.status).toBe(500);
    expect(output(r)).toContain("The publication review could not be read. Try again.");
    expect(output(r)).toContain(BUG_HINT);
  });
});

// ---------------------------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------------------------

const START = ["admin", "publish", "start"];

/** The reviews of the platform's database, newest last. */
const reviewRows = () =>
  h.db
    .query<
      {
        id: number;
        dataset_id: string;
        state: string;
        detail: string | null;
        started_by: number | null;
      },
      []
    >("SELECT id, dataset_id, state, detail, started_by FROM publication_reviews ORDER BY id")
    .all();

/** The review dispatches the Worker sent GitHub, by the dataset each was for, in order. */
const dispatchedDatasets = () =>
  h.github.dispatches
    .filter((d) => d.event_type === "run-publication-review")
    .map((d) => d.client_payload.dataset_id);

/** The requests the NEMAR API served that started something. */
const startPosts = () => h.requests.filter((c) => c.method === "POST");

/** A request whose screen is clean and which has no review yet: the one a start is offered for. */
function seedStartable(datasetId: string, requestedAt?: string): number {
  const { requestId } = seedScreenedRequest(h.db, { datasetId });
  if (requestedAt) {
    h.db.run("UPDATE publication_requests SET requested_at = ? WHERE id = ?", [
      requestedAt,
      requestId,
    ]);
  }
  return requestId;
}

describe("start", () => {
  test("dispatches the review, exits 0 and points at show", async () => {
    seedStartable("nm000480");

    const r = await h.cli([...START, "nm000480"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("nm000480: review started.");
    expect(r.stdout).toContain("nemar admin publish show nm000480");
    expect(dispatchedDatasets()).toEqual(["nm000480"]);
    const rows = reviewRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dataset_id: "nm000480", state: "dispatched" });
    expect(rows[0].started_by).not.toBeNull();
  });

  test("a second start answers that a review is running, exits 0 and sends nothing", async () => {
    seedStartable("nm000480");
    await h.cli([...START, "nm000480"]);

    const r = await h.cli([...START, "nm000480"]);

    expect(r.exitCode).toBe(0);
    expect(output(r)).toContain(START_REFUSALS.running.error);
    expect(output(r)).toContain("(running)");
    expect(output(r)).not.toContain(BUG_HINT);
    expect(dispatchedDatasets()).toEqual(["nm000480"]);
    expect(reviewRows()).toHaveLength(1);
  });

  test("a review that already reported answers has_result and exits 0", async () => {
    seedPassing("nm000480");

    const r = await h.cli([...START, "nm000480"]);

    expect(r.exitCode).toBe(0);
    expect(output(r)).toContain(START_REFUSALS.has_result.error);
    expect(output(r)).toContain("(has_result)");
    expect(dispatchedDatasets()).toEqual([]);
  });

  test("a review that ended without a report is started again and says so", async () => {
    const { requestId } = seedScreenedRequest(h.db, { datasetId: "nm000480" });
    seedPublicationReview(h.db, {
      requestId,
      datasetId: "nm000480",
      state: "errored",
      detail: "dispatch_failed",
    });

    const r = await h.cli([...START, "nm000480"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("nm000480: review started again.");
    expect(dispatchedDatasets()).toEqual(["nm000480"]);
  });

  test("a request that is not waiting for its decision exits 1 with the Worker's sentence and word", async () => {
    seedScreenedRequest(h.db, {
      datasetId: "nm000480",
      requestStatus: "blocked",
      blockReason: "min_requirements_failed",
    });

    const r = await h.cli([...START, "nm000480"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain(START_REFUSALS.request_not_requested.error);
    expect(output(r)).toContain("(request_not_requested)");
    expect(output(r)).not.toContain(BUG_HINT);
    expect(dispatchedDatasets()).toEqual([]);
    expect(reviewRows()).toEqual([]);
  });

  // Every other refusal is a start that did not happen, and a script must be able to tell.
  test("every other refusal exits 1", async () => {
    // The screen has not reported.
    seedScreenedRequest(h.db, { datasetId: "nm000481", status: "pending" });
    const notReady = await h.cli([...START, "nm000481"]);
    expect(notReady.exitCode).toBe(1);
    expect(output(notReady)).toContain("(screen_not_ready)");

    // An OpenNeuro mirror is not reviewed.
    seedScreenedRequest(h.db, { datasetId: "on000482", source: "openneuro" });
    const mirror = await h.cli([...START, "on000482"]);
    expect(mirror.exitCode).toBe(1);
    expect(output(mirror)).toContain("(not_applicable)");

    // The other environment's Worker answers for it: the production Worker does not own a fixture
    // the dev Worker does, so there is no row here at all.
    const gone = await h.cli([...START, "nm000483"]);
    expect(gone.exitCode).toBe(1);
    expect(output(gone)).toContain("nm000483 has no active publication request.");
    expect(gone.stderr + gone.stdout).not.toContain(BUG_HINT);

    expect(dispatchedDatasets()).toEqual([]);
  });

  test("the review being off exits 1 and starts nothing", async () => {
    h.setEnv({ PUBLICATION_REVIEW_ENABLED: "0" });
    seedStartable("nm000480");

    const r = await h.cli([...START, "nm000480"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("(review_disabled)");
    expect(output(r)).toContain(START_REFUSALS.review_disabled.error);
    expect(reviewRows()).toEqual([]);
  });

  test("a Worker that cannot hand the review to GitHub exits 1 and the row records it", async () => {
    h.setEnv({ PRESCREEN_CALLBACK_SECRET: undefined });
    seedStartable("nm000480");

    const r = await h.cli([...START, "nm000480"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain(NOT_HANDED_OVER.dispatch_unconfigured.error);
    expect(output(r)).toContain("(dispatch_unconfigured)");
    // The Worker's own clear answer, not a crash of the command.
    expect(output(r)).not.toContain(BUG_HINT);
    expect(dispatchedDatasets()).toEqual([]);
    expect(reviewRows()[0]).toMatchObject({ state: "errored", detail: "dispatch_unconfigured" });
  });

  test("a fault of the Worker exits 1 and keeps the bug-report hint", async () => {
    seedStartable("nm000480");
    h.hookDb({
      statement(sql) {
        if (/INSERT INTO publication_reviews/.test(sql)) throw new Error("simulated write failure");
      },
    });

    const r = await h.cli([...START, "nm000480"]);

    expect(r.exitCode).toBe(1);
    expect(h.requests.at(-1)?.status).toBe(500);
    expect(output(r)).toContain(BUG_HINT);
  });

  test("a member is refused by the Worker and exits 1", async () => {
    seedStartable("nm000480");
    await h.user("plainmember", "member", "member-key-0123456789abcdef0123456789abcdef");

    const r = await h.cli([...START, "nm000480"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("This command requires admin privileges");
    expect(reviewRows()).toEqual([]);
  });

  test("a malformed id exits 1 before any request is made, and so does no id at all", async () => {
    const bad = await h.cli([...START, "nm12"]);
    expect(bad.exitCode).toBe(1);
    expect(output(bad)).toContain('"nm12" is not a dataset id');
    const none = await h.cli(START);
    expect(none.exitCode).toBe(1);
    expect(output(none)).toContain("Give a dataset id, or --all.");
    expect(h.requests).toEqual([]);
  });

  test("signed out exits 1 and sends nothing", async () => {
    seedStartable("nm000480");

    const r = await h.cli([...START, "nm000480"], { signedOut: true });

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Not authenticated");
    expect(h.requests).toEqual([]);
  });

  test("--json prints the Worker's answer and nothing else on standard output", async () => {
    seedStartable("nm000480");

    const r = await h.cli([...START, "nm000480", "--json"]);

    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      started: true,
      reason: "dispatched",
      environment: "production",
    });
    // A refusal that leaves a review standing is still an answer, and is the document.
    const again = await h.cli([...START, "nm000480", "--json"]);
    expect(again.exitCode).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ code: "running" });
    // Any other refusal goes to standard error and leaves standard output empty.
    seedScreenedRequest(h.db, { datasetId: "nm000481", status: "pending" });
    const refused = await h.cli([...START, "nm000481", "--json"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain(START_REFUSALS.screen_not_ready.error);
  });

  test("--dry-run goes with --all", async () => {
    seedStartable("nm000480");

    const r = await h.cli([...START, "nm000480", "--dry-run"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("--dry-run goes with --all.");
    expect(h.requests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// start --all
// ---------------------------------------------------------------------------------------------

describe("start --all", () => {
  /**
   * Four requests a start is offered for, oldest first (the Worker lists newest first), and the
   * ones it is not offered for: a review that reported, one running, a blocked request, a request
   * whose screen has not reported (its reasons name a start as the cure, and the Worker says no),
   * and a request that needs the screen re-run.
   */
  function seedFleet() {
    seedStartable("nm000480", "2026-10-10 08:00:00");
    seedStartable("nm000481", "2026-10-10 09:00:00");
    // A review that errored before it reached a model: started again, free.
    const errored = seedScreenedRequest(h.db, { datasetId: "nm000482" });
    seedPublicationReview(h.db, {
      requestId: errored.requestId,
      datasetId: "nm000482",
      state: "errored",
      detail: "dispatch_failed",
    });
    seedStartable("nm000483", "2026-10-10 11:00:00");
    h.db.run(
      "UPDATE publication_requests SET requested_at = '2026-10-10 10:00:00' WHERE dataset_id = 'nm000482'",
    );
    // Not offered.
    seedPassing("nm000484");
    const running = seedScreenedRequest(h.db, { datasetId: "nm000485" });
    seedPublicationReview(h.db, {
      requestId: running.requestId,
      datasetId: "nm000485",
      state: "dispatched",
      createdMinutesAgo: 1,
    });
    seedScreenedRequest(h.db, {
      datasetId: "nm000486",
      requestStatus: "blocked",
      blockReason: "min_requirements_failed",
    });
    seedScreenedRequest(h.db, { datasetId: "nm000487", status: "pending" });
    seedScreenedRequest(h.db, { datasetId: "nm000488", status: "error" });
  }
  const CANDIDATES = ["nm000480", "nm000481", "nm000482", "nm000483"];

  test("--dry-run lists the candidates, oldest first, with their reasons, and starts nothing", async () => {
    seedFleet();

    const r = await h.cli([...START, "--all", "--dry-run"]);

    expect(r.exitCode).toBe(0);
    expectInOrder(r.stdout, CANDIDATES);
    for (const id of ["nm000484", "nm000485", "nm000486", "nm000487", "nm000488"]) {
      expect(r.stdout).not.toContain(id);
    }
    // The reasons the Worker gave each, as codes.
    const lineOf = (id: string) => r.stdout.split("\n").find((l) => l.trimStart().startsWith(id));
    expect(lineOf("nm000480")).toContain("review_not_started");
    expect(lineOf("nm000482")).toContain("review_could_not_run");
    expect(lineOf("nm000480")).toContain("depositor_nm000480");
    expect(r.stdout).toContain("This was a dry run: nothing was started.");
    // One read, no write.
    expect(startPosts()).toEqual([]);
    expect(dispatchedDatasets()).toEqual([]);
    expect(reviewRows().filter((row) => row.state === "dispatched")).toHaveLength(1);
  });

  test("without --yes in a pipe it is cancelled, exits 1 and starts nothing", async () => {
    seedFleet();

    const none = await h.cli([...START, "--all"]);
    // Piped input is not a person at a terminal: a stray `y` cannot spend the platform's money.
    const typed = await h.cli([...START, "--all"], { input: "y\n" });

    for (const r of [none, typed]) {
      expect(r.exitCode).toBe(1);
      expect(output(r)).toContain("Cancelled.");
      expect(output(r)).not.toContain(BUG_HINT);
    }
    expect(startPosts()).toEqual([]);
    expect(dispatchedDatasets()).toEqual([]);
  });

  test("--yes starts each candidate, oldest first, and says what came of it", async () => {
    seedFleet();

    const r = await h.cli([...START, "--all", "--yes"]);

    expect(r.exitCode).toBe(0);
    expect(dispatchedDatasets()).toEqual(CANDIDATES);
    expect(r.stdout).toContain("4 started, 0 already had a review, 0 not started, 0 failed");
    for (const id of CANDIDATES) expect(r.stdout).toContain(`${id}  started`);
    expect(r.stdout).not.toContain("Stopped:");
    // The two that were not candidates were not asked about.
    expect(startPosts().map((c) => c.path)).toEqual(
      CANDIDATES.map((id) => `/admin/publish/${id}/review/start`),
    );
  });

  test("a request that is not offered is never started, whatever its reason codes say", async () => {
    // A review that reported and whose stored report no longer reads is `review_could_not_run`,
    // whose cure is "start it", and the route would answer has_result: the Worker's
    // `start_offered` says no. Deciding from the reason codes would offer it.
    const stale = seedScreenedRequest(h.db, { datasetId: "nm000480" });
    seedPublicationReview(h.db, {
      requestId: stale.requestId,
      datasetId: "nm000480",
      state: "reported",
      rawReport: "this is not a report",
      verdict: "action_required",
      claimed: true,
    });
    seedStartable("nm000481");
    const list = JSON.parse((await h.cli([...LIST, "--json"])).stdout) as PublishRequestsResponse;
    const summary = list.requests.find((q) => q.dataset_id === "nm000480")?.publication_review;
    expect(summary?.start_offered).toBe(false);
    expect(summary?.reasons.some((code) => START_CURE_REASONS.includes(code))).toBe(true);

    const r = await h.cli([...START, "--all", "--yes"]);

    expect(r.exitCode).toBe(0);
    expect(dispatchedDatasets()).toEqual(["nm000481"]);
    expect(startPosts().map((c) => c.path)).toEqual(["/admin/publish/nm000481/review/start"]);
  });

  test("the platform's allowance spent: the loop stops, the rest are not tried, exit 1", async () => {
    for (const [i, id] of CANDIDATES.entries())
      seedStartable(id, `2026-10-10 ${String(8 + i).padStart(2, "0")}:00:00`);
    // 49 model calls in the last day: the next start is the 50th, the one after is over.
    for (let i = 0; i < PLATFORM_DAILY_CAP - 1; i++) {
      const datasetId = `nm${String(1000 + i).padStart(6, "0")}`;
      const { requestId } = seedScreenedRequest(h.db, { datasetId, requestStatus: "published" });
      seedPublicationReview(h.db, { requestId, datasetId, state: "reported", claimed: true });
    }

    const r = await h.cli([...START, "--all", "--yes"]);

    expect(r.exitCode).toBe(1);
    // The first went; the second was declined by the platform's allowance; the others were never asked.
    expect(dispatchedDatasets()).toEqual(["nm000480"]);
    expect(startPosts().map((c) => c.path)).toEqual([
      "/admin/publish/nm000480/review/start",
      "/admin/publish/nm000481/review/start",
    ]);
    expect(reviewRows().find((row) => row.dataset_id === "nm000481")).toMatchObject({
      state: "declined",
      detail: "platform_limit",
    });
    expect(reviewRows().some((row) => row.dataset_id === "nm000482")).toBe(false);
    expect(r.stdout).toContain("1 started, 0 already had a review, 1 not started, 0 failed");
    expect(r.stdout).toContain(
      "Stopped: the platform's allowance for the last 24 hours is spent, so 2 were not tried.",
    );
    expect(output(r)).not.toContain(BUG_HINT);
  });

  test("a run with nothing to start says so and exits 0", async () => {
    seedPassing("nm000480");

    const r = await h.cli([...START, "--all", "--yes"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Nothing to start");
    expect(startPosts()).toEqual([]);
  });

  test("the review being off dies before asking, with --yes or without", async () => {
    h.setEnv({ PUBLICATION_REVIEW_ENABLED: "0" });
    seedStartable("nm000480");

    for (const args of [
      [...START, "--all"],
      [...START, "--all", "--yes"],
    ]) {
      const r = await h.cli(args);
      expect(r.exitCode).toBe(1);
      expect(output(r)).toContain(
        "The automated review is off on this Worker, so nothing was started.",
      );
      expect(output(r)).not.toContain("Cancelled.");
    }
    expect(startPosts()).toEqual([]);
  });

  test("one that was started meanwhile already has a review and is not a failure", async () => {
    seedFleet();
    // After the list was read and before the first start: someone else starts nm000481.
    h.after("GET /admin/publish/requests", () => {
      const row = h.db
        .query<{ id: number }, []>(
          "SELECT id FROM publication_requests WHERE dataset_id = 'nm000481'",
        )
        .get();
      seedPublicationReview(h.db, {
        requestId: row?.id as number,
        datasetId: "nm000481",
        state: "dispatched",
        createdMinutesAgo: 0,
      });
    });

    const r = await h.cli([...START, "--all", "--yes"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("nm000481  already has a review");
    expect(r.stdout).toContain("3 started, 1 already had a review, 0 not started, 0 failed");
    expect(dispatchedDatasets()).toEqual(["nm000480", "nm000482", "nm000483"]);
  });

  test("--json prints one document: the candidates on a dry run, the results of a run", async () => {
    seedFleet();

    const dry = await h.cli([...START, "--all", "--dry-run", "--json"]);
    expect(dry.exitCode).toBe(0);
    const would = JSON.parse(dry.stdout) as {
      dry_run: boolean;
      would_start: Array<{ dataset_id: string }>;
    };
    expect(would.dry_run).toBe(true);
    expect(would.would_start.map((q) => q.dataset_id)).toEqual(CANDIDATES);

    const run = await h.cli([...START, "--all", "--yes", "--json"]);
    expect(run.exitCode).toBe(0);
    const done = JSON.parse(run.stdout) as {
      started: number;
      failed: number;
      not_tried: number;
      results: Array<{ dataset_id: string; outcome: string }>;
    };
    expect(done).toMatchObject({ started: 4, failed: 0, not_tried: 0 });
    expect(done.results.map((q) => q.dataset_id)).toEqual(CANDIDATES);
    expect(done.results.every((q) => q.outcome === "started")).toBe(true);
  });

  test("--json cancelled prints nothing on standard output and exits 1", async () => {
    seedFleet();

    const r = await h.cli([...START, "--all", "--json"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Cancelled.");
  });

  // `inquirer` writes its question to standard output, which `--json` keeps for the one document
  // a pipe reads (`| jq`). So under --json the question is not asked at all, on a terminal too.
  describe.skipIf(process.platform === "win32")(
    "--json at a terminal, standard output piped",
    () => {
      test("without --yes it is refused: nothing is asked on standard output, nothing is started, exit 1", async () => {
        seedFleet();

        const r = await h.cli([...START, "--all", "--json"], {
          terminal: async (t) => {
            await t.waitFor("Cancelled.", { timeoutMs: 10_000 });
          },
          pipeStdout: true,
        });

        expect(r.exitCode).toBe(1);
        // What a pipe reads: nothing, so no prompt text for `jq` to choke on.
        expect(r.stdout).toBe("");
        expect(r.stderr).toContain("--json cannot ask for a confirmation");
        expect(r.stderr).toContain("--yes");
        expect(r.stderr).toContain("Cancelled.");
        expect(startPosts()).toEqual([]);
        expect(dispatchedDatasets()).toEqual([]);
      });

      test("with --yes it runs and standard output is the one JSON document", async () => {
        seedFleet();

        const r = await h.cli([...START, "--all", "--yes", "--json"], {
          terminal: async () => undefined,
          pipeStdout: true,
        });

        expect(r.exitCode).toBe(0);
        const done = JSON.parse(r.stdout) as {
          started: number;
          results: Array<{ outcome: string }>;
        };
        expect(done.started).toBe(4);
        expect(dispatchedDatasets()).toEqual(CANDIDATES);
      });
    },
  );

  test("--all with a dataset id is refused", async () => {
    const r = await h.cli([...START, "nm000480", "--all"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("Give either a dataset id or --all, not both.");
    expect(h.requests).toEqual([]);
  });
});
