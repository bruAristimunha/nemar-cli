/**
 * The administrator's view of the pull-request review (ADR 0093, following ADR 0092): every open
 * pull request to `main` in `nemarDatasets`, joined with the Worker's own record of reviewing it,
 * and the controls over who gets reviewed. The decisions are in the ADR; this header keeps only the
 * reasons behind the oddities below, because two copies of a decision drift.
 *
 * - **A verdict belongs to the commit it read.** The review ON RECORD for the pull request's current
 *   head is used when there is one; otherwise the newest review is shown as `not_reviewed` with what
 *   it concluded as `stale_verdict`. "Newest" is the last commit SEEN (`seen_at`), the review's own
 *   definition, so a redelivered commit is the newest; the exact commit is still preferred because a
 *   delivery can be missed, and the newest row would then be the wrong one.
 * - **One search, not one call per pull request.** The open pull requests, their head commits, forks,
 *   authors and required checks arrive in a paginated GraphQL search, so a queue of 60 costs two
 *   requests instead of a read and a check lookup for each. The token is shared with publishing and
 *   every sweep. Pages are read one after another, never in parallel (GitHub's secondary limit is
 *   about bursts).
 * - **Nothing here trusts a pull request's words.** Titles go through `sanitizeNote`, branch names
 *   are reduced to a conservative character set, links are built from the dataset id and number, and
 *   no body is read.
 * - **Overrides are keyed by GitHub's numeric id**, because a login can be renamed and reused.
 */

import {
  type CheckState,
  type ClearOverrideResponse,
  type ContributorStanding,
  type LivePullRequest,
  type PrReviewDetail,
  QUEUE_VERDICTS,
  type QueueEntry,
  type QueueEnvironment,
  type QueueErrorCode,
  type QueueFilters,
  type QueueResponse,
  type QueueSkipped,
  type QueueVerdict,
  type ReadVerdict,
  type ReviewHistoryItem,
  type ReviewRecord,
  type SetOverrideResponse,
  type VerdictDetail,
} from "../../../shared/contract/pr-review-admin.js";
import {
  type AuthorOverride,
  REJECTION_COUNT,
  REJECTION_PERCENT,
  REVIEW_STATES,
  type ReviewOutcome,
  type ReviewState,
  isDeclineReason,
  isRunError,
  sanitizeNote,
  standingOf,
  verdictOf,
} from "../../../shared/pr-review.js";
import { auditLogStatement } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import { isDevOwnedDatasetId, isValidDatasetId } from "./datasetId.js";
import { isNonProductionEnv } from "./environment.js";
import { getDatasetsTokenWithRefresher } from "./github-auth.js";
import { deriveContexts } from "./github/branch-protection.js";
import { GITHUB_API, ORG_NAME, ghHeaders } from "./github/shared.js";
import { githubFetchWithRetry } from "./github/transport.js";
import {
  PR_REVIEW_DEADLINE_MINUTES,
  outcomeOfRow,
  readAuthorOverride,
  readAuthorTally,
} from "./pr-review.js";

/** The GitHub search that defines the queue: open pull requests to `main` across the datasets org. */
export const OPEN_PR_SEARCH = `org:${ORG_NAME} is:pr is:open base:main`;

/** Pull requests per GraphQL page, and pages per call. GitHub's search returns at most 1000 results. */
const PAGE_SIZE = 50;
const MAX_PAGES = 20;
/**
 * Check contexts read per pull request. If a commit has more and the required check is not among
 * the first ones, it is reported as `unknown`, not `missing`; if it IS among them its state is
 * taken from what was read, which can be an older run than one on the unread page.
 */
const CONTEXTS_PER_PR = 40;
/** The longest a Retry-After is waited out inside an admin request. */
const MAX_THROTTLE_MS = 15_000;
const LIVE_TIMEOUT_MS = 10_000;
/**
 * One GraphQL page (the request, its retries and their waits share one timer), and the whole search,
 * which is checked before each page starts. A hung GitHub is an error, not a wait.
 */
let graphqlPageTimeoutMs = 45_000;
const GRAPHQL_TOTAL_MS = 90_000;
/**
 * A review handed to GitHub this long ago with no report is not "in progress". The watchdog gives up
 * on it after {@link PR_REVIEW_DEADLINE_MINUTES}, on a 30-minute tick, and only in production; so
 * this is deadline plus one tick, after which the queue says it never reported rather than showing a
 * review that will not finish as one still running.
 */
const OVERDUE_AFTER_MS = (PR_REVIEW_DEADLINE_MINUTES + 30) * 60_000;
/** How many reviews of one pull request `show` lists. */
const HISTORY_LIMIT = 20;
/** D1 allows 100 bound parameters per query; stay under it. */
const IN_CHUNK = 90;

export function __setGraphqlTimeoutForTests(ms: number | null): void {
  graphqlPageTimeoutMs = ms ?? 45_000;
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const SHA40 = /^[0-9a-f]{40}$/;

/** A failure the route turns into a status and a plain sentence. `code` is a fixed word from the contract. */
export class QueueError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 502 | 503,
    readonly code: QueueErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "QueueError";
  }
}

// ---------------------------------------------------------------------------------------------
// Plain text from author-controlled strings
// ---------------------------------------------------------------------------------------------

/**
 * A git ref or login reduced to a conservative subset of what it can contain (`A-Za-z0-9._-/`);
 * every other character becomes `?`, so a legitimate branch such as `fix#12` reads `fix?12`. It is
 * for recognising a branch, not for reproducing it.
 */
export function plainRef(input: unknown, max = 60): string {
  if (typeof input !== "string") return "";
  const s = input.normalize("NFKC").replace(/[^A-Za-z0-9._\-/]/g, "?");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

export interface CheckContext {
  name: string;
  state: CheckState;
  /** ISO timestamp used to pick the newest run of a re-run check. */
  at: string;
  /** A check run (posted by an App) or a commit status (posted by anyone with a token). */
  kind: "run" | "status";
  /**
   * The GitHub App that posted a check run. Null for a commit status, which has none, and for a
   * check run whose App could not be read.
   */
  appId: number | null;
}

const CHECK_FAIL = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

/** A run that has been queued has not started, so it has no start time; it is the newest there is. */
const NEWEST = "9999-12-31T23:59:59Z";

function appIdOf(n: Record<string, unknown>): number | null {
  const id = rec(rec(n.checkSuite)?.app)?.databaseId;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Read one node of a commit's `statusCheckRollup.contexts`. Unrecognised shapes are dropped. */
export function readCheckContext(node: unknown): CheckContext | null {
  const n = rec(node);
  if (!n) return null;
  if (n.__typename === "CheckRun" && typeof n.name === "string") {
    const started = typeof n.startedAt === "string" ? n.startedAt : "";
    const appId = appIdOf(n);
    if (n.status !== "COMPLETED") {
      return { name: n.name, kind: "run", state: "pending", at: started || NEWEST, appId };
    }
    if (n.conclusion === "SUCCESS") {
      return { name: n.name, kind: "run", state: "pass", at: started, appId };
    }
    if (typeof n.conclusion === "string" && CHECK_FAIL.has(n.conclusion)) {
      return { name: n.name, kind: "run", state: "fail", at: started, appId };
    }
    // NEUTRAL and SKIPPED count as passing for a required check on GitHub. Neither of NEMAR's
    // checks emits them, so seeing one means something else is posting under the name.
    return { name: n.name, kind: "run", state: "unknown", at: started, appId };
  }
  if (n.__typename === "StatusContext" && typeof n.context === "string") {
    const at = typeof n.createdAt === "string" ? n.createdAt : "";
    if (n.state === "SUCCESS") {
      return { name: n.context, kind: "status", state: "pass", at, appId: null };
    }
    if (n.state === "PENDING" || n.state === "EXPECTED") {
      return { name: n.context, kind: "status", state: "pending", at: at || NEWEST, appId: null };
    }
    if (n.state === "FAILURE" || n.state === "ERROR") {
      return { name: n.context, kind: "status", state: "fail", at, appId: null };
    }
    return { name: n.context, kind: "status", state: "unknown", at, appId: null };
  }
  return null;
}

/**
 * The state of the check called one of `names`: the newest run wins (a re-run replaces the failure
 * before it, and a run still queued is the newest of all). When the ruleset pins the check to a
 * GitHub App (`appId`), only that App's check runs count: anyone with push access can add a workflow
 * job with the same name, and the ruleset would not accept it, so neither should this view. A
 * same-named run whose App could not be read is not counted either, but it is not ignored: if it is
 * newer than what was found, the state is `unknown`. No such check is `missing` when the whole list
 * was read and `unknown` when it was cut short, because a check that might be on the next page is
 * not known to be absent.
 */
export function checkStateOf(
  contexts: readonly CheckContext[],
  names: readonly string[],
  listComplete: boolean,
  appId?: number,
): CheckState {
  let best: CheckContext | null = null;
  // The newest same-named check run whose App could not be read: it may be the pinned App's.
  let unattributed: CheckContext | null = null;
  for (const c of contexts) {
    if (!names.includes(c.name)) continue;
    if (appId !== undefined && c.appId !== appId) {
      if (c.kind === "run" && c.appId === null && (!unattributed || c.at >= unattributed.at)) {
        unattributed = c;
      }
      continue;
    }
    if (!best || c.at >= best.at) best = c;
  }
  if (unattributed && (!best || unattributed.at > best.at)) return "unknown";
  if (best) return best.state;
  return listComplete ? "missing" : "unknown";
}

// ---------------------------------------------------------------------------------------------
// The GitHub side
// ---------------------------------------------------------------------------------------------

export interface OpenPullRequest {
  datasetId: string;
  prNumber: number;
  title: string;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  headSha: string;
  fromFork: boolean;
  headLabel: string;
  authorLogin: string;
  authorId: number | null;
  bids: CheckState;
  version: CheckState;
}

export interface OpenPullRequests {
  prs: OpenPullRequest[];
  truncated: boolean;
  notADataset: number;
  /** Search results that could not be read as a pull request and so are not in `prs`. */
  unreadable: number;
}

const OPEN_PRS_QUERY = `
query OpenDatasetPullRequests($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: ${PAGE_SIZE}, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on PullRequest {
        number
        state
        title
        isDraft
        createdAt
        updatedAt
        baseRefName
        headRefName
        headRefOid
        isCrossRepository
        headRepositoryOwner { login }
        repository { name owner { login } }
        author { __typename login ... on User { databaseId } }
        commits(last: 1) {
          nodes {
            commit {
              oid
              statusCheckRollup {
                contexts(first: ${CONTEXTS_PER_PR}) {
                  pageInfo { hasNextPage }
                  nodes {
                    __typename
                    ... on CheckRun {
                      name status conclusion startedAt
                      checkSuite { app { databaseId } }
                    }
                    ... on StatusContext { context state createdAt }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

function rec(x: unknown): Record<string, unknown> | null {
  return typeof x === "object" && x !== null && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : null;
}

type SkipReason = "not_a_dataset" | "unreadable" | "no_longer_open";

/**
 * One search node as an open dataset pull request, or the reason it is not one. A reason is given
 * only when the node POSITIVELY says it: a repository whose name is readable and is not a dataset
 * id, a state or base branch that is readable and is not `OPEN` and `main`. A field that is missing
 * or not what it should be is `unreadable`, which is counted and shown, because reading an absence
 * as "not mine" would let a response with no fields at all end as "No open pull requests".
 * `no_longer_open` is the search index lagging a merge or a retarget; the fetch logs how many it
 * left out.
 */
function readOpenPullRequest(node: unknown): { pr: OpenPullRequest } | { skip: SkipReason } {
  const n = rec(node);
  if (!n || n.__typename !== "PullRequest") return { skip: "unreadable" };
  const repo = rec(n.repository);
  const owner = rec(repo?.owner);
  if (typeof repo?.name !== "string" || typeof owner?.login !== "string") {
    return { skip: "unreadable" };
  }
  if (!isValidDatasetId(repo.name) || owner.login.toLowerCase() !== ORG_NAME.toLowerCase()) {
    return { skip: "not_a_dataset" };
  }
  const number = n.number;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
    return { skip: "unreadable" };
  }
  if (typeof n.headRefOid !== "string" || !SHA40.test(n.headRefOid)) return { skip: "unreadable" };
  if (typeof n.state !== "string" || typeof n.baseRefName !== "string") {
    return { skip: "unreadable" };
  }
  if (n.state !== "OPEN" || n.baseRefName !== "main") return { skip: "no_longer_open" };

  const author = rec(n.author);
  const authorLogin =
    typeof author?.login === "string" && LOGIN.test(author.login) ? author.login : "(unknown)";
  const databaseId = author?.databaseId;
  const authorId =
    author?.__typename === "User" &&
    typeof databaseId === "number" &&
    Number.isSafeInteger(databaseId) &&
    databaseId > 0
      ? databaseId
      : null;

  const fromFork = n.isCrossRepository === true;
  const forkOwner = rec(n.headRepositoryOwner)?.login;
  const branch = plainRef(n.headRefName) || "(unknown)";
  const headLabel = fromFork
    ? `${typeof forkOwner === "string" ? plainRef(forkOwner, 39) : "(deleted fork)"}:${branch}`
    : branch;

  const commitNodes = rec(n.commits)?.nodes;
  const commit = rec(rec(Array.isArray(commitNodes) ? commitNodes[0] : null)?.commit);
  // The checks are the head commit's. If the commit the connection returned is not the head the
  // search named (a very long pull request, or a push between the two reads), they are not read.
  const checksAreHeads = commit !== null && commit.oid === n.headRefOid;
  const contexts = checksAreHeads ? rec(rec(commit.statusCheckRollup)?.contexts) : null;
  const list: CheckContext[] = [];
  let dropped = false;
  if (Array.isArray(contexts?.nodes)) {
    for (const c of contexts.nodes) {
      const parsed = readCheckContext(c);
      if (parsed) list.push(parsed);
      else dropped = true;
    }
  }
  const complete = contexts !== null && rec(contexts.pageInfo)?.hasNextPage === false;
  // No rollup at all means no check has run on the commit, which is "missing", not "unknown". A
  // node that could not be read might have been the check, so then "none" is not known either.
  const readable = checksAreHeads && !dropped && (commit.statusCheckRollup === null || complete);
  const [bidsCtx, versionCtx] = deriveContexts(repo.name);
  return {
    pr: {
      datasetId: repo.name,
      prNumber: number,
      title: sanitizeNote(n.title, 120),
      draft: n.isDraft === true,
      createdAt: typeof n.createdAt === "string" ? n.createdAt : "",
      updatedAt: typeof n.updatedAt === "string" ? n.updatedAt : "",
      headSha: n.headRefOid,
      fromFork,
      headLabel,
      authorLogin,
      authorId,
      // The names and the App pin come from branch protection, the one place that knows which check
      // a repository is held to; the legacy repositories name their BIDS check differently and
      // post it as a plain workflow job.
      bids: checkStateOf(list, [bidsCtx.context], readable, bidsCtx.integration_id),
      version: checkStateOf(list, [versionCtx.context], readable, versionCtx.integration_id),
    },
  };
}

/** `repository#number` for a search node that names both, else null. Used to count a node once. */
function searchNodeKey(node: unknown): string | null {
  const n = rec(node);
  const name = rec(n?.repository)?.name;
  return typeof name === "string" && typeof n?.number === "number" ? `${name}#${n.number}` : null;
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/**
 * Every open pull request to `main` in the datasets organisation. Pages are read one after another.
 * Anything that stops the read, a failed second page, a GraphQL `errors` array even with `data`
 * beside it, a hung GitHub, fails the WHOLE read: a partial queue that looks complete is worse than
 * none.
 */
export async function fetchOpenPullRequests(env: Bindings): Promise<OpenPullRequests> {
  let auth: { token: string; refresh: () => Promise<string> };
  try {
    auth = await getDatasetsTokenWithRefresher(env);
  } catch (err) {
    console.error(`[pr-queue] no GitHub token (${errMessage(err)})`);
    throw new QueueError(502, "github_unavailable", "NEMAR could not get a GitHub token.");
  }

  const seen = new Set<string>();
  const prs: OpenPullRequest[] = [];
  let notADataset = 0;
  let unreadable = 0;
  let noLongerOpen = 0;
  let nodesSeen = 0;
  let shifted = false;
  let issueCount = 0;
  let after: string | null = null;
  let more = false;
  const started = Date.now();

  for (let page = 0; page < MAX_PAGES; page++) {
    if (Date.now() - started > GRAPHQL_TOTAL_MS) {
      throw new QueueError(502, "github_timeout", "GitHub took too long to answer the search.");
    }
    let res: Response;
    try {
      res = await githubFetchWithRetry(
        `${GITHUB_API()}/graphql`,
        {
          method: "POST",
          headers: { ...ghHeaders(auth.token), "Content-Type": "application/json" },
          body: JSON.stringify({ query: OPEN_PRS_QUERY, variables: { q: OPEN_PR_SEARCH, after } }),
          signal: AbortSignal.timeout(graphqlPageTimeoutMs),
        },
        {
          kind: "interactive",
          maxAttempts: 3,
          maxThrottleMs: MAX_THROTTLE_MS,
          // The transport's pre-flight throttle watches the REST `core` budget, which publishing
          // and every sweep spend and this search does not (GraphQL has its own). Gating the
          // queue on it would refuse a list GitHub would have answered. A secondary limit is
          // still waited out, and an exhausted GraphQL budget is reported below.
          lowRemainingThreshold: 0,
          refreshTokenOn401: auth.refresh,
        },
      );
    } catch (err) {
      console.error(`[pr-queue] GitHub unreachable (${errMessage(err)})`);
      if (isTimeout(err)) {
        throw new QueueError(502, "github_timeout", "GitHub took too long to answer the search.");
      }
      throw new QueueError(502, "github_unavailable", "GitHub could not be reached.");
    }
    if (!res.ok) {
      // The status alone cannot tell a permission the App lacks from a limit that will lift.
      const said = sanitizeNote(await res.text().catch(() => ""), 160);
      console.error(`[pr-queue] GraphQL answered HTTP ${res.status}: ${said || "no body"}`);
      if (
        res.status === 429 ||
        (res.status === 403 &&
          (/rate limit|abuse/i.test(said) || res.headers.get("x-ratelimit-remaining") === "0"))
      ) {
        throw new QueueError(
          503,
          "github_rate_limited",
          "GitHub is rate limiting the search. Try again in a minute or two.",
        );
      }
      throw new QueueError(
        502,
        "github_refused",
        `GitHub refused the search (HTTP ${res.status})${said ? `: ${said}` : ""}.`,
      );
    }
    const body = rec(
      await res.json().catch((err) => {
        console.error(`[pr-queue] GraphQL answer could not be read (${errMessage(err)})`);
        return null;
      }),
    );
    const errors = body?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const first = rec(errors[0]);
      const why = sanitizeNote(first?.message, 160) || "no reason given";
      console.error(`[pr-queue] GraphQL errors: ${why}`);
      if (first?.type === "RATE_LIMITED") {
        throw new QueueError(
          503,
          "github_rate_limited",
          `GitHub's rate limit for this search is spent (${why}). Try again later.`,
        );
      }
      throw new QueueError(
        502,
        "github_graphql_error",
        `GitHub could not answer the search: ${why}`,
      );
    }
    const search = rec(rec(body?.data)?.search);
    if (!search || !Array.isArray(search.nodes)) {
      console.error("[pr-queue] GraphQL answered 200 with no search result");
      throw new QueueError(
        502,
        "github_bad_response",
        "GitHub's search answered in an unexpected shape.",
      );
    }
    const count = typeof search.issueCount === "number" ? search.issueCount : issueCount;
    // GitHub's search cursors are positions. If the count moved between pages, a pull request
    // closed or opened mid-read and the pages shifted, which can hide one that is still open.
    if (page > 0 && count !== issueCount) shifted = true;
    issueCount = count;
    for (const node of search.nodes) {
      // A pull request listed twice (a page boundary moved while paging) counts once, so a pull
      // request the shift hid is not covered for by the one seen twice.
      const nodeKey = searchNodeKey(node);
      if (nodeKey !== null) {
        if (seen.has(nodeKey)) continue;
        seen.add(nodeKey);
      }
      nodesSeen++;
      const read = readOpenPullRequest(node);
      if ("skip" in read) {
        if (read.skip === "not_a_dataset") notADataset++;
        else if (read.skip === "no_longer_open") noLongerOpen++;
        else {
          unreadable++;
          console.warn("[pr-queue] a search result could not be read as a pull request");
        }
        continue;
      }
      prs.push(read.pr);
    }
    const info = rec(search.pageInfo);
    more = info?.hasNextPage === true;
    after = typeof info?.endCursor === "string" ? info.endCursor : null;
    if (!more) break;
    if (after === null) break;
  }
  // `more` still true means the page limit (or a missing cursor) stopped the read; `issueCount`
  // above what was read means GitHub's own 1000-result cap did; `shifted` means the set changed
  // while it was being read.
  const truncated = more || shifted || issueCount > nodesSeen;
  if (noLongerOpen > 0) {
    console.info(
      `[pr-queue] ${noLongerOpen} search result(s) were no longer open pull requests to main`,
    );
  }
  return { prs, truncated, notADataset, unreadable };
}

// ---------------------------------------------------------------------------------------------
// The review side
// ---------------------------------------------------------------------------------------------

export interface ReviewRow {
  id: number;
  dataset_id: string;
  pr_number: number;
  head_sha: string;
  author_id: number;
  author_login: string;
  from_fork: number;
  /** The raw column. It is CHECK-constrained, and a reader still must not trust it. */
  state: string;
  verdict: string | null;
  detail: string | null;
  created_at: string;
  decided_at: string | null;
}

const REVIEW_COLUMNS = `id, dataset_id, pr_number, head_sha, author_id, author_login, from_fork,
  state, verdict, detail, created_at, decided_at`;

const REVIEW_STATE_SET: ReadonlySet<string> = new Set(REVIEW_STATES);

/** D1 writes `datetime('now')` ("2026-10-09 02:10:00", UTC); a value with a zone is read as given. */
function storedTime(value: string): number {
  return Date.parse(/Z|[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
}

/**
 * What a stored row means, in the queue's words, ignoring which commit it is about. A `dispatched`
 * row older than {@link OVERDUE_AFTER_MS} reads as `could_not_decide` / `unreported`: the Worker
 * never ages a row itself (the production watchdog does, the dev Worker never), so without this a
 * review that will not finish shows as running forever and is never offered to an administrator.
 */
export function meaningOf(
  row: Pick<ReviewRow, "state" | "verdict" | "detail"> & { created_at?: string },
  now: number = Date.now(),
): {
  verdict: QueueVerdict;
  detail: VerdictDetail | null;
} {
  switch (row.state) {
    case "dispatched": {
      const started = row.created_at === undefined ? Number.NaN : storedTime(row.created_at);
      return Number.isFinite(started) && now - started > OVERDUE_AFTER_MS
        ? { verdict: "could_not_decide", detail: "unreported" }
        : { verdict: "in_progress", detail: null };
    }
    case "reported":
      // Anything that is not one of the three derived verdicts is a row nobody can stand behind.
      return row.verdict === "pass" || row.verdict === "fail" || row.verdict === "uncertain"
        ? { verdict: row.verdict, detail: null }
        : { verdict: "could_not_decide", detail: null };
    case "declined":
      return {
        verdict: "not_reviewed",
        detail: isDeclineReason(row.detail) ? row.detail : null,
      };
    case "errored":
      return {
        verdict: "could_not_decide",
        detail: isRunError(row.detail) ? row.detail : null,
      };
    case "unreported":
      return { verdict: "could_not_decide", detail: "unreported" };
    default:
      return { verdict: "could_not_decide", detail: null };
  }
}

/** The verdict a review reached about the commit it read, or null if it reached none. */
function readVerdictOf(v: QueueVerdict): ReadVerdict | null {
  return v === "pass" || v === "fail" || v === "uncertain" ? v : null;
}

export interface Classified {
  verdict: QueueVerdict;
  detail: VerdictDetail | null;
  reviewed_sha: string | null;
  review_current: boolean | null;
  stale_verdict: ReadVerdict | null;
}

/**
 * The verdict for a pull request now at `headSha`, given the review on record for it (or none).
 * `headSha` null means the current head could not be established: no verdict is asserted about it,
 * because a pass about a commit nobody can name is not a pass about this one. The stored verdict
 * rides along as `stale_verdict` and `review_current` stays null (unknown, not false).
 */
export function classify(
  row: ReviewRow | null,
  headSha: string | null,
  now: number = Date.now(),
): Classified {
  if (!row) {
    return {
      verdict: "not_reviewed",
      detail: null,
      reviewed_sha: null,
      review_current: null,
      stale_verdict: null,
    };
  }
  const meant = meaningOf(row, now);
  if (headSha === null || row.head_sha !== headSha) {
    return {
      verdict: "not_reviewed",
      detail: null,
      reviewed_sha: row.head_sha,
      review_current: headSha === null ? null : false,
      stale_verdict: readVerdictOf(meant.verdict),
    };
  }
  return { ...meant, reviewed_sha: row.head_sha, review_current: true, stale_verdict: null };
}

interface Reviews {
  /** `dataset#pr#sha`: the review of exactly that commit. */
  byHead: Map<string, ReviewRow>;
  /** `dataset#pr`: the newest review of the pull request, whatever commit it read. */
  newest: Map<string, ReviewRow>;
}

const headKey = (ds: string, pr: number, sha: string) => `${ds}#${pr}#${sha}`;

/**
 * The reviews of the given datasets, without the (large) stored report. Two lookups are kept
 * because they answer different questions: `byHead` says whether the CURRENT commit was reviewed,
 * `newest` says what the last review concluded when it was not. A force-push back to a reviewed
 * commit adds no row (the table is unique per commit); when GitHub's delivery for it arrives it
 * refreshes that row's `seen_at`, so the row is the newest, and when the delivery was missed the
 * newest row is still the other commit's, which is why `byHead` is consulted first.
 */
async function loadReviews(db: D1Database, datasetIds: readonly string[]): Promise<Reviews> {
  const byHead = new Map<string, ReviewRow>();
  const newest = new Map<string, ReviewRow>();
  for (let i = 0; i < datasetIds.length; i += IN_CHUNK) {
    const chunk = datasetIds.slice(i, i + IN_CHUNK);
    const { results } = await db
      .prepare(
        `SELECT ${REVIEW_COLUMNS} FROM pr_reviews
          WHERE dataset_id IN (${chunk.map(() => "?").join(",")}) ORDER BY seen_at, id`,
      )
      .bind(...chunk)
      .all<ReviewRow>();
    for (const r of results) {
      byHead.set(headKey(r.dataset_id, r.pr_number, r.head_sha), r);
      newest.set(`${r.dataset_id}#${r.pr_number}`, r); // ascending seen_at, so the last write is the newest
    }
  }
  return { byHead, newest };
}

// ---------------------------------------------------------------------------------------------
// Ordering and filtering
// ---------------------------------------------------------------------------------------------

/**
 * Verdicts an administrator can act on: approve a pass, or review by hand what the automation
 * could not or did not decide. A fail is the author's to fix and an in-progress review is waiting
 * on the machine, so neither is yours yet.
 */
const NEEDS_YOU: ReadonlySet<QueueVerdict> = new Set([
  "pass",
  "uncertain",
  "could_not_decide",
  "not_reviewed",
]);

export function needsYou(e: Pick<QueueEntry, "verdict" | "draft">): boolean {
  return !e.draft && NEEDS_YOU.has(e.verdict);
}

/** Lower sorts first: ready to approve, then the ones needing a closer look, then the rest. */
const VERDICT_RANK: Record<QueueVerdict, number> = {
  pass: 0,
  uncertain: 1,
  could_not_decide: 2,
  not_reviewed: 3,
  in_progress: 4,
  fail: 5,
};

function checkRank(e: Pick<QueueEntry, "bids" | "version">): number {
  if (e.bids === "fail" || e.version === "fail") return 2;
  if (e.bids === "pass" && e.version === "pass") return 0;
  return 1;
}

/**
 * Order the queue so what an administrator can act on comes first: drafts last, then by verdict,
 * then pull requests whose required checks already pass, then the one that has waited longest.
 */
export function sortQueue<T extends QueueEntry>(entries: readonly T[]): T[] {
  return [...entries].sort(
    (a, b) =>
      Number(a.draft) - Number(b.draft) ||
      VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] ||
      checkRank(a) - checkRank(b) ||
      a.created_at.localeCompare(b.created_at) ||
      a.dataset_id.localeCompare(b.dataset_id) ||
      a.pr_number - b.pr_number,
  );
}

export function filterQueue<T extends QueueEntry>(entries: readonly T[], f: QueueFilters): T[] {
  const author = f.author?.toLowerCase() ?? null;
  return entries.filter(
    (e) =>
      (f.verdicts.length === 0 || f.verdicts.includes(e.verdict)) &&
      (f.dataset === null || e.dataset_id === f.dataset) &&
      (author === null || e.author_login.toLowerCase() === author) &&
      (!f.needs_me || e.needs_you),
  );
}

/** Parse the `verdict` query value (comma separated). A word outside the vocabulary is an error. */
export function parseVerdictFilter(raw: string | undefined): QueueVerdict[] {
  if (raw === undefined || raw.trim() === "") return [];
  const out: QueueVerdict[] = [];
  for (const part of raw.split(",")) {
    const word = part.trim().toLowerCase().replaceAll("-", "_");
    if (!(QUEUE_VERDICTS as readonly string[]).includes(word)) {
      throw new QueueError(
        400,
        "bad_verdict",
        `"${sanitizeNote(part, 30)}" is not a verdict. Use: ${QUEUE_VERDICTS.join(", ")}.`,
      );
    }
    if (!out.includes(word as QueueVerdict)) out.push(word as QueueVerdict);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------------------------

export function environmentName(env: Bindings): QueueEnvironment {
  return isNonProductionEnv(env) ? "non-production" : "production";
}

/**
 * Whether this Worker answers for a dataset. The production Worker leaves dev-owned repositories
 * to the dev Worker and the dev Worker answers only for the ones it owns, exactly as the webhook
 * fence decides who reviews them: the `nemarDatasets` organisation is shared, the D1 databases are
 * not, so the other environment's pull requests would all read "not reviewed" here.
 */
export function ownedHere(env: Bindings, datasetId: string): boolean {
  return isNonProductionEnv(env) ? isDevOwnedDatasetId(datasetId) : !isDevOwnedDatasetId(datasetId);
}

export async function buildQueue(env: Bindings, filters: QueueFilters): Promise<QueueResponse> {
  const open = await fetchOpenPullRequests(env);
  const skipped: QueueSkipped = {
    not_a_dataset: open.notADataset,
    not_owned_here: 0,
    unreadable: open.unreadable,
  };
  const mine = open.prs.filter((pr) => {
    const owned = ownedHere(env, pr.datasetId);
    if (!owned) skipped.not_owned_here++;
    return owned;
  });
  const reviews = await loadReviews(env.DB, [...new Set(mine.map((pr) => pr.datasetId))]);

  const all: QueueEntry[] = mine.map((pr) => {
    // The review of the current commit if there is one; else the newest, which `classify` will
    // show as another commit's.
    const row =
      reviews.byHead.get(headKey(pr.datasetId, pr.prNumber, pr.headSha)) ??
      reviews.newest.get(`${pr.datasetId}#${pr.prNumber}`) ??
      null;
    const classified = classify(row, pr.headSha);
    const verdictAndDraft = { verdict: classified.verdict, draft: pr.draft };
    return {
      dataset_id: pr.datasetId,
      pr_number: pr.prNumber,
      url: pullUrl(pr.datasetId, pr.prNumber),
      title: pr.title,
      author_login: pr.authorLogin,
      author_id: pr.authorId,
      from_fork: pr.fromFork,
      head_label: pr.headLabel,
      head_sha: pr.headSha,
      draft: pr.draft,
      created_at: pr.createdAt,
      updated_at: pr.updatedAt,
      ...classified,
      bids: pr.bids,
      version: pr.version,
      needs_you: needsYou(verdictAndDraft),
    };
  });
  return {
    environment: environmentName(env),
    review_enabled: env.PR_REVIEW_ENABLED === "1",
    entries: sortQueue(filterQueue(all, filters)),
    total_open: all.length,
    truncated: open.truncated,
    skipped,
    filters,
  };
}

export function pullUrl(datasetId: string, prNumber: number): string {
  return `https://github.com/${ORG_NAME}/${datasetId}/pull/${prNumber}`;
}

// ---------------------------------------------------------------------------------------------
// One pull request
// ---------------------------------------------------------------------------------------------

type LiveRead =
  | { kind: "found"; pr: LivePullRequest }
  | { kind: "missing" }
  | { kind: "unreadable" };

/** What GitHub says about one pull request now. Never throws: it reads as `unreadable` instead. */
export async function fetchLivePullRequest(
  env: Bindings,
  datasetId: string,
  prNumber: number,
): Promise<LiveRead> {
  const where = `${datasetId}#${prNumber}`;
  try {
    const { token, refresh } = await getDatasetsTokenWithRefresher(env);
    const res = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${datasetId}/pulls/${prNumber}`,
      { headers: ghHeaders(token), signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) },
      {
        kind: "interactive",
        maxAttempts: 2,
        maxThrottleMs: MAX_THROTTLE_MS,
        refreshTokenOn401: refresh,
      },
    );
    if (res.status === 404) return { kind: "missing" };
    if (!res.ok) {
      console.warn(`[pr-queue] ${where}: live read answered HTTP ${res.status}`);
      return { kind: "unreadable" };
    }
    const p = rec(await res.json().catch(() => null));
    const head = rec(p?.head);
    const base = rec(p?.base);
    const user = rec(p?.user);
    if (!p || typeof head?.sha !== "string" || !SHA40.test(head.sha)) {
      console.warn(`[pr-queue] ${where}: live read had no usable head commit`);
      return { kind: "unreadable" };
    }
    const headRepo = rec(head.repo);
    const fromFork =
      typeof headRepo?.full_name !== "string" ||
      headRepo.full_name.toLowerCase() !== `${ORG_NAME}/${datasetId}`.toLowerCase();
    const forkOwner = rec(headRepo?.owner)?.login;
    const branch = plainRef(head.ref) || "(unknown)";
    return {
      kind: "found",
      pr: {
        state: p.merged === true ? "merged" : p.state === "open" ? "open" : "closed",
        draft: p.draft === true,
        head_sha: head.sha,
        base_ref: plainRef(base?.ref),
        url: pullUrl(datasetId, prNumber),
        title: sanitizeNote(p.title, 120),
        author_login:
          typeof user?.login === "string" && LOGIN.test(user.login) ? user.login : "(unknown)",
        author_id:
          typeof user?.id === "number" && Number.isSafeInteger(user.id) && user.id > 0
            ? user.id
            : null,
        from_fork: fromFork,
        head_label: fromFork
          ? `${typeof forkOwner === "string" ? plainRef(forkOwner, 39) : "(deleted fork)"}:${branch}`
          : branch,
      },
    };
  } catch (err) {
    console.error(`[pr-queue] ${where}: live read failed (${errMessage(err)})`);
    return { kind: "unreadable" };
  }
}

/**
 * What a stored row stands for, by the review's own rules (`outcomeOfRow`, which also logs a report
 * that no longer parses and says why). Null for a review still waiting for its report.
 */
function outcomeOf(row: ReviewRow & { report: string | null }): ReviewOutcome | null {
  return outcomeOfRow({
    id: row.id,
    datasetId: row.dataset_id,
    prNumber: row.pr_number,
    headSha: row.head_sha,
    state: (REVIEW_STATE_SET.has(row.state) ? row.state : "errored") as ReviewState,
    detail: row.detail,
    report: row.report,
    checkRunId: null,
    commentId: null,
  });
}

type StoredReview = ReviewRow & { report: string | null };

/** Higher is stricter: what a reader would have to overcome to approve. */
const STRICTNESS: Record<ReadVerdict, number> = { pass: 0, uncertain: 1, fail: 2 };

function isReadVerdict(v: unknown): v is ReadVerdict {
  return v === "pass" || v === "fail" || v === "uncertain";
}

export async function readPrReviewDetail(
  env: Bindings,
  datasetId: string,
  prNumber: number,
  headParam: string | null = null,
): Promise<PrReviewDetail> {
  if (!ownedHere(env, datasetId)) {
    throw new QueueError(
      404,
      "not_owned_here",
      `${datasetId} belongs to the ${isNonProductionEnv(env) ? "production" : "dev"} Worker, which holds its reviews. Ask that environment.`,
    );
  }
  if (headParam !== null && !SHA40.test(headParam)) {
    throw new QueueError(400, "bad_head", "A commit is 40 lowercase hexadecimal characters.");
  }
  const db = env.DB;
  const { results } = await db
    .prepare(
      `SELECT ${REVIEW_COLUMNS}, report FROM pr_reviews
        WHERE dataset_id = ? AND pr_number = ? ORDER BY seen_at DESC, id DESC LIMIT ?`,
    )
    .bind(datasetId, prNumber, HISTORY_LIMIT + 1)
    .all<StoredReview>();

  const live = await fetchLivePullRequest(env, datasetId, prNumber);
  const livePr = live.kind === "found" ? live.pr : null;
  if (results.length === 0 && livePr === null) {
    if (live.kind === "missing") {
      throw new QueueError(
        404,
        "no_such_pull_request",
        `${datasetId} has no pull request #${prNumber}.`,
      );
    }
    // Nothing stored and GitHub could not be read: that is not "not reviewed", it is "do not know".
    throw new QueueError(
      502,
      "github_unavailable",
      `There is no stored review of ${datasetId}#${prNumber} and GitHub could not be read to check the pull request.`,
    );
  }

  // The commit the verdict is about: the one the caller named, else GitHub's current head.
  const head = headParam ?? livePr?.head_sha ?? null;
  // Its review if one exists (it may be older than the newest: see loadReviews), else the newest.
  let stored: StoredReview | null =
    head === null ? null : (results.find((r) => r.head_sha === head) ?? null);
  if (head !== null && stored === null && results.length > HISTORY_LIMIT) {
    stored = await db
      .prepare(
        `SELECT ${REVIEW_COLUMNS}, report FROM pr_reviews
          WHERE dataset_id = ? AND pr_number = ? AND head_sha = ?`,
      )
      .bind(datasetId, prNumber, head)
      .first<StoredReview>();
  }
  const row: StoredReview | null = stored ?? results[0] ?? null;

  // The verdict an approval would lean on is the STRICTER of the stored column and the one
  // re-derived from the stored report, so either source can lower it and neither can raise it: a
  // report that no longer parses is "could not decide" unless the column says `fail`, and a later
  // change to the rules that would now pass an old rejection does not make it easier to approve.
  // The list reads the column alone; the two differ only when a rule changed or a report is corrupt.
  const outcome = row ? outcomeOf(row) : null;
  let derived: Pick<ReviewRow, "state" | "verdict" | "detail"> | null = row;
  if (row && row.state === "reported") {
    const stored = isReadVerdict(row.verdict) ? row.verdict : null;
    let verdict: QueueVerdict;
    if (outcome?.kind === "reported") {
      const fromReport = verdictOf(outcome.report);
      if (stored !== null && stored !== fromReport) {
        console.warn(
          `[pr-queue] review ${row.id}: the stored verdict (${stored}) disagrees with the report (${fromReport}); showing the stricter`,
        );
      }
      verdict =
        stored !== null && STRICTNESS[stored] > STRICTNESS[fromReport] ? stored : fromReport;
    } else {
      verdict = stored === "fail" ? "fail" : "could_not_decide";
    }
    derived = { ...row, verdict };
  }
  const own = derived ? meaningOf(derived) : null;
  const review: ReviewRecord | null =
    row && own
      ? {
          id: row.id,
          head_sha: row.head_sha,
          verdict: own.verdict,
          detail: own.detail,
          author_login: plainRef(row.author_login, 39),
          author_id: row.author_id,
          from_fork: row.from_fork === 1,
          created_at: row.created_at,
          decided_at: row.decided_at,
          outcome,
        }
      : null;
  const effective = classify(row && derived ? { ...row, ...derived } : null, head);

  const history: ReviewHistoryItem[] = results.slice(0, HISTORY_LIMIT).map((r) => {
    const state: ReviewState = REVIEW_STATE_SET.has(r.state) ? (r.state as ReviewState) : "errored";
    return {
      id: r.id,
      head_sha: r.head_sha,
      state,
      verdict: meaningOf(r).verdict,
      created_at: r.created_at,
      decided_at: r.decided_at,
    };
  });

  const authorId = row?.author_id ?? livePr?.author_id ?? null;
  const authorLogin = row?.author_login ?? livePr?.author_login ?? null;
  const author =
    authorId !== null && authorLogin !== null
      ? await standingFor(db, plainRef(authorLogin, 39), authorId, row ? "history" : "github")
      : null;

  return {
    environment: environmentName(env),
    review_enabled: env.PR_REVIEW_ENABLED === "1",
    dataset_id: datasetId,
    pr_number: prNumber,
    head_sha: head,
    verdict: effective.verdict,
    detail: effective.detail,
    stale_verdict: effective.stale_verdict,
    review,
    history,
    history_truncated: results.length > HISTORY_LIMIT,
    live: livePr,
    live_status:
      live.kind === "found" ? "found" : live.kind === "missing" ? "missing" : "unreadable",
    review_current: effective.review_current,
    author,
  };
}

// ---------------------------------------------------------------------------------------------
// Contributors: standing and overrides
// ---------------------------------------------------------------------------------------------

const RECENT_SQL = `
  WITH latest AS (
    SELECT dataset_id, pr_number, head_sha, verdict, decided_at, seen_at, id,
           ROW_NUMBER() OVER (PARTITION BY dataset_id, pr_number ORDER BY seen_at DESC, id DESC) AS rn
      FROM pr_reviews
     WHERE author_id = ? AND state = 'reported' AND verdict IN ('pass', 'fail')
  )
  SELECT dataset_id, pr_number, head_sha, verdict, decided_at
    FROM latest WHERE rn = 1 ORDER BY seen_at DESC, id DESC LIMIT 10`;

/** The tally, override and standing of one contributor, as the review gate would see them now. */
export async function standingFor(
  db: D1Database,
  login: string,
  authorId: number,
  resolvedFrom: ContributorStanding["resolved_from"],
): Promise<ContributorStanding> {
  const tally = await readAuthorTally(db, authorId);
  const row = await db
    .prepare(
      `SELECT o.mode AS mode, o.reason AS reason, o.set_at AS set_at,
              COALESCE(u.username, 'account-' || u.id) AS set_by
         FROM pr_review_overrides o LEFT JOIN users u ON u.id = o.set_by
        WHERE o.author_id = ?`,
    )
    .bind(authorId)
    .first<{ mode: string; reason: string | null; set_at: string; set_by: string | null }>();
  const mode: AuthorOverride = row?.mode === "allow" || row?.mode === "block" ? row.mode : null;
  const recent = await db.prepare(RECENT_SQL).bind(authorId).all<{
    dataset_id: string;
    pr_number: number;
    head_sha: string;
    verdict: "pass" | "fail";
    decided_at: string | null;
  }>();
  return {
    login,
    author_id: authorId,
    tally,
    override:
      row && mode
        ? {
            mode,
            reason: row.reason ? sanitizeNote(row.reason, 200) : null,
            set_at: row.set_at,
            set_by: row.set_by ? plainRef(row.set_by, 60) : null,
          }
        : null,
    standing: standingOf(tally, mode),
    by_record: standingOf(tally, null),
    thresholds: { rejected_more_than: REJECTION_COUNT, percent_more_than: REJECTION_PERCENT },
    recent: recent.results,
    resolved_from: resolvedFrom,
  };
}

export function parseLogin(raw: string): string {
  if (!LOGIN.test(raw)) {
    throw new QueueError(400, "bad_login", "That is not a GitHub login.");
  }
  return raw;
}

interface ResolvedAuthor {
  id: number;
  login: string;
  from: ContributorStanding["resolved_from"];
}

/** The numeric id and canonical login GitHub holds for a login now, or a reason it cannot say. */
async function resolveAtGitHub(
  env: Bindings,
  login: string,
): Promise<ResolvedAuthor | { missing: true } | { failed: true }> {
  try {
    const { token, refresh } = await getDatasetsTokenWithRefresher(env);
    const res = await githubFetchWithRetry(
      `${GITHUB_API()}/users/${encodeURIComponent(login)}`,
      { headers: ghHeaders(token), signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) },
      {
        kind: "interactive",
        maxAttempts: 2,
        maxThrottleMs: MAX_THROTTLE_MS,
        refreshTokenOn401: refresh,
      },
    );
    if (res.status === 404) return { missing: true };
    if (!res.ok) {
      console.warn(`[pr-queue] user lookup answered HTTP ${res.status}`);
      return { failed: true };
    }
    const u = rec(await res.json().catch(() => null));
    if (
      typeof u?.id !== "number" ||
      !Number.isSafeInteger(u.id) ||
      u.id <= 0 ||
      typeof u.login !== "string" ||
      !LOGIN.test(u.login)
    ) {
      console.warn("[pr-queue] user lookup had no usable id and login");
      return { failed: true };
    }
    if (u.type !== "User") {
      throw new QueueError(
        422,
        "not_a_user",
        `${u.login} is a GitHub ${sanitizeNote(u.type, 20) || "account"}, not a person. Reviews are counted per person.`,
      );
    }
    return { id: u.id, login: u.login, from: "github" };
  } catch (err) {
    if (err instanceof QueueError) throw err;
    console.error(`[pr-queue] user lookup failed (${errMessage(err)})`);
    return { failed: true };
  }
}

/** A login the Worker already knows from a review, for when GitHub cannot say. */
async function resolveInReviews(db: D1Database, login: string): Promise<ResolvedAuthor | null> {
  const row = await db
    .prepare(
      `SELECT author_id, author_login FROM pr_reviews
        WHERE lower(author_login) = lower(?) ORDER BY seen_at DESC, id DESC LIMIT 1`,
    )
    .bind(login)
    .first<{ author_id: number; author_login: string }>();
  return row ? { id: row.author_id, login: plainRef(row.author_login, 39), from: "history" } : null;
}

/**
 * `reading`: GitHub first, then the review history (a closed or renamed account still has one).
 * `writing`: GitHub only. An override binds to an id, and an id inferred from a stored login could
 * belong to someone else after a rename.
 * `clearing`: GitHub first, like `writing`, because GitHub is the one that knows who holds a login
 * NOW; a stored login can have been renamed away and reused. Only when GitHub cannot say (the
 * account is gone, or GitHub is down) is the login an override stored used, and only if exactly one
 * account stored it. If no override stored it, the review history is tried as for `reading`, which
 * can name an account that has since been renamed; that is safe here because a clear deletes only a
 * decision that already exists for the id it finds, and says when there was none.
 */
export async function resolveAuthor(
  env: Bindings,
  loginRaw: string,
  purpose: "reading" | "writing" | "clearing",
): Promise<ResolvedAuthor> {
  const login = parseLogin(loginRaw);
  const at = await resolveAtGitHub(env, login);
  if ("id" in at) return at;

  if (purpose === "clearing") {
    const { results } = await env.DB.prepare(
      `SELECT author_id, author_login FROM pr_review_overrides
        WHERE lower(author_login) = lower(?) ORDER BY set_at DESC`,
    )
      .bind(login)
      .all<{ author_id: number; author_login: string }>();
    if (results.length > 1) {
      throw new QueueError(
        409,
        "ambiguous_login",
        "missing" in at
          ? `More than one account that once used the name ${login} has a decision on file, and GitHub has no account by that name now, so which one is meant cannot be told from here.`
          : `More than one account that once used the name ${login} has a decision on file, and GitHub could not say which holds it now. Try again when GitHub answers.`,
      );
    }
    if (results.length === 1) {
      return {
        id: results[0].author_id,
        login: plainRef(results[0].author_login, 39),
        from: "history",
      };
    }
  }
  if (purpose !== "writing") {
    const known = await resolveInReviews(env.DB, login);
    if (known) return known;
  }
  if ("missing" in at) {
    throw new QueueError(404, "no_such_user", `GitHub has no user called ${login}.`);
  }
  throw new QueueError(
    502,
    "github_unavailable",
    purpose === "writing"
      ? `GitHub could not confirm ${login}, and a decision about a contributor is only recorded against an id GitHub confirms. Try again.`
      : `GitHub could not be asked about ${login}, and the Worker has no record of them.`,
  );
}

export async function readContributor(env: Bindings, login: string): Promise<ContributorStanding> {
  const who = await resolveAuthor(env, login, "reading");
  return standingFor(env.DB, who.login, who.id, who.from);
}

export async function setOverride(
  env: Bindings,
  adminUserId: number,
  login: string,
  mode: "allow" | "block",
  reasonRaw: string | undefined,
): Promise<SetOverrideResponse> {
  const who = await resolveAuthor(env, login, "writing");
  const previous = await readAuthorOverride(env.DB, who.id);
  const reason = sanitizeNote(reasonRaw, 200) || null;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO pr_review_overrides (author_id, author_login, mode, reason, set_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (author_id) DO UPDATE SET
           author_login = excluded.author_login, mode = excluded.mode, reason = excluded.reason,
           set_by = excluded.set_by, set_at = datetime('now')`,
    ).bind(who.id, who.login, mode, reason, adminUserId),
    auditLogStatement(env.DB, {
      userId: adminUserId,
      action: "pr_review_override_set",
      resourceType: "pr_review_author",
      resourceId: String(who.id),
      details: JSON.stringify({ login: who.login, mode, previous, reason }),
    }),
  ]);
  return {
    environment: environmentName(env),
    previous,
    standing: await standingFor(env.DB, who.login, who.id, who.from),
  };
}

export async function clearOverride(
  env: Bindings,
  adminUserId: number,
  login: string,
): Promise<ClearOverrideResponse> {
  const who = await resolveAuthor(env, login, "clearing");
  const previous = await readAuthorOverride(env.DB, who.id);
  if (previous !== null) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM pr_review_overrides WHERE author_id = ?").bind(who.id),
      auditLogStatement(env.DB, {
        userId: adminUserId,
        action: "pr_review_override_clear",
        resourceType: "pr_review_author",
        resourceId: String(who.id),
        details: JSON.stringify({ login: who.login, removed: previous }),
      }),
    ]);
  }
  return {
    environment: environmentName(env),
    removed: previous,
    standing: await standingFor(env.DB, who.login, who.id, who.from),
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 160) : "unknown";
}
