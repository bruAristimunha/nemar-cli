/**
 * Where the pull-request review's result is published (ADR 0092): a check-run per reviewed
 * commit and one comment per pull request, both made by the NEMAR GitHub App. The check-run is
 * updated from "in progress" to its conclusion; the comment belongs to the pull request and is
 * edited by each later commit's result.
 *
 * Two surfaces, and each can fail on its own. A check-run needs the App's `checks: write`, which
 * the central BIDS validation already uses. The comment needs `pull_requests: write` or
 * `issues: write`, which an installation may not have been granted; when it has not, the check
 * still lands and the caller logs the comment's refusal. Neither failure is allowed to lose the
 * stored verdict, so these functions throw and the caller decides what each failure costs.
 *
 * A check-run can be created only by a GitHub App installation token. The PAT fallback
 * `getDatasetsToken` can return for an unconfigured environment is refused by GitHub with a 403,
 * which surfaces here as a thrown status.
 *
 * A stale installation token (a cache that outlived a key rotation, a one-off 401) is refreshed
 * once through `refresh`, the way the other GitHub writers do (issue #596).
 */

import { type CheckConclusion, PR_REVIEW_CHECK_NAME } from "../../../../shared/pr-review.js";
import { GITHUB_API, ORG_NAME, ghHeaders } from "./shared";
import { githubFetchWithRetry } from "./transport";

/** GitHub caps a check-run's `summary` and `text` at 65535 characters each. */
const CHECK_TEXT_MAX = 60_000;
/** A comment may hold 65536 characters. */
const COMMENT_MAX = 60_000;
/** The most a "quick" call may take, in all, before it is abandoned. */
const QUICK_TIMEOUT_MS = 5_000;

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 40).trimEnd()}\n\n(Output shortened.)`;
}

/**
 * Fetch options for one call. A quick call is for the webhook's own request, which GitHub answers
 * within ten seconds: it fails fast on a nearly exhausted rate limit instead of sleeping, tries
 * twice, and is abandoned after a few seconds.
 */
function callOptions(refresh: (() => Promise<string>) | undefined, quick: boolean | undefined) {
  return {
    kind: quick ? ("interactive" as const) : ("background" as const),
    ...(quick ? { maxAttempts: 2 } : {}),
    ...(refresh ? { refreshTokenOn401: refresh } : {}),
  };
}

export interface CheckRunInput {
  token: string;
  repo: string;
  headSha: string;
  /** The existing check-run to update, or null to create one. */
  checkRunId: number | null;
  /** `in_progress` for a review that is running; `completed` carries a conclusion. */
  conclusion: CheckConclusion | null;
  title: string;
  summary: string;
  text: string;
  /** Mints a fresh token after a 401. */
  refresh?: () => Promise<string>;
  /** Bounded for use inside a webhook request. */
  quick?: boolean;
}

/**
 * Create or update the review's check-run and return its id. A 404 on update (the run was
 * deleted, or belongs to another installation) falls through to a create, so a stale id in the
 * database never strands a result.
 */
export async function upsertReviewCheckRun(input: CheckRunInput): Promise<number> {
  const output = {
    title: input.title,
    summary: clip(input.summary, CHECK_TEXT_MAX),
    text: clip(input.text, CHECK_TEXT_MAX),
  };
  const done =
    input.conclusion === null
      ? { status: "in_progress" }
      : {
          status: "completed",
          conclusion: input.conclusion,
          completed_at: new Date().toISOString(),
        };
  const options = callOptions(input.refresh, input.quick);
  const signal = input.quick ? { signal: AbortSignal.timeout(QUICK_TIMEOUT_MS) } : {};

  if (input.checkRunId !== null) {
    const res = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${input.repo}/check-runs/${input.checkRunId}`,
      {
        method: "PATCH",
        headers: { ...ghHeaders(input.token), "Content-Type": "application/json" },
        body: JSON.stringify({ ...done, output }),
        ...signal,
      },
      options,
    );
    if (res.ok) return input.checkRunId;
    if (res.status !== 404) throw new Error(`check-run update refused: HTTP ${res.status}`);
  }

  const res = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${input.repo}/check-runs`,
    {
      method: "POST",
      headers: { ...ghHeaders(input.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: PR_REVIEW_CHECK_NAME,
        head_sha: input.headSha,
        started_at: new Date().toISOString(),
        ...done,
        output,
      }),
      ...signal,
    },
    options,
  );
  if (!res.ok) throw new Error(`check-run create refused: HTTP ${res.status}`);
  const body = (await res.json()) as { id?: unknown };
  if (typeof body.id !== "number" || !Number.isSafeInteger(body.id)) {
    throw new Error("check-run create returned no id");
  }
  return body.id;
}

export interface ReviewCommentInput {
  token: string;
  repo: string;
  prNumber: number;
  /** The comment this pull request already carries, or null to create one. */
  commentId: number | null;
  body: string;
  /** Mints a fresh token after a 401. */
  refresh?: () => Promise<string>;
}

/** Create or edit the pull request's one review comment and return its id. */
export async function upsertReviewComment(input: ReviewCommentInput): Promise<number> {
  const body = clip(input.body, COMMENT_MAX);
  const options = callOptions(input.refresh, false);
  if (input.commentId !== null) {
    const res = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${input.repo}/issues/comments/${input.commentId}`,
      {
        method: "PATCH",
        headers: { ...ghHeaders(input.token), "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
      options,
    );
    if (res.ok) return input.commentId;
    if (res.status !== 404) throw new Error(`comment update refused: HTTP ${res.status}`);
  }
  const res = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${input.repo}/issues/${input.prNumber}/comments`,
    {
      method: "POST",
      headers: { ...ghHeaders(input.token), "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    },
    options,
  );
  if (!res.ok) throw new Error(`comment create refused: HTTP ${res.status}`);
  const created = (await res.json()) as { id?: unknown };
  if (typeof created.id !== "number" || !Number.isSafeInteger(created.id)) {
    throw new Error("comment create returned no id");
  }
  return created.id;
}
