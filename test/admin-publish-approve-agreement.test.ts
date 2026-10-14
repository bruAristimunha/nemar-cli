/**
 * `decideApproval` and the Worker's review gate agree (ADR 0102, sections 8 and 9; the rule the
 * command's design rests on).
 *
 * The command decides from the review it READ; the Worker decides from the review it derives when
 * `POST /approve` arrives. The command is allowed to be more permissive than the Worker (the
 * Worker is the gate, and the command only explains), but never stricter, and what it sends has
 * to be accepted. This file holds that to a table of seeded scenarios, each one read and decided
 * by the real code on both sides:
 *
 *  - the detail comes from the real `GET /admin/publish/:id/review`, parsed as the command parses
 *    it, and `decideApproval` decides from it with the administrator's flags;
 *  - where it PROCEEDS, the request it would send (its override, the acknowledgment, `resume`) is
 *    posted to the real `POST /approve`, and the Worker must accept it, except for a scenario that
 *    names, in `workerRefuses`, a refusal the command cannot know of (another administrator's
 *    recorded override) and says why that is allowed;
 *  - where it REFUSES, the request it declined to send is posted and the Worker must refuse it
 *    too, in the closed word the scenario names; and where the refusal is a missing flag
 *    (`--force`, `--acknowledge-identifier-screen`, `--resume`), the same scenario decided again
 *    WITH the flag must proceed and be accepted, so the cure the command names is one that works.
 *
 * Every Worker answer is read off the real route over a real D1 (`helpers/admin-publish-cli.ts`);
 * GitHub is the only stand-in. A scenario that goes red here is a disagreement, not a flaky test:
 * either the command would refuse what the Worker passes, or it would send what the Worker
 * rejects.
 *
 * CI TIER: unit-pure. Hermetic: an in-process backend over a local database, the CLI spawned
 * against it, stand-ins only at GitHub and Resend, no live network; it sets its own default
 * timeout. It needs the Worker's review gate
 * (`backend/src/services/publication-review-gate.ts`), which refuses with the shared words.
 */

import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  failingReport,
  seedPublicationReview,
  seedScreenedRequest,
  setOverride,
} from "../backend/test/helpers/publication-review";
import { makePublicationReviewApp } from "../backend/test/helpers/publication-review-app";
import type { PublicationReviewOverride } from "../shared/contract/publication-review-admin";
import { uncoveredByOverride } from "../shared/publication-review";
import {
  type ApproveOptions,
  type ApproveRefusal,
  decideApproval,
  parseReviewDetail,
} from "../src/lib/publication-review-approve";
import { startPublishCli } from "./helpers/admin-publish-cli";
import {
  DATASET,
  hardReport,
  reportWith,
  seedGolden,
  seedReport,
  twoReasons,
} from "./helpers/approve-seeds";

setDefaultTimeout(60_000);

const KEY = "agree-admin-key-0123456789abcdef0123456789abcdef";
const OTHER_KEY = "agree-other-key-0123456789abcdef0123456789abcdef";
const WHY = "Read the recording formats by hand, nothing to remove";

const h = startPublishCli();
const api = makePublicationReviewApp();
afterAll(() => h.stop());

interface World {
  db: Database;
  adminId: number;
  otherId: number;
}

interface Scenario {
  name: string;
  /** The review is on unless a scenario says it is off. */
  flag?: "off";
  /** Seeds the request (and whatever the scenario is about) over a fresh database. */
  seed(w: World): void;
  /** The administrator's flags; `resume` is on unless a scenario says otherwise. */
  options?: Partial<ApproveOptions>;
  /** What `decideApproval` must say, so a scenario cannot drift into a different case. */
  decision: "proceed" | ApproveRefusal;
  /** For a proceed: whether it sends an override. */
  override?: "some" | "none";
  /**
   * For a proceed the Worker is ALLOWED to refuse: the closed word it refuses with. The command
   * cannot know whose key a recorded override belongs to, so it goes on and the Worker decides.
   */
  workerRefuses?: string;
  /** For a refusal: the closed word the Worker refuses the request the command declined to send with. */
  workerRefusal?: string;
  /** Before the Worker is asked. */
  setup?(): void;
}

/** A request on the golden path: every step but the two no-ops done. */
const golden = (w: World, over?: Parameters<typeof seedGolden>[1]) => seedGolden(w.db, over);

/** A blocked request that never started a step: the Worker refuses it outright. */
const blockedUnstarted = (w: World, blockReason: string) => {
  const requestId = golden(w, { requestStatus: "blocked", blockReason });
  w.db.run("UPDATE publication_requests SET steps_completed = '[]' WHERE id = ?", [requestId]);
  return requestId;
};

const SCENARIOS: Scenario[] = [
  // ---- a pass, and what needs no override ------------------------------------------------------
  {
    name: "a pass",
    seed: (w) => seedReport(w.db, golden(w)),
    decision: "proceed",
    override: "none",
  },
  {
    name: "--force over a pass sends nothing",
    seed: (w) => seedReport(w.db, golden(w)),
    options: { force: true },
    decision: "proceed",
    override: "none",
  },

  // ---- a review that is not a pass: the force is the administrator's act -----------------------
  {
    name: "a failed question and no Version, without --force",
    seed: (w) => seedReport(w.db, golden(w), twoReasons()),
    decision: "needs_force",
    workerRefusal: "needs_override",
  },
  {
    name: "a failed question and no Version, with --force",
    seed: (w) => seedReport(w.db, golden(w), twoReasons()),
    options: { force: true },
    decision: "proceed",
    override: "some",
  },
  {
    name: "a review that never started, without --force",
    seed: (w) => void golden(w),
    decision: "needs_force",
    workerRefusal: "needs_override",
  },
  {
    name: "a review that never started, with --force (no review row: the id is null)",
    seed: (w) => void golden(w),
    options: { force: true },
    decision: "proceed",
    override: "some",
  },
  {
    name: "a review that is running, with --force",
    seed: (w) => {
      const requestId = golden(w);
      seedPublicationReview(w.db, {
        requestId,
        datasetId: DATASET,
        state: "dispatched",
        createdMinutesAgo: 5,
      });
    },
    options: { force: true },
    decision: "proceed",
    override: "some",
  },
  {
    name: "BIDS failed at the reviewed commit, without --force (--skip-ci-check is not an input)",
    seed: (w) => seedReport(w.db, golden(w), reportWith({ bids: "fail" })),
    decision: "needs_force",
    workerRefusal: "needs_override",
  },
  {
    name: "a version released since the review ran",
    seed: (w) => {
      seedReport(w.db, golden(w));
      w.db.run("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, '1.0.0', ?)", [
        DATASET,
        "10.5072/FK2.agree",
      ]);
    },
    options: { force: true },
    decision: "proceed",
    override: "some",
  },
  {
    name: "a concept DOI that no anonymous release reserved",
    seed: (w) => {
      seedReport(w.db, golden(w));
      w.db.run("UPDATE datasets SET concept_doi = '10.5072/FK2.agree' WHERE dataset_id = ?", [
        DATASET,
      ]);
    },
    options: { force: true },
    decision: "proceed",
    override: "some",
  },

  // ---- what nothing clears ---------------------------------------------------------------------
  {
    name: "a failed submission minimum, even with --force",
    seed: (w) => seedReport(w.db, golden(w), hardReport()),
    options: { force: true },
    decision: "hard",
    workerRefusal: "hard_reason",
  },
  {
    name: "a named publication that keeps the version of an earlier anonymous release",
    seed: (w) => {
      seedScreenedRequest(w.db, {
        datasetId: DATASET,
        anonymous: true,
        requestStatus: "published",
      });
      seedReport(w.db, golden(w));
      w.db.run("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, '1.0.0', ?)", [
        DATASET,
        "10.5072/FK2.anon",
      ]);
    },
    options: { force: true },
    decision: "hard",
    workerRefusal: "hard_reason",
  },
  {
    name: "a stopped approval that keeps the version of an earlier anonymous release",
    seed: (w) => {
      seedScreenedRequest(w.db, {
        datasetId: DATASET,
        anonymous: true,
        requestStatus: "published",
      });
      const requestId = golden(w, { requestStatus: "approving" });
      w.db.run("UPDATE publication_requests SET steps_completed = '[]' WHERE id = ?", [requestId]);
      seedReport(w.db, requestId);
      w.db.run("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, '1.0.0', ?)", [
        DATASET,
        "10.5072/FK2.anon",
      ]);
    },
    // The run stopped before it published, so it is gated again and the version row is an
    // earlier release's: the detail shows the hard reason, and the Worker refuses it as the command does.
    options: { force: true },
    decision: "hard",
    workerRefusal: "hard_reason",
  },
  {
    name: "direct identifiers: the screen's gate answers before the review's",
    seed: (w) => seedReport(w.db, golden(w, { status: "direct-identifiers" })),
    options: { force: true },
    decision: "hard",
    workerRefusal: "identifier_screen_not_clear",
  },
  {
    name: "a screen that did not run",
    seed: (w) => seedReport(w.db, golden(w, { status: "error" })),
    options: { force: true },
    decision: "hard",
    workerRefusal: "identifier_screen_not_clear",
  },
  {
    name: "a blocked request that never started, with the review on",
    seed: (w) => seedReport(w.db, blockedUnstarted(w, "ci_failed")),
    options: { force: true },
    decision: "blocked",
    workerRefusal: "request_blocked",
  },
  {
    name: "a blocked request that has started publishing (the owner-name walk-back), resumed",
    seed: (w) =>
      seedReport(w.db, golden(w, { requestStatus: "blocked", blockReason: "owner_name_missing" })),
    // The Worker refuses a blocked request only when no step beyond the validation ones ran, and
    // skips every gate for one that did, as it does for an `approving` run.
    decision: "proceed",
    override: "none",
  },
  {
    name: "a blocked request that has started publishing, without --resume",
    seed: (w) =>
      seedReport(w.db, golden(w, { requestStatus: "blocked", blockReason: "owner_name_missing" })),
    options: { resume: false },
    decision: "needs_resume",
  },
  {
    name: "a blocked request with only the validation steps done, resumed",
    seed: (w) => {
      const requestId = blockedUnstarted(w, "ci_failed");
      w.db.run("UPDATE publication_requests SET steps_completed = ? WHERE id = ?", [
        JSON.stringify(["ci_check", "enrichment_check"]),
        requestId,
      ]);
    },
    options: { force: true },
    decision: "blocked",
    workerRefusal: "request_blocked",
  },
  {
    name: "a blocked request that never started, with the review off",
    flag: "off",
    seed: (w) => void blockedUnstarted(w, "min_requirements_failed"),
    decision: "blocked",
    workerRefusal: "request_blocked",
  },

  // ---- the screen's acknowledgment is its own flag ---------------------------------------------
  {
    name: "an acknowledgment needed and not given",
    seed: (w) => seedReport(w.db, golden(w, { status: "unchecked" })),
    decision: "needs_ack",
    workerRefusal: "identifier_screen_not_clear",
  },
  {
    name: "an acknowledgment given over a pass",
    seed: (w) => seedReport(w.db, golden(w, { status: "unchecked" })),
    options: { acknowledge: WHY },
    decision: "proceed",
    override: "none",
  },
  {
    name: "an acknowledgment given, over a failing review, with --force",
    seed: (w) => seedReport(w.db, golden(w, { status: "unchecked" }), twoReasons()),
    options: { acknowledge: WHY, force: true },
    decision: "proceed",
    override: "some",
  },
  {
    name: "an acknowledgment given, over a failing review, without --force",
    seed: (w) => seedReport(w.db, golden(w, { status: "unchecked" }), twoReasons()),
    options: { acknowledge: WHY },
    decision: "needs_force",
    workerRefusal: "needs_override",
  },

  {
    name: "an acknowledgment this administrator recorded earlier is enough",
    seed: (w) => {
      const requestId = golden(w, { status: "unchecked" });
      seedReport(w.db, requestId);
      w.db.run(
        `UPDATE publication_requests
            SET identifier_screen_ack_by = ?, identifier_screen_ack_reason = ?,
                identifier_screen_ack_at = datetime('now')
          WHERE id = ?`,
        [w.adminId, WHY, requestId],
      );
    },
    decision: "proceed",
    override: "none",
  },
  {
    name: "an acknowledgment another administrator recorded: the command goes on, the Worker decides",
    seed: (w) => {
      const requestId = golden(w, { status: "unchecked" });
      seedReport(w.db, requestId);
      w.db.run(
        `UPDATE publication_requests
            SET identifier_screen_ack_by = ?, identifier_screen_ack_reason = ?,
                identifier_screen_ack_at = datetime('now')
          WHERE id = ?`,
        [w.otherId, WHY, requestId],
      );
    },
    decision: "proceed",
    override: "none",
    // An acknowledgment counts only for the administrator who gave it, and the command cannot
    // know whose key is whose.
    workerRefuses: "identifier_screen_not_clear",
  },

  // ---- a run that has started publishing, and the gate that is off ------------------------------
  {
    name: "a run that has started publishing, resumed, over a failing review",
    seed: (w) => seedReport(w.db, golden(w, { requestStatus: "approving" }), failingReport()),
    decision: "proceed",
    override: "none",
  },
  {
    name: "a run that has started publishing, without --resume",
    seed: (w) => seedReport(w.db, golden(w, { requestStatus: "approving" }), failingReport()),
    options: { resume: false },
    decision: "needs_resume",
  },
  {
    name: "the review off: a stored failing review is advice",
    flag: "off",
    seed: (w) => seedReport(w.db, golden(w), failingReport()),
    options: { force: true },
    decision: "proceed",
    override: "none",
  },
  {
    name: "a mirror: the review does not apply",
    seed: (w) => void golden(w, { source: "openneuro" }),
    options: { force: true },
    decision: "proceed",
    override: "none",
  },

  // ---- a recorded override ---------------------------------------------------------------------
  {
    name: "an override this administrator recorded covers the run",
    seed: (w) => {
      const reviewId = seedReport(w.db, golden(w), twoReasons());
      setOverride(w.db, reviewId, w.adminId, ["question_failed", "version_missing"]);
    },
    decision: "proceed",
    override: "none",
  },
  {
    name: "an override another administrator recorded: the command goes on, the Worker decides",
    seed: (w) => {
      const reviewId = seedReport(w.db, golden(w), twoReasons());
      setOverride(w.db, reviewId, w.otherId, ["question_failed", "version_missing"]);
    },
    decision: "proceed",
    override: "none",
    // The command cannot know whose key is whose; an override covers only its own approver's run.
    workerRefuses: "needs_override",
  },
  {
    name: "a recorded override that misses one reason",
    seed: (w) => {
      const reviewId = seedReport(w.db, golden(w), twoReasons());
      setOverride(w.db, reviewId, w.adminId, ["question_failed"]);
    },
    decision: "needs_force",
    workerRefusal: "needs_override",
  },

  // ---- an approval that stopped before it published, and a review still running -----------------
  {
    name: "a stopped approval over a review that is still running, with --force",
    seed: (w) => {
      const requestId = golden(w, { requestStatus: "approving" });
      w.db.run("UPDATE publication_requests SET steps_completed = '[]' WHERE id = ?", [requestId]);
      seedPublicationReview(w.db, {
        requestId,
        datasetId: DATASET,
        state: "dispatched",
        createdMinutesAgo: 10,
      });
    },
    // The gate lets the run through and the stand-in's failing BIDS run stops it at `ci_check`:
    // the proof that it got past the gate.
    setup: () => {
      h.bidsConclusion.value = "failure";
    },
    options: { force: true },
    decision: "proceed",
    override: "some",
  },
  {
    name: "a stopped approval over a review that is still running, without --force",
    seed: (w) => {
      const requestId = golden(w, { requestStatus: "approving" });
      w.db.run("UPDATE publication_requests SET steps_completed = '[]' WHERE id = ?", [requestId]);
      seedPublicationReview(w.db, {
        requestId,
        datasetId: DATASET,
        state: "dispatched",
        createdMinutesAgo: 10,
      });
    },
    // Cured with --force the gate lets the run through, and the failing BIDS run stops it.
    setup: () => {
      h.bidsConclusion.value = "failure";
    },
    decision: "needs_force",
    workerRefusal: "needs_override",
  },
];

// ---------------------------------------------------------------------------------------------
// The two sides
// ---------------------------------------------------------------------------------------------

async function world(s: Scenario): Promise<World> {
  h.reset();
  const adminId = await h.admin("agreeadmin", KEY);
  const otherId = await h.admin("agreeother", OTHER_KEY);
  if (s.flag !== "off") h.setEnv({ PUBLICATION_REVIEW_ENABLED: "1" });
  const w = { db: h.db, adminId, otherId };
  s.seed(w);
  s.setup?.();
  return w;
}

const call = (path: string, init: RequestInit = {}) =>
  api.handle(
    new Request(`http://api.test${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    }),
    h.env(),
  );

/** The detail the command reads, parsed as the command parses it. */
async function readDetail() {
  const res = await call(`/admin/publish/${DATASET}/review`);
  expect(res.status).toBe(200);
  const detail = parseReviewDetail(await res.json());
  expect(detail).not.toBeNull();
  return detail as NonNullable<typeof detail>;
}

interface Sent {
  resume: boolean;
  acknowledge?: string;
  override?: PublicationReviewOverride | null;
}

/** What `POST /approve` answers, as the closed word of a refusal or `accepted`. */
async function postApprove(sent: Sent): Promise<{ word: string; status: number }> {
  const res = await call(`/admin/publish/${DATASET}/approve`, {
    method: "POST",
    body: JSON.stringify({
      resume: sent.resume,
      sandbox: false,
      skip_ci_check: false,
      ...(sent.acknowledge !== undefined
        ? { acknowledge_identifier_screen: sent.acknowledge }
        : {}),
      ...(sent.override ? { override_publication_review: sent.override } : {}),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    refusal?: string;
    step?: string;
  };
  const gates = ["publication_review_not_clear", "request_blocked", "identifier_screen_not_clear"];
  if (res.status === 409 && body.error !== undefined && gates.includes(body.error)) {
    return {
      word:
        body.error === "publication_review_not_clear" ? (body.refusal ?? body.error) : body.error,
      status: res.status,
    };
  }
  // Past every gate: published, or stopped at a step by the run itself.
  expect([200, 422]).toContain(res.status);
  return { word: "accepted", status: res.status };
}

const optionsOf = (s: Scenario, over: Partial<ApproveOptions> = {}): ApproveOptions => ({
  force: false,
  acknowledge: undefined,
  resume: true,
  ...s.options,
  ...over,
});

/** The request the command would send for a decision that proceeds. */
function sentBy(
  d: Extract<ReturnType<typeof decideApproval>, { kind: "proceed" }>,
  o: ApproveOptions,
): Sent {
  return { resume: o.resume, acknowledge: o.acknowledge, override: d.override };
}

describe("the command's decision and the Worker's gate agree over seeded scenarios", () => {
  for (const s of SCENARIOS) {
    test(s.name, async () => {
      await world(s);
      const detail = await readDetail();
      const options = optionsOf(s);
      const d = decideApproval(DATASET, { kind: "detail", detail }, options);
      expect(d.kind === "proceed" ? "proceed" : d.why).toBe(s.decision);

      if (d.kind === "proceed") {
        expect(d.override === null ? "none" : "some").toBe(s.override as string);
        const answer = await postApprove(sentBy(d, options));
        // The command may proceed where the Worker refuses, and only where the scenario says so.
        expect(answer.word).toBe(s.workerRefuses ?? "accepted");
        return;
      }

      // The command refused. Whatever it declined to send, the Worker would have refused too,
      // or the refusal is a missing flag and the cure it names works.
      if (d.why === "needs_resume") {
        // The Worker would start the run over without it; with it, the Worker accepts.
        await world(s);
        const withResume = optionsOf(s, { resume: true });
        const again = decideApproval(
          DATASET,
          { kind: "detail", detail: await readDetail() },
          withResume,
        );
        expect(again.kind).toBe("proceed");
        if (again.kind === "proceed") {
          expect((await postApprove(sentBy(again, withResume))).word).toBe("accepted");
        }
        return;
      }

      const refused = await postApprove(refusedRequest(d.why, detail, options));
      expect(refused.word).toBe(s.workerRefusal as string);

      if (d.why === "needs_force" || d.why === "needs_ack") {
        // The cure: the flag the command names. Decided again with it, the command proceeds and
        // what it sends is accepted.
        await world(s);
        const cure =
          d.why === "needs_ack"
            ? optionsOf(s, { acknowledge: WHY, force: options.force || needsOverride(detail) })
            : optionsOf(s, { force: true });
        const cured = decideApproval(DATASET, { kind: "detail", detail: await readDetail() }, cure);
        expect(cured.kind).toBe("proceed");
        if (cured.kind === "proceed") {
          expect((await postApprove(sentBy(cured, cure))).word).toBe("accepted");
        }
      }
    });
  }
});

/** Whether any override-class reason stands in the detail, so an acknowledgment alone would not do. */
function needsOverride(detail: Awaited<ReturnType<typeof readDetail>>): boolean {
  return uncoveredByOverride(detail.reasons, []).length > 0;
}

/**
 * The request the command declined to send. For a hard reason that is the strongest a flag can
 * make it: the override of every override-class reason shown, which the Worker must still refuse.
 */
function refusedRequest(
  why: Exclude<ApproveRefusal, "needs_resume">,
  detail: Awaited<ReturnType<typeof readDetail>>,
  options: ApproveOptions,
): Sent {
  const strongest: PublicationReviewOverride = {
    review_id: detail.review?.id ?? null,
    reasons: uncoveredByOverride(detail.reasons, []),
  };
  switch (why) {
    case "hard":
    case "blocked":
      return { resume: options.resume, acknowledge: options.acknowledge, override: strongest };
    case "needs_ack":
      // The acknowledgment is the flag that is missing, so it is not sent.
      return { resume: options.resume, override: options.force ? strongest : null };
    case "needs_force":
      return { resume: options.resume, acknowledge: options.acknowledge, override: null };
  }
}
