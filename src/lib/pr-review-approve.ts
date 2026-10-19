/**
 * Approving a dataset pull request as the administrator themselves (ADR 0093).
 *
 * **Why this runs on the administrator's machine and not in the Worker.** An approval is a person
 * vouching for a change, and GitHub records whose. No Worker code path approves, and the Worker
 * holds nothing that belongs to an individual administrator; the tokens it does hold (the NEMAR App
 * and the datasets token) could submit a review, which is exactly why one must never be made with
 * them: it would put the App's name on a judgment a person made, and turn the automated review
 * (which the App publishes) into its own approval. So the approval is a request from here to
 * GitHub, with the token the administrator already holds, and the only thing the NEMAR API
 * contributes is the automated verdict to show them first.
 *
 * - **The token is checked before it is used.** `GET /user` answers for a person's token and refuses
 *   an App installation token (403), so a CI or bot credential left in `GH_TOKEN` cannot approve "as"
 *   someone. The login it names is also compared with the one the administrator's NEMAR account is
 *   linked to. `gh auth token` is run with `GH_TOKEN` and `GITHUB_TOKEN` removed from its
 *   environment: `gh` itself prefers them to its stored login, and `GITHUB_TOKEN` is the Actions
 *   bot's in a workflow.
 * - **The approval is pinned to a commit.** It is submitted with `commit_id` set to the head the
 *   administrator was shown, so a push that lands in between leaves the approval on the commit they
 *   read.
 * - **A merge is a client-side check, not enforcement.** It is attempted once, only if GitHub
 *   reports the pull request `clean`; it re-asks for a few seconds while GitHub is still working
 *   the state out, does not wait for pending checks, sends the approved `sha`, and otherwise stops
 *   with the approval standing. An administrator can be a bypass actor on the
 *   ruleset, so this does not attempt a merge GitHub reports as blocked; the ruleset is what
 *   enforces, and it is not this code's job to defeat it.
 * - **Whether a merge can be asked for is settled BEFORE anything is written.** A person who asks
 *   for the merge too (`approve --merge`, or `y` in `next`) has not asked for an approval that
 *   cannot be followed by it, so {@link checkMergeable} is asked first,
 *   and a state that is not `clean` (or is still `unknown`) writes nothing. The look after the
 *   approval ({@link mergeWhenClean}) stays, for a state that changed in between.
 * - **A write whose result is not known is said to be unknown.** A request that got no answer, or
 *   an answer that cannot be read, may have been applied; it is reported as `unknown`, never as a
 *   refusal, and so is a 5xx from a gateway in front of GitHub.
 */

import type { QueueVerdict, ReadVerdict } from "../../shared/contract/pr-review-admin.js";
import { QUEUE_VERDICTS } from "../../shared/contract/pr-review-admin.js";
import { sanitizeNote } from "../../shared/pr-review.js";
import { runCommand } from "./git-annex/run-command.js";

export const DATASETS_ORG = "nemarDatasets";
const REQUEST_TIMEOUT_MS = 20_000;
const GH_TOKEN_TIMEOUT_MS = 15_000;

/** The one place a GitHub URL for a dataset pull request is built. */
export function pullRequestUrl(datasetId: string, prNumber: number): string {
  return `https://github.com/${DATASETS_ORG}/${datasetId}/pull/${prNumber}`;
}

/** The command that does what `approve` does, for an administrator who cannot or would rather not use it. */
export function manualApprovalCommand(datasetId: string, prNumber: number): string {
  return `gh pr review ${prNumber} --repo ${DATASETS_ORG}/${datasetId} --approve`;
}

/**
 * GitHub's API origin. `NEMAR_GITHUB_API_URL` exists so a test can point this at a local stand-in,
 * and it is honoured ONLY for a loopback http address: an environment variable that could send an
 * administrator's token to an arbitrary host would be an exfiltration path, not a test seam. A
 * value that is set and not acceptable is an ERROR, not a fall-through to the real GitHub: a typo
 * must not turn a rehearsal into a real approval.
 */
export function githubApiBase(env: Record<string, string | undefined> = process.env): string {
  const override = env.NEMAR_GITHUB_API_URL?.trim();
  if (!override) return "https://api.github.com";
  try {
    const u = new URL(override);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    if (u.protocol === "http:" && loopback) return override.replace(/\/+$/, "");
  } catch {
    // fall through to the error below
  }
  throw new Error(
    "NEMAR_GITHUB_API_URL is set but is not an http://127.0.0.1, http://localhost or http://[::1] address. It is only for tests, so it is refused rather than ignored; unset it to use GitHub.",
  );
}

// ---------------------------------------------------------------------------------------------
// The token and who it belongs to
// ---------------------------------------------------------------------------------------------

export type TokenSource = "GH_TOKEN" | "gh";

export type TokenResult =
  | { ok: true; token: string; source: TokenSource }
  | { ok: false; reason: string };

export async function adminGitHubToken(
  env: Record<string, string | undefined> = process.env,
  run: typeof runCommand = runCommand,
): Promise<TokenResult> {
  const fromEnv = env.GH_TOKEN?.trim();
  if (fromEnv) return { ok: true, token: fromEnv, source: "GH_TOKEN" };
  try {
    const { stdout, exitCode, stderr, timedOut } = await run(
      ["gh", "auth", "token", "--hostname", "github.com"],
      // `gh` prefers these to the login it stores, which would answer with a token that is not
      // the account `gh auth status` shows. Ask for the stored one. The timeout is for a locked
      // keyring that waits for a prompt nobody can see.
      {
        unsetEnv: ["GH_TOKEN", "GITHUB_TOKEN"],
        timeout: GH_TOKEN_TIMEOUT_MS,
        // The answer IS the token; `--verbose` would otherwise print it.
        sensitiveOutput: true,
      },
    );
    if (timedOut) {
      return {
        ok: false,
        reason: `gh did not answer within ${GH_TOKEN_TIMEOUT_MS / 1000} seconds (a locked keyring waiting for a prompt?). Set GH_TOKEN, or run 'gh auth status'.`,
      };
    }
    if (exitCode === 0 && stdout.trim()) return { ok: true, token: stdout.trim(), source: "gh" };
    return {
      ok: false,
      reason: `gh has no signed-in account for github.com (${stderr.trim().split("\n")[0] || `exit ${exitCode}`}).`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason:
        msg.includes("ENOENT") || msg.includes("not found")
          ? "The GitHub CLI (gh) is not installed."
          : `gh could not be run: ${msg}`,
    };
  }
}

export interface GitHubPerson {
  login: string;
  id: number;
}

/**
 * Why a token was not accepted as a person's: `not_a_person` (an App or workflow token, a bot, or
 * an organisation), `rejected` (GitHub refused it: expired or revoked), or `unreachable` (GitHub did
 * not answer, or answered with an error that says nothing about the token). Only the first calls for
 * the manual fallback; the others are the administrator's to fix or retry.
 */
export type IdentityResult =
  | { ok: true; user: GitHubPerson }
  | { ok: false; kind: "not_a_person" | "rejected" | "unreachable"; reason: string };

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "nemar-cli pr-reviews",
    "Content-Type": "application/json",
  };
}

/** Who a token is, if it is a person's. An App or Actions token, a bot, or a rejected token is not. */
export async function whoAmI(token: string, base = githubApiBase()): Promise<IdentityResult> {
  let res: Response;
  try {
    res = await fetch(`${base}/user`, {
      headers: headers(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      kind: "unreachable",
      reason: `GitHub could not be reached (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
  if (res.status === 401) {
    return { ok: false, kind: "rejected", reason: "GitHub rejected this token." };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // A 403 that is a rate limit says nothing about the token; the integration-token 403 does.
    if (res.status === 403 && !/rate limit|abuse/i.test(text)) {
      return {
        ok: false,
        kind: "not_a_person",
        reason:
          "This token does not belong to a GitHub user (an app or workflow token cannot approve for you).",
      };
    }
    return {
      ok: false,
      kind: "unreachable",
      reason: `GitHub answered HTTP ${res.status} when asked whose token this is. Try again in a moment.`,
    };
  }
  // A 200 whose body cannot be read says nothing about the token: it is not "an app token".
  const unreadable = Symbol("unreadable");
  const parsed = await res.json().catch(() => unreadable);
  if (parsed === unreadable) {
    return {
      ok: false,
      kind: "unreachable",
      reason:
        "GitHub answered, but the answer could not be read when asked whose token this is. Try again in a moment.",
    };
  }
  const u = parsed as { login?: unknown; id?: unknown; type?: unknown } | null;
  if (
    typeof u?.login !== "string" ||
    typeof u.id !== "number" ||
    u.type !== "User" ||
    u.login.endsWith("[bot]")
  ) {
    return {
      ok: false,
      kind: "not_a_person",
      reason: "This token does not belong to a GitHub user, so it cannot approve for you.",
    };
  }
  return { ok: true, user: { login: u.login, id: u.id } };
}

/**
 * Whether the GitHub login is the one the administrator's NEMAR account is linked to. `unlinked`
 * means the account names no GitHub login (an ORCID or email account): nothing to compare, so the
 * caller shows the login being used.
 */
export function identityMatches(
  linked: string | null | undefined,
  login: string,
): "match" | "mismatch" | "unlinked" {
  if (!linked) return "unlinked";
  return linked.toLowerCase() === login.toLowerCase() ? "match" : "mismatch";
}

// ---------------------------------------------------------------------------------------------
// The pull request, as GitHub says it is now
// ---------------------------------------------------------------------------------------------

export interface PullRequestFacts {
  state: "open" | "closed" | "merged";
  draft: boolean;
  baseRef: string;
  headSha: string;
  authorLogin: string;
  /** GitHub's own mergeability verdict, which already weighs every required check and review. */
  mergeableState: string;
}

export type FetchResult<T> = { ok: true; value: T } | { ok: false; status: number; reason: string };

function why(status: number, body: unknown): string {
  const message =
    typeof body === "object" && body !== null && "message" in body
      ? sanitizeNote((body as { message: unknown }).message, 160)
      : "";
  return message ? `${message} (HTTP ${status})` : `GitHub answered HTTP ${status}.`;
}

export async function fetchPullRequest(
  token: string,
  datasetId: string,
  prNumber: number,
  base = githubApiBase(),
): Promise<FetchResult<PullRequestFacts>> {
  let res: Response;
  try {
    res = await fetch(`${base}/repos/${DATASETS_ORG}/${datasetId}/pulls/${prNumber}`, {
      headers: headers(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      reason: `GitHub could not be reached (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      reason:
        res.status === 404
          ? `${DATASETS_ORG}/${datasetId} has no pull request #${prNumber}, or your GitHub account cannot see it.`
          : why(res.status, body),
    };
  }
  const head = body?.head as { sha?: unknown } | undefined;
  const baseInfo = body?.base as { ref?: unknown } | undefined;
  const user = body?.user as { login?: unknown } | undefined;
  if (typeof head?.sha !== "string" || !/^[0-9a-f]{40}$/.test(head.sha)) {
    return { ok: false, status: res.status, reason: "GitHub's answer had no head commit." };
  }
  return {
    ok: true,
    value: {
      state: body?.merged === true ? "merged" : body?.state === "open" ? "open" : "closed",
      draft: body?.draft === true,
      baseRef: typeof baseInfo?.ref === "string" ? baseInfo.ref : "",
      headSha: head.sha,
      authorLogin: typeof user?.login === "string" ? user.login : "",
      mergeableState: typeof body?.mergeable_state === "string" ? body.mergeable_state : "unknown",
    },
  };
}

/** Why a pull request cannot be approved at all, or null when it can. */
export function refusalFor(pr: PullRequestFacts): string | null {
  if (pr.state === "merged") return "This pull request is already merged.";
  if (pr.state === "closed") return "This pull request is closed.";
  if (pr.baseRef !== "main") {
    return `This pull request targets ${sanitizeNote(pr.baseRef, 40) || "another branch"}, not main. The review queue covers pull requests to main.`;
  }
  if (pr.draft) return "This pull request is a draft. Ask the author to mark it ready first.";
  return null;
}

// ---------------------------------------------------------------------------------------------
// What the automated verdict allows
// ---------------------------------------------------------------------------------------------

/**
 * A verdict word from the NEMAR API as one this CLI knows, or null for anything else. The CLI ships
 * on npm independently of the Worker, so a newer server may say something this version has never
 * heard of. That is NOT a verdict: it reads as unknown (see {@link reviewForApproval}), which needs
 * `--force`, and never as "could not decide", a question `--yes` would answer.
 */
export function asVerdict(raw: unknown): QueueVerdict | null {
  return typeof raw === "string" && (QUEUE_VERDICTS as readonly string[]).includes(raw)
    ? (raw as QueueVerdict)
    : null;
}

const READ_VERDICT_WORDS: readonly string[] = ["pass", "fail", "uncertain"];

export type ReviewForApproval =
  | {
      ok: true;
      verdict: QueueVerdict;
      /** The closed reason behind a `not_reviewed` or `could_not_decide`, as the server sent it. */
      detail: string | null;
      staleVerdict: ReadVerdict | null;
      reviewCurrent: boolean | null;
      /** Set when an administrator has paused the contributor's reviews, in words, so the approver sees why. */
      contributorNote: string | null;
      /**
       * The stored report of the review of THIS commit, for display; null when there is none, it
       * is still running, or the review on record is of another commit (whose report is not a
       * statement about this one). Not validated here: the renderer reports what it cannot read.
       */
      outcome: unknown;
    }
  | { ok: false; why: string };

/**
 * The review a `GET /admin/pr-reviews/:dataset/:pr?head=<sha>` answer stands for, checked rather
 * than cast. Anything that cannot be read as an answer about THIS commit is `ok: false`, which the
 * caller treats as an unread review (it needs `--force`): a body with no verdict, a verdict this
 * CLI does not know, or an answer about another commit (a Worker that ignored `head`) must not be
 * softened into a gate that `--yes` skips.
 */
export function reviewForApproval(d: unknown, head: string): ReviewForApproval {
  const r = typeof d === "object" && d !== null ? (d as Record<string, unknown>) : null;
  if (!r) return { ok: false, why: "the NEMAR API sent no review" };
  const verdict = asVerdict(r.verdict);
  if (verdict === null) {
    return {
      ok: false,
      why: "the NEMAR API sent a verdict this version of the CLI does not know; update the CLI",
    };
  }
  if (r.head_sha !== head) {
    return {
      ok: false,
      why: "the NEMAR API answered about a different commit than GitHub reports",
    };
  }
  const stale = r.stale_verdict ?? null;
  if (stale !== null && !READ_VERDICT_WORDS.includes(stale as string)) {
    return { ok: false, why: "the NEMAR API sent a review this version of the CLI cannot read" };
  }
  const current = r.review_current ?? null;
  if (current !== null && typeof current !== "boolean") {
    return { ok: false, why: "the NEMAR API sent a review this version of the CLI cannot read" };
  }
  const standing = (r.author as { standing?: { paused?: unknown; because?: unknown } } | null)
    ?.standing;
  // A Worker older than this CLI can still pause by the record, and its pause is not a block.
  const contributorNote =
    standing?.paused === true
      ? `The contributor's pull requests are not reviewed automatically (paused${standing.because === "maintainer" ? " by an administrator's block" : ""}).`
      : null;
  return {
    ok: true,
    verdict,
    detail: typeof r.detail === "string" ? r.detail : null,
    staleVerdict: stale as ReadVerdict | null,
    reviewCurrent: current as boolean | null,
    contributorNote,
    outcome:
      current === true ? ((r.review as { outcome?: unknown } | null)?.outcome ?? null) : null,
  };
}

export type ApprovalGate =
  | { kind: "proceed" }
  /** Allowed after the administrator confirms (`--yes` skips the question), with this sentence shown first. */
  | { kind: "confirm"; warning: string }
  /** Refused unless the administrator says `--force`. */
  | { kind: "needs_force"; reason: string };

/**
 * What the automated review's verdict, as it stands for the commit about to be approved, means for
 * approving. A person is the final authority, so nothing is forbidden outright; but an approval
 * that goes against the review's finding, that the review has not finished, or that cannot see the
 * review at all, needs an explicit `--force`, and one the review did not clear needs a confirmation
 * that says so. A pass raises no warning, though every approval still asks unless `--yes`.
 *
 * `unread` is why the NEMAR API could not say what the review concluded. That is "unknown", which
 * is never rendered as "not reviewed": a stored rejection could be hiding behind it.
 */
export function approvalGate(input: {
  verdict: QueueVerdict;
  staleVerdict: ReadVerdict | null;
  unread?: string;
}): ApprovalGate {
  if (input.unread) {
    return {
      kind: "needs_force",
      reason: `The automated review could not be read (${input.unread}), so its verdict is unknown. Pass --force to approve without it.`,
    };
  }
  switch (input.verdict) {
    case "pass":
      return { kind: "proceed" };
    case "fail":
      return {
        kind: "needs_force",
        reason:
          "The automated review says this pull request needs changes. Read it with `show`, and pass --force to approve it anyway.",
      };
    case "in_progress":
      return {
        kind: "needs_force",
        reason:
          "The automated review of this commit is still running. Wait for it, or pass --force to approve without it.",
      };
    case "uncertain":
      return {
        kind: "confirm",
        warning: "The automated review could not decide whether this is a good change.",
      };
    case "could_not_decide":
      return { kind: "confirm", warning: "The automated review ended without a verdict." };
    case "not_reviewed":
      return {
        kind: "confirm",
        warning:
          input.staleVerdict === null
            ? "The automated review has not read this commit."
            : `The automated review read a different commit of this pull request (it said: ${input.staleVerdict}), not this one.`,
      };
    case "exempt":
      // Not a pass and not a failure: nothing was asked of a review of this commit. An earlier
      // commit of it may have been (an owner's push on top of someone else's), and its verdict is
      // said, as for a review of another commit, because that change is still in this one.
      return {
        kind: "confirm",
        warning: `The automated review did not run on this commit: a NEMAR owner or administrator opened this pull request, and they are not reviewed.${
          input.staleVerdict === null
            ? ""
            : ` An earlier commit of it was reviewed and read ${input.staleVerdict}.`
        }`,
      };
  }
}

// ---------------------------------------------------------------------------------------------
// Writing to GitHub, as the administrator
// ---------------------------------------------------------------------------------------------

/**
 * What is known of a write that did not succeed cleanly:
 *  - `not_sent`: this code decided not to send it (merge only).
 *  - `refused`: GitHub answered that it did not do it (a 4xx).
 *  - `unknown`: there is no usable answer, so it MAY have been applied: the request got no answer
 *    (`status` 0), GitHub answered 2xx with a body that cannot be read, or a gateway answered 5xx.
 *  - `different`: GitHub recorded something, but not what was asked for.
 */
export type WriteOutcome = "not_sent" | "refused" | "unknown" | "different";

export type WriteFailure = { ok: false; outcome: WriteOutcome; status: number; reason: string };
export type WriteResult = { ok: true } | WriteFailure;

function noAnswer(err: unknown): WriteFailure {
  return {
    ok: false,
    outcome: "unknown",
    status: 0,
    reason: `GitHub did not answer (${err instanceof Error ? err.message : String(err)}).`,
  };
}

/** Approve the pull request on the exact commit the administrator was shown. */
export async function submitApproval(
  token: string,
  datasetId: string,
  prNumber: number,
  headSha: string,
  expectedLogin: string,
  body: string,
  base = githubApiBase(),
): Promise<WriteResult> {
  let res: Response;
  try {
    res = await fetch(`${base}/repos/${DATASETS_ORG}/${datasetId}/pulls/${prNumber}/reviews`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ commit_id: headSha, event: "APPROVE", body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return noAnswer(err);
  }
  const answer = (await res.json().catch(() => null)) as {
    state?: unknown;
    commit_id?: unknown;
    user?: { login?: unknown };
  } | null;
  if (!res.ok) {
    return {
      ok: false,
      outcome: res.status >= 500 ? "unknown" : "refused",
      status: res.status,
      reason: why(res.status, answer),
    };
  }
  // A 2xx whose answer cannot be read does not say what was recorded. The review may exist.
  if (typeof answer?.state !== "string") {
    return {
      ok: false,
      outcome: "unknown",
      status: res.status,
      reason: `GitHub answered HTTP ${res.status}, but its answer could not be read.`,
    };
  }
  // Trust the answer, not the request: the review must be an approval, by this person, of this commit.
  const by = typeof answer.user?.login === "string" ? answer.user.login : "";
  if (
    answer.state !== "APPROVED" ||
    answer.commit_id !== headSha ||
    by.toLowerCase() !== expectedLogin.toLowerCase()
  ) {
    const got = [
      answer.state !== "APPROVED" ? `state ${sanitizeNote(answer.state, 20)}` : "",
      by.toLowerCase() !== expectedLogin.toLowerCase() ? `by @${sanitizeNote(by, 40) || "?"}` : "",
      answer.commit_id !== headSha
        ? `commit ${typeof answer.commit_id === "string" ? sanitizeNote(answer.commit_id, 40).slice(0, 7) : "?"}`
        : "",
    ].filter(Boolean);
    return {
      ok: false,
      outcome: "different",
      status: res.status,
      reason: `GitHub recorded a review, but not the approval that was asked for (${got.join(", ")}).`,
    };
  }
  return { ok: true };
}

/** Post a comment on the pull request, as the administrator, with the text exactly as given. */
export async function postComment(
  token: string,
  datasetId: string,
  prNumber: number,
  text: string,
  base = githubApiBase(),
): Promise<WriteResult> {
  let res: Response;
  try {
    res = await fetch(`${base}/repos/${DATASETS_ORG}/${datasetId}/issues/${prNumber}/comments`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ body: text }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return noAnswer(err);
  }
  const answer = (await res.json().catch(() => null)) as { id?: unknown } | null;
  if (!res.ok) {
    return {
      ok: false,
      outcome: res.status >= 500 ? "unknown" : "refused",
      status: res.status,
      reason: why(res.status, answer),
    };
  }
  // A 2xx that does not name the comment does not say it was not posted either.
  if (typeof answer?.id !== "number") {
    return {
      ok: false,
      outcome: "unknown",
      status: res.status,
      reason: `GitHub answered HTTP ${res.status}, but its answer could not be read.`,
    };
  }
  return { ok: true };
}

/** Close the pull request without merging it. The answer must say it is closed. */
export async function closePullRequest(
  token: string,
  datasetId: string,
  prNumber: number,
  base = githubApiBase(),
): Promise<WriteResult> {
  let res: Response;
  try {
    res = await fetch(`${base}/repos/${DATASETS_ORG}/${datasetId}/pulls/${prNumber}`, {
      method: "PATCH",
      headers: headers(token),
      body: JSON.stringify({ state: "closed" }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return noAnswer(err);
  }
  const answer = (await res.json().catch(() => null)) as { state?: unknown } | null;
  if (!res.ok) {
    return {
      ok: false,
      outcome: res.status >= 500 ? "unknown" : "refused",
      status: res.status,
      reason: why(res.status, answer),
    };
  }
  if (typeof answer?.state !== "string") {
    return {
      ok: false,
      outcome: "unknown",
      status: res.status,
      reason: `GitHub answered HTTP ${res.status}, but its answer could not be read.`,
    };
  }
  if (answer.state !== "closed") {
    return {
      ok: false,
      outcome: "different",
      status: res.status,
      reason: `GitHub answered, but the pull request is ${sanitizeNote(answer.state, 20)}, not closed.`,
    };
  }
  return { ok: true };
}

export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

/** `clean` is GitHub saying every required check and review is satisfied. */
const MERGEABLE = "clean";

/**
 * Why each `mergeable_state` GitHub reports is not `clean`, in words. Only `clean` is merged on, so
 * a state that is not listed (`has_hooks` is a GitHub Enterprise Server value, and GitHub can add
 * more) is still refused, with the last sentence.
 */
const NOT_CLEAN_WHY = new Map<string, string>([
  [
    "blocked",
    // GitHub says `blocked` for any required check or review that is not satisfied, and does not say
    // which, so this names what they can be. Where its ruleset is in force (ADR 0107) one of them
    // is the NEMAR PR Review check, and that is the one this tool names as overridable in the GitHub
    // UI, for an owner or administrator; the bypass is theirs on GitHub, and this tool never uses
    // it (ADR 0093). That is what this tool names, not all that GitHub allows: an organization
    // owner also bypasses the NEMAR branch protection ruleset, which carries the BIDS validation
    // and the version check, and nothing here points anyone at that one. It is said of the review
    // alone, and only where its ruleset is in force, because where the review is not required a
    // pull request is not held by it at all.
    "a required check or review is not satisfied (the BIDS validation, the version check or, where its ruleset is in force, the NEMAR PR Review); this tool names the NEMAR PR Review check, and no other, as one an owner or administrator can override in the GitHub UI, and only where its ruleset is in force, and it never uses the bypass itself",
  ],
  ["behind", "the branch is behind main"],
  ["dirty", "it has merge conflicts"],
  [
    "unstable",
    "a check or status that is not required is not passing or has not reported, for example the automated review holding the pull request",
  ],
  ["draft", "it is a draft"],
  ["unknown", "GitHub has not said whether it can be merged"],
]);

/**
 * Why GitHub's `mergeable_state` is not one a merge is attempted on. Meaningful for any state but
 * `clean`. A Map, so a state named like an object property (`constructor`) is not read as one.
 */
export function notCleanWhy(state: string): string {
  return NOT_CLEAN_WHY.get(state) ?? "this tool merges only a pull request GitHub reports as clean";
}

/** What can be done about a merge that would not be attempted: see {@link MergeCheck}. */
export type MergeAdvice = "without_merge" | "retry" | "rerun" | "none";

/**
 * What a merge may be told about GitHub's `mergeable_state`, as ONE value for every place that asks:
 * the check before an approval, the one right before it, the `next` card, and the look before the
 * merge. `ok` only for `clean`. Otherwise `why` is the sentence (which state, why it blocks, that
 * no merge would be tried), `card` the short phrase for the `next` card, and `advice` what the
 * administrator can do: `without_merge` for a state that will not clear by itself, `retry` for one
 * that may (GitHub still working it out, a read that failed), `rerun` when the head is another
 * commit than the one shown (waiting does not help, a fresh run reads the new one), `none` when the
 * pull request is no longer open.
 *
 * A state that is missing, empty or unrecognised is not `clean`: it is refused, and a missing one
 * reads as `unknown`.
 */
export type MergeCheck =
  | { ok: true }
  | { ok: false; why: string; card: string; advice: MergeAdvice };

/** A {@link MergeCheck} that refuses. */
export type MergeRefused = Extract<MergeCheck, { ok: false }>;

export function mergeCheckOf(state: string | null | undefined): MergeCheck {
  const word = state && state.length > 0 ? state : "unknown";
  if (word === MERGEABLE) return { ok: true };
  return {
    ok: false,
    why: `GitHub reports this pull request as '${stateWord(word)}' (${notCleanWhy(word)}), so a merge would not be attempted.`,
    card: `${notCleanWhy(word)} (GitHub: ${stateWord(word)})`,
    advice: word === "unknown" ? "retry" : "without_merge",
  };
}

/**
 * A `mergeable_state` as shown to a person. GitHub's are lowercase words with underscores
 * (`has_hooks`); anything else is not shown as sent, because it reaches a terminal and
 * {@link sanitizeNote} would eat the underscore.
 */
export function stateWord(state: string): string {
  return /^[a-z][a-z_]{0,29}$/.test(state) ? state : "unrecognised";
}

/**
 * What a read of GitHub's mergeability came to: the state, or why there is none. `unreadable` is a
 * failed read of the pull request (`status` is GitHub's, or 0 for no answer); `moved` is a head that
 * is no longer the commit being acted on; `closed` is a pull request that is no longer open.
 */
export type MergeStateRead =
  | { ok: true; state: string }
  | { ok: false; kind: "unreadable"; status: number; reason: string }
  | { ok: false; kind: "moved" }
  | { ok: false; kind: "closed"; merged: boolean };

/**
 * A pull request as a caller has read it: its head and, when one was read with it, the state. They
 * are one value on purpose. {@link PullRequestFacts} is one, so a caller passes what it read and a
 * state cannot be paired with a commit it was not read for.
 */
export interface MergeSeen {
  headSha: string;
  /**
   * The state read with that head, or null when none was read yet (it is then read). When it is not
   * `unknown` nothing more is read; when it is, GitHub is still working it out.
   */
  mergeableState: string | null;
}

interface SettleOptions {
  base?: string;
  sleep?: (ms: number) => Promise<void>;
  /** Reads in all, counting the one already made. */
  tries?: number;
}

/**
 * GitHub's `mergeable_state` for the head in `seen`. It is computed lazily, so an `unknown` is asked
 * about again a few times, a second apart; one that is still `unknown` after that is returned as
 * `unknown`, for the caller to treat as not clean. A re-read that finds another head is `moved`, and
 * one that finds the pull request closed or merged is `closed`. Never sleeps after the last read.
 */
export async function settleMergeState(
  token: string,
  datasetId: string,
  prNumber: number,
  seen: MergeSeen,
  options: SettleOptions = {},
): Promise<MergeStateRead> {
  const base = options.base ?? githubApiBase();
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const tries = options.tries ?? 5;

  let state = seen.mergeableState;
  let reads = state === null ? 0 : 1;
  for (;;) {
    if (state === null) {
      const pr = await fetchPullRequest(token, datasetId, prNumber, base);
      if (!pr.ok) return { ok: false, kind: "unreadable", status: pr.status, reason: pr.reason };
      if (pr.value.state !== "open") {
        return { ok: false, kind: "closed", merged: pr.value.state === "merged" };
      }
      if (pr.value.headSha !== seen.headSha) return { ok: false, kind: "moved" };
      state = pr.value.mergeableState;
      reads++;
    }
    if (state !== "unknown" || reads >= tries) return { ok: true, state };
    await sleep(1000);
    state = null;
  }
}

/** A read that gave no state, as a refusal that says what happened and not "GitHub has not said". */
function unreadMergeCheck(read: Extract<MergeStateRead, { ok: false }>): MergeRefused {
  if (read.kind === "moved") {
    return {
      ok: false,
      why: "The pull request changed since it was read.",
      card: "the pull request changed since it was read",
      advice: "rerun",
    };
  }
  if (read.kind === "closed") {
    return {
      ok: false,
      why: `The pull request is no longer open (it was ${read.merged ? "merged" : "closed"}).`,
      card: "the pull request is no longer open",
      advice: "none",
    };
  }
  const reason = read.reason.replace(/\.$/, "");
  return {
    ok: false,
    why: `Could not check whether it can be merged (${reason}).`,
    card: `could not be checked (${reason})`,
    advice: "retry",
  };
}

/**
 * Whether a merge of the head in `seen` may be asked for now: GitHub's state, asked again while it
 * is `unknown`, as a {@link MergeCheck}. This is the ONE place that decides it, for the check made
 * before the approval is confirmed, the one made right before it is written, and the `next` card.
 * A pull request whose state was already read and is settled costs no request; one passed with only
 * its head and no state (`mergeableState: null`) is read.
 */
export async function checkMergeable(
  token: string,
  datasetId: string,
  prNumber: number,
  seen: MergeSeen,
  options: SettleOptions = {},
): Promise<MergeCheck> {
  const read = await settleMergeState(token, datasetId, prNumber, seen, options);
  return read.ok ? mergeCheckOf(read.state) : unreadMergeCheck(read);
}

/**
 * The check made immediately before an approval that asks for a merge is written, by both callers
 * (`approve --merge` after its confirmation, `y` in `next` when it is answered), so they cannot
 * disagree. The early check can be minutes old by then, a check can have started or reported, and an
 * approval cannot be taken back: the state is READ again (one request when it is clean), with only the
 * head in hand so no state is carried over, and a refusal says it came from this second look.
 */
export async function recheckBeforeApproval(
  token: string,
  datasetId: string,
  prNumber: number,
  headSha: string,
  options: SettleOptions = {},
): Promise<MergeCheck> {
  const check = await checkMergeable(
    token,
    datasetId,
    prNumber,
    { headSha, mergeableState: null },
    options,
  );
  return check.ok ? check : { ...check, why: `Checked again just before approving: ${check.why}` };
}

/**
 * A merge that did not happen, with what is known of it ({@link WriteOutcome}). `not_sent` covers
 * every case where this code decided not to ask (a failed read of the pull request first, a branch
 * that moved, a state that is not `clean`), so only `unknown` means "GitHub may have merged it".
 * `status` is GitHub's where it answered, 405 or 409 where this code decided, and 0 for no answer.
 */
export type MergeResult = { ok: true } | (WriteFailure & { merge?: MergeRefused });

/**
 * Merge the pull request at `headSha`, only if GitHub says it is mergeable WITHOUT a bypass.
 * Mergeability is computed lazily, so an `unknown` is asked about again a few times.
 *
 * This runs AFTER the approval, so it is the second look, not the first: the caller that asked for
 * a merge has already checked the state before approving anything ({@link checkMergeable}), and
 * this one catches a state that changed since (a check that turned pending, a push, the approval
 * itself).
 */
export async function mergeWhenClean(
  token: string,
  datasetId: string,
  prNumber: number,
  headSha: string,
  method: MergeMethod,
  options: { base?: string; sleep?: (ms: number) => Promise<void>; tries?: number } = {},
): Promise<MergeResult> {
  const base = options.base ?? githubApiBase();

  const read = await settleMergeState(
    token,
    datasetId,
    prNumber,
    { headSha, mergeableState: null },
    options,
  );
  if (!read.ok) {
    if (read.kind === "moved") {
      return {
        ok: false,
        outcome: "not_sent",
        status: 409,
        reason: "The pull request changed after it was approved, so it was not merged.",
      };
    }
    if (read.kind === "closed") {
      return {
        ok: false,
        outcome: "not_sent",
        status: 409,
        reason: `Not merged: ${unreadMergeCheck(read).why} The approval stands.`,
      };
    }
    return {
      ok: false,
      outcome: "not_sent",
      status: read.status,
      reason: `Not merged: ${read.reason} The approval stands.`,
    };
  }
  const check = mergeCheckOf(read.state);
  if (!check.ok) {
    return {
      ok: false,
      outcome: "not_sent",
      status: 405,
      merge: check,
      reason: `Not merged: ${check.why} The approval stands.`,
    };
  }

  let res: Response;
  try {
    res = await fetch(`${base}/repos/${DATASETS_ORG}/${datasetId}/pulls/${prNumber}/merge`, {
      method: "PUT",
      headers: headers(token),
      body: JSON.stringify({ sha: headSha, merge_method: method }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return noAnswer(err);
  }
  const answer = (await res.json().catch(() => null)) as { merged?: unknown } | null;
  if (!res.ok) {
    return {
      ok: false,
      outcome: res.status >= 500 ? "unknown" : "refused",
      status: res.status,
      reason: why(res.status, answer),
    };
  }
  // A 2xx that does not say `merged: true` does not say it was not merged either.
  if (answer?.merged !== true) {
    return {
      ok: false,
      outcome: "unknown",
      status: res.status,
      reason: `GitHub answered HTTP ${res.status}, but did not say the pull request was merged.`,
    };
  }
  return { ok: true };
}
