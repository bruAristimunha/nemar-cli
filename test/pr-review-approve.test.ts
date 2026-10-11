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
import {
  adminGitHubToken,
  approvalGate,
  asVerdict,
  closePullRequest,
  fetchPullRequest,
  githubApiBase,
  identityMatches,
  manualApprovalCommand,
  mergeWhenClean,
  postComment,
  pullRequestUrl,
  refusalFor,
  reviewForApproval,
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
    for (const v of ["uncertain", "could_not_decide", "not_reviewed"] as const) {
      expect(approvalGate({ verdict: v, staleVerdict: null }).kind).toBe("confirm");
    }
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
    if (r.ok) expect(r.contributorNote).toContain("paused by a maintainer");
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
        expect(r.mergeableState).toBe(state);
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

// A different person's token is a person, which is why identity is matched against the NEMAR link.
test("another person's token is a person: the NEMAR link is what tells them apart", async () => {
  expect(await whoAmI(OTHER_TOKEN, base())).toMatchObject({
    ok: true,
    user: { login: "someone-else" },
  });
});
