/**
 * Unit tests for the green-gate predicate (epic #713, phase #717).
 * Pure, no network, no mocks: assert `isRequiredCheckGreen` — the predicate
 * that decides whether `ensureRepoToSpec` applies branch protection. The full
 * ensureRepoToSpec composition is exercised end-to-end by the live flows; here
 * we pin the gate that prevents bricking a repo whose check is red/missing.
 *
 * The second half runs the real `ensureRepoToSpec` against a stateful GitHub
 * stand-in (helpers/github-rulesets.ts) for the one step it adds in ADR 0107,
 * the required pull-request review: what `review` of `require`, `remove` and
 * `undefined` leaves on a public and on a private repository.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  BRANCH_RULESET_NAME,
  NEMAR_APP_ID,
  REVIEW_RULESET_NAME,
  type RequiredCheck,
  ensureRepoToSpec,
  ensureReviewRuleset,
  isRequiredCheckGreen,
} from "../src/services/github";
import { reviewStepFailure } from "../src/services/github/branch-protection";
import { HttpError } from "../src/services/retry";
import { type RulesetStandIn, startRulesetStandIn } from "./helpers/github-rulesets";

const BIDS: RequiredCheck = { context: "Run BIDS Validation", integration_id: NEMAR_APP_ID };

function run(name: string, conclusion: string | null, app_id: number | null = NEMAR_APP_ID) {
  return { name, conclusion, app_id };
}

describe("isRequiredCheckGreen", () => {
  test("matching App check-run with success is green", () => {
    expect(isRequiredCheckGreen(BIDS, [run("Run BIDS Validation", "success")], [])).toBe(true);
  });

  test("matching check-run with failure is not green", () => {
    expect(isRequiredCheckGreen(BIDS, [run("Run BIDS Validation", "failure")], [])).toBe(false);
  });

  test("missing check is not green (fail-closed)", () => {
    expect(isRequiredCheckGreen(BIDS, [run("something else", "success")], [])).toBe(false);
  });

  test("in-progress check (null conclusion) is not green", () => {
    expect(isRequiredCheckGreen(BIDS, [run("Run BIDS Validation", null)], [])).toBe(false);
  });

  test("neutral and skipped count as green", () => {
    expect(isRequiredCheckGreen(BIDS, [run("Run BIDS Validation", "neutral")], [])).toBe(true);
    expect(isRequiredCheckGreen(BIDS, [run("Run BIDS Validation", "skipped")], [])).toBe(true);
  });

  test("wrong integration_id does not satisfy a pinned check (spoof-resistant)", () => {
    expect(isRequiredCheckGreen(BIDS, [run("Run BIDS Validation", "success", 9999)], [])).toBe(
      false,
    );
  });

  test("unpinned check matches by name regardless of source", () => {
    const vc: RequiredCheck = { context: "version-check" };
    expect(isRequiredCheckGreen(vc, [run("version-check", "success", 15368)], [])).toBe(true);
  });

  test("falls back to a legacy commit status with state=success", () => {
    const legacy: RequiredCheck = { context: "bids-validation" };
    expect(
      isRequiredCheckGreen(legacy, [], [{ context: "bids-validation", state: "success" }]),
    ).toBe(true);
    expect(
      isRequiredCheckGreen(legacy, [], [{ context: "bids-validation", state: "failure" }]),
    ).toBe(false);
  });
});

describe("ensureRepoToSpec and the required review", () => {
  const PAT = "ghp_ensure_repo_spec_test";
  const REPO = "nm000201";
  let standIn: RulesetStandIn;

  beforeAll(() => {
    standIn = startRulesetStandIn();
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = standIn.url;
  });

  afterAll(() => {
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
    standIn.stop();
  });

  beforeEach(() => {
    standIn.reset();
  });

  const heldBy = (repo = REPO) => (standIn.rulesets.get(repo) ?? []).map((r) => r.name).sort();

  test("require puts the review ruleset on a public repository, next to the branch ruleset", async () => {
    const result = await ensureRepoToSpec(REPO, PAT, { visibility: "public", review: "require" });

    expect(result.steps.review_ruleset).toEqual({ status: "ok", detail: "created" });
    expect(result.steps.branch_ruleset).toEqual({ status: "ok" });
    expect(heldBy()).toContain(REVIEW_RULESET_NAME);
    expect(heldBy()).toContain(BRANCH_RULESET_NAME);
  });

  test("require does not wait for the BIDS check: a red repository still gets the review", async () => {
    standIn.bidsConclusion.set(REPO, "failure");

    const result = await ensureRepoToSpec(REPO, PAT, { visibility: "public", review: "require" });

    expect(result.steps.branch_ruleset).toEqual({
      status: "skipped",
      detail: "RED_REQUIRED_CHECK",
    });
    expect(result.steps.review_ruleset).toEqual({ status: "ok", detail: "created" });
    expect(heldBy()).toEqual([REVIEW_RULESET_NAME]);
  });

  test("an undefined review leaves the review ruleset exactly as it is, and says nothing about it", async () => {
    await ensureReviewRuleset(REPO, PAT);
    const held = standIn.rulesets.get(REPO)?.[0];
    if (!held) throw new Error("the ruleset was not created");
    // An administrator's break-glass: switched off, not deleted.
    held.body = { ...held.body, enforcement: "disabled" };
    const before = structuredClone(held);
    standIn.calls.length = 0;

    const result = await ensureRepoToSpec(REPO, PAT, { visibility: "public" });

    expect(result.steps.review_ruleset).toBeUndefined();
    expect(standIn.rulesets.get(REPO)?.find((r) => r.name === REVIEW_RULESET_NAME)).toStrictEqual(
      before,
    );
    // Nothing wrote to it, and nothing deleted it.
    expect(
      standIn.rulesetWrites().filter((w) => w.path.endsWith(`/rulesets/${before.id}`)),
    ).toHaveLength(0);
  });

  test("remove takes the review ruleset off and leaves the branch ruleset", async () => {
    await ensureReviewRuleset(REPO, PAT);

    const result = await ensureRepoToSpec(REPO, PAT, { visibility: "public", review: "remove" });

    expect(result.steps.review_ruleset).toEqual({ status: "ok", detail: "removed" });
    expect(heldBy()).toContain(BRANCH_RULESET_NAME);
    expect(heldBy()).not.toContain(REVIEW_RULESET_NAME);
  });

  test("on a private repository require is read as remove: nothing there publishes the check", async () => {
    await ensureReviewRuleset(REPO, PAT);

    const result = await ensureRepoToSpec(REPO, PAT, { visibility: "private", review: "require" });

    expect(result.steps.review_ruleset).toEqual({ status: "ok", detail: "removed (private)" });
    expect(heldBy()).toEqual([]);
    // And a private repository that never had one is left with none, not given one.
    const clean = await ensureRepoToSpec("nm000202", PAT, {
      visibility: "private",
      review: "require",
    });
    expect(clean.steps.review_ruleset).toEqual({
      status: "ok",
      detail: "nothing to remove (private)",
    });
    expect(heldBy("nm000202")).toEqual([]);
  });

  /** Run `fn` and return what it wrote to console.error. */
  async function logged(fn: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      await fn();
    } finally {
      console.error = realError;
    }
    return lines;
  }

  // `nemar admin fleet enforce` prints a step's detail as it is. GitHub's body is JSON, and the name
  // of the function that threw is no use to the person reading, so the detail is GitHub's status
  // and a sentence, and the whole error text goes to the server log.
  test("a review step that fails is recorded with GitHub's status and none of its words, and does not stop the rest", async () => {
    await ensureReviewRuleset(REPO, PAT);
    // The review ruleset exists, so its write is the only PUT; the branch ruleset is a POST.
    standIn.failNext("PUT", /\/rulesets\/\d+$/, 403);

    let result: Awaited<ReturnType<typeof ensureRepoToSpec>> | undefined;
    const lines = await logged(async () => {
      result = await ensureRepoToSpec(REPO, PAT, { visibility: "public", review: "require" });
    });

    expect(result?.steps.review_ruleset).toEqual({
      status: "failed",
      detail: "GitHub refused the review ruleset with HTTP 403",
    });
    expect(result?.steps.branch_ruleset).toEqual({ status: "ok" });
    expect(result?.steps.tag_ruleset).toEqual({ status: "ok" });
    // Nothing GitHub said, and nothing about which function threw, is in what is returned.
    const answer = JSON.stringify(result);
    expect(answer).not.toContain("refused by the stand-in");
    expect(answer).not.toContain("Review ruleset update failed");
    // (A JSON body inside a JSON string is written with escaped quotes.)
    expect(answer).not.toContain('{\\"message');
    // The whole error text is in the server log, with the repository and the stage.
    const line = lines.find((l) => l.includes("review ruleset step failed"));
    expect(line).toBeDefined();
    expect(line).toContain(REPO);
    expect(line).toContain("Review ruleset update failed for nm000201: HTTP 403");
    expect(line).toContain("refused by the stand-in");
  });

  test("a create that GitHub refuses with a 422 is a refusal, with the status and not the body", async () => {
    // With the BIDS check red the review ruleset is the only one written, so it is the only POST.
    standIn.bidsConclusion.set(REPO, "failure");
    standIn.failNext("POST", /\/rulesets$/, 422);

    let result: Awaited<ReturnType<typeof ensureRepoToSpec>> | undefined;
    const lines = await logged(async () => {
      result = await ensureRepoToSpec(REPO, PAT, { visibility: "public", review: "require" });
    });

    expect(result?.steps.review_ruleset).toEqual({
      status: "failed",
      detail: "GitHub refused the review ruleset with HTTP 422",
    });
    expect(JSON.stringify(result)).not.toContain("refused by the stand-in");
    expect(lines.some((l) => l.includes("refused by the stand-in"))).toBe(true);
    expect(heldBy()).toEqual([]);
  });

  test("a failure that is not a refusal says it is not known whether the change was made, and a dry run does not", async () => {
    await ensureReviewRuleset(REPO, PAT);
    // The transport tries three times before it gives GitHub's 503 to the caller.
    standIn.failNext("PUT", /\/rulesets\/\d+$/, 503, 3);

    let live: Awaited<ReturnType<typeof ensureRepoToSpec>> | undefined;
    await logged(async () => {
      live = await ensureRepoToSpec(REPO, PAT, { visibility: "public", review: "require" });
    });
    expect(live?.steps.review_ruleset).toEqual({
      status: "failed",
      detail:
        "GitHub could not complete the review ruleset request (HTTP 503); it is not known whether it was changed",
    });

    // A dry run writes nothing, so nothing could have been changed and it does not say that.
    standIn.failNext("GET", /\/rulesets$/, 503, 3);
    let dry: Awaited<ReturnType<typeof ensureRepoToSpec>> | undefined;
    await logged(async () => {
      dry = await ensureRepoToSpec(REPO, PAT, {
        visibility: "public",
        review: "require",
        dryRun: true,
      });
    });
    expect(dry?.steps.review_ruleset).toEqual({
      status: "failed",
      detail: "GitHub could not complete the review ruleset request (HTTP 503)",
    });
  }, 20_000);

  test("the sentence is the status and nothing else: a refusal, a failure with a status, and no answer", () => {
    const body = '{"message":"Validation Failed","errors":["Name must be unique"]}';
    const refused = new HttpError(
      `Review ruleset create failed for x: HTTP 422: ${body}`,
      422,
      body,
    );
    expect(reviewStepFailure(refused, false)).toBe(
      "GitHub refused the review ruleset with HTTP 422",
    );
    expect(reviewStepFailure(refused, true)).toBe(
      "GitHub refused the review ruleset with HTTP 422",
    );
    // A 429 is not a refusal of this request: it is asked again later.
    const limited = new HttpError(`rate limited: ${body}`, 429, body);
    expect(reviewStepFailure(limited, false)).toBe(
      "GitHub could not complete the review ruleset request (HTTP 429); it is not known whether it was changed",
    );
    // No status at all: the network, or something that is not an HTTP answer.
    const noAnswer = new TypeError(`fetch failed: ${body}`);
    expect(reviewStepFailure(noAnswer, false)).toBe(
      "the request to GitHub for the review ruleset did not complete; it is not known whether it was changed",
    );
    expect(reviewStepFailure(noAnswer, true)).toBe(
      "the request to GitHub for the review ruleset did not complete",
    );
    for (const e of [refused, limited, noAnswer]) {
      for (const dry of [true, false])
        expect(reviewStepFailure(e, dry)).not.toContain("Validation");
    }
  });

  test("a dry run reports what each intent would do and writes nothing", async () => {
    const create = await ensureRepoToSpec(REPO, PAT, {
      visibility: "public",
      review: "require",
      dryRun: true,
    });
    expect(create.steps.review_ruleset).toEqual({ status: "ok", detail: "would create" });

    await ensureReviewRuleset(REPO, PAT);
    standIn.calls.length = 0;
    const update = await ensureRepoToSpec(REPO, PAT, {
      visibility: "public",
      review: "require",
      dryRun: true,
    });
    expect(update.steps.review_ruleset).toEqual({ status: "ok", detail: "would update" });
    const remove = await ensureRepoToSpec(REPO, PAT, {
      visibility: "private",
      review: "require",
      dryRun: true,
    });
    expect(remove.steps.review_ruleset).toEqual({ status: "ok", detail: "would remove (private)" });
    expect(standIn.writes()).toHaveLength(0);
  });

  // Step 2 of the live run makes main the default branch, and only then does the review step run,
  // so a repository on another branch is given the ruleset, not skipped. It makes main the default
  // by moving the default to an existing main, or by renaming the branch when there is no main.
  // The dry run plans those same two steps, in words that are true of both.
  describe("a repository whose default branch is not main", () => {
    const REPO_PATH = `/repos/nemarDatasets/${REPO}`;

    test("a dry run says it would make main the default branch, then create the ruleset", async () => {
      standIn.defaultBranches.set(REPO, "master");

      const result = await ensureRepoToSpec(REPO, PAT, {
        visibility: "public",
        review: "require",
        dryRun: true,
      });

      expect(result.steps.review_ruleset).toEqual({
        status: "ok",
        detail: "would make main the default branch, then create",
      });
      expect(result.steps.plan?.detail).toBe("public, default=master");
      expect(standIn.writes()).toHaveLength(0);
      // The plan did not change what it was planning for.
      expect(standIn.defaultBranches.get(REPO)).toBe("master");
    });

    test("a dry run says update when the ruleset is already there", async () => {
      await ensureReviewRuleset(REPO, PAT);
      standIn.defaultBranches.set(REPO, "git-annex");
      standIn.calls.length = 0;

      const result = await ensureRepoToSpec(REPO, PAT, {
        visibility: "public",
        review: "require",
        dryRun: true,
      });

      expect(result.steps.review_ruleset).toEqual({
        status: "ok",
        detail: "would make main the default branch, then update",
      });
      expect(standIn.writes()).toHaveLength(0);
    });

    test("the live run does what the dry run said: it makes main the default, then creates the ruleset", async () => {
      standIn.defaultBranches.set(REPO, "master");

      const live = await ensureRepoToSpec(REPO, PAT, { visibility: "public", review: "require" });

      expect(live.steps.main_branch).toEqual({ status: "ok", detail: "repointed from master" });
      expect(live.steps.review_ruleset).toEqual({ status: "ok", detail: "created" });
      expect(standIn.defaultBranches.get(REPO)).toBe("main");
      expect(heldBy()).toContain(REVIEW_RULESET_NAME);
      // The review step took ensureMainBranch's word for it: the repository was read twice (to
      // capture the branch, and by ensureMainBranch), and not a third time for the review.
      expect(standIn.calls.filter((c) => c.method === "GET" && c.path === REPO_PATH)).toHaveLength(
        2,
      );
    });

    // The dry run cannot know whether `main` exists, and does not ask. Its words are the same, and
    // true, whichever the live run finds: it repoints to an existing main, or it renames the branch.
    test("the dry run's words are true of both live outcomes: main is repointed to, or the branch is renamed to it", async () => {
      const plan = {
        status: "ok",
        detail: "would make main the default branch, then create",
      };

      standIn.defaultBranches.set(REPO, "master");
      const dryWithMain = await ensureRepoToSpec(REPO, PAT, {
        visibility: "public",
        review: "require",
        dryRun: true,
      });
      expect(dryWithMain.steps.review_ruleset).toEqual(plan);
      expect(standIn.writes()).toHaveLength(0);
      const liveWithMain = await ensureRepoToSpec(REPO, PAT, {
        visibility: "public",
        review: "require",
      });
      expect(liveWithMain.steps.main_branch).toEqual({
        status: "ok",
        detail: "repointed from master",
      });
      expect(liveWithMain.steps.review_ruleset).toEqual({ status: "ok", detail: "created" });
      expect(standIn.defaultBranches.get(REPO)).toBe("main");

      // The same repository with no main branch at all: the live run renames its branch.
      standIn.reset();
      standIn.defaultBranches.set(REPO, "master");
      standIn.missingMain.add(REPO);
      const dryNoMain = await ensureRepoToSpec(REPO, PAT, {
        visibility: "public",
        review: "require",
        dryRun: true,
      });
      expect(dryNoMain.steps.review_ruleset).toEqual(plan);
      expect(standIn.writes()).toHaveLength(0);
      const liveNoMain = await ensureRepoToSpec(REPO, PAT, {
        visibility: "public",
        review: "require",
      });
      expect(liveNoMain.steps.main_branch).toEqual({ status: "ok", detail: "renamed from master" });
      expect(liveNoMain.steps.review_ruleset).toEqual({ status: "ok", detail: "created" });
      expect(standIn.defaultBranches.get(REPO)).toBe("main");
    });

    test("a dry run reads the repository once, and the review step does not read it again", async () => {
      standIn.defaultBranches.set(REPO, "master");

      await ensureRepoToSpec(REPO, PAT, { visibility: "public", review: "require", dryRun: true });

      expect(standIn.calls.filter((c) => c.method === "GET" && c.path === REPO_PATH)).toHaveLength(
        1,
      );
    });

    test("where the repository would be skipped anyway, nothing is planned: private and removal are as they were", async () => {
      standIn.defaultBranches.set(REPO, "master");

      const priv = await ensureRepoToSpec(REPO, PAT, {
        visibility: "private",
        review: "require",
        dryRun: true,
      });
      expect(priv.steps.review_ruleset).toEqual({
        status: "ok",
        detail: "nothing to remove (private)",
      });
      const remove = await ensureRepoToSpec(REPO, PAT, {
        visibility: "public",
        review: "remove",
        dryRun: true,
      });
      expect(remove.steps.review_ruleset).toEqual({ status: "ok", detail: "nothing to remove" });
    });
  });

  // The other steps fall back to "main" when the repository cannot be read, because all they need
  // is a branch to look at. The review step writes a ruleset that follows the default branch, so a
  // guess would put it on a repository whose default branch is another one.
  describe("when the repository's default branch cannot be read", () => {
    const REPO_READ = new RegExp(`^/repos/nemarDatasets/${REPO}$`);
    const reviewWrites = () =>
      standIn.rulesetWrites().filter((w) => w.body?.name === REVIEW_RULESET_NAME);

    test("a repository on master gets no review ruleset: the guess does not stand in for the answer", async () => {
      standIn.defaultBranches.set(REPO, "master");
      // The first read (which captures the branch) and the one ensureMainBranch makes are refused.
      // The third, which the review step makes for itself, is the one that tells it the truth.
      standIn.failNext("GET", REPO_READ, 403, 2);

      const result = await ensureRepoToSpec(REPO, PAT, { visibility: "public", review: "require" });

      expect(result.steps.main_branch?.status).toBe("failed");
      expect(result.steps.review_ruleset).toEqual({
        status: "skipped",
        detail: "default branch is master, not main",
      });
      expect(reviewWrites()).toEqual([]);
      expect(heldBy()).not.toContain(REVIEW_RULESET_NAME);
    });

    test("with every read refused the review step is not applied, in a sentence, and writes nothing", async () => {
      standIn.failNext("GET", REPO_READ, 403, 20);

      const result = await ensureRepoToSpec(REPO, PAT, { visibility: "public", review: "require" });

      expect(result.steps.main_branch?.status).toBe("failed");
      expect(result.steps.review_ruleset).toEqual({
        status: "failed",
        detail: "not applied: the default branch could not be read from GitHub (HTTP 403)",
      });
      expect(reviewWrites()).toEqual([]);
    });

    test("a dry run says what the live run says for the same repository", async () => {
      standIn.failNext("GET", REPO_READ, 403, 20);
      const dry = await ensureRepoToSpec(REPO, PAT, {
        visibility: "public",
        review: "require",
        dryRun: true,
      });
      standIn.reset();
      standIn.failNext("GET", REPO_READ, 403, 20);
      const live = await ensureRepoToSpec(REPO, PAT, { visibility: "public", review: "require" });

      expect(dry.steps.review_ruleset).toEqual(live.steps.review_ruleset);
      expect(dry.steps.review_ruleset?.status).toBe("failed");
      // The plan does not name a branch it was not told.
      expect(dry.steps.plan?.detail).toBe("public, default=unknown");
      expect(standIn.writes().filter((w) => w.path.includes("/rulesets"))).not.toContainEqual(
        expect.objectContaining({ body: expect.objectContaining({ name: REVIEW_RULESET_NAME }) }),
      );
    });

    test("a removal needs no default branch, so an unreadable one does not stop it", async () => {
      await ensureReviewRuleset(REPO, PAT);
      standIn.failNext("GET", REPO_READ, 403, 20);

      const result = await ensureRepoToSpec(REPO, PAT, { visibility: "public", review: "remove" });

      expect(result.steps.review_ruleset).toEqual({ status: "ok", detail: "removed" });
      expect(heldBy()).not.toContain(REVIEW_RULESET_NAME);
    });
  });
});
