/**
 * `nemar admin publish approve` against the publication review (ADR 0102, sections 8 and 9).
 *
 * The real command (`bun run src/index.ts ...`) against the real backend app, over a real D1
 * (`helpers/admin-publish-cli.ts`). What the command printed, what it posted and what the backend
 * recorded are all read from where they really are; GitHub and Resend are the only stand-ins, and
 * no NEMAR answer is canned, so a refusal in these tests is one the Worker or the command made.
 *
 * Two kinds of test, named so a red one says what is missing:
 *
 *  - "the command decides": the CLI refuses, or proceeds, from the review it READ, and the test
 *    asserts what it did before the Worker could. These do not need the Worker's review gate: each
 *    asserts that nothing was posted, or what exactly was.
 *  - "with the Worker's gate": the refusal or the record is the Worker's own (the 409 the command
 *    prints, the override on the row, the web executor's run). These need the gate
 *    (`backend/src/services/publication-review-gate.ts`) and say so in their name.
 *
 * Mutation checks (each turns a named test red): treat `--yes` as `--force` (the `--yes without
 * --force` rows); build the override from a second read (the in-between row); refuse when a
 * recorded override covers (the executor row); let a hard reason through with `--force` (the hard
 * rows); let `--skip-ci-check` stand for `--force` (the skip row); skip the acknowledgment step
 * (the acknowledgment rows); proceed for a blocked request when the flag is off (the blocked
 * rows); refuse a started-publishing run that has `--resume` (the resume rows); drop the override
 * from a retry call (the retry row, "a retry after a 5xx"); exit 0 when the run gives up (the
 * "keeps failing" row); ask the question after a refused read (the "definitive answer" rows);
 * read the banner's release kind from the status again (the "banner names the kind" rows); send no
 * request id by default, or drop it from a retry, or let `--request-id` disagree with the detail
 * (the "run is for the request the command read" rows).
 *
 * CI TIER: unit-pure. Hermetic: an in-process backend over a local database, the CLI spawned
 * against it, stand-ins only at GitHub and Resend, no live network; it sets its own default
 * timeout.
 */

import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  NOTE_SENTINEL,
  SUMMARY_SENTINEL,
  failingReport,
  seedPublicationReview,
  seedScreenedRequest,
  setOverride,
} from "../backend/test/helpers/publication-review";
import { makePublicationReviewApp } from "../backend/test/helpers/publication-review-app";
import { REQUEST_MISMATCH_MESSAGE } from "../shared/contract/publication";
import {
  HARD_REASONS,
  NOT_ASSESSED_LINE,
  REASONS,
  REVIEW_GATE_REFUSAL_TEXT,
  reviewGateRefusalText,
} from "../shared/publication-review";
import { type CliResult, startPublishCli } from "./helpers/admin-publish-cli";
import {
  DATASET,
  hardReport,
  reportWith,
  seedGolden as seedGoldenIn,
  seedReport as seedReportIn,
  twoReasons,
  withheldReport,
} from "./helpers/approve-seeds";

setDefaultTimeout(60_000);

const ADMIN_KEY = "approve-admin-key-0123456789abcdef0123456789abcdef";
const OTHER_ADMIN_KEY = "approve-other-key-0123456789abcdef0123456789abcdef";
const MEMBER_KEY = "approve-member-key-0123456789abcdef0123456789abcdef";
const EXECUTOR_KEY = "approve-executor-key-0123456789abcdef0123456789abcdef";
const APPROVE_PATH = `/admin/publish/${DATASET}/approve`;

const h = startPublishCli();
const api = makePublicationReviewApp();
afterAll(() => h.stop());

/** A POST to the real routes, in this process and over the harness's database, as `key`'s account. */
const direct = async (path: string, key: string, body: Record<string, unknown>) =>
  api.handle(
    new Request(`http://api.test${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    h.env(),
  );

let adminId: number;

beforeEach(async () => {
  h.reset();
  adminId = await h.admin("approveradmin", ADMIN_KEY);
  h.setEnv({ PUBLICATION_REVIEW_ENABLED: "1" });
});

/** Everything the command printed. The spinner writes its verdict to standard error. */
const output = (r: CliResult) => `${r.stdout}\n${r.stderr}`;

const approveBodies = () => h.posted.filter((p) => p.path === APPROVE_PATH).map((p) => p.body);

const requestRow = (id: number) =>
  h.db
    .query<{ status: string; approved_by: number | null }, [number]>(
      "SELECT status, approved_by FROM publication_requests WHERE id = ?",
    )
    .get(id);

const seedGolden = (over?: Parameters<typeof seedGoldenIn>[1]) => seedGoldenIn(h.db, over);
const seedReport = (requestId: number, report?: Record<string, unknown>) =>
  seedReportIn(h.db, requestId, report);

/** A blocked request that never started a step, which the Worker refuses outright. */
const seedBlockedUnstarted = (blockReason: string) => {
  const requestId = seedGolden({ requestStatus: "blocked", blockReason });
  h.db.run("UPDATE publication_requests SET steps_completed = '[]' WHERE id = ?", [requestId]);
  return requestId;
};

const WHY_ACK = "Read the recording formats by hand, nothing to remove";

/** The command's retry wait, shortened to nothing so a test of the retry does not sleep ten seconds. */
const SHORT_RETRY = { NEMAR_APPROVE_RETRY_DELAY_MS: "0" };

const approve = (flags: string[], opts: Parameters<typeof h.cli>[1] = {}) =>
  h.cli(["admin", "publish", "approve", DATASET, ...flags], opts);

describe("the command decides: a pass", () => {
  test("approves, posts no override, and shows the screen and the review first", async () => {
    const requestId = seedGolden();
    seedReport(requestId);

    const r = await approve(["--resume", "--yes"]);

    expect(r.exitCode).toBe(0);
    expect(requestRow(requestId)?.status).toBe("published");
    expect(approveBodies()).toHaveLength(1);
    expect(approveBodies()[0]).not.toHaveProperty("override_publication_review");
    expect(r.stdout).toContain("Identifier screen: clean");
    expect(r.stdout).toContain("Publication review: pass");
    expect(r.stdout).toContain("Gate: enforced");
    expect(r.stdout).toContain(NOT_ASSESSED_LINE);
    // The banner is still the step list the request will run.
    expect(r.stdout).toContain("This will run the following 16-step orchestrator:");
  });

  test("--force over a pass sends nothing: there is nothing to override", async () => {
    const requestId = seedGolden();
    seedReport(requestId);

    const r = await approve(["--resume", "--yes", "--force"]);

    expect(r.exitCode).toBe(0);
    expect(approveBodies()[0]).not.toHaveProperty("override_publication_review");
    expect(requestRow(requestId)?.status).toBe("published");
  });
});

describe("the command decides: a review that is not a pass", () => {
  test("without --force it prints each reason with its cure, exits 1 and posts nothing", async () => {
    const requestId = seedGolden();
    seedReport(requestId, twoReasons());

    const r = await approve(["--resume"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Publication review: FAIL");
    expect(r.stdout).toContain(REASONS.question_failed.sentence.replace(/\.$/, ""));
    expect(r.stdout).toContain(REASONS.version_missing.sentence);
    expect(r.stdout).toContain("Not approved:");
    // The refusal says it in the gate's own words, then names the exact command.
    expect(r.stdout).toContain(reviewGateRefusalText("needs_override", DATASET));
    expect(r.stdout).toContain(`nemar admin publish approve ${DATASET} --resume --force`);
    // The model's own words never reach the approval screen.
    expect(output(r)).not.toContain(SUMMARY_SENTINEL);
    expect(output(r)).not.toContain(NOTE_SENTINEL);
    expect(h.posted).toEqual([]);
    expect(requestRow(requestId)?.status).toBe("requested");
  });

  test("--yes is the answer to the question, not to the reason: without --force it is the same", async () => {
    const requestId = seedGolden();
    seedReport(requestId, twoReasons());

    const r = await approve(["--resume", "--yes"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Not approved:");
    expect(r.stdout).toContain("--force");
    expect(h.posted).toEqual([]);
    expect(requestRow(requestId)?.status).toBe("requested");
  });

  test("--force --yes posts the override of the review shown and exactly the reasons shown", async () => {
    const requestId = seedGolden();
    const reviewId = seedReport(requestId, twoReasons());

    const r = await approve(["--resume", "--yes", "--force"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Approving over: question_failed, version_missing");
    expect(approveBodies()).toHaveLength(1);
    expect(approveBodies()[0]?.override_publication_review).toEqual({
      review_id: reviewId,
      reasons: ["question_failed", "version_missing"],
    });
    expect(requestRow(requestId)?.status).toBe("published");
  });

  test("a hard reason is refused with its cure, even with --force --yes, and nothing is posted", async () => {
    const requestId = seedGolden();
    seedReport(requestId, hardReport());

    const r = await approve(["--resume", "--yes", "--force"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Not approved:");
    expect(r.stdout).toContain(reviewGateRefusalText("hard_reason", DATASET));
    expect(r.stdout).toContain(REASONS.submission_minimum_failed.cure);
    expect(h.posted).toEqual([]);
    expect(requestRow(requestId)?.status).toBe("requested");
  });

  test("--skip-ci-check skips the orchestrator's live check and clears no review reason", async () => {
    const requestId = seedGolden();
    seedReport(requestId, reportWith({ bids: "fail" }));

    const r = await approve(["--resume", "--yes", "--skip-ci-check"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(REASONS.bids_failed_at_review.sentence);
    expect(r.stdout).toContain("Not approved:");
    expect(h.posted).toEqual([]);
    expect(requestRow(requestId)?.status).toBe("requested");
  });

  test("a review that never started is a reason too, and --force names it (no review row: id null)", async () => {
    const requestId = seedGolden();

    const refused = await approve(["--resume", "--yes"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toContain(REASONS.review_not_started.sentence);
    expect(h.posted).toEqual([]);

    const forced = await approve(["--resume", "--yes", "--force"]);
    expect(forced.exitCode).toBe(0);
    expect(approveBodies()[0]?.override_publication_review).toEqual({
      review_id: null,
      reasons: ["review_not_started"],
    });
    expect(requestRow(requestId)?.status).toBe("published");
  });
});

describe("the command decides: what is sent is what was shown", () => {
  test("a reason that comes up after the review was read is not in the override", async () => {
    const requestId = seedGolden();
    const reviewId = seedReport(requestId, twoReasons());
    // Between the command's read of the review and its post, a release of the version appears.
    // The override names the review and the reasons that were SHOWN; the Worker, which is the gate,
    // is the one that sees the new reason (and refuses it: see "with the Worker's gate" below). What
    // this test holds is what the command posted, not the Worker's answer to it.
    h.after(`GET /admin/publish/${DATASET}/review`, () => {
      h.db.run("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, '1.0.0', ?)", [
        DATASET,
        "10.5072/FK2.late",
      ]);
    });

    await approve(["--resume", "--yes", "--force"]);

    expect(approveBodies()).toHaveLength(1);
    expect(approveBodies()[0]?.override_publication_review).toEqual({
      review_id: reviewId,
      reasons: ["question_failed", "version_missing"],
    });
  });

  test("a recorded override that covers the run is enough: no --force, and none is sent", async () => {
    const requestId = seedGolden();
    const reviewId = seedReport(requestId, twoReasons());
    // The web executor's `--yes` run proceeds on the confirmation its clicker recorded; here it is
    // this administrator's own, so the Worker accepts it too.
    setOverride(h.db, reviewId, adminId, ["question_failed", "version_missing"]);

    const r = await approve(["--resume", "--yes"]);

    expect(r.stdout).toContain(`An override by administrator #${adminId}`);
    expect(r.exitCode).toBe(0);
    expect(approveBodies()).toHaveLength(1);
    expect(approveBodies()[0]).not.toHaveProperty("override_publication_review");
    expect(requestRow(requestId)?.status).toBe("published");
  });

  test("a retry after a 5xx sends the override and the acknowledgment again", async () => {
    const requestId = seedGolden({ status: "unchecked" });
    const reviewId = seedReport(requestId, twoReasons());
    // The approval's own request lookup fails once, after the command's reads, and answers 500: the
    // command retries on its own after a wait. A retry that lands before the run is marked
    // approving passes the gates again, so it must carry what the first call carried.
    let armed = false;
    let failed = false;
    h.after(`GET /admin/publish/${DATASET}/review`, () => {
      armed = true;
    });
    h.hookDb({
      statement(sql) {
        if (armed && !failed && /FROM publication_requests/.test(sql)) {
          failed = true;
          throw new Error("simulated read failure");
        }
      },
    });

    const r = await approve(
      ["--resume", "--yes", "--force", "--acknowledge-identifier-screen", WHY_ACK],
      { env: SHORT_RETRY },
    );

    expect(failed).toBe(true);
    expect(output(r)).toContain("Retrying in 0s");
    expect(approveBodies()).toHaveLength(2);
    for (const body of approveBodies()) {
      expect(body?.override_publication_review).toEqual({
        review_id: reviewId,
        reasons: ["question_failed", "version_missing"],
      });
      expect(body?.acknowledge_identifier_screen).toBe(WHY_ACK);
    }
    expect(r.exitCode).toBe(0);
    expect(requestRow(requestId)?.status).toBe("published");
  });
});

describe("a Worker that keeps failing (#1581)", () => {
  test("the command retries, gives up, exits 1, prints the failure and keeps the bug-report hint", async () => {
    const requestId = seedGolden({ status: "unchecked" });
    seedReport(requestId);
    // Every attempt dies on the write that marks the request approving: a 5xx the command may
    // retry, and one that may be a bug, so (unlike a refusal) the hint to report it stays.
    let attempts = 0;
    h.hookDb({
      statement(sql) {
        if (/SET status = 'approving'/.test(sql)) {
          attempts++;
          throw new Error("simulated write failure");
        }
      },
    });

    const r = await approve(["--resume", "--yes", "--acknowledge-identifier-screen", WHY_ACK], {
      env: SHORT_RETRY,
    });

    expect(r.exitCode).toBe(1);
    // Five attempts reached the Worker (the command's whole budget) and all five were a 500.
    expect(attempts).toBe(5);
    expect(approveBodies()).toHaveLength(5);
    expect(h.requests.filter((c) => c.path === APPROVE_PATH).map((c) => c.status)).toEqual([
      500, 500, 500, 500, 500,
    ]);
    expect(output(r).match(/Retrying in 0s/g)).toHaveLength(4);
    expect(output(r)).toContain("attempt 5/5");
    expect(output(r)).toContain("Invalid response from server (status 500)");
    expect(output(r)).toContain("attach the log to a new issue");
    expect(requestRow(requestId)?.status).toBe("requested");
  });
});

describe("the command decides: the screen's acknowledgment is its own flag", () => {
  const WHY = WHY_ACK;

  test("not given: refused before anything is posted, and --force does not stand in for it", async () => {
    const requestId = seedGolden({ status: "unchecked" });
    seedReport(requestId);

    for (const flags of [
      ["--resume", "--yes"],
      ["--resume", "--yes", "--force"],
    ]) {
      const r = await approve(flags);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("Not approved:");
      expect(r.stdout).toContain(REASONS.identifier_screen_needs_acknowledgment.sentence);
      expect(r.stdout).toContain("--acknowledge-identifier-screen");
    }
    expect(h.posted).toEqual([]);
    expect(requestRow(requestId)?.status).toBe("requested");
  });

  test("given: the trimmed reason is posted, with no override, and the run publishes", async () => {
    const requestId = seedGolden({ status: "unchecked" });
    seedReport(requestId);

    const r = await approve(["--resume", "--yes", "--acknowledge-identifier-screen", `  ${WHY}  `]);

    expect(r.exitCode).toBe(0);
    expect(approveBodies()[0]?.acknowledge_identifier_screen).toBe(WHY);
    expect(approveBodies()[0]).not.toHaveProperty("override_publication_review");
    expect(requestRow(requestId)?.status).toBe("published");
  });

  test("the reason is 10 to 500 characters once trimmed: 9 and 501 are refused before anything is posted, 10 and 500 are sent", async () => {
    const requestId = seedGolden({ status: "unchecked" });
    seedReport(requestId);

    for (const reason of ["a".repeat(9), "a".repeat(501)]) {
      const r = await approve(["--resume", "--yes", "--acknowledge-identifier-screen", reason]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("--acknowledge-identifier-screen needs a reason of 10 to 500");
    }
    expect(h.posted).toEqual([]);

    const ten = "b".repeat(10);
    expect(
      (await approve(["--resume", "--yes", "--acknowledge-identifier-screen", ten])).exitCode,
    ).toBe(0);
    expect(approveBodies()[0]?.acknowledge_identifier_screen).toBe(ten);

    h.reset();
    adminId = await h.admin("approveradmin", ADMIN_KEY);
    h.setEnv({ PUBLICATION_REVIEW_ENABLED: "1" });
    seedReport(seedGolden({ status: "unchecked" }));
    const long = "c".repeat(500);
    expect(
      (await approve(["--resume", "--yes", "--acknowledge-identifier-screen", long])).exitCode,
    ).toBe(0);
    expect(approveBodies()[0]?.acknowledge_identifier_screen).toBe(long);
  });

  test("when the review is not a pass either, the refusal says --force is needed as well", async () => {
    const requestId = seedGolden({ status: "unchecked" });
    seedReport(requestId, twoReasons());

    const r = await approve(["--resume", "--yes"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(
      `nemar admin publish approve ${DATASET} --resume --acknowledge-identifier-screen "<reason>" --force`,
    );
    expect(h.posted).toEqual([]);
  });
});

describe("the command decides: a blocked request is refused with the flag off and on", () => {
  for (const flag of ["on", "off"] as const) {
    test(`with the review ${flag}: exits 1 before posting, with the block reason`, async () => {
      if (flag === "off") h.setEnv({ PUBLICATION_REVIEW_ENABLED: "0" });
      const requestId = seedBlockedUnstarted("min_requirements_failed");

      const r = await approve(["--resume", "--yes", "--force"]);

      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("Not approved:");
      expect(r.stdout).toContain("The request is blocked (min_requirements_failed).");
      expect(r.stdout).toContain(REASONS.request_blocked.cure);
      expect(h.posted).toEqual([]);
      expect(requestRow(requestId)?.status).toBe("blocked");
    });
  }
});

describe("the command decides: a blocked run that has started publishing is resumed, not refused", () => {
  // The owner-name walk-back blocks a run half way; the owner fixes the name and the run goes on.
  for (const flag of ["on", "off"] as const) {
    test(`with the review ${flag}: --resume publishes with no override, and without it the cure is --resume`, async () => {
      if (flag === "off") h.setEnv({ PUBLICATION_REVIEW_ENABLED: "0" });
      const requestId = seedGolden({ requestStatus: "blocked", blockReason: "owner_name_missing" });
      seedReport(requestId, failingReport());

      const without = await approve(["--yes"]);
      expect(without.exitCode).toBe(1);
      expect(without.stdout).toContain("This approval has already started publishing.");
      expect(h.posted).toEqual([]);

      const r = await approve(["--resume", "--yes"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("a resume that has started publishing is not gated again");
      expect(approveBodies()[0]).not.toHaveProperty("override_publication_review");
      expect(requestRow(requestId)?.status).toBe("published");
    });
  }
});

describe("the command decides: a run that has started publishing", () => {
  test("without --resume it exits 1 with the resume cure and posts nothing", async () => {
    const requestId = seedGolden({ requestStatus: "approving" });
    seedReport(requestId, failingReport());

    const r = await approve(["--yes"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("This approval has already started publishing.");
    expect(r.stdout).toContain(`nemar admin publish approve ${DATASET} --resume`);
    expect(h.posted).toEqual([]);
  });

  test("with --resume it publishes with no review gate and no override, whatever the review says", async () => {
    const requestId = seedGolden({ requestStatus: "approving" });
    seedReport(requestId, failingReport());

    const r = await approve(["--resume", "--yes"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("a resume that has started publishing is not gated again");
    expect(approveBodies()[0]).not.toHaveProperty("override_publication_review");
    expect(requestRow(requestId)?.status).toBe("published");
  });
});

describe("the command decides: an approval that stopped behind a reason nothing clears", () => {
  const STOPPED =
    "This approval stopped before it started publishing, and a reason that nothing clears now stands, so it cannot be resumed.";

  test("the review says to deny it, under the review and before the refusal, and the hard reason refuses", async () => {
    // A failed-minimum report can land on an `approving` request that has not started publishing,
    // and the request stays `approving`: the move to blocked takes only a request that is waiting.
    const requestId = seedGolden({ requestStatus: "approving" });
    h.db.run("UPDATE publication_requests SET steps_completed = '[]' WHERE id = ?", [requestId]);
    seedReport(requestId, hardReport());

    for (const flags of [["--resume", "--yes", "--force"], ["--yes"]]) {
      const r = await approve(flags);

      expect(r.exitCode).toBe(1);
      const line = `${STOPPED} Deny it with a reason (nemar admin publish deny ${DATASET}); the depositor can request again.`;
      expect(r.stdout).toContain(line);
      // Under the review it belongs to, ahead of the standing line and the refusal.
      const at = (text: string) => r.stdout.indexOf(text);
      expect(at("Publication review: FAIL")).toBeGreaterThanOrEqual(0);
      expect(at("Publication review: FAIL")).toBeLessThan(at(line));
      expect(at(line)).toBeLessThan(at(NOT_ASSESSED_LINE));
      expect(at(NOT_ASSESSED_LINE)).toBeLessThan(at("Not approved:"));
      // The refusal is the hard one, whatever the flags: it names the reason, and nothing posted.
      expect(r.stdout).toContain(REASONS.submission_minimum_failed.sentence.replace(/\.$/, ""));
      expect(h.posted).toEqual([]);
      expect(requestRow(requestId)?.status).toBe("approving");
    }
  });

  test("a request that has started publishing, or that waits for its decision, is not told this", async () => {
    const started = seedGolden({ requestStatus: "approving" });
    seedReport(started, hardReport());
    const resumed = await approve(["--resume", "--yes"]);
    expect(resumed.exitCode).toBe(0);
    expect(resumed.stdout).not.toContain(STOPPED);

    h.reset();
    adminId = await h.admin("approveradmin", ADMIN_KEY);
    h.setEnv({ PUBLICATION_REVIEW_ENABLED: "1" });
    const waiting = seedGolden();
    seedReport(waiting, hardReport());
    const refused = await approve(["--resume", "--yes", "--force"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toContain("Not approved:");
    expect(refused.stdout).not.toContain(STOPPED);
  });
});

describe("the command decides: the evidence behind a reason is read before the question", () => {
  const SHOWN =
    "Shown to the model: README withheld (finding), dataset_description.json sent (9 keys shown, 1 not), CHANGES absent, LICENSE sent (cut), participants.json withheld (finding)";
  const WITHHELD = "Withheld for findings: edf-patient-name 2, local-user-path 1";
  const POINTER = `The whole review, with the model's questions and findings: nemar admin publish show ${DATASET}`;
  const text_withheld = REASONS.text_withheld.sentence.replace(/\.$/, "");

  /** Where `text` is in the output, which it must be: a missing marker is a failure of its own. */
  const at = (r: CliResult, text: string) => {
    const i = r.stdout.indexOf(text);
    expect(i, `"${text}" in the output`).toBeGreaterThanOrEqual(0);
    return i;
  };

  test("without --force: what the model was shown and what was withheld for findings, then the pointer to show, before the refusal", async () => {
    const requestId = seedGolden();
    seedReport(requestId, withheldReport());

    const r = await approve(["--resume"]);

    expect(r.exitCode).toBe(1);
    // In the review block: after the reasons, ahead of the standing line and the refusal.
    expect(at(r, "Publication review: FAIL")).toBeLessThan(at(r, text_withheld));
    expect(at(r, text_withheld)).toBeLessThan(at(r, SHOWN));
    expect(at(r, SHOWN)).toBeLessThan(at(r, WITHHELD));
    expect(at(r, WITHHELD)).toBeLessThan(at(r, POINTER));
    expect(at(r, POINTER)).toBeLessThan(at(r, NOT_ASSESSED_LINE));
    expect(at(r, NOT_ASSESSED_LINE)).toBeLessThan(at(r, "Not approved:"));
    expect(h.posted).toEqual([]);
    expect(requestRow(requestId)?.status).toBe("requested");
  });

  test("with --force --yes: the same lines come before the override note and before the question", async () => {
    const requestId = seedGolden();
    const reviewId = seedReport(requestId, withheldReport());

    const r = await approve(["--resume", "--yes", "--force"]);

    expect(r.exitCode).toBe(0);
    expect(at(r, SHOWN)).toBeLessThan(at(r, WITHHELD));
    expect(at(r, WITHHELD)).toBeLessThan(at(r, POINTER));
    expect(at(r, POINTER)).toBeLessThan(at(r, "Approving over:"));
    expect(at(r, "Approving over:")).toBeLessThan(at(r, "This will run the following"));
    expect(approveBodies()[0]?.override_publication_review).toEqual({
      review_id: reviewId,
      reasons: ["question_failed", "text_withheld", "question_unknown"],
    });
    expect(requestRow(requestId)?.status).toBe("published");
  });

  test("the model's own words stay in show: neither the summary nor a finding's note is printed", async () => {
    const requestId = seedGolden();
    seedReport(requestId, withheldReport());

    // They are in the review, and `show` prints them under their labels; `approve` does not.
    const shown = await h.cli(["admin", "publish", "show", DATASET]);
    expect(shown.stdout).toContain(
      "Summary (written by the model; the depositor's text can steer it):",
    );
    expect(shown.stdout).toContain(SUMMARY_SENTINEL);
    expect(shown.stdout).toContain(NOTE_SENTINEL);

    for (const flags of [["--resume"], ["--resume", "--yes", "--force"]]) {
      const r = await approve(flags);
      expect(output(r)).not.toContain(SUMMARY_SENTINEL);
      expect(output(r)).not.toContain(NOTE_SENTINEL);
      expect(output(r)).not.toContain("Summary (");
      expect(output(r)).not.toContain("Findings (");
    }
  });

  test("a review that withheld nothing prints what was shown and the pointer, and no withheld line", async () => {
    const requestId = seedGolden();
    seedReport(requestId);

    const r = await approve(["--resume", "--yes"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "Shown to the model: README sent, dataset_description.json sent (9 keys shown, 1 not), CHANGES sent, LICENSE sent, participants.json absent",
    );
    expect(r.stdout).toContain(POINTER);
    expect(r.stdout).not.toContain("Withheld for findings");
  });

  test("a review the Worker could not read back has no evidence to print, and the gate still speaks", async () => {
    // A stored report about another commit is read back as no report: the review row exists and its
    // evidence is null in the detail, so `approve` prints no half a block and does not stop short.
    // (A detail whose evidence has another shape cannot be made by this Worker; the reader of that
    // shape is tested on its own in `publication-review-display.unit.test.ts`.)
    const requestId = seedGolden();
    const reviewId = seedReport(requestId, withheldReport());
    h.db.run(
      "UPDATE publication_reviews SET report = json_set(report, '$.evidence.head', ?) WHERE id = ?",
      ["b".repeat(40), reviewId],
    );

    const r = await approve(["--resume"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(REASONS.review_could_not_run.sentence.replace(/\.$/, ""));
    expect(r.stdout).toContain("Not approved:");
    expect(r.stdout).not.toContain("Shown to the model");
    expect(r.stdout).not.toContain("Withheld for findings");
    expect(r.stdout).not.toContain("The whole review");
    expect(h.posted).toEqual([]);
  });

  test("a request with no review row prints neither, nor the pointer", async () => {
    const requestId = seedGolden();

    const r = await approve(["--resume", "--yes", "--force"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(REASONS.review_not_started.sentence);
    expect(r.stdout).not.toContain("Shown to the model");
    expect(r.stdout).not.toContain("Withheld for findings");
    expect(r.stdout).not.toContain("The whole review");
    expect(requestRow(requestId)?.status).toBe("published");
  });
});

describe("the command decides: the banner names the kind of request from the review it read", () => {
  const STATUS_PATH = `/datasets/${DATASET}/publish/status`;
  const ANONYMOUS_BANNER = "This is an ANONYMOUS RELEASE and will run";
  const UNKNOWN_BANNER = "Could not read the request's state";
  /** Fails the request-status route's own read and nothing else. */
  const failStatusReads = () => {
    h.hookDb({
      statement(sql) {
        if (/requested_by_username/.test(sql)) throw new Error("simulated status failure");
      },
    });
  };

  test("an anonymous release is named from the detail, whatever the status read would say", async () => {
    const requestId = seedGolden({ anonymous: true });
    seedPublicationReview(h.db, {
      requestId,
      datasetId: DATASET,
      state: "reported",
      anonymous: true,
    });
    failStatusReads();

    const r = await approve(["--resume"]);

    expect(r.stdout).toContain(ANONYMOUS_BANNER);
    expect(r.stdout).not.toContain(UNKNOWN_BANNER);
    // The detail carries `anonymous`, so the command did not ask a second source.
    expect(h.requests.some((c) => c.path === STATUS_PATH)).toBe(false);
  });

  test("a named publication is named from the detail too, with no status read", async () => {
    const requestId = seedGolden();
    seedReport(requestId);

    const r = await approve(["--resume"]);

    expect(r.stdout).toContain("This will run the following 16-step orchestrator:");
    expect(h.requests.some((c) => c.path === STATUS_PATH)).toBe(false);
  });

  test("with no detail to read, the status read decides, and a failing one says it could not", async () => {
    const requestId = seedGolden({ anonymous: true });
    seedPublicationReview(h.db, {
      requestId,
      datasetId: DATASET,
      state: "reported",
      anonymous: true,
    });
    // The review cannot be read at all: the status read is the only source left.
    h.hookDb({
      statement(sql) {
        if (/FROM publication_reviews/.test(sql)) throw new Error("simulated read failure");
      },
    });
    const fallback = await approve(["--resume"]);
    expect(fallback.stdout).toContain(ANONYMOUS_BANNER);
    expect(h.requests.some((c) => c.path === STATUS_PATH && c.status === 200)).toBe(true);

    h.hookDb({
      statement(sql) {
        if (/FROM publication_reviews/.test(sql) || /requested_by_username/.test(sql)) {
          throw new Error("simulated read failure");
        }
      },
    });
    const neither = await approve(["--resume"]);
    expect(neither.stdout).toContain(UNKNOWN_BANNER);
    expect(neither.stdout).toContain("lists all 16 steps; an anonymous release runs fewer");
  });
});

describe("the command decides: nothing from the review reaches the terminal as an instruction", () => {
  const ESC = String.fromCharCode(27);
  const HOSTILE = `${ESC}[2J${ESC}]0;title\u0007x\u202ey\u200bz`;
  /** Anything a terminal could act on, in a line of output (a line end is the run's own). */
  const DANGEROUS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
  const expectClean = (text: string) => {
    for (const line of text.split("\n")) expect(line).not.toMatch(DANGEROUS);
  };

  // The Worker reduces what it stores, so this is the Worker and the command together; the
  // command's own `plain()` calls are held by `admin-publish-approve-print.test.ts`, which feeds
  // them text the Worker would never send.
  test("hostile text in the stored report, the request and the screen's report is cleaned or left out, with the question and without", async () => {
    const requestId = seedGolden();
    seedReport(requestId, {
      ...failingReport(),
      summary: `Summary ${HOSTILE}`,
      findings: [
        {
          question: "complete_and_honest",
          severity: "blocker",
          code: "readme_mismatch",
          document: "readme",
          note: `Note ${HOSTILE}`,
        },
      ],
    });
    h.db.run("UPDATE publication_requests SET block_reason = ? WHERE id = ?", [HOSTILE, requestId]);

    for (const flags of [["--resume"], ["--resume", "--yes", "--force"]]) {
      const r = await approve(flags);
      expectClean(output(r));
      expect(output(r)).not.toContain("Summary x");
      expect(output(r)).not.toContain("Note x");
    }
  });

  test("a blocked request with a hostile block reason is refused in clean words", async () => {
    seedBlockedUnstarted(HOSTILE);

    const r = await approve(["--resume", "--yes", "--force"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Not approved:");
    expectClean(output(r));
    expect(h.posted).toEqual([]);
  });
});

describe("approve --help-all names every reason nothing clears", () => {
  // The words the help uses for each hard reason. A hard reason the table gains has to be added
  // here, and so to the help: `--force` does not clear it, and the help is where that is said.
  const WORDS: Record<string, string> = {
    request_blocked: "a blocked request",
    submission_minimum_failed: "a failed submission minimum",
    identifier_screen_blocks: "direct identifiers",
    identifier_screen_not_run: "a screen that did not run",
    identifier_screen_pending: "is still running",
    identifier_screen_stale: "is stale",
    version_kept_after_anonymous_release: "a version kept after an anonymous release",
  };

  test("the table of words is the table of hard reasons, and the help says each", async () => {
    expect(Object.keys(WORDS).sort()).toEqual([...HARD_REASONS].sort());

    const r = await h.cli(["admin", "publish", "approve", "--help-all"]);

    expect(r.exitCode).toBe(0);
    const help = r.stdout.replace(/\s+/g, " ");
    for (const [code, words] of Object.entries(WORDS)) expect(help, code).toContain(words);
  });
});

describe("the command decides: a gate that is off or does not apply", () => {
  test("the review off: a stored failing review is advice, --force changes nothing and says so", async () => {
    h.setEnv({ PUBLICATION_REVIEW_ENABLED: "0" });
    const requestId = seedGolden();
    seedReport(requestId, failingReport());

    const r = await approve(["--resume", "--yes", "--force"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Gate: off");
    expect(r.stdout).toContain("--force changes nothing: the review gate is off.");
    expect(approveBodies()[0]).not.toHaveProperty("override_publication_review");
    expect(requestRow(requestId)?.status).toBe("published");
  });

  test("a mirror: the review does not apply, whatever it says", async () => {
    const requestId = seedGolden({ source: "openneuro" });

    const r = await approve(["--resume", "--yes", "--force"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Gate: n/a");
    expect(r.stdout).toContain("--force changes nothing: the review gate is n/a.");
    expect(approveBodies()[0]).not.toHaveProperty("override_publication_review");
    expect(requestRow(requestId)?.status).toBe("published");
  });
});

describe("the command decides: a definitive answer to the read ends it before the question", () => {
  const BUG_HINT = "attach the log to a new issue";

  test("a malformed dataset id is refused before anything is sent", async () => {
    seedReport(seedGolden());

    for (const flags of [["--yes"], ["--yes", "--force"], []]) {
      const r = await h.cli(["admin", "publish", "approve", "nm0004", ...flags]);

      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain('"nm0004" is not a dataset id (like nm000108).');
      expect(output(r)).not.toContain("could not be read");
      expect(output(r)).not.toContain(BUG_HINT);
    }
    expect(h.requests).toEqual([]);
    expect(h.posted).toEqual([]);
  });

  test("a key that is not an administrator's gets the Worker's refusal and exit 1, with and without --yes, and nothing is posted", async () => {
    const requestId = seedGolden();
    seedReport(requestId);
    await h.user("plainmember", "member", MEMBER_KEY);

    for (const flags of [["--resume", "--yes"], ["--resume", "--yes", "--force"], ["--resume"]]) {
      const r = await approve(flags, { as: "plainmember" });

      expect(r.exitCode, flags.join(" ")).toBe(1);
      expect(r.stdout).not.toContain("could not be read");
      expect(r.stdout).not.toContain("This will run the following");
      expect(r.stdout).not.toContain("Cancelled");
      expect(output(r)).toContain("This command requires admin privileges");
      // A refusal is the Worker's answer, not a crash: no invitation to report a bug.
      expect(output(r)).not.toContain(BUG_HINT);
    }
    expect(h.posted).toEqual([]);
    expect(h.requests.map((c) => `${c.method} ${c.path} ${c.status}`)).toEqual([
      `GET /admin/publish/${DATASET}/review 403`,
      `GET /admin/publish/${DATASET}/review 403`,
      `GET /admin/publish/${DATASET}/review 403`,
    ]);
    expect(requestRow(requestId)?.status).toBe("requested");
  });

  test("a 404 for a dataset with no active request is not definitive: the Worker still decides", async () => {
    // The documented choice (`readReview`): `no_request` goes on, so the Worker's own answer ends it.
    seedScreenedRequest(h.db, { datasetId: DATASET });
    h.db.run("DELETE FROM publication_requests");

    const r = await approve(["--resume", "--yes"]);

    expect(r.exitCode).toBe(1);
    expect(h.posted.filter((p) => p.path === APPROVE_PATH)).toHaveLength(1);
  });
});

describe("the command decides: a review that cannot be read is the Worker's to judge", () => {
  const failReads = () =>
    h.hookDb({
      statement(sql) {
        if (/FROM publication_reviews/.test(sql)) throw new Error("simulated read failure");
      },
    });

  test("the command says so, and sends no override even with --force: nothing was shown to override", async () => {
    const requestId = seedGolden();
    seedReport(requestId, failingReport());
    failReads();

    const r = await approve(["--resume", "--yes", "--force"]);

    expect(r.stdout).toContain(
      "The publication review could not be read (HTTP 500); the API still checks it.",
    );
    // It says the flag was not sent, so the Worker's "approve over it with --force" is not a
    // contradiction of what the administrator typed.
    expect(r.stdout).toContain("--force was not sent: no review could be read to approve over.");
    // It went on to the Worker, which is the gate, and sent no override of its own making.
    expect(approveBodies().length).toBeGreaterThan(0);
    for (const body of approveBodies()) {
      expect(body).not.toHaveProperty("override_publication_review");
    }
    expect(h.requests.find((c) => c.path === `/admin/publish/${DATASET}/review`)?.status).toBe(500);
  });

  test("a dataset with no active request: the Worker's 404 is what ends it", async () => {
    seedScreenedRequest(h.db, { datasetId: DATASET });
    h.db.run("DELETE FROM publication_requests");

    const r = await approve(["--resume", "--yes"]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(
      `No active publication request was found for ${DATASET}; the API decides.`,
    );
    expect(output(r)).toContain("No active publication request found");
    expect(h.requests.at(-1)?.status).toBe(404);
    expect(r.stdout).not.toContain("--force was not sent");

    const forced = await approve(["--resume", "--yes", "--force"]);
    expect(forced.exitCode).toBe(1);
    expect(forced.stdout).toContain(
      "--force was not sent: no review could be read to approve over.",
    );
  });
});

describe("with the Worker's gate: what the Worker refuses is printed, and exits 1", () => {
  test("the review cannot be read by the Worker either: it refuses unverified, the command prints that", async () => {
    const requestId = seedGolden();
    seedReport(requestId);
    h.hookDb({
      statement(sql) {
        if (/FROM publication_reviews/.test(sql)) throw new Error("simulated read failure");
      },
    });

    const r = await approve(["--resume", "--yes"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain(REVIEW_GATE_REFUSAL_TEXT.unverified);
    expect(requestRow(requestId)?.status).toBe("requested");
    expect(requestRow(requestId)?.approved_by).toBeNull();
  });

  test("a blocked request the command could not see is refused by the Worker with the block reason", async () => {
    const requestId = seedBlockedUnstarted("min_requirements_failed");
    h.hookDb({
      statement(sql) {
        if (/FROM publication_reviews/.test(sql)) throw new Error("simulated read failure");
      },
    });

    const r = await approve(["--resume", "--yes", "--force"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("The request is blocked");
    expect(h.requests.filter((c) => c.path === APPROVE_PATH).map((c) => c.status)).toEqual([409]);
    expect(requestRow(requestId)?.status).toBe("blocked");
  });

  test("a refusal prints each reason as the review above it worded it, not as the closed words", async () => {
    const requestId = seedGolden();
    const reviewId = seedReport(requestId, withheldReport());
    // Another administrator's record names every reason, so this run goes to the Worker with no
    // override and the Worker refuses with all three reasons in its body.
    const otherId = await h.admin("otheradmin", OTHER_ADMIN_KEY);
    setOverride(h.db, reviewId, otherId, ["question_failed", "text_withheld", "question_unknown"]);
    const shown = JSON.parse((await h.cli(["admin", "publish", "show", DATASET, "--json"])).stdout);

    const r = await approve(["--resume", "--yes"], { as: "approveradmin" });

    expect(r.exitCode).toBe(1);
    expect(h.requests.filter((c) => c.path === APPROVE_PATH).map((c) => c.status)).toEqual([409]);
    for (const reason of shown.reasons as Array<{
      code: keyof typeof REASONS;
      sentence: string;
      cure: string;
      line?: string;
    }>) {
      // What the CLI prints is the whole line the Worker sent; a Worker that sends none gets the
      // sentence and the cure, never the closed words.
      expect(output(r), reason.code).toContain(reason.line ?? `${reason.sentence} ${reason.cure}`);
      if (reason.line !== undefined) {
        // ... and that line is one the review above the question printed (a reason that stands
        // twice, as `question_unknown` does for two questions, has two lines).
        expect(shown.description.lines as string[], reason.code).toContain(reason.line);
      }
    }
    // The words for a person, not the closed ones behind them.
    expect(output(r)).toContain("(README, participants.json)");
    expect(output(r)).not.toContain("(readme, participants_json)");
  });

  test("--force records the override on the review it was shown, for the reasons shown", async () => {
    const requestId = seedGolden();
    const reviewId = seedReport(requestId, twoReasons());

    const r = await approve(["--resume", "--yes", "--force"]);

    expect(r.exitCode).toBe(0);
    const row = h.db
      .query<{ override_by: number | null; override_reasons: string | null }, [number]>(
        "SELECT override_by, override_reasons FROM publication_reviews WHERE id = ?",
      )
      .get(reviewId);
    expect(row?.override_by).toBe(adminId);
    expect(JSON.parse(row?.override_reasons ?? "[]")).toEqual([
      "question_failed",
      "version_missing",
    ]);
    const audit = h.db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'publication_review_overridden'",
      )
      .get();
    expect(audit?.n).toBe(1);
  });

  test("a reason that came up after it was shown is refused, the sentence and the new reason are printed", async () => {
    const requestId = seedGolden();
    const reviewId = seedReport(requestId, twoReasons());
    // Between the command's read of the review and its approval, a release of the version appears.
    h.after(`GET /admin/publish/${DATASET}/review`, () => {
      h.db.run("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, '1.0.0', ?)", [
        DATASET,
        "10.5072/FK2.late",
      ]);
    });

    const r = await approve(["--resume", "--yes", "--force"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain(REVIEW_GATE_REFUSAL_TEXT.override_not_covering.split(" (nemar")[0]);
    expect(output(r)).toContain(REASONS.version_already_released.sentence);
    expect(output(r)).toContain(`Next: nemar admin publish show ${DATASET}`);
    expect(h.requests.filter((c) => c.path === APPROVE_PATH).map((c) => c.status)).toEqual([409]);
    const row = h.db
      .query<{ override_by: number | null }, [number]>(
        "SELECT override_by FROM publication_reviews WHERE id = ?",
      )
      .get(reviewId);
    expect(row?.override_by).toBeNull();
    expect(requestRow(requestId)?.status).toBe("requested");
  });

  test("--skip-ci-check over a BIDS reason needs --force, and the skip is recorded in the audit row", async () => {
    const requestId = seedGolden();
    seedReport(requestId, reportWith({ bids: "fail" }));

    const r = await approve(["--resume", "--yes", "--force", "--skip-ci-check"]);

    expect(r.exitCode).toBe(0);
    expect(requestRow(requestId)?.status).toBe("published");
    const published = h.db
      .query<{ details: string }, []>(
        "SELECT details FROM audit_log WHERE action = 'dataset_published' ORDER BY id DESC LIMIT 1",
      )
      .get();
    const details = JSON.parse(published?.details ?? "{}");
    expect(details.skip_ci_check).toBe(true);
    expect(details.review_gate).toBe("enforced");
  });

  test("a --yes run with no dispatch token does not ride on the clicker's recorded override: refused, and the click's claim is intact", async () => {
    // The flip of the earlier pin (#1604, ADR 0103 decisions 4 and 6). The clicker's override
    // covers the clicker's run, which is the one that carries the click's token
    // (admin-publish-approve-token-cli.test.ts); the same command without it is its caller's own
    // act, and the caller has no override.
    const requestId = seedGolden();
    const reviewId = seedReport(requestId, twoReasons());
    await h.admin("executor", EXECUTOR_KEY);
    // The clicker's confirmation, recorded through the real route (the page's body) before the
    // executor runs; the claim it leaves is a live one, but only the token proves a call is its run.
    const dispatched = await direct(`/admin/publish/${DATASET}/approve-dispatch`, ADMIN_KEY, {
      override_publication_review: {
        review_id: reviewId,
        reasons: ["question_failed", "version_missing"],
      },
    });
    expect(dispatched.status).toBe(202);
    const claim = h.db
      .query<
        { approval_requested_by: number | null; approval_dispatched_at: string | null },
        [number]
      >(
        "SELECT approval_requested_by, approval_dispatched_at FROM publication_requests WHERE id = ?",
      )
      .get(requestId);

    const r = await approve(["--resume", "--yes"], { as: "executor" });

    expect(r.stdout).toContain(`An override by administrator #${adminId}`);
    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain(REVIEW_GATE_REFUSAL_TEXT.needs_override.split(" Read it")[0]);
    expect(h.requests.filter((c) => c.path === APPROVE_PATH).map((c) => c.status)).toEqual([409]);
    expect(approveBodies()).toHaveLength(1);
    expect(approveBodies()[0]).not.toHaveProperty("override_publication_review");
    expect(h.posted.filter((p) => p.path === APPROVE_PATH)[0]?.dispatchToken).toBe(false);
    expect(requestRow(requestId)?.status).toBe("requested");
    expect(requestRow(requestId)?.approved_by).toBeNull();
    // Nothing was taken over: the executor the click dispatched can still carry out the click.
    expect(
      h.db
        .query<
          { approval_requested_by: number | null; approval_dispatched_at: string | null },
          [number]
        >(
          "SELECT approval_requested_by, approval_dispatched_at FROM publication_requests WHERE id = ?",
        )
        .get(requestId),
    ).toEqual(claim);
  });

  test("another administrator's recorded override covers nothing for this run: the Worker refuses and the command prints it", async () => {
    const requestId = seedGolden();
    const reviewId = seedReport(requestId, twoReasons());
    const otherId = await h.admin("otheradmin", OTHER_ADMIN_KEY);
    setOverride(h.db, reviewId, otherId, ["question_failed", "version_missing"]);

    // The command cannot know whose key is whose, so it goes on; the Worker is the gate.
    const r = await approve(["--resume", "--yes"], { as: "approveradmin" });

    expect(r.stdout).toContain(`An override by administrator #${otherId}`);
    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain(REVIEW_GATE_REFUSAL_TEXT.needs_override.split(" Read it")[0]);
    expect(output(r)).toContain(REASONS.question_failed.sentence.replace(/\.$/, ""));
    expect(h.requests.filter((c) => c.path === APPROVE_PATH).map((c) => c.status)).toEqual([409]);
    expect(requestRow(requestId)?.status).toBe("requested");
  });
});

describe("the run is for the request the command read (#1579)", () => {
  test("sends the request id of the detail it showed, with the rest of the body", async () => {
    const requestId = seedGolden();
    seedReport(requestId);

    const r = await approve(["--resume", "--yes"]);

    expect(r.exitCode).toBe(0);
    expect(approveBodies()).toHaveLength(1);
    expect(approveBodies()[0]?.request_id).toBe(requestId);
    expect(approveBodies()[0]?.resume).toBe(true);
    expect(requestRow(requestId)?.status).toBe("published");
  });

  test("a request denied and filed again between the command's read and its approval is refused, and the new request is untouched", async () => {
    // The dangerous direction: the administrator read request 1 and said yes, but while the
    // question stood the depositor's request was denied and a new one filed. Without the id the
    // run finds the newest active request by itself and approves one nobody read.
    const first = seedGolden();
    seedReport(first);
    let second = 0;
    h.after(`GET /admin/publish/${DATASET}/review`, () => {
      h.db.run("UPDATE publication_requests SET status = 'denied' WHERE id = ?", [first]);
      second = seedGolden();
      seedReport(second);
    });

    const r = await approve(["--resume", "--yes"]);

    expect(second).toBeGreaterThan(first);
    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain(REQUEST_MISMATCH_MESSAGE);
    // One call, refused as a 409 that is not retried, and it named the request that was read.
    expect(h.requests.filter((c) => c.path === APPROVE_PATH).map((c) => c.status)).toEqual([409]);
    expect(approveBodies()).toHaveLength(1);
    expect(approveBodies()[0]?.request_id).toBe(first);
    expect(requestRow(second)).toEqual({ status: "requested", approved_by: null });
    expect(requestRow(first)).toEqual({ status: "denied", approved_by: null });
    const published = h.db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'dataset_published'",
      )
      .get();
    expect(published?.n).toBe(0);
  });

  test("a retry after a 5xx names the request again", async () => {
    const requestId = seedGolden({ status: "unchecked" });
    seedReport(requestId);
    // The approval's own request lookup fails once, after the command's reads, and answers 500:
    // the command retries by itself, and the retry is a call like the first.
    let armed = false;
    let failed = false;
    h.after(`GET /admin/publish/${DATASET}/review`, () => {
      armed = true;
    });
    h.hookDb({
      statement(sql) {
        if (armed && !failed && /FROM publication_requests/.test(sql)) {
          failed = true;
          throw new Error("simulated read failure");
        }
      },
    });

    const r = await approve(["--resume", "--yes", "--acknowledge-identifier-screen", WHY_ACK], {
      env: SHORT_RETRY,
    });

    expect(failed).toBe(true);
    expect(output(r)).toContain("Retrying in 0s");
    expect(approveBodies()).toHaveLength(2);
    for (const body of approveBodies()) expect(body?.request_id).toBe(requestId);
    expect(r.exitCode).toBe(0);
    expect(requestRow(requestId)?.status).toBe("published");
  });

  /** A review this version of the command cannot read: no detail, so no request id of its own. */
  const unreadableReview = () =>
    h.rewrite(`GET /admin/publish/${DATASET}/review`, (body) => {
      body.gate = "something-newer";
    });

  test("--request-id is not sent when the review could not be read and none was named", async () => {
    seedReport(seedGolden());
    unreadableReview();

    const without = await approve(["--resume", "--yes"]);

    expect(without.exitCode).toBe(0);
    expect(approveBodies()).toHaveLength(1);
    expect(approveBodies()[0]).not.toHaveProperty("request_id");
  });

  test("--request-id names it when the review could not be read", async () => {
    const requestId = seedGolden();
    seedReport(requestId);
    unreadableReview();

    const named = await approve(["--resume", "--yes", "--request-id", String(requestId)]);

    expect(named.exitCode).toBe(0);
    expect(approveBodies()).toHaveLength(1);
    expect(approveBodies()[0]?.request_id).toBe(requestId);
  });

  test("--request-id that agrees with the detail it read is sent as it is", async () => {
    const requestId = seedGolden();
    seedReport(requestId);

    const r = await approve(["--resume", "--yes", "--request-id", String(requestId)]);

    expect(r.exitCode).toBe(0);
    expect(approveBodies()[0]?.request_id).toBe(requestId);
  });

  test("--request-id that disagrees with the detail it read is refused locally, with nothing posted", async () => {
    const requestId = seedGolden();
    seedReport(requestId);

    const r = await approve(["--resume", "--yes", "--request-id", String(requestId + 5)]);

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(`#${requestId + 5}`);
    expect(r.stdout).toContain(`#${requestId}`);
    // It was refused before the banner and the question, and before any write. The review was
    // read (that is how the command knew the request in force), so the sentence says that no
    // approval was sent, not that nothing was.
    expect(r.stdout).not.toContain("This will run the following");
    expect(r.stdout).toContain("No approval was sent.");
    expect(r.stdout).not.toContain("Nothing was sent");
    expect(h.requests.length).toBeGreaterThan(0);
    expect(h.requests.every((c) => c.method === "GET")).toBe(true);
    expect(h.posted).toEqual([]);
    expect(requestRow(requestId)?.status).toBe("requested");
  });

  test.each(["0", "-4", "1.5", "7abc", "abc", ""])(
    "--request-id %p is not a request id: refused before anything is sent",
    async (value) => {
      const requestId = seedGolden();
      seedReport(requestId);

      const r = await approve(["--resume", "--yes", "--request-id", value]);

      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("--request-id needs a request number");
      expect(h.posted).toEqual([]);
      expect(h.requests).toEqual([]);
      expect(requestRow(requestId)?.status).toBe("requested");
    },
  );
});
