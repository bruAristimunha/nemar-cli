/**
 * Does the Zarr serving copy describe the tagged data? (portable compute, card DM-06b, plan D12)
 *
 * A dataset has ONE serving copy, built from one commit S of its repository (`source_commit` in the copy's own
 * `index.json`). A version is named by a tag whose commit is T. A Zarr recipe reads the copy and says the result
 * is the version's, so the Worker asks, before a job exists, for proof that the copy's data is the tagged data:
 *
 *  - `exact`: S equals T.
 *  - `metadata_only`: the GitHub compare of `T...S` answers `status` `ahead`, `behind_by` 0, fewer than 300
 *    files, every changed path (and a renamed file's previous path) under `.nemar/` or `.github/`, and no more
 *    changed paths than {@link ZARR_SOURCE_MAX_DELTA_PATHS}. What this proves is exactly that: no file outside
 *    `.nemar/` and `.github/` changed between the tag and the copy's commit.
 *  - anything else is refused.
 *
 * The recipe cannot make this check (its network reaches only the Zarr host and the data host); it takes S, T,
 * the verdict and the delta paths as arguments, validates that they agree with one another, and refuses an
 * index whose own commit is not S. This file is the one place the verdict is decided, and its two words are:
 *  - `zarr_source_mismatch` (409): the copy COULD NOT BE SHOWN to be the tagged version's data. It covers a
 *    proof that fails (behind, diverged, a data path) and a check that is out of its limits (300 or more
 *    files, more paths than a job carries, no changed path to name, a path the launch cannot carry) and a
 *    tag or commit GitHub did not show (a 404 can also mean the installation cannot see the repository). The
 *    REASON, one of {@link ZARR_SOURCE_REASONS}, is returned with the word.
 *  - `zarr_source_unverifiable` (503): the copy or GitHub could not be read, so nothing is known (a timeout,
 *    a 5xx, a refusal, a body over its bound, no index, no credentials in production). The same dispatch may
 *    succeed later.
 * A verdict is never guessed: every path that is not a positive proof is one of the two words.
 *
 * THE TAG IS A TAG. The commit is read from `commits/refs/tags/<name>`, the fully qualified ref (the short
 * `tags/` form is a 422, as `upstream-repull-verified.ts` found), never `commits/<name>`: that form resolves
 * a branch, a lightweight tag or a commit prefix, and a branch or a `1.0.2` tag outside the `refs/tags/v*`
 * ruleset is something anyone who can push to the dataset repository can create or move.
 *
 * THE BOUNDS, all literal, because this runs inside an administrator's request:
 *  - at most THREE GitHub requests per call (the commit by tag, once more without a leading `v` after a 404 or
 *    422, and one compare), each abandoned after {@link ZARR_SOURCE_GITHUB_TIMEOUT_MS} (5 s), with NO retry
 *    (`maxAttempts` 1), no redirect followed, and a body read to at most {@link ZARR_SOURCE_COMMIT_MAX_BYTES}
 *    (1 MiB, the commit) or {@link ZARR_SOURCE_COMPARE_MAX_BYTES} (8 MiB, the compare). The compare asks
 *    `per_page=100`, which pages its COMMITS; its files come on the first page, GitHub lists at most 300 of them
 *    for the whole comparison, and the 24-path cap (not the page) is the real limit on what is passed on.
 *  - ONE index read, abandoned after {@link ZARR_SOURCE_INDEX_TIMEOUT_MS} (10 s). Over HTTP (a test or the local
 *    stack, `NEMAR_ZARR_INDEX_BASE`) the body is read to at most {@link ZARR_SOURCE_INDEX_MAX_BYTES} (64 MiB, the
 *    recipe's own bound). In production the read is `getZarrIndex`, whose body is not bounded by this file: the
 *    wait for it is, and the converter's index is well under 1 MiB.
 *  - one installation-token mint at most (cached per installation), its wait bounded by the same 5 s.
 *  The token is awaited first, then the index read and the tag lookup run at the same time, then the compare:
 *  the longest a call takes is 5 s + max(10 s, 5 s + 5 s) + 5 s = 20 s.
 *
 * CREDENTIALS. The dataset repositories are public. With the GitHub App configured for the datasets
 * organization the requests carry its installation token (the quota is the installation's, not the address's).
 * Outside production, with no App, they are unauthenticated. In production, with no App, nothing is
 * requested: `zarr_source_unverifiable`, because a production Worker that cannot authenticate would be
 * reading under the shared per-address quota and would fail unpredictably. A 401 is not re-sent (that would
 * break the three-request bound): the stale token is dropped from the cache, this dispatch is unverifiable, and
 * the next one mints a fresh token. The mint API can narrow a token to one repository with read access; the
 * shared mint and its per-installation cache are outside this card, so the token is the installation's.
 *
 * TEST SEAMS, read at call time: `NEMAR_GITHUB_API_URL` (`GITHUB_API()`, the one every GitHub-facing suite
 * uses) and `NEMAR_ZARR_INDEX_BASE`, which is honored only in a recognized non-production environment so a
 * stray value on the production Worker cannot redirect the verdict. Outside production the requests carry the
 * local stack's user agent, not the Worker's.
 */

import { computeIsWellFormed, launchStringBytes } from "../../../shared/contract/compute.js";
import type { Bindings } from "../types/bindings.js";
import { isNonProductionEnv } from "./environment.js";
import {
  getGitHubAppConfig,
  getInstallationToken,
  invalidateInstallationToken,
  resolveInstallationId,
} from "./github-auth.js";
import { GITHUB_API, ORG_NAME } from "./github/shared.js";
import { githubFetchWithRetry } from "./github/transport.js";
import { getZarrIndex } from "./s3.js";

/** Each GitHub request (and the wait for an installation token) is abandoned after this. */
export const ZARR_SOURCE_GITHUB_TIMEOUT_MS = 5_000;
/** The index read (and the wait for `getZarrIndex`) is abandoned after this. */
export const ZARR_SOURCE_INDEX_TIMEOUT_MS = 10_000;
/** The most GitHub requests one check makes. */
export const ZARR_SOURCE_MAX_GITHUB_REQUESTS = 3;
/** The most of a commit's body that is read. */
export const ZARR_SOURCE_COMMIT_MAX_BYTES = 1024 * 1024;
/** The most of a compare's body that is read. */
export const ZARR_SOURCE_COMPARE_MAX_BYTES = 8 * 1024 * 1024;
/** The most of an index's body that is read over HTTP: the recipe's own bound. */
export const ZARR_SOURCE_INDEX_MAX_BYTES = 64 * 1024 * 1024;
/** GitHub lists at most 300 files of a compare; that many or more is a mismatch. */
export const ZARR_SOURCE_COMPARE_FILES_LIMIT = 300;
/** The files a compare page is asked for: more than the delta may hold, so a page never hides a data path. */
export const ZARR_SOURCE_COMPARE_PAGE = 100;
/**
 * The most delta paths a dispatch passes. The recipe takes 32 (`MAX_DELTA_PATHS`); the argument vector of a
 * job is at most 64 strings (`JobSpecSchema`), of which 16 are the fixed ones, so 24 paths is what a job can
 * carry. More is a mismatch, as more than 32 is.
 */
export const ZARR_SOURCE_MAX_DELTA_PATHS = 24;
/**
 * The most the delta paths may take in the launch specification (`launchStringBytes` of each, and a separator):
 * a third of the variable part's bound (49,152), the fixed arguments of the vector take under 1 KiB, so a job
 * with these paths always builds.
 */
export const ZARR_SOURCE_DELTA_BYTES_MAX = 32_768;
/** The roots a changed path may lie under (the recipe's `DELTA_ROOTS`). */
export const ZARR_SOURCE_DELTA_ROOTS = [".nemar/", ".github/"] as const;
/** The longest delta path (the recipe's `MAX_DELTA_PATH_LENGTH`). */
export const ZARR_SOURCE_DELTA_PATH_MAX = 512;
/** The user agent outside production: a developer's machine is the local stack, not the Worker. */
export const ZARR_SOURCE_LOCAL_USER_AGENT = "nemar-local-stack/0";

/** Every reason a refusal can carry, fixed words of this file: returned with the word, never free text. */
export const ZARR_SOURCE_REASONS = [
  "tag_absent",
  "compare_absent",
  "compare_behind",
  "compare_diverged",
  "compare_identical",
  "too_many_files",
  "data_path",
  "too_many_delta_paths",
  "no_delta_path",
  "delta_path_unsupported",
  "no_github_credentials",
  "token_mint_failed",
  "github_unreadable",
  "compare_unreadable",
  "no_index",
  "index_unreadable",
  "index_commit_unusable",
  "check_threw",
] as const;

export type ZarrSourceReason = (typeof ZARR_SOURCE_REASONS)[number];

export type ZarrCommitEquivalence = "exact" | "metadata_only";

export type ZarrSourceCheck =
  | {
      ok: true;
      /** The commit the serving index was built from. */
      sourceCommit: string;
      /** The commit of the version's tag. */
      tagCommit: string;
      equivalence: ZarrCommitEquivalence;
      /** The paths between the two commits, in the compare's order; empty for `exact`. */
      deltaPaths: string[];
    }
  | {
      ok: false;
      code: "zarr_source_mismatch" | "zarr_source_unverifiable";
      reason: ZarrSourceReason;
    };

const COMMIT_RE = /^[0-9a-f]{40}$/;

type Refused = Extract<ZarrSourceCheck, { ok: false }>;

const mismatch = (reason: ZarrSourceReason): Refused => ({
  ok: false,
  code: "zarr_source_mismatch",
  reason,
});
const unverifiable = (reason: ZarrSourceReason): Refused => ({
  ok: false,
  code: "zarr_source_unverifiable",
  reason,
});

// --- Bounded reads --------------------------------------------------------------------------------------

/** Rejects after `ms`; the work it races is not cancelled (a promise cannot be), only no longer waited for. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([work, clock]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** The body as text, or null when it is longer than `max` bytes (the rest is not read). */
async function readBounded(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

type Got = { kind: "ok"; body: unknown } | { kind: "absent" } | { kind: "unreadable" };

/** One bounded GET of JSON: 404 and 422 are `absent`, every other failure (a throw, a status, a size) is `unreadable`. */
async function getJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  maxBytes: number,
  viaGithubClient: boolean,
  onUnauthorized?: () => void,
): Promise<Got> {
  let res: Response;
  const init: RequestInit = {
    method: "GET",
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  };
  try {
    res = viaGithubClient
      ? await githubFetchWithRetry(url, init, { maxAttempts: 1, kind: "interactive" })
      : await fetch(url, init);
  } catch {
    return { kind: "unreadable" };
  }
  if (res.status === 404 || res.status === 422) {
    await res.body?.cancel().catch(() => {});
    return { kind: "absent" };
  }
  if (res.status === 401) onUnauthorized?.();
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { kind: "unreadable" };
  }
  try {
    const text = await readBounded(res, maxBytes);
    if (text === null) return { kind: "unreadable" };
    return { kind: "ok", body: JSON.parse(text) };
  } catch {
    return { kind: "unreadable" };
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// --- S: the commit the serving index was built from -----------------------------------------------------

/**
 * The `source_commit` of `<base>/<id>/zarr/index.json` over HTTP (a test or the local stack), or why there is
 * none. Exported for the local stack, which reads a public index when it seeds a dataset.
 */
export async function readZarrIndexOverHttp(
  base: string,
  datasetId: string,
  userAgent: string = ZARR_SOURCE_LOCAL_USER_AGENT,
): Promise<
  | { ok: true; sourceCommit: string; storeCount: number | null }
  | { ok: false; reason: "no_index" | "index_unreadable" | "index_commit_unusable" }
> {
  const got = await getJson(
    `${base.replace(/\/+$/, "")}/${encodeURIComponent(datasetId)}/zarr/index.json`,
    { Accept: "application/json", "User-Agent": userAgent },
    ZARR_SOURCE_INDEX_TIMEOUT_MS,
    ZARR_SOURCE_INDEX_MAX_BYTES,
    false,
  );
  if (got.kind === "absent") return { ok: false, reason: "no_index" };
  if (got.kind !== "ok" || !isRecord(got.body)) return { ok: false, reason: "index_unreadable" };
  const commit = got.body.source_commit;
  if (typeof commit !== "string" || !COMMIT_RE.test(commit)) {
    return { ok: false, reason: "index_commit_unusable" };
  }
  const count = got.body.store_count;
  return {
    ok: true,
    sourceCommit: commit,
    storeCount: typeof count === "number" && Number.isInteger(count) ? count : null,
  };
}

async function indexCommit(
  env: Bindings,
  datasetId: string,
): Promise<{ ok: true; commit: string } | { ok: false; reason: ZarrSourceReason }> {
  const seam = (globalThis as { NEMAR_ZARR_INDEX_BASE?: string }).NEMAR_ZARR_INDEX_BASE;
  if (seam && isNonProductionEnv(env)) {
    const read = await readZarrIndexOverHttp(seam, datasetId);
    return read.ok ? { ok: true, commit: read.sourceCommit } : { ok: false, reason: read.reason };
  }
  if (!env.S3_BUCKET || !env.AWS_REGION || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    return { ok: false, reason: "index_unreadable" };
  }
  let info: Awaited<ReturnType<typeof getZarrIndex>>;
  try {
    info = await withTimeout(
      getZarrIndex(
        {
          bucket: env.S3_BUCKET,
          region: env.AWS_REGION,
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        },
        datasetId,
      ),
      ZARR_SOURCE_INDEX_TIMEOUT_MS,
    );
  } catch {
    return { ok: false, reason: "index_unreadable" };
  }
  if (info === null) return { ok: false, reason: "no_index" };
  if (info.sourceCommit === null || !COMMIT_RE.test(info.sourceCommit)) {
    return { ok: false, reason: "index_commit_unusable" };
  }
  return { ok: true, commit: info.sourceCommit };
}

// --- T: the commit of the version's tag -----------------------------------------------------------------

/** What a GitHub request needs: the installation token (null: none), the user agent, and a 401's consequence. */
type GithubAccess =
  | { ok: true; token: string | null; userAgent: string; onUnauthorized: () => void }
  | { ok: false; reason: "no_github_credentials" | "token_mint_failed" };

async function githubAccess(env: Bindings): Promise<GithubAccess> {
  const userAgent = isNonProductionEnv(env) ? ZARR_SOURCE_LOCAL_USER_AGENT : "NEMAR-API";
  const installation = resolveInstallationId(env, ORG_NAME);
  if (getGitHubAppConfig(env) !== null && installation !== undefined) {
    try {
      const token = await withTimeout(
        getInstallationToken(env, installation),
        ZARR_SOURCE_GITHUB_TIMEOUT_MS,
      );
      // A token GitHub answers 401 to is dropped, so the NEXT dispatch mints a fresh one; this one is not
      // re-sent (the three-request bound) and is unverifiable.
      return {
        ok: true,
        token,
        userAgent,
        onUnauthorized: () => invalidateInstallationToken(installation),
      };
    } catch {
      return { ok: false, reason: "token_mint_failed" };
    }
  }
  // The datasets are public: outside production an unauthenticated read is enough. In production a Worker
  // without the App is a misconfiguration, and it fails closed rather than read under a shared quota.
  return isNonProductionEnv(env)
    ? { ok: true, token: null, userAgent, onUnauthorized: () => {} }
    : { ok: false, reason: "no_github_credentials" };
}

const githubHeaders = (access: GithubAccess & { ok: true }): Record<string, string> => ({
  Accept: "application/vnd.github+json",
  "User-Agent": access.userAgent,
  ...(access.token === null ? {} : { Authorization: `Bearer ${access.token}` }),
});

/** Is the string a path segment safe to put in a GitHub URL: the tag and ids this tree writes are. */
const ref = (value: string): string => encodeURIComponent(value);

async function tagCommit(
  repo: string,
  tag: string,
  access: GithubAccess & { ok: true },
): Promise<
  { ok: true; commit: string } | { ok: false; reason: "tag_absent" | "github_unreadable" }
> {
  // The data plane's tag is `v1.0.2`; the repository may carry the tag without its `v`. One more request
  // only after an answer that says the first name is not there. Both are looked up as TAGS (`refs/tags/`).
  const names = tag.startsWith("v") && tag.length > 1 ? [tag, tag.slice(1)] : [tag];
  for (const name of names) {
    const got = await getJson(
      `${GITHUB_API()}/repos/${ORG_NAME}/${ref(repo)}/commits/refs/tags/${ref(name)}`,
      githubHeaders(access),
      ZARR_SOURCE_GITHUB_TIMEOUT_MS,
      ZARR_SOURCE_COMMIT_MAX_BYTES,
      true,
      access.onUnauthorized,
    );
    if (got.kind === "absent") continue;
    if (got.kind !== "ok" || !isRecord(got.body)) return { ok: false, reason: "github_unreadable" };
    const sha = got.body.sha;
    if (typeof sha !== "string" || !COMMIT_RE.test(sha)) {
      return { ok: false, reason: "github_unreadable" };
    }
    return { ok: true, commit: sha };
  }
  return { ok: false, reason: "tag_absent" };
}

// --- The compare ------------------------------------------------------------------------------------------

/**
 * The recipe's own rule for a delta path (`delta_path`), so a path it would refuse is never passed, or the
 * reason this one is refused: `data_path` (not under a root, or not a plain path: a data file may be named
 * anything) or `delta_path_unsupported` (a path under a root that a launch cannot carry: ill-formed UTF-16 is
 * refused by the job's argument rule, and the launch bytes are counted by the caller).
 */
function deltaPathProblem(path: string): "data_path" | "delta_path_unsupported" | null {
  if (path === "" || path.length > ZARR_SOURCE_DELTA_PATH_MAX) return "data_path";
  if (!ZARR_SOURCE_DELTA_ROOTS.some((root) => path.startsWith(root))) return "data_path";
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code < 32 || code === 127) return "data_path";
  }
  if (path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return "data_path";
  }
  return computeIsWellFormed(path) ? null : "delta_path_unsupported";
}

/** The paths between the tag commit and the source commit when that is a metadata-only delta, or the word. */
async function metadataOnlyDelta(
  repo: string,
  tagCommitSha: string,
  source: string,
  access: GithubAccess & { ok: true },
): Promise<{ ok: true; deltaPaths: string[] } | Refused> {
  const got = await getJson(
    `${GITHUB_API()}/repos/${ORG_NAME}/${ref(repo)}/compare/${tagCommitSha}...${source}?per_page=${ZARR_SOURCE_COMPARE_PAGE}`,
    githubHeaders(access),
    ZARR_SOURCE_GITHUB_TIMEOUT_MS,
    ZARR_SOURCE_COMPARE_MAX_BYTES,
    true,
    access.onUnauthorized,
  );
  // The tag commit was just read, so a 404 or 422 names the SOURCE commit (the repository does not have it) or
  // a history with no common ancestor: the copy was built from something that is not this version's line.
  if (got.kind === "absent") return mismatch("compare_absent");
  if (got.kind !== "ok" || !isRecord(got.body)) return unverifiable("github_unreadable");
  const body = got.body;
  if (body.status === "behind" || body.status === "diverged" || body.status === "identical") {
    return mismatch(`compare_${body.status}`);
  }
  if (body.status !== "ahead" || typeof body.behind_by !== "number") {
    return unverifiable("compare_unreadable");
  }
  if (body.behind_by !== 0) return mismatch("compare_behind");
  const files = body.files;
  if (!Array.isArray(files)) return unverifiable("compare_unreadable");
  if (files.length >= ZARR_SOURCE_COMPARE_FILES_LIMIT) return mismatch("too_many_files");
  const paths: string[] = [];
  for (const file of files) {
    if (!isRecord(file) || typeof file.filename !== "string") {
      return unverifiable("compare_unreadable");
    }
    // A rename out of a data path is a deletion of data, whatever the new name is.
    const names = [file.filename];
    if (file.previous_filename !== undefined) {
      if (typeof file.previous_filename !== "string") return unverifiable("compare_unreadable");
      names.push(file.previous_filename);
    }
    for (const name of names) {
      const problem = deltaPathProblem(name);
      if (problem !== null) return mismatch(problem);
      if (!paths.includes(name)) paths.push(name);
    }
  }
  if (paths.length > ZARR_SOURCE_MAX_DELTA_PATHS) return mismatch("too_many_delta_paths");
  // What the paths take in the launch specification, so a job with them always builds (never `invalid_spec`).
  let launchBytes = 0;
  for (const path of paths) launchBytes += launchStringBytes(path) + 1;
  if (launchBytes > ZARR_SOURCE_DELTA_BYTES_MAX) return mismatch("delta_path_unsupported");
  // Two commits that differ and no file between them: the recipe refuses `metadata_only` with no path to name,
  // so a job would only fail. Refused here, with its own reason.
  if (paths.length === 0) return mismatch("no_delta_path");
  return { ok: true, deltaPaths: paths };
}

// --- The verdict -------------------------------------------------------------------------------------------

/**
 * Decide whether the serving copy of `datasetId` describes the version tagged `tag` (the data-plane tag,
 * `v1.0.2`). Never throws: every failure is one of the two words. Called by `resolveRun` only for a recipe whose
 * input is `zarr`, only after the newest-version and ready-copy rules passed.
 */
export async function checkZarrSource(
  env: Bindings,
  datasetId: string,
  tag: string,
): Promise<ZarrSourceCheck> {
  try {
    const access = await githubAccess(env);
    if (!access.ok) return unverifiable(access.reason);
    const [index, tagged] = await Promise.all([
      indexCommit(env, datasetId),
      tagCommit(datasetId, tag, access),
    ]);
    // A tag GitHub does not have is definite whatever the index says.
    if (!tagged.ok && tagged.reason === "tag_absent") return mismatch("tag_absent");
    if (!index.ok) return unverifiable(index.reason);
    if (!tagged.ok) return unverifiable(tagged.reason);
    const s = index.commit;
    const t = tagged.commit;
    if (s === t) {
      return { ok: true, sourceCommit: s, tagCommit: t, equivalence: "exact", deltaPaths: [] };
    }
    const delta = await metadataOnlyDelta(datasetId, t, s, access);
    if (!delta.ok) return delta;
    return {
      ok: true,
      sourceCommit: s,
      tagCommit: t,
      equivalence: "metadata_only",
      deltaPaths: delta.deltaPaths,
    };
  } catch (err) {
    // A throw here is a defect, not a service: the error's name (never its message) is for the operator.
    console.error(
      `[zarr-source] check_threw error=${err instanceof Error ? err.name.replace(/[^A-Za-z0-9]/g, "") : "unknown"}`,
    );
    return unverifiable("check_threw");
  }
}
