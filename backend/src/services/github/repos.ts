/**
 * Repository lifecycle: create/delete, visibility, description, default and
 * main branch management, auto-merge, org repo listing, username validation.
 *
 * Moved verbatim from services/github.ts (#906, epic #902); the only
 * intentional changes are import paths.
 */

import { GITHUB_API, ORG_NAME, ghHeaders } from "./shared";
import { githubFetchWithRetry } from "./transport";

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  clone_url: string;
  ssh_url: string;
}

/**
 * The three answers a GitHub user lookup can give (#1052).
 *
 * `unavailable` is the one that used to be missing. This helper collapsed
 * every non-2xx -- a 500, a 429, a DNS failure -- into the same `null` as a
 * clean 404, so a GitHub outage told a user their handle did not exist and
 * sent them to go fix a field that was already correct. The three cases need
 * three different answers from a caller: proceed, refuse, or ask them to try
 * again later.
 *
 * `detail` carries the status (or the thrown message) for the log; it is not
 * meant for a user, who is told to retry and nothing more.
 */
export type GitHubUserLookup =
  | { status: "found"; user: GitHubUser }
  | { status: "not_found" }
  | { status: "unavailable"; detail: string };

/**
 * Look up a GitHub account. Never throws: a transport failure is reported as
 * `unavailable`, which is what it is.
 *
 * 404 is the ONLY not-found. 403 and 429 are rate limiting or an auth problem
 * with our own installation token, 5xx is GitHub, and anything else is
 * unclassified -- none of them is evidence about the account, so none of them
 * may be reported as one.
 */
export async function validateGitHubUsername(
  username: string,
  pat: string,
): Promise<GitHubUserLookup> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API()}/users/${username}`, {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
      },
    });
  } catch (err) {
    return {
      status: "unavailable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (response.status === 404) return { status: "not_found" };
  if (!response.ok) {
    return { status: "unavailable", detail: `HTTP ${response.status}` };
  }

  try {
    return { status: "found", user: (await response.json()) as GitHubUser };
  } catch (err) {
    // A 200 whose body will not parse is GitHub misbehaving, not an absent
    // account.
    return {
      status: "unavailable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * List all repositories in the nemarDatasets org
 */
export async function listOrgRepos(pat: string): Promise<GitHubRepo[]> {
  const repos: GitHubRepo[] = [];
  let page = 1;

  while (true) {
    const response = await fetch(
      `${GITHUB_API()}/orgs/${ORG_NAME}/repos?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "NEMAR-API",
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to list repos: ${response.status}`);
    }

    const pageRepos = await response.json<GitHubRepo[]>();
    if (pageRepos.length === 0) break;

    repos.push(...pageRepos);
    page++;
  }

  return repos;
}

/**
 * GitHub rejects a repo `description` containing control characters with a 422
 * ("description control characters are not allowed") -- some OpenNeuro dataset
 * descriptions carry stray newlines/tabs/control bytes, which crashed the
 * onboard import at repo-create (e.g. ds005815). A repo description is a
 * single-line cosmetic field, so collapse all control chars (incl. tab/newline)
 * to spaces, squeeze runs, trim, and cap at GitHub's ~350-char limit. This is
 * the GitHub-side label only; the dataset's real description is untouched.
 */
export function sanitizeRepoDescription(description: string): string {
  const cleaned = description
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 350 ? `${cleaned.slice(0, 349)}…` : cleaned;
}

export async function createRepository(
  name: string,
  description: string,
  isPrivate: boolean,
  pat: string,
): Promise<GitHubRepo> {
  const response = await fetch(`${GITHUB_API()}/orgs/${ORG_NAME}/repos`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      description: sanitizeRepoDescription(description),
      private: isPrivate,
      auto_init: false, // We push the first commit from CLI
      has_issues: true,
      has_projects: false,
      has_wiki: false,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create repo: ${error}`);
  }

  return response.json();
}

/**
 * Delete a repository from the nemarDatasets organization.
 * Idempotent: returns true if the repo was deleted or did not exist.
 * Requires a PAT with `delete_repo` scope.
 */
export async function deleteRepository(repo: string, pat: string): Promise<boolean> {
  if (!repo || repo.includes("/") || repo.includes("..")) {
    throw new Error(`Invalid repository name: "${repo}"`);
  }

  const response = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
    },
  });

  // 204 = deleted, 404 = already gone (both are success)
  if (response.status === 204 || response.status === 404) {
    return true;
  }

  const error = await response.text();
  throw new Error(`Failed to delete repo ${repo}: HTTP ${response.status} - ${error}`);
}

/**
 * Ensure a dataset repo's default branch is "main".
 *
 * Two different faults wear the same symptom, and they need opposite repairs:
 *
 * - **The branch carrying the dataset is called something else** (`master`, or
 *   DataLad's `adjusted/master(unlocked)`). Renaming it to `main` is the fix, and
 *   was the only case this function knew about.
 * - **`main` exists and the repository simply points somewhere else.** Sixteen
 *   imported repositories have `default_branch = git-annex`, git-annex's own log
 *   branch, because `createRepository` uses `auto_init: false` and GitHub adopts
 *   whichever branch the first push happens to carry (#1386). Here a rename is not
 *   merely unnecessary, it is destructive in intent: it would try to turn the annex
 *   log branch into `main` while a real `main` already exists. Repointing the
 *   default is the fix.
 *
 * So: look for `main` first. If it is there, move the pointer; only rename when
 * `main` is the thing that is missing.
 *
 * Safe to call multiple times (no-op if already "main").
 */
export async function ensureMainBranch(
  repo: string,
  pat: string,
): Promise<{ changed: boolean; action?: "renamed" | "repointed"; previousBranch?: string }> {
  const repoResponse = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}`, {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
    },
  });

  if (!repoResponse.ok) {
    const body = await repoResponse.text().catch(() => "");
    throw new Error(`Failed to fetch repo info for ${repo}: ${repoResponse.status} ${body}`);
  }

  const repoData = (await repoResponse.json()) as { default_branch: string };
  const defaultBranch = repoData.default_branch;

  if (defaultBranch === "main") {
    return { changed: false };
  }

  // Does a real `main` already exist? Then the repository is merely pointed at the
  // wrong branch, and the pointer is what moves.
  const mainResponse = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}/branches/main`, {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
    },
  });
  if (mainResponse.ok) {
    console.log(
      `Repointing default branch from "${defaultBranch}" to the existing "main" for ${repo}`,
    );
    const repointResponse = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ default_branch: "main" }),
    });
    if (!repointResponse.ok) {
      const errorBody = await repointResponse.text();
      throw new Error(
        `Failed to set the default branch to the existing "main" for ${repo} (was "${defaultBranch}"): ${repointResponse.status} ${errorBody}`,
      );
    }
    // `repointed`, not `renamed`: nothing was renamed here, and an audit trail that
    // says otherwise sends the next investigator looking for a branch rename that
    // never happened -- the same class of misdirection that made #1386 hard to find.
    return { changed: true, action: "repointed", previousBranch: defaultBranch };
  }
  // A bare `fetch`, not `githubFetchWithRetry`, and deliberately: a transient 502
  // makes this step fail loudly rather than proceed on a guess, which is the whole
  // point of the check. Consistent with the repo GET above it. The cost is a false
  // failure of the `main_branch` step on a one-off 5xx, which is recoverable by
  // re-running; renaming a branch that should not be renamed is not.
  if (mainResponse.status !== 404) {
    const body = await mainResponse.text().catch(() => "");
    throw new Error(
      `Could not determine whether ${repo} has a main branch (HTTP ${mainResponse.status}): ${body.slice(0, 300)}. Refusing to rename "${defaultBranch}" without knowing.`,
    );
  }

  console.log(`Renaming default branch "${defaultBranch}" to "main" for ${repo}`);

  const renameResponse = await fetch(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/branches/${encodeURIComponent(defaultBranch)}/rename`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ new_name: "main" }),
    },
  );

  if (!renameResponse.ok) {
    const errorBody = await renameResponse.text();
    throw new Error(
      `Failed to rename branch "${defaultBranch}" to "main" for ${repo}: ${renameResponse.status} ${errorBody}`,
    );
  }

  return { changed: true, action: "renamed", previousBranch: defaultBranch };
}

/**
 * Enable auto-merge for a repository
 */
export async function enableAutoMerge(repo: string, pat: string): Promise<boolean> {
  const response = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      allow_auto_merge: true,
    }),
  });

  return response.ok;
}

/**
 * Read whether a repository is private right now. `ok: false` when GitHub did not answer or the
 * answer carried no boolean `private`: a caller that must know the prior state (so it can put it
 * back) treats that as "unknown" and stops, instead of guessing the opposite of its target.
 */
export async function getRepoPrivate(
  repo: string,
  pat: string,
): Promise<{ ok: true; isPrivate: boolean } | { ok: false; status: number; error: string }> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}`, {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
      },
    });
  } catch (fetchError) {
    const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
    return { ok: false, status: 0, error: `Network error: ${msg}` };
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { ok: false, status: response.status, error: body || `HTTP ${response.status}` };
  }
  const info = (await response.json().catch(() => null)) as { private?: unknown } | null;
  if (typeof info?.private !== "boolean") {
    return {
      ok: false,
      status: response.status,
      error: "GitHub's answer carried no `private` flag",
    };
  }
  return { ok: true, isPrivate: info.private };
}

/**
 * Set repository visibility (public or private)
 */
export async function setRepoVisibility(
  repo: string,
  isPrivate: boolean,
  pat: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ private: isPrivate }),
    });
  } catch (fetchError) {
    const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
    return { ok: false, status: 0, error: `Network error: ${msg}` };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { ok: false, status: response.status, error: body || `HTTP ${response.status}` };
  }
  return { ok: true, status: response.status };
}

export async function setRepoDescription(
  repo: string,
  description: string,
  pat: string,
  homepage?: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  let response: Response;
  try {
    // Sanitize for the same 422 createRepository guards against: callers pass a
    // BIDS Name / dataset name that can carry control chars (enrich-dataset,
    // publish-approval), which GitHub rejects on PATCH too.
    const payload: { description: string; homepage?: string } = {
      description: sanitizeRepoDescription(description),
    };
    if (homepage !== undefined) payload.homepage = homepage;
    response = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (fetchError) {
    const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
    return { ok: false, status: 0, error: `Network error: ${msg}` };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { ok: false, status: response.status, error: body || `HTTP ${response.status}` };
  }
  return { ok: true, status: response.status };
}

/** A repo's default branch (defaults to "main" if it can't be read). */
export async function getRepoDefaultBranch(repo: string, pat: string): Promise<string> {
  const r = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}`,
    { headers: ghHeaders(pat) },
    { retryOn404: true },
  );
  if (!r.ok) return "main";
  const info = (await r.json()) as { default_branch?: string };
  return info.default_branch || "main";
}
