/**
 * Git Data API: file contents, blobs, trees, tree-based batched commits,
 * tags, releases, and release archive download.
 *
 * Moved verbatim from services/github.ts (#906, epic #902); the only
 * intentional changes are import paths.
 */

import { HttpError } from "../retry";
import { GITHUB_API, ORG_NAME, ghHeaders } from "./shared";
import { githubFetchWithRetry } from "./transport";

/** Identity used for all backend-initiated commits and tags on dataset repos. */
const NEMAR_COMMITTER = { name: "nemarAdmin", email: "nemarAdmin@osc.earth" };

/**
 * Detect a GitHub Contents-API stale-SHA conflict on an update PUT. When the
 * `sha` we sent no longer matches the current blob (a concurrent write landed
 * first), GitHub returns 409; some paths surface it as 422 with a
 * sha/"does not match"/"fast forward" message. Either is safe to retry by
 * refetching the SHA. Pure; match the message, not just the status.
 */
export function isContentsApiShaConflict(status: number, bodyText: string): boolean {
  if (status === 409) return true;
  if (status !== 422) return false;
  let parsed: { message?: string } | null = null;
  try {
    parsed = JSON.parse(bodyText) as { message?: string };
  } catch {
    // Fall through to substring match.
  }
  const msg = parsed?.message ?? bodyText;
  // Match the known stale-SHA 422 phrases, NOT a bare "sha" (which appears in
  // unrelated 422s, e.g. "Invalid sha for author"). The 409 arm already covers
  // the blob-sha conflict unambiguously.
  return /does not match|not a fast forward/i.test(msg);
}

/**
 * Create or update a file in a repository, on `main` unless told otherwise.
 *
 * **The default is `main`, not "whatever GitHub calls this repository's default
 * branch", and the difference is not academic.** The Contents API writes to the
 * repository's default branch when the request carries no `branch`, and sixteen
 * dataset repositories have theirs set to `git-annex` -- git-annex's own log branch
 * -- because `createRepository` uses `auto_init: false` and GitHub adopted whichever
 * branch their first push happened to carry. The publication orchestrator's two
 * DOI writes had no branch, so on those repositories they READ `main`
 * (`getFileContent` defaults to it) and WROTE `git-annex`: fourteen public datasets
 * still advertise OpenNeuro's DOI on `main` while NEMAR's concept DOI and badge sit
 * on a branch nothing reads (#1386). This docstring used to assert that a missing
 * branch lands on `main`, which is exactly the assumption that was wrong.
 *
 * Pass `branch` for a release branch or any other non-main ref; `""` is not a way
 * to ask for the repository default, because there is no reason to want one.
 *
 * **On a repository with no commits this CREATES `branch`, as an unrelated ROOT
 * commit** (#1643). Nothing here refuses; only the availability report guards
 * against it, by asking `branchExists` first.
 */
export async function createOrUpdateFile(
  repo: string,
  path: string,
  content: string,
  message: string,
  pat: string,
  branch = "main",
): Promise<void> {
  const branchQuery = `?ref=${encodeURIComponent(branch)}`;
  const encoded = btoa(
    Array.from(new TextEncoder().encode(content), (b) => String.fromCharCode(b)).join(""),
  );

  // Retry on a stale-SHA conflict: a concurrent writer (e.g. another enrichment
  // run, #755) can advance the blob between our GET-sha and PUT. Refetch the
  // current SHA and re-PUT -- last-writer-wins, no non-fast-forward failure.
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Get the current blob SHA (needed to update; absent => create).
    let sha: string | undefined;
    let getResponse: Response;
    try {
      getResponse = await fetch(
        `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/contents/${path}${branchQuery}`,
        {
          headers: {
            Authorization: `Bearer ${pat}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "NEMAR-API",
          },
        },
      );
    } catch (err) {
      throw new Error(
        `Network error checking ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (getResponse.ok) {
      const existing = await getResponse.json<{ sha: string }>();
      sha = existing.sha;
    } else if (getResponse.status !== 404) {
      const body = await getResponse.text().catch(() => "");
      throw new Error(`GitHub API error ${getResponse.status} checking ${path}: ${body}`);
    }

    // Create or update the file.
    let response: Response;
    try {
      response = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}/contents/${path}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "NEMAR-API",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message,
          content: encoded,
          ...(sha ? { sha } : {}),
          branch,
          committer: NEMAR_COMMITTER,
          author: NEMAR_COMMITTER,
        }),
      });
    } catch (err) {
      throw new Error(
        `Network error committing ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (response.ok || response.status === 201) return;

    const body = await response.text().catch(() => "");
    if (isContentsApiShaConflict(response.status, body) && attempt < maxAttempts) {
      console.warn(
        `[github] createOrUpdateFile sha conflict on ${repo}/${path}@${branch} (attempt ${attempt}/${maxAttempts}); refetching`,
      );
      continue;
    }
    throw new Error(`GitHub API error ${response.status} committing ${path}: ${body}`);
  }
  // Unreachable: every iteration returns, continues, or throws (mirrors
  // commitFilesAsTree). Guards against a future refactor silently returning void.
  throw new Error(`createOrUpdateFile: unreachable end-of-function for ${repo}/${path}`);
}

/**
 * Delete a file from a repository via the GitHub Contents API.
 */
export async function deleteRepoFile(
  repo: string,
  path: string,
  sha: string,
  message: string,
  pat: string,
): Promise<void> {
  const response = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}/contents/${path}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      sha,
      committer: NEMAR_COMMITTER,
      author: NEMAR_COMMITTER,
    }),
  });

  if (response.status === 404) return; // already deleted; treat as success
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub API error ${response.status} deleting ${path}: ${body}`);
  }
}

// ============================================================================
// Git Tree and Blob API (for manifest generation)
// ============================================================================

export interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}

/**
 * Get the recursive git tree at a given ref (tag, branch, or commit SHA).
 * Returns all entries (blobs and trees) in the repository at that ref.
 *
 * `refreshTokenOn401` (optional): when set, a one-off 401 from GitHub
 * triggers a fresh-mint of the bearer token before the call is retried
 * exactly once. Wire from `getDatasetsTokenWithRefresher` to make this
 * call self-heal across stale App-installation-token caches. Issue #596.
 */
export async function getTreeAtRef(
  repo: string,
  ref: string,
  pat: string,
  refreshTokenOn401?: () => Promise<string>,
): Promise<TreeEntry[]> {
  // First resolve the ref to a commit SHA. retryOn404: callers that pass a
  // ref they just created (a tag we wrote, "main" right after a merge) will
  // see GitHub briefly 404 the new ref while caches catch up; we retry those.
  const refResponse = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/commits/${ref}`,
    {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
      },
    },
    { retryOn404: true, refreshTokenOn401 },
  );

  if (!refResponse.ok) {
    throw new HttpError(
      `Failed to resolve ref '${ref}': HTTP ${refResponse.status}`,
      refResponse.status,
    );
  }

  const commit = await refResponse.json<{ sha: string; commit: { tree: { sha: string } } }>();
  const treeSha = commit.commit.tree.sha;

  // Get the tree recursively
  const treeResponse = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/git/trees/${treeSha}?recursive=1`,
    {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
      },
    },
    { refreshTokenOn401 },
  );

  if (!treeResponse.ok) {
    throw new HttpError(`Failed to get tree: HTTP ${treeResponse.status}`, treeResponse.status);
  }

  const tree = await treeResponse.json<{ tree: TreeEntry[]; truncated: boolean }>();
  if (tree.truncated) {
    console.warn(`[manifest] Tree for ${repo}@${ref} was truncated (very large repo)`);
  }

  return tree.tree.filter((entry) => entry.type === "blob");
}

/**
 * Get the content of a blob by SHA. Returns the decoded text content.
 * Uses the blob API to get base64-encoded content.
 *
 * `refreshTokenOn401` mirrors `getTreeAtRef`'s parameter — wire it from
 * `getDatasetsTokenWithRefresher` so the call self-heals from a one-off
 * stale-App-token 401. Issue #596.
 */
export async function getBlobContent(
  repo: string,
  blobSha: string,
  pat: string,
  refreshTokenOn401?: () => Promise<string>,
): Promise<string> {
  // retryOn404: blob SHA came from a tree we just resolved, so 404 indicates
  // propagation lag, not a missing object.
  const response = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/git/blobs/${blobSha}`,
    {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
      },
    },
    { retryOn404: true, refreshTokenOn401 },
  );

  if (!response.ok) {
    throw new HttpError(`Failed to get blob ${blobSha}: HTTP ${response.status}`, response.status);
  }

  const blob = await response.json<{ content: string; encoding: string }>();
  if (blob.encoding === "base64") {
    const binary = atob(blob.content.replace(/\n/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }
  return blob.content;
}

/**
 * Get the text content of a file from a repo via the Contents API.
 * Returns null if the file does not exist.
 */
export async function getFileContent(
  repo: string,
  filePath: string,
  pat: string,
  ref = "main",
  /** Retry policy; the default is the background one. A caller in a batch passes {@link LOOKUP_ONCE}. */
  options?: FetchPolicy,
): Promise<string | null> {
  // No retryOn404 here: 404 is a valid "file not present" signal returned as null.
  const response = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/contents/${filePath}?ref=${ref}`,
    {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
      },
    },
    options,
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new HttpError(
      `Failed to get ${filePath} from ${repo}: HTTP ${response.status}`,
      response.status,
    );
  }

  const data = await response.json<{ content: string; encoding: string }>();
  // A zero-byte file comes back as base64 with `content: ""`. That is a file
  // that exists and is empty, which is an answer; only a response with no
  // content field at all is not one.
  if (data.encoding === "base64" && data.content === "") return "";
  if (!data.content) {
    throw new Error(`No content field in GitHub response for ${filePath} in ${repo}`);
  }
  if (data.encoding === "base64") {
    const binary = atob(data.content.replace(/\n/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }
  return data.content;
}

type FetchPolicy = NonNullable<Parameters<typeof githubFetchWithRetry>[2]>;

/**
 * How `branchExists` (and a sweep's file reads) talk to GitHub: the interactive
 * kind and ONE attempt, so it never sleeps. The default (background) kind sleeps up to a minute before a
 * call when the cached rate-limit bucket is nearly drained, and again between
 * retries; asked once per row of a sweep, that stalls a 30-row pass for the
 * better part of an hour (measured: about 60 s per row). Interactive turns a
 * drained bucket into an immediate HttpError(503), and a single attempt turns a
 * 5xx, 429 or secondary rate limit into the response itself, so every one of
 * them becomes a per-row error that leaves the row unstamped for the next pass.
 */
export const LOOKUP_ONCE: FetchPolicy = { kind: "interactive", maxAttempts: 1 };

/**
 * GET the ref of `branch`: the one request `branchExists` and
 * `getMainBranchSha` both make, so they cannot disagree about the URL.
 *
 * The branch is encoded per path segment so that `#`, `?` and `%` in a name
 * cannot change the URL, while `/` stays a separator. GitHub accepts
 * `release/1.0` and `release%2F1.0` alike in a ref path, so this is about not
 * letting a branch name alter the request, not about making slash branches
 * resolvable. (`getMainBranchSha` used to send the branch raw.)
 *
 * `options` is the retry policy, the one way the two requests differ; they also
 * differ in what a 404 or an empty-repository 409 means (an answer for one, an
 * error for the other), which is why neither is written in terms of the other.
 */
async function fetchBranchRef(
  repo: string,
  branch: string,
  pat: string,
  options: FetchPolicy,
): Promise<Response> {
  const ref = branch.split("/").map(encodeURIComponent).join("/");
  return githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/git/ref/heads/${ref}`,
    { headers: ghHeaders(pat) },
    options,
  );
}

/** The `HttpError` for a GitHub response that is not an answer (`what`
 *  completes "Failed to ..."). Pass `bodyText` when the body was already read. */
async function githubHttpError(
  response: Response,
  what: string,
  bodyText?: string,
): Promise<HttpError> {
  const error = bodyText ?? (await response.text().catch(() => "<failed to read body>"));
  return new HttpError(
    `Failed to ${what}: HTTP ${response.status}: ${error.slice(0, 300)}`,
    response.status,
    error.slice(0, 300),
  );
}

/** The commit SHA in a 2xx ref response. A 2xx whose body is not a ref (a
 *  proxy's HTML page, a captive portal) is an error, never an answer. */
async function readRefSha(response: Response, branch: string): Promise<string> {
  const refData = (await response.json().catch(() => null)) as {
    object?: { sha?: string };
  } | null;
  const sha = refData?.object?.sha;
  if (!sha) {
    throw new Error(`Unexpected response format for ${branch} branch ref`);
  }
  return sha;
}

/**
 * GitHub answers 404 for a ref that does not exist AND for a repository the
 * token cannot see (lost installation access, the wrong installation, a PAT
 * scope), so a 404 on the ref says nothing about the depositor's state until
 * the repository itself is known to be visible. Resolves when it is; throws
 * `HttpError(404)` when it is not.
 */
async function assertRepositoryVisible(repo: string, pat: string): Promise<void> {
  const response = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}`,
    { headers: ghHeaders(pat) },
    LOOKUP_ONCE,
  );
  if (response.status === 404) {
    await response.body?.cancel();
    throw new HttpError(
      `${ORG_NAME}/${repo}: repository not visible to NEMAR (GitHub answers 404 for the repository itself)`,
      404,
    );
  }
  if (!response.ok) {
    throw await githubHttpError(response, `look up repository ${ORG_NAME}/${repo}`);
  }
  await response.body?.cancel();
}

/**
 * Whether `branch` exists in the dataset repository.
 *
 * Two responses are answers, and everything else throws:
 *   - 404 means "no such ref" ONLY if the repository is visible, so it is
 *     followed by one probe of the repository itself; a repository that is not
 *     visible throws `HttpError(404)` instead of reading as "no branch".
 *   - 409 whose message says the repository is empty ("Git Repository is
 *     empty.", observed from api.github.com for an empty repository on
 *     2026-10-07; not in GitHub's reference) means "no". Any other 409 throws.
 * A 2xx must carry a ref (`object.sha`); a 2xx that does not throws.
 *
 * The policy is {@link LOOKUP_ONCE}: interactive, a single attempt, never a
 * sleep. A 404 is not retried as a propagation delay (that is
 * `getMainBranchSha`'s question, not this one), and neither is a 5xx, a 429 or
 * a secondary rate limit; each throws, and the caller decides what that costs.
 */
export async function branchExists(repo: string, branch: string, pat: string): Promise<boolean> {
  const what = `look up ${branch} branch ref`;
  const response = await fetchBranchRef(repo, branch, pat, LOOKUP_ONCE);
  if (response.status === 404) {
    await response.body?.cancel();
    await assertRepositoryVisible(repo, pat);
    return false;
  }
  if (response.status === 409) {
    const body = await response.text().catch(() => "");
    if (/empty/i.test(body)) return false;
    throw await githubHttpError(response, what, body);
  }
  if (!response.ok) throw await githubHttpError(response, what);
  await readRefSha(response, branch);
  return true;
}

/**
 * Get the latest commit SHA on a branch.
 *
 * @param repo Repository name (e.g., "nm000123")
 * @param branch Branch name (e.g., "main")
 * @param pat GitHub PAT
 * @returns 40-character commit SHA
 * @throws {Error} If the branch ref cannot be resolved
 */
export async function getMainBranchSha(repo: string, branch: string, pat: string): Promise<string> {
  // retryOn404: caller knows the branch exists (e.g., we just committed to it),
  // so 404 indicates GitHub hasn't propagated the ref yet.
  const response = await fetchBranchRef(repo, branch, pat, { retryOn404: true });
  if (!response.ok) throw await githubHttpError(response, `get ${branch} branch ref`);
  return readRefSha(response, branch);
}

/** Input to `commitFilesAsTree`. `content` must be UTF-8 text; binary is not supported. */
export interface TreeFile {
  path: string;
  content: string;
  mode?: "100644" | "100755";
}

/**
 * Validate `files` against the constraints GitHub enforces on tree entries.
 * Catches problems locally so they fail fast instead of being retried 3 times
 * through `commitFilesAsTree`'s ref-conflict loop.
 */
function validateTreeFiles(files: TreeFile[]): void {
  const seen = new Set<string>();
  for (const f of files) {
    if (!f.path) {
      throw new Error("commitFilesAsTree: empty path");
    }
    if (f.path.startsWith("/")) {
      throw new Error(`commitFilesAsTree: path must be repo-relative, got '${f.path}'`);
    }
    if (f.path.endsWith("/")) {
      throw new Error(`commitFilesAsTree: path must not end with '/', got '${f.path}'`);
    }
    if (f.path.includes("\0")) {
      throw new Error("commitFilesAsTree: path contains NUL byte");
    }
    if (f.path.split("/").some((seg) => seg === "..")) {
      throw new Error(`commitFilesAsTree: path contains '..' segment, got '${f.path}'`);
    }
    if (seen.has(f.path)) {
      throw new Error(`commitFilesAsTree: duplicate path '${f.path}'`);
    }
    seen.add(f.path);
  }
}

/**
 * Detect GitHub's fast-forward conflict 422. The endpoint returns 422 for
 * several distinct reasons (bad SHA, missing ref, signed-commit policy, etc.)
 * and only the fast-forward case is safe to retry. Match the documented
 * English message rather than the raw status code.
 */
function isFastForwardConflict422(bodyText: string): boolean {
  let parsed: { message?: string } | null = null;
  try {
    parsed = JSON.parse(bodyText) as { message?: string };
  } catch {
    // Fall through to substring match.
  }
  const msg = parsed?.message ?? bodyText;
  return /not a fast forward/i.test(msg);
}

/**
 * Commit one or more files to a branch in a single Git Data API transaction.
 *
 * Cost (happy path): 4 REST calls regardless of how many files are written —
 * `createOrUpdateFile()` costs 2 per file, so this strictly wins for N >= 3
 * and ties at N = 2. For N = 1 prefer `createOrUpdateFile()`.
 *
 * Concurrency: if the branch advances between resolving the base and the
 * ref PATCH, GitHub returns 422 "Update is not a fast forward". We make up to
 * 3 attempts (2 retries), refetching the base each time. Non-fast-forward
 * 422s (bad branch, signed-commit policy, missing ref) are surfaced
 * immediately — they will never succeed on retry.
 *
 * @returns SHA of the new commit. For an empty `files` array, returns the
 *   current branch head SHA without making any write calls.
 */
export async function commitFilesAsTree(
  repo: string,
  branch: string,
  files: TreeFile[],
  message: string,
  pat: string,
): Promise<string> {
  const authHeaders = {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "NEMAR-API",
  };
  const jsonHeaders = { ...authHeaders, "Content-Type": "application/json" };

  if (files.length === 0) {
    return getMainBranchSha(repo, branch, pat);
  }

  validateTreeFiles(files);

  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const branchResp = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/branches/${branch}`,
      { headers: authHeaders },
      { retryOn404: true },
    );
    if (!branchResp.ok) {
      const body = await branchResp.text().catch(() => "");
      throw new HttpError(
        `Failed to resolve branch '${branch}': HTTP ${branchResp.status}: ${body.slice(0, 1024)}`,
        branchResp.status,
        body.slice(0, 1024),
      );
    }
    const branchData = (await branchResp.json()) as {
      commit: { sha: string; commit: { tree: { sha: string } } };
    };
    const baseCommitSha = branchData.commit.sha;
    const baseTreeSha = branchData.commit.commit.tree.sha;

    const treeResp = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/git/trees`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree: files.map((f) => ({
            path: f.path,
            mode: f.mode ?? "100644",
            type: "blob",
            content: f.content,
          })),
        }),
      },
    );
    if (!treeResp.ok) {
      const body = await treeResp.text().catch(() => "");
      throw new HttpError(
        `Failed to create tree on ${repo}@${branch}: HTTP ${treeResp.status}: ${body.slice(0, 1024)}`,
        treeResp.status,
        body.slice(0, 1024),
      );
    }
    const { sha: newTreeSha } = (await treeResp.json()) as { sha: string };

    const isoDate = new Date().toISOString();
    const commitResp = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/git/commits`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          message,
          tree: newTreeSha,
          parents: [baseCommitSha],
          author: { ...NEMAR_COMMITTER, date: isoDate },
          committer: { ...NEMAR_COMMITTER, date: isoDate },
        }),
      },
    );
    if (!commitResp.ok) {
      const body = await commitResp.text().catch(() => "");
      throw new HttpError(
        `Failed to create commit on ${repo}@${branch}: HTTP ${commitResp.status}: ${body.slice(0, 1024)}`,
        commitResp.status,
        body.slice(0, 1024),
      );
    }
    const { sha: newCommitSha } = (await commitResp.json()) as { sha: string };

    const refResp = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/git/refs/heads/${branch}`,
      {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ sha: newCommitSha }),
      },
    );
    if (refResp.ok) return newCommitSha;

    const body = await refResp.text().catch(() => "");
    // 422 with a non-fast-forward message means the branch advanced; refetch
    // and retry. Other 422 causes (bad ref, signed-commit policy, missing
    // ref) never succeed on retry — surface them immediately.
    if (refResp.status === 422 && isFastForwardConflict422(body) && attempt < maxAttempts) {
      console.warn(
        `[github] commitFilesAsTree fast-forward conflict on ${repo}@${branch} (attempt ${attempt}/${maxAttempts}): ${body.slice(0, 200)}`,
      );
      continue;
    }
    const note =
      refResp.status === 422 && isFastForwardConflict422(body)
        ? ` (exhausted ${maxAttempts} attempts)`
        : "";
    throw new HttpError(
      `Failed to update ref ${branch} on ${repo}: HTTP ${refResp.status}${note}: ${body.slice(0, 1024)}`,
      refResp.status,
      body.slice(0, 1024),
    );
  }

  // Unreachable: the for loop either returns, continues, or throws.
  throw new Error(`commitFilesAsTree: unreachable end-of-function for ${repo}@${branch}`);
}

export interface EnrichmentCommitResult {
  /** "batched" when metadata + .bidsignore were committed together; "single" when only metadata was committed. */
  commitMode: "batched" | "single";
  /** True when .bidsignore was modified in the commit. */
  bidsignoreUpdated: boolean;
  /** Set when reading existing .bidsignore failed; metadata was still committed alone. */
  bidsignoreReadError?: string;
}

/**
 * Thrown by `commitEnrichmentWithBidsignore` on commit failure. Carries the
 * `commitMode` that was attempted so callers can decide whether the failure
 * affected both files (batched) or only metadata (single).
 */
export class EnrichmentCommitError extends Error {
  readonly commitMode: "batched" | "single";
  readonly bidsignoreReadError?: string;
  constructor(
    message: string,
    commitMode: "batched" | "single",
    bidsignoreReadError: string | undefined,
    cause?: unknown,
  ) {
    super(message);
    this.name = "EnrichmentCommitError";
    this.commitMode = commitMode;
    this.bidsignoreReadError = bidsignoreReadError;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * Commit a NEMAR enrichment metadata file plus a `.bidsignore` update (when
 * needed) using whichever path is cheapest:
 *
 *   - both files dirty -> `commitFilesAsTree` (one atomic commit, 4 calls)
 *   - only metadata dirty -> `createOrUpdateFile` (single-file Contents API, 2 calls)
 *
 * If reading the existing `.bidsignore` fails, commits metadata alone and
 * returns the read error in `bidsignoreReadError`. Throws
 * `EnrichmentCommitError` on commit failure, with `commitMode` set so callers
 * can tell which path was attempted.
 */
export async function commitEnrichmentWithBidsignore(
  repo: string,
  branch: string,
  metadataPath: string,
  metadataContent: string,
  bidsignoreEntriesToIgnore: string[],
  message: string,
  pat: string,
  /**
   * Optional additional files to commit in the same tree write. Used by the
   * enrichment pipeline to land an auto-generated participants.tsv alongside
   * .nemar/metadata.json when the dataset shipped without one (see
   * `ensureParticipantsTsv` in participants-tsv.ts). When non-empty, forces
   * a batched tree commit even if .bidsignore didn't change so all files land
   * in one commit.
   */
  additionalFiles: ReadonlyArray<{ path: string; content: string }> = [],
): Promise<EnrichmentCommitResult> {
  let bidsignoreUpdated = false;
  let bidsignoreContent = "";
  let bidsignoreReadError: string | undefined;
  try {
    const tree = await getTreeAtRef(repo, branch, pat);
    const bidsignoreFile = tree.find((f) => f.path === ".bidsignore");
    if (bidsignoreFile) {
      bidsignoreContent = await getBlobContent(repo, bidsignoreFile.sha, pat);
    }
    for (const entry of bidsignoreEntriesToIgnore) {
      if (!bidsignoreContent.includes(entry)) {
        bidsignoreContent = bidsignoreContent
          ? `${bidsignoreContent.trimEnd()}\n${entry}\n`
          : `${entry}\n`;
        bidsignoreUpdated = true;
      }
    }
  } catch (readErr) {
    bidsignoreReadError = readErr instanceof Error ? readErr.message : String(readErr);
    bidsignoreUpdated = false;
  }

  // Batched mode covers .bidsignore changes AND any additional files the
  // caller requested. Single-file mode is reserved for the metadata-only case.
  const commitMode: "batched" | "single" =
    bidsignoreUpdated || additionalFiles.length > 0 ? "batched" : "single";
  try {
    if (commitMode === "batched") {
      const treeFiles: Array<{ path: string; content: string }> = [
        { path: metadataPath, content: metadataContent },
      ];
      if (bidsignoreUpdated) {
        treeFiles.push({ path: ".bidsignore", content: bidsignoreContent });
      }
      for (const f of additionalFiles) {
        treeFiles.push({ path: f.path, content: f.content });
      }
      // Guard against duplicate paths in the tree write. GitHub's tree API
      // accepts duplicates but the behavior is last-wins, which silently
      // discards earlier contents. Throwing instead of silently winning
      // prevents a future caller from accidentally clobbering metadataPath
      // or .bidsignore via additionalFiles.
      const seen = new Set<string>();
      for (const f of treeFiles) {
        if (seen.has(f.path)) {
          throw new EnrichmentCommitError(
            `duplicate path '${f.path}' in commit tree`,
            commitMode,
            bidsignoreReadError,
            null,
          );
        }
        seen.add(f.path);
      }
      await commitFilesAsTree(repo, branch, treeFiles, message, pat);
    } else {
      // Pass `branch` so a release/* or other non-main caller doesn't have
      // its single-file commit silently land on the default branch.
      await createOrUpdateFile(repo, metadataPath, metadataContent, message, pat, branch);
    }
  } catch (commitErr) {
    const detail = commitErr instanceof Error ? commitErr.message : String(commitErr);
    throw new EnrichmentCommitError(detail, commitMode, bidsignoreReadError, commitErr);
  }
  return { commitMode, bidsignoreUpdated, bidsignoreReadError };
}

/**
 * Create a git tag on a repository.
 *
 * @param repo Repository name (e.g., "nm000123")
 * @param tag Tag name (e.g., "v1.0.0")
 * @param sha Commit SHA to tag
 * @param message Tag message/annotation
 * @param pat GitHub PAT
 * @returns Tag SHA if successful
 * @throws {Error} If tag object or reference creation fails
 */
export async function createTag(
  repo: string,
  tag: string,
  sha: string,
  message: string,
  pat: string,
): Promise<string> {
  // First, create an annotated tag object
  const tagResponse = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}/git/tags`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tag,
      message,
      object: sha,
      type: "commit",
      tagger: { ...NEMAR_COMMITTER, date: new Date().toISOString() },
    }),
  });

  if (!tagResponse.ok) {
    const error = await tagResponse.text();
    throw new Error(`Failed to create tag object: ${error}`);
  }

  const tagData = (await tagResponse.json()) as { sha: string };

  // Then, create a reference to the tag
  const refResponse = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}/git/refs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ref: `refs/tags/${tag}`,
      sha: tagData.sha,
    }),
  });

  if (!refResponse.ok) {
    // 422 means the tag reference already exists; treat as success for idempotent re-runs
    if (refResponse.status === 422) {
      return tagData.sha;
    }
    const error = await refResponse.text();
    throw new Error(`Failed to create tag reference: ${error}`);
  }

  return tagData.sha;
}

/**
 * Create a GitHub release from a tag.
 *
 * @param repo Repository name (e.g., "nm000123")
 * @param tag Tag name (e.g., "v1.0.0")
 * @param name Release name (e.g., "Dataset v1.0.0")
 * @param body Release notes/description
 * @param pat GitHub PAT
 * @returns Release ID if successful
 * @throws {Error} If release creation fails (except for already-existing releases)
 */
export async function createRelease(
  repo: string,
  tag: string,
  name: string,
  body: string,
  pat: string,
): Promise<number> {
  const response = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}/releases`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tag_name: tag,
      name,
      body,
      draft: false,
      prerelease: false,
    }),
  });

  if (!response.ok) {
    // 422 means release already exists for this tag; fetch the existing one
    if (response.status === 422) {
      const existing = await fetch(
        `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/releases/tags/${tag}`,
        {
          headers: {
            Authorization: `Bearer ${pat}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "NEMAR-API",
          },
        },
      );
      if (existing.ok) {
        const existingData = (await existing.json()) as { id: number };
        return existingData.id;
      }
    }
    const error = await response.text();
    throw new Error(`Failed to create release: ${error}`);
  }

  const releaseData = (await response.json()) as { id: number };
  return releaseData.id;
}

/**
 * Download a repository source archive (zipball) at a given git ref.
 * Uses the repository archive endpoint, not the releases API.
 *
 * @param repo Repository name (e.g., "nm000123")
 * @param ref Git ref to archive (tag, branch, or SHA; e.g., "v1.0.0")
 * @param pat GitHub PAT
 * @returns ArrayBuffer containing the zip file
 * @throws {Error} If download fails or archive exceeds 100MB
 */
export async function downloadReleaseArchive(
  repo: string,
  ref: string,
  pat: string,
): Promise<ArrayBuffer> {
  const response = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}/zipball/${ref}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to download archive for ${ref}: ${error}`);
  }

  // Validate content-type to catch HTML error pages returned with 200
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    throw new Error(`Expected zip archive but received HTML response for ${ref}`);
  }

  // Guard against exceeding CF Worker memory limits (128MB)
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number.parseInt(contentLength, 10) > 100 * 1024 * 1024) {
    throw new Error(
      `Archive for ${ref} exceeds 100MB (${contentLength} bytes); too large for Worker environment`,
    );
  }

  return response.arrayBuffer();
}
