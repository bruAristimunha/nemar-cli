/**
 * What a pull request changed, read as git data (ADR 0092).
 *
 * Runs inside the central review workflow against a repository made with `git init` and
 * `git fetch`, which has no working tree. **Nothing is checked out and nothing from the pull
 * request is executed**: with no working tree, no hook, filter, `.gitattributes` driver or script
 * in the pull request can run, and a fork's content is read exactly like a branch's. Every git
 * call passes its arguments as an array (no shell) after the commit ids have been checked against
 * a 40-hex shape, and with `--literal-pathspecs`, so a path or a branch name is only ever data and
 * a file named like a pathspec (`:(glob)*.json`) cannot make git read another file's content.
 *
 * The output has two halves with different trust. {@link buildEvidence} is the deterministic
 * account (counts per area, versions, subjects, a file list) that goes into the report whatever
 * the model says. {@link GitFacts} also carries the text the model is shown (patches, commit
 * subjects), all of it attacker-controlled and handled as such by `pr-review-prompt.ts`.
 *
 * **What the reviewer was NOT shown is a fact too.** The model sees the diff of the changed
 * metadata files that fit a budget, never recordings. A file it needs to read to rule out a loss
 * (a MODIFIED or REMOVED metadata file) that it was not shown in full makes the evidence
 * `truncated`, which stops a clean pass about nothing being lost. An unread ADDED file does not:
 * a new file cannot remove anything.
 */

import { execFileSync } from "node:child_process";
import {
  AREAS,
  type Area,
  type AreaCounts,
  type ChangeStatus,
  type ChangedFile,
  MAX_LISTED,
  MAX_MODEL_FILES,
  type ReviewEvidence,
  SEMVER,
} from "../../shared/pr-review";
import { shouldAnnex } from "../../src/lib/git-annex/policy";

export { MAX_MODEL_FILES };
/** At most this many files have their content (a diff) shown to the model. */
export const MAX_PATCH_FILES = 40;
/** Characters of one file's diff shown to the model. */
export const MAX_PATCH_FILE_CHARS = 12_000;
/** Characters of diff shown to the model in all (about 20,000 tokens). */
export const MAX_PATCH_TOTAL_CHARS = 80_000;
/** Commit subjects shown to the model. */
export const MAX_COMMITS = 30;

/** A full commit id. Every revision this module hands to git has this shape. */
export const SHA40 = /^[0-9a-f]{40}$/;

/**
 * Why the evidence could not be read. A closed list, because the word is printed in a public log:
 * an error built from a path or a git message would put a pull request's text there.
 */
export const EVIDENCE_ERRORS = [
  "bad_commit_id",
  "tree_unreadable",
  "description_unreadable",
  "no_merge_base",
  "changes_unreadable",
  "commits_unreadable",
] as const;
export type EvidenceErrorCode = (typeof EVIDENCE_ERRORS)[number];

export class EvidenceError extends Error {
  readonly code: EvidenceErrorCode;
  constructor(code: EvidenceErrorCode) {
    super(code);
    this.name = "EvidenceError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

/**
 * Where in a dataset a path sits. Recordings are whatever the repository's one annex policy
 * (ADR 0015, ADR 0031) always keeps out of git, so this cannot disagree with how the dataset was
 * built: a `_motion.tsv` is a recording here for the same reason it is annexed there.
 */
export function classifyPath(path: string): Area {
  const root = !path.includes("/");
  if (path === "dataset_description.json") return "dataset_description";
  if (root && /^(readme|changes)(\.[A-Za-z0-9]+)?$/i.test(path)) return "readme_and_changes";
  if (root && /^participants\.(tsv|json)$/.test(path)) return "participants";
  if (path.startsWith("derivatives/")) return "derivatives";
  if (path.startsWith("sourcedata/")) return "sourcedata";
  if (path.startsWith("code/")) return "code";
  if (shouldAnnex(path, 0)) return "recordings";
  if (/\.(json|tsv)$/i.test(path)) return "sidecars";
  return "other";
}

/**
 * The order a reviewer would open things: the files that describe the dataset come first. A
 * `Record`, so a new area added to the contract fails the build here instead of silently sorting
 * first (`indexOf` of a missing area is -1).
 */
const AREA_PRIORITY: Record<Area, number> = {
  dataset_description: 0,
  readme_and_changes: 1,
  participants: 2,
  sidecars: 3,
  code: 4,
  derivatives: 5,
  sourcedata: 6,
  other: 7,
  recordings: 8,
};

/** The areas whose changed files are worth reading in full, because they describe the dataset. */
const READABLE_AREAS: ReadonlySet<Area> = new Set([
  "dataset_description",
  "readme_and_changes",
  "participants",
  "sidecars",
]);

// ---------------------------------------------------------------------------------------------
// Reading git
// ---------------------------------------------------------------------------------------------

export interface RawChange {
  status: ChangeStatus;
  path: string;
}

export interface Patch {
  path: string;
  text: string;
  truncated: boolean;
}

export interface GitFacts {
  changes: RawChange[];
  /** Diffs of the changed metadata files that fit the budget, most important first. */
  patches: Patch[];
  /** Subject lines of the commits being merged. Attacker-controlled. */
  commits: string[];
  versionBefore: string | null;
  versionAfter: string | null;
  subjectsBefore: number | null;
  subjectsAfter: number | null;
  /** True when the change list was longer than {@link MAX_MODEL_FILES}. */
  listCut: boolean;
  /**
   * True when a MODIFIED or REMOVED metadata file the reviewer needed was not shown in full: it
   * did not fit the file or character budget, its diff was cut, or reading it failed.
   */
  readIncomplete: boolean;
}

function git(dir: string, args: string[]): string {
  return execFileSync(
    "git",
    [
      "--literal-pathspecs",
      "-C",
      dir,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "protocol.ext.allow=never",
      ...args,
    ],
    {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function tryGit(dir: string, args: string[]): string | null {
  try {
    return git(dir, args);
  } catch {
    return null;
  }
}

function requireSha(value: string): void {
  if (!SHA40.test(value)) throw new EvidenceError("bad_commit_id");
}

/** Parse `git diff --name-status -z --no-renames` output. */
export function parseNameStatus(raw: string): RawChange[] {
  const parts = raw.split("\0");
  const out: RawChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i];
    const path = parts[i + 1];
    if (!code || !path) continue;
    const status: ChangeStatus = code.startsWith("A")
      ? "added"
      : code.startsWith("D")
        ? "removed"
        : "modified";
    out.push({ status, path });
  }
  return out;
}

/**
 * The `Version` in `dataset_description.json` at a revision, or null when the file has none (absent
 * file, no `Version`, or one that is not `X.Y.Z`). A file that EXISTS but cannot be read is not
 * "no version": it is an {@link EvidenceError}, so a failed fetch of a blob cannot pass as
 * "this dataset has no version".
 */
function versionAt(dir: string, rev: string): string | null {
  // Ask the TREE whether the file exists: that needs no blob, so a blob that cannot be fetched
  // is told apart from a file that is not there.
  const entry = tryGit(dir, ["ls-tree", rev, "--", "dataset_description.json"]);
  if (entry === null) throw new EvidenceError("tree_unreadable");
  if (entry.trim() === "") return null;
  const raw = tryGit(dir, ["show", `${rev}:dataset_description.json`]);
  if (raw === null) throw new EvidenceError("description_unreadable");
  try {
    const v = (JSON.parse(raw) as { Version?: unknown }).Version;
    return typeof v === "string" && SEMVER.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** How many `sub-*` directories the commit has. An unreadable tree is an error, not "unknown". */
function subjectsAt(dir: string, rev: string): number {
  const raw = tryGit(dir, ["ls-tree", "-d", "--name-only", rev]);
  if (raw === null) throw new EvidenceError("tree_unreadable");
  return raw.split("\n").filter((n) => /^sub-/.test(n)).length;
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  return text.length <= max
    ? { text, truncated: false }
    : { text: text.slice(0, max), truncated: true };
}

const STATUS_RANK: Record<ChangeStatus, number> = { removed: 0, modified: 1, added: 2 };

/** The order a reviewer would open files in: removed, then modified, then added; within each, the files that describe the dataset first and recordings last. */
function byReviewOrder(a: RawChange, b: RawChange): number {
  return (
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    AREA_PRIORITY[classifyPath(a.path)] - AREA_PRIORITY[classifyPath(b.path)] ||
    a.path.localeCompare(b.path)
  );
}

/**
 * Read what `headSha` changes relative to the point it branched from `baseSha`.
 *
 * `baseSha` is the tip of `main`; the diff is taken against the merge base, so a pull request
 * is judged on what IT changes and not on what `main` gained since. Throws {@link EvidenceError}
 * when the commits are not present or share no history.
 */
export function gatherGitFacts(dir: string, baseSha: string, headSha: string): GitFacts {
  requireSha(baseSha);
  requireSha(headSha);
  const mergeBase = tryGit(dir, ["merge-base", baseSha, headSha])?.trim();
  if (!mergeBase || !SHA40.test(mergeBase)) throw new EvidenceError("no_merge_base");

  const raw = tryGit(dir, ["diff", "--name-status", "-z", "--no-renames", mergeBase, headSha]);
  if (raw === null) throw new EvidenceError("changes_unreadable");
  const changes = parseNameStatus(raw);

  // Removals and modifications first: that is where a loss hides. Added files come last, so a
  // budget that runs out costs the least important reads.
  const wanted = changes
    .filter((c) => READABLE_AREAS.has(classifyPath(c.path)))
    .sort(byReviewOrder);

  const patches: Patch[] = [];
  const read = new Map<string, Patch>();
  let budget = MAX_PATCH_TOTAL_CHARS;
  for (const c of wanted.slice(0, MAX_PATCH_FILES)) {
    if (budget <= 0) break;
    const diff = tryGit(dir, [
      "diff",
      "-U2",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      mergeBase,
      headSha,
      "--",
      c.path,
    ]);
    if (diff === null || diff === "") continue;
    const { text, truncated } = clip(diff, Math.min(MAX_PATCH_FILE_CHARS, budget));
    budget -= text.length;
    const patch = { path: c.path, text, truncated };
    patches.push(patch);
    read.set(c.path, patch);
  }

  const readIncomplete = wanted.some((c) => {
    if (c.status === "added") return false;
    const patch = read.get(c.path);
    return patch === undefined || patch.truncated;
  });

  // An empty list would read to the model as "no commits", so a failed read is an error.
  const log = tryGit(dir, ["log", "--format=%s", `-n${MAX_COMMITS}`, `${mergeBase}..${headSha}`]);
  if (log === null) throw new EvidenceError("commits_unreadable");
  return {
    changes,
    patches,
    commits: log.split("\n").filter(Boolean),
    versionBefore: versionAt(dir, mergeBase),
    versionAfter: versionAt(dir, headSha),
    subjectsBefore: subjectsAt(dir, mergeBase),
    subjectsAfter: subjectsAt(dir, headSha),
    listCut: changes.length > MAX_MODEL_FILES,
    readIncomplete,
  };
}

// ---------------------------------------------------------------------------------------------
// The deterministic account
// ---------------------------------------------------------------------------------------------

function emptyAreas(): Record<Area, AreaCounts> {
  const out = {} as Record<Area, AreaCounts>;
  for (const a of AREAS) out[a] = { added: 0, modified: 0, removed: 0 };
  return out;
}

/**
 * The report's evidence block, from git alone. Every change is counted in exactly one area, so
 * the areas add up to `files_changed` by construction (the Worker refuses a report where they do
 * not). The file list is the first {@link MAX_LISTED} a reviewer would open, in
 * {@link byReviewOrder}.
 */
export function buildEvidence(facts: GitFacts): ReviewEvidence {
  const areas = emptyAreas();
  for (const c of facts.changes) areas[classifyPath(c.path)][c.status]++;
  const listed: ChangedFile[] = [...facts.changes].sort(byReviewOrder).slice(0, MAX_LISTED);
  return {
    files_changed: facts.changes.length,
    files_read: facts.patches.length,
    truncated: facts.listCut || facts.readIncomplete,
    version_before: facts.versionBefore,
    version_after: facts.versionAfter,
    subjects_before: facts.subjectsBefore,
    subjects_after: facts.subjectsAfter,
    areas,
    listed,
  };
}
