/**
 * The review ruleset (ADR 0107): the body that goes to GitHub, and what putting it on, keeping it
 * on and taking it off does to a repository's rulesets.
 *
 * The body is pinned byte for byte. It decides who can merge without the review, so a changed role
 * id or a dropped actor must fail here and not surface as a surprise on a dataset repository.
 * Everything else runs the real functions against a stateful `Bun.serve()` stand-in for
 * api.github.com (helpers/github-rulesets.ts): rulesets live per repository, a duplicate name is a
 * 422, and organization rulesets are listed unless the request asks for `includes_parents=false`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PR_REVIEW_CHECK_NAME } from "../../shared/pr-review";
import {
  BRANCH_RULESET_NAME,
  NEMAR_APP_ID,
  REVIEW_RULESET_NAME,
  buildReviewRulesetPayload,
  deriveContexts,
  ensureBranchRuleset,
  ensureReviewRuleset,
  getReviewRulesetInfo,
  reconcileReviewRuleset,
  removeReviewRuleset,
} from "../src/services/github";
import {
  REPOSITORY_ADMIN_ROLE_ID,
  REVIEW_BASE_BRANCH,
} from "../src/services/github/branch-protection";
import { PR_REVIEW_BASE_BRANCH } from "../src/services/pr-review";
import { HttpError } from "../src/services/retry";
import { type RulesetStandIn, startRulesetStandIn } from "./helpers/github-rulesets";

const PAT = "ghp_review_ruleset_test";
const REPO = "nm000201";

/** The body, written out. If this and `buildReviewRulesetPayload` disagree, one of them is wrong. */
const PINNED_PAYLOAD = {
  name: "NEMAR PR review required",
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  bypass_actors: [
    { actor_id: 3679074, actor_type: "Integration", bypass_mode: "always" },
    { actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: "always" },
    { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
  ],
  rules: [
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: false,
        do_not_enforce_on_create: true,
        required_status_checks: [{ context: "NEMAR PR Review", integration_id: 3679074 }],
      },
    },
  ],
};

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

/** The repository's own rulesets, by name. */
const heldBy = (repo: string) => (standIn.rulesets.get(repo) ?? []).map((r) => r.name);

describe("the review ruleset payload", () => {
  test("is exactly the pinned body", () => {
    expect(buildReviewRulesetPayload()).toStrictEqual(PINNED_PAYLOAD);
  });

  test("names the check the Worker publishes, from the App that publishes it", () => {
    // Renaming the check would leave every required repository waiting for a check that is never
    // posted, so the name is pinned as a literal here and not only as a constant.
    expect(PR_REVIEW_CHECK_NAME).toBe("NEMAR PR Review");
    expect(NEMAR_APP_ID).toBe(3679074);
    expect(REVIEW_RULESET_NAME).toBe("NEMAR PR review required");
  });

  test("the repository Admin role id is the unverified 5, so a change is noticed", () => {
    // Not a claim that 5 is right: it has not been read back from GitHub. The first apply on a
    // dev-owned exemplar is followed by that read (see REPOSITORY_ADMIN_ROLE_ID). This only makes
    // changing it a decision somebody has to make on purpose.
    expect(REPOSITORY_ADMIN_ROLE_ID).toBe(5);
  });

  test("the branch it is written for is the branch the Worker reviews", () => {
    expect(REVIEW_BASE_BRANCH).toBe(PR_REVIEW_BASE_BRANCH);
  });

  test("every call builds its own body", () => {
    const first = buildReviewRulesetPayload();
    first.bypass_actors.length = 0;
    first.rules.length = 0;
    expect(buildReviewRulesetPayload()).toStrictEqual(PINNED_PAYLOAD);
  });
});

describe("ensureReviewRuleset", () => {
  test("creates the ruleset with the pinned body when the repository has none", async () => {
    const result = await ensureReviewRuleset(REPO, PAT);

    expect(result.action).toBe("created");
    expect(result.payload).toStrictEqual(PINNED_PAYLOAD);
    const writes = standIn.rulesetWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe("POST");
    expect(writes[0].path).toBe(`/repos/nemarDatasets/${REPO}/rulesets`);
    // What went over the wire, not what the function says it sent.
    expect(writes[0].body).toStrictEqual(PINNED_PAYLOAD);
    expect(writes[0].auth).toBe(`Bearer ${PAT}`);
    expect(heldBy(REPO)).toEqual([REVIEW_RULESET_NAME]);
  });

  test("a second call updates the same ruleset in place and does not add another", async () => {
    await ensureReviewRuleset(REPO, PAT);
    const id = standIn.rulesets.get(REPO)?.[0].id;
    standIn.calls.length = 0;

    const again = await ensureReviewRuleset(REPO, PAT);

    expect(again.action).toBe("updated");
    const writes = standIn.rulesetWrites();
    expect(writes.map((w) => `${w.method} ${w.path.split("/").slice(-2).join("/")}`)).toEqual([
      `PUT rulesets/${id}`,
    ]);
    expect(heldBy(REPO)).toEqual([REVIEW_RULESET_NAME]);
  });

  test("puts a ruleset someone loosened back to the payload", async () => {
    await ensureReviewRuleset(REPO, PAT);
    const held = standIn.rulesets.get(REPO)?.[0];
    if (!held) throw new Error("the ruleset was not created");
    // Somebody switched it off by hand and added a bypass for everyone.
    held.body = {
      ...held.body,
      enforcement: "disabled",
      bypass_actors: [{ actor_id: 4, actor_type: "RepositoryRole", bypass_mode: "always" }],
    };

    await ensureReviewRuleset(REPO, PAT);

    expect(standIn.rulesets.get(REPO)?.[0].body).toStrictEqual(PINNED_PAYLOAD);
  });

  test("asks for the repository's own rulesets only, and never writes to an organization's", async () => {
    standIn.orgRulesets.push({
      id: 77,
      name: REVIEW_RULESET_NAME,
      source_type: "Organization",
      body: { name: REVIEW_RULESET_NAME, target: "branch", enforcement: "active", rules: [] },
    });

    const result = await ensureReviewRuleset(REPO, PAT);

    // A list that included the organization's would have found a ruleset of this name and updated
    // IT. The repository gets its own, and the organization's is where it was.
    expect(result.action).toBe("created");
    expect(
      standIn.calls.find((c) => c.path.endsWith("/rulesets") && c.method === "GET")?.search,
    ).toBe("?includes_parents=false");
    expect(standIn.rulesetWrites().every((w) => !w.path.endsWith("/77"))).toBe(true);
    expect(heldBy(REPO)).toEqual([REVIEW_RULESET_NAME]);
    expect(standIn.orgRulesets).toHaveLength(1);
  });

  test("leaves the branch ruleset alone, and is left alone by it", async () => {
    await ensureBranchRuleset(REPO, PAT, { checks: deriveContexts(REPO) });
    const branchBefore = structuredClone(
      standIn.rulesets.get(REPO)?.find((r) => r.name === BRANCH_RULESET_NAME),
    );
    expect(branchBefore).toBeDefined();

    await ensureReviewRuleset(REPO, PAT);
    await ensureReviewRuleset(REPO, PAT);

    expect(heldBy(REPO).sort()).toEqual([BRANCH_RULESET_NAME, REVIEW_RULESET_NAME].sort());
    expect(standIn.rulesets.get(REPO)?.find((r) => r.name === BRANCH_RULESET_NAME)).toStrictEqual(
      branchBefore,
    );
    // And the other way: writing the branch ruleset again does not reach the review ruleset.
    const reviewBefore = structuredClone(
      standIn.rulesets.get(REPO)?.find((r) => r.name === REVIEW_RULESET_NAME),
    );
    await ensureBranchRuleset(REPO, PAT, { checks: deriveContexts(REPO) });
    expect(standIn.rulesets.get(REPO)?.find((r) => r.name === REVIEW_RULESET_NAME)).toStrictEqual(
      reviewBefore,
    );
  });

  test("surfaces a refused write with GitHub's status, and keeps nothing", async () => {
    standIn.failNext("POST", /\/rulesets$/, 422);

    const err = await ensureReviewRuleset(REPO, PAT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(422);
    expect((err as HttpError).message).toContain(`Review ruleset create failed for ${REPO}`);
    expect(heldBy(REPO)).toEqual([]);
  });

  test("writes nothing when the list is refused", async () => {
    standIn.failNext("GET", /\/rulesets$/, 403);

    const err = await ensureReviewRuleset(REPO, PAT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message).toContain(`Review ruleset list failed for ${REPO}`);
    expect(standIn.rulesetWrites()).toHaveLength(0);
  });

  // The transport sends a POST again after a 5xx. A create that GitHub processed and then answered
  // with a 502 is therefore written twice, and the second meets the name the first made.
  test("a create GitHub processed but answered with a 502 ends as an update of the ruleset it made", async () => {
    standIn.failAfterWriting("POST", /\/rulesets$/, 502);

    const result = await ensureReviewRuleset(REPO, PAT);

    expect(result.action).toBe("updated");
    // One ruleset, with the payload, and not an error for a repository that is right.
    expect(heldBy(REPO)).toEqual([REVIEW_RULESET_NAME]);
    expect(standIn.rulesets.get(REPO)?.[0].body).toStrictEqual(PINNED_PAYLOAD);
    // The first POST, the transport's second POST (a 422: the name is taken), then the update.
    expect(standIn.rulesetWrites().map((w) => w.method)).toEqual(["POST", "POST", "PUT"]);
  }, 20_000);

  test("a ruleset that appears between the list and the create is brought to the payload", async () => {
    standIn.beforeNext("POST", /\/rulesets$/, () =>
      standIn.rulesets.set(REPO, [
        {
          id: 555,
          name: REVIEW_RULESET_NAME,
          source_type: "Repository",
          body: { ...PINNED_PAYLOAD, enforcement: "disabled" },
        },
      ]),
    );

    const result = await ensureReviewRuleset(REPO, PAT);

    expect(result.action).toBe("updated");
    expect(standIn.rulesets.get(REPO)).toHaveLength(1);
    expect(standIn.rulesets.get(REPO)?.[0].body).toStrictEqual(PINNED_PAYLOAD);
    expect(standIn.rulesetWrites().map((w) => w.method)).toEqual(["POST", "PUT"]);
  });

  test("a 422 with no ruleset behind it is still the error: one more list, no update", async () => {
    standIn.failNext("POST", /\/rulesets$/, 422);

    const err = await ensureReviewRuleset(REPO, PAT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(422);
    expect((err as HttpError).message).toContain(`Review ruleset create failed for ${REPO}`);
    expect(standIn.rulesetWrites().map((w) => w.method)).toEqual(["POST"]);
    expect(
      standIn.calls.filter((c) => c.method === "GET" && c.path.endsWith("/rulesets")),
    ).toHaveLength(2);
    expect(heldBy(REPO)).toEqual([]);
  });

  test("a re-list that fails leaves the create's 422 as the error", async () => {
    standIn.failNext("POST", /\/rulesets$/, 422);
    // Arm the refusal of the list just before the create, so that only the second list is refused.
    standIn.beforeNext("POST", /\/rulesets$/, () => standIn.failNext("GET", /\/rulesets$/, 403));

    const err = await ensureReviewRuleset(REPO, PAT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(422);
    expect((err as HttpError).message).toContain(`Review ruleset create failed for ${REPO}`);
  });

  // The transport retries a 5xx (three attempts, a second apart), so a write that GitHub keeps
  // answering with 500 reaches the caller after all three, which is why these two take two seconds.
  test("a 500 on the update is an error with that status, and the ruleset is as it was", async () => {
    await ensureReviewRuleset(REPO, PAT);
    const before = structuredClone(standIn.rulesets.get(REPO));
    standIn.failNext("PUT", /\/rulesets\/\d+$/, 500, 3);

    const err = await ensureReviewRuleset(REPO, PAT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(500);
    expect((err as HttpError).message).toContain(`Review ruleset update failed for ${REPO}`);
    expect(standIn.rulesets.get(REPO)).toStrictEqual(before);
  }, 20_000);

  test("a 500 on the create is an error with that status, and the repository has no ruleset", async () => {
    standIn.failNext("POST", /\/rulesets$/, 500, 3);

    const err = await ensureReviewRuleset(REPO, PAT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(500);
    expect((err as HttpError).message).toContain(`Review ruleset create failed for ${REPO}`);
    expect(heldBy(REPO)).toEqual([]);
  }, 20_000);
});

describe("removeReviewRuleset", () => {
  test("deletes the review ruleset and only that one", async () => {
    await ensureBranchRuleset(REPO, PAT, { checks: deriveContexts(REPO) });
    await ensureReviewRuleset(REPO, PAT);

    const removed = await removeReviewRuleset(REPO, PAT);

    expect(removed).toBe(true);
    expect(heldBy(REPO)).toEqual([BRANCH_RULESET_NAME]);
    expect(standIn.rulesetWrites().filter((w) => w.method === "DELETE")).toHaveLength(1);
  });

  test("finds nothing to delete on a repository without one, and says so", async () => {
    await ensureBranchRuleset(REPO, PAT, { checks: deriveContexts(REPO) });

    expect(await removeReviewRuleset(REPO, PAT)).toBe(false);

    expect(standIn.rulesetWrites().filter((w) => w.method === "DELETE")).toHaveLength(0);
    expect(heldBy(REPO)).toEqual([BRANCH_RULESET_NAME]);
  });

  test("does not delete an organization ruleset that has the same name", async () => {
    standIn.orgRulesets.push({
      id: 77,
      name: REVIEW_RULESET_NAME,
      source_type: "Organization",
      body: { name: REVIEW_RULESET_NAME, target: "branch", enforcement: "active", rules: [] },
    });

    expect(await removeReviewRuleset(REPO, PAT)).toBe(false);

    expect(standIn.rulesetWrites()).toHaveLength(0);
    expect(standIn.orgRulesets).toHaveLength(1);
  });

  test("a refused delete is an error, not a removal", async () => {
    await ensureReviewRuleset(REPO, PAT);
    standIn.failNext("DELETE", /\/rulesets\/\d+$/, 403);

    const err = await removeReviewRuleset(REPO, PAT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message).toContain(`Review ruleset delete failed for ${REPO}`);
    expect(heldBy(REPO)).toEqual([REVIEW_RULESET_NAME]);
  });

  test("a repository GitHub cannot find has none to delete", async () => {
    standIn.defaultBranches.set("nm000999", null);

    // The transport waits out its 404 retries first, which is why this one takes a few seconds.
    expect(await removeReviewRuleset("nm000999", PAT)).toBe(false);
  }, 20_000);

  test("a delete that answers 404 means the ruleset is already gone, which is the removal asked for", async () => {
    await ensureReviewRuleset(REPO, PAT);
    // Somebody else deletes it after it was listed and before this call's delete reaches GitHub.
    standIn.beforeNext("DELETE", /\/rulesets\/\d+$/, () => standIn.rulesets.set(REPO, []));

    // The transport waits out its 404 retries first, which is why this one takes a few seconds.
    expect(await removeReviewRuleset(REPO, PAT)).toBe(true);

    expect(heldBy(REPO)).toEqual([]);
    expect(standIn.rulesetWrites().filter((w) => w.method === "DELETE").length).toBeGreaterThan(0);
  }, 20_000);
});

describe("getReviewRulesetInfo", () => {
  test("reports absent, active and switched-off rulesets as what they are", async () => {
    expect(await getReviewRulesetInfo(REPO, PAT)).toEqual({ present: false, active: false });

    await ensureReviewRuleset(REPO, PAT);
    expect(await getReviewRulesetInfo(REPO, PAT)).toEqual({ present: true, active: true });

    // The break-glass rollback sets enforcement to "disabled" and leaves the ruleset in place.
    const held = standIn.rulesets.get(REPO)?.[0];
    if (!held) throw new Error("the ruleset was not created");
    held.body = { ...held.body, enforcement: "disabled" };
    expect(await getReviewRulesetInfo(REPO, PAT)).toEqual({ present: true, active: false });
  });

  test("an organization ruleset of the same name is not the repository's", async () => {
    standIn.orgRulesets.push({
      id: 77,
      name: REVIEW_RULESET_NAME,
      source_type: "Organization",
      body: { name: REVIEW_RULESET_NAME, target: "branch", enforcement: "active", rules: [] },
    });
    expect(await getReviewRulesetInfo(REPO, PAT)).toEqual({ present: false, active: false });
  });

  test("throws when GitHub cannot say, so an outage is never read as an absence", async () => {
    standIn.failNext("GET", /\/rulesets$/, 403);

    await expect(getReviewRulesetInfo(REPO, PAT)).rejects.toBeInstanceOf(HttpError);
  });
});

describe("reconcileReviewRuleset", () => {
  test("require writes the ruleset where the default branch is main", async () => {
    const step = await reconcileReviewRuleset(REPO, PAT, { intent: "require" });

    expect(step).toMatchObject({ intent: "require", action: "create", applied: true });
    expect(step.payload).toStrictEqual(PINNED_PAYLOAD);
    expect(heldBy(REPO)).toEqual([REVIEW_RULESET_NAME]);

    const again = await reconcileReviewRuleset(REPO, PAT, { intent: "require" });
    expect(again).toMatchObject({ action: "update", applied: true });
    expect(heldBy(REPO)).toEqual([REVIEW_RULESET_NAME]);
  });

  test("require writes nothing where the default branch is not main, and says why", async () => {
    standIn.defaultBranches.set(REPO, "git-annex");

    const step = await reconcileReviewRuleset(REPO, PAT, { intent: "require" });

    // The ruleset follows the default branch and the Worker reviews pull requests to main only,
    // so here it would require a check no pull request is ever given.
    expect(step).toEqual({
      intent: "require",
      action: "skip",
      applied: false,
      reason: "default_branch_not_main",
      defaultBranch: "git-annex",
    });
    expect(standIn.rulesetWrites()).toHaveLength(0);
    expect(heldBy(REPO)).toEqual([]);
  });

  test("a default branch the caller already read is not read again", async () => {
    await reconcileReviewRuleset(REPO, PAT, { intent: "require", defaultBranch: "main" });
    expect(standIn.calls.filter((c) => c.path === `/repos/nemarDatasets/${REPO}`)).toHaveLength(0);

    const step = await reconcileReviewRuleset(REPO, PAT, {
      intent: "require",
      defaultBranch: "master",
    });
    expect(step.action).toBe("skip");
  });

  test("it does not guess a default branch GitHub would not tell it", async () => {
    standIn.failNext("GET", new RegExp(`^/repos/nemarDatasets/${REPO}$`), 403);

    await expect(reconcileReviewRuleset(REPO, PAT, { intent: "require" })).rejects.toBeInstanceOf(
      HttpError,
    );
    expect(standIn.rulesetWrites()).toHaveLength(0);
  });

  test("a dry run reads what GitHub holds and writes nothing", async () => {
    const before = await reconcileReviewRuleset(REPO, PAT, { intent: "require", dryRun: true });
    expect(before).toMatchObject({ action: "create", applied: false });
    expect(before.payload).toStrictEqual(PINNED_PAYLOAD);
    expect(standIn.writes()).toHaveLength(0);
    expect(heldBy(REPO)).toEqual([]);

    await ensureReviewRuleset(REPO, PAT);
    standIn.calls.length = 0;
    const after = await reconcileReviewRuleset(REPO, PAT, { intent: "require", dryRun: true });
    expect(after).toMatchObject({ action: "update", applied: false });
    expect(standIn.writes()).toHaveLength(0);
  });

  test("remove deletes it, and a repository without one has nothing to remove", async () => {
    await ensureReviewRuleset(REPO, PAT);

    const dry = await reconcileReviewRuleset(REPO, PAT, { intent: "remove", dryRun: true });
    expect(dry).toEqual({ intent: "remove", action: "remove", applied: false });
    expect(heldBy(REPO)).toEqual([REVIEW_RULESET_NAME]);

    const done = await reconcileReviewRuleset(REPO, PAT, { intent: "remove" });
    expect(done).toEqual({ intent: "remove", action: "remove", applied: true });
    expect(heldBy(REPO)).toEqual([]);

    const none = await reconcileReviewRuleset(REPO, PAT, { intent: "remove" });
    expect(none).toEqual({ intent: "remove", action: "none", applied: false });
  });

  test("a dry run of a removal reads a repository GitHub cannot find as the removal does: nothing to remove", async () => {
    standIn.defaultBranches.set("nm000999", null);

    // The transport waits out its 404 retries first, which is why this one takes a few seconds.
    const step = await reconcileReviewRuleset("nm000999", PAT, { intent: "remove", dryRun: true });

    expect(step).toEqual({ intent: "remove", action: "none", applied: false });
  }, 20_000);

  test("remove does not need the default branch, so a repository on another branch can still be cleared", async () => {
    await ensureReviewRuleset(REPO, PAT);
    standIn.defaultBranches.set(REPO, "git-annex");

    const done = await reconcileReviewRuleset(REPO, PAT, { intent: "remove" });

    expect(done.action).toBe("remove");
    expect(heldBy(REPO)).toEqual([]);
  });
});

// The stand-in is what tells these tests that a body is wrong, so it has to refuse what GitHub
// refuses: a body that merely has the right shape at the top would pass a misspelled or mistyped
// rule parameter, and the first the team would hear of it is a 422 from the real thing. Each case
// starts from the pinned review body and breaks one field.
describe("the GitHub stand-in refuses what GitHub refuses", () => {
  const rulesetsUrl = () => `${standIn.url}/repos/nemarDatasets/${REPO}/rulesets`;
  const send = (body: unknown, url = rulesetsUrl(), method = "POST") =>
    fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  type Params = Record<string, unknown>;
  /** The pinned review body with its status-check parameters changed by `edit`. */
  function withParameters(edit: (p: Params) => void): Record<string, unknown> {
    const body = structuredClone(PINNED_PAYLOAD) as Record<string, unknown>;
    const rule = (body.rules as Array<{ parameters: Params }>)[0];
    edit(rule.parameters);
    return body;
  }

  test("the pinned body is taken, so the refusals below are not a blanket 422", async () => {
    const res = await send(PINNED_PAYLOAD);
    expect(res.status).toBe(201);
    expect(heldBy(REPO)).toEqual([REVIEW_RULESET_NAME]);
  });

  test("an unpinned check, with no integration_id, is taken: GitHub makes that field optional", async () => {
    const res = await send(
      withParameters((p) => {
        p.required_status_checks = [{ context: "version-check" }];
      }),
    );
    expect(res.status).toBe(201);
  });

  test.each<[string, (p: Params) => void, string]>([
    [
      "a strict policy that is not a boolean",
      (p) => {
        p.strict_required_status_checks_policy = "false";
      },
      "strict_required_status_checks_policy",
    ],
    [
      "a strict policy under a misspelled name",
      (p) => {
        p.strict_required_status_checks_policy = undefined;
        p.strict_required_checks_policy = false;
      },
      "strict_required_status_checks_policy",
    ],
    [
      "a do_not_enforce_on_create that is not a boolean",
      (p) => {
        p.do_not_enforce_on_create = "true";
      },
      "do_not_enforce_on_create",
    ],
    [
      "required_status_checks that is not an array",
      (p) => {
        p.required_status_checks = { context: "NEMAR PR Review", integration_id: 3679074 };
      },
      "required_status_checks must be an array",
    ],
    [
      "a check with no context",
      (p) => {
        p.required_status_checks = [{ integration_id: 3679074 }];
      },
      "context",
    ],
    [
      "a check whose context is not a string",
      (p) => {
        p.required_status_checks = [{ context: 42, integration_id: 3679074 }];
      },
      "context",
    ],
    [
      "an integration_id that is not an integer",
      (p) => {
        p.required_status_checks = [{ context: "NEMAR PR Review", integration_id: "3679074" }];
      },
      "integration_id",
    ],
  ])("%s is a 422, and nothing is held", async (_name, edit, field) => {
    const res = await send(withParameters(edit));

    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain(field);
    expect(heldBy(REPO)).toEqual([]);
  });

  test("a status-check rule with no parameters is a 422", async () => {
    const body = structuredClone(PINNED_PAYLOAD) as Record<string, unknown>;
    body.rules = [{ type: "required_status_checks" }];

    expect((await send(body)).status).toBe(422);
    expect(heldBy(REPO)).toEqual([]);
  });

  test.each<[string, unknown]>([
    ["no conditions at all", undefined],
    ["conditions without a ref_name", {}],
    ["a ref_name without include", { ref_name: { exclude: [] } }],
    ["a ref_name without exclude", { ref_name: { include: ["~DEFAULT_BRANCH"] } }],
    ["an include that is not an array", { ref_name: { include: "~DEFAULT_BRANCH", exclude: [] } }],
    ["an include of something that is not a string", { ref_name: { include: [1], exclude: [] } }],
  ])("a branch ruleset with %s is a 422, and nothing is held", async (_name, conditions) => {
    const body = { ...structuredClone(PINNED_PAYLOAD), conditions } as Record<string, unknown>;

    const res = await send(body);

    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("ref_name");
    expect(heldBy(REPO)).toEqual([]);
  });

  test("a tag ruleset is held to the same condition", async () => {
    const tag = {
      name: "Protect version tags",
      target: "tag",
      enforcement: "active",
      rules: [{ type: "deletion" }],
    };

    expect((await send(tag)).status).toBe(422);
    const ok = await send({
      ...tag,
      conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    });
    expect(ok.status).toBe(201);
  });

  test("an update is held to the same rules as a create", async () => {
    await ensureReviewRuleset(REPO, PAT);
    const held = standIn.rulesets.get(REPO)?.[0];
    if (!held) throw new Error("the ruleset was not created");
    const before = structuredClone(held);

    const res = await send(
      withParameters((p) => {
        p.strict_required_status_checks_policy = "false";
      }),
      `${rulesetsUrl()}/${held.id}`,
      "PUT",
    );

    expect(res.status).toBe(422);
    expect(standIn.rulesets.get(REPO)?.[0]).toStrictEqual(before);
  });
});
