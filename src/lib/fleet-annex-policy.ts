/**
 * Bringing the imported fleet onto NEMAR's annex policy, 600 repositories at a time
 * (#1374, ADR 0060 for the per-dataset fix, ADR 0020 for the blast radius).
 *
 * Every dataset imported before ADR 0060 landed carries upstream's
 * `.gitattributes` -- `*.tsv text eol=lf annex.largefiles=largerthan=1mb` and a
 * dozen similar lines -- and carries NEMAR's own expression nowhere: a sample of
 * imported repositories has no `config.log` on the git-annex branch at all. Both
 * halves matter, and neither is visible from the outside, so this module reads
 * them:
 *
 *   - {@link scanDatasetAnnexPolicy} answers "what governs this repository?" from
 *     GitHub alone -- one tree listing, the `.gitattributes` blobs it names, and
 *     the git-annex branch's `config.log`. No clone, so a sweep over the fleet is
 *     minutes rather than hours, and the same call verifies a repository after it
 *     has been fixed.
 *   - {@link applyAnnexPolicyToDataset} is the fix, which is `normalizeDatasetRepo`
 *     unchanged: clone, strip, configure, commit, push. It moves no data and needs
 *     no credentials in the ordinary case; a dataset that ALSO keeps data in git is
 *     reported and skipped unless the caller opts in, because that one needs the S3
 *     leg and an operator watching it.
 *
 * The fix is a forward fix per repository, which is what makes it safe on published
 * datasets: it adds a commit that changes `.gitattributes` and nothing a version
 * manifest, a tag, an archive or a DOI addresses.
 */

import { rmSync } from "node:fs";
import { isCurrentLargefilesExpression, shouldAnnex } from "./git-annex/policy.js";
import { runCommand } from "./git-annex/run-command.js";
import { stripLargefilesAttributes } from "./import-normalize.js";
import { normalizeDatasetRepo, planDatasetNormalization } from "./normalize-dataset.js";

/** The org every dataset repository lives in (see AGENTS.md: this is deliberate). */
export const DATASET_ORG = "nemarDatasets";

/** One blob or link in a repository tree, as the GitHub tree API reports it. */
export interface FleetTreeEntry {
  path: string;
  /** `100644` plain file, `100755` executable, `120000` symlink (an annexed file). */
  mode: string;
  /** Blob size in bytes; absent for trees and for entries GitHub did not size. */
  size?: number;
}

/** A tracked `.gitattributes` that still governs content, and what fixing it removes. */
export interface AttributeFileFinding {
  path: string;
  /** Attributes {@link stripLargefilesAttributes} would remove from this file. */
  rulesRemoved: number;
  /** Lines it declines to rewrite because a quote makes them unsafe to split. */
  declined: string[];
}

/**
 * A git-annex pointer file is one line -- `/annex/objects/<key>` -- so it is never
 * this big, and a recording never this small. Used to keep an unlocked annexed
 * file from being counted as data git still holds; the clone the fix makes asks
 * git-annex itself and is the authority.
 */
export const POINTER_SUSPECT_MAX_BYTES = 256;

/** What governs one dataset repository, read from GitHub without cloning it. */
export interface AnnexPolicyState {
  datasetId: string;
  /** Tracked `.gitattributes` files carrying a content-governing largefiles rule. */
  attributeFiles: AttributeFileFinding[];
  /**
   * True when the git-annex branch configures NEMAR's current expression, or the
   * `largerthan=100kb` spelling of it that git-annex reads identically.
   */
  policyConfigured: boolean;
  /** What the git-annex branch configures, when it configures anything. */
  configuredExpression: string | null;
  /** Files NEMAR policy calls data that the tree holds as plain blobs. */
  gitResidentData: Array<{ path: string; size: number }>;
  /** Data-shaped paths too small to be recordings, i.e. probably unlocked pointers. */
  pointerSuspects: string[];
  /** True when GitHub truncated the tree, making `gitResidentData` a lower bound. */
  treeTruncated: boolean;
}

/** What a dataset needs, as a single word for a report. */
export type AnnexPolicyLabel = "compliant" | "policy" | "policy-and-data" | "data";

/**
 * Which of the two halves of the policy this repository is missing, and whether it
 * also keeps data in git.
 *
 * `policy` is the ordinary fleet case and needs no credentials; `data` means the S3
 * leg has to run, which is `nemar admin annex-normalize` with someone watching.
 */
export function labelAnnexPolicyState(state: AnnexPolicyState): AnnexPolicyLabel {
  // The SAME question `isAnnexPolicyInForce` asks, so the two cannot disagree. They
  // did: this counted any finding, that counted only removable ones, so a dataset
  // whose single finding is a quoted line nothing will rewrite was labeled `policy`
  // forever, re-cloned on every sweep, and reported "applied" each time having
  // committed nothing.
  const needsPolicy = !isAnnexPolicyInForce(state);
  const needsData = state.gitResidentData.length > 0;
  if (needsPolicy && needsData) return "policy-and-data";
  if (needsData) return "data";
  if (needsPolicy) return "policy";
  return "compliant";
}

/**
 * Read a git-annex `config.log` into the value in force for each key.
 *
 * The format is one `<timestamp>s <key> <value>` record per line, appended rather
 * than rewritten, so a key set twice appears twice and the newest timestamp wins --
 * the same rule git-annex's own union merge applies. An empty value means the key
 * was unset, which is not the same as never set, and both read as absent here.
 */
export function parseAnnexConfigLog(log: string): Map<string, string> {
  const newest = new Map<string, { at: number; value: string }>();
  for (const line of log.split("\n")) {
    const match = line.match(/^(\d+(?:\.\d+)?)s\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    const [, stamp, key, rawValue] = match;
    const at = Number(stamp);
    const value = rawValue.trim();
    const seen = newest.get(key);
    if (!seen || seen.at <= at) newest.set(key, { at, value });
  }
  const inForce = new Map<string, string>();
  for (const [key, { value }] of newest) {
    if (value !== "") inForce.set(key, value);
  }
  return inForce;
}

/**
 * Decide what governs a repository from its tree, its `.gitattributes` blobs and
 * its git-annex `config.log`. Pure: the network lives in
 * {@link scanDatasetAnnexPolicy}, this is what `test/fleet-annex-policy.unit.test.ts`
 * drives.
 */
export function classifyAnnexPolicy(input: {
  datasetId: string;
  entries: FleetTreeEntry[];
  treeTruncated: boolean;
  /** Contents of every tracked `.gitattributes`, keyed by repo-relative path. */
  attributeContents: Map<string, string>;
  /** The git-annex branch's `config.log`, or null when the branch carries none. */
  configLog: string | null;
}): AnnexPolicyState {
  const attributeFiles: AttributeFileFinding[] = [];
  for (const [path, content] of input.attributeContents) {
    const result = stripLargefilesAttributes(content);
    if (result.stripped === 0 && result.skipped.length === 0) continue;
    attributeFiles.push({
      path,
      rulesRemoved: result.stripped,
      declined: result.skipped,
    });
  }
  attributeFiles.sort((a, b) => a.path.localeCompare(b.path));

  const configured = input.configLog ? parseAnnexConfigLog(input.configLog) : new Map();
  const configuredExpression = configured.get("annex.largefiles") ?? null;

  const gitResidentData: Array<{ path: string; size: number }> = [];
  const pointerSuspects: string[] = [];
  for (const entry of input.entries) {
    // A symlink is how a locked annexed file appears, and is the normal case for an
    // OpenNeuro tree. Only a plain blob can be data git itself is holding.
    if (entry.mode !== "100644" && entry.mode !== "100755") continue;
    // An absent size is not a small file. GitHub populates `size` for blobs today,
    // but reading a missing one as 0 would classify a multi-gigabyte recording as a
    // pointer and drop it from the report -- and the only thing then standing
    // between that and a half-applied policy is the clone check.
    const size = entry.size ?? Number.POSITIVE_INFINITY;
    if (!shouldAnnex(entry.path, size)) continue;
    if (size <= POINTER_SUSPECT_MAX_BYTES) {
      pointerSuspects.push(entry.path);
      continue;
    }
    gitResidentData.push({ path: entry.path, size });
  }

  return {
    datasetId: input.datasetId,
    attributeFiles,
    policyConfigured:
      configuredExpression !== null && isCurrentLargefilesExpression(configuredExpression),
    configuredExpression,
    gitResidentData,
    pointerSuspects,
    treeTruncated: input.treeTruncated,
  };
}

/** Every path in a tree that is a tracked `.gitattributes`, root or nested. */
export function gitattributesPaths(entries: FleetTreeEntry[]): string[] {
  return entries
    .filter((e) => e.path === ".gitattributes" || e.path.endsWith("/.gitattributes"))
    .map((e) => e.path)
    .sort();
}

// =============================================================================
// Reading the fleet from GitHub
// =============================================================================

/** A GitHub REST reader, so the scan can be driven against a stand-in in tests. */
export interface GitHubReader {
  /** GET an API path relative to the API root, e.g. `repos/org/repo/git/trees/main`. */
  get(path: string): Promise<{ status: number; body: string }>;
}

/** Thrown when GitHub answers in a way the sweep must not paper over. */
export class GitHubReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /**
     * True when continuing is pointless rather than just incomplete: an exhausted
     * rate limit fails every remaining dataset the same way, and recording 600
     * identical "failures" would read as 600 broken repositories.
     */
    readonly fatal = false,
  ) {
    super(message);
    this.name = "GitHubReadError";
  }
}

/**
 * A reader over `api.github.com`, authenticated with the token `gh` already holds.
 *
 * Authentication is not optional even though every imported dataset repository is
 * public: the anonymous rate limit is 60 requests an hour, which a sweep of 600
 * datasets exhausts in its first minute.
 */
export async function createGitHubReader(
  options: { baseUrl?: string } = {},
): Promise<GitHubReader> {
  const baseUrl = options.baseUrl ?? "https://api.github.com";
  let token = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim() || "";
  if (!token) {
    const { stdout, exitCode, stderr } = await runCommand(["gh", "auth", "token"], {
      sensitiveOutput: true,
    });
    if (exitCode !== 0 || !stdout.trim()) {
      throw new Error(
        `No GitHub token available: set GH_TOKEN, or run \`gh auth login\` (gh said: ${stderr.trim() || `exit ${exitCode}`}). A sweep of the fleet cannot run on the anonymous rate limit.`,
      );
    }
    token = stdout.trim();
  }

  return {
    async get(path: string) {
      const url = `${baseUrl}/${path.replace(/^\//, "")}`;
      let lastError = "";
      // Two retries, for a 5xx or a 429. A secondary rate limit arrives as a 403 with `Retry-After` and is NOT retried here; it surfaces as an unreadable dataset. A primary rate-limit
      // exhaustion is reported rather than waited out: the caller decides whether
      // to stop the sweep or resume it after the reset.
      for (let attempt = 0; attempt < 3; attempt++) {
        let response: Response;
        try {
          response = await fetch(url, {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "nemar-cli fleet annex-policy sweep",
            },
          });
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
          continue;
        }
        if (response.status === 403 || response.status === 429) {
          const remaining = response.headers.get("x-ratelimit-remaining");
          const reset = response.headers.get("x-ratelimit-reset");
          if (remaining === "0") {
            const at = reset ? new Date(Number(reset) * 1000).toISOString() : "unknown";
            throw new GitHubReadError(
              `GitHub rate limit exhausted; it resets at ${at}. Re-run the sweep after that, or narrow it with --limit.`,
              response.status,
              true,
            );
          }
        }
        if (response.status >= 500 || response.status === 429) {
          lastError = `HTTP ${response.status}`;
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
          continue;
        }
        return { status: response.status, body: await response.text() };
      }
      throw new GitHubReadError(`GET ${path} failed after 3 attempts: ${lastError}`, 0);
    },
  };
}

/** Decode a GitHub contents/blob response, which carries base64 with newlines in it. */
function decodeBase64Content(body: string, what: string): string {
  const parsed = JSON.parse(body) as { content?: string; encoding?: string };
  if (parsed.encoding !== "base64" || typeof parsed.content !== "string") {
    throw new Error(`${what}: expected a base64 blob, got encoding=${parsed.encoding}`);
  }
  return Buffer.from(parsed.content.replace(/\n/g, ""), "base64").toString("utf8");
}

/**
 * Read one dataset's annex policy state from GitHub.
 *
 * Costs one tree listing, one blob per tracked `.gitattributes`, and one read of
 * `config.log` on the git-annex branch. A repository with no git-annex branch, or
 * one whose branch has no `config.log`, reads as "no policy configured" rather than
 * as an error: that is the state 600 imported datasets are actually in.
 */
export async function scanDatasetAnnexPolicy(
  datasetId: string,
  reader: GitHubReader,
  options: { branch?: string } = {},
): Promise<AnnexPolicyState> {
  const branch = options.branch ?? "main";
  const repo = `repos/${DATASET_ORG}/${datasetId}`;

  const tree = await reader.get(`${repo}/git/trees/${branch}?recursive=1`);
  if (tree.status !== 200) {
    throw new GitHubReadError(
      `Could not read ${datasetId}'s ${branch} tree: HTTP ${tree.status}`,
      tree.status,
    );
  }
  const treeBody = JSON.parse(tree.body) as {
    tree?: Array<{ path: string; mode: string; type: string; size?: number; sha: string }>;
    truncated?: boolean;
  };
  const blobs = (treeBody.tree ?? []).filter((e) => e.type === "blob");
  const entries: FleetTreeEntry[] = blobs.map((e) => ({
    path: e.path,
    mode: e.mode,
    size: e.size,
  }));

  const attributeContents = new Map<string, string>();
  for (const path of gitattributesPaths(entries)) {
    const sha = blobs.find((e) => e.path === path)?.sha;
    if (!sha) continue;
    const blob = await reader.get(`${repo}/git/blobs/${sha}`);
    if (blob.status !== 200) {
      throw new GitHubReadError(
        `Could not read ${datasetId}:${path} (blob ${sha.slice(0, 8)}): HTTP ${blob.status}`,
        blob.status,
      );
    }
    attributeContents.set(path, decodeBase64Content(blob.body, `${datasetId}:${path}`));
  }

  const config = await reader.get(`${repo}/contents/config.log?ref=git-annex`);
  let configLog: string | null = null;
  if (config.status === 200) {
    configLog = decodeBase64Content(config.body, `${datasetId}:git-annex:config.log`);
  } else if (config.status !== 404) {
    throw new GitHubReadError(
      `Could not read ${datasetId}'s git-annex config.log: HTTP ${config.status}`,
      config.status,
    );
  }

  return classifyAnnexPolicy({
    datasetId,
    entries,
    treeTruncated: Boolean(treeBody.truncated),
    attributeContents,
    configLog,
  });
}

// =============================================================================
// Applying the fix
// =============================================================================

/** Why a dataset was left alone, or what happened to it. */
export type BackfillAction =
  | "compliant"
  | "skipped-has-data"
  | "planned"
  | "applied"
  | "failed"
  | "unverified";

export interface BackfillOutcome {
  datasetId: string;
  /** What GitHub said before anything was done. */
  before: AnnexPolicyState;
  action: BackfillAction;
  committed?: boolean;
  pushed?: boolean;
  notes?: string[];
  error?: string;
  /** A re-read after the push; `action` is `unverified` when this still shows drift. */
  after?: AnnexPolicyState;
}

/**
 * Remove a clone, including git-annex's read-only object directories.
 *
 * `git annex` makes each object and its parent directory read-only so content
 * cannot be edited in place, and a plain recursive delete stops on those. 600
 * clones left behind would fill the disk long before the sweep finished.
 */
export async function removeAnnexClone(path: string): Promise<void> {
  await runCommand(["chmod", "-R", "u+w", path]);
  rmSync(path, { recursive: true, force: true });
}

/**
 * Put NEMAR's annex policy in force on one dataset, then read GitHub back to prove
 * it landed.
 *
 * The fix itself is `normalizeDatasetRepo`, unchanged from the single-dataset
 * command: one commit that strips inherited `annex.largefiles` attributes, plus
 * NEMAR's expression written to the git-annex branch, pushed together. A dataset
 * that also keeps data in git is skipped by default -- that needs the S3 leg, which
 * is a different operation with a different failure mode, and the operator should
 * choose to run it.
 */
export async function applyAnnexPolicyToDataset(
  datasetId: string,
  reader: GitHubReader,
  options: {
    /** Parent directory for the clone; it is removed again unless `keepClone`. */
    workRoot: string;
    /** False for a rehearsal: everything except the push. */
    push?: boolean;
    /** Also move data the repository keeps in git, which needs S3 credentials. */
    includeData?: boolean;
    /** Leave the clone on disk, to inspect or to resume from. */
    keepClone?: boolean;
    /** `"ambient"` moves data with this machine's own AWS configuration. */
    credentials?: "backend" | "ambient";
    maxBytes?: number;
    /** Where to clone from; defaults to the dataset's repository in the org. */
    originUrl?: string;
  },
): Promise<BackfillOutcome> {
  const before = await scanDatasetAnnexPolicy(datasetId, reader);
  const label = labelAnnexPolicyState(before);
  if (label === "compliant") {
    return { datasetId, before, action: "compliant" };
  }
  if ((label === "data" || label === "policy-and-data") && !options.includeData) {
    return {
      datasetId,
      before,
      action: "skipped-has-data",
      notes: [
        `${before.gitResidentData.length} file(s) NEMAR policy calls data are in git; that needs the S3 leg (nemar admin annex-normalize ${datasetId})`,
      ],
    };
  }

  const datasetPath = `${options.workRoot.replace(/\/$/, "")}/${datasetId}`;
  try {
    const plan = await planDatasetNormalization(datasetId, {
      workDir: options.workRoot,
      originUrl: options.originUrl,
    });
    if (plan.files.length > 0 && !options.includeData) {
      // The tree said there was nothing to move and the clone disagrees. The clone
      // is the authority (it asks git-annex, and it sees sizes GitHub may not have
      // reported), so stop rather than starting an upload nobody asked for.
      return {
        datasetId,
        before,
        action: "skipped-has-data",
        notes: [
          `the clone found ${plan.files.length} data file(s) in git that the tree listing did not; re-run with --include-data or use nemar admin annex-normalize ${datasetId}`,
        ],
      };
    }
    const result = await normalizeDatasetRepo(plan, {
      push: options.push !== false,
      credentials: options.credentials,
      maxBytes: options.maxBytes,
    });
    if (!result.committed && !result.pushed) {
      // The clone had nothing to change, and the clone is the authority: it read
      // the whole tree, which the scan may not have (GitHub truncates past ~65,000
      // entries) and which may hold only a quoted rule the strip will not split.
      // Reporting `applied` here would claim a commit that was never made, and
      // re-reading the same truncated tree to "verify" would prove nothing.
      return {
        datasetId,
        before,
        action: "compliant",
        committed: false,
        pushed: false,
        notes: [...result.notes, "the clone found nothing to change"],
      };
    }
    let verified: Awaited<ReturnType<typeof verifyAnnexPolicyLanded>> | undefined;
    if (options.push !== false) {
      try {
        verified = await verifyAnnexPolicyLanded(datasetId, reader);
      } catch (error) {
        // The push already happened. Reporting this as `failed` would say the
        // repository was not changed when it was, and the natural response -- re-run
        // the failures -- would re-clone and re-push hundreds of repositories. An
        // exhausted rate limit still stops the sweep, because every remaining
        // verification would fail identically.
        if (error instanceof GitHubReadError && error.fatal) throw error;
        return {
          datasetId,
          before,
          action: "unverified",
          committed: result.committed,
          pushed: result.pushed,
          notes: [
            ...result.notes,
            `pushed, but the read-back could not be completed: ${error instanceof Error ? error.message : String(error)}. Re-run the read-only report for this dataset to confirm.`,
          ],
        };
      }
    }
    const notes = [...result.notes];
    if (verified?.remainingDeclined.length) {
      notes.push(
        `left alone: ${verified.remainingDeclined.join(", ")} (a quoted pattern the strip will not split; fix by hand)`,
      );
    }
    return {
      datasetId,
      before,
      action: verified === undefined || verified.landed ? "applied" : "unverified",
      committed: result.committed,
      pushed: result.pushed,
      notes,
      after: verified?.state,
    };
  } catch (error) {
    return {
      datasetId,
      before,
      action: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Cleanup of a scratch clone must never replace the outcome the try block
    // produced -- a throw here would discard a successful push and, because the
    // sweep does not catch, abort the batch.
    if (!options.keepClone) {
      try {
        await removeAnnexClone(datasetPath);
      } catch {
        // The clone is disposable and the work is already pushed; a leftover
        // directory under the work root is not worth losing the result over.
      }
    }
  }
}

/**
 * Read a dataset back after its push and decide whether the policy is in force.
 *
 * Two things this has to be careful about, both of which would otherwise report a
 * dataset as broken when it is fine:
 *
 * - **GitHub is read-after-write consistent only eventually.** A tree read moments
 *   after a push can still describe the previous commit, so a single drift reading is
 *   retried before it counts. Three attempts over about six seconds; a real failure
 *   costs those seconds once, and a 598-dataset rollout does not report false alarms.
 * - **A quoted attribute line is never rewritten.** `stripLargefilesAttributes`
 *   declines a line whose pattern is quoted rather than cutting it in half, so such a
 *   file still reports a finding forever. That is a hand-fix, not a failed push: the
 *   policy landed, and the caller is told which files were left.
 */
export async function verifyAnnexPolicyLanded(
  datasetId: string,
  reader: GitHubReader,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<{ landed: boolean; state: AnnexPolicyState; remainingDeclined: string[] }> {
  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 3000;
  let state = await scanDatasetAnnexPolicy(datasetId, reader);
  for (let attempt = 1; attempt < attempts; attempt++) {
    if (isAnnexPolicyInForce(state)) break;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    state = await scanDatasetAnnexPolicy(datasetId, reader);
  }
  return {
    landed: isAnnexPolicyInForce(state),
    state,
    remainingDeclined: state.attributeFiles.filter((f) => f.declined.length > 0).map((f) => f.path),
  };
}

/**
 * True when nothing removable is left: the expression is configured, and every
 * `.gitattributes` finding still standing is a quoted line nothing will rewrite.
 */
export function isAnnexPolicyInForce(state: AnnexPolicyState): boolean {
  // A truncated tree is not evidence of absence. GitHub stops listing past about
  // 65,000 entries, and a nested `.gitattributes` beyond the cut is simply not in
  // `entries`: it is never fetched, never classified, and would certify as "in
  // force" on a read that never saw it. Say no, and let the clone decide.
  if (state.treeTruncated) return false;
  return state.policyConfigured && state.attributeFiles.every((f) => f.rulesRemoved === 0);
}

/** What a read-only sweep found, grouped the way the operator has to act on it. */
export interface FleetScanSummary {
  scanned: number;
  byLabel: Record<AnnexPolicyLabel, string[]>;
  /** Datasets whose tree GitHub truncated: their data counts are a lower bound. */
  truncated: string[];
  /** Datasets that could not be read, with why. The sweep continues past these. */
  failed: Array<{ datasetId: string; error: string }>;
  states: AnnexPolicyState[];
}

/**
 * Thrown when a sweep stops early, carrying what it had already read.
 *
 * Stopping is right when every remaining read would fail identically; throwing the
 * partial inventory away is not. A rate limit exhausted at dataset 590 of 600 used
 * to cost all 589 successful reads, and the operator waited an hour to repeat the
 * same 2,400 requests.
 */
export class FleetSweepAborted extends Error {
  constructor(
    readonly cause: Error,
    readonly partial: FleetScanSummary,
  ) {
    super(cause.message);
    this.name = "FleetSweepAborted";
  }
}

/** Group scan results the way the report and the apply step both need them. */
function summarizeScan(
  results: Array<{ datasetId: string; state?: AnnexPolicyState; error?: string }>,
): FleetScanSummary {
  const byLabel: Record<AnnexPolicyLabel, string[]> = {
    compliant: [],
    policy: [],
    "policy-and-data": [],
    data: [],
  };
  const failed: Array<{ datasetId: string; error: string }> = [];
  const states: AnnexPolicyState[] = [];
  const truncated: string[] = [];
  for (const result of results) {
    if (result.state) {
      states.push(result.state);
      byLabel[labelAnnexPolicyState(result.state)].push(result.datasetId);
      if (result.state.treeTruncated) truncated.push(result.datasetId);
    } else if (result.error) {
      failed.push({ datasetId: result.datasetId, error: result.error });
    }
  }
  return { scanned: states.length, byLabel, truncated, failed, states };
}

/**
 * Read the policy state of every named dataset, in parallel, without cloning any of
 * them.
 *
 * A dataset that cannot be read is recorded and the sweep continues -- one renamed
 * or deleted repository must not cost the inventory of the other 599. An exhausted
 * rate limit is different and stops the sweep, because every remaining read would
 * fail the same way and be filed as a broken repository; it throws
 * `FleetSweepAborted`, which carries everything read up to that point.
 */
export async function sweepAnnexPolicy(
  targets: string[],
  reader: GitHubReader,
  options: {
    concurrency?: number;
    onResult?: (result: { datasetId: string; state?: AnnexPolicyState; error?: string }) => void;
  } = {},
): Promise<FleetScanSummary> {
  // Collected as each dataset finishes rather than from the return value, so an
  // abort still has everything that was read before it.
  const collected: Array<{ datasetId: string; state?: AnnexPolicyState; error?: string }> = [];

  await mapWithConcurrency(targets, options.concurrency ?? 4, async (datasetId) => {
    try {
      const state = await scanDatasetAnnexPolicy(datasetId, reader);
      options.onResult?.({ datasetId, state });
      collected.push({ datasetId, state });
    } catch (error) {
      if (error instanceof GitHubReadError && error.fatal) {
        throw new FleetSweepAborted(error, summarizeScan(collected));
      }
      const message = error instanceof Error ? error.message : String(error);
      options.onResult?.({ datasetId, error: message });
      collected.push({ datasetId, error: message });
    }
  });

  // Input order, not completion order: the report is read by dataset id.
  const order = new Map(targets.map((id, index) => [id, index]));
  collected.sort((a, b) => (order.get(a.datasetId) ?? 0) - (order.get(b.datasetId) ?? 0));
  return summarizeScan(collected);
}

// =============================================================================
// Target selection
// =============================================================================

/**
 * Which datasets a sweep covers, in a stable order.
 *
 * Imported (`on######`) datasets are the population #1374 is about: they are the
 * ones whose `.gitattributes` came from upstream, so they are the default prefix.
 * `nm` datasets are NOT exempt, only out of scope by default: 195 of 198 carried an
 * expression written before `*_motion.tsv` joined the policy, and `--prefix nm`
 * sweeps them. The live five are never swept without `force`.
 */
export function selectAnnexPolicyTargets(
  datasets: Array<{ dataset_id: string }>,
  options: { prefix?: string; exclude?: ReadonlySet<string>; force?: boolean; limit?: number },
): string[] {
  const prefix = options.prefix ?? "on";
  const excluded = options.exclude ?? new Set<string>();
  const selected = datasets
    .map((d) => d.dataset_id)
    .filter((id) => id.startsWith(prefix))
    .filter((id) => options.force || !excluded.has(id))
    .sort();
  return options.limit !== undefined ? selected.slice(0, options.limit) : selected;
}

/** Run `work` over `items` with at most `concurrency` in flight, keeping input order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () =>
    (async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await work(items[index], index);
      }
    })(),
  );
  await Promise.all(runners);
  return results;
}
