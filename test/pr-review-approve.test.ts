/**
 * Approving a dataset pull request as the administrator themselves (ADR 0093): the GitHub side,
 * driven against a local `Bun.serve()` stand-in for api.github.com that answers `GET /user` by token
 * and records every request with the token it carried.
 *
 * What is pinned is what keeps an approval honest: only a person's token is accepted, the approval
 * is recorded on the commit that was shown, the answer is checked rather than assumed, and a
 * merge needs GitHub's own word that it is clean and never goes around the ruleset.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { buildBranchRulesetPayload } from "../backend/src/services/github";
import {
  adminGitHubToken,
  approvalGate,
  asVerdict,
  checkMergeable,
  closePullRequest,
  fetchPullRequest,
  githubApiBase,
  identityMatches,
  manualApprovalCommand,
  mergeCheckOf,
  mergeWhenClean,
  notCleanWhy,
  postComment,
  pullRequestUrl,
  recheckBeforeApproval,
  refusalFor,
  reviewForApproval,
  settleMergeState,
  stateWord,
  submitApproval,
  whoAmI,
} from "../src/lib/pr-review-approve";
import {
  ADMIN_TOKEN,
  APP_TOKEN,
  BOT_LOGIN_TOKEN,
  BOT_TOKEN,
  BOT_TYPE_TOKEN,
  type GitHubStandin,
  OTHER_TOKEN,
  startGitHubStandin,
} from "./helpers/github-standin";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const gh: GitHubStandin = startGitHubStandin();
const base = () => gh.url;

afterAll(() => gh.stop());
beforeEach(() => gh.reset());

describe("the GitHub origin", () => {
  test("is api.github.com unless a loopback http origin is given for a test", () => {
    expect(githubApiBase({})).toBe("https://api.github.com");
    expect(githubApiBase({ NEMAR_GITHUB_API_URL: "http://127.0.0.1:4010/" })).toBe(
      "http://127.0.0.1:4010",
    );
    expect(githubApiBase({ NEMAR_GITHUB_API_URL: "http://localhost:4010" })).toBe(
      "http://localhost:4010",
    );
  });

  test("an empty value is no value", () => {
    expect(githubApiBase({ NEMAR_GITHUB_API_URL: "  " })).toBe("https://api.github.com");
  });

  test("never sends an administrator's token to a host that is not this machine", () => {
    for (const evil of [
      "http://evil.test",
      "https://evil.test",
      "https://127.0.0.1:4010",
      "http://127.0.0.1.evil.test",
      "http://localhost.evil.test",
      "file:///etc/passwd",
      "not a url",
    ]) {
      // Refused, not ignored: a typo must not turn a rehearsal into a request to the real GitHub.
      expect(() => githubApiBase({ NEMAR_GITHUB_API_URL: evil })).toThrow(
        "NEMAR_GITHUB_API_URL is set but is not",
      );
    }
  });
});

describe("the administrator's own token", () => {
  const ghThatFails = async () => {
    throw new Error("gh must not be run when GH_TOKEN is set");
  };

  test("gh is asked for its own stored login, with the variables it would prefer taken away", async () => {
    let asked: { cmd: string[]; unsetEnv?: string[] } | null = null;
    const run = (async (cmd: string[], options?: { unsetEnv?: string[] }) => {
      asked = { cmd, unsetEnv: options?.unsetEnv };
      return { stdout: "gho_from_gh\n", stderr: "", exitCode: 0 };
    }) as never;
    await adminGitHubToken({}, run);
    expect(asked).toMatchObject({ cmd: ["gh", "auth", "token", "--hostname", "github.com"] });
    expect([...(asked?.unsetEnv ?? [])].sort()).toEqual(["GITHUB_TOKEN", "GH_TOKEN"].sort());
  });

  test("GH_TOKEN wins and gh is not asked", async () => {
    const r = await adminGitHubToken({ GH_TOKEN: " tok " }, ghThatFails as never);
    expect(r).toEqual({ ok: true, token: "tok", source: "GH_TOKEN" });
  });

  test("GITHUB_TOKEN is never read: in a workflow it is the Actions bot's", async () => {
    const run = (async () => ({ stdout: "", stderr: "not logged in", exitCode: 1 })) as never;
    const r = await adminGitHubToken({ GITHUB_TOKEN: "ghs_actions" }, run);
    expect(r.ok).toBe(false);
  });

  test("a gh that never answers (a locked keyring) is reported, not waited for", async () => {
    let asked: { timeout?: number } | undefined;
    const hung = (async (_cmd: string[], options: { timeout?: number }) => {
      asked = options;
      return { stdout: "", stderr: "timed out", exitCode: 1, timedOut: true };
    }) as never;
    const r = await adminGitHubToken({}, hung);
    expect(asked?.timeout).toBeGreaterThan(0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("did not answer");
  });

  test("falls back to the token gh holds, and says why when it has none", async () => {
    const good = (async () => ({ stdout: "gho_from_gh\n", stderr: "", exitCode: 0 })) as never;
    expect(await adminGitHubToken({}, good)).toEqual({
      ok: true,
      token: "gho_from_gh",
      source: "gh",
    });
    const signedOut = (async () => ({
      stdout: "",
      stderr: "You are not logged into any GitHub hosts.\nmore",
      exitCode: 1,
    })) as never;
    const out = await adminGitHubToken({}, signedOut);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("not logged into any GitHub hosts");
    const missing = (async () => {
      throw new Error("ENOENT: no such file or directory, posix_spawn 'gh'");
    }) as never;
    const none = await adminGitHubToken({}, missing);
    expect(none).toEqual({ ok: false, reason: "The GitHub CLI (gh) is not installed." });
  });
});

describe("who a token is", () => {
  test("a person's token names the login", async () => {
    expect(await whoAmI(ADMIN_TOKEN, base())).toEqual({
      ok: true,
      user: { login: "queueadmin-gh", id: 9001 },
    });
  });

  test("an app installation token is refused, not accepted as someone", async () => {
    const r = await whoAmI(APP_TOKEN, base());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("not_a_person");
      expect(r.reason).toContain("app or workflow token cannot approve for you");
    }
  });

  test("a bot account and a rejected token are not people either", async () => {
    // Refused by its login (`[bot]`) AND, independently, by its account type.
    const bot = await whoAmI(BOT_TOKEN, base());
    expect(bot).toMatchObject({ ok: false, kind: "not_a_person" });
    const botByType = await whoAmI(BOT_TYPE_TOKEN, base());
    expect(botByType).toMatchObject({ ok: false, kind: "not_a_person" });
    const botByLogin = await whoAmI(BOT_LOGIN_TOKEN, base());
    expect(botByLogin).toMatchObject({ ok: false, kind: "not_a_person" });
  });

  test("a rejected token is told apart from an app token and from an outage", async () => {
    const bad = await whoAmI("nonsense", base());
    expect(bad).toMatchObject({
      ok: false,
      kind: "rejected",
      reason: "GitHub rejected this token.",
    });

    // Neither a server error, nor a rate limit, says anything about whose token this is.
    for (const [status, message] of [
      [500, "Server Error"],
      [502, "Bad Gateway"],
      [429, "Too Many Requests"],
      [403, "You have exceeded a secondary rate limit."],
    ] as const) {
      gh.userStatus = status;
      gh.userMessage = message;
      const r = await whoAmI(ADMIN_TOKEN, base());
      expect(r).toMatchObject({ ok: false, kind: "unreachable" });
      if (!r.ok) expect(r.reason).toContain(`HTTP ${status}`);
    }

    // The 403 an App installation token gets is a verdict on the token.
    gh.userStatus = null;
    expect(await whoAmI(APP_TOKEN, base())).toMatchObject({ ok: false, kind: "not_a_person" });
  });

  test("a 200 whose body cannot be read is unreadable, not 'an app token'", async () => {
    const proxy = Bun.serve({ port: 0, fetch: () => new Response("<html>proxy</html>") });
    try {
      const r = await whoAmI(ADMIN_TOKEN, `http://127.0.0.1:${proxy.port}`);
      expect(r).toMatchObject({ ok: false, kind: "unreachable" });
    } finally {
      proxy.stop(true);
    }
  });

  test("an unreachable GitHub is said to be unreachable, which is not a verdict on the token", async () => {
    const r = await whoAmI(ADMIN_TOKEN, "http://127.0.0.1:1");
    expect(r).toMatchObject({ ok: false, kind: "unreachable" });
  });

  test("the NEMAR-linked login must match, ignoring case; an unlinked account is not a mismatch", () => {
    expect(identityMatches("Queueadmin-GH", "queueadmin-gh")).toBe("match");
    expect(identityMatches("someone", "queueadmin-gh")).toBe("mismatch");
    expect(identityMatches(null, "queueadmin-gh")).toBe("unlinked");
    expect(identityMatches("", "queueadmin-gh")).toBe("unlinked");
    // Not a different person's login that merely contains it.
    expect(identityMatches("queueadmin", "queueadmin-gh")).toBe("mismatch");
  });
});

describe("what the review's verdict allows", () => {
  test("a pass proceeds; a failure and a review still running need --force; the rest ask first", () => {
    expect(approvalGate({ verdict: "pass", staleVerdict: null })).toEqual({ kind: "proceed" });
    expect(approvalGate({ verdict: "fail", staleVerdict: null }).kind).toBe("needs_force");
    expect(approvalGate({ verdict: "in_progress", staleVerdict: null }).kind).toBe("needs_force");
    for (const v of ["uncertain", "could_not_decide", "not_reviewed", "exempt"] as const) {
      expect(approvalGate({ verdict: v, staleVerdict: null }).kind).toBe("confirm");
    }
  });

  test("an exempt pull request asks first and says why: it is neither a pass nor a block", () => {
    const gate = approvalGate({ verdict: "exempt", staleVerdict: null });
    expect(gate.kind).toBe("confirm");
    if (gate.kind === "confirm") {
      expect(gate.warning).toContain("did not run");
      expect(gate.warning).toContain("owner or administrator");
    }
    // An unreadable answer still beats it: nothing is assumed about a review that cannot be read.
    expect(approvalGate({ verdict: "exempt", staleVerdict: null, unread: "down" }).kind).toBe(
      "needs_force",
    );
  });

  test("an exempt pull request says what an earlier commit's review concluded, because that change is still in it", () => {
    const gate = approvalGate({ verdict: "exempt", staleVerdict: "fail" });
    expect(gate.kind).toBe("confirm");
    if (gate.kind === "confirm") {
      expect(gate.warning).toContain("did not run on this commit");
      expect(gate.warning).toContain("An earlier commit of it was reviewed and read fail");
    }
    const none = approvalGate({ verdict: "exempt", staleVerdict: null });
    if (none.kind === "confirm") expect(none.warning).not.toContain("earlier commit");
  });

  test("a review of a different commit says what it concluded, so its pass is not read as this one's", () => {
    const gate = approvalGate({ verdict: "not_reviewed", staleVerdict: "pass" });
    expect(gate.kind).toBe("confirm");
    if (gate.kind === "confirm") expect(gate.warning).toContain("a different commit");
    expect(gate.kind).not.toBe("proceed");
    // A different commit's review that reached no verdict has nothing to report.
    const none = approvalGate({ verdict: "not_reviewed", staleVerdict: null });
    if (none.kind === "confirm") expect(none.warning).toContain("has not read this commit");
  });

  test("a review that could not be read is unknown, whatever else is said, and needs --force", () => {
    for (const verdict of ["pass", "fail", "not_reviewed", "uncertain"] as const) {
      const gate = approvalGate({ verdict, staleVerdict: null, unread: "the API is down" });
      expect(gate.kind).toBe("needs_force");
      if (gate.kind === "needs_force") {
        expect(gate.reason).toContain("could not be read (the API is down)");
        expect(gate.reason).toContain("verdict is unknown");
      }
    }
  });

  test("a verdict word this version does not know is not a verdict", () => {
    expect(asVerdict("pass")).toBe("pass");
    for (const odd of ["great", "", undefined, null, 3, {}]) expect(asVerdict(odd)).toBeNull();
  });
});

describe("reading the review the API sent", () => {
  const good = {
    verdict: "pass",
    head_sha: SHA_A,
    detail: null,
    stale_verdict: null,
    review_current: true,
    author: { standing: { paused: false, because: "record" } },
  };

  test("a well-formed answer about this commit is read", () => {
    expect(reviewForApproval(good, SHA_A)).toEqual({
      ok: true,
      verdict: "pass",
      detail: null,
      staleVerdict: null,
      reviewCurrent: true,
      contributorNote: null,
      outcome: null,
    });
  });

  test("a paused contributor is named, because that is what an approver most needs to know", () => {
    const r = reviewForApproval(
      {
        ...good,
        verdict: "not_reviewed",
        detail: "contributor_paused",
        review_current: null,
        author: { standing: { paused: true, because: "maintainer" } },
      },
      SHA_A,
    );
    expect(r).toMatchObject({ ok: true, detail: "contributor_paused" });
    if (r.ok) expect(r.contributorNote).toContain("paused by an administrator's block");
  });

  test("a pause whose cause this CLI does not know is a plain pause, not a block", () => {
    const r = reviewForApproval(
      {
        ...good,
        verdict: "not_reviewed",
        detail: "contributor_paused",
        review_current: null,
        author: { standing: { paused: true, because: "tally" } },
      },
      SHA_A,
    );
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      expect(r.contributorNote).toBe(
        "The contributor's pull requests are not reviewed automatically (paused).",
      );
    }
  });

  test("anything that cannot be read as an answer about THIS commit is unread, which needs --force", () => {
    const cases: Array<[string, unknown]> = [
      ["no body", null],
      ["a verdict this CLI does not know", { ...good, verdict: "brilliant" }],
      ["no verdict", { head_sha: SHA_A }],
      ["a different commit (a Worker that ignored ?head)", { ...good, head_sha: SHA_B }],
      ["no commit", { ...good, head_sha: null }],
      ["a stale verdict that is not one", { ...good, stale_verdict: "great" }],
      ["a review_current that is not a boolean", { ...good, review_current: "yes" }],
    ];
    for (const [label, body] of cases) {
      const r = reviewForApproval(body, SHA_A);
      expect(r.ok, label).toBe(false);
    }
    // An unknown word is not "could not decide": that is a question --yes would answer.
    const unknown = reviewForApproval({ ...good, verdict: "brilliant" }, SHA_A);
    if (!unknown.ok) expect(unknown.why).toContain("does not know");
  });
});

describe("a pull request that cannot be approved", () => {
  const open = {
    state: "open" as const,
    draft: false,
    baseRef: "main",
    headSha: SHA_A,
    authorLogin: "contributor",
    mergeableState: "clean",
  };
  test("is refused for the right reason, and an ordinary one is not", () => {
    expect(refusalFor(open)).toBeNull();
    expect(refusalFor({ ...open, state: "merged" })).toContain("already merged");
    expect(refusalFor({ ...open, state: "closed" })).toContain("closed");
    expect(refusalFor({ ...open, baseRef: "dev" })).toContain("not main");
    expect(refusalFor({ ...open, draft: true })).toContain("draft");
  });

  test("the fallback names the link and the equivalent gh command", () => {
    expect(pullRequestUrl("nm000201", 7)).toBe("https://github.com/nemarDatasets/nm000201/pull/7");
    expect(manualApprovalCommand("nm000201", 7)).toBe(
      "gh pr review 7 --repo nemarDatasets/nm000201 --approve",
    );
  });
});

describe("reading the pull request", () => {
  test("returns what GitHub says now", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A, author: "alice", mergeableState: "blocked" };
    const r = await fetchPullRequest(ADMIN_TOKEN, "nm000201", 7, base());
    expect(r).toEqual({
      ok: true,
      value: {
        state: "open",
        draft: false,
        baseRef: "main",
        headSha: SHA_A,
        authorLogin: "alice",
        mergeableState: "blocked",
      },
    });
  });

  test("a pull request you cannot see is a 404 that says so", async () => {
    const r = await fetchPullRequest(ADMIN_TOKEN, "nm000201", 99, base());
    expect(r).toMatchObject({ ok: false, status: 404 });
    if (!r.ok) expect(r.reason).toContain("has no pull request #99");
  });
});

describe("approving", () => {
  const approve = (sha = SHA_A, login = "queueadmin-gh") =>
    submitApproval(ADMIN_TOKEN, "nm000201", 7, sha, login, "Looks right.", base());

  test("is recorded on the exact commit shown, under the administrator's token", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A };
    expect(await approve()).toEqual({ ok: true });
    const post = gh.seen.find((s) => s.method === "POST" && s.path.endsWith("/reviews"));
    expect(post?.token).toBe(ADMIN_TOKEN);
    expect(post?.body).toEqual({ commit_id: SHA_A, event: "APPROVE", body: "Looks right." });
  });

  test("an approval of an older commit stays on that commit when the branch has moved", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_B }; // the head moved on after the administrator looked
    expect(await approve(SHA_A)).toEqual({ ok: true });
    const post = gh.seen.find((s) => s.path.endsWith("/reviews"));
    expect((post?.body as { commit_id: string }).commit_id).toBe(SHA_A);
  });

  test("trusts GitHub's answer, not the request: a review that is not an approval is a failure", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A };
    gh.reviewState = "COMMENTED";
    const r = await approve();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not the approval that was asked for");
  });

  test("an approval recorded under a different login than the one checked is a failure", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A };
    const r = await approve(SHA_A, "someone-else");
    expect(r.ok).toBe(false);
  });

  test("an approval recorded on a different commit than asked is a failure", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A };
    gh.reviewCommit = SHA_B;
    const r = await approve();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not the approval that was asked for");
  });

  test("a connection that drops is an unknown outcome (status 0), not a refusal", async () => {
    const dead = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          socket.end();
        },
        data() {},
      },
    });
    try {
      const r = await submitApproval(
        ADMIN_TOKEN,
        "nm000201",
        7,
        SHA_A,
        "queueadmin-gh",
        "ok",
        `http://127.0.0.1:${dead.port}`,
      );
      expect(r).toMatchObject({ ok: false, status: 0, outcome: "unknown" });
      // The read before a merge failed, so no merge was sent: that is not "may have merged".
      const m = await mergeWhenClean(ADMIN_TOKEN, "nm000201", 7, SHA_A, "merge", {
        base: `http://127.0.0.1:${dead.port}`,
        sleep: async () => {},
      });
      expect(m).toMatchObject({ ok: false, status: 0, outcome: "not_sent" });
      if (!m.ok) {
        expect(m.reason).toStartWith("Not merged: ");
        expect(m.reason).toContain("The approval stands.");
      }
    } finally {
      dead.stop(true);
    }
  });

  test("GitHub's refusal comes through in plain words, as a refusal", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A };
    gh.reviewStatus = 422;
    const r = await approve();
    expect(r).toMatchObject({ ok: false, status: 422, outcome: "refused" });
    if (!r.ok) expect(r.reason).toContain("Can not approve your own pull request");
  });

  test("a review that exists but is not the approval asked for says what it is", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A };
    gh.reviewState = "COMMENTED";
    const r = await approve();
    expect(r).toMatchObject({ ok: false, outcome: "different" });
    if (!r.ok) expect(r.reason).toContain("state COMMENTED");
    gh.reviewState = null;
    gh.reviewCommit = SHA_B;
    const c = await approve();
    expect(c).toMatchObject({ ok: false, outcome: "different" });
    if (!c.ok) expect(c.reason).toContain("commit bbbbbbb");
    const other = await approve(SHA_A, "someone-else");
    expect(other).toMatchObject({ ok: false, outcome: "different" });
    if (!other.ok) expect(other.reason).toContain("by @queueadmin-gh");
  });

  test("an answer that cannot be read, or a gateway error, may have been applied: unknown, not refused", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A };
    // The approval IS recorded; only the answer is unreadable.
    gh.unreadableAnswers = true;
    const unreadable = await approve();
    expect(unreadable).toMatchObject({ ok: false, status: 200, outcome: "unknown" });
    expect(gh.seen.filter((s) => s.method === "POST" && s.path.endsWith("/reviews"))).toHaveLength(
      1,
    );

    gh.unreadableAnswers = false;
    for (const status of [500, 502, 504]) {
      gh.reviewStatus = status;
      expect(await approve(), String(status)).toMatchObject({ ok: false, outcome: "unknown" });
    }
    for (const status of [401, 403, 404, 422]) {
      gh.reviewStatus = status;
      expect(await approve(), String(status)).toMatchObject({ ok: false, outcome: "refused" });
    }
  });
});

describe("commenting and closing", () => {
  const comment = (text = "Please add a CHANGES entry.") =>
    postComment(ADMIN_TOKEN, "nm000201", 7, text, base());
  const close = () => closePullRequest(ADMIN_TOKEN, "nm000201", 7, base());

  test("a comment is posted under the administrator's token, exactly as typed", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A };
    expect(await comment("  Two spaces, an @mention and `code`.  ")).toEqual({ ok: true });
    expect(gh.comments).toEqual([
      {
        dataset: "nm000201",
        number: 7,
        body: "  Two spaces, an @mention and `code`.  ",
        token: ADMIN_TOKEN,
      },
    ]);
  });

  test("closing sends state closed and checks the answer says closed", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A };
    expect(await close()).toEqual({ ok: true });
    const patch = gh.seen.find((x) => x.method === "PATCH");
    expect(patch?.token).toBe(ADMIN_TOKEN);
    expect(patch?.body).toEqual({ state: "closed" });
    expect(gh.pulls["nm000201#7"].state).toBe("closed");
  });

  test("a refusal is a refusal, and a gateway error or an unreadable answer is unknown", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A };
    for (const write of [comment, close]) {
      gh.commentStatus = 422;
      gh.closeStatus = 422;
      expect(await write(), "422").toMatchObject({ ok: false, outcome: "refused", status: 422 });
      gh.commentStatus = 502;
      gh.closeStatus = 502;
      expect(await write(), "502").toMatchObject({ ok: false, outcome: "unknown", status: 502 });
      gh.commentStatus = null;
      gh.closeStatus = null;
      gh.unreadableAnswers = true;
      expect(await write(), "unreadable").toMatchObject({ ok: false, outcome: "unknown" });
      gh.unreadableAnswers = false;
    }
  });

  test("a close that GitHub answers with another state is reported as that", async () => {
    const srv = Bun.serve({ port: 0, fetch: () => Response.json({ state: "open" }) });
    try {
      const r = await closePullRequest(ADMIN_TOKEN, "nm000201", 7, `http://127.0.0.1:${srv.port}`);
      expect(r).toMatchObject({ ok: false, outcome: "different" });
      if (!r.ok) expect(r.reason).toContain("open, not closed");
    } finally {
      srv.stop(true);
    }
  });

  test("a request that gets no answer is unknown", async () => {
    const r = await postComment(ADMIN_TOKEN, "nm000201", 7, "hi", "http://127.0.0.1:1");
    expect(r).toMatchObject({ ok: false, status: 0, outcome: "unknown" });
    expect(await closePullRequest(ADMIN_TOKEN, "nm000201", 7, "http://127.0.0.1:1")).toMatchObject({
      ok: false,
      status: 0,
      outcome: "unknown",
    });
  });
});

describe("merging", () => {
  const merge = (method: "merge" | "squash" | "rebase" = "merge", sha = SHA_A) =>
    mergeWhenClean(ADMIN_TOKEN, "nm000201", 7, sha, method, {
      base: base(),
      sleep: async () => {},
    });
  const puts = () => gh.seen.filter((s) => s.method === "PUT");

  test("merges the approved commit when GitHub says it is clean, with the chosen method", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A, mergeableState: "clean" };
    expect(await merge("squash")).toEqual({ ok: true });
    expect(puts()).toHaveLength(1);
    expect(puts()[0].token).toBe(ADMIN_TOKEN);
    expect(puts()[0].body).toEqual({ sha: SHA_A, merge_method: "squash" });
  });

  test("asks again while GitHub is still working out mergeability, then merges", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A, mergeableState: "clean", unknownReads: 2 };
    let slept = 0;
    const r = await mergeWhenClean(ADMIN_TOKEN, "nm000201", 7, SHA_A, "merge", {
      base: base(),
      sleep: async () => {
        slept++;
      },
    });
    expect(r).toEqual({ ok: true });
    expect(slept).toBe(2);
  });

  test("never merges around the ruleset: anything but clean is reported and nothing is sent", async () => {
    // A state this code has never heard of is not clean either.
    for (const state of ["blocked", "behind", "dirty", "unstable", "draft", "brand_new_state"]) {
      gh.reset();
      gh.pulls["nm000201#7"] = { sha: SHA_A, mergeableState: state };
      const r = await merge();
      expect(r.ok).toBe(false);
      if (!r.ok) {
        // The refusal that is reported carries the state it was made for.
        expect(r.merge?.why).toContain(`'${state}'`);
        expect(r.reason).toContain("The approval stands");
      }
      expect(puts()).toHaveLength(0);
    }
  });

  test("gives up on a mergeability GitHub never settles, rather than guessing", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A, unknownReads: 99 };
    const r = await mergeWhenClean(ADMIN_TOKEN, "nm000201", 7, SHA_A, "merge", {
      base: base(),
      sleep: async () => {},
      tries: 3,
    });
    expect(r.ok).toBe(false);
    expect(puts()).toHaveLength(0);
  });

  test("does not merge a branch that moved after the approval", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_B, mergeableState: "clean" };
    const r = await merge("merge", SHA_A);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(puts()).toHaveLength(0);
  });

  test("a refusal from GitHub at the last step is reported, not swallowed", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A, mergeableState: "clean" };
    gh.mergeStatus = 405;
    const r = await merge();
    expect(r).toMatchObject({ ok: false, status: 405, outcome: "refused" });
    if (!r.ok) expect(r.reason).toContain("not mergeable");
  });

  test("only `clean` merges: has_hooks (a GitHub Enterprise Server value) is not clean", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A, mergeableState: "has_hooks" };
    const r = await merge();
    expect(r).toMatchObject({ ok: false, status: 405, outcome: "not_sent" });
    expect(puts()).toHaveLength(0);
  });

  test("every decision not to ask says nothing was sent", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A, mergeableState: "blocked" };
    expect(await merge()).toMatchObject({ ok: false, outcome: "not_sent" });
    gh.pulls["nm000201#7"] = { sha: SHA_B, mergeableState: "clean" };
    expect(await merge("merge", SHA_A)).toMatchObject({ ok: false, outcome: "not_sent" });
  });

  test("a pull request that was closed or merged after the approval is not merged, and the approval stands", async () => {
    for (const fields of [
      { state: "closed" as const },
      { state: "closed" as const, merged: true },
    ]) {
      gh.reset();
      gh.pulls["nm000201#7"] = { sha: SHA_A, mergeableState: "clean", ...fields };
      const r = await merge();
      expect(r, JSON.stringify(fields)).toMatchObject({ ok: false, outcome: "not_sent" });
      if (!r.ok) {
        expect(r.reason).toContain("no longer open");
        expect(r.reason).toContain("The approval stands.");
      }
      expect(puts()).toHaveLength(0);
    }
  });

  test("a merge answered by a gateway error, or by a body that cannot be read, may have happened", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A, mergeableState: "clean" };
    gh.mergeStatus = 502;
    expect(await merge()).toMatchObject({ ok: false, status: 502, outcome: "unknown" });
    gh.mergeStatus = 200;
    gh.unreadableAnswers = true;
    const r = await merge();
    expect(r).toMatchObject({ ok: false, status: 200, outcome: "unknown" });
    if (!r.ok) expect(r.reason).toContain("did not say the pull request was merged");
  });

  test("a 200 that says merged: false is not a merge", async () => {
    const srv = Bun.serve({
      port: 0,
      fetch(req) {
        if (req.method === "PUT") return Response.json({ merged: false, message: "Not merged" });
        return Response.json({
          state: "open",
          merged: false,
          draft: false,
          base: { ref: "main" },
          head: { sha: SHA_A },
          user: { login: "alice" },
          mergeable_state: "clean",
        });
      },
    });
    try {
      const r = await mergeWhenClean(ADMIN_TOKEN, "nm000201", 7, SHA_A, "merge", {
        base: `http://127.0.0.1:${srv.port}`,
        sleep: async () => {},
      });
      expect(r.ok).toBe(false);
    } finally {
      srv.stop(true);
    }
  });

  test("a merge request that gets no answer is unknown", async () => {
    // Serves the read, then drops the connection on the merge itself.
    const srv = Bun.serve({
      port: 0,
      fetch(req) {
        if (req.method === "PUT") {
          queueMicrotask(() => srv.stop(true));
          return new Promise<Response>(() => {});
        }
        return Response.json({
          state: "open",
          merged: false,
          draft: false,
          base: { ref: "main" },
          head: { sha: SHA_A },
          user: { login: "alice" },
          mergeable_state: "clean",
        });
      },
    });
    const r = await mergeWhenClean(ADMIN_TOKEN, "nm000201", 7, SHA_A, "merge", {
      base: `http://127.0.0.1:${srv.port}`,
      sleep: async () => {},
    });
    srv.stop(true);
    expect(r).toMatchObject({ ok: false, status: 0, outcome: "unknown" });
  });
});

describe("what GitHub's mergeable state allows, asked before anything is written", () => {
  /** The pull request as a caller has read it: a head, and the state read with it when it was read. */
  const seen = (mergeableState: string | null = null) => ({ headSha: SHA_A, mergeableState });
  const options = (extra: Partial<Parameters<typeof settleMergeState>[4]> = {}) => {
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
    };
    return { slept, opts: { base: base(), sleep, ...extra } };
  };
  const settle = async (
    from: { headSha: string; mergeableState: string | null } = seen(),
    extra: Partial<Parameters<typeof settleMergeState>[4]> = {},
  ) => {
    const { slept, opts } = options(extra);
    return { result: await settleMergeState(ADMIN_TOKEN, "nm000201", 7, from, opts), slept };
  };
  const check = async (
    from: { headSha: string; mergeableState: string | null } = seen(),
    extra: Partial<Parameters<typeof settleMergeState>[4]> = {},
  ) => checkMergeable(ADMIN_TOKEN, "nm000201", 7, from, options(extra).opts);
  /** The sentence a merge that is not allowed is refused with, or null when it is. */
  const refusal = (state: string | null | undefined) => {
    const c = mergeCheckOf(state);
    return c.ok ? null : c.why;
  };
  const reads = () => gh.seen.filter((s) => s.method === "GET" && s.path.endsWith("/pulls/7"));

  test("only clean allows a merge, and the sentence names the state and why it blocks", () => {
    expect(refusal("clean")).toBeNull();
    for (const [state, why] of [
      ["unstable", "a check or status that is not required is not passing or has not reported"],
      ["blocked", "a required check or review is not satisfied"],
      ["behind", "the branch is behind main"],
      ["dirty", "it has merge conflicts"],
      ["draft", "it is a draft"],
      ["unknown", "GitHub has not said whether it can be merged"],
      ["has_hooks", "this tool merges only a pull request GitHub reports as clean"],
      ["brand_new_state", "this tool merges only a pull request GitHub reports as clean"],
    ] as const) {
      const said = refusal(state);
      expect(said, state).toContain(`'${state}'`);
      expect(said, state).toContain(why);
      expect(said, state).toContain("so a merge would not be attempted");
    }
  });

  test("a blocked state names what can block, and names the review check, and no other, as the one to override in the GitHub UI, where its ruleset is in force", () => {
    // GitHub says `blocked` for any required check or review that is not satisfied. The review is
    // one of them where a dataset's ruleset requires it (ADR 0107), and it is the one check this
    // tool names as overridable in the GitHub UI by an owner or administrator: the tool never uses
    // the bypass they hold there. Saying so of every blocked pull request would send an
    // administrator to override a block that is not the review's.
    const why = refusal("blocked") ?? "";
    expect(why).toContain("a required check or review is not satisfied");
    // The other blocks are named, not left to be read as the review.
    expect(why).toContain("the BIDS validation, the version check");
    expect(why).toContain("where its ruleset is in force, the NEMAR PR Review");
    // What the tool names as overridable is the review check alone, and only where its ruleset is
    // in force. It is what the tool names, and not a claim about what GitHub allows.
    expect(why).toContain(
      "this tool names the NEMAR PR Review check, and no other, as one an owner or administrator can override in the GitHub UI, and only where its ruleset is in force",
    );
    expect(why).toContain("never uses the bypass");
    // It must not say that the review is the only check anyone can override. An organization owner
    // bypasses the NEMAR branch protection ruleset too, and that is the ruleset that carries the
    // BIDS validation and the version check.
    expect(
      buildBranchRulesetPayload({ checks: [] }).bypass_actors.map((a) => a.actor_type),
    ).toContain("OrganizationAdmin");
    expect(why).not.toContain("can override only");
    expect(why).not.toContain("override only");
    // The old sentence told them to merge "such a pull request", whichever check was blocking it.
    expect(why).not.toContain("such a pull request");
    expect(why).not.toContain("merges");
    // The same sentence reaches the card `next` shows, and no other state says it.
    const check = mergeCheckOf("blocked");
    if (!check.ok) expect(check.card).toContain("in the GitHub UI");
    for (const state of ["behind", "dirty", "unstable", "draft", "unknown"]) {
      expect(refusal(state), state).not.toContain("GitHub UI");
    }
  });

  test("a state that is the name of an object property is an unrecognised state, not that property", () => {
    for (const state of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      const said = refusal(state);
      expect(said, state).toContain("this tool merges only a pull request GitHub reports as clean");
      expect(said, state).not.toContain("function");
      expect(said, state).not.toContain("[object");
      expect(notCleanWhy(state), state).toBe(
        "this tool merges only a pull request GitHub reports as clean",
      );
    }
  });

  test("a state that is missing or empty is not clean, it is unknown", () => {
    for (const state of [undefined, null, ""]) {
      expect(refusal(state), String(state)).toContain("'unknown'");
    }
  });

  test("a state word that is not one of GitHub's is not shown as sent", () => {
    expect(stateWord("has_hooks")).toBe("has_hooks");
    for (const odd of [
      "\u001b[31mred",
      "UPPER",
      "has hooks",
      "x".repeat(40),
      "[link](http://x.test)",
    ]) {
      expect(stateWord(odd), odd).toBe("unrecognised");
      expect(refusal(odd), odd).toContain("'unrecognised'");
    }
  });

  test("an answer that carries no mergeable_state is read as unknown, never as clean", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A, omitMergeableState: true };
    const read = await fetchPullRequest(ADMIN_TOKEN, "nm000201", 7, base());
    expect(read).toMatchObject({ ok: true, value: { mergeableState: "unknown" } });
    // ...and asked about again, because unknown is what GitHub says while it works it out.
    const { result, slept } = await settle(seen(), { tries: 2 });
    expect(result).toEqual({ ok: true, state: "unknown" });
    expect(reads()).toHaveLength(3);
    expect(slept).toHaveLength(1);
  });

  test("a state already read and settled is used as it is, with no further read", async () => {
    const { result, slept } = await settle(seen("unstable"));
    expect(result).toEqual({ ok: true, state: "unstable" });
    expect(reads()).toHaveLength(0);
    expect(slept).toEqual([]);
  });

  test("an unknown already read is asked about again after a wait, and the new answer is used", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A, mergeableState: "unstable" };
    const { result, slept } = await settle(seen("unknown"));
    expect(result).toEqual({ ok: true, state: "unstable" });
    expect(reads()).toHaveLength(1);
    expect(slept).toEqual([1000]);
  });

  test("with nothing read yet it reads, and asks again while GitHub says unknown", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A, mergeableState: "clean", unknownReads: 2 };
    const { result, slept } = await settle();
    expect(result).toEqual({ ok: true, state: "clean" });
    expect(reads()).toHaveLength(3);
    expect(slept).toEqual([1000, 1000]);
  });

  test("a state that never settles comes back as unknown after the reads allowed, with no wait after the last", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A, unknownReads: 99 };
    const { result, slept } = await settle(seen(), { tries: 3 });
    expect(result).toEqual({ ok: true, state: "unknown" });
    expect(reads()).toHaveLength(3);
    expect(slept).toHaveLength(2);
    // ...and unknown is not clean.
    expect(refusal("unknown")).not.toBeNull();
  });

  test("a head that is no longer the commit acted on is reported, not read as a state", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_B, mergeableState: "clean" };
    expect((await settle()).result).toEqual({ ok: false, kind: "moved" });
  });

  test("a pull request that cannot be read is reported with GitHub's status", async () => {
    const { result } = await settle();
    expect(result).toMatchObject({ ok: false, kind: "unreadable", status: 404 });
  });

  test("a pull request that is no longer open when asked again is reported, merged or closed", async () => {
    for (const [fields, merged] of [
      [{ state: "closed" as const }, false],
      [{ state: "closed" as const, merged: true }, true],
    ] as const) {
      gh.reset();
      gh.pulls["nm000201#7"] = { sha: SHA_A, mergeableState: "clean", ...fields };
      const { result } = await settle(seen("unknown"));
      expect(result, JSON.stringify(fields)).toEqual({ ok: false, kind: "closed", merged });
    }
  });

  test("the state and the head it was read with travel together, so a state is never paired with another commit", async () => {
    // The caller hands over the pull request it read, and the re-read is held to that one's head.
    gh.pulls["nm000201#7"] = { sha: SHA_A, unknownReads: 1 };
    const read = await fetchPullRequest(ADMIN_TOKEN, "nm000201", 7, base());
    if (!read.ok) throw new Error("the stand-in answered no pull request");
    expect(read.value).toMatchObject({ headSha: SHA_A, mergeableState: "unknown" });
    gh.pulls["nm000201#7"].sha = SHA_B; // a push lands before the state is asked about again
    expect((await settle(read.value)).result).toEqual({ ok: false, kind: "moved" });
  });
});

describe("the one check a merge is asked about, before the approval and again right before it", () => {
  const seen = (mergeableState: string | null = null) => ({ headSha: SHA_A, mergeableState });
  const opts = () => ({ base: base(), sleep: async () => {} });
  const check = (from = seen(), extra = {}) =>
    checkMergeable(ADMIN_TOKEN, "nm000201", 7, from, { ...opts(), ...extra });
  const reads = () => gh.seen.filter((s) => s.method === "GET" && s.path.endsWith("/pulls/7"));

  test("clean is the only state that allows it, and a clean one already read costs no read", async () => {
    expect(mergeCheckOf("clean")).toEqual({ ok: true });
    expect(await check(seen("clean"))).toEqual({ ok: true });
    expect(reads()).toHaveLength(0);
  });

  test("a state that will not clear by itself advises approving without merging, one that may clear says to try again", () => {
    for (const state of [
      "unstable",
      "blocked",
      "behind",
      "dirty",
      "draft",
      "has_hooks",
      "odd_one",
    ]) {
      expect(mergeCheckOf(state), state).toMatchObject({ ok: false, advice: "without_merge" });
    }
    for (const state of ["unknown", "", undefined, null]) {
      expect(mergeCheckOf(state), String(state)).toMatchObject({ ok: false, advice: "retry" });
    }
  });

  test("each way of not getting a state says what actually happened, not that GitHub has not said", async () => {
    // Cannot be read at all.
    const unreadable = await check(seen("unknown"));
    expect(unreadable).toMatchObject({ ok: false, advice: "retry" });
    if (!unreadable.ok) {
      expect(unreadable.why).toContain("Could not check whether it can be merged");
      expect(unreadable.why).toContain("has no pull request #7");
      expect(unreadable.why).not.toContain("has not said");
      expect(unreadable.card).toContain("could not be checked");
    }
    // Read, but the branch is another commit now.
    gh.pulls["nm000201#7"] = { sha: SHA_B, mergeableState: "clean" };
    const moved = await check(seen("unknown"));
    // Waiting does not help a moved head: a fresh run reads the new commit.
    expect(moved).toMatchObject({ ok: false, advice: "rerun" });
    if (!moved.ok) {
      expect(moved.why).toContain("The pull request changed since it was read.");
      expect(moved.why).not.toContain("has not said");
    }
    // Read, and GitHub still says unknown after the reads allowed: that IS "has not said".
    gh.pulls["nm000201#7"] = { sha: SHA_A, unknownReads: 99 };
    const unsettled = await check(seen("unknown"), { tries: 2 });
    expect(unsettled).toMatchObject({ ok: false, advice: "retry" });
    if (!unsettled.ok) expect(unsettled.why).toContain("'unknown' (GitHub has not said whether");
  });

  test("a pull request that is no longer open says so, and there is nothing to retry or approve around", async () => {
    for (const [fields, word] of [
      [{ state: "closed" as const }, "closed"],
      [{ state: "closed" as const, merged: true }, "merged"],
    ] as const) {
      gh.reset();
      gh.pulls["nm000201#7"] = { sha: SHA_A, mergeableState: "clean", ...fields };
      const closed = await check(seen("unknown"));
      expect(closed, word).toMatchObject({ ok: false, advice: "none" });
      if (!closed.ok) {
        expect(closed.why, word).toBe(`The pull request is no longer open (it was ${word}).`);
        expect(closed.card, word).toContain("no longer open");
      }
    }
  });

  test("the check right before an approval reads again with only the head in hand, and says it is the second look", async () => {
    const late = () => recheckBeforeApproval(ADMIN_TOKEN, "nm000201", 7, SHA_A, opts());
    gh.pulls["nm000201#7"] = { sha: SHA_A, mergeableState: "clean" };
    expect(await late()).toEqual({ ok: true });
    expect(reads()).toHaveLength(1); // one request when it is clean

    gh.reset();
    gh.pulls["nm000201#7"] = { sha: SHA_A, mergeableState: "unstable" };
    const held = await late();
    expect(held).toMatchObject({ ok: false, advice: "without_merge" });
    if (!held.ok) {
      expect(held.why).toStartWith(
        "Checked again just before approving: GitHub reports this pull request as 'unstable'",
      );
    }
    // The same refusal, without the prefix, from the check made earlier.
    const early = await check(seen("unstable"));
    if (!early.ok && !held.ok)
      expect(held.why).toBe(`Checked again just before approving: ${early.why}`);
  });

  test("a failed read is never clean, even when the state it was asked about was", async () => {
    // The caller's own state is "unknown", so the check reads again; the read fails.
    gh.pulls["nm000201#7"] = {
      sha: SHA_A,
      mergeableState: "clean",
      adminReadsAfterFirst: { status: 502 },
    };
    await fetchPullRequest(ADMIN_TOKEN, "nm000201", 7, base()); // the caller's first read
    expect((await check(seen("unknown"))).ok).toBe(false);
  });
});

// A different person's token is a person, which is why identity is matched against the NEMAR link.
test("another person's token is a person: the NEMAR link is what tells them apart", async () => {
  expect(await whoAmI(OTHER_TOKEN, base())).toMatchObject({
    ok: true,
    user: { login: "someone-else" },
  });
});
